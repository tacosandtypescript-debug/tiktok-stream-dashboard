//! TTS: cola, filtros, catalogo de voces y sintesis.
//!
//! Reparto de responsabilidades (docs/decisions.md D3): Rust decide **que** se
//! lee, **cuando** y **con que prioridad**; Python solo convierte texto en
//! audio. Asi el motor de voz es sustituible sin tocar la cola ni los filtros.

pub mod consumo;
pub mod cuota;
pub mod filters;
pub mod fish;
pub mod fish_modelos;
pub mod manager;
pub mod plantilla;
pub mod player;
pub mod provider;
pub mod queue;
pub mod voices;

use std::path::{Path, PathBuf};

pub use consumo::{ClaveVoz, Consumo, ConsumoStatus, UsoProveedor};
pub use filters::{FilterConfig, FilterOutcome, Filters, RejectReason};
pub use fish::{
    modelos, ClaveGuardada, ClienteTts, FishAudio, FishConfig, ModeloFish, RespuestaHttp,
    MODELO_POR_DEFECTO, TOPE_CLAVES,
};
pub use manager::{TtsManager, TtsNowPlaying, TtsSettings, TtsStatus, VoiceProvider};
pub use player::{AudioSink, FallbackSink, NullSink, RodioSink};
pub use provider::{
    cache_key, prune_cache, ClaveStatus, EdgeTtsSidecar, ErrorVoz, EstadoClave, MotivoFallo,
    ProviderSettings, Readiness, SharedTtsProvider, TtsAudio, TtsCancellation, TtsConfig,
    TtsProvider, TtsRequest,
};
pub use queue::{priority, PushOutcome, TtsItem, TtsPreview, TtsQueue, TtsSource};
pub use voices::{catalog, detect_language, Language, Voice, DEFAULT_VOICE};

/// Nombre base del ejecutable que Tauri empaqueta como `externalBin`.
pub const SIDECAR_NAME: &str = "tiktok-tts-provider";
/// Ruta del script del sidecar, relativa a la raiz del repositorio.
pub const SIDECAR_SCRIPT: &str = "services/tts-provider/src/main.py";
/// Interprete de desarrollo (gestionado por `uv` dentro del propio proyecto).
pub const DEV_PYTHON: &str = ".tooling/venv/Scripts/python.exe";

/// Lo que se le dice al streamer cuando no aparece el motor de voz.
///
/// El detalle tecnico —que si el script, que si PyInstaller— se queda en el
/// registro: en pantalla solo cabe **lo que se puede hacer**. Y lo que se puede
/// hacer incluye volver a abrir la aplicacion, que es lo que faltaba decir: la
/// ruta del motor se resuelve **una vez, al arrancar**, asi que copiar el fichero
/// con la aplicacion abierta no arregla nada hasta reiniciarla.
pub const SIN_MOTOR: &str = "falta el motor de voz. Descarga tiktok-tts-provider-x86_64-pc-windows-msvc.exe, ponlo en la misma carpeta que la aplicacion y vuelve a abrirla";

/// Sufijo que Tauri exige en `src-tauri/binaries/` para el binario de cada
/// arquitectura. El proyecto publica Windows x64 por ahora; si se habilita
/// otra arquitectura, el build script debe copiar el artefacto con su triple.
pub fn sidecar_target_triple() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else {
        "unsupported-target"
    }
}

pub fn sidecar_filename() -> String {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    format!("{}-{}{}", SIDECAR_NAME, sidecar_target_triple(), extension)
}

fn sidecar_candidates(root: &Path) -> Vec<PathBuf> {
    let filename = sidecar_filename();
    let mut candidates = Vec::new();

    if let Ok(executable) = std::env::var("TTSDASH_TTS_SIDECAR") {
        if !executable.trim().is_empty() {
            candidates.push(PathBuf::from(executable));
        }
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            // Release/installed layout: alongside the dashboard or in the
            // resources directory used by Tauri's NSIS bundle.
            candidates.push(directory.join(&filename));
            candidates.push(
                directory
                    .join(SIDECAR_NAME)
                    .with_extension(if cfg!(windows) { "exe" } else { "" }),
            );
            candidates.push(directory.join("resources").join(&filename));
        }
    }

    // Development layout: staged externalBin, release output and the local
    // tooling cache are all deterministic and remain outside the repository's
    // tracked source files.
    candidates.push(root.join("apps/desktop/src-tauri/binaries").join(&filename));
    candidates.push(
        root.join("apps/desktop/src-tauri/target/release")
            .join(&filename),
    );
    candidates.push(root.join(".tooling/tts-provider").join(&filename));

    candidates
}

/// Localiza la raiz del repositorio subiendo desde el ejecutable.
///
/// En desarrollo el binario vive en `apps/desktop/src-tauri/target/<perfil>/`,
/// asi que la raiz se reconoce por contener el script del sidecar. Si no se
/// encuentra, se devuelve el directorio de trabajo.
pub fn find_repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("TTSDASH_ROOT") {
        if !root.trim().is_empty() {
            return PathBuf::from(root);
        }
    }

    let mut candidate: Option<PathBuf> = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.to_path_buf()));
    while let Some(directory) = candidate {
        if directory.join(SIDECAR_SCRIPT).exists() {
            return directory;
        }
        candidate = directory.parent().map(|parent| parent.to_path_buf());
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Configuracion de TTS lista para este equipo.
///
/// El runtime se resuelve en este orden:
///
/// 1. `TTSDASH_TTS_SIDECAR`, override explícito para soporte y QA.
/// 2. El ejecutable congelado junto al release/recursos de Tauri.
/// 3. El ejecutable congelado del staging `src-tauri/binaries` o `.tooling`.
/// 4. Python del proyecto (`.tooling/venv`) y, por último, `python` del PATH.
///
/// El último camino es solo desarrollo. El instalador no depende de Python:
/// Tauri incluye el ejecutable de PyInstaller mediante `externalBin`.
pub fn default_config() -> TtsConfig {
    let root = find_repo_root();
    let mut config = TtsConfig {
        script: root.join(SIDECAR_SCRIPT),
        ..TtsConfig::default()
    };

    let candidates = sidecar_candidates(&root);
    if let Some(executable) = candidates.iter().find(|candidate| candidate.exists()) {
        config.executable = Some(executable.clone());
        return config;
    }

    if let Ok(python) = std::env::var("TTSDASH_PYTHON") {
        if !python.trim().is_empty() {
            config.python = PathBuf::from(python);
            return config;
        }
    }

    let dev_python = root.join(DEV_PYTHON);
    config.python = if dev_python.exists() {
        dev_python
    } else {
        PathBuf::from("python")
    };
    config
}

/// Elige la voz segun el idioma detectado en el texto.
pub fn voice_for(text: &str, spanish: &str, english: &str) -> String {
    match detect_language(text) {
        Language::Es => spanish.to_string(),
        Language::En => english.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elige_la_voz_por_idioma() {
        assert_eq!(
            voice_for("hola, ¿qué tal?", "es-ES-ElviraNeural", "en-US-AriaNeural"),
            "es-ES-ElviraNeural"
        );
        assert_eq!(
            voice_for("hello everyone", "es-ES-ElviraNeural", "en-US-AriaNeural"),
            "en-US-AriaNeural"
        );
    }

    // La composicion de la frase que se lee ya no vive aqui: se mudo a
    // `tts::plantilla`, con sus variables y sus pruebas. Estas dos se han ido con
    // ella en vez de quedarse duplicadas.

    #[test]
    fn la_configuracion_apunta_a_un_script_existente_en_este_repositorio() {
        let config = default_config();
        assert!(
            config.script.ends_with("main.py"),
            "script inesperado: {}",
            config.script.display()
        );
        // En este repositorio el sidecar existe; si no, el test avisa.
        assert!(
            config.script.exists(),
            "no se encontro el sidecar en {} (raiz detectada: {})",
            config.script.display(),
            find_repo_root().display()
        );
    }
}
