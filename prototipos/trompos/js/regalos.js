// Configuración de regalos y motor de recompensas (orden 05).
//
// Cada fila de la tabla es un regalo simulado: cuántas unidades hacen falta, qué
// recompensa da (vida, poder, las dos o un evento), qué poder lanza, a quién se lo
// lanza, cada cuánto puede repetirse y si está activo.
//
// Lo que NO depende del diseño: el poder que activa un regalo se lanza **desde el
// trompo del donador**, sea cual sea su diseño. Un participante con el diseño azul
// (firma: Martillo Orbital) puede lanzar Onda de Rebote si el regalo lo dice.
//
// Persistencia: la configuración se guarda en `datos/regalos.json` a través de
// `/api/regalos` (el servidor del prototipo, no la base de datos de la aplicación).
// Al arrancar se lee de ahí; si no hay archivo, se usan los valores de ejemplo de este
// módulo, que también son los que repone «Restaurar ejemplos».

import { PODERES, ORDEN_PODERES } from "./poderes.js";
import { limitar } from "./util.js";

/** Tipos de recompensa. */
export const RECOMPENSAS = {
  vida: { clave: "vida", nombre: "Vida", color: "#4ade80" },
  poder: { clave: "poder", nombre: "Poder", color: "#ffcc44" },
  vida_poder: { clave: "vida_poder", nombre: "Vida y poder", color: "#a78bfa" },
  evento: { clave: "evento", nombre: "Evento especial", color: "#ff9ec7" },
};

/** Objetivos posibles de un poder lanzado por un regalo. */
export const OBJETIVOS = {
  cercano: { clave: "cercano", nombre: "Rival más cercano" },
  mas_vida: { clave: "mas_vida", nombre: "Rival con más vida" },
  lider: { clave: "lider", nombre: "Líder actual" },
  aleatorio: { clave: "aleatorio", nombre: "Participante aleatorio" },
  area: { clave: "area", nombre: "Todos los rivales del área" },
  propio: { clave: "propio", nombre: "El propio donador" },
  todos: { clave: "todos", nombre: "Todos los participantes" },
};

/** Cómo se acumulan las unidades de un regalo que pide más de una. */
export const ACUMULACIONES = {
  inmediata: { clave: "inmediata", nombre: "Consumir al llegar" },
  ronda: { clave: "ronda", nombre: "Acumular por ronda" },
  participante: { clave: "participante", nombre: "Acumular por participante" },
};

/** Qué hacer si el poder está en enfriamiento cuando llega el regalo. */
export const REGLAS_ESPERA = {
  cola: { clave: "cola", nombre: "Poner en cola y lanzarlo cuando esté libre" },
  ignorar: { clave: "ignorar", nombre: "Ignorar el evento" },
  primer_disponible: { clave: "primer_disponible", nombre: "Lanzar el primer poder disponible" },
};

/**
 * Valores de ejemplo. No son definitivos: todo se edita desde el taller y se guarda
 * en `datos/regalos.json`. Cubren los cuatro tipos de recompensa, la acumulación, los
 * enfriamientos y todos los objetivos.
 */
export function regalosDeEjemplo() {
  return {
    reglas: {
      siEnfriando: "cola",
      excedente: "conservar",
    },
    regalos: [
      { id: "rosa", regalo: "Rosa", regaloId: "5655", cantidad: 1, recompensa: "vida", vida: 500, poder: null, objetivo: "propio", enfriamiento: 0, acumulacion: "inmediata", activo: true },
      { id: "dona", regalo: "Dona", regaloId: "5658", cantidad: 1, recompensa: "poder", vida: 0, poder: "balance", objetivo: "cercano", enfriamiento: 0, acumulacion: "inmediata", activo: true },
      { id: "leon", regalo: "León", regaloId: "5659", cantidad: 1, recompensa: "poder", vida: 0, poder: "cosmico", objetivo: "area", enfriamiento: 0, acumulacion: "inmediata", activo: true },
      { id: "universo", regalo: "Universo", regaloId: "5660", cantidad: 1, recompensa: "vida_poder", vida: 800, poder: "volcanico", objetivo: "cercano", enfriamiento: 0, acumulacion: "inmediata", activo: true },
      { id: "estrella", regalo: "Estrella", regaloId: "5661", cantidad: 3, recompensa: "poder", vida: 0, poder: "electrico", objetivo: "mas_vida", enfriamiento: 0, acumulacion: "participante", activo: true },
      { id: "corona", regalo: "Corona", regaloId: "5662", cantidad: 2, recompensa: "vida_poder", vida: 1200, poder: "ataque", objetivo: "lider", enfriamiento: 6, acumulacion: "participante", activo: true },
      { id: "manita", regalo: "Manita", regaloId: "5663", cantidad: 1, recompensa: "poder", vida: 0, poder: "defensa", objetivo: "todos", enfriamiento: 5, acumulacion: "inmediata", activo: true },
      { id: "galaxia", regalo: "Galaxia", regaloId: "5664", cantidad: 5, recompensa: "vida", vida: 1500, poder: null, objetivo: "propio", enfriamiento: 0, acumulacion: "ronda", activo: true },
      { id: "fuego", regalo: "Fuego", regaloId: "5665", cantidad: 4, recompensa: "evento", vida: 0, poder: null, objetivo: "todos", enfriamiento: 10, acumulacion: "inmediata", activo: false },
    ],
  };
}

/** Rellena una fila con los valores por defecto que falten y la sanea. */
export function normalizarRegalo(fila = {}, indice = 0) {
  const recompensa = RECOMPENSAS[fila.recompensa] ? fila.recompensa : "vida";
  const objetivo = OBJETIVOS[fila.objetivo] ? fila.objetivo : "cercano";
  const acumulacion = ACUMULACIONES[fila.acumulacion] ? fila.acumulacion : "inmediata";
  const poder = PODERES[fila.poder] ? fila.poder : null;
  return {
    id: String(fila.id ?? `regalo-${indice + 1}`).trim() || `regalo-${indice + 1}`,
    regalo: String(fila.regalo ?? `Regalo ${indice + 1}`).slice(0, 40),
    regaloId: String(fila.regaloId ?? "").slice(0, 24),
    cantidad: limitar(Math.round(Number(fila.cantidad) || 1), 1, 999),
    recompensa,
    vida: limitar(Math.round(Number(fila.vida) || 0), 0, 99999),
    poder,
    objetivo,
    enfriamiento: limitar(Number(fila.enfriamiento) || 0, 0, 600),
    acumulacion,
    activo: fila.activo !== false,
  };
}

/**
 * Motor de regalos de una ronda.
 *
 * Lleva los acumuladores (por ronda y por participante), la cola de eventos que
 * esperan a que el poder salga del enfriamiento, el historial y los rechazos.
 */
export class Regalos {
  constructor(parametros) {
    this.p = parametros;
    this.config = regalosDeEjemplo();
    this.origen = "ejemplos";
    this.historial = [];
    this.pendientes = [];
    this.acumuladoRonda = new Map();
    this.acumuladoParticipante = new Map();
    this.esperas = new Map(); // clave de regalo -> cuándo se puede volver a usar
    this.contadores = { enviados: 0, aplicados: 0, rechazados: 0, enEspera: 0, eventos: 0, vidaDada: 0, danioDeRegalos: 0, desconocidos: 0, enEsperaDeUsuario: 0 };
    // Regalos que han llegado sin estar en la tabla: se listan para poder configurarlos.
    this.desconocidos = [];
    // Recompensas apuntadas para quien espera sitio (no se pierde ninguna).
    this.usuariosPendientes = [];
    this.aviso = { texto: "", color: "#ffcc44", t: 0 };
  }

  // ------------------------------------------------------------ configuración

  /** Carga la configuración guardada (o los ejemplos si no hay archivo). */
  async cargar() {
    try {
      const respuesta = await fetch("/api/regalos", { cache: "no-store" });
      const datos = await respuesta.json();
      if (datos?.existe && Array.isArray(datos.regalos)) {
        this.config = {
          reglas: {
            siEnfriando: REGLAS_ESPERA[datos.reglas?.siEnfriando] ? datos.reglas.siEnfriando : "cola",
            excedente: datos.reglas?.excedente === "reiniciar" ? "reiniciar" : "conservar",
          },
          regalos: datos.regalos.map(normalizarRegalo),
        };
        this.origen = "datos/regalos.json";
      } else {
        this.usarEjemplos();
        this.origen = "ejemplos (sin archivo guardado)";
      }
    } catch {
      this.usarEjemplos();
      this.origen = "ejemplos (servidor sin API)";
    }
    return this.config;
  }

  async guardar() {
    const respuesta = await fetch("/api/regalos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.config),
    });
    const datos = await respuesta.json();
    if (!datos.ok) throw new Error(datos.error ?? "no se pudo guardar");
    this.origen = "datos/regalos.json";
    return datos;
  }

  usarEjemplos() {
    this.config = regalosDeEjemplo();
    this.config.regalos = this.config.regalos.map(normalizarRegalo);
  }

  restaurar() {
    this.usarEjemplos();
    this.limpiarHistorial();
    this.origen = "ejemplos";
    return this.config;
  }

  /** Exporta la configuración tal cual (lo que se descarga o se pega en otro sitio). */
  exportar() {
    return JSON.stringify({ version: 1, exportado: new Date().toISOString(), ...this.config }, null, 2);
  }

  /** Importa una configuración exportada. Devuelve cuántos regalos ha leído. */
  importar(texto) {
    const datos = JSON.parse(texto);
    if (!datos || !Array.isArray(datos.regalos)) throw new Error("el archivo no tiene regalos");
    this.config = {
      reglas: {
        siEnfriando: REGLAS_ESPERA[datos.reglas?.siEnfriando] ? datos.reglas.siEnfriando : "cola",
        excedente: datos.reglas?.excedente === "reiniciar" ? "reiniciar" : "conservar",
      },
      regalos: datos.regalos.map(normalizarRegalo),
    };
    this.origen = "importado";
    return this.config.regalos.length;
  }

  regaloPorId(id) {
    return this.config.regalos.find((r) => r.id === id) ?? null;
  }

  anadirRegalo(fila) {
    const claves = new Set(this.config.regalos.map((r) => r.id));
    let id = normalizarRegalo(fila, this.config.regalos.length).id;
    while (claves.has(id)) id = `${id}-2`;
    const nuevo = normalizarRegalo({ ...fila, id }, this.config.regalos.length);
    this.config.regalos.push(nuevo);
    return nuevo;
  }

  editarRegalo(id, cambios) {
    const i = this.config.regalos.findIndex((r) => r.id === id);
    if (i < 0) return null;
    this.config.regalos[i] = normalizarRegalo({ ...this.config.regalos[i], ...cambios, id }, i);
    return this.config.regalos[i];
  }

  quitarRegalo(id) {
    const antes = this.config.regalos.length;
    this.config.regalos = this.config.regalos.filter((r) => r.id !== id);
    return antes !== this.config.regalos.length;
  }

  // ------------------------------------------------------------ acumuladores

  /** Clave del acumulador según el modo de la fila. */
  claveAcumulador(fila, participanteId) {
    if (fila.acumulacion === "ronda") return `ronda:${fila.id}`;
    if (fila.acumulacion === "participante") return `p:${participanteId}:${fila.id}`;
    return "inmediata";
  }

  progreso(fila, participanteId) {
    if (fila.cantidad <= 1) return null;
    if (fila.acumulacion === "inmediata") return { lleva: 0, pide: fila.cantidad, texto: "se consume al llegar" };
    const clave = this.claveAcumulador(fila, participanteId);
    const mapa = fila.acumulacion === "ronda" ? this.acumuladoRonda : this.acumuladoParticipante;
    const lleva = mapa.get(clave) ?? 0;
    return { lleva, pide: fila.cantidad, texto: `${lleva}/${fila.cantidad}` };
  }

  /** Suma unidades y dice si toca aplicar la recompensa (y con cuánto se queda). */
  acumular(fila, participanteId, cantidad) {
    if (fila.cantidad <= 1 || fila.acumulacion === "inmediata") {
      return { dispara: true, restante: 0, progreso: null };
    }
    const mapa = fila.acumulacion === "ronda" ? this.acumuladoRonda : this.acumuladoParticipante;
    const clave = this.claveAcumulador(fila, participanteId);
    const lleva = (mapa.get(clave) ?? 0) + cantidad;
    if (lleva >= fila.cantidad) {
      const sobran = lleva - fila.cantidad;
      const restante = this.config.reglas.excedente === "conservar" ? sobran : 0;
      if (restante > 0) mapa.set(clave, restante);
      else mapa.delete(clave);
      return { dispara: true, restante, progreso: { lleva, pide: fila.cantidad } };
    }
    mapa.set(clave, lleva);
    return { dispara: false, restante: lleva, progreso: { lleva, pide: fila.cantidad } };
  }

  limpiarAcumuladores() {
    this.acumuladoRonda.clear();
    this.acumuladoParticipante.clear();
  }

  /** Al empezar una ronda se tiran los acumuladores de ronda y la cola. */
  nuevaRonda() {
    this.acumuladoRonda.clear();
    this.pendientes = [];
    this.esperas.clear();
  }

  // ------------------------------------------------------------ eventos

  /**
   * Busca la fila de la tabla por el regalo del evento: primero por el identificador
   * (`regaloId` de la configuración contra `giftId` de TikTok) y después por nombre,
   * porque hay regalos que llegan sin id utilizable.
   */
  porRegalo(evento) {
    const id = String(evento?.giftId ?? "").trim();
    const nombre = String(evento?.giftName ?? "").trim().toLowerCase();
    if (id) {
      const porId = this.config.regalos.find((r) => String(r.regaloId).trim() === id);
      if (porId) return porId;
    }
    if (nombre) {
      const porNombre = this.config.regalos.find((r) => r.regalo.trim().toLowerCase() === nombre);
      if (porNombre) return porNombre;
    }
    return null;
  }

  /**
   * Procesa un **evento normalizado** de TikTok (orden 06).
   *
   * Es el camino que usan tanto los eventos reales del bus como los simulados: no hay
   * ninguna ruta que se salte la tabla, la acumulación ni el enfriamiento.
   */
  procesarEvento(sim, evento, registro) {
    const fila = this.porRegalo(evento);
    const usuario = registro?.usuario ?? null;
    const cantidad = limitar(Math.round(Number(evento.cantidadNueva ?? evento.quantity) || 1), 1, 99);
    const meta = {
      origen: evento.origen ?? "app",
      eventId: evento.eventId,
      userId: evento.userId,
      userName: evento.userName,
      displayName: evento.displayName ?? usuario?.displayName,
      avatarUrl: evento.avatarUrl ?? usuario?.avatarUrl,
      giftId: evento.giftId,
      giftName: evento.giftName,
      repeatCount: evento.repeatCount,
      isFinal: evento.isFinal,
      simulado: Boolean(evento.simulado),
    };

    // Regalo que no está en la tabla: no se inventa nada, se registra y se apunta para
    // poder configurarlo después.
    if (!fila) {
      const clave = evento.giftId || evento.giftName || "sin identificar";
      const conocido = this.desconocidos.find((d) => d.clave === clave);
      if (conocido) {
        conocido.veces += 1;
        conocido.ultimaVez = Date.now();
      } else {
        this.desconocidos.unshift({
          clave,
          giftId: evento.giftId,
          giftName: evento.giftName,
          veces: 1,
          primeraVez: Date.now(),
          ultimaVez: Date.now(),
        });
        if (this.desconocidos.length > 40) this.desconocidos.length = 40;
      }
      this.contadores.desconocidos += 1;
      const aviso = this.registrar({
        id: `e${this.contadores.enviados + 1}`,
        momento: Number(sim.tiempoBatalla.toFixed(2)),
        donador: meta.displayName ?? "(desconocido)",
        donadorId: registro?.usuario?.participantId ?? null,
        regalo: evento.giftName || `(regalo ${clave})`,
        regaloId: evento.giftId ?? "",
        cantidad,
        recompensa: "—",
        poder: "—",
        objetivo: "—",
        vida: 0,
        danio: 0,
        estado: "desconocido",
        detalle: `regalo no configurado (${clave}): se registra para poder configurarlo`,
        progreso: null,
        ...meta,
      });
      sim.mensajes?.anunciar(`REGALO NO CONFIGURADO · ${evento.giftName || clave}`, "#9aa4b2", "poder", `de ${meta.displayName ?? "?"}`);
      return aviso;
    }

    this.contadores.enviados += 1;

    // En espera: no se pierde nada; la recompensa se apunta para cuando entre.
    if (registro?.estado === "espera") {
      const acumulado = this.acumular(fila, `espera:${evento.userId}`, cantidad);
      const apunte = {
        regaloId: fila.id,
        regalo: fila.regalo,
        cantidad,
        momento: Number(sim.tiempoBatalla.toFixed(2)),
        dispara: acumulado.dispara,
      };
      if (acumulado.dispara) {
        this.usuariosPendientes.push({ userId: evento.userId, regaloId: fila.id, cantidad, momento: apunte.momento });
      }
      return this.registrar({
        id: `e${this.contadores.enviados}`,
        momento: apunte.momento,
        donador: meta.displayName ?? "(desconocido)",
        donadorId: null,
        regalo: fila.regalo,
        regaloId: fila.regaloId,
        cantidad,
        recompensa: RECOMPENSAS[fila.recompensa].nombre,
        poder: fila.poder ? PODERES[fila.poder].nombre : "—",
        objetivo: OBJETIVOS[fila.objetivo].nombre,
        vida: 0,
        danio: 0,
        estado: "en espera",
        detalle: acumulado.dispara
          ? "recompensa apuntada: entra en la arena al liberarse un sitio"
          : `esperando sitio · ${acumulado.progreso ? `${acumulado.progreso.lleva}/${acumulado.progreso.pide}` : ""}`,
        progreso: acumulado.progreso ? `${acumulado.progreso.lleva}/${acumulado.progreso.pide}` : null,
        ...meta,
      });
    }

    return this.aplicar(sim, {
      fila,
      trompo: registro?.trompo ?? null,
      cantidad,
      meta,
      claveAcumulador: registro?.usuario?.participantId ?? registro?.usuario?.userId ?? null,
    });
  }

  /**
   * Aplica una recompensa a un trompo. Es el camino común del panel de pruebas y de los
   * eventos (reales o simulados): acumulación, enfriamiento, vida, poder y registro.
   */
  aplicar(sim, { fila, trompo, cantidad, meta = {}, claveAcumulador = null }) {
    const evento = {
      id: `e${this.contadores.enviados + 1}`,
      momento: Number(sim.tiempoBatalla.toFixed(2)),
      donador: trompo ? trompo.nombre : (meta.displayName ?? "(desconocido)"),
      donadorId: trompo ? trompo.id : null,
      regalo: fila ? fila.regalo : `(regalo ${meta.giftId ?? "?"} sin configurar)`,
      regaloId: fila ? fila.regaloId : (meta.giftId ?? ""),
      cantidad,
      recompensa: fila ? RECOMPENSAS[fila.recompensa].nombre : "—",
      poder: fila && fila.poder ? PODERES[fila.poder].nombre : "—",
      objetivo: fila ? OBJETIVOS[fila.objetivo].nombre : "—",
      vida: 0,
      danio: 0,
      estado: "aplicado",
      detalle: "",
      progreso: null,
      ...meta,
    };
    if (!fila) {
      evento.estado = "rechazado";
      evento.detalle = "ese regalo no está en la tabla";
      this.contadores.rechazados += 1;
      return this.registrar(evento);
    }
    if (!fila.activo) {
      evento.estado = "rechazado";
      evento.detalle = "el regalo está desactivado en la tabla";
      this.contadores.rechazados += 1;
      return this.registrar(evento);
    }
    if (!trompo) {
      evento.estado = "rechazado";
      evento.detalle = "no hay ningún participante con ese identificador";
      this.contadores.rechazados += 1;
      return this.registrar(evento);
    }
    if (trompo.estado === "ko" || trompo.estado === "fuera") {
      // Eliminado: no se revive, y queda registrado. (Durante la cuenta atrás el trompo
      // no está «activo» pero el regalo sí cuenta: no se pierde nada.)
      evento.estado = "rechazado";
      evento.detalle = `${trompo.nombre} está eliminado: el regalo no se puede aplicar (no se revive en esta fase)`;
      this.contadores.rechazados += 1;
      return this.registrar(evento);
    }
    // Enfriamiento propio del regalo (independiente del de los poderes).
    const claveEspera = `${fila.id}:${trompo.id}`;
    const libreEn = this.esperas.get(claveEspera) ?? 0;
    if (libreEn > sim.tiempoBatalla) {
      evento.estado = "rechazado";
      evento.detalle = `el regalo está en enfriamiento (${(libreEn - sim.tiempoBatalla).toFixed(1)} s)`;
      this.contadores.rechazados += 1;
      return this.registrar(evento);
    }

    // Acumulación: puede que todavía no toque.
    const acumulado = this.acumular(fila, claveAcumulador ?? trompo.id, cantidad);
    evento.progreso = acumulado.progreso ? `${acumulado.progreso.lleva}/${acumulado.progreso.pide}` : null;
    if (!acumulado.dispara) {
      evento.estado = "acumulando";
      evento.detalle = `${acumulado.progreso.lleva} de ${acumulado.progreso.pide} ${fila.regalo}`;
      return this.registrar(evento);
    }

    // Recompensa.
    if (fila.recompensa === "vida" || fila.recompensa === "vida_poder") {
      this.aplicarVida(trompo, fila.vida, evento, sim);
    }
    if (fila.recompensa === "poder" || fila.recompensa === "vida_poder") {
      this.lanzarPoder(sim, trompo, fila, evento);
    }
    if (fila.recompensa === "evento") {
      this.eventoEspecial(sim, trompo, fila, evento);
    }
    if (fila.enfriamiento > 0) {
      this.esperas.set(claveEspera, sim.tiempoBatalla + fila.enfriamiento);
      evento.detalle = `${evento.detalle}${evento.detalle ? " · " : ""}regalo en enfriamiento ${fila.enfriamiento} s`;
    }
    this.contadores.aplicados += 1;
    return this.registrar(evento);
  }

  /**
   * Envía un regalo a mano desde el taller de la fase 5 (sin evento de TikTok).
   *
   * @param sim    la simulación (para tocar trompos, vida y poderes)
   * @param datos  { participanteId, regaloId, cantidad }
   */
  enviar(sim, datos) {
    const fila = this.regaloPorId(datos.regaloId);
    const trompo = sim.trompos.find((t) => t.id === datos.participanteId);
    const cantidad = limitar(Math.round(Number(datos.cantidad) || 1), 1, 99);
    this.contadores.enviados += 1;
    return this.aplicar(sim, {
      fila,
      trompo,
      cantidad,
      meta: { origen: "taller", simulado: false },
    });
  }

  /** Vida: sube sin pasar del máximo y se ve en el anillo y en la tabla. */
  aplicarVida(trompo, cantidad, evento, sim) {
    if (cantidad <= 0) return;
    const antes = trompo.vida;
    trompo.vida = Math.min(trompo.vidaMax, trompo.vida + cantidad);
    const real = Math.round(trompo.vida - antes);
    evento.vida = real;
    this.contadores.vidaDada += real;
    if (real <= 0) {
      evento.detalle = "ya tenía la vida al máximo";
      return;
    }
    // Animación verde/dorada: número flotante, destello y chispas hacia arriba.
    if (sim) {
      sim.efectos.texto(trompo.x, trompo.y - trompo.radio * 1.8, `+${real}`, "#4ade80", trompo.radio);
      sim.efectos.destello(trompo.x, trompo.y, "#4ade80", 90, trompo.radio * 2);
      for (let i = 0; i < 14; i += 1) {
        sim.efectos.energia(trompo.x, trompo.y, i % 2 === 0 ? "#4ade80" : "#ffd76a", 1.4, trompo.radio * 1.2);
      }
      sim.tabla.firma = "";
      sim.actualizarClasificacion(0, true);
      sim.sonido.tocar("poderEscudo", { intensidad: 0.5 });
    }
  }

  /**
   * Poder del regalo: se lanza **desde el trompo del donador**, con el objetivo
   * configurado y respetando su enfriamiento.
   */
  lanzarPoder(sim, trompo, fila, evento) {
    const clave = fila.poder;
    if (!clave) {
      evento.detalle = "la fila no tiene poder configurado";
      return;
    }
    const estadoAntes = sim.poderes.deUnTrompo(trompo);
    const enfriando = (trompo.poder?.enfriamientos?.[clave] ?? 0) > 0;
    const ocupado = trompo.poder?.estado !== "listo";

    if (enfriando || ocupado) {
      const regla = this.config.reglas.siEnfriando;
      const restante = Number((trompo.poder?.enfriamientos?.[clave] ?? 0).toFixed(1));
      if (regla === "ignorar") {
        evento.estado = "rechazado";
        evento.detalle = `${PODERES[clave].nombre} está en enfriamiento (${restante} s) y la regla es ignorar`;
        this.contadores.rechazados += 1;
        // Se registra igual: un regalo nunca se pierde en silencio.
        this.registrar(evento);
        return;
      }
      if (regla === "primer_disponible") {
        const alternativa = ORDEN_PODERES.find(
          (c) => c !== clave && (trompo.poder?.enfriamientos?.[c] ?? 0) <= 0 && trompo.poder?.estado === "listo",
        );
        if (alternativa) {
          const usado = sim.activarPoder(trompo.id, alternativa, true, fila.objetivo);
          evento.poder = PODERES[alternativa].nombre;
          evento.estado = "aplicado";
          evento.detalle = `${PODERES[clave].nombre} estaba en enfriamiento: se lanzó ${PODERES[alternativa].nombre}`;
          this.apuntarObjetivo(usado, evento);
          return;
        }
      }
      // Regla por defecto: a la cola, sin perder el evento.
      this.pendientes.push({
        momento: Number(sim.tiempoBatalla.toFixed(2)),
        donador: trompo.nombre,
        donadorId: trompo.id,
        regalo: fila.regalo,
        clave,
        objetivo: fila.objetivo,
        enfriamientoRestante: restante,
        eventoId: evento.id,
      });
      this.contadores.enEspera += 1;
      evento.estado = "en cola";
      evento.detalle = `${PODERES[clave].nombre} en enfriamiento (${restante} s): queda en cola (${this.pendientes.length} pendientes)`;
      void estadoAntes;
      return;
    }

    const usado = sim.activarPoder(trompo.id, clave, true, fila.objetivo);
    evento.estado = "lanzado";
    evento.clavePoder = clave;
    evento.abierto = true;
    if (!usado) evento.detalle = "no se pudo lanzar el poder";
    this.apuntarObjetivo(usado, evento);
  }

  /**
   * Cierra los eventos cuyo poder ya ha terminado: hasta entonces no se sabe a quién
   * ha tocado ni cuánto daño ha hecho (el cristal, por ejemplo, vuela antes de
   * reventar). Mientras están abiertos se van actualizando.
   */
  cerrarEventos(sim) {
    for (const ev of this.historial) {
      if (!ev.abierto || !ev.clavePoder) continue;
      const t = sim.trompos.find((x) => x.id === ev.donadorId);
      if (!t || !t.poder || t.poder.clave !== ev.clavePoder) continue;
      const datos = t.poder.datos ?? {};
      if (datos.danioHecho) ev.danio = Math.round(datos.danioHecho);
      if (datos.objetivos?.length) ev.objetivoDado = datos.objetivos.join(", ");
      ev.enfriamientoRestante = Number((t.poder.enfriamientos?.[ev.clavePoder] ?? 0).toFixed(1));
      if (t.poder.estado !== "cargando" && t.poder.estado !== "activo") {
        ev.estado = "aplicado";
        ev.abierto = false;
      }
    }
  }

  /** Anota a quién ha golpeado o afectado el poder, para el historial. */
  apuntarObjetivo(usado, evento) {
    if (!usado) return;
    evento.objetivoDado = usado.objetivoResumen ?? "—";
    evento.danio = Math.round(usado.danio ?? 0);
  }

  /** Evento especial: señal visual clara y registro, sin tocar la física. */
  eventoEspecial(sim, trompo, fila, evento) {
    this.contadores.eventos += 1;
    evento.detalle = "evento especial: aviso global (los efectos llegarán en otra fase)";
    this.aviso = { texto: `${fila.regalo.toUpperCase()} · EVENTO ESPECIAL DE ${trompo.nombre.toUpperCase()}`, color: "#ff9ec7", t: 3.5 };
    if (sim) {
      sim.mensajes.anunciar(`EVENTO ESPECIAL: ${fila.regalo}`, "#ff9ec7", "evento", `de ${trompo.nombre}`, {
        nombre: trompo.nombre,
        inicial: trompo.inicial,
        foto: trompo.foto,
        color: trompo.color,
      });
      sim.efectos.onda(trompo.x, trompo.y, "#ff9ec7", 260, 460);
      sim.sonido.tocar("poderCampo", { intensidad: 0.8 });
    }
  }

  registrar(evento) {
    this.historial.unshift(evento);
    if (this.historial.length > 120) this.historial.length = 120;
    return evento;
  }

  limpiarHistorial() {
    this.historial = [];
    this.desconocidos = [];
    this.contadores.rechazados = 0;
    this.contadores.aplicados = 0;
    this.contadores.enviados = 0;
    this.contadores.enEspera = 0;
    this.contadores.eventos = 0;
    this.contadores.vidaDada = 0;
  }

  /** Cada paso: cierra los eventos ya resueltos y saca de la cola lo que pueda salir. */
  actualizar(dt, sim) {
    if (this.aviso.t > 0) this.aviso.t = Math.max(0, this.aviso.t - dt);
    this.cerrarEventos(sim);
    if (!this.pendientes.length) return;
    for (let i = 0; i < this.pendientes.length; i += 1) {
      const pend = this.pendientes[i];
      const trompo = sim.trompos.find((t) => t.id === pend.donadorId);
      // Se descarta sólo si el donador ya no está en la ronda. Mientras está apareciendo
      // (o eliminado, esperando el final) el evento se guarda: no se pierde ninguno.
      if (!trompo || trompo.estado === "fuera") {
        this.pendientes.splice(i, 1);
        i -= 1;
        continue;
      }
      if (trompo.estado === "ko") continue;
      if (trompo.poder?.estado !== "listo") continue;
      if ((trompo.poder?.enfriamientos?.[pend.clave] ?? 0) > 0) continue;
      this.pendientes.splice(i, 1);
      i -= 1;
      this.contadores.enEspera = Math.max(0, this.contadores.enEspera - 1);
      const usado = sim.activarPoder(trompo.id, pend.clave, true, pend.objetivo);
      const evento = this.historial.find((e) => e.id === pend.eventoId);
      if (evento) {
        evento.estado = "lanzado";
        evento.clavePoder = pend.clave;
        evento.abierto = true;
        evento.detalle = `lanzado al salir del enfriamiento (esperó desde ${pend.momento} s)`;
        this.apuntarObjetivo(usado, evento);
      }
      this.contadores.aplicados += 1;
    }
  }

  /** Estado para el taller y para el banco de pruebas. */
  estado() {
    const danioDeRegalos = this.historial.reduce((suma, e) => suma + (e.danio ?? 0), 0);
    return {
      origen: this.origen,
      reglas: { ...this.config.reglas },
      regalos: this.config.regalos.map((r) => ({ ...r })),
      contadores: { ...this.contadores, danioDeRegalos },
      // Regalos que han llegado sin estar en la tabla (orden 06): se listan para
      // poder configurarlos después, sin haber inventado ninguna recompensa.
      desconocidos: this.desconocidos.map((d) => ({ ...d })),
      usuariosPendientes: this.usuariosPendientes.map((u) => ({ ...u })),
      pendientes: this.pendientes.map((p) => ({ ...p })),
      historial: this.historial.slice(0, 40).map((e) => ({ ...e })),
      progreso: this.config.regalos
        .filter((r) => r.cantidad > 1)
        .map((r) => ({
          regalo: r.regalo,
          cantidad: r.cantidad,
          acumulacion: r.acumulacion,
          porRonda: this.acumuladoRonda.get(`ronda:${r.id}`) ?? 0,
          porParticipante: [...this.acumuladoParticipante.entries()]
            .filter(([k]) => k.endsWith(`:${r.id}`))
            .map(([k, v]) => ({ clave: k, lleva: v })),
        })),
    };
  }
}
