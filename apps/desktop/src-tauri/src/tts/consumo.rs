//! Consumo y coste de la voz, medidos **en local**.
//!
//! Fish Audio cobra por **bytes UTF-8 del texto de entrada**, no por el audio, y
//! a un precio publicado por modelo (15 $ por millon de bytes; el modelo
//! `s2.1-pro-free` cuesta 0,00 $). Eso tiene una consecuencia muy util: la
//! aplicacion puede saber su propio gasto con exactitud, porque sabe exactamente
//! lo que ha mandado. No hay nada que preguntar a la API.
//!
//! Aqui vive **todo** el calculo, y en un solo sitio a proposito:
//!
//!   * `precio_por_millon` es la tarifa del modelo;
//!   * `coste_micro` es la unica conversion de bytes a dinero;
//!   * `micro_a_usd` y `redondear_usd` convierten a dolares presentables;
//!   * `Consumo` acumula bytes, peticiones y dinero.
//!
//! Quien pinta (la pagina de Voz) no calcula nada: recibe los bytes y los dolares
//! ya hechos. Dos copias de la tarifa acaban discrepando el dia que cambie el
//! precio, y entonces la interfaz diria una cosa y el motor otra.
//!
//! **El dinero se acumula al facturar, no al mirar.** Si el gasto se calculara
//! como `total_bytes * precio_del_modelo_actual`, cambiar de modelo a mitad de
//! directo volveria a tasar a precio de pago las frases que costaron cero (o al
//! reves). Cada frase suma su coste con el modelo que estaba en vigor en ese
//! momento, y por eso el acumulado se guarda en **micro-dolares enteros**
//! (`i64`): sumar `f64` miles de veces deriva, sumar enteros no.

use serde::Serialize;

use crate::tts::provider::ClaveStatus;

/// Bytes de texto por los que se cobra una unidad de precio.
pub const BYTES_POR_MILLON: f64 = 1_000_000.0;

/// Micro-dolares por dolar: la unidad entera en la que se acumula el gasto.
///
/// Seis decimales son micro-dolares: una frase corta cuesta del orden de
/// 0,0006 $, asi que con menos precision muchas frases saldrian a cero y con mas
/// solo se acumularia el ruido del `f64`.
const MICRO: f64 = 1_000_000.0;

/// Precio del modelo, en dolares por millon de bytes UTF-8 de entrada.
///
/// Un modelo desconocido se cobra al precio **de pago**: si la API ignora una
/// cabecera `model` que no reconoce y aplica su motor por defecto (`s2.1-pro`, a
/// 15 $/M), enseñar 0,00 $ seria mentir sobre el gasto. Ante la duda, el numero
/// alto: el streamer vera que algo no cuadra antes que una factura sorpresa.
pub fn precio_por_millon(modelo: &str) -> f64 {
    super::fish::MODELOS
        .iter()
        .find(|conocido| conocido.id == modelo.trim())
        .map(|conocido| conocido.precio_por_millon)
        .unwrap_or(15.0)
}

/// Redondeo a micro-dolares.
///
/// `f64::round` redondea **alejando del cero** en el punto medio, que es lo que
/// se espera de un precio y lo que evita que medio micro se quede en cero.
pub fn redondear_usd(dolares: f64) -> f64 {
    if !dolares.is_finite() {
        return 0.0;
    }
    (dolares * MICRO).round() / MICRO
}

/// Coste de `bytes`, en **micro-dolares enteros**, con ese modelo.
///
/// Es la unica conversion de bytes a dinero de todo el programa. Se calcula como
/// `bytes * precio` porque `bytes / 1e6 * precio * 1e6` es exactamente eso: asi
/// se evita la ida y vuelta por el millon y el redondeo es el de un micro.
pub fn coste_micro(bytes: u64, modelo: &str) -> i64 {
    let micro = bytes as f64 * precio_por_millon(modelo);
    if !micro.is_finite() || micro >= i64::MAX as f64 {
        // Un coste absurdamente grande se satura en vez de dar la vuelta al
        // entero: mas vale un numero enorme y visible que un negativo que parezca
        // un saldo a favor.
        return i64::MAX;
    }
    micro.round() as i64
}

/// Micro-dolares a dolares, ya redondeados para poder enseñarlos.
pub fn micro_a_usd(micro: i64) -> f64 {
    redondear_usd(micro as f64 / MICRO)
}

/// Bytes UTF-8 de un texto: **exactamente** lo que se manda y por lo que se cobra.
///
/// `str::len` ya son bytes UTF-8 en Rust, asi que no hay conversion que pueda
/// desviarse. Un texto con una letra acentuada son dos bytes por esa letra, y eso
/// es lo que factura el proveedor.
pub fn bytes_de(texto: &str) -> u64 {
    texto.len() as u64
}

/// Contadores de gasto: lo del directo en curso y lo acumulado de siempre.
///
/// Los dos viven juntos porque se suman a la vez y se persisten en la misma fila;
/// separarlos obligaria a dos escrituras por frase.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Consumo {
    /// Bytes mandados en el directo en curso.
    pub sesion_bytes: u64,
    /// Peticiones cobradas en el directo en curso.
    pub sesion_llamadas: u64,
    /// Micro-dolares del directo en curso.
    pub sesion_micro: i64,
    /// Bytes mandados desde que existe la instalacion.
    pub total_bytes: u64,
    /// Peticiones cobradas desde que existe la instalacion.
    pub total_llamadas: u64,
    /// Micro-dolares desde que existe la instalacion.
    pub total_micro: i64,
}

impl Consumo {
    /// Suma una peticion cobrada, tasada con el modelo que la mando.
    ///
    /// Devuelve `false` si no habia nada que sumar: asi el llamante no persiste
    /// ni cuenta una llamada por un cero.
    pub fn sumar(&mut self, bytes: u64, modelo: &str) -> bool {
        if bytes == 0 {
            return false;
        }
        let micro = coste_micro(bytes, modelo);
        self.sesion_bytes += bytes;
        self.sesion_llamadas += 1;
        self.sesion_micro += micro;
        self.total_bytes += bytes;
        self.total_llamadas += 1;
        self.total_micro += micro;
        true
    }

    /// Reinicia la parte del directo. El acumulado no se toca nunca.
    pub fn reiniciar_sesion(&mut self) -> bool {
        let habia = self.sesion_bytes > 0 || self.sesion_llamadas > 0 || self.sesion_micro != 0;
        self.sesion_bytes = 0;
        self.sesion_llamadas = 0;
        self.sesion_micro = 0;
        habia
    }
}

/// Uso de una clave, en crudo: bytes, peticiones y micro-dolares.
///
/// Es lo que devuelve el proveedor (el unico que sabe a que clave se le sumo cada
/// frase). Los dolares los resuelve `ConsumoStatus::nuevo`, que es donde vive el
/// calculo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsoClave {
    pub id: u64,
    pub nombre: String,
    pub pista: String,
    pub estado: &'static str,
    pub en_uso: bool,
    pub bytes: u64,
    pub llamadas: u64,
    pub micro: i64,
}

/// Lo que el proveedor sabe de su propio gasto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsoProveedor {
    /// Modelo en vigor; con el se tasa lo que venga a partir de ahora.
    pub modelo: String,
    pub total: Consumo,
    pub claves: Vec<UsoClave>,
}

impl UsoProveedor {
    /// Cuantas claves siguen sirviendo.
    pub fn vivas(&self) -> usize {
        self.claves
            .iter()
            .filter(|clave| clave.estado == "viva")
            .count()
    }

    /// Nombre de la clave en uso, si hay alguna.
    pub fn en_uso(&self) -> Option<String> {
        self.claves
            .iter()
            .find(|clave| clave.en_uso)
            .map(|clave| clave.nombre.clone())
    }
}

/// Una clave ya resuelta a dinero, tal como la pinta la interfaz.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClaveVoz {
    pub id: u64,
    pub nombre: String,
    /// Pista enmascarada. Nunca la clave.
    pub pista: String,
    pub estado: &'static str,
    pub en_uso: bool,
    pub bytes: u64,
    pub llamadas: u64,
    pub usd: f64,
}

/// El consumo ya resuelto a dinero, tal como lo pinta la interfaz.
///
/// Se construye en un solo sitio (`ConsumoStatus::nuevo`) para que la interfaz no
/// vuelva a multiplicar nada.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConsumoStatus {
    /// Modelo con el que se tasa **lo que venga a partir de ahora**.
    pub modelo: String,
    pub precio_por_millon: f64,
    pub sesion_bytes: u64,
    pub sesion_llamadas: u64,
    pub sesion_usd: f64,
    pub total_bytes: u64,
    pub total_llamadas: u64,
    pub total_usd: f64,
    /// Desglose por clave, en el orden de la lista.
    pub claves: Vec<ClaveVoz>,
    /// Cuantas claves quedan vivas.
    pub claves_vivas: usize,
}

impl ConsumoStatus {
    pub fn nuevo(uso: UsoProveedor) -> Self {
        let claves_vivas = uso.vivas();
        Self {
            precio_por_millon: precio_por_millon(&uso.modelo),
            sesion_usd: micro_a_usd(uso.total.sesion_micro),
            total_usd: micro_a_usd(uso.total.total_micro),
            sesion_bytes: uso.total.sesion_bytes,
            sesion_llamadas: uso.total.sesion_llamadas,
            total_bytes: uso.total.total_bytes,
            total_llamadas: uso.total.total_llamadas,
            claves: uso
                .claves
                .into_iter()
                .map(|clave| ClaveVoz {
                    id: clave.id,
                    nombre: clave.nombre,
                    pista: clave.pista,
                    estado: clave.estado,
                    en_uso: clave.en_uso,
                    bytes: clave.bytes,
                    llamadas: clave.llamadas,
                    usd: micro_a_usd(clave.micro),
                })
                .collect(),
            claves_vivas,
            modelo: uso.modelo,
        }
    }

    /// El consumo de un proveedor que no cobra por bytes (o cuando aun no se ha
    /// usado ninguna clave): todo a cero, con las claves que haya.
    pub fn vacio(modelo: &str, claves: Vec<ClaveStatus>) -> Self {
        Self {
            modelo: modelo.to_string(),
            precio_por_millon: precio_por_millon(modelo),
            sesion_bytes: 0,
            sesion_llamadas: 0,
            sesion_usd: 0.0,
            total_bytes: 0,
            total_llamadas: 0,
            total_usd: 0.0,
            claves_vivas: claves
                .iter()
                .filter(|clave| clave.estado == crate::tts::provider::EstadoClave::Viva)
                .count(),
            claves: claves
                .into_iter()
                .map(|clave| ClaveVoz {
                    id: clave.id,
                    nombre: clave.nombre,
                    pista: clave.pista,
                    estado: clave.estado.as_str(),
                    en_uso: clave.en_uso,
                    bytes: clave.bytes,
                    llamadas: clave.llamadas,
                    usd: micro_a_usd(clave.micro),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::fish::MODELO_POR_DEFECTO;

    #[test]
    fn cuenta_bytes_utf8_y_no_caracteres() {
        assert_eq!(bytes_de("hola"), 4);
        assert_eq!(bytes_de(""), 0);
        // Una vocal acentuada ocupa dos bytes y se cobra por dos.
        assert_eq!(bytes_de("a\u{e9}b"), 4);
        assert_eq!(bytes_de("a\u{f1}o"), 4, "la enie ocupa dos bytes");
    }

    #[test]
    fn el_modelo_gratuito_cuesta_cero() {
        assert_eq!(precio_por_millon(MODELO_POR_DEFECTO), 0.0);
        assert_eq!(coste_micro(0, MODELO_POR_DEFECTO), 0);
        // Ni un millon de bytes, ni cien millones: el gratuito es cero exacto.
        assert_eq!(coste_micro(1_000_000, MODELO_POR_DEFECTO), 0);
        assert_eq!(coste_micro(123_456_789, MODELO_POR_DEFECTO), 0);
        assert_eq!(micro_a_usd(0), 0.0);
    }

    #[test]
    fn el_precio_de_los_modelos_de_pago_es_el_publicado() {
        for modelo in ["s2.1-pro", "s2-pro", "s1"] {
            assert_eq!(precio_por_millon(modelo), 15.0, "{modelo}");
        }
        // Un millon de bytes son exactamente 15 $ = 15 000 000 micro.
        assert_eq!(coste_micro(1_000_000, "s2.1-pro"), 15_000_000);
        assert_eq!(micro_a_usd(15_000_000), 15.0);
        // Y la mitad, 7,50 $.
        assert_eq!(micro_a_usd(coste_micro(500_000, "s2.1-pro")), 7.5);
        // Una frase de 40 bytes: 40 * 15 = 600 micro = 0,0006 $.
        assert_eq!(coste_micro(40, "s2.1-pro"), 600);
        assert_eq!(micro_a_usd(coste_micro(40, "s2.1-pro")), 0.0006);
    }

    /// Un modelo que la API no reconoce se cobra al precio de pago: mas vale
    /// enseñar el numero alto que prometer un cero que no es cierto.
    #[test]
    fn un_modelo_desconocido_se_cobra_al_precio_de_pago() {
        assert_eq!(precio_por_millon("modelo-inventado"), 15.0);
        assert_eq!(precio_por_millon(""), 15.0);
        assert_eq!(coste_micro(1_000_000, "modelo-inventado"), 15_000_000);
        // Y los espacios de sobra no cambian el modelo.
        assert_eq!(precio_por_millon("  s2.1-pro  "), 15.0);
        assert_eq!(precio_por_millon("  s2.1-pro-free  "), 0.0);
    }

    #[test]
    fn el_coste_se_redondea_a_micro_dolares() {
        // La cuenta cruda en `f64` no da el decimal exacto (40 bytes a 15 $/M
        // salen 0,00060000000000000004): por eso hay que redondear antes de
        // enseñarlo.
        let sucio = 40.0 / BYTES_POR_MILLON * 15.0;
        assert_ne!(sucio, 0.0006, "el f64 no da el decimal exacto");
        assert_eq!(redondear_usd(sucio), 0.0006);
        assert_eq!(redondear_usd(1.2345674999), 1.234567);
        // El punto medio sube (aleja del cero): un coste no se queda a cero por
        // culpa del redondeo.
        assert_eq!(redondear_usd(0.0000005), 0.000001);
        assert_eq!(redondear_usd(-0.0000005), -0.000001);
        // Y nada raro puede colarse como precio.
        assert_eq!(redondear_usd(f64::NAN), 0.0);
        assert_eq!(redondear_usd(f64::INFINITY), 0.0);
        assert_eq!(
            coste_micro(u64::MAX, "s2.1-pro"),
            i64::MAX,
            "un numero absurdo se satura, no da la vuelta"
        );
    }

    #[test]
    fn el_consumo_suma_por_directo_y_en_total() {
        let mut consumo = Consumo::default();
        assert!(!consumo.sumar(0, "s2.1-pro"), "un cero no es una llamada");
        assert!(consumo.sumar(100, "s2.1-pro"));
        assert!(consumo.sumar(50, "s2.1-pro"));
        assert_eq!(
            consumo,
            Consumo {
                sesion_bytes: 150,
                sesion_llamadas: 2,
                sesion_micro: 2_250,
                total_bytes: 150,
                total_llamadas: 2,
                total_micro: 2_250,
            }
        );

        // El cambio de directo limpia la sesion y **no** el acumulado.
        assert!(consumo.reiniciar_sesion());
        assert_eq!(consumo.sesion_bytes, 0);
        assert_eq!(consumo.sesion_micro, 0);
        assert_eq!(consumo.total_bytes, 150);
        assert_eq!(consumo.total_micro, 2_250);
        assert!(
            !consumo.reiniciar_sesion(),
            "una sesion ya a cero no cambia"
        );

        assert!(consumo.sumar(10, "s2.1-pro"));
        assert_eq!(consumo.sesion_bytes, 10);
        assert_eq!(consumo.total_bytes, 160);
    }

    /// Lo que hace correcto acumular dinero al facturar: cambiar de modelo no
    /// vuelve a tasar las frases que ya se mandaron.
    #[test]
    fn cambiar_de_modelo_no_re_tasa_lo_ya_mandado() {
        let mut consumo = Consumo::default();
        // 1000 bytes con el gratuito: 0 $.
        consumo.sumar(1_000, MODELO_POR_DEFECTO);
        // 1000 bytes con el de pago: 15000 micro = 0,015 $.
        consumo.sumar(1_000, "s2.1-pro");
        assert_eq!(consumo.total_bytes, 2_000);
        assert_eq!(consumo.total_micro, 15_000);
        // Si se recalculara todo a precio de pago, serian 30 000 micro.
        assert_ne!(consumo.total_micro, coste_micro(2_000, "s2.1-pro"));
        assert_eq!(micro_a_usd(consumo.total_micro), 0.015);
    }

    #[test]
    fn el_estado_del_consumo_trae_el_total_y_el_desglose_por_clave() {
        let uso = UsoProveedor {
            modelo: "s2.1-pro".into(),
            total: Consumo {
                sesion_bytes: 200_000,
                sesion_llamadas: 4,
                sesion_micro: 3_000_000,
                total_bytes: 1_000_000,
                total_llamadas: 20,
                total_micro: 15_000_000,
            },
            claves: vec![
                UsoClave {
                    id: 0,
                    nombre: "la de marzo".into(),
                    pista: "••••••••1111".into(),
                    estado: "viva",
                    en_uso: true,
                    bytes: 600_000,
                    llamadas: 12,
                    micro: 9_000_000,
                },
                UsoClave {
                    id: 1,
                    nombre: "la del canal nuevo".into(),
                    pista: "••••••••2222".into(),
                    estado: "agotada",
                    en_uso: false,
                    bytes: 400_000,
                    llamadas: 8,
                    micro: 6_000_000,
                },
            ],
        };
        let status = ConsumoStatus::nuevo(uso);
        assert_eq!(status.modelo, "s2.1-pro");
        assert_eq!(status.precio_por_millon, 15.0);
        assert_eq!(status.sesion_usd, 3.0);
        assert_eq!(status.total_usd, 15.0);
        assert_eq!(status.claves_vivas, 1);
        assert_eq!(status.claves.len(), 2);
        assert_eq!(status.claves[0].nombre, "la de marzo");
        assert_eq!(status.claves[0].usd, 9.0);
        assert!(status.claves[0].en_uso);
        assert_eq!(status.claves[1].estado, "agotada");
        assert_eq!(status.claves[1].usd, 6.0);
        // La suma del desglose es el total: no hay dos contabilidades.
        let suma: i64 = 9_000_000 + 6_000_000;
        assert_eq!(micro_a_usd(suma), status.total_usd);
    }

    #[test]
    fn el_proveedor_sin_consumo_enseña_ceros_y_las_claves_que_haya() {
        let status = ConsumoStatus::vacio(
            MODELO_POR_DEFECTO,
            vec![ClaveStatus {
                id: 0,
                nombre: "gratis".into(),
                pista: "••••••••0000".into(),
                estado: crate::tts::provider::EstadoClave::Viva,
                en_uso: true,
                bytes: 0,
                llamadas: 0,
                micro: 0,
            }],
        );
        assert_eq!(status.precio_por_millon, 0.0);
        assert_eq!(status.sesion_usd, 0.0);
        assert_eq!(status.total_usd, 0.0);
        assert_eq!(status.claves.len(), 1);
        assert_eq!(status.claves_vivas, 1);
    }
}
