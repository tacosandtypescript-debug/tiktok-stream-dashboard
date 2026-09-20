//! Punto de entrada.
//!
//! `--self-test` ejecuta una autoverificacion sin ventana (util en CI y para
//! comprobar una instalacion nueva). Sin argumentos, abre la aplicacion.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn value_of(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

/// Texto para `--tts-test`: admite `--text "..."` y tambien el texto justo
/// despues de la propia bandera (`--tts-test "hola"`).
fn text_of(args: &[String], flag: &str) -> Option<String> {
    if let Some(explicit) = value_of(args, "--text") {
        return Some(explicit);
    }
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.starts_with("--"))
        .cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|arg| arg == "--tts-test") {
        let text = text_of(&args, "--tts-test")
            .unwrap_or_else(|| "Hola, esto es una prueba del lector de chat.".to_string());
        let voice = value_of(&args, "--voice");
        let rate = value_of(&args, "--rate");
        let pitch = value_of(&args, "--pitch");
        if let Err(error) =
            dashboard::tts_probe(&text, voice.as_deref(), rate.as_deref(), pitch.as_deref())
        {
            eprintln!("prueba de TTS fallida: {error:#}");
            std::process::exit(1);
        }
        return;
    }

    if args.iter().any(|arg| arg == "--tts-voices") {
        if let Err(error) = dashboard::tts_voices() {
            eprintln!("no se pudieron listar las voces: {error:#}");
            std::process::exit(1);
        }
        return;
    }

    if args.iter().any(|arg| arg == "--medios") {
        let Some(carpeta) = value_of(&args, "--medios") else {
            eprintln!("--medios necesita una carpeta: --medios \"C:\\ruta\\a\\los\\sonidos\"");
            std::process::exit(1);
        };
        if let Err(error) = dashboard::importar_medios(std::path::Path::new(&carpeta)) {
            eprintln!("importación fallida: {error:#}");
            std::process::exit(1);
        }
        return;
    }

    if args.iter().any(|arg| arg == "--self-test") {
        let seconds = value_of(&args, "--seconds")
            .and_then(|value| value.parse().ok())
            .unwrap_or(5);
        let live = value_of(&args, "--live");
        if let Err(error) = dashboard::self_test(seconds, live.as_deref()) {
            eprintln!("autoverificación fallida: {error}");
            std::process::exit(1);
        }
        return;
    }

    #[cfg(feature = "desktop")]
    dashboard::run();

    #[cfg(not(feature = "desktop"))]
    {
        eprintln!("Esta compilación no incluye la interfaz. Usa --self-test, --tts-test o compila con la feature `desktop`.");
        let _ = dashboard::init();
    }
}
