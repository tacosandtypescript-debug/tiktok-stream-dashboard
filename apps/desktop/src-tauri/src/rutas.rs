//! Donde vive todo lo que la aplicacion escribe en disco.
//!
//! Por que existe este modulo: `data_dir()` nacio dentro de `database`, y eso ponia
//! a medio proyecto a depender de la base de datos **para pedir una carpeta**. Seis
//! modulos entraban en `database` solo por esto —`alerts`, `overlay::config`,
//! `telemetry` y tres de `tts`—, y uno de ellos creaba un ciclo: `database` guarda
//! tipos de TTS (`ClaveGuardada`, `Consumo`) y `tts` volvia a `database` por la
//! carpeta. Las rutas no son persistencia; son la plataforma.
//!
//! Lo que se escribe, todo colgando de aqui:
//!
//! ```text
//! %LOCALAPPDATA%\TikTokStreamDashboard\
//! ├── data\dashboard.db      base de datos
//! ├── logs\                  registro diario
//! ├── cache\tts\             audio sintetizado
//! ├── alertas\               medios de las alertas
//! └── overlay.json           puerto, token y diseno del overlay
//! ```

use std::path::{Path, PathBuf};

/// Directorio de datos de la aplicacion.
///
/// En Windows, `%LOCALAPPDATA%`: fuera de cualquier carpeta sincronizada (una
/// carpeta de OneDrive con WAL acaba corrompiendo la base).
///
/// `TTSDASH_DATA_DIR` permite redirigirlo: lo usan los tests, la
/// autoverificacion y una eventual instalacion portatil.
pub fn data_dir() -> PathBuf {
    resolve_data_dir(
        std::env::var("TTSDASH_DATA_DIR").ok().as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// Constructor puro de `data_dir`, para poder probarlo sin tocar el entorno
/// del proceso (que en tests es compartido y por tanto racy).
fn resolve_data_dir(
    custom: Option<&str>,
    local_app_data: Option<&str>,
    home: Option<&str>,
) -> PathBuf {
    if let Some(custom) = custom {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Some(local) = local_app_data {
        return Path::new(local).join("TikTokStreamDashboard");
    }
    if let Some(home) = home {
        return Path::new(home)
            .join(".local")
            .join("share")
            .join("tiktok-stream-dashboard");
    }
    PathBuf::from(".").join("data")
}

/// La base de datos, dentro del directorio de datos.
pub fn database_path() -> PathBuf {
    data_dir().join("data").join("dashboard.db")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_directorio_de_datos_se_resuelve_por_prioridad() {
        // El override manda: es lo que usan la autoverificacion y los tests.
        assert_eq!(
            resolve_data_dir(Some("C:\\tmp\\ttdash"), Some("C:\\Local"), Some("/home/u")),
            PathBuf::from("C:\\tmp\\ttdash")
        );
        // Un override vacio se ignora y no rompe la resolucion normal.
        assert_eq!(
            resolve_data_dir(Some("   "), Some("C:\\Local"), None),
            Path::new("C:\\Local").join("TikTokStreamDashboard")
        );
        // En Windows se prefiere LOCALAPPDATA, nunca una carpeta sincronizada.
        assert_eq!(
            resolve_data_dir(None, Some("C:\\Local"), Some("/home/u")),
            Path::new("C:\\Local").join("TikTokStreamDashboard")
        );
        // Sin ninguna variable, se cae a una ruta relativa en lugar de fallar.
        assert_eq!(
            resolve_data_dir(None, None, None),
            PathBuf::from(".").join("data")
        );
    }

    /// La base y las rutas de al lado cuelgan del mismo sitio.
    ///
    /// Es lo que permite redirigir **todo** con una sola variable: si la base se
    /// mudara por su cuenta, `TTSDASH_DATA_DIR` dejaria de valer para la mitad de lo
    /// que se escribe.
    #[test]
    fn la_base_cuelga_del_directorio_de_datos() {
        assert!(database_path().starts_with(data_dir()));
    }
}
