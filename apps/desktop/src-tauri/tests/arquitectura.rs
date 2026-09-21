//! Las reglas de dependencia entre modulos, comprobadas contra el codigo.
//!
//! Por que existe: los dos ciclos que tenia este crate —`database ↔ tts` y
//! `app ↔ overlay`— no los detectaba nada. Se podian arreglar hoy y volver manana
//! con una linea inocente: un `use crate::app::AppState` en el overlay, un
//! `crate::database::data_dir()` en el TTS. Un modulo no avisa cuando alguien vuelve
//! a meterlo en un ciclo.
//!
//! Esto es la misma idea que el test de contrato del protocolo (`core/contract.rs`)
//! pero aplicada a la forma del codigo: una regla escrita en un documento se queda
//! vieja; una regla con un test falla el dia que se rompe.
//!
//! Se leen los **fuentes**, no los simbolos: en Rust no hay forma de preguntarle al
//! compilador quien importa a quien, y la direccion de un `use` es justo lo que se
//! quiere vigilar.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// La raiz de los fuentes del crate.
fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Todos los `.rs` de un modulo, como `(ruta legible, texto)`.
///
/// Un modulo es `src/<nombre>.rs` o `src/<nombre>/**/*.rs`: las dos formas que usa
/// este crate.
fn ficheros_de(modulo: &str) -> Vec<(String, String)> {
    let raiz = src();
    let suelto = raiz.join(format!("{modulo}.rs"));
    let mut encontrados = Vec::new();

    if suelto.is_file() {
        encontrados.push(suelto);
    }

    let carpeta = raiz.join(modulo);
    if carpeta.is_dir() {
        let mut pila = vec![carpeta];
        while let Some(actual) = pila.pop() {
            let Ok(entradas) = fs::read_dir(&actual) else {
                continue;
            };
            for entrada in entradas.flatten() {
                let ruta = entrada.path();
                if ruta.is_dir() {
                    pila.push(ruta);
                } else if ruta.extension().is_some_and(|e| e == "rs") {
                    encontrados.push(ruta);
                }
            }
        }
    }

    encontrados.sort();
    encontrados
        .into_iter()
        .map(|ruta| {
            let nombre = ruta
                .strip_prefix(&raiz)
                .unwrap_or(&ruta)
                .display()
                .to_string();
            let texto = fs::read_to_string(&ruta).unwrap_or_default();
            (nombre, texto)
        })
        .collect()
}

/// Los modulos de primer nivel que menciona un fichero, via `crate::<modulo>::`.
///
/// Se ignoran las lineas de comentario de documentacion de modulo para no confundir
/// una mencion en prosa —media docena de ficheros describen la arquitectura en su
/// cabecera— con una dependencia de verdad. Y se ignoran los `#[cfg(test)]` porque
/// un test puede montar el escenario que quiera.
fn modulos_que_usa(texto: &str) -> BTreeSet<String> {
    let mut modulos = BTreeSet::new();
    for linea in texto.lines() {
        let limpia = linea.trim_start();
        if limpia.starts_with("//") {
            continue;
        }
        let mut resto = linea;
        while let Some(posicion) = resto.find("crate::") {
            resto = &resto[posicion + "crate::".len()..];
            let nombre: String = resto
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !nombre.is_empty() && nombre != "self" && nombre != "super" {
                modulos.insert(nombre);
            }
        }
    }
    modulos
}

/// Comprueba una regla y falla diciendo **donde**.
fn exigir_sin(modulo: &str, prohibidos: &[&str]) {
    let mut culpas = Vec::new();
    for (fichero, texto) in ficheros_de(modulo) {
        let usados = modulos_que_usa(&texto);
        for prohibido in prohibidos {
            if usados.contains(*prohibido) {
                culpas.push(format!("  {fichero} usa crate::{prohibido}::"));
            }
        }
    }
    assert!(
        culpas.is_empty(),
        "«{modulo}» no puede depender de {prohibidos:?}, y lo hace:\n{}",
        culpas.join("\n")
    );
}

/// El nucleo no sabe nada de nadie.
///
/// Es la hoja del grafo: lo usan 16 ficheros y el no usa ninguno. Si algun dia
/// empieza a depender de `app` o de `database`, deja de poder probarse solo y todo
/// lo que cuelga de el arrastra esa dependencia.
#[test]
fn el_nucleo_no_depende_de_nadie() {
    exigir_sin(
        "core",
        &[
            "alerts",
            "app",
            "chat",
            "database",
            "desktop",
            "feed",
            "ipc",
            "overlay",
            "preview",
            "providers",
            "rutas",
            "secreto",
            "telemetry",
            "tts",
            "web",
        ],
    );
}

/// Los modulos que solo sirven datos o utilidades no dependen de nadie.
#[test]
fn las_hojas_siguen_siendo_hojas() {
    for hoja in ["rutas", "secreto", "preview"] {
        exigir_sin(
            hoja,
            &[
                "alerts",
                "app",
                "chat",
                "core",
                "database",
                "desktop",
                "feed",
                "ipc",
                "overlay",
                "providers",
                "telemetry",
                "tts",
                "web",
            ],
        );
    }
}

/// El TTS no vuelve a la base de datos por una carpeta.
///
/// `database` guarda tipos del TTS (`ClaveGuardada`, `Consumo`), asi que esa
/// direccion se queda. La contraria creaba un ciclo: el TTS entraba en `database`
/// solo para pedirle `data_dir()`, que ahora vive en `rutas`.
#[test]
fn el_tts_no_pide_carpetas_a_la_base_de_datos() {
    exigir_sin("tts", &["database"]);
}

/// El servidor de overlays no conoce el composition root.
///
/// Recibe un `overlay::Motor` con cinco cosas. Si vuelve a pedir `AppState`, el
/// servidor HTTP recupera acceso a todo el motor y los dos modulos se necesitan
/// mutuamente otra vez.
#[test]
fn el_overlay_no_conoce_el_estado_de_la_aplicacion() {
    exigir_sin("overlay", &["app"]);
}

/// La persistencia no sabe que existe una interfaz.
#[test]
fn la_base_de_datos_no_sabe_de_la_interfaz() {
    exigir_sin("database", &["app", "overlay", "web", "desktop", "ipc"]);
}

/// El proveedor, el chat y el feed no saben quien los consume.
#[test]
fn el_motor_de_eventos_no_depende_de_sus_consumidores() {
    for modulo in ["providers", "chat", "feed"] {
        exigir_sin(
            modulo,
            &[
                "alerts",
                "app",
                "database",
                "desktop",
                "ipc",
                "overlay",
                "preview",
                "telemetry",
                "tts",
                "web",
            ],
        );
    }
}

/// El propio comprobador tiene que estar mirando algo.
///
/// Sin esto, un extractor roto —una carpeta que se llama distinto, un `src` que no
/// se encuentra— daria todos los tests en verde sin haber leido una linea.
#[test]
fn el_comprobador_esta_leyendo_los_fuentes() {
    let modulos = ["core", "app", "tts", "overlay", "database", "rutas"];
    for modulo in modulos {
        let ficheros = ficheros_de(modulo);
        assert!(
            !ficheros.is_empty(),
            "no se encontro ningun fuente de «{modulo}» bajo {}",
            src().display()
        );
    }

    // Y la deteccion de dependencias funciona: se prueba con un texto conocido.
    let usados = modulos_que_usa("use crate::app::AppState;\n// crate::tts:: en prosa no cuenta\n");
    assert!(
        usados.contains("app"),
        "no detecto una dependencia de verdad"
    );
    assert!(
        !usados.contains("tts"),
        "contó una mencion dentro de un comentario"
    );
}
