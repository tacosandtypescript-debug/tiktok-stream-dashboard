//! Gestor de TTS: une el bus de eventos con los filtros, la cola, el sidecar de
//! sintesis y el reproductor.
//!
//! Es el unico punto donde se decide **que** se lee, **cuando** y **con que
//! prioridad** (docs/decisions.md D3). Los modulos que ya existian siguen sin
//! saber nada unos de otros: `filters` no conoce la cola, la cola no conoce el
//! sidecar y el reproductor no conoce los eventos.
//!
//! Decisiones que no son obvias:
//!
//!   * **un unico bucle** de sintesis y reproduccion, en una tarea propia que se
//!     arranca de forma perezosa con `start()`. No hay temporizadores girando en
//!     vacio: el bucle espera a `tokio::sync::watch` (que se toca en cada cambio
//!     de estado capaz de producir trabajo) y, mientras algo suena o hay cola,
//!     se despierta cada 25 ms para vigilar el final de la reproduccion. Cuando
//!     no hay nada, duerme hasta el siguiente aviso: ni `busy loop` ni un `sleep`
//!     largo que retrase la primera frase.
//!   * la pausa **silencio el dispositivo** y ademas impide sacar nada de la
//!     cola; si no, la cola se vaciaria sin oirse y "reanudar" no tendria nada
//!     que leer.
//!   * "saltar" corta el sonido **y** descarta la frase en curso. Dejar el
//!     reproductor marcado como detenido haria que la frase siguiente tampoco
//!     sonase.
//!   * nada crece sin limite: la cola tiene tope, los mensajes recordados para
//!     deduplicar tienen tope y la lista de usuarios silenciados tambien. Un
//!     chat inundado no puede comerse la memoria.
//!   * la deduplicacion usa el texto **normalizado** por el pipeline (no el
//!     original) y se registra aunque la frase no llegue a leerse. Si se
//!     registrara solo al encolar, el mismo mensaje reenviado por el bus tras un
//!     descarte por cooldown acabaria leyendose al tercer intento.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::core::event::{Event, EventKind};
use crate::core::EventBus;

use super::filters::{FilterConfig, FilterOutcome, Filters, RejectReason};
use super::player::AudioSink;
use super::provider::{SharedTtsProvider, TtsCancellation, TtsRequest};
use super::queue::{priority, PushOutcome, TtsItem, TtsPreview, TtsQueue, TtsSource};
use super::voices::{self, Language};
use super::{chat_line, voice_for};

/// Capacidad del bus si el gestor tuviera que crear uno.
const BUS_CAPACITY: usize = 4096;

/// Memoria de mensajes ya vistos, aparte de la que guardan los filtros: aqui la
/// clave es (usuario, texto) y ademas el `source_id` de TikTok.
const SEEN_CAPACITY: usize = 4096;

/// Ventana temporal de esa memoria: pasado este plazo, el mismo texto del mismo
/// usuario se puede volver a leer.
///
/// Es una constante propia y **no** `FilterConfig::duplicate_window` a proposito:
/// lo que evita esta memoria es que el mismo evento reenviado por el bus se lea
/// dos veces, y esa garantia no puede depender de un ajuste de usuario (el
/// pipeline si permite poner la ventana a cero para desactivar su deduplicacion
/// por texto). El valor es el mismo que el del filtro por defecto, 30 s; sin
/// ventana, un mensaje repetido quedaba silenciado para siempre mientras cupiera
/// en la memoria.
const SEEN_WINDOW: Duration = Duration::from_secs(30);

/// Tope de usuarios silenciados: es una lista de trabajo, no un registro.
const MUTED_CAPACITY: usize = 1024;

/// Vigilancia del final de la reproduccion. Un valor pequeno gasta mas CPU; uno
/// grande deja un hueco audible entre frases. 25 ms es lo que usa cualquier
/// reproductor para no notar la costura.
const PLAYBACK_TICK: Duration = Duration::from_millis(25);

/// Espera cuando no hay absolutamente nada que hacer. El bucle se despierta
/// antes si algo cambia (nueva frase, pausa, salto): este plazo solo cubre lo
/// que no avisa por el canal.
const IDLE_TICK: Duration = Duration::from_millis(250);

/// Cada cuantas frases se poda la cache de sintesis en disco (F3).
///
/// La poda va atada a las frases atendidas y no a un temporizador a proposito:
/// el proyecto prohibe los bucles y temporizadores ociosos, y una sesion sin chat
/// no tiene por que despertar solo para mirar una carpeta. Con este valor, una
/// sala normal poda varias veces por hora y el coste (leer un directorio) queda
/// repartido.
const CACHE_PRUNE_EVERY: u64 = 100;

/// Configuracion del TTS tal como la ve la interfaz. Es el contrato que
/// persistira SQLite por perfil (docs/milestone-2.md §4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TtsSettings {
    pub enabled: bool,
    pub voice_es: String,
    pub voice_en: String,
    pub say_author: bool,
    pub volume: f32,
    pub rate: String,
    pub pitch: String,
    /// Nombre del dispositivo seleccionado. `None` usa el predeterminado del
    /// sistema.
    pub audio_device: Option<String>,
    /// Leer en voz alta los regalos que cierran su racha.
    pub read_gifts: bool,
    /// Leer los follows. Apagado por defecto: una sala media genera decenas por
    /// hora y taparian el chat.
    pub read_follows: bool,
    pub filters: FilterConfig,
    pub queue_capacity: usize,
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            voice_es: voices::DEFAULT_VOICE.to_string(),
            voice_en: "en-US-AriaNeural".to_string(),
            say_author: true,
            volume: 1.0,
            rate: "+0%".to_string(),
            pitch: "+0Hz".to_string(),
            audio_device: None,
            read_gifts: true,
            read_follows: false,
            filters: FilterConfig::default(),
            queue_capacity: 32,
        }
    }
}

/// Frase que suena ahora mismo.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TtsNowPlaying {
    pub id: u64,
    pub user: String,
    pub text: String,
    pub priority: i32,
}

/// Estado del TTS para la pagina del interfaz. Los contadores viven aqui y no
/// en `core::metrics` a proposito: son de este modulo y no deben obligar a
/// tocar el nucleo de metricas cada vez que se anade uno.
#[derive(Debug, Clone, Serialize)]
pub struct TtsStatus {
    pub enabled: bool,
    pub paused: bool,
    /// Ajustes actuales, para que la interfaz pueda mostrar el volumen, el ritmo
    /// y las voces que estan en uso de verdad (no los que cree recordar).
    pub settings: TtsSettings,
    pub playing: Option<TtsNowPlaying>,
    pub queued: Vec<TtsPreview>,
    pub queued_len: usize,
    pub played: u64,
    pub dropped: u64,
    pub from_cache: u64,
    pub synthesized: u64,
    pub synth_failures: u64,
    pub muted_users: usize,
    /// Descartes por motivo, de mayor a menor. El streamer tiene que poder ver
    /// por que no se lee el chat (docs/plan-review.md §P1-7).
    pub rejections: Vec<(&'static str, u64)>,
    /// Motivo por el que el TTS esta degradado (sin audio o sin sidecar), si lo
    /// esta. Se muestra de forma visible: el streamer debe saberlo antes que el
    /// chat (docs/decisions.md D3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degraded: Option<String>,
    /// Clase del estado degradado: evita confundir un dispositivo de audio
    /// ausente con un proveedor de sintesis caido.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degraded_kind: Option<&'static str>,
    /// Ultimo fallo del proveedor, limpiado al recuperar una sintesis.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_degraded: Option<String>,
    /// Fallo actual de la salida de audio.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_degraded: Option<String>,
    /// Nombre real del dispositivo activo; `None` indica el sink de reserva.
    pub audio_device: Option<String>,
}

/// Contadores propios del gestor.
#[derive(Debug, Default)]
struct Counters {
    played: u64,
    from_cache: u64,
    synthesized: u64,
    synth_failures: u64,
    /// Descartes que no produce el pipeline de filtros: limite global de lectura
    /// y cola llena.
    rejections: HashMap<&'static str, u64>,
}

/// Memoria acotada de mensajes ya vistos.
///
/// La memoria esta acotada por **dos** sitios: la capacidad (`SEEN_CAPACITY`,
/// para que un chat inundado no se coma la RAM) y la ventana temporal
/// (`SEEN_WINDOW`, para que repetir un mensaje util no quede silenciado para
/// siempre).
#[derive(Default)]
struct Seen {
    content: HashMap<(String, String), Instant>,
    order_content: VecDeque<(String, String)>,
    sources: HashMap<String, Instant>,
    order_sources: VecDeque<String>,
}

/// `true` si la marca `seen` sigue dentro de la ventana de deduplicacion.
///
/// `duration_since` satura en cero si la marca es posterior a `now` (no puede
/// pasar con `Instant`, pero de ser asi contaria como reciente: ante la duda, no
/// repetir el mensaje).
fn seen_recently(seen: Instant, now: Instant) -> bool {
    now.duration_since(seen) <= SEEN_WINDOW
}

impl Seen {
    /// `true` si este mensaje ya se ha visto **dentro de la ventana**.
    fn contains(&self, user_id: &str, text: &str, source_id: Option<&str>, now: Instant) -> bool {
        if let Some(source_id) = source_id {
            if self
                .sources
                .get(source_id)
                .is_some_and(|seen| seen_recently(*seen, now))
            {
                return true;
            }
        }
        self.content
            .get(&(user_id.to_string(), text.to_string()))
            .is_some_and(|seen| seen_recently(*seen, now))
    }

    fn remember(&mut self, user_id: &str, text: &str, source_id: Option<&str>, now: Instant) {
        let key = (user_id.to_string(), text.to_string());
        match self.content.get_mut(&key) {
            // Ya estaba (repetido dentro de la ventana): se refresca la marca sin
            // volver a apuntarla en el orden de desalojo, porque un duplicado
            // expulsaria antes a otra entrada.
            Some(seen) => *seen = now,
            None => {
                if self.order_content.len() >= SEEN_CAPACITY {
                    if let Some(oldest) = self.order_content.pop_front() {
                        self.content.remove(&oldest);
                    }
                }
                self.order_content.push_back(key.clone());
                self.content.insert(key, now);
            }
        }
        if let Some(source_id) = source_id {
            match self.sources.get_mut(source_id) {
                Some(seen) => *seen = now,
                None => {
                    if self.order_sources.len() >= SEEN_CAPACITY {
                        if let Some(oldest) = self.order_sources.pop_front() {
                            self.sources.remove(&oldest);
                        }
                    }
                    self.order_sources.push_back(source_id.to_string());
                    self.sources.insert(source_id.to_string(), now);
                }
            }
        }
    }
}

/// Lo que el bucle debe hacer con la frase que ha sacado de la cola.
#[derive(Debug, PartialEq, Eq)]
enum Dispatch {
    Played,
    Skipped,
    Failed,
}

/// `true` si toca podar la cache con este contador de frases.
///
/// Es una funcion pura a proposito: la politica (frases, no reloj) se puede
/// fijar en un test sin esperar a nada ni arrancar el gestor.
fn prune_due(played: u64, every: u64) -> bool {
    every > 0 && played > 0 && played.is_multiple_of(every)
}

pub struct TtsManager {
    settings: RwLock<TtsSettings>,
    filters: Mutex<Filters>,
    queue: Mutex<TtsQueue>,
    playing: Mutex<Option<TtsNowPlaying>>,
    counters: Mutex<Counters>,
    seen: Mutex<Seen>,
    muted: Mutex<HashSet<String>>,
    paused: Mutex<bool>,
    provider: SharedTtsProvider,
    /// Se clona en `consumer_future`; el propio gestor publica avisos de
    /// diagnostico en el.
    bus: Arc<EventBus>,
    sink: RwLock<Arc<dyn AudioSink>>,
    /// Estado efectivo, separado del dispositivo solicitado en los ajustes.
    audio_device: RwLock<Option<String>>,
    /// Cambio de estado que puede producir trabajo. El bucle lo espera: es lo
    /// que sustituye a sondear la cola.
    wake_tx: watch::Sender<u64>,
    /// El receptor del bucle. Vive aqui, no suelto, para que `start()` pueda
    /// tomarlo una sola vez sin un `Mutex<Option<...>>` en medio.
    wake_rx: Mutex<Option<watch::Receiver<u64>>>,
    /// Serializa `start()`: dos llamadas simultaneas no pueden crear dos bucles.
    started: Mutex<bool>,
    loop_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Cancelacion de la síntesis que el bucle esta esperando, si la hay.
    current_cancel: Mutex<Option<TtsCancellation>>,
    /// Estado del proveedor separado del fallo de dispositivo de audio.
    provider_degraded: Mutex<Option<String>>,
    /// Fallo de reproducción detectado en el camino caliente. El error de
    /// apertura inicial sigue viniendo de `AudioSink::last_error()`.
    audio_degraded: Mutex<Option<String>>,
}

impl TtsManager {
    pub fn new(
        settings: TtsSettings,
        provider: SharedTtsProvider,
        bus: Arc<EventBus>,
        sink: Arc<dyn AudioSink>,
    ) -> Self {
        let queue_capacity = settings.queue_capacity.max(2);
        let filters = Filters::new(settings.filters.clone(), Instant::now());
        let (wake_tx, wake_rx) = watch::channel(0u64);
        let volume = settings.volume;
        let audio_device = sink.device_name();
        let audio_error = sink.last_error();

        let manager = Self {
            settings: RwLock::new(settings),
            filters: Mutex::new(filters),
            queue: Mutex::new(TtsQueue::new(queue_capacity)),
            playing: Mutex::new(None),
            counters: Mutex::new(Counters::default()),
            seen: Mutex::new(Seen::default()),
            muted: Mutex::new(HashSet::new()),
            paused: Mutex::new(false),
            provider,
            bus,
            sink: RwLock::new(sink),
            audio_device: RwLock::new(audio_device),
            wake_tx,
            wake_rx: Mutex::new(Some(wake_rx)),
            started: Mutex::new(false),
            loop_task: Mutex::new(None),
            current_cancel: Mutex::new(None),
            provider_degraded: Mutex::new(None),
            audio_degraded: Mutex::new(audio_error),
        };
        // El volumen del dispositivo no es un detalle de cada frase: se aplica
        // una vez y sobrevive a todas las reproducciones.
        manager.sink().set_volume(volume);
        manager
    }

    /// Capacidad del bus que se usa si no se pasa uno.
    pub fn bus_capacity() -> usize {
        BUS_CAPACITY
    }

    // -----------------------------------------------------------------------
    // Suscripcion al bus
    // -----------------------------------------------------------------------

    /// Futuro del consumidor: escucha el bus y alimenta `handle_event`.
    ///
    /// Devuelve el futuro en lugar de lanzarlo a proposito, igual que
    /// `AppState::consumer_future`: el setup de Tauri corre **sin** runtime de
    /// Tokio y `tokio::spawn` ahi panica. Ademas la suscripcion se hace ya, no
    /// en el primer `poll`: el bus solo entrega a quien esta escuchando, y todo
    /// lo publicado entre el spawn y el primer `poll` se perderia.
    pub fn consumer_future(
        self: &Arc<Self>,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let manager = self.clone();
        let mut receiver = manager.bus.subscribe();
        async move {
            // El bucle de sintesis arranca aqui: es el primer punto donde hay
            // runtime garantizado.
            manager.start();
            loop {
                match receiver.recv().await {
                    Ok(event) => manager.handle_event(&event),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "el consumidor de TTS va por detras");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    /// Publica un aviso de diagnostico del propio TTS (degradado, sin audio).
    fn notify(&self, detail: &str) {
        self.bus.publish(
            None,
            EventKind::ProviderStatus {
                status: "tts".into(),
                detail: Some(detail.to_string()),
            },
        );
    }

    /// Publica un evento **por el bus del gestor**.
    ///
    /// Existe para que el resto de la aplicacion (y los tests) puedan inyectar
    /// eventos sin conocer el bus: el gestor es el dueno de su suscripcion.
    pub fn publish(&self, source_id: Option<String>, kind: EventKind) -> bool {
        self.bus.publish(source_id, kind)
    }

    // -----------------------------------------------------------------------
    // Entrada de eventos
    // -----------------------------------------------------------------------

    /// Decide si un evento se lee y, si procede, lo encola.
    ///
    /// Requiere que el bucle este arrancado (`start()`), que es lo que hace
    /// `consumer_future` por el llamante.
    pub fn handle_event(&self, event: &Event) {
        if !self.enabled() {
            // Desactivado no se gasta ni una sintesis: el proveedor no se toca.
            self.count_rejection(RejectReason::Disabled.as_str());
            return;
        }

        let Some((text, priority, source)) = self.wants(&event.kind) else {
            return;
        };

        // Sin contenido no hay nada que decir. Se comprueba sobre el texto de
        // origen (no sobre la linea compuesta) para que "Nick dice:" no cuente
        // como contenido.
        let trimmed = text.trim();
        if trimmed.is_empty() {
            self.count_rejection(RejectReason::Empty.as_str());
            return;
        }

        let (user_id, nickname) = user_of(&event.kind);

        if self.is_muted(&user_id) {
            self.count_rejection(RejectReason::BlockedUser.as_str());
            return;
        }

        let now = Instant::now();
        // El chat pasa por el pipeline de contenido (palabras, enlaces, spam,
        // longitud, cooldown por usuario). Un aviso de regalo o de follow ya
        // viene compuesto y no es spam: solo gasta cupo global, porque si no el
        // cooldown de 20 s o el minimo de caracteres lo descartarian casi siempre.
        let accepted = if source == TtsSource::Chat {
            let outcome = {
                let mut filters = self.lock_filters();
                filters.evaluate(&user_id, trimmed, now)
            };
            match outcome {
                FilterOutcome::Accept { text } => text,
                FilterOutcome::Reject(reason) => {
                    self.count_rejection(reason.as_str());
                    return;
                }
            }
        } else {
            trimmed.to_string()
        };

        // Deduplicacion propia, previa al compromiso (token y cooldown): asi el
        // mismo mensaje reenviado por el bus no gasta cuota global ni relee. La
        // memoria caduca por capacidad y por tiempo (ver `SEEN_WINDOW`).
        {
            let normalized = accepted.to_lowercase();
            let mut seen = self.lock_seen();
            if seen.contains(&user_id, &normalized, event.source_id.as_deref(), now) {
                seen.remember(&user_id, &normalized, event.source_id.as_deref(), now);
                drop(seen);
                self.count_rejection(RejectReason::Duplicate.as_str());
                return;
            }
            seen.remember(&user_id, &normalized, event.source_id.as_deref(), now);
        }

        // Admision final: cupo global + registro del cooldown y del mensaje
        // reciente. Se hace **despues** de la deduplicacion para que un mensaje
        // reenviado por el bus no gaste cuota de lectura. El descarte por cupo
        // lo cuenta el propio filtro, en el unico sitio donde ocurre.
        {
            let mut filters = self.lock_filters();
            let admitted = if source == TtsSource::Chat {
                filters.admit(&user_id, &accepted, now)
            } else {
                filters.admit_announcement(now)
            };
            if !admitted {
                return;
            }
        }

        // El chat se compone aqui (el autor depende del ajuste); los avisos de
        // regalo y follow ya vienen compuestos por `wants`. Se clona porque el
        // texto de origen sigue haciendo falta para elegir la voz.
        let line = if source == TtsSource::Chat {
            chat_line(&nickname, &accepted, self.say_author())
        } else {
            accepted.clone()
        };
        let (voice_es, voice_en) = self.voices();
        let item = TtsItem {
            id: 0,
            user_id,
            text: line,
            voice: voice_for(&accepted, &voice_es, &voice_en),
            priority,
            source,
            queued_at: Instant::now(),
        };

        let (outcome, id) = {
            let mut queue = self.lock_queue();
            let id = queue.next_id();
            let item = TtsItem { id, ..item };
            let outcome = queue.push(item, Instant::now());
            (outcome, id)
        };

        match outcome {
            PushOutcome::Queued { .. } => {
                tracing::debug!(id, priority, "frase encolada");
                self.wake();
            }
            PushOutcome::Rejected(reason) => {
                self.count_rejection(reason.as_str());
            }
        }
    }

    /// Que eventos se leen. Devuelve el texto **ya compuesto** que se dice, la
    /// prioridad y la fuente.
    ///
    /// Es el **unico** punto donde se decide que se lee. Anadir un evento nuevo
    /// (una suscripcion, un share, un aviso de OBS) es anadir un brazo aqui y su
    /// plantilla en `tts::mod`: nada mas del gestor cambia.
    pub fn wants(&self, kind: &EventKind) -> Option<(String, i32, TtsSource)> {
        let (read_gifts, read_follows) = self.announcements();
        match kind {
            EventKind::ChatMessage { content, .. } => {
                Some((content.clone(), priority::CHAT, TtsSource::Chat))
            }
            // Solo se lee el evento que **cierra** la racha: los intermedios son
            // acumulativos y anunciarlos todos convertiria una racha de 50 en 50
            // frases (misma regla que la contabilidad de `feed.rs`).
            EventKind::GiftReceived { user, gift } if read_gifts && gift.commits() => Some((
                super::gift_line(&user.nickname, gift),
                priority::for_gift(gift.diamonds()),
                TtsSource::Gift,
            )),
            EventKind::FollowReceived { user } if read_follows => Some((
                super::follow_line(&user.nickname),
                priority::FOLLOWER,
                TtsSource::Follow,
            )),
            _ => None,
        }
    }

    /// Interruptores de los avisos que no son chat.
    fn announcements(&self) -> (bool, bool) {
        let settings = self.settings.read().unwrap_or_else(|e| e.into_inner());
        (settings.read_gifts, settings.read_follows)
    }

    // -----------------------------------------------------------------------
    // Ajustes
    // -----------------------------------------------------------------------

    pub fn set_enabled(&self, enabled: bool) {
        {
            let mut settings = self.write_settings();
            settings.enabled = enabled;
        }
        self.lock_filters().set_enabled(enabled);
        if !enabled {
            // Desactivar debe notarse ya: lo encolado se descarta y se corta el
            // audio, sin esperar a que termine la frase en curso.
            self.cancel_current_synthesis();
            self.clear();
            self.sink().stop();
            self.set_playing(None);
        }
        self.wake();
    }

    pub fn set_volume(&self, volume: f32) {
        let volume = super::player::clamp_volume(volume);
        self.write_settings().volume = volume;
        self.sink().set_volume(volume);
    }

    pub fn set_rate(&self, rate: &str) {
        self.write_settings().rate = rate.to_string();
    }

    pub fn set_pitch(&self, pitch: &str) {
        self.write_settings().pitch = pitch.to_string();
    }

    /// Interruptores de los avisos que no son chat (regalos, follows). Se
    /// aplican en `wants`, asi que valen tanto para lo que llega despues como
    /// para lo que ya estaba en la cola.
    pub fn set_read_gifts(&self, value: bool) {
        self.write_settings().read_gifts = value;
    }

    pub fn set_read_follows(&self, value: bool) {
        self.write_settings().read_follows = value;
    }

    pub fn set_voice(&self, language: Language, voice: &str) {
        let mut settings = self.write_settings();
        match language {
            Language::Es => settings.voice_es = voice.to_string(),
            Language::En => settings.voice_en = voice.to_string(),
        }
    }

    pub fn set_say_author(&self, value: bool) {
        self.write_settings().say_author = value;
    }

    /// Abre primero el nuevo dispositivo y solo entonces corta y sustituye el
    /// anterior. Si la apertura falla, el sink vigente sigue funcionando y el
    /// error queda visible en `TtsStatus`.
    pub fn select_device(&self, device: Option<&str>) -> anyhow::Result<String> {
        let requested = device.map(str::trim).filter(|name| !name.is_empty());
        let replacement = match super::player::RodioSink::with_device(requested) {
            Ok(replacement) => replacement,
            Err(error) => {
                let detail = format!("no se pudo seleccionar el dispositivo: {error:#}");
                *self
                    .audio_degraded
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(detail.clone());
                self.notify(&detail);
                return Err(anyhow::anyhow!(detail));
            }
        };
        let name = replacement.device().to_string();
        let volume = self
            .settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .volume;
        replacement.set_volume(volume);

        let replacement: Arc<dyn AudioSink> = Arc::new(replacement);
        let previous = {
            let mut current = self.sink.write().unwrap_or_else(|e| e.into_inner());
            std::mem::replace(&mut *current, replacement)
        };
        previous.stop();
        *self.audio_device.write().unwrap_or_else(|e| e.into_inner()) = Some(name.clone());
        *self
            .audio_degraded
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        {
            let mut settings = self.write_settings();
            settings.audio_device = requested.map(str::to_string);
        }
        self.wake();
        tracing::info!(device = %name, "salida de audio cambiada");
        Ok(name)
    }

    // -----------------------------------------------------------------------
    // Control
    // -----------------------------------------------------------------------

    /// Pausa el TTS: silencia lo que suena y deja de sacar frases de la cola.
    pub fn pause(&self) {
        *self.lock_paused() = true;
        self.cancel_current_synthesis();
        // Silenciar de inmediato: una pausa que sigue sonando no es una pausa.
        self.sink().stop();
        self.set_playing(None);
        self.wake();
    }

    pub fn resume(&self) {
        *self.lock_paused() = false;
        self.wake();
    }

    /// "Saltar": corta la frase en curso y la descarta.
    pub fn skip(&self) {
        self.cancel_current_synthesis();
        self.sink().stop();
        self.set_playing(None);
        self.wake();
    }

    /// Vacia la cola. No corta lo que esta sonando: para eso esta `skip`.
    pub fn clear(&self) {
        let removed = self.lock_queue().clear();
        if removed > 0 {
            tracing::debug!(removed, "cola de TTS vaciada");
        }
        self.wake();
    }

    /// Quita una frase concreta de la cola.
    pub fn remove(&self, id: u64) {
        if self.lock_queue().remove(id) {
            self.wake();
        }
    }

    /// Silencia a un usuario: no se lee lo que llegue, ni lo suyo ya encolado.
    pub fn mute_user(&self, user_id: &str) {
        {
            let mut muted = self.lock_muted();
            if muted.len() >= MUTED_CAPACITY && !muted.contains(user_id) {
                // La lista es de trabajo, no un registro historico. Si se llena
                // se avisa en lugar de crecer sin limite: quitar el silencio de
                // otra persona por la espalda seria peor que no admitir uno nuevo.
                tracing::warn!("lista de usuarios silenciados llena: {user_id} no se silencia");
                return;
            }
            muted.insert(user_id.to_string());
        }
        let removed = self.lock_queue().drop_user(user_id);
        if removed > 0 {
            tracing::debug!(removed, "frases descartadas del usuario silenciado");
        }
        self.wake();
    }

    pub fn unmute_user(&self, user_id: &str) {
        self.lock_muted().remove(user_id);
    }

    // -----------------------------------------------------------------------
    // Estado
    // -----------------------------------------------------------------------

    /// Estado completo para la pagina de TTS.
    pub fn status(&self) -> TtsStatus {
        let now = Instant::now();
        let settings = self.settings();
        let (queued, queued_len, dropped) = {
            let queue = self.lock_queue();
            (queue.preview(now, 50), queue.len(), queue.dropped())
        };
        let playing = self
            .playing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let paused = *self.lock_paused();
        let counters = self.counters.lock().unwrap_or_else(|e| e.into_inner());

        // Los descartes del pipeline y los propios se presentan juntos: para el
        // streamer son la misma pregunta ("por que no se lee esto"). Cada motivo
        // lo cuenta un solo sitio (el filtro o el gestor), asi que la suma no
        // duplica nada.
        let mut rejections: HashMap<&'static str, u64> =
            self.lock_filters().rejected_counts().into_iter().collect();
        for (reason, count) in &counters.rejections {
            *rejections.entry(reason).or_insert(0) += count;
        }
        let mut rejections: Vec<(&'static str, u64)> = rejections.into_iter().collect();
        rejections.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));

        let provider_degraded = self
            .provider_degraded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let audio_degraded = self
            .audio_degraded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .or_else(|| self.sink().last_error());
        let (degraded_kind, degraded) = match (&audio_degraded, &provider_degraded) {
            (Some(detail), _) => (Some("audio"), Some(detail.clone())),
            (None, Some(detail)) => (Some("provider"), Some(detail.clone())),
            (None, None) => (None, None),
        };

        TtsStatus {
            enabled: settings.enabled,
            paused,
            settings: settings.clone(),
            playing,
            queued,
            queued_len,
            played: counters.played,
            dropped,
            from_cache: counters.from_cache,
            synthesized: counters.synthesized,
            synth_failures: counters.synth_failures,
            muted_users: self.lock_muted().len(),
            rejections,
            degraded,
            degraded_kind,
            provider_degraded,
            audio_degraded,
            audio_device: self
                .audio_device
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        }
    }

    /// Ajustes actuales (copia: la interfaz nunca bloquea al gestor).
    pub fn settings(&self) -> TtsSettings {
        self.settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Capacidad de la cola, para que la interfaz pueda dibujar el nivel.
    pub fn queue_capacity(&self) -> usize {
        self.lock_queue().capacity()
    }

    // -----------------------------------------------------------------------
    // Bucle de sintesis y reproduccion
    // -----------------------------------------------------------------------

    /// Arranca el bucle. Es idempotente y perezoso: no hace nada si ya corre.
    ///
    /// Requiere `Arc<Self>` porque la tarea necesita una referencia con duracion
    /// `'static`, y exige un runtime de Tokio activo (igual que `tokio::spawn`).
    /// `new()` solo construye el gestor, de modo que se puede crear en el setup
    /// de Tauri, que corre fuera del runtime.
    pub fn start(self: &Arc<Self>) {
        {
            // El cerrojo se toma antes de comprobar la marca: dos llamadas
            // simultaneas no pueden crear dos bucles compitiendo por la cola.
            let mut started = self.started.lock().unwrap_or_else(|e| e.into_inner());
            if *started {
                return;
            }
            *started = true;
        }

        let Some(wake) = self
            .wake_rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        else {
            return;
        };

        let manager = self.clone();
        let task = tokio::spawn(async move {
            manager.run(wake).await;
        });
        *self.loop_task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
        tracing::info!("bucle de TTS arrancado");
    }

    /// Bucle unico de sintesis y reproduccion.
    ///
    /// Espera por `watch` en lugar de sondear: cada cambio de estado que pueda
    /// producir trabajo avisa por el canal, y el plazo solo existe para vigilar
    /// el final de lo que suena. Sin trabajo, no hay ciclo.
    async fn run(&self, mut wake: watch::Receiver<u64>) {
        // La cache de audio puede venir de sesiones anteriores y nadie mas la
        // vigila (el CLI solo poda en `--tts-test`), asi que la aplicacion la
        // poda al arrancar el bucle y luego cada `CACHE_PRUNE_EVERY` frases.
        self.prune_cache().await;
        loop {
            if self.enabled() && !*self.lock_paused() {
                let Some(item) = self.lock_queue().pop_next(Instant::now()) else {
                    // Nada que leer: espera indefinida hasta que alguien avise.
                    if wake.changed().await.is_err() {
                        break;
                    }
                    continue;
                };
                let outcome = self.dispatch(item).await;
                if outcome != Dispatch::Failed {
                    // La poda se decide por frases atendidas, no por reloj: asi no
                    // hay ningun temporizador girando en vacio.
                    self.prune_cache_when_due().await;
                }
                match outcome {
                    // Reproduciendo o esperando a que termine: vigilar de cerca.
                    Dispatch::Played => self.settle(&mut wake, PLAYBACK_TICK).await,
                    // Saltado o fallido: puede haber mas cola, sin esperas.
                    Dispatch::Skipped | Dispatch::Failed => continue,
                }
                continue;
            }
            // En pausa o desactivado: no se saca nada de la cola, pero se
            // atiende el aviso de reanudar.
            self.settle(&mut wake, IDLE_TICK).await;
        }
    }

    /// Espera `tick` o un aviso, lo que llegue antes.
    ///
    /// Si devuelve `false`, el emisor desaparecio: el gestor se esta apagando.
    async fn settle(&self, wake: &mut watch::Receiver<u64>, tick: Duration) {
        let _ = tokio::time::timeout(tick, wake.changed()).await;
    }

    /// Sintetiza y reproduce una frase. Devuelve que ha pasado con ella.
    async fn dispatch(&self, item: TtsItem) -> Dispatch {
        // La velocidad y el tono se leen **en el momento de sintetizar**, no
        // cuando se encolo: si el streamer los cambia mientras hay cola, lo que
        // suene despues ya sale con el ajuste nuevo.
        let (rate, pitch) = {
            let settings = self.settings.read().unwrap_or_else(|e| e.into_inner());
            (settings.rate.clone(), settings.pitch.clone())
        };
        let request = TtsRequest {
            id: item.id,
            text: item.text.clone(),
            voice: item.voice.clone(),
            rate,
            pitch,
        };
        let cancel = TtsCancellation::new();
        *self
            .current_cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());
        let audio = self
            .provider
            .synthesize_with_cancel(&request, cancel.clone())
            .await;
        self.clear_current_synthesis(&cancel);

        let audio = match audio {
            Ok(audio) => audio,
            Err(error) => {
                if cancel.is_cancelled() {
                    return Dispatch::Skipped;
                }
                // Sin sidecar no se cae nada: se cuenta y se sigue. Es el modo
                // degradado que exige docs/decisions.md D3.
                tracing::warn!(%error, id = item.id, "sintesis fallida");
                self.lock_counters().synth_failures += 1;
                *self
                    .provider_degraded
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(error.to_string());
                self.notify(&format!("sintesis fallida: {error}"));
                return Dispatch::Failed;
            }
        };

        // Una cancelacion concurrente puede haber ocurrido justo cuando el
        // proveedor devolvio el audio; no se debe publicar ni reproducir esa
        // frase despues de skip/pause.
        if cancel.is_cancelled() {
            return Dispatch::Skipped;
        }
        *self
            .provider_degraded
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;

        {
            let mut counters = self.lock_counters();
            if audio.cached {
                counters.from_cache += 1;
            } else {
                counters.synthesized += 1;
            }
        }

        self.set_playing(Some(TtsNowPlaying {
            id: item.id,
            user: item.user_id.clone(),
            text: item.text.clone(),
            priority: item.priority,
        }));
        tracing::debug!(id = item.id, bytes = audio.bytes, "leyendo frase");

        let volume = self
            .settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .volume;
        // El read lock cubre la llamada a `play`: una seleccion concurrente no
        // puede sustituir el sink entre tomar la referencia y encolar el audio.
        // Si la seleccion ocurre justo despues, detiene este sink viejo antes
        // de que se publique la siguiente frase.
        let sink = {
            let current = self.sink.read().unwrap_or_else(|e| e.into_inner());
            let sink = current.clone();
            if let Err(error) = sink.play(&audio.path, volume) {
                tracing::warn!(%error, id = item.id, "no se pudo reproducir");
                self.lock_counters().synth_failures += 1;
                *self
                    .audio_degraded
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(error.to_string());
                self.set_playing(None);
                return Dispatch::Failed;
            }
            sink
        };
        if sink.last_error().is_none() {
            *self
                .audio_degraded
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
        }
        self.lock_counters().played += 1;

        // Se espera de verdad al final del audio: si no, el bucle sacaria la
        // frase siguiente y se solaparian.
        //
        // La espera **no** corre en el worker del runtime: `wait` es sincrona y
        // dura lo que la locucion (hasta 30 s), asi que dejaba un hilo de Tokio
        // secuestrado por frase. Va a la piscina de bloqueo, que es el sitio
        // previsto para esperas de este tipo; el bucle, mientras tanto, sigue sin
        // sacar la frase siguiente hasta que esta termina o alguien la corta.
        if sink.is_playing() {
            let _ = tokio::task::spawn_blocking(move || sink.wait()).await;
        }
        if self.take_playing(item.id) {
            Dispatch::Played
        } else {
            // Mientras sonaba, alguien pulso "saltar" o "pausa".
            Dispatch::Skipped
        }
    }

    /// Poda la cache del proveedor si el contador de frases ha cruzado un
    /// multiplo. Se llama tras atender una frase.
    async fn prune_cache_when_due(&self) {
        let played = self.lock_counters().played;
        if !prune_due(played, CACHE_PRUNE_EVERY) {
            return;
        }
        self.prune_cache().await;
    }

    /// Poda la cache de sintesis en disco.
    ///
    /// Es E/S sobre cientos de ficheros, asi que no puede correr en el worker del
    /// runtime: el mismo motivo que la espera de `dispatch`, en pequeno.
    async fn prune_cache(&self) {
        let provider = self.provider.clone();
        match tokio::task::spawn_blocking(move || provider.prune_cache()).await {
            Ok(0) => {}
            Ok(removed) => tracing::info!(removed, "cache de TTS podada"),
            Err(error) => tracing::warn!(%error, "no se pudo podar la cache de TTS"),
        }
    }

    /// Despierta al bucle: algo ha cambiado en el estado.
    fn wake(&self) {
        // El contador es monotonico y solo se usa como "esto ha cambiado": al
        // `watch` le basta con que el valor sea distinto para despertar al
        // receptor.
        self.wake_tx
            .send_modify(|tick| *tick = tick.wrapping_add(1));
    }

    fn cancel_current_synthesis(&self) {
        if let Some(cancel) = self
            .current_cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .cloned()
        {
            cancel.cancel();
        }
    }

    fn clear_current_synthesis(&self, cancel: &TtsCancellation) {
        let mut current = self
            .current_cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if current
            .as_ref()
            .is_some_and(|active| active.is_same(cancel))
        {
            *current = None;
        }
    }

    fn set_playing(&self, playing: Option<TtsNowPlaying>) {
        *self.playing.lock().unwrap_or_else(|e| e.into_inner()) = playing;
    }

    /// Quita `playing` solo si sigue siendo la misma frase. Devuelve si lo era.
    ///
    /// La comparacion por id es lo que distingue "termino sola" de "la salto el
    /// usuario": sin ella, un salto seguido de la frase siguiente se confundiria.
    fn take_playing(&self, id: u64) -> bool {
        let mut playing = self.playing.lock().unwrap_or_else(|e| e.into_inner());
        if playing.as_ref().map(|current| current.id) == Some(id) {
            *playing = None;
            true
        } else {
            false
        }
    }

    // -----------------------------------------------------------------------
    // Cerrojos
    // -----------------------------------------------------------------------

    fn enabled(&self) -> bool {
        self.settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .enabled
    }

    fn sink(&self) -> Arc<dyn AudioSink> {
        self.sink.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn say_author(&self) -> bool {
        self.settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .say_author
    }

    fn voices(&self) -> (String, String) {
        let settings = self.settings.read().unwrap_or_else(|e| e.into_inner());
        (settings.voice_es.clone(), settings.voice_en.clone())
    }

    fn write_settings(&self) -> std::sync::RwLockWriteGuard<'_, TtsSettings> {
        self.settings.write().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_filters(&self) -> std::sync::MutexGuard<'_, Filters> {
        self.filters.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_queue(&self) -> std::sync::MutexGuard<'_, TtsQueue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_seen(&self) -> std::sync::MutexGuard<'_, Seen> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_muted(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.muted.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_paused(&self) -> std::sync::MutexGuard<'_, bool> {
        self.paused.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_counters(&self) -> std::sync::MutexGuard<'_, Counters> {
        self.counters.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn is_muted(&self, user_id: &str) -> bool {
        self.lock_muted().contains(user_id)
    }

    fn count_rejection(&self, reason: &'static str) {
        *self.lock_counters().rejections.entry(reason).or_insert(0) += 1;
    }

    /// Cierre ordenado: corta el audio, detiene el bucle y apaga el sidecar.
    pub async fn shutdown(&self) {
        self.cancel_current_synthesis();
        self.sink().stop();
        self.set_playing(None);
        let task = self
            .loop_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(task) = task {
            task.abort();
            // `abort` no espera a que la tarea pare; el `await` si. Ignorar el
            // resultado es correcto: una tarea abortada acaba en `Err`.
            let _ = task.await;
        }
        self.provider.shutdown().await;
        tracing::info!(from_cache = self.lock_counters().from_cache, "TTS detenido");
    }
}

/// Solo para tests: permite encolar una frase ya construida (por ejemplo la de
/// un regalo, que `wants` aun declara no legible) y comprobar el orden real de
/// lectura sin depender de que exista un evento con esa prioridad.
#[cfg(test)]
impl TtsManager {
    fn enqueue_for_test(&self, item: TtsItem) -> u64 {
        let (id, outcome) = {
            let mut queue = self.lock_queue();
            let id = queue.next_id();
            let item = TtsItem { id, ..item };
            let outcome = queue.push(item, Instant::now());
            (id, outcome)
        };
        match outcome {
            PushOutcome::Queued { .. } => {}
            PushOutcome::Rejected(reason) => self.count_rejection(reason.as_str()),
        }
        self.wake();
        id
    }
}

impl Drop for TtsManager {
    fn drop(&mut self) {
        self.cancel_current_synthesis();
        self.sink().stop();
        // Sin esto, la tarea del bucle seguiria viva hasta que se apagara el
        // runtime (los tests lo notarian).
        if let Some(task) = self
            .loop_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
    }
}

/// Usuario de un evento, si lo trae.
fn user_of(kind: &EventKind) -> (String, String) {
    match kind {
        EventKind::ChatMessage { user, .. } | EventKind::GiftReceived { user, .. } => {
            (user.id.clone(), user.nickname.clone())
        }
        EventKind::FollowReceived { user } => (user.id.clone(), user.nickname.clone()),
        _ => (String::new(), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::{GiftInfo, UserRef};
    use crate::core::Metrics;
    use crate::providers::BoxFuture;
    use crate::tts::player::NullSink;
    use crate::tts::provider::{TtsAudio, TtsProvider};
    use anyhow::Result;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Condvar;
    use tokio::sync::Notify;

    // -----------------------------------------------------------------------
    // Dobles de prueba
    // -----------------------------------------------------------------------

    /// Proveedor falso: escribe un fichero temporal y no toca la red.
    struct FakeProvider {
        synthesised: Mutex<Vec<String>>,
        /// Ajustes con los que se pidio cada sintesis, para poder comprobar que
        /// la velocidad y el tono de la interfaz llegan hasta el sintetizador.
        ajustes: Mutex<Vec<(String, String)>>,
        /// Veces que el gestor le ha pedido podar la cache.
        prunes: AtomicU64,
    }

    impl FakeProvider {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                synthesised: Mutex::new(Vec::new()),
                ajustes: Mutex::new(Vec::new()),
                prunes: AtomicU64::new(0),
            })
        }

        fn synthesised(&self) -> Vec<String> {
            self.synthesised
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }

        fn ajustes(&self) -> Vec<(String, String)> {
            self.ajustes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }

        /// Cuantas veces se ha podado (que el gestor lo pida es lo que se prueba:
        /// la poda en si la cubre el test de `provider`).
        fn prunes(&self) -> u64 {
            self.prunes.load(Ordering::Relaxed)
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
            self.synthesised.lock().unwrap_or_else(|e| e.into_inner())
        }
    }

    fn temp_file(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ttdash-manager-{}-{unique}-{tag}.mp3",
            std::process::id()
        ));
        // MP3 minimo pero no vacio: el reproductor descarta los ficheros de cero
        // bytes (sintoma de una sintesis interrumpida).
        let _ = std::fs::write(&path, [0xff, 0xf3, 0x00, 0x00]);
        path
    }

    impl TtsProvider for FakeProvider {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn synthesize<'a>(&'a self, request: &'a TtsRequest) -> BoxFuture<'a, Result<TtsAudio>> {
            Box::pin(async move {
                self.lock().push(request.text.clone());
                self.ajustes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((request.rate.clone(), request.pitch.clone()));
                Ok(TtsAudio {
                    path: temp_file("audio"),
                    bytes: 4,
                    ms: 0,
                    cached: false,
                })
            })
        }

        fn health<'a>(&'a self) -> BoxFuture<'a, bool> {
            Box::pin(async move { true })
        }

        fn available_voices<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>>> {
            Box::pin(async move { Ok(vec![voices::DEFAULT_VOICE.to_string()]) })
        }

        fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
            Box::pin(async move {})
        }

        /// El gestor es quien decide **cuando** se poda; aqui solo se cuenta.
        fn prune_cache(&self) -> usize {
            self.prunes.fetch_add(1, Ordering::Relaxed);
            1
        }
    }

    /// Provider que permanece en síntesis hasta que recibe la cancelación. Es
    /// deliberadamente independiente del sidecar: prueba el contrato del
    /// gestor y evita que un `sleep` haga pasar una cancelación falsa.
    struct CancelAwareProvider {
        started: AtomicU64,
        cancelled: AtomicU64,
        wake: Notify,
    }

    impl CancelAwareProvider {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                started: AtomicU64::new(0),
                cancelled: AtomicU64::new(0),
                wake: Notify::new(),
            })
        }
    }

    impl TtsProvider for CancelAwareProvider {
        fn name(&self) -> &'static str {
            "cancel-aware"
        }

        fn synthesize<'a>(&'a self, _: &'a TtsRequest) -> BoxFuture<'a, Result<TtsAudio>> {
            Box::pin(std::future::pending())
        }

        fn synthesize_with_cancel<'a>(
            &'a self,
            _: &'a TtsRequest,
            cancel: TtsCancellation,
        ) -> BoxFuture<'a, Result<TtsAudio>> {
            self.started.fetch_add(1, Ordering::Relaxed);
            self.wake.notify_waiters();
            Box::pin(async move {
                cancel.cancelled().await;
                self.cancelled.fetch_add(1, Ordering::Relaxed);
                anyhow::bail!("síntesis cancelada por la prueba")
            })
        }

        fn health<'a>(&'a self) -> BoxFuture<'a, bool> {
            Box::pin(async move { true })
        }

        fn available_voices<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>>> {
            Box::pin(async move { Ok(vec![]) })
        }

        fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
            Box::pin(async move {})
        }
    }

    struct BrokenAudioSink;

    impl AudioSink for BrokenAudioSink {
        fn play(&self, _: &Path, _: f32) -> anyhow::Result<()> {
            anyhow::bail!("dispositivo de prueba no disponible")
        }

        fn stop(&self) {}

        fn set_volume(&self, _: f32) {}

        fn is_playing(&self) -> bool {
            false
        }

        fn wait(&self) {}
    }

    /// Salida que ya ha "terminado" cuando `play` regresa.
    ///
    /// `NullSink` imita a `rodio` y se queda sonando hasta que alguien llama a
    /// `wait`; aqui interesa que el bucle de sintesis pueda encadenar frases sin
    /// depender de la duracion del audio falso.
    struct InstantSink {
        inner: NullSink,
    }

    impl InstantSink {
        fn new() -> Self {
            Self {
                inner: NullSink::new(),
            }
        }
    }

    impl AudioSink for InstantSink {
        fn play(&self, file: &Path, volume: f32) -> anyhow::Result<()> {
            self.inner.play(file, volume)
        }

        fn stop(&self) {
            self.inner.stop();
        }

        fn set_volume(&self, volume: f32) {
            self.inner.set_volume(volume);
        }

        fn is_playing(&self) -> bool {
            // El audio falso dura cero: nada que esperar.
            false
        }

        fn wait(&self) {}
    }

    /// Salida que imita a rodio **de verdad**: `play` deja la frase "sonando" y
    /// `wait` **bloquea** hasta que el test la libera o alguien la corta con
    /// `stop()`.
    ///
    /// Faltaba justo eso: los dobles anteriores devolvian `is_playing() == false`,
    /// asi que el gestor nunca esperaba y los fallos que solo se ven con una
    /// locucion en curso (un "saltar" que no corta, un volumen que no cambia a
    /// media frase) no aparecian en ningun test.
    ///
    /// Bloquear en `wait` (y no en `play`) es lo que imita a rodio: encolar es
    /// instantaneo y quien espera es el que pide el final del audio.
    struct RodioLikeSink {
        inner: NullSink,
        state: Mutex<RodioLikeState>,
        changed: Condvar,
    }

    #[derive(Default)]
    struct RodioLikeState {
        /// Hay una frase sonando.
        playing: bool,
        /// La locucion en curso ha terminado (la libera el test o un corte).
        finished: bool,
        /// Hay una espera bloqueada ahora mismo.
        waiting: bool,
        /// Esperas que termino un `stop()`.
        cuts: u64,
    }

    impl RodioLikeSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                inner: NullSink::new(),
                state: Mutex::new(RodioLikeState::default()),
                changed: Condvar::new(),
            })
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, RodioLikeState> {
            self.state.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// Libera la locucion en curso como si el audio hubiera llegado a su
        /// final.
        fn release(&self) {
            self.lock().finished = true;
            self.changed.notify_all();
        }

        /// `true` si ahora mismo hay una espera bloqueada.
        fn waiting(&self) -> bool {
            self.lock().waiting
        }

        /// Esperas que tuvieron que terminar porque alguien corto el audio.
        fn cut_waits(&self) -> u64 {
            self.lock().cuts
        }
    }

    impl AudioSink for RodioLikeSink {
        fn play(&self, file: &Path, volume: f32) -> anyhow::Result<()> {
            self.inner.play(file, volume)?;
            let mut state = self.lock();
            state.playing = true;
            state.finished = false;
            Ok(())
        }

        fn stop(&self) {
            self.inner.stop();
            let mut state = self.lock();
            if state.waiting {
                state.cuts += 1;
            }
            // Un corte termina la espera en curso igual que en rodio: la fuente
            // se descarta en el bloque de audio siguiente.
            state.playing = false;
            state.finished = true;
            drop(state);
            self.changed.notify_all();
        }

        fn set_volume(&self, volume: f32) {
            self.inner.set_volume(volume);
        }

        fn is_playing(&self) -> bool {
            self.lock().playing
        }

        fn wait(&self) {
            let mut state = self.lock();
            state.waiting = true;
            // El plazo evita que un test mal escrito deje el hilo de bloqueo
            // colgado para siempre.
            let deadline = Instant::now() + ESPERA_MAXIMA;
            while state.playing && !state.finished && Instant::now() < deadline {
                let (guard, _) = self
                    .changed
                    .wait_timeout(state, ESPERA_MAXIMA)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state = guard;
            }
            state.playing = false;
            state.waiting = false;
        }
    }

    /// Plazo maximo de una espera del doble `RodioLikeSink`.
    const ESPERA_MAXIMA: Duration = Duration::from_secs(2);

    // -----------------------------------------------------------------------
    // Utilidades
    // -----------------------------------------------------------------------

    fn user(id: &str) -> UserRef {
        UserRef {
            id: id.into(),
            unique_id: format!("u{id}"),
            nickname: format!("Nick {id}"),
        }
    }

    fn chat(seq: u64, id: &str, content: &str) -> Event {
        Event::new(
            seq,
            "sala".into(),
            Some(format!("msg-{seq}")),
            EventKind::ChatMessage {
                user: user(id),
                content: content.into(),
                emote_count: 0,
            },
        )
    }

    /// Mensaje sin `source_id`: es el caso real de un evento reconstruido y el
    /// que obliga a deduplicar por (usuario, texto).
    fn chat_without_id(seq: u64, id: &str, content: &str) -> Event {
        Event::new(
            seq,
            "sala".into(),
            None,
            EventKind::ChatMessage {
                user: user(id),
                content: content.into(),
                emote_count: 0,
            },
        )
    }

    fn gift(seq: u64, id: &str, diamonds: i32) -> Event {
        Event::new(
            seq,
            "sala".into(),
            Some(format!("gift-{seq}")),
            EventKind::GiftReceived {
                user: user(id),
                // Constructor y no literal: anadir campos a `GiftInfo` (como el
                // icono) no debe obligar a tocar cada test.
                gift: GiftInfo::new("5655", "Rose", diamonds, true, 1, true, "1"),
            },
        )
    }

    /// Ajustes de prueba: sin cooldowns, para encadenar varias frases del mismo
    /// usuario sin esperar 20 s ni agotar el token bucket global.
    fn settings() -> TtsSettings {
        let mut settings = TtsSettings::default();
        settings.filters.user_cooldown = Duration::ZERO;
        settings.filters.duplicate_window = Duration::ZERO;
        settings.filters.spam_window = Duration::ZERO;
        settings.filters.global_interval = Duration::from_millis(1);
        settings.filters.global_burst = 10_000;
        settings.queue_capacity = 32;
        settings
    }

    struct Harness {
        manager: Arc<TtsManager>,
        provider: Arc<FakeProvider>,
        sink: Arc<InstantSink>,
    }

    /// Gestor con un sink cualquiera: monta el bus, el proveedor y el gestor sin
    /// duplicar la construccion en cada test que necesita un doble distinto.
    fn manager_with(
        settings: TtsSettings,
        sink: Arc<dyn AudioSink>,
    ) -> (Arc<TtsManager>, Arc<FakeProvider>) {
        let metrics = Arc::new(Metrics::default());
        let bus = Arc::new(EventBus::new(64, metrics));
        let provider = FakeProvider::new();
        let manager = Arc::new(TtsManager::new(
            settings,
            provider.clone() as SharedTtsProvider,
            bus,
            sink,
        ));
        (manager, provider)
    }

    fn harness(settings: TtsSettings) -> Harness {
        let sink = Arc::new(InstantSink::new());
        let (manager, provider) = manager_with(settings, sink.clone() as Arc<dyn AudioSink>);
        Harness {
            manager,
            provider,
            sink,
        }
    }

    /// Espera a que se cumpla una condicion. Los plazos son generosos a
    /// proposito: en la suite completa hay otros tests compitiendo por los hilos.
    async fn wait_for(mut condition: impl FnMut() -> bool) -> bool {
        for _ in 0..400 {
            if condition() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn desactivado_no_sintetiza_nada() {
        let mut settings = settings();
        settings.enabled = false;
        let h = harness(settings);
        h.manager.start();

        h.manager.handle_event(&chat(1, "1", "hola a todos"));
        tokio::time::sleep(Duration::from_millis(50)).await;

        let status = h.manager.status();
        assert!(!status.enabled);
        assert!(h.provider.synthesised().is_empty(), "no se pidio sintesis");
        assert_eq!(status.synthesized, 0);
        assert_eq!(status.played, 0);
        assert_eq!(status.playing, None);
        assert_eq!(status.queued_len, 0);

        // Al reactivar, vuelve a leerse.
        h.manager.set_enabled(true);
        h.manager.handle_event(&chat(2, "1", "ya estamos aqui"));
        assert!(
            wait_for(|| h.sink.inner.played_len() >= 1).await,
            "deberia reproducirse al reactivar"
        );
        assert!(h.manager.status().enabled);
    }

    #[tokio::test]
    async fn los_filtros_descartan_y_se_cuenta_el_motivo() {
        let h = harness(settings());
        h.manager.start();

        // Un enlace y una palabra bloqueada: los descartan los filtros.
        h.manager
            .handle_event(&chat(1, "1", "mira https://spam.example"));
        h.manager.handle_event(&chat(2, "2", "a"));
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert!(h.provider.synthesised().is_empty(), "nada llega al sidecar");
        let status = h.manager.status();
        let motivos: Vec<&str> = status.rejections.iter().map(|(m, _)| *m).collect();
        assert!(
            motivos.contains(&"contiene un enlace"),
            "motivos: {motivos:?}"
        );
        assert!(motivos.contains(&"demasiado corto"), "motivos: {motivos:?}");
        assert!(status.rejections.iter().all(|(_, n)| *n >= 1));
    }

    #[tokio::test]
    async fn el_mismo_evento_no_se_lee_dos_veces() {
        let h = harness(settings());
        h.manager.start();
        let event = chat(1, "1", "hola a todos");

        h.manager.handle_event(&event);
        h.manager.handle_event(&event);

        assert!(
            wait_for(|| h.sink.inner.played_len() >= 1).await,
            "deberia sonar"
        );
        // Margen para detectar una segunda lectura que no deberia ocurrir.
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(h.sink.inner.played_len(), 1, "solo una lectura");
        assert_eq!(h.provider.synthesised().len(), 1);
    }

    #[tokio::test]
    async fn el_mismo_texto_del_mismo_usuario_no_se_repite() {
        let h = harness(settings());
        h.manager.start();

        // Mismo usuario, mismo texto normalizado, sin `source_id`.
        h.manager
            .handle_event(&chat_without_id(1, "7", "  Hola   a todos "));
        h.manager
            .handle_event(&chat_without_id(2, "7", "hola a todos"));

        assert!(wait_for(|| h.sink.inner.played_len() >= 1).await);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(h.sink.inner.played_len(), 1, "el duplicado no se lee");

        // El mismo texto de **otro** usuario si es otra frase.
        h.manager
            .handle_event(&chat_without_id(3, "8", "hola a todos"));
        assert!(
            wait_for(|| h.sink.inner.played_len() >= 2).await,
            "otro usuario si se lee"
        );

        let status = h.manager.status();
        assert!(
            status
                .rejections
                .iter()
                .any(|(motivo, n)| *motivo == "mensaje duplicado" && *n >= 1),
            "descartes: {:?}",
            status.rejections
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lo_prioritario_adelanta_al_chat_ya_encolado() {
        // La primera reproduccion se queda "sonando" hasta que el test la
        // libera: asi la cola se llena de verdad y el adelantamiento es
        // determinista, sin depender de tiempos.
        let sink = RodioLikeSink::new();
        let (manager, provider) = manager_with(settings(), sink.clone() as Arc<dyn AudioSink>);
        manager.start();

        manager.handle_event(&chat(1, "hablante", "primera frase del chat"));
        assert!(
            wait_for(|| !provider.synthesised().is_empty()).await,
            "el bucle deberia estar reproduciendo la primera frase"
        );
        assert!(
            wait_for(|| sink.waiting()).await,
            "la frase deberia estar sonando"
        );

        // Con el bucle entretenido en el reproductor, la cola se llena de chat
        // normal (prioridad 10) y despues entra un regalo prioritario. Hoy los
        // regalos todavia no se leen (`wants` los declara no legibles), asi que
        // se encola con la misma forma que tendra el evento real.
        for index in 2..=7u64 {
            manager.handle_event(&chat(
                index,
                &format!("u{index}"),
                "frase distinta del chat",
            ));
        }
        let regalo = TtsItem {
            id: 0,
            user_id: "regalador".into(),
            text: "Nick regalador envio: Rose".into(),
            voice: voices::DEFAULT_VOICE.into(),
            priority: priority::for_gift(100),
            source: TtsSource::Gift,
            queued_at: Instant::now(),
        };
        manager.enqueue_for_test(regalo);

        // La vista previa es el orden de lectura previsto: el regalo va primero
        // aunque haya llegado el ultimo.
        let status = manager.status();
        assert!(status.queued_len >= 2, "la cola deberia tener frases");
        assert_eq!(
            status.queued[0].source,
            TtsSource::Gift,
            "el regalo deberia ir primero: {:?}",
            status.queued
        );
        assert!(
            status.queued[0].priority > status.queued[1].priority,
            "el regalo tiene mas prioridad que el chat"
        );

        // Y se lee de verdad antes que el chat que ya esperaba.
        sink.release();
        assert!(
            wait_for(|| provider.synthesised().len() >= 2).await,
            "el bucle deberia seguir tras liberar la reproduccion"
        );
        let sintetizadas = provider.synthesised();
        assert!(
            sintetizadas[1].contains("Rose"),
            "la segunda sintesis deberia ser el regalo: {sintetizadas:?}"
        );

        manager.shutdown().await;
        assert_eq!(sink.inner.played_len(), 2);
    }

    #[tokio::test]
    async fn saltar_corta_el_audio_y_vaciar_la_cola_la_deja_vacia() {
        let h = harness(settings());
        h.manager.start();
        for index in 1..=5u64 {
            h.manager
                .handle_event(&chat(index, &index.to_string(), "una frase distinta"));
        }
        let mut arrancado = false;
        for _ in 0..400 {
            if !h.provider.synthesised().is_empty() {
                arrancado = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(arrancado, "el bucle deberia haber empezado a sintetizar");

        h.manager.skip();
        assert!(h.sink.inner.stops() >= 1, "saltar debe cortar el sonido");
        assert_eq!(h.manager.status().playing, None);

        h.manager.clear();
        let status = h.manager.status();
        assert_eq!(status.queued_len, 0);
        assert!(status.queued.is_empty());
    }

    #[tokio::test]
    async fn se_puede_quitar_una_frase_concreta() {
        // Sin arrancar el bucle: asi la cola se queda quieta mientras se prepara
        // el caso (el gestor esta disenado para poder usarse asi en la interfaz).
        let h = harness(settings());
        for index in 1..=3u64 {
            h.manager
                .handle_event(&chat(index, &index.to_string(), "frase distinta"));
        }
        let status = h.manager.status();
        assert_eq!(status.queued_len, 3);
        let victim = status.queued[1].id;

        h.manager.remove(victim);
        let restantes = h.manager.status();
        assert_eq!(restantes.queued_len, 2);
        assert!(restantes.queued.iter().all(|item| item.id != victim));

        // Quitar algo que no existe no rompe nada.
        h.manager.remove(999_999);
        assert_eq!(h.manager.status().queued_len, 2);
    }

    #[tokio::test]
    async fn los_ajustes_se_reflejan_en_el_estado() {
        let h = harness(settings());
        h.manager.start();

        h.manager.set_volume(0.35);
        h.manager.set_rate("+20%");
        h.manager.set_voice(Language::En, "en-GB-SoniaNeural");
        h.manager.set_voice(Language::Es, "es-MX-DaliaNeural");
        h.manager.set_say_author(false);

        let status = h.manager.status();
        let settings = h.manager.settings();
        assert!(status.enabled);
        assert_eq!(settings.volume, 0.35);
        assert_eq!(settings.rate, "+20%");
        assert_eq!(settings.voice_en, "en-GB-SoniaNeural");
        assert_eq!(settings.voice_es, "es-MX-DaliaNeural");
        assert!(!settings.say_author);
        // El volumen se aplica al dispositivo, no solo al ajuste.
        assert_eq!(h.sink.inner.volume(), 0.35);

        // Y se sigue leyendo con los ajustes nuevos.
        h.manager.set_say_author(true);
        h.manager
            .handle_event(&chat(1, "1", "hello everyone, this is english"));
        assert!(wait_for(|| h.sink.inner.played_len() >= 1).await);
        assert_eq!(h.manager.status().played, 1);
        assert_eq!(h.manager.status().synthesized, 1);
    }

    #[tokio::test]
    async fn silenciar_a_un_usuario_lo_excluye() {
        let h = harness(settings());
        h.manager.start();
        h.manager.mute_user("5");

        h.manager.handle_event(&chat(1, "5", "no deberia leerse"));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(h.manager.status().muted_users, 1);
        assert_eq!(h.provider.synthesised().len(), 0, "silenciado no se lee");

        h.manager.unmute_user("5");
        h.manager.handle_event(&chat(2, "5", "ahora si se lee"));
        assert!(wait_for(|| h.sink.inner.played_len() >= 1).await);
        assert_eq!(h.manager.status().muted_users, 0);

        // Silenciar tambien descarta lo que ya estaba encolado de ese usuario.
        h.manager.clear();
        h.manager.mute_user("6");
        h.manager.handle_event(&chat(3, "6", "esto no llega"));
        assert_eq!(h.manager.status().queued_len, 0);
        assert!(h
            .provider
            .synthesised()
            .iter()
            .all(|text| !text.contains("esto no llega")));
    }

    #[test]
    fn el_limite_global_de_lectura_descarta_y_se_cuenta() {
        // Un token por hora y rafaga de tres: agotada la rafaga, todo entra por
        // el limite global, no por los demas filtros.
        let mut settings = settings();
        settings.filters.global_interval = Duration::from_secs(3600);
        settings.filters.global_burst = 3;
        let h = harness(settings);

        let global = |h: &Harness| {
            h.manager
                .status()
                .rejections
                .iter()
                .find(|(motivo, _)| *motivo == "límite global de lectura")
                .map(|(_, count)| *count)
                .unwrap_or(0)
        };
        // Los descartes del pipeline se cuentan en el propio pipeline (que no
        // conoce el token bucket): aqui interesa el incremento de este test.
        let antes = global(&h);

        for index in 1..=8u64 {
            // Texto distinto en cada uno: si no, el que descarta es el detector
            // de duplicados y no se probaria el token bucket.
            h.manager.handle_event(&chat(
                index,
                &format!("u{index}"),
                &format!("frase numero {index}"),
            ));
        }

        let status = h.manager.status();
        assert_eq!(status.queued_len, 3, "solo pasa la rafaga");
        assert_eq!(
            global(&h) - antes,
            5,
            "los cinco que no caben en la rafaga se cuentan una sola vez: {:?}",
            status.rejections
        );
    }

    #[test]
    fn la_cola_no_crece_con_un_chat_inundado() {
        // Sin bucle: 5000 eventos tienen que quedar acotados solo por la cola.
        let h = harness(settings());
        let capacity = h.manager.queue_capacity();

        for index in 0..5000u64 {
            // Usuarios distintos: el cooldown por usuario no debe enmascarar la
            // prueba de saturacion.
            h.manager
                .handle_event(&chat(index + 1, &format!("u{index}"), "mensaje distinto"));
        }

        let status = h.manager.status();
        assert!(
            status.queued_len <= capacity,
            "la cola esta acotada: {} > {capacity}",
            status.queued_len
        );
        assert!(
            status.dropped > 0,
            "con 5000 eventos tiene que haber descartes contabilizados"
        );
    }

    #[test]
    fn los_tipos_de_evento_se_deciden_en_wants() {
        let h = harness(settings());
        let chat_event = chat(1, "1", "hola");
        let (text, priority, source) = h.manager.wants(&chat_event.kind).expect("el chat se lee");
        assert_eq!(text, "hola");
        assert_eq!(priority, priority::CHAT);
        assert_eq!(source, TtsSource::Chat);

        // Los regalos ya se leen, con su prioridad segun los diamantes.
        let (text, priority, source) = h
            .manager
            .wants(&gift(2, "2", 100).kind)
            .expect("un regalo que cierra racha se lee");
        assert_eq!(text, "Nick 2 envio Rose");
        assert_eq!(priority, priority::PREMIUM_GIFT);
        assert_eq!(source, TtsSource::Gift);

        // Los follows, en cambio, vienen apagados por defecto.
        let follow = Event::new(
            3,
            "sala".into(),
            None,
            EventKind::FollowReceived { user: user("3") },
        );
        assert!(h.manager.wants(&follow.kind).is_none());
        h.manager.set_read_follows(true);
        assert_eq!(
            h.manager.wants(&follow.kind).expect("activado se lee").2,
            TtsSource::Follow
        );

        // Y un tipo sin texto no rompe nada.
        let viewers = Event::new(
            4,
            "sala".into(),
            None,
            EventKind::ViewerUpdated {
                current: 1,
                cumulative: 2,
            },
        );
        assert!(h.manager.wants(&viewers.kind).is_none());
    }

    #[tokio::test]
    async fn pausar_silencia_y_no_vacia_la_cola() {
        let h = harness(settings());
        h.manager.start();
        h.manager.pause();
        h.manager.handle_event(&chat(1, "1", "esto espera"));
        tokio::time::sleep(Duration::from_millis(60)).await;

        let status = h.manager.status();
        assert!(status.paused);
        assert_eq!(status.played, 0, "en pausa no se lee");
        assert_eq!(status.queued_len, 1, "la frase sigue esperando");
        assert!(
            h.sink.inner.stops() >= 1,
            "la pausa silencia el dispositivo"
        );

        h.manager.resume();
        assert!(
            wait_for(|| h.sink.inner.played_len() >= 1).await,
            "al reanudar se lee lo que esperaba"
        );
        assert!(!h.manager.status().paused);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn el_consumidor_del_bus_lee_lo_que_se_publica() {
        let h = harness(settings());
        let consumer = tokio::spawn(h.manager.consumer_future());

        h.manager.publish(
            Some("m1".into()),
            EventKind::ChatMessage {
                user: user("1"),
                content: "hola desde el bus".into(),
                emote_count: 0,
            },
        );

        assert!(
            wait_for(|| h.sink.inner.played_len() >= 1).await,
            "el consumidor deberia haber leido"
        );
        assert_eq!(h.provider.synthesised().len(), 1);

        consumer.abort();
    }

    #[tokio::test]
    async fn cerrar_detiene_el_bucle_y_el_sidecar() {
        let h = harness(settings());
        h.manager.start();
        h.manager.handle_event(&chat(1, "1", "una frase"));
        assert!(wait_for(|| h.sink.inner.played_len() >= 1).await);
        h.manager.shutdown().await;
        assert!(h.sink.inner.stops() >= 1, "el cierre corta el audio");
        assert_eq!(h.manager.status().playing, None);
    }

    #[tokio::test]
    async fn una_sintesis_fallida_no_tumba_el_gestor() {
        /// Proveedor que siempre falla: simula el sidecar caido (D3).
        struct BrokenProvider;

        impl TtsProvider for BrokenProvider {
            fn name(&self) -> &'static str {
                "broken"
            }

            fn synthesize<'a>(&'a self, _: &'a TtsRequest) -> BoxFuture<'a, Result<TtsAudio>> {
                Box::pin(async move { anyhow::bail!("sidecar caido") })
            }

            fn health<'a>(&'a self) -> BoxFuture<'a, bool> {
                Box::pin(async move { false })
            }

            fn available_voices<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>>> {
                Box::pin(async move { Ok(Vec::new()) })
            }

            fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
                Box::pin(async move {})
            }
        }

        let bus = Arc::new(EventBus::new(16, Arc::new(Metrics::default())));
        let sink = Arc::new(InstantSink::new());
        let manager = Arc::new(TtsManager::new(
            settings(),
            Arc::new(BrokenProvider) as SharedTtsProvider,
            bus,
            sink.clone() as Arc<dyn AudioSink>,
        ));
        manager.start();

        for index in 1..=3u64 {
            manager.handle_event(&chat(index, &index.to_string(), "una frase cualquiera"));
        }

        assert!(
            wait_for(|| manager.status().synth_failures >= 3).await,
            "los fallos se cuentan: {:?}",
            manager.status().synth_failures
        );
        assert_eq!(manager.status().played, 0);
        let degraded = manager.status();
        assert_eq!(degraded.degraded_kind, Some("provider"));
        assert!(degraded
            .provider_degraded
            .as_deref()
            .is_some_and(|detail| detail.contains("sidecar caido")));
        assert_eq!(degraded.audio_degraded, None);
        // El gestor sigue vivo y acepta mas eventos.
        manager.handle_event(&chat(9, "9", "otra frase"));
    }

    /// Regresion: la velocidad y el tono se quedaban en los ajustes del gestor y
    /// la sintesis salia siempre a `+0%` (docs/decisions.md D12).
    #[tokio::test]
    async fn el_ritmo_y_el_tono_llegan_al_sintetizador() {
        let h = harness(settings());
        h.manager.start();

        h.manager.set_rate("+25%");
        h.manager.set_pitch("-4Hz");
        h.manager.handle_event(&chat(1, "1", "una frase distinta"));

        assert!(wait_for(|| !h.provider.ajustes().is_empty()).await);
        assert_eq!(
            h.provider.ajustes()[0],
            ("+25%".to_string(), "-4Hz".to_string()),
            "la sintesis debe usar el ajuste vigente, no uno fijo"
        );

        // Y se lee por frase, asi que un cambio posterior afecta a lo siguiente.
        h.manager.set_rate("+40%");
        h.manager.handle_event(&chat(2, "2", "otra frase distinta"));
        assert!(wait_for(|| h.provider.ajustes().len() >= 2).await);
        assert_eq!(h.provider.ajustes()[1].0, "+40%");
    }

    #[tokio::test]
    async fn los_regalos_se_leen_solo_al_cerrar_la_racha() {
        let h = harness(settings());
        h.manager.start();

        let racha = |seq: u64, repeat: i32, final_: bool| {
            Event::new(
                seq,
                "sala".into(),
                Some(format!("gift-{seq}")),
                EventKind::GiftReceived {
                    user: user("9"),
                    gift: GiftInfo::new("5655", "Rose", 1, true, repeat, final_, "g1"),
                },
            )
        };

        // Dos eventos intermedios de la racha: no se leen.
        h.manager.handle_event(&racha(1, 1, false));
        h.manager.handle_event(&racha(2, 2, false));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(
            h.provider.synthesised().is_empty(),
            "los intermedios de una racha no se anuncian: {:?}",
            h.provider.synthesised()
        );

        // El que cierra la racha si, y con la cantidad acumulada.
        h.manager.handle_event(&racha(3, 5, true));
        assert!(wait_for(|| !h.provider.synthesised().is_empty()).await);
        assert_eq!(h.provider.synthesised()[0], "Nick 9 envio 5 x Rose");
    }

    #[tokio::test]
    async fn los_regalos_y_follows_se_pueden_apagar() {
        let h = harness(settings());
        h.manager.start();
        h.manager.set_read_gifts(false);
        h.manager.set_read_follows(true);

        h.manager.handle_event(&gift(1, "9", 1));
        h.manager.handle_event(&Event::new(
            2,
            "sala".into(),
            Some("follow-2".into()),
            EventKind::FollowReceived { user: user("8") },
        ));

        assert!(wait_for(|| !h.provider.synthesised().is_empty()).await);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            h.provider.synthesised(),
            vec!["Nick 8 te sigue".to_string()],
            "con los regalos apagados solo se lee el follow"
        );
    }

    /// Un aviso de regalo no puede gastar el cooldown del chat de quien lo mando:
    /// si no, regalar silenciaria a esa persona durante 20 s.
    #[tokio::test]
    async fn un_regalo_no_bloquea_el_chat_de_quien_lo_manda() {
        let mut ajustes = settings();
        // El cooldown por usuario es el del plan: 20 s.
        ajustes.filters.user_cooldown = Duration::from_secs(20);
        ajustes.filters.min_chars = 2;
        let h = harness(ajustes);
        h.manager.start();

        h.manager.handle_event(&gift(1, "7", 1));
        h.manager.handle_event(&chat(2, "7", "hola a todos"));

        assert!(wait_for(|| h.provider.synthesised().len() >= 2).await);
        let leidas = h.provider.synthesised();
        assert!(
            leidas.iter().any(|line| line.contains("envio")),
            "el regalo se lee: {leidas:?}"
        );
        assert!(
            leidas.iter().any(|line| line.contains("dice")),
            "y el chat del mismo usuario sigue leyendose: {leidas:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Regresiones de robustez
    // -----------------------------------------------------------------------

    /// F1 visto desde el gestor: con una frase **sonando**, "saltar" y "pausar"
    /// terminan la espera en curso y el volumen cambia al momento, sin esperar al
    /// final de la locucion.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn saltar_o_pausar_cortan_la_espera_en_curso_y_el_volumen_llega_ya() {
        let sink = RodioLikeSink::new();
        let (manager, _provider) = manager_with(settings(), sink.clone() as Arc<dyn AudioSink>);
        manager.start();
        manager.handle_event(&chat(1, "1", "primera frase que suena"));

        assert!(
            wait_for(|| sink.waiting()).await,
            "la frase deberia estar sonando"
        );
        assert!(sink.is_playing());

        // El volumen de una frase en curso cambia ya, no al terminarla.
        manager.set_volume(0.4);
        assert_eq!(sink.inner.volume(), 0.4, "el volumen debe aplicarse ya");

        // "Saltar" corta la espera en curso: no hay que agotar la locucion.
        let inicio = Instant::now();
        manager.skip();
        assert!(
            wait_for(|| !sink.waiting()).await,
            "saltar debe terminar la espera"
        );
        let tardanza = inicio.elapsed();
        assert!(
            tardanza < Duration::from_secs(1),
            "y hacerlo ya, no al final de la frase: {tardanza:?}"
        );
        assert_eq!(sink.cut_waits(), 1, "el corte lo noto la espera en curso");
        assert_eq!(manager.status().playing, None);

        // "Pausar" tambien corta lo que suena.
        manager.resume();
        manager.handle_event(&chat(2, "2", "segunda frase que suena"));
        assert!(
            wait_for(|| sink.waiting() && sink.cut_waits() == 1).await,
            "la segunda frase deberia estar sonando"
        );
        manager.pause();
        assert!(
            wait_for(|| !sink.waiting()).await,
            "pausar debe cortar la espera en curso"
        );
        assert_eq!(sink.cut_waits(), 2, "la pausa tambien corta");
        assert_eq!(
            manager.status().played,
            2,
            "las dos frases llegaron a sonar"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn saltar_cancela_la_sintesis_en_vuelo_y_no_la_cuenta_como_fallo() {
        let provider = CancelAwareProvider::new();
        let sink = Arc::new(NullSink::default());
        let bus = Arc::new(EventBus::new(32, Arc::new(Metrics::default())));
        let manager = Arc::new(TtsManager::new(
            settings(),
            provider.clone() as SharedTtsProvider,
            bus,
            sink.clone() as Arc<dyn AudioSink>,
        ));
        manager.start();
        manager.handle_event(&chat(1, "cancel-user", "frase que tarda"));
        assert!(wait_for(|| provider.started.load(Ordering::Relaxed) == 1).await);

        manager.skip();
        assert!(
            wait_for(|| provider.cancelled.load(Ordering::Relaxed) == 1).await,
            "skip debe llegar al proveedor, no solo al reproductor"
        );
        let status = manager.status();
        assert_eq!(
            status.synth_failures, 0,
            "cancelar no es un fallo del proveedor"
        );
        assert_eq!(status.played, 0);
        assert_eq!(status.playing, None);
        manager.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pausar_y_cerrar_cancelan_una_sintesis_en_vuelo() {
        let provider = CancelAwareProvider::new();
        let sink = Arc::new(NullSink::default());
        let bus = Arc::new(EventBus::new(32, Arc::new(Metrics::default())));
        let manager = Arc::new(TtsManager::new(
            settings(),
            provider.clone() as SharedTtsProvider,
            bus,
            sink as Arc<dyn AudioSink>,
        ));
        manager.start();
        manager.handle_event(&chat(1, "cancel-user", "otra frase que tarda"));
        assert!(wait_for(|| provider.started.load(Ordering::Relaxed) == 1).await);

        manager.pause();
        assert!(wait_for(|| provider.cancelled.load(Ordering::Relaxed) == 1).await);
        assert_eq!(manager.status().synth_failures, 0);

        // `shutdown` repite la señal de forma idempotente y deja el proveedor
        // sin una operación en vuelo.
        manager.shutdown().await;
        assert_eq!(provider.cancelled.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn el_estado_degradado_distingue_audio_de_proveedor() {
        let provider = FakeProvider::new();
        let bus = Arc::new(EventBus::new(32, Arc::new(Metrics::default())));
        let manager = Arc::new(TtsManager::new(
            settings(),
            provider as SharedTtsProvider,
            bus,
            Arc::new(BrokenAudioSink),
        ));
        manager.start();
        manager.handle_event(&chat(1, "audio-user", "la sintesis si funciona"));
        assert!(wait_for(|| manager.status().synth_failures >= 1).await);

        let status = manager.status();
        assert_eq!(status.degraded_kind, Some("audio"));
        assert!(status
            .audio_degraded
            .as_deref()
            .is_some_and(|detail| detail.contains("dispositivo de prueba")));
        assert_eq!(status.provider_degraded, None);
        manager.shutdown().await;
    }

    /// F2: la espera del audio no puede secuestrar un hilo del runtime.
    ///
    /// El test corre en un runtime de **un solo hilo** a proposito: si el gestor
    /// esperase la locucion dentro de su propia tarea, nada mas de este test
    /// avanzaria hasta que la frase terminara.
    #[tokio::test]
    async fn la_espera_del_audio_no_secuestra_el_runtime() {
        let sink = RodioLikeSink::new();
        let (manager, _provider) = manager_with(settings(), sink.clone() as Arc<dyn AudioSink>);
        manager.start();
        manager.handle_event(&chat(1, "1", "una locucion larga"));

        assert!(
            wait_for(|| sink.waiting()).await,
            "el gestor deberia estar esperando el final del audio"
        );

        // Este latido corre **mientras** suena la frase: con la espera dentro de
        // la tarea del gestor, el unico worker del runtime estaria bloqueado y el
        // plazo no se cumpliria.
        let inicio = Instant::now();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let transcurrido = inicio.elapsed();
        assert!(
            transcurrido < Duration::from_secs(1),
            "la espera bloqueo el runtime: el latido tardo {transcurrido:?}"
        );
        assert!(
            sink.waiting(),
            "la espera sigue en curso, pero sin bloquear nada"
        );

        // Y al terminar la locucion el bucle sigue con lo que haya.
        sink.release();
        assert!(wait_for(|| !sink.waiting()).await);
        assert_eq!(manager.status().played, 1);
    }

    /// La poda se decide por frases atendidas (nada de temporizadores): la
    /// funcion pura lo fija sin arrancar el gestor.
    #[test]
    fn la_poda_se_decide_por_frases_y_no_por_reloj() {
        assert!(!prune_due(0, 100), "sin frases no hay nada que podar");
        assert!(!prune_due(99, 100));
        assert!(prune_due(100, 100));
        assert!(prune_due(200, 100));
        assert!(!prune_due(150, 100));
        // Un periodo a cero no puede podar en cada frase (seria un bucle de E/S).
        assert!(!prune_due(100, 0));
    }

    /// F3: la cache se poda al arrancar el bucle y despues cada cierto numero de
    /// frases. Antes solo la podaba el CLI (`--tts-test`), asi que en la
    /// aplicacion la carpeta crecia sin limite.
    #[tokio::test]
    async fn la_cache_se_poda_al_arrancar_y_cada_cierto_numero_de_frases() {
        let h = harness(settings());
        h.manager.start();
        assert!(
            wait_for(|| h.provider.prunes() >= 1).await,
            "el bucle debe podar al arrancar: la cache puede venir de otras sesiones"
        );

        // Se adelanta el contador en lugar de leer 100 frases: la politica va
        // atada a las frases, no al reloj.
        h.manager.lock_counters().played = CACHE_PRUNE_EVERY - 1;
        h.manager
            .handle_event(&chat(1, "1", "la frase que dispara la poda"));
        assert!(
            wait_for(|| h.provider.prunes() >= 2).await,
            "al cruzar el multiplo de frases deberia podar otra vez"
        );
    }

    /// F10: la memoria de duplicados caduca **por tiempo**, no solo por
    /// capacidad. Sin ventana, el mismo texto del mismo usuario no se volvia a
    /// leer nunca mientras cupiera.
    #[test]
    fn la_memoria_de_duplicados_caduca_por_tiempo() {
        let mut seen = Seen::default();
        // Reloj sintetico: la ventana no se prueba esperando 30 s de verdad.
        let ahora = Instant::now();
        seen.remember("7", "hola a todos", Some("msg-1"), ahora);

        // Dentro de la ventana el mensaje sigue siendo un duplicado, por las dos
        // claves (el `source_id` de TikTok y el par usuario/texto).
        let dentro = ahora + Duration::from_secs(1);
        assert!(seen.contains("7", "hola a todos", Some("msg-1"), dentro));
        assert!(seen.contains("7", "hola a todos", None, dentro));

        // Pasado el plazo se puede volver a leer.
        let fuera = ahora + SEEN_WINDOW + Duration::from_secs(1);
        assert!(!seen.contains("7", "hola a todos", Some("msg-1"), fuera));
        assert!(!seen.contains("7", "hola a todos", None, fuera));

        // Y el mismo texto de otra persona es otra frase.
        assert!(!seen.contains("8", "hola a todos", None, dentro));

        // Refrescar la marca no duplica la entrada en el orden de desalojo: si
        // no, un mensaje repetido expulsaria antes a otro.
        seen.remember("7", "hola a todos", Some("msg-1"), dentro);
        assert_eq!(seen.order_content.len(), 1);
        assert_eq!(seen.order_sources.len(), 1);
    }

    /// La ventana temporal no puede haber aflojado el tope de memoria: un chat
    /// inundado sigue acotado.
    #[test]
    fn la_memoria_de_duplicados_sigue_acotada() {
        let mut seen = Seen::default();
        let ahora = Instant::now();
        for index in 0..SEEN_CAPACITY + 50 {
            seen.remember(
                "7",
                &format!("frase {index}"),
                Some(&format!("msg-{index}")),
                ahora,
            );
        }

        assert!(seen.content.len() <= SEEN_CAPACITY);
        assert!(seen.sources.len() <= SEEN_CAPACITY);
        assert!(seen.order_content.len() <= SEEN_CAPACITY);
        assert!(seen.order_sources.len() <= SEEN_CAPACITY);
        // Lo mas antiguo se ha desalojado.
        assert!(!seen.contains("7", "frase 0", Some("msg-0"), ahora));
    }
}
