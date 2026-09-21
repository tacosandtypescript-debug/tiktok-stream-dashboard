// Overlay del juego de trompos: motor de batalla + regalos de TikTok.
//!
//! Este archivo es el que corre dentro de OBS (y dentro de la vista previa del
//! panel). No dibuja ningún control: sólo el lienzo de 1080 x 1920.
//!
//! De dónde salen los regalos: **del bus de eventos del motor**, el mismo que
//! alimentan las Alertas y los overlays que ya existían. Este overlay se suscribe
//! con `ConexionTikTok` a `ws://<mismo origen>/api/eventos` y no abre ninguna
//! conexión con TikTok: no hay un segundo listener en ninguna parte.
//!
//! El motor de batalla es **el mismo del prototipo** (`prototipos/trompos/js/`), que
//! es el entorno de pruebas: aquí no hay una copia, se importa de allí, así que lo
//! que se probó es exactamente lo que corre en antena. Al empaquetar, esos módulos
//! entran en el paquete de la interfaz (son módulos ES sin dependencias).

import { PARAMETROS, aplicarUrl } from "../../../../prototipos/trompos/js/parametros.js";
import { Simulacion } from "../../../../prototipos/trompos/js/simulacion.js";
import { ConexionTikTok, eventoDePrueba, ESCENARIOS } from "../../../../prototipos/trompos/js/tiktok.js";
import {
  CLAVE_COMANDO,
  CLAVE_CONFIG,
  leerConfig,
  publicarEstado,
  type ConfigJuego,
  type EstadoJuego,
} from "./config";

// Las direcciones URL siguen mandando sobre la configuración guardada (así se puede
// abrir el overlay con `?participantes=40&vida=2500` sin tocar nada).
aplicarUrl();

const lienzo = document.getElementById("lienzo") as HTMLCanvasElement;
const aviso = document.getElementById("aviso") as HTMLDivElement;
let config: ConfigJuego = leerConfig();

/** Aplica la configuración al motor: un solo sitio donde se traduce a parámetros. */
function aplicarConfig(c: ConfigJuego): void {
  PARAMETROS.simulacion.maxParticipantes = Math.min(40, Math.max(2, c.maxParticipantes));
  // Con relleno, la arena arranca llena (para ver el juego sin nadie conectado). Sin
  // relleno arranca **vacía** y se va llenando con quien manda regalos: si arrancara
  // llena, los espectadores se quedarían todos EN ESPERA y no entraría nadie.
  PARAMETROS.simulacion.participantes = c.relleno ? c.maxParticipantes : 0;
  PARAMETROS.vida.inicial = Math.max(200, c.vidaInicial);
  PARAMETROS.simulacion.batallaMaxima = Math.max(20, c.duracionMaxima);
  PARAMETROS.fisica.velocidadCrucero = Math.round(400 * c.velocidad);
  PARAMETROS.trompo.rapidezMinima = Math.round(350 * c.velocidad);
  PARAMETROS.trompo.rapidezMaxima = Math.round(560 * c.velocidad);
  PARAMETROS.sonido.activo = c.sonido;
  PARAMETROS.sonido.volumen = c.volumen;
  PARAMETROS.aspecto.verNombres = c.mostrarNombres;
  PARAMETROS.fotos.activo = c.mostrarFotos;
  PARAMETROS.aspecto.verTabla = c.mostrarTabla;
  PARAMETROS.efectos.numerosDanio = c.mostrarDanio;
  PARAMETROS.aspecto.verParticulas = c.mostrarParticulas;
  PARAMETROS.poderes.activo = c.mostrarPoderes;
  PARAMETROS.poderes.verEfectos = c.mostrarPoderes;
  PARAMETROS.aspecto.verRastro = c.mostrarParticulas;
}

aplicarConfig(config);

const sim = new Simulacion({ canvas: lienzo, tabla: null, p: PARAMETROS });
sim.cambiarParticipantes(PARAMETROS.simulacion.participantes as number);

// El motor de regalos usa la tabla de la configuración del panel.
function cargarRegalos(c: ConfigJuego): void {
  sim.regalos.config = {
    reglas: { siEnfriando: c.reglas.siEnfriando, excedente: c.reglas.excedente },
    regalos: c.regalos.map((r) => ({ ...r })),
  };
  sim.regalos.origen = "panel de la aplicación";
}
cargarRegalos(config);

// --- eventos: un único punto de entrada, el mismo para reales y simulados
const conexion = new ConexionTikTok({
  // Mismo origen: en desarrollo lo proxea Vite (con `ws: true`) y en modo web lo
  // sirve el propio motor. Nunca se apunta a otro sitio ni se pide un token.
  url: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/eventos`,
  alEvento: (evento: unknown) => sim.procesarEvento(evento),
});
sim.conexion = conexion;

if (config.modo === "real") conexion.conectar();

// --- ciclo de vida
let pausado = false;
let pausadoPorFaltaDeFoco = false;
let cuadro = 0;
let ultimo = performance.now();


/** Comandos del panel: iniciar, pausar, reanudar, reiniciar, limpiar, activar. */
function atenderComando(tipo: string, datos: unknown): void {
  const conDatos = datos as { participantes?: number; escenario?: string } | null;
  switch (tipo) {
    case "iniciar":
      sim.reiniciar();
      pausado = false;
      break;
    case "pausar":
      pausado = true;
      break;
    case "reanudar":
      pausado = false;
      break;
    case "reiniciar":
      // Ronda nueva con la misma configuración: se limpian trompos, daño y eventos.
      sim.reiniciar();
      sim.regalos.limpiarHistorial();
      sim.usuarios.limpiar();
      pausado = false;
      break;
    case "limpiar":
      sim.usuarios.limpiar();
      sim.regalos.limpiarHistorial();
      sim.regalos.nuevaRonda();
      sim.estadisticas.retirados.length = 0;
      sim.reiniciar();
      pausado = false;
      break;
    case "participantes":
      if (conDatos?.participantes) {
        aplicarConfig({ ...config, maxParticipantes: conDatos.participantes });
        sim.cambiarParticipantes(PARAMETROS.simulacion.participantes as number);
      }
      break;
    case "escenario": {
      // Los controles internos de prueba usan el MISMO camino que los regalos reales.
      const escenario = conDatos?.escenario ?? "rosa";
      if (escenario === "racha") {
        for (const repeat of [1, 3, 5]) {
          conexion.enviarCrudo(
            eventoDePrueba("racha-parcial", { repeat, grupo: "panel" }),
            { simulado: true },
          );
        }
      } else if (escenario === "duplicado") {
        const crudo = eventoDePrueba("duplicado");
        conexion.enviarCrudo(crudo, { simulado: true });
        conexion.enviarCrudo(crudo, { simulado: true });
      } else {
        conexion.enviarCrudo(eventoDePrueba(escenario), { simulado: true });
      }
      break;
    }
    default:
      break;
  }
}

window.addEventListener("storage", (evento) => {
  if (evento.key === CLAVE_CONFIG) {
    const antes = config.maxParticipantes;
    const antesRelleno = config.relleno;
    config = leerConfig();
    aplicarConfig(config);
    cargarRegalos(config);
    // Si cambió el cupo o el relleno, se rehace la alineación con la configuración nueva.
    if (config.maxParticipantes !== antes || config.relleno !== antesRelleno) {
      sim.cambiarParticipantes(PARAMETROS.simulacion.participantes as number);
    }
    if (config.activo && !pausadoPorFaltaDeFoco) pausado = false;
    aviso.textContent = config.activo ? "" : "JUEGO DESACTIVADO";
    if (config.modo === "real") conexion.conectar();
    else conexion.desconectar("modo simulado");
    return;
  }
  if (evento.key === CLAVE_COMANDO && evento.newValue) {
    try {
      const comando = JSON.parse(evento.newValue) as { tipo: string; datos: unknown };
      atenderComando(comando.tipo, comando.datos);
    } catch {
      /* un comando ilegible no puede tumbar el overlay */
    }
  }
});

// La propia pestaña también atiende sus comandos (por si el panel está en el mismo
// documento, como en la vista previa).
window.addEventListener("beyblades:comando", ((evento: CustomEvent) => {
  atenderComando(evento.detail?.tipo, evento.detail?.datos);
}) as EventListener);

// --- pausa automática cuando la pestaña no se ve: no se gasta motor en balde
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pausadoPorFaltaDeFoco = true;
    pausado = true;
  } else {
    pausadoPorFaltaDeFoco = false;
    pausado = false;
    ultimo = performance.now();
  }
});

// --- estado para el panel (contadores, fase, conexión…)
let relojEstado = 0;
function publicarSiToca(dt: number): void {
  relojEstado += dt;
  if (relojEstado < 0.5) return;
  relojEstado = 0;
  const e = sim.estado();
  const c = conexion.estadoActual();
  const estado: EstadoJuego = {
    activo: config.activo,
    fase: e.fase,
    vivos: e.vivos,
    participantes: sim.trompos.length,
    ronda: e.ronda,
    conexion: c.estado,
    conexionDetalle: c.detalle,
    procesados: c.contadores.procesados,
    duplicados: c.contadores.duplicados,
    desconocidos: sim.regalos.contadores.desconocidos,
    enEspera: sim.usuarios.cuantosEnEspera,
    ultimo: c.ultimoEvento
      ? `${c.ultimoEvento.displayName} · ${c.ultimoEvento.giftName} ×${c.ultimoEvento.cantidadNueva}`
      : "",
    ganador: e.ganador ?? null,
    cuando: Date.now(),
  };
  publicarEstado(estado);
}

/** Marco de dibujo con su reloj de estado. */
function bucle(ahora: number): void {
  const dt = Math.min(0.1, (ahora - ultimo) / 1000);
  ultimo = ahora;
  if (!pausado && config.activo) sim.simular(dt);
  sim.dibujar();
  publicarSiToca(dt);
  cuadro = requestAnimationFrame(bucle);
}

aviso.textContent = config.activo ? "" : "JUEGO DESACTIVADO";
cancelAnimationFrame(cuadro);
cuadro = requestAnimationFrame(bucle);

// Al cerrar el overlay: se para la animación, se apaga el sonido y se sueltan
// listeners y temporizadores (nada de conexiones zombis).
window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(cuadro);
  conexion.desconectar("overlay cerrado");
  sim.sonido.silenciar?.(true);
});

// Ayudas de desarrollo: sólo existen si la página se abre con `?taller=1`, y nunca
// se enseñan en antena (el overlay de OBS no lleva controles).
if (new URLSearchParams(window.location.search).has("taller")) {
  (window as unknown as { BEYBLADES: unknown }).BEYBLADES = {
    sim,
    conexion,
    escenarios: ESCENARIOS,
    escenario: (clave: string) => conexion.enviarCrudo(eventoDePrueba(clave), { simulado: true }),
    comando: atenderComando,
  };
}

/** Arranca la ronda sola si así está configurado. */
if (config.rondaAutomatica) sim.reiniciar();
