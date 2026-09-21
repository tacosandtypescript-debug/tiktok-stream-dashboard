// Puente con TikTok (orden 06).
//
// **No abre ninguna conexión nueva con TikTok.** El motor de la aplicación ya tiene su
// proveedor nativo y publica los eventos normalizados por WebSocket en
// `ws://127.0.0.1:8790/api/eventos` (lo mismo que consumen los overlays). El prototipo
// se suscribe a ese bus: si el día de mañana cambia el proveedor, aquí no se toca nada.
//
// Este módulo es un **módulo ES puro**: no toca el DOM, así que lo usan el navegador y
// `servidor.mjs` (para la ruta de ingesta) con exactamente el mismo normalizador. Esa es
// la garantía de que lo simulado y lo real pasan por el mismo camino.
//
// Contrato del bus (protocolo 1 del motor, `apps/desktop/src-tauri/src/core/event.rs`):
//
//   { protocol_version, event_id, seq, timestamp_ms, room_id, source_id?,
//     type: "gift.received",
//     user: { id, unique_id, nickname, avatar_url? },
//     gift: { id, name, image_url?, diamond_count, streakable, repeat_count,
//             is_final, group_id } }
//
// De ahí sale el evento normalizado con el que trabaja el juego:
//
//   { eventId, protocolo, userId, userName, displayName, avatarUrl, giftId, giftName,
//     quantity, repeatCount, isFinal, diamantes, grupoId, acumulable, salaId, seq,
//     recibidoEn, marca, origen }
//
// El motor del juego **no** conoce el formato del proveedor: sólo este.

/** Versión del protocolo del motor que entiende este puente. */
export const PROTOCOLO = 1;

/** Puerto por defecto del servidor web del motor (donde vive el bus de eventos). */
export const PUERTO_MOTOR = 8790;

/** Estados de la conexión, tal cual se enseñan en el taller. */
export const ESTADOS_CONEXION = {
  desconectado: { clave: "desconectado", nombre: "Desconectado", color: "#9aa4b2" },
  conectando: { clave: "conectando", nombre: "Conectando", color: "#ffcc44" },
  conectado: { clave: "conectado", nombre: "Conectado", color: "#4ade80" },
  esperando: { clave: "esperando", nombre: "Esperando al directo", color: "#63b4ff" },
  reconectando: { clave: "reconectando", nombre: "Reconectando", color: "#ffa53d" },
  error: { clave: "error", nombre: "Error", color: "#ff5a3c" },
};

/** Cuántos eventos recientes se recuerdan para no procesarlos dos veces (10 min). */
export const EXPIRACION_DEDUP = 10 * 60 * 1000;
const MAXIMO_DEDUP = 4000;

function texto(valor, porDefecto = "") {
  const salida = valor === undefined || valor === null ? "" : String(valor).trim();
  return salida || porDefecto;
}

function numero(valor, porDefecto = 0) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
}

/**
 * Normaliza un evento del bus (o de cualquier otro emisor) al formato del juego.
 *
 * Devuelve `null` si el evento no es un regalo o si no se puede identificar al usuario:
 * un evento sin `userId` no se puede atribuir a nadie y **no se inventa** un donador.
 */
export function normalizarEvento(crudo, opciones = {}) {
  if (!crudo || typeof crudo !== "object") return null;
  const tipo = texto(crudo.type ?? crudo.tipo);
  if (tipo && !tipo.startsWith("gift.")) return null;

  const usuario = crudo.user ?? crudo.usuario ?? {};
  const regalo = crudo.gift ?? crudo.regalo ?? {};

  const userId = texto(usuario.id ?? usuario.userId ?? crudo.userId);
  if (!userId) return null;

  const userName = texto(usuario.unique_id ?? usuario.userName ?? crudo.userName);
  const displayName = texto(usuario.nickname ?? usuario.displayName ?? crudo.displayName, userName || userId);
  const avatarUrl = texto(usuario.avatar_url ?? usuario.avatarUrl ?? crudo.avatarUrl);

  const repeatCount = Math.max(1, Math.round(numero(regalo.repeat_count ?? crudo.repeatCount ?? crudo.quantity, 1)));
  const giftId = texto(regalo.id ?? crudo.giftId);
  const giftName = texto(regalo.name ?? crudo.giftName);
  const grupoId = texto(regalo.group_id ?? crudo.grupoId);
  const marca = numero(crudo.timestamp_ms ?? crudo.marca, opciones.ahora ?? Date.now());
  const recibidoEn = numero(opciones.ahora ?? crudo.recibidoEn, Date.now());

  // Identificador del evento: el del motor si lo trae; si no, una clave compuesta que
  // incluye la marca de tiempo y el avance de la racha, para no confundir dos regalos
  // distintos del mismo usuario.
  const eventId =
    texto(crudo.event_id ?? crudo.eventId) ||
    `${userId}|${giftId || giftName}|${grupoId}|${repeatCount}|${marca}`;

  return {
    eventId,
    protocolo: numero(crudo.protocol_version ?? crudo.protocolo, PROTOCOLO),
    userId,
    userName: userName || displayName,
    displayName,
    avatarUrl,
    giftId,
    giftName,
    // `quantity` es lo que se aplica; con rachas lo ajusta el control de rachas.
    quantity: repeatCount,
    repeatCount,
    isFinal: Boolean(regalo.is_final ?? crudo.isFinal),
    diamantes: numero(regalo.diamond_count ?? crudo.diamantes, 0),
    acumulable: Boolean(regalo.streakable ?? crudo.acumulable),
    grupoId,
    salaId: texto(crudo.room_id ?? crudo.salaId),
    seq: numero(crudo.seq, 0),
    recibidoEn,
    marca,
    origen: texto(crudo.__origen ?? crudo.origen, "app"),
  };
}

/**
 * Idempotencia: recuerda los eventos ya vistos y los descarta al repetirse.
 *
 * Usa `eventId` y, si el emisor no lo manda, la clave compuesta del normalizador. Los
 * eventos caducan (10 minutos) para no crecer sin freno; pasada la expiración, un
 * reenvío del mismo evento volvería a contar, cosa que a esa distancia ya no ocurre.
 */
export class Deduplicador {
  constructor(expiracion = EXPIRACION_DEDUP, maximo = MAXIMO_DEDUP) {
    this.expiracion = expiracion;
    this.maximo = maximo;
    this.vistos = new Map();
    this.duplicados = 0;
    this.ultimoDuplicado = null;
  }

  /** ¿Está repetido? Si no lo estaba, lo apunta. */
  repetido(eventId, ahora = Date.now()) {
    this.limpiar(ahora);
    const previo = this.vistos.get(eventId);
    if (previo !== undefined) {
      this.duplicados += 1;
      this.ultimoDuplicado = { eventId, cuando: ahora, primero: previo };
      return true;
    }
    this.vistos.set(eventId, ahora);
    if (this.vistos.size > this.maximo) {
      // Fuera los más viejos: el Map conserva el orden de inserción.
      const sobran = this.vistos.size - this.maximo;
      let i = 0;
      for (const clave of this.vistos.keys()) {
        this.vistos.delete(clave);
        i += 1;
        if (i >= sobran) break;
      }
    }
    return false;
  }

  limpiar(ahora = Date.now()) {
    for (const [clave, cuando] of this.vistos) {
      if (ahora - cuando > this.expiracion) this.vistos.delete(clave);
    }
  }

  reiniciar() {
    this.vistos.clear();
    this.duplicados = 0;
    this.ultimoDuplicado = null;
  }
}

/**
 * Control de rachas.
 *
 * TikTok manda **actualizaciones parciales** de la misma racha: cada evento trae el
 * total acumulado (`repeat_count`) de ese `group_id`, y el último llega con
 * `is_final`. Aquí se calcula sólo la **diferencia nueva**, así que cinco
 * actualizaciones de una racha de cinco no cuentan veinticinco: cuentan cinco.
 */
export class Rachas {
  constructor() {
    this.abiertas = new Map(); // grupoId -> { total, actualizado }
    this.gruposVistos = 0;
  }

  /**
   * Devuelve cuántas unidades NUEVAS trae el evento (0 si no aporta nada).
   */
  nuevas(evento) {
    const grupo = evento.grupoId || `suelto:${evento.eventId}`;
    const previo = this.abiertas.get(grupo);
    const total = Math.max(1, evento.repeatCount);
    let nuevas;
    if (!previo) {
      this.gruposVistos += 1;
      nuevas = total;
    } else {
      nuevas = total - previo.total;
    }
    if (nuevas > 0) {
      this.abiertas.set(grupo, { total, actualizado: evento.marca });
    }
    // Con `is_final` la racha se cierra: el siguiente regalo del mismo grupo empieza
    // a contar desde cero.
    if (evento.isFinal) this.abiertas.delete(grupo);
    else if (!previo && !evento.grupoId) this.abiertas.delete(grupo);
    return Math.max(0, nuevas);
  }

  reiniciar() {
    this.abiertas.clear();
    this.gruposVistos = 0;
  }
}

/**
 * Conexión con el bus del motor.
 *
 * Todo evento —real, del puente o simulado— entra por `enviarCrudo()`. No hay ninguna
 * ruta que se salte el normalizador, y por eso lo que se prueba en simulado es el mismo
 * camino que lo real.
 */
export class ConexionTikTok {
  constructor(opciones = {}) {
    this.url = opciones.url ?? `ws://127.0.0.1:${PUERTO_MOTOR}/api/eventos`;
    this.alEvento = opciones.alEvento ?? (() => {});
    this.alCambio = opciones.alCambio ?? (() => {});
    this.WebSocketImpl = opciones.WebSocketImpl ?? globalThis.WebSocket ?? null;
    this.estado = "desconectado";
    this.detalle = "";
    this.modo = opciones.modo ?? "simulado"; // "real" | "simulado"
    this.mudo = false; // silenciar los eventos de prueba
    this.socket = null;
    this.intentos = 0;
    this.reconexiones = 0;
    this.deseado = false;
    this.temporizador = null;
    this.deduplicador = new Deduplicador();
    this.rachas = new Rachas();
    this.contadores = {
      recibidos: 0,
      procesados: 0,
      duplicados: 0,
      desconocidos: 0,
      sinUsuario: 0,
      noRegalo: 0,
      repetidosDeRacha: 0,
      simulados: 0,
      reenviados: 0,
    };
    this.ultimoEvento = null;
    this.ultimoCrudo = null;
    this.registro = [];
    this.desde = Date.now();
    this.esperaBase = opciones.esperaBase ?? 1000;
    this.esperaMaxima = opciones.esperaMaxima ?? 15000;
    // Puente HTTP del servidor del prototipo (segunda fuente de eventos reales).
    this.puenteActivo = false;
    this.puenteTimer = null;
    this.puenteDesde = 0;
  }

  estadoVisible() {
    return ESTADOS_CONEXION[this.estado] ?? ESTADOS_CONEXION.desconectado;
  }

  cambiar(estado, detalle = "") {
    if (this.estado === estado && this.detalle === detalle) return;
    this.estado = estado;
    this.detalle = detalle;
    this.alCambio(this.estadoVisible(), detalle);
  }

  anotar(texto, tipo = "info") {
    this.registro.unshift({ cuando: Date.now(), texto, tipo });
    if (this.registro.length > 60) this.registro.length = 60;
  }

  /** Modo real o simulado. Son excluyentes: un evento sólo se procesa una vez. */
  usarModo(modo) {
    if (modo !== "real" && modo !== "simulado") return this.modo;
    if (this.modo === modo) return this.modo;
    this.modo = modo;
    this.anotar(`modo ${modo}`, "modo");
    if (modo === "simulado") this.desconectar("modo simulado");
    else if (!this.puenteActivo) this.cambiar("desconectado", "pulsa Conectar para escuchar el bus del motor");
    return this.modo;
  }

  /** Se suscribe al bus del motor. Si falla, se reintenta con espera progresiva. */
  conectar() {
    if (!this.WebSocketImpl) {
      this.cambiar("error", "este navegador no tiene WebSocket");
      return false;
    }
    this.deseado = true;
    this.usarModo("real");
    this.abrir();
    return true;
  }

  abrir() {
    if (this.socket) return;
    this.cambiar(this.intentos > 0 ? "reconectando" : "conectando", this.url);
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.cambiar("error", String(error?.message ?? error));
      this.programarReintento();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.intentos = 0;
      this.cambiar("conectado", this.url);
      this.anotar("conectado al bus del motor", "ok");
    };
    socket.onmessage = (mensaje) => {
      let crudo;
      try {
        crudo = JSON.parse(typeof mensaje.data === "string" ? mensaje.data : "{}");
      } catch {
        this.anotar("mensaje ilegible del bus", "error");
        return;
      }
      crudo.__origen = "app";
      this.enviarCrudo(crudo);
    };
    socket.onerror = () => {
      this.anotar("error de conexión con el bus", "error");
    };
    socket.onclose = () => {
      this.socket = null;
      if (!this.deseado) {
        this.cambiar("desconectado", "desconectado a mano");
        return;
      }
      // Se perdió: se reintenta sin tocar la batalla, los participantes ni los eventos
      // ya procesados (el deduplicador sigue vivo).
      this.cambiar("reconectando", `sin bus del motor (intento ${this.intentos + 1})`);
      this.programarReintento();
    };
  }

  programarReintento() {
    if (!this.deseado || this.temporizador) return;
    this.intentos += 1;
    const espera = Math.min(this.esperaMaxima, this.esperaBase * 2 ** Math.min(6, this.intentos - 1));
    clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => {
      this.temporizador = null;
      if (!this.deseado) return;
      this.reconexiones += 1;
      this.abrir();
    }, espera);
  }

  /**
   * Escucha el **puente del servidor del prototipo**: los eventos que un listener
   * autorizado deja en `POST /api/tiktok/evento`. Sirve para probar la ruta real sin
   * depender del motor, y no duplica nada: si el mismo evento llega también por el bus,
   * el deduplicador lo tira.
   */
  usarPuente(activar = true) {
    this.puenteActivo = Boolean(activar);
    if (!this.puenteActivo) {
      if (this.puenteTimer) clearTimeout(this.puenteTimer);
      this.puenteTimer = null;
      return false;
    }
    this.usarModo("real");
    this.cambiar("conectado", "puente del servidor (HTTP)");
    this.anotar("escuchando el puente del servidor", "ok");
    this.latirPuente();
    return true;
  }

  async latirPuente() {
    if (!this.puenteActivo) return;
    try {
      const respuesta = await fetch(`/api/tiktok/eventos?desde=${this.puenteDesde}`);
      const datos = await respuesta.json();
      if (datos?.ok) {
        this.puenteDesde = datos.total;
        for (const evento of datos.eventos ?? []) this.enviarCrudo(evento, { origen: "puente" });
      }
    } catch {
      this.cambiar("reconectando", "sin puente del servidor");
    }
    this.puenteTimer = setTimeout(() => this.latirPuente(), 700);
  }

  desconectar(motivo = "a mano") {
    this.deseado = false;
    this.puenteActivo = false;
    if (this.puenteTimer) {
      clearTimeout(this.puenteTimer);
      this.puenteTimer = null;
    }
    if (this.temporizador) {
      clearTimeout(this.temporizador);
      this.temporizador = null;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close();
      } catch {
        /* da igual: ya no hay nada que cerrar */
      }
    }
    this.intentos = 0;
    this.cambiar("desconectado", motivo);
    this.anotar(`desconectado (${motivo})`, "info");
  }

  /**
   * ÚNICO punto de entrada de eventos.
   *
   * 1. se normaliza (o se descarta si no es un regalo atribuible),
   * 2. se comprueba que no esté repetido,
   * 3. se calcula lo nuevo de la racha,
   * 4. se entrega al juego.
   */
  enviarCrudo(crudo, opciones = {}) {
    const ahora = Date.now();
    this.contadores.recibidos += 1;
    this.ultimoCrudo = opciones.guardarCrudo === false ? this.ultimoCrudo : crudo;
    const evento = normalizarEvento(crudo, { ahora });
    if (!evento) {
      const tipo = texto(crudo?.type ?? crudo?.tipo);
      if (tipo && !tipo.startsWith("gift.")) this.contadores.noRegalo += 1;
      else {
        this.contadores.sinUsuario += 1;
        this.anotar(`evento sin usuario atribuible (${tipo || "sin tipo"})`, "aviso");
      }
      return null;
    }
    if (this.deduplicador.repetido(evento.eventId, ahora)) {
      this.contadores.duplicados += 1;
      this.anotar(`duplicado ignorado: ${evento.eventId}`, "duplicado");
      return { ...evento, duplicado: true, cantidadNueva: 0 };
    }
    const cantidadNueva = this.rachas.nuevas(evento);
    if (cantidadNueva === 0) {
      this.contadores.repetidosDeRacha += 1;
      this.anotar(`racha sin unidades nuevas (${evento.giftName})`, "duplicado");
      return { ...evento, cantidadNueva: 0, sinNovedad: true };
    }
    const completo = {
      ...evento,
      cantidadNueva,
      origen: opciones.origen ?? evento.origen,
      simulado: Boolean(opciones.simulado),
    };
    this.ultimoEvento = completo;
    this.contadores.procesados += 1;
    if (completo.simulado) this.contadores.simulados += 1;
    if (!this.mudo || !completo.simulado) this.alEvento(completo);
    else this.anotar(`evento de prueba silenciado: ${completo.giftName}`, "modo");
    return completo;
  }

  /** Contadores y estado para el taller. */
  estadoActual() {
    return {
      estado: this.estado,
      visible: this.estadoVisible(),
      detalle: this.detalle,
      url: this.url,
      modo: this.modo,
      mudo: this.mudo,
      intentos: this.intentos,
      reconexiones: this.reconexiones,
      contadores: { ...this.contadores, duplicados: this.deduplicador.duplicados },
      ultimoEvento: this.ultimoEvento,
      ultimoDuplicado: this.deduplicador.ultimoDuplicado,
      registro: this.registro.slice(0, 20),
      rachasAbiertas: this.rachas.abiertas.size,
      puente: this.puenteActivo,
      desde: this.desde,
    };
  }
}

/**
 * Los doce escenarios de prueba de la orden, como eventos **crudos del bus**: entran por
 * `enviarCrudo()` igual que los reales, así que la prueba recorre el mismo camino.
 */
export function eventoDePrueba(escenario, datos = {}) {
  const ahora = Date.now();
  const usuario = (id, nombre, display) => ({
    id,
    unique_id: nombre,
    nickname: display ?? nombre,
    avatar_url: "",
  });
  const regalo = (id, nombre, repeat, extra = {}) => ({
    id,
    name: nombre,
    diamond_count: 1,
    streakable: false,
    repeat_count: repeat,
    is_final: true,
    group_id: "",
    ...extra,
  });
  const sobre = (tipo, user, gift, extra = {}) => ({
    protocol_version: PROTOCOLO,
    event_id: `prueba-${escenario}-${ahora}-${Math.floor(Math.random() * 1e6)}`,
    seq: 0,
    timestamp_ms: ahora,
    room_id: "prueba",
    type: tipo,
    user,
    gift,
    __origen: "prueba",
    ...extra,
  });
  switch (escenario) {
    case "usuario-nuevo":
      return sobre(
        "gift.received",
        usuario(`nuevo-${ahora}`, `nuevo_${ahora % 100000}`, "Espectador Nuevo"),
        regalo("5655", "Rosa", 1),
      );
    case "rosa":
      return sobre("gift.received", datos.user ?? usuario("u-mariana", "mariana", "Mariana"), regalo("5655", "Rosa", 1));
    case "dona":
      return sobre("gift.received", datos.user ?? usuario("u-mariana", "mariana", "Mariana"), regalo("5658", "Dona", 1));
    case "acumulado":
      return sobre(
        "gift.received",
        datos.user ?? usuario("u-carlos", "carlos", "Carlos"),
        regalo("5661", "Estrella", datos.repeat ?? 3),
      );
    case "enfriamiento":
      return sobre("gift.received", datos.user ?? usuario("u-lupe", "lupe", "Lupe"), regalo("5660", "Universo", 1));
    case "desconocido":
      return sobre("gift.received", datos.user ?? usuario("u-ana", "ana", "Ana"), regalo("9999", "Regalo Raro", 1));
    case "repetido":
      return sobre("gift.received", datos.user ?? usuario("u-juan", "juan", "Juan"), regalo("5655", "Rosa", 1), {
        event_id: datos.eventId ?? `prueba-repetido-${ahora}`,
      });
    case "duplicado":
      // El mismo `event_id` dos veces: el segundo lo tiene que ignorar el deduplicador.
      return sobre("gift.received", datos.user ?? usuario("u-sofi", "sofi", "Sofi"), regalo("5655", "Rosa", 1), {
        event_id: datos.eventId ?? `prueba-duplicado-${ahora}`,
      });
    case "racha-parcial":
      // Actualizaciones parciales de la misma racha: sólo cuenta la diferencia.
      return sobre(
        "gift.received",
        datos.user ?? usuario("u-drako", "drako", "Drako"),
        regalo("5664", "Galaxia", datos.repeat ?? 1, {
          streakable: true,
          group_id: datos.grupo ?? "racha-1",
          is_final: Boolean(datos.final),
        }),
      );
    case "espera":
      return sobre("gift.received", datos.user ?? usuario("u-espera", "espera", "Nuevo en espera"), regalo("5655", "Rosa", 1));
    case "eliminado":
      return sobre("gift.received", datos.user ?? usuario("u-muerto", "muerto", "Eliminado"), regalo("5655", "Rosa", 1));
    case "evento-especial":
      return sobre("gift.received", datos.user ?? usuario("u-vane", "vane", "Vanessa"), regalo("5665", "Fuego", 4));
    default:
      return null;
  }
}

/** Nombres de los escenarios de prueba, en el orden en que se enseñan. */
export const ESCENARIOS = [
  { clave: "usuario-nuevo", nombre: "Usuario nuevo", detalle: "crea participante, diseño y vida" },
  { clave: "rosa", nombre: "Rosa", detalle: "regalo de vida" },
  { clave: "dona", nombre: "Dona", detalle: "regalo de poder" },
  { clave: "acumulado", nombre: "Estrella ×3", detalle: "cantidad acumulada" },
  { clave: "enfriamiento", nombre: "Universo", detalle: "poder en enfriamiento" },
  { clave: "desconocido", nombre: "Regalo Raro", detalle: "regalo no configurado" },
  { clave: "racha-parcial", nombre: "Galaxia 1/3/5", detalle: "actualización parcial de racha" },
  { clave: "repetido", nombre: "Rosa repetida", detalle: "usuario que ya existe" },
  { clave: "duplicado", nombre: "Evento duplicado", detalle: "el mismo eventId dos veces" },
  { clave: "eliminado", nombre: "Eliminado", detalle: "no se revive, se registra" },
  { clave: "espera", nombre: "En espera", detalle: "arena llena: a la cola" },
  { clave: "evento-especial", nombre: "Fuego", detalle: "evento especial (aviso global)" },
];
