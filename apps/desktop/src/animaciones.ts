//! El catálogo de animaciones de las alertas, en palabras del streamer.
//!
//! Los **identificadores** son los mismos que valida el motor (`ANIMACIONES`, en
//! `alerts/mod.rs`) y los que entiende el overlay (`alertas.js`): aquí solo viven los
//! rótulos.
//!
//! Y son **dos rótulos por animación**, no uno, porque el mismo nombre leído en la
//! entrada y en la salida se entiende al revés. «Arriba» de entrada es bajar desde
//! arriba; de salida es irse hacia arriba. Con una sola lista, la mitad de las veces el
//! desplegable diría lo contrario de lo que hace.

export type SentidoAnimacion = "entrada" | "salida";

const NOMBRES: Record<string, { entrada: string; salida: string }> = {
  ninguna: { entrada: "Sin animación", salida: "Sin animación" },
  fundido: { entrada: "Aparecer", salida: "Desvanecerse" },
  arriba: { entrada: "Desde arriba", salida: "Hacia arriba" },
  abajo: { entrada: "Desde abajo", salida: "Hacia abajo" },
  izquierda: { entrada: "Desde la izquierda", salida: "Hacia la izquierda" },
  derecha: { entrada: "Desde la derecha", salida: "Hacia la derecha" },
  acercar: { entrada: "Crecer al entrar", salida: "Encoger al salir" },
  alejar: { entrada: "Encoger al entrar", salida: "Crecer al salir" },
  rebote: { entrada: "Rebote", salida: "Rebote al salir" },
  giro: { entrada: "Giro", salida: "Giro al salir" },
  desenfoque: { entrada: "Desenfocar al entrar", salida: "Desenfocar al salir" },
};

/**
 * Los identificadores, en el orden en que se ofrecen.
 *
 * El orden es el del motor, y no alfabético: primero lo que no se mueve —nada,
 * fundido— y después lo que sí. Así el desplegable se lee de menos a más.
 */
export const ANIMACIONES: string[] = Object.keys(NOMBRES);

/** Cómo se llama una animación cuando se usa para entrar o para salir. */
export function nombreAnimacion(id: string, sentido: SentidoAnimacion): string {
  return NOMBRES[id]?.[sentido] ?? id;
}

/**
 * Los ritmos.
 *
 * El primero es el de fábrica y deja que lo ponga la animación: un rebote trae su
 * rebote sin que nadie lo elija, que es lo que hace que «Rebote» rebote de verdad.
 */
export const RITMOS: Array<{ id: string; nombre: string }> = [
  { id: "auto", nombre: "Automático" },
  { id: "suave", nombre: "Suave" },
  { id: "rebote", nombre: "Con rebote" },
  { id: "lineal", nombre: "Lineal" },
  { id: "rapido", nombre: "Acelerando" },
  { id: "lento", nombre: "Frenando" },
];

/**
 * Cuánto puede durar una animación, en segundos.
 *
 * Son los mismos topes que `ANIMACION_MINIMA_MS` y `ANIMACION_MAXIMA_MS` del motor,
 * que es quien los hace cumplir de verdad. Aquí solo evitan ofrecer un valor que el
 * motor va a rechazar al guardar.
 */
export const ANIMACION_MINIMA_S = 0.1;
export const ANIMACION_MAXIMA_S = 5;

// ---------------------------------------------------------------------------
// Las animaciones de permanencia
// ---------------------------------------------------------------------------

/** Los campos del aviso que puede tocar un efecto de permanencia. */
export type CampoPermanencia =
  | "idle_distancia"
  | "idle_ms"
  | "idle_intervalo_ms"
  | "idle_brillo"
  | "idle_blur"
  | "idle_color"
  | "idle_modo";

/**
 * Un mando de un efecto.
 *
 * Cada efecto dice **cuáles usa**, y el editor pinta solo esos. El campo que hay detrás
 * es compartido —`idle_distancia` son píxeles al flotar y un tanto por ciento al
 * brillar—, así que el rótulo y la unidad vienen de aquí y no de un nombre fijo: decir
 * «8 px» donde son «8 %» sería mentir en el sitio donde se ajusta.
 */
export interface ParametroPermanencia {
  campo: CampoPermanencia;
  etiqueta: string;
  /** Lo que se enseña detrás del campo. No hay para el color ni para el modo. */
  unidad?: "px" | "s" | "%";
  tipo: "numero" | "color" | "modo";
  min?: number;
  max?: number;
  paso?: number;
  /** Con lo que viene el efecto la primera vez que se elige. */
  sugerido: number | string;
  /** Las opciones, cuando el campo es un modo. */
  opciones?: Array<{ valor: string; nombre: string }>;
}

export interface EfectoPermanencia {
  id: string;
  nombre: string;
  parametros: ParametroPermanencia[];
}

const SEGUNDOS = (etiqueta: string, min: number, max: number, sugerido: number, paso = 0.1) =>
  ({ campo: "idle_ms", etiqueta, unidad: "s", tipo: "numero", min, max, paso, sugerido }) as const;

const CADA = (sugerido: number) =>
  ({
    campo: "idle_intervalo_ms",
    etiqueta: "Cada",
    unidad: "s",
    tipo: "numero",
    min: 0,
    max: 20,
    paso: 0.5,
    sugerido,
  }) as const;

/**
 * Los efectos, con los mandos que usa cada uno y con lo que traen puesto.
 *
 * Los valores sugeridos son los del encargo —flotar 8 px y 2,5 s; agitar 2 px, 0,5 s y
 * uno cada 2 s— y se aplican **al elegir el efecto**: son un punto de partida, no una
 * imposición, y en cuanto el streamer los toca mandan los suyos.
 */
export const PERMANENCIAS: EfectoPermanencia[] = [
  { id: "ninguna", nombre: "Sin movimiento", parametros: [] },
  {
    id: "flotar",
    nombre: "Flotar",
    parametros: [
      {
        campo: "idle_distancia",
        etiqueta: "Distancia",
        unidad: "px",
        tipo: "numero",
        min: 1,
        max: 60,
        paso: 1,
        sugerido: 8,
      },
      SEGUNDOS("Velocidad", 0.5, 8, 2.5),
    ],
  },
  {
    id: "rebotar",
    nombre: "Rebote suave",
    parametros: [
      {
        campo: "idle_distancia",
        etiqueta: "Altura",
        unidad: "px",
        tipo: "numero",
        min: 1,
        max: 40,
        paso: 1,
        sugerido: 5,
      },
      SEGUNDOS("Velocidad", 0.4, 5, 1.5),
    ],
  },
  {
    id: "agitar",
    nombre: "Vibración suave",
    parametros: [
      {
        campo: "idle_distancia",
        etiqueta: "Intensidad",
        unidad: "px",
        tipo: "numero",
        min: 1,
        max: 20,
        paso: 1,
        sugerido: 2,
      },
      SEGUNDOS("Velocidad", 0.2, 3, 0.5),
      CADA(2),
    ],
  },
  {
    id: "brillo",
    nombre: "Luz que cruza",
    parametros: [
      SEGUNDOS("Velocidad", 0.3, 5, 1.5),
      {
        campo: "idle_brillo",
        etiqueta: "Brillo",
        unidad: "%",
        tipo: "numero",
        min: 5,
        max: 100,
        paso: 5,
        sugerido: 40,
      },
      {
        campo: "idle_distancia",
        etiqueta: "Ancho",
        unidad: "%",
        tipo: "numero",
        min: 4,
        max: 90,
        paso: 2,
        sugerido: 24,
      },
      CADA(2),
      {
        campo: "idle_modo",
        etiqueta: "Dirección",
        tipo: "modo",
        sugerido: "izquierda",
        opciones: [
          { valor: "izquierda", nombre: "Hacia la derecha" },
          { valor: "derecha", nombre: "Hacia la izquierda" },
        ],
      },
    ],
  },
  {
    id: "gelatina",
    nombre: "Gelatina",
    parametros: [
      {
        campo: "idle_distancia",
        etiqueta: "Intensidad",
        unidad: "%",
        tipo: "numero",
        min: 1,
        max: 20,
        paso: 1,
        sugerido: 6,
      },
      SEGUNDOS("Velocidad", 0.4, 5, 1.2),
      CADA(2),
    ],
  },
  {
    id: "borde",
    nombre: "Resplandor",
    parametros: [
      { campo: "idle_color", etiqueta: "Color", tipo: "color", sugerido: "#25f4ee" },
      {
        campo: "idle_brillo",
        etiqueta: "Fuerza",
        unidad: "%",
        tipo: "numero",
        min: 5,
        max: 100,
        paso: 5,
        sugerido: 70,
      },
      {
        campo: "idle_blur",
        etiqueta: "Difusión",
        unidad: "px",
        tipo: "numero",
        min: 0,
        max: 60,
        paso: 2,
        sugerido: 12,
      },
      SEGUNDOS("Ciclo", 0.3, 6, 1.6),
      {
        campo: "idle_modo",
        etiqueta: "Modo",
        tipo: "modo",
        sugerido: "pulso",
        opciones: [
          { valor: "pulso", nombre: "Pulso" },
          { valor: "recorrido", nombre: "Recorrido" },
        ],
      },
    ],
  },
];

export function efectoPermanencia(id: string): EfectoPermanencia | undefined {
  return PERMANENCIAS.find((efecto) => efecto.id === id);
}
