//! Proveedor de TTS: cliente del sidecar de sintesis.
//!
//! Interfaz `TtsProvider` (docs/plan-review.md §12) con una implementacion
//! basada en el sidecar Python de `edge-tts`. Rust no sabe nada de Python: solo
//! habla JSON Lines por stdin/stdout.
//!
//! Detalles que importan en Windows y en produccion:
//!   * el proceso se lanza con `CREATE_NO_WINDOW` (si no, parpadea una consola);
//!   * stdout es **solo** protocolo; los logs del sidecar se reenvian a stderr
//!     desde una tarea aparte;
//!   * toda lectura tiene timeout y **tope de longitud**: un sidecar roto no
//!     puede colgar ni inundar la aplicacion;
//!   * si el proceso muere, se reinicia de forma perezosa en la siguiente
//!     peticion.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, Notify};
use tokio::time::timeout;

use crate::providers::BoxFuture;

/// Tope de una linea del protocolo. El cuerpo mas grande esperado son unos
/// cientos de bytes; 64 KB deja margen de sobra.
const MAX_LINE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct TtsConfig {
    /// Ejecutable congelado por PyInstaller. Cuando existe, se usa sin Python
    /// ni script: es el modo de distribución de Tauri.
    pub executable: Option<PathBuf>,
    /// Interprete de Python. En desarrollo, el del venv del proyecto.
    pub python: PathBuf,
    /// Script del sidecar.
    pub script: PathBuf,
    /// Carpeta de audio sintetizado.
    pub cache_dir: PathBuf,
    /// Timeout de una sintesis.
    pub timeout: Duration,
    /// Tope de la cache en disco y antiguedad maxima.
    pub cache_max_bytes: u64,
    pub cache_max_age: Duration,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            executable: None,
            python: PathBuf::from("python"),
            script: PathBuf::from("services/tts-provider/src/main.py"),
            cache_dir: crate::database::data_dir().join("cache").join("tts"),
            timeout: Duration::from_secs(20),
            cache_max_bytes: 200 * 1024 * 1024,
            cache_max_age: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }
}

/// Una frase a sintetizar.
///
/// La velocidad y el tono viajan **con la peticion**, no en la configuracion del
/// proveedor: antes vivian en `TtsConfig` y el control de velocidad de la
/// interfaz solo cambiaba el ajuste del gestor, de modo que la sintesis seguia
/// saliendo a `+0%` (ver docs/decisions.md D12). Con un unico dueño del dato
/// —los ajustes del gestor— ese desajuste no puede repetirse.
#[derive(Debug, Clone)]
pub struct TtsRequest {
    pub id: u64,
    pub text: String,
    pub voice: String,
    pub rate: String,
    pub pitch: String,
}

/// Señal cooperativa para cancelar una síntesis en vuelo.
///
/// Se comparte por valor entre el gestor y el proveedor. La rama del proveedor
/// no solo abandona el futuro: `EdgeTtsSidecar` mata el proceso que está ocupado
/// con `edge-tts`, de modo que no queda una respuesta atrasada ni un fichero
/// parcial para la siguiente frase.
#[derive(Clone, Default)]
pub struct TtsCancellation {
    state: Arc<CancellationState>,
}

#[derive(Default)]
struct CancellationState {
    cancelled: std::sync::atomic::AtomicBool,
    notify: Notify,
}

impl TtsCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self
            .state
            .cancelled
            .swap(true, std::sync::atomic::Ordering::Release)
        {
            self.state.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.state
            .cancelled
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub(crate) fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.state.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TtsAudio {
    pub path: PathBuf,
    pub bytes: u64,
    pub ms: u64,
    /// `true` si se reutilizo un fichero ya sintetizado.
    pub cached: bool,
}

pub trait TtsProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn synthesize<'a>(&'a self, request: &'a TtsRequest) -> BoxFuture<'a, Result<TtsAudio>>;
    /// Variante cancelable para el camino interactivo del gestor.
    ///
    /// El método antiguo se conserva como contrato mínimo para providers
    /// sencillos y dobles de prueba. Los providers que tienen una operación
    /// realmente abortable deben sobrescribir esta variante.
    fn synthesize_with_cancel<'a>(
        &'a self,
        request: &'a TtsRequest,
        cancel: TtsCancellation,
    ) -> BoxFuture<'a, Result<TtsAudio>> {
        Box::pin(async move {
            tokio::select! {
                result = self.synthesize(request) => result,
                _ = cancel.cancelled() => bail!("síntesis cancelada"),
            }
        })
    }
    fn health<'a>(&'a self) -> BoxFuture<'a, bool>;
    fn available_voices<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>>>;
    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()>;
    /// Poda la cache en disco del proveedor. Devuelve cuantos ficheros borro.
    ///
    /// Quien decide **cuando** podar es el gestor (es el unico que sabe cuantas
    /// frases se han leido y por tanto cuando toca); los **topes** son del
    /// proveedor, que es el dueno de la carpeta y de su configuracion. Por
    /// defecto no hace nada: un proveedor sin cache en disco no tiene nada que
    /// podar. Sin esto, la cache solo se podaba desde el CLI (`--tts-test`) y en
    /// la aplicacion crecia sin limite.
    fn prune_cache(&self) -> usize {
        0
    }
}

// ---------------------------------------------------------------------------
// Protocolo
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct SidecarRequest<'a> {
    id: u64,
    cmd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rate: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pitch: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    out: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SidecarResponse {
    id: Option<u64>,
    ok: bool,
    path: Option<String>,
    bytes: Option<u64>,
    ms: Option<u64>,
    error: Option<String>,
    voices: Option<Vec<SidecarVoice>>,
}

#[derive(Debug, Deserialize)]
struct SidecarVoice {
    name: String,
}

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

async fn stop_sidecar(sidecar: &mut Option<Sidecar>) {
    if let Some(mut sidecar) = sidecar.take() {
        let _ = sidecar.stdin.shutdown().await;
        let _ = sidecar.child.start_kill();
        let _ = sidecar.child.wait().await;
    }
}

/// Salida temporal que se borra incluso si la tarea de síntesis es abortada.
/// Solo se conserva después de que `rename` haya publicado el MP3 completo.
struct TempOutput {
    path: PathBuf,
    keep: std::sync::atomic::AtomicBool,
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl TempOutput {
    fn new(final_path: &Path, request_id: u64) -> Self {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let unique = format!(
            ".{}.{}.{}.{}.tmp.mp3",
            final_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("tts"),
            std::process::id(),
            request_id,
            sequence
        );
        Self {
            path: final_path.with_file_name(unique),
            keep: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn keep(&self) {
        self.keep.store(true, Ordering::Release);
    }
}

impl Drop for TempOutput {
    fn drop(&mut self) {
        if !self.keep.load(Ordering::Acquire) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn valid_audio_file(path: &Path) -> Option<u64> {
    let metadata = std::fs::metadata(path).ok()?;
    (metadata.is_file() && metadata.len() > 0).then_some(metadata.len())
}

fn validate_output(response: &SidecarResponse, expected: &Path) -> Result<()> {
    if let Some(reported) = response.path.as_deref() {
        let reported = PathBuf::from(reported);
        let expected = std::fs::canonicalize(expected)
            .with_context(|| format!("validando la salida temporal {}", expected.display()))?;
        let reported = std::fs::canonicalize(&reported).with_context(|| {
            format!(
                "validando la ruta declarada por el sidecar {}",
                reported.display()
            )
        })?;
        if reported != expected {
            bail!(
                "el sidecar declaro una salida distinta a la temporal: {}",
                reported.display()
            );
        }
    }

    let actual = valid_audio_file(expected)
        .ok_or_else(|| anyhow!("el sidecar produjo un fichero de audio vacio o ausente"))?;
    if let Some(declared) = response.bytes {
        if declared != actual {
            bail!("tamano de audio inconsistente: el sidecar declaro {declared}, hay {actual}");
        }
    }
    Ok(())
}

pub struct EdgeTtsSidecar {
    config: TtsConfig,
    inner: Mutex<Option<Sidecar>>,
    starts: AtomicU64,
    requests: AtomicU64,
    failures: AtomicU64,
    cache_hits: AtomicU64,
}

/// Lee una linea del protocolo con **tope de longitud**.
///
/// El tope se aplica **al leer** (`take`), no despues de tener la linea entera:
/// si no, un sidecar roto podria hacer crecer el buffer hasta agotar la memoria
/// antes de que nadie comprobase su tamano, que es justo lo que el tope pretende
/// evitar. Va aparte de `request` para poder probarlo sin arrancar el sidecar.
async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>> {
    let mut buffer = Vec::new();
    // Un byte de mas deja sitio al `\n` de una linea que llega justo al tope.
    let limit = MAX_LINE_BYTES as u64 + 1;
    let read = reader
        .take(limit)
        .read_until(b'\n', &mut buffer)
        .await
        .context("leyendo del sidecar")?;
    if read == 0 {
        bail!("el sidecar cerro la salida");
    }
    // Sin el `\n` final y ya en el tope, la linea venia cortada: es demasiado
    // larga y se rechaza con un motivo claro.
    if !buffer.ends_with(b"\n") && buffer.len() > MAX_LINE_BYTES {
        bail!("linea de protocolo demasiado larga (mas de {MAX_LINE_BYTES} bytes)");
    }
    Ok(buffer)
}

impl EdgeTtsSidecar {
    pub fn new(config: TtsConfig) -> Self {
        Self {
            config,
            inner: Mutex::new(None),
            starts: AtomicU64::new(0),
            requests: AtomicU64::new(0),
            failures: AtomicU64::new(0),
            cache_hits: AtomicU64::new(0),
        }
    }

    pub fn config(&self) -> &TtsConfig {
        &self.config
    }

    pub fn stats(&self) -> (u64, u64, u64, u64) {
        (
            self.starts.load(Ordering::Relaxed),
            self.requests.load(Ordering::Relaxed),
            self.failures.load(Ordering::Relaxed),
            self.cache_hits.load(Ordering::Relaxed),
        )
    }

    /// Ruta en cache para una frase. La clave incluye voz, velocidad, tono y
    /// texto: cambiar cualquiera de ellos produce otro fichero, asi que subir la
    /// velocidad no reutiliza el audio viejo.
    pub fn cache_path(&self, request: &TtsRequest) -> PathBuf {
        let key = cache_key(&request.voice, &request.rate, &request.pitch, &request.text);
        self.config.cache_dir.join(format!("{key}.mp3"))
    }

    async fn start(&self) -> Result<Sidecar> {
        std::fs::create_dir_all(&self.config.cache_dir)
            .with_context(|| format!("creando {}", self.config.cache_dir.display()))?;

        let mut command = if let Some(executable) = &self.config.executable {
            if !executable.is_file() {
                bail!(
                    "el ejecutable del sidecar no existe: {} (override TTSDASH_TTS_SIDECAR o artefacto Tauri)",
                    executable.display()
                );
            }
            Command::new(executable)
        } else {
            if !self.config.script.exists() {
                bail!(
                    "no se encuentra el script del sidecar de TTS en {} y no hay ejecutable congelado; ejecuta scripts/setup.ps1 y scripts/build-tts-sidecar.ps1",
                    self.config.script.display()
                );
            }
            let mut command = Command::new(&self.config.python);
            command.arg(&self.config.script);
            command
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8");

        // Sin consola parpadeando en cada arranque.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let launch_path = self
            .config
            .executable
            .as_ref()
            .unwrap_or(&self.config.python);
        let mut child = command
            .spawn()
            .with_context(|| format!("arrancando el sidecar con {}", launch_path.display()))?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("sin stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("sin stdout"))?;
        let stderr = child.stderr.take();

        // Los logs del sidecar van a stderr: se reenvian para no perderlos, pero
        // jamas se mezclan con el protocolo.
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "tts_sidecar", "{line}");
                }
            });
        }

        self.starts.fetch_add(1, Ordering::Relaxed);
        tracing::info!(runtime = %launch_path.display(), "sidecar de TTS arrancado");
        Ok(Sidecar {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    /// Detiene el sidecar si esta vivo. Es idempotente.
    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        stop_sidecar(&mut *guard).await;
    }

    /// Envia una peticion y espera su respuesta.
    async fn request(
        &self,
        request: SidecarRequest<'_>,
        cancel: TtsCancellation,
    ) -> Result<SidecarResponse> {
        let mut guard = self.inner.lock().await;
        if guard.is_none() {
            *guard = Some(self.start().await?);
        }
        let sidecar = guard.as_mut().expect("sidecar recien arrancado");

        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        self.requests.fetch_add(1, Ordering::Relaxed);

        let result = tokio::select! {
            result = timeout(self.config.timeout, async {
            sidecar
                .stdin
                .write_all(line.as_bytes())
                .await
                .context("escribiendo al sidecar")?;
            sidecar.stdin.flush().await.context("volcando al sidecar")?;

            // Se leen lineas hasta encontrar la respuesta de **esta** peticion.
            loop {
                let buffer = read_line(&mut sidecar.stdout).await?;
                let text = String::from_utf8_lossy(&buffer);
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let parsed: SidecarResponse = match serde_json::from_str(text) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        tracing::warn!(%error, line = text, "respuesta no parseable del sidecar");
                        continue;
                    }
                };
                if parsed.id.is_none() || parsed.id == Some(request.id) {
                    return Ok(parsed);
                }
                tracing::debug!(id = ?parsed.id, "respuesta de otra peticion; se ignora");
                }
            }) => result,
            _ = cancel.cancelled() => {
                stop_sidecar(&mut *guard).await;
                Ok(Err(anyhow!("síntesis cancelada")))
            }
        };

        match result {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) if cancel.is_cancelled() => {
                stop_sidecar(&mut *guard).await;
                Err(error)
            }
            Ok(Err(error)) => {
                // Un fallo de E/S deja el sidecar en estado dudoso: se descarta.
                self.failures.fetch_add(1, Ordering::Relaxed);
                if let Some(mut broken) = guard.take() {
                    let _ = broken.child.start_kill();
                    let _ = broken.child.wait().await;
                }
                Err(error)
            }
            Err(_) => {
                self.failures.fetch_add(1, Ordering::Relaxed);
                if let Some(mut broken) = guard.take() {
                    let _ = broken.child.start_kill();
                    let _ = broken.child.wait().await;
                }
                bail!(
                    "el sidecar de TTS no respondio en {:?}",
                    self.config.timeout
                )
            }
        }
    }

    /// Sintetiza a un fichero, reutilizando la cache si la frase ya se dijo.
    pub async fn synthesize_to_file(&self, request: &TtsRequest) -> Result<TtsAudio> {
        self.synthesize_to_file_with_cancel(request, TtsCancellation::new())
            .await
    }

    /// Variante cancelable usada por el gestor interactivo.
    pub async fn synthesize_to_file_with_cancel(
        &self,
        request: &TtsRequest,
        cancel: TtsCancellation,
    ) -> Result<TtsAudio> {
        let path = self.cache_path(request);
        if let Some(bytes) = valid_audio_file(&path) {
            self.cache_hits.fetch_add(1, Ordering::Relaxed);
            return Ok(TtsAudio {
                path,
                bytes,
                ms: 0,
                cached: true,
            });
        }

        let temporary = TempOutput::new(&path, request.id);
        // Un intento cancelado anterior puede haber dejado un `.tmp.mp3` con
        // el mismo id tras un reinicio del gestor; nunca se valida como salida
        // de esta petición.
        let _ = std::fs::remove_file(&temporary.path);
        let response = self
            .request(
                SidecarRequest {
                    id: request.id,
                    cmd: "synthesize",
                    text: Some(&request.text),
                    voice: Some(&request.voice),
                    rate: Some(&request.rate),
                    pitch: Some(&request.pitch),
                    out: Some(temporary.path.to_string_lossy().to_string()),
                },
                cancel.clone(),
            )
            .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => return Err(error),
        };

        if !response.ok {
            bail!(
                "el sidecar fallo: {}",
                response.error.unwrap_or_else(|| "sin detalle".into())
            );
        }

        if cancel.is_cancelled() {
            bail!("síntesis cancelada");
        }

        validate_output(&response, &temporary.path)?;
        let bytes = valid_audio_file(&temporary.path)
            .ok_or_else(|| anyhow!("el sidecar produjo un audio invalido"))?;

        // `rename` es la publicación atómica: los lectores solo ven un MP3
        // completo. En Windows no reemplaza un destino existente; si otro
        // proceso ganó la carrera y dejó un fichero válido, se reutiliza.
        match std::fs::rename(&temporary.path, &path) {
            Ok(()) => temporary.keep(),
            Err(error) if valid_audio_file(&path).is_some() => {
                tracing::debug!(%error, file = %path.display(), "otra síntesis publicó la misma caché");
            }
            Err(error) => {
                // Un fichero final inválido no se puede reemplazar en Windows
                // con `rename`; al ser una entrada de cache fallida, se elimina
                // antes de volver a publicar el temporal validado.
                if valid_audio_file(&path).is_none() {
                    let _ = std::fs::remove_file(&path);
                    std::fs::rename(&temporary.path, &path).with_context(|| {
                        format!("publicando la cache atomica en {}", path.display())
                    })?;
                    temporary.keep();
                } else {
                    return Err(error).with_context(|| {
                        format!("publicando la cache atomica en {}", path.display())
                    });
                }
            }
        }

        Ok(TtsAudio {
            path,
            bytes,
            ms: response.ms.unwrap_or(0),
            cached: false,
        })
    }
}

impl TtsProvider for EdgeTtsSidecar {
    fn name(&self) -> &'static str {
        "edge-tts"
    }

    fn synthesize<'a>(&'a self, request: &'a TtsRequest) -> BoxFuture<'a, Result<TtsAudio>> {
        Box::pin(async move { self.synthesize_to_file(request).await })
    }

    fn synthesize_with_cancel<'a>(
        &'a self,
        request: &'a TtsRequest,
        cancel: TtsCancellation,
    ) -> BoxFuture<'a, Result<TtsAudio>> {
        Box::pin(async move { self.synthesize_to_file_with_cancel(request, cancel).await })
    }

    fn health<'a>(&'a self) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match self
                .request(
                    SidecarRequest {
                        id: 0,
                        cmd: "ping",
                        text: None,
                        voice: None,
                        rate: None,
                        pitch: None,
                        out: None,
                    },
                    TtsCancellation::new(),
                )
                .await
            {
                Ok(response) => response.ok,
                Err(error) => {
                    tracing::warn!(%error, "el sidecar de TTS no responde");
                    false
                }
            }
        })
    }

    fn available_voices<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let response = self
                .request(
                    SidecarRequest {
                        id: 0,
                        cmd: "voices",
                        text: None,
                        voice: None,
                        rate: None,
                        pitch: None,
                        out: None,
                    },
                    TtsCancellation::new(),
                )
                .await?;
            if !response.ok {
                bail!("el sidecar no devolvio voces");
            }
            Ok(response
                .voices
                .unwrap_or_default()
                .into_iter()
                .map(|voice| voice.name)
                .collect())
        })
    }

    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.stop().await })
    }

    fn prune_cache(&self) -> usize {
        // La logica de poda vive en la funcion libre de este modulo: aqui solo se
        // le pasan los topes y la carpeta de la configuracion, que es de quien es
        // la cache.
        self::prune_cache(
            &self.config.cache_dir,
            self.config.cache_max_bytes,
            self.config.cache_max_age,
            std::time::SystemTime::now(),
        )
    }
}

// ---------------------------------------------------------------------------
// Cache en disco
// ---------------------------------------------------------------------------

/// Clave de cache: FNV-1a sobre voz, velocidad, tono y texto.
///
/// Se implementa a mano en lugar de usar el hasher de la biblioteca estandar
/// porque su salida no esta garantizada entre versiones: con FNV-1a la cache
/// sigue siendo valida tras actualizar el compilador.
pub fn cache_key(voice: &str, rate: &str, pitch: &str, text: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(PRIME);
        }
    };
    feed(voice.as_bytes());
    feed(b"\x1f");
    feed(rate.as_bytes());
    feed(b"\x1f");
    feed(pitch.as_bytes());
    feed(b"\x1f");
    feed(text.as_bytes());
    format!("{hash:016x}")
}

/// Borra los ficheros de cache mas antiguos hasta cumplir los topes.
///
/// Devuelve cuantos borro. La cache **no puede** crecer sin limite
/// (docs/plan-review.md §50).
pub fn prune_cache(dir: &Path, max_bytes: u64, max_age: Duration, now: std::time::SystemTime) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        let modified = metadata.modified().unwrap_or(now);
        total += metadata.len();
        files.push((path, metadata.len(), modified));
    }

    // Primero lo caducado.
    let mut removed = 0usize;
    let mut kept: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    for (path, size, modified) in files {
        let expired = now
            .duration_since(modified)
            .map(|age| age > max_age)
            .unwrap_or(false);
        if expired {
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
                removed += 1;
            }
        } else {
            kept.push((path, size, modified));
        }
    }

    // Despues, los mas antiguos hasta bajar del tope.
    if total > max_bytes {
        kept.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in kept {
            if total <= max_bytes {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
                removed += 1;
            }
        }
    }

    removed
}

/// Comparte el proveedor entre tareas.
pub type SharedTtsProvider = Arc<dyn TtsProvider>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_clave_de_cache_es_estable_y_sensible_a_todo() {
        let base = cache_key("es-ES-ElviraNeural", "+0%", "+0Hz", "hola");
        assert_eq!(base.len(), 16);
        // Estable: el mismo contenido da la misma clave (cache reutilizable).
        assert_eq!(
            base,
            cache_key("es-ES-ElviraNeural", "+0%", "+0Hz", "hola")
        );
        // Cualquier cambio produce otra entrada.
        assert_ne!(base, cache_key("es-ES-AlvaroNeural", "+0%", "+0Hz", "hola"));
        assert_ne!(base, cache_key("es-ES-ElviraNeural", "+10%", "+0Hz", "hola"));
        assert_ne!(base, cache_key("es-ES-ElviraNeural", "+0%", "+5Hz", "hola"));
        assert_ne!(base, cache_key("es-ES-ElviraNeural", "+0%", "+0Hz", "hola!"));
        // Y no confunde campos distintos con el mismo texto concatenado.
        assert_ne!(
            cache_key("a", "b", "c", "d"),
            cache_key("ab", "c", "d", "")
        );
    }

    #[test]
    fn la_cache_conserva_los_limites_de_produccion() {
        let config = TtsConfig::default();
        assert_eq!(config.cache_max_bytes, 200 * 1024 * 1024);
        assert_eq!(config.cache_max_age, Duration::from_secs(7 * 24 * 60 * 60));
    }

    #[test]
    fn la_cache_se_poda_por_caducidad_y_por_tamano() {
        let dir = std::env::temp_dir().join(format!("ttdash-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Los ficheros se crean **antes** de fijar `now`: si no, su fecha de
        // modificacion quedaria en el futuro y nada pareceria caducado.
        for index in 1..=5 {
            std::fs::write(dir.join(format!("{index}.mp3")), vec![0u8; 1000]).unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
        let now = std::time::SystemTime::now();

        // Con 10 KB de tope, hay que borrar hasta bajar: 5 ficheros de 1 KB no
        // superan el tope, asi que no se toca nada.
        assert_eq!(prune_cache(&dir, 10_000, Duration::from_secs(3600), now), 0);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 5);

        // Con 2 KB de tope, se borran al menos 3.
        let removed = prune_cache(&dir, 2_000, Duration::from_secs(3600), now);
        assert!(removed >= 3, "se esperaban al menos 3 borrados, hubo {removed}");
        let restante: u64 = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.metadata().ok())
            .map(|metadata| metadata.len())
            .sum();
        assert!(restante <= 2_000, "quedan {restante} bytes");

        // Todo caduca si la antiguedad maxima es cero.
        let removed = prune_cache(&dir, 10_000, Duration::from_secs(0), now);
        assert!(removed >= 1);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_salida_temporal_se_valida_y_se_publica_atomica() {
        let dir = std::env::temp_dir().join(format!(
            "ttdash-atomic-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("answer.mp3");
        let temporary = TempOutput::new(&final_path, 17);
        std::fs::write(&temporary.path, [1u8, 2, 3, 4]).unwrap();
        let response = SidecarResponse {
            id: Some(17),
            ok: true,
            path: Some(temporary.path.to_string_lossy().into_owned()),
            bytes: Some(4),
            ms: Some(12),
            error: None,
            voices: None,
        };

        validate_output(&response, &temporary.path).unwrap();
        std::fs::rename(&temporary.path, &final_path).unwrap();
        temporary.keep();
        assert_eq!(valid_audio_file(&final_path), Some(4));

        // Un fichero vacio nunca se puede publicar como cache valida.
        let empty = dir.join("empty.mp3");
        std::fs::write(&empty, []).unwrap();
        let error = validate_output(
            &SidecarResponse {
                id: Some(18),
                ok: true,
                path: Some(empty.to_string_lossy().into_owned()),
                bytes: Some(0),
                ms: Some(0),
                error: None,
                voices: None,
            },
            &empty,
        )
        .expect_err("un audio vacio no es una salida valida");
        assert!(error.to_string().contains("vacio o ausente"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_respuesta_del_sidecar_se_parsea() {
        let ok: SidecarResponse = serde_json::from_str(
            r#"{"id": 7, "ok": true, "path": "C:\\x\\a.mp3", "bytes": 16992, "ms": 657}"#,
        )
        .unwrap();
        assert!(ok.ok);
        assert_eq!(ok.id, Some(7));
        assert_eq!(ok.bytes, Some(16992));

        let error: SidecarResponse =
            serde_json::from_str(r#"{"id": 8, "ok": false, "error": "texto vacio"}"#).unwrap();
        assert!(!error.ok);
        assert_eq!(error.error.as_deref(), Some("texto vacio"));

        let pong: SidecarResponse = serde_json::from_str(r#"{"id": 1, "ok": true, "cmd": "pong"}"#).unwrap();
        assert!(pong.ok);

        let voices: SidecarResponse =
            serde_json::from_str(r#"{"ok": true, "voices": [{"name": "es-ES-ElviraNeural"}]}"#)
                .unwrap();
        assert_eq!(voices.voices.unwrap().len(), 1);
    }

    /// F3: el gestor decide **cuando** podar, pero la poda en si tiene que usar
    /// la carpeta y los topes del proveedor. Antes esta llamada no existia en la
    /// interfaz del proveedor, asi que la cache solo la podaba el CLI.
    #[test]
    fn el_proveedor_poda_su_propia_carpeta_con_sus_topes() {
        let dir = std::env::temp_dir().join(format!("ttdash-provider-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for index in 1..=3 {
            std::fs::write(dir.join(format!("{index}.mp3")), vec![0u8; 100]).unwrap();
        }
        // Los ficheros son anteriores a la poda: si no, su fecha podria quedar
        // en el mismo instante que `now` y no parecerian caducados.
        std::thread::sleep(Duration::from_millis(5));

        let mut config = TtsConfig::default();
        config.cache_dir = dir.clone();
        // Todo caduca: es la forma de comprobar el cableado sin esperar 7 dias.
        config.cache_max_age = Duration::from_secs(0);
        let provider = EdgeTtsSidecar::new(config);

        assert_eq!(provider.prune_cache(), 3, "deberia podar su propia carpeta");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F6: el tope de linea se aplica **al leer**. Sin `take`, un sidecar roto
    /// haria crecer el buffer sin limite antes de que nadie mirase su tamano.
    #[tokio::test]
    async fn una_linea_demasiado_larga_se_rechaza_sin_leerla_entera() {
        // Una linea enorme y sin `\n` no puede llegar a memoria completa: con el
        // tope aplicado **al leer**, el lector ni siquiera se agota. Si el tope se
        // comprobase despues (con la linea entera ya leida), los 256 KB habrian
        // pasado por memoria y el lector estaria vacio.
        let enorme = vec![b'x'; MAX_LINE_BYTES * 4];
        let mut lector = BufReader::new(&enorme[..]);
        let error = read_line(&mut lector)
            .await
            .expect_err("deberia rechazar la linea");
        assert!(
            error.to_string().contains("demasiado larga"),
            "motivo inesperado: {error}"
        );
        assert!(
            !lector.into_inner().is_empty(),
            "el tope se aplica al leer, no despues: no puede tragarsela entera"
        );

        // Una linea normal se acepta tal cual.
        let mut lector = BufReader::new(&b"{\"ok\": true}\n"[..]);
        assert_eq!(read_line(&mut lector).await.unwrap(), b"{\"ok\": true}\n");

        // Y una que llega justo al tope tambien: el margen de un byte es para su
        // `\n`, no para colar lineas mas largas.
        let justa = [vec![b'y'; MAX_LINE_BYTES], vec![b'\n']].concat();
        let mut lector = BufReader::new(&justa[..]);
        let leida = read_line(&mut lector).await.unwrap();
        assert_eq!(leida.len(), MAX_LINE_BYTES + 1);
        assert!(leida.ends_with(b"\n"));

        // Un sidecar que cierra la salida se detecta (no se confunde con vacio).
        let mut lector = BufReader::new(&b""[..]);
        let error = read_line(&mut lector).await.expect_err("sin salida");
        assert!(error.to_string().contains("cerro la salida"), "{error}");
    }
}
