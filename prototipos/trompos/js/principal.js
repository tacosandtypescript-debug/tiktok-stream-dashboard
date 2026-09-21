// Arranque del prototipo: lienzo, simulación, taller y ayudas de comprobación.
//
// `window.PROTOTIPO` existe para poder revisar el prototipo desde fuera (consola del
// navegador o un banco de pruebas): medidas del lienzo, transparencia real, huella de
// cada diseño, recortes para las capturas y un simulador de cabeza que avanza la
// física sin dibujar. No es una API del producto: es la forma de comprobar en
// automático lo que se ve a ojo.

import { PARAMETROS, aplicarUrl, medidaArena, escalaTrompos, escalaEfectos, radioDe } from "./parametros.js";
import { PODERES, ORDEN_PODERES } from "./poderes.js";
import { RECOMPENSAS, OBJETIVOS, ACUMULACIONES, REGLAS_ESPERA } from "./regalos.js";
import { ConexionTikTok, eventoDePrueba, ESCENARIOS } from "./tiktok.js";
import { Simulacion } from "./simulacion.js";
import { Tabla } from "./tabla.js";
import { Taller } from "./hud.js";
import { DISENOS, ORDEN_DISENOS, dibujarCuerpo } from "./dibujo/disenos.js";
import { estadisticasEtiquetas, escalaEtiqueta, modoCompacto, medidasEtiqueta } from "./dibujo/etiquetas.js";

const consulta = new URLSearchParams(location.search);
const limpio = consulta.has("limpio") || consulta.has("solo");
if (limpio) document.body.classList.add("limpio");

const aplicados = aplicarUrl(location.search);
if (aplicados.length) {
  document.body.dataset.url = aplicados.join(" · ");
}

const lienzo = document.getElementById("lienzo");
const sim = new Simulacion({
  canvas: lienzo,
  tabla: document.getElementById("tabla"),
  p: PARAMETROS,
});
const taller = new Taller(sim, PARAMETROS).montar();

/**
 * Puente con TikTok (orden 06).
 *
 * Se suscribe al bus de eventos del motor —el mismo que alimenta los overlays— en
 * `ws://127.0.0.1:8790/api/eventos`. No abre ninguna conexión con TikTok, no pide
 * credenciales y no envía nada: sólo escucha.
 */
const conexion = new ConexionTikTok({
  alEvento: (evento) => sim.procesarEvento(evento),
  alCambio: () => taller.refrescarTikTok?.(),
});
// La simulación necesita verlo para el taller y para las pruebas.
sim.conexion = conexion;

// El bucle vive aquí (y no dentro de la simulación) para poder refrescar el HUD en
// el mismo fotograma sin duplicar `requestAnimationFrame`.
let ultimo = 0;
function bucle(ts) {
  requestAnimationFrame(bucle);
  const dt = ultimo ? Math.min((ts - ultimo) / 1000, 0.25) : 0;
  ultimo = ts;
  sim.fotograma(ts);
  taller.refrescar(dt);
}
requestAnimationFrame(bucle);

// ------------------------------------------------------------------ ayudas

/** Fracción de píxeles con algo pintado (alfa > 8) en el lienzo de verdad. */
function cobertura(ctx, ancho, alto, salto = 4) {
  const datos = ctx.getImageData(0, 0, ancho, alto).data;
  let cuenta = 0;
  let total = 0;
  for (let y = 0; y < alto; y += salto) {
    for (let x = 0; x < ancho; x += salto) {
      const i = (y * ancho + x) * 4;
      if (datos[i + 3] > 8) cuenta += 1;
      total += 1;
    }
  }
  return { pintados: cuenta, total, fraccion: Number((cuenta / total).toFixed(4)) };
}

function alfaEn(ctx, x, y) {
  return ctx.getImageData(x, y, 1, 1).data[3];
}

/** Hasta dónde llega la tinta, en píxeles del lienzo. */
function extensionDe(ctx, ancho, alto) {
  const datos = ctx.getImageData(0, 0, ancho, alto).data;
  let xMin = ancho;
  let xMax = -1;
  let yMin = alto;
  let yMax = -1;
  for (let y = 0; y < alto; y += 4) {
    for (let x = 0; x < ancho; x += 4) {
      if (datos[(y * ancho + x) * 4 + 3] <= 8) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (xMax < 0) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  return { xMin, xMax, yMin, yMax };
}

/** Huella de tinta de cada diseño: dos diseños distintos no pueden dar el mismo número. */
function huellas(escala = 1) {
  const lado = 200;
  const c = document.createElement("canvas");
  c.width = lado;
  c.height = lado;
  const ctx = c.getContext("2d");
  const salida = [];
  for (const clave of ORDEN_DISENOS) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, lado, lado);
    ctx.save();
    ctx.translate(lado / 2, lado / 2);
    dibujarCuerpo(ctx, DISENOS[clave], lado * 0.34 * escala, 1, 0.37, 0.11);
    ctx.restore();
    const datos = ctx.getImageData(0, 0, lado, lado).data;
    let hash = 2166136261;
    let tinta = 0;
    for (let i = 0; i < datos.length; i += 4) {
      const a = datos[i + 3];
      if (a > 8) tinta += 1;
      if (a > 0) {
        hash ^= (datos[i] << 16) ^ (datos[i + 1] << 8) ^ datos[i + 2] ^ a;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
    salida.push({ clave, nombre: DISENOS[clave].nombre, hash: hash >>> 0, tinta });
  }
  return salida;
}

/** Recorta una zona del lienzo y la devuelve ampliada, para capturas de detalle. */
function recorte(x, y, ancho, alto, ampliacion = 2) {
  const c = document.createElement("canvas");
  c.width = Math.round(ancho * ampliacion);
  c.height = Math.round(alto * ampliacion);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(lienzo, x, y, ancho, alto, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

window.PROTOTIPO = {
  sim,
  taller,
  parametros: PARAMETROS,
  disenos: DISENOS,

  estado: () => sim.estado(),
  pasoFijo: (segundos) => {
    const pasos = Math.floor(segundos / PARAMETROS.tiempo.paso);
    for (let i = 0; i < pasos; i += 1) sim.paso(PARAMETROS.tiempo.paso);
    return sim.estado();
  },
  simular: (segundos, opciones) => sim.simular(segundos, opciones),
  hastaElFinal: (maxSegundos = 400) => sim.simular(0, { hastaElFinal: true, maxSegundos }),
  dibujar: () => sim.dibujar(),
  pausar: () => sim.pausar(),
  continuar: () => sim.continuar(),
  reiniciar: (nueva = false) => sim.reiniciar({ nuevaSemilla: nueva }),
  reiniciarRonda: () => sim.reiniciarRonda(),
  siguienteRonda: () => sim.siguienteRonda(),
  impacto: () => sim.impactoForzado(),
  anadir: () => sim.anadirParticipante(),
  quitar: (id) => sim.quitarParticipante(id),
  editar: (id, cambios) => sim.editarParticipante(id, cambios),
  identidades: () => sim.identidades(),
  fotos: () => sim.fotos.estado(),
  poderes: () => sim.poderes.estado(sim),
  poderesCatalogo: () => PODERES,
  ordenPoderes: () => ORDEN_PODERES,

  /**
   * Lanza un poder y deja la simulación en el momento pedido, para poder capturarlo.
   * Momentos: "carga" (aviso), "activo" (efecto), "final" (disipación).
   *
   * `id` es opcional: si no se dice, se lanza en el primer participante que lo tenga
   * listo (cualquiera puede usar cualquiera de los diez poderes).
   */
  probarPoder(clave, momento = "activo", id = null) {
    const usado = id
      ? sim.activarPoder(id, clave, true)
      : sim.activarPoderEnCualquiera(clave, true);
    if (!usado || !usado.id) return null;
    const definicion = PODERES[clave];
    // Ojo: `pasoFijo` vive en PROTOTIPO, no en la simulación; aquí se avanza a mano.
    const avanzar = (segundos) => {
      const pasos = Math.floor(segundos / PARAMETROS.tiempo.paso);
      for (let i = 0; i < pasos; i += 1) sim.paso(PARAMETROS.tiempo.paso);
    };
    if (momento === "carga") {
      avanzar(Math.max(0.05, definicion.carga * 0.72));
    } else if (momento === "impacto") {
      // Justo después de romperse: se ven los fragmentos saliendo.
      avanzar(definicion.carga + (definicion.vuelo ?? 0) + 0.12);
    } else if (momento === "activo") {
      if (definicion.vuelo) {
        // Los poderes con proyectil (el cristal) se capturan a mitad de vuelo: si se
        // avanza como los demás, cuando se dibuja ya ha reventado.
        avanzar(definicion.carga + definicion.vuelo * 0.55);
      } else {
        // Muy al principio del efecto: es cuando se ve la explosión, el rayo o el
        // fogonazo. Un poco más tarde y el crop pilla sólo los escombros.
        avanzar(definicion.carga + 0.06);
        avanzar(0.12);
      }
    } else {
      avanzar(definicion.carga + definicion.duracion + definicion.final * 0.45);
    }
    sim.dibujar();
    const trompo = sim.trompos.find((t) => t.id === usado.id);
    if (!trompo) return null;
    return {
      ...sim.poderes.deUnTrompo(trompo),
      x: Math.round(trompo.x),
      y: Math.round(trompo.y),
      radio: Number(trompo.radio.toFixed(1)),
    };
  },

  activarPoder: (id, clave = null, forzar = false, objetivo = null) => sim.activarPoder(id, clave, forzar, objetivo),
  activarPoderEnCualquiera: (clave, forzar = true) => sim.activarPoderEnCualquiera(clave, forzar),
  demostracionPoderes: (activar = null) => sim.demostracionPoderes(activar),
  reiniciarPoderes: () => sim.reiniciarPoderes(),
  participantes: (n) => sim.cambiarParticipantes(n),
  sonido: () => sim.sonido.estado(),
  desbloquearSonido: () => sim.sonido.desbloquear(),
  probarSonidos: () => sim.sonido.probar(0.12),
  recorte,

  medir() {
    const ctx = sim.ctx;
    const { ancho, alto } = PARAMETROS.lienzo;
    const rect = lienzo.getBoundingClientRect();
    const arena = medidaArena(PARAMETROS);
    return {
      lienzo: { ancho, alto, atributoAncho: lienzo.width, atributoAlto: lienzo.height },
      enPantalla: { ancho: Math.round(rect.width), alto: Math.round(rect.height), escala: Number((rect.width / ancho).toFixed(3)) },
      alfaEsquinas: {
        arribaIzquierda: alfaEn(ctx, 0, 0),
        arribaDerecha: alfaEn(ctx, ancho - 1, 0),
        abajoIzquierda: alfaEn(ctx, 0, alto - 1),
        abajoDerecha: alfaEn(ctx, ancho - 1, alto - 1),
      },
      cobertura: cobertura(ctx, ancho, alto, 8),
      fondoDelLienzo: getComputedStyle(lienzo).backgroundColor,
      arena,
      // Geometría de los dos bloques de la franja superior (orden de layout): el banco
      // comprueba que cada uno ocupa su mitad y que los dos caben por encima de la arena.
      clasificacion: {
        x: PARAMETROS.clasificacion.x,
        y: PARAMETROS.clasificacion.y,
        ancho: PARAMETROS.clasificacion.ancho,
        alto:
          PARAMETROS.clasificacion.altoCabecera +
          6 +
          PARAMETROS.clasificacion.filas * (PARAMETROS.clasificacion.altoFila + PARAMETROS.clasificacion.separacionFilas) +
          PARAMETROS.clasificacion.altoResumen,
      },
      carteles: {
        x: PARAMETROS.carteles.x,
        y: PARAMETROS.carteles.y,
        ancho: PARAMETROS.carteles.ancho,
        alto:
          PARAMETROS.carteles.altoCabecera +
          6 +
          PARAMETROS.carteles.maxEliminaciones * (PARAMETROS.carteles.altoPlato + PARAMETROS.carteles.separacion),
      },
      escala: {
        trompos: Number(escalaTrompos(PARAMETROS).toFixed(3)),
        efectos: Number(escalaEfectos(PARAMETROS).toFixed(3)),
        etiquetas: Number(escalaEtiqueta(PARAMETROS).toFixed(3)),
        compactas: modoCompacto(PARAMETROS),
        radio: Number(radioDe(PARAMETROS, DISENOS.ataque).toFixed(1)),
      },
      etiquetas: estadisticasEtiquetas(),
      estado: sim.estado(),
    };
  },
  huellas,
  /** Medidas de la etiqueta de un trompo (para comprobar nombres largos). */
  medirEtiqueta: (tr) => medidasEtiqueta(sim.ctx, tr, PARAMETROS, modoCompacto(PARAMETROS)),

  /**
   * Huella del núcleo de un participante: recorta el trozo del lienzo donde está su
   * medallón y devuelve un hash. Sirve para demostrar que la foto se pinta de verdad
   * (el hash cambia si se quita la foto) sin depender de mirar la captura.
   */
  huellaNucleo(id, margen = 1.15) {
    const t = sim.trompos.find((x) => x.id === id);
    if (!t) return null;
    sim.dibujar();
    const r = Math.max(6, Math.ceil(t.radio * margen));
    const x = Math.max(0, Math.min(PARAMETROS.lienzo.ancho - r * 2, Math.round(t.x - r)));
    const y = Math.max(0, Math.min(PARAMETROS.lienzo.alto - r * 2, Math.round(t.y - r)));
    const dataUrl = recorte(x, y, r * 2, r * 2, 2);
    let h = 2166136261;
    for (let i = 0; i < dataUrl.length; i += 7) {
      h ^= dataUrl.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const reg = sim.fotos.registro(t.foto);
    return {
      id,
      nombre: t.nombre,
      foto: t.foto,
      estadoFoto: reg.estado,
      utilizable: sim.fotos.utilizable(t.foto),
      inicial: t.inicial,
      color: t.color,
      radioMedallon: Number(Math.max(PARAMETROS.fotos.medallonMinimo, t.radio * PARAMETROS.fotos.medallon).toFixed(1)),
      hash: h >>> 0,
    };
  },
  etiquetas: () => estadisticasEtiquetas(),

  /**
   * Hasta dónde llega la tinta en vertical y en horizontal, en fracción del lienzo.
   * Es la medida de «la composición ocupa todo el lienzo, no una franja».
   */
  extension() {
    const { ancho, alto } = PARAMETROS.lienzo;
    const { xMin, xMax, yMin, yMax } = extensionDe(sim.ctx, ancho, alto);
    if (xMax < 0) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0, ancho: 0, alto: 0 };
    return {
      xMin,
      xMax,
      yMin,
      yMax,
      ancho: Number(((xMax - xMin) / ancho).toFixed(3)),
      alto: Number(((yMax - yMin) / alto).toFixed(3)),
    };
  },

  /**
   * Lo mismo, pero a lo largo de varios segundos de pelea: un fotograma suelto
   * puede pillarlo todo abajo, y lo que importa es que la batalla recorra el lienzo
   * entero. Avanza con paso fijo y va uniendo las extensiones.
   */
  extensionAcumulada(segundos = 8, trozos = 16) {
    const { ancho, alto } = PARAMETROS.lienzo;
    let xMin = ancho;
    let xMax = -1;
    let yMin = alto;
    let yMax = -1;
    for (let i = 0; i < trozos; i += 1) {
      sim.simular(segundos / trozos);
      sim.dibujar();
      const e = extensionDe(sim.ctx, ancho, alto);
      if (e.xMax < 0) continue;
      xMin = Math.min(xMin, e.xMin);
      xMax = Math.max(xMax, e.xMax);
      yMin = Math.min(yMin, e.yMin);
      yMax = Math.max(yMax, e.yMax);
    }
    if (xMax < 0) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0, ancho: 0, alto: 0 };
    return {
      xMin,
      xMax,
      yMin,
      yMax,
      ancho: Number(((xMax - xMin) / ancho).toFixed(3)),
      alto: Number(((yMax - yMin) / alto).toFixed(3)),
    };
  },

  /** Reparte la huella por franjas horizontales: comprueba que se usa todo el alto. */
  repartoVertical(franjas = 12) {
    const ctx = sim.ctx;
    const { ancho, alto } = PARAMETROS.lienzo;
    const datos = ctx.getImageData(0, 0, ancho, alto).data;
    const altoFranja = Math.floor(alto / franjas);
    const salida = [];
    for (let f = 0; f < franjas; f += 1) {
      let cuenta = 0;
      for (let y = f * altoFranja; y < (f + 1) * altoFranja; y += 6) {
        for (let x = 0; x < ancho; x += 6) {
          if (datos[(y * ancho + x) * 4 + 3] > 8) cuenta += 1;
        }
      }
      salida.push(cuenta);
    }
    return salida;
  },

  /** ¿Hay tinta en la franja de la tabla y en la de los mensajes? (zonas reservadas) */
  zonaReservada(desde, hasta) {
    const ctx = sim.ctx;
    const { ancho } = PARAMETROS.lienzo;
    const datos = ctx.getImageData(0, desde, ancho, hasta - desde).data;
    let cuenta = 0;
    for (let y = 0; y < hasta - desde; y += 2) {
      for (let x = 0; x < ancho; x += 2) {
        if (datos[(y * ancho + x) * 4 + 3] > 8) cuenta += 1;
      }
    }
    return cuenta;
  },

  /**
   * Comprobación de arranque: distancias entre trompos al empezar la ronda. Sirve
   * para demostrar que con 40 participantes no nacen unos encima de otros.
   */
  solapesIniciales() {
    let peor = 0;
    let quien = null;
    const lista = sim.trompos;
    for (let i = 0; i < lista.length; i += 1) {
      for (let j = i + 1; j < lista.length; j += 1) {
        const d = Math.hypot(lista[j].x - lista[i].x, lista[j].y - lista[i].y);
        const solape = lista[i].radio + lista[j].radio - d;
        if (solape > peor) {
          peor = solape;
          quien = [lista[i].nombre, lista[j].nombre];
        }
      }
    }
    return { peor: Number(peor.toFixed(2)), quien, radio: Number((lista[0]?.radio ?? 0).toFixed(1)) };
  },
  // --- regalos (orden 05)

  /** Envía un regalo simulado y devuelve el evento. */
  enviarRegalo: (participanteId, regaloId, cantidad = 1) => sim.enviarRegalo({ participanteId, regaloId, cantidad }),
  regalos: () => sim.regalos.estado(),
  regalosConfig: () => sim.regalos.config,
  guardarRegalos: () => sim.regalos.guardar(),
  cargarRegalos: () => sim.regalos.cargar(),
  restaurarRegalos: () => sim.regalos.restaurar(),
  anadirRegalo: (fila) => sim.regalos.anadirRegalo(fila),
  editarRegalo: (id, cambios) => sim.regalos.editarRegalo(id, cambios),
  quitarRegalo: (id) => sim.regalos.quitarRegalo(id),
  exportarRegalos: () => sim.regalos.exportar(),
  importarRegalos: (texto) => sim.regalos.importar(texto),
  /** Repinta la tabla de regalos del taller con lo que hay en el modelo. */
  pintarRegalos: () => {
    taller.pintarTablaRegalos();
    taller.refrescarRegalos(sim.estado());
  },
  regalosCatalogo: () => ({ RECOMPENSAS, OBJETIVOS, ACUMULACIONES, REGLAS_ESPERA }),

  // --- TikTok (orden 06)

  /** Estado del puente: conexión, contadores, último evento y registro técnico. */
  tiktok: () => conexion.estadoActual(),
  escenariosTikTok: () => ESCENARIOS,
  conectarTikTok: () => conexion.conectar(),
  conectarPuenteTikTok: () => conexion.usarPuente(true),
  desconectarTikTok: (motivo) => conexion.desconectar(motivo),
  modoTikTok: (modo) => conexion.usarModo(modo),
  silenciarTikTok: (mudo) => {
    conexion.mudo = mudo ?? !conexion.mudo;
    return conexion.mudo;
  },
  /** Lanza un escenario de prueba: pasa por el mismo normalizador que un evento real. */
  probarTikTok: (escenario, datos = {}) => {
    const crudo = eventoDePrueba(escenario, datos);
    if (!crudo) return null;
    return conexion.enviarCrudo(crudo, { simulado: true, origen: "prueba" });
  },
  /** Inyecta un sobre crudo tal cual (para pruebas desde consola o desde el banco). */
  inyectarTikTok: (crudo) => conexion.enviarCrudo(crudo, { origen: "inyectado" }),
  usuarios: () => sim.usuarios.estado(),
  guardarUsuarios: async () => {
    const respuesta = await fetch("/api/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sim.usuarios.exportar()),
    });
    return respuesta.json();
  },
  promoverDeEspera: () => sim.promoverDeEspera(),
};

/** Carga la configuración de regalos guardada y refresca la tabla del taller. */
sim.cargarRegalos().then(() => {
  taller.pintarTablaRegalos();
  taller.refrescarRegalos(sim.estado());
});

/** Carga el registro de espectadores reconocidos (identidad por userId). */
fetch("/api/usuarios", { cache: "no-store" })
  .then((r) => r.json())
  .then((datos) => {
    if (datos?.existe) sim.usuarios.importar(datos);
    taller.pintarUsuarios?.();
  })
  .catch(() => {});
taller.pintarTikTok?.();

document.body.dataset.listo = "1";
