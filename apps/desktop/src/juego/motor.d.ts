//! Tipos del motor del juego, que es JavaScript probado en el prototipo.
//!
//! El motor (`prototipos/trompos/js/`) es el entorno de pruebas de la fase 01-06 y se
//! importa tal cual: no hay una copia en TypeScript ni un segundo motor. Aquí sólo se
//! declara lo que usa el overlay, para que `tsc` no tenga que adivinar.
//!
//! Si algún día el motor se pasa a TypeScript, este archivo se borra y ya está.

declare module "*/parametros.js" {
  export const PARAMETROS: Record<string, Record<string, number | boolean | unknown[]>>;
  export function aplicarUrl(): void;
}

declare module "*/simulacion.js" {
  export class Simulacion {
    constructor(datos: { canvas: HTMLCanvasElement | null; tabla: unknown; p: unknown });
    readonly trompos: unknown[];
    readonly regalos: {
      config: { reglas: Record<string, string>; regalos: unknown[] };
      origen: string;
      contadores: Record<string, number>;
      historial: unknown[];
      limpiarHistorial(): void;
      nuevaRonda(): void;
    };
    readonly usuarios: {
      limpiar(): void;
      cuantosEnEspera: number;
      estado(): unknown;
    };
    readonly sonido: { silenciar?(valor: boolean): void };
    readonly estadisticas: { retirados: unknown[] };
    conexion: unknown;
    cambiarParticipantes(n: number): unknown;
    reiniciar(): unknown;
    simular(segundos: number): void;
    dibujar(): void;
    paso(dt: number): void;
    procesarEvento(evento: unknown): unknown;
    estado(): { fase: string; vivos: number; ronda: number; ganador?: string | null };
  }
}

declare module "*/tiktok.js" {
  export class ConexionTikTok {
    constructor(opciones: {
      url?: string;
      alEvento?: (evento: unknown) => void;
      alCambio?: (estado: unknown, detalle: string) => void;
      WebSocketImpl?: unknown;
      modo?: string;
    });
    conectar(): boolean;
    desconectar(motivo?: string): void;
    enviarCrudo(crudo: unknown, opciones?: Record<string, unknown>): unknown;
    estadoActual(): {
      estado: string;
      detalle: string;
      contadores: Record<string, number>;
      ultimoEvento: { displayName: string; giftName: string; cantidadNueva: number } | null;
    };
  }
  export function eventoDePrueba(escenario: string, datos?: Record<string, unknown>): unknown;
  export const ESCENARIOS: { clave: string; nombre: string; detalle: string }[];
}
