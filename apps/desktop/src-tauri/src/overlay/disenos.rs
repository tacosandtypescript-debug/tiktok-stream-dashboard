//! Catalogo de disenos del overlay.
//!
//! Un diseno es **un fichero HTML autocontenido**: su estilo y su pintado viven
//! dentro, y lo unico que comparte con los demas es el runtime
//! (`web/comun.js`, `web/anim.js`, `web/comun.css`), que le da los datos y el
//! ritmo. Se anaden disenos sin tocar el servidor: basta con dejar el fichero en
//! `web/disenos/` y una entrada aqui.
//!
//! Aqui solo esta el **indice**: que disenos hay y para que vistas valen. El
//! texto que lee el streamer no vive aqui, sino en el `i18n` del frontend
//! (docs/decisions.md D4): esto publica identificadores y el frontend les pone
//! nombre. Asi anadir ingles no obliga a tocar Rust.
//!
//! Las vistas son las **fuentes de OBS**: una por tabla, para poder colocar cada
//! marcador donde se quiera sobre el video.

/// Las tres vistas del overlay. Cada una es una fuente de OBS propia.
pub const VISTAS: [&str; 3] = ["tap", "gifts", "follows"];

/// Vista en la que cae una peticion con `view` desconocido o vacio.
///
/// Es la misma politica que ya tenia el servidor: mejor enseñar el marcador
/// principal que una pagina en blanco en mitad de un directo.
pub const VISTA_POR_DEFECTO: &str = "tap";

/// Diseno que se sirve cuando el streamer no ha elegido otro.
pub const POR_DEFECTO: &str = "carriles";

/// Las vistas de un minijuego: solo tap tap.
///
/// Los tres juegos se mueven con el **ritmo** de los taps, no con el total, asi
/// que no tienen nada que hacer en regalos ni en seguidores.
const SOLO_TAP: [&str; 1] = ["tap"];

/// Lienzo del diseno, en pixeles.
///
/// Lo necesita la vista previa de la pestana Overlays para escalar el marco: un
/// diseno de tabla vive en 420 px de ancho y uno de pantalla completa en
/// 1080×1920. Sin este dato la previa recortaria o dejaria franjas, que en un
/// marcador de diez filas se nota mucho.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Tamano {
    pub ancho: u32,
    pub alto: u32,
}

/// Que clase de overlay es un diseno.
///
/// La interfaz los enseña en **dos secciones distintas** —marcadores y juegos— porque
/// no se eligen igual: un marcador dice lo que ha pasado y un juego se mueve con el
/// ritmo de los taps. Sin este dato, el frontal tendria que adivinar cual es cual por
/// el identificador, y un diseno nuevo mal adivinado saldria en la seccion equivocada.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TipoDiseno {
    /// Un marcador: la tabla de lo que ha pasado en esa vista.
    Marcador,
    /// Un juego: se mueve con el ritmo de los taps.
    Juego,
}

/// Un diseno del catalogo.
pub struct Diseno {
    /// Identificador estable. Viaja en la URL (`?diseno=`) y se guarda en
    /// `overlay.json`, asi que **no se puede renombrar** sin migrar.
    pub id: &'static str,
    /// Si es un marcador o un juego.
    pub tipo: TipoDiseno,
    /// Vistas en las que este diseno tiene sentido.
    ///
    /// No todos valen para todo: los minijuegos se mueven con el **ritmo** de los
    /// taps, y en regalos o seguidores no hay taps que los muevan.
    pub vistas: &'static [&'static str],
    /// Lienzo que espera el diseno, para la vista previa.
    pub previa: Tamano,
    /// El documento que carga el Browser Source, con los assets compartidos
    /// dentro del binario: OBS no puede leer el disco del proyecto.
    pub html: &'static str,
}

/// Todos los disenos, en el orden en que se enseñan.
///
/// El orden es el de la galeria de maquetas (A..H) y `POR_DEFECTO` no es el
/// primero a proposito: carriles es el diseno que traia el proyecto y el que
/// tienen puesto las instalaciones que ya existen, asi que la lista empieza por
/// el marcador pero el overlay sigue sirviendo carriles hasta que se elija otro.
///
/// Los lienzos estan **medidos**, no estimados: la vista previa los usa para
/// escalar el marco y con un numero a ojo se recortaba la ultima fila.
pub const CATALOGO: &[Diseno] = &[
    Diseno {
        id: "marcador",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 558,
        },
        html: include_str!("web/disenos/marcador.html"),
    },
    Diseno {
        id: "carriles",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 520,
        },
        html: include_str!("web/disenos/carriles.html"),
    },
    Diseno {
        id: "cintas",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 311,
        },
        html: include_str!("web/disenos/cintas.html"),
    },
    Diseno {
        id: "anillos",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 411,
        },
        html: include_str!("web/disenos/anillos.html"),
    },
    Diseno {
        id: "columnas",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 340,
        },
        html: include_str!("web/disenos/columnas.html"),
    },
    Diseno {
        id: "fichas",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 454,
        },
        html: include_str!("web/disenos/fichas.html"),
    },
    Diseno {
        id: "sin-fondo",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 570,
        },
        html: include_str!("web/disenos/sin-fondo.html"),
    },
    Diseno {
        id: "franja",
        tipo: TipoDiseno::Marcador,
        vistas: &VISTAS,
        previa: Tamano {
            ancho: 420,
            alto: 667,
        },
        html: include_str!("web/disenos/franja.html"),
    },
    // --- Minijuegos ---------------------------------------------------------
    //
    // Solo valen para **tap tap**, y por eso declaran una vista y no las tres: se
    // mueven con el ritmo de los taps por segundo, y en regalos o seguidores no
    // hay ninguno que los mueva. Ofrecerlos en esas vistas seria prometer algo que
    // no puede pasar.
    Diseno {
        id: "pelotas",
        tipo: TipoDiseno::Juego,
        vistas: &SOLO_TAP,
        previa: Tamano {
            ancho: 1080,
            alto: 1920,
        },
        html: include_str!("web/disenos/pelotas.html"),
    },
    Diseno {
        id: "duelo",
        tipo: TipoDiseno::Juego,
        vistas: &SOLO_TAP,
        previa: Tamano {
            ancho: 1080,
            alto: 1129,
        },
        html: include_str!("web/disenos/duelo.html"),
    },
    Diseno {
        id: "esgrima",
        tipo: TipoDiseno::Juego,
        vistas: &SOLO_TAP,
        previa: Tamano {
            ancho: 1080,
            alto: 612,
        },
        html: include_str!("web/disenos/esgrima.html"),
    },
];

/// El diseno con ese identificador, si existe.
pub fn buscar(id: &str) -> Option<&'static Diseno> {
    CATALOGO.iter().find(|diseno| diseno.id == id)
}

/// Si el diseno vale para esa vista.
pub fn admite(diseno: &Diseno, vista: &str) -> bool {
    diseno.vistas.contains(&vista)
}

/// El diseno que se sirve para una vista.
///
/// El elegido manda, pero solo si existe **y** vale para esa vista. Si no, cae en
/// el de por defecto: un identificador desconocido —una instalacion vieja, un
/// diseno retirado en una actualizacion— no puede dejar el overlay en blanco en
/// mitad de un directo.
pub fn para_vista(vista: &str, elegido: Option<&str>) -> &'static Diseno {
    elegido
        .and_then(buscar)
        .filter(|diseno| admite(diseno, vista))
        .unwrap_or_else(|| de_fabrica(vista))
}

/// El diseno de fabrica de una vista: `POR_DEFECTO` si vale para ella, y si no el
/// primero del catalogo que sirva.
fn de_fabrica(vista: &str) -> &'static Diseno {
    buscar(POR_DEFECTO)
        .filter(|diseno| admite(diseno, vista))
        .or_else(|| CATALOGO.iter().find(|diseno| admite(diseno, vista)))
        // El catalogo nunca esta vacio (lo comprueba `el_catalogo_es_coherente`)
        // y todo diseno admite alguna vista, asi que no hay caso sin salida. Si
        // lo hubiera, el overlay serviria la primera pagina en vez de caerse.
        .unwrap_or(&CATALOGO[0])
}

/// El catalogo tal y como lo publica el snapshot para la pestana Overlays.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DisenoInfo {
    pub id: &'static str,
    /// Marcador o juego: la interfaz los enseña en secciones distintas.
    pub tipo: TipoDiseno,
    /// Vistas en las que se puede elegir.
    pub vistas: &'static [&'static str],
    /// Lienzo del diseno, para escalar la vista previa.
    pub previa: Tamano,
}

pub fn catalogo() -> Vec<DisenoInfo> {
    CATALOGO
        .iter()
        .map(|diseno| DisenoInfo {
            id: diseno.id,
            tipo: diseno.tipo,
            vistas: diseno.vistas,
            previa: diseno.previa,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// El catalogo tiene que ser coherente consigo mismo: identificadores unicos
    /// (van en la URL y en `overlay.json`), todos los disenos utiles en alguna
    /// vista, y todas las vistas cubiertas por el diseno de fabrica.
    #[test]
    fn el_catalogo_es_coherente() {
        assert!(!CATALOGO.is_empty(), "el catalogo no puede estar vacio");

        let mut ids = std::collections::HashSet::new();
        for diseno in CATALOGO {
            assert!(
                ids.insert(diseno.id),
                "identificador repetido: {}",
                diseno.id
            );
            assert!(
                !diseno.vistas.is_empty(),
                "{} no vale para ninguna vista: seria inalcanzable",
                diseno.id
            );
            for vista in diseno.vistas {
                assert!(
                    VISTAS.contains(vista),
                    "{} declara una vista que no existe: {vista}",
                    diseno.id
                );
            }
            assert!(
                diseno.previa.ancho > 0 && diseno.previa.alto > 0,
                "{} no declara lienzo: la vista previa no sabria escalarlo",
                diseno.id
            );
            assert!(
                diseno.html.contains("<!doctype html"),
                "{} no es un documento completo",
                diseno.id
            );
            assert!(
                diseno.html.contains("comun.js"),
                "{} no carga el runtime compartido: se quedaria sin datos",
                diseno.id
            );
            assert!(
                diseno.html.contains("comun.css"),
                "{} no carga los estilos compartidos",
                diseno.id
            );
            assert!(
                !diseno.html.contains("tauri"),
                "{} no puede depender del IPC de Tauri, que un Browser Source no tiene",
                diseno.id
            );

            // --- Lo que un diseno NO puede hacer -----------------------------
            //
            // Estas comprobaciones existen porque las diez primeras versiones de
            // los disenos fueron maquetas de demostracion, y quedarse con un
            // resto de aquello no rompe nada de forma visible: el diseno se pinta
            // igual y falla solo en el caso raro.

            // El rotulo de la vista **nunca** va escrito en el documento: el mismo
            // fichero sirve para las tres vistas, asi que escribirlo a mano hacia
            // que el marcador de regalos dijera "Tap tap".
            //
            // No se exige que todos tengan `h1#titulo`: un diseno de pantalla
            // completa, que lo pinta todo en un lienzo, no tiene cabecera que
            // poner. Lo que si se exige es que quien lo tenga lo rellene desde el
            // contexto, y eso lo comprueba la verificacion de los disenos, que
            // abre cada uno en las tres vistas y mira el texto.
            for literal in [">Tap tap<", ">Regalos<", ">Seguidores<"] {
                assert!(
                    !diseno.html.contains(literal),
                    "{} lleva el rotulo de la vista escrito a mano ({literal})",
                    diseno.id
                );
            }
            // Y si hay hueco de rotulo, tiene que haber una lectura del contexto:
            // un `h1#titulo` que nadie rellena deja el marcador sin titulo.
            if diseno.html.contains("id=\"titulo\"") {
                assert!(
                    diseno.html.contains(".titulo"),
                    "{} tiene hueco de rotulo pero no lo rellena desde el contexto",
                    diseno.id
                );
            }
            // El andamiaje de las maquetas: se conectaban por su cuenta.
            for resto in ["cliente-vivo", "enVivo", "new WebSocket"] {
                assert!(
                    !diseno.html.contains(resto),
                    "{} conserva el andamiaje de maqueta: {resto}",
                    diseno.id
                );
            }
            // Un solo formateador de cifras, el del runtime: dos formatos en la
            // misma pantalla se notan.
            assert!(
                !diseno.html.contains("toLocaleString"),
                "{} formatea por su cuenta: tiene que usar `ctx.numero`",
                diseno.id
            );
            // Un overlay no se desplaza: lo que no quepa se recorta.
            for desplaza in ["overflow: auto", "overflow: scroll", "overflow-y: auto"] {
                assert!(
                    !diseno.html.contains(desplaza),
                    "{} se desplaza ({desplaza}), y un overlay no puede",
                    diseno.id
                );
            }
            // Nada de red: el overlay tiene que funcionar sin conexion y sin
            // pedirle nada a nadie. Se buscan **cargas**, no la cadena `http`:
            // un SVG lleva `xmlns="http://www.w3.org/2000/svg"`, que es un
            // identificador y no una peticion.
            for carga in [
                "src=\"http",
                "src='http",
                "href=\"http",
                "href='http",
                "url(http",
                "@import",
                "fetch(",
                "XMLHttpRequest",
            ] {
                assert!(
                    !diseno.html.contains(carga),
                    "{} carga algo de la red ({carga}): un diseno va entero en el fichero",
                    diseno.id
                );
            }
        }

        assert!(
            buscar(POR_DEFECTO).is_some(),
            "el de por defecto debe existir"
        );
        for vista in VISTAS {
            assert!(
                admite(de_fabrica(vista), vista),
                "no hay diseno de fabrica para {vista}"
            );
        }
    }

    /// Un identificador desconocido no puede dejar el overlay en blanco: es el
    /// caso de una instalacion que guardo un diseno que ya no existe.
    #[test]
    fn un_diseno_desconocido_cae_en_el_de_fabrica() {
        assert_eq!(para_vista("tap", Some("no_existe")).id, POR_DEFECTO);
        assert_eq!(para_vista("tap", None).id, POR_DEFECTO);
        assert_eq!(para_vista("gifts", Some("")).id, POR_DEFECTO);
    }

    /// Un diseno que existe pero no vale para esa vista tampoco se sirve: en
    /// regalos no hay taps que muevan un minijuego.
    #[test]
    fn un_diseno_que_no_vale_para_la_vista_no_se_sirve() {
        // Los minijuegos se mueven con el ritmo de los taps, asi que solo valen
        // para tap tap. Si algun dia no quedara ninguno de una sola vista, el
        // filtro se quedaria sin ejercitar y esta prueba lo dice en vez de pasar
        // en vacio, que es la forma de que una comprobacion deje de comprobar sin
        // que nadie se entere.
        let limitado = CATALOGO
            .iter()
            .find(|diseno| diseno.vistas.len() < VISTAS.len())
            .expect("tiene que haber al menos un diseno de una sola vista (los juegos)");
        let fuera = VISTAS
            .iter()
            .find(|vista| !admite(limitado, vista))
            .expect("un diseno con menos vistas que el total tiene alguna fuera");
        let servido = para_vista(fuera, Some(limitado.id));
        assert!(
            admite(servido, fuera),
            "se sirvio {} para {fuera}, y no vale",
            servido.id
        );
        assert_ne!(
            servido.id, limitado.id,
            "un minijuego no puede acabar en una vista sin taps"
        );
    }

    /// El catalogo que ve la interfaz lleva las vistas, no el HTML: mandar once
    /// documentos por el snapshot seria copiar el binario en cada invoke.
    #[test]
    fn el_catalogo_publicado_no_lleva_el_html() {
        let info = catalogo();
        assert_eq!(info.len(), CATALOGO.len());
        let json = serde_json::to_string(&info).expect("deberia serializar");
        assert!(json.contains("\"carriles\""), "{json}");
        assert!(
            !json.contains("<!doctype"),
            "el HTML no viaja en el snapshot: {json}"
        );
    }

    /// Un juego es un juego **y** se mueve solo con los taps; un marcador vale para
    /// las tres vistas.
    ///
    /// Es la invariante que sostiene las dos secciones de la interfaz: si un juego se
    /// declarara marcador saldria en la seccion equivocada, y si un juego admitiera
    /// regalos se podria elegir en una vista donde no hay nada que lo mueva.
    #[test]
    fn los_juegos_son_juegos_y_solo_van_con_los_taps() {
        let juegos: Vec<&Diseno> = CATALOGO
            .iter()
            .filter(|diseno| diseno.tipo == TipoDiseno::Juego)
            .collect();
        assert!(
            !juegos.is_empty(),
            "si no queda ningun juego, esta comprobacion deja de comprobar"
        );
        for juego in &juegos {
            assert_eq!(
                juego.vistas, &SOLO_TAP,
                "{} es un juego y tiene que moverse solo con los taps",
                juego.id
            );
        }

        for marcador in CATALOGO
            .iter()
            .filter(|diseno| diseno.tipo == TipoDiseno::Marcador)
        {
            assert_eq!(
                marcador.vistas, &VISTAS,
                "{} es un marcador: tiene que valer para las tres vistas",
                marcador.id
            );
        }

        // Y los tipos viajan a la interfaz, que es quien separa las secciones.
        let info = catalogo();
        let juego = info
            .iter()
            .find(|diseno| diseno.id == juegos[0].id)
            .expect("el juego tiene que estar en el catalogo publicado");
        let json = serde_json::to_string(juego).expect("deberia serializar");
        assert!(
            json.contains("\"tipo\":\"juego\""),
            "el tipo no viaja en el snapshot: {json}"
        );
    }
}
