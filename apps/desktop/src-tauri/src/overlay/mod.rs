//! Servidor HTTP + WebSocket para los overlays de OBS.
//!
//! OBS carga un *Browser Source*, que es un WebView que solo entiende HTTP y
//! WebSocket: no puede hablar el IPC de Tauri (eso es del origen
//! `tauri.localhost`). De ahi que los overlays no puedan reutilizar el canal de
//! la interfaz y necesiten este servidor (docs/plan-review.md §29 y §158).
//!
//! Dos decisiones del plan que se respetan aqui:
//!
//!   * **El dashboard no depende de este servidor.** La interfaz va por IPC, asi
//!     que un fallo de Axum no puede tumbar el panel (§151).
//!   * **Los overlays son stateless**: al conectar piden el estado completo y se
//!     pintan; asi un `Refresh browser when scene becomes active` de OBS nunca
//!     pierde nada.
//!
//! La pagina que se sirve **no** se compone aqui: cada diseno es un documento
//! completo (`disenos.rs`) que carga los assets compartidos por su ruta. Servir
//! el documento tal cual es lo que permite anadir un diseno sin tocar este
//! fichero, y que lo que se prueba en la pestana Overlays sea exactamente el
//! mismo fichero que carga OBS.
//!
//! Seguridad: escuchar en loopback **no** basta. Cualquier pagina que el streamer
//! visite puede intentar abrir `ws://127.0.0.1` (DNS rebinding / CSRF) y leeria
//! el directo. Por eso hay token por instalacion **y** validacion de `Origin`.

pub(crate) mod config;
pub mod disenos;
#[cfg(test)]
mod tests;

pub use config::{puerto_disponible, OverlayConfig, OVERLAY_PORT};
pub use disenos::{catalogo, DisenoInfo, VISTAS};

use std::sync::{Arc, RwLock};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use tokio::sync::{broadcast, watch};

use crate::app::AppState;
use crate::core::{Event, EventKind};

/// Vista en la que cae una peticion con `view` desconocido.
pub use disenos::VISTA_POR_DEFECTO;

/// Assets compartidos por todos los disenos.
///
/// Van embebidos en el binario (`include_str!`) y se sirven desde aqui porque el
/// overlay es autonomo: si dependiera de los recursos empaquetados de Tauri, su
/// origen seria otro y no cargarian en el Browser Source.
const COMUN_CSS: &str = include_str!("web/comun.css");
const COMUN_JS: &str = include_str!("web/comun.js");
const ANIM_JS: &str = include_str!("web/anim.js");

/// La vista de las alertas.
///
/// **No** es una vista de diseno: un diseno de ranking pinta una tabla que cambia,
/// y esto pinta un aviso detras de otro. Tiene su propia pagina y su propio
/// cliente, y por eso no aparece en `disenos::VISTAS`.
pub const VISTA_ALERTAS: &str = "alerts";

/// La pagina de alertas y su cliente.
const PAGINA_ALERTAS: &str = include_str!("web/alertas.html");
const CLIENTE_ALERTAS: &str = include_str!("web/alertas.js");

/// Lo que se envia por el WebSocket.
///
/// `state` es la foto completa (al conectar o al refrescar OBS) y `rankings` es
/// el incremental. Los dos llevan la misma forma para que el cliente tenga un
/// solo camino de pintado.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MensajeOverlay {
    State {
        provider: String,
        status: String,
        handle: String,
        tap: Vec<crate::core::event::RankingEntry>,
        gifts: Vec<crate::core::event::RankingEntry>,
        follows: Vec<crate::core::event::RankingEntry>,
    },
    Rankings {
        tap: Vec<crate::core::event::RankingEntry>,
        gifts: Vec<crate::core::event::RankingEntry>,
        follows: Vec<crate::core::event::RankingEntry>,
    },
}

/// Lo que se envia por el WebSocket de las alertas.
///
/// Dos formas y no una: al conectar se manda **lo que se quedo esperando**
/// (`alertas`, en plural, una lista) y despues cada aviso suelto (`alerta`). El
/// cliente los mete en la misma cola, asi que da igual de donde vengan.
///
/// El aviso suelto va **en caja** desde que `Aviso` crecio con las animaciones: sin
/// ella, una variante ocupaba un `Vec` y la otra un aviso entero, y el enum se quedaba
/// con el tamaño de la grande para transportar la pequeña. `Box` se serializa igual
/// —el JSON no cambia— asi que el cliente no se entera.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MensajeAlertas {
    Alertas { avisos: Vec<crate::alerts::Aviso> },
    Alerta { aviso: Box<crate::alerts::Aviso> },
}

/// Celda compartida con el estado de la aplicacion.
///
/// El servidor **no** se queda con una copia de la configuracion: lee la misma
/// celda que escribe la interfaz. Asi cambiar el diseno de una vista se ve en la
/// siguiente peticion, sin reiniciar el servidor ni volver a abrir el puerto, y
/// no hay dos copias del token que puedan discrepar.
type ConfigCompartida = Arc<RwLock<Option<Arc<OverlayConfig>>>>;

/// Estado compartido por todas las conexiones.
///
/// No guarda el bus: la suscripcion la hace **una sola** tarea
/// (`bucle_publicacion`) que reparte por el `watch`. Si cada conexion se
/// suscribiera al bus, con varios Browser Source abiertos el bus tendria un
/// receptor mas por cada uno y todos pagarian el mismo trabajo.
struct OverlayState {
    config: ConfigCompartida,
    /// Ultima foto publicada (las tres tablas). El receptor siempre tiene un
    /// valor, asi que una conexion nueva se pinta **sin esperar** al siguiente
    /// evento.
    ultimo: watch::Receiver<MensajeOverlay>,
    /// Datos de sesion que viajan en la foto de bienvenida.
    ///
    /// Se guardan aparte del `watch` porque este ultimo solo lleva el ultimo
    /// conjunto de tablas: quien se conecta necesita saber **ademas** en que
    /// estado esta el directo.
    sesion: Arc<RwLock<(String, String, String)>>,
    /// Los avisos. La cola la comparte el motor, que es quien la llena: el
    /// servidor solo la entrega y sabe cual de ellos ha salido ya.
    cola: Arc<crate::alerts::ColaAlertas>,
}

impl OverlayState {
    /// Comprueba el token de la URL.
    fn token_valido(&self, candidato: &str) -> bool {
        let Ok(guard) = self.config.read() else {
            return false;
        };
        let Some(config) = guard.as_ref() else {
            // Sin configuracion no hay servidor: nada puede ser valido.
            return false;
        };
        comparar_en_tiempo_constante(&config.token, candidato)
    }
}

/// Compara dos cadenas sin que el tiempo dependa de cuantos caracteres coinciden.
///
/// Con `==` de `String` el tiempo depende del prefijo comun, que es la clase de
/// detalle que convierte un token en decorativo. Aqui el riesgo es bajo
/// (loopback, 32 hex), pero cuesta lo mismo hacerlo bien.
fn comparar_en_tiempo_constante(esperado: &str, recibido: &str) -> bool {
    let esperado = esperado.as_bytes();
    let recibido = recibido.as_bytes();
    if esperado.len() != recibido.len() {
        return false;
    }
    esperado
        .iter()
        .zip(recibido)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[derive(Debug, Deserialize)]
pub(crate) struct Parametros {
    /// Vista que se quiere pintar (`tap`, `gifts` o `follows`).
    #[serde(default)]
    view: String,
    /// Diseno pedido en la URL.
    ///
    /// Va vacio en la direccion que se pega en OBS —ahi manda lo que el streamer
    /// haya elegido— y lo usa la pestana Overlays para pintar la previa de un
    /// diseno concreto sin cambiar el que esta en antena.
    #[serde(default)]
    diseno: String,
    /// Token de acceso.
    #[serde(default)]
    t: String,
}

/// Arranca el servidor en un hilo con su propio runtime.
///
/// Se lanza aparte del runtime de Tauri a proposito: si Axum se cae o se queda
/// sin hilos, la interfaz y el motor siguen funcionando (plan-review §151).
/// Devuelve el puerto que se ha conseguido reservar.
pub fn spawn(state: Arc<AppState>, config: &OverlayConfig) -> anyhow::Result<u16> {
    let puerto = puerto_disponible(config.port)?;

    let mut suscripcion = state.bus.subscribe();
    // Las tablas iniciales, para que una conexion que llegue antes del primer
    // evento ya tenga algo que pintar.
    let inicial = mensaje_actual(&state);
    let (tx, rx) = watch::channel(inicial);

    // Los datos de sesion se guardan aparte porque la foto de bienvenida se manda
    // **en cada conexion** (ver `atender`), no una sola vez.
    let (provider, status, handle) = datos_de_sesion(&state);
    let sesion = Arc::new(RwLock::new((provider, status, handle)));

    let estado = Arc::new(OverlayState {
        config: state.overlay.clone(),
        ultimo: rx,
        sesion: sesion.clone(),
        cola: state.cola_alertas(),
    });

    // Tarea que traduce el bus interno a la emision del overlay, con la misma
    // ventana de un segundo que ya aplica `publish_rankings`: el overlay no debe
    // recibir mas rapido de lo que puede pintar.
    let estado_tarea = estado.clone();
    std::thread::Builder::new()
        .name("overlay-server".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    tracing::error!(%error, "no se pudo crear el runtime del servidor de overlays");
                    return;
                }
            };

            runtime.block_on(async move {
                tokio::spawn(async move {
                    bucle_publicacion(&mut suscripcion, &tx).await;
                });

                let app = Router::new()
                    .route("/", get(pagina))
                    .route("/comun.css", get(estilo_compartido))
                    .route("/comun.js", get(runtime_compartido))
                    .route("/anim.js", get(animaciones))
                    .route("/alertas.js", get(cliente_alertas))
                    // Los medios de las alertas: lo que el streamer ha cargado,
                    // servido desde aqui para que OBS no dependa de rutas del disco.
                    .route("/media/{nombre}", get(media))
                    // La biblioteca de voces: la portada que se guardo en la cache
                    // y la prueba que se sintetizo. Van por aqui y no por el
                    // frontal porque el panel tambien corre en el navegador (modo
                    // web) y alli no hay acceso al disco del streamer.
                    .route("/voces/portada/{archivo}", get(portada_voz))
                    .route("/voces/prueba/{archivo}", get(prueba_voz))
                    .route("/overlay", get(websocket))
                    .route("/salud", get(salud))
                    .with_state(estado_tarea);

                match tokio::net::TcpListener::bind(("127.0.0.1", puerto)).await {
                    Ok(listener) => {
                        tracing::info!(
                            puerto,
                            url = %format!("http://127.0.0.1:{puerto}/"),
                            "servidor de overlays escuchando"
                        );
                        if let Err(error) = axum::serve(listener, app).await {
                            tracing::error!(%error, "el servidor de overlays se detuvo");
                        }
                    }
                    Err(error) => {
                        tracing::error!(%error, puerto, "no se pudo abrir el servidor de overlays");
                    }
                }
            });
        })?;

    Ok(puerto)
}

/// Traduce los eventos del bus a lo que se emite por el WebSocket.
///
/// Publica **solo incrementales**: la foto de bienvenida la manda cada conexion
/// al abrirse (ver `atender`), que es lo unico que garantiza que quien llega
/// tarde —o quien refresca el Browser Source, que es el caso normal de OBS— la
/// reciba. Mandarla una sola vez desde aqui no servia: si el primer evento del
/// directo llegaba antes que el cliente, la foto se perdia y el overlay se
/// quedaba en blanco hasta el siguiente cambio.
///
/// Solo interesan los rankings: los demas eventos se ignoran a proposito para no
/// despertar a la tarea por cada comentario del directo.
async fn bucle_publicacion(
    suscripcion: &mut broadcast::Receiver<Arc<Event>>,
    tx: &watch::Sender<MensajeOverlay>,
) {
    loop {
        match suscripcion.recv().await {
            Ok(evento) => {
                if let EventKind::RankingsUpdated {
                    tap,
                    gifts,
                    follows,
                } = &evento.kind
                {
                    // `send` falla si no queda ningun receptor; entonces se para.
                    if tx
                        .send(MensajeOverlay::Rankings {
                            tap: tap.clone(),
                            gifts: gifts.clone(),
                            follows: follows.clone(),
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(perdidos)) => {
                // Un suscriptor lento pierde eventos antiguos en vez de consumir
                // memoria: es la politica del bus. Los rankings son acumulativos,
                // asi que el siguiente evento trae la foto completa igualmente.
                tracing::debug!(perdidos, "el overlay se salto eventos del bus");
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Foto completa del estado que le interesa al overlay.
fn mensaje_actual(state: &AppState) -> MensajeOverlay {
    let (provider, status, handle) = datos_de_sesion(state);
    let (tap, gifts, follows) = tablas_actuales(state);
    MensajeOverlay::State {
        provider,
        status,
        handle,
        tap,
        gifts,
        follows,
    }
}

/// Los tres datos de sesion que viajan en la foto de bienvenida.
fn datos_de_sesion(state: &AppState) -> (String, String, String) {
    let snapshot = state.snapshot();
    (snapshot.provider, snapshot.status, snapshot.handle)
}

/// Las tres tablas de ranking de la sesion.
fn tablas_actuales(
    state: &AppState,
) -> (
    Vec<crate::core::event::RankingEntry>,
    Vec<crate::core::event::RankingEntry>,
    Vec<crate::core::event::RankingEntry>,
) {
    match state.rankings_event() {
        Some(EventKind::RankingsUpdated {
            tap,
            gifts,
            follows,
        }) => (tap, gifts, follows),
        _ => (Vec::new(), Vec::new(), Vec::new()),
    }
}

/// Las tres tablas que lleva un mensaje, sea foto o incremental.
fn tablas_del_mensaje(
    mensaje: &MensajeOverlay,
) -> (
    Vec<crate::core::event::RankingEntry>,
    Vec<crate::core::event::RankingEntry>,
    Vec<crate::core::event::RankingEntry>,
) {
    match mensaje {
        MensajeOverlay::State {
            tap,
            gifts,
            follows,
            ..
        }
        | MensajeOverlay::Rankings {
            tap,
            gifts,
            follows,
        } => (tap.clone(), gifts.clone(), follows.clone()),
    }
}

/// Sirve el documento del diseno que toque, **tal cual**.
///
/// No se compone HTML aqui: el diseno ya referencia los assets compartidos por su
/// ruta, asi que la pagina que ve el streamer es el mismo fichero que se revisa y
/// se prueba, sin una capa de plantillas que pueda divergir.
///
/// Como se elige el diseno, por orden:
///
///   1. `?diseno=<id>`, que es lo que usa la vista previa de la pestana Overlays;
///   2. el que el streamer tenga elegido para esa vista;
///   3. el de por defecto, si el identificador guardado ya no existe.
async fn pagina(
    State(estado): State<Arc<OverlayState>>,
    Query(params): Query<Parametros>,
) -> Html<&'static str> {
    // Las alertas tienen su propia pagina: no son un diseno de ranking y no pasan
    // por el catalogo.
    if params.view == VISTA_ALERTAS {
        return Html(PAGINA_ALERTAS);
    }
    Html(diseno_para(&estado, &params).html)
}

async fn cliente_alertas() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        CLIENTE_ALERTAS,
    )
}

/// Sirve un medio del almacen de alertas.
///
/// Lleva el mismo token que el WebSocket: la direccion acaba dentro de la pagina
/// del overlay, pero eso no la hace publica —cualquier pagina que el streamer
/// visite podria pedirla si no se comprobara— y cuesta lo mismo comprobarlo.
async fn media(
    State(estado): State<Arc<OverlayState>>,
    axum::extract::Path(nombre): axum::extract::Path<String>,
    Query(params): Query<Parametros>,
) -> Response {
    if !estado.token_valido(&params.t) {
        return (StatusCode::UNAUTHORIZED, "token invalido").into_response();
    }
    // `ruta_de` ya rechaza lo que pueda salir de la carpeta (`..`, barras).
    let Some(ruta) = crate::alerts::Almacen::nuevo().ruta_de(&nombre) else {
        return (StatusCode::NOT_FOUND, "ese medio no esta").into_response();
    };
    let tipo = crate::alerts::Almacen::mime(&nombre);

    // Leer fuera del runtime: un video de decenas de megas bloqueando un hilo de
    // Tokio pararia el WebSocket, que es justo lo que no puede pasar.
    match tokio::task::spawn_blocking(move || std::fs::read(ruta)).await {
        Ok(Ok(bytes)) => (
            [
                (header::CONTENT_TYPE, tipo),
                // Los medios no cambian de contenido: el navegador de OBS puede
                // quedarselos y no volver a pedirlos.
                (header::CACHE_CONTROL, "max-age=3600"),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(error)) => {
            tracing::warn!(%error, %nombre, "no se pudo leer un medio de alertas");
            (StatusCode::INTERNAL_SERVER_ERROR, "no se pudo leer").into_response()
        }
        Err(error) => {
            tracing::warn!(%error, %nombre, "la lectura del medio se cancelo");
            (StatusCode::INTERNAL_SERVER_ERROR, "no se pudo leer").into_response()
        }
    }
}

/// Sirve la portada cacheada de una voz del catalogo.
///
/// Lleva el mismo token que los medios y por la misma razon: la direccion acaba
/// dentro de la pagina del panel, y eso no la hace publica.
///
/// Se sirve **desde la cache local** y nunca desde Fish: es lo que hace que la
/// biblioteca siga enseñando las voces cuando el catalogo tarda o no contesta.
async fn portada_voz(
    State(estado): State<Arc<OverlayState>>,
    axum::extract::Path(archivo): axum::extract::Path<String>,
    Query(params): Query<Parametros>,
) -> Response {
    if !estado.token_valido(&params.t) {
        return (StatusCode::UNAUTHORIZED, "token invalido").into_response();
    }
    // Leer fuera del runtime: el disco no se toca desde un hilo de Tokio.
    match tokio::task::spawn_blocking(move || crate::tts::fish_modelos::leer_portada(&archivo))
        .await
    {
        Ok(Some((bytes, tipo))) => (
            [
                (header::CONTENT_TYPE, tipo),
                // Una portada cambia poco —solo al actualizar la voz—, asi que el
                // navegador puede quedarsela y no pedirla en cada vuelta.
                (header::CACHE_CONTROL, "max-age=3600"),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "esa portada no esta").into_response(),
        Err(error) => {
            tracing::warn!(%error, "la lectura de una portada se cancelo");
            (StatusCode::INTERNAL_SERVER_ERROR, "no se pudo leer").into_response()
        }
    }
}

/// Sirve una prueba sintetizada: el MP3 que dejo el motor al generarla.
///
/// Es el unico audio que la biblioteca reproduce **desde el disco**: las muestras
/// oficiales son direcciones de Fish y las reproduce el navegador directamente.
async fn prueba_voz(
    State(estado): State<Arc<OverlayState>>,
    axum::extract::Path(archivo): axum::extract::Path<String>,
    Query(params): Query<Parametros>,
) -> Response {
    if !estado.token_valido(&params.t) {
        return (StatusCode::UNAUTHORIZED, "token invalido").into_response();
    }
    match tokio::task::spawn_blocking(move || crate::tts::fish_modelos::leer_prueba(&archivo)).await
    {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, "audio/mpeg"),
                // Al reves que la portada: una prueba se puede volver a generar y
                // el nombre del fichero depende del texto, asi que no se cachea.
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "esa prueba no esta").into_response(),
        Err(error) => {
            tracing::warn!(%error, "la lectura de una prueba se cancelo");
            (StatusCode::INTERNAL_SERVER_ERROR, "no se pudo leer").into_response()
        }
    }
}

/// Que diseno se sirve para esta peticion. Ver `pagina`.
fn diseno_para(estado: &OverlayState, params: &Parametros) -> &'static disenos::Diseno {
    let vista = vista_para(&params.view);
    let elegido = if params.diseno.is_empty() {
        estado
            .config
            .read()
            .ok()
            .and_then(|guard| guard.as_ref().map(|config| config.disenos.elegido(vista)))
    } else {
        Some(params.diseno.as_str())
    };
    disenos::para_vista(vista, elegido)
}

/// La vista de una peticion, con la de por defecto si viene vacia o inventada.
fn vista_para(view: &str) -> &str {
    if VISTAS.contains(&view) {
        view
    } else {
        VISTA_POR_DEFECTO
    }
}

/// El estilo y el runtime se sirven desde aqui porque el overlay es autonomo: si
/// dependieran de los recursos empaquetados de Tauri, su origen seria otro y no
/// cargarian en el Browser Source.
async fn estilo_compartido() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        COMUN_CSS,
    )
}

async fn runtime_compartido() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        COMUN_JS,
    )
}

async fn animaciones() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        ANIM_JS,
    )
}

async fn salud() -> &'static str {
    "ok"
}

/// Valida el `Origin` de la peticion.
///
/// OBS manda `Origin` **nulo** (o ninguno), asi que rechazarlo romperia el caso
/// de uso principal. Lo que se acepta:
///
///   * sin cabecera u `Origin: null` → es OBS o una pagina local;
///   * host exactamente `127.0.0.1`, `localhost` o `[::1]` → una pestaña del
///     propio equipo, util para probar el overlay en el navegador.
///
/// Cualquier otro origen se rechaza: es la defensa contra una web cualquiera que
/// intente leer el directo desde el navegador del streamer.
///
/// El host se compara **entero**, no por prefijo. Comparar con `starts_with`
/// dejaba pasar `https://localhost.ejemplo.com`, que es precisamente el ataque
/// que esto impide: el navegador manda ese `Origin` y resuelve el nombre contra
/// el equipo del streamer (DNS rebinding). Lo cubre
/// `una_web_externa_no_puede_conectarse`.
fn origen_permitido(cabeceras: &HeaderMap) -> bool {
    let Some(origen) = cabeceras.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origen) = origen.to_str() else {
        return false;
    };
    let origen = origen.trim();
    if origen.is_empty() || origen.eq_ignore_ascii_case("null") {
        return true;
    }

    let minusculas = origen.to_ascii_lowercase();
    let Some((esquema, resto)) = minusculas.split_once("://") else {
        return false;
    };
    if esquema != "http" && esquema != "https" {
        return false;
    }

    // Del resto, el host es lo que hay antes del primer `/`, `?` o `#`, y sin el
    // puerto.
    let autoridad = resto.split(['/', '?', '#']).next().unwrap_or_default();
    let host = if autoridad.starts_with('[') {
        // IPv6 entre corchetes: `[::1]:7878`.
        match autoridad.find(']') {
            Some(cierre) => &autoridad[..=cierre],
            None => return false,
        }
    } else {
        autoridad.split(':').next().unwrap_or_default()
    };

    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// Handshake del WebSocket.
async fn websocket(
    State(estado): State<Arc<OverlayState>>,
    Query(params): Query<Parametros>,
    cabeceras: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !origen_permitido(&cabeceras) {
        tracing::warn!(
            origen = ?cabeceras.get(header::ORIGIN),
            "conexion de overlay rechazada por Origin"
        );
        return (StatusCode::FORBIDDEN, "origen no permitido").into_response();
    }
    if !estado.token_valido(&params.t) {
        tracing::warn!("conexion de overlay rechazada: token invalido");
        return (StatusCode::UNAUTHORIZED, "token invalido").into_response();
    }

    // La fuente de alertas no pide tablas: pide avisos.
    if params.view == VISTA_ALERTAS {
        let cola = estado.cola.clone();
        return ws.on_upgrade(move |socket| atender_alertas(socket, cola));
    }

    let vista = vista_para(&params.view).to_string();
    let receptor = estado.ultimo.clone();
    let sesion = estado.sesion.clone();
    ws.on_upgrade(move |socket| atender(socket, receptor, sesion, vista))
}

/// Bucle de la fuente de alertas.
///
/// Es el unico overlay que **no** es stateless en el sentido del plan: su estado
/// no es una tabla sino una cola de avisos que hay que entregar. Lo que si se
/// respeta es la promesa de que un refresco no pierde nada: al conectar se lleva
/// lo que se quedo esperando.
async fn atender_alertas(mut socket: WebSocket, cola: Arc<crate::alerts::ColaAlertas>) {
    tracing::debug!("overlay de alertas conectado");

    // Se suscribe **antes** de leer lo pendiente: a partir de aqui, un aviso nuevo
    // va directo al receptor y no entra en la lista de espera, asi que no hay forma
    // de mandarlo dos veces.
    let mut receptor = cola.suscribir();
    let pendientes = cola.pendientes();
    if !pendientes.is_empty() {
        let cuantos = pendientes.len();
        let seqs: Vec<u64> = pendientes.iter().map(|aviso| aviso.seq).collect();
        if enviar(&mut socket, &MensajeAlertas::Alertas { avisos: pendientes })
            .await
            .is_err()
        {
            return;
        }
        // Se dan por entregados despues de enviarlos: si el envio falla, siguen
        // esperando a la siguiente conexion en vez de perderse.
        cola.entregar(&seqs);
        tracing::debug!(cuantos, "avisos pendientes entregados al overlay");
    }

    loop {
        tokio::select! {
            nuevo = receptor.recv() => {
                match nuevo {
                    Ok(aviso) => {
                        if enviar(&mut socket, &MensajeAlertas::Alerta { aviso: Box::new(aviso) }).await.is_err() {
                            break;
                        }
                    }
                    // Un suscriptor lento pierde avisos viejos en vez de consumir
                    // memoria: es la politica del bus, y una alerta de hace rato ya
                    // no interesa.
                    Err(broadcast::error::RecvError::Lagged(perdidos)) => {
                        tracing::warn!(perdidos, "el overlay de alertas se salto avisos");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            entrante = socket.recv() => {
                match entrante {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    }

    tracing::debug!("overlay de alertas desconectado");
}

/// Bucle de una conexion: manda la foto de bienvenida y despues los incrementales.
///
/// La foto se compone **aqui**, en cada conexion: une las tablas que tenga el
/// `watch` en ese momento con los datos de sesion. Es lo que hace stateless al
/// overlay (plan-review §180): refrescar el Browser Source en OBS vuelve a pedir
/// la foto y no se pierde nada, aunque el directo lleve horas en marcha.
async fn atender(
    mut socket: WebSocket,
    mut receptor: watch::Receiver<MensajeOverlay>,
    sesion: Arc<RwLock<(String, String, String)>>,
    vista: String,
) {
    tracing::debug!(vista = %vista, "overlay conectado");

    let (provider, status, handle) = sesion.read().map(|guard| guard.clone()).unwrap_or_default();
    let (tap, gifts, follows) = tablas_del_mensaje(&receptor.borrow_and_update().clone());
    let bienvenida = MensajeOverlay::State {
        provider,
        status,
        handle,
        tap,
        gifts,
        follows,
    };
    if enviar(&mut socket, &bienvenida).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            cambiado = receptor.changed() => {
                if cambiado.is_err() {
                    // El emisor desaparecio: el motor se cerro.
                    break;
                }
                let mensaje = receptor.borrow_and_update().clone();
                if enviar(&mut socket, &mensaje).await.is_err() {
                    break;
                }
            }
            // Los mensajes del cliente se leen para detectar el cierre limpio.
            // No se espera ninguno: el overlay no manda ordenes.
            entrante = socket.recv() => {
                match entrante {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    }

    tracing::debug!(vista = %vista, "overlay desconectado");
}

/// Serializa y manda un mensaje.
///
/// Generica porque hay dos protocolos por el mismo WebSocket: el de las tablas y
/// el de los avisos. Lo que comparten es esto: serializar, mandar y decir si
/// fallo.
async fn enviar<T: serde::Serialize>(socket: &mut WebSocket, mensaje: &T) -> Result<(), ()> {
    let texto = match serde_json::to_string(mensaje) {
        Ok(texto) => texto,
        Err(error) => {
            tracing::error!(%error, "no se pudo serializar el mensaje del overlay");
            return Err(());
        }
    };
    socket
        .send(Message::Text(texto.into()))
        .await
        .map_err(|_| ())
}
