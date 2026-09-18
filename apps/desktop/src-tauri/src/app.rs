//! Motor de la aplicacion: estado, suscripcion al bus y persistencia.
//!
//! Deliberadamente **no depende de Tauri**. El shell de escritorio
//! (`desktop.rs`) solo anade comandos y la ventana. Ventaja concreta: el flujo
//! completo (bus -> chat -> SQLite) se puede probar en CI en segundos, sin
//! compilar Tauri.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::broadcast;

use crate::chat::{ChatBuffer, ChatEntry};
use crate::core::event::{Event, Perfil};
use crate::core::{EventBus, EventKind, Metrics, MetricsSnapshot, PROTOCOL_VERSION};
use crate::database::{database_path, Database, DbWriter, WriteJob};
use crate::feed::{
    like_is_notable, EventFeed, FeedItem, FeedKind, GiftBoard, GiftEventView, GiftTypeSummary,
    RankingBoard, RankingEntry, FEED_CAPACITY,
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
/// Puestos que se envian de cada tabla de ranking.
///
/// Diez por tabla: es lo que cabe de un vistazo en el panel y en el overlay sin
/// desplazar, y coincide con lo que ya publica el tablero de regalos.
pub const RANKING_TOP: usize = 10;
/// Mensajes de chat que se conservan y se envian a la interfaz.
pub const CHAT_CAPACITY: usize = 200;
/// Cuantos usuarios se recuerdan para el campo de conexion.
///
/// Cuatro: es lo que se lee de un vistazo en la lista de sugerencias del campo.
/// Mas seria un historico, y para eso ya esta la tabla `streams`.
pub const USUARIOS_RECORDADOS: usize = 4;
/// Longitud maxima de un usuario que se acepta al recordarlo.
///
/// Es el mismo tope que usa `desktop::abrir_perfil` para construir la direccion
/// del perfil: lo que no vale para abrirlo tampoco vale para recordarlo.
const MAX_USUARIO: usize = 32;

pub struct AppState {
    pub(crate) bus: Arc<EventBus>,
    pub(crate) metrics: Arc<Metrics>,
    pub(crate) chat: Mutex<ChatBuffer>,
    /// Actividad reciente (regalos, follows, likes grandes, avisos).
    pub(crate) feed: Mutex<EventFeed>,
    /// Resumen de regalos **de la sesion actual**.
    pub(crate) gifts: Mutex<GiftBoard>,
    /// Tap tap: likes acumulados por persona en la sesion.
    ///
    /// Es lo que el publico "toca" para animar el directo. Se agrega aqui y no
    /// en la interfaz para que las tres tablas de ranking y el overlay cuenten
    /// exactamente lo mismo.
    pub(crate) taps: Mutex<RankingBoard>,
    /// Diamantes y unidades aportados por persona en la sesion.
    ///
    /// **No hay tablero propio de regalos**: la tabla se deriva del `GiftBoard`
    /// (ver `publish_rankings`), que ya lleva el gasto por persona y la
    /// liquidacion de rachas.
    /// Seguidores nuevos por persona en la sesion.
    pub(crate) follow_ranking: Mutex<RankingBoard>,
    /// Si se guardan los totales de por vida de quien aporta.
    ///
    /// Va **apagado** por defecto: acumular un historico de personas es una
    /// decision del streamer, no algo que deba pasar sin que lo pida.
    pub(crate) lifetime_enabled: AtomicBool,
    /// Aportaciones pendientes de sumar al historico, por persona.
    ///
    /// Se acumulan aqui y se vuelcan cada pocos segundos: un tap no puede costar
    /// una escritura a disco, y en un directo movido llegan decenas por segundo.
    pub(crate) pending_lifetime: Mutex<Option<PendingLifetime>>,
    /// Ultima vez que se volco el historico (mismo criterio que `last_board`).
    pub(crate) last_lifetime: Mutex<Option<std::time::Instant>>,
    /// Avatares ya enviados a la base, para no repetir la escritura.
    ///
    /// El avatar viaja en cada evento, asi que sin esta memoria se escribiria el
    /// perfil en cada comentario. Es una cache de escritura, no de lectura: solo
    /// interesa saber si esa persona ya tiene su foto guardada.
    pub(crate) avatars_guardados: Mutex<std::collections::HashSet<String>>,
    pub(crate) provider: RwLock<Arc<dyn TikTokProvider>>,
    pub(crate) native: Arc<NativeProvider>,
    pub(crate) simulated: Arc<SimulatedProvider>,
    pub(crate) writer: Mutex<Option<DbWriter>>,
    pub(crate) stream_id: RwLock<Option<String>>,
    pub(crate) handle: RwLock<String>,
    /// Ultimos usuarios con los que el streamer se ha conectado, el mas reciente
    /// primero.
    ///
    /// No es el historico de sesiones: eso es `streams.handle`, una fila por
    /// directo. Esto es la comodidad del campo de conexion: al arrancar se
    /// rellena con el primero y todos se ofrecen como sugerencia.
    pub(crate) ultimos_usuarios: RwLock<Vec<String>>,
    pub(crate) title: RwLock<String>,
    /// Perfil del duenio de la sala, para la ficha de la cabecera.
    ///
    /// Puede quedar vacio sin que pase nada: TikTok no siempre lo manda y la
    /// sesion sigue exactamente igual. Se vacia al conectar con otro usuario para
    /// que la ficha del anterior no se quede puesta.
    pub(crate) perfil: RwLock<Perfil>,
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
    /// Ultima vez que se publicaron las tablas de ranking (coalescing).
    ///
    /// Va **aparte** de `last_board` a proposito: con un solo reloj, una lluvia
    /// de regalos silenciaria las actualizaciones de tap tap y el ranking de
    /// likes se quedaria congelado justo cuando mas se mueve.
    pub(crate) last_rankings: Mutex<Option<std::time::Instant>>,
    /// Progreso de la sesion pendiente de escribir: pico de espectadores y
    /// total de likes. Va aparte del feed porque su destino es la fila de
    /// `streams`, no una tabla de eventos.
    pub(crate) progress: Mutex<SessionProgress>,
    /// Traza del chat (recibido en la interfaz / renderizado por React).
    pub(crate) ui_chat: Mutex<UiChatTrace>,
    /// Lectura del chat en voz alta. Vive en su propio modulo y solo depende del
    /// bus: no conoce nada de TikTok ni de Tauri.
    pub(crate) tts: Arc<TtsManager>,
    /// Proveedor de sintesis (sidecar edge-tts), compartido con el manager.
    ///
    /// El gestor guarda su propio clon y hoy nadie mas lo lee, pero se conserva
    /// como unico punto de construccion del sidecar para lo que no pasa por el
    /// gestor (por ejemplo un comando de voces o de salud, que son metodos del
    /// trait `TtsProvider`). De ahi el `allow`: el campo sigue aqui a proposito,
    /// no es codigo muerto olvidado.
    #[allow(dead_code)]
    pub(crate) tts_provider: SharedTtsProvider,
    pub(crate) db_path: PathBuf,
    pub(crate) schema_version: u32,
    /// Configuracion del servidor de overlays (token, puerto y diseno), si esta
    /// activo.
    ///
    /// La rellena el **shell de escritorio** al arrancar el servidor, no
    /// `AppState::open`: asi los tests y la autoverificacion —que construyen el
    /// mismo estado— no abren puertos ni escriben ficheros de configuracion.
    ///
    /// Va en un `Arc<RwLock<..>>` porque la celda la comparte el servidor de
    /// overlays: cambiar el diseno de una vista se ve en la siguiente peticion de
    /// OBS sin reiniciar nada, y no hay dos copias que puedan discrepar.
    pub(crate) overlay: Arc<RwLock<Option<Arc<crate::overlay::OverlayConfig>>>>,
    /// Ajustes de las alertas de OBS (que dispara, con que medio y con que texto).
    ///
    /// En memoria porque cada evento los consulta: leer la base en cada regalo
    /// seria absurdo. Se cargan al abrir y se escriben al guardar.
    pub(crate) alertas: RwLock<crate::alerts::AjustesAlertas>,
    /// La cola de avisos. La comparte el servidor de overlays: el motor encola y
    /// el servidor entrega, y los dos tienen que ver la misma lista.
    pub(crate) cola_alertas: Arc<crate::alerts::ColaAlertas>,
    /// La salida de audio del **monitor de alertas**: por donde las oye el streamer
    /// en esta maquina.
    ///
    /// No es la salida de la audiencia —esa es la fuente de OBS— y por eso es un
    /// reproductor aparte del lector de voz, con su propio dispositivo y volumen.
    pub(crate) salida_alertas: RwLock<Arc<dyn crate::tts::player::AudioSink>>,
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
        // La configuracion se lee antes de construir `TtsManager`: el primer
        // evento que llegue al bus debe usar el perfil real, no un instante de
        // valores de fabrica. `#[serde(default)]` permite que el perfil v4
        // inicial `{}` evolucione sin romper instalaciones existentes.
        let tts_settings = match database.default_tts_profile()? {
            Some(json) => match serde_json::from_str::<TtsSettings>(&json) {
                Ok(settings) => settings,
                Err(error) => {
                    tracing::warn!(%error, "perfil TTS invalido; se usan valores predeterminados");
                    TtsSettings::default()
                }
            },
            None => TtsSettings::default(),
        };
        // Los ajustes de alertas, por el mismo motivo: el primer regalo del
        // directo tiene que disparar ya con lo que el streamer configuro, no con
        // los valores de fabrica. Un JSON ilegible no impide arrancar.
        let alertas = match database.alert_settings()? {
            Some(json) => match serde_json::from_str::<crate::alerts::AjustesAlertas>(&json) {
                Ok(ajustes) => ajustes,
                Err(error) => {
                    tracing::warn!(%error, "ajustes de alertas ilegibles; se usan los de fabrica");
                    crate::alerts::AjustesAlertas::de_fabrica()
                }
            },
            None => crate::alerts::AjustesAlertas::de_fabrica(),
        };
        // Se copia el dispositivo antes de mover `alertas` al estado: hace falta para
        // abrir la salida del monitor.
        let ajustes_salida_alertas = Some(alertas.salida.clone());
        // Los ultimos usuarios, por el mismo motivo que los ajustes de alertas: el
        // campo de conexion nace ya con el de ayer en lugar de vacio. Se sanean al
        // leerlos (la base puede traer una lista editada a mano o de una version
        // anterior) y el primero es tambien el handle inicial, para que la
        // cabecera y el campo digan lo mismo.
        let ultimos_usuarios = match database.recent_handles()? {
            Some(json) => match serde_json::from_str::<Vec<String>>(&json) {
                Ok(guardados) => sanear_usuarios(&guardados),
                Err(error) => {
                    tracing::warn!(%error, "usuarios recordados ilegibles; el campo arranca vacio");
                    Vec::new()
                }
            },
            None => Vec::new(),
        };
        let handle_inicial = ultimos_usuarios.first().cloned().unwrap_or_default();
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
        let tts_provider: SharedTtsProvider =
            Arc::new(EdgeTtsSidecar::new(crate::tts::default_config()));
        let sink: Arc<dyn AudioSink> = Arc::new(FallbackSink::with_device(
            tts_settings.audio_device.as_deref(),
        ));
        let tts = Arc::new(TtsManager::new(
            tts_settings,
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
            taps: Mutex::new(RankingBoard::default()),
            follow_ranking: Mutex::new(RankingBoard::default()),
            lifetime_enabled: AtomicBool::new(false),
            pending_lifetime: Mutex::new(Some(PendingLifetime::default())),
            last_lifetime: Mutex::new(None),
            avatars_guardados: Mutex::new(std::collections::HashSet::new()),
            provider: RwLock::new(native.clone() as Arc<dyn TikTokProvider>),
            native,
            simulated,
            writer: Mutex::new(Some(writer)),
            stream_id: RwLock::new(None),
            handle: RwLock::new(handle_inicial),
            title: RwLock::new(String::new()),
            perfil: RwLock::new(Perfil::default()),
            started_at_ms: RwLock::new(None),
            ui_events: Mutex::new(std::collections::HashMap::new()),
            last_board: Mutex::new(None),
            last_rankings: Mutex::new(None),
            progress: Mutex::new(SessionProgress::default()),
            ui_chat: Mutex::new(UiChatTrace::default()),
            ultimos_usuarios: RwLock::new(ultimos_usuarios),
            tts,
            tts_provider,
            db_path,
            schema_version,
            overlay: Arc::new(RwLock::new(None)),
            alertas: RwLock::new(alertas),
            salida_alertas: RwLock::new(Arc::new(crate::tts::player::FallbackSink::with_device(
                ajustes_salida_alertas
                    .as_ref()
                    .and_then(|salida| salida.dispositivo()),
            ))),
            cola_alertas: Arc::new(crate::alerts::ColaAlertas::nueva()),
            instance_port,
        })
    }

    pub fn new(instance_port: u16) -> anyhow::Result<Self> {
        Self::open(database_path(), instance_port)
    }

    /// Conecta el proveedor activo **y** recuerda a que usuario.
    ///
    /// Es el unico sitio donde se abre una sesion, y existe por un motivo
    /// concreto: el handle es lo que acaba en `streams.handle` (lo lee
    /// `on_event` al recibir `StreamConnected`). El arranque automatico
    /// (`TTSDASH_AUTOSTART`) llamaba al proveedor directamente, asi que la
    /// sesion se guardaba con `handle` vacio aunque el proveedor se hubiera
    /// conectado a un usuario concreto.
    pub async fn connect(&self, handle: &str) -> anyhow::Result<()> {
        let limpio = handle.trim().trim_start_matches('@').to_string();
        if let Ok(mut guard) = self.handle.write() {
            *guard = limpio.clone();
        }
        // Se recuerda **aqui**, en el momento en que el streamer dice "esta es mi
        // cuenta", y no cuando la sala se resuelve: quien esta fuera de directo no
        // resuelve sala nunca, y es justo el caso de estar preparando la sesion.
        // El guardado no puede tumbar la conexion: `recordar_usuario` avisa en el
        // log y sigue.
        self.recordar_usuario(&limpio);
        // La ficha del usuario anterior no puede sobrevivir al cambio de sesion:
        // se vacia ahora y la rellena la resolucion de la sala nueva.
        if let Ok(mut guard) = self.perfil.write() {
            *guard = Perfil::default();
        }
        self.current_provider().connect(&limpio).await
    }

    /// Recuerda el usuario de la conexion para la proxima vez.
    ///
    /// Es una **comodidad**, no parte de la conexion: la lista en memoria se
    /// actualiza siempre (es la que rellena el campo y ofrece las sugerencias en
    /// esta misma sesion) y si la escritura no se puede encolar se avisa en el
    /// log y se sigue, porque conectar es lo importante.
    fn recordar_usuario(&self, handle: &str) {
        let Ok(mut lista) = self.ultimos_usuarios.write() else {
            tracing::warn!("cerrojo de usuarios recordados envenenado; no se recuerda el usuario");
            return;
        };
        anotar_usuario(&mut lista, handle);
        let handles_json = match serde_json::to_string(&*lista) {
            Ok(json) => json,
            Err(error) => {
                tracing::warn!(%error, "no se pudo serializar la lista de usuarios recordados");
                return;
            }
        };
        // Descartable a proposito: perder la lista no cambia nada de lo que se
        // guarda en el historico de sesiones.
        if !self.persist(WriteJob::RecentHandles { handles_json }, false) {
            tracing::warn!(usuario = %handle, "no se pudo guardar el usuario recordado; la conexion sigue");
        }
    }

    /// Cambia al proveedor simulado y abre sesion con el.
    ///
    /// Vive en el motor y no en el comando de Tauri para que "elegir proveedor y
    /// abrir sesion" sea un solo camino (el comando es una envoltura) y se pueda
    /// probar sin Tauri ni red.
    pub async fn start_simulation(&self, handle: &str) -> anyhow::Result<()> {
        // Se detiene el proveedor activo antes de cambiar: nunca dos a la vez
        // (consumirian la misma cuota de firma).
        self.current_provider().disconnect().await;
        if let Ok(mut guard) = self.provider.write() {
            *guard = self.simulated.clone() as Arc<dyn TikTokProvider>;
        }
        self.connect(handle).await
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
    pub fn consumer_future(
        self: &Arc<Self>,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
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
                        state.note_lagged(skipped);
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
    ///
    /// Devuelve si el trabajo quedo **encolado**. Sirve para quien lleva una cache
    /// de "esto ya se ha escrito" (los avatares): si la cola lo rechazo, la cache
    /// no debe darlo por guardado o no se reintentaria nunca.
    fn persist(&self, job: WriteJob, critical: bool) -> bool {
        let guard = match self.writer.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        let Some(writer) = guard.as_ref() else {
            return false;
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
                return false;
            }
            true
        } else if !writer.try_send(job) {
            tracing::debug!("evento descartable descartado (cola llena)");
            false
        } else {
            true
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
        // Antes de nada: si este evento trae usuario y foto, se guarda su perfil
        // (una sola vez por persona). Se hace aqui, en un solo sitio, para que
        // valga para todos los tipos de evento en vez de repetirlo en cada rama.
        self.remember_from_event(event);

        match &event.kind {
            EventKind::StreamConnected {
                room_id,
                title,
                perfil,
            } => {
                let stream_id = format!("{room_id}-{}", event.timestamp_ms);
                if let Ok(mut guard) = self.stream_id.write() {
                    *guard = Some(stream_id.clone());
                }
                if let Ok(mut guard) = self.title.write() {
                    *guard = title.clone();
                }
                // Se guarda aunque venga vacio: el perfil de la sesion anterior ya
                // no vale para esta, y la ficha se queda sin datos en vez de
                // ensenar a otra persona.
                if let Ok(mut guard) = self.perfil.write() {
                    *guard = perfil.clone();
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
                // Las tablas de ranking tambien son de la sesion, por el mismo
                // motivo que el resumen de regalos: el directo de hoy no compite
                // con el de ayer. El historico de por vida vive en la base y no
                // se toca aqui.
                for tablero in [&self.taps, &self.follow_ranking] {
                    if let Ok(mut board) = tablero.lock() {
                        board.clear();
                    }
                }
                // El progreso tambien es de la sesion: un pico pendiente de la
                // anterior no puede colarse en esta.
                if let Ok(mut progress) = self.progress.lock() {
                    *progress = SessionProgress::default();
                }
                // El handle lo fija `AppState::connect`: es el unico sitio que
                // sabe a que usuario se esta conectando el proveedor (el
                // arranque automatico lo omitia y la sesion quedaba sin el).
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
                // Antes de soltar la sesion hay que volcar lo que solo vive en
                // memoria: el pico de espectadores y los likes pendientes, y las
                // rachas de regalos que TikTok dejo abiertas (sin `repeat_end`).
                // Todo se persiste contra el `stream_id` que esta a punto de
                // cerrarse.
                self.flush_progress(true);
                self.settle_streaks(event.seq, event.timestamp_ms);
                // Ultima ocasion de escribir el historico: despues de esto no
                // habra mas eventos que lo acumulen, y lo pendiente se perderia.
                self.flush_lifetime(true);
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

            // `emote_count` solo interesa mientras el mensaje esta vivo: la
            // tabla `comments` guarda el texto y no tiene columna de emotes, y
            // anadirla ahora seria un cambio de esquema que nadie ha pedido. El
            // dato viaja a la interfaz en el evento.
            EventKind::ChatMessage {
                user,
                content,
                emote_count: _,
            } => {
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
                // La contabilidad de rachas vive **solo** en el tablero: el
                // mismo numero que se enseña es el que se guarda.
                let outcome = match self.gifts.lock() {
                    Ok(mut board) => board.record(GiftEventView {
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
                    }),
                    Err(_) => crate::feed::RecordOutcome::default(),
                };
                self.publish_gift_board(gift.is_final);
                // Y las tablas de ranking, que son las que llevan la aportacion
                // **por persona**. Faltaba: `rankings.updated` salia unicamente de
                // los likes y los follows, asi que en un directo donde llegan
                // regalos pero nadie da taps ni sigue a nadie, la tabla de regalos
                // del overlay de OBS (`?view=gifts`) se quedaba con el ultimo
                // marcador **sin ningun error que lo dijera**. Se fuerza con el
                // cierre de racha por el mismo motivo que el tablero: es cuando la
                // cifra se compromete y el streamer la esta mirando.
                self.publish_rankings(gift.is_final);

                let (units, diamonds) = (outcome.current.units, outcome.current.diamonds);

                // Alerta del regalo: **solo al cerrar la racha**.
                //
                // Una racha de veinte rosas manda veinte eventos con su incremento;
                // disparar en cada uno seria una alerta por rosa y la del regalo
                // grande se perdería entre ellas. Se usa la aportacion comprometida
                // —la misma que va al historico— para que el aviso diga lo que de
                // verdad se ha donado y no el ultimo incremento.
                if gift.commits() {
                    self.disparar_alerta(
                        crate::alerts::TipoAviso::Gift,
                        crate::alerts::Variables {
                            usuario: crate::alerts::nombre_de(user),
                            regalo: if gift.name.trim().is_empty() {
                                "un regalo".to_string()
                            } else {
                                gift.name.clone()
                            },
                            cantidad: units.max(0),
                            diamantes: diamonds.max(0),
                            ..crate::alerts::Variables::default()
                        },
                        diamonds.max(0),
                    );
                }

                // El historico solo suma la aportacion **comprometida**: los
                // progresos de una racha llegan con 0 y se cuentan al cerrarse,
                // que es justo cuando `outcome.current` los trae. Con esto el
                // historico y los totales de la sesion no pueden discrepar.
                self.observe_lifetime(user, 0, units.max(0), diamonds.max(0));

                // Rachas que este mismo regalo ha dejado atras (el usuario empezo
                // otra): se persisten aqui, con la misma orden que usa el cierre
                // de sesion. Contarlas solo en memoria dejaba el total de la
                // sesion en disco por debajo del que ve el streamer.
                if !outcome.abandoned.is_empty() {
                    if let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) {
                        for racha in &outcome.abandoned {
                            tracing::debug!(
                                grupo = %racha.group_id,
                                unidades = racha.units,
                                diamantes = racha.diamonds,
                                "racha abandonada liquidada al empezar otra"
                            );
                            self.persist(
                                WriteJob::GiftSettlement {
                                    stream_id: stream_id.clone(),
                                    group_id: racha.group_id.clone(),
                                    units: racha.units,
                                    diamonds: racha.diamonds,
                                },
                                true,
                            );
                        }
                    }
                }
                if let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) {
                    // Los regalos mueven dinero y rankings: nunca se descartan.
                    self.persist(
                        WriteJob::Gift {
                            stream_id,
                            user_id: user.id.clone(),
                            gift_id: gift.id.clone(),
                            gift_name: gift.name.clone(),
                            image_url: gift.image_url.clone(),
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
                // Tabla de seguidores: una persona, un follow.
                if let Ok(mut ranking) = self.follow_ranking.lock() {
                    ranking.record(user, 1, 1);
                }
                // Un follow no es "aportacion economica", pero si señala a alguien
                // que sostiene el directo. Se cuenta como **evento** (la columna
                // `events`), no como like: mezclarlo con los taps inflaria el
                // numero que se compara con los likes reales.
                self.observe_lifetime(user, 0, 1, 0);
                self.publish_rankings(false);
                self.disparar_alerta(
                    crate::alerts::TipoAviso::Follow,
                    crate::alerts::Variables {
                        usuario: crate::alerts::nombre_de(user),
                        ..crate::alerts::Variables::default()
                    },
                    0,
                );
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
                self.disparar_alerta(
                    crate::alerts::TipoAviso::Share,
                    crate::alerts::Variables {
                        usuario: crate::alerts::nombre_de(user),
                        ..crate::alerts::Variables::default()
                    },
                    0,
                );
            }

            EventKind::SubscribeReceived { user, months } => {
                self.push_feed(FeedItem::subscribe(
                    event.seq,
                    event.timestamp_ms,
                    user.clone(),
                    *months,
                ));
                self.persist_social(event, "subscribe", user);
                self.disparar_alerta(
                    crate::alerts::TipoAviso::Subscribe,
                    crate::alerts::Variables {
                        usuario: crate::alerts::nombre_de(user),
                        meses: *months,
                        ..crate::alerts::Variables::default()
                    },
                    0,
                );
            }

            EventKind::LikeUpdated { user, count, total } => {
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
                // La alerta de likes la filtra el propio ajuste por su minimo, que
                // para eso es configurable: aqui no se decide, se le pasa la rafaga.
                // `{usuario}` puede quedar vacio: TikTok no siempre dice quien dio
                // los likes, y el texto de fabrica se lee igual sin nombre.
                self.disparar_alerta(
                    crate::alerts::TipoAviso::Like,
                    crate::alerts::Variables {
                        usuario: user
                            .as_ref()
                            .map(crate::alerts::nombre_de)
                            .unwrap_or_default(),
                        likes: *count,
                        ..crate::alerts::Variables::default()
                    },
                    *count,
                );
                // Tap tap: cada rafaga de likes **ya trae quien la manda**
                // (`WebcastLikeMessage.user`, campo 5 del proto), asi que la
                // aportacion por persona se puede agregar sin pedir nada mas a
                // TikTok. `count` es el incremento, no el total del directo: es
                // justo lo que hay que sumarle a esa persona.
                if let Some(user) = user {
                    if *count > 0 {
                        if let Ok(mut taps) = self.taps.lock() {
                            taps.record(user, *count, 1);
                        }
                        self.observe_lifetime(user, *count, 0, 0);
                    }
                }
                self.publish_rankings(false);
                if let Ok(mut progress) = self.progress.lock() {
                    progress.observe_likes(*total);
                }
                self.flush_progress(false);
            }

            EventKind::ViewerUpdated { current, .. } => {
                // Los espectadores no van al feed (lo pinta el panel con el
                // snapshot), pero su pico si interesa: se guarda por sesion.
                if let Ok(mut progress) = self.progress.lock() {
                    progress.observe_viewers(*current);
                }
                self.flush_progress(false);
            }

            // Las entradas en la sala se publican para que la interfaz las
            // cuente, pero no se persisten ni se anaden al feed: es el mensaje
            // mas frecuente de TikTok y una fila por entrada taparia el chat
            // (ver el contrato en `core/event.rs`).
            EventKind::MemberJoined { .. } => {}

            // Un borrado deja **tombstone** en la base (no se pierde el texto ni
            // el rastro, solo se marca cuando dejo de estar visible) ademas de
            // que la interfaz lo tache en pantalla. La marca no es critica: si
            // se pierde, el historico conserva el mensaje, que es el estado
            // anterior y no rompe nada.
            EventKind::ChatMessageDeleted { target_source_id } => {
                if let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) {
                    self.persist(
                        WriteJob::ChatDeleted {
                            stream_id,
                            source_id: target_source_id.clone(),
                            deleted_at: event.timestamp_ms,
                        },
                        false,
                    );
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
                // El evento actualiza tambien la copia persistente para que los
                // snapshots pedidos despues de una transicion no pierdan el
                // motivo aunque ya no haya otro evento en vuelo.
                self.metrics.set_provider_detail(detail.clone());
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
    /// que el streamer esta mirando. Lo mismo vale para la liquidacion de fin de
    /// sesion, que se publica con `forzar` porque no habra otra ocasion.
    fn publish_gift_board(&self, forzar: bool) {
        let ahora = Instant::now();
        let publicar = match self.last_board.lock() {
            Ok(mut ultimo) => {
                let toca = ultimo
                    .map(|previo| ahora.duration_since(previo) >= Duration::from_secs(1))
                    .unwrap_or(true);
                if toca || forzar {
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
                gifts_by_type: board.by_gift(10),
            },
        );
    }

    /// Publica las tres tablas de aportacion por persona, ya calculadas.
    ///
    /// Mismo criterio que `publish_gift_board`: como mucho una vez por segundo
    /// mientras llegan taps, regalos o follows, porque un directo activo publica
    /// likes constantemente y una tabla por cada uno ahogaria la interfaz y el
    /// overlay. Los tableros **no pierden nada** al agrupar: son acumuladores, no
    /// colas, asi que lo que no se publica en una vuelta sale en la siguiente.
    fn publish_rankings(&self, forzar: bool) {
        let ahora = Instant::now();
        let publicar = match self.last_rankings.lock() {
            Ok(mut ultimo) => {
                let toca = ultimo
                    .map(|previo| ahora.duration_since(previo) >= Duration::from_secs(1))
                    .unwrap_or(true);
                if toca || forzar {
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

        // Se leen los tableros de una vez para que la foto sea coherente: si se
        // publicaran por separado, la interfaz podria pintar un tap tap de antes
        // con unos regalos de despues.
        //
        // La tabla de **regalos** no tiene tablero propio a proposito: se deriva
        // del `GiftBoard`, que ya lleva el gasto por persona y ya sabe liquidar
        // las rachas al cerrarse. Un segundo acumulador duplicaria esa
        // contabilidad (la regla del proyecto es que cada numero se calcula en un
        // solo sitio), y ademas se desincronizaria en cuanto una racha se
        // liquidara por fin de directo y no por un regalo nuevo.
        if let Some(evento) = self.rankings_event() {
            self.bus.publish(None, evento);
        }
    }

    /// Las tres tablas de ranking de la sesion, ya calculadas.
    ///
    /// Existe aparte de `publish_rankings` porque tambien las necesita el
    /// servidor de overlays: **una sola funcion** para las dos salidas (el bus,
    /// que alimenta la interfaz, y el WebSocket, que alimenta OBS), de modo que
    /// el dashboard y el overlay no puedan enseñar numeros distintos.
    ///
    /// Devuelve `None` solo si un cerrojo esta envenenado.
    pub fn rankings_event(&self) -> Option<EventKind> {
        let (Ok(taps), Ok(gifts), Ok(follows)) = (
            self.taps.lock(),
            self.gifts.lock(),
            self.follow_ranking.lock(),
        ) else {
            return None;
        };

        let regalos = gifts
            .top_gifters(RANKING_TOP)
            .into_iter()
            .map(|entrada| RankingEntry {
                user: entrada.user,
                value: entrada.diamonds,
                events: entrada.gifts.max(0) as u64,
            })
            .collect();

        Some(EventKind::RankingsUpdated {
            tap: taps.top(RANKING_TOP),
            gifts: regalos,
            follows: follows.top(RANKING_TOP),
        })
    }

    /// Vuelca a la fila de `streams` el pico de espectadores y los likes.
    ///
    /// La politica de coalescing vive **solo** aqui y es la misma que la de los
    /// viewers en el proveedor: como mucho una escritura por segundo. Lo que se
    /// agrupa no se pierde, porque el pico se acumula con `max` y al cerrar la
    /// sesion se volca lo pendiente (`forzar`), que es el unico momento en el
    /// que no habria otra ocasion de escribirlo.
    fn flush_progress(&self, forzar: bool) {
        let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) else {
            return;
        };
        let Ok(mut progress) = self.progress.lock() else {
            return;
        };
        if !forzar && !progress.due(Instant::now()) {
            return;
        }
        let (peak_viewers, like_total) = progress.take();
        if peak_viewers.is_none() && like_total.is_none() {
            return;
        }
        // El volcado de cierre no puede perderse: es el ultimo dato de la
        // sesion. Los intermedios son descartables, como el chat.
        self.persist(
            WriteJob::StreamProgress {
                stream_id,
                peak_viewers,
                like_total,
            },
            forzar,
        );

        // Aprovecha el mismo latido para volcar el historico: `flush_progress` ya
        // se llama en cada rafaga de likes o viewers, asi que **no hace falta un
        // temporizador propio**. La ventana de un segundo la aplica
        // `flush_lifetime`, de modo que esto no añade escrituras.
        self.flush_lifetime(false);
    }

    /// Guarda la foto de perfil de quien acaba de aparecer, una sola vez.
    ///
    /// El avatar viaja en **todos** los eventos, asi que escribir el perfil en
    /// cada comentario seria absurdo. Se escribe la primera vez que se ve a esa
    /// persona con foto; despues basta con la copia en memoria, que ademas es la
    /// que pinta las tablas.
    ///
    /// Es una escritura **descartable**: si la cola esta llena se pierde y se
    /// reintentara en el siguiente evento, porque el `HashSet` solo se rellena
    /// cuando la escritura se ha aceptado.
    fn remember_avatar(&self, user: &crate::core::event::UserRef, at_ms: i64) {
        if user.avatar_url.is_empty() {
            return;
        }
        let Ok(mut vistos) = self.avatars_guardados.lock() else {
            return;
        };
        if vistos.contains(&user.id) {
            return;
        }
        if self.persist(
            WriteJob::UserProfile {
                user_id: user.id.clone(),
                unique_id: user.unique_id.clone(),
                nickname: user.nickname.clone(),
                avatar_url: user.avatar_url.clone(),
                seen_at: at_ms,
            },
            false,
        ) {
            vistos.insert(user.id.clone());
        }
    }

    /// Guarda el avatar de cualquiera que hable, aunque no aporte nada.
    ///
    /// Se llama en **cada** mensaje de chat, que es el flujo mas denso del
    /// directo: asi la tabla de tap tap y el overlay tienen foto de toda la gente
    /// desde su primer mensaje, sin esperar a que regale algo. La cache
    /// (`avatars_guardados`) garantiza que esto no se traduzca en mas escrituras.
    fn remember_from_event(&self, event: &Event) {
        let user = match &event.kind {
            EventKind::ChatMessage { user, .. }
            | EventKind::GiftReceived { user, .. }
            | EventKind::FollowReceived { user }
            | EventKind::ShareReceived { user }
            | EventKind::SubscribeReceived { user, .. } => Some(user),
            EventKind::LikeUpdated { user, .. } => user.as_ref(),
            // Una entrada a la sala tambien trae usuario y es el evento mas
            // frecuente: es la mejor ocasion de tener su foto.
            EventKind::MemberJoined { user } => Some(user),
            _ => None,
        };
        if let Some(user) = user {
            self.remember_avatar(user, event.timestamp_ms);
        }
    }

    /// Suma una aportacion al historico pendiente de quien la hizo.
    ///
    /// No escribe: acumula. Si el ajuste esta apagado no hace nada, que es lo que
    /// significa "no guardar el historico".
    fn observe_lifetime(
        &self,
        user: &crate::core::event::UserRef,
        likes: i64,
        gifts: i64,
        diamonds: i64,
    ) {
        if !self.lifetime_enabled.load(Ordering::Relaxed) {
            return;
        }
        let Ok(mut pendiente) = self.pending_lifetime.lock() else {
            return;
        };
        let Some(pendiente) = pendiente.as_mut() else {
            return;
        };
        pendiente.add(user, likes, gifts, diamonds);
    }

    /// Escribe en disco el historico acumulado.
    ///
    /// Ventana de un segundo, como el resto de coalescing del motor. El cierre de
    /// sesion **fuerza** el volcado: es el ultimo momento en que se puede
    /// escribir y perderlo dejaria el total corto.
    ///
    /// Estas escrituras son descartables a proposito: el historico es un
    /// acumulado de conveniencia, no un libro contable, y bloquear el consumidor
    /// de eventos por el seria peor que perder una ventana.
    fn flush_lifetime(&self, forzar: bool) {
        if !self.lifetime_enabled.load(Ordering::Relaxed) {
            return;
        }
        let ahora = Instant::now();
        let toca = match self.last_lifetime.lock() {
            Ok(mut ultimo) => {
                let toca = ultimo
                    .map(|previo| ahora.duration_since(previo) >= Duration::from_secs(1))
                    .unwrap_or(true);
                if toca || forzar {
                    *ultimo = Some(ahora);
                    true
                } else {
                    false
                }
            }
            Err(_) => false,
        };
        if !toca {
            return;
        }

        let Ok(mut pendiente) = self.pending_lifetime.lock() else {
            return;
        };
        let Some(pendiente) = pendiente.as_mut() else {
            return;
        };
        if pendiente.is_empty() {
            return;
        }
        let visto = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        for delta in pendiente.take() {
            self.persist(
                WriteJob::LifetimeDelta {
                    user_id: delta.user.id.clone(),
                    unique_id: delta.user.unique_id.clone(),
                    nickname: delta.user.nickname.clone(),
                    likes: delta.likes,
                    gifts: delta.gifts,
                    diamonds: delta.diamonds,
                    seen_at: visto,
                },
                false,
            );
        }
    }

    /// Activa o desactiva el historico de por vida.
    ///
    /// Al **desactivarlo** se vuelca lo pendiente en lugar de tirarlo: apagar el
    /// ajuste no debe borrar lo que ya se ha observado mientras estaba encendido.
    pub fn set_lifetime_enabled(&self, enabled: bool) {
        self.lifetime_enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            self.flush_lifetime(true);
        }
    }

    pub fn lifetime_enabled(&self) -> bool {
        self.lifetime_enabled.load(Ordering::Relaxed)
    }

    /// Guarda la configuracion del servidor de overlays ya arrancado.
    ///
    /// Se guarda inmutable (`Arc`) porque el servidor lee **esta** celda en cada
    /// peticion: cambiar de diseno es reemplazar el `Arc`, no mutar un campo, y
    /// asi no hay ningun instante en el que el overlay vea media configuracion.
    pub fn set_overlay(&self, config: crate::overlay::OverlayConfig) {
        if let Ok(mut guard) = self.overlay.write() {
            *guard = Some(Arc::new(config));
        }
    }

    /// La configuracion del overlay, si el servidor llego a arrancar.
    pub fn overlay_actual(&self) -> Option<Arc<crate::overlay::OverlayConfig>> {
        self.overlay.read().ok().and_then(|guard| guard.clone())
    }

    /// Cambia el diseno de una vista y lo deja guardado en disco.
    ///
    /// Se escribe el fichero **antes** de publicarlo: si el disco falla, el error
    /// sale y no se cambia nada. Publicarlo primero dejaria la aplicacion
    /// enseñando un diseno que en el siguiente arranque habria desaparecido, sin
    /// que nadie se enterara hasta abrir OBS.
    pub fn set_overlay_diseno(&self, vista: &str, id: &str) -> Result<(), String> {
        let mut guard = self
            .overlay
            .write()
            .map_err(|_| "el estado del overlay esta bloqueado".to_string())?;
        let actual = guard
            .as_ref()
            .ok_or_else(|| "el servidor de overlays no arranco".to_string())?;

        let mut siguiente = (**actual).clone();
        siguiente.disenos.poner(vista, id)?;
        siguiente
            .save(&crate::overlay::OverlayConfig::path())
            .map_err(|error| format!("no se pudo guardar el diseno: {error}"))?;

        *guard = Some(Arc::new(siguiente));
        Ok(())
    }

    /// Diseno elegido de cada vista, ya resuelto contra el catalogo.
    pub fn overlay_seleccion(&self) -> std::collections::HashMap<String, String> {
        let mut salida = std::collections::HashMap::new();
        let Some(config) = self.overlay_actual() else {
            return salida;
        };
        for vista in crate::overlay::VISTAS {
            salida.insert(vista.to_string(), config.disenos.elegido(vista).to_string());
        }
        salida
    }

    /// Direccion que se pega en OBS por vista, con su token, o vacio si el
    /// servidor no arranco.
    ///
    /// Se construye **siempre** desde la configuracion guardada, nunca desde algo
    /// que venga de fuera: el token no debe poder inyectarse desde el renderer.
    pub fn overlay_urls(&self) -> std::collections::HashMap<String, String> {
        let mut salida = std::collections::HashMap::new();
        let Some(config) = self.overlay_actual() else {
            return salida;
        };
        for vista in crate::overlay::VISTAS {
            salida.insert(vista.to_string(), config.pagina_url(vista));
        }
        // Y la de las alertas, que no es una vista de diseno pero tambien se pega
        // en OBS. La interfaz la usa para el boton de copiar de la pagina de
        // Alertas.
        salida.insert(
            crate::overlay::VISTA_ALERTAS.to_string(),
            config.pagina_url(crate::overlay::VISTA_ALERTAS),
        );
        salida
    }

    /// Raiz del servidor de overlays, sin vista ni token.
    ///
    /// Es la que usa la vista previa de la pestana Overlays: le añade
    /// `?view=&diseno=&demo=1` para pintar un diseno con el simulador.
    pub fn overlay_page_url(&self) -> Option<String> {
        self.overlay_actual().map(|config| config.base_url())
    }

    /// Quienes mas han aportado historicamente, leido de la base.
    ///
    /// Abre una conexion **de lectura** en lugar de preguntarle al escritor: el
    /// escritor es dueño de su `Connection` dentro de su propio hilo, y meter una
    /// consulta por su cola obligaria a un viaje de ida y vuelta con canal para
    /// algo que SQLite permite hacer en paralelo. La consulta no toca el WAL de
    /// escritura, asi que no compite con el volcado.
    ///
    /// Devuelve vacio si el historico esta apagado: sin el ajuste no hay nada que
    /// enseñar, y consultar la base para nada seria trabajo inutil.
    pub fn top_lifetime(&self, count: usize) -> Vec<RankingEntry> {
        if !self.lifetime_enabled() {
            return Vec::new();
        }
        match Database::open(&self.db_path) {
            Ok(base) => base.top_lifetime(count).unwrap_or_default(),
            Err(error) => {
                tracing::debug!(%error, "no se pudo leer el historico de aportaciones");
                Vec::new()
            }
        }
    }

    /// Liquida las rachas de regalos que siguen abiertas y las persiste.
    ///
    /// Una racha sin `repeat_end` se quedaba abierta para siempre y sus
    /// diamantes se perdian: ni en el resumen de la sesion ni en la base. Se
    /// cierra **antes** de soltar el `stream_id`, que es a lo que hay que
    /// colgarla.
    fn settle_streaks(&self, seq: u64, timestamp_ms: i64) {
        // Sin sesion abierta no hay a quien colgarle la liquidacion. Ocurre en el
        // doble cierre (el control de fin de directo y despues la caida del
        // WebSocket): la segunda vez ya esta todo liquidado y persistido.
        let Some(stream_id) = self.stream_id.read().ok().and_then(|g| g.clone()) else {
            return;
        };
        let liquidado = match self.gifts.lock() {
            Ok(mut board) => board.settle_open(),
            Err(_) => return,
        };
        if liquidado.is_empty() {
            return;
        }
        let diamantes: i64 = liquidado.iter().map(|racha| racha.diamonds).sum();
        self.push_feed(FeedItem::info(
            seq,
            timestamp_ms,
            format!(
                "cierre de sesión · {} racha(s) sin cerrar liquidadas ({diamantes} diamantes)",
                liquidado.len()
            ),
        ));
        // La interfaz tiene que ver los diamantes que se acaban de liberar.
        self.publish_gift_board(true);
        for racha in liquidado {
            self.persist(
                WriteJob::GiftSettlement {
                    stream_id: stream_id.clone(),
                    group_id: racha.group_id,
                    units: racha.units,
                    diamonds: racha.diamonds,
                },
                true,
            );
        }
        // La tabla de regalos se deriva del tablero, asi que las rachas que se
        // acaban de liquidar tienen que salir ya: no habra otro evento que las
        // publique (es el cierre de sesion).
        self.publish_rankings(true);
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

    /// Contabiliza los eventos que un consumidor del bus se ha saltado por ir
    /// lento.
    ///
    /// Lo llaman los consumidores que pueden perder eventos (estado e interfaz):
    /// asi el contador refleja **todo** lo que se perdio y no solo lo que perdio
    /// uno de ellos.
    pub fn note_lagged(&self, skipped: u64) {
        self.metrics
            .subscription_lagged
            .fetch_add(skipped, Ordering::Relaxed);
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
                tracing::info!(
                    seq,
                    recibidos = traza.received,
                    "chat recibido por la interfaz"
                );
            } else if traza.received % 25 == 0 {
                tracing::info!(
                    seq,
                    recibidos = traza.received,
                    "chat recibido por la interfaz"
                );
            }
            // Aviso inequivoco: llegan mensajes y React no ha pintado ninguna
            // lista **en varios segundos**. Se mide el tiempo, no el numero de
            // mensajes: una rafaga inicial de ocho es normal en una sala grande,
            // y contar mensajes daba falsos positivos.
            if !traza.warned && traza.rendered == 0 {
                let ahora = std::time::Instant::now();
                match traza.first_received {
                    None => traza.first_received = Some(ahora),
                    Some(inicio)
                        if ahora.duration_since(inicio) >= std::time::Duration::from_secs(5) =>
                    {
                        traza.warned = true;
                        tracing::warn!(
                            "la interfaz recibe mensajes de chat pero no ha renderizado ninguna \
                             lista en 5 s: el fallo esta en el estado o el render de React, no en \
                             la cadena de eventos"
                        );
                    }
                    Some(_) => {}
                }
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
    pub fn ui_event_counts(&self) -> Vec<(String, u64)> {
        let mut lista: Vec<(String, u64)> = self
            .ui_events
            .lock()
            .map(|mapa| mapa.iter().map(|(k, v)| (k.clone(), *v)).collect())
            .unwrap_or_default();
        lista.sort_by_key(|item| std::cmp::Reverse(item.1));
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
                    board.top_gifters(RANKING_TOP),
                    board.by_gift(10),
                    board.total_gifts(),
                    board.total_diamonds(),
                )
            })
            .unwrap_or_default();
        // Las tablas de ranking, con el mismo criterio que el resto del snapshot:
        // solo el top, para que la foto no crezca con el directo.
        //
        // La de regalos se **deriva** del `GiftBoard` (unica contabilidad de
        // rachas); las otras dos tienen su propio acumulador porque cuentan cosas
        // que el tablero de regalos no mira. Y es el **unico** destino de esa
        // tabla: la foto ya no manda ademas `top_gifters` en crudo, que era mandar
        // los mismos diez nombres dos veces por segundo y en dos formas distintas.
        let gift_ranking: Vec<RankingEntry> = top_gifters
            .iter()
            .map(|entrada| RankingEntry {
                user: entrada.user.clone(),
                value: entrada.diamonds,
                events: entrada.gifts.max(0) as u64,
            })
            .collect();
        let tap_ranking = self
            .taps
            .lock()
            .map(|board| board.top(RANKING_TOP))
            .unwrap_or_default();
        let follow_ranking = self
            .follow_ranking
            .lock()
            .map(|board| board.top(RANKING_TOP))
            .unwrap_or_default();
        let provider = self.current_provider();
        let (written, dropped, write_errors, critical_write_errors) = self
            .writer
            .lock()
            .ok()
            .and_then(|guard| {
                guard.as_ref().map(|writer| {
                    (
                        writer.written(),
                        writer.dropped(),
                        writer.write_errors(),
                        writer.critical_write_errors(),
                    )
                })
            })
            .unwrap_or((0, 0, 0, 0));

        Snapshot {
            protocol_version: PROTOCOL_VERSION,
            provider: provider.name().to_string(),
            status: provider.status().as_str().to_string(),
            status_detail: self.metrics.provider_detail(),
            handle: self.handle.read().map(|g| g.clone()).unwrap_or_default(),
            ultimos_usuarios: self
                .ultimos_usuarios
                .read()
                .map(|g| g.clone())
                .unwrap_or_default(),
            room_id: self.bus.room_id(),
            stream_id: self.stream_id.read().ok().and_then(|g| g.clone()),
            title: self.title.read().map(|g| g.clone()).unwrap_or_default(),
            perfil: self.perfil.read().map(|g| g.clone()).unwrap_or_default(),
            started_at_ms: self.started_at_ms.read().ok().and_then(|g| *g),
            chat,
            events,
            gifts,
            gifts_by_type,
            total_gifts,
            total_diamonds,
            metrics: self.metrics.snapshot(),
            db_path: self.db_path.display().to_string(),
            schema_version: self.schema_version,
            db_written: written,
            db_dropped: dropped,
            db_write_errors: write_errors,
            db_critical_write_errors: critical_write_errors,
            tap_ranking: tap_ranking.clone(),
            gift_ranking: gift_ranking.clone(),
            follow_ranking: follow_ranking.clone(),
            lifetime_ranking: self.top_lifetime(RANKING_TOP),
            lifetime_enabled: self.lifetime_enabled.load(Ordering::Relaxed),
            overlay_urls: self.overlay_urls(),
            overlay_seleccion: self.overlay_seleccion(),
            overlay_disenos: crate::overlay::catalogo(),
            overlay_page_url: self.overlay_page_url(),
            log_dir: telemetry::log_dir().display().to_string(),
            instance_port: self.instance_port,
            ui_events: self.ui_event_counts(),
            tts: self.tts.status(),
            alertas: self.alertas(),
            alertas_medios: crate::alerts::Almacen::nuevo().listar(),
            // El monitor de alertas: que dispositivo abrio de verdad y, si esta mudo,
            // por que. Es lo que deja a la interfaz decir "no disponible" en vez de
            // dejar al streamer pulsando probar sin entender nada.
            alertas_audio_dispositivo: self
                .salida_alertas
                .read()
                .ok()
                .and_then(|salida| salida.device_name()),
            alertas_audio_problema: self
                .salida_alertas
                .read()
                .ok()
                .and_then(|salida| salida.last_error()),
            // Cuantos avisos se han tirado por no caber en la cola: el plan obliga
            // a contar lo que se descarta, y aqui el streamer puede verlo.
            alertas_descartados: self.cola_alertas.descartados(),
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

    /// Los ajustes de alertas en vigor.
    pub fn alertas(&self) -> crate::alerts::AjustesAlertas {
        self.alertas
            .read()
            .map(|ajustes| ajustes.clone())
            .unwrap_or_else(|_| crate::alerts::AjustesAlertas::de_fabrica())
    }

    /// La cola de avisos, compartida con el servidor de overlays.
    pub fn cola_alertas(&self) -> Arc<crate::alerts::ColaAlertas> {
        self.cola_alertas.clone()
    }

    /// Guarda los ajustes de alertas.
    ///
    /// Se **encola primero** y se publica en memoria despues: al reves, un fallo
    /// del escritor dejaria una configuracion viva que desaparece al reiniciar, y
    /// el streamer no tendria forma de saber que lo que ve no es lo que hay.
    pub fn set_alertas(&self, mut ajustes: crate::alerts::AjustesAlertas) -> anyhow::Result<()> {
        // El dispositivo de antes, para saber si hay que reabrir la salida.
        let dispositivo_antes = self.alertas().salida.dispositivo().map(str::to_string);
        // Se sanean **al guardar**: lo que hay en la base ya paso por aqui.
        ajustes.sanear(&crate::alerts::Almacen::nuevo().listar());
        let dispositivo_despues = ajustes.salida.dispositivo().map(str::to_string);
        let settings_json = serde_json::to_string(&ajustes)?;
        {
            let writer = self
                .writer
                .lock()
                .map_err(|_| anyhow::anyhow!("cerrojo del escritor de base envenenado"))?;
            let Some(writer) = writer.as_ref() else {
                anyhow::bail!("el escritor de base de datos ya esta cerrado");
            };
            if !writer.send_critical(
                WriteJob::AlertSettings { settings_json },
                WRITER_BLOCK_TIMEOUT,
            ) {
                anyhow::bail!("no se pudieron encolar los ajustes de alertas");
            }
        }
        if let Ok(mut guard) = self.alertas.write() {
            *guard = ajustes;
        }
        // Solo se reabre si **cambio el dispositivo**. Reabrir el audio en cada
        // guardado cortaria el sonido cada vez que se suelta una tecla en un texto,
        // porque los ajustes se guardan a cada cambio.
        if dispositivo_antes != dispositivo_despues {
            if let Ok(mut salida) = self.salida_alertas.write() {
                *salida = Arc::new(crate::tts::player::FallbackSink::with_device(
                    dispositivo_despues.as_deref(),
                ));
            }
        }
        Ok(())
    }

    /// Suena el aviso en **esta maquina**, si trae sonido.
    ///
    /// No es la salida de la audiencia: esa es la fuente de OBS, y por eso esto vive
    /// aparte, con su propio dispositivo y su propio volumen. `play` encola y vuelve
    /// —la reproduccion ocurre en el hilo de audio—, asi que se puede llamar desde el
    /// camino de los eventos sin bloquear nada.
    fn sonar_en_local(&self, aviso: &crate::alerts::Aviso) {
        if aviso.sonido.is_empty() {
            return;
        }
        // Si el fichero ya no esta, no se dice nada: el aviso sale igual, sin sonido.
        let Some(ruta) = crate::alerts::Almacen::nuevo().ruta_de(&aviso.sonido) else {
            return;
        };
        let volumen = self.alertas().salida.volumen;
        let Ok(salida) = self.salida_alertas.read() else {
            return;
        };
        if let Err(error) = salida.play(&ruta, volumen) {
            tracing::warn!(%error, fichero = %aviso.sonido, "no se pudo sonar la alerta aqui");
        }
    }

    /// Encola un aviso de prueba y lo devuelve.
    ///
    /// **No** pasa por el filtro de minimo a proposito: el boton de probar esta
    /// para ver como queda, y si el streamer tiene «solo regalos de 100 diamantes»
    /// la prueba no deberia quedarse muda y hacerle dudar de si funciona.
    pub fn probar_alerta(&self, tipo: crate::alerts::TipoAviso) -> crate::alerts::Aviso {
        let ajustes = self.alertas();
        let aviso =
            crate::alerts::Aviso::demo(self.cola_alertas.siguiente_seq(), tipo, ajustes.de(tipo));
        self.cola_alertas.encolar(aviso.clone());
        // Probar suena aqui **siempre**: es la unica forma de comprobar el sonido sin
        // tener OBS delante, que es justo cuando se esta configurando.
        self.sonar_en_local(&aviso);
        aviso
    }

    /// Dispara un aviso si su tipo esta activo y pasa el minimo.
    ///
    /// El minimo se aplica **aqui**, antes de encolar: decidir si algo se enseña
    /// es politica del motor, y el overlay no deberia tener que saber que un
    /// regalo de un diamante no cuenta.
    fn disparar_alerta(
        &self,
        tipo: crate::alerts::TipoAviso,
        variables: crate::alerts::Variables,
        cantidad: i64,
    ) {
        let Ok(ajustes) = self.alertas.read() else {
            return;
        };
        let ajuste = ajustes.de(tipo);
        // Sin texto y sin medio no hay nada que enseñar: un aviso vacio de tres
        // segundos es peor que ninguno.
        if !ajuste.util() || (ajuste.minimo > 0 && cantidad < ajuste.minimo) {
            return;
        }
        let aviso =
            crate::alerts::Aviso::nuevo(self.cola_alertas.siguiente_seq(), tipo, ajuste, variables);
        // En directo ya se oyen por OBS, asi que sonar tambien aqui es una eleccion y
        // viene apagada: oirlas dos veces es peor que no oirlas.
        let en_directo = ajustes.salida.en_directo;
        drop(ajustes);
        if en_directo {
            self.sonar_en_local(&aviso);
        }
        self.cola_alertas.encolar(aviso);
    }

    /// Persiste un snapshot completo del perfil TTS. Se usa el mismo escritor
    /// dedicado que el resto de SQLite para mantener una sola secuencia de
    /// commits y no abrir una segunda conexion concurrente.
    pub fn persist_tts_settings(&self) -> anyhow::Result<()> {
        let settings_json = serde_json::to_string(&self.tts.settings())?;
        let writer = self
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("cerrojo del escritor de base envenenado"))?;
        let Some(writer) = writer.as_ref() else {
            anyhow::bail!("el escritor de base de datos ya esta cerrado");
        };
        if !writer.send_critical(WriteJob::TtsProfile { settings_json }, WRITER_BLOCK_TIMEOUT) {
            anyhow::bail!("no se pudo encolar el perfil TTS para persistirlo");
        }
        Ok(())
    }

    /// Cambia la salida solo después de abrir correctamente el nuevo sink.
    pub fn select_tts_device(&self, device: Option<&str>) -> anyhow::Result<String> {
        let name = self.tts.select_device(device)?;
        self.persist_tts_settings()?;
        Ok(name)
    }
}

/// Deja el usuario como se teclea y como se guarda: sin arroba y sin espacios
/// de sobra. `@Carlos ` y `carlos` son la misma cuenta, y en la lista no puede
/// haber dos.
pub(crate) fn normalizar_usuario(handle: &str) -> String {
    handle.trim().trim_start_matches('@').trim().to_string()
}

/// Si el usuario se puede recordar.
///
/// Un usuario con espacios por dentro o mas largo que el tope de TikTok es un
/// error de tecleo (o un pegado raro): guardarlo solo serviria para ofrecerlo
/// como sugerencia y arrastrar el error a la sesion siguiente.
pub(crate) fn usuario_recordable(handle: &str) -> bool {
    !handle.is_empty()
        && handle.chars().count() <= MAX_USUARIO
        && !handle.chars().any(char::is_whitespace)
}

/// Anade un usuario a la lista de recordados.
///
/// Contrato de la lista: el mas reciente **primero**, sin repetidos (comparando
/// sin distinguir mayusculas, que la misma cuenta tecleada `@Carlos` y `carlos`
/// es una sola) y como mucho `USUARIOS_RECORDADOS`. Un usuario invalido no
/// entra: la lista no se toca.
pub(crate) fn anotar_usuario(lista: &mut Vec<String>, handle: &str) {
    let limpio = normalizar_usuario(handle);
    if !usuario_recordable(&limpio) {
        return;
    }
    lista.retain(|otro| !otro.eq_ignore_ascii_case(&limpio));
    lista.insert(0, limpio);
    lista.truncate(USUARIOS_RECORDADOS);
}

/// Sanea la lista que viene de la base con el mismo contrato y **sin tocar el
/// orden**.
///
/// La base no es de fiar: un JSON editado a mano o una lista de una version
/// anterior puede traer repetidos, usuarios invalidos o mas de los que se
/// ofrecen. El primero que aparece es el mas reciente, asi que los repetidos
/// posteriores se descartan en vez de reordenar la lista.
pub(crate) fn sanear_usuarios(guardados: &[String]) -> Vec<String> {
    let mut lista: Vec<String> = Vec::new();
    for handle in guardados {
        let limpio = normalizar_usuario(handle);
        if !usuario_recordable(&limpio) {
            continue;
        }
        if lista.iter().any(|otro| otro.eq_ignore_ascii_case(&limpio)) {
            continue;
        }
        lista.push(limpio);
        if lista.len() >= USUARIOS_RECORDADOS {
            break;
        }
    }
    lista
}

/// Progreso de la sesion que vive en la fila de `streams` y no en una tabla de
/// eventos: pico de espectadores y total de likes.
///
/// Existe para no inundar al escritor: los viewers y los likes llegan en rafagas
/// y cada uno seria un `UPDATE`. La ventana es la **misma politica** que el
/// coalescing de viewers del proveedor (1/s), y aqui ademas el pico se acumula
/// con `max` en lugar de quedarse con el ultimo valor, de modo que agrupar no
/// puede perder el pico. El ultimo volcado del dia es el del cierre de sesion.
#[derive(Debug, Default)]
pub(crate) struct SessionProgress {
    /// Mayor numero de espectadores visto desde el ultimo volcado.
    pending_peak: Option<i64>,
    /// Ultimo total absoluto de likes (es monotono, asi que el ultimo es el
    /// mayor).
    pending_likes: Option<i64>,
    /// Cuando se volco por ultima vez.
    last_flush: Option<Instant>,
}

impl SessionProgress {
    /// Ventana minima entre volcados.
    const WINDOW: Duration = Duration::from_secs(1);

    fn observe_viewers(&mut self, current: i64) {
        self.pending_peak = Some(self.pending_peak.map_or(current, |pico| pico.max(current)));
    }

    fn observe_likes(&mut self, total: i64) {
        self.pending_likes = Some(total);
    }

    /// Si toca volcar (ventana cumplida y algo pendiente). Marca el volcado.
    fn due(&mut self, now: Instant) -> bool {
        if self.pending_peak.is_none() && self.pending_likes.is_none() {
            return false;
        }
        let toca = self
            .last_flush
            .map(|previo| now.duration_since(previo) >= Self::WINDOW)
            .unwrap_or(true);
        if toca {
            self.last_flush = Some(now);
        }
        toca
    }

    /// Toma lo pendiente y lo deja vacio.
    fn take(&mut self) -> (Option<i64>, Option<i64>) {
        (self.pending_peak.take(), self.pending_likes.take())
    }
}

/// Lo que falta por aportar al historico de una persona desde el ultimo volcado.
#[derive(Debug, Clone)]
pub(crate) struct LifetimeDelta {
    user: crate::core::event::UserRef,
    likes: i64,
    gifts: i64,
    diamonds: i64,
}

/// Aportaciones acumuladas a la espera de escribirse, por persona.
///
/// Existe por el mismo motivo que `SessionProgress`: **agrupar lo que llega en
/// rafaga**. Un tap no puede costar una escritura, y en un directo movido llegan
/// decenas por segundo. Acumular es exacto (son sumas), asi que agrupar no pierde
/// nada: lo que no se escribe en una vuelta se escribe en la siguiente, y el
/// cierre de sesion fuerza el ultimo volcado.
#[derive(Debug, Default)]
pub(crate) struct PendingLifetime {
    por_usuario: std::collections::HashMap<String, LifetimeDelta>,
}

impl PendingLifetime {
    fn add(&mut self, user: &crate::core::event::UserRef, likes: i64, gifts: i64, diamonds: i64) {
        let entrada = self
            .por_usuario
            .entry(user.id.clone())
            .or_insert_with(|| LifetimeDelta {
                user: user.clone(),
                likes: 0,
                gifts: 0,
                diamonds: 0,
            });
        entrada.likes += likes;
        entrada.gifts += gifts;
        entrada.diamonds += diamonds;
    }

    /// Toma todo lo pendiente. La tabla de personas es acotada porque lo es el
    /// numero de personas que aportan en una ventana de segundos.
    fn take(&mut self) -> Vec<LifetimeDelta> {
        self.por_usuario.drain().map(|(_, delta)| delta).collect()
    }

    fn is_empty(&self) -> bool {
        self.por_usuario.is_empty()
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
    /// Cuando llego el primer comentario, para no avisar durante la rafaga
    /// inicial (no se serializa).
    #[serde(skip)]
    pub first_received: Option<std::time::Instant>,
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
    /// Ultimo detalle del estado del proveedor; no desaparece al pedir otra foto.
    pub status_detail: Option<String>,
    pub handle: String,
    /// Ultimos usuarios con los que se conecto, el mas reciente primero.
    ///
    /// Es la lista de sugerencias del campo de conexion, no el historico de
    /// sesiones: ese es el `handle` de cada fila de `streams`.
    pub ultimos_usuarios: Vec<String>,
    pub room_id: String,
    pub stream_id: Option<String>,
    pub title: String,
    /// Perfil del duenio de la sala. Vacio mientras la sala no lo traiga: la
    /// interfaz no pinta ficha en ese caso.
    pub perfil: Perfil,
    /// Inicio de la sesion actual, para mostrar su duracion.
    pub started_at_ms: Option<i64>,
    pub chat: Vec<ChatEntry>,
    /// Actividad reciente: regalos, follows, likes grandes y avisos.
    pub events: Vec<FeedItem>,
    /// Regalos de la sesion actual, del mas nuevo al mas antiguo.
    pub gifts: Vec<GiftEventView>,
    /// Regalos agrupados por tipo.
    pub gifts_by_type: Vec<GiftTypeSummary>,
    pub total_gifts: i64,
    pub total_diamonds: i64,
    /// Tap tap: likes acumulados por persona en esta sesion.
    pub tap_ranking: Vec<RankingEntry>,
    /// Diamantes aportados por persona en esta sesion.
    pub gift_ranking: Vec<RankingEntry>,
    /// Seguidores nuevos por persona en esta sesion.
    pub follow_ranking: Vec<RankingEntry>,
    /// Totales historicos de quien aporta, sumando todos los directos.
    ///
    /// Vacio si el ajuste esta apagado. Sale de la base, no de memoria: es lo
    /// unico de estas tablas que sobrevive al cierre.
    pub lifetime_ranking: Vec<RankingEntry>,
    /// Si se esta guardando el historico de quienes aportan.
    pub lifetime_enabled: bool,
    /// Direccion que se pega en OBS como Browser Source, **por vista**, con su
    /// token.
    ///
    /// Vacio si el servidor de overlays no arranco (por ejemplo, sin puerto
    /// libre): la interfaz lo enseña como "no disponible" en vez de una URL rota.
    /// Antes habia una sola y era la del WebSocket con la etiqueta "Browser
    /// Source", que pegada en OBS no carga nada: OBS abre un documento y es el
    /// documento el que abre el socket.
    pub overlay_urls: std::collections::HashMap<String, String>,
    /// Diseno elegido de cada vista, ya resuelto contra el catalogo.
    pub overlay_seleccion: std::collections::HashMap<String, String>,
    /// Los disenos que existen y para que vistas valen.
    ///
    /// Solo identificadores: los rotulos que lee el streamer estan en el `i18n`
    /// del frontend (docs/decisions.md D4), asi que anadir ingles no obliga a
    /// tocar Rust.
    pub overlay_disenos: Vec<crate::overlay::DisenoInfo>,
    /// Raiz del servidor de overlays (HTTP, sin token ni vista).
    ///
    /// Es la base de la vista previa: la interfaz le añade `?view=&diseno=&demo=1`
    /// para pintar un diseno con el simulador.
    pub overlay_page_url: Option<String>,
    pub metrics: MetricsSnapshot,
    pub db_path: String,
    pub schema_version: u32,
    pub db_written: u64,
    pub db_dropped: u64,
    /// Lotes SQLite que fallaron; se conservan aparte de los descartes por
    /// saturacion de la cola.
    pub db_write_errors: u64,
    /// Trabajos criticos incluidos en lotes SQLite fallidos.
    pub db_critical_write_errors: u64,
    pub log_dir: String,
    pub instance_port: u16,
    /// Eventos reconocidos por la interfaz, por tipo (diagnostico).
    pub ui_events: Vec<(String, u64)>,
    /// Estado del lector de chat en voz alta.
    pub tts: TtsStatus,
    /// Ajustes de las alertas de OBS: qué dispara, con qué medio y con qué texto.
    pub alertas: crate::alerts::AjustesAlertas,
    /// Los medios que el streamer ha cargado. Solo los nombres: las direcciones
    /// las arma la interfaz con el origen del servidor de overlays.
    pub alertas_medios: Vec<String>,
    /// El dispositivo que el monitor de alertas abrio de verdad. `None` si esta mudo.
    pub alertas_audio_dispositivo: Option<String>,
    /// Por que el monitor de alertas esta mudo, si lo esta.
    pub alertas_audio_problema: Option<String>,
    /// Avisos que se han tirado por no caber en la cola.
    pub alertas_descartados: u64,
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

    /// Un regalo publica tambien las tablas de ranking.
    ///
    /// No lo hacia: el manejador de regalos publicaba `gifts.updated` y nada mas,
    /// y `rankings.updated` salia unicamente de los likes y los follows. En un
    /// directo donde llegan regalos pero nadie da taps ni sigue a nadie, la tabla
    /// de regalos del overlay de OBS (`?view=gifts`) **no se actualizaba nunca**,
    /// y no habia ningun error que lo dijera: la fuente se quedaba con el ultimo
    /// marcador. Es la peor forma de fallar, porque parece que no pasa nada.
    #[tokio::test]
    async fn un_regalo_publica_las_tablas_de_ranking() {
        let path = temp_db_path("rankings-regalo");
        let state = Arc::new(AppState::open(path.clone(), 0).expect("estado"));
        let mut receptor = state.bus.subscribe();

        let carlos = UserRef {
            id: "1".to_string(),
            unique_id: "carlos".to_string(),
            nickname: "Carlos".to_string(),
            avatar_url: String::new(),
        };
        state.on_event(&Event::new(
            1,
            "sala".to_string(),
            Some("gift-1".to_string()),
            EventKind::GiftReceived {
                user: carlos,
                gift: crate::core::event::GiftInfo::new("5655", "Rosa", 3, false, 1, true, "0"),
            },
        ));

        // Se mira todo lo publicado: puede haber mas de un evento y no se sabe en
        // que orden llegan.
        let mut visto = false;
        while let Ok(evento) = receptor.try_recv() {
            if let EventKind::RankingsUpdated { gifts, .. } = &evento.kind {
                assert_eq!(gifts.len(), 1, "el regalo tiene que salir en su tabla");
                assert_eq!(gifts[0].value, 3, "con sus diamantes");
                assert_eq!(gifts[0].user.nickname, "Carlos");
                visto = true;
            }
        }
        assert!(
            visto,
            "un regalo tiene que publicar rankings.updated: sin eso el overlay de \
             regalos y la tabla de Rankings se quedan mudos"
        );

        state.shutdown();
        cleanup(&path);
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
    fn el_estado_carga_el_perfil_tts_antes_de_construir_el_gestor() {
        let path = temp_db_path("tts-profile");
        let mut database = Database::open(&path).expect("base");
        database.migrate().expect("migraciones");
        let mut settings = TtsSettings {
            enabled: false,
            voice_es: "es-MX-DaliaNeural".into(),
            rate: "+25%".into(),
            pitch: "-4Hz".into(),
            audio_device: Some("Cable Input".into()),
            ..TtsSettings::default()
        };
        settings.filters.max_chars = 99;
        let json = serde_json::to_string(&settings).expect("json");
        database
            .write_batch(&[WriteJob::TtsProfile {
                settings_json: json,
            }])
            .expect("perfil");
        drop(database);

        let state = AppState::open(path.clone(), 0).expect("estado");
        let loaded = state.tts_settings();
        assert!(!loaded.enabled);
        assert_eq!(loaded.voice_es, "es-MX-DaliaNeural");
        assert_eq!(loaded.rate, "+25%");
        assert_eq!(loaded.pitch, "-4Hz");
        assert_eq!(loaded.audio_device.as_deref(), Some("Cable Input"));
        assert_eq!(loaded.filters.max_chars, 99);
        state.shutdown();
        cleanup(&path);
    }

    #[test]
    fn el_snapshot_conserva_el_detalle_del_estado_del_proveedor() {
        let path = temp_db_path("status-detail");
        let state = AppState::open(path.clone(), 0).expect("estado");
        state.on_event(&Event::new(
            1,
            "sala".into(),
            None,
            EventKind::ProviderStatus {
                status: "error".into(),
                detail: Some("cuota agotada".into()),
            },
        ));

        let first = state.snapshot();
        let second = state.snapshot();
        assert_eq!(first.status_detail.as_deref(), Some("cuota agotada"));
        assert_eq!(second.status_detail.as_deref(), Some("cuota agotada"));

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
            ..Default::default()
        };
        for seq in 1..=(CHAT_CAPACITY as u64 + 50) {
            let event = Event::new(
                seq,
                "sala".into(),
                Some(format!("m{seq}")),
                EventKind::ChatMessage {
                    user: user.clone(),
                    content: format!("mensaje {seq}"),
                    emote_count: 0,
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
        state
            .simulated
            .set_interval(std::time::Duration::from_millis(5));
        // Se conecta por el camino de la aplicacion: `AppState::connect` es el
        // que recuerda el handle que acaba en `streams.handle`.
        state.connect("prueba").await.expect("arranca el simulador");

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
        // El handle real del usuario conectado, no una cadena vacia.
        assert_eq!(
            database
                .query_string("SELECT handle FROM streams", 0)
                .unwrap()
                .as_deref(),
            Some("prueba"),
            "la sesion debe guardar a que usuario se conecto"
        );

        // La sesion queda cerrada, no interrumpida: el cierre fue ordenado.
        let abiertas = database
            .query_i64("SELECT COUNT(*) FROM streams WHERE ended_at IS NULL", 0)
            .unwrap();
        assert_eq!(abiertas, Some(0));

        drop(database);
        cleanup(&path);
    }

    /// El progreso de sesion se agrupa por ventana, acumula el pico y nunca
    /// escribe dos veces lo mismo.
    #[test]
    fn el_progreso_de_sesion_se_agrupa_y_conserva_el_pico() {
        let mut progress = SessionProgress::default();
        let t0 = Instant::now();

        // Sin nada pendiente no hay volcado, aunque haya pasado la ventana.
        assert!(!progress.due(t0));
        assert_eq!(progress.take(), (None, None));

        // Varios viewers seguidos: el primero vence la ventana, los demas se
        // agrupan y el pico se queda con el mayor (los viewers bajan).
        progress.observe_viewers(120);
        assert!(progress.due(t0), "el primer volcado no espera");
        assert_eq!(progress.take(), (Some(120), None));

        progress.observe_viewers(300);
        progress.observe_viewers(90);
        progress.observe_likes(1_000);
        assert!(
            !progress.due(t0 + Duration::from_millis(500)),
            "dentro de la ventana no se vuelca"
        );
        assert!(
            progress.due(t0 + SessionProgress::WINDOW),
            "cumplida la ventana, si"
        );
        assert_eq!(
            progress.take(),
            (Some(300), Some(1_000)),
            "se queda el pico, no el ultimo valor"
        );
        assert_eq!(progress.take(), (None, None), "tomar vacia lo pendiente");
    }

    /// Al cerrar la sesion, lo que quedo pendiente se escribe y llega a la fila
    /// de `streams` que se esta cerrando.
    #[test]
    fn el_cierre_de_sesion_vuelca_el_progreso_pendiente() {
        let path = temp_db_path("progreso");
        let state = AppState::open(path.clone(), 0).expect("estado");
        state.on_event(&Event::new(
            1,
            "sala".into(),
            Some("sys-1".into()),
            EventKind::StreamConnected {
                room_id: "sala".into(),
                title: String::new(),
                perfil: Perfil::default(),
            },
        ));
        // Dos viewers separados por menos de la ventana: el segundo no se
        // escribe hasta el cierre.
        state.on_event(&Event::new(
            2,
            "sala".into(),
            None,
            EventKind::ViewerUpdated {
                current: 100,
                cumulative: 900,
            },
        ));
        state.on_event(&Event::new(
            3,
            "sala".into(),
            None,
            EventKind::ViewerUpdated {
                current: 250,
                cumulative: 1_100,
            },
        ));
        state.on_event(&Event::new(
            4,
            "sala".into(),
            None,
            EventKind::LikeUpdated {
                user: None,
                count: 5,
                total: 4_000,
            },
        ));
        state.on_event(&Event::new(
            5,
            "sala".into(),
            Some("sys-5".into()),
            EventKind::StreamDisconnected {
                reason: "fin de la prueba".into(),
            },
        ));

        state.shutdown();
        let database = Database::open(&path).expect("reabriendo la base");
        assert_eq!(
            database
                .query_i64("SELECT peak_viewers FROM streams", 0)
                .unwrap(),
            Some(250),
            "el pico de la sesion no se pierde al cerrar"
        );
        assert_eq!(
            database
                .query_i64("SELECT like_total FROM streams", 0)
                .unwrap(),
            Some(4_000),
            "y el total de likes tampoco"
        );

        drop(database);
        cleanup(&path);
    }

    /// La lista de usuarios recordados: el mas reciente primero, sin repetidos y
    /// con tope de cuatro.
    #[test]
    fn los_usuarios_recordados_no_se_repiten_y_el_mas_reciente_va_primero() {
        let mut lista = Vec::new();
        anotar_usuario(&mut lista, "@carlos");
        anotar_usuario(&mut lista, "vane");
        assert_eq!(
            lista,
            vec!["vane".to_string(), "carlos".to_string()],
            "el ultimo en conectarse va primero"
        );

        // La misma cuenta tecleada de otra forma no se duplica: se mueve arriba.
        anotar_usuario(&mut lista, "CARLOS");
        assert_eq!(
            lista,
            vec!["CARLOS".to_string(), "vane".to_string()],
            "sin repetidos: la cuenta sube al primer puesto, no se anade otra vez"
        );

        for usuario in ["uno", "dos", "tres"] {
            anotar_usuario(&mut lista, usuario);
        }
        assert_eq!(
            lista.len(),
            USUARIOS_RECORDADOS,
            "la lista se queda en cuatro"
        );
        assert_eq!(
            lista,
            vec![
                "tres".to_string(),
                "dos".to_string(),
                "uno".to_string(),
                "CARLOS".to_string()
            ],
            "los cuatro mas recientes, el mas nuevo primero"
        );
        assert!(
            !lista.iter().any(|usuario| usuario == "vane"),
            "el mas antiguo es el que se cae"
        );

        // Y lo que viene de la base pasa por el mismo contrato.
        let saneada = sanear_usuarios(&[
            "bueno".to_string(),
            " con espacio".to_string(),
            "BUENO".to_string(),
            "a".repeat(MAX_USUARIO + 1),
            "otro".to_string(),
        ]);
        assert_eq!(
            saneada,
            vec!["bueno".to_string(), "otro".to_string()],
            "el saneado quita invalidos y repetidos sin tocar el orden"
        );
    }

    /// Un usuario que no se puede recordar no entra: la lista no se toca.
    #[test]
    fn un_usuario_invalido_no_entra_en_la_lista() {
        let mut lista = Vec::new();
        anotar_usuario(&mut lista, "@carlos");
        // Con espacios por dentro: es un error de tecleo, no un usuario.
        anotar_usuario(&mut lista, "car los");
        // Demasiado largo.
        anotar_usuario(&mut lista, &"a".repeat(MAX_USUARIO + 1));
        // Vacio, solo la arroba o solo espacios.
        anotar_usuario(&mut lista, "");
        anotar_usuario(&mut lista, "@");
        anotar_usuario(&mut lista, "   ");

        assert_eq!(
            lista,
            vec!["carlos".to_string()],
            "solo ha entrado el usuario valido"
        );
        // Justo en el tope si entra: el limite es el de TikTok, no uno mas bajo.
        let largo = "b".repeat(MAX_USUARIO);
        anotar_usuario(&mut lista, &largo);
        assert_eq!(lista.first(), Some(&largo), "un usuario del tope si entra");
    }

    /// El usuario con el que se conecta se recuerda y vuelve relleno al reabrir:
    /// es el caso del streamer que cierra y al dia siguiente vuelve a teclear su
    /// `@`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn el_usuario_de_la_conexion_se_recuerda_al_reabrir() {
        let path = temp_db_path("usuarios-recordados");
        let state = Arc::new(AppState::open(path.clone(), 0).expect("estado"));
        // Con `@` delante a proposito: el motor lo normaliza antes de guardarlo.
        state.start_simulation("@carlos").await.expect("simulando");
        state.shutdown();
        drop(state);

        // Otro arranque sobre la misma base: el campo nace con el de ayer.
        let state = AppState::open(path.clone(), 0).expect("estado reabierto");
        let snapshot = state.snapshot();
        assert_eq!(
            snapshot.ultimos_usuarios,
            vec!["carlos".to_string()],
            "el usuario de la conexion se guarda sin arroba"
        );
        assert_eq!(
            snapshot.handle, "carlos",
            "y es el handle inicial, para que el campo arranque relleno"
        );
        state.shutdown();
        cleanup(&path);
    }
}
