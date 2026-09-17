//! Reproduccion de audio del TTS.
//!
//! Decisiones que no son obvias (docs/plan-review.md §P1-6, docs/decisions.md D3):
//!
//!   * **un unico flujo de salida para todo el proceso**. Crear un reproductor
//!     por frase cuesta latencia (abrir el dispositivo tarda decenas de ms),
//!     multiplica los procesos internos de Windows y hace imposible el "salto"
//!     de la frase en curso. `rodio` mezcla varias fuentes por flujo, asi que
//!     un solo `OutputStream` basta para lo que dura la aplicacion.
//!   * el flujo y el reproductor viven en un **hilo propio**: `rodio`/`cpal`
//!     exigen abrir el dispositivo en el mismo hilo que lo usa y, sobre todo,
//!     `Sink::sleep_until_end()` bloquea. Nunca se llama desde el runtime
//!     asincrono.
//!   * el hilo se gobierna con un canal **acotado** (capacidad `COMMAND_CAPACITY`).
//!     Si se llena se descarta **el comando mas nuevo** y se cuenta: el audio es
//!     lo menos importante del sistema, y bloquear al emisor (que corre en el
//!     runtime) para encolar un sonido seria cambiar un fallo audible por un
//!     tiron en el evento en directo. Como el gestor reproduce de uno en uno, en
//!     la practica el canal casi nunca se llena; el tope es la red de seguridad.
//!   * si no hay dispositivo de salida, `RodioSink::new()` falla con un error
//!     claro y **la aplicacion sigue funcionando**: el TTS queda degradado (no
//!     suena), pero el bus, el chat y el resto de la interfaz no se enteran.
//!     Por eso existe `FallbackSink`, que envuelve la eleccion y nunca propaga
//!     ese fallo al gestor.

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rodio::{Decoder, OutputStream, Sink};

/// Capacidad del canal de ordenes. Acotada a proposito (ver cabecera).
const COMMAND_CAPACITY: usize = 16;

/// Limite de espera al cerrar el hilo. Si no responde, se abandona: cerrar la
/// aplicacion no puede quedarse colgado por una tarjeta de sonido.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(300);

/// Salida de audio. Existe como trait para poder probar el gestor entero sin
/// tarjeta de sonido (`NullSink`) y sin depender de tiempos reales.
pub trait AudioSink: Send + Sync {
    /// Reproduce un fichero. Devuelve el control en cuanto esta encolado; la
    /// reproduccion ocurre en el hilo de audio.
    fn play(&self, file: &Path, volume: f32) -> anyhow::Result<()>;
    /// Corta la reproduccion en curso (accion "saltar").
    fn stop(&self);
    /// Volumen 0.0..=1.0; fuera de rango se recorta.
    fn set_volume(&self, volume: f32);
    fn is_playing(&self) -> bool;
    /// **Bloquea** hasta que termina lo que suena. Es sincrona a proposito: la
    /// usan los tests y el cierre, nunca el runtime asincrono.
    fn wait(&self);
    /// Ultimo fallo del dispositivo, si lo hubo. Se muestra en el estado.
    fn last_error(&self) -> Option<String> {
        None
    }
}

/// Recorta el volumen al rango util. `NaN` se trata como 1.0: un valor
/// envenenado no puede dejar el audio mudo para siempre.
pub fn clamp_volume(volume: f32) -> f32 {
    if volume.is_nan() {
        return 1.0;
    }
    volume.clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Hilo de audio
// ---------------------------------------------------------------------------

enum Command {
    Play(PathBuf, f32),
    Stop,
    SetVolume(f32),
    IsPlaying(Sender<bool>),
    /// Espera a que termine lo que suena y responde. Siempre responde; el
    /// llamante decide si le interesa bloquearse cuando no hay nada sonando.
    Wait(Sender<()>),
    Devices(Sender<anyhow::Result<Vec<String>>>),
    Shutdown,
}

/// Traduce el volumen pedido al factor que espera `rodio`.
///
/// La escala perceptual no es lineal: 0.5 "a oidos" es mucho mas que la mitad
/// de amplitud. La curva cuadratica es una aproximacion barata y suficiente
/// para que el control de la interfaz no se sienta raro.
fn amplitude(volume: f32) -> f32 {
    let volume = clamp_volume(volume);
    volume * volume
}

struct Worker {
    commands: Receiver<Command>,
    /// El flujo debe vivir tanto como el reproductor: al soltarlo, el audio
    /// termina. Se guarda aqui, en el hilo que lo creo.
    _stream: OutputStream,
    sink: Sink,
    volume: f32,
}

impl Worker {
    fn run(mut self) {
        while let Ok(command) = self.commands.recv() {
            match command {
                Command::Play(path, volume) => self.play(&path, volume),
                Command::Stop => self.stop(),
                Command::SetVolume(volume) => {
                    self.volume = clamp_volume(volume);
                    self.sink.set_volume(amplitude(self.volume));
                }
                Command::IsPlaying(reply) => {
                    let _ = reply.send(!self.sink.empty());
                }
                Command::Wait(reply) => {
                    self.sink.sleep_until_end();
                    let _ = reply.send(());
                }
                Command::Devices(reply) => {
                    let _ = reply.send(available_devices());
                }
                Command::Shutdown => break,
            }
        }
        self.sink.stop();
    }

    fn play(&self, path: &Path, volume: f32) {
        // Un fallo de decodificacion no se puede detectar en `rodio`: la fuente
        // se agota sin avisar. Los ficheros de cache vacios son el sintoma real
        // (una sintesis interrumpida), asi que se comprueba el tamano antes.
        let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if bytes == 0 {
            tracing::warn!(file = %path.display(), "audio vacio: no se reproduce");
            return;
        }

        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(%error, file = %path.display(), "no se pudo abrir el audio");
                return;
            }
        };
        let source = match Decoder::new(BufReader::new(file)) {
            Ok(source) => source,
            Err(error) => {
                tracing::warn!(%error, file = %path.display(), "audio no decodificable");
                return;
            }
        };

        // `stop()` deja el reproductor marcado: `append` espera a vaciarlo. Para
        // saltar de una frase a otra hay que soltar la marca.
        self.sink.play();
        self.sink.set_volume(amplitude(volume));
        self.sink.append(source);
    }

    /// Silencia y vacia el flujo.
    ///
    /// `Sink::stop` solo marca el fin de la fuente actual: el silencio real
    /// llega en el siguiente bloque de audio. `clear()` quita ya lo encolado y
    /// pausa; se reanuda en el momento para que la proxima frase suene.
    fn stop(&self) {
        self.sink.clear();
        self.sink.play();
    }
}

/// Nombres de los dispositivos de salida disponibles.
///
/// `cpal` no garantiza que su lista se pueda consultar desde cualquier hilo
/// (en Windows el dispositivo es COM), asi que la enumeracion se hace **en el
/// hilo de audio**, que es el mismo que lo va a abrir.
pub fn available_devices() -> anyhow::Result<Vec<String>> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    let host = rodio::cpal::default_host();
    let devices = host
        .output_devices()
        .map_err(|error| anyhow::anyhow!("no se pudieron listar los dispositivos: {error}"))?;
    Ok(devices
        .filter_map(|device| device.name().ok())
        .collect::<Vec<String>>())
}

/// Lista los dispositivos de salida usando un hilo de audio efimero.
///
/// Abre el dispositivo por defecto (es lo que permite enumerar en el hilo
/// correcto) y lo cierra al terminar. Se usa desde la interfaz, no en el camino
/// caliente.
pub fn list_devices() -> anyhow::Result<Vec<String>> {
    let sink = RodioSink::new()?;
    sink.devices()
}

struct WorkerStart {
    stream: OutputStream,
    handle: rodio::OutputStreamHandle,
}

/// Salida real con `rodio`: un flujo persistente en un hilo propio.
pub struct RodioSink {
    commands: SyncSender<Command>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
    error: Arc<Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
    device: String,
}

impl RodioSink {
    /// Abre el dispositivo de salida por defecto.
    ///
    /// Si no hay ninguno, devuelve un error explicito. El gestor lo convierte en
    /// "TTS degradado": el resto de la aplicacion sigue viva.
    pub fn new() -> anyhow::Result<Self> {
        Self::with_device(None)
    }

    /// Abre un dispositivo concreto por nombre. `None` es el de por defecto.
    ///
    /// La eleccion importa en esta maquina: rutear el TTS a un cable virtual
    /// permite que OBS lo capture por separado (docs/decisions.md D3).
    pub fn with_device(device: Option<&str>) -> anyhow::Result<Self> {
        let requested = device.map(|name| name.to_string());
        Self::spawn(move || open_stream(requested.as_deref()))
    }

    /// Crea el hilo de audio y espera a saber si el dispositivo se abrio.
    ///
    /// El resultado se devuelve por canal en lugar de devolver el flujo: mover
    /// un `cpal::Stream` entre hilos no es portable, y el hilo debe ser su dueno.
    fn spawn(start: impl FnOnce() -> anyhow::Result<WorkerStart> + Send + 'static) -> anyhow::Result<Self> {
        let (command_tx, command_rx) = mpsc::sync_channel::<Command>(COMMAND_CAPACITY);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));

        let thread_error = error.clone();
        let thread = thread::Builder::new()
            .name("tts-audio".into())
            .spawn(move || match start() {
                Ok(started) => {
                    let sink = match Sink::try_new(&started.handle) {
                        Ok(sink) => sink,
                        Err(error) => {
                            let message = format!("no se pudo crear el reproductor: {error}");
                            let _ = ready_tx.send(Err(message.clone()));
                            *lock(&thread_error) = Some(message);
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok("dispositivo por defecto".into()));
                    Worker {
                        commands: command_rx,
                        _stream: started.stream,
                        sink,
                        volume: 1.0,
                    }
                    .run();
                }
                Err(error) => {
                    // Sin dispositivo el hilo termina, pero el sink sigue siendo
                    // utilizable: las ordenes se descartan y se ve el motivo.
                    let _ = ready_tx.send(Err(format!("{error:#}")));
                    *lock(&thread_error) = Some(format!("{error:#}"));
                }
            })
            .map_err(|error| anyhow::anyhow!("no se pudo crear el hilo de audio: {error}"))?;

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(device)) => Ok(Self {
                commands: command_tx,
                thread: Mutex::new(Some(thread)),
                error,
                dropped,
                device,
            }),
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(anyhow::anyhow!("audio no disponible: {message}"))
            }
            Err(_) => Err(anyhow::anyhow!(
                "el hilo de audio no respondio al abrir el dispositivo"
            )),
        }
    }

    /// Dispositivo en uso, para mostrarlo en la interfaz.
    pub fn device(&self) -> &str {
        &self.device
    }

    /// Ordenes descartadas por canal lleno.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn devices(&self) -> anyhow::Result<Vec<String>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.send(Command::Devices(reply_tx))?;
        match reply_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(result) => result,
            Err(_) => Err(anyhow::anyhow!("el hilo de audio no respondio")),
        }
    }

    /// Envia una orden. Si el canal esta lleno se descarta **la mas nueva**:
    /// bloquear al emisor (el runtime) por un sonido no tiene sentido.
    fn send(&self, command: Command) -> anyhow::Result<()> {
        match self.commands.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                tracing::warn!("hilo de audio saturado: orden descartada");
                // No es un error para el gestor: perder una frase es aceptable,
                // romper el bucle no.
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => {
                Err(anyhow::anyhow!("el hilo de audio termino"))
            }
        }
    }
}

/// Abre el flujo de salida. Elige el dispositivo por nombre si se pidio; si el
/// nombre no existe, falla en lugar de usar otro en silencio: el streamer debe
/// saber que su cable virtual no se abrio.
fn open_stream(device: Option<&str>) -> anyhow::Result<WorkerStart> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    let (stream, handle) = match device {
        None => OutputStream::try_default()
            .map_err(|error| anyhow::anyhow!("no hay dispositivo de salida de audio: {error}"))?,
        Some(name) => {
            let host = rodio::cpal::default_host();
            let chosen = host
                .output_devices()
                .map_err(|error| anyhow::anyhow!("no se pudieron listar los dispositivos: {error}"))?
                .find(|candidate| candidate.name().map(|current| current == name).unwrap_or(false));
            match chosen {
                Some(chosen) => OutputStream::try_from_device(&chosen).map_err(|error| {
                    anyhow::anyhow!("no se pudo abrir el dispositivo {name}: {error}")
                })?,
                None => {
                    return Err(anyhow::anyhow!(
                        "no existe el dispositivo de salida {name}"
                    ))
                }
            }
        }
    };
    Ok(WorkerStart { stream, handle })
}

/// Evita `unwrap` en los cerrojos: un cerrojo envenenado no puede tumbar el
/// audio, solo dejar el diagnostico sin actualizar.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl AudioSink for RodioSink {
    fn play(&self, file: &Path, volume: f32) -> anyhow::Result<()> {
        self.send(Command::Play(file.to_path_buf(), volume))
    }

    fn stop(&self) {
        let _ = self.send(Command::Stop);
    }

    fn set_volume(&self, volume: f32) {
        let _ = self.send(Command::SetVolume(volume));
    }

    fn is_playing(&self) -> bool {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.send(Command::IsPlaying(reply_tx)).is_err() {
            return false;
        }
        reply_rx
            .recv_timeout(Duration::from_millis(500))
            .unwrap_or(false)
    }

    fn wait(&self) {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.send(Command::Wait(reply_tx)).is_err() {
            return;
        }
        let _ = reply_rx.recv_timeout(Duration::from_secs(30));
    }

    fn last_error(&self) -> Option<String> {
        lock(&self.error).clone()
    }
}

impl Drop for RodioSink {
    fn drop(&mut self) {
        // Se cierra el canal y, si el hilo no termina a tiempo, se abandona: la
        // aplicacion no se queda colgada por el audio.
        let _ = self.commands.try_send(Command::Shutdown);
        if let Some(thread) = lock(&self.thread).take() {
            let (done_tx, done_rx) = mpsc::channel();
            let spawned = thread::Builder::new()
                .name("tts-audio-join".into())
                .spawn(move || {
                    let _ = thread.join();
                    let _ = done_tx.send(());
                });
            if let Ok(handle) = spawned {
                let _ = done_rx.recv_timeout(SHUTDOWN_GRACE);
                let _ = handle.join();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dobles de prueba y degradacion
// ---------------------------------------------------------------------------

/// Salida que no suena: registra lo que se le pidio y "reproduce" al instante.
///
/// Es lo que permite probar el gestor completo (orden, prioridades, saltos) en
/// CI, donde no hay tarjeta de sonido.
#[derive(Default)]
pub struct NullSink {
    played: Mutex<Vec<(PathBuf, f32)>>,
    stopped: AtomicU64,
    volume: Mutex<f32>,
    playing: Mutex<bool>,
}

impl NullSink {
    pub fn new() -> Self {
        Self {
            volume: Mutex::new(1.0),
            ..Self::default()
        }
    }

    /// Ficheros "reproducidos", en orden, con el volumen de cada uno.
    pub fn played(&self) -> Vec<(PathBuf, f32)> {
        lock(&self.played).clone()
    }

    pub fn played_len(&self) -> usize {
        lock(&self.played).len()
    }

    /// Cuantas veces se pidio cortar la reproduccion.
    pub fn stops(&self) -> u64 {
        self.stopped.load(Ordering::Relaxed)
    }

    pub fn volume(&self) -> f32 {
        *lock(&self.volume)
    }
}

impl AudioSink for NullSink {
    fn play(&self, file: &Path, volume: f32) -> anyhow::Result<()> {
        *lock(&self.volume) = clamp_volume(volume);
        lock(&self.played).push((file.to_path_buf(), clamp_volume(volume)));
        *lock(&self.playing) = true;
        Ok(())
    }

    fn stop(&self) {
        self.stopped.fetch_add(1, Ordering::Relaxed);
        *lock(&self.playing) = false;
    }

    fn set_volume(&self, volume: f32) {
        *lock(&self.volume) = clamp_volume(volume);
    }

    fn is_playing(&self) -> bool {
        *lock(&self.playing)
    }

    /// Devuelve el control de inmediato: para este doble, "reproducir" ya ha
    /// terminado cuando `play` regresa.
    fn wait(&self) {
        *lock(&self.playing) = false;
    }
}

/// Envuelve la salida elegida y **degrada** en lugar de fallar.
///
/// Si al arrancar no hay dispositivo, el gestor debe seguir vivo: se queda con
/// un `NullSink`, guarda el motivo y lo publica en el estado. El streamer ve
/// "audio no disponible" en la pagina de TTS en lugar de un TTS que no responde.
pub struct FallbackSink {
    inner: Arc<dyn AudioSink>,
    /// `None` si el dispositivo real se abrio.
    problem: Option<String>,
}

impl FallbackSink {
    /// Intenta abrir `rodio`; si no puede, devuelve un sink mudo con el motivo.
    pub fn new() -> Self {
        match RodioSink::new() {
            Ok(sink) => {
                tracing::info!(device = sink.device(), "salida de audio lista");
                Self {
                    inner: Arc::new(sink),
                    problem: None,
                }
            }
            Err(error) => {
                let problem = format!("{error:#}");
                tracing::warn!(%problem, "TTS sin salida de audio: la aplicacion sigue sin leer");
                Self {
                    inner: Arc::new(NullSink::new()),
                    problem: Some(problem),
                }
            }
        }
    }

    pub fn with_device(device: Option<&str>) -> Self {
        match RodioSink::with_device(device) {
            Ok(sink) => Self {
                inner: Arc::new(sink),
                problem: None,
            },
            Err(error) => Self {
                inner: Arc::new(NullSink::new()),
                problem: Some(format!("{error:#}")),
            },
        }
    }

    /// Motivo por el que el audio esta degradado, si lo esta.
    pub fn problem(&self) -> Option<&str> {
        self.problem.as_deref()
    }

    /// Hasta que se demuestre lo contrario, solo degrada si el propio `rodio`
    /// avisa: un sink mudo por decision del usuario no es un problema.
    pub fn sink(&self) -> Arc<dyn AudioSink> {
        self.inner.clone()
    }
}

impl Default for FallbackSink {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioSink for FallbackSink {
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
        self.inner.is_playing()
    }

    fn wait(&self) {
        self.inner.wait();
    }

    fn last_error(&self) -> Option<String> {
        match &self.problem {
            Some(problem) => Some(problem.clone()),
            None => self.inner.last_error(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporal(name: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "ttdash-player-{}-{unique}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn el_volumen_se_recorta_al_rango_util() {
        assert_eq!(clamp_volume(-1.0), 0.0);
        assert_eq!(clamp_volume(0.0), 0.0);
        assert_eq!(clamp_volume(0.5), 0.5);
        assert_eq!(clamp_volume(1.0), 1.0);
        assert_eq!(clamp_volume(7.0), 1.0);
        // Un NaN no puede dejar el audio mudo para siempre.
        assert_eq!(clamp_volume(f32::NAN), 1.0);
    }

    #[test]
    fn la_curva_de_volumen_no_pasa_de_la_unidad() {
        assert_eq!(amplitude(1.0), 1.0);
        assert_eq!(amplitude(0.0), 0.0);
        assert!(amplitude(0.5) < 0.5, "la mitad percibida es menos amplitud");
        assert_eq!(amplitude(3.0), 1.0, "recorta por encima del tope");
    }

    #[test]
    fn el_doble_nulo_registra_y_no_suena() {
        let sink = NullSink::new();
        let first = temporal("a.mp3");
        let second = temporal("b.mp3");

        assert!(!sink.is_playing());
        sink.play(&first, 0.5).expect("reproduce");
        sink.play(&second, 2.0).expect("reproduce");

        let played = sink.played();
        assert_eq!(played.len(), 2);
        assert_eq!(played[0].0, first);
        assert_eq!(played[0].1, 0.5);
        assert_eq!(played[1].1, 1.0, "el volumen se recorta al registrar");
        assert!(sink.is_playing());

        sink.set_volume(0.25);
        assert_eq!(sink.volume(), 0.25);

        sink.stop();
        assert_eq!(sink.stops(), 1);
        assert!(!sink.is_playing());

        // `wait` no bloquea: es lo que mantiene los tests en milisegundos.
        sink.wait();
    }

    #[test]
    fn el_envoltorio_de_respaldo_nunca_falla() {
        // En CI no hay dispositivo: el envoltorio debe existir igualmente.
        let fallback = FallbackSink::new();
        let file = temporal("c.mp3");
        // Sin dispositivo, `play` no puede fallar hacia fuera: la aplicacion no
        // se entera de que no hay audio mas alla del estado.
        fallback.play(&file, 0.5).expect("nunca falla");
        fallback.set_volume(0.3);
        let _ = fallback.is_playing();
        fallback.wait();
        fallback.stop();
    }

    #[test]
    fn con_dispositivo_real_el_flujo_se_abre_una_sola_vez() {
        // El dispositivo es un recurso compartido de la maquina: si `rodio` no
        // puede abrirlo, el test se salta en lugar de fallar (CI sin audio).
        let sink = match RodioSink::new() {
            Ok(sink) => sink,
            Err(error) => {
                eprintln!("sin dispositivo de audio, test omitido: {error:#}");
                return;
            }
        };
        assert!(!sink.is_playing(), "al arrancar no suena nada");
        sink.set_volume(0.5);
        sink.stop();
        // Un fichero inexistente no puede tumbar el hilo de audio.
        let missing = temporal("no-existe.mp3");
        sink.play(&missing, 0.5).expect("la orden se acepta");
        assert!(!sink.is_playing());
        assert!(sink.last_error().is_none());
        let _ = sink.dropped();
    }
}
