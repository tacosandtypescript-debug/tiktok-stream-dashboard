//! Configuracion del servidor de overlays: token de acceso, puerto y diseno.
//!
//! El servidor escucha en loopback, pero eso **no** lo hace privado: cualquier
//! pagina web que el streamer visite puede intentar abrir un WebSocket a
//! `127.0.0.1` (DNS rebinding / CSRF) y leeria el chat y los rankings del
//! directo. Por eso hay un token por instalacion, y se exige en la URL
//! (docs/plan-review.md §329-§330).
//!
//! El token **se guarda en disco** y no se regenera en cada arranque: la URL que
//! se pega en OBS tiene que seguir funcionando manana. Por el mismo motivo se
//! guarda el diseno elegido de cada vista.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Puerto preferido del servidor de overlays.
pub const OVERLAY_PORT: u16 = 7878;
/// Cuantos puertos se prueban hacia arriba si el preferido esta ocupado.
const PUERTOS_A_PROBAR: u16 = 12;

/// Lo que se persiste entre arranques.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayConfig {
    /// Token de acceso. Viaja en la URL de OBS.
    pub token: String,
    /// Puerto realmente reservado (puede no ser el preferido).
    pub port: u16,
    /// Diseno elegido para cada vista.
    ///
    /// `#[serde(default)]` a proposito: un `overlay.json` escrito antes de que
    /// existieran los disenos solo tiene token y puerto, y tiene que seguir
    /// cargando. Hay instalaciones con la URL **ya pegada en OBS**.
    #[serde(default)]
    pub disenos: Disenos,
}

/// Diseno elegido por vista. `None` significa "el de por defecto".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Disenos {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gifts: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follows: Option<String>,
}

impl Disenos {
    /// Lo que hay guardado para esa vista, sin resolver.
    pub fn guardado(&self, vista: &str) -> Option<&str> {
        match vista {
            "tap" => self.tap.as_deref(),
            "gifts" => self.gifts.as_deref(),
            "follows" => self.follows.as_deref(),
            _ => None,
        }
    }

    /// El diseno que se sirve para esa vista, ya resuelto contra el catalogo.
    ///
    /// Lo resuelve el catalogo porque un identificador guardado puede haber
    /// desaparecido en una actualizacion, y entonces hay que servir el de fabrica
    /// en vez de una pagina en blanco.
    pub fn elegido(&self, vista: &str) -> &'static str {
        crate::overlay::disenos::para_vista(vista, self.guardado(vista)).id
    }

    /// Fija el diseno de una vista.
    ///
    /// Valida que el diseno exista **y** que valga para esa vista: guardar un
    /// identificador que luego no se puede servir dejaria el overlay roto en el
    /// siguiente arranque, que es justo lo que no se puede permitir en directo.
    pub fn poner(&mut self, vista: &str, id: &str) -> Result<(), String> {
        if !crate::overlay::VISTAS.contains(&vista) {
            return Err(format!("vista desconocida: {vista}"));
        }
        let diseno = crate::overlay::disenos::buscar(id)
            .ok_or_else(|| format!("diseno desconocido: {id}"))?;
        if !crate::overlay::disenos::admite(diseno, vista) {
            return Err(format!("el diseno {id} no vale para la vista {vista}"));
        }
        match vista {
            "tap" => self.tap = Some(id.to_string()),
            "gifts" => self.gifts = Some(id.to_string()),
            _ => self.follows = Some(id.to_string()),
        }
        Ok(())
    }
}

impl OverlayConfig {
    /// Ruta del fichero de configuracion (junto a los logs y la base).
    pub fn path() -> PathBuf {
        crate::rutas::data_dir().join("overlay.json")
    }

    /// Carga la configuracion, o la crea si no existe.
    ///
    /// El token se genera una sola vez. Se usa el reloj del sistema y el
    /// identificador del proceso como fuente: aqui no hace falta un generador
    /// criptografico, porque el token no protege un secreto de valor, solo
    /// impide que una web cualquiera se conecte por accidente o por curiosidad.
    pub fn load_or_create(path: &Path) -> Result<Self> {
        if let Ok(texto) = std::fs::read_to_string(path) {
            if let Ok(config) = serde_json::from_str::<OverlayConfig>(&texto) {
                if !config.token.is_empty() {
                    return Ok(config);
                }
            }
            // Un fichero ilegible no debe impedir arrancar: se regenera.
            tracing::warn!(ruta = %path.display(), "overlay.json ilegible; se regenera");
        }

        let config = OverlayConfig {
            token: generar_token(),
            port: OVERLAY_PORT,
            disenos: Disenos::default(),
        };
        config.save(path)?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(padre) = path.parent() {
            std::fs::create_dir_all(padre)
                .with_context(|| format!("creando {}", padre.display()))?;
        }
        let texto = serde_json::to_string_pretty(self)?;
        std::fs::write(path, texto).with_context(|| format!("escribiendo {}", path.display()))?;
        Ok(())
    }

    /// El mismo configuracion con otro puerto.
    ///
    /// Se usa cuando el puerto preferido estaba ocupado: el que se consigue se
    /// persiste para que la URL de OBS no cambie entre arranques
    /// (docs/plan-review.md P0-4b).
    pub fn con_puerto(mut self, puerto: u16) -> Self {
        self.port = puerto;
        self
    }

    /// Raiz del servidor, sin vista ni token.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }

    /// Direccion que se pega en OBS como **Browser Source**.
    ///
    /// Es la pagina (HTTP), no el WebSocket: OBS carga un documento y es el
    /// documento el que abre el socket. Publicar la `ws://` con la etiqueta
    /// "Browser Source" —que es lo que hacia antes— mandaba al streamer a pegar
    /// en OBS una direccion que no carga nada.
    pub fn pagina_url(&self, vista: &str) -> String {
        format!(
            "http://127.0.0.1:{}/?view={}&t={}",
            self.port, vista, self.token
        )
    }

    /// Direccion del WebSocket, para el registro.
    ///
    /// No se pega en OBS: la abre el propio documento del overlay.
    pub fn websocket_url(&self, vista: &str) -> String {
        format!(
            "ws://127.0.0.1:{}/overlay?view={}&t={}",
            self.port, vista, self.token
        )
    }
}

/// Token aleatorio de 32 caracteres hexadecimales.
fn generar_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    // Mezcla simple y suficiente para lo que se usa: que dos instalaciones no
    // compartan token y que no sea adivinable por fuerza bruta desde una web.
    let mut estado = nanos ^ (pid << 64) ^ 0x9E37_79B9_7F4A_7C15;
    let mut salida = String::with_capacity(32);
    for _ in 0..32 {
        // xorshift de 64 bits
        estado ^= estado << 13;
        estado ^= estado >> 7;
        estado ^= estado << 17;
        let nibble = (estado & 0xF) as u8;
        salida.push(char::from_digit(nibble as u32, 16).unwrap_or('0'));
    }
    salida
}

/// Busca un puerto libre a partir de `preferido`.
///
/// Se persiste el que se consigue para que la URL de OBS no cambie entre
/// arranques (docs/plan-review.md P0-4b). Se prueba el preferido y los
/// siguientes: si el streamer tiene el 7878 ocupado, la aplicacion sigue
/// arrancando en vez de fallar.
pub fn puerto_disponible(preferido: u16) -> Result<u16> {
    for salto in 0..PUERTOS_A_PROBAR {
        let puerto = preferido.saturating_add(salto);
        if std::net::TcpListener::bind(("127.0.0.1", puerto)).is_ok() {
            return Ok(puerto);
        }
    }
    anyhow::bail!(
        "no hay puerto libre entre {preferido} y {}",
        preferido.saturating_add(PUERTOS_A_PROBAR - 1)
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn carpeta(nombre: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ttdash-overlay-{nombre}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn el_token_es_estable_entre_arranques() {
        let dir = carpeta("estable");
        let ruta = dir.join("overlay.json");
        let _ = std::fs::remove_file(&ruta);

        let primero = OverlayConfig::load_or_create(&ruta).expect("primera carga");
        let segundo = OverlayConfig::load_or_create(&ruta).expect("segunda carga");
        assert_eq!(
            primero.token, segundo.token,
            "el token no puede cambiar: la URL de OBS dejaria de funcionar"
        );
        assert_eq!(primero.port, OVERLAY_PORT);
        assert_eq!(primero.token.len(), 32);

        // La URL del WebSocket lleva la vista y el token.
        let url = segundo.websocket_url("tap");
        assert!(url.contains("view=tap"));
        assert!(url.contains(&segundo.token));

        let _ = std::fs::remove_file(&ruta);
        let _ = std::fs::remove_dir(&dir);
    }

    /// Lo que se pega en OBS es la pagina, con la vista y el token. Si aqui
    /// volviera a salir `ws://`, OBS cargaria una direccion que no es un
    /// documento y el streamer veria una fuente vacia sin saber por que.
    #[test]
    fn la_url_de_obs_es_la_pagina_con_vista_y_token() {
        let config = OverlayConfig {
            token: "abc123".to_string(),
            port: 7878,
            disenos: Disenos::default(),
        };
        let url = config.pagina_url("gifts");
        assert_eq!(url, "http://127.0.0.1:7878/?view=gifts&t=abc123");
        assert_eq!(config.base_url(), "http://127.0.0.1:7878/");
    }

    /// Un `overlay.json` de antes de los disenos solo tiene token y puerto. Si no
    /// cargara, la aplicacion regeneraria el token y **la URL ya pegada en OBS
    /// dejaria de funcionar**.
    #[test]
    fn un_fichero_sin_disenos_sigue_cargando() {
        let dir = carpeta("viejos");
        let ruta = dir.join("overlay.json");
        std::fs::write(
            &ruta,
            r#"{"token":"0123456789abcdef0123456789abcdef","port":7879}"#,
        )
        .unwrap();

        let config = OverlayConfig::load_or_create(&ruta).expect("debe cargar");
        assert_eq!(config.token, "0123456789abcdef0123456789abcdef");
        assert_eq!(config.port, 7879, "el puerto no se puede perder");
        assert_eq!(
            config.disenos,
            Disenos::default(),
            "sin eleccion guardada se usa el diseno de fabrica"
        );
        assert_eq!(
            config.disenos.elegido("tap"),
            crate::overlay::disenos::POR_DEFECTO
        );

        let _ = std::fs::remove_file(&ruta);
        let _ = std::fs::remove_dir(&dir);
    }

    /// El diseno se guarda y se vuelve a leer: la eleccion tiene que sobrevivir
    /// al cierre, porque es lo que hace que la URL de OBS no cambie de aspecto.
    #[test]
    fn el_diseno_elegido_se_guarda_y_se_recupera() {
        let dir = carpeta("disenos");
        let ruta = dir.join("overlay.json");
        let _ = std::fs::remove_file(&ruta);

        let mut config = OverlayConfig::load_or_create(&ruta).expect("carga");
        config
            .disenos
            .poner("tap", crate::overlay::disenos::POR_DEFECTO)
            .expect("el de fabrica vale para tap");
        config.save(&ruta).expect("guardar");

        let releido = OverlayConfig::load_or_create(&ruta).expect("recarga");
        assert_eq!(
            releido.disenos.guardado("tap"),
            Some(crate::overlay::disenos::POR_DEFECTO)
        );
        assert_eq!(
            releido.disenos.guardado("gifts"),
            None,
            "elegir uno no puede tocar los otros"
        );

        let _ = std::fs::remove_file(&ruta);
        let _ = std::fs::remove_dir(&dir);
    }

    /// Un identificador inventado no se guarda: dejaria el overlay roto en el
    /// siguiente arranque, que es el peor momento para enterarse.
    #[test]
    fn no_se_guarda_un_diseno_que_no_existe() {
        let mut disenos = Disenos::default();
        assert!(disenos.poner("tap", "inventado").is_err());
        assert!(disenos.poner("vista_inventada", "carriles").is_err());
        assert_eq!(disenos, Disenos::default(), "no puede quedar nada a medias");
    }

    #[test]
    fn un_fichero_corrupto_no_impide_arrancar() {
        let dir = carpeta("malo");
        let ruta = dir.join("overlay.json");
        std::fs::write(&ruta, "{ esto no es json").unwrap();

        let config = OverlayConfig::load_or_create(&ruta).expect("debe regenerarse");
        assert_eq!(config.token.len(), 32, "se genera un token nuevo");

        let _ = std::fs::remove_file(&ruta);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn encuentra_un_puerto_libre() {
        // El puerto 0 siempre esta libre: el sistema elige uno.
        let puerto = puerto_disponible(0).expect("deberia encontrar puerto");
        assert!(puerto < PUERTOS_A_PROBAR);
    }
}
