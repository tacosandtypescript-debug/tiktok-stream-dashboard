//! Logs con rotacion.
//!
//! docs/plan-review.md §52-§53:
//!   * `logs/app.log` con todo desde INFO, `logs/error.log` desde WARN;
//!   * rotacion diaria, con purga de los ficheros antiguos: los logs no pueden
//!     crecer sin limite;
//!   * no se registra cada like en INFO. El detalle va a DEBUG, que esta
//!     desactivado por defecto.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// Ficheros de log que se conservan.
const KEEP_DAYS: u64 = 14;

/// Los guardias mantienen vivos los hilos que escriben; si se sueltan, se
/// pierden lineas al cerrar.
static GUARDS: OnceLock<Vec<WorkerGuard>> = OnceLock::new();

pub fn log_dir() -> PathBuf {
    crate::rutas::data_dir().join("logs")
}

/// Inicializa el subsistema de logs. Es idempotente: llamarlo dos veces no
/// falla, simplemente no hace nada la segunda vez.
///
/// **Nunca** aborta la aplicacion. Si el directorio de logs no se puede
/// escribir (perfil de solo lectura, permisos, sandbox), se registra solo en
/// consola y se avisa: quedarse sin logs es molesto, no poder abrir la
/// aplicacion es inaceptable.
pub fn init() -> Result<()> {
    let dir = log_dir();
    let file_logging = match prepare_dir(&dir) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "aviso: sin logs en fichero ({}): {error}. Se registrara solo en consola.",
                dir.display()
            );
            false
        }
    };

    if let Ok(removed) = prune(&dir, KEEP_DAYS) {
        if removed > 0 && file_logging {
            eprintln!("logs antiguos eliminados: {removed}");
        }
    }

    let console_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    if file_logging {
        let appender = tracing_appender::rolling::daily(&dir, "app.log");
        let errors = tracing_appender::rolling::daily(&dir, "error.log");
        let (app_writer, app_guard) = tracing_appender::non_blocking(appender);
        let (error_writer, error_guard) = tracing_appender::non_blocking(errors);
        let _ = GUARDS.set(vec![app_guard, error_guard]);

        let subscriber = tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(app_writer)
                    .with_ansi(false)
                    .with_target(true)
                    .with_filter(LevelFilter::INFO),
            )
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(error_writer)
                    .with_ansi(false)
                    .with_filter(LevelFilter::WARN),
            )
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::stderr)
                    .with_filter(console_filter),
            );
        let _ = subscriber.try_init();
    } else {
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(console_filter),
        );
        let _ = subscriber.try_init();
    }

    tracing::info!(dir = %dir.display(), fichero = file_logging, "logs inicializados");
    Ok(())
}

/// Comprueba que se puede escribir en el directorio de logs **antes** de
/// entregarselo a `tracing-appender`, que entra en panico si no puede crear el
/// fichero.
fn prepare_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creando {}", dir.display()))?;
    let probe = dir.join(".escritura-de-prueba");
    std::fs::write(&probe, b"ok").with_context(|| format!("escribiendo en {}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Elimina los ficheros de log mas antiguos que `keep_days`. Devuelve cuantos
/// borro.
pub fn prune(dir: &Path, keep_days: u64) -> Result<usize> {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(keep_days * 24 * 60 * 60))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut removed = 0;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("app.log") || name.starts_with("error.log"))
            .unwrap_or(false);
        if !is_log {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::now());
        if modified < cutoff && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purga_solo_los_logs_antiguos() {
        let dir = std::env::temp_dir().join(format!("ttdash-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("directorio temporal");

        let reciente = dir.join("app.log.2026-09-17");
        let ajeno = dir.join("otra-cosa.txt");
        std::fs::write(&reciente, "reciente").unwrap();
        std::fs::write(&ajeno, "no es un log").unwrap();

        // Con 14 dias de retencion, un fichero recien creado no se toca.
        assert_eq!(prune(&dir, KEEP_DAYS).unwrap(), 0);
        assert!(reciente.exists());
        assert!(ajeno.exists());

        // Con retencion 0, todo lo anterior a "ahora" se considera antiguo.
        std::thread::sleep(Duration::from_millis(1100));
        let removed = prune(&dir, 0).unwrap();
        assert!(removed >= 1, "deberia borrar el log, no los otros ficheros");
        assert!(!reciente.exists());
        assert!(ajeno.exists(), "un fichero que no es log no se toca");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_directorio_de_logs_cuelga_del_de_datos() {
        let dir = log_dir();
        assert!(dir.ends_with("logs"));
        assert!(dir.starts_with(crate::rutas::data_dir()));
    }
}
