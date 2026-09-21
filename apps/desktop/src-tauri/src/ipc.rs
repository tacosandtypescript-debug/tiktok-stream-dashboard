//! Superficie de comandos, compartida por los dos transportes.
//!
//! La aplicacion tiene dos formas de llegar al motor:
//!
//! - el **shell de escritorio** (`desktop.rs`), que expone comandos tipados de
//!   Tauri y los pinta en un WebView;
//! - el **servidor web** (`web/`), que expone los mismos comandos por HTTP y los
//!   eventos por WebSocket, para trabajar desde un navegador.
//!
//! Los dos transportes tienen que hacer **exactamente lo mismo**. Por eso aqui
//! vive lo que tiene decision propia —la validacion del handle, el recorrido de
//! carpetas al importar medios, el mapeo de los ajustes de voz— y el despachador
//! `dispatch` que usa el servidor web. `desktop.rs` llama a estas mismas
//! funciones: no hay dos copias de una regla que se puedan separar con el tiempo.

use std::path::Path;
use std::sync::Arc;

use crate::app::{AppState, Snapshot};

/// Cambios de configuracion del lector de voz. Todo opcional: solo se aplica lo
/// que la interfaz envia.
#[derive(Debug, Default, serde::Deserialize)]
pub struct TtsPatch {
    pub enabled: Option<bool>,
    pub volume: Option<f32>,
    pub rate: Option<String>,
    pub pitch: Option<String>,
    /// Plantilla de lo que se lee para un mensaje de chat.
    pub chat_template: Option<String>,
    /// Plantilla de lo que se lee para un regalo.
    pub gift_template: Option<String>,
    /// Plantilla de lo que se lee para un seguidor nuevo.
    pub follow_template: Option<String>,
    pub voice_es: Option<String>,
    pub voice_en: Option<String>,
    pub read_gifts: Option<bool>,
    pub read_follows: Option<bool>,
    /// Motor de voz (edge-tts o Fish Audio).
    pub provider: Option<crate::tts::VoiceProvider>,
    /// Codigo de voz de Fish (`reference_id`).
    pub fish_reference_id: Option<String>,
    /// Modelo de Fish.
    pub fish_model: Option<String>,
    /// Las voces de Fish guardadas con su nombre, **la lista entera**: la
    /// interfaz manda el resultado despues de anadir o quitar, que es quien sabe
    /// cual acaba de tocar el streamer.
    pub fish_voces: Option<Vec<crate::tts::manager::VozGuardada>>,
}

/// Lo que salio de importar varios ficheros de golpe.
#[derive(serde::Serialize)]
pub struct ImportacionMedios {
    /// Cuantos entraron.
    pub importados: usize,
    /// Los que no, ya con su motivo escrito. Se enseñan: un fichero que se queda
    /// fuera en silencio es un fichero que el streamer cree que tiene y no tiene.
    pub fallos: Vec<String>,
    /// El estado nuevo, para que la interfaz no tenga que pedirlo aparte.
    pub snapshot: Snapshot,
}

/// Traza del chat: mensaje recibido por la interfaz o lista ya pintada.
///
/// `dom` es una medida del WebView ("ul 320/920 top=0 | main ..."): dice que
/// elemento desplaza de verdad la lista, que es justo lo que no se puede ver
/// desde Rust ni desde la base de datos.
#[derive(Debug, Default, serde::Deserialize)]
pub struct UiChatPayload {
    pub received_seq: Option<u64>,
    pub rendered_len: Option<u64>,
    pub rendered_seq: Option<u64>,
    pub dom: Option<String>,
}

/// Valida un handle de TikTok y devuelve la URL de su perfil.
///
/// El handle llega de la interfaz, asi que **no se puede confiar en el**: se
/// valida caracter a caracter y la URL se construye aqui, no en el cliente. Sin
/// esto, un `unique_id` con `../` o con un esquema pegado (`javascript:`) seria
/// una via para abrir cualquier cosa.
///
/// Vive aqui, y no en cada transporte, porque el servidor web **no abre** el
/// navegador de la maquina: le devuelve la URL ya validada al navegador del
/// streamer, que es quien tiene que abrirla. La validacion es la misma en los dos
/// casos.
pub fn perfil_url(unique_id: &str) -> Result<String, String> {
    let handle = unique_id.trim().trim_start_matches('@');
    let valido = !handle.is_empty()
        && handle.len() <= 32
        && handle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
    if !valido {
        return Err(format!("handle de TikTok no valido: {unique_id}"));
    }
    Ok(format!("https://www.tiktok.com/@{handle}"))
}

/// Importa una lista de rutas (ficheros o carpetas) al almacen de medios.
///
/// Una **carpeta** se abre y se importa lo que haya dentro, sin bajar a
/// subcarpetas: es lo que permite soltar de una vez la carpeta entera donde el
/// streamer guarda sus sonidos. Un fichero que falla **no tira los demas**: en una
/// carpeta siempre hay uno que no vale, y perder los otros nueve por ese seria peor
/// que no tener la funcion.
///
/// Devuelve cuantos entraron y, por cada uno que no, su motivo ya escrito.
pub fn importar_medios(rutas: &[String]) -> (usize, Vec<String>) {
    let almacen = crate::alerts::Almacen::nuevo();
    let mut importados = 0;
    let mut fallos = Vec::new();

    for ruta in rutas {
        let camino = Path::new(ruta);
        // Una carpeta se abre; un fichero se importa. Se mira antes de importar
        // porque `importar_desde_ruta` rechazaria la carpeta con «no es un fichero»
        // y el streamer no sabria por que.
        let dentro: Vec<std::path::PathBuf> = if camino.is_dir() {
            match std::fs::read_dir(camino) {
                Ok(entradas) => entradas
                    .filter_map(|entrada| entrada.ok())
                    .map(|entrada| entrada.path())
                    // Solo ficheros: una subcarpeta se ignora en vez de fallar, para
                    // que soltar una carpeta con carpetas dentro no llene la lista de
                    // errores que no lo son.
                    .filter(|p| p.is_file())
                    .collect(),
                Err(error) => {
                    fallos.push(format!("{ruta}: no se pudo abrir la carpeta ({error})"));
                    continue;
                }
            }
        } else {
            vec![camino.to_path_buf()]
        };

        for fichero in dentro {
            match almacen.importar_desde_ruta(&fichero) {
                Ok(_) => importados += 1,
                Err(error) => fallos.push(format!("{}: {error}", fichero.display())),
            }
        }
    }

    (importados, fallos)
}

/// Aplica un parche de ajustes del lector de voz y lo persiste.
pub fn aplicar_patch_tts(state: &AppState, patch: TtsPatch) -> Result<(), String> {
    use crate::tts::voices::Language;

    // El motor **primero**: la voz de las frases siguientes depende de cual este
    // puesto, y cambiar el motor descarta lo que estaba en cola.
    if let Some(provider) = patch.provider {
        state.set_voice_provider(provider);
    }
    if let Some(enabled) = patch.enabled {
        state.tts.set_enabled(enabled);
    }
    if let Some(volume) = patch.volume {
        state.tts.set_volume(volume);
    }
    if let Some(rate) = patch.rate {
        state.tts.set_rate(&rate);
    }
    if let Some(pitch) = patch.pitch {
        state.tts.set_pitch(&pitch);
    }
    if let Some(value) = patch.read_gifts {
        state.tts.set_read_gifts(value);
    }
    if let Some(value) = patch.read_follows {
        state.tts.set_read_follows(value);
    }
    if let Some(plantilla) = patch.chat_template {
        state.tts.set_chat_template(&plantilla);
    }
    if let Some(plantilla) = patch.gift_template {
        state.tts.set_gift_template(&plantilla);
    }
    if let Some(plantilla) = patch.follow_template {
        state.tts.set_follow_template(&plantilla);
    }
    if let Some(voice) = patch.voice_es {
        state.tts.set_voice(Language::Es, &voice);
    }
    if let Some(voice) = patch.voice_en {
        state.tts.set_voice(Language::En, &voice);
    }
    if let Some(voice) = patch.fish_reference_id {
        state.tts.set_fish_voice(&voice);
    }
    if let Some(model) = patch.fish_model {
        state.tts.set_fish_model(&model);
    }
    if let Some(voces) = patch.fish_voces {
        state.tts.set_fish_voces(&voces);
    }
    state
        .persist_tts_settings()
        .map_err(|error| format!("no se pudieron guardar los ajustes TTS: {error:#}"))
}

/// Acciones puntuales sobre la cola de voz o los usuarios silenciados.
pub fn accion_tts(state: &AppState, action: &str, value: Option<&str>) -> Result<(), String> {
    match action {
        "pause" => state.tts.pause(),
        "resume" => state.tts.resume(),
        "skip" => state.tts.skip(),
        "clear" => {
            state.tts.clear();
        }
        "remove" => {
            let id: u64 = value
                .ok_or("falta el identificador")?
                .parse()
                .map_err(|_| "identificador inválido")?;
            state.tts.remove(id);
        }
        "mute" => {
            let user = value.ok_or("falta el usuario")?;
            state.tts.mute_user(user);
        }
        "unmute" => {
            let user = value.ok_or("falta el usuario")?;
            state.tts.unmute_user(user);
        }
        other => return Err(format!("acción desconocida: {other}")),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Despachador del servidor web
// ---------------------------------------------------------------------------

/// Despacha un comando por su nombre, con los argumentos ya en JSON.
///
/// Es el equivalente de `invoke` en el servidor web: los mismos nombres, los
/// mismos argumentos y **las mismas funciones** que usa el shell de escritorio.
/// Un comando desconocido devuelve error en vez de un `null` silencioso, para que
/// un nombre mal escrito se vea al momento.
pub async fn dispatch(
    state: &Arc<AppState>,
    cmd: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match cmd {
        // --- Motor y estado -------------------------------------------------
        "app_snapshot" => a_json(&state.snapshot()),
        "app_metrics" => a_json(&state.metrics()),
        "set_lifetime" => {
            let enabled: bool = campo(args, "enabled")?;
            state.set_lifetime_enabled(enabled);
            if enabled {
                tracing::info!("historico de aportaciones activado");
            } else {
                tracing::info!("historico de aportaciones desactivado");
            }
            a_json(&state.snapshot())
        }
        "clear_chat" => state
            .chat
            .lock()
            .map(|mut buffer| buffer.clear())
            .map(|_| serde_json::Value::Null)
            .map_err(|_| "no se pudo limpiar el chat".to_string()),
        "clear_feed" => {
            state.clear_feed();
            Ok(serde_json::Value::Null)
        }
        "connect" => {
            let handle: String = campo(args, "handle")?;
            if handle.trim().is_empty() {
                return Err("el usuario no puede estar vacío".into());
            }
            state.connect(&handle).await.map_err(|e| e.to_string())?;
            a_json(&state.snapshot())
        }
        "start_simulation" => {
            let handle: Option<String> = campo_opcional(args, "handle")?;
            let handle = handle.unwrap_or_else(|| "simulado".into());
            state
                .start_simulation(&handle)
                .await
                .map_err(|e| e.to_string())?;
            a_json(&state.snapshot())
        }
        "use_native_provider" => {
            let active = state.current_provider();
            active.disconnect().await;
            if let Ok(mut guard) = state.provider.write() {
                *guard = state.native.clone() as Arc<dyn crate::providers::TikTokProvider>;
            }
            a_json(&state.snapshot())
        }
        "disconnect" => {
            let provider = state.current_provider();
            provider.disconnect().await;
            a_json(&state.snapshot())
        }

        // --- Overlay y alertas ----------------------------------------------
        "set_overlay_design" => {
            let vista: String = campo(args, "vista")?;
            let diseno: String = campo(args, "diseno")?;
            state.set_overlay_diseno(&vista, &diseno)?;
            tracing::info!(%vista, %diseno, "diseno de overlay cambiado");
            a_json(&state.snapshot())
        }
        "set_alertas" => {
            let ajustes: crate::alerts::AjustesAlertas = campo(args, "ajustes")?;
            state
                .set_alertas(ajustes)
                .map_err(|error| error.to_string())?;
            a_json(&state.snapshot())
        }
        "importar_medio_alerta" => {
            let ruta: String = campo(args, "ruta")?;
            crate::alerts::Almacen::nuevo()
                .importar_desde_ruta(Path::new(&ruta))
                .map_err(|error| error.to_string())?;
            a_json(&state.snapshot())
        }
        "importar_medio_alerta_bytes" => {
            let nombre: String = campo(args, "nombre")?;
            let bytes: Vec<u8> = campo(args, "bytes")?;
            crate::alerts::Almacen::nuevo()
                .importar_bytes(&nombre, &bytes)
                .map_err(|error| error.to_string())?;
            a_json(&state.snapshot())
        }
        "importar_medios_alerta" => {
            let rutas: Vec<String> = campo(args, "rutas")?;
            let (importados, fallos) = importar_medios(&rutas);
            a_json(&ImportacionMedios {
                importados,
                fallos,
                snapshot: state.snapshot(),
            })
        }
        "borrar_medio_alerta" => {
            let nombre: String = campo(args, "nombre")?;
            crate::alerts::Almacen::nuevo()
                .borrar(&nombre)
                .map_err(|error| error.to_string())?;
            a_json(&state.snapshot())
        }
        "probar_alerta" => {
            let tipo: String = campo(args, "tipo")?;
            let tipo = crate::alerts::TipoAviso::desde_id(&tipo)
                .ok_or_else(|| format!("tipo de aviso desconocido: {tipo}"))?;
            state.probar_alerta(tipo);
            a_json(&state.snapshot())
        }
        "oir_medio" => {
            let nombre: String = campo(args, "nombre")?;
            state.oir_medio(&nombre)?;
            Ok(serde_json::Value::Null)
        }
        "parar_preview" => {
            let esperado: Option<crate::preview::DuenioPreview> = campo_opcional(args, "esperado")?;
            state.parar_preview(esperado);
            Ok(serde_json::Value::Null)
        }
        "preview_estado" => a_json(&state.preview_estado()),

        // --- Diagnostico de la interfaz --------------------------------------
        "ui_receiving" => {
            tracing::info!("interfaz recibiendo eventos del bus (flujo en vivo operativo)");
            Ok(serde_json::Value::Null)
        }
        "ui_events" => {
            let counts: std::collections::HashMap<String, u64> = campo(args, "counts")?;
            state.note_ui_events(&counts);
            Ok(serde_json::Value::Null)
        }
        "ui_chat" => {
            let payload: UiChatPayload = campo(args, "payload")?;
            state.note_ui_chat(
                payload.received_seq,
                payload.rendered_len,
                payload.rendered_seq,
                payload.dom.as_deref(),
            );
            Ok(serde_json::Value::Null)
        }
        "ui_error" => {
            let message: String = campo(args, "message")?;
            tracing::error!(origen = "interfaz", "{message}");
            Ok(serde_json::Value::Null)
        }

        // --- Voz --------------------------------------------------------------
        "tts_status" => a_json(&state.tts_status()),
        "tts_cuota" => {
            let tts = state.tts.clone();
            a_json(&tts.cuota().await)
        }
        "tts_update" => {
            let patch: TtsPatch = campo(args, "patch")?;
            aplicar_patch_tts(state, patch)?;
            Ok(serde_json::Value::Null)
        }
        "tts_action" => {
            let action: String = campo(args, "action")?;
            let value: Option<String> = campo_opcional(args, "value")?;
            accion_tts(state, &action, value.as_deref())?;
            Ok(serde_json::Value::Null)
        }
        "tts_voices" => a_json(&crate::tts::catalog()),
        "tts_devices" => {
            let devices = crate::tts::player::list_devices()
                .map_err(|error| format!("no se pudieron listar los dispositivos: {error:#}"))?;
            a_json(&devices)
        }
        "tts_select_device" => {
            let device: Option<String> = campo_opcional(args, "device")?;
            state
                .select_tts_device(device.as_deref())
                .map_err(|error| format!("{error:#}"))?;
            a_json(&state.tts_status())
        }
        "tts_key_add" => {
            let nombre: String = campo(args, "nombre")?;
            let clave: String = campo(args, "clave")?;
            let status = state
                .tts_key_add(&nombre, &clave)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_key_remove" => {
            let id: u64 = campo(args, "id")?;
            let status = state
                .tts_key_remove(id)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_key_reset" => {
            let id: u64 = campo(args, "id")?;
            let status = state
                .tts_key_reset(id)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_key_rename" => {
            let id: u64 = campo(args, "id")?;
            let nombre: String = campo(args, "nombre")?;
            let status = state
                .tts_key_rename(id, &nombre)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_key_disable" => {
            let id: u64 = campo(args, "id")?;
            let status = state
                .tts_key_disable(id)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_key_probar" => {
            let id: u64 = campo(args, "id")?;
            state
                .tts_key_probar(id)
                .await
                .map_err(|error| format!("{error:#}"))?;
            Ok(serde_json::Value::Null)
        }

        // --- La biblioteca de voces -------------------------------------------
        "tts_voces_buscar" => {
            let filtros: crate::tts::fish_modelos::FiltrosVoces =
                campo_opcional(args, "filtros")?.unwrap_or_default();
            let pagina = state
                .voces_buscar(filtros)
                .await
                .map_err(|error| format!("{error:#}"))?;
            a_json(&pagina)
        }
        "tts_voz_obtener" => {
            let id: String = campo(args, "id")?;
            let voz = state
                .voz_obtener(&id)
                .await
                .map_err(|error| format!("{error:#}"))?;
            a_json(&voz)
        }
        "tts_voz_guardar" => {
            let id: String = campo(args, "id")?;
            let nombre: Option<String> = campo_opcional(args, "nombre")?;
            let status = state
                .voz_guardar(&id, nombre.as_deref().unwrap_or_default())
                .await
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_voz_quitar" => {
            let referencia: String = campo(args, "referencia")?;
            let status = state
                .voz_quitar(&referencia)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_voz_renombrar" => {
            let referencia: String = campo(args, "referencia")?;
            let nombre: String = campo(args, "nombre")?;
            let status = state
                .voz_renombrar(&referencia, &nombre)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_voz_favorita" => {
            let referencia: String = campo(args, "referencia")?;
            let favorito: bool = campo(args, "favorito")?;
            let status = state
                .voz_favorita(&referencia, favorito)
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_voces_actualizar" => {
            let referencia: String = campo(args, "referencia")?;
            let status = state
                .voz_actualizar(&referencia)
                .await
                .map_err(|error| format!("{error:#}"))?;
            a_json(&status)
        }
        "tts_voz_probar" => {
            let referencia: String = campo(args, "referencia")?;
            let texto: Option<String> = campo_opcional(args, "texto")?;
            let archivo = state
                .voz_probar(&referencia, texto.as_deref())
                .await
                .map_err(|error| format!("{error:#}"))?;
            a_json(&archivo)
        }
        "tts_voz_portada" => {
            let id: String = campo(args, "id")?;
            let url: String = campo(args, "url")?;
            let archivo = state
                .voz_cachear_portada(&id, &url)
                .await
                .map_err(|error| format!("{error:#}"))?;
            a_json(&archivo)
        }

        // --- Perfiles ---------------------------------------------------------
        // El servidor web **no** abre el navegador de su maquina: devuelve la URL
        // ya validada y la abre el navegador del streamer. Exponer `abrir_perfil`
        // tal cual permitiria lanzar un navegador en el servidor a quien diera con
        // el puerto.
        "perfil_url" => {
            let unique_id: String = campo(args, "unique_id")?;
            a_json(&perfil_url(&unique_id)?)
        }

        otro => Err(format!("comando desconocido: {otro}")),
    }
}

/// Saca un argumento obligatorio del cuerpo JSON.
fn campo<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    nombre: &str,
) -> Result<T, String> {
    let valor = args
        .get(nombre)
        .ok_or_else(|| format!("falta el argumento `{nombre}`"))?;
    serde_json::from_value(valor.clone())
        .map_err(|error| format!("argumento `{nombre}` inválido: {error}"))
}

/// Saca un argumento opcional. Ausente y `null` son lo mismo: `None`.
fn campo_opcional<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    nombre: &str,
) -> Result<Option<T>, String> {
    match args.get(nombre) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(valor) => serde_json::from_value(valor.clone())
            .map(Some)
            .map_err(|error| format!("argumento `{nombre}` inválido: {error}")),
    }
}

fn a_json<T: serde::Serialize>(valor: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(valor)
        .map_err(|error| format!("no se pudo serializar la respuesta: {error}"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    /// Los comandos que declara el shell de escritorio.
    ///
    /// Se leen del **fuente** y no de una lista escrita a mano: una lista a mano se
    /// queda vieja justo cuando hace falta que no lo este, que es cuando alguien
    /// anade un comando.
    fn comandos_del_shell(codigo: &str) -> BTreeSet<String> {
        let mut nombres = BTreeSet::new();
        let mut lineas = codigo.lines();
        while let Some(linea) = lineas.next() {
            if linea.trim() != "#[tauri::command]" {
                continue;
            }
            // La firma puede ocupar varias lineas; el nombre esta en la primera.
            for firma in lineas.by_ref().take(6) {
                let firma = firma.trim();
                let resto = firma
                    .strip_prefix("fn ")
                    .or_else(|| firma.strip_prefix("async fn "));
                if let Some(resto) = resto {
                    if let Some((nombre, _)) = resto.split_once('(') {
                        nombres.insert(nombre.trim().to_string());
                    }
                    break;
                }
            }
        }
        nombres
    }

    /// Los comandos que atiende el despachador del servidor web.
    ///
    /// Solo el cuerpo de `dispatch`: las sub-acciones de `accion_tts` —`pause`,
    /// `skip`...— tienen la misma forma y no son comandos de la superficie.
    fn comandos_del_despachador(codigo: &str) -> BTreeSet<String> {
        let desde = codigo
            .find("pub async fn dispatch")
            .expect("existe `dispatch` en ipc.rs");
        let cuerpo = &codigo[desde..];
        // Una llave a principio de linea solo puede ser el cierre de la funcion:
        // dentro, todo va indentado.
        let hasta = cuerpo
            .find("\n}\n")
            .expect("`dispatch` cierra su llave en una linea propia");
        cuerpo[..hasta]
            .lines()
            .filter_map(|linea| {
                let linea = linea.trim();
                let resto = linea.strip_prefix('"')?;
                let (nombre, cola) = resto.split_once('"')?;
                cola.trim_start()
                    .starts_with("=>")
                    .then(|| nombre.to_string())
            })
            .collect()
    }

    /// Las diferencias **a proposito**, para que se vean y no se confundan con un
    /// olvido. Si aparece una tercera, el test falla y hay que decidir cual es.
    const SOLO_ESCRITORIO: &[&str] = &[
        // Abre el navegador en la maquina del streamer: expuesto por HTTP, quien
        // diera con el puerto podria lanzar un navegador en el servidor. En su
        // lugar, el panel web tiene `perfil_url`.
        "abrir_perfil",
    ];
    const SOLO_WEB: &[&str] = &[
        // La direccion del perfil ya validada: es lo que el panel web ofrece en
        // lugar de `abrir_perfil`.
        "perfil_url",
    ];

    /// Los dos transportes tienen que ofrecer los mismos comandos.
    ///
    /// La superficie esta declarada dos veces —los `#[tauri::command]` de
    /// `desktop.rs` y los brazos de `dispatch`—, y nada impedia que se separaran: un
    /// comando anadido en un solo lado funciona en la ventana y no en el panel web
    /// (o al reves), y el fallo es un «comando desconocido» que nadie ve hasta que lo
    /// usa. Este test es lo que lo convierte en un fallo de la suite.
    #[test]
    fn los_dos_transportes_exponen_los_mismos_comandos() {
        let shell = comandos_del_shell(include_str!("desktop.rs"));
        let web = comandos_del_despachador(include_str!("ipc.rs"));

        assert!(
            !shell.is_empty() && !web.is_empty(),
            "no se extrajo ningun comando, revisa el extractor: {shell:?} / {web:?}"
        );

        let solo_escritorio: Vec<&String> = shell
            .iter()
            .filter(|nombre| !web.contains(*nombre) && !SOLO_ESCRITORIO.contains(&nombre.as_str()))
            .collect();
        let solo_web: Vec<&String> = web
            .iter()
            .filter(|nombre| !shell.contains(*nombre) && !SOLO_WEB.contains(&nombre.as_str()))
            .collect();

        assert!(
            solo_escritorio.is_empty(),
            "estos comandos solo los tiene el escritorio, y el panel web contestaria \
             «comando desconocido»: {solo_escritorio:?}"
        );
        assert!(
            solo_web.is_empty(),
            "estos comandos solo los tiene el servidor web, y la ventana no los ve: {solo_web:?}"
        );

        // Y las excepciones siguen existiendo: si alguna desaparece, esta lista miente.
        for nombre in SOLO_ESCRITORIO {
            assert!(
                shell.contains(*nombre),
                "{nombre} ya no existe en el escritorio"
            );
        }
        for nombre in SOLO_WEB {
            assert!(
                web.contains(*nombre),
                "{nombre} ya no existe en el servidor web"
            );
        }
    }
}
