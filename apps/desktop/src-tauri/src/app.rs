//! Motor de la aplicacion: estado, suscripcion al bus y persistencia.
//!
//! Deliberadamente **no depende de Tauri**. El shell de escritorio
//! (`desktop.rs`) solo anade comandos y la ventana. Ventaja concreta: el flujo
//! completo (bus -> chat -> SQLite) se puede probar en CI en segundos, sin
//! compilar Tauri.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::broadcast;

use crate::chat::{ChatBuffer, ChatEntry};
use crate::core::event::Event;
use crate::core::{EventBus, EventKind, Metrics, MetricsSnapshot, PROTOCOL_VERSION};
use crate::database::{database_path, Database, DbWriter, WriteJob};
use crate::feed::{
    like_is_notable, EventFeed, FeedItem, FeedKind, GiftBoard, GiftEventView, GifterEntry,
    GiftTypeSummary, FEED_CAPACITY,
};
use crate::providers::{NativeProvider, ProviderConfig, SimulatedProvider, TikTokProvider};
use crate::telemetry;
use crate::tts::manager::{TtsManager, TtsSettings, TtsStatus};
use crate::tts::player::{AudioSink, FallbackSink};
use crate::tts::{EdgeTtsSidecar, SharedTtsProvider};

/// Capacidad del bus. Acotada a proposito: un suscriptor lento pierde eventos
/// antiguos en lugar de consumir memoria sin limite.
pub const BUS_CAPACITY: usize = 4096;
/// Capacidad de la cola del escritor de base de datos.
pub const DB_QUEUE: usize = 4096;
/// Cuanto puede esperar un evento critico a que la cola de escritura haga sitio.
///
/// Un regalo no se pierde, pero tampoco se bloquea al consumidor de eventos para
/// siempre: si en este plazo no cabe, se cuenta como perdido y se avisa.
pub const WRITER_BLOCK_TIMEOUT: Duration = Duration::from_millis(250);
/// Mensajes de chat que se conservan y se envian a la interfaz.
pub const CHAT_CAPACITY: usize = 200;

pub struct AppState {
    pub(crate) bus: Arc<EventBus>,
    pub(crate) metrics: Arc<Metrics>,
    pub(crate) chat: Mutex<ChatBuffer>,
    /// Actividad reciente (regalos, follows, likes grandes, avisos).
    pub(crate) feed: Mutex<EventFeed>,
    /// Resumen de regalos **de la sesion actual**.
    pub(crate) gifts: Mutex<GiftBoard>,
    pub(crate) provider: RwLock<Arc<dyn TikTokProvider>>,
    pub(crate) native: Arc<NativeProvider>,
    pub(crate) simulated: Arc<SimulatedProvider>,
    pub(crate) writer: Mutex<Option<DbWriter>>,
    pub(crate) stream_id: RwLock<Option<String>>,
    pub(crate) handle: RwLock<String>,
    pub(crate) title: RwLock<String>,
    /// Cuando empezo la sesion actual, para mostrar su duracion.
    pub(crate) started_at_ms: RwLock<Option<i64>>,
    /// Eventos que la interfaz dice haber reconocido, por tipo.
    ///
    /// Es el unico modo de distinguir "los eventos llegan al WebView" de "la
    /// interfaz sabe que hacer con ellos": si un tipo aparece aqui, hay un
    /// `case` que lo pinta.
    pub(crate) ui_events: Mutex<std::collections::HashMap<String, u64>>,
    /// Ultima vez que se publicaron los agregados de regalos (coalescing).
    pub(crate) last_board: Mutex<Option<std::time::Instant>>,
    /// Traza del chat (recibido en la interfaz / renderizado por React).
    pub(crate) ui_chat: Mutex<UiChatTrace>,
    /// Lectura del chat en voz alta. Vive en su propio modulo y solo depende del
    /// bus: no conoce nada de TikTok ni de Tauri.
    pub(crate) tts: Arc<TtsManager>,
    /// Proveedor de sintesis (sidecar edge-tts), compartido con el manager.
    pub(crate) tts_provider: SharedTtsProvider,
    pub(crate) db_path: PathBuf,
    pub(crate) schema_version: u32,
    pub(crate) instance_port: u16,
}

impl AppState {
    /// Abre el estado sobre una base de datos concreta. `open` permite a los
    /// tests usar un fichero temporal; la aplicacion usa `new`.
    pub fn open(db_path: PathBuf, instance_port: u16) -> anyhow::Result<Self> {
        let metrics = Arc::new(Metrics::default());
        let bus = Arc::new(EventBus::new(BUS_CAPACITY, metrics.clone()));

        // Recuperacion tras un cierre inesperado: las sesiones que quedaron
        // abiertas se marcan como interrumpidas antes de aceptar eventos.
        let database = Database::open(&db_path)?;
        let schema_version = database.migrate()?;
        database.mark_crashed_streams()?;
        let writer = DbWriter::start(database, DB_QUEUE);

        let native = Arc::new(NativeProvider::new(
            ProviderConfig::default(),
            bus.clone(),
            metrics.clone(),
        )?);
        let simulated = Arc::new(SimulatedProvider::new(bus.clone(), metrics.clone()));

        // TTS: sintesis por sidecar y reproduccion por el sink de reserva, que
        // degrada a silencio si no hay tarjeta de sonido en lugar de impedir
        // arrancar la aplicacion.
        let tts_provider: SharedTtsProvider = Arc::new(EdgeTtsSidecar::new(crate::tts::default_config()));
        let sink: Arc<dyn AudioSink> = Arc::new(FallbackSink::new());
        let tts = Arc::new(TtsManager::new(
            TtsSettings::default(),
            tts_provider.clone(),
            bus.clone(),
            sink,
        ));

        Ok(Self {
            bus,
            metrics,
            chat: Mutex::new(ChatBuffer::new(CHAT_CAPACITY)),
            feed: Mutex::new(EventFeed::new(FEED_CAPACITY)),
            gifts: Mutex::new(GiftBoard::new(FEED_CAPACITY)),
            provider: RwLock::new(native.clone() as Arc<dyn TikTokProvider>),
            native,
            simulated,
            writer: Mutex::new(Some(writer)),
            stream_id: RwLock::new(None),
            handle: RwLock::new(String::new()),
            title: RwLock::new(String::new()),
            started_at_ms: RwLock::new(None),
            ui_events: Mutex::new(std::collections::HashMap::new()),
            last_board: Mutex::new(None),
            ui_chat: Mutex::new(UiChatTrace::default()),
            tts,
            tts_provider,
            db_path,
            schema_version,
            instance_port,
        })
    }

    pub fn new(instance_port: u16) -> anyhow::Result<Self> {
        Self::open(database_path(), instance_port)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.bus.subscribe()
    }

    /// Acceso al bus para pruebas de integracion y para modulos que quieran
    /// publicar eventos propios (el lector de voz, por ejemplo).
    pub fn event_bus(&self) -> Arc<EventBus> {
        self.bus.clone()
    }

    pub fn metrics(&self) -> MetricsSnapshot {
        self.metrics.snapshot()
    }

    /// Futuro del consumidor de estado: aplica al estado todo lo que pasa por el
    /// bus (chat, sesion, base de datos).
    ///
    /// Devuelve el futuro en lugar de lanzarlo a proposito. El setup de Tauri se
    /// ejecuta en el hilo principal **sin** runtime de Tokio, asi que llamar a
    /// `tokio::spawn` desde ahi panica. El llamante decide donde ejecutarlo:
    /// `tauri::async_runtime` en la aplicacion, `tokio::spawn` en los tests.
    pub fn consumer_future(self: &Arc<Self>) -> impl std::future::Future<Output = ()> + Send + 'static {
        let state = self.clone();
        // La suscripcion se hace **aqui**, no dentro del bloque async: si
        // esperase al primer `poll`, todo lo publicado entre el spawn y el
        // primer poll se perderia (el bus solo entrega a quien ya escucha).
        let mut receiver = state.subscribe();
        async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => state.on_event(&event),
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        state
                            .metrics
                            .subscription_lagged
                            .fetch_add(skipped, Ordering::Relaxed);
                        tracing::warn!(skipped, "el consumidor de estado va por detras");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    /// Envia trabajo al escritor.
    ///
    /// Politica de descarte (docs/plan-review.md §6):
    ///   * **criticos** (regalos, follows, eventos sociales): nunca se pierden en
    ///     silencio. Si la cola esta llena se espera un poco; si aun asi no cabe,
    ///     se cuenta en `db_critical_dropped` y queda registrado como ERROR, para
    ///     que la sesion se vea degradada en lugar de mentir con los totales.
    ///   * **descartables** (persistencia del chat): se descartan y se cuentan.
    fn persist(&self, job: WriteJob, critical: bool) {
        let guard = match self.writer.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let Some(writer) = guard.as_ref() else {
            return;
        };
        if critical {
            if !writer.send_critical(job, WRITER_BLOCK_TIMEOUT) {
                self.metrics
                    .db_critical_dropped
                    .fetch_add(1, Ordering::Relaxed);
                tracing::error!(
                    timeout_ms = WRITER_BLOCK_TIMEOUT.as_millis() as u64,
                    "cola de base de datos saturada: se perdio un evento critico"
                );
            }
        } else if !writer.try_send(job) {
            tracing::debug!("evento descartable descartado (cola llena)");
        }
    }

    pub fn current_provider(&self) -> Arc<dyn TikTokProvider> {
        self.provider
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| self.native.clone() as Arc<dyn TikTokProvider>)
    }

    /// Procesa un evento: chat en memoria, persistencia y estado de sesion.
    pub fn on_event(&self, event: &Event) {
        match &event.kind {
            EventKind::StreamConnected { room_id, title } => {
                let stream_id = format!("{room_id}-{}", event.timestamp_ms);
                if let Ok(mut guard) = self.stream_id.write() {
                    *guard = Some(stream_id.clone());
                }
                if let Ok(mut guard) = self.title.write() {
                    *guard = title.clone();
                }
                if let Ok(mut guard) = self.started_at_ms.write() {
                    *guard = Some(event.timestamp_ms);
                }
                // El resumen de regalos es de la sesion: al empezar una nueva, se
                // empieza de cero. El feed de actividad, en cambio, es un
                // registro continuo y no se vacia.
                if let Ok(mut gifts) = self.gifts.lock() {
                    gifts.clear();
                }
                let handle = self.handle.read().map(|g| g.clone()).unwrap_or_default();
                self.push_feed(FeedItem::info(
                    event.seq,
                    event.timestamp_ms,
                    if handle.is_empty() {
                        format!("conectado a la sala {room_id}")
                    } else {
                        format!("conectado a @{handle}")
                    },
                ));
                self.persist(
                    WriteJob::StreamStarted {
                        stream_id,
                        handle,
                        room_id: room_id.clone(),
                        title: title.clone(),
                        started_at: event.timestamp_ms,
                    },
                    true,
                );
            }

            EventKind::StreamDisconnected { reason } => {
                self.push_feed(FeedItem::info(
                    event.seq,
                    event.timestamp_ms,
                    format!("conexión cerrada · {reason}"),
                ));
                if let Ok(mut guard) = self.started_at_ms.write() {
                    *guard = None;
                }
                let stream_id = self.stream_id.write().ok().and_then(|mut g| g.take());
                if let Some(stream_id) = stream_id {
                    self.persist(
                        WriteJob::StreamEnded {
                            stream_id,
                            ended_at: event.timestamp_ms,
                            crashed: false,
                        },
                        true,
                    );
                }
            }

            EventKind::ChatMessage { user, content } => {
                let entry = ChatEntry {
                    seq: event.seq,
                    timestamp_ms: event.timestamp_ms,
                    user: user.clone(),
                    content: content.clone(),
                    source_id: event.source_id.clone(),
                };
                if let Ok(mut buffer) = self.chat.lock() {
                    buffer.push(entry);
                }
                if let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) {
                    self.persist(
                        WriteJob::Comment {
                            stream_id,
                            user_id: user.id.clone(),
                            nickname: user.nickname.clone(),
                            content: content.clone(),
                            timestamp_ms: event.timestamp_ms,
                            source_id: event.source_id.clone(),
                        },
                        false,
                    );
                }
            }

            EventKind::GiftReceived { user, gift } => {
                self.push_feed(FeedItem::gift(
                    event.seq,
                    event.timestamp_ms,
                    user.clone(),
                    gift.clone(),
                ));
                if let Ok(mut board) = self.gifts.lock() {
                    board.record(GiftEventView {
                        seq: event.seq,
                        timestamp_ms: event.timestamp_ms,
                        user: user.clone(),
                        gift_id: gift.id.clone(),
                        gift_name: gift.name.clone(),
                        image_url: gift.image_url.clone(),
                        repeat_count: gift.repeat_count,
                        diamond_count: gift.diamond_count,
                        streakable: gift.streakable,
                        is_final: gift.is_final,
                        group_id: gift.group_id.clone(),
                    });
                }
                self.publish_gift_board(gift);

                // Solo se contabiliza cuando la aportacion esta completa: los
                // eventos de progreso de una racha son acumulativos.
                let (units, diamonds) = if gift.commits() {
                    (i64::from(gift.units()), i64::from(gift.diamonds()))
                } else {
                    (0, 0)
                };
                if let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) {
                    // Los regalos mueven dinero y rankings: nunca se descartan.
                    self.persist(
                        WriteJob::Gift {
                            stream_id,
                            user_id: user.id.clone(),
                            gift_id: gift.id.clone(),
                            gift_name: gift.name.clone(),
                            diamond_count: gift.diamond_count,
                            repeat_count: gift.repeat_count,
                            is_final: gift.is_final,
                            group_id: gift.group_id.clone(),
                            timestamp_ms: event.timestamp_ms,
                            source_id: event.source_id.clone(),
                            committed_units: units,
                            committed_diamonds: diamonds,
                        },
                        true,
                    );
                }
            }

            EventKind::FollowReceived { user } => {
                self.push_feed(FeedItem::social(
                    event.seq,
                    event.timestamp_ms,
                    FeedKind::Follow,
                    user.clone(),
                ));
                // Los follows siguen guardandose en su tabla de siempre: no se
                // fragmenta el historico que ya existe.
                if let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) {
                    self.persist(
                        WriteJob::Follow {
                            stream_id,
                            user_id: user.id.clone(),
                            timestamp_ms: event.timestamp_ms,
                            source_id: event.source_id.clone(),
                        },
                        true,
                    );
                }
            }

            EventKind::ShareReceived { user } => {
                self.push_feed(FeedItem::social(
                    event.seq,
                    event.timestamp_ms,
                    FeedKind::Share,
                    user.clone(),
                ));
                self.persist_social(event, "share", user);
            }

            EventKind::SubscribeReceived { user, months } => {
                self.push_feed(FeedItem::subscribe(
                    event.seq,
                    event.timestamp_ms,
                    user.clone(),
                    *months,
                ));
                self.persist_social(event, "subscribe", user);
            }

            EventKind::LikeUpdated {
                user,
                count,
                total,
            } => {
                // Solo las rafagas grandes van al feed: si no, lo inundan.
                if like_is_notable(*count) {
                    self.push_feed(FeedItem::likes(
                        event.seq,
                        event.timestamp_ms,
                        user.clone(),
                        *count,
                        *total,
                    ));
                }
            }

            EventKind::StreamWaiting { handle, detail } => {
                self.push_feed(FeedItem::info(
                    event.seq,
                    event.timestamp_ms,
                    format!("esperando a @{handle} · {detail}"),
                ));
            }

            EventKind::ProviderStatus { status, detail } => {
                // Solo los problemas merecen aparecer en la actividad.
                if status == "error" {
                    self.push_feed(FeedItem::info(
                        event.seq,
                        event.timestamp_ms,
                        format!(
                            "error de conexión · {}",
                            detail.clone().unwrap_or_else(|| "sin detalle".into())
                        ),
                    ));
                }
            }

            _ => {}
        }
    }

    /// Publica los agregados de regalos ya calculados.
    ///
    /// Se coalesce a **una vez por segundo** para no inundar la interfaz en una
    /// lluvia de regalos, pero un cierre de racha se publica siempre: es el dato
    /// que el streamer esta mirando.
    fn publish_gift_board(&self, gift: &crate::core::event::GiftInfo) {
        let ahora = std::time::Instant::now();
        let publicar = match self.last_board.lock() {
            Ok(mut ultimo) => {
                let toca = ultimo
                    .map(|previo| ahora.duration_since(previo) >= Duration::from_secs(1))
                    .unwrap_or(true);
                if toca || gift.is_final {
                    *ultimo = Some(ahora);
                    true
                } else {
                    false
                }
            }
            Err(_) => false,
        };
        if !publicar {
            return;
        }

        let Ok(board) = self.gifts.lock() else {
            return;
        };
        self.bus.publish(
            None,
            EventKind::GiftsUpdated {
                total_gifts: board.total_gifts(),
                total_diamonds: board.total_diamonds(),
                top_gifters: board.top_gifters(10),
                gifts_by_type: board.by_gift(10),
            },
        );
    }

    /// Anade un item ya estructurado al feed de actividad.
    fn push_feed(&self, item: FeedItem) {
        if let Ok(mut feed) = self.feed.lock() {
            feed.push(item);
        }
    }

    /// Persiste un evento social (follow, share o suscripcion).
    ///
    /// Son eventos de **valor** pero no mueven dinero como los regalos, asi que
    /// se marcan como descartables si la cola de escritura se llena.
    fn persist_social(&self, event: &Event, kind: &str, user: &crate::core::event::UserRef) {
        let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) else {
            return;
        };
        self.persist(
            WriteJob::Social {
                stream_id,
                kind: kind.to_string(),
                user_id: user.id.clone(),
                nickname: user.nickname.clone(),
                timestamp_ms: event.timestamp_ms,
                source_id: event.source_id.clone(),
            },
            false,
        );
    }

    /// Vacia el feed de actividad (no toca el resumen de regalos).
    pub fn clear_feed(&self) {
        if let Ok(mut feed) = self.feed.lock() {
            feed.clear();
        }
    }

    /// La interfaz informa de un mensaje de chat recibido o de una lista pintada.
    ///
    /// Es la unica forma de saber **en que eslabon** se para el chat: Rust puede
    /// comprobar hasta el WebView, no dentro de React.
    pub fn note_ui_chat(
        &self,
        received_seq: Option<u64>,
        rendered_len: Option<u64>,
        rendered_seq: Option<u64>,
        dom: Option<&str>,
    ) {
        let Ok(mut traza) = self.ui_chat.lock() else {
            return;
        };
        if let Some(seq) = received_seq {
            traza.received += 1;
            traza.last_received_seq = seq;
            // Los primeros mensajes se registran uno a uno para poder seguirlos.
            if traza.received <= 5 {
                tracing::info!(seq, recibidos = traza.received, "chat recibido por la interfaz");
            } else if traza.received % 25 == 0 {
                tracing::info!(seq, recibidos = traza.received, "chat recibido por la interfaz");
            }
            // Aviso inequivoco: llegan mensajes y React no ha pintado ninguna
            // lista. Se deja un margen porque los informes van por rafagas.
            if !traza.warned && traza.received >= 8 && traza.rendered == 0 {
                traza.warned = true;
                tracing::warn!(
                    "la interfaz recibe mensajes de chat pero no ha renderizado ninguna lista: \
                     el fallo esta en el estado o el render de React, no en la cadena de eventos"
                );
            }
        }
        if let Some(len) = rendered_len {
            traza.rendered += 1;
            traza.rendered_len = len;
            if let Some(seq) = rendered_seq {
                traza.last_rendered_seq = seq;
            }
            if let Some(medida) = dom {
                traza.last_dom = medida.to_string();
            }
            if traza.rendered <= 5 {
                tracing::info!(
                    mensajes = len,
                    ultimo_seq = traza.last_rendered_seq,
                    dom = %traza.last_dom,
                    "chat renderizado por la interfaz"
                );
            } else if traza.rendered % 25 == 0 {
                tracing::info!(
                    mensajes = len,
                    renderizados = traza.rendered,
                    dom = %traza.last_dom,
                    "chat renderizado por la interfaz"
                );
            }
        }
    }

    /// Traza del chat, para el panel de diagnostico.
    pub fn ui_chat_trace(&self) -> UiChatTrace {
        self.ui_chat
            .lock()
            .map(|traza| traza.clone())
            .unwrap_or_default()
    }

    /// Registra los eventos que la interfaz ha reconocido y pintado.
    ///
    /// La primera vez que aparece un tipo se anota en el log: es la prueba de
    /// que el flujo llego hasta el render, no solo hasta el WebView.
    pub fn note_ui_events(&self, counts: &std::collections::HashMap<String, u64>) {
        let Ok(mut acumulado) = self.ui_events.lock() else {
            return;
        };
        for (kind, count) in counts {
            let entrada = acumulado.entry(kind.clone()).or_insert(0);
            if *entrada == 0 {
                tracing::info!(
                    kind = %kind,
                    "la interfaz ha reconocido un tipo de evento nuevo"
                );
            }
            *entrada += count;
        }
    }

    /// Tipos de evento reconocidos por la interfaz, ordenados por cantidad.
    pub fn ui_event_counts(&self) -> Vec<(String, u64)> {        let mut lista: Vec<(String, u64)> = self
            .ui_events
            .lock()
            .map(|mapa| mapa.iter().map(|(k, v)| (k.clone(), *v)).collect())
            .unwrap_or_default();
        lista.sort_by(|a, b| b.1.cmp(&a.1));
        lista
    }

    pub fn snapshot(&self) -> Snapshot {
        let chat = self
            .chat
            .lock()
            .map(|buffer| buffer.recent(CHAT_CAPACITY))
            .unwrap_or_default();
        let events = self
            .feed
            .lock()
            .map(|feed| feed.recent(FEED_CAPACITY))
            .unwrap_or_default();
        let (gifts, top_gifters, gifts_by_type, total_gifts, total_diamonds) = self
            .gifts
            .lock()
            .map(|board| {
                (
                    board.recent(60),
                    board.top_gifters(10),
                    board.by_gift(10),
                    board.total_gifts(),
                    board.total_diamonds(),
                )
            })
            .unwrap_or_default();
        let provider = self.current_provider();
        let (written, dropped) = self
            .writer
            .lock()
            .ok()
            .and_then(|guard| {
                guard
                    .as_ref()
                    .map(|writer| (writer.written(), writer.dropped()))
            })
            .unwrap_or((0, 0));

        Snapshot {
            protocol_version: PROTOCOL_VERSION,
            provider: provider.name().to_string(),
            status: provider.status().as_str().to_string(),
            handle: self.handle.read().map(|g| g.clone()).unwrap_or_default(),
            room_id: self.bus.room_id(),
            stream_id: self.stream_id.read().ok().and_then(|g| g.clone()),
            title: self.title.read().map(|g| g.clone()).unwrap_or_default(),
            started_at_ms: self.started_at_ms.read().ok().and_then(|g| *g),
            chat,
            events,
            gifts,
            top_gifters,
            gifts_by_type,
            total_gifts,
            total_diamonds,
            metrics: self.metrics.snapshot(),
            db_path: self.db_path.display().to_string(),
            schema_version: self.schema_version,
            db_written: written,
            db_dropped: dropped,
            log_dir: telemetry::log_dir().display().to_string(),
            instance_port: self.instance_port,
            ui_events: self.ui_event_counts(),
            tts: self.tts.status(),
            ui_chat: self.ui_chat_trace(),
        }
    }

    /// Cierre ordenado: se vacia la cola de escritura antes de salir.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.writer.lock() {
            if let Some(writer) = guard.take() {
                writer.close();
            }
        }
    }

    /// Cierre del TTS: detiene la sintesis y el sidecar.
    ///
    /// Es asincrono porque apaga un proceso hijo. El sidecar tambien termina solo
    /// cuando se cierra su entrada estandar, asi que un cierre brusco de la
    /// aplicacion no deja procesos huerfanos.
    pub async fn shutdown_tts(&self) {
        self.tts.shutdown().await;
    }

    /// Estado del TTS para la interfaz.
    pub fn tts_status(&self) -> TtsStatus {
        self.tts.status()
    }

    /// Configuracion actual del TTS.
    pub fn tts_settings(&self) -> TtsSettings {
        self.tts.settings()
    }
}

/// Traza del chat desde el bus hasta la pantalla.
///
/// Distingue los dos ultimos eslabones, que no se pueden comprobar desde Rust:
///   * `received`: la interfaz recibio el evento del chat;
///   * `rendered`: React volvio a pintar la lista con ese mensaje dentro.
///
/// Si `received` sube y `rendered` se queda quieto, el fallo esta en el estado de
/// React o en su render, no en la cadena de eventos ni en el WebSocket.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct UiChatTrace {
    pub received: u64,
    pub rendered: u64,
    pub last_received_seq: u64,
    pub last_rendered_seq: u64,
    pub rendered_len: u64,
    /// Ultima medida del DOM enviada por la interfaz (quien desplaza la lista).
    pub last_dom: String,
    /// Ya se aviso de una brecha entre recibidos y pintados (no se serializa).
    #[serde(skip)]
    pub warned: bool,
}

/// Estado visible que pide la interfaz al abrirse.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Snapshot {
    pub protocol_version: u32,
    pub provider: String,
    pub status: String,
    pub handle: String,
    pub room_id: String,
    pub stream_id: Option<String>,
    pub title: String,
    /// Inicio de la sesion actual, para mostrar su duracion.
    pub started_at_ms: Option<i64>,
    pub chat: Vec<ChatEntry>,
    /// Actividad reciente: regalos, follows, likes grandes y avisos.
    pub events: Vec<FeedItem>,
    /// Regalos de la sesion actual, del mas nuevo al mas antiguo.
    pub gifts: Vec<GiftEventView>,
    /// Quienes mas diamantes han aportado en esta sesion.
    pub top_gifters: Vec<GifterEntry>,
    /// Regalos agrupados por tipo.
    pub gifts_by_type: Vec<GiftTypeSummary>,
    pub total_gifts: i64,
    pub total_diamonds: i64,
    pub metrics: MetricsSnapshot,
    pub db_path: String,
    pub schema_version: u32,
    pub db_written: u64,
    pub db_dropped: u64,
    pub log_dir: String,
    pub instance_port: u16,
    /// Eventos reconocidos por la interfaz, por tipo (diagnostico).
    pub ui_events: Vec<(String, u64)>,
    /// Estado del lector de chat en voz alta.
    pub tts: TtsStatus,
    /// Traza del chat: recibido en la interfaz frente a renderizado por React.
    pub ui_chat: UiChatTrace,
}

/// Base de datos temporal para los tests.
#[cfg(test)]
pub(crate) fn temp_db_path(tag: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("ttdash-{tag}-{}-{unique}.db", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::UserRef;

    fn cleanup(path: &PathBuf) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn el_estado_arranca_y_cierra_sin_panicos() {
        let path = temp_db_path("estado");
        let state = AppState::open(path.clone(), 0).expect("estado");
        let snapshot = state.snapshot();
        assert_eq!(snapshot.protocol_version, PROTOCOL_VERSION);
        assert_eq!(snapshot.provider, "native");
        assert_eq!(snapshot.status, "stopped");
        assert!(snapshot.chat.is_empty());
        assert_eq!(snapshot.schema_version, crate::database::SCHEMA_VERSION);
        state.shutdown();
        cleanup(&path);
    }

    #[test]
    fn el_chat_del_estado_es_acotado() {
        let path = temp_db_path("chat");
        let state = AppState::open(path.clone(), 0).expect("estado");
        let user = UserRef {
            id: "1".into(),
            unique_id: "u".into(),
            nickname: "Nick".into(),
        };
        for seq in 1..=(CHAT_CAPACITY as u64 + 50) {
            let event = Event::new(
                seq,
                "sala".into(),
                Some(format!("m{seq}")),
                EventKind::ChatMessage {
                    user: user.clone(),
                    content: format!("mensaje {seq}"),
                },
            );
            state.on_event(&event);
        }
        let snapshot = state.snapshot();
        assert_eq!(snapshot.chat.len(), CHAT_CAPACITY, "el buffer esta acotado");
        // El contador del propio buffer refleja todo lo que ha visto, aunque ya
        // no este en memoria. (`metrics.chat_messages` cuenta el bus, y aqui se
        // llama a `on_event` directamente.)
        let total = state
            .chat
            .lock()
            .map(|buffer| buffer.total())
            .expect("cerrojo");
        assert_eq!(total, CHAT_CAPACITY as u64 + 50);
        state.shutdown();
        cleanup(&path);
    }

    /// Flujo completo del Milestone 1: proveedor simulado -> bus -> chat ->
    /// SQLite, sin Tauri y sin red.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn el_flujo_completo_llega_al_chat_y_a_la_base_de_datos() {
        use crate::providers::TikTokProvider;

        let path = temp_db_path("flujo");
        let state = Arc::new(AppState::open(path.clone(), 0).expect("estado"));
        let _consumer = tokio::spawn(state.consumer_future());

        // Se usa el simulador con cadencia alta para no alargar el test.
        {
            let mut guard = state.provider.write().expect("cerrojo de proveedor");
            *guard = state.simulated.clone() as Arc<dyn TikTokProvider>;
        }
        state.simulated.set_interval(std::time::Duration::from_millis(5));
        if let Ok(mut guard) = state.handle.write() {
            *guard = "prueba".into();
        }
        state
            .simulated
            .connect("prueba")
            .await
            .expect("arranca el simulador");

        // Se espera a que el consumidor procese un numero suficiente de eventos.
        // El plazo es generoso a proposito: en la suite completa hay otros tests
        // compitiendo por los hilos.
        let mut mensajes = 0;
        for _ in 0..250 {
            mensajes = state.chat.lock().map(|buffer| buffer.len()).unwrap_or(0);
            if mensajes >= 10 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let sesion_abierta = state.snapshot().stream_id.is_some();
        state.simulated.disconnect().await;
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;

        let snapshot = state.snapshot();
        assert!(
            snapshot.chat.len() >= 10,
            "el chat deberia tener mensajes, tiene {} (mensajes={mensajes})",
            snapshot.chat.len()
        );
        assert!(snapshot.metrics.gifts > 0, "el simulador emite regalos");
        assert!(
            sesion_abierta,
            "la sesion deberia estar abierta mientras corre el simulador"
        );
        assert!(
            snapshot.stream_id.is_none(),
            "al desconectar, la sesion se cierra"
        );

        state.shutdown(); // vuelca la cola de escritura

        let database = Database::open(&path).expect("reabriendo la base");
        assert!(
            database.count("comments").unwrap() >= 5,
            "los comentarios deberian persistirse"
        );
        assert!(database.count("gift_events").unwrap() > 0, "y los regalos");
        assert_eq!(database.count("streams").unwrap(), 1, "una sola sesion");

        // La sesion queda cerrada, no interrumpida: el cierre fue ordenado.
        let abiertas = database
            .query_i64("SELECT COUNT(*) FROM streams WHERE ended_at IS NULL", 0)
            .unwrap();
        assert_eq!(abiertas, Some(0));

        drop(database);
        cleanup(&path);
    }
}
