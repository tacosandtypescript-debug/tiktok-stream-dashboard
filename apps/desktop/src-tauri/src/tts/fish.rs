//! Proveedor de voz **Fish Audio**: una llamada HTTPS, sin sidecar ni Python.
//!
//! Contrato confirmado en la documentacion oficial antes de escribir esto
//! (`https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech`,
//! contrastado con el esquema `https://api.fish.audio/openapi.json`):
//!
//!   * `POST https://api.fish.audio/v1/tts`
//!   * cabeceras: `Authorization: Bearer <clave>`, `Content-Type: application/json`
//!     y `model: <modelo>` (el modelo viaja en **cabecera**, no en el cuerpo)
//!   * cuerpo JSON: `{"text": "...", "reference_id": "<codigo de voz>",
//!     "format": "mp3"}`
//!   * respuesta correcta: **bytes de audio binarios** (`Content-Type:
//!     audio/mpeg` con `format: mp3`), no JSON ni una URL
//!   * errores: JSON con `message` y `status` (401 clave, 402 sin saldo, 429
//!     demasiado seguido, 503 sobrecarga)
//!
//! El audio se publica en la **misma cache** que la voz de siempre y con el mismo
//! tipo de fichero (MP3), para que la cola, el volumen, la salida de audio
//! configurable y el reproductor de `rodio` no noten la diferencia.
//!
//! # El relevo de claves
//!
//! El streamer puede guardar hasta [`TOPE_CLAVES`] claves y la voz no se puede
//! cortar a mitad de directo porque una se acabe. Cuando una falla, el proveedor
//! decide que hacer segun **que** ha fallado, y esa distincion es el corazon de
//! la funcion:
//!
//! | respuesta | que significa | que se hace |
//! |---|---|---|
//! | 401 | la clave no vale | marcarla **invalida** y pasar a la siguiente. No se reintenta nunca: no se arregla sola |
//! | 402 | esa clave se acabo | marcarla **agotada** y pasar a la siguiente |
//! | 429 | va demasiado rapido | **no** es agotamiento: se espera y se reintenta la **misma**. Cambiar de clave aqui quemaria otra por un problema de ritmo |
//! | 5xx / sin red | el servicio | reintentar la misma con la espera de siempre; no se gasta ninguna clave |
//! | 400 | la peticion esta mal | no se reintenta: el texto no se va a arreglar solo |
//!
//! Confundir un 429 con un agotamiento consume las diez claves en un pico de
//! trafico; por eso cada clase tiene su rama y sus pruebas.
//!
//! La clave **nunca** sale de aqui: entra por `agregar`/`cargar`, vive en un
//! `Secreto` (cuyo `Debug` la redacta) y solo se usa para escribir la cabecera.
//! Los errores se componen a mano para no arrastrar la peticion de `reqwest`, que
//! es por donde se filtraria.

use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};

use crate::providers::BoxFuture;
use crate::secreto::Secreto;

use super::consumo::{bytes_de, Consumo, UsoClave, UsoProveedor};
use super::provider::{
    apply_cached, prune_cache, sink_atomically, valid_audio_file, ErrorVoz, EstadoClave,
    MotivoFallo, ProviderSettings, Readiness, TtsAudio, TtsCancellation, TtsProvider, TtsRequest,
};

/// Endpoint exacto de la referencia de la API.
pub const ENDPOINT: &str = "https://api.fish.audio/v1/tts";

/// Nombre estable del proveedor. Es el mismo que devuelve `name()` y el que se
/// usa como clave en la base para guardar sus claves de API: cambiarlo seria
/// perder las claves ya guardadas.
pub const PROVIDER_ID: &str = "fish-audio";

/// Modelo por defecto: el gratuito.
///
/// Es el de fabrica a proposito. El de pago cuesta 15 $ por millon de bytes de
/// texto, asi que tiene que ser una eleccion consciente del streamer y no un
/// valor que nadie ha mirado.
pub const MODELO_POR_DEFECTO: &str = "s2.1-pro-free";

/// Cuantas claves se pueden guardar.
pub const TOPE_CLAVES: usize = 10;

/// Tope de longitud de una peticion, en bytes UTF-8.
///
/// Los filtros del gestor ya recortan a ~150 caracteres, asi que esto es una red
/// de seguridad para el camino que no pasa por ellos (una lectura manual, un
/// evento nuevo). 4096 bytes son unas 4000 letras: mas de lo que se lee de una
/// tirada y muy por debajo de cualquier limite del servicio.
pub const MAX_TEXTO_BYTES: usize = 4096;

/// Tope del mensaje de error que se guarda y se muestra.
///
/// El error de la API es ajeno: si viniera con media pagina de detalle, esa
/// pagina acabaria en el estado degradado y en la interfaz.
const MAX_ERROR_BYTES: usize = 300;

/// Un modelo y lo que cuesta. La tarifa se publica desde Rust para que la
/// interfaz no tenga su propia copia de los precios.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct ModeloFish {
    pub id: &'static str,
    /// Dolares por millon de bytes UTF-8 de texto de **entrada**.
    pub precio_por_millon: f64,
}

/// Los modelos que acepta la cabecera `model`, con su tarifa.
///
/// Es la tabla de la documentacion de precios: `s2.1-pro`, `s2-pro` y `s1` a
/// 15 $/M bytes, y `s2.1-pro-free` a 0,00 $.
pub const MODELOS: &[ModeloFish] = &[
    ModeloFish {
        id: MODELO_POR_DEFECTO,
        precio_por_millon: 0.0,
    },
    ModeloFish {
        id: "s2.1-pro",
        precio_por_millon: 15.0,
    },
    ModeloFish {
        id: "s2-pro",
        precio_por_millon: 15.0,
    },
    ModeloFish {
        id: "s1",
        precio_por_millon: 15.0,
    },
];

pub fn modelos() -> Vec<ModeloFish> {
    MODELOS.to_vec()
}

/// Configuracion del proveedor. Mismos topes de cache que el resto de la voz.
#[derive(Debug, Clone)]
pub struct FishConfig {
    pub endpoint: String,
    pub cache_dir: PathBuf,
    pub timeout: Duration,
    pub cache_max_bytes: u64,
    pub cache_max_age: Duration,
    /// Espera base entre reintentos de la **misma** clave (429 y 5xx). Se dobla
    /// en cada intento. Los tests la ponen a cero para no esperar de verdad.
    pub espera_reintento: Duration,
    /// Reintentos por clave para 429 y 5xx. Un 401 o un 402 no gastan reintentos:
    /// gastan claves, que es otra cosa.
    pub max_reintentos: u32,
}

impl Default for FishConfig {
    fn default() -> Self {
        Self {
            endpoint: ENDPOINT.to_string(),
            cache_dir: crate::database::data_dir().join("cache").join("tts"),
            timeout: Duration::from_secs(30),
            cache_max_bytes: 200 * 1024 * 1024,
            cache_max_age: Duration::from_secs(7 * 24 * 60 * 60),
            espera_reintento: Duration::from_millis(800),
            max_reintentos: 2,
        }
    }
}

/// Una clave guardada, con su nombre, su estado y su uso.
///
/// **Sin `Debug` derivado**: el de `Secreto` ya redacta el valor, pero ademas asi
/// nadie mete este struct en un `tracing` con `?clave` por descuido.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ClaveGuardada {
    /// Posicion en la lista (0 = la primera que se intenta).
    pub posicion: u64,
    pub nombre: String,
    pub secreto: Secreto,
    pub estado: EstadoClave,
    pub bytes: u64,
    pub llamadas: u64,
    pub micro: i64,
}

impl fmt::Debug for ClaveGuardada {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaveGuardada")
            .field("posicion", &self.posicion)
            .field("nombre", &self.nombre)
            .field("secreto", &self.secreto)
            .field("estado", &self.estado)
            .field("bytes", &self.bytes)
            .field("llamadas", &self.llamadas)
            .field("micro", &self.micro)
            .finish()
    }
}

impl ClaveGuardada {
    pub fn nueva(posicion: u64, nombre: impl Into<String>, secreto: Secreto) -> Self {
        Self {
            posicion,
            nombre: nombre.into(),
            secreto,
            estado: EstadoClave::Viva,
            bytes: 0,
            llamadas: 0,
            micro: 0,
        }
    }

    fn esta_viva(&self) -> bool {
        self.estado == EstadoClave::Viva
    }

    fn status(&self, en_uso: bool) -> UsoClave {
        UsoClave {
            id: self.posicion,
            nombre: self.nombre.clone(),
            // Si no hay pista (una clave vacia guardada a mano) se deja el
            // rotulo de la interfaz, no un hueco.
            pista: self.secreto.pista().unwrap_or_default(),
            estado: self.estado.as_str(),
            en_uso,
            bytes: self.bytes,
            llamadas: self.llamadas,
            micro: self.micro,
        }
    }
}

/// Lo que devuelve el transporte HTTP. Nunca lleva la cabecera de autorizacion ni
/// la peticion: solo el resultado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RespuestaHttp {
    /// Bytes de audio.
    Audio(Vec<u8>),
    /// El servicio contesto con un error HTTP, con su codigo y su mensaje.
    Error { status: u16, mensaje: String },
    /// No se pudo hablar con el servicio (red, DNS, timeout), o la respuesta no
    /// era audio. No es culpa de la clave.
    Servicio(String),
}

/// Lo que el transporte necesita para hacer una peticion.
pub struct PeticionTts<'a> {
    pub endpoint: &'a str,
    pub clave: &'a Secreto,
    pub modelo: &'a str,
    /// Codigo de voz: es el `reference_id` del cuerpo.
    pub voz: &'a str,
    pub texto: &'a str,
    pub cancel: &'a TtsCancellation,
}

/// Quien habla con la API.
///
/// Es un trait para poder probar el **relevo de claves sin red**: los tests
/// inyectan un doble que devuelve la secuencia de respuestas que quieran y deja
/// escrito con que clave se llamo. El de verdad es [`ClienteHttp`].
pub trait ClienteTts: Send + Sync {
    fn pedir<'a>(&'a self, peticion: PeticionTts<'a>) -> BoxFuture<'a, RespuestaHttp>;
}

/// Cliente real: `reqwest` con rustls (que el proyecto ya usa).
///
/// El cliente HTTP se crea **en el primer uso**: `AppState::open` corre fuera del
/// runtime de Tokio (en el setup de Tauri) y construirlo ahi es pedir problemas.
/// Se crea uno solo para todas las frases; abrir uno por peticion tiraria el pool
/// de conexiones.
pub struct ClienteHttp {
    timeout: Duration,
    cliente: OnceLock<reqwest::Client>,
}

impl ClienteHttp {
    pub fn nuevo(timeout: Duration) -> Self {
        Self {
            timeout,
            cliente: OnceLock::new(),
        }
    }

    fn cliente(&self) -> Result<reqwest::Client> {
        if let Some(cliente) = self.cliente.get() {
            return Ok(cliente.clone());
        }
        let cliente = reqwest::Client::builder()
            .timeout(self.timeout)
            // Sin tope de conexion, una red que traga paquetes deja la lectura
            // colgada hasta el timeout total. Con el, se falla en 10 s y la cola
            // sigue con la frase siguiente.
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!(
                "tiktok-stream-dashboard/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .context("construyendo el cliente HTTPS de Fish Audio")?;
        // Si otra tarea se adelanto, se usa el suyo: los dos valen.
        let _ = self.cliente.set(cliente.clone());
        Ok(cliente)
    }
}

impl ClienteTts for ClienteHttp {
    fn pedir<'a>(&'a self, peticion: PeticionTts<'a>) -> BoxFuture<'a, RespuestaHttp> {
        Box::pin(async move {
            let cliente = match self.cliente() {
                Ok(cliente) => cliente,
                Err(error) => {
                    // `error` viene de `.context(...)`, sin la clave dentro.
                    return RespuestaHttp::Servicio(format!("Fish Audio: {error}"));
                }
            };

            let cuerpo = serde_json::json!({
                "text": peticion.texto,
                "reference_id": peticion.voz,
                // MP3 explicito y fijo: es el formato que ya reproduce el
                // reproductor de la cola, asi que lo que devuelve la API se guarda
                // tal cual.
                "format": "mp3",
            });

            let enviar = cliente
                .post(peticion.endpoint)
                // `bearer_auth` escribe `Authorization: Bearer <clave>`. La clave
                // va en la cabecera y **solo** aqui.
                .bearer_auth(peticion.clave.exponer())
                .header("model", peticion.modelo)
                .json(&cuerpo)
                .send();

            let respuesta = tokio::select! {
                resultado = enviar => match resultado {
                    Ok(respuesta) => respuesta,
                    // El `Display` de `reqwest` puede arrastrar la peticion (y con
                    // ella la cabecera), asi que se descarta y se dice solo donde
                    // fallo.
                    Err(_) => return RespuestaHttp::Servicio(describe_error_red(peticion.endpoint)),
                },
                _ = peticion.cancel.cancelled() => {
                    return RespuestaHttp::Servicio("síntesis cancelada".to_string());
                }
            };

            let status = respuesta.status().as_u16();
            let tipo = respuesta
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|valor| valor.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();

            if !respuesta.status().is_success() {
                let mensaje = leer_mensaje(respuesta).await;
                return RespuestaHttp::Error { status, mensaje };
            }

            // Una respuesta correcta tiene que ser de audio. Si la API contesta
            // JSON con un 200 (una cuota agotada devuelta de otra forma),
            // guardarlo dejaria un `.mp3` con un JSON dentro.
            if tipo.contains("json") {
                let mensaje = leer_mensaje(respuesta).await;
                return RespuestaHttp::Servicio(format!(
                    "Fish Audio devolvio un error en vez de audio: {mensaje}"
                ));
            }

            match respuesta.bytes().await {
                Ok(bytes) => RespuestaHttp::Audio(bytes.to_vec()),
                Err(_) => RespuestaHttp::Servicio(describe_error_red(peticion.endpoint)),
            }
        })
    }
}

/// Texto del error de red, sin arrastrar la peticion.
fn describe_error_red(endpoint: &str) -> String {
    format!("Fish Audio: no se pudo hablar con {endpoint} (sin red o servicio caido)")
}

/// Texto del error HTTP, con el mensaje de la API recortado.
fn describe_error_http(status: u16, detalle: &str) -> String {
    let clase = match status {
        401 | 403 => "la clave no vale",
        402 => "la cuenta no tiene saldo",
        429 => "demasiadas peticiones seguidas",
        // El 400 mas comun de este endpoint es un `reference_id` que no existe, y
        // el mensaje del servicio ("Reference not found") no le dice al streamer
        // que lo que tiene mal es el codigo de voz.
        400 if detalle.to_lowercase().contains("reference") => "el codigo de voz no existe",
        400 => "la peticion no es valida",
        503 => "el servicio esta sobrecargado",
        _ => "la API respondio con un error",
    };
    if detalle.is_empty() {
        format!("Fish Audio: {clase} ({status})")
    } else {
        format!("Fish Audio: {clase} ({status}): {detalle}")
    }
}

/// Lee el `message` del JSON de error, recortado y siempre en una linea.
async fn leer_mensaje(respuesta: reqwest::Response) -> String {
    let Ok(cuerpo) = respuesta.text().await else {
        return String::new();
    };
    let mensaje = serde_json::from_str::<serde_json::Value>(&cuerpo)
        .ok()
        .and_then(|valor| {
            valor
                .get("message")
                .and_then(|texto| texto.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    recortar(&mensaje.replace(['\n', '\r'], " "))
}

/// Recorta un texto a [`MAX_ERROR_BYTES`] sin partir un caracter por la mitad.
fn recortar(texto: &str) -> String {
    let texto = texto.trim();
    if texto.len() <= MAX_ERROR_BYTES {
        return texto.to_string();
    }
    let corte = texto
        .char_indices()
        .map(|(indice, _)| indice)
        .take_while(|indice| *indice <= MAX_ERROR_BYTES)
        .last()
        .unwrap_or(0);
    format!("{}...", &texto[..corte])
}

/// En que familia cae un codigo de error. Es lo que decide el relevo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Clase {
    /// 401/403: la clave no vale.
    Clave,
    /// 402: esa clave se acabo.
    Saldo,
    /// 429: ritmo, no agotamiento.
    Ritmo,
    /// 5xx: el servicio.
    Servicio,
    /// 400 y demas: la peticion.
    Peticion,
}

fn clase_de(status: u16) -> Clase {
    match status {
        401 | 403 => Clase::Clave,
        402 => Clase::Saldo,
        429 => Clase::Ritmo,
        500..=599 => Clase::Servicio,
        _ => Clase::Peticion,
    }
}

/// Estado vivo del proveedor: las claves, cual esta activa, el modelo y el gasto.
struct FishEstado {
    claves: Vec<ClaveGuardada>,
    /// Posicion de la clave que se esta usando.
    activa: Option<usize>,
    /// Modelo de la cabecera `model`.
    model: String,
    consumo: Consumo,
}

pub struct FishAudio {
    config: FishConfig,
    transporte: Arc<dyn ClienteTts>,
    estado: RwLock<FishEstado>,
    calls: AtomicU64,
    failures: AtomicU64,
    cache_hits: AtomicU64,
}

impl FishAudio {
    pub fn new(config: FishConfig) -> Self {
        let transporte = Arc::new(ClienteHttp::nuevo(config.timeout));
        Self::con(config, transporte)
    }

    /// Con un transporte propio. Es lo que usan las pruebas del relevo: no toca
    /// la red.
    pub fn con(config: FishConfig, transporte: Arc<dyn ClienteTts>) -> Self {
        Self {
            config,
            transporte,
            estado: RwLock::new(FishEstado {
                claves: Vec::new(),
                activa: None,
                model: MODELO_POR_DEFECTO.to_string(),
                consumo: Consumo::default(),
            }),
            calls: AtomicU64::new(0),
            failures: AtomicU64::new(0),
            cache_hits: AtomicU64::new(0),
        }
    }

    pub fn config(&self) -> &FishConfig {
        &self.config
    }

    /// `(peticiones, fallos, aciertos de cache)`.
    pub fn stats(&self) -> (u64, u64, u64) {
        (
            self.calls.load(Ordering::Relaxed),
            self.failures.load(Ordering::Relaxed),
            self.cache_hits.load(Ordering::Relaxed),
        )
    }

    /// Carga lo que habia en la base: las claves y el gasto acumulado.
    ///
    /// Se llama **antes** de que el gestor empiece a leer, de modo que el primer
    /// evento ya usa las claves de verdad y el contador arranca donde estaba.
    pub fn cargar(&self, claves: Vec<ClaveGuardada>, consumo: Consumo) {
        let mut estado = self.lock_estado();
        estado.claves = claves;
        estado.consumo = consumo;
        estado.activa = estado.claves.iter().position(ClaveGuardada::esta_viva);
    }

    /// Anade una clave al final de la lista. Devuelve su posicion.
    ///
    /// El tope de [`TOPE_CLAVES`] es del proveedor y no de la interfaz: un tope
    /// que solo existiera en el formulario se podria saltar por otra via.
    pub fn agregar(&self, nombre: &str, secreto: Secreto) -> Result<u64> {
        if secreto.esta_vacio() {
            bail!("la clave esta vacia");
        }
        let mut estado = self.lock_estado();
        if estado.claves.len() >= TOPE_CLAVES {
            bail!("no caben mas de {TOPE_CLAVES} claves");
        }
        let posicion = estado.claves.len() as u64;
        let nombre = nombre.trim();
        estado.claves.push(ClaveGuardada::nueva(
            posicion,
            if nombre.is_empty() {
                // Sin nombre se numera: la lista tiene que poder distinguirse.
                format!("Clave {}", posicion + 1)
            } else {
                nombre.to_string()
            },
            secreto,
        ));
        if estado.activa.is_none() {
            estado.activa = Some(estado.claves.len() - 1);
        }
        Ok(posicion)
    }

    /// Quita una clave. Devuelve `false` si no existia.
    ///
    /// Las posiciones se renumeran: son el identificador que ve la interfaz y una
    /// lista con huecos seria mas dificil de leer que una lista compacta. La
    /// interfaz vuelve a pedir el estado despues de cada cambio.
    pub fn quitar(&self, posicion: u64) -> bool {
        let mut estado = self.lock_estado();
        let indice = posicion as usize;
        if indice >= estado.claves.len() {
            return false;
        }
        estado.claves.remove(indice);
        for (nuevo, clave) in estado.claves.iter_mut().enumerate() {
            clave.posicion = nuevo as u64;
        }
        // La activa se recalcula: la que apuntaba puede haberse ido con el hueco.
        estado.activa = estado.claves.iter().position(ClaveGuardada::esta_viva);
        true
    }

    /// Vuelve a dejar una clave como utilizable.
    ///
    /// Hace falta: una clave marcada como agotada porque el streamer se quedo sin
    /// saldo sigue marcada cuando recarga, y sin esto habria que reiniciar la
    /// aplicacion para volver a usarla.
    pub fn reactivar(&self, posicion: u64) -> bool {
        let mut estado = self.lock_estado();
        let Some(clave) = estado.claves.get_mut(posicion as usize) else {
            return false;
        };
        clave.estado = EstadoClave::Viva;
        if estado.activa.is_none() {
            estado.activa = Some(posicion as usize);
        }
        true
    }

    /// Copia de las claves para persistir. **Lleva los secretos**: es el unico
    /// camino por el que salen del proveedor, y va a la base de datos del usuario,
    /// no a un log ni a la interfaz.
    pub fn claves_para_persistir(&self) -> Vec<ClaveGuardada> {
        self.leer_estado().claves.clone()
    }

    /// El consumo y el estado de las claves, para la interfaz.
    pub fn uso(&self) -> UsoProveedor {
        let estado = self.leer_estado();
        let activa = estado.activa;
        UsoProveedor {
            modelo: estado.model.clone(),
            total: estado.consumo,
            claves: estado
                .claves
                .iter()
                .enumerate()
                .map(|(indice, clave)| clave.status(Some(indice) == activa))
                .collect(),
        }
    }

    /// Ruta en cache de una frase.
    ///
    /// La clave incluye el **proveedor**, la voz y el modelo ademas del texto:
    /// cambiar el modelo cambia la locucion (y el precio), asi que no puede
    /// reutilizar el MP3 del modelo anterior.
    pub fn cache_path(&self, request: &TtsRequest, model: &str) -> PathBuf {
        let key = super::provider::fish_cache_key(&request.voice, model, &request.text);
        self.config.cache_dir.join(format!("{key}.mp3"))
    }

    fn lock_estado(&self) -> std::sync::RwLockWriteGuard<'_, FishEstado> {
        self.estado
            .write()
            .unwrap_or_else(|envenenado| envenenado.into_inner())
    }

    fn leer_estado(&self) -> std::sync::RwLockReadGuard<'_, FishEstado> {
        self.estado
            .read()
            .unwrap_or_else(|envenenado| envenenado.into_inner())
    }

    /// La clave que toca intentar: la activa si sigue viva, y si no la primera
    /// viva por orden.
    fn seleccionar(&self) -> Option<usize> {
        let estado = self.leer_estado();
        if let Some(activa) = estado.activa {
            if estado
                .claves
                .get(activa)
                .is_some_and(ClaveGuardada::esta_viva)
            {
                return Some(activa);
            }
        }
        estado.claves.iter().position(ClaveGuardada::esta_viva)
    }

    /// La siguiente clave viva **despues** de `desde`, dando la vuelta.
    ///
    /// Dar la vuelta es seguro: una clave que falla por clave o por saldo queda
    /// marcada y no se puede volver a elegir en esta misma peticion.
    fn siguiente(&self, desde: usize) -> Option<usize> {
        let estado = self.leer_estado();
        let total = estado.claves.len();
        (1..=total)
            .map(|salto| (desde + salto) % total.max(1))
            .find(|indice| {
                estado
                    .claves
                    .get(*indice)
                    .is_some_and(ClaveGuardada::esta_viva)
            })
    }

    /// Lo que hace falta para llamar: el secreto, el modelo y el nombre.
    fn datos_de(&self, indice: usize) -> Option<(Secreto, String, String)> {
        let estado = self.leer_estado();
        let clave = estado.claves.get(indice)?;
        Some((
            clave.secreto.clone(),
            estado.model.clone(),
            clave.nombre.clone(),
        ))
    }

    fn marcar(&self, indice: usize, estado_nuevo: EstadoClave) {
        let mut estado = self.lock_estado();
        if let Some(clave) = estado.claves.get_mut(indice) {
            clave.estado = estado_nuevo;
        }
    }

    /// Apunta el gasto de una peticion cobrada: al total y a la clave que la
    /// mando. El reparto por clave es simplemente **a quien se le sumo**.
    fn contar(&self, indice: usize, bytes: u64, modelo: &str) {
        let mut estado = self.lock_estado();
        estado.consumo.sumar(bytes, modelo);
        if let Some(clave) = estado.claves.get_mut(indice) {
            clave.bytes += bytes;
            clave.llamadas += 1;
            clave.micro += super::consumo::coste_micro(bytes, modelo);
        }
        estado.activa = Some(indice);
    }

    /// Espera antes de reintentar la **misma** clave. Se puede cancelar.
    async fn esperar(&self, intento: u32, cancel: &TtsCancellation) -> Result<()> {
        let espera = self.config.espera_reintento * 2u32.saturating_pow(intento);
        if espera.is_zero() {
            return Ok(());
        }
        tokio::select! {
            _ = tokio::time::sleep(espera) => Ok(()),
            _ = cancel.cancelled() => bail!("síntesis cancelada"),
        }
    }

    /// Manda el texto y devuelve los bytes de audio, con relevo de claves.
    async fn pedir(&self, request: &TtsRequest, cancel: &TtsCancellation) -> Result<Vec<u8>> {
        let texto = request.text.trim();
        if texto.is_empty() {
            return Err(ErrorVoz::anyhow(
                MotivoFallo::TextoVacio,
                "Fish Audio: el texto esta vacio",
            ));
        }
        if texto.len() > MAX_TEXTO_BYTES {
            return Err(ErrorVoz::anyhow(
                MotivoFallo::TextoLargo,
                format!(
                    "Fish Audio: el texto ocupa {} bytes y el tope por peticion es {MAX_TEXTO_BYTES}",
                    texto.len()
                ),
            ));
        }

        let (total_claves, hay_viva) = {
            let estado = self.leer_estado();
            (
                estado.claves.len(),
                estado.claves.iter().any(ClaveGuardada::esta_viva),
            )
        };
        if request.voice.trim().is_empty() {
            return Err(ErrorVoz::anyhow(
                MotivoFallo::SinVoz,
                "Fish Audio: falta el codigo de voz",
            ));
        }
        if total_claves == 0 {
            return Err(ErrorVoz::anyhow(
                MotivoFallo::SinClave,
                "Fish Audio: no hay ninguna clave guardada",
            ));
        }
        if !hay_viva {
            // Se dice **sin gastar una peticion**: reintentar con claves muertas no
            // arregla nada y solo ensucia la cuenta.
            return Err(ErrorVoz::anyhow(
                MotivoFallo::SinClaves,
                "Fish Audio: ninguna clave se puede usar; marca una como valida o pon otra",
            ));
        }

        // Cada clave puede gastar `max_reintentos` extra; los fallos de clave no
        // gastan reintentos, asi que el tope real es mayor. La cuenta esta
        // acotada a proposito para que este bucle no pueda girar sin fin.
        let tope = total_claves * (self.config.max_reintentos as usize + 2) + 1;
        let mut indice = self.seleccionar();
        let mut reintentos = 0u32;
        // Por que murio la ultima clave que se intento.
        //
        // Es lo que se devuelve cuando se acaban todas: decir solo "se agotaron
        // las claves" ocultaria lo unico que el streamer necesita saber, que es si
        // el problema se arregla poniendo otra clave (401) o recargando saldo
        // (402). Comprobado contra la API real: con una sola clave falsa, lo util
        // es "la clave no vale (401)", no "no queda ninguna".
        let mut ultimo_fallo: Option<(MotivoFallo, String)> = None;

        for _ in 0..tope {
            let Some(actual) = indice else { break };
            let Some((clave, modelo, _nombre)) = self.datos_de(actual) else {
                break;
            };

            self.calls.fetch_add(1, Ordering::Relaxed);
            let respuesta = self
                .transporte
                .pedir(PeticionTts {
                    endpoint: &self.config.endpoint,
                    clave: &clave,
                    modelo: &modelo,
                    voz: request.voice.trim(),
                    texto,
                    cancel,
                })
                .await;

            if cancel.is_cancelled() {
                return Err(ErrorVoz::anyhow(
                    MotivoFallo::Cancelada,
                    "síntesis cancelada",
                ));
            }

            match respuesta {
                RespuestaHttp::Audio(bytes) if !bytes.is_empty() => {
                    self.contar(actual, bytes_de(texto), &modelo);
                    return Ok(bytes);
                }
                // Un 200 sin audio es una anomalia del servicio, no de la clave.
                RespuestaHttp::Audio(_) => {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                    if reintentos < self.config.max_reintentos {
                        self.esperar(reintentos, cancel).await?;
                        reintentos += 1;
                        continue;
                    }
                    return Err(ErrorVoz::anyhow(
                        MotivoFallo::Servicio,
                        "Fish Audio devolvio un audio vacio",
                    ));
                }
                RespuestaHttp::Servicio(motivo) => {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                    // El servicio, no la clave: se reintenta la misma con la
                    // espera de siempre y no se gasta ninguna clave.
                    if reintentos < self.config.max_reintentos {
                        self.esperar(reintentos, cancel).await?;
                        reintentos += 1;
                        continue;
                    }
                    return Err(ErrorVoz::anyhow(MotivoFallo::Servicio, motivo));
                }
                RespuestaHttp::Error { status, mensaje } => {
                    let detalle = describe_error_http(status, &mensaje);
                    match clase_de(status) {
                        Clase::Clave => {
                            // No se arregla sola: se marca y se pasa a la
                            // siguiente. No se reintenta nunca.
                            self.failures.fetch_add(1, Ordering::Relaxed);
                            self.marcar(actual, EstadoClave::Invalida);
                            reintentos = 0;
                            ultimo_fallo = Some((MotivoFallo::ClaveRechazada, detalle));
                            indice = self.siguiente(actual);
                            tracing::warn!(
                                clave = actual,
                                "Fish Audio rechazo una clave; se pasa a la siguiente"
                            );
                        }
                        Clase::Saldo => {
                            self.failures.fetch_add(1, Ordering::Relaxed);
                            self.marcar(actual, EstadoClave::Agotada);
                            reintentos = 0;
                            ultimo_fallo = Some((MotivoFallo::SinSaldo, detalle));
                            indice = self.siguiente(actual);
                            tracing::warn!(
                                clave = actual,
                                "Fish Audio sin saldo en una clave; se pasa a la siguiente"
                            );
                        }
                        Clase::Ritmo => {
                            // **No** se cambia de clave: un 429 es ritmo, y
                            // cambiar aqui quemaria otra clave sin motivo.
                            if reintentos < self.config.max_reintentos {
                                self.esperar(reintentos, cancel).await?;
                                reintentos += 1;
                                continue;
                            }
                            self.failures.fetch_add(1, Ordering::Relaxed);
                            return Err(ErrorVoz::anyhow(MotivoFallo::Ritmo, detalle));
                        }
                        Clase::Servicio => {
                            if reintentos < self.config.max_reintentos {
                                self.esperar(reintentos, cancel).await?;
                                reintentos += 1;
                                continue;
                            }
                            self.failures.fetch_add(1, Ordering::Relaxed);
                            return Err(ErrorVoz::anyhow(MotivoFallo::Servicio, detalle));
                        }
                        Clase::Peticion => {
                            self.failures.fetch_add(1, Ordering::Relaxed);
                            return Err(ErrorVoz::anyhow(MotivoFallo::Peticion, detalle));
                        }
                    }
                }
            }
        }

        // Se intentaron todas y ninguna valia: se dice **por que** fallo la
        // ultima, que es lo que dice que hay que hacer (otra clave o mas saldo).
        match ultimo_fallo {
            Some((motivo, detalle)) => Err(ErrorVoz::anyhow(motivo, detalle)),
            None => Err(ErrorVoz::anyhow(
                MotivoFallo::SinClaves,
                "Fish Audio: no queda ninguna clave utilizable",
            )),
        }
    }

    /// Sintetiza a fichero, reutilizando la cache si la frase ya se dijo.
    pub async fn synthesize_to_file_with_cancel(
        &self,
        request: &TtsRequest,
        cancel: TtsCancellation,
    ) -> Result<TtsAudio> {
        let model = {
            let estado = self.leer_estado();
            estado.model.clone()
        };
        let path = self.cache_path(request, &model);

        if let Some(bytes) = valid_audio_file(&path) {
            self.cache_hits.fetch_add(1, Ordering::Relaxed);
            return Ok(apply_cached(path, bytes));
        }

        let empezado = std::time::Instant::now();
        let audio = self.pedir(request, &cancel).await?;
        if cancel.is_cancelled() {
            bail!("síntesis cancelada");
        }
        let ms = empezado.elapsed().as_millis() as u64;
        sink_atomically(&path, &audio, request.id, ms)
    }

    pub async fn synthesize_to_file(&self, request: &TtsRequest) -> Result<TtsAudio> {
        self.synthesize_to_file_with_cancel(request, TtsCancellation::new())
            .await
    }
}

/// `Debug` a mano: la clave no puede salir por aqui.
impl fmt::Debug for FishAudio {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FishAudio")
            .field("endpoint", &self.config.endpoint)
            .field("cache_dir", &self.config.cache_dir)
            .field("timeout", &self.config.timeout)
            .field("claves", &self.leer_estado().claves)
            .finish()
    }
}

impl TtsProvider for FishAudio {
    fn name(&self) -> &'static str {
        PROVIDER_ID
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

    /// El modelo es lo unico que este proveedor necesita aparte de la peticion.
    fn apply(&self, ajustes: &ProviderSettings) {
        let distinto = self.leer_estado().model != ajustes.model;
        if distinto {
            self.lock_estado().model = ajustes.model.clone();
        }
    }

    fn begin_stream(&self) {
        // El contador del directo vuelve a cero. El acumulado no se toca.
        self.lock_estado().consumo.reiniciar_sesion();
    }

    fn usage(&self) -> Option<UsoProveedor> {
        Some(self.uso())
    }

    /// Sin clave y sin codigo de voz no hay nada que preguntar: se contesta al
    /// instante y sin gastar una llamada.
    fn health<'a>(&'a self) -> BoxFuture<'a, bool> {
        Box::pin(async move { self.readiness() == Readiness::Ready })
    }

    fn available_voices<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>>> {
        // Fish elige la voz por `reference_id`, que el streamer pega desde su
        // biblioteca: no hay catalogo local que ofrecer, y pedirlo a la API seria
        // una llamada de red por una lista que no se usa en esta version.
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
        // No hay proceso que apagar: el cliente HTTPS se comparte y se va con el
        // proceso.
        Box::pin(async move {})
    }

    fn prune_cache(&self) -> usize {
        prune_cache(
            &self.config.cache_dir,
            self.config.cache_max_bytes,
            self.config.cache_max_age,
            std::time::SystemTime::now(),
        )
    }

    fn has_secret(&self) -> bool {
        !self.leer_estado().claves.is_empty()
    }

    fn secret_hint(&self) -> Option<String> {
        let estado = self.leer_estado();
        estado
            .activa
            .and_then(|activa| estado.claves.get(activa))
            .and_then(|clave| clave.secreto.pista())
    }

    fn readiness(&self) -> Readiness {
        let estado = self.leer_estado();
        if estado.claves.is_empty() {
            return Readiness::MissingSecret;
        }
        if !estado.claves.iter().any(ClaveGuardada::esta_viva) {
            // Hay claves, pero ninguna sirve. Distinto de "no hay ninguna".
            return Readiness::NoUsableKey;
        }
        Readiness::Ready
    }
}

/// Un guion de respuestas para las pruebas del relevo: devuelve las respuestas en
/// orden y apunta **con que clave** se llamo. No toca la red.
#[cfg(test)]
#[derive(Default)]
pub struct TransporteFalso {
    guion: std::sync::Mutex<std::collections::VecDeque<RespuestaHttp>>,
    usadas: std::sync::Mutex<Vec<String>>,
}

#[cfg(test)]
impl TransporteFalso {
    pub fn nuevo(respuestas: Vec<RespuestaHttp>) -> Arc<Self> {
        Arc::new(Self {
            guion: std::sync::Mutex::new(respuestas.into()),
            usadas: std::sync::Mutex::new(Vec::new()),
        })
    }

    /// Las claves con las que se llamo, en orden. Son valores de mentira.
    pub fn usadas(&self) -> Vec<String> {
        self.usadas
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::VecDeque<RespuestaHttp>> {
        self.guion.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
impl ClienteTts for TransporteFalso {
    fn pedir<'a>(&'a self, peticion: PeticionTts<'a>) -> BoxFuture<'a, RespuestaHttp> {
        self.usadas
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(peticion.clave.exponer().to_string());
        let siguiente = self.lock().pop_front();
        Box::pin(async move {
            siguiente.unwrap_or_else(|| {
                RespuestaHttp::Servicio("el guion de la prueba se quedo sin respuestas".into())
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::consumo::precio_por_millon;

    fn peticion(texto: &str, voice: &str) -> TtsRequest {
        TtsRequest {
            id: 1,
            text: texto.to_string(),
            voice: voice.to_string(),
            rate: "+0%".into(),
            pitch: "+0Hz".into(),
        }
    }

    fn config() -> FishConfig {
        static SECUENCIA: AtomicU64 = AtomicU64::new(0);
        let unico = SECUENCIA.fetch_add(1, Ordering::Relaxed);
        FishConfig {
            cache_dir: std::env::temp_dir()
                .join(format!("ttdash-fish-{}-{unico}", std::process::id())),
            // Sin esperas: las pruebas del relevo no pueden tardar segundos.
            espera_reintento: Duration::ZERO,
            ..FishConfig::default()
        }
    }

    /// Proveedor con dos claves de mentira y el transporte que se le pase.
    fn con_guion(respuestas: Vec<RespuestaHttp>) -> (FishAudio, Arc<TransporteFalso>) {
        let transporte = TransporteFalso::nuevo(respuestas);
        let provider = FishAudio::con(config(), transporte.clone());
        provider.cargar(
            vec![
                ClaveGuardada::nueva(0, "la de marzo", Secreto::new("clave-AAA")),
                ClaveGuardada::nueva(1, "la del canal", Secreto::new("clave-BBB")),
            ],
            Consumo::default(),
        );
        provider.apply(&ProviderSettings {
            model: "s2.1-pro".into(),
        });
        (provider, transporte)
    }

    fn audio(bytes: usize) -> RespuestaHttp {
        RespuestaHttp::Audio(vec![0xff; bytes])
    }

    #[test]
    fn el_modelo_de_fabrica_es_el_gratuito() {
        // Un modelo de pago por defecto seria gastar dinero sin que nadie lo elija.
        assert_eq!(MODELO_POR_DEFECTO, "s2.1-pro-free");
        assert_eq!(precio_por_millon(MODELO_POR_DEFECTO), 0.0);
        assert!(MODELOS.iter().any(|modelo| modelo.id == "s2.1-pro"));
        assert_eq!(
            modelos().len(),
            4,
            "la tabla de precios tiene cuatro modelos"
        );
        assert_eq!(TOPE_CLAVES, 10);
    }

    /// El endpoint es el de la documentacion, y no se inventa en el codigo.
    #[test]
    fn el_endpoint_es_el_de_la_documentacion() {
        assert_eq!(
            FishConfig::default().endpoint,
            "https://api.fish.audio/v1/tts"
        );
    }

    #[tokio::test]
    async fn sin_claves_no_se_llama_a_la_api() {
        let transporte = TransporteFalso::nuevo(vec![]);
        let provider = FishAudio::con(config(), transporte.clone());

        let error = provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect_err("sin claves no se sintetiza");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::SinClave));
        assert!(
            transporte.usadas().is_empty(),
            "no puede gastar una llamada"
        );
        assert_eq!(provider.readiness(), Readiness::MissingSecret);
    }

    #[tokio::test]
    async fn sin_codigo_de_voz_no_se_llama_a_la_api() {
        let (provider, transporte) = con_guion(vec![audio(4)]);
        let error = provider
            .synthesize_to_file(&peticion("hola", ""))
            .await
            .expect_err("sin codigo de voz no se sintetiza");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::SinVoz));
        assert!(transporte.usadas().is_empty());

        let error = provider
            .synthesize_to_file(&peticion("   ", "voz-1"))
            .await
            .expect_err("sin texto no se sintetiza");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::TextoVacio));
        assert!(transporte.usadas().is_empty());

        let largo = "a".repeat(MAX_TEXTO_BYTES + 1);
        let error = provider
            .synthesize_to_file(&peticion(&largo, "voz-1"))
            .await
            .expect_err("por encima del tope no se manda");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::TextoLargo));
        assert!(transporte.usadas().is_empty());
    }

    /// El caso normal: la primera clave vale y se cobra a esa.
    #[tokio::test]
    async fn la_primera_clave_viva_es_la_que_se_usa() {
        let (provider, transporte) = con_guion(vec![audio(8)]);
        let audio = provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect("deberia sintetizar");
        assert_eq!(transporte.usadas(), vec!["clave-AAA".to_string()]);
        assert_eq!(audio.bytes, 8);

        let uso = provider.uso();
        assert_eq!(uso.claves[0].bytes, 4, "se cobra el texto, no el audio");
        assert_eq!(uso.claves[0].llamadas, 1);
        assert_eq!(uso.claves[0].micro, 60, "4 bytes * 15 $/M");
        assert!(uso.claves[0].en_uso);
        assert_eq!(uso.total.total_bytes, 4);
        assert_eq!(uso.vivas(), 2);
    }

    /// 401: la clave se marca invalida y se pasa a la siguiente. No se reintenta.
    #[tokio::test]
    async fn un_401_marca_la_clave_y_pasa_a_la_siguiente() {
        let (provider, transporte) = con_guion(vec![
            RespuestaHttp::Error {
                status: 401,
                mensaje: "Invalid API key".into(),
            },
            audio(8),
        ]);
        provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect("la segunda clave deberia servir");

        // Una sola llamada por clave: la primera no se reintenta.
        assert_eq!(
            transporte.usadas(),
            vec!["clave-AAA".to_string(), "clave-BBB".to_string()]
        );
        let uso = provider.uso();
        assert_eq!(uso.claves[0].estado, "invalida");
        assert_eq!(uso.claves[1].estado, "viva");
        assert!(uso.claves[1].en_uso);
        assert_eq!(uso.claves[0].bytes, 0, "una clave muerta no cobra nada");
        assert_eq!(uso.claves[1].bytes, 4);
        assert_eq!(uso.vivas(), 1);
    }

    /// 402: la clave se agota y el relevo es automatico.
    #[tokio::test]
    async fn un_402_pasa_solo_a_la_siguiente() {
        let (provider, transporte) = con_guion(vec![
            RespuestaHttp::Error {
                status: 402,
                mensaje: "Insufficient quota".into(),
            },
            audio(4),
        ]);
        provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect("la segunda clave deberia servir");
        assert_eq!(
            transporte.usadas(),
            vec!["clave-AAA".to_string(), "clave-BBB".to_string()]
        );
        let uso = provider.uso();
        assert_eq!(uso.claves[0].estado, "agotada");
        assert_eq!(uso.claves[1].estado, "viva");
    }

    /// El corazon de la funcion: un 429 **no** cambia de clave. Si se confundiera
    /// con un agotamiento, un pico de trafico consumiria las diez.
    #[tokio::test]
    async fn un_429_reintenta_la_misma_clave_y_no_toca_las_demas() {
        let (provider, transporte) = con_guion(vec![
            RespuestaHttp::Error {
                status: 429,
                mensaje: "Too many requests".into(),
            },
            RespuestaHttp::Error {
                status: 429,
                mensaje: "Too many requests".into(),
            },
            audio(4),
        ]);
        provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect("al tercer intento la misma clave sirve");

        assert_eq!(
            transporte.usadas(),
            vec![
                "clave-AAA".to_string(),
                "clave-AAA".to_string(),
                "clave-AAA".to_string()
            ],
            "un 429 nunca puede cambiar de clave"
        );
        let uso = provider.uso();
        assert_eq!(uso.claves[0].estado, "viva", "un 429 no agota la clave");
        assert_eq!(uso.claves[1].estado, "viva");
        assert_eq!(uso.vivas(), 2);
    }

    /// Y si el 429 no se va, se falla la frase **sin** gastar las otras claves.
    #[tokio::test]
    async fn un_429_que_no_cede_falla_sin_gastar_otra_clave() {
        let (provider, transporte) = con_guion(vec![
            RespuestaHttp::Error {
                status: 429,
                mensaje: "Too many requests".into(),
            },
            RespuestaHttp::Error {
                status: 429,
                mensaje: "Too many requests".into(),
            },
            RespuestaHttp::Error {
                status: 429,
                mensaje: "Too many requests".into(),
            },
        ]);
        let error = provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect_err("el 429 no cede");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::Ritmo));
        assert_eq!(
            transporte.usadas(),
            vec!["clave-AAA".to_string(); 3],
            "no puede probar la segunda clave"
        );
        assert_eq!(provider.uso().claves[1].estado, "viva");
    }

    /// 5xx: es el servicio, no la clave. Se reintenta la misma y no se gasta nada.
    #[tokio::test]
    async fn un_5xx_no_gasta_claves() {
        let (provider, transporte) = con_guion(vec![
            RespuestaHttp::Error {
                status: 503,
                mensaje: "overloaded".into(),
            },
            audio(4),
        ]);
        provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect("el segundo intento sirve");
        assert_eq!(
            transporte.usadas(),
            vec!["clave-AAA".to_string(), "clave-AAA".to_string()]
        );
        assert_eq!(provider.uso().vivas(), 2, "ninguna clave se gasta");
    }

    /// Sin red: igual que un 5xx, y con el motivo del servicio.
    #[tokio::test]
    async fn sin_red_se_reintenta_sin_gastar_claves() {
        let (provider, transporte) = con_guion(vec![
            RespuestaHttp::Servicio("sin red".into()),
            RespuestaHttp::Servicio("sin red".into()),
            RespuestaHttp::Servicio("sin red".into()),
        ]);
        let error = provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect_err("sin red no hay audio");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::Servicio));
        assert_eq!(transporte.usadas(), vec!["clave-AAA".to_string(); 3]);
        assert_eq!(provider.uso().vivas(), 2);
    }

    /// Con todas agotadas se dice, y no se manda ni una peticion.
    #[tokio::test]
    async fn con_todas_agotadas_se_dice_y_no_se_llama() {
        let (provider, transporte) = con_guion(vec![
            RespuestaHttp::Error {
                status: 401,
                mensaje: "nope".into(),
            },
            RespuestaHttp::Error {
                status: 402,
                mensaje: "sin saldo".into(),
            },
        ]);
        // La primera frase agota las dos claves. El motivo que se devuelve es el
        // de la **ultima**: un 402 dice que hay que recargar saldo, mientras que
        // "se agotaron las claves" no diria que hacer.
        let error = provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect_err("no queda ninguna");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::SinSaldo));
        assert!(error.to_string().contains("saldo"), "{error}");
        assert_eq!(transporte.usadas().len(), 2);

        // La siguiente frase ya no llama a nadie y lo dice claro.
        assert_eq!(provider.readiness(), Readiness::NoUsableKey);
        let error = provider
            .synthesize_to_file(&peticion("otra", "voz-1"))
            .await
            .expect_err("sigue sin haber ninguna");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::SinClaves));
        assert!(error.to_string().contains("ninguna clave"), "{error}");
        assert_eq!(transporte.usadas().len(), 2, "no gasta ni una llamada mas");

        // Y reactivar una vuelve a habilitarlo.
        assert!(provider.reactivar(1));
        assert_eq!(provider.readiness(), Readiness::Ready);
        assert_eq!(provider.uso().vivas(), 1);
    }

    /// Un 400 no se reintenta: el texto no se arregla solo.
    #[tokio::test]
    async fn una_peticion_invalida_no_se_reintenta() {
        let (provider, transporte) = con_guion(vec![RespuestaHttp::Error {
            status: 400,
            mensaje: "bad json".into(),
        }]);
        let error = provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect_err("un 400 no se arregla reintentando");
        assert_eq!(ErrorVoz::motivo_de(&error), Some(MotivoFallo::Peticion));
        assert_eq!(transporte.usadas().len(), 1);
        assert_eq!(provider.uso().vivas(), 2, "un 400 no gasta claves");
    }

    #[test]
    fn el_tope_de_claves_es_diez() {
        let provider = FishAudio::con(config(), TransporteFalso::nuevo(vec![]));
        for indice in 0..TOPE_CLAVES {
            provider
                .agregar(
                    &format!("clave {indice}"),
                    Secreto::new(format!("valor-{indice}")),
                )
                .expect("cabe");
        }
        let error = provider
            .agregar("una mas", Secreto::new("valor-extra"))
            .expect_err("no cabe la once");
        assert!(error.to_string().contains("10"), "{error}");
        assert_eq!(provider.uso().claves.len(), TOPE_CLAVES);

        // Quitar deja hueco y renumera: la lista no puede tener agujeros.
        assert!(provider.quitar(0));
        assert!(!provider.quitar(99));
        let claves = provider.claves_para_persistir();
        assert_eq!(claves.len(), TOPE_CLAVES - 1);
        for (indice, clave) in claves.iter().enumerate() {
            assert_eq!(clave.posicion, indice as u64);
        }
    }

    /// La clave no puede salir por un log ni por el estado del proveedor.
    #[test]
    fn la_clave_no_sale_en_el_debug_ni_en_el_estado() {
        let (provider, _) = con_guion(vec![]);
        let texto = format!("{provider:?}");
        assert!(!texto.contains("clave-AAA"), "{texto}");
        assert!(!texto.contains("clave-BBB"), "{texto}");

        // Con diez claves, con mas motivo: ninguna puede aparecer.
        let provider = FishAudio::con(config(), TransporteFalso::nuevo(vec![]));
        for indice in 0..TOPE_CLAVES {
            provider
                .agregar(
                    &format!("clave {indice}"),
                    Secreto::new(format!("secreta-{indice}-abcdef")),
                )
                .expect("cabe");
        }
        let debug = format!("{provider:?}");
        for indice in 0..TOPE_CLAVES {
            assert!(
                !debug.contains(&format!("secreta-{indice}-abcdef")),
                "se filtro la clave {indice}"
            );
        }

        // Lo unico que sale hacia la interfaz es la pista enmascarada...
        assert_eq!(provider.secret_hint().as_deref(), Some("••••••••cdef"));
        // ...y en el uso no hay ni un valor.
        let uso = provider.uso();
        assert_eq!(uso.claves.len(), TOPE_CLAVES);
        for clave in &uso.claves {
            assert!(clave.pista.starts_with("••••"), "{}", clave.pista);
            assert!(!clave.pista.contains("secreta"));
        }
    }

    /// La clave tampoco puede viajar dentro del mensaje de error.
    #[tokio::test]
    async fn el_error_no_lleva_la_clave() {
        let (provider, _) = con_guion(vec![
            RespuestaHttp::Error {
                status: 401,
                mensaje: "Invalid API key".into(),
            },
            RespuestaHttp::Error {
                status: 401,
                mensaje: "Invalid API key".into(),
            },
        ]);
        let error = provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect_err("las dos claves fallan");
        let texto = format!("{error:#}");
        assert!(!texto.contains("clave-AAA"), "{texto}");
        assert!(!texto.contains("clave-BBB"), "{texto}");
        assert!(!texto.to_lowercase().contains("bearer"), "{texto}");

        // Y el `Display` de las clases tampoco.
        let error = describe_error_http(401, "Invalid API key");
        assert!(error.contains("clave no vale"), "{error}");
        assert!(!describe_error_red(ENDPOINT).contains("Authorization"));
    }

    #[test]
    fn el_modelo_se_aplica_al_proveedor() {
        let (provider, _) = con_guion(vec![]);
        assert_eq!(provider.leer_estado().model, "s2.1-pro");
        provider.apply(&ProviderSettings {
            model: "s2.1-pro-free".into(),
        });
        assert_eq!(provider.leer_estado().model, "s2.1-pro-free");
    }

    /// El consumo de la sesion se reinicia con el directo; el acumulado no.
    #[tokio::test]
    async fn el_directo_nuevo_reinicia_la_sesion_y_no_el_total() {
        let (provider, _) = con_guion(vec![audio(4), audio(4)]);
        provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect("sintetiza");
        assert!(provider.uso().total.sesion_bytes > 0);

        provider.begin_stream();
        let uso = provider.uso();
        assert_eq!(uso.total.sesion_bytes, 0);
        assert_eq!(uso.total.sesion_llamadas, 0);
        assert!(uso.total.total_bytes > 0, "el acumulado sigue");
        // El uso por clave es acumulado: no se reinicia con el directo.
        assert_eq!(uso.claves[0].bytes, 4);
    }

    /// El reparto por clave es a quien se le sumo cada frase.
    #[tokio::test]
    async fn el_uso_se_reparte_entre_las_claves() {
        let (provider, _) = con_guion(vec![
            RespuestaHttp::Error {
                status: 402,
                mensaje: "sin saldo".into(),
            },
            audio(4),
            audio(6),
        ]);
        // 1) la primera se agota y la segunda atiende. 2) la segunda sigue.
        // Textos distintos a proposito: el mismo texto saldria de cache y una
        // frase cacheada no se manda, asi que no se cobra (y no se reparte).
        provider
            .synthesize_to_file(&peticion("hola", "voz-1"))
            .await
            .expect("la segunda clave sirve");
        provider
            .synthesize_to_file(&peticion("adios", "voz-1"))
            .await
            .expect("la segunda clave sigue sirviendo");

        let uso = provider.uso();
        assert_eq!(uso.claves[0].bytes, 0);
        assert_eq!(uso.claves[0].llamadas, 0);
        assert_eq!(uso.claves[1].bytes, 4 + 5, "hola + adios");
        assert_eq!(uso.claves[1].llamadas, 2);
        assert_eq!(uso.total.total_bytes, 9);
        assert_eq!(uso.total.total_llamadas, 2);
        // Los bytes del desglose suman el total: no hay dos contabilidades.
        let suma: u64 = uso.claves.iter().map(|clave| clave.bytes).sum();
        assert_eq!(suma, uso.total.total_bytes);
    }

    /// Una frase que sale de cache **no se manda**, asi que no se cobra ni se le
    /// apunta a ninguna clave.
    #[tokio::test]
    async fn la_frase_cacheada_no_se_cobra() {
        let (provider, transporte) = con_guion(vec![audio(4), audio(4)]);
        let request = peticion("hola", "voz-1");
        provider
            .synthesize_to_file(&request)
            .await
            .expect("primera sintesis");
        let segunda = provider
            .synthesize_to_file(&request)
            .await
            .expect("la segunda sale de cache");
        assert!(segunda.cached);
        assert_eq!(transporte.usadas().len(), 1, "solo se mando una vez");
        assert_eq!(provider.uso().total.total_llamadas, 1);
        assert_eq!(provider.uso().total.total_bytes, 4);
    }

    #[test]
    fn el_error_http_no_lleva_la_cabecera_y_recorta_el_detalle() {
        let error = describe_error_http(401, "Invalid API key");
        assert!(error.contains("clave no vale"), "{error}");
        assert!(!error.to_lowercase().contains("bearer"), "{error}");
        // El 400 de una voz que no existe se dice en palabras del streamer.
        let error = describe_error_http(400, "Reference not found");
        assert!(error.contains("codigo de voz"), "{error}");
        let error = describe_error_http(400, "bad json");
        assert!(error.contains("peticion no es valida"), "{error}");
        let error = describe_error_http(402, "");
        assert!(!error.contains("): "), "sin detalle no se anade dos puntos");
        assert!(describe_error_red(ENDPOINT).contains("sin red"));
        assert!(describe_error_red(ENDPOINT).contains(ENDPOINT));

        // El recorte del mensaje ajeno, para que no llene el estado degradado.
        let largo = recortar(&"x".repeat(MAX_ERROR_BYTES * 2));
        assert!(largo.len() <= MAX_ERROR_BYTES + 3, "{}", largo.len());
        assert!(largo.ends_with("..."));
        assert_eq!(recortar("  hola  "), "hola");
    }

    /// La cache no mezcla proveedores, ni voces, ni modelos, ni textos.
    #[test]
    fn la_cache_separa_proveedor_voz_modelo_y_texto() {
        let (provider, _) = con_guion(vec![]);
        let request = peticion("hola", "voz-1");
        let pago = provider.cache_path(&request, "s2.1-pro");
        let gratis = provider.cache_path(&request, MODELO_POR_DEFECTO);
        assert_ne!(pago, gratis);
        let otro_texto = provider.cache_path(&peticion("adios", "voz-1"), "s2.1-pro");
        assert_ne!(pago, otro_texto);

        // Y no choca con la cache de edge-tts, que usa la misma carpeta.
        let edge = crate::tts::provider::cache_key("voz-1", "+0%", "+0Hz", "hola");
        let nombre = pago
            .file_name()
            .and_then(|nombre| nombre.to_str())
            .unwrap_or_default()
            .to_string();
        assert!(!nombre.starts_with(&edge));
    }
}
