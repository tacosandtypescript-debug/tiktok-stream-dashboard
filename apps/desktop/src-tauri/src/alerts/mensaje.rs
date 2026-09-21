//! El **contenedor del mensaje** de una alerta: el bloque donde va el texto.
//!
//! Es lo que en la alerta es el «Alguien se suscribió (3 meses)» de abajo. Vive aqui
//! y no suelto en `AjusteAviso` por una razon de tamaño: son casi treinta campos, y
//! mezclados con los del aviso —texto, medio, sonido, animaciones, permanencia— el
//! ajuste de un tipo de alerta se volvia ilegible.
//!
//! **Esto no toca las animaciones de la alerta.** La entrada, la permanencia y la
//! salida mueven la **caja entera** —el medio y su texto dentro—; lo de aqui mueve
//! solo el bloque del mensaje y, por separado, las letras de dentro. Son dos sistemas
//! independientes a proposito: elegir «Abrir en horizontal» para el mensaje no puede
//! cambiar como entra la alerta, y al reves.
//!
//! Tres decisiones que se ven en los nombres:
//!
//!   * **El estilo es un catálogo, no un componente.** Cada preset (`ESTILOS_MENSAJE`)
//!     es una configuración de partida; los campos de abajo la ajustan. Un preset nuevo
//!     es una entrada mas, y no hay siete componentes distintos que mantener.
//!   * **Las medidas de la caja van en px y el ancho en % del lienzo.** Los px de aqui
//!     viven dentro de la caja del aviso, que ya lleva su `zoom`: escalan con el aviso,
//!     que es lo que se espera. El ancho no, porque el lienzo de OBS cambia de tamaño
//!     entre la previa y la fuente de verdad, y un ancho en px mentiria en uno de los
//!     dos.
//!   * **Texto y caja van separados.** El color del fondo y el color de la letra son
//!     dos cosas distintas que se ajustan por separado, y la animación de la caja y la
//!     de las letras tambien.

use serde::{Deserialize, Serialize};

use super::{color_valido, del_catalogo, RITMOS};

/// Los estilos del contenedor.
///
/// El orden es el del desplegable: primero el de siempre, y despues de menos a mas.
pub const ESTILOS_MENSAJE: &[&str] = &[
    "default", "pill", "card", "glass", "outline", "glow", "neon", "gradient", "minimal", "barra",
    "lateral", "flotante", "cinta", "etiqueta", "sombra",
];

/// Como aparece el contenedor del mensaje.
///
/// Son **solo del contenedor**: la alerta tiene las suyas (`ANIMACIONES`) y no se
/// mezclan. `ninguna` es el valor de fabrica, porque un aviso configurado antes de que
/// esto existiera tiene que salir exactamente igual que salia.
pub const ANIMACIONES_MENSAJE: &[&str] = &[
    "ninguna",
    "fundido",
    "subir",
    "bajar",
    "izquierda",
    "derecha",
    "pop",
    "escala",
    "rebote",
    "abrir_horizontal",
    "abrir_vertical",
    "revelar",
    "revelar_centro",
    "desenfoque",
    "destello",
    "elastico",
    "caer",
];

/// Lo que hace el contenedor **mientras el aviso esta en pantalla**.
///
/// Se repiten, como las de la alerta, pero son mas suaves a proposito: la alerta ya se
/// esta moviendo y dos cosas moviendose a la vez con la misma fuerza se ven como un
/// temblor, no como un efecto.
pub const PERMANENCIAS_MENSAJE: &[&str] = &[
    "ninguna",
    "flotar",
    "pulso",
    "pulso_brillo",
    "borde_brillo",
    "brillo",
    "agitar",
];

/// Como aparecen las **letras** dentro del contenedor.
///
/// Va separado de la animacion del contenedor —`animacion`— porque son dos cosas
/// distintas y se pueden combinar: el contenedor se abre en horizontal y las palabras
/// se descubren una a una. Unirlas en un solo catalogo obligaria a un preset por
/// combinacion.
pub const ANIMACIONES_TEXTO: &[&str] = &[
    "ninguna", "fundido", "maquina", "palabras", "letras", "onda", "brillo", "pop",
];

/// Donde se apoya el texto dentro del contenedor.
pub const ALINEACIONES_MENSAJE: &[&str] = &["izquierda", "centro", "derecha"];

/// Las familias que se pueden elegir.
///
/// Son **pilas de fuentes del sistema**, no fuentes descargadas: el overlay corre en
/// OBS, sin red garantizada y sin poder esperar a que baje una tipografia. Cada nombre
/// lleva detras sus reservas, y la ultima es siempre la del proyecto, que es la que
/// sabe pintar los apodos adornados de TikTok.
pub const FUENTES_MENSAJE: &[&str] = &[
    "sistema",
    "redonda",
    "serif",
    "mono",
    "impacto",
    "manuscrita",
    "condensada",
];

/// Los topes de cada mando.
///
/// Son los mismos que repite el editor de la interfaz —que solo evita ofrecer un valor
/// que el motor va a rechazar— y los aplica el saneado, que es quien manda.
pub const BORDE_MAXIMO: u32 = 12;
/// El radio llega hasta 200 px y no hasta el alto de la caja a proposito: una capsula
/// —el estilo `pill`— pide un radio **mayor** que media caja, y es el navegador el que lo
/// recorta a la mitad del alto. Con un tope del tamaño de la caja, una capsula de dos
/// lineas saldria con las esquinas redondeadas y no como una capsula.
pub const RADIO_MAXIMO: u32 = 200;
pub const PADDING_MAXIMO: u32 = 80;
pub const SOMBRA_MAXIMA: u32 = 100;
pub const BLUR_MAXIMO: u32 = 40;
pub const GLOW_MAXIMO: u32 = 60;
pub const ANCHO_MINIMO_VW: u32 = 20;
pub const ANCHO_MAXIMO_VW: u32 = 100;
pub const ALTURA_MINIMA_MAXIMA: u32 = 400;
pub const SEPARACION_MAXIMA: u32 = 120;
pub const TAMANO_MINIMO: u32 = 10;
pub const TAMANO_MAXIMO: u32 = 160;
pub const PESO_MINIMO: u32 = 100;
pub const PESO_MAXIMO: u32 = 900;
/// El espaciado entre letras **puede ser negativo**: apretar una palabra es una forma
/// de titulo tan valida como separarla.
pub const ESPACIADO_MINIMO: i32 = -10;
pub const ESPACIADO_MAXIMO: i32 = 30;
pub const INTERLINEADO_MINIMO: u32 = 80;
pub const INTERLINEADO_MAXIMO: u32 = 250;
pub const CONTORNO_MAXIMO: u32 = 12;
pub const SOMBRA_TEXTO_MAXIMA: u32 = 40;

/// Cuanto puede esperar el mensaje desde que entra la alerta.
///
/// Diez segundos dan de sobra para encadenar «primero la imagen y despues el texto»,
/// que es para lo que existe. Mas que eso ya no es una secuencia, es otro aviso.
pub const MENSAJE_RETARDO_MAXIMO: u32 = 10_000;
pub const MENSAJE_DURACION_MINIMA: u32 = 80;
pub const MENSAJE_DURACION_MAXIMA: u32 = 5_000;
pub const MENSAJE_CICLO_MINIMO: u32 = 400;
pub const MENSAJE_CICLO_MAXIMO: u32 = 20_000;
pub const INTENSIDAD_MINIMA: u32 = 0;
pub const INTENSIDAD_MAXIMA: u32 = 200;

// ---------------------------------------------------------------------------
// Los valores de fabrica
// ---------------------------------------------------------------------------
//
// Reproducen **exactamente** lo que el aviso pintaba antes de que esto existiera: el
// `background: var(--velo)`, el borde de un pixel, el radio de 12, el relleno de 26 por
// 14 y la letra de 40 px con su sombra. No es una casualidad: un aviso configurado ayer
// tiene que salir hoy igual, y eso solo se sostiene si el valor de fabrica es el de
// antes, campo a campo.

fn fondo_de_fabrica() -> String {
    // `--velo`, el mismo negro azulado del proyecto.
    "#0b0d12".to_string()
}

/// El segundo color, para el degradado. Si nadie lo toca, el cian de la marca.
fn fondo_2_de_fabrica() -> String {
    "#25f4ee".to_string()
}

/// La opacidad del fondo. Sale del `rgba(11, 13, 18, 0.88)` de `--velo`.
fn opacidad_de_fabrica() -> u32 {
    88
}

fn borde_color_de_fabrica() -> String {
    "#232936".to_string()
}

fn borde_grosor_de_fabrica() -> u32 {
    1
}

fn radio_de_fabrica() -> u32 {
    12
}

fn padding_h_de_fabrica() -> u32 {
    26
}

fn padding_v_de_fabrica() -> u32 {
    14
}

fn ancho_de_fabrica() -> u32 {
    70
}

fn separacion_de_fabrica() -> u32 {
    // El hueco que el aviso tenia entre el medio y el texto (`gap: 14px`).
    14
}

fn fuente_de_fabrica() -> String {
    "sistema".to_string()
}

fn tamano_de_fabrica() -> u32 {
    40
}

fn peso_de_fabrica() -> u32 {
    800
}

fn color_de_fabrica() -> String {
    "#e8eaf0".to_string()
}

fn alineacion_de_fabrica() -> String {
    "centro".to_string()
}

fn interlineado_de_fabrica() -> u32 {
    115
}

fn contorno_color_de_fabrica() -> String {
    "#000000".to_string()
}

/// El difuminado de la sombra del texto. Sale del `0 3px 12px` de siempre.
fn sombra_texto_de_fabrica() -> u32 {
    12
}

fn animacion_de_fabrica() -> String {
    "ninguna".to_string()
}

fn duracion_de_fabrica() -> u32 {
    450
}

fn ciclo_de_fabrica() -> u32 {
    2_200
}

fn intensidad_de_fabrica() -> u32 {
    60
}

/// Lo que se puede configurar del **contenedor del mensaje**.
///
/// Todos los campos llevan `#[serde(default)]`: los ajustes guardados antes de que esto
/// existiera cargan con los valores de fabrica, que son los de siempre.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MensajeAviso {
    // --- El estilo ---------------------------------------------------------
    /// El preset. Ver `ESTILOS_MENSAJE`.
    #[serde(default = "estilo_de_fabrica")]
    pub estilo: String,
    /// Color del fondo, `#rrggbb`.
    #[serde(default = "fondo_de_fabrica")]
    pub fondo: String,
    /// El segundo color: solo lo usa el degradado.
    #[serde(default = "fondo_2_de_fabrica")]
    pub fondo_2: String,
    /// Cuanto tapa el fondo, en tanto por ciento.
    #[serde(default = "opacidad_de_fabrica")]
    pub fondo_opacidad: u32,
    #[serde(default = "borde_color_de_fabrica")]
    pub borde_color: String,
    #[serde(default = "borde_grosor_de_fabrica")]
    pub borde_grosor: u32,
    #[serde(default = "radio_de_fabrica")]
    pub radio: u32,
    #[serde(default = "padding_h_de_fabrica")]
    pub padding_h: u32,
    #[serde(default = "padding_v_de_fabrica")]
    pub padding_v: u32,
    /// Cuanta sombra proyecta la caja, en tanto por ciento. Cero es ninguna.
    #[serde(default)]
    pub sombra: u32,
    /// Lo que se difumina lo de detras, en pixeles. Es el cristal esmerilado.
    #[serde(default)]
    pub blur: u32,
    /// El resplandor de fuera, en pixeles.
    #[serde(default)]
    pub glow: u32,
    #[serde(default = "fondo_2_de_fabrica")]
    pub glow_color: String,
    /// El ancho maximo, en tanto por ciento del lienzo.
    #[serde(default = "ancho_de_fabrica")]
    pub ancho_vw: u32,
    /// El alto minimo de la caja, en pixeles. Sirve para igualar mensajes de una y dos
    /// lineas sin tocar el relleno.
    #[serde(default)]
    pub altura_minima: u32,
    /// El hueco con el medio de arriba, en pixeles.
    #[serde(default = "separacion_de_fabrica")]
    pub separacion: u32,

    // --- El texto ----------------------------------------------------------
    /// Ver `FUENTES_MENSAJE`.
    #[serde(default = "fuente_de_fabrica")]
    pub fuente: String,
    #[serde(default = "tamano_de_fabrica")]
    pub tamano: u32,
    #[serde(default = "peso_de_fabrica")]
    pub peso: u32,
    #[serde(default = "color_de_fabrica")]
    pub color: String,
    /// Ver `ALINEACIONES_MENSAJE`.
    #[serde(default = "alineacion_de_fabrica")]
    pub alineacion: String,
    /// El espacio entre letras, en decimas de pixel.
    ///
    /// Va en decimas y no en pixeles enteros porque los valores utiles de verdad son
    /// medios pixeles: un titulo se aprieta con `-0.5px` y se abre con `1.5px`, y con
    /// un entero el mando daria saltos de dos en dos.
    #[serde(default)]
    pub espaciado: i32,
    /// El alto de linea, en tanto por ciento. Cien es el de la fuente.
    #[serde(default = "interlineado_de_fabrica")]
    pub interlineado: u32,
    /// El grosor del contorno de la letra, en decimas de pixel. Cero es ninguno.
    #[serde(default)]
    pub contorno: u32,
    #[serde(default = "contorno_color_de_fabrica")]
    pub contorno_color: String,
    /// Lo que se difumina la sombra de la letra, en pixeles. Cero es ninguna.
    #[serde(default = "sombra_texto_de_fabrica")]
    pub sombra_texto: u32,

    // --- Las animaciones ---------------------------------------------------
    /// Como aparece el contenedor. Ver `ANIMACIONES_MENSAJE`.
    #[serde(default = "animacion_de_fabrica")]
    pub animacion: String,
    /// Que hace mientras esta en pantalla. Ver `PERMANENCIAS_MENSAJE`.
    #[serde(default = "animacion_de_fabrica")]
    pub animacion_idle: String,
    /// Como aparecen las letras. Ver `ANIMACIONES_TEXTO`.
    #[serde(default = "animacion_de_fabrica")]
    pub animacion_texto: String,
    /// Cuanto espera el mensaje desde que entra la alerta, en milisegundos.
    ///
    /// Es lo que permite que primero entre la imagen y despues el texto, que es la
    /// unica forma de que eso se vea como una secuencia y no como un bloque.
    #[serde(default)]
    pub retardo_ms: u32,
    #[serde(default = "duracion_de_fabrica")]
    pub duracion_ms: u32,
    /// Lo que dura un ciclo de la animacion de permanencia.
    #[serde(default = "ciclo_de_fabrica")]
    pub ciclo_ms: u32,
    /// Cuanto se mueve, cuanto crece o cuanto brilla, en tanto por ciento.
    #[serde(default = "intensidad_de_fabrica")]
    pub intensidad: u32,
    /// El ritmo de la animacion de entrada. `auto` deja el que traiga la animacion.
    #[serde(default = "ritmo_de_fabrica")]
    pub ritmo: String,
}

fn estilo_de_fabrica() -> String {
    "default".to_string()
}

fn ritmo_de_fabrica() -> String {
    "auto".to_string()
}

impl Default for MensajeAviso {
    fn default() -> Self {
        Self {
            estilo: estilo_de_fabrica(),
            fondo: fondo_de_fabrica(),
            fondo_2: fondo_2_de_fabrica(),
            fondo_opacidad: opacidad_de_fabrica(),
            borde_color: borde_color_de_fabrica(),
            borde_grosor: borde_grosor_de_fabrica(),
            radio: radio_de_fabrica(),
            padding_h: padding_h_de_fabrica(),
            padding_v: padding_v_de_fabrica(),
            sombra: 0,
            blur: 0,
            glow: 0,
            glow_color: fondo_2_de_fabrica(),
            ancho_vw: ancho_de_fabrica(),
            altura_minima: 0,
            separacion: separacion_de_fabrica(),
            fuente: fuente_de_fabrica(),
            tamano: tamano_de_fabrica(),
            peso: peso_de_fabrica(),
            color: color_de_fabrica(),
            alineacion: alineacion_de_fabrica(),
            espaciado: 0,
            interlineado: interlineado_de_fabrica(),
            contorno: 0,
            contorno_color: contorno_color_de_fabrica(),
            sombra_texto: sombra_texto_de_fabrica(),
            animacion: animacion_de_fabrica(),
            animacion_idle: animacion_de_fabrica(),
            animacion_texto: animacion_de_fabrica(),
            retardo_ms: 0,
            duracion_ms: duracion_de_fabrica(),
            ciclo_ms: ciclo_de_fabrica(),
            intensidad: intensidad_de_fabrica(),
            ritmo: ritmo_de_fabrica(),
        }
    }
}

impl MensajeAviso {
    pub fn de_fabrica() -> Self {
        Self::default()
    }

    /// Deja los ajustes en algo que se puede pintar, venga de donde venga.
    ///
    /// El JSON lo puede haber editado a mano el streamer, y los ajustes se guardan y se
    /// vuelven a leer: un nombre que ya no existe, un color con forma de sentencia CSS
    /// o un cero de mas tienen que salir de aqui convertidos en algo valido, no llegar
    /// al overlay.
    pub fn sanear(&mut self) {
        self.estilo = del_catalogo(&self.estilo, ESTILOS_MENSAJE, &estilo_de_fabrica());
        self.animacion = del_catalogo(
            &self.animacion,
            ANIMACIONES_MENSAJE,
            &animacion_de_fabrica(),
        );
        self.animacion_idle = del_catalogo(
            &self.animacion_idle,
            PERMANENCIAS_MENSAJE,
            &animacion_de_fabrica(),
        );
        self.animacion_texto = del_catalogo(
            &self.animacion_texto,
            ANIMACIONES_TEXTO,
            &animacion_de_fabrica(),
        );
        self.alineacion = del_catalogo(
            &self.alineacion,
            ALINEACIONES_MENSAJE,
            &alineacion_de_fabrica(),
        );
        self.fuente = del_catalogo(&self.fuente, FUENTES_MENSAJE, &fuente_de_fabrica());
        self.ritmo = del_catalogo(&self.ritmo, RITMOS, &ritmo_de_fabrica());

        // Los colores: forma `#rrggbb` o el de fabrica. Ver `color_valido`.
        self.fondo = color_valido(&self.fondo).unwrap_or_else(fondo_de_fabrica);
        self.fondo_2 = color_valido(&self.fondo_2).unwrap_or_else(fondo_2_de_fabrica);
        self.borde_color = color_valido(&self.borde_color).unwrap_or_else(borde_color_de_fabrica);
        self.glow_color = color_valido(&self.glow_color).unwrap_or_else(fondo_2_de_fabrica);
        self.color = color_valido(&self.color).unwrap_or_else(color_de_fabrica);
        self.contorno_color =
            color_valido(&self.contorno_color).unwrap_or_else(contorno_color_de_fabrica);

        self.fondo_opacidad = self.fondo_opacidad.min(100);
        self.borde_grosor = self.borde_grosor.min(BORDE_MAXIMO);
        self.radio = self.radio.min(RADIO_MAXIMO);
        self.padding_h = self.padding_h.min(PADDING_MAXIMO);
        self.padding_v = self.padding_v.min(PADDING_MAXIMO);
        self.sombra = self.sombra.min(SOMBRA_MAXIMA);
        self.blur = self.blur.min(BLUR_MAXIMO);
        self.glow = self.glow.min(GLOW_MAXIMO);
        self.ancho_vw = self.ancho_vw.clamp(ANCHO_MINIMO_VW, ANCHO_MAXIMO_VW);
        self.altura_minima = self.altura_minima.min(ALTURA_MINIMA_MAXIMA);
        self.separacion = self.separacion.min(SEPARACION_MAXIMA);

        self.tamano = self.tamano.clamp(TAMANO_MINIMO, TAMANO_MAXIMO);
        // El peso se redondea a la centena: un `437` no lo entiende ninguna fuente y el
        // navegador lo redondearia igual, asi que se hace aqui y se guarda lo que se ve.
        self.peso = self.peso.clamp(PESO_MINIMO, PESO_MAXIMO);
        self.peso = ((self.peso + 50) / 100) * 100;
        self.espaciado = self.espaciado.clamp(ESPACIADO_MINIMO, ESPACIADO_MAXIMO);
        self.interlineado = self
            .interlineado
            .clamp(INTERLINEADO_MINIMO, INTERLINEADO_MAXIMO);
        self.contorno = self.contorno.min(CONTORNO_MAXIMO);
        self.sombra_texto = self.sombra_texto.min(SOMBRA_TEXTO_MAXIMA);

        self.retardo_ms = self.retardo_ms.min(MENSAJE_RETARDO_MAXIMO);
        self.duracion_ms = self
            .duracion_ms
            .clamp(MENSAJE_DURACION_MINIMA, MENSAJE_DURACION_MAXIMA);
        self.ciclo_ms = self
            .ciclo_ms
            .clamp(MENSAJE_CICLO_MINIMO, MENSAJE_CICLO_MAXIMO);
        self.intensidad = self.intensidad.clamp(INTENSIDAD_MINIMA, INTENSIDAD_MAXIMA);
    }

    /// El espaciado entre letras, en pixeles, tal y como lo espera el CSS.
    pub fn espaciado_px(&self) -> f32 {
        self.espaciado as f32 / 10.0
    }

    /// El contorno de la letra, en pixeles.
    pub fn contorno_px(&self) -> f32 {
        self.contorno as f32 / 10.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerts::{AjusteAviso, Aviso, TipoAviso};

    #[test]
    fn de_fabrica_es_lo_que_el_aviso_pintaba_antes() {
        let mensaje = MensajeAviso::de_fabrica();
        // Campo a campo: si alguno cambia, un aviso configurado ayer sale distinto hoy.
        assert_eq!(mensaje.estilo, "default");
        assert_eq!(mensaje.fondo, "#0b0d12");
        assert_eq!(mensaje.fondo_opacidad, 88);
        assert_eq!(mensaje.borde_color, "#232936");
        assert_eq!(mensaje.borde_grosor, 1);
        assert_eq!(mensaje.radio, 12);
        assert_eq!(mensaje.padding_h, 26);
        assert_eq!(mensaje.padding_v, 14);
        assert_eq!(mensaje.sombra, 0);
        assert_eq!(mensaje.blur, 0);
        assert_eq!(mensaje.glow, 0);
        assert_eq!(mensaje.ancho_vw, 70);
        assert_eq!(mensaje.altura_minima, 0);
        assert_eq!(mensaje.separacion, 14);
        assert_eq!(mensaje.tamano, 40);
        assert_eq!(mensaje.peso, 800);
        assert_eq!(mensaje.color, "#e8eaf0");
        assert_eq!(mensaje.alineacion, "centro");
        assert_eq!(mensaje.espaciado, 0);
        assert_eq!(mensaje.interlineado, 115);
        assert_eq!(mensaje.contorno, 0);
        assert_eq!(mensaje.sombra_texto, 12);
        // Y las animaciones de fabrica: **ninguna**. Un aviso que ya estaba configurado
        // no puede empezar a moverse porque esto exista.
        assert_eq!(mensaje.animacion, "ninguna");
        assert_eq!(mensaje.animacion_idle, "ninguna");
        assert_eq!(mensaje.animacion_texto, "ninguna");
        assert_eq!(mensaje.retardo_ms, 0);
        assert_eq!(mensaje.ritmo, "auto");
    }

    #[test]
    fn un_ajuste_guardado_antes_carga_con_el_mensaje_de_fabrica() {
        // El JSON de un aviso de antes de que existiera el contenedor: sin `mensaje`.
        let json = r#"{
            "activo": true,
            "texto": "Gracias {usuario}",
            "duracion_ms": 5000,
            "volumen": 0.8
        }"#;
        let ajuste: AjusteAviso = serde_json::from_str(json).expect("deberia cargar");
        assert_eq!(ajuste.mensaje, MensajeAviso::de_fabrica());
        // Y lo que ya existia se conserva.
        assert_eq!(ajuste.texto, "Gracias {usuario}");
        assert_eq!(ajuste.entrada_ms, 380);
    }

    #[test]
    fn el_saneado_deja_del_catalogo_lo_que_no_esta() {
        let mut mensaje = MensajeAviso {
            estilo: "  NEON ".to_string(),
            animacion: "abrir_horizontal".to_string(),
            animacion_idle: "inventada".to_string(),
            animacion_texto: "maquina".to_string(),
            alineacion: "centro".to_string(),
            fuente: "comic-sans".to_string(),
            ritmo: "rebote".to_string(),
            ..MensajeAviso::de_fabrica()
        };
        mensaje.sanear();

        assert_eq!(
            mensaje.estilo, "neon",
            "se acepta con espacios y en mayusculas"
        );
        assert_eq!(mensaje.animacion, "abrir_horizontal");
        assert_eq!(
            mensaje.animacion_idle, "ninguna",
            "un efecto que no existe cae al de fabrica"
        );
        assert_eq!(mensaje.animacion_texto, "maquina");
        assert_eq!(mensaje.fuente, "sistema");
        assert_eq!(mensaje.ritmo, "rebote");
    }

    #[test]
    fn el_saneado_recorta_los_numeros_y_los_colores() {
        let mut mensaje = MensajeAviso {
            fondo: "rojo; } body { display: none".to_string(),
            fondo_2: "#GGGGGG".to_string(),
            color: "#AABBCC".to_string(),
            borde_grosor: 99,
            radio: 999,
            padding_h: 999,
            padding_v: 999,
            sombra: 500,
            blur: 500,
            glow: 500,
            ancho_vw: 400,
            altura_minima: 9_000,
            separacion: 9_000,
            fondo_opacidad: 400,
            tamano: 5_000,
            peso: 437,
            espaciado: -99,
            interlineado: 1,
            contorno: 99,
            sombra_texto: 99,
            retardo_ms: 90_000,
            duracion_ms: 1,
            ciclo_ms: 90_000,
            intensidad: 9_000,
            ..MensajeAviso::de_fabrica()
        };
        mensaje.sanear();

        // Un color que no es un color se sustituye: no se pinta mal, se sale de su sitio.
        assert_eq!(mensaje.fondo, "#0b0d12");
        assert_eq!(mensaje.fondo_2, "#25f4ee");
        assert_eq!(
            mensaje.color, "#aabbcc",
            "un color valido se guarda en minusculas"
        );
        assert_eq!(mensaje.borde_grosor, BORDE_MAXIMO);
        assert_eq!(mensaje.radio, RADIO_MAXIMO);
        assert_eq!(mensaje.padding_h, PADDING_MAXIMO);
        assert_eq!(mensaje.padding_v, PADDING_MAXIMO);
        assert_eq!(mensaje.sombra, SOMBRA_MAXIMA);
        assert_eq!(mensaje.blur, BLUR_MAXIMO);
        assert_eq!(mensaje.glow, GLOW_MAXIMO);
        assert_eq!(mensaje.ancho_vw, ANCHO_MAXIMO_VW);
        assert_eq!(mensaje.altura_minima, ALTURA_MINIMA_MAXIMA);
        assert_eq!(mensaje.separacion, SEPARACION_MAXIMA);
        assert_eq!(mensaje.fondo_opacidad, 100);
        assert_eq!(mensaje.tamano, TAMANO_MAXIMO);
        assert_eq!(mensaje.peso, 400, "el peso se redondea a la centena");
        assert_eq!(mensaje.espaciado, ESPACIADO_MINIMO);
        assert_eq!(mensaje.interlineado, INTERLINEADO_MINIMO);
        assert_eq!(mensaje.contorno, CONTORNO_MAXIMO);
        assert_eq!(mensaje.sombra_texto, SOMBRA_TEXTO_MAXIMA);
        assert_eq!(mensaje.retardo_ms, MENSAJE_RETARDO_MAXIMO);
        assert_eq!(mensaje.duracion_ms, MENSAJE_DURACION_MINIMA);
        assert_eq!(mensaje.ciclo_ms, MENSAJE_CICLO_MAXIMO);
        assert_eq!(mensaje.intensidad, INTENSIDAD_MAXIMA);
    }

    #[test]
    fn el_ancho_no_baja_de_lo_que_se_puede_leer() {
        let mut mensaje = MensajeAviso {
            ancho_vw: 0,
            ..MensajeAviso::de_fabrica()
        };
        mensaje.sanear();
        assert_eq!(mensaje.ancho_vw, ANCHO_MINIMO_VW);
    }

    #[test]
    fn las_decimas_se_convierten_en_pixeles() {
        let mensaje = MensajeAviso {
            espaciado: -5,
            contorno: 3,
            ..MensajeAviso::de_fabrica()
        };
        assert_eq!(mensaje.espaciado_px(), -0.5);
        assert_eq!(mensaje.contorno_px(), 0.3);
    }

    #[test]
    fn el_aviso_lleva_el_mensaje_de_su_tipo() {
        let mut ajustes = crate::alerts::AjustesAlertas::de_fabrica();
        ajustes.gift.mensaje.estilo = "neon".to_string();
        ajustes.follow.mensaje.tamano = 24;

        let regalo = Aviso::demo(1, TipoAviso::Gift, ajustes.de(TipoAviso::Gift));
        let seguidor = Aviso::demo(2, TipoAviso::Follow, ajustes.de(TipoAviso::Follow));

        assert_eq!(regalo.mensaje.estilo, "neon");
        assert_eq!(
            regalo.mensaje.tamano, 40,
            "que Seguidores cambie el suyo no puede tocar el de Regalos"
        );
        assert_eq!(seguidor.mensaje.tamano, 24);
        assert_eq!(seguidor.mensaje.estilo, "default");
    }

    #[test]
    fn el_saneado_de_los_ajustes_entra_hasta_el_mensaje() {
        let mut ajustes = crate::alerts::AjustesAlertas::de_fabrica();
        ajustes.gift.mensaje.estilo = "no-existe".to_string();
        ajustes.gift.mensaje.color = "no-es-un-color".to_string();
        ajustes.gift.mensaje.tamano = 9_000;
        ajustes.sanear(&[]);

        assert_eq!(ajustes.gift.mensaje.estilo, "default");
        assert_eq!(ajustes.gift.mensaje.color, color_de_fabrica());
        assert_eq!(ajustes.gift.mensaje.tamano, TAMANO_MAXIMO);
    }

    /// Las cadenas de un array del overlay: `const NOMBRE = [ "a", "b", ];`.
    fn array_del_overlay(js: &str, nombre: &str) -> Vec<String> {
        let declaracion = format!("const {nombre} = [");
        let bloque = js
            .split(&declaracion)
            .nth(1)
            .and_then(|resto| resto.split("];").next())
            .unwrap_or_else(|| panic!("el overlay tiene que declarar {declaracion}"));
        bloque
            .split('"')
            .skip(1)
            .step_by(2)
            .map(|trozo| trozo.to_string())
            .collect()
    }

    /// Las claves de un catalogo del overlay, que es un objeto con una entrada por linea.
    ///
    /// Se exige la sangria **exacta** de cuatro espacios, como el test de las animaciones
    /// de la alerta: dentro de los catalogos hay objetos con sus propias claves, y sin
    /// esto se colarian como si fueran estilos.
    fn claves_del_overlay(js: &str, declaracion: &str) -> Vec<String> {
        let bloque = js
            .split(declaracion)
            .nth(1)
            .and_then(|resto| resto.split("\n  };").next())
            .unwrap_or_else(|| panic!("el overlay tiene que declarar {declaracion}"));
        let mut claves = Vec::new();
        for linea in bloque.lines() {
            let sangria = linea.len() - linea.trim_start().len();
            if sangria != 4 {
                continue;
            }
            let Some((clave, _)) = linea.trim().split_once(':') else {
                continue;
            };
            let clave = clave.trim();
            if clave.is_empty() || !clave.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                continue;
            }
            claves.push(clave.to_string());
        }
        claves
    }

    /// El catalogo del mensaje es **el mismo** en el motor y en el overlay.
    ///
    /// El overlay corre en otro proceso y no puede preguntarle al motor: sus estilos y sus
    /// animaciones son copias. Si alguien añade uno arriba y se olvida abajo, el motor lo
    /// acepta, lo guarda y el aviso sale **con el estilo de fabrica, sin un error y sin
    /// que nada falle**: el saneado del overlay tira al de fabrica lo que no conoce. Es la
    /// peor forma de romperse, y por eso esto se comprueba leyendo los ficheros.
    #[test]
    fn el_catalogo_del_mensaje_es_el_mismo_en_el_motor_y_en_el_overlay() {
        let config = include_str!("../overlay/web/mensaje/config.js");

        for (nombre, catalogo) in [
            ("ESTILOS", ESTILOS_MENSAJE),
            ("ANIMACIONES", ANIMACIONES_MENSAJE),
            ("PERMANENCIAS", PERMANENCIAS_MENSAJE),
            ("ANIMACIONES_TEXTO", ANIMACIONES_TEXTO),
        ] {
            let en_el_overlay = array_del_overlay(config, nombre);
            assert_eq!(
                en_el_overlay.len(),
                catalogo.len(),
                "{nombre}: el motor y el overlay tienen que ofrecer lo mismo"
            );
            for id in catalogo {
                assert!(
                    en_el_overlay.iter().any(|suyo| suyo == id),
                    "«{id}» esta en el motor pero no en {nombre} de config.js"
                );
            }
            for suyo in &en_el_overlay {
                assert!(
                    catalogo.contains(&suyo.as_str()),
                    "«{suyo}» esta en {nombre} de config.js y no en el catalogo del motor"
                );
            }
        }

        // Las fuentes y las alineaciones van dentro de mapas, no en un array: se busca el
        // nombre escrito como clave.
        for fuente in FUENTES_MENSAJE {
            assert!(
                config.contains(&format!("    {fuente}:")),
                "la fuente «{fuente}» no esta en config.js"
            );
        }
        for alineacion in ALINEACIONES_MENSAJE {
            assert!(
                config.contains(&format!("    {alineacion}:")),
                "la alineacion «{alineacion}» no esta en config.js"
            );
        }

        // Y las animaciones, en los ficheros que las ejecutan: un nombre que el motor
        // acepte y el overlay no sepa animar sale como si no hubiera animacion.
        let animaciones = include_str!("../overlay/web/mensaje/animaciones.js");
        for (declaracion, catalogo) in [
            ("const ENTRADAS = {", ANIMACIONES_MENSAJE),
            ("const PERMANENCIAS = {", PERMANENCIAS_MENSAJE),
        ] {
            let claves = claves_del_overlay(animaciones, declaracion);
            for id in catalogo {
                assert!(
                    claves.iter().any(|suya| suya == id),
                    "«{id}» esta en el motor pero no en {declaracion} de animaciones.js"
                );
            }
            for suya in &claves {
                assert!(
                    catalogo.contains(&suya.as_str()),
                    "«{suya}» esta en animaciones.js y no en el catalogo del motor"
                );
            }
        }

        let texto = include_str!("../overlay/web/mensaje/texto.js");
        let claves = claves_del_overlay(texto, "const ANIMACIONES = {");
        for id in ANIMACIONES_TEXTO {
            assert!(
                claves.iter().any(|suya| suya == id),
                "«{id}» esta en el motor pero no en texto.js"
            );
        }
        for suya in &claves {
            assert!(
                ANIMACIONES_TEXTO.contains(&suya.as_str()),
                "«{suya}» esta en texto.js y no en el catalogo del motor"
            );
        }

        // Y los presets, que son los que dan la forma: uno que falte aqui caeria al de
        // fabrica **en silencio**, que es justo el fallo que este test persigue.
        let presets = include_str!("../overlay/web/mensaje/presets.js");
        let claves = claves_del_overlay(presets, "const ESTILOS = {");
        for id in ESTILOS_MENSAJE {
            assert!(
                claves.iter().any(|suya| suya == id),
                "«{id}» esta en el motor pero no en presets.js"
            );
        }
    }

    /// Los **nombres de los campos** son los mismos en el motor y en la interfaz.
    ///
    /// Es la guarda que faltaba, y la que costo un rato de diagnostico: el motor ignora los
    /// campos que no conoce —a proposito, para poder leer ajustes de una version anterior—,
    /// asi que un nombre escrito de otra forma en `api.ts` no da error: el campo se queda en
    /// su valor de fabrica, el desplegable vuelve a «Default» y el mando parece no hacer
    /// nada. Se comparan las dos listas leyendo el fichero de la interfaz.
    #[test]
    fn los_campos_del_mensaje_son_los_mismos_en_el_motor_y_en_la_interfaz() {
        let ts = include_str!("../../../src/api.ts");
        let bloque = ts
            .split("export interface MensajeAviso {")
            .nth(1)
            .and_then(|resto| resto.split("\n}").next())
            .expect("api.ts tiene que declarar MensajeAviso");

        let mut en_la_interfaz: Vec<String> = Vec::new();
        for linea in bloque.lines() {
            let limpia = linea.trim();
            // Una linea de campo acaba en `;`; los comentarios y el aire no.
            if !limpia.ends_with(';') || limpia.starts_with("//") || limpia.starts_with('*') {
                continue;
            }
            let Some((campo, _)) = limpia.split_once(':') else {
                continue;
            };
            en_la_interfaz.push(campo.trim().to_string());
        }

        // Los del motor: las claves de lo que serializa, que es lo que viaja por el cable.
        let serializado = serde_json::to_value(MensajeAviso::de_fabrica()).expect("serializa");
        let en_el_motor: Vec<String> = serializado
            .as_object()
            .expect("un objeto")
            .keys()
            .cloned()
            .collect();

        for campo in &en_el_motor {
            assert!(
                en_la_interfaz.iter().any(|suyo| suyo == campo),
                "«{campo}» esta en el motor pero no en MensajeAviso de api.ts: el motor lo \
                 ignoraria y el mando se quedaria en su valor de fabrica"
            );
        }
        for campo in &en_la_interfaz {
            assert!(
                en_el_motor.iter().any(|suyo| suyo == campo),
                "«{campo}» esta en api.ts y no en el motor: se guardaria sin efecto"
            );
        }
        assert_eq!(
            en_la_interfaz.len(),
            en_el_motor.len(),
            "las dos listas tienen que tener los mismos campos"
        );
    }
}
