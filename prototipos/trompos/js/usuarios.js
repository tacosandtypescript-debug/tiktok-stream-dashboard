// Registro de usuarios de TikTok (orden 06).
//
// La identidad es el **userId**, nunca el nombre: TikTok deja cambiar el mote y el
// apodo, y con el nombre como clave el mismo espectador acabaría con dos participantes.
//
//   { userId, userName, displayName, avatarUrl, firstSeenAt, lastSeenAt,
//     participantId, active }
//
// Cuando llega alguien nuevo: si hay sitio se le crea el participante (diseño libre,
// vida inicial y sitio seguro — eso lo hace la simulación), y si ya hay 40 activos se
// queda **en espera** con sus regalos apuntados, sin perder ni uno. Entra en cuanto se
// libera un sitio o al empezar la ronda siguiente.

/** Estados de un usuario dentro del prototipo. */
export const ESTADOS_USUARIO = {
  dentro: { clave: "dentro", nombre: "En la arena", color: "#4ade80" },
  espera: { clave: "espera", nombre: "EN ESPERA", color: "#ffcc44" },
  eliminado: { clave: "eliminado", nombre: "Eliminado", color: "#ff5a3c" },
  fuera: { clave: "fuera", nombre: "Fuera", color: "#9aa4b2" },
};

export class Usuarios {
  constructor(p) {
    this.p = p;
    this.mapa = new Map();
    this.cola = [];
    this.contadores = { vistos: 0, nuevos: 0, dentro: 0, enEspera: 0, eliminados: 0, promovidos: 0, pendientesAplicadas: 0 };
    this.avisos = [];
  }

  get maximo() {
    return this.p.simulacion.maxParticipantes;
  }

  /** Cuántos hay dentro de la arena (los que están «fuera» no ocupan sitio). */
  get cuantosDentro() {
    return [...this.mapa.values()].filter((u) => u.estado === "dentro").length;
  }

  get cuantosEnEspera() {
    return this.cola.length;
  }

  /**
   * Registra (o recupera) al usuario de un evento y dice en qué estado queda.
   *
   * Devuelve `{ usuario, nuevo, estado, motivo, trompo }`.
   */
  registrar(evento, sim) {
    const ahora = Date.now();
    const userId = evento.userId;
    let usuario = this.mapa.get(userId);
    let nuevo = false;
    if (!usuario) {
      usuario = {
        userId,
        userName: evento.userName ?? "",
        displayName: evento.displayName ?? evento.userName ?? userId,
        avatarUrl: evento.avatarUrl ?? "",
        firstSeenAt: ahora,
        lastSeenAt: ahora,
        participantId: null,
        active: true,
        // --- seguimiento para el taller (no forma parte de la identidad mínima)
        estado: "espera",
        motivo: "",
        regalos: 0,
        diamantes: 0,
        pendientes: [],
        vistoPorNombre: null,
      };
      this.mapa.set(userId, usuario);
      nuevo = true;
      this.contadores.nuevos += 1;
    }
    this.contadores.vistos += 1;
    usuario.lastSeenAt = ahora;
    // El nombre y la foto se actualizan: pueden cambiar. La identidad no.
    if (evento.displayName) usuario.displayName = evento.displayName;
    if (evento.userName) usuario.userName = evento.userName;
    if (evento.avatarUrl) usuario.avatarUrl = evento.avatarUrl;
    usuario.regalos += Math.max(1, evento.cantidadNueva ?? evento.quantity ?? 1);
    usuario.diamantes += (evento.diamantes ?? 0) * Math.max(1, evento.cantidadNueva ?? 1);

    // ¿Ya tiene trompo en esta ronda? Se busca por userId, no por el id guardado: al
    // empezar una ronda los participantes se rehacen y el id interno cambia.
    let trompo = sim.trompos.find((t) => t.userId === userId && t.estado !== "fuera");
    if (trompo) {
      usuario.participantId = trompo.id;
      // «Eliminado» es estar fuera de la ronda (KO o retirado). Durante la cuenta atrás
      // el trompo todavía no está «activo» y aun así el regalo cuenta.
      const fuera = trompo.estado === "ko" || trompo.estado === "fuera";
      usuario.estado = fuera ? "eliminado" : "dentro";
      usuario.motivo = fuera ? "está eliminado en esta ronda" : "";
      if (!fuera) this.contadores.dentro += nuevo ? 1 : 0;
      return { usuario, nuevo, estado: usuario.estado, motivo: usuario.motivo, trompo };
    }
    if (usuario.estado === "eliminado") {
      // Eliminado en esta ronda: no se revive (esa mecánica no existe todavía). El
      // regalo se registra igual y queda pendiente para la ronda siguiente.
      usuario.motivo = "está eliminado: el regalo queda pendiente para la próxima ronda";
      this.contadores.eliminados += 1;
      return { usuario, nuevo, estado: "eliminado", motivo: usuario.motivo, trompo: null };
    }

    // ¿Hay sitio? Si no, a la cola de espera (sin perder sus regalos).
    if (!sim.haySitio()) {
      let entraEnEspera = false;
      if (!this.cola.includes(userId)) {
        this.cola.push(userId);
        this.contadores.enEspera += 1;
        entraEnEspera = true;
        this.avisos.unshift({ cuando: ahora, texto: `${usuario.displayName} entra EN ESPERA (arena llena: ${this.maximo})` });
        if (this.avisos.length > 30) this.avisos.length = 30;
      }
      usuario.estado = "espera";
      usuario.motivo = `arena llena (${this.maximo} participantes)`;
      return { usuario, nuevo, estado: "espera", motivo: usuario.motivo, trompo: null, entraEnEspera };
    }

    const ficha = sim.anadirParticipante({
      nombre: usuario.displayName,
      foto: usuario.avatarUrl || null,
      userId,
    });
    if (!ficha) {
      if (!this.cola.includes(userId)) this.cola.push(userId);
      usuario.estado = "espera";
      usuario.motivo = "no se pudo crear el participante";
      return { usuario, nuevo, estado: "espera", motivo: usuario.motivo, trompo: null };
    }
    usuario.participantId = ficha.id;
    usuario.estado = "dentro";
    usuario.motivo = "";
    this.contadores.dentro += 1;
    return {
      usuario,
      nuevo,
      estado: "dentro",
      motivo: "",
      trompo: sim.trompos.find((t) => t.id === ficha.id),
      ficha,
    };
  }

  /** Apunta una recompensa para cuando el usuario entre en la arena. */
  anotarPendiente(usuario, pendiente) {
    usuario.pendientes.push(pendiente);
    if (usuario.pendientes.length > 40) usuario.pendientes.shift();
    return usuario.pendientes.length;
  }

  /**
   * Mete en la arena a los que esperan, mientras queden sitios. Devuelve las fichas de
   * los que han entrado con sus recompensas pendientes, para que el motor las aplique.
   */
  promover(sim) {
    const entrados = [];
    while (this.cola.length && sim.haySitio()) {
      const userId = this.cola.shift();
      const usuario = this.mapa.get(userId);
      if (!usuario) continue;
      const ficha = sim.anadirParticipante({
        nombre: usuario.displayName,
        foto: usuario.avatarUrl || null,
        userId,
      });
      if (!ficha) {
        this.cola.unshift(userId);
        break;
      }
      usuario.participantId = ficha.id;
      usuario.estado = "dentro";
      usuario.motivo = "";
      this.contadores.promovidos += 1;
      const pendientes = usuario.pendientes.splice(0, usuario.pendientes.length);
      this.contadores.pendientesAplicadas += pendientes.length;
      entrados.push({ usuario, ficha, pendientes });
    }
    return entrados;
  }

  /** Ficha de identidad para el taller. */
  listar() {
    return [...this.mapa.values()].map((u) => ({
      userId: u.userId,
      userName: u.userName,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      firstSeenAt: u.firstSeenAt,
      lastSeenAt: u.lastSeenAt,
      participantId: u.participantId,
      active: u.active,
      estado: u.estado,
      motivo: u.motivo,
      regalos: u.regalos,
      diamantes: u.diamantes,
      pendientes: u.pendientes.length,
      posicionCola: this.cola.indexOf(u.userId),
    }));
  }

  /** Los que esperan, en orden. */
  enEspera() {
    return this.cola
      .map((userId) => this.mapa.get(userId))
      .filter(Boolean)
      .map((u) => ({
        userId: u.userId,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        regalos: u.regalos,
        pendientes: u.pendientes.length,
        desde: u.firstSeenAt,
      }));
  }

  limpiar() {
    this.mapa.clear();
    this.cola = [];
    this.avisos = [];
    this.contadores = { vistos: 0, nuevos: 0, dentro: 0, enEspera: 0, eliminados: 0, promovidos: 0, pendientesAplicadas: 0 };
  }

  /** Exporta el registro (para guardarlo y que no se pierdan las identidades). */
  exportar() {
    return {
      usuarios: [...this.mapa.values()].map((u) => ({
        userId: u.userId,
        userName: u.userName,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        firstSeenAt: u.firstSeenAt,
        lastSeenAt: u.lastSeenAt,
        participantId: u.participantId,
        active: u.active,
      })),
      cola: [...this.cola],
    };
  }

  importar(datos) {
    if (!datos || !Array.isArray(datos.usuarios)) return 0;
    this.mapa.clear();
    for (const u of datos.usuarios) {
      if (!u?.userId) continue;
      this.mapa.set(String(u.userId), {
        userId: String(u.userId),
        userName: String(u.userName ?? ""),
        displayName: String(u.displayName ?? u.userName ?? u.userId),
        avatarUrl: String(u.avatarUrl ?? ""),
        firstSeenAt: Number(u.firstSeenAt) || Date.now(),
        lastSeenAt: Number(u.lastSeenAt) || Date.now(),
        participantId: u.participantId ?? null,
        active: u.active !== false,
        estado: "fuera",
        motivo: "registro cargado: entrará en la próxima ronda",
        regalos: 0,
        diamantes: 0,
        pendientes: [],
      });
    }
    this.cola = Array.isArray(datos.cola) ? datos.cola.filter((id) => this.mapa.has(id)) : [];
    return this.mapa.size;
  }

  estado() {
    return {
      maximo: this.maximo,
      dentro: this.cuantosDentro,
      enEspera: this.cola.length,
      contadores: { ...this.contadores },
      usuarios: this.listar(),
      espera: this.enEspera(),
      avisos: this.avisos.slice(0, 10),
    };
  }
}
