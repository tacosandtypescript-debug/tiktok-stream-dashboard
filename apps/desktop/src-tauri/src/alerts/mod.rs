//! Alertas para OBS: avisos con su medio, su texto y su sonido.
//!
//! Es lo que en StreamElements o StreamLabs se llama *alert box*: cuando alguien
//! regala, sigue, comparte, se suscribe o suelta una rafaga de likes, sale un
//! aviso en pantalla con una imagen, un GIF, un video o un sonido.
//!
//! Tres decisiones que estan en este fichero:
//!
//!   * **El texto se compone aqui, no en el overlay.** La plantilla la escribe el
//!     streamer, pero rellenarla es del motor: asi hay una sola interpolacion, y
//!     el overlay solo pinta lo que le llega. Es el mismo criterio que las frases
//!     del lector de voz, que tambien se componen en Rust.
//!   * **Los medios son del proyecto, no del disco del streamer.** Se copian a la
//!     carpeta de datos y los sirve el servidor de overlays: una ruta de
//!     `C:\Users\...\Escritorio\gif bueno (2).gif` se rompe en cuanto se mueve un
//!     fichero, y en OBS se ve un hueco.
//!   * **La cola guarda lo que no se pudo entregar.** Si la fuente de OBS no esta
//!     cargada, el aviso espera en vez de perderse: con `Refresh browser when scene
//!     becomes active`, que es lo normal, un cambio de escena no se come la alerta
//!     del regalo grande.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::core::event::UserRef;

/// Avisos que se guardan sin entregar. Mas alla de esto, lo viejo se descarta:
/// una ristra de alertas de hace diez minutos no la quiere nadie.
pub const TOPE_PENDIENTES: usize = 20;

/// Tamano maximo de un medio importado.
///
/// Un GIF de reaccion ronda el mega y un video corto, unos cuantos. El tope esta
/// para que nadie meta un `.mkv` de dos gigas en el overlay por accidente.
pub const TAMANO_MAXIMO: u64 = 48 * 1024 * 1024;

/// Extensiones que se aceptan, con su tipo MIME.
///
/// Lista blanca y no lista negra: lo que no este aqui no entra, asi no hay que
/// imaginarse que formato raro puede colarse.
pub const ACEPTADOS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("apng", "image/apng"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
    ("m4a", "audio/mp4"),
];

/// Los siete avisos que existen.
///
/// El identificador viaja en el JSON y se guarda en los ajustes, asi que **no se
/// puede renombrar** sin migrar. Las entradas a la sala no estan a proposito: son
/// el mensaje mas frecuente de TikTok y con una alerta por entrada la cola se
/// comeria las de los regalos.
///
/// Los regalos van **por tramos** —normal, grande y enorme— porque un regalo de
/// diez diamantes no puede sonar igual que uno de cinco mil: es la diferencia
/// entre una alerta que acompaña al directo y una que lo interrumpe. Cual de los
/// tres toca lo decide [`tramo_de_regalo`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TipoAviso {
    Gift,
    GiftGrande,
    GiftEnorme,
    Follow,
    Subscribe,
    Share,
    Like,
}

impl TipoAviso {
    pub const TODOS: [TipoAviso; 7] = [
        TipoAviso::Gift,
        TipoAviso::GiftGrande,
        TipoAviso::GiftEnorme,
        TipoAviso::Follow,
        TipoAviso::Subscribe,
        TipoAviso::Share,
        TipoAviso::Like,
    ];

    /// Los tramos de regalo, **de mayor a menor**.
    ///
    /// El orden importa y es el que usa [`tramo_de_regalo`]: se mira primero el mas
    /// alto para que un regalo de cinco mil no se conforme con el tramo normal.
    pub const TRAMOS_DE_REGALO: [TipoAviso; 3] = [
        TipoAviso::GiftEnorme,
        TipoAviso::GiftGrande,
        TipoAviso::Gift,
    ];

    /// Identificador estable. Es el que va en la URL y en el JSON.
    pub fn id(self) -> &'static str {
        match self {
            TipoAviso::Gift => "gift",
            TipoAviso::GiftGrande => "gift_grande",
            TipoAviso::GiftEnorme => "gift_enorme",
            TipoAviso::Follow => "follow",
            TipoAviso::Subscribe => "subscribe",
            TipoAviso::Share => "share",
            TipoAviso::Like => "like",
        }
    }

    /// El tipo con ese identificador, si existe.
    pub fn desde_id(id: &str) -> Option<TipoAviso> {
        match id {
            "gift" => Some(TipoAviso::Gift),
            "gift_grande" => Some(TipoAviso::GiftGrande),
            "gift_enorme" => Some(TipoAviso::GiftEnorme),
            "follow" => Some(TipoAviso::Follow),
            "subscribe" => Some(TipoAviso::Subscribe),
            "share" => Some(TipoAviso::Share),
            "like" => Some(TipoAviso::Like),
            _ => None,
        }
    }

    /// Si este aviso tiene sentido con un minimo (diamantes o likes).
    ///
    /// Un follow no tiene cantidad con la que filtrar, asi que ofrecer un minimo
    /// ahi seria un campo que no hace nada.
    pub fn admite_minimo(self) -> bool {
        matches!(
            self,
            TipoAviso::Gift | TipoAviso::GiftGrande | TipoAviso::GiftEnorme | TipoAviso::Like
        )
    }

    /// Los nombres de las variables que esta plantilla puede usar.
    pub fn variables(self) -> &'static [&'static str] {
        match self {
            TipoAviso::Gift | TipoAviso::GiftGrande | TipoAviso::GiftEnorme => {
                &["usuario", "regalo", "cantidad", "diamantes"]
            }
            TipoAviso::Follow => &["usuario"],
            TipoAviso::Subscribe => &["usuario", "meses", "meses_texto"],
            TipoAviso::Share => &["usuario"],
            TipoAviso::Like => &["usuario", "likes"],
        }
    }
}

/// Que tramo de regalo le toca a una aportacion de `diamantes`.
///
/// Se recorre [`TipoAviso::TRAMOS_DE_REGALO`] de mayor a menor y gana el primero
/// que sirva: util —encendido y con algo que enseñar— y con su `minimo` cumplido.
///
/// Se **cae al tramo de abajo** cuando el de arriba no sirve, y eso es a
/// proposito: apagar el aviso de los regalos enormes no puede significar que un
/// leon entre sin ninguna alerta. Lo que si se respeta es el minimo del tramo al
/// que se cae, asi que una racha por debajo del minimo del normal sigue sin
/// sonar, que es como estaba.
pub fn tramo_de_regalo(ajustes: &AjustesAlertas, diamantes: i64) -> Option<TipoAviso> {
    TipoAviso::TRAMOS_DE_REGALO.into_iter().find(|tramo| {
        let ajuste = ajustes.de(*tramo);
        ajuste.util() && diamantes >= ajuste.minimo
    })
}

/// Lo que se puede configurar de un tipo de aviso.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AjusteAviso {
    pub activo: bool,
    /// Plantilla del texto. Las variables van entre llaves.
    pub texto: String,
    /// Nombre del fichero en el almacen de medios, o vacio.
    #[serde(default)]
    pub medio: String,
    /// Nombre del fichero de sonido, o vacio.
    #[serde(default)]
    pub sonido: String,
    pub duracion_ms: u32,
    pub volumen: f32,
    /// Minimo para que dispare: diamantes en regalos, likes en rafagas.
    #[serde(default)]
    pub minimo: i64,
}

impl AjusteAviso {
    /// Si el aviso esta listo para salir: activo y con algo que enseñar.
    ///
    /// Sin texto y sin medio no hay alerta: un aviso vacio que dura tres segundos
    /// es peor que no tenerlo.
    pub fn util(&self) -> bool {
        self.activo && (!self.texto.trim().is_empty() || !self.medio.is_empty())
    }
}

/// Por donde se oyen las alertas **en esta maquina**.
///
/// Conviene no confundirlo, porque es facil: a la audiencia le llega el sonido por
/// la fuente de OBS, no por aqui. Esto es para que el streamer las oiga el tambien
/// —al probar un aviso, y si quiere durante el directo— en el dispositivo que elija.
/// Es el mismo criterio que el lector de voz, que ya tiene su selector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SalidaAlertas {
    /// Nombre del dispositivo de salida. Vacio = el que tenga el sistema.
    #[serde(default)]
    pub dispositivo: String,
    /// Volumen del monitor, 0..1. No toca el que oye la audiencia.
    #[serde(default = "volumen_de_fabrica")]
    pub volumen: f32,
    /// Si ademas de por OBS suenan aqui durante el directo.
    ///
    /// Apagado por defecto: en directo ya las oyes por OBS, y sonar dos veces es
    /// peor que no oirlas.
    #[serde(default)]
    pub en_directo: bool,
}

fn volumen_de_fabrica() -> f32 {
    0.8
}

impl Default for SalidaAlertas {
    fn default() -> Self {
        Self {
            dispositivo: String::new(),
            volumen: volumen_de_fabrica(),
            en_directo: false,
        }
    }
}

impl SalidaAlertas {
    /// El dispositivo elegido, si hay uno. Vacio significa "el del sistema".
    pub fn dispositivo(&self) -> Option<&str> {
        let nombre = self.dispositivo.trim();
        (!nombre.is_empty()).then_some(nombre)
    }
}

/// Los siete ajustes, uno por tipo, mas por donde se oyen aqui.
///
/// Campos con nombre y no un mapa: asi el JSON es estable, el compilador obliga a
/// rellenar los siete y un tipo nuevo no se olvida en silencio.
///
/// Los dos tramos de regalo nuevos llevan `#[serde(default)]` para que los ajustes
/// guardados **antes** de que existieran sigan cargando: un perfil de la version
/// anterior no tiene esas claves y sin el `default` no abriria.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AjustesAlertas {
    pub gift: AjusteAviso,
    #[serde(default = "tramo_grande_de_fabrica")]
    pub gift_grande: AjusteAviso,
    #[serde(default = "tramo_enorme_de_fabrica")]
    pub gift_enorme: AjusteAviso,
    pub follow: AjusteAviso,
    pub subscribe: AjusteAviso,
    pub share: AjusteAviso,
    pub like: AjusteAviso,
    /// Aditivo a proposito: los ajustes guardados antes de que existiera este campo
    /// siguen cargando, con los valores de fabrica. Mismo criterio que el resto.
    #[serde(default)]
    pub salida: SalidaAlertas,
}

impl AjustesAlertas {
    pub fn de(&self, tipo: TipoAviso) -> &AjusteAviso {
        match tipo {
            TipoAviso::Gift => &self.gift,
            TipoAviso::GiftGrande => &self.gift_grande,
            TipoAviso::GiftEnorme => &self.gift_enorme,
            TipoAviso::Follow => &self.follow,
            TipoAviso::Subscribe => &self.subscribe,
            TipoAviso::Share => &self.share,
            TipoAviso::Like => &self.like,
        }
    }

    pub fn de_mut(&mut self, tipo: TipoAviso) -> &mut AjusteAviso {
        match tipo {
            TipoAviso::Gift => &mut self.gift,
            TipoAviso::GiftGrande => &mut self.gift_grande,
            TipoAviso::GiftEnorme => &mut self.gift_enorme,
            TipoAviso::Follow => &mut self.follow,
            TipoAviso::Subscribe => &mut self.subscribe,
            TipoAviso::Share => &mut self.share,
            TipoAviso::Like => &mut self.like,
        }
    }

    /// Los tres primeros vienen encendidos: son los que el streamer espera ver sin
    /// tener que configurar nada. Compartidos y likes, apagados: un share sale
    /// poco y una rafaga de likes puede ser constante.
    ///
    /// Los siete traen sonido y texto, para que un directo recien instalado suene
    /// sin tocar nada. Los sonidos son **del proyecto**: los genera
    /// `scripts/generar-sonidos.mjs` y viajan dentro del ejecutable.
    pub fn de_fabrica() -> Self {
        Self {
            gift: AjusteAviso {
                activo: true,
                texto: "{usuario} donó {regalo} ×{cantidad}".to_string(),
                medio: String::new(),
                sonido: pack::CAMPANA_SUAVE.to_string(),
                duracion_ms: 5000,
                volumen: 0.8,
                // Con una rosa no salta: en un directo movido, cada rosa es una
                // alerta y el aviso del regalo grande se pierde entre ellas.
                minimo: 10,
            },
            gift_grande: tramo_grande_de_fabrica(),
            gift_enorme: tramo_enorme_de_fabrica(),
            follow: AjusteAviso {
                activo: true,
                texto: "{usuario} te sigue".to_string(),
                medio: String::new(),
                sonido: pack::SUBIDA.to_string(),
                duracion_ms: 4000,
                volumen: 0.8,
                minimo: 0,
            },
            subscribe: AjusteAviso {
                activo: true,
                texto: "{usuario} se suscribió ({meses_texto})".to_string(),
                medio: String::new(),
                sonido: pack::FANFARRIA.to_string(),
                duracion_ms: 5000,
                volumen: 0.8,
                minimo: 0,
            },
            share: AjusteAviso {
                activo: false,
                texto: "{usuario} compartió el directo".to_string(),
                medio: String::new(),
                sonido: pack::TOQUE.to_string(),
                duracion_ms: 4000,
                volumen: 0.75,
                minimo: 0,
            },
            like: AjusteAviso {
                activo: false,
                texto: "{usuario} +{likes} likes".to_string(),
                medio: String::new(),
                sonido: pack::PIZCA.to_string(),
                duracion_ms: 3500,
                volumen: 0.6,
                minimo: 50,
            },
            salida: SalidaAlertas::default(),
        }
    }
}

/// El tramo grande de fabrica.
///
/// Es una funcion y no un literal repetido porque la usan **dos** sitios: los
/// ajustes de fabrica y el `#[serde(default)]` de `AjustesAlertas`, que es el que
/// rellena el hueco de un perfil guardado antes de que este tramo existiera. Con
/// el valor escrito dos veces, un dia se cambiaria uno y no el otro.
fn tramo_grande_de_fabrica() -> AjusteAviso {
    AjusteAviso {
        activo: true,
        texto: "{usuario} suelta {regalo} ×{cantidad}".to_string(),
        medio: String::new(),
        sonido: pack::CAMPANA_BRILLANTE.to_string(),
        duracion_ms: 6000,
        volumen: 0.85,
        // Cien diamantes es el terreno de las gafas de sol y los corazones con las
        // manos: regalos que ya se notan, pero que no son el momento del directo.
        minimo: 100,
    }
}

/// El tramo enorme de fabrica. Mismo motivo que el grande para ser funcion.
fn tramo_enorme_de_fabrica() -> AjusteAviso {
    AjusteAviso {
        activo: true,
        texto: "¡{usuario} va en serio! {regalo} ×{cantidad}".to_string(),
        medio: String::new(),
        sonido: pack::REDOBLE.to_string(),
        duracion_ms: 8000,
        volumen: 0.9,
        // Mil diamantes es una galaxia. Si esto entra, el directo para.
        minimo: 1000,
    }
}

impl Default for AjustesAlertas {
    fn default() -> Self {
        Self::de_fabrica()
    }
}

/// Duracion minima y maxima de un aviso, y longitud maxima de la plantilla.
///
/// Son topes del motor y no de la interfaz: los ajustes pueden llegar de
/// cualquier sitio —un fichero tocado a mano, un renderer con una idea rara— y una
/// duracion de un millon de milisegundos dejaria la fuente de OBS ocupada durante
/// horas.
pub const DURACION_MINIMA_MS: u32 = 500;
pub const DURACION_MAXIMA_MS: u32 = 60_000;
pub const TEXTO_MAXIMO: usize = 200;

impl AjustesAlertas {
    /// Deja los ajustes en valores que el motor puede cumplir.
    ///
    /// Se llama **al guardar**, no al leer: lo que hay en la base ya paso por
    /// aqui, y saneando tambien al leer se taparia un fichero corrupto en vez de
    /// avisar.
    pub fn sanear(&mut self, medios: &[String]) {
        for tipo in TipoAviso::TODOS {
            let ajuste = self.de_mut(tipo);
            ajuste.duracion_ms = ajuste
                .duracion_ms
                .clamp(DURACION_MINIMA_MS, DURACION_MAXIMA_MS);
            ajuste.volumen = if ajuste.volumen.is_finite() {
                ajuste.volumen.clamp(0.0, 1.0)
            } else {
                0.8
            };
            ajuste.minimo = ajuste.minimo.max(0);
            if !tipo.admite_minimo() {
                // Un minimo en un follow no filtraria nada y solo confundiria.
                ajuste.minimo = 0;
            }
            ajuste.texto = ajuste.texto.chars().take(TEXTO_MAXIMO).collect();
            // Un medio que ya no esta en el almacen se limpia: si no, el aviso
            // saldria con un hueco donde iba la imagen y nadie sabria por que.
            if !medios.iter().any(|nombre| nombre == &ajuste.medio) {
                ajuste.medio.clear();
            }
            if !medios.iter().any(|nombre| nombre == &ajuste.sonido) {
                ajuste.sonido.clear();
            }
        }

        // El monitor de esta maquina. El dispositivo no se valida aqui: si el
        // elegido ya no existe, el reproductor degrada a mudo y lo dice, que es
        // mejor que borrarle la eleccion al streamer por un cable desconectado.
        self.salida.volumen = if self.salida.volumen.is_finite() {
            self.salida.volumen.clamp(0.0, 1.0)
        } else {
            volumen_de_fabrica()
        };
        self.salida.dispositivo = self.salida.dispositivo.trim().to_string();
    }
}

/// Los valores con los que se rellena una plantilla.
#[derive(Debug, Clone, Default)]
pub struct Variables {
    pub usuario: String,
    pub regalo: String,
    pub cantidad: i64,
    pub diamantes: i64,
    pub meses: i64,
    pub likes: i64,
}

impl Variables {
    /// El valor de una variable, o `None` si ese nombre no existe.
    ///
    /// Se distingue "no existe" de "esta vacio" a proposito: una variable que no
    /// aplica a este aviso —`{regalo}` en un follow— se sustituye por nada, pero
    /// un nombre mal escrito se deja **tal cual** para que el streamer vea el
    /// error en vez de un hueco inexplicable.
    fn valor(&self, nombre: &str) -> Option<String> {
        match nombre {
            "usuario" => Some(self.usuario.clone()),
            "regalo" => Some(self.regalo.clone()),
            "cantidad" => Some(self.cantidad.to_string()),
            "diamantes" => Some(self.diamantes.to_string()),
            "meses" => Some(self.meses.to_string()),
            "meses_texto" => Some(if self.meses == 1 {
                "1 mes".to_string()
            } else {
                format!("{} meses", self.meses)
            }),
            "likes" => Some(self.likes.to_string()),
            _ => None,
        }
    }
}

/// Rellena una plantilla: `{usuario} donó {regalo}`.
///
/// Un `{` sin cerrar o un nombre desconocido se dejan como estan; es lo que hace
/// que un error de escritura se vea en pantalla en vez de desaparecer.
pub fn componer(plantilla: &str, variables: &Variables) -> String {
    let mut salida = String::with_capacity(plantilla.len() + 32);
    let mut resto = plantilla;
    while let Some(inicio) = resto.find('{') {
        salida.push_str(&resto[..inicio]);
        let tras = &resto[inicio + 1..];
        match tras.find('}') {
            Some(fin) => {
                let nombre = &tras[..fin];
                match variables.valor(nombre) {
                    Some(valor) => salida.push_str(&valor),
                    None => {
                        salida.push('{');
                        salida.push_str(nombre);
                        salida.push('}');
                    }
                }
                resto = &tras[fin + 1..];
            }
            None => {
                // Sin cierre: el resto es texto literal.
                salida.push_str(&resto[inicio..]);
                resto = "";
            }
        }
    }
    salida.push_str(resto);
    salida.trim().to_string()
}

/// El nombre visible de quien manda el aviso.
pub fn nombre_de(usuario: &UserRef) -> String {
    if !usuario.nickname.trim().is_empty() {
        usuario.nickname.clone()
    } else if !usuario.unique_id.trim().is_empty() {
        format!("@{}", usuario.unique_id)
    } else {
        // Sin nombre no se inventa uno vacio: el aviso tiene que leerse.
        "Alguien".to_string()
    }
}

/// Un aviso listo para salir por el WebSocket.
///
/// Lleva el **texto ya compuesto** y los **nombres** de fichero, no URLs: la
/// direccion la arma el overlay con su propio origen, y asi el token no viaja
/// dentro del mensaje.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Aviso {
    pub seq: u64,
    pub tipo: String,
    pub texto: String,
    #[serde(default)]
    pub medio: String,
    #[serde(default)]
    pub sonido: String,
    pub duracion_ms: u32,
    pub volumen: f32,
}

impl Aviso {
    /// Un aviso a partir del ajuste y de los datos del evento.
    pub fn nuevo(seq: u64, tipo: TipoAviso, ajuste: &AjusteAviso, variables: Variables) -> Self {
        Self {
            seq,
            tipo: tipo.id().to_string(),
            texto: componer(&ajuste.texto, &variables),
            medio: ajuste.medio.clone(),
            sonido: ajuste.sonido.clone(),
            duracion_ms: ajuste.duracion_ms,
            volumen: ajuste.volumen,
        }
    }

    /// Un aviso de mentira, para el boton de probar.
    ///
    /// Existe para que el streamer pueda ajustar sin esperar a que alguien regale
    /// algo: sin esto, configurar la duracion o el volumen es a ciegas.
    pub fn demo(seq: u64, tipo: TipoAviso, ajuste: &AjusteAviso) -> Self {
        let variables = match tipo {
            TipoAviso::Gift => Variables {
                usuario: "Alguien".into(),
                regalo: "Rosa".into(),
                cantidad: 5,
                diamantes: 5,
                ..Variables::default()
            },
            TipoAviso::Subscribe => Variables {
                usuario: "Alguien".into(),
                meses: 3,
                ..Variables::default()
            },
            TipoAviso::Like => Variables {
                usuario: "Alguien".into(),
                likes: 100,
                ..Variables::default()
            },
            _ => Variables {
                usuario: "Alguien".into(),
                ..Variables::default()
            },
        };
        Self::nuevo(seq, tipo, ajuste, variables)
    }
}

/// Los nombres del pack de sonidos que trae la aplicacion.
///
/// Estan aqui, en un solo sitio, porque los usan **dos**: los ajustes de fabrica
/// —que apuntan a ellos— y la siembra del almacen —que los escribe—. Con el nombre
/// escrito en los dos lados, un dia se cambiaria uno y el aviso quedaria mudo sin
/// que nada fallara.
pub mod pack {
    pub const CAMPANA_SUAVE: &str = "campana-suave.wav";
    pub const CAMPANA_BRILLANTE: &str = "campana-brillante.wav";
    pub const REDOBLE: &str = "redoble.wav";
    pub const SUBIDA: &str = "subida.wav";
    pub const FANFARRIA: &str = "fanfarria.wav";
    pub const TOQUE: &str = "toque.wav";
    pub const PIZCA: &str = "pizca.wav";
}

/// El almacen de medios: lo que el streamer ha cargado, copiado a nuestra carpeta.
///
/// Lleva la carpeta dentro y no la consulta al entorno en cada llamada: los tests
/// comparten el entorno del proceso, asi que una funcion que leyera
/// `TTSDASH_DATA_DIR` por dentro seria imposible de probar sin escribir en la
/// carpeta real del streamer. `en()` existe para eso.
pub struct Almacen {
    dir: PathBuf,
}

/// Los sonidos que van **dentro del ejecutable**.
///
/// Son propios: los sintetiza `scripts/generar-sonidos.mjs` y se versionan en
/// `src-tauri/sonidos/`. Van embebidos y no repartidos al lado porque la release
/// son dos ficheros y no tiene por que pasar a ser nueve: una carpeta de assets
/// que se queda a medias al copiar es justo el fallo que ya costo una tarde con el
/// motor de voz.
const PACK: &[(&str, &[u8])] = &[
    (
        pack::CAMPANA_SUAVE,
        include_bytes!("../../sonidos/campana-suave.wav"),
    ),
    (
        pack::CAMPANA_BRILLANTE,
        include_bytes!("../../sonidos/campana-brillante.wav"),
    ),
    (pack::REDOBLE, include_bytes!("../../sonidos/redoble.wav")),
    (pack::SUBIDA, include_bytes!("../../sonidos/subida.wav")),
    (
        pack::FANFARRIA,
        include_bytes!("../../sonidos/fanfarria.wav"),
    ),
    (pack::TOQUE, include_bytes!("../../sonidos/toque.wav")),
    (pack::PIZCA, include_bytes!("../../sonidos/pizca.wav")),
];

impl Almacen {
    /// El almacen de verdad: junto a la base y los logs.
    pub fn nuevo() -> Self {
        Self::en(crate::database::data_dir().join("alertas"))
    }

    /// Un almacen en otra carpeta. Lo usan los tests.
    pub fn en(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Escribe en el almacen los sonidos del pack que **falten**.
    ///
    /// Devuelve cuantos ha escrito. No pisa nada: si ya hay un fichero con ese
    /// nombre se respeta, porque puede ser uno que el streamer haya puesto en su
    /// sitio a proposito. Es idempotente —la segunda pasada escribe cero— y por eso
    /// se puede llamar en cada arranque sin miedo.
    ///
    /// Se llama al abrir la aplicacion y **no** en el camino de una alerta: escribir
    /// siete ficheros no puede estar entre un regalo y su aviso.
    pub fn sembrar_pack(&self) -> usize {
        if std::fs::create_dir_all(&self.dir).is_err() {
            return 0;
        }
        let mut escritos = 0;
        for (nombre, bytes) in PACK {
            let destino = self.dir.join(nombre);
            if destino.exists() {
                continue;
            }
            match std::fs::write(&destino, bytes) {
                Ok(()) => escritos += 1,
                // Un fichero que no se puede escribir no puede tumbar el arranque:
                // los avisos funcionan igual, sin ese sonido.
                Err(error) => {
                    tracing::warn!(fichero = nombre, %error, "no se pudo sembrar un sonido del pack")
                }
            }
        }
        escritos
    }

    /// El tipo MIME de un fichero del almacen, por su extension.
    pub fn mime(nombre: &str) -> &'static str {
        let extension = extension_de(nombre);
        ACEPTADOS
            .iter()
            .find(|(ext, _)| *ext == extension)
            .map(|(_, mime)| *mime)
            // Sin extension conocida se sirve como binario: el navegador lo
            // descarga en vez de intentar pintarlo.
            .unwrap_or("application/octet-stream")
    }

    /// Todos los ficheros del almacen, ordenados.
    pub fn listar(&self) -> Vec<String> {
        let Ok(entradas) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut nombres: Vec<String> = entradas
            .filter_map(|entrada| entrada.ok())
            .filter(|entrada| entrada.path().is_file())
            .filter_map(|entrada| entrada.file_name().into_string().ok())
            .collect();
        nombres.sort();
        nombres
    }

    /// La ruta de un fichero del almacen, si el nombre es de fiar.
    ///
    /// El nombre viene de la URL, asi que se rechaza cualquier cosa con `/`, `\`
    /// o `..`: sin esto, `/media/../../base.db` seria una lectura arbitraria.
    pub fn ruta_de(&self, nombre: &str) -> Option<PathBuf> {
        if nombre.is_empty()
            || nombre.len() > 120
            || nombre.contains('/')
            || nombre.contains('\\')
            || nombre.contains("..")
            || nombre.starts_with('.')
        {
            return None;
        }
        let ruta = self.dir.join(nombre);
        ruta.is_file().then_some(ruta)
    }

    /// Importa un fichero desde una ruta del disco. Devuelve su nombre nuevo.
    pub fn importar_desde_ruta(&self, origen: &Path) -> Result<String> {
        let nombre = origen
            .file_name()
            .and_then(|n| n.to_str())
            .context("la ruta no tiene nombre de fichero")?;
        let bytes =
            std::fs::read(origen).with_context(|| format!("leyendo {}", origen.display()))?;
        self.importar_bytes(nombre, &bytes)
    }

    /// Importa un fichero desde sus bytes.
    ///
    /// El nombre final **lo pone el almacen**, no quien llama: se limpia el que
    /// venga y se le añade un numero si ya existe. Asi dos GIF con el mismo nombre
    /// no se pisan, y un nombre con `..` no puede escapar de la carpeta.
    pub fn importar_bytes(&self, nombre: &str, bytes: &[u8]) -> Result<String> {
        if bytes.is_empty() {
            anyhow::bail!("el fichero esta vacio");
        }
        if bytes.len() as u64 > TAMANO_MAXIMO {
            anyhow::bail!(
                "el fichero pasa del tope de {} MB",
                TAMANO_MAXIMO / (1024 * 1024)
            );
        }

        let extension = extension_de(nombre);
        if !ACEPTADOS.iter().any(|(ext, _)| *ext == extension) {
            anyhow::bail!(
                "formato no admitido: .{extension}. Se aceptan {}",
                ACEPTADOS
                    .iter()
                    .map(|(ext, _)| *ext)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }

        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("creando {}", self.dir.display()))?;

        // Se elige el primer nombre libre: `golpe.gif`, `golpe-2.gif`, ...
        let base = limpiar_nombre(nombre);
        let stem = base.strip_suffix(&format!(".{extension}")).unwrap_or(&base);
        let mut destino = self.dir.join(&base);
        let mut copia = 1;
        while destino.exists() {
            copia += 1;
            destino = self.dir.join(format!("{stem}-{copia}.{extension}"));
        }

        std::fs::write(&destino, bytes)
            .with_context(|| format!("escribiendo {}", destino.display()))?;
        Ok(destino
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&base)
            .to_string())
    }

    /// Borra un fichero del almacen.
    pub fn borrar(&self, nombre: &str) -> Result<()> {
        let ruta = self
            .ruta_de(nombre)
            .context("ese fichero no esta en el almacen")?;
        std::fs::remove_file(&ruta).with_context(|| format!("borrando {}", ruta.display()))?;
        Ok(())
    }
}

/// La extension en minusculas, sin el punto.
fn extension_de(nombre: &str) -> String {
    Path::new(nombre)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Deja el nombre en algo que no puede salir de la carpeta.
fn limpiar_nombre(nombre: &str) -> String {
    let extension = extension_de(nombre);
    let stem: String = Path::new(nombre)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("medio")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let stem = stem.trim_matches('-').to_string();
    let stem = if stem.is_empty() {
        "medio".to_string()
    } else {
        stem.chars().take(48).collect()
    };
    format!("{stem}.{extension}")
}

/// La cola de avisos: lo que se entrega y lo que espera a que haya fuente.
///
/// El overlay **no** lleva la cuenta de lo que falta: si nadie escucha, el aviso
/// se queda aqui. Es lo que hace que un cambio de escena en OBS no se coma la
/// alerta del regalo grande, y lo que evita que un refresco del Browser Source
/// pierda nada.
pub struct ColaAlertas {
    /// Avisos que aun no ha recogido ninguna fuente.
    pendientes: Mutex<VecDeque<Aviso>>,
    /// Avisos nuevos, para las fuentes ya conectadas.
    emisor: tokio::sync::broadcast::Sender<Aviso>,
    siguiente_seq: AtomicU64,
    /// Cuantos se han tirado por no caber. Se cuenta: el plan obliga a contar lo
    /// que se descarta.
    descartados: AtomicU64,
    entregados: AtomicU64,
}

impl ColaAlertas {
    pub fn nueva() -> Self {
        let (emisor, _) = tokio::sync::broadcast::channel(64);
        Self {
            pendientes: Mutex::new(VecDeque::new()),
            emisor,
            siguiente_seq: AtomicU64::new(1),
            descartados: AtomicU64::new(0),
            entregados: AtomicU64::new(0),
        }
    }

    pub fn siguiente_seq(&self) -> u64 {
        self.siguiente_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Encola un aviso.
    ///
    /// Si hay alguien escuchando se entrega en el acto; si no, se guarda. La
    /// distincion la hace `send`, que falla precisamente cuando no queda ningun
    /// receptor, asi que no hay que llevar la cuenta de conexiones a mano.
    pub fn encolar(&self, aviso: Aviso) {
        if self.emisor.send(aviso.clone()).is_ok() {
            self.entregados.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let Ok(mut pendientes) = self.pendientes.lock() else {
            return;
        };
        while pendientes.len() >= TOPE_PENDIENTES {
            pendientes.pop_front();
            self.descartados.fetch_add(1, Ordering::Relaxed);
        }
        pendientes.push_back(aviso);
    }

    /// Los avisos que esperan a una fuente, sin sacarlos.
    ///
    /// No se vacian al leerlos: se vacian cuando se entregan de verdad. Asi una
    /// conexion que se cae justo despues de pedirlos no se los lleva por delante.
    pub fn pendientes(&self) -> Vec<Aviso> {
        self.pendientes
            .lock()
            .map(|pendientes| pendientes.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Da por entregados unos avisos: los quita de la lista de espera.
    pub fn entregar(&self, seqs: &[u64]) {
        let Ok(mut pendientes) = self.pendientes.lock() else {
            return;
        };
        pendientes.retain(|aviso| !seqs.contains(&aviso.seq));
        self.entregados
            .fetch_add(seqs.len() as u64, Ordering::Relaxed);
    }

    pub fn suscribir(&self) -> tokio::sync::broadcast::Receiver<Aviso> {
        self.emisor.subscribe()
    }

    pub fn descartados(&self) -> u64 {
        self.descartados.load(Ordering::Relaxed)
    }

    pub fn entregados(&self) -> u64 {
        self.entregados.load(Ordering::Relaxed)
    }
}

impl Default for ColaAlertas {
    fn default() -> Self {
        Self::nueva()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_plantilla_se_rellena() {
        let variables = Variables {
            usuario: "Carlos".into(),
            regalo: "Rosa".into(),
            cantidad: 5,
            diamantes: 5,
            ..Variables::default()
        };
        assert_eq!(
            componer("{usuario} donó {regalo} ×{cantidad}", &variables),
            "Carlos donó Rosa ×5"
        );
        // Sin variables, la plantilla es texto plano.
        assert_eq!(componer("gracias", &variables), "gracias");
    }

    /// Un nombre mal escrito se queda a la vista. Sustituirlo por nada dejaria un
    /// hueco que nadie sabe explicar; asi el streamer ve que se equivoco.
    #[test]
    fn una_variable_desconocida_se_queda_visible() {
        let variables = Variables {
            usuario: "Carlos".into(),
            ..Variables::default()
        };
        assert_eq!(
            componer("{usuario} {regaloo}", &variables),
            "Carlos {regaloo}"
        );
        // Y una llave sin cerrar deja el resto tal cual: es un texto roto y tiene
        // que verse roto, no comerse media plantilla.
        assert_eq!(
            componer("{usuario te sigue", &variables),
            "{usuario te sigue"
        );
        assert_eq!(componer("hola {usuario", &variables), "hola {usuario");
    }

    /// Una variable que existe pero no aplica se sustituye por nada: `{regalo}`
    /// en un follow no es un error, es que no hay regalo.
    #[test]
    fn una_variable_que_no_aplica_desaparece() {
        let variables = Variables {
            usuario: "Ana".into(),
            ..Variables::default()
        };
        assert_eq!(componer("{usuario} {regalo}", &variables), "Ana");
    }

    #[test]
    fn los_meses_se_escriben_en_singular_y_plural() {
        let uno = Variables {
            meses: 1,
            ..Variables::default()
        };
        let tres = Variables {
            meses: 3,
            ..Variables::default()
        };
        assert_eq!(texto_de(&uno), "1 mes");
        assert_eq!(texto_de(&tres), "3 meses");

        fn texto_de(v: &Variables) -> String {
            componer("{meses_texto}", v)
        }
    }

    #[test]
    fn el_texto_de_fabrica_de_cada_aviso_usa_sus_variables() {
        let ajustes = AjustesAlertas::de_fabrica();
        for tipo in TipoAviso::TODOS {
            let ajuste = ajustes.de(tipo);
            let variables = Variables {
                usuario: "Ana".into(),
                regalo: "Rosa".into(),
                cantidad: 3,
                diamantes: 3,
                meses: 2,
                likes: 40,
            };
            let texto = componer(&ajuste.texto, &variables);
            assert!(
                !texto.contains('{'),
                "{} deja una variable sin rellenar: {texto}",
                tipo.id()
            );
            assert!(ajuste.util() || !ajuste.activo);
        }
    }

    /// Un almacen en una carpeta temporal.
    ///
    /// Los tests **no** pueden usar el de verdad: escribirian en la carpeta del
    /// streamer, y ademas el entorno del proceso es compartido entre tests, asi
    /// que redirigirlo seria racy. Por eso la carpeta se inyecta.
    fn almacen_de_prueba(tag: &str) -> (Almacen, PathBuf) {
        let unico = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "ttdash-alertas-{tag}-{}-{unico}",
            std::process::id()
        ));
        (Almacen::en(dir.clone()), dir)
    }

    /// El tramo que le toca a un regalo, por lo que vale.
    ///
    /// Es la regla que decide si un leon suena distinto que una rosa, asi que se
    /// prueba entera: los tres tramos, el limite exacto de cada uno, el regalo que
    /// no llega al minimo y el tramo apagado.
    #[test]
    fn el_regalo_elige_su_tramo_por_diamantes() {
        let ajustes = AjustesAlertas::de_fabrica();

        assert_eq!(
            tramo_de_regalo(&ajustes, 5_000),
            Some(TipoAviso::GiftEnorme)
        );
        assert_eq!(
            tramo_de_regalo(&ajustes, 1_000),
            Some(TipoAviso::GiftEnorme),
            "el minimo entra: mil es el limite, no el primer numero que se queda fuera"
        );
        assert_eq!(tramo_de_regalo(&ajustes, 999), Some(TipoAviso::GiftGrande));
        assert_eq!(tramo_de_regalo(&ajustes, 100), Some(TipoAviso::GiftGrande));
        assert_eq!(tramo_de_regalo(&ajustes, 99), Some(TipoAviso::Gift));
        assert_eq!(tramo_de_regalo(&ajustes, 10), Some(TipoAviso::Gift));
        assert_eq!(
            tramo_de_regalo(&ajustes, 9),
            None,
            "por debajo del minimo del tramo mas bajo no hay aviso, como con una rosa"
        );
    }

    /// Apagar un tramo no puede dejar al regalo sin ninguna alerta.
    ///
    /// Es la decision que hace que esto sirva en un directo: si el streamer apaga
    /// el aviso de los regalos enormes —porque le corta el ritmo, porque esta
    /// cansado de la fanfarria—, un leon tiene que seguir entrando por el tramo de
    /// abajo. Lo que si se respeta es el minimo del tramo al que se cae.
    #[test]
    fn apagar_un_tramo_cae_al_de_abajo() {
        let mut ajustes = AjustesAlertas::de_fabrica();
        ajustes.gift_enorme.activo = false;
        assert_eq!(
            tramo_de_regalo(&ajustes, 5_000),
            Some(TipoAviso::GiftGrande),
            "el enorme apagado no puede tragarse el aviso de un regalo de cinco mil"
        );

        ajustes.gift_grande.activo = false;
        assert_eq!(tramo_de_regalo(&ajustes, 5_000), Some(TipoAviso::Gift));
    }

    /// Un tramo sin nada que enseñar es como si estuviera apagado.
    ///
    /// `util()` es lo que mira el motor para decidir si un aviso sale, y un tramo
    /// con el texto en blanco y sin medio no se puede pintar: tiene que caer al de
    /// abajo igual que si estuviera apagado.
    #[test]
    fn un_tramo_vacio_cae_al_de_abajo() {
        let mut ajustes = AjustesAlertas::de_fabrica();
        ajustes.gift_enorme.texto = "   ".to_string();
        ajustes.gift_enorme.medio = String::new();
        assert_eq!(
            tramo_de_regalo(&ajustes, 5_000),
            Some(TipoAviso::GiftGrande)
        );
    }

    /// Con los tres tramos apagados, un regalo no dispara nada.
    #[test]
    fn sin_tramos_no_hay_aviso() {
        let mut ajustes = AjustesAlertas::de_fabrica();
        for tramo in TipoAviso::TRAMOS_DE_REGALO {
            ajustes.de_mut(tramo).activo = false;
        }
        assert_eq!(tramo_de_regalo(&ajustes, 5_000), None);
    }

    /// Los ajustes guardados **antes** de que existieran los tramos siguen cargando.
    ///
    /// Es el perfil de la version anterior: cinco avisos y ningun `gift_grande`. Si
    /// el `#[serde(default)]` faltara, la aplicacion no abriria para quien ya la
    /// tenia puesta, que es el peor fallo posible de una actualizacion.
    #[test]
    fn un_perfil_de_la_version_anterior_carga_con_los_tramos_de_fabrica() {
        let viejo = r#"{
            "gift": {"activo": true, "texto": "hola", "duracion_ms": 3000, "volumen": 0.7},
            "follow": {"activo": true, "texto": "hola", "duracion_ms": 3000, "volumen": 0.7},
            "subscribe": {"activo": true, "texto": "hola", "duracion_ms": 3000, "volumen": 0.7},
            "share": {"activo": true, "texto": "hola", "duracion_ms": 3000, "volumen": 0.7},
            "like": {"activo": true, "texto": "hola", "duracion_ms": 3000, "volumen": 0.7}
        }"#;
        let ajustes: AjustesAlertas = serde_json::from_str(viejo).expect("tiene que cargar");
        assert_eq!(
            ajustes.gift_grande,
            tramo_grande_de_fabrica(),
            "el tramo que no estaba entra con los valores de fabrica"
        );
        assert_eq!(ajustes.gift_enorme, tramo_enorme_de_fabrica());
        assert_eq!(
            tramo_de_regalo(&ajustes, 5_000),
            Some(TipoAviso::GiftEnorme),
            "y los tramos funcionan sin que el streamer toque nada"
        );
    }

    /// Los siete avisos de fabrica traen sonido, y ese sonido esta en el pack.
    ///
    /// Sin esto, un nombre mal escrito en `de_fabrica` no lo cazaria nadie: el
    /// aviso saldria sin sonido y no habria un solo error en ningun sitio.
    #[test]
    fn los_avisos_de_fabrica_suenan_y_su_sonido_existe() {
        let ajustes = AjustesAlertas::de_fabrica();
        let nombres: Vec<&str> = PACK.iter().map(|(nombre, _)| *nombre).collect();

        for tipo in TipoAviso::TODOS {
            let ajuste = ajustes.de(tipo);
            assert!(
                !ajuste.sonido.is_empty(),
                "el aviso {} viene sin sonido",
                tipo.id()
            );
            assert!(
                nombres.contains(&ajuste.sonido.as_str()),
                "el aviso {} apunta a «{}», que no esta en el pack",
                tipo.id(),
                ajuste.sonido
            );
        }

        // Los cinco que vienen encendidos tienen que poder salir tal cual, sin que
        // el streamer toque nada.
        for tipo in [
            TipoAviso::Gift,
            TipoAviso::GiftGrande,
            TipoAviso::GiftEnorme,
            TipoAviso::Follow,
            TipoAviso::Subscribe,
        ] {
            assert!(ajustes.de(tipo).util(), "el aviso {} no sale", tipo.id());
        }

        // Y los dos que vienen apagados lo estan a proposito: un share sale poco y
        // una rafaga de likes puede ser constante. Se comprueba para que nadie los
        // encienda «arreglando» el test sin pensar en el directo.
        for tipo in [TipoAviso::Share, TipoAviso::Like] {
            assert!(
                !ajustes.de(tipo).activo,
                "el aviso {} viene apagado",
                tipo.id()
            );
        }
    }

    /// El pack: siete WAV que se pueden reproducir y que **no son silencio**.
    ///
    /// Un fichero de ceros pasa todas las demas comprobaciones y no suena. Es el
    /// fallo que no se ve en una captura ni en un test de tipos, asi que se mira la
    /// onda: que haya muestras distintas y que el pico sea de verdad.
    #[test]
    fn el_pack_son_wav_con_contenido() {
        assert_eq!(PACK.len(), 7, "el pack son siete sonidos");

        for (nombre, bytes) in PACK {
            assert!(bytes.len() > 44, "{nombre} no tiene ni cabecera");
            assert_eq!(&bytes[0..4], b"RIFF", "{nombre} no es un RIFF");
            assert_eq!(&bytes[8..12], b"WAVE", "{nombre} no es un WAVE");
            assert_eq!(&bytes[36..40], b"data", "{nombre} no trae bloque de datos");

            // La cabecera que escribe el generador: PCM, mono, 16 bits, 44,1 kHz.
            assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 1, "PCM");
            assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1, "mono");
            assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16, "16 bits");
            let hz = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
            assert_eq!(hz, 44_100, "{nombre} no esta a 44,1 kHz");

            let muestras = (bytes.len() - 44) / 2;
            let segundos = muestras as f64 / hz as f64;
            assert!(
                (0.1..=1.5).contains(&segundos),
                "{nombre} dura {segundos:.2} s: un aviso es corto o no es un aviso"
            );

            let mut pico: i32 = 0;
            let mut distintos = std::collections::HashSet::new();
            for i in 0..muestras {
                let v = i16::from_le_bytes([bytes[44 + i * 2], bytes[45 + i * 2]]) as i32;
                pico = pico.max(v.abs());
                // Solo unos cuantos: con contar los de cada mil muestras basta para
                // distinguir una onda de una ristra de ceros.
                if i % 101 == 0 {
                    distintos.insert(v);
                }
            }
            assert!(pico > 3_000, "{nombre} suena a nada: pico {pico}");
            assert!(
                pico <= 32_767,
                "{nombre} recorta: un pico a tope suena a chasquido"
            );
            assert!(
                distintos.len() > 20,
                "{nombre} es un tono plano o silencio: {} valores distintos",
                distintos.len()
            );
        }
    }

    /// El pack se siembra una vez y **no pisa** lo que ya hay.
    ///
    /// Que no pise es lo que permite llamarlo en cada arranque: si el streamer ha
    /// puesto su propio `campana-suave.wav` —o ha retocado el nuestro—, la
    /// aplicacion no se lo puede cambiar por debajo.
    #[test]
    fn el_pack_se_siembra_y_no_pisa_nada() {
        let (almacen, dir) = almacen_de_prueba("pack");

        assert_eq!(almacen.listar().len(), 0, "la carpeta nace vacia");
        assert_eq!(almacen.sembrar_pack(), PACK.len(), "la primera vez, todos");
        assert_eq!(almacen.listar().len(), PACK.len());

        // La segunda pasada no escribe nada: es lo que lo hace seguro en cada
        // arranque.
        assert_eq!(almacen.sembrar_pack(), 0, "la segunda vez, ninguno");

        // Y uno propio con el mismo nombre se respeta.
        let mio = dir.join(pack::PIZCA);
        std::fs::write(&mio, b"lo mio").unwrap();
        assert_eq!(almacen.sembrar_pack(), 0);
        assert_eq!(std::fs::read(&mio).unwrap(), b"lo mio", "no se pisa");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// El recorrido entero del almacen: importar, listar, encontrar y borrar.
    #[test]
    fn el_almacen_importa_lista_y_borra() {
        let (almacen, dir) = almacen_de_prueba("recorrido");

        // Un GIF de verdad no hace falta: lo que se prueba es el recorrido.
        let primero = almacen
            .importar_bytes("Golpe Final!.GIF", b"GIF89a")
            .unwrap();
        assert_eq!(primero, "golpe-final.gif");
        assert_eq!(almacen.listar(), vec![primero.clone()]);
        assert_eq!(
            std::fs::read(almacen.ruta_de(&primero).unwrap()).unwrap(),
            b"GIF89a"
        );

        // El mismo nombre otra vez no pisa al primero.
        let segundo = almacen.importar_bytes("Golpe Final!.GIF", b"otro").unwrap();
        assert_eq!(segundo, "golpe-final-2.gif");
        assert_eq!(almacen.listar().len(), 2);

        // Y desde una ruta del disco, que es el camino del arrastre. El origen va
        // **fuera** del almacen: si estuviera dentro, el nombre ya existiria y la
        // copia se renombraria, que es lo correcto pero no lo que se prueba aqui.
        let fuera = dir.join("origenes");
        std::fs::create_dir_all(&fuera).unwrap();
        let origen = fuera.join("origen.mp3");
        std::fs::write(&origen, b"ID3").unwrap();
        let tercero = almacen.importar_desde_ruta(&origen).unwrap();
        assert_eq!(tercero, "origen.mp3");

        almacen.borrar(&tercero).unwrap();
        assert_eq!(almacen.listar().len(), 2);
        assert!(
            almacen.borrar(&tercero).is_err(),
            "borrar dos veces el mismo no puede pasar en silencio"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// El nombre del fichero sale de la URL, asi que no puede escapar de la
    /// carpeta. Sin esto, `/media/../../base.db` seria una lectura arbitraria.
    #[test]
    fn un_nombre_de_fichero_no_puede_salir_de_la_carpeta() {
        let (almacen, dir) = almacen_de_prueba("travesia");
        for malo in [
            "",
            "..",
            "../base.db",
            "..\\base.db",
            "sub/dir.gif",
            "sub\\dir.gif",
            ".oculto",
        ] {
            assert!(almacen.ruta_de(malo).is_none(), "deberia rechazar {malo:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_nombre_importado_se_limpia_y_no_se_pisa() {
        assert_eq!(limpiar_nombre("Golpe Final!.GIF"), "golpe-final.gif");
        assert_eq!(limpiar_nombre("../../evil.png"), "evil.png");
        assert_eq!(limpiar_nombre("sin-extension"), "sin-extension.");
        assert_eq!(limpiar_nombre(""), "medio.");
    }

    #[test]
    fn solo_se_aceptan_los_formatos_de_la_lista() {
        let (almacen, dir) = almacen_de_prueba("formatos");
        let err = almacen.importar_bytes("virus.exe", b"x").unwrap_err();
        assert!(err.to_string().contains("formato no admitido"), "{err}");
        let err = almacen.importar_bytes("vacio.gif", b"").unwrap_err();
        assert!(err.to_string().contains("vacio"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_mime_sale_de_la_extension() {
        assert_eq!(Almacen::mime("golpe.gif"), "image/gif");
        assert_eq!(Almacen::mime("foto.JPG"), "image/jpeg");
        assert_eq!(Almacen::mime("clips.mp4"), "video/mp4");
        assert_eq!(Almacen::mime("raro.xyz"), "application/octet-stream");
        assert_eq!(Almacen::mime("sin-extension"), "application/octet-stream");
    }

    /// Sin nadie escuchando, el aviso espera; con alguien, se entrega. Es la
    /// decision que hace que un cambio de escena en OBS no se coma la alerta.
    #[test]
    fn sin_fuente_el_aviso_espera_y_con_fuente_se_entrega() {
        let cola = ColaAlertas::nueva();
        let ajuste = AjustesAlertas::de_fabrica().gift;
        let aviso = Aviso::demo(cola.siguiente_seq(), TipoAviso::Gift, &ajuste);

        // Nadie escucha: se guarda.
        cola.encolar(aviso.clone());
        assert_eq!(cola.pendientes().len(), 1, "sin fuente el aviso espera");
        assert_eq!(cola.pendientes()[0].seq, aviso.seq);

        // Llega una fuente: al pedir los pendientes se los lleva, y solo entonces
        // se dan por entregados.
        let pendientes = cola.pendientes();
        assert_eq!(pendientes.len(), 1);
        assert_eq!(cola.pendientes().len(), 1, "leerlos no los consume");
        cola.entregar(&pendientes.iter().map(|a| a.seq).collect::<Vec<_>>());
        assert!(cola.pendientes().is_empty(), "entregados se vacian");

        // Y con una fuente conectada, el siguiente va directo.
        let _receptor = cola.suscribir();
        cola.encolar(Aviso::demo(cola.siguiente_seq(), TipoAviso::Gift, &ajuste));
        assert!(
            cola.pendientes().is_empty(),
            "con receptor no se queda en la cola"
        );
        assert_eq!(cola.entregados(), 2);
    }

    /// La cola tiene tope y lo que sobra se cuenta: el plan obliga a contar lo que
    /// se descarta, y una lista sin tope es una fuga de memoria en un directo largo.
    #[test]
    fn la_cola_tiene_tope_y_cuenta_lo_que_tira() {
        let cola = ColaAlertas::nueva();
        let ajuste = AjustesAlertas::de_fabrica().gift;
        for _ in 0..(TOPE_PENDIENTES + 5) {
            cola.encolar(Aviso::demo(cola.siguiente_seq(), TipoAviso::Gift, &ajuste));
        }
        assert_eq!(cola.pendientes().len(), TOPE_PENDIENTES);
        assert_eq!(cola.descartados(), 5);
        // Lo que queda son los ultimos: lo viejo es lo que sobra.
        let pendientes = cola.pendientes();
        assert_eq!(pendientes.last().unwrap().seq, TOPE_PENDIENTES as u64 + 5);
        assert_eq!(pendientes.first().unwrap().seq, 6);
    }

    /// Los ajustes viajan en JSON y tienen que poder evolucionar: un campo nuevo
    /// con `#[serde(default)]` no puede invalidar un perfil guardado.
    #[test]
    fn los_ajustes_guardados_siguen_cargando() {
        let guardado = r#"{
            "gift": {"activo": true, "texto": "gracias {usuario}", "duracion_ms": 4000,
                     "volumen": 0.5, "minimo": 0}
        }"#;
        let solo_gift: serde_json::Value = serde_json::from_str(guardado).unwrap();
        // Sin los otros cuatro no carga: los campos con nombre obligan a que el
        // fichero este entero, que es lo que se quiere al guardar nosotros.
        assert!(serde_json::from_value::<AjustesAlertas>(solo_gift).is_err());

        // Y un ajuste completo sin los campos nuevos si carga.
        let incompleto = r#"{
            "activo": true, "texto": "hola", "duracion_ms": 3000, "volumen": 0.7
        }"#;
        let ajuste: AjusteAviso = serde_json::from_str(incompleto).unwrap();
        assert_eq!(ajuste.medio, "", "un medio que no estaba queda vacio");
        assert_eq!(ajuste.minimo, 0, "y un minimo que no estaba, en cero");
    }

    /// Los ajustes pueden llegar de cualquier sitio —un fichero tocado a mano, un
    /// renderer con una idea rara— y el motor no se fia: los deja en valores que
    /// puede cumplir. Una duracion de un millon de milisegundos dejaria la fuente
    /// de OBS ocupada durante horas.
    #[test]
    fn los_ajustes_se_sanean_al_guardar() {
        let mut ajustes = AjustesAlertas::de_fabrica();
        ajustes.gift.duracion_ms = 5_000_000;
        ajustes.gift.volumen = 50.0;
        ajustes.gift.minimo = -3;
        ajustes.gift.texto = "x".repeat(1000);
        ajustes.gift.medio = "fantasma.gif".to_string();
        ajustes.follow.minimo = 10;
        ajustes.follow.volumen = f32::NAN;

        ajustes.sanear(&["golpe.gif".to_string()]);

        assert_eq!(ajustes.gift.duracion_ms, DURACION_MAXIMA_MS);
        assert_eq!(ajustes.gift.volumen, 1.0);
        assert_eq!(
            ajustes.gift.minimo, 0,
            "un minimo negativo no tiene sentido"
        );
        assert_eq!(ajustes.gift.texto.chars().count(), TEXTO_MAXIMO);
        assert_eq!(
            ajustes.gift.medio, "",
            "un medio que ya no esta en el almacen se limpia"
        );
        assert_eq!(
            ajustes.follow.minimo, 0,
            "un follow no tiene cantidad con la que filtrar"
        );
        assert_eq!(
            ajustes.follow.volumen, 0.8,
            "un volumen no finito vuelve al de fabrica"
        );

        // Y un medio que si esta se conserva.
        let mut otros = AjustesAlertas::de_fabrica();
        otros.gift.medio = "golpe.gif".to_string();
        otros.sanear(&["golpe.gif".to_string()]);
        assert_eq!(otros.gift.medio, "golpe.gif");
    }
}
