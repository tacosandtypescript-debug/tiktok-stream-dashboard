//! Provider TikTok nativo en Rust.
//!
//! Portado y endurecido a partir del spike validado
//! (`spikes/tiktok-rust-provider/`, ver REPORT.md). Diferencias clave:
//!
//!   * publica eventos normalizados en el bus en lugar de imprimirlos;
//!   * supervisor con reconexion sujeta a la cuota anonima del servidor de
//!     firma (5/min, 30/h, **100/dia**): nunca hay bucles de reconexion rapidos;
//!   * estado `WaitingForLive` que sondea SIN gastar cuota;
//!   * coalescing de viewers a 1/s para no inundar la UI ni los overlays;
//!   * cancelacion limpia (watch channel) al desconectar.
//!
//! Hechos verificados que estan codificados aqui y que conviene no "arreglar"
//! sin volver a medir (ver REPORT.md §3):
//!   * `WebcastPushFrame.service` y `.method` son `uint64`;
//!   * `group_id` identifica el streak y es 0 en regalos no acumulables;
//!   * `repeat_end != 0` marca el final del streak; `gift.type == 1` = acumulable;
//!   * `WebcastRoomUserSeqMessage.total` son los espectadores ACTUALES y
//!     `total_user` los acumulados (los nombres enganan).

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::proto::*;
use super::{BoxFuture, ProviderStatus, StatusReporter, TikTokProvider};
use crate::core::event::{GiftInfo, UserRef};
use crate::core::{EventBus, EventKind, Metrics};

/// User-Agent del navegador. Sus trozos deben concordar con `browser_name` y
/// `browser_version`, que el servidor de firma valida.
pub const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const CLIENT_NAME: &str = "ttlive-python";
const TIKTOK_WEB: &str = "https://www.tiktok.com";
const IDC_COOKIE: &str = "tt-target-idc=useast1a";
/// Cada cuanto se late si el servidor no dice otra cosa. La implementacion de
/// referencia usa 5 s.
const HEARTBEAT_FALLBACK: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// Servidor de firma. Configurable para poder sustituirlo (D2).
    pub sign_base: String,
    pub user_agent: String,
    pub app_language: String,
    pub browser_language: String,
    pub region: String,
    pub tz_name: String,
    /// Sondeo mientras el usuario no esta en directo. No gasta cuota.
    pub live_poll_interval: Duration,
    /// Espera minima entre intentos. La cuota es de 5/min: no bajar de 30 s.
    pub min_reconnect_delay: Duration,
    pub max_reconnect_delay: Duration,
    /// Pausa larga tras un 429 del servidor de firma.
    pub rate_limit_pause: Duration,
    /// Fallos consecutivos antes de rendirse (protege la cuota diaria).
    pub max_consecutive_failures: u32,
    /// Ventana minima entre actualizaciones de viewers.
    pub viewer_coalesce: Duration,
    pub heartbeat: Duration,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            sign_base: "https://api.eulerstream.com".to_string(),
            user_agent: DEFAULT_UA.to_string(),
            app_language: "en".to_string(),
            browser_language: "en-US".to_string(),
            region: "CA".to_string(),
            tz_name: "America/Toronto".to_string(),
            live_poll_interval: Duration::from_secs(30),
            min_reconnect_delay: Duration::from_secs(30),
            max_reconnect_delay: Duration::from_secs(300),
            rate_limit_pause: Duration::from_secs(600),
            max_consecutive_failures: 10,
            viewer_coalesce: Duration::from_secs(1),
            heartbeat: Duration::from_secs(9),
        }
    }
}

struct RoomInfo {
    room_id: String,
    live: bool,
    title: String,
}

pub struct NativeProvider {
    config: ProviderConfig,
    http: reqwest::Client,
    bus: Arc<EventBus>,
    metrics: Arc<Metrics>,
    device_id: String,
    /// Emisor de cancelacion de la conexion en curso. Es propiedad del
    /// proveedor: si lo guardara el supervisor, `disconnect` no tendria forma
    /// de pedirle que parase.
    cancel: Mutex<Option<watch::Sender<bool>>>,
    task: Mutex<Option<JoinHandle<()>>>,
    reporter: StatusReporter,
}

impl NativeProvider {
    pub fn new(config: ProviderConfig, bus: Arc<EventBus>, metrics: Arc<Metrics>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(config.user_agent.clone())
            .timeout(Duration::from_secs(30))
            .build()
            .context("construyendo cliente HTTP del provider")?;
        let reporter = StatusReporter::new(bus.clone(), metrics.clone());
        Ok(Self {
            config,
            http,
            bus,
            metrics,
            device_id: random_device_id(),
            cancel: Mutex::new(None),
            task: Mutex::new(None),
            reporter,
        })
    }
}

impl TikTokProvider for NativeProvider {
    fn name(&self) -> &'static str {
        "native"
    }

    fn status(&self) -> ProviderStatus {
        ProviderStatus::from_code(self.metrics.provider_state.load(Ordering::Relaxed))
    }

    fn connect<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let handle = handle.trim().trim_start_matches('@').to_string();
            // Una sola conexion por instancia: reconectar es reemplazar la tarea.
            self.stop_task().await;

            let (cancel_tx, cancel_rx) = watch::channel(false);
            if let Ok(mut guard) = self.cancel.lock() {
                *guard = Some(cancel_tx);
            }

            let supervisor = Supervisor {
                config: self.config.clone(),
                http: self.http.clone(),
                bus: self.bus.clone(),
                metrics: self.metrics.clone(),
                device_id: self.device_id.clone(),
                handle,
                reporter: self.reporter.clone(),
            };

            let task = tokio::spawn(async move {
                supervisor.run(cancel_rx).await;
            });
            if let Ok(mut guard) = self.task.lock() {
                *guard = Some(task);
            }
            self.reporter
                .set(ProviderStatus::Starting, Some("conectando".into()));
            Ok(())
        })
    }

    fn disconnect<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            // El supervisor sale del bucle por cancelacion, asi que el
            // `StreamDisconnected` que emitiria al caerse la conexion no se
            // publica solo: sin esto la sesion quedaba abierta en la base (y
            // `mark_crashed_streams` la marcaba como interrumpida al arrancar).
            let estaba = self.status();
            self.stop_task().await;
            if matches!(
                estaba,
                ProviderStatus::Connected | ProviderStatus::Connecting | ProviderStatus::Reconnecting
            ) {
                self.bus.publish(
                    None,
                    EventKind::StreamDisconnected {
                        reason: "desconectado por el usuario".into(),
                    },
                );
            }
            self.reporter.set(ProviderStatus::Stopped, None);
        })
    }
}

impl NativeProvider {
    async fn stop_task(&self) {
        // El emisor se *toma*, no se clona: si quedara alguno vivo, el
        // supervisor nunca veria la cancelacion.
        let sender = self.cancel.lock().ok().and_then(|mut guard| guard.take());
        if let Some(sender) = sender {
            let _ = sender.send(true);
        }
        let task = self.task.lock().ok().and_then(|mut guard| guard.take());
        if let Some(task) = task {
            // Margen corto: el supervisor observa la cancelacion en cada select.
            match tokio::time::timeout(Duration::from_secs(5), task).await {
                Ok(_) => {}
                Err(_) => tracing::warn!("el supervisor no termino a tiempo; se aborta"),
            }
        }
    }
}

/// Estado del supervisor de una conexion.
struct Supervisor {
    config: ProviderConfig,
    http: reqwest::Client,
    bus: Arc<EventBus>,
    metrics: Arc<Metrics>,
    device_id: String,
    handle: String,
    reporter: StatusReporter,
}

impl Supervisor {
    async fn sleep_or_cancel(&self, cancel: &mut watch::Receiver<bool>, delay: Duration) -> bool {
        tokio::select! {
            _ = tokio::time::sleep(delay) => false,
            _ = cancel.changed() => true,
        }
    }

    async fn run(&self, mut cancel: watch::Receiver<bool>) {
        let mut failures: u32 = 0;
        let mut delay = self.config.min_reconnect_delay;
        // Motivo por el que el supervisor se rinde. Se guarda para **no** pisarlo
        // con `Stopped` al salir: si no, tras "cuota inservible; detenido" el
        // usuario veia "Desconectado" (igual que si nunca hubiera conectado) y
        // volvia a pulsar Conectar, justo lo que se intenta evitar.
        let mut terminal: Option<String> = None;

        loop {
            if *cancel.borrow() {
                break;
            }

            // --- Etapa 1: resolver la sala (sin cuota) ---------------------
            let room = match resolve_room(&self.http, &self.config, &self.device_id, &self.handle).await {
                Ok(room) => room,
                Err(error) => {
                    failures += 1;
                    self.metrics.provider_errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(%error, "no se pudo resolver la sala");
                    self.reporter.set(ProviderStatus::Error, Some(error.to_string()));
                    if failures >= self.config.max_consecutive_failures {
                        let detail = format!("{} fallos consecutivos; detenido", failures);
                        self.reporter
                            .set(ProviderStatus::Error, Some(detail.clone()));
                        terminal = Some(detail);
                        break;
                    }
                    if self.sleep_or_cancel(&mut cancel, delay).await {
                        break;
                    }
                    delay = next_delay(delay, &self.config);
                    continue;
                }
            };

            if !room.live {
                // Sin cuota: solo se consulta el estado de la sala.
                self.reporter.set(
                    ProviderStatus::WaitingForLive,
                    Some(format!("@{} no esta en directo", self.handle)),
                );
                self.bus.publish(
                    None,
                    EventKind::StreamWaiting {
                        handle: self.handle.clone(),
                        detail: "esperando a que empiece el directo".into(),
                    },
                );
                if self
                    .sleep_or_cancel(&mut cancel, self.config.live_poll_interval)
                    .await
                {
                    break;
                }
                continue;
            }

            self.bus.set_room(&room.room_id);
            failures = 0;
            delay = self.config.min_reconnect_delay;

            // --- Etapa 2: payload firmado (consume 1 unidad de cuota) ------
            self.reporter.set(ProviderStatus::Connecting, Some("firmando conexion".into()));
            self.metrics.sign_requests.fetch_add(1, Ordering::Relaxed);
            let signed = match fetch_signed(&self.http, &self.config, &room.room_id).await {
                Ok(signed) => signed,
                Err(error) => {
                    let rate_limited = error.to_string().contains("LIMITE");
                    if rate_limited {
                        self.metrics.sign_rate_limited.fetch_add(1, Ordering::Relaxed);
                    }
                    self.metrics.provider_errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(%error, rate_limited, "fallo la firma");
                    self.reporter.set(ProviderStatus::Error, Some(error.to_string()));
                    failures += 1;
                    if failures >= self.config.max_consecutive_failures {
                        let detail =
                            "cuota o firma inservible; detenido para no agotar el dia".to_string();
                        self.reporter
                            .set(ProviderStatus::Error, Some(detail.clone()));
                        terminal = Some(detail);
                        break;
                    }
                    // Con cuota agotada se espera mucho mas: reintentar rapido
                    // solo empeora la situacion.
                    let wait = if rate_limited {
                        self.config.rate_limit_pause
                    } else {
                        delay
                    };
                    if self.sleep_or_cancel(&mut cancel, wait).await {
                        break;
                    }
                    delay = next_delay(delay, &self.config);
                    continue;
                }
            };

        // --- Etapas 3 y 4: WebSocket + decodificacion ------------------
        // Traza temporal: que nos ha dado el servidor de firma exactamente.
        // El `push_server` decide si habra eventos en vivo: se registra siempre.
        tracing::info!(
            push_server = %signed.envelope.push_server,
            cursor = %signed.envelope.cursor,
            need_ack = signed.envelope.need_ack,
            is_first = signed.envelope.is_first,
            heartbeat_duration = signed.envelope.heartbeat_duration,
            fetch_interval = signed.envelope.fetch_interval,
            route_params = signed.envelope.route_params.len(),
            mensajes = signed.envelope.messages.len(),
            internal_ext = signed.envelope.internal_ext.len(),
            "sobre firmado recibido"
        );
        let reason = self
            .pump(&mut cancel, &signed, &room)
                .await
                .unwrap_or_else(|error| {
                    self.metrics.provider_errors.fetch_add(1, Ordering::Relaxed);
                    error.to_string()
                });

            if *cancel.borrow() {
                break;
            }

            self.metrics
                .provider_reconnects
                .fetch_add(1, Ordering::Relaxed);
            self.bus.publish(
                None,
                EventKind::StreamDisconnected {
                    reason: reason.clone(),
                },
            );
            self.reporter.set(ProviderStatus::Reconnecting, Some(reason));
            if self.sleep_or_cancel(&mut cancel, delay).await {
                break;
            }
            delay = next_delay(delay, &self.config);
        }

        match terminal {
            Some(detail) => self.reporter.set(ProviderStatus::Error, Some(detail)),
            None => self.reporter.set(ProviderStatus::Stopped, None),
        }
    }

    /// Conecta el WebSocket y procesa frames hasta que falle o se cancele.
    async fn pump(
        &self,
        cancel: &mut watch::Receiver<bool>,
        signed: &SignedFetch,
        room: &RoomInfo,
    ) -> Result<String> {
        let ws_url = build_ws_url(&signed.envelope, &room.room_id, &self.config)?;
        // Traza temporal: la URL exacta del push server, para compararla con la
        // que funcionaba en la sesion grabada (fixtures `live.jsonl`).
        tracing::debug!(url = %ws_url, "url del WebSocket");

        let mut request = ws_url
            .clone()
            .into_client_request()
            .context("URL de WebSocket invalida")?;
        {
            let headers = request.headers_mut();
            headers.insert(
                "User-Agent",
                HeaderValue::from_str(&self.config.user_agent)?,
            );
            headers.insert("Origin", HeaderValue::from_static(TIKTOK_WEB));
            let cookie = if signed.cookies.is_empty() {
                IDC_COOKIE.to_string()
            } else {
                format!("{IDC_COOKIE}; {}", signed.cookies)
            };
            headers.insert("Cookie", HeaderValue::from_str(&cookie)?);
        }

        let (stream, response) = tokio_tungstenite::connect_async(request)
            .await
            .context("handshake del WebSocket")?;
        self.metrics.ws_connects.fetch_add(1, Ordering::Relaxed);
        tracing::info!(status = response.status().as_u16(), "WebSocket conectado");

        self.reporter.set(ProviderStatus::Connected, Some(room.room_id.clone()));
        self.bus.publish(
            None,
            EventKind::StreamConnected {
                room_id: room.room_id.clone(),
                title: room.title.clone(),
            },
        );

        // La respuesta inicial del servidor de firma ya trae eventos.
        let mut sink = EventSink::new(self.metrics.clone(), self.config.viewer_coalesce);
        for message in &signed.envelope.messages {
            translate_message(&message.method, &message.payload, &mut sink);
        }
        for (source_id, kind) in sink.drain() {
            self.bus.publish(source_id, kind);
        }

        let (mut write, mut read) = stream.split();

        // Entrada en la sala por el propio WebSocket.
        //
        // Sin este frame el push server responde 101 y **no empuja nada**: la
        // respuesta firmada trae los mensajes iniciales y a partir de ahi el
        // silencio (ver docs/decisions.md D9). Solo se envia cuando el
        // servidor marca la respuesta como la primera de la sesion.
        if signed.envelope.is_first {
            let peticion = WebcastPushFrame {
                seq_id: 1,
                log_id: 0,
                service: 0,
                method: 0,
                headers: Vec::new(),
                payload_encoding: "pb".into(),
                payload_type: "im_enter_room".into(),
                payload: WebcastImEnterRoomMessage {
                    room_id: room.room_id.parse().unwrap_or(0),
                    room_tag: String::new(),
                    live_region: String::new(),
                    live_id: 12,
                    identity: "audience".into(),
                    cursor: String::new(),
                    account_type: 0,
                    enter_unique_id: 0,
                    filter_welcome_msg: "0".into(),
                    is_anchor_continue_keep_msg: false,
                }
                .encode_to_vec(),
            };
            write
                .send(Message::Binary(peticion.encode_to_vec()))
                .await
                .context("enviando im_enter_room")?;
            tracing::info!(room_id = %room.room_id, "peticion de entrada en la sala enviada");
        }

        // El latido lleva un `HeartBeatMessage` con la sala y un contador, no
        // cuatro bytes sueltos; el servidor marca cada cuanto quiere recibirlo.
        let intervalo = if signed.envelope.heartbeat_duration > 0 {
            Duration::from_millis(signed.envelope.heartbeat_duration as u64)
        } else {
            HEARTBEAT_FALLBACK
        };
        let mut heartbeat = tokio::time::interval(intervalo);
        heartbeat.tick().await; // descarta el tick inmediato
        let mut latido: i64 = 1;

        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    let frame = WebcastPushFrame {
                        seq_id: 0,
                        log_id: 0,
                        service: 0,
                        method: 0,
                        headers: Vec::new(),
                        payload_encoding: "pb".into(),
                        payload_type: "hb".into(),
                        payload: HeartBeatMessage {
                            room_id: room.room_id.parse().unwrap_or(0),
                            send_packet_seq_id: latido,
                        }
                        .encode_to_vec(),
                    };
                    latido += 1;
                    write
                        .send(Message::Binary(frame.encode_to_vec()))
                        .await
                        .context("enviando heartbeat")?;
                }
                incoming = read.next() => {
                    match incoming {
                        None => return Ok("el servidor cerro la conexion".into()),
                        Some(Err(error)) => return Err(anyhow!("error de WebSocket: {error}")),
                        Some(Ok(Message::Binary(raw))) => {
                            self.metrics.ws_frames.fetch_add(1, Ordering::Relaxed);
                            // Traza temporal: distingue "el servidor no manda nada"
                            // de "manda frames que no sabemos leer".
                            tracing::debug!(
                                bytes = raw.len(),
                                frames = self.metrics.ws_frames.load(Ordering::Relaxed),
                                "frame crudo recibido"
                            );
                            match decode_frame(&raw) {
                                Ok((ack, messages)) => {
                                    for message in &messages {
                                        translate_message(
                                            &message.method,
                                            &message.payload,
                                            &mut sink,
                                        );
                                    }
                                    if let Some(ack) = ack {
                                        write.send(Message::Binary(ack)).await
                                            .context("enviando ACK")?;
                                    }
                                }
                                Err(error) => tracing::debug!(%error, "frame no procesable"),
                            }
                            for (source_id, kind) in sink.drain() {
                                self.bus.publish(source_id, kind);
                            }
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            write.send(Message::Pong(payload)).await.ok();
                        }
                        Some(Ok(_)) => {}
                    }
                }
                _ = cancel.changed() => {
                    if *cancel.borrow() {
                        return Ok("desconectado por el usuario".into());
                    }
                }
            }
        }
    }

}

/// Traduce un mensaje de TikTok a eventos del protocolo interno.
///
/// Es una funcion libre y no un metodo del supervisor para que los contract
/// tests puedan alimentarla con frames grabados sin montar un proveedor.
pub(crate) fn translate_message(method: &str, payload: &[u8], sink: &mut EventSink) {
        match method {
            "WebcastChatMessage" => match WebcastChatMessage::decode(payload) {
                Ok(message) => {
                    let Some(user) = user_ref(&message.user) else {
                        return;
                    };
                    // TikTok manda los mensajes que son **solo** emote con
                    // `content` vacio (un espacio) y los emotes aparte: mirar
                    // solo el texto los descartaba enteros. Solo se descarta lo
                    // que no trae ni texto ni emotes.
                    let emote_count = message.emotes.len() as u32;
                    if message.content.trim().is_empty() && emote_count == 0 {
                        return;
                    }
                    let id = message.common.as_ref().map(source_id);
                    // Traza por mensaje: util para seguir uno concreto de punta a
                    // punta, pero a nivel debug porque una sala grande escribe
                    // decenas por segundo.
                    tracing::debug!(
                        id = id.as_deref().unwrap_or("-"),
                        autor = %user.unique_id,
                        texto = %message.content,
                        emotes = emote_count,
                        "chat decodificado"
                    );
                    sink.push(
                        id,
                        EventKind::ChatMessage {
                            user,
                            content: message.content,
                            emote_count,
                        },
                    );
                }
                Err(error) => tracing::debug!(%error, "chat no decodificable"),
            },

            // Entradas en la sala: el mensaje mas frecuente de TikTok. Sin esta
            // rama se descartaba en silencio (el `other =>` de abajo).
            "WebcastMemberMessage" => match WebcastMemberMessage::decode(payload) {
                Ok(message) => {
                    let Some(user) = user_ref(&message.user) else {
                        return;
                    };
                    sink.push(
                        message.common.as_ref().map(source_id),
                        EventKind::MemberJoined { user },
                    );
                }
                Err(error) => tracing::debug!(%error, "entrada en la sala no decodificable"),
            },

            // Fin del directo: cierra la sesion en el momento en vez de
            // esperar a que caiga el WebSocket (o al siguiente arranque, donde
            // `mark_crashed_streams` la marcaba como interrumpida).
            "WebcastControlMessage" => match WebcastControlMessage::decode(payload) {
                Ok(message) => {
                    let reason = match message.action {
                        WebcastControlMessage::STREAM_ENDED => "el directo ha terminado",
                        WebcastControlMessage::STREAM_SUSPENDED => "el directo se ha suspendido",
                        other => {
                            // Pausa, reanudacion y desconocidos no cierran nada.
                            tracing::trace!(action = other, "control sin fin de directo");
                            return;
                        }
                    };
                    sink.push(
                        message.common.as_ref().map(source_id),
                        EventKind::StreamDisconnected {
                            reason: reason.to_string(),
                        },
                    );
                }
                Err(error) => tracing::debug!(%error, "control no decodificable"),
            },

            "WebcastImDeleteMessage" => match WebcastImDeleteMessage::decode(payload) {
                Ok(message) => {
                    if message.delete_msg_ids.is_empty() {
                        tracing::trace!("aviso de borrado sin mensajes; se ignora");
                        return;
                    }
                    for msg_id in &message.delete_msg_ids {
                        // El `source_id` del evento va vacio a proposito: un
                        // mismo aviso puede borrar varios mensajes, y repetir el
                        // id del aviso haria que el bus descartase los
                        // siguientes como duplicados. El mensaje borrado viaja
                        // en el cuerpo del evento.
                        sink.push(
                            None,
                            EventKind::ChatMessageDeleted {
                                source_id: msg_id.to_string(),
                            },
                        );
                    }
                }
                Err(error) => tracing::debug!(%error, "borrado de comentarios no decodificable"),
            },

            "WebcastGiftMessage" => match WebcastGiftMessage::decode(payload) {
                Ok(message) => {
                    let Some(user) = user_ref(&message.user) else {
                        return;
                    };
                    let gift = gift_info(&message);
                    sink.push(
                        message.common.as_ref().map(source_id),
                        EventKind::GiftReceived { user, gift },
                    );
                }
                Err(error) => tracing::debug!(%error, "regalo no decodificable"),
            },

            "WebcastLikeMessage" => match WebcastLikeMessage::decode(payload) {
                Ok(message) => sink.push(
                    message.common.as_ref().map(source_id),
                    EventKind::LikeUpdated {
                        user: user_ref(&message.user),
                        count: i64::from(message.count),
                        total: message.total,
                    },
                ),
                Err(error) => tracing::debug!(%error, "like no decodificable"),
            },

            "WebcastRoomUserSeqMessage" => {
                match WebcastRoomUserSeqMessage::decode(payload) {
                    // OJO: `total` son los espectadores actuales y `total_user`
                    // los acumulados. Verificado contra la API de TikTok.
                    Ok(message) => sink.observe_viewers(message.total, message.total_user),
                    Err(error) => tracing::debug!(%error, "viewers no decodificable"),
                }
            }

            "WebcastSocialMessage" => match WebcastSocialMessage::decode(payload) {
                Ok(message) => {
                    let Some(user) = user_ref(&message.user) else {
                        return;
                    };
                    // El discriminador fiable es `common.display_text.key`
                    // (contiene "follow" o "share"), no el campo `action`.
                    let clave = message
                        .common
                        .as_ref()
                        .map(|common| common.display_key().to_ascii_lowercase())
                        .unwrap_or_default();
                    let id = message.common.as_ref().map(source_id);
                    if clave.contains("share") {
                        sink.push(id, EventKind::ShareReceived { user });
                    } else if clave.contains("follow") {
                        sink.push(id, EventKind::FollowReceived { user });
                    } else {
                        tracing::debug!(clave = %clave, "social sin follow ni share; se ignora");
                    }
                }
                Err(error) => tracing::debug!(%error, "social no decodificable"),
            },

            "WebcastSubNotifyMessage" => match WebcastSubNotifyMessage::decode(payload) {
                Ok(message) => {
                    // Solo se emite con meses implicados: los enums de tipo de
                    // suscripcion no estan verificados en directo, pero
                    // `sub_month` si es inequivoco.
                    if message.sub_month <= 0 {
                        tracing::trace!("aviso de suscripcion sin meses; se ignora");
                        return;
                    }
                    if let Some(user) = user_ref(&message.user) {
                        sink.push(
                            message.common.as_ref().map(source_id),
                            EventKind::SubscribeReceived {
                                user,
                                months: message.sub_month,
                            },
                        );
                    }
                }
                Err(error) => tracing::debug!(%error, "suscripcion no decodificable"),
            },

            other => tracing::trace!(method = other, "mensaje no modelado"),
        }
}

// ---------------------------------------------------------------------------
// Decodificacion de frames
// ---------------------------------------------------------------------------

/// Acumula los eventos que produce un frame.
///
/// Es publico para que los contract tests puedan reproducir frames grabados y
/// comprobar el flujo completo sin tocar la red (ver `tests/`).
pub struct EventSink {
    events: Vec<(Option<String>, EventKind)>,
    last_viewer_emit: Option<std::time::Instant>,
    latest_viewers: Option<(i64, i64)>,
    metrics: Arc<Metrics>,
    /// Ventana minima entre actualizaciones de viewers.
    coalesce: Duration,
}

impl EventSink {
    pub fn new(metrics: Arc<Metrics>, coalesce: Duration) -> Self {
        Self {
            events: Vec::new(),
            last_viewer_emit: None,
            latest_viewers: None,
            metrics,
            coalesce,
        }
    }

    pub fn push(&mut self, source_id: Option<String>, kind: EventKind) {
        self.events.push((source_id, kind));
    }

    /// Extrae los eventos acumulados y vacia el acumulador.
    pub fn drain(&mut self) -> Vec<(Option<String>, EventKind)> {
        std::mem::take(&mut self.events)
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn latest_viewers(&self) -> Option<(i64, i64)> {
        self.latest_viewers
    }

    /// Los viewers llegan muy rapido y solo interesa el ultimo valor: se emite
    /// como maximo una vez por ventana y se cuenta lo colapsado.
    pub fn observe_viewers(&mut self, current: i64, cumulative: i64) {
        self.latest_viewers = Some((current, cumulative));
        let now = std::time::Instant::now();
        let due = match self.last_viewer_emit {
            None => true,
            Some(last) => now.duration_since(last) >= self.coalesce,
        };
        if due {
            self.last_viewer_emit = Some(now);
            self.metrics
                .viewer_updates_emitted
                .fetch_add(1, Ordering::Relaxed);
            self.push(None, EventKind::ViewerUpdated { current, cumulative });
        } else {
            self.metrics
                .viewer_updates_coalesced
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Decodifica un frame crudo.
///
/// Devuelve el ACK a enviar (si procede) **y los mensajes que contiene**. Es
/// importante devolver los mensajes y no solo el ACK: en la primera conexion
/// real se detecto que, al descartarlos aqui, los frames se decodificaban
/// correctamente pero ningun evento llegaba al bus.
fn decode_frame(raw: &[u8]) -> Result<(Option<Vec<u8>>, Vec<BaseProtoMessage>)> {
    let frame = WebcastPushFrame::decode(raw).context("decodificando WebcastPushFrame")?;

    if frame.payload_type != "msg" {
        tracing::trace!(payload_type = %frame.payload_type, "frame ignorado");
        return Ok((None, Vec::new()));
    }

    let payload = match frame.compress_type() {
        Some("gzip") => gunzip(&frame.payload)?,
        Some("none") | None => frame.payload.clone(),
        Some(other) => {
            tracing::warn!(compress_type = other, "compresion desconocida");
            frame.payload.clone()
        }
    };

    let envelope = ProtoMessageFetchResult::decode(&payload[..])
        .context("decodificando ProtoMessageFetchResult")?;

    // Traza temporal: que trae cada frame y si pide ACK.
    tracing::debug!(
        mensajes = envelope.messages.len(),
        need_ack = envelope.need_ack,
        log_id = frame.log_id,
        metodos = %envelope
            .messages
            .iter()
            .map(|m| m.method.as_str())
            .collect::<Vec<_>>()
            .join(","),
        "envelope decodificado"
    );

    let ack = if envelope.need_ack && frame.log_id != 0 {
        // El ACK reenvia el `internal_ext` del sobre (o "-" si viene vacio),
        // con la misma codificacion que usa el cliente de referencia.
        let ack = WebcastPushFrame {
            seq_id: frame.seq_id,
            log_id: frame.log_id,
            service: 0,
            method: 0,
            headers: Vec::new(),
            payload_encoding: "pb".into(),
            payload_type: "ack".into(),
            payload: if envelope.internal_ext.is_empty() {
                b"-".to_vec()
            } else {
                envelope.internal_ext.clone()
            },
        };
        Some(ack.encode_to_vec())
    } else {
        None
    };

    Ok((ack, envelope.messages))
}

fn gunzip(payload: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = flate2::read::GzDecoder::new(payload);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .context("gunzip del payload")?;
    Ok(out)
}

fn user_ref(user: &Option<User>) -> Option<UserRef> {
    let user = user.as_ref()?;
    if user.id == 0 {
        return None;
    }
    Some(UserRef {
        id: user.id.to_string(),
        unique_id: user.display_id.clone(),
        nickname: user.nickname.clone(),
    })
}

fn source_id(common: &CommonMessageData) -> String {
    common.msg_id.to_string()
}

/// Traduce el mensaje de regalo a la unidad canonica del protocolo.
fn gift_info(message: &WebcastGiftMessage) -> GiftInfo {
    let gift = message.gift.as_ref();
    let id = if let Some(gift) = gift {
        gift.id.to_string()
    } else {
        message.gift_id.to_string()
    };
    GiftInfo::new(
        id,
        gift.map(|g| g.name.clone()).unwrap_or_default(),
        gift.map(|g| g.diamond_count).unwrap_or(0),
        gift.map(Gift::streakable).unwrap_or(false),
        message.repeat_count,
        message.repeat_end != 0,
        message.group_id.to_string(),
    )
    // El icono es lo que permite mostrar el regalo en el panel.
    .with_image(
        gift.and_then(|g| g.image.as_ref())
            .map(ImageModel::best_url)
            .unwrap_or_default(),
    )
}

// ---------------------------------------------------------------------------
// HTTP: sala y firma
// ---------------------------------------------------------------------------

fn pct(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn query(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn random_device_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut id = String::with_capacity(19);
    id.push(char::from_digit(rng.gen_range(1..=9), 10).unwrap());
    for _ in 0..18 {
        id.push(char::from_digit(rng.gen_range(0..=9), 10).unwrap());
    }
    id
}

fn browser_version(ua: &str) -> String {
    pct(ua.split_once('/').map(|(_, rest)| rest).unwrap_or(ua))
}

fn browser_name(ua: &str) -> String {
    ua.split_once('/')
        .map(|(name, _)| name)
        .unwrap_or("Mozilla")
        .to_string()
}

fn web_params(config: &ProviderConfig, device_id: &str, handle: &str) -> Vec<(String, String)> {
    let pair = |key: &str, value: &str| (key.to_string(), value.to_string());
    vec![
        pair("aid", "1988"),
        pair("app_language", &config.app_language),
        pair("app_name", "tiktok_web"),
        pair("browser_language", &config.browser_language),
        pair("browser_name", &browser_name(&config.user_agent)),
        pair("browser_online", "true"),
        pair("browser_platform", "Win32"),
        pair("browser_version", &browser_version(&config.user_agent)),
        pair("channel", "tiktok_web"),
        pair("cookie_enabled", "true"),
        pair("data_collection_enabled", "true"),
        pair("device_platform", "web_pc"),
        pair("device_id", device_id),
        pair("focus_state", "true"),
        pair("from_page", ""),
        pair("history_len", "8"),
        pair("is_fullscreen", "false"),
        pair("is_page_visible", "true"),
        pair("os", "windows"),
        pair("priority_region", &config.region),
        pair("region", &config.region),
        pair("root_referer", &format!("{TIKTOK_WEB}/@{handle}")),
        pair("screen_height", "1080"),
        pair("screen_width", "1920"),
        pair("tz_name", &config.tz_name),
        pair("user_is_login", "false"),
        pair("webcast_language", &config.app_language),
        pair("msToken", ""),
    ]
}

/// Parametros del WebSocket: sus valores ya van pre-codificados, no se vuelven
/// a codificar (el doble encoding rompe el handshake).
fn ws_params(config: &ProviderConfig) -> Vec<(String, String)> {
    let pair = |key: &str, value: &str| (key.to_string(), value.to_string());
    vec![
        pair("aid", "1988"),
        pair("app_language", &config.app_language),
        pair("app_name", "tiktok_web"),
        pair("browser_platform", "Win32"),
        pair("browser_language", &config.browser_language),
        pair("browser_name", &browser_name(&config.user_agent)),
        pair("browser_version", &browser_version(&config.user_agent)),
        pair("browser_online", "true"),
        pair("cookie_enabled", "true"),
        pair("tz_name", &config.tz_name),
        pair("device_platform", "web"),
        pair("identity", "audience"),
        pair("live_id", "12"),
        pair("sup_ws_ds_opt", "1"),
        pair("update_version_code", "2.0.0"),
        pair("version_code", "180800"),
        pair("client_enter", "1"),
        pair("ws_direct", "1"),
        pair("did_rule", "3"),
        pair("webcast_language", &config.app_language),
        pair("screen_height", "1080"),
        pair("screen_width", "1920"),
        pair("heartbeat_duration", "10000"),
        pair("resp_content_type", "protobuf"),
        pair("history_comment_count", "6"),
        pair("last_rtt", "137"),
    ]
}

/// Extrae el JSON de un `<script id="..." type="application/json">` del HTML.
///
/// Se hace con busqueda de cadenas en lugar de expresiones regulares: el HTML de
/// TikTok trae comillas y barras por todas partes y una expresion regular es
/// justo lo que peor se lee aqui.
fn extract_script_json(html: &str, id: &str) -> Option<String> {
    let marcador = format!("<script id=\"{id}\" type=\"application/json\">");
    let inicio = html.find(&marcador)? + marcador.len();
    let resto = &html[inicio..];
    let fin = resto.find("</script>")?;
    Some(resto[..fin].to_string())
}

/// Interpreta el `SIGI_STATE` de la pagina `/@usuario/live`.
///
/// Es la via de respaldo: la API de salas responde 403 cuando TikTok limita las
/// peticiones, y sin plan B la aplicacion se queda sin poder conectar.
fn parse_live_html(html: &str) -> Result<RoomInfo> {
    let json_text = extract_script_json(html, "SIGI_STATE").ok_or_else(|| {
        anyhow!("no se encontro SIGI_STATE en la pagina: puede que TikTok este bloqueando las peticiones")
    })?;
    let json: Value =
        serde_json::from_str(&json_text).context("SIGI_STATE no es JSON valido")?;

    let user = json
        .pointer("/LiveRoom/liveRoomUserInfo/user")
        .ok_or_else(|| anyhow!("el usuario no existe o no puede emitir en directo"))?;

    let room_id = user
        .get("roomId")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .filter(|text| !text.is_empty())
        .ok_or_else(|| anyhow!("la pagina no trae roomId"))?;

    // En esta via, `status == 4` es la unica senal fiable de "no esta en directo".
    let live = user.get("status").and_then(Value::as_i64) != Some(4);

    Ok(RoomInfo {
        room_id,
        live,
        title: json
            .pointer("/LiveRoom/liveRoomUserInfo/liveRoom/title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// Resuelve la sala por la via de respaldo (HTML).
async fn resolve_room_html(
    http: &reqwest::Client,
    handle: &str,
) -> Result<RoomInfo> {
    let url = format!("{TIKTOK_WEB}/@{handle}/live");
    let response = http
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Referer", TIKTOK_WEB)
        .send()
        .await
        .context("GET /@usuario/live")?;

    let status = response.status();
    let html = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("la pagina del directo devolvio HTTP {status}");
    }
    parse_live_html(&html)
}

async fn resolve_room(
    http: &reqwest::Client,
    config: &ProviderConfig,
    device_id: &str,
    handle: &str,
) -> Result<RoomInfo> {
    match resolve_room_api(http, config, device_id, handle).await {
        Ok(room) => Ok(room),
        Err(api_error) => {
            // La API de salas devuelve 403 cuando TikTok limita las peticiones.
            // Se intenta la via del HTML antes de rendirse.
            tracing::warn!(%api_error, "la via de la API fallo; se prueba el HTML");
            match resolve_room_html(http, handle).await {
                Ok(room) => {
                    tracing::info!(room_id = %room.room_id, live = room.live, "sala resuelta por HTML");
                    Ok(room)
                }
                Err(html_error) => bail!(
                    "no se pudo resolver la sala: API ({api_error}) y HTML ({html_error})"
                ),
            }
        }
    }
}

async fn resolve_room_api(
    http: &reqwest::Client,
    config: &ProviderConfig,
    device_id: &str,
    handle: &str,
) -> Result<RoomInfo> {
    let mut params = web_params(config, device_id, handle);
    params.push(("sourceType".into(), "54".into()));
    params.push(("uniqueId".into(), handle.to_string()));
    let url = format!("{TIKTOK_WEB}/api-live/user/room/?{}", query(&params));

    let response = http
        .get(&url)
        .header("Accept", "application/json")
        .header("Referer", TIKTOK_WEB)
        .header("Origin", TIKTOK_WEB)
        .send()
        .await
        .context("GET api-live/user/room")?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!(
            "api-live/user/room devolvio HTTP {status}: {}",
            &body[..body.len().min(200)]
        );
    }

    let json: Value = serde_json::from_str(&body)
        .with_context(|| format!("JSON inesperado: {}", &body[..body.len().min(160)]))?;

    let message = json.get("message").and_then(Value::as_str).unwrap_or("");
    if !message.is_empty() {
        bail!("TikTok respondio: {message}");
    }

    let room_id = json
        .pointer("/data/user/roomId")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .filter(|text| !text.is_empty())
        .ok_or_else(|| anyhow!("sin roomId en la respuesta"))?;

    // `roomId` sigue poblado aunque el usuario este offline: la unica senal
    // fiable es `liveRoom.status == 4`.
    let live_status = json.pointer("/data/liveRoom/status").and_then(Value::as_i64);

    Ok(RoomInfo {
        room_id,
        live: live_status != Some(4),
        title: json
            .pointer("/data/liveRoom/title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

struct SignedFetch {
    envelope: ProtoMessageFetchResult,
    cookies: String,
}

/// URL de `/webcast/fetch` en el servidor de firma.
///
/// El `user_agent` **debe ir codificado**: contiene espacios, parentesis y
/// barras, y el servidor responde `400 Invalid user agent provided` si se envia
/// en crudo. Es el mismo cuidado que exige la URL del WebSocket, asi que ambas
/// usan `pct`.
fn sign_url(config: &ProviderConfig, room_id: &str) -> String {
    let params = [
        ("client".to_string(), CLIENT_NAME.to_string()),
        ("room_id".to_string(), room_id.to_string()),
        ("user_agent".to_string(), pct(&config.user_agent)),
        ("platform".to_string(), "web".to_string()),
        ("client_enter".to_string(), "true".to_string()),
    ];
    format!("{}/webcast/fetch?{}", config.sign_base, query(&params))
}

async fn fetch_signed(
    http: &reqwest::Client,
    config: &ProviderConfig,
    room_id: &str,
) -> Result<SignedFetch> {
    let url = sign_url(config, room_id);

    let response = http
        .get(&url)
        .header("Accept", "application/json, application/protobuf")
        .header("Referer", TIKTOK_WEB)
        .header("Origin", TIKTOK_WEB)
        .send()
        .await
        .context("GET webcast/fetch")?;

    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .bytes()
        .await
        .context("leyendo el cuerpo del servidor de firma")?;

    if status.as_u16() == 429 {
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let message = json
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("(sin mensaje)");
        let label = json.get("limit_label").and_then(Value::as_str).unwrap_or("");
        bail!("LIMITE del servidor de firma {label}: {message}");
    }
    if !status.is_success() {
        bail!(
            "servidor de firma HTTP {status}: {}",
            String::from_utf8_lossy(&bytes[..bytes.len().min(200)])
        );
    }
    if bytes.is_empty() {
        bail!("el servidor de firma devolvio un cuerpo vacio");
    }

    Ok(SignedFetch {
        envelope: ProtoMessageFetchResult::decode(&bytes[..])
            .context("decodificando ProtoMessageFetchResult")?,
        cookies: headers
            .get("x-set-tt-cookie")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string(),
    })
}

fn build_ws_url(
    envelope: &ProtoMessageFetchResult,
    room_id: &str,
    config: &ProviderConfig,
) -> Result<String> {
    if envelope.push_server.is_empty() {
        bail!("sin push_server en la respuesta inicial");
    }
    if envelope.cursor.is_empty() {
        bail!("sin cursor en la respuesta inicial");
    }

    // Los valores de route_params vienen del servidor y deben codificarse; los
    // base ya vienen codificados y no deben tocarse.
    let mut all: Vec<(String, String)> = envelope
        .route_params
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| (key.clone(), pct(value)))
        .collect();
    all.sort();
    all.extend(ws_params(config));
    all.push(("room_id".into(), room_id.to_string()));
    all.push(("compress".into(), "gzip".into()));

    Ok(format!(
        "{}?{}&version_code=270000",
        envelope.push_server,
        query(&all)
    ))
}

/// Backoff exponencial con jitter: evita sincronizar reintentos entre clientes.
fn next_delay(current: Duration, config: &ProviderConfig) -> Duration {
    use rand::Rng;
    let doubled = current.saturating_mul(2).min(config.max_reconnect_delay);
    let jitter = rand::thread_rng().gen_range(0.8..1.2);
    Duration::from_secs_f64(doubled.as_secs_f64() * jitter)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Usuario minimo decodificable: `user_ref` descarta los que no traen id.
    fn usuario(id: i64, handle: &str) -> User {
        User {
            id,
            nickname: format!("Nick {id}"),
            display_id: handle.to_string(),
            sec_uid: String::new(),
        }
    }

    fn comun(method: &str, msg_id: i64) -> CommonMessageData {
        CommonMessageData {
            method: method.to_string(),
            msg_id,
            ..Default::default()
        }
    }

    fn sink_de_prueba() -> EventSink {
        EventSink::new(Arc::new(Metrics::default()), Duration::from_millis(500))
    }

    fn chat_proto(content: &str, emotes: usize) -> Vec<u8> {
        WebcastChatMessage {
            common: Some(comun("WebcastChatMessage", 11)),
            user: Some(usuario(1, "carlos")),
            content: content.to_string(),
            emotes: (0..emotes)
                .map(|indice| EmoteWithIndex {
                    index: indice as i64,
                })
                .collect(),
        }
        .encode_to_vec()
    }

    // -----------------------------------------------------------------------
    // Mensajes que antes se descartaban o no se modelaban
    // -----------------------------------------------------------------------

    /// TikTok manda los mensajes que son **solo** emote con `content` vacio (un
    /// espacio) y la lista de emotes aparte: mirar solo el texto los
    /// descartaba enteros.
    #[test]
    fn un_mensaje_que_es_solo_emote_no_se_descarta() {
        let mut sink = sink_de_prueba();
        translate_message("WebcastChatMessage", &chat_proto(" ", 2), &mut sink);

        let eventos = sink.drain();
        assert_eq!(eventos.len(), 1, "el mensaje de emotes debe llegar al bus");
        match &eventos[0].1 {
            EventKind::ChatMessage {
                content,
                emote_count,
                user,
            } => {
                assert_eq!(*emote_count, 2, "dos emotes del fansclub");
                assert_eq!(content.as_str(), " ");
                assert_eq!(user.unique_id, "carlos");
            }
            otro => panic!("se esperaba un chat, llego {}", otro.name()),
        }
        assert_eq!(
            eventos[0].0.as_deref(),
            Some("11"),
            "el mensaje conserva su msg_id"
        );
    }

    /// Un mensaje con texto no puede contar emotes que no trae.
    #[test]
    fn el_chat_con_texto_cuenta_cero_emotes() {
        let mut sink = sink_de_prueba();
        translate_message("WebcastChatMessage", &chat_proto("hola a todos", 0), &mut sink);

        match &sink.drain()[0].1 {
            EventKind::ChatMessage { emote_count, .. } => assert_eq!(*emote_count, 0),
            otro => panic!("se esperaba un chat, llego {}", otro.name()),
        }
    }

    /// Sin texto **y** sin emotes se sigue descartando: una lista de emotes
    /// vacia no convierte un mensaje vacio en un mensaje valido.
    #[test]
    fn el_chat_sin_texto_ni_emotes_se_sigue_descartando() {
        let mut sink = sink_de_prueba();
        translate_message("WebcastChatMessage", &chat_proto("   ", 0), &mut sink);
        assert!(sink.is_empty(), "un mensaje vacio no es un mensaje");
    }

    /// Las entradas en la sala son el mensaje mas frecuente de TikTok y antes se
    /// perdian en el `other =>` de `translate_message`.
    #[test]
    fn la_entrada_en_la_sala_publica_member_joined() {
        let mut sink = sink_de_prueba();
        let payload = WebcastMemberMessage {
            common: Some(comun("WebcastMemberMessage", 22)),
            user: Some(usuario(7, "ana")),
        }
        .encode_to_vec();
        translate_message("WebcastMemberMessage", &payload, &mut sink);

        let eventos = sink.drain();
        assert_eq!(eventos.len(), 1);
        assert_eq!(eventos[0].1.name(), "member.joined");
        match &eventos[0].1 {
            EventKind::MemberJoined { user } => assert_eq!(user.unique_id, "ana"),
            otro => panic!("se esperaba una entrada, llego {}", otro.name()),
        }
        assert_eq!(eventos[0].0.as_deref(), Some("22"));
    }

    /// Una entrada sin usuario identificable (id 0) no puede publicarse.
    #[test]
    fn la_entrada_sin_usuario_no_publica_nada() {
        let mut sink = sink_de_prueba();
        let payload = WebcastMemberMessage {
            common: Some(comun("WebcastMemberMessage", 23)),
            user: None,
        }
        .encode_to_vec();
        translate_message("WebcastMemberMessage", &payload, &mut sink);
        assert!(sink.is_empty());
    }

    /// El fin del directo llega por `WebcastControlMessage` y cierra la sesion
    /// en el momento, sin esperar a que caiga el WebSocket.
    #[test]
    fn el_control_de_fin_de_directo_publica_la_desconexion() {
        for (action, fragmento) in [
            (WebcastControlMessage::STREAM_ENDED, "terminado"),
            (WebcastControlMessage::STREAM_SUSPENDED, "suspendido"),
        ] {
            let mut sink = sink_de_prueba();
            let payload = WebcastControlMessage {
                common: Some(comun("WebcastControlMessage", 33)),
                action,
            }
            .encode_to_vec();
            translate_message("WebcastControlMessage", &payload, &mut sink);

            let eventos = sink.drain();
            assert_eq!(eventos.len(), 1, "action {action} cierra el directo");
            match &eventos[0].1 {
                EventKind::StreamDisconnected { reason } => assert!(
                    reason.contains(fragmento),
                    "el motivo debe ser claro, es {reason:?}"
                ),
                otro => panic!("se esperaba una desconexion, llego {}", otro.name()),
            }
        }

        // Pausa, reanudacion y valores desconocidos no cierran la sesion.
        for action in [0, 1, 2, 99] {
            let mut sink = sink_de_prueba();
            let payload = WebcastControlMessage {
                common: Some(comun("WebcastControlMessage", 34)),
                action,
            }
            .encode_to_vec();
            translate_message("WebcastControlMessage", &payload, &mut sink);
            assert!(
                sink.is_empty(),
                "action {action} no es un fin de directo y no debe cerrar la sesion"
            );
        }
    }

    /// El borrado de comentarios se publica con el `msg_id` del mensaje borrado.
    #[test]
    fn el_borrado_de_comentarios_publica_su_evento() {
        let mut sink = sink_de_prueba();
        let payload = WebcastImDeleteMessage {
            common: Some(comun("WebcastImDeleteMessage", 44)),
            delete_msg_ids: vec![111, 222],
        }
        .encode_to_vec();
        translate_message("WebcastImDeleteMessage", &payload, &mut sink);

        let eventos = sink.drain();
        assert_eq!(eventos.len(), 2, "un aviso puede borrar varios mensajes");
        let borrados: Vec<&str> = eventos
            .iter()
            .filter_map(|(_, kind)| match kind {
                EventKind::ChatMessageDeleted { source_id } => Some(source_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(borrados, vec!["111", "222"]);
        // El `source_id` del evento va vacio: repetir el id del aviso haria que
        // el bus descartase el segundo borrado como duplicado.
        assert!(
            eventos.iter().all(|(source, _)| source.is_none()),
            "el aviso no puede reutilizar su id para cada mensaje borrado"
        );

        // Un aviso sin ids no publica nada.
        let mut sink = sink_de_prueba();
        let vacio = WebcastImDeleteMessage {
            common: Some(comun("WebcastImDeleteMessage", 45)),
            delete_msg_ids: Vec::new(),
        }
        .encode_to_vec();
        translate_message("WebcastImDeleteMessage", &vacio, &mut sink);
        assert!(sink.is_empty());
    }

    #[test]
    fn extrae_el_json_de_un_script_por_id() {
        let html = r#"<html><head><script id="SIGI_STATE" type="application/json">{"a":1}</script></head></html>"#;
        assert_eq!(
            extract_script_json(html, "SIGI_STATE").as_deref(),
            Some(r#"{"a":1}"#)
        );
        assert!(extract_script_json(html, "OTRO").is_none());
        assert!(extract_script_json("<html></html>", "SIGI_STATE").is_none());
    }

    #[test]
    fn la_via_html_resuelve_la_sala_y_detecta_el_fin_del_directo() {
        let en_directo = r#"<script id="SIGI_STATE" type="application/json">{"LiveRoom":{"liveRoomUserInfo":{"user":{"uniqueId":"carlos","roomId":"7686403026103585554","status":2},"liveRoom":{"title":"jugando"}}}}</script>"#;
        let room = parse_live_html(en_directo).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(room.room_id, "7686403026103585554");
        assert!(room.live, "status distinto de 4 significa en directo");
        assert_eq!(room.title, "jugando");

        let apagado = r#"<script id="SIGI_STATE" type="application/json">{"LiveRoom":{"liveRoomUserInfo":{"user":{"roomId":"1","status":4}}}}</script>"#;
        let room = parse_live_html(apagado).expect("sala resuelta");
        assert!(!room.live, "status 4 significa que no esta en directo");

        // Sin LiveRoom, el usuario no existe o nunca ha emitido.
        let inexistente =
            r#"<script id="SIGI_STATE" type="application/json">{"UserModule":{}}</script>"#;
        assert!(parse_live_html(inexistente).is_err());

        // Sin SIGI_STATE, TikTok esta bloqueando las peticiones.
        assert!(parse_live_html("<html></html>").is_err());

        // Con LiveRoom pero sin roomId tampoco se puede seguir.
        let sin_sala = r#"<script id="SIGI_STATE" type="application/json">{"LiveRoom":{"liveRoomUserInfo":{"user":{"status":2}}}}</script>"#;
        assert!(parse_live_html(sin_sala).is_err());
    }

    #[test]
    fn la_url_de_firma_codifica_el_user_agent() {        // Regresion: enviarlo en crudo hace que el servidor de firma responda
        // `400 Invalid user agent provided` y no se pueda conectar a nada.
        let config = ProviderConfig::default();
        let url = sign_url(&config, "7686381796992322334");

        assert!(url.starts_with("https://api.eulerstream.com/webcast/fetch?"));
        assert!(url.contains("client=ttlive-python"));
        assert!(url.contains("room_id=7686381796992322334"));
        assert!(url.contains("platform=web"));
        assert!(url.contains("client_enter=true"));
        assert!(
            url.contains("user_agent=Mozilla%2F5.0%20%28Windows%20NT%2010.0%3B%20Win64%3B%20x64%29"),
            "el user_agent debe ir codificado: {url}"
        );
        assert!(!url.contains(' '), "una URL con espacios da HTTP 400");
        assert!(!url.contains('('), "los parentesis crudos dan HTTP 400");
    }

    #[test]
    fn codifica_porcentual_estricta() {
        assert_eq!(pct("Mozilla"), "Mozilla");
        assert_eq!(pct("5.0 (Windows)"), "5.0%20%28Windows%29");
        assert_eq!(pct("a/b"), "a%2Fb");
    }

    #[test]
    fn la_url_del_ws_codifica_route_params_y_duplica_version_code() {
        let mut envelope = ProtoMessageFetchResult::default();
        envelope.push_server = "wss://example.test/webcast/im/ws/".into();
        envelope.cursor = "1789625530246_1_1_1_0_0".into();
        envelope.route_params.insert(
            "user_agent".into(),
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64)".into(),
        );

        let url = build_ws_url(&envelope, "7686341765710269205", &ProviderConfig::default())
            .expect("url construida");

        assert!(url.starts_with("wss://example.test/webcast/im/ws/?"));
        assert!(url.contains("user_agent=Mozilla%2F5.0%20%28Windows%20NT%2010.0%3B%20Win64%3B%20x64%29"));
        assert!(url.contains("room_id=7686341765710269205"));
        assert!(url.contains("compress=gzip"));
        assert!(url.contains("version_code=180800"));
        assert!(url.ends_with("&version_code=270000"));
        assert!(!url.contains(' '), "una URL con espacios da HTTP 400");
    }

    #[test]
    fn exige_push_server_y_cursor() {
        let envelope = ProtoMessageFetchResult::default();
        assert!(build_ws_url(&envelope, "1", &ProviderConfig::default()).is_err());
    }

    #[test]
    fn el_regalo_traduce_streak_y_grupo() {
        let message = WebcastGiftMessage {
            common: None,
            gift_id: 5655,
            repeat_count: 3,
            combo_count: 1,
            user: None,
            repeat_end: 0,
            group_id: 1789625806726,
            gift: Some(Gift {
                image: Some(ImageModel {
                    url_list: vec!["https://cdn.example/rose.png".into()],
                    uri: String::new(),
                    height: 0,
                    width: 0,
                }),
                describe: String::new(),
                duration: 0,
                id: 5655,
                combo: true,
                r#type: 1,
                diamond_count: 1,
                name: "Rose".into(),
            }),
        };

        let progreso = gift_info(&message);
        assert!(progreso.streakable, "type == 1 significa acumulable");
        assert!(!progreso.is_final, "repeat_end == 0 es progreso");
        assert_eq!(progreso.group_id, "1789625806726");
        assert_eq!(
            progreso.image_url, "https://cdn.example/rose.png",
            "el icono del regalo debe viajar al panel"
        );

        let final_ = gift_info(&WebcastGiftMessage {
            repeat_end: 1,
            ..message
        });
        assert!(final_.is_final, "repeat_end != 0 cierra el streak");
        assert_eq!(final_.group_id, "1789625806726", "mismo streak");
    }

    #[test]
    fn un_regalo_sin_metadatos_no_pierde_el_id() {
        let message = WebcastGiftMessage {
            common: None,
            gift_id: 999,
            repeat_count: 1,
            combo_count: 0,
            user: None,
            repeat_end: 1,
            group_id: 0,
            gift: None,
        };
        let info = gift_info(&message);
        assert_eq!(info.id, "999");
        assert_eq!(info.group_id, "0");
        assert!(!info.streakable);
    }

    #[test]
    fn los_viewers_se_colapsan_en_la_ventana() {
        let metrics = Arc::new(Metrics::default());
        let mut sink = EventSink::new(metrics.clone(), Duration::from_millis(500));

        sink.observe_viewers(100, 1000);
        sink.observe_viewers(101, 1001);
        sink.observe_viewers(102, 1002);

        assert_eq!(sink.len(), 1, "solo el primero entra en la ventana");
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.viewer_updates_emitted, 1);
        assert_eq!(snapshot.viewer_updates_coalesced, 2);
        assert_eq!(sink.latest_viewers(), Some((102, 1002)));
    }

    /// Regresion del fallo detectado en la primera conexion real: los frames se
    /// decodificaban, pero sus mensajes nunca llegaban al bus.
    ///
    /// Se comprueba contra una grabacion real de una sala en directo (132
    /// frames, incluido un streak completo), sin tocar la red.
    #[test]
    fn los_frames_grabados_producen_eventos() {
        use base64::Engine as _;

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../spikes/tiktok-rust-provider/live.jsonl"
        );
        let contenido = match std::fs::read_to_string(path) {
            Ok(contenido) => contenido,
            Err(error) => {
                // La grabacion vive fuera del crate; si no esta, no se falla.
                eprintln!("fixture no disponible ({path}): {error}");
                return;
            }
        };

        let metrics = Arc::new(Metrics::default());
        let mut sink = EventSink::new(metrics.clone(), Duration::from_millis(1000));
        let mut frames = 0usize;

        for (indice, linea) in contenido.lines().enumerate() {
            let Ok(valor) = serde_json::from_str::<serde_json::Value>(linea) else {
                continue;
            };
            let Some(b64) = valor.get("b64").and_then(|valor| valor.as_str()) else {
                continue;
            };
            let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                continue;
            };
            frames += 1;
            match decode_frame(&raw) {
                Ok((_ack, messages)) => {
                    for message in &messages {
                        translate_message(&message.method, &message.payload, &mut sink);
                    }
                }
                Err(error) => panic!("frame {} no decodificable: {error}", indice + 1),
            }
        }

        let eventos = sink.drain();
        let chats = eventos
            .iter()
            .filter(|(_, kind)| kind.name() == "chat.message")
            .count();
        let miembros = eventos
            .iter()
            .filter(|(_, kind)| kind.name() == "member.joined")
            .count();
        // Mensajes que son solo emote: sin el campo `emotes` no llegaban.
        let con_emotes = eventos
            .iter()
            .filter(|(_, kind)| match kind {
                EventKind::ChatMessage { emote_count, .. } => *emote_count > 0,
                _ => false,
            })
            .count();
        // Recuento por tipo: si TikTok anade algo, el fallo dice que llego.
        let mut por_tipo: std::collections::BTreeMap<&str, usize> =
            std::collections::BTreeMap::new();
        for (_, kind) in &eventos {
            *por_tipo.entry(kind.name()).or_insert(0) += 1;
        }
        let regalos: Vec<&GiftInfo> = eventos
            .iter()
            .filter_map(|(_, kind)| match kind {
                EventKind::GiftReceived { gift, .. } => Some(gift),
                _ => None,
            })
            .collect();

        assert!(frames >= 100, "se esperaban frames grabados, hay {frames}");
        assert!(chats > 0, "una sala en directo produce comentarios");
        assert!(
            miembros >= 50,
            "la grabacion medida trae 60 entradas en la sala, el mensaje mas \
             frecuente de TikTok; ahora llegan como member.joined: {por_tipo:?}"
        );
        assert!(
            con_emotes > 0,
            "y al menos un mensaje que es solo emote: {por_tipo:?}"
        );
        assert!(!regalos.is_empty(), "y regalos");
        assert!(
            regalos
                .iter()
                .any(|gift| gift.streakable && gift.group_id != "0"),
            "los regalos acumulables traen su group_id: {regalos:?}"
        );
        assert!(
            regalos.iter().any(|gift| gift.is_final),
            "y al menos uno cierra el streak"
        );
    }

    #[test]
    fn el_backoff_crece_y_se_limita() {
        let config = ProviderConfig {
            min_reconnect_delay: Duration::from_secs(30),
            max_reconnect_delay: Duration::from_secs(120),
            ..ProviderConfig::default()
        };
        let first = next_delay(Duration::from_secs(30), &config);
        assert!(first >= Duration::from_secs(24) && first <= Duration::from_secs(72));
        let capped = next_delay(Duration::from_secs(600), &config);
        assert!(capped <= Duration::from_secs(144), "el tope es 120 s con jitter");
    }

    #[test]
    fn el_ack_reutiliza_log_id_y_payload() {
        let frame = WebcastPushFrame {
            seq_id: 7,
            log_id: 42,
            service: 0,
            method: 0,
            headers: vec![PushHeader {
                key: "compress_type".into(),
                value: "none".into(),
            }],
            payload_encoding: String::new(),
            payload_type: "msg".into(),
            payload: Vec::new(),
        };
        assert_eq!(frame.compress_type(), Some("none"));
        assert_eq!(frame.log_id, 42);
    }

    /// La sala no recibe eventos si no se pide la entrada (D9), y los tags de v3
    /// no son los de los `.proto` que circulan: `live_region` ocupa el 3 y
    /// empuja `live_id` al 4.
    #[test]
    fn la_peticion_de_entrada_usa_los_tags_de_v3() {
        let peticion = WebcastImEnterRoomMessage {
            room_id: 7686403026103585554,
            live_id: 12,
            identity: "audience".into(),
            filter_welcome_msg: "0".into(),
            ..Default::default()
        };
        let bytes = peticion.encode_to_vec();
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();

        // tag 1 (varint) = room_id
        assert!(hex.starts_with("08"), "room_id debe abrir el mensaje: {hex}");
        // tag 4 = live_id = 12  -> clave 0x20, valor 0x0c
        assert!(hex.contains("200c"), "live_id va en el tag 4: {hex}");
        // tag 5 = identity -> clave 0x2a, largo 8, "audience"
        assert!(
            hex.contains("2a0861756469656e6365"),
            "identity va en el tag 5: {hex}"
        );
        // tag 9 = filter_welcome_msg -> clave 0x4a, largo 1, "0"
        assert!(hex.contains("4a0130"), "filter_welcome_msg va en el tag 9: {hex}");
        // El tag 3 es una cadena (live_region), nunca un varint: 0x18 = tag 3 varint.
        assert!(!hex.contains("18"), "el tag 3 es live_region (string): {hex}");
    }

    /// El latido lleva sala y contador; con payload vacio el servidor puede
    /// ignorarlo y cerrar la conexion.
    #[test]
    fn el_latido_lleva_sala_y_contador() {
        let latido = HeartBeatMessage {
            room_id: 5,
            send_packet_seq_id: 9,
        }
        .encode_to_vec();
        assert_eq!(latido, vec![0x08, 0x05, 0x10, 0x09]);
    }
}
