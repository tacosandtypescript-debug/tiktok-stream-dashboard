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
//!   * **el control (`stop`, `set_volume`) no pasa por el canal**: va directo al
//!     reproductor compartido (ver `Control`). Si pasara por el canal solo se
//!     atenderia al salir de `sleep_until_end()`, es decir, al terminar la
//!     locucion: "saltar" y "pausar" no cortarian nada y el volumen no cambiaria
//!     a media frase. Por el canal van las ordenes que **si** deben ejecutarse en
//!     orden (`Play`, `Wait`, `IsPlaying`).
//!   * un `Play` que se cruza con un `stop()` acaba en **silencio**, nunca en una
//!     frase fantasma: la orden viaja con la generacion de corte que habia al
//!     pedirla, el hilo la descarta si ya no es la vigente y, por si el corte
//!     llega entre la comprobacion y el encolado, se vuelve a parar el
//!     reproductor despues de encolarla.
//!   * el reproductor se abstrae en el trait privado `Device`. Es la costura que
//!     permite probar el gobierno del hilo (canal acotado + control directo +
//!     generacion de corte) sin tarjeta de sonido, con un doble que imita a
//!     rodio, bloqueo incluido.

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::Context;
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
    /// Reproduce un fichero **cortando antes lo que estuviera sonando**.
    ///
    /// Existe por los previews —el boton «oir» de la biblioteca de sonidos y el
    /// de probar de las alertas—: ahi encolar seria **sumar**, y dos previews a
    /// la vez es justo lo que no puede pasar. El lector de voz sigue usando
    /// `play`, que encola la frase siguiente: en una locucion, sumar es lo
    /// correcto.
    ///
    /// El defecto corta y luego reproduce. Ya garantiza "uno a la vez", pero no
    /// es atomico: entre el corte y el encolado cabe otra reproduccion.
    /// `RodioSink` lo hace **atomico** mandando las dos cosas en la misma orden
    /// del hilo de audio, que es lo que hace falta cuando dos clics seguidos
    /// pueden cruzarse.
    fn play_exclusive(&self, file: &Path, volume: f32) -> anyhow::Result<()> {
        self.stop();
        self.play(file, volume)
    }
    /// Corta la reproduccion en curso (accion "saltar").
    fn stop(&self);
    /// Volumen 0.0..=1.0; fuera de rango se recorta.
    fn set_volume(&self, volume: f32);
    fn is_playing(&self) -> bool;
    /// **Bloquea** hasta que termina lo que suena (o alguien lo corta con
    /// `stop()`). Es sincrona a proposito: el gestor la llama desde la piscina de
    /// bloqueo de Tokio (`spawn_blocking`), jamas desde una tarea asincrona, para
    /// no secuestrar un hilo del runtime.
    fn wait(&self);
    /// Ultimo fallo del dispositivo, si lo hubo. Se muestra en el estado.
    fn last_error(&self) -> Option<String> {
        None
    }
    /// Nombre del dispositivo que el sink consiguió abrir.
    fn device_name(&self) -> Option<String> {
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

/// Orden que se ejecuta **en el hilo de audio**, y en orden.
///
/// `Stop` y `SetVolume` no estan aqui a proposito: ver `Control`.
enum Command {
    /// La generacion es la que habia al pedir la reproduccion. Si al atender la
    /// orden ya no es la vigente, un "saltar" se ha cruzado con ella y la frase
    /// no debe sonar.
    Play(PathBuf, u64),
    /// Como `Play`, pero cortando antes lo que suene. Las dos cosas —corte y
    /// encolado— las hace el hilo de audio, en el mismo turno, asi que dos
    /// previews seguidos no pueden solaparse por muy rapido que se pulse.
    PlayExclusive(PathBuf, u64),
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

/// Estado que el hilo de audio comparte con quien pide el control.
///
/// Es lo que hace que `stop()` y `set_volume()` se apliquen **de inmediato**: el
/// hilo de audio se pasa la locucion entera dentro de `sleep_until_end()`, asi
/// que una orden que esperase en el canal no surtiria efecto hasta el final de la
/// frase. Aqui solo hay dos atomos, de modo que el control nunca se queda
/// esperando al audio.
#[derive(Debug)]
struct Control {
    /// Generacion de corte. `stop()` la incrementa y cada `Play` viaja con la
    /// generacion que habia al pedirlo: una orden con una generacion vieja se
    /// descarta (silencio) en lugar de sonar como frase fantasma.
    generation: AtomicU64,
    /// Volumen vigente, en bits de `f32` (un atomo no guarda `f32`). El hilo de
    /// audio lo lee al encolar cada frase, asi que un cambio a media locucion no
    /// se pierde ni lo pisa el volumen que llevaba la orden.
    volume: AtomicU32,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            volume: AtomicU32::new(1.0f32.to_bits()),
        }
    }
}

impl Control {
    fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }

    fn set_volume(&self, volume: f32) {
        self.volume
            .store(clamp_volume(volume).to_bits(), Ordering::Relaxed);
    }

    /// Generacion vigente, para etiquetar una reproduccion.
    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// `true` si la reproduccion etiquetada con `generation` sigue vigente.
    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Acquire) == generation
    }

    /// Marca un corte: invalida cualquier reproduccion ya pedida.
    fn cut(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
}

// ---------------------------------------------------------------------------
// Reproductor del hilo de audio
// ---------------------------------------------------------------------------

/// Reproductor que maneja el hilo de audio.
///
/// El trait es privado y existe por un motivo de prueba: lo dificil de acertar
/// aqui es el **gobierno** del hilo (canal acotado, control directo y generacion
/// de corte), y con el `Sink` de rodio haria falta tarjeta de sonido para
/// probarlo. `RodioDevice` es el unico implementador de produccion; el doble de
/// los tests imita a rodio, bloqueo incluido.
trait Device: Send + Sync + 'static {
    /// Decodifica y encola un fichero. `Err` si no se puede leer o decodificar.
    fn append(&self, file: &Path) -> anyhow::Result<()>;
    /// Volumen en amplitud (la curva de `amplitude` ya aplicada).
    fn set_volume(&self, amplitude: f32);
    /// Corta lo que suene. Es seguro desde cualquier hilo y no bloquea.
    fn stop(&self);
    /// `true` mientras quede algo encolado.
    fn is_playing(&self) -> bool;
    /// Bloquea hasta que la fuente en curso termina **o** alguien la corta.
    fn sleep_until_end(&self);
}

/// Implementacion real sobre un `Sink` de rodio.
///
/// Por que se puede compartir entre hilos: en rodio 0.20 `Sink` es `Send + Sync`
/// (sus campos son `Arc`, `Mutex` y atomos, y la cola de fuentes guarda
/// `Box<dyn Source + Send>` bajo un `Mutex`), y tanto `stop()` — un `AtomicBool`
/// — como `set_volume()` — un cerrojo interno muy corto — son seguros desde
/// cualquier hilo. `Sink` **no** es `Clone`, de ahi que se guarde en un `Arc`.
struct RodioDevice {
    sink: Arc<Sink>,
}

impl Device for RodioDevice {
    fn append(&self, file: &Path) -> anyhow::Result<()> {
        // Un fallo de decodificacion no se puede detectar en `rodio`: la fuente
        // se agota sin avisar. Los ficheros de cache vacios son el sintoma real
        // (una sintesis interrumpida), asi que se comprueba el tamano antes.
        let bytes = std::fs::metadata(file)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if bytes == 0 {
            anyhow::bail!("audio vacio: no se reproduce");
        }
        let handle = std::fs::File::open(file)
            .with_context(|| format!("no se pudo abrir {}", file.display()))?;
        let source = Decoder::new(BufReader::new(handle))
            .with_context(|| format!("audio no decodificable: {}", file.display()))?;
        self.sink.append(source);
        Ok(())
    }

    fn set_volume(&self, amplitude: f32) {
        self.sink.set_volume(amplitude);
    }

    fn stop(&self) {
        // Nada de `clear()`: por dentro vuelve a bloquear en `sleep_until_end`,
        // que es justo lo que este modulo evita. `stop()` solo marca el fin de la
        // fuente; el silencio llega en el bloque de audio siguiente (~5 ms).
        self.sink.stop();
    }

    fn is_playing(&self) -> bool {
        !self.sink.empty()
    }

    fn sleep_until_end(&self) {
        self.sink.sleep_until_end();
    }
}

struct Worker {
    commands: Receiver<Command>,
    /// El flujo debe vivir tanto como el reproductor: al soltarlo, el audio
    /// termina. Se guarda aqui, en el hilo que lo creo. `None` en las pruebas,
    /// que usan un reproductor falso sin dispositivo detras.
    _stream: Option<OutputStream>,
    device: Arc<dyn Device>,
    control: Arc<Control>,
}

impl Worker {
    fn run(self) {
        while let Ok(command) = self.commands.recv() {
            match command {
                Command::Play(path, generation) => self.play(&path, generation, false),
                Command::PlayExclusive(path, generation) => self.play(&path, generation, true),
                Command::IsPlaying(reply) => {
                    let _ = reply.send(self.device.is_playing());
                }
                Command::Wait(reply) => {
                    // Bloquea hasta el final de la frase **o** hasta que un
                    // `stop()` la corte: el corte no pasa por este canal (ver
                    // `Control`), asi que "saltar" no agota la locucion.
                    // Bloquearse aqui es correcto: este es el hilo de audio, no
                    // un worker del runtime.
                    self.device.sleep_until_end();
                    let _ = reply.send(());
                }
                Command::Devices(reply) => {
                    let _ = reply.send(available_devices());
                }
                Command::Shutdown => break,
            }
        }
        self.device.stop();
    }

    /// Encola una frase, salvo que un corte la haya cancelado.
    ///
    /// `exclusivo` corta lo que este sonando **aqui dentro**, en el mismo turno
    /// del hilo de audio que el encolado. Es la unica forma de que "uno a la vez"
    /// valga tambien con dos ordenes seguidas: hechas desde fuera —un `stop()`
    /// del llamante y luego un `play()`— cabria una tercera en medio.
    fn play(&self, path: &Path, generation: u64, exclusivo: bool) {
        if !self.control.is_current(generation) {
            tracing::debug!(file = %path.display(), "frase cancelada por un corte");
            return;
        }
        if exclusivo {
            self.device.stop();
        }
        if let Err(error) = self.device.append(path) {
            tracing::warn!(%error, file = %path.display(), "no se pudo reproducir el audio");
            return;
        }
        // El volumen se lee **ahora**: si ha cambiado mientras la orden esperaba
        // en el canal, vale el ultimo.
        self.device.set_volume(amplitude(self.control.volume()));
        // Y el corte puede haberse colado entre la comprobacion y el encolado: en
        // rodio, encolar rearma el reproductor parado, asi que la unica forma de
        // que un "saltar" inmediato deje silencio es volver a pararlo.
        if !self.control.is_current(generation) {
            self.device.stop();
        }
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

/// Piezas del hilo de audio: el flujo, el nombre del dispositivo y el
/// reproductor.
struct Started {
    /// El flujo de `cpal`, que debe vivir tanto como el reproductor. `None` solo
    /// en las pruebas, que no abren ningun dispositivo.
    stream: Option<OutputStream>,
    /// Nombre del dispositivo, para mostrarlo en la interfaz.
    name: String,
    device: Arc<dyn Device>,
}

/// Salida real con `rodio`: un flujo persistente en un hilo propio.
pub struct RodioSink {
    commands: SyncSender<Command>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
    error: Arc<Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
    /// Nombre del dispositivo en uso.
    name: String,
    /// El reproductor, compartido con el hilo de audio: `stop()` y
    /// `set_volume()` van **directos** aqui (ver `Control`).
    player: Arc<dyn Device>,
    /// Volumen vigente y generacion de corte, compartidos con el hilo.
    control: Arc<Control>,
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
        Self::spawn(move || open_player(requested.as_deref()))
    }

    /// Crea el hilo de audio y espera a saber si el dispositivo se abrio.
    ///
    /// El resultado se devuelve por canal en lugar de devolver el flujo: mover
    /// un `cpal::Stream` entre hilos no es portable, y el hilo debe ser su dueno.
    /// Por el mismo canal viaja el reproductor ya creado, que si es `Send + Sync`
    /// y lo comparten las dos partes.
    fn spawn(
        start: impl FnOnce() -> anyhow::Result<Started> + Send + 'static,
    ) -> anyhow::Result<Self> {
        let (command_tx, command_rx) = mpsc::sync_channel::<Command>(COMMAND_CAPACITY);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(String, Arc<dyn Device>), String>>();
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let control = Arc::new(Control::default());

        let thread_error = error.clone();
        let thread_control = control.clone();
        let thread = thread::Builder::new()
            .name("tts-audio".into())
            .spawn(move || match start() {
                Ok(Started {
                    stream,
                    name,
                    device,
                }) => {
                    // El reproductor se publica al proceso antes de entrar en el
                    // bucle: a partir de aqui `stop()` y `set_volume()` no
                    // dependen del canal.
                    let _ = ready_tx.send(Ok((name, device.clone())));
                    Worker {
                        commands: command_rx,
                        _stream: stream,
                        device,
                        control: thread_control,
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
            Ok(Ok((name, player))) => Ok(Self {
                commands: command_tx,
                thread: Mutex::new(Some(thread)),
                error,
                dropped,
                name,
                player,
                control,
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
        &self.name
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
            Err(TrySendError::Disconnected(_)) => Err(anyhow::anyhow!("el hilo de audio termino")),
        }
    }
}

/// Abre el flujo de salida y crea el reproductor. Se ejecuta **en el hilo de
/// audio**, que es el unico que puede abrir el dispositivo.
///
/// Elige el dispositivo por nombre si se pidio; si el nombre no existe, falla en
/// lugar de usar otro en silencio: el streamer debe saber que su cable virtual no
/// se abrio.
fn open_player(device: Option<&str>) -> anyhow::Result<Started> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    let (stream, name, handle) = match device {
        None => {
            let (stream, handle) = OutputStream::try_default().map_err(|error| {
                anyhow::anyhow!("no hay dispositivo de salida de audio: {error}")
            })?;
            (stream, "dispositivo por defecto".to_string(), handle)
        }
        Some(name) => {
            let host = rodio::cpal::default_host();
            let chosen = host
                .output_devices()
                .map_err(|error| {
                    anyhow::anyhow!("no se pudieron listar los dispositivos: {error}")
                })?
                .find(|candidate| {
                    candidate
                        .name()
                        .map(|current| current == name)
                        .unwrap_or(false)
                });
            match chosen {
                Some(chosen) => {
                    let (stream, handle) =
                        OutputStream::try_from_device(&chosen).map_err(|error| {
                            anyhow::anyhow!("no se pudo abrir el dispositivo {name}: {error}")
                        })?;
                    (stream, name.to_string(), handle)
                }
                None => return Err(anyhow::anyhow!("no existe el dispositivo de salida {name}")),
            }
        }
    };

    let sink = Sink::try_new(&handle)
        .map_err(|error| anyhow::anyhow!("no se pudo crear el reproductor: {error}"))?;
    Ok(Started {
        stream: Some(stream),
        name,
        device: Arc::new(RodioDevice {
            sink: Arc::new(sink),
        }),
    })
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
        // El volumen viaja por el estado compartido, no por la orden: el hilo de
        // audio aplica el ultimo valor pedido, asi que un `set_volume` a media
        // frase no se pisa con el volumen que llevaba la orden.
        self.control.set_volume(volume);
        let generation = self.control.generation();
        self.send(Command::Play(file.to_path_buf(), generation))
    }

    /// Igual que `play`, pero el corte viaja **en la misma orden**: cuando el
    /// hilo de audio la atiende, para y encola sin soltar el turno.
    fn play_exclusive(&self, file: &Path, volume: f32) -> anyhow::Result<()> {
        self.control.set_volume(volume);
        let generation = self.control.generation();
        self.send(Command::PlayExclusive(file.to_path_buf(), generation))
    }

    fn stop(&self) {
        // Primero se marca el corte y despues se para el reproductor: cualquier
        // `Play` que ya este en el canal queda invalidado por la generacion
        // (silencio, nunca una frase fantasma).
        self.control.cut();
        self.player.stop();
    }

    fn set_volume(&self, volume: f32) {
        let volume = clamp_volume(volume);
        self.control.set_volume(volume);
        // Directo al reproductor: si el hilo de audio esta esperando el final de
        // la frase en curso, el cambio se oye igual.
        self.player.set_volume(amplitude(volume));
    }

    fn is_playing(&self) -> bool {
        // Va por el canal **a proposito**: el canal es FIFO, asi que la respuesta
        // llega despues de que el hilo haya atendido el `Play` anterior.
        // Preguntandolo directo al reproductor habria una carrera (un `play`
        // recien enviado todavia no esta encolado) y el gestor sacaria la frase
        // siguiente antes de tiempo.
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

    fn device_name(&self) -> Option<String> {
        Some(self.name.clone())
    }
}

impl Drop for RodioSink {
    fn drop(&mut self) {
        // Se corta el audio antes de cerrar el hilo: si el worker esta esperando
        // el final de una frase, `stop()` le despierta al momento y el cierre no
        // tiene que agotar el plazo de gracia.
        self.player.stop();
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

    fn device_name(&self) -> Option<String> {
        None
    }
}

/// Envuelve la salida elegida y **degrada** en lugar de fallar.
///
/// Si al arrancar no hay dispositivo, el gestor debe seguir vivo: se queda con
/// un `NullSink`, guarda el motivo y lo publica en el estado. El streamer ve
/// "audio no disponible" en la pagina de TTS en lugar de un TTS que no responde.
///
/// Ademas se puede **apagar el audio por entorno** (`TTSDASH_AUDIO=off`). No es
/// un capricho: en un servidor de integracion continua no hay tarjeta de sonido
/// y el backend de WASAPI no devuelve un error, **revienta el proceso** con un
/// `STATUS_ACCESS_VIOLATION` (0xC0000005) al enumerar salidas. Preguntar antes
/// de tocar el dispositivo es la unica forma de que la suite pueda correr ahi.
pub struct FallbackSink {
    inner: Arc<dyn AudioSink>,
    /// `None` si el dispositivo real se abrio.
    problem: Option<String>,
}

/// Motivo por el que el audio esta apagado, si lo esta.
///
/// Se lee del entorno en un unico sitio para que el comportamiento sea el mismo
/// en el arranque de la aplicacion, en los tests y en el cambio de dispositivo.
pub fn disabled_reason() -> Option<String> {
    audio_disabled_reason(std::env::var("TTSDASH_AUDIO").ok().as_deref())
}

/// Decide si el audio esta apagado a partir del valor de `TTSDASH_AUDIO`.
///
/// Es una funcion pura para poder probarla sin tocar el entorno del proceso
/// (las variables de entorno son globales y los tests corren en paralelo).
fn audio_disabled_reason(value: Option<&str>) -> Option<String> {
    let value = value?.trim().to_ascii_lowercase();
    match value.as_str() {
        "off" | "0" | "no" | "none" | "null" => {
            Some("audio desactivado por TTSDASH_AUDIO".to_string())
        }
        _ => None,
    }
}

impl FallbackSink {
    /// Intenta abrir `rodio`; si no puede, devuelve un sink mudo con el motivo.
    pub fn new() -> Self {
        if let Some(problem) = disabled_reason() {
            tracing::info!(%problem, "TTS arrancado sin salida de audio (entorno)");
            return Self {
                inner: Arc::new(NullSink::new()),
                problem: Some(problem),
            };
        }
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
        if let Some(problem) = disabled_reason() {
            return Self {
                inner: Arc::new(NullSink::new()),
                problem: Some(problem),
            };
        }
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

    /// Se releva tal cual: si el sink de dentro sabe hacerlo atomico —`rodio`—,
    /// el envoltorio no puede romperlo partiendo la orden en dos.
    fn play_exclusive(&self, file: &Path, volume: f32) -> anyhow::Result<()> {
        self.inner.play_exclusive(file, volume)
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

    fn device_name(&self) -> Option<String> {
        self.inner.device_name()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Condvar;
    use std::time::Instant;

    /// Plazo maximo de una espera del doble. Un test mal escrito no puede dejar
    /// el hilo de audio colgado para siempre.
    const ESPERA_MAXIMA: Duration = Duration::from_secs(2);

    fn temporal(name: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "ttdash-player-{}-{unique}-{name}",
            std::process::id()
        ))
    }

    /// Reproductor falso que **imita a rodio**, bloqueo incluido: al encolar una
    /// fuente queda "sonando" y `sleep_until_end` no vuelve hasta que la fuente
    /// termina (lo libera el test) o alguien la corta con `stop()`.
    ///
    /// Es lo que faltaba para reproducir el fallo F1: los demas dobles devolvian
    /// `is_playing() == false`, asi que el gobierno del hilo de audio (un `stop`
    /// o un `set_volume` que solo se atendian al final de la frase) no se veia
    /// desde un test sin tarjeta de sonido.
    struct FakeDevice {
        state: Mutex<FakeState>,
        changed: Condvar,
        volume: Mutex<f32>,
    }

    #[derive(Default)]
    struct FakeState {
        /// Hay una fuente encolada y sin cortar.
        playing: bool,
        /// La fuente en curso ha llegado a su final (lo decide el test).
        finished: bool,
        /// Hay una espera bloqueada ahora mismo.
        waiting: bool,
        /// Esperas que termino un `stop()`.
        cuts: u64,
        /// Cortes pedidos, con espera o sin ella. Es lo que distingue una
        /// reproduccion que **encola** de una que **reemplaza**.
        stops: u64,
        appended: Vec<PathBuf>,
    }

    impl FakeDevice {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                state: Mutex::new(FakeState::default()),
                changed: Condvar::new(),
                volume: Mutex::new(1.0),
            })
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
            self.state.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// Libera la frase en curso como si el audio hubiera terminado solo.
        fn finish(&self) {
            self.lock().finished = true;
            self.changed.notify_all();
        }

        fn volume(&self) -> f32 {
            *self.volume.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// Espera (con plazo) a que el hilo de audio cumpla una condicion: el
        /// `play` publico solo envia una orden, no reproduce.
        fn wait_until(&self, mut condition: impl FnMut(&FakeState) -> bool) -> bool {
            for _ in 0..400 {
                if condition(&self.lock()) {
                    return true;
                }
                thread::sleep(Duration::from_millis(5));
            }
            false
        }
    }

    impl Device for FakeDevice {
        fn append(&self, file: &Path) -> anyhow::Result<()> {
            let mut state = self.lock();
            state.appended.push(file.to_path_buf());
            state.playing = true;
            state.finished = false;
            Ok(())
        }

        fn set_volume(&self, amplitude: f32) {
            *self.volume.lock().unwrap_or_else(|e| e.into_inner()) = amplitude;
        }

        fn stop(&self) {
            let mut state = self.lock();
            state.stops += 1;
            if state.waiting {
                state.cuts += 1;
            }
            // Un corte termina la espera en curso igual que en rodio: la fuente
            // se descarta en el bloque de audio siguiente (~5 ms).
            state.playing = false;
            state.finished = true;
            drop(state);
            self.changed.notify_all();
        }

        fn is_playing(&self) -> bool {
            self.lock().playing
        }

        fn sleep_until_end(&self) {
            let mut state = self.lock();
            state.waiting = true;
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

    impl RodioSink {
        /// Salida con el reproductor falso: el hilo de audio, el canal y el
        /// control son los de produccion; lo unico que cambia es el dispositivo.
        fn with_fake(device: Arc<dyn Device>) -> anyhow::Result<Self> {
            Self::spawn(move || {
                Ok(Started {
                    stream: None,
                    name: "prueba".into(),
                    device,
                })
            })
        }
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
        // Con el audio apagado por entorno ni se intenta: en un servidor sin
        // tarjeta, WASAPI no devuelve error, revienta el proceso.
        if let Some(problem) = disabled_reason() {
            eprintln!("audio apagado por entorno, test omitido: {problem}");
            return;
        }
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

    #[test]
    fn el_audio_se_puede_apagar_por_entorno() {
        // Es una funcion pura a proposito: el valor se prueba aqui y el entorno
        // del proceso se lee en un unico sitio (`disabled_reason`), porque las
        // variables de entorno son globales y los tests corren en paralelo.
        for valor in ["off", "OFF", " 0 ", "no", "none", "null", "Off"] {
            assert!(
                audio_disabled_reason(Some(valor)).is_some(),
                "{valor:?} deberia apagar el audio"
            );
        }
        for valor in [None, Some(""), Some(" "), Some("on"), Some("default")] {
            assert!(
                audio_disabled_reason(valor).is_none(),
                "{valor:?} no deberia apagar el audio"
            );
        }
    }

    #[test]
    fn el_control_compartido_es_puro_y_marca_los_cortes() {
        // El estado que comparten el gestor y el hilo de audio son dos atomos:
        // su semantica se puede fijar sin dispositivo ni esperas.
        let control = Control::default();
        assert_eq!(control.volume(), 1.0, "arranca a volumen completo");
        control.set_volume(0.4);
        assert_eq!(control.volume(), 0.4);
        // Fuera de rango se recorta y un NaN no deja el audio mudo.
        control.set_volume(3.0);
        assert_eq!(control.volume(), 1.0);
        control.set_volume(f32::NAN);
        assert_eq!(control.volume(), 1.0);

        // La generacion distingue la reproduccion vigente de la cancelada.
        let generation = control.generation();
        assert!(control.is_current(generation));
        control.cut();
        assert!(
            !control.is_current(generation),
            "un stop cancela el play pendiente"
        );
        assert!(control.is_current(control.generation()));
    }

    /// Un preview **reemplaza** lo que sonaba; no se suma.
    ///
    /// Era el fallo de «oir A, oir B y seguir sonando A»: los dos previews
    /// entraban en la misma cola de `rodio` y sonaban a la vez. El corte viaja en
    /// la misma orden que el encolado, asi que el segundo no puede colarse.
    #[test]
    fn un_preview_reemplaza_lo_que_sonaba() {
        let fake = FakeDevice::new();
        let sink = Arc::new(RodioSink::with_fake(fake.clone()).expect("hilo de audio"));
        let campana = temporal("campana.mp3");
        let redoble = temporal("redoble.mp3");

        // El primero corta tambien: no se da por hecho que el monitor estuviera
        // mudo, porque puede haber sonado cualquier cosa antes.
        sink.play_exclusive(&campana, 1.0)
            .expect("la orden se acepta");
        assert!(fake.wait_until(|state| state.appended.len() == 1));
        assert_eq!(fake.lock().stops, 1, "un preview corta por delante");

        sink.play_exclusive(&redoble, 1.0)
            .expect("la orden se acepta");
        assert!(fake.wait_until(|state| state.appended.len() == 2));
        assert_eq!(fake.lock().stops, 2, "el segundo preview corta el primero");
        assert_eq!(
            fake.lock().appended,
            vec![campana, redoble],
            "los dos se encolaron, pero el primero ya estaba cortado"
        );
        assert!(sink.is_playing(), "el segundo esta sonando");
    }

    /// Lo contrario, y por eso hay dos caminos: el lector de voz **encola**.
    ///
    /// Dos frases seguidas se leen una detras de otra; pisar la primera seria
    /// comerse parte del chat.
    #[test]
    fn el_lector_de_voz_sigue_encolando() {
        let fake = FakeDevice::new();
        let sink = Arc::new(RodioSink::with_fake(fake.clone()).expect("hilo de audio"));

        sink.play(&temporal("frase-1.mp3"), 1.0)
            .expect("la orden se acepta");
        sink.play(&temporal("frase-2.mp3"), 1.0)
            .expect("la orden se acepta");

        assert!(fake.wait_until(|state| state.appended.len() == 2));
        assert_eq!(fake.lock().stops, 0, "encolar no corta nada");
    }

    #[test]
    fn saltar_corta_la_espera_en_curso_y_el_volumen_no_espera_al_final() {
        let fake = FakeDevice::new();
        let sink = Arc::new(RodioSink::with_fake(fake.clone()).expect("hilo de audio"));
        let file = temporal("locucion.mp3");

        // `play` solo encola la orden: la reproduccion ocurre en el hilo de audio.
        sink.play(&file, 1.0).expect("la orden se acepta");
        assert!(
            fake.wait_until(|state| !state.appended.is_empty()),
            "el hilo deberia haber encolado la frase"
        );
        assert!(sink.is_playing());

        // La espera del gestor, en otro hilo (como el `spawn_blocking` real).
        let esperando = {
            let sink = sink.clone();
            thread::spawn(move || sink.wait())
        };
        assert!(
            fake.wait_until(|state| state.waiting),
            "la espera deberia estar en curso"
        );

        // El volumen de una frase que ya esta sonando cambia **ya**: no puede
        // quedarse esperando al final de la locucion.
        sink.set_volume(0.5);
        assert_eq!(
            fake.volume(),
            amplitude(0.5),
            "el volumen debe llegar sin esperar al final"
        );

        // Y "saltar" corta la espera en curso de inmediato.
        let inicio = Instant::now();
        sink.stop();
        esperando.join().expect("la espera termina");
        let tardanza = inicio.elapsed();
        assert!(
            tardanza < Duration::from_secs(1),
            "saltar debe cortar la espera ya, tardo {tardanza:?}"
        );
        assert_eq!(fake.lock().cuts, 1, "el corte lo noto la espera en curso");
        assert!(!sink.is_playing());
    }

    #[test]
    fn un_play_que_se_cruza_con_un_stop_no_deja_frase_fantasma() {
        let fake = FakeDevice::new();
        let sink = Arc::new(RodioSink::with_fake(fake.clone()).expect("hilo de audio"));
        let primera = temporal("primera.mp3");
        let fantasma = temporal("fantasma.mp3");

        sink.play(&primera, 1.0).expect("la orden se acepta");
        assert!(fake.wait_until(|state| !state.appended.is_empty()));
        let esperando = {
            let sink = sink.clone();
            thread::spawn(move || sink.wait())
        };
        assert!(
            fake.wait_until(|state| state.waiting),
            "la frase esta sonando"
        );

        // Con el hilo ocupado esperando, llega al canal otra frase y, detras, un
        // "saltar": el corte tiene que invalidar tambien la orden pendiente. Si
        // no, rodio rearma el reproductor al encolarla y suena una frase fantasma.
        sink.play(&fantasma, 1.0).expect("la orden se acepta");
        sink.stop();
        esperando.join().expect("la espera termina");

        // `is_playing` viaja por el mismo canal FIFO: cuando responde, la orden
        // pendiente ya se ha atendido.
        assert!(!sink.is_playing(), "la frase fantasma no debe sonar");
        assert_eq!(
            fake.lock().appended,
            vec![primera],
            "solo la primera llego al reproductor"
        );
    }

    #[test]
    fn un_stop_inmediato_deja_silencio() {
        // El `Play` y el `stop()` pueden cruzarse en cualquier orden: el resultado
        // tiene que ser silencio igual.
        let fake = FakeDevice::new();
        let sink = RodioSink::with_fake(fake.clone()).expect("hilo de audio");
        let file = temporal("cruzada.mp3");

        sink.play(&file, 1.0).expect("la orden se acepta");
        sink.stop();

        assert!(!sink.is_playing(), "no puede quedar nada sonando");
        assert!(
            !fake.lock().playing,
            "el reproductor tiene que haber parado"
        );
    }

    #[test]
    fn una_locucion_que_termina_sola_no_cuenta_como_corte() {
        // El final natural y el corte se tienen que poder distinguir: si no, el
        // gestor contaria como "saltada" cada frase que termina sola.
        let fake = FakeDevice::new();
        let sink = Arc::new(RodioSink::with_fake(fake.clone()).expect("hilo de audio"));
        let file = temporal("natural.mp3");

        sink.play(&file, 1.0).expect("la orden se acepta");
        assert!(fake.wait_until(|state| !state.appended.is_empty()));
        let esperando = {
            let sink = sink.clone();
            thread::spawn(move || sink.wait())
        };
        assert!(fake.wait_until(|state| state.waiting));

        fake.finish();
        esperando.join().expect("la espera termina");
        assert_eq!(fake.lock().cuts, 0, "nadie corto la locucion");
        assert!(!sink.is_playing());
    }
}
