//! Panel servido por HTTP, para trabajar desde un navegador.
//!
//! La aplicacion nace como app de escritorio: el motor (Rust) es la fuente de
//! verdad y la interfaz habla con el por el IPC de Tauri. Ese canal **solo existe
//! dentro del WebView**, asi que un navegador no puede usarlo. Este modulo abre el
//! mismo motor por donde si puede: un servidor local que sirve la interfaz ya
//! compilada, expone los comandos por HTTP y empuja los eventos por WebSocket.
//!
//! Lo que **no** hace:
//!
//! - no reimplementa nada del motor: los comandos los despacha `crate::ipc`, que
//!   es el mismo codigo que ejecuta el shell de escritorio;
//! - no abre el navegador de la maquina al pedir un perfil: devuelve la URL ya
//!   validada (`perfil_url`) y la abre el navegador de quien esta mirando;
//! - no se expone a la red por su cuenta: escucha en `127.0.0.1` salvo que se
//!   pida lo contrario con `TTSDASH_WEB_BIND`. Por aqui se puede encender el
//!   lector de voz y leer el chat de una sala, asi que la puerta empieza cerrada.
//!
//! Configuracion:
//!
//! | Variable | Para que |
//! |---|---|
//! | `TTSDASH_WEB_PORT` | Puerto (por defecto 8790) |
//! | `TTSDASH_WEB_BIND` | Interfaz de escucha (por defecto 127.0.0.1) |
//! | `TTSDASH_WEB_DIST` | Carpeta de la interfaz compilada |

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{OriginalUri, Path as RutaAxum, State as EstadoAxum};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tokio::sync::broadcast;

use crate::app::AppState;

/// Puerto por defecto del panel web.
///
/// No puede ser ni el de la guarda de instancia unica (7879) ni el de los
/// overlays: son servidores distintos y tienen que poder convivir.
pub const PUERTO_POR_DEFECTO: u16 = 8790;

/// Lo que comparten todos los manejadores.
struct WebState {
    app: Arc<AppState>,
    /// Eventos del bus ya serializados, listos para ir por el WebSocket.
    eventos: broadcast::Sender<String>,
    /// De donde se sirve la interfaz compilada.
    dist: PathBuf,
}

/// Arranca el panel web y **bloquea** hasta que el servidor termina.
///
/// Es el equivalente de `desktop::run()`: misma instancia unica, mismo motor, los
/// mismos tres consumidores del bus.
pub fn run() -> anyhow::Result<()> {
    if let Err(error) = crate::telemetry::init() {
        eprintln!("no se pudieron inicializar los logs: {error}");
    }

    let bind = std::env::var("TTSDASH_WEB_BIND")
        .ok()
        .map(|valor| valor.trim().to_string())
        .filter(|valor| !valor.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let puerto = puerto_configurado();
    let dist = dist_dir();

    if !dist.is_dir() {
        tracing::warn!(
            ruta = %dist.display(),
            "no existe la carpeta de la interfaz compilada; compilala con `npm run build` o apunta TTSDASH_WEB_DIST"
        );
    }

    // Instancia unica: dos instancias consumirian la misma cuota de firma y
    // escribirian en la misma base de datos. Vale igual aqui que en escritorio,
    // pero con un matiz: este servidor **y** la aplicacion de escritorio son
    // instancias distintas del mismo motor, asi que no pueden convivir. Si esto
    // falla, casi siempre es que la ventana de escritorio esta abierta.
    let guard = match crate::core::single::InstanceGuard::acquire() {
        Ok(Some(guard)) => guard,
        Ok(None) => anyhow::bail!(
            "ya hay una instancia del motor en ejecucion (¿la aplicación de escritorio?); \
             cierrala antes de levantar el panel web"
        ),
        Err(error) => anyhow::bail!("no se pudo comprobar la instancia única: {error}"),
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("no se pudo crear el runtime: {error}"))?;

    runtime.block_on(async move {
        // La guarda tiene que vivir todo el proceso: se filtra a proposito.
        let puerto_guarda = guard.port();
        Box::leak(Box::new(guard));

        let state = Arc::new(AppState::new(puerto_guarda)?);
        tokio::spawn(state.consumer_future());
        // El lector de voz escucha el mismo bus en su propia tarea.
        tokio::spawn(state.tts.consumer_future());

        // El canal de eventos: el bus tiene **un** suscriptor que serializa y
        // reparte; cada navegador conectado es un receptor mas. Asi el bus no
        // depende de cuantos navegadores haya abiertos.
        let (emisor, _) = broadcast::channel::<String>(1024);
        tokio::spawn(publicar_eventos(state.clone(), emisor.clone()));

        arrancar_overlays(&state);

        // Arranque automatico, igual que en escritorio:
        //   TTSDASH_AUTOSTART=sim          -> proveedor simulado
        //   TTSDASH_AUTOSTART=<usuario>    -> proveedor real
        if let Ok(auto) = std::env::var("TTSDASH_AUTOSTART") {
            let auto = auto.trim().to_string();
            if !auto.is_empty() {
                let state = state.clone();
                tokio::spawn(async move {
                    use crate::providers::TikTokProvider;
                    let simulated = auto == "sim" || auto == "simulado";
                    let resultado = if simulated {
                        if let Ok(mut guard) = state.provider.write() {
                            *guard = state.simulated.clone() as Arc<dyn TikTokProvider>;
                        }
                        state.connect("simulado").await
                    } else {
                        state.connect(&auto).await
                    };
                    match resultado {
                        Ok(()) => tracing::info!(proveedor = %auto, "arranque automatico"),
                        Err(error) => tracing::warn!(%error, "arranque automatico fallido"),
                    }
                });
            }
        }

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

        let router = router(Arc::new(WebState {
            app: state.clone(),
            eventos: emisor,
            dist,
        }));

        let listener = tokio::net::TcpListener::bind((bind.as_str(), puerto))
            .await
            .map_err(|error| anyhow::anyhow!("no se pudo escuchar en {bind}:{puerto}: {error}"))?;
        let direccion = listener.local_addr()?;
        let url = format!("http://{direccion}");
        tracing::info!(%url, "panel web disponible");
        println!("panel web disponible en {url}");

        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                // Ctrl+C en la consola: se sale del `serve` y el cierre ordenado
                // de abajo vacia la cola de escritura de la base y apaga la voz.
                let _ = tokio::signal::ctrl_c().await;
                tracing::info!("cierre pedido por consola");
            })
            .await?;

        state.shutdown();
        state.shutdown_tts().await;
        tracing::info!("panel web cerrado");
        Ok(())
    })
}

/// Levanta el servidor de overlays de OBS, si se puede.
///
/// El panel lo necesita para dos cosas que se ven en pantalla: la direccion que
/// se pega en OBS y las miniaturas y la previa de los medios de Alertas, que las
/// sirve ese mismo servidor. Si no arranca, el panel sigue: las dos cosas salen
/// vacias y el diagnostico lo dice.
fn arrancar_overlays(state: &Arc<AppState>) {
    let ruta = crate::overlay::OverlayConfig::path();
    let config = match crate::overlay::OverlayConfig::load_or_create(&ruta) {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(%error, "sin configuracion de overlays");
            return;
        }
    };
    match crate::overlay::spawn(state.clone(), &config) {
        Ok(puerto) => {
            let config = config.con_puerto(puerto);
            let _ = config.save(&ruta);
            tracing::info!(
                pagina = %config.pagina_url(crate::overlay::VISTA_POR_DEFECTO),
                "overlay de OBS disponible"
            );
            state.set_overlay(config);
        }
        Err(error) => tracing::warn!(%error, "sin servidor de overlays"),
    }
}

fn router(estado: Arc<WebState>) -> Router {
    Router::new()
        .route("/salud", get(salud))
        .route("/api/eventos", get(eventos_ws))
        .route("/api/cmd/{comando}", post(comando))
        // Todo lo demas es la interfaz compilada: Vite la deja en `dist` y el
        // enrutado de la aplicacion es del navegador, asi que una ruta que no sea
        // un fichero devuelve `index.html` y React decide que pintar.
        .fallback(estatico)
        .with_state(estado)
}

/// Lo que contesta `/salud`: sirve para comprobar el montaje sin abrir el panel.
async fn salud(EstadoAxum(estado): EstadoAxum<Arc<WebState>>) -> Response {
    Json(json!({
        "ok": true,
        "motor": "tiktok-stream-dashboard",
        "version": env!("CARGO_PKG_VERSION"),
        "interfaz": estado.dist.display().to_string(),
        "interfaz_compilada": estado.dist.is_dir(),
        "overlay": estado.app.overlay_urls(),
        "esquema": estado.app.snapshot().schema_version,
    }))
    .into_response()
}

/// Despacha un comando del motor.
///
/// El sobre de la respuesta es siempre el mismo:
///
/// - `{"ok": true, "data": ...}` — el comando salio bien;
/// - `{"ok": false, "error": "..."}` — el comando fallo, y el texto es el que
///   tiene que ver el streamer.
///
/// El codigo HTTP se queda en 200 aunque el comando falle: un fallo de negocio
/// ("ese medio no vale") no es un fallo de transporte, y meterlo en un 400
/// obligaria a la interfaz a distinguir los dos casos para nada.
async fn comando(
    EstadoAxum(estado): EstadoAxum<Arc<WebState>>,
    RutaAxum(nombre): RutaAxum<String>,
    cuerpo: Bytes,
) -> Response {
    let args: serde_json::Value = if cuerpo.is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_slice(&cuerpo) {
            Ok(valor) => valor,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "error": format!("cuerpo JSON inválido: {error}") })),
                )
                    .into_response();
            }
        }
    };

    match crate::ipc::dispatch(&estado.app, &nombre, &args).await {
        Ok(data) => Json(json!({ "ok": true, "data": data })).into_response(),
        Err(error) => Json(json!({ "ok": false, "error": error })).into_response(),
    }
}

async fn eventos_ws(
    ws: WebSocketUpgrade,
    EstadoAxum(estado): EstadoAxum<Arc<WebState>>,
) -> Response {
    ws.on_upgrade(move |socket| atender_eventos(socket, estado))
}

/// Manda a un navegador cada evento del bus hasta que se va.
async fn atender_eventos(mut socket: WebSocket, estado: Arc<WebState>) {
    let mut receptor = estado.eventos.subscribe();
    tracing::debug!("navegador conectado al flujo de eventos");
    loop {
        tokio::select! {
            recibido = receptor.recv() => match recibido {
                Ok(texto) => {
                    if socket.send(Message::Text(texto.into())).await.is_err() {
                        break;
                    }
                }
                // El navegador no da abasto: se cuenta lo perdido con el mismo
                // contador que usa el resto del motor, para que el diagnostico no
                // mienta segun por donde se mire.
                Err(broadcast::error::RecvError::Lagged(saltados)) => {
                    estado.app.note_lagged(saltados);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            // Sin leer del socket no se detecta que el navegador se fue, y la
            // tarea se queda viva para siempre: una pestaña cerrada, una tarea
            // zombi. Aqui se descartan los mensajes del cliente (el canal es de
            // bajada) y se corta en cuanto se cierra.
            entrante = socket.recv() => match entrante {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    tracing::debug!("navegador desconectado del flujo de eventos");
}

/// Lee el bus y reparte los eventos ya en JSON.
///
/// Es el equivalente de `desktop::spawn_ui_bridge`, que emite por Tauri. Se
/// serializa **una vez** por evento para todos los navegadores conectados.
async fn publicar_eventos(state: Arc<AppState>, emisor: broadcast::Sender<String>) {
    let mut receptor = state.subscribe();
    loop {
        match receptor.recv().await {
            Ok(evento) => match serde_json::to_string(evento.as_ref()) {
                Ok(texto) => {
                    // Sin receptores el envio falla, y no es un problema: no hay
                    // nadie mirando. Se descarta el evento y se sigue.
                    let _ = emisor.send(texto);
                }
                Err(error) => {
                    tracing::warn!(%error, "no se pudo serializar un evento para el panel web");
                }
            },
            Err(broadcast::error::RecvError::Lagged(saltados)) => state.note_lagged(saltados),
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// Sirve la interfaz compilada.
async fn estatico(
    EstadoAxum(estado): EstadoAxum<Arc<WebState>>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let pedido = uri.path().trim_start_matches('/');

    // Una ruta que no sea un fichero es una ruta de la aplicacion: React decide
    // que pintar, pero para eso necesita el `index.html`.
    let es_ruta_de_la_app = pedido.is_empty() || Path::new(pedido).extension().is_none();
    let relativa = if pedido.is_empty() {
        "index.html"
    } else {
        pedido
    };

    if let Some(fichero) = resolver(&estado.dist, relativa) {
        if let Some(respuesta) = servir(&fichero).await {
            return respuesta;
        }
    }

    if es_ruta_de_la_app {
        if let Some(fichero) = resolver(&estado.dist, "index.html") {
            if let Some(respuesta) = servir(&fichero).await {
                return respuesta;
            }
        }
    }

    (StatusCode::NOT_FOUND, format!("no encontrado: {pedido}\n")).into_response()
}

/// Resuelve una ruta pedida contra la carpeta de la interfaz, sin salirse.
///
/// El navegador puede pedir lo que quiera, incluido `../../` o una ruta absoluta
/// de Windows: aqui se rechaza cualquier segmento que no sea un nombre normal
/// **antes** de tocar el disco, en vez de confiar en una comprobacion despues.
fn resolver(base: &Path, relativa: &str) -> Option<PathBuf> {
    let mut destino = base.to_path_buf();
    for segmento in relativa.split('/') {
        let sano = !segmento.is_empty()
            && segmento != "."
            && segmento != ".."
            && !segmento.contains('\\')
            && !segmento.contains(':');
        if !sano {
            return None;
        }
        destino.push(segmento);
    }
    if destino.is_file() {
        Some(destino)
    } else {
        None
    }
}

/// Lee un fichero y lo devuelve con su tipo y su politica de cache.
async fn servir(fichero: &Path) -> Option<Response> {
    let bytes = tokio::fs::read(fichero).await.ok()?;
    let tipo = mime_para(fichero);
    // El `index.html` **nunca** se cachea: si se queda pegado, un cambio en la
    // interfaz no se ve por mucho que se recargue, que es justo lo contrario de
    // lo que se quiere al tocar el panel. Los recursos llevan hash en el nombre
    // (Vite), asi que esos si pueden cachearse para siempre.
    let cache = if fichero
        .file_name()
        .and_then(|nombre| nombre.to_str())
        .is_some_and(|nombre| nombre == "index.html")
    {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };
    Some(
        (
            [(header::CONTENT_TYPE, tipo), (header::CACHE_CONTROL, cache)],
            bytes,
        )
            .into_response(),
    )
}

fn mime_para(ruta: &Path) -> &'static str {
    match ruta
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn puerto_configurado() -> u16 {
    std::env::var("TTSDASH_WEB_PORT")
        .ok()
        .and_then(|valor| valor.trim().parse().ok())
        .unwrap_or(PUERTO_POR_DEFECTO)
}

/// De donde se sirve la interfaz.
///
/// En desarrollo es `apps/desktop/dist`, junto al crate. En una copia del binario
/// fuera del checkout se admite una carpeta `dist` al lado del ejecutable, que es
/// lo que hace util llevarse el servidor a otra maquina.
fn dist_dir() -> PathBuf {
    if let Ok(ruta) = std::env::var("TTSDASH_WEB_DIST") {
        if !ruta.trim().is_empty() {
            return PathBuf::from(ruta);
        }
    }

    let del_checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist");
    if del_checkout.is_dir() {
        return del_checkout;
    }

    if let Ok(ejecutable) = std::env::current_exe() {
        if let Some(carpeta) = ejecutable.parent() {
            let al_lado = carpeta.join("dist");
            if al_lado.is_dir() {
                return al_lado;
            }
        }
    }

    del_checkout
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_ruta_no_se_puede_escapar_de_la_carpeta() {
        let base = Path::new("/srv/dist");
        assert!(resolver(base, "../secreto.txt").is_none());
        assert!(resolver(base, "assets/../../secreto.txt").is_none());
        assert!(resolver(base, "C:/Windows/win.ini").is_none());
        assert!(resolver(base, "assets\\..\\..\\secreto.txt").is_none());
        assert!(resolver(base, "..").is_none());
        assert!(resolver(base, "").is_none());
    }

    #[test]
    fn el_tipo_se_deduce_por_la_extension() {
        assert_eq!(
            mime_para(Path::new("a/index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            mime_para(Path::new("a/index-BnR9WEl5.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_para(Path::new("a/x.css")), "text/css; charset=utf-8");
        assert_eq!(mime_para(Path::new("a/x.woff2")), "font/woff2");
        assert_eq!(
            mime_para(Path::new("a/raro.xyz")),
            "application/octet-stream"
        );
    }
}
