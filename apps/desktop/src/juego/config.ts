// Configuración del juego de trompos, compartida por el panel y el overlay.
//!
//! El panel escribe aquí y el overlay lee: al ser el mismo origen (Vite en
//! desarrollo, el servidor del motor en modo web) basta `localStorage`, y el evento
//! `storage` avisa al overlay en cuanto hay un cambio, sin recargar. En la fase de
//! empaquetado esto se muda a la configuración del motor; el formato ya es el mismo,
//! así que no habrá que rehacer la tabla ni las reglas.

/** Un poder que un regalo puede activar (los diez del motor). */
export const PODERES = [
  "ataque",
  "defensa",
  "balance",
  "velocidad",
  "electrico",
  "volcanico",
  "cristal",
  "sombra",
  "viento",
  "cosmico",
] as const;

/** Tipos de recompensa, los mismos que entiende el motor de regalos. */
export const RECOMPENSAS = [
  { clave: "vida", nombre: "Vida" },
  { clave: "poder", nombre: "Poder" },
  { clave: "vida_poder", nombre: "Vida y poder" },
] as const;

/** Objetivos del poder, los mismos que entiende el motor. */
export const OBJETIVOS = [
  { clave: "cercano", nombre: "Rival más cercano" },
  { clave: "mas_vida", nombre: "Rival con más vida" },
  { clave: "lider", nombre: "Líder actual" },
  { clave: "aleatorio", nombre: "Uno al azar" },
  { clave: "area", nombre: "Todos los del área" },
  { clave: "propio", nombre: "El propio donador" },
  { clave: "todos", nombre: "Todos los participantes" },
] as const;

/** Cómo se acumulan las unidades de un regalo que pide más de una. */
export const ACUMULACIONES = [
  { clave: "inmediata", nombre: "Al llegar" },
  { clave: "ronda", nombre: "Por ronda" },
  { clave: "participante", nombre: "Por participante" },
] as const;

export interface RegaloJuego {
  id: string;
  regalo: string;
  regaloId: string;
  cantidad: number;
  recompensa: string;
  vida: number;
  poder: string | null;
  objetivo: string;
  enfriamiento: number;
  acumulacion: string;
  activo: boolean;
}

export interface ConfigJuego {
  activo: boolean;
  maxParticipantes: number;
  vidaInicial: number;
  velocidad: number;
  duracionMaxima: number;
  relleno: boolean;
  sonido: boolean;
  volumen: number;
  rondaAutomatica: boolean;
  mostrarNombres: boolean;
  mostrarFotos: boolean;
  mostrarTabla: boolean;
  mostrarDanio: boolean;
  mostrarParticulas: boolean;
  mostrarPoderes: boolean;
  modo: "simulado" | "real";
  reglas: { siEnfriando: string; excedente: string };
  regalos: RegaloJuego[];
}

/** Claves de `localStorage`. */
export const CLAVE_CONFIG = "beyblades.config";
export const CLAVE_COMANDO = "beyblades.comando";
export const CLAVE_ESTADO = "beyblades.estado";

/** Regalos de partida: los mismos ejemplos que se probaron en el prototipo. */
export function regalosPorDefecto(): RegaloJuego[] {
  return [
    { id: "rosa", regalo: "Rosa", regaloId: "5655", cantidad: 1, recompensa: "vida", vida: 500, poder: null, objetivo: "propio", enfriamiento: 0, acumulacion: "inmediata", activo: true },
    { id: "dona", regalo: "Dona", regaloId: "5658", cantidad: 1, recompensa: "poder", vida: 0, poder: "balance", objetivo: "cercano", enfriamiento: 0, acumulacion: "inmediata", activo: true },
    { id: "leon", regalo: "León", regaloId: "5659", cantidad: 1, recompensa: "poder", vida: 0, poder: "cosmico", objetivo: "area", enfriamiento: 0, acumulacion: "inmediata", activo: true },
    { id: "universo", regalo: "Universo", regaloId: "5660", cantidad: 1, recompensa: "vida_poder", vida: 800, poder: "volcanico", objetivo: "cercano", enfriamiento: 0, acumulacion: "inmediata", activo: true },
    { id: "estrella", regalo: "Estrella", regaloId: "5661", cantidad: 3, recompensa: "poder", vida: 0, poder: "electrico", objetivo: "mas_vida", enfriamiento: 0, acumulacion: "participante", activo: true },
    { id: "corona", regalo: "Corona", regaloId: "5662", cantidad: 2, recompensa: "vida_poder", vida: 1200, poder: "ataque", objetivo: "lider", enfriamiento: 6, acumulacion: "participante", activo: true },
    { id: "manita", regalo: "Manita", regaloId: "5663", cantidad: 1, recompensa: "poder", vida: 0, poder: "defensa", objetivo: "todos", enfriamiento: 5, acumulacion: "inmediata", activo: true },
    { id: "galaxia", regalo: "Galaxia", regaloId: "5664", cantidad: 5, recompensa: "vida", vida: 1500, poder: null, objetivo: "propio", enfriamiento: 0, acumulacion: "ronda", activo: true },
  ];
}

/** Configuración de fábrica. El valor por defecto vive **solo aquí**. */
export const CONFIG_POR_DEFECTO: ConfigJuego = {
  activo: false,
  maxParticipantes: 10,
  vidaInicial: 1800,
  velocidad: 1,
  duracionMaxima: 180,
  relleno: true,
  sonido: true,
  volumen: 0.6,
  rondaAutomatica: false,
  mostrarNombres: true,
  mostrarFotos: true,
  mostrarTabla: true,
  mostrarDanio: true,
  mostrarParticulas: true,
  mostrarPoderes: true,
  modo: "simulado",
  reglas: { siEnfriando: "cola", excedente: "conservar" },
  regalos: regalosPorDefecto(),
};

/** Lee la configuración, completando lo que falte con los valores de fábrica. */
export function leerConfig(): ConfigJuego {
  try {
    const crudo = window.localStorage.getItem(CLAVE_CONFIG);
    if (!crudo) return { ...CONFIG_POR_DEFECTO, regalos: regalosPorDefecto() };
    const datos = JSON.parse(crudo) as Partial<ConfigJuego>;
    return {
      ...CONFIG_POR_DEFECTO,
      ...datos,
      reglas: { ...CONFIG_POR_DEFECTO.reglas, ...(datos.reglas ?? {}) },
      regalos: Array.isArray(datos.regalos) && datos.regalos.length ? datos.regalos : regalosPorDefecto(),
    };
  } catch {
    return { ...CONFIG_POR_DEFECTO, regalos: regalosPorDefecto() };
  }
}

/** Guarda la configuración. El overlay se entera por el evento `storage`. */
export function guardarConfig(config: ConfigJuego): void {
  window.localStorage.setItem(CLAVE_CONFIG, JSON.stringify(config));
}

/** Manda un comando al overlay (iniciar, pausar, reanudar, reiniciar, limpiar). */
export function enviarComando(tipo: string, datos?: unknown): void {
  window.localStorage.setItem(
    CLAVE_COMANDO,
    JSON.stringify({ tipo, datos: datos ?? null, cuando: Date.now(), nonce: Math.random() }),
  );
}

export interface EstadoJuego {
  activo: boolean;
  fase: string;
  vivos: number;
  participantes: number;
  ronda: number;
  conexion: string;
  conexionDetalle: string;
  procesados: number;
  duplicados: number;
  desconocidos: number;
  enEspera: number;
  ultimo: string;
  ganador: string | null;
  cuando: number;
}

/** El overlay publica su estado para que el panel lo enseñe. */
export function publicarEstado(estado: EstadoJuego): void {
  window.localStorage.setItem(CLAVE_ESTADO, JSON.stringify(estado));
}

export function leerEstado(): EstadoJuego | null {
  try {
    const crudo = window.localStorage.getItem(CLAVE_ESTADO);
    return crudo ? (JSON.parse(crudo) as EstadoJuego) : null;
  } catch {
    return null;
  }
}

/** Dirección del overlay para OBS: el mismo documento que la vista previa. */
export function urlOverlay(): string {
  return `${window.location.origin}/juego.html`;
}
