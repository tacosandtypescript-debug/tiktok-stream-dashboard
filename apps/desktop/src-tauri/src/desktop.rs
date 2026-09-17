//! Shell de escritorio (Tauri).
//!
//! Solo contiene lo imprescindible: la ventana, los comandos y el puente de
//! eventos hacia la interfaz. Todo el motor vive en `crate::app`, que no depende
//! de Tauri y por tanto se puede probar sin compilarlo.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager, State};

use crate::app::{AppState, Snapshot};
use crate::core::MetricsSnapshot;
use crate::providers::TikTokProvider;

/// Se pone a `true` la primera vez que la interfaz pide un snapshot.
///
/// Es la prueba de que el WebView cargo los recursos, ejecuto React y llego a
/// hablar con Rust por IPC. Un `ERR_CONNECTION_REFUSED` o unos recursos mal
/// empaquetados dejan esta traza sin aparecer.
static UI_CONNECTED: AtomicBool = AtomicBool::new(false);

/// Se pone a `true` la primera vez que la interfaz recibe un evento del bus.
///
/// Distingue "la interfaz cargo" de "la interfaz recibe datos en vivo". Sin
/// permisos de evento en el fichero de capabilities, `listen()` se rechaza y el
/// chat solo se actualiza al pedir un snapshot.
static UI_RECEIVING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn app_snapshot(state: State<'_, Arc<AppState>>) -> Snapshot {
    if !UI_CONNECTED.swap(true, Ordering::Relaxed) {
        tracing::info!("interfaz conectada con el motor (IPC operativo)");
    }
    state.snapshot()
}

/// La interfaz avisa de que ha recibido su primer evento del bus.
#[tauri::command]
fn ui_receiving() {
    if !UI_RECEIVING.swap(true, Ordering::Relaxed) {
        tracing::info!("interfaz recibiendo eventos del bus (flujo en vivo operativo)");
    }
}

/// La interfaz informa de cuantos eventos de cada tipo ha reconocido y pintado.
///
/// Distingue "los eventos llegan al WebView" de "la interfaz sabe pintarlos".
#[tauri::command]
fn ui_events(state: State<'_, Arc<AppState>>, counts: std::collections::HashMap<String, u64>) {
    state.note_ui_events(&counts);
}

/// Traza del chat: mensaje recibido por la interfaz o lista ya pintada.
///
/// `dom` es una medida del WebView ("ul 320/920 top=0 | main ..."): dice que
/// elemento desplaza de verdad la lista, que es justo lo que no se puede ver
/// desde Rust ni desde la base de datos.
#[derive(Debug, Default, serde::Deserialize)]
struct UiChatPayload {
    received_seq: Option<u64>,
    rendered_len: Option<u64>,
    rendered_seq: Option<u64>,
    dom: Option<String>,
}

#[tauri::command]
fn ui_chat(state: State<'_, Arc<AppState>>, payload: UiChatPayload) {
    state.note_ui_chat(
        payload.received_seq,
        payload.rendered_len,
        payload.rendered_seq,
        payload.dom.as_deref(),
    );
}

/// La interfaz reporta un error de render.
///
/// Sin esto, un fallo de React deja la ventana congelada o en blanco sin
/// rastro alguno en los logs.
#[tauri::command]
fn ui_error(message: String) {
    tracing::error!(origen = "interfaz", "{message}");
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

/// Cambios de configuracion del lector de voz. Todo opcional: solo se aplica lo
/// que la interfaz envia.
#[derive(Debug, Default, serde::Deserialize)]
struct TtsPatch {
    enabled: Option<bool>,
    volume: Option<f32>,
    rate: Option<String>,
    say_author: Option<bool>,
    voice_es: Option<String>,
    voice_en: Option<String>,
}

#[tauri::command]
fn tts_status(state: State<'_, Arc<AppState>>) -> crate::tts::manager::TtsStatus {
    state.tts_status()
}

#[tauri::command]
fn tts_update(state: State<'_, Arc<AppState>>, patch: TtsPatch) {
    use crate::tts::voices::Language;

    if let Some(enabled) = patch.enabled {
        state.tts.set_enabled(enabled);
    }
    if let Some(volume) = patch.volume {
        state.tts.set_volume(volume);
    }
    if let Some(rate) = patch.rate {
        state.tts.set_rate(&rate);
    }
    if let Some(say_author) = patch.say_author {
        state.tts.set_say_author(say_author);
    }
    if let Some(voice) = patch.voice_es {
        state.tts.set_voice(Language::Es, &voice);
    }
    if let Some(voice) = patch.voice_en {
        state.tts.set_voice(Language::En, &voice);
    }
}

/// Acciones puntuales sobre la cola o los usuarios silenciados.
#[tauri::command]
fn tts_action(
    state: State<'_, Arc<AppState>>,
    action: String,
    value: Option<String>,
) -> Result<(), String> {
    match action.as_str() {
        "pause" => state.tts.pause(),
        "resume" => state.tts.resume(),
        "skip" => state.tts.skip(),
        "clear" => {
            state.tts.clear();
        }
        "remove" => {
            let id: u64 = value
                .as_deref()
                .ok_or("falta el identificador")?
                .parse()
                .map_err(|_| "identificador inválido")?;
            state.tts.remove(id);
        }
        "mute" => {
            let user = value.as_deref().ok_or("falta el usuario")?;
            state.tts.mute_user(user);
        }
        "unmute" => {
            let user = value.as_deref().ok_or("falta el usuario")?;
            state.tts.unmute_user(user);
        }
        other => return Err(format!("acción desconocida: {other}")),
    }
    Ok(())
}

/// Voces que ofrece el catalogo curado del proyecto, para el selector de la
/// interfaz.
#[tauri::command]
fn tts_voices() -> Vec<crate::tts::Voice> {
    crate::tts::catalog()
}

#[tauri::command]
fn app_metrics(state: State<'_, Arc<AppState>>) -> MetricsSnapshot {
    state.metrics()
}

#[tauri::command]
async fn connect(state: State<'_, Arc<AppState>>, handle: String) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    if handle.trim().is_empty() {
        return Err("el usuario no puede estar vacío".into());
    }
    if let Ok(mut guard) = state.handle.write() {
        *guard = handle.trim().trim_start_matches('@').to_string();
    }
    let provider = state.current_provider();
    provider.connect(&handle).await.map_err(|e| e.to_string())?;
    Ok(state.snapshot())
}

#[tauri::command]
async fn start_simulation(
    state: State<'_, Arc<AppState>>,
    handle: Option<String>,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    // Se detiene el proveedor activo antes de cambiar: nunca dos a la vez
    // (consumirian la misma cuota de firma).
    let active = state.current_provider();
    active.disconnect().await;

    if let Ok(mut guard) = state.provider.write() {
        *guard = state.simulated.clone() as Arc<dyn TikTokProvider>;
    }
    let handle = handle.unwrap_or_else(|| "simulado".into());
    if let Ok(mut guard) = state.handle.write() {
        *guard = handle.clone();
    }
    state
        .simulated
        .connect(&handle)
        .await
        .map_err(|e| e.to_string())?;
    Ok(state.snapshot())
}

/// Vuelve al proveedor real tras una simulacion.
#[tauri::command]
async fn use_native_provider(state: State<'_, Arc<AppState>>) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    let active = state.current_provider();
    active.disconnect().await;
    if let Ok(mut guard) = state.provider.write() {
        *guard = state.native.clone() as Arc<dyn TikTokProvider>;
    }
    Ok(state.snapshot())
}

#[tauri::command]
async fn disconnect(state: State<'_, Arc<AppState>>) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    let provider = state.current_provider();
    provider.disconnect().await;
    Ok(state.snapshot())
}

#[tauri::command]
fn clear_chat(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state
        .chat
        .lock()
        .map(|mut buffer| buffer.clear())
        .map_err(|_| "no se pudo limpiar el chat".to_string())
}

/// Vacia la actividad reciente (no toca el resumen de regalos).
#[tauri::command]
fn clear_feed(state: State<'_, Arc<AppState>>) {
    state.clear_feed();
}

/// Publica cada evento del bus en la interfaz.
///
/// El estado se actualiza en otro consumidor (`AppState::spawn_consumer`): asi
/// `on_event` se ejecuta exactamente una vez, aunque haya mas suscriptores.
fn spawn_ui_bridge(app: tauri::AppHandle, state: Arc<AppState>) {
    let mut receiver = state.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if let Err(error) = app.emit("dash://event", event.as_ref()) {
                        tracing::debug!(%error, "no se pudo emitir el evento a la interfaz");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Ya contabilizado por el consumidor de estado.
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

pub fn run() {
    // Los logs se inicializan antes que nada: sin esto, arrancar la interfaz no
    // dejaba ni una linea en disco.
    if let Err(error) = crate::telemetry::init() {
        eprintln!("no se pudieron inicializar los logs: {error}");
    }

    // Instancia unica: dos instancias consumirian la misma cuota de firma y
    // escribirian en la misma base de datos.
    match crate::core::single::InstanceGuard::acquire() {
        Ok(Some(guard)) => {
            let port = guard.port();
            // El guardia debe vivir todo el proceso; se filtra a proposito.
            Box::leak(Box::new(guard));
            launch(port);
        }
        Ok(None) => {
            eprintln!("Ya hay una instancia de TikTokStreamDashboard en ejecución.");
        }
        Err(error) => {
            eprintln!("No se pudo comprobar la instancia única: {error}");
        }
    }
}

fn launch(instance_port: u16) {
    let app = tauri::Builder::default()
        .setup(move |app| {
            let state = Arc::new(AppState::new(instance_port).map_err(|e| e.to_string())?);
            // El setup corre en el hilo principal sin runtime de Tokio, asi que
            // se usa el runtime de Tauri (que si es Tokio por dentro).
            tauri::async_runtime::spawn(state.consumer_future());
            // El lector de voz escucha el mismo bus en su propia tarea.
            tauri::async_runtime::spawn(state.tts.consumer_future());
            spawn_ui_bridge(app.handle().clone(), state.clone());

            // Arranque automatico, util para desarrollo y para verificar sin
            // tocar la interfaz:
            //   TTSDASH_AUTOSTART=sim          -> proveedor simulado
            //   TTSDASH_AUTOSTART=<usuario>    -> proveedor real
            if let Ok(auto) = std::env::var("TTSDASH_AUTOSTART") {
                let auto = auto.trim().to_string();
                if !auto.is_empty() {
                    let state = state.clone();
                    tauri::async_runtime::spawn(async move {
                        let simulated = auto == "sim" || auto == "simulado";
                        let result = if simulated {
                            if let Ok(mut guard) = state.provider.write() {
                                *guard = state.simulated.clone() as Arc<dyn TikTokProvider>;
                            }
                            state.simulated.connect("simulado").await
                        } else {
                            state.native.connect(&auto).await
                        };
                        match result {
                            Ok(()) => tracing::info!(proveedor = %auto, "arranque automatico"),
                            Err(error) => tracing::warn!(%error, "arranque automatico fallido"),
                        }
                    });
                }
            }

            // Lector de voz activado de fabrica para desarrollo y verificacion:
            //   TTSDASH_TTS=on
            if let Ok(valor) = std::env::var("TTSDASH_TTS") {
                let activo = matches!(
                    valor.trim().to_ascii_lowercase().as_str(),
                    "on" | "1" | "true" | "si" | "sí"
                );
                if activo {
                    state.tts.set_enabled(true);
                    tracing::info!("lector de voz activado por TTSDASH_TTS");
                }
            }

            app.manage(state);
            tracing::info!(port = instance_port, "aplicación lista");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_snapshot,
            app_metrics,
            ui_receiving,
            ui_events,
            ui_chat,
            ui_error,
            tts_status,
            tts_update,
            tts_action,
            tts_voices,
            connect,
            start_simulation,
            use_native_provider,
            disconnect,
            clear_chat,
            clear_feed
        ])
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                // Cierre ordenado: se vacia la cola de escritura y se apaga el
                // lector de voz (que a su vez cierra el sidecar).
                state.shutdown();
                let state = state.inner().clone();
                tauri::async_runtime::block_on(async move {
                    state.shutdown_tts().await;
                });
            }
            tracing::info!("aplicación cerrada");
        }
    });
}
