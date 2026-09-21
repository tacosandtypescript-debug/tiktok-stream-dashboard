//! El catálogo del **contenedor del mensaje**, en palabras del streamer.
//!
//! Los identificadores son los mismos que valida el motor (`alerts/mensaje.rs`) y los que
//! entiende el overlay (`mensaje/`): aquí solo viven los rótulos, los topes y **qué mandos
//! usa cada estilo**.
//!
//! Esa última parte es lo que hace que el editor no enseñe veinticinco mandos a la vez: un
//! estilo declara los suyos —una cápsula no tiene «resplandor» que ajustar— y el panel
//! pinta solo esos. El motor no necesita saberlo: él pinta los valores que le lleguen, y
//! los que no toca un estilo se quedan con lo que traían.
//!
//! Lo que **no** hay aquí es ninguna animación de la alerta entera. Este sistema es solo
//! del mensaje y de sus letras; ver `animaciones.ts` para lo otro.

import type { AjusteAviso, MensajeAviso } from "./api";

/** Los campos del contenedor que se pueden tocar. */
export type CampoMensaje = keyof MensajeAviso;

/**
 * El mensaje de fábrica: **lo que el aviso pintaba antes de que esto existiera**.
 *
 * Está espejado de `MensajeAviso::de_fabrica()` en Rust, campo a campo. Ese es el valor
 * que tiene que quedar cuando se elige «Default», y por eso no se escribe a mano en cada
 * estilo: cada uno parte de aquí y cambia lo suyo.
 */
export const MENSAJE_DE_FABRICA: MensajeAviso = {
  estilo: "default",
  fondo: "#0b0d12",
  fondo_2: "#25f4ee",
  fondo_opacidad: 88,
  borde_color: "#232936",
  borde_grosor: 1,
  radio: 12,
  padding_h: 26,
  padding_v: 14,
  sombra: 0,
  blur: 0,
  glow: 0,
  glow_color: "#25f4ee",
  ancho_vw: 70,
  altura_minima: 0,
  separacion: 14,
  fuente: "sistema",
  tamano: 40,
  peso: 800,
  color: "#e8eaf0",
  alineacion: "centro",
  espaciado: 0,
  interlineado: 115,
  contorno: 0,
  contorno_color: "#000000",
  sombra_texto: 12,
  animacion: "ninguna",
  animacion_idle: "ninguna",
  animacion_texto: "ninguna",
  retardo_ms: 0,
  duracion_ms: 450,
  ciclo_ms: 2200,
  intensidad: 60,
  ritmo: "auto",
};

/**
 * Un mando del panel.
 *
 * `decimas` marca los dos campos que el motor guarda en décimas de píxel —el espaciado
 * entre letras y el contorno—: son los únicos que pueden ser negativos o llevar medio
 * píxel, y por eso se editan con un decimal y se guardan multiplicados por diez.
 */
export interface MandoMensaje {
  campo: CampoMensaje;
  etiqueta: string;
  tipo: "numero" | "color" | "lista";
  unidad?: "px" | "%" | "s";
  min?: number;
  max?: number;
  paso?: number;
  /** El valor va en décimas: se enseña dividido y se guarda multiplicado. */
  decimas?: boolean;
  /** El valor va en milisegundos: se enseña en segundos y se guarda multiplicado. */
  enSegundos?: boolean;
  /** Las opciones, cuando el mando es una lista. */
  opciones?: Array<{ valor: string; nombre: string }>;
}

/** Los mandos del **contenedor**: lo que se ve detrás del texto. */
export const MANDOS_CONTENEDOR: MandoMensaje[] = [
  { campo: "fondo", etiqueta: "Color de fondo", tipo: "color" },
  { campo: "fondo_2", etiqueta: "Segundo color", tipo: "color" },
  { campo: "fondo_opacidad", etiqueta: "Opacidad", tipo: "numero", unidad: "%", min: 0, max: 100, paso: 5 },
  { campo: "borde_color", etiqueta: "Color del borde", tipo: "color" },
  { campo: "borde_grosor", etiqueta: "Grosor del borde", tipo: "numero", unidad: "px", min: 0, max: 12, paso: 1 },
  { campo: "radio", etiqueta: "Redondeo", tipo: "numero", unidad: "px", min: 0, max: 200, paso: 2 },
  { campo: "padding_h", etiqueta: "Relleno a los lados", tipo: "numero", unidad: "px", min: 0, max: 80, paso: 2 },
  { campo: "padding_v", etiqueta: "Relleno arriba y abajo", tipo: "numero", unidad: "px", min: 0, max: 80, paso: 2 },
  { campo: "sombra", etiqueta: "Sombra", tipo: "numero", unidad: "%", min: 0, max: 100, paso: 5 },
  { campo: "blur", etiqueta: "Desenfoque de fondo", tipo: "numero", unidad: "px", min: 0, max: 40, paso: 1 },
  { campo: "glow", etiqueta: "Resplandor", tipo: "numero", unidad: "px", min: 0, max: 60, paso: 2 },
  { campo: "glow_color", etiqueta: "Color del resplandor", tipo: "color" },
  { campo: "ancho_vw", etiqueta: "Ancho máximo", tipo: "numero", unidad: "%", min: 20, max: 100, paso: 5 },
  { campo: "altura_minima", etiqueta: "Alto mínimo", tipo: "numero", unidad: "px", min: 0, max: 400, paso: 4 },
  { campo: "separacion", etiqueta: "Separación con la imagen", tipo: "numero", unidad: "px", min: 0, max: 120, paso: 2 },
];

/** Los mandos del **texto**. Van aparte: el fondo y la letra no son lo mismo. */
export const MANDOS_TEXTO: MandoMensaje[] = [
  { campo: "fuente", etiqueta: "Fuente", tipo: "lista" },
  { campo: "tamano", etiqueta: "Tamaño", tipo: "numero", unidad: "px", min: 10, max: 160, paso: 1 },
  { campo: "peso", etiqueta: "Grosor", tipo: "lista" },
  { campo: "color", etiqueta: "Color del texto", tipo: "color" },
  { campo: "alineacion", etiqueta: "Alineación", tipo: "lista" },
  {
    campo: "espaciado",
    etiqueta: "Espaciado entre letras",
    tipo: "numero",
    unidad: "px",
    min: -10,
    max: 30,
    paso: 1,
    decimas: true,
  },
  { campo: "interlineado", etiqueta: "Alto de línea", tipo: "numero", unidad: "%", min: 80, max: 250, paso: 5 },
  { campo: "contorno", etiqueta: "Contorno", tipo: "numero", unidad: "px", min: 0, max: 12, paso: 1, decimas: true },
  { campo: "contorno_color", etiqueta: "Color del contorno", tipo: "color" },
  { campo: "sombra_texto", etiqueta: "Sombra del texto", tipo: "numero", unidad: "px", min: 0, max: 40, paso: 2 },
];

/** Las fuentes: pilas del sistema, que es lo que hay en OBS sin depender de la red. */
export const FUENTES = [
  { valor: "sistema", nombre: "La del sistema" },
  { valor: "redonda", nombre: "Redonda" },
  { valor: "serif", nombre: "Con serifas" },
  { valor: "mono", nombre: "Monoespaciada" },
  { valor: "impacto", nombre: "Impacto" },
  { valor: "manuscrita", nombre: "Manuscrita" },
  { valor: "condensada", nombre: "Condensada" },
];

export const ALINEACIONES = [
  { valor: "izquierda", nombre: "Izquierda" },
  { valor: "centro", nombre: "Centro" },
  { valor: "derecha", nombre: "Derecha" },
];

export const PESOS = [
  { valor: "300", nombre: "Fina" },
  { valor: "400", nombre: "Normal" },
  { valor: "500", nombre: "Media" },
  { valor: "600", nombre: "Semiespesa" },
  { valor: "700", nombre: "Negrita" },
  { valor: "800", nombre: "Muy gruesa" },
  { valor: "900", nombre: "La más gruesa" },
];

/**
 * Un **estilo** del contenedor.
 *
 * `campos` son los mandos del contenedor que este estilo usa, y `sugerido` lo que se
 * escribe al elegirlo. Los sugeridos se aplican **al elegir el estilo** y no antes, igual
 * que los de un efecto de permanencia: son un punto de partida, y en cuanto el streamer
 * toca un mando mandan los suyos.
 *
 * Los que no están en `sugerido` se quedan como estén, y por eso cada estilo parte de
 * `MENSAJE_DE_FABRICA`: elegir «Default» devuelve exactamente el aspecto de siempre.
 */
export interface EstiloMensaje {
  id: string;
  nombre: string;
  /** Lo que se lee de un vistazo al elegirlo. */
  pista: string;
  campos: CampoMensaje[];
  sugerido: Partial<MensajeAviso>;
}

/** Los campos que cualquier estilo puede tocar: el texto y el sitio que ocupa. */
const SIEMPRE: CampoMensaje[] = ["padding_h", "padding_v", "ancho_vw", "altura_minima", "separacion"];

const CAJA: CampoMensaje[] = ["fondo", "fondo_opacidad", "borde_color", "borde_grosor", "radio", ...SIEMPRE];

export const ESTILOS: EstiloMensaje[] = [
  {
    id: "default",
    nombre: "Default",
    pista: "El de siempre: fondo oscuro, borde fino y esquinas redondeadas.",
    campos: [...CAJA, "sombra", "blur", "glow", "glow_color"],
    sugerido: { ...MENSAJE_DE_FABRICA },
  },
  {
    id: "pill",
    nombre: "Cápsula",
    pista: "Compacta y muy redondeada: el navegador recorta el radio a media altura.",
    campos: [...CAJA, "sombra"],
    sugerido: { ...MENSAJE_DE_FABRICA, radio: 200, padding_h: 34, padding_v: 10, sombra: 18 },
  },
  {
    id: "card",
    nombre: "Tarjeta",
    pista: "Sólida, con relleno de sobra y sombra.",
    campos: [...CAJA, "sombra"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo: "#12141c",
      fondo_opacidad: 96,
      radio: 18,
      padding_h: 34,
      padding_v: 18,
      sombra: 45,
    },
  },
  {
    id: "glass",
    nombre: "Cristal",
    pista: "Translúcida, con el fondo difuminado por detrás.",
    campos: [...CAJA, "blur", "sombra"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 34,
      borde_color: "#ffffff",
      radio: 18,
      blur: 14,
      sombra: 25,
    },
  },
  {
    id: "outline",
    nombre: "Contorno",
    pista: "Sin fondo: solo el borde, para no tapar el vídeo.",
    campos: ["borde_color", "borde_grosor", "radio", "sombra", ...SIEMPRE],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 0,
      borde_color: "#25f4ee",
      borde_grosor: 2,
      radio: 14,
      padding_h: 24,
      padding_v: 12,
      sombra: 0,
    },
  },
  {
    id: "glow",
    nombre: "Resplandor",
    pista: "Con luz de color alrededor.",
    campos: [...CAJA, "glow", "glow_color", "sombra"],
    sugerido: { ...MENSAJE_DE_FABRICA, fondo_opacidad: 72, radio: 16, glow: 26, sombra: 0 },
  },
  {
    id: "neon",
    nombre: "Neón",
    pista: "Borde y letra encendidos con el mismo color.",
    campos: [...CAJA, "glow", "glow_color"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo: "#05060a",
      fondo_opacidad: 58,
      borde_color: "#25f4ee",
      borde_grosor: 2,
      radio: 10,
      glow: 18,
      glow_color: "#25f4ee",
      contorno: 6,
      contorno_color: "#25f4ee",
    },
  },
  {
    id: "gradient",
    nombre: "Degradado",
    pista: "Fondo con dos colores, en diagonal.",
    campos: ["fondo", "fondo_2", "fondo_opacidad", "borde_color", "borde_grosor", "radio", "sombra", ...SIEMPRE],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo: "#25f4ee",
      fondo_2: "#ff2e63",
      fondo_opacidad: 85,
      borde_grosor: 0,
      radio: 20,
      padding_h: 30,
      padding_v: 16,
      sombra: 35,
    },
  },
  {
    id: "minimal",
    nombre: "Mínimo",
    pista: "Casi solo texto, con una línea de acento debajo.",
    campos: ["glow_color", ...SIEMPRE],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 0,
      borde_grosor: 0,
      padding_h: 8,
      padding_v: 6,
      sombra: 0,
      tamano: 34,
    },
  },
  {
    id: "barra",
    nombre: "Barra inferior",
    pista: "Una banda que cruza el lienzo entero.",
    campos: ["fondo", "fondo_opacidad", "borde_color", "borde_grosor", "radio", "padding_h", "padding_v", "sombra", "glow", "glow_color", "separacion"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 82,
      borde_grosor: 0,
      radio: 0,
      padding_h: 40,
      padding_v: 16,
      ancho_vw: 100,
      sombra: 30,
    },
  },
  {
    id: "lateral",
    nombre: "Acento lateral",
    pista: "Con una barra de color pegada a la izquierda.",
    campos: ["fondo", "fondo_opacidad", "borde_color", "borde_grosor", "radio", "sombra", "glow_color", ...SIEMPRE],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 92,
      borde_grosor: 0,
      radio: 10,
      padding_h: 24,
      sombra: 25,
      glow_color: "#25f4ee",
    },
  },
  {
    id: "flotante",
    nombre: "Etiqueta flotante",
    pista: "Despegada de la imagen, con sombra: se lee como una tarjeta aparte.",
    campos: [...CAJA, "sombra"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 94,
      radio: 14,
      sombra: 62,
      separacion: 26,
    },
  },
  {
    id: "cinta",
    nombre: "Cinta",
    pista: "Con las puntas dobladas por detrás, como un banner.",
    campos: [...CAJA, "sombra"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo: "#ff2e63",
      fondo_opacidad: 95,
      borde_color: "#b81742",
      borde_grosor: 0,
      radio: 6,
      padding_h: 26,
      padding_v: 12,
      sombra: 20,
      ancho_vw: 60,
    },
  },
  {
    id: "etiqueta",
    nombre: "Distintivo",
    pista: "Pequeña, como una etiqueta pegada.",
    campos: [...CAJA, "sombra", "glow", "glow_color"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 92,
      radio: 200,
      padding_h: 18,
      padding_v: 8,
      sombra: 22,
      tamano: 26,
      peso: 700,
    },
  },
  {
    id: "sombra",
    nombre: "Sombra suave",
    pista: "Limpia, con una sombra larga y difusa.",
    campos: [...CAJA, "sombra", "blur"],
    sugerido: {
      ...MENSAJE_DE_FABRICA,
      fondo_opacidad: 92,
      radio: 20,
      padding_h: 32,
      padding_v: 18,
      sombra: 85,
      blur: 4,
    },
  },
];

export function estiloMensaje(id: string): EstiloMensaje | undefined {
  return ESTILOS.find((estilo) => estilo.id === id);
}

/** Los campos que son un nombre de catálogo: van a un desplegable y se leen directamente. */
const CAMPOS_NOMBRE: CampoMensaje[] = [
  "estilo",
  "animacion",
  "animacion_idle",
  "animacion_texto",
  "fuente",
  "alineacion",
  "ritmo",
];

/** Los que son un color, en forma `#rrggbb`. */
const CAMPOS_COLOR: CampoMensaje[] = [
  "fondo",
  "fondo_2",
  "borde_color",
  "glow_color",
  "color",
  "contorno_color",
];

/**
 * El mensaje de un ajuste, **completo y con valores usables**.
 *
 * El tipo dice que el motor manda todos los campos, y el cable no siempre cumple: una foto
 * de un motor anterior —que no sabía nada de esto—, unos ajustes guardados por una versión
 * vieja o un perfil a medio escribir llegan sin `mensaje` o con campos de menos. Leer
 * `ajuste.mensaje.estilo` a pelo se lleva la pantalla por delante, y es la misma lección
 * que ya está escrita para la lista de usuarios recordados y para los dispositivos de
 * audio: **la interfaz no se cae por un campo que falta**.
 *
 * Se rellena con lo de fábrica y se comprueban los tres tipos que el panel usa de verdad:
 * los nombres (un desplegable con `undefined` se vuelve loco), los colores (un
 * `<input type="color">` con basura pinta negro sin decir nada) y los números (un `NaN`
 * deja el campo vacío y avisa por consola).
 */
export function mensajeDe(ajuste: AjusteAviso | null | undefined): MensajeAviso {
  const bruto = ajuste?.mensaje;
  if (!bruto || typeof bruto !== "object") return { ...MENSAJE_DE_FABRICA };

  const mensaje: MensajeAviso = { ...MENSAJE_DE_FABRICA, ...bruto };
  const campos = mensaje as unknown as Record<string, unknown>;
  const fabrica = MENSAJE_DE_FABRICA as unknown as Record<string, unknown>;

  for (const campo of CAMPOS_NOMBRE) {
    const valor = campos[campo];
    if (typeof valor !== "string" || valor.trim() === "") campos[campo] = fabrica[campo];
  }
  for (const campo of CAMPOS_COLOR) {
    const valor = campos[campo];
    if (typeof valor !== "string" || !/^#[0-9a-f]{6}$/i.test(valor)) campos[campo] = fabrica[campo];
  }
  for (const campo of Object.keys(MENSAJE_DE_FABRICA) as CampoMensaje[]) {
    if (CAMPOS_NOMBRE.includes(campo) || CAMPOS_COLOR.includes(campo)) continue;
    const valor = campos[campo];
    if (typeof valor !== "number" || !Number.isFinite(valor)) campos[campo] = fabrica[campo];
  }

  return mensaje;
}

/** El nombre del estilo, o el identificador si es uno que ya no existe. */
export function nombreEstilo(id: string): string {
  return estiloMensaje(id)?.nombre ?? id;
}

/** Un mando por su campo, para el panel. */
export function mandoMensaje(campo: CampoMensaje): MandoMensaje | undefined {
  return [...MANDOS_CONTENEDOR, ...MANDOS_TEXTO].find((mando) => mando.campo === campo);
}

/** Un nombre de animación del contenedor. */
export interface AnimacionMensaje {
  id: string;
  nombre: string;
  /** Si usa el mando de intensidad: las que no se mueven no lo necesitan. */
  intensidad?: boolean;
}

export const ANIMACIONES_MENSAJE: AnimacionMensaje[] = [
  { id: "ninguna", nombre: "Sin animación" },
  { id: "fundido", nombre: "Aparecer" },
  { id: "subir", nombre: "Sube desde abajo", intensidad: true },
  { id: "bajar", nombre: "Baja desde arriba", intensidad: true },
  { id: "izquierda", nombre: "Entra desde la izquierda", intensidad: true },
  { id: "derecha", nombre: "Entra desde la derecha", intensidad: true },
  { id: "pop", nombre: "Pop" },
  { id: "escala", nombre: "Escala suave" },
  { id: "rebote", nombre: "Rebote" },
  { id: "abrir_horizontal", nombre: "Se abre a los lados" },
  { id: "abrir_vertical", nombre: "Se despliega hacia abajo" },
  { id: "revelar", nombre: "Se descubre de izquierda a derecha" },
  { id: "revelar_centro", nombre: "Se abre desde el centro" },
  { id: "desenfoque", nombre: "Se enfoca", intensidad: true },
  { id: "destello", nombre: "Destello" },
  { id: "elastico", nombre: "Elástico" },
  { id: "caer", nombre: "Cae en su sitio", intensidad: true },
];

export const PERMANENCIAS_MENSAJE: AnimacionMensaje[] = [
  { id: "ninguna", nombre: "Sin movimiento" },
  { id: "flotar", nombre: "Flota despacio", intensidad: true },
  { id: "pulso", nombre: "Late", intensidad: true },
  { id: "pulso_brillo", nombre: "Late con luz", intensidad: true },
  { id: "borde_brillo", nombre: "Borde encendido", intensidad: true },
  { id: "brillo", nombre: "Una luz lo cruza" },
  { id: "agitar", nombre: "Tiembla suave", intensidad: true },
];

export const ANIMACIONES_TEXTO: AnimacionMensaje[] = [
  { id: "ninguna", nombre: "Sin animación" },
  { id: "fundido", nombre: "Aparecer" },
  { id: "maquina", nombre: "Máquina de escribir" },
  { id: "palabras", nombre: "Palabra a palabra" },
  { id: "letras", nombre: "Letra a letra" },
  { id: "onda", nombre: "Onda" },
  { id: "brillo", nombre: "Brillo" },
  { id: "pop", nombre: "Palabras con rebote" },
];

function porId(catalogo: AnimacionMensaje[], id: string): AnimacionMensaje | undefined {
  return catalogo.find((animacion) => animacion.id === id);
}

export function animacionMensaje(id: string): AnimacionMensaje | undefined {
  return porId(ANIMACIONES_MENSAJE, id);
}

export function permanenciaMensaje(id: string): AnimacionMensaje | undefined {
  return porId(PERMANENCIAS_MENSAJE, id);
}

export function animacionTexto(id: string): AnimacionMensaje | undefined {
  return porId(ANIMACIONES_TEXTO, id);
}

/** Los nombres de animación que existen, para el desplegable del estilo de mensaje. */
export function nombreAnimacionMensaje(id: string): string {
  return (
    porId(ANIMACIONES_MENSAJE, id)?.nombre ??
    porId(PERMANENCIAS_MENSAJE, id)?.nombre ??
    porId(ANIMACIONES_TEXTO, id)?.nombre ??
    id
  );
}

/**
 * Los mandos de las animaciones, que un estilo **no** toca.
 *
 * Están aquí arriba, con lo demás del catálogo, porque son la lista que usan el parche del
 * estilo y el panel; y el día que se añada un tiempo nuevo solo hay que añadirlo en un
 * sitio para que ningún preset lo reinicie.
 */
export const CAMPOS_ANIMACION: CampoMensaje[] = [
  "animacion",
  "animacion_idle",
  "animacion_texto",
  "retardo_ms",
  "duracion_ms",
  "ciclo_ms",
  "intensidad",
  "ritmo",
];

/**
 * Lo que hay que guardar al elegir un estilo: el estilo **y lo suyo**.
 *
 * Tres reglas, y las tres son por el mismo motivo —que elegir un estilo no borre trabajo
 * que no es suyo—:
 *
 *   1. **La caja entera parte de fábrica.** Un estilo es la forma completa del contenedor,
 *      no una mezcla con el anterior: sin esto, el resplandor de «Neón» se quedaba pegado
 *      al pasar a «Contorno», que no lo usa. Se reinician los mandos del contenedor, todos,
 *      y no solo los que el estilo declara —`campos` es lo que se **enseña**, no lo que se
 *      escribe—.
 *   2. **La letra no se toca**, salvo lo que el estilo pida de verdad: «Distintivo» pide
 *      letra pequeña y «Neón» un contorno. Los valores que el estilo no cambia respecto a
 *      fábrica no se escriben, así que el color y la fuente que hayas elegido siguen ahí.
 *   3. **Las animaciones nunca.** Tienen su pestaña y su vida aparte: antes, elegir
 *      «Cristal» después de poner «Máquina de escribir» borraba la animación del texto.
 */
export function parcheDeEstilo(id: string, actual: MensajeAviso): MensajeAviso {
  const estilo = estiloMensaje(id);
  if (!estilo) return actual;

  const suyo: Record<string, string | number> = {};
  for (const mando of MANDOS_CONTENEDOR) {
    suyo[mando.campo] = MENSAJE_DE_FABRICA[mando.campo];
  }
  for (const [campo, valor] of Object.entries(estilo.sugerido)) {
    if (CAMPOS_ANIMACION.includes(campo as CampoMensaje)) continue;
    if (valor === MENSAJE_DE_FABRICA[campo as CampoMensaje]) continue;
    suyo[campo] = valor as string | number;
  }

  return { ...actual, ...suyo, estilo: id } as MensajeAviso;
}

/** Si el mando de la intensidad hace algo con las animaciones elegidas. */
export function usaIntensidad(mensaje: MensajeAviso): boolean {
  return Boolean(
    animacionMensaje(mensaje.animacion)?.intensidad ||
      permanenciaMensaje(mensaje.animacion_idle)?.intensidad ||
      animacionTexto(mensaje.animacion_texto)?.intensidad,
  );
}
