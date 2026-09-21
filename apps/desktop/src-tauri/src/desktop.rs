//! Shell de escritorio (Tauri).
//!
//! Solo contiene lo imprescindible: la ventana, los comandos y el puente de
//! eventos hacia la interfaz. Todo el motor vive en `crate::app`, que no depende
//! de Tauri y por tanto se puede probar sin compilarlo.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager, State};

use crate::app::{AppState, Snapshot};
use crate::core::MetricsSnapshot;
use crate::ipc::ImportacionMedios;
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

/// Abre el perfil de TikTok de una persona en el navegador del sistema.
///
/// El handle llega de la interfaz, asi que **no se puede confiar en el**: lo
/// valida `crate::ipc::perfil_url`, que es la misma funcion que usa el servidor
/// web, y la URL se construye en Rust, no en el WebView. Sin esto, un `unique_id`
/// con `../` o con un esquema pegado (`javascript:`) seria una via para abrir
/// cualquier cosa desde el renderer, y la CSP del WebView no protege de un `start`
/// del sistema operativo.
///
/// Se usa `cmd /C start` en lugar de anadir `tauri-plugin-opener` porque es una
/// sola llamada: no merece una dependencia mas ni un permiso nuevo en las
/// capabilities.
#[tauri::command]
fn abrir_perfil(unique_id: String) -> Result<(), String> {
    let url = crate::ipc::perfil_url(&unique_id)?;

    #[cfg(target_os = "windows")]
    let resultado = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(not(target_os = "windows"))]
    let resultado = std::process::Command::new("xdg-open").arg(&url).spawn();

    match resultado {
        Ok(_) => {
            tracing::debug!(%url, "perfil abierto en el navegador");
            Ok(())
        }
        Err(error) => {
            tracing::warn!(%error, %url, "no se pudo abrir el perfil");
            Err(format!("no se pudo abrir el perfil: {error}"))
        }
    }
}

/// Activa o desactiva el historico de aportaciones de por vida.
///
/// Devuelve el estado con la foto nueva para que la interfaz no tenga que pedir
/// otra: el ajuste cambia lo que se enseña y conviene pintarlo al instante.
#[tauri::command]
fn set_lifetime(state: State<'_, Arc<AppState>>, enabled: bool) -> Snapshot {
    state.set_lifetime_enabled(enabled);
    if enabled {
        tracing::info!("historico de aportaciones activado");
    } else {
        tracing::info!("historico de aportaciones desactivado");
    }
    state.snapshot()
}

/// Cambia el diseno de una vista del overlay.
///
/// Devuelve la foto nueva: la eleccion cambia lo que se ve y conviene pintarlo al
/// instante, sin pedir otro snapshot. Falla si el servidor de overlays no arranco
/// o si el diseno no vale para esa vista; en ese caso **no se guarda nada**.
#[tauri::command]
fn set_overlay_design(
    state: State<'_, Arc<AppState>>,
    vista: String,
    diseno: String,
) -> Result<Snapshot, String> {
    state.set_overlay_diseno(&vista, &diseno)?;
    tracing::info!(%vista, %diseno, "diseno de overlay cambiado");
    Ok(state.snapshot())
}

/// Guarda los ajustes de las alertas de OBS.
///
/// Devuelve la foto nueva: el cambio se ve en la pagina de Alertas y conviene
/// pintarlo al instante, sin pedir otro snapshot.
#[tauri::command]
fn set_alertas(
    state: State<'_, Arc<AppState>>,
    ajustes: crate::alerts::AjustesAlertas,
) -> Result<Snapshot, String> {
    state
        .set_alertas(ajustes)
        .map_err(|error| error.to_string())?;
    Ok(state.snapshot())
}

/// Copia un fichero del disco al almacen de medios de las alertas.
///
/// La ruta la pone el streamer (arrastrando el fichero a la ventana o
/// escribiendola). Lo que se guarda despues es **nuestro** nombre, dentro de
/// nuestra carpeta: una ruta del escritorio se rompe en cuanto se mueve un
/// fichero, y entonces en OBS sale un hueco.
#[tauri::command]
fn importar_medio_alerta(
    state: State<'_, Arc<AppState>>,
    ruta: String,
) -> Result<Snapshot, String> {
    crate::alerts::Almacen::nuevo()
        .importar_desde_ruta(std::path::Path::new(&ruta))
        .map_err(|error| error.to_string())?;
    Ok(state.snapshot())
}

/// Copia un fichero al almacen desde sus bytes.
///
/// Es el camino del selector de archivos del navegador, que da el contenido pero
/// no la ruta. Va en un solo viaje y con tope de tamano: trocearlo obligaria a
/// llevar la cuenta de un fichero a medio escribir, que es mas estado del que
/// merece un GIF.
#[tauri::command]
fn importar_medio_alerta_bytes(
    state: State<'_, Arc<AppState>>,
    nombre: String,
    bytes: Vec<u8>,
) -> Result<Snapshot, String> {
    crate::alerts::Almacen::nuevo()
        .importar_bytes(&nombre, &bytes)
        .map_err(|error| error.to_string())?;
    Ok(state.snapshot())
}

/// Copia **varios** ficheros al almacen de una vez.
///
/// Recorre `crate::ipc::importar_medios`, que es el mismo codigo que usa el
/// servidor web: la validacion —lista blanca de formatos, tope de tamano, nombre
/// saneado— es **exactamente** la misma por los dos caminos.
#[tauri::command]
fn importar_medios_alerta(
    state: State<'_, Arc<AppState>>,
    rutas: Vec<String>,
) -> Result<ImportacionMedios, String> {
    let (importados, fallos) = crate::ipc::importar_medios(&rutas);

    Ok(ImportacionMedios {
        importados,
        fallos,
        snapshot: state.snapshot(),
    })
}

/// Suena un medio del almacen en el monitor del streamer, sin encolar nada.
///
/// Es el boton de oir del editor: una lista de nombres no dice como suena nada.
#[tauri::command]
fn oir_medio(state: State<'_, Arc<AppState>>, nombre: String) -> Result<(), String> {
    state.oir_medio(&nombre)
}

/// Borra un medio del almacen.
///
/// Los avisos que lo usaran se quedan sin medio: el saneado los limpia al
/// guardar, y la interfaz avisa.
#[tauri::command]
fn borrar_medio_alerta(
    state: State<'_, Arc<AppState>>,
    nombre: String,
) -> Result<Snapshot, String> {
    crate::alerts::Almacen::nuevo()
        .borrar(&nombre)
        .map_err(|error| error.to_string())?;
    Ok(state.snapshot())
}

/// Encola una alerta de prueba, para el boton de «probar».
#[tauri::command]
fn probar_alerta(state: State<'_, Arc<AppState>>, tipo: String) -> Result<Snapshot, String> {
    let tipo = crate::alerts::TipoAviso::desde_id(&tipo)
        .ok_or_else(|| format!("tipo de aviso desconocido: {tipo}"))?;
    state.probar_alerta(tipo);
    Ok(state.snapshot())
}

/// Para el audio de previsualizacion que este sonando.
///
/// Es el otro extremo del boton de oir —el mismo sonido pulsado dos veces—, el
/// cambio de pestaña y el paso previo del coordinador antes de arrancar otra cosa:
/// ningun audio de prueba puede quedarse sonando de fondo, y dos no pueden sonar a
/// la vez. Con `esperado` solo se suelta ese preview, para no apagar el que haya
/// empezado entretanto.
#[tauri::command]
fn parar_preview(state: State<'_, Arc<AppState>>, esperado: Option<crate::preview::DuenioPreview>) {
    state.parar_preview(esperado);
}

/// Quien tiene el turno del audio de previsualizacion, si alguien.
///
/// El coordinador de la interfaz lo pregunta mientras suena algo para saber cuando
/// termino —un preview del motor se limpia solo al acabarse el fichero— y para no
/// pintar como sonando algo que ya no suena.
#[tauri::command]
fn preview_estado(state: State<'_, Arc<AppState>>) -> Option<crate::preview::DuenioPreview> {
    state.preview_estado()
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
/// El tipo vive en `crate::ipc` porque el servidor web recibe el mismo cuerpo
/// JSON y tiene que interpretarlo igual.
#[tauri::command]
fn ui_chat(state: State<'_, Arc<AppState>>, payload: crate::ipc::UiChatPayload) {
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

/// Cambios de configuracion del lector de voz.
///
/// El tipo vive en `crate::ipc`: los dos transportes mandan el mismo parche y lo
/// aplican con `crate::ipc::aplicar_patch_tts`.
#[tauri::command]
fn tts_update(state: State<'_, Arc<AppState>>, patch: crate::ipc::TtsPatch) -> Result<(), String> {
    crate::ipc::aplicar_patch_tts(&state, patch)
}

#[tauri::command]
fn tts_status(state: State<'_, Arc<AppState>>) -> crate::tts::manager::TtsStatus {
    state.tts_status()
}

/// El saldo de la cuenta del motor de voz, preguntado a su API.
///
/// Va **aparte** de `tts_status` y no dentro: el estado es sincrono y se refresca
/// cada segundo, y el saldo es una consulta de red que puede tardar o fallar. Si
/// fuera dentro, un corte de red bloquearia el refresco del estado entero.
///
/// Se puede llamar a menudo: el ritmo de las consultas lo lleva el proveedor.
#[tauri::command]
async fn tts_cuota(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<crate::tts::cuota::CuotaStatus>, String> {
    let tts = state.tts.clone();
    Ok(tts.cuota().await)
}

/// Guarda una clave de la API de voz.
///
/// Va en su propio comando, aparte de `tts_update`, porque es **escritura sola**:
/// la interfaz manda una clave nueva y **no puede leer** la que hay. Ni el estado
/// que devuelve ni el `Snapshot` llevan el valor, solo su pista enmascarada: es la
/// unica forma de que una clave no acabe en una captura de pantalla o en un log.
///
/// Devuelve el estado nuevo para que la lista de claves se repinte al instante.
#[tauri::command]
fn tts_key_add(
    state: State<'_, Arc<AppState>>,
    nombre: String,
    clave: String,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .tts_key_add(&nombre, &clave)
        .map_err(|error| format!("{error:#}"))
}

/// Quita una clave de la lista (por su posicion).
#[tauri::command]
fn tts_key_remove(
    state: State<'_, Arc<AppState>>,
    id: u64,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .tts_key_remove(id)
        .map_err(|error| format!("{error:#}"))
}

/// Vuelve a dejar utilizable una clave marcada como invalida o agotada.
#[tauri::command]
fn tts_key_reset(
    state: State<'_, Arc<AppState>>,
    id: u64,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .tts_key_reset(id)
        .map_err(|error| format!("{error:#}"))
}

/// Acciones puntuales sobre la cola o los usuarios silenciados.
#[tauri::command]
fn tts_action(
    state: State<'_, Arc<AppState>>,
    action: String,
    value: Option<String>,
) -> Result<(), String> {
    crate::ipc::accion_tts(&state, &action, value.as_deref())
}

/// Le pone otro nombre a una clave.
#[tauri::command]
fn tts_key_rename(
    state: State<'_, Arc<AppState>>,
    id: u64,
    nombre: String,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .tts_key_rename(id, &nombre)
        .map_err(|error| format!("{error:#}"))
}

/// Apaga una clave: deja de intentarse sin perderla.
#[tauri::command]
fn tts_key_disable(
    state: State<'_, Arc<AppState>>,
    id: u64,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .tts_key_disable(id)
        .map_err(|error| format!("{error:#}"))
}

/// Comprueba una clave contra la API. No gasta saldo ni cambia su estado.
#[tauri::command]
async fn tts_key_probar(state: State<'_, Arc<AppState>>, id: u64) -> Result<(), String> {
    state
        .tts_key_probar(id)
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Una pagina del catalogo de voces de Fish Audio.
#[tauri::command]
async fn tts_voces_buscar(
    state: State<'_, Arc<AppState>>,
    filtros: crate::tts::fish_modelos::FiltrosVoces,
) -> Result<crate::tts::fish_modelos::PaginaVoces, String> {
    state
        .voces_buscar(filtros)
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Una voz del catalogo, con sus muestras oficiales.
#[tauri::command]
async fn tts_voz_obtener(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<crate::tts::fish_modelos::VozFish, String> {
    state
        .voz_obtener(&id)
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Guarda una voz del catalogo en «Mis voces».
#[tauri::command]
async fn tts_voz_guardar(
    state: State<'_, Arc<AppState>>,
    id: String,
    nombre: Option<String>,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .voz_guardar(&id, nombre.as_deref().unwrap_or_default())
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Quita una voz de la lista local. No toca la cuenta de Fish.
#[tauri::command]
fn tts_voz_quitar(
    state: State<'_, Arc<AppState>>,
    referencia: String,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .voz_quitar(&referencia)
        .map_err(|error| format!("{error:#}"))
}

/// Le pone el nombre que quiere el streamer.
#[tauri::command]
fn tts_voz_renombrar(
    state: State<'_, Arc<AppState>>,
    referencia: String,
    nombre: String,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .voz_renombrar(&referencia, &nombre)
        .map_err(|error| format!("{error:#}"))
}

/// Marca o desmarca la estrella de una voz guardada.
#[tauri::command]
fn tts_voz_favorita(
    state: State<'_, Arc<AppState>>,
    referencia: String,
    favorito: bool,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .voz_favorita(&referencia, favorito)
        .map_err(|error| format!("{error:#}"))
}

/// Refresca los datos de una voz guardada preguntandoselos otra vez a Fish.
#[tauri::command]
async fn tts_voces_actualizar(
    state: State<'_, Arc<AppState>>,
    referencia: String,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .voz_actualizar(&referencia)
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Genera una prueba de una voz con el motor de siempre. **Cuesta saldo.**
#[tauri::command]
async fn tts_voz_probar(
    state: State<'_, Arc<AppState>>,
    referencia: String,
    texto: Option<String>,
) -> Result<String, String> {
    state
        .voz_probar(&referencia, texto.as_deref())
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Deja la portada de una voz en la cache local y devuelve su fichero.
#[tauri::command]
async fn tts_voz_portada(
    state: State<'_, Arc<AppState>>,
    id: String,
    url: String,
) -> Result<String, String> {
    state
        .voz_cachear_portada(&id, &url)
        .await
        .map_err(|error| format!("{error:#}"))
}

/// Voces que ofrece el catalogo curado del proyecto, para el selector de la
/// interfaz.
#[tauri::command]
fn tts_voices() -> Vec<crate::tts::Voice> {
    crate::tts::catalog()
}

/// Enumera las salidas disponibles. La enumeracion puede fallar en una
/// maquina sin backend de audio; se devuelve el motivo para que la interfaz no
/// muestre una lista ficticia.
#[tauri::command]
fn tts_devices() -> Result<Vec<String>, String> {
    crate::tts::player::list_devices()
        .map_err(|error| format!("no se pudieron listar los dispositivos: {error:#}"))
}

/// Selecciona una salida TTS de forma transaccional desde el punto de vista de
/// audio: si no se puede abrir, se conserva la anterior y el estado queda
/// degradado con el motivo exacto.
#[tauri::command]
fn tts_select_device(
    state: State<'_, Arc<AppState>>,
    device: Option<String>,
) -> Result<crate::tts::manager::TtsStatus, String> {
    state
        .select_tts_device(device.as_deref())
        .map(|_| state.tts_status())
        .map_err(|error| format!("{error:#}"))
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
    // El handle lo guarda el motor: es el que acaba en `streams.handle`.
    state.connect(&handle).await.map_err(|e| e.to_string())?;
    Ok(state.snapshot())
}

#[tauri::command]
async fn start_simulation(
    state: State<'_, Arc<AppState>>,
    handle: Option<String>,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    let handle = handle.unwrap_or_else(|| "simulado".into());
    // Elegir proveedor y abrir sesion vive en el motor (y guarda el handle).
    state
        .start_simulation(&handle)
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
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // Los tres consumidores comparten el mismo contador: si el
                    // puente a la interfaz se salta eventos, el chat y la
                    // actividad quedan con huecos y el panel de diagnostico tiene
                    // que poder verlo (antes solo lo sumaba el estado, asi que
                    // `subscription_lagged` subestimaba lo perdido).
                    state.note_lagged(skipped);
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
            // Los medios del pack se siembran **antes** de que nadie lea los
            // ajustes de alertas: los valores de fábrica apuntan a estos nombres y
            // `AppState::new` puede sanear referencias que no existan todavía.
            //
            // En desarrollo se lee el checkout; en una release, el recurso que
            // Tauri copió junto al ejecutable. Siempre se copia a AppData y nunca
            // se escribe de vuelta en el checkout.
            let origen_pack = ruta_pack_alertas(app.handle());
            if !origen_pack.is_dir() {
                tracing::error!(
                    origen = %origen_pack.display(),
                    "no existe el pack de medios de Alertas; se continúa sin sembrarlo"
                );
            } else {
                let reporte = crate::alerts::Almacen::nuevo().sembrar_pack_desde(&origen_pack);
                tracing::info!(
                    origen = %origen_pack.display(),
                    copiados = reporte.copied,
                    existentes = reporte.skipped_existing,
                    rechazados = reporte.rejected.len(),
                    "pack de medios de Alertas procesado"
                );
                for rechazado in reporte.rejected {
                    tracing::warn!(fichero = %rechazado, "medio rechazado del pack de Alertas");
                }
            }

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
                            state.connect("simulado").await
                        } else {
                            // `AppState::connect` y no el proveedor a pelo: es lo
                            // que guarda el handle en la sesion.
                            state.connect(&auto).await
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

            // Servidor de overlays para OBS. Se arranca **despues** de tener el
            // estado y **antes** de gestionarlo, para que la primera foto que
            // sirva a un Browser Source ya tenga datos.
            //
            // Un fallo aqui no impide arrancar: sin puerto libre o sin permiso
            // para escribir la configuracion, la aplicacion sigue funcionando y
            // el overlay queda como "no disponible" en la interfaz. El dashboard
            // va por IPC, asi que no depende de este servidor.
            match crate::overlay::OverlayConfig::load_or_create(
                &crate::overlay::OverlayConfig::path(),
            ) {
                Ok(config) => match crate::overlay::spawn(state.clone(), &config) {
                    Ok(puerto) => {
                        // El puerto real puede no ser el preferido: se guarda el
                        // que se ha conseguido para que la URL de OBS no cambie.
                        let config = config.con_puerto(puerto);
                        let _ = config.save(&crate::overlay::OverlayConfig::path());
                        tracing::info!(
                            pagina = %config.pagina_url(crate::overlay::VISTA_POR_DEFECTO),
                            "overlay de OBS disponible"
                        );
                        state.set_overlay(config);
                    }
                    Err(error) => tracing::warn!(%error, "sin servidor de overlays"),
                },
                Err(error) => tracing::warn!(%error, "sin configuracion de overlays"),
            }

            app.manage(state);
            tracing::info!(port = instance_port, "aplicación lista");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_snapshot,
            app_metrics,
            set_lifetime,
            set_overlay_design,
            set_alertas,
            importar_medio_alerta,
            importar_medio_alerta_bytes,
            importar_medios_alerta,
            oir_medio,
            borrar_medio_alerta,
            probar_alerta,
            parar_preview,
            preview_estado,
            abrir_perfil,
            ui_receiving,
            ui_events,
            ui_chat,
            ui_error,
            tts_status,
            tts_cuota,
            tts_update,
            tts_action,
            tts_voices,
            tts_devices,
            tts_select_device,
            tts_key_add,
            tts_key_remove,
            tts_key_reset,
            tts_key_rename,
            tts_key_disable,
            tts_key_probar,
            tts_voces_buscar,
            tts_voz_obtener,
            tts_voz_guardar,
            tts_voz_quitar,
            tts_voz_renombrar,
            tts_voz_favorita,
            tts_voces_actualizar,
            tts_voz_probar,
            tts_voz_portada,
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

/// Resuelve el origen de fábrica sin convertirlo en el almacén de runtime.
///
/// El recurso empaquetado es la ruta canónica en release. En debug el directorio
/// de recursos puede no existir todavía, por eso se usa directamente el pack del
/// checkout. El fallback de release permite ejecutar un binario no empaquetado
/// desde el mismo checkout para diagnóstico.
fn ruta_pack_alertas(app: &tauri::AppHandle) -> PathBuf {
    let fallback = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("alertas-pack");

    #[cfg(debug_assertions)]
    {
        let _ = app;
        fallback
    }

    #[cfg(not(debug_assertions))]
    {
        app.path()
            .resource_dir()
            .ok()
            .map(|directorio| directorio.join("alertas-pack"))
            .filter(|directorio| directorio.is_dir())
            .unwrap_or(fallback)
    }
}
