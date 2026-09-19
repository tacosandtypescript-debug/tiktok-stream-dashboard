//! Un secreto que no puede acabar en un log ni en la interfaz.
//!
//! El repositorio es publico y la clave de la API de voz es del streamer, asi que
//! hay una regla que no se negocia: el valor se guarda **solo** en la base de
//! datos del usuario (`%LOCALAPPDATA%`) y no vuelve nunca a la interfaz ni al
//! log. Este tipo es lo que hace esa regla comprobable en vez de una promesa:
//!
//!   * `Debug` **nunca** imprime el valor. Un `tracing::debug!(?estado)`, un
//!     `#[derive(Debug)]` en un struct que lo contenga o un `dbg!` olvidado
//!     escriben una marca, jamas la clave.
//!   * no implementa `Serialize`, asi que no puede colarse en un `Snapshot` ni en
//!     el JSON de ajustes por descuido: si alguien lo intenta, no compila.
//!   * `pista()` es lo unico que sale hacia fuera: una version enmascarada
//!     (`••••••••abcd`) para que el streamer reconozca cual tiene puesta. La
//!     interfaz **escribe** una clave nueva, pero no puede leer la que hay: es la
//!     unica forma de que no acabe en una captura de pantalla.

use std::fmt;

/// Cuantos caracteres finales se muestran en la pista.
///
/// Cuatro es lo que usa cualquier panel de claves (Stripe, GitHub): suficiente
/// para reconocer una clave entre varias, insuficiente para reconstruirla.
const CARACTERES_VISIBLES: usize = 4;

/// Texto de un secreto (clave de API, token) con `Debug` redactado.
///
/// No es `Copy` y no expone el valor por accidente: para leerlo hay que pedirlo
/// explicitamente con `exponer()`, que es lo que deja ver en una revision donde
/// se usa.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secreto(String);

impl Secreto {
    pub fn new(valor: impl Into<String>) -> Self {
        Self(valor.into())
    }

    /// El valor, para quien tiene que mandarlo en una cabecera.
    ///
    /// Se llama `exponer` y no `as_str` a proposito: que el nombre del metodo
    /// avise en cada llamada de que por ahi sale la clave.
    pub fn exponer(&self) -> &str {
        &self.0
    }

    /// `true` si no hay nada guardado. Se comprueba sin sacar el valor.
    pub fn esta_vacio(&self) -> bool {
        self.0.trim().is_empty()
    }

    /// Version enmascarada: `••••••••abcd`, o `None` si no hay secreto.
    ///
    /// Se recorta por **caracteres** y no por bytes: una clave con acentos o con
    /// cualquiera de los `•` no puede partir un caracter por la mitad.
    pub fn pista(&self) -> Option<String> {
        let limpio = self.0.trim();
        if limpio.is_empty() {
            return None;
        }
        // Una clave mas corta que la cola visible se enmascara entera: mostrar
        // "abcd" de una clave de cuatro caracteres seria mostrarla.
        let cola: String = if limpio.chars().count() > CARACTERES_VISIBLES {
            let inicio = limpio.chars().count() - CARACTERES_VISIBLES;
            limpio.chars().skip(inicio).collect()
        } else {
            String::new()
        };
        Some(format!("{}{cola}", "\u{2022}".repeat(8)))
    }
}

/// `Debug` sin el valor. Es la razon de existir de este tipo.
impl fmt::Debug for Secreto {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Ni la longitud se dice: el numero de caracteres ya es una pista.
        if self.esta_vacio() {
            formatter.write_str("Secreto(vacio)")
        } else {
            formatter.write_str("Secreto(••••)")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_pista_enmascara_el_valor_y_deja_reconocerlo() {
        let clave = Secreto::new("sk_live_1234567890abcdef");
        let pista = clave.pista().expect("hay clave");
        assert!(pista.ends_with("cdef"), "pista inesperada: {pista}");
        assert!(!pista.contains("1234567890"), "la pista filtra el cuerpo");
        // Ocho puntos y la cola: es el formato que pide la interfaz.
        assert_eq!(pista, "••••••••cdef");

        // Sin clave no hay pista (la interfaz no pinta una mascara vacia).
        assert_eq!(Secreto::default().pista(), None);
        assert_eq!(Secreto::new("   ").pista(), None);

        // Una clave corta se enmascara entera.
        assert_eq!(Secreto::new("abcd").pista().as_deref(), Some("••••••••"));
        assert_eq!(Secreto::new("abc").pista().as_deref(), Some("••••••••"));
    }

    /// La prueba que da sentido al tipo: la clave no puede salir por un `Debug`.
    #[test]
    fn el_debug_no_imprime_la_clave() {
        let clave = Secreto::new("sk_muy_secreta_987654");
        let texto = format!("{clave:?}");
        assert!(!texto.contains("sk_muy_secreta_987654"), "{texto}");
        assert!(!texto.contains("987654"), "{texto}");

        // Tampoco dentro de otro struct, que es como se filtra de verdad.
        #[derive(Debug)]
        #[allow(dead_code)]
        struct Ajustes {
            modelo: String,
            clave: Secreto,
        }
        let ajustes = Ajustes {
            modelo: "s2.1-pro".into(),
            clave,
        };
        let texto = format!("{ajustes:?}");
        assert!(texto.contains("s2.1-pro"), "{texto}");
        assert!(!texto.contains("sk_muy_secreta_987654"), "{texto}");
    }
}
