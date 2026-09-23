//! Tests del servidor de overlays.
//!
//! Lo que se prueba aqui es sobre todo **seguridad y forma del mensaje**, no el
//! transporte: el token y el `Origin` son las dos unicas barreras que impiden que
//! una pagina web cualquiera lea el directo desde el navegador del streamer
//! (docs/plan-review.md §329-§330), asi que se prueban una por una.
//!
//! Ademas se prueba la eleccion de diseno, porque es lo unico que el streamer
//! puede romper desde la interfaz: un identificador mal guardado se lleva por
//! delante el marcador que esta en antena.

use std::sync::{Arc, RwLock};

use axum::http::{header, HeaderMap, HeaderValue};
use tokio::sync::watch;

use super::config::Disenos;
use super::*;
use crate::core::event::{RankingEntry, UserRef};

fn cabeceras(origen: Option<&str>) -> HeaderMap {
    let mut mapa = HeaderMap::new();
    if let Some(origen) = origen {
        mapa.insert(header::ORIGIN, HeaderValue::from_str(origen).unwrap());
    }
    mapa
}

fn parametros(view: &str, diseno: &str) -> Parametros {
    Parametros {
        view: view.to_string(),
        diseno: diseno.to_string(),
        t: String::new(),
        desde: 0,
        generacion: 0,
        origen: String::new(),
    }
}

fn estado_con(config: OverlayConfig) -> Arc<OverlayState> {
    let (_tx, rx) = watch::channel(MensajeOverlay::Rankings {
        tap: Vec::new(),
        gifts: Vec::new(),
        follows: Vec::new(),
    });
    Arc::new(OverlayState {
        config: Arc::new(RwLock::new(Some(Arc::new(config)))),
        ultimo: rx,
        sesion: Arc::new(RwLock::new((
            "simulated".to_string(),
            "connected".to_string(),
            "canal".to_string(),
        ))),
        cola: Arc::new(crate::alerts::ColaAlertas::nueva()),
    })
}

fn config_con_token(token: &str) -> OverlayConfig {
    OverlayConfig {
        token: token.to_string(),
        port: crate::overlay::OVERLAY_PORT,
        disenos: Disenos::default(),
    }
}

fn estado_con_token(token: &str) -> Arc<OverlayState> {
    estado_con(config_con_token(token))
}

/// El token es la defensa principal: sin el, cualquiera que acierte el puerto
/// entra. Se comprueba que aciertos parciales, vacios y de otra longitud fallan.
#[test]
fn el_token_se_exige_y_se_compara_entero() {
    let estado = estado_con_token("0123456789abcdef0123456789abcdef");

    assert!(estado.token_valido("0123456789abcdef0123456789abcdef"));
    assert!(
        !estado.token_valido("0123456789abcdef0123456789abcde"),
        "un token mas corto no vale"
    );
    assert!(
        !estado.token_valido("0123456789abcdef0123456789abcdef0"),
        "uno mas largo tampoco"
    );
    assert!(
        !estado.token_valido("0123456789abcdef0123456789abcdee"),
        "fallar el ultimo caracter no vale"
    );
    assert!(!estado.token_valido(""), "sin token no vale");
    assert!(
        !estado.token_valido("f123456789abcdef0123456789abcdef"),
        "fallar el primer caracter no vale"
    );

    // La comparacion es la misma que usa la conexion, no una copia paralela.
    assert!(comparar_en_tiempo_constante("abc", "abc"));
    assert!(!comparar_en_tiempo_constante("abc", "abd"));
    assert!(!comparar_en_tiempo_constante("abc", "ab"));
}

/// Sin configuracion guardada —el servidor no llego a arrancar— no hay token que
/// valga: no se puede aceptar una conexion "porque no hay con que comparar".
#[test]
fn sin_configuracion_no_se_acepta_ningun_token() {
    let (_tx, rx) = watch::channel(MensajeOverlay::Rankings {
        tap: Vec::new(),
        gifts: Vec::new(),
        follows: Vec::new(),
    });
    let estado = Arc::new(OverlayState {
        config: Arc::new(RwLock::new(None)),
        ultimo: rx,
        sesion: Arc::new(RwLock::new((String::new(), String::new(), String::new()))),
        cola: Arc::new(crate::alerts::ColaAlertas::nueva()),
    });
    assert!(!estado.token_valido(""));
    assert!(!estado.token_valido("loquesea"));
}

/// OBS manda `Origin` nulo (o ninguno): rechazarlo romperia el caso de uso
/// principal, que es justo el que hay que dejar pasar.
#[test]
fn el_origen_de_obs_se_acepta() {
    assert!(
        origen_permitido(&cabeceras(None)),
        "OBS puede no mandar Origin"
    );
    assert!(
        origen_permitido(&cabeceras(Some("null"))),
        "OBS manda Origin nulo"
    );
    assert!(origen_permitido(&cabeceras(Some(""))));
}

/// Probar el overlay en una pestaña del propio equipo tiene que funcionar.
#[test]
fn el_origen_local_se_acepta() {
    for origen in [
        "http://127.0.0.1:7878",
        "https://127.0.0.1",
        "http://localhost:7878",
        "https://localhost",
        "http://[::1]:7878",
    ] {
        assert!(origen_permitido(&cabeceras(Some(origen))), "{origen}");
    }
}

/// La defensa contra DNS rebinding: una web cualquiera abriendo un WebSocket
/// contra el equipo del streamer.
#[test]
fn una_web_externa_no_puede_conectarse() {
    for origen in [
        "https://ejemplo.com",
        "http://malicioso.example:1234",
        "https://tiktok.com",
        // Un truco clasico: el nombre legitimo como subcadena.
        "https://127.0.0.1.ejemplo.com",
        "https://localhost.ejemplo.com",
        "https://notlocalhost",
    ] {
        assert!(!origen_permitido(&cabeceras(Some(origen))), "{origen}");
    }
}

/// La foto de estado lleva las tres tablas y los datos del directo, que es lo
/// que el overlay pinta al conectar.
#[test]
fn el_mensaje_de_estado_lleva_las_tres_tablas() {
    let usuario = UserRef {
        id: "1".to_string(),
        unique_id: "carlos".to_string(),
        nickname: "Carlos".to_string(),
        avatar_url: "https://ejemplo/carlos.jpg".to_string(),
    };
    let mensaje = MensajeOverlay::State {
        provider: "simulated".to_string(),
        status: "connected".to_string(),
        handle: "canal".to_string(),
        tap: vec![RankingEntry {
            user: usuario.clone(),
            value: 40,
            events: 3,
        }],
        gifts: Vec::new(),
        follows: Vec::new(),
    };

    let json = serde_json::to_string(&mensaje).expect("deberia serializar");
    assert!(json.contains("\"kind\":\"state\""), "{json}");
    assert!(json.contains("\"value\":40"), "{json}");
    assert!(
        json.contains("https://ejemplo/carlos.jpg"),
        "el overlay necesita la foto en el mensaje: {json}"
    );

    // El incremental se distingue por `kind`, que es como el cliente sabe si
    // tiene que repintar todo o solo las tablas.
    let incremental = MensajeOverlay::Rankings {
        tap: Vec::new(),
        gifts: Vec::new(),
        follows: Vec::new(),
    };
    let json = serde_json::to_string(&incremental).expect("deberia serializar");
    assert!(json.contains("\"kind\":\"rankings\""), "{json}");
}

/// La pagina que se sirve al Browser Source tiene que ser autonoma: si
/// dependiera de los recursos empaquetados de Tauri, OBS no podria cargarla.
#[test]
fn los_assets_compartidos_son_autonomos() {
    // Una sola copia del runtime: duplicarlo por diseno garantizaria que se
    // desincronizaran al primer cambio.
    assert!(
        COMUN_JS.contains("new WebSocket"),
        "el runtime abre el socket"
    );
    assert!(
        COMUN_JS.contains("parametros.get(\"t\")"),
        "y reutiliza el token que el usuario pego en la URL"
    );
    // El simulador es lo que hace posible la vista previa sin directo.
    assert!(
        COMUN_JS.contains("demo"),
        "el runtime tiene que saber servir el simulador de la previa"
    );
    // El ritmo se calcula en un solo sitio: si cada juego lo midiera por su
    // cuenta, el mismo chat correria a velocidades distintas en cada uno.
    assert!(
        COMUN_JS.contains("function tasasDe"),
        "el ritmo de taps se calcula en el runtime compartido"
    );
    // El bucle de los disenos de juego tiene que pasar por aqui: una excepcion
    // dentro de `requestAnimationFrame` mata el bucle y deja el overlay congelado
    // sin ningun sintoma. Paso, y costo un directo encontrarlo.
    assert!(
        COMUN_JS.contains("animar(fn)") && COMUN_JS.contains("requestAnimationFrame(paso)"),
        "el runtime tiene que dar el bucle de dibujo con red de seguridad"
    );

    assert!(
        COMUN_CSS.contains("prefers-reduced-motion"),
        "el movimiento tiene que respetar la preferencia del sistema"
    );
    // Y nada se desplaza: un overlay que hace scroll ensucia el video.
    assert!(
        COMUN_CSS.contains("overflow: hidden"),
        "lo que no quepa se recorta, no se desplaza"
    );
    // El fondo transparente es lo que permite componerlo sobre el video.
    assert!(COMUN_CSS.contains("background: transparent"));
    // La pila de fuentes tiene que incluir familias de reserva: hay apodos de
    // TikTok con caracteres Unicode adornados que Segoe UI no pinta, y en un
    // directo real se veian como cuadritos.
    assert!(
        COMUN_CSS.contains("Segoe UI Symbol") && COMUN_CSS.contains("Segoe UI Emoji"),
        "hacen falta familias de reserva para los apodos adornados"
    );

    // Los assets no pueden depender del IPC de Tauri.
    for (nombre, asset) in [
        ("comun.js", COMUN_JS),
        ("anim.js", ANIM_JS),
        ("comun.css", COMUN_CSS),
    ] {
        assert!(!asset.contains("tauri"), "{nombre} no puede usar el IPC");
    }
    // Y ninguna animacion permanente: cada Browser Source es un renderer mas.
    assert!(
        ANIM_JS.contains("prefers-reduced-motion"),
        "las animaciones respetan la preferencia del sistema"
    );
}

/// La vista se elige por la URL. Las tres tablas son **fuentes independientes**
/// de OBS, y una vista desconocida cae en tap tap: mejor enseñar el marcador
/// principal que una pagina en blanco en mitad de un directo.
#[test]
fn la_vista_se_elige_por_la_url() {
    assert_eq!(vista_para("tap"), "tap");
    assert_eq!(vista_para("gifts"), "gifts");
    assert_eq!(vista_para("follows"), "follows");
    assert_eq!(vista_para(""), "tap");
    assert_eq!(vista_para("lo_que_sea"), "tap");
}

/// El diseno que se sirve sale de la URL si viene, y si no de lo que el streamer
/// tenga guardado para esa vista.
#[test]
fn el_diseno_sale_de_la_url_y_si_no_de_lo_guardado() {
    let estado = estado_con_token("x");

    // Sin nada guardado, el de fabrica.
    let servido = diseno_para(&estado, &parametros("tap", ""));
    assert_eq!(servido.id, disenos::POR_DEFECTO);

    // Lo pedido en la URL manda sobre lo guardado: es lo que usa la previa.
    let servido = diseno_para(&estado, &parametros("tap", disenos::POR_DEFECTO));
    assert_eq!(servido.id, disenos::POR_DEFECTO);

    // Un identificador inventado no deja la pagina en blanco.
    let servido = diseno_para(&estado, &parametros("tap", "inventado"));
    assert_eq!(servido.id, disenos::POR_DEFECTO);
}

/// Cambiar el diseno se ve en la **siguiente** peticion, sin reiniciar el
/// servidor: la celda de configuracion es la misma que escribe la interfaz, y de
/// eso depende que el streamer no tenga que reiniciar en mitad de un directo.
#[test]
fn cambiar_el_diseno_se_ve_sin_reiniciar_el_servidor() {
    let estado = estado_con_token("x");

    // Se cambia la configuracion por la misma celda que usa la aplicacion.
    {
        let mut guard = estado.config.write().unwrap();
        let mut config = (**guard.as_ref().unwrap()).clone();
        config.disenos.poner("tap", disenos::POR_DEFECTO).unwrap();
        *guard = Some(Arc::new(config));
    }

    let servido = diseno_para(&estado, &parametros("tap", ""));
    assert_eq!(
        servido.id,
        disenos::POR_DEFECTO,
        "se sirve lo que se acaba de guardar, sin reiniciar el servidor"
    );
}

/// La foto de bienvenida de una conexion se compone con lo que haya en ese
/// momento, sea una foto o un incremental.
///
/// Es el fallo que costo encontrar: la primera version mandaba la foto **una sola
/// vez** al arrancar, asi que si el primer evento del directo llegaba antes que
/// el cliente, el `watch` ya contenia un incremental y quien se conectaba
/// despues no recibia nunca la foto completa. El overlay se quedaba en blanco
/// hasta el siguiente cambio, y un refresco de OBS (el caso normal) no se
/// repintaba. Al leer las tablas con `tablas_del_mensaje`, da igual lo que haya
/// en el `watch`: la conexion siempre se lleva las tres tablas.
#[test]
fn la_foto_de_bienvenida_sale_de_lo_que_haya_en_ese_momento() {
    let usuario = UserRef {
        id: "1".to_string(),
        unique_id: "carlos".to_string(),
        nickname: "Carlos".to_string(),
        avatar_url: String::new(),
    };
    let entrada = RankingEntry {
        user: usuario.clone(),
        value: 42,
        events: 3,
    };

    // El `watch` ya lleva un incremental, que es el caso que fallaba.
    let incremental = MensajeOverlay::Rankings {
        tap: vec![entrada.clone()],
        gifts: Vec::new(),
        follows: Vec::new(),
    };
    let (tap, gifts, follows) = tablas_del_mensaje(&incremental);
    assert_eq!(tap.len(), 1, "las tablas salen del incremental");
    assert_eq!(tap[0].value, 42);
    assert!(gifts.is_empty() && follows.is_empty());

    // Y de una foto tambien.
    let foto = MensajeOverlay::State {
        provider: "native".to_string(),
        status: "connected".to_string(),
        handle: "canal".to_string(),
        tap: vec![entrada],
        gifts: Vec::new(),
        follows: Vec::new(),
    };
    let (tap, _, _) = tablas_del_mensaje(&foto);
    assert_eq!(tap.len(), 1);
    assert_eq!(tap[0].user.nickname, "Carlos");

    // Los datos de sesion van aparte, en el estado compartido.
    let estado = estado_con_token("x");
    let (provider, status, handle) = estado.sesion.read().unwrap().clone();
    assert_eq!(provider, "simulated");
    assert_eq!(status, "connected");
    assert_eq!(handle, "canal");
}
