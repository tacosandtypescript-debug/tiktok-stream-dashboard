//! El catalogo de voces de Fish Audio: leerlo y entenderlo.
//!
//! Todo lo que se manda y lo que se interpreta vive aqui, y **nada de esto habla
//! con la red por su cuenta**: las peticiones las hace [`FishAudio::get_json`],
//! que es la unica puerta y la que lleva el relevo de claves probado. Este modulo
//! se queda con lo que se puede probar sin red —construir la direccion, leer la
//! respuesta, y guardar la portada en disco—.
//!
//! # Lo que confirma la API oficial
//!
//! Contrato contrastado contra el esquema que sirve Fish
//! (`https://api.fish.audio/openapi.json`) y los tipos de su SDK
//! (`api-reference/sdk/python/types.mdx`):
//!
//!   * `GET https://api.fish.audio/model` con `page_size`, `page_number`,
//!     `title`, `tag`, `self`, `author_id`, `language`, `title_language` y
//!     `sort_by` — todos de consulta y todos opcionales;
//!   * `GET https://api.fish.audio/model/{id}` para una sola;
//!   * la respuesta viene paginada (`total` + `items`);
//!   * cada voz trae `id`, `title`, `description`, `cover_image`, `languages`,
//!     `tags`, `samples`, `author` (con `id`, `nickname` y `avatar`),
//!     `visibility`, `state` y los contadores de uso.
//!
//! **`sort_by` no se usa**: el esquema lo declara como una cadena sin decir que
//! valores acepta, y mandar uno inventado seria pedirle a la API algo que no esta
//! escrito en ningun sitio. El orden que se enseña es el que devuelve.
//!
//! # Las muestras no se generan
//!
//! Cada voz puede traer `samples`, y cada muestra es **una URL a un audio ya
//! hecho**: recorrer el catalogo escuchando no gasta una sola sintesis. Solo
//! cuando una voz no trae ninguna se ofrece generarla, y eso si cuesta saldo.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

use super::fish::FishAudio;
use crate::providers::BoxFuture;

/// El catalogo de voces. Es el mismo host que la sintesis.
pub const BASE: &str = "https://api.fish.audio/model";

/// Donde Fish sirve los medios **publicos** del catalogo.
///
/// Hace falta porque la API devuelve `cover_image` como **ruta relativa**
/// (`coverimage/<id>`), no como direccion completa: comprobado contra la propia web
/// de Fish —que sirve esa portada desde
/// `https://public-platform.r2.fish.audio/coverimage/<id>`, con un 200 y
/// `image/jpeg`— y contra el `avatar` del autor, que viene igual. Sin resolverla, el
/// navegador pide `coverimage/<id>` **al panel**, que no tiene esa ruta, y la
/// biblioteca se queda sin caras.
///
/// Las muestras **no** pasan por aqui: esas ya vienen absolutas (y firmadas, con una
/// hora de validez, por lo que no se pueden guardar como si fueran para siempre).
pub const MEDIA_BASE: &str = "https://public-platform.r2.fish.audio/";

/// Deja una direccion de medio en absoluta.
///
/// Lo que ya es absoluto se respeta tal cual —incluido un `data:`—, y lo relativo se
/// cuelga de [`MEDIA_BASE`]. Vacio se queda vacio: «no hay imagen» es una respuesta
/// valida.
fn absoluta(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("data:") {
        return url.to_string();
    }
    format!("{MEDIA_BASE}{}", url.trim_start_matches('/'))
}

/// Cuantas voces se piden por pagina si nadie dice otra cosa.
///
/// Con cuatro o cinco columnas de tarjetas, 24 son seis filas: lo que se recorre
/// de una tirada sin que la lista parezca interminable, y lo bastante corto para
/// que la primera pagina llegue rapido.
pub const TAMANO_POR_DEFECTO: u32 = 24;

/// Tope de la pagina que se le puede pedir a la API.
///
/// No es un capricho: una peticion de 200 voces trae 200 portadas que el navegador
/// va a pedir de golpe, y el streamer solo va a mirar las primeras.
pub const TAMANO_MAXIMO: u32 = 48;

/// Tope de la portada que se descarga, en bytes.
///
/// Una portada es una imagen de tarjeta. Si el fichero que hay al otro lado pesa
/// mas que esto, no es una portada: se deja sin imagen antes que meter ocho megas
/// en la cache del streamer.
pub const MAX_PORTADA_BYTES: usize = 2 * 1024 * 1024;

/// Una muestra ya hecha por Fish.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct MuestraVoz {
    /// Como se llama la muestra ("Sample 1", el nombre del texto...).
    pub titulo: String,
    /// Lo que dice la muestra. Es lo que deja comprobarla de un vistazo.
    pub texto: String,
    /// URL del audio. **No** se construye nunca a mano.
    pub audio: String,
}

impl MuestraVoz {
    /// Si la muestra tiene con que sonar.
    pub fn suena(&self) -> bool {
        !self.audio.trim().is_empty()
    }
}

/// Quien hizo la voz.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct AutorVoz {
    pub id: String,
    pub nombre: String,
    pub avatar: String,
}

/// Una voz del catalogo de Fish, ya masticada.
///
/// Los nombres van en español y en el vocabulario del proyecto; los de la API se
/// traducen en [`voz_de_json`] y **no salen de este modulo**.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct VozFish {
    /// El `reference_id`: es lo que se le manda a la sintesis.
    pub id: String,
    pub titulo: String,
    pub descripcion: String,
    /// Portada que da la API. Puede venir vacia.
    pub portada: String,
    /// Codigos de idioma (`es`, `en`...) tal cual los da la API.
    pub idiomas: Vec<String>,
    pub tags: Vec<String>,
    pub muestras: Vec<MuestraVoz>,
    pub autor: AutorVoz,
    /// `public`, `private` o `unlist`.
    pub visibilidad: String,
    /// `created`, `training`, `trained` o `failed`.
    pub estado: String,
    pub me_gusta: u64,
    pub usos: u64,
    pub actualizado_en: String,
}

impl VozFish {
    /// El idioma que se enseña: el primero que diga la API, o nada.
    pub fn idioma(&self) -> &str {
        self.idiomas.first().map(String::as_str).unwrap_or("")
    }

    /// La imagen que se enseña, por orden de preferencia.
    ///
    /// La portada de la voz y, si no la hay, el avatar de quien la hizo. Es el
    /// mismo orden que pide el encargo, y **nunca** se inventa una direccion a
    /// partir del identificador: si no hay ninguna de las dos, no hay imagen y
    /// quien pinte pone su placeholder.
    pub fn imagen(&self) -> &str {
        if !self.portada.trim().is_empty() {
            return self.portada.trim();
        }
        self.autor.avatar.trim()
    }

    /// Si esta voz ya se puede usar para sintetizar.
    pub fn lista(&self) -> bool {
        self.estado.is_empty() || self.estado == "trained"
    }
}

/// Una pagina del catalogo.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PaginaVoces {
    /// Cuantas hay en total con esos filtros, segun la API.
    pub total: u64,
    /// Que pagina se pidio (1 = la primera).
    pub pagina: u32,
    pub tamano: u32,
    pub items: Vec<VozFish>,
}

impl PaginaVoces {
    /// Si queda algo por traer.
    pub fn hay_mas(&self) -> bool {
        let traidas = (self.pagina.max(1) * self.tamano) as u64;
        traidas < self.total
    }
}

/// Lo que se le puede pedir al catalogo.
///
/// Solo lo que la API confirma: buscar por titulo, un idioma, una etiqueta, un
/// autor, y si son las voces propias. Nada de campos inventados.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct FiltrosVoces {
    /// Texto libre: la API lo busca en el titulo.
    pub buscar: String,
    pub idioma: String,
    pub tag: String,
    /// Identificador del autor (no su nombre: la API pide el id).
    pub autor: String,
    /// Solo las voces de mi cuenta.
    pub propios: bool,
    pub pagina: u32,
    pub tamano: u32,
}

impl FiltrosVoces {
    /// Los filtros con la pagina y el tamaño ya saneados.
    fn saneados(&self) -> (u32, u32) {
        let pagina = self.pagina.max(1);
        let tamano = match self.tamano {
            0 => TAMANO_POR_DEFECTO,
            otro => otro.min(TAMANO_MAXIMO),
        };
        (pagina, tamano)
    }
}

/// La direccion del catalogo con los filtros puestos.
///
/// Se arma a mano y **con escape**: el texto que escribe el streamer va dentro de
/// la consulta, y una `&` suelta partiria la direccion por la mitad.
pub fn url_listar(filtros: &FiltrosVoces) -> String {
    let (pagina, tamano) = filtros.saneados();
    let mut partes = vec![
        format!("page_number={pagina}"),
        format!("page_size={tamano}"),
    ];
    let mut anadir = |clave: &str, valor: &str| {
        let valor = valor.trim();
        if !valor.is_empty() {
            partes.push(format!("{clave}={}", escapar(valor)));
        }
    };
    anadir("title", &filtros.buscar);
    anadir("language", &filtros.idioma);
    anadir("tag", &filtros.tag);
    anadir("author_id", &filtros.autor);
    if filtros.propios {
        partes.push("self=true".to_string());
    }
    format!("{BASE}?{}", partes.join("&"))
}

/// La direccion de una voz concreta.
pub fn url_voz(id: &str) -> String {
    format!("{BASE}/{}", escapar(id.trim()))
}

/// Escapa un valor para que viaje dentro de una consulta.
fn escapar(valor: &str) -> String {
    let mut salida = String::with_capacity(valor.len());
    for byte in valor.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                salida.push(byte as char)
            }
            otro => salida.push_str(&format!("%{otro:02X}")),
        }
    }
    salida
}

/// Lee una pagina del catalogo.
pub async fn listar(fish: &FishAudio, filtros: &FiltrosVoces) -> Result<PaginaVoces> {
    let (pagina, tamano) = filtros.saneados();
    let json = fish.get_json(&url_listar(filtros)).await?;
    let mut leida = pagina_de_json(&json)?;
    leida.pagina = pagina;
    leida.tamano = tamano;
    Ok(leida)
}

/// Lee una voz concreta.
pub async fn obtener(fish: &FishAudio, id: &str) -> Result<VozFish> {
    let id = id.trim();
    if id.is_empty() {
        anyhow::bail!("falta el identificador de la voz");
    }
    let json = fish.get_json(&url_voz(id)).await?;
    Ok(voz_de_json(&json))
}

/// Interpreta la respuesta paginada.
///
/// Se acepta tanto `items` como una lista pelada: la API devuelve un objeto con
/// `total` e `items`, pero una respuesta sin `items` no puede tumbar la pantalla
/// —se lee como «no hay nada» y se dice—.
pub fn pagina_de_json(json: &serde_json::Value) -> Result<PaginaVoces> {
    let items = match json.get("items") {
        Some(serde_json::Value::Array(items)) => items.clone(),
        None => match json {
            serde_json::Value::Array(items) => items.clone(),
            _ => Vec::new(),
        },
        Some(_) => Vec::new(),
    };
    let total = json
        .get("total")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(items.len() as u64);

    Ok(PaginaVoces {
        total,
        pagina: 1,
        tamano: TAMANO_POR_DEFECTO,
        items: items.iter().map(voz_de_json).collect(),
    })
}

/// Traduce una voz de la API a lo que usa la aplicacion.
///
/// Todo es opcional y nada revienta: una voz a la que le falte la portada, el
/// autor o los idiomas se enseña igual, que es lo que hace falta para poder
/// recorrer un catalogo ajeno sin que una respuesta rara rompa la lista entera.
pub fn voz_de_json(json: &serde_json::Value) -> VozFish {
    let texto = |clave: &str| -> String {
        json.get(clave)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let lista = |clave: &str| -> Vec<String> {
        json.get(clave)
            .and_then(serde_json::Value::as_array)
            .map(|valores| {
                valores
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(|valor| valor.trim().to_string())
                    .filter(|valor| !valor.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let numero = |clave: &str| -> u64 {
        json.get(clave)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };

    // El identificador es lo unico sin lo que la voz no sirve. La API lo llama
    // `_id`; el SDK lo llama `id`. Se aceptan los dos porque los dos estan en su
    // documentacion.
    let id = match texto("_id") {
        vacio if vacio.is_empty() => texto("id"),
        con_valor => con_valor,
    };

    let autor_json = json.get("author").cloned().unwrap_or_default();
    let autor_texto = |clave: &str| -> String {
        autor_json
            .get(clave)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let muestras = json
        .get("samples")
        .and_then(serde_json::Value::as_array)
        .map(|valores| {
            valores
                .iter()
                .map(|muestra| MuestraVoz {
                    titulo: muestra
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                    texto: muestra
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                    audio: muestra
                        .get("audio")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                })
                .filter(MuestraVoz::suena)
                .collect()
        })
        .unwrap_or_default();

    VozFish {
        id,
        titulo: texto("title"),
        descripcion: texto("description"),
        // La portada y el avatar se resuelven aqui: la API los da relativos y quien
        // los pinta es un navegador, que los pediria al sitio equivocado.
        portada: absoluta(&texto("cover_image")),
        idiomas: lista("languages"),
        tags: lista("tags"),
        muestras,
        autor: AutorVoz {
            id: autor_texto("id"),
            nombre: autor_texto("nickname"),
            avatar: absoluta(&autor_texto("avatar")),
        },
        visibilidad: texto("visibility"),
        estado: texto("state"),
        me_gusta: numero("like_count"),
        usos: numero("task_count"),
        actualizado_en: texto("updated_at"),
    }
}

// ---------------------------------------------------------------------------
// La cache de portadas
// ---------------------------------------------------------------------------

/// Donde viven las portadas y las pruebas que se guardan.
///
/// Va aparte de `cache/tts` —que es audio de frases y se poda por tamaño— porque
/// esto es otra cosa: imagenes pequeñas y pruebas sueltas que el streamer ha
/// pedido a proposito.
pub fn cache_dir() -> PathBuf {
    crate::rutas::data_dir().join("cache").join("voces")
}

/// La carpeta de las portadas.
pub fn portadas_dir() -> PathBuf {
    cache_dir().join("portadas")
}

/// La ruta de la portada cacheada de una voz, si la hay.
///
/// Se busca por identificador y con cualquier extension: la API da la imagen en
/// el formato que sea, y lo que importa es encontrarla.
pub fn portada_cacheada(id: &str) -> Option<PathBuf> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let carpeta = portadas_dir();
    for extension in ["webp", "png", "jpg", "jpeg", "gif"] {
        let ruta = carpeta.join(format!("{id}.{extension}"));
        if ruta.is_file() {
            return Some(ruta);
        }
    }
    None
}

/// Quien descarga una imagen. Es un trait para probar el catalogo sin red.
pub trait Descargador: Send + Sync {
    fn traer<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>>>;
}

/// El descargador de verdad: `reqwest`.
///
/// Va con su propio cliente y **sin la clave**: una portada es una direccion
/// publica y no tiene por que llevar credencial ninguna.
pub struct DescargadorHttp {
    timeout: Duration,
    cliente: reqwest::Client,
}

impl DescargadorHttp {
    pub fn nuevo(timeout: Duration) -> Result<Self> {
        let cliente = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!(
                "tiktok-stream-dashboard/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .context("construyendo el cliente HTTPS de las portadas")?;
        Ok(Self { timeout, cliente })
    }
}

impl Descargador for DescargadorHttp {
    fn traer<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            let respuesta = self
                .cliente
                .get(url)
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("no se pudo descargar la imagen"))?;
            if !respuesta.status().is_success() {
                anyhow::bail!("la imagen respondio con {}", respuesta.status().as_u16());
            }
            let bytes = respuesta
                .bytes()
                .await
                .map_err(|_| anyhow::anyhow!("la imagen se corto al leerla"))?;
            if bytes.len() > MAX_PORTADA_BYTES {
                anyhow::bail!("la imagen pesa mas de lo que se guarda");
            }
            let _ = self.timeout;
            Ok(bytes.to_vec())
        })
    }
}

/// El tipo de imagen que se ha descargado, por su contenido.
///
/// Se mira **el contenido y no la extension de la URL**: la API puede servir una
/// webp desde una direccion sin extension, y guardarla como `.png` haria que el
/// navegador no la pintara.
fn extension_de(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("png");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("gif");
    }
    // WEBP: "RIFF" ... "WEBP".
    if &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// Guarda una portada descargada y devuelve su nombre de fichero.
pub fn guardar_portada(id: &str, bytes: &[u8]) -> Result<String> {
    let id = id.trim();
    if id.is_empty() {
        anyhow::bail!("una portada sin voz no se guarda");
    }
    let Some(extension) = extension_de(bytes) else {
        anyhow::bail!("lo que se descargo no era una imagen");
    };
    let carpeta = portadas_dir();
    std::fs::create_dir_all(&carpeta).with_context(|| format!("creando {}", carpeta.display()))?;
    // Se escribe con el nombre definitivo y de una vez: si se cortara a medias, la
    // proxima vez se leeria un fichero roto como si fuera la portada buena. El
    // temporal lleva el proceso delante para no chocar entre dos descargas.
    let destino = carpeta.join(format!("{id}.{extension}"));
    let temporal = carpeta.join(format!(".{id}.{}.tmp", std::process::id()));
    std::fs::write(&temporal, bytes)
        .with_context(|| format!("escribiendo {}", temporal.display()))?;
    std::fs::rename(&temporal, &destino)
        .with_context(|| format!("colocando {}", destino.display()))?;

    // Si antes habia otra con distinta extension, se va: dos portadas de la misma
    // voz solo hacen dudar de cual es la buena.
    for otra in ["webp", "png", "jpg", "jpeg", "gif"] {
        if otra == extension {
            continue;
        }
        let ruta = carpeta.join(format!("{id}.{otra}"));
        if ruta.is_file() {
            let _ = std::fs::remove_file(ruta);
        }
    }

    Ok(format!("{id}.{extension}"))
}

/// Descarga la portada de una voz y la deja en la cache. Devuelve su fichero.
///
/// Solo se llama con voces que el streamer ha **guardado** o al pedir el detalle
/// de una: bajar las portadas de todo lo que se explora seria traerse la
/// biblioteca entera de Fish a su disco sin que lo haya pedido.
pub async fn cachear_portada(descargador: &dyn Descargador, id: &str, url: &str) -> Result<String> {
    let url = url.trim();
    if url.is_empty() {
        anyhow::bail!("esa voz no trae portada");
    }
    let bytes = descargador.traer(url).await?;
    guardar_portada(id, &bytes)
}

/// Lee una portada de la cache. `None` si no esta.
pub fn leer_portada(archivo: &str) -> Option<(Vec<u8>, &'static str)> {
    // `Path::file_name` descarta cualquier intento de salir de la carpeta.
    let nombre = Path::new(archivo).file_name()?.to_str()?;
    if nombre.starts_with('.') {
        return None;
    }
    let ruta = portadas_dir().join(nombre);
    let bytes = std::fs::read(ruta).ok()?;
    let tipo = match extension_de(&bytes) {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    };
    Some((bytes, tipo))
}

/// La carpeta donde el proveedor deja los MP3 que sintetiza.
///
/// Es la del proveedor de voz —`cache/tts`—, no la de las voces: una prueba
/// sintetizada es audio de una frase, igual que cualquier otra locucion, y vive
/// donde viven las demas para que la poda de la cache las trate a todas igual.
pub fn cache_audio_dir() -> PathBuf {
    crate::rutas::data_dir().join("cache").join("tts")
}

/// Lee una prueba sintetizada de la cache de audio. `None` si no esta.
///
/// Igual que con las portadas, el nombre se queda en su ultimo tramo: una prueba
/// no puede sacar de su carpeta ni el fichero que la pide.
pub fn leer_prueba(archivo: &str) -> Option<Vec<u8>> {
    let nombre = Path::new(archivo).file_name()?.to_str()?;
    if nombre.starts_with('.') {
        return None;
    }
    std::fs::read(cache_audio_dir().join(nombre)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn la_direccion_lleva_los_filtros_confirmados() {
        let url = url_listar(&FiltrosVoces {
            buscar: "camila".into(),
            idioma: "es".into(),
            tag: "female".into(),
            autor: "abc123".into(),
            propios: true,
            pagina: 3,
            tamano: 12,
        });
        assert!(url.starts_with("https://api.fish.audio/model?"), "{url}");
        for trozo in [
            "page_number=3",
            "page_size=12",
            "title=camila",
            "language=es",
            "tag=female",
            "author_id=abc123",
            "self=true",
        ] {
            assert!(url.contains(trozo), "falta {trozo} en {url}");
        }
    }

    /// Un texto con `&` no puede partir la direccion por la mitad: el filtro se
    /// escaparia y la API recibiria otro distinto.
    #[test]
    fn el_texto_del_buscador_va_escapado() {
        let url = url_listar(&FiltrosVoces {
            buscar: "rock & roll".into(),
            ..FiltrosVoces::default()
        });
        assert!(url.contains("title=rock%20%26%20roll"), "{url}");
        assert_eq!(url.matches('&').count(), 2, "solo los separadores: {url}");
    }

    /// Sin filtros solo va la paginacion, y con el tamaño de fabrica.
    #[test]
    fn sin_filtros_solo_va_la_pagina() {
        let url = url_listar(&FiltrosVoces::default());
        assert_eq!(
            url,
            "https://api.fish.audio/model?page_number=1&page_size=24"
        );
    }

    /// Una pagina enorme se recorta: no se le piden 200 voces a la API.
    #[test]
    fn el_tamano_de_pagina_tiene_tope() {
        let url = url_listar(&FiltrosVoces {
            tamano: 500,
            ..FiltrosVoces::default()
        });
        assert!(url.contains(&format!("page_size={TAMANO_MAXIMO}")), "{url}");
    }

    #[test]
    fn la_direccion_de_una_voz_lleva_su_identificador() {
        assert_eq!(url_voz("abc-123"), "https://api.fish.audio/model/abc-123");
        assert_eq!(
            url_voz("  abc-123  "),
            "https://api.fish.audio/model/abc-123"
        );
        assert_eq!(url_voz("a/b"), "https://api.fish.audio/model/a%2Fb");
    }

    #[test]
    fn una_voz_se_lee_entera() {
        let voz = voz_de_json(&json!({
            "_id": "9a9cf47702da476aa4629e2506d4a857",
            "title": "Camila",
            "description": "Voz femenina",
            "cover_image": "https://cdn.fish.audio/cover.webp",
            "languages": ["es", "en"],
            "tags": ["female", "spanish"],
            "samples": [
                { "title": "Sample 1", "text": "Hola a todos", "audio": "https://cdn.fish.audio/s1.mp3" },
                { "title": "Sample 2", "text": "Sin audio" }
            ],
            "author": { "id": "u1", "nickname": "kato", "avatar": "https://cdn.fish.audio/a.png" },
            "visibility": "public",
            "state": "trained",
            "like_count": 12,
            "task_count": 340,
            "updated_at": "2026-09-01T00:00:00Z"
        }));
        assert_eq!(voz.id, "9a9cf47702da476aa4629e2506d4a857");
        assert_eq!(voz.titulo, "Camila");
        assert_eq!(voz.idiomas, vec!["es", "en"]);
        assert_eq!(voz.idioma(), "es");
        assert_eq!(voz.tags, vec!["female", "spanish"]);
        assert_eq!(voz.autor.nombre, "kato");
        assert_eq!(voz.autor.id, "u1");
        assert_eq!(voz.me_gusta, 12);
        assert_eq!(voz.usos, 340);
        assert!(voz.lista(), "una voz entrenada se puede usar");
        // La muestra sin audio no se ofrece: un ▶ que no suena es una promesa
        // vacia en la tarjeta.
        assert_eq!(voz.muestras.len(), 1);
        assert_eq!(voz.muestras[0].texto, "Hola a todos");
    }

    /// La imagen cae de la portada al avatar, y de ahi a nada. **Nunca** se arma
    /// una direccion con el identificador.
    #[test]
    fn la_imagen_cae_de_la_portada_al_avatar() {
        let con_portada = voz_de_json(&json!({
            "id": "x",
            "cover_image": "https://cdn/cover.png",
            "author": { "avatar": "https://cdn/avatar.png" }
        }));
        assert_eq!(con_portada.imagen(), "https://cdn/cover.png");

        let sin_portada = voz_de_json(&json!({
            "id": "x",
            "cover_image": "",
            "author": { "avatar": "https://cdn/avatar.png" }
        }));
        assert_eq!(sin_portada.imagen(), "https://cdn/avatar.png");

        let sin_nada = voz_de_json(&json!({ "id": "x" }));
        assert_eq!(
            sin_nada.imagen(),
            "",
            "mejor nada que una direccion inventada"
        );
    }

    /// Una respuesta rara no puede tumbar la lista: lo que falte se queda vacio.
    #[test]
    fn una_voz_a_la_que_le_falta_todo_se_lee_igual() {
        let voz = voz_de_json(&json!({ "id": "solo-el-id" }));
        assert_eq!(voz.id, "solo-el-id");
        assert_eq!(voz.titulo, "");
        assert!(voz.idiomas.is_empty());
        assert!(voz.muestras.is_empty());
        assert!(voz.lista(), "sin estado no se puede decir que no valga");
    }

    /// La portada y el avatar vienen **relativos** y se resuelven al leerlos.
    ///
    /// Es lo que comprueba por que existe `absoluta`: con `coverimage/<id>` tal cual,
    /// el navegador la pide al panel y no hay imagen.
    #[test]
    fn la_portada_relativa_se_resuelve_contra_la_base_de_medios() {
        let voz = voz_de_json(&json!({
            "_id": "v1",
            "title": "Camila",
            "cover_image": "coverimage/5161d41404314212af1254556477c17d",
            "author": { "nickname": "kato", "avatar": "/avatar/u1.png" }
        }));
        assert_eq!(
            voz.portada,
            "https://public-platform.r2.fish.audio/coverimage/5161d41404314212af1254556477c17d"
        );
        assert_eq!(
            voz.autor.avatar,
            "https://public-platform.r2.fish.audio/avatar/u1.png"
        );

        // Lo que ya es absoluto se respeta tal cual.
        let absoluta = voz_de_json(&json!({
            "id": "v2",
            "cover_image": "https://otro.example/c.png"
        }));
        assert_eq!(absoluta.portada, "https://otro.example/c.png");

        // Y sin portada no se inventa ninguna direccion.
        let sin_nada = voz_de_json(&json!({ "id": "v3" }));
        assert_eq!(sin_nada.portada, "");
        assert_eq!(sin_nada.autor.avatar, "");
    }

    /// Las muestras se dejan **tal cual vienen**: son direcciones absolutas y
    /// firmadas, y reescribirlas las romperia.
    #[test]
    fn las_muestras_no_se_tocan() {
        let firmada =
            "https://c97f.r2.cloudflarestorage.com/fish/task/abc.mp3?X-Amz-Signature=deadbeef";
        let voz = voz_de_json(&json!({
            "id": "v1",
            "samples": [{ "title": "Sample 1", "text": "hola", "audio": firmada }]
        }));
        assert_eq!(voz.muestras.len(), 1);
        assert_eq!(voz.muestras[0].audio, firmada);
    }

    #[test]
    fn la_pagina_se_lee_con_su_total_y_sus_voces() {
        let pagina = pagina_de_json(&json!({
            "total": 120,
            "items": [ { "id": "a" }, { "id": "b" } ]
        }))
        .expect("deberia leer la pagina");
        assert_eq!(pagina.total, 120);
        assert_eq!(pagina.items.len(), 2);
        assert!(pagina.hay_mas());

        let ultima = PaginaVoces {
            total: 120,
            pagina: 5,
            tamano: 24,
            items: vec![],
        };
        assert!(
            !ultima.hay_mas(),
            "la quinta pagina de 24 ya llega al total"
        );
    }

    #[test]
    fn una_respuesta_sin_items_no_revienta() {
        let pagina = pagina_de_json(&json!({ "total": 3 })).expect("se lee igual");
        assert_eq!(pagina.total, 3);
        assert!(pagina.items.is_empty());
        // Y una lista pelada tambien vale.
        let pelada = pagina_de_json(&json!([{ "id": "a" }])).expect("se lee igual");
        assert_eq!(pelada.items.len(), 1);
        assert_eq!(pelada.total, 1);
    }

    #[test]
    fn el_tipo_de_imagen_se_mira_en_el_contenido() {
        assert_eq!(
            extension_de(&[0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            Some("jpg")
        );
        assert_eq!(
            extension_de(&[0x89, b'P', b'N', b'G', 0, 0, 0, 0, 0, 0, 0, 0]),
            Some("png")
        );
        let mut riff = b"RIFF".to_vec();
        riff.extend_from_slice(&[0, 0, 0, 0]);
        riff.extend_from_slice(b"WEBP");
        assert_eq!(extension_de(&riff), Some("webp"));
        assert_eq!(extension_de(b"no soy una imagen"), None);
    }

    /// La portada se guarda con la extension de su contenido y sustituye a la
    /// anterior: dos ficheros de la misma voz solo hacen dudar de cual es.
    #[test]
    fn la_portada_se_guarda_y_sustituye() {
        let id = format!("prueba-portada-{}", std::process::id());
        let png = [0x89, b'P', b'N', b'G', 0, 0, 0, 0, 0, 0, 0, 0];
        let archivo = guardar_portada(&id, &png).expect("deberia guardar");
        assert_eq!(archivo, format!("{id}.png"));
        assert!(portada_cacheada(&id).is_some());

        let mut riff = b"RIFF".to_vec();
        riff.extend_from_slice(&[0, 0, 0, 0]);
        riff.extend_from_slice(b"WEBP");
        let archivo = guardar_portada(&id, &riff).expect("deberia sustituir");
        assert_eq!(archivo, format!("{id}.webp"));
        assert!(portada_cacheada(&id).is_some());
        assert!(
            !portadas_dir().join(format!("{id}.png")).exists(),
            "la vieja se va"
        );

        let _ = std::fs::remove_file(portadas_dir().join(archivo));
    }

    #[test]
    fn una_cosa_que_no_es_imagen_no_se_guarda() {
        let id = format!("prueba-no-imagen-{}", std::process::id());
        assert!(guardar_portada(&id, b"<html>no</html>").is_err());
        assert!(portada_cacheada(&id).is_none());
    }

    /// Leer una portada no puede salirse de su carpeta.
    #[test]
    fn una_portada_no_puede_salir_de_su_carpeta() {
        assert!(leer_portada("../../etc/passwd").is_none());
        assert!(leer_portada(".oculto.png").is_none());
    }
}
