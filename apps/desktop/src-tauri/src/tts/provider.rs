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
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::providers::BoxFuture;

/// Tope de una linea del protocolo. El cuerpo mas grande esperado son unos
/// cientos de bytes; 64 KB deja margen de sobra.
const MAX_LINE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct TtsConfig {
    /// Interprete de Python. En desarrollo, el del venv del proyecto.
    pub python: PathBuf,
    /// Script del sidecar.
    pub script: PathBuf,
    /// Carpeta de audio sintetizado.
    pub cache_dir: PathBuf,
    /// Timeout de una sintesis.
    pub timeout: Duration,
    pub rate: String,
    pub pitch: String,
    /// Tope de la cache en disco y antiguedad maxima.
    pub cache_max_bytes: u64,
    pub cache_max_age: Duration,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            python: PathBuf::from("python"),
            script: PathBuf::from("services/tts-provider/src/main.py"),
            cache_dir: crate::database::data_dir().join("cache").join("tts"),
            timeout: Duration::from_secs(20),
            rate: "+0%".into(),
            pitch: "+0Hz".into(),
            cache_max_bytes: 200 * 1024 * 1024,
            cache_max_age: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TtsRequest {
    pub id: u64,
    pub text: String,
    pub voice: String,
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
    fn health<'a>(&'a self) -> BoxFuture<'a, bool>;
    fn available_voices<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>>>;
    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()>;
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

pub struct EdgeTtsSidecar {
    config: TtsConfig,
    inner: Mutex<Option<Sidecar>>,
    starts: AtomicU64,
    requests: AtomicU64,
    failures: AtomicU64,
    cache_hits: AtomicU64,
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
    /// texto: cambiar cualquiera de ellos produce otro fichero.
    pub fn cache_path(&self, voice: &str, text: &str) -> PathBuf {
        let key = cache_key(voice, &self.config.rate, &self.config.pitch, text);
        self.config.cache_dir.join(format!("{key}.mp3"))
    }

    async fn start(&self) -> Result<Sidecar> {
        if !self.config.script.exists() {
            bail!(
                "no se encuentra el sidecar de TTS en {}",
                self.config.script.display()
            );
        }
        std::fs::create_dir_all(&self.config.cache_dir)
            .with_context(|| format!("creando {}", self.config.cache_dir.display()))?;

        let mut command = Command::new(&self.config.python);
        command
            .arg(&self.config.script)
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

        let mut child = command
            .spawn()
            .with_context(|| format!("arrancando el sidecar con {}", self.config.python.display()))?;

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
        tracing::info!(script = %self.config.script.display(), "sidecar de TTS arrancado");
        Ok(Sidecar {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    /// Detiene el sidecar si esta vivo. Es idempotente.
    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut sidecar) = guard.take() {
            let _ = sidecar.stdin.shutdown().await;
            let _ = sidecar.child.start_kill();
            let _ = sidecar.child.wait().await;
        }
    }

    /// Envia una peticion y espera su respuesta.
    async fn request(&self, request: SidecarRequest<'_>) -> Result<SidecarResponse> {
        let mut guard = self.inner.lock().await;
        if guard.is_none() {
            *guard = Some(self.start().await?);
        }
        let sidecar = guard.as_mut().expect("sidecar recien arrancado");

        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        self.requests.fetch_add(1, Ordering::Relaxed);

        let result = timeout(self.config.timeout, async {
            sidecar
                .stdin
                .write_all(line.as_bytes())
                .await
                .context("escribiendo al sidecar")?;
            sidecar.stdin.flush().await.context("volcando al sidecar")?;

            // Se leen lineas hasta encontrar la respuesta de **esta** peticion.
            loop {
                let mut buffer = Vec::new();
                let read = sidecar
                    .stdout
                    .read_until(b'\n', &mut buffer)
                    .await
                    .context("leyendo del sidecar")?;
                if read == 0 {
                    bail!("el sidecar cerro la salida");
                }
                if buffer.len() > MAX_LINE_BYTES {
                    bail!("linea de protocolo demasiado larga ({} bytes)", buffer.len());
                }
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
        })
        .await;

        match result {
            Ok(Ok(response)) => Ok(response),
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
        let path = self.cache_path(&request.voice, &request.text);
        if let Ok(metadata) = std::fs::metadata(&path) {
            if metadata.len() > 0 {
                self.cache_hits.fetch_add(1, Ordering::Relaxed);
                return Ok(TtsAudio {
                    path,
                    bytes: metadata.len(),
                    ms: 0,
                    cached: true,
                });
            }
        }

        let response = self
            .request(SidecarRequest {
                id: request.id,
                cmd: "synthesize",
                text: Some(&request.text),
                voice: Some(&request.voice),
                rate: Some(&self.config.rate),
                pitch: Some(&self.config.pitch),
                out: Some(path.to_string_lossy().to_string()),
            })
            .await?;

        if !response.ok {
            bail!(
                "el sidecar fallo: {}",
                response.error.unwrap_or_else(|| "sin detalle".into())
            );
        }

        // Se respeta la ruta que confirma el sidecar si la devuelve: es la
        // prueba de que escribio exactamente donde se le pidio.
        let path = response
            .path
            .map(PathBuf::from)
            .unwrap_or(path);

        Ok(TtsAudio {
            path,
            bytes: response.bytes.unwrap_or(0),
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

    fn health<'a>(&'a self) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match self
                .request(SidecarRequest {
                    id: 0,
                    cmd: "ping",
                    text: None,
                    voice: None,
                    rate: None,
                    pitch: None,
                    out: None,
                })
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
                .request(SidecarRequest {
                    id: 0,
                    cmd: "voices",
                    text: None,
                    voice: None,
                    rate: None,
                    pitch: None,
                    out: None,
                })
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
}
