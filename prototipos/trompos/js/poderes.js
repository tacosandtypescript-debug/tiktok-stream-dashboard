// Los diez poderes: catálogo, máquina de estados y efecto de cada uno.
//
// **Todos son de ataque** (orden 04 revisada): ningún poder se limita a proteger. Cada
// uno pega de una forma distinta —golpe, área, cadena, embestida, arrastre— y todos
// avisan antes de hacer daño.
//
// **Los puede usar cualquiera**: el poder no está atado a quien lleva el diseño. Cada
// participante tiene su *poder de firma* (el de su diseño, que es el que se enseña en
// la chapa cuando está listo) y además puede lanzar los otros nueve, cada uno con su
// propio enfriamiento. Eso es lo que hará falta cuando un regalo tenga que disparar
// cualquier poder sobre cualquier espectador.
//
// Cuatro momentos:
//   1. **carga**       — aviso: aro que se llena, aura que sube, sonido.
//   2. **activo**      — el efecto principal (filos, martillos, rayo, explosión…).
//   3. **efecto**      — lo que les pasa a los demás: daño, empuje, arrastre.
//   4. **finalizando** — se disipa y su clave entra en enfriamiento.
//
// Reglas que se cumplen por construcción:
//   * nada de daño ni velocidad infinitos: todo pasa por los topes de
//     `PARAMETROS.poderes` y por el daño máximo por golpe (22 % de la vida máxima);
//   * nada de empujes que saquen a nadie: el impulso se acota y la física encajona a
//     los trompos en la arena cada paso;
//   * nada de matar sin aviso: los diez poderes tienen fase de carga;
//   * nada de cadenas infinitas: el rayo y la onda saltan como mucho tres veces;
//   * nada de acumularse: un poder por trompo a la vez, y cada clave con su enfriamiento.

import { limitar } from "./util.js";

/**
 * Catálogo. `clase` dice de qué manera hace el daño; `modificadores` son los valores
 * que se aplican mientras está activo: velocidad (multiplicador del crucero),
 * danioContacto (multiplicador del daño de choque), defensa (multiplicador del daño
 * recibido) y esquiva (probabilidad de que un golpe no entre).
 */
export const PODERES = {
  ataque: {
    clave: "ataque",
    nombre: "Filo Radial",
    lema: "Seis filos de energía y una embestida corta",
    tipo: "ataque",
    clase: "golpe",
    color: "#ff5a3c",
    icono: "filos",
    carga: 0.6,
    duracion: 2.6,
    final: 0.7,
    enfriamiento: 8,
    alcance: 200,
    danio: 34,
    modificadores: { velocidad: 1.5, danioContacto: 1.7 },
    lunge: 1.25,
    sonidos: { carga: "poderCarga", activa: "poderActiva", impacto: "poderImpacto" },
  },
  defensa: {
    clave: "defensa",
    nombre: "Martillo Orbital",
    lema: "Cuatro martillos que salen en cruz",
    tipo: "ataque",
    clase: "area",
    color: "#63b4ff",
    icono: "martillos",
    carga: 0.7,
    duracion: 1.3,
    final: 0.7,
    enfriamiento: 9,
    alcance: 230,
    danio: 32,
    empuje: 300,
    // Cuatro golpes, uno por rumbo, con un abanico de 70° cada uno.
    martillos: 4,
    abanico: 1.22,
    modificadores: {},
    sonidos: { carga: "poderCarga", activa: "poderImpacto", impacto: "poderImpacto" },
  },
  balance: {
    clave: "balance",
    nombre: "Onda de Rebote",
    lema: "Salta de un rival a otro",
    tipo: "ataque",
    clase: "cadena",
    color: "#c07bff",
    icono: "rebote",
    carga: 0.55,
    duracion: 0.9,
    final: 0.7,
    enfriamiento: 8,
    alcance: 340,
    danio: 40,
    saltos: 3,
    caidaSalto: 0.62,
    modificadores: {},
    sonidos: { carga: "poderCarga", activa: "poderActiva", impacto: "poderImpacto" },
  },
  velocidad: {
    clave: "velocidad",
    nombre: "Espiral Cortante",
    lema: "Corre y corta a su paso",
    tipo: "ataque",
    clase: "movimiento",
    color: "#67f2ff",
    icono: "espiral",
    carga: 0.4,
    duracion: 4.5,
    final: 0.9,
    enfriamiento: 9,
    alcance: 0,
    danio: 14,
    modificadores: { velocidad: 1.5, danioContacto: 1.15 },
    rampa: 1.4,
    // Cada cuánto corta a quien pasa cerca mientras corre.
    cadenciaCorte: 0.35,
    radioCorte: 1.7,
    sonidos: { carga: "poderCarga", activa: "poderViento", impacto: "poderImpacto" },
  },
  electrico: {
    clave: "electrico",
    nombre: "Descarga Eléctrica",
    lema: "Un rayo que salta hasta tres veces",
    tipo: "ataque",
    clase: "cadena",
    color: "#ffe873",
    icono: "rayo",
    carga: 0.55,
    duracion: 0.9,
    final: 0.6,
    enfriamiento: 8.5,
    alcance: 520,
    danio: 70,
    saltos: 3,
    caidaSalto: 0.62,
    modificadores: {},
    sonidos: { carga: "poderCarga", activa: "poderElectrico", impacto: "poderElectrico" },
  },
  volcanico: {
    clave: "volcanico",
    nombre: "Explosión Volcánica",
    lema: "Carga, avisa y revienta el área",
    tipo: "ataque",
    clase: "area",
    color: "#ffa53d",
    icono: "volcan",
    carga: 1.4, // aviso largo: da tiempo a apartarse
    duracion: 0.5,
    final: 0.9,
    enfriamiento: 11,
    alcance: 260,
    danio: 55,
    empuje: 520,
    modificadores: {},
    sonidos: { carga: "poderCarga", activa: "poderExplosion", impacto: "poderExplosion" },
  },
  cristal: {
    clave: "cristal",
    nombre: "Cristal de Impacto",
    lema: "Un cristal grande que revienta en esquirlas",
    tipo: "ataque",
    clase: "proyectil",
    color: "#ff9ec7",
    icono: "cristal",
    carga: 0.65,
    duracion: 1.15,
    final: 0.75,
    // El enfriamiento no cambia respecto a la Lluvia de Esquirlas.
    enfriamiento: 9,
    // Alcance del vuelo: hasta dónde llega el cristal antes de estallar solo contra
    // una pared.
    alcance: 330,
    // Reparto del daño con el MISMO presupuesto que la Lluvia de Esquirlas (antes:
    // 3 esquirlas × 26 = 78). Ahora: 38 del cristal + 6 fragmentos × 7 = 80, y con tope
    // total de 80 por activación.
    danio: 38,
    danioFragmento: 7,
    danioTotalMaximo: 80,
    fragmentos: 6,
    radioFragmentos: 175,
    vuelo: 0.38, // segundos que tarda el cristal en llegar
    empuje: 240,
    modificadores: {},
    sonidos: { carga: "poderCarga", activa: "poderRotura", impacto: "poderRotura" },
  },
  sombra: {
    clave: "sombra",
    nombre: "Golpe Umbrío",
    lema: "Se desliza y golpea por la espalda",
    tipo: "ataque",
    clase: "embestida",
    color: "#a78bfa",
    icono: "velo",
    carga: 0.5,
    duracion: 1.4,
    final: 0.8,
    enfriamiento: 8.5,
    alcance: 300,
    danio: 46,
    // Mientras dura la embestida el daño de contacto se multiplica: es el golpe.
    modificadores: { velocidad: 1.35, danioContacto: 2.4 },
    lunge: 1.4,
    oscuridad: 0.42,
    sonidos: { carga: "poderCarga", activa: "poderSombra", impacto: "poderImpacto" },
  },
  viento: {
    clave: "viento",
    nombre: "Ráfaga Cortante",
    lema: "Corriente que arrastra y corta",
    tipo: "ataque",
    clase: "area",
    color: "#7ef0a4",
    icono: "viento",
    carga: 0.5,
    duracion: 3,
    final: 0.8,
    enfriamiento: 9,
    alcance: 280,
    danio: 11,
    // Ahora arrastra hacia dentro (es un ataque) en vez de empujar hacia fuera.
    arrastre: 260,
    cadencia: 0.3,
    modificadores: {},
    sonidos: { carga: "poderCarga", activa: "poderViento", impacto: "poderViento" },
  },
  cosmico: {
    clave: "cosmico",
    nombre: "Colapso Estelar",
    lema: "Gravedad dorada que aprieta",
    tipo: "ataque",
    clase: "area",
    color: "#ffcc44",
    icono: "campo",
    carga: 0.6,
    duracion: 4,
    final: 1.1,
    enfriamiento: 12,
    // Alcance limitado: nunca cubre la arena entera (son 928 × 1432 px).
    alcance: 340,
    danio: 9,
    atraccion: 300,
    frenado: 0.7,
    cadencia: 0.3,
    modificadores: {},
    sonidos: { carga: "poderCarga", activa: "poderCampo", impacto: "poderCampo" },
  },
};

export const ORDEN_PODERES = [
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
];

export function poderDeDiseno(clave) {
  return PODERES[clave] ?? PODERES.ataque;
}

/** Icono del poder, dibujado por código (nada de imágenes). */
export function dibujarIcono(ctx, poder, x, y, tamano, color = null) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color ?? poder.color;
  ctx.fillStyle = color ?? poder.color;
  ctx.lineWidth = Math.max(1.5, tamano * 0.16);
  ctx.lineCap = "round";
  const r = tamano;
  switch (poder.icono) {
    case "filos":
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.stroke();
      }
      break;
    case "martillos":
      for (let i = 0; i < 4; i += 1) {
        const a = (i / 4) * Math.PI * 2;
        ctx.save();
        ctx.rotate(a);
        ctx.fillRect(r * 0.55, -r * 0.36, r * 0.4, r * 0.72);
        ctx.beginPath();
        ctx.moveTo(r * 0.35, -r * 0.14);
        ctx.lineTo(r * 0.6, 0);
        ctx.lineTo(r * 0.35, r * 0.14);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      break;
    case "rebote":
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, Math.PI * 0.2, Math.PI * 1.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(r * 0.7, -r * 0.1);
      ctx.lineTo(r * 0.95, r * 0.35);
      ctx.lineTo(r * 0.35, r * 0.4);
      ctx.fill();
      break;
    case "espiral":
      ctx.beginPath();
      for (let i = 0; i <= 40; i += 1) {
        const t = i / 40;
        const a = t * Math.PI * 3;
        const rr = r * (0.15 + t * 0.85);
        const px = Math.cos(a) * rr;
        const py = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      break;
    case "rayo":
      ctx.beginPath();
      ctx.moveTo(-r * 0.35, -r);
      ctx.lineTo(r * 0.15, -r * 0.1);
      ctx.lineTo(-r * 0.1, -r * 0.05);
      ctx.lineTo(r * 0.4, r);
      ctx.lineTo(-r * 0.2, r * 0.05);
      ctx.lineTo(r * 0.05, 0);
      ctx.closePath();
      ctx.fill();
      break;
    case "volcan":
      ctx.beginPath();
      ctx.moveTo(-r, r * 0.7);
      ctx.lineTo(-r * 0.35, -r * 0.5);
      ctx.lineTo(0, r * 0.1);
      ctx.lineTo(r * 0.35, -r * 0.5);
      ctx.lineTo(r, r * 0.7);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, r * 0.85, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "cristal":
      // Gema grande: pentágono con facetas.
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.8, -r * 0.32);
      ctx.lineTo(r * 0.6, r * 0.8);
      ctx.lineTo(-r * 0.6, r * 0.8);
      ctx.lineTo(-r * 0.8, -r * 0.32);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(0, r * 0.8);
      ctx.moveTo(-r * 0.8, -r * 0.32);
      ctx.lineTo(r * 0.8, -r * 0.32);
      ctx.stroke();
      break;
    case "velo":
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.75, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(r * 0.35, r * 0.15, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "viento":
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.arc(0, 0, r * (0.35 + i * 0.3), Math.PI * 0.15, Math.PI * 1.1);
        ctx.stroke();
      }
      break;
    case "campo":
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.ellipse(0, 0, r * (0.55 + i * 0.22), r * (0.3 + i * 0.12), i * 0.7, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    default:
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

/**
 * Estado inicial del poder de un trompo.
 *
 * `firma` es el poder de su diseño (el que se enseña en la chapa cuando está listo) y
 * `enfriamientos` guarda, por clave, cuánto le queda a cada uno de los diez: por eso
 * cualquiera puede lanzar cualquiera, cada uno con su propio tiempo de espera.
 */
export function estadoInicialPoder(claveFirma) {
  return {
    firma: claveFirma,
    clave: claveFirma,
    estado: "listo", // listo | cargando | activo | finalizando | enfriando
    t: 0,
    enfriamiento: 0,
    enfriamientos: {},
    integridad: 0,
    modificadores: {},
    datos: {},
    veces: 0,
  };
}

/**
 * Gestor de poderes de una ronda.
 *
 * Guarda el estado de cada trompo en `trompo.poder` (para que la física lea los
 * modificadores sin preguntar a nadie) y lleva el contador de activaciones, el freno
 * entre activaciones y la demostración automática reproducible.
 */
export class Poderes {
  constructor(p) {
    this.p = p;
    this.activaciones = 0;
    this.danioDePoderes = 0;
    this.eliminacionesPorPoder = 0;
    this.ultimaActivacion = -99;
    this.demo = { activa: false, reloj: 0, cursor: 0, paso: 0, pasos: [] };
  }

  limpiar() {
    this.activaciones = 0;
    this.danioDePoderes = 0;
    this.eliminacionesPorPoder = 0;
    this.ultimaActivacion = -99;
    this.demo = { activa: false, reloj: 0, cursor: 0, paso: 0, pasos: [] };
  }

  /** Prepara el poder de todos los trompos de la ronda. */
  preparar(trompos) {
    for (const t of trompos) {
      if (!t.poder) t.poder = estadoInicialPoder(t.diseno.clave);
    }
  }

  /** Modificadores activos de un trompo (o valores neutros). */
  modificadoresDe(t) {
    const m = t?.poder?.estado === "activo" ? t.poder.modificadores : null;
    return {
      velocidad: m?.velocidad ?? 1,
      danioContacto: m?.danioContacto ?? 1,
      defensa: m?.defensa ?? 1,
      esquiva: m?.esquiva ?? 0,
    };
  }

  /** ¿Le queda enfriamiento a esa clave? */
  enfriamientoDe(t, clave) {
    return t?.poder?.enfriamientos?.[clave] ?? 0;
  }

  /** ¿Puede lanzar ese poder ahora mismo? (uno a la vez, y con su clave fría) */
  puedeActivar(t, clave, tiempo) {
    if (!this.p.poderes.activo || !t || !t.activo || !t.poder) return false;
    if (t.poder.estado !== "listo") return false;
    if (this.enfriamientoDe(t, clave) > 0) return false;
    if (tiempo - this.ultimaActivacion < this.p.poderes.enfriamientoGlobal) return false;
    return true;
  }

  /**
   * Lanza un poder en un trompo. Cualquiera puede lanzar cualquiera: si no se dice
   * clave, usa la de su diseño (la firma).
   *
   * `objetivo` (orden 05) lo pone el regalo: rival más cercano, el de más vida, el
   * líder, uno al azar, el área entera, el propio donador o todos los participantes.
   */
  activar(trompo, sim, forzar = false, clave = null, objetivo = null) {
    if (!this.p.poderes.activo || !trompo || !trompo.poder) return null;
    const cual = clave ?? trompo.poder.firma;
    if (!forzar && !this.puedeActivar(trompo, cual, sim.tiempo)) return null;
    const poder = poderDeDiseno(cual);
    const p = trompo.poder;
    p.clave = poder.clave;
    p.estado = "cargando";
    p.t = 0;
    p.datos = {};
    p.integridad = poder.integridad ?? 0;
    p.modificadores = {};
    p.objetivo = objetivo ?? "cercano";
    p.veces += 1;
    this.activaciones += 1;
    this.ultimaActivacion = sim.tiempo;
    sim.mensajes.anunciar(`${poder.nombre.toUpperCase()} · ${trompo.nombre}`, poder.color, "poder", "", {
      nombre: trompo.nombre,
      inicial: trompo.inicial,
      foto: trompo.foto,
      color: trompo.color,
    });
    sim.sonido.tocar(poder.sonidos.carga, { intensidad: 0.7 });
    return poder;
  }

  // ------------------------------------------------------------ objetivos

  /** Rivales vivos (siempre sin contar con el que lanza, salvo objetivo «propio»). */
  rivalesDe(t, sim, incluirPropio = false) {
    const objetivo = t.poder?.objetivo ?? "cercano";
    if (objetivo === "propio") return t.activo ? [t] : [];
    return sim.trompos.filter((o) => o.activo && (incluirPropio || o !== t));
  }

  /**
   * A quién apunta un poder de un solo objetivo.
   *
   * `cercano` y `area` respetan el alcance del poder; `mas_vida`, `lider`, `aleatorio`,
   * `todos` y `propio` lo ignoran: el regalo decide a quién va, no la distancia.
   */
  elegirObjetivo(t, sim, alcance = Infinity) {
    const objetivo = t.poder?.objetivo ?? "cercano";
    const rivales = this.rivalesDe(t, sim);
    if (objetivo === "propio") return t.activo ? t : null;
    if (!rivales.length) return null;
    if (objetivo === "mas_vida") {
      return rivales.reduce((mejor, o) => (o.vida > mejor.vida ? o : mejor), rivales[0]);
    }
    if (objetivo === "lider") {
      const lider = sim.lider();
      return lider && lider.activo ? lider : this.masCercano(t, sim, alcance);
    }
    if (objetivo === "aleatorio") {
      // Azar del flujo de la física: la misma semilla da el mismo objetivo.
      return rivales[Math.floor(sim.azar.rango(0, rivales.length)) % rivales.length];
    }
    if (objetivo === "todos") return this.masCercano(t, sim, Infinity);
    return this.masCercano(t, sim, alcance);
  }

  /**
   * A quiénes afecta un poder de área.
   *
   * Los poderes de área **siempre respetan su radio**; el objetivo sólo puede
   * estrechar la lista (el líder, el de más vida, el propio donador) o dejarla en
   * «todos los que estén dentro». Los eliminados nunca entran.
   */
  objetivosDeArea(t, sim, radio) {
    const objetivo = t.poder?.objetivo ?? "area";
    if (objetivo === "propio") return t.activo ? [t] : [];
    const dentro = (o) => Math.hypot(o.x - t.x, o.y - t.y) <= radio;
    const vivos = sim.trompos.filter((o) => o.activo && o !== t);
    if (objetivo === "lider") {
      const lider = sim.lider();
      return lider && lider.activo && lider !== t && dentro(lider) ? [lider] : [];
    }
    if (objetivo === "mas_vida") {
      const mejores = vivos.filter(dentro);
      if (!mejores.length) return [];
      return [mejores.reduce((mejor, o) => (o.vida > mejor.vida ? o : mejor), mejores[0])];
    }
    if (objetivo === "aleatorio") {
      const cerca = vivos.filter(dentro);
      if (!cerca.length) return [];
      return [cerca[Math.floor(sim.azar.rango(0, cerca.length)) % cerca.length]];
    }
    return vivos.filter(dentro);
  }

  /**
   * Filtro de objetivos explícito, para los efectos que no son un área limpia (los
   * fragmentos del cristal): `null` significa «manda el radio del poder».
   */
  objetivosDeAreaFiltro(t, sim) {
    const objetivo = t.poder?.objetivo ?? "cercano";
    const vivos = sim.trompos.filter((o) => o.activo && o !== t);
    if (objetivo === "todos") return null;
    if (objetivo === "propio") return new Set([t.id]);
    if (objetivo === "lider") {
      const lider = sim.lider();
      return new Set(lider ? [lider.id] : []);
    }
    if (objetivo === "mas_vida") {
      if (!vivos.length) return new Set();
      return new Set([vivos.reduce((mejor, o) => (o.vida > mejor.vida ? o : mejor), vivos[0]).id]);
    }
    if (objetivo === "aleatorio") {
      if (!vivos.length) return new Set();
      return new Set([vivos[Math.floor(sim.azar.rango(0, vivos.length)) % vivos.length].id]);
    }
    return null;
  }

  /** Rival vivo más cercano, dentro de un alcance (o todos si es infinito). */
  masCercano(t, sim, alcance) {
    let mejor = null;
    let mejorD = alcance === Infinity ? Infinity : alcance;
    for (const o of sim.trompos) {
      if (o === t || !o.activo) continue;
      const d = Math.hypot(o.x - t.x, o.y - t.y);
      if (d < mejorD) {
        mejorD = d;
        mejor = o;
      }
    }
    return mejor;
  }

  cancelar(trompo) {
    if (!trompo?.poder) return;
    const poder = poderDeDiseno(trompo.poder.clave);
    if (trompo.poder.estado !== "listo" && trompo.poder.estado !== "enfriando") {
      trompo.poder.estado = "enfriando";
      trompo.poder.t = 0;
      trompo.poder.enfriamiento = poder.enfriamiento;
      trompo.poder.enfriamientos[poder.clave] = poder.enfriamiento;
    }
  }

  /** Repone todos los enfriamientos de todos los trompos (botón del taller). */
  reiniciarEnfriamientos(trompos) {
    for (const t of trompos) {
      if (!t.poder) continue;
      t.poder.estado = "listo";
      t.poder.t = 0;
      t.poder.enfriamiento = 0;
      t.poder.enfriamientos = {};
      t.poder.modificadores = {};
      t.poder.datos = {};
    }
  }

  // ------------------------------------------------------------ avance

  actualizar(dt, sim) {
    if (!this.p.poderes.activo) return;
    for (const t of sim.trompos) {
      const p = t.poder;
      if (!p) continue;
      // Los diez enfriamientos corren siempre, esté el que esté en marcha.
      for (const [clave, resto] of Object.entries(p.enfriamientos)) {
        const nuevo = resto - dt;
        if (nuevo <= 0) delete p.enfriamientos[clave];
        else p.enfriamientos[clave] = nuevo;
      }
      if (p.estado === "listo" || p.estado === "enfriando") {
        if (p.enfriamiento > 0) {
          p.enfriamiento = Math.max(0, p.enfriamiento - dt);
          if (p.enfriamiento === 0) {
            p.estado = "listo";
            p.t = 0;
          }
        }
      }
      if (!t.presente) continue;
      // Si el dueño del poder cae, el poder se corta y su clave entra en enfriamiento:
      // es lo que evita que un poder quede congelado en «activo» para siempre.
      if (!t.activo && p.estado !== "listo" && p.estado !== "enfriando") {
        const definicion = poderDeDiseno(p.clave);
        p.estado = "enfriando";
        p.t = 0;
        p.enfriamiento = definicion.enfriamiento;
        p.enfriamientos[definicion.clave] = definicion.enfriamiento;
        p.modificadores = {};
      }
      p.t += dt;
      const poder = poderDeDiseno(p.clave);
      switch (p.estado) {
        case "cargando": {
          if (p.t >= poder.carga) {
            p.estado = "activo";
            p.t = 0;
            p.modificadores = { ...poder.modificadores };
            this.alActivar(t, poder, sim);
          }
          break;
        }
        case "activo": {
          this.mientrasActivo(t, poder, sim, dt);
          if (p.t >= poder.duracion) {
            p.estado = "finalizando";
            p.t = 0;
            p.modificadores = {};
            sim.sonido.tocar("poderFinal", { intensidad: 0.5 });
          }
          break;
        }
        case "finalizando": {
          if (p.t >= poder.final) {
            p.estado = "enfriando";
            p.t = 0;
            p.enfriamiento = poder.enfriamiento;
            p.enfriamientos[poder.clave] = poder.enfriamiento;
          }
          break;
        }
        default:
          break;
      }
    }
    this.actualizarDemo(dt, sim);
  }

  /** Lo que pasa justo al activarse (una vez). */
  alActivar(t, poder, sim) {
    sim.sonido.tocar(poder.sonidos.activa, { intensidad: 0.85 });
    switch (poder.clase) {
      case "golpe":
      case "embestida": {
        // Embestida corta hacia el rival más cercano. El impulso se acota y la física
        // encajona en la arena: nadie sale despedido fuera.
        const objetivo = this.elegirObjetivo(t, sim, poder.alcance || Infinity);
        const rumbo = objetivo ? Math.atan2(objetivo.y - t.y, objetivo.x - t.x) : t.rumbo;
        const impulso = Math.min(this.p.poderes.empujeMaximo, sim.p.fisica.velocidadCrucero * (poder.lunge ?? 1.2));
        t.vx += Math.cos(rumbo) * impulso * 0.6;
        t.vy += Math.sin(rumbo) * impulso * 0.6;
        t.rumbo = rumbo;
        break;
      }
      case "cadena": {
        if (poder.clave === "electrico") this.descarga(t, poder, sim);
        else this.rebote(t, poder, sim);
        break;
      }
      case "area": {
        if (poder.clave === "volcanico") this.explosion(t, poder, sim);
        else if (poder.clave === "defensa") this.martillos(t, poder, sim);
        break;
      }
      case "proyectil": {
        this.lanzarCristal(t, poder, sim);
        break;
      }
      default:
        break;
    }
  }

  /** Lo que pasa mientras el poder está activo (cada paso). */
  mientrasActivo(t, poder, sim, dt) {
    if (t.poder.datos.flash > 0) t.poder.datos.flash = Math.max(0, t.poder.datos.flash - dt);
    if (t.poder.datos.rayoTiempo !== undefined) t.poder.datos.rayoTiempo += dt;
    if (t.poder.datos.fragmentos) {
      for (const f of t.poder.datos.fragmentos) f.t = Math.min(1, f.t + dt / 0.45);
    }
    if (t.poder.datos.rebotes) {
      for (const r of t.poder.datos.rebotes) r.t = Math.min(1, r.t + dt / 0.35);
    }
    switch (poder.clave) {
      case "cristal": {
        // El cristal vuela; al llegar (o al dar contra la pared) revienta.
        const c = t.poder.datos.cristal;
        if (c && !c.golpeado) {
          c.t += dt / poder.vuelo;
          if (c.t >= 1) {
            c.t = 1;
            c.golpeado = true;
            this.detonarCristal(t, poder, sim);
          }
        }
        break;
      }
      case "velocidad": {
        // Aceleración y desaceleración progresivas: sube en `rampa` segundos y baja en
        // los últimos, sin teletransportes ni saltos de velocidad.
        const activo = this.tiempoActivo(t);
        const subida = limitar(activo / poder.rampa, 0, 1);
        const bajada = limitar((poder.duracion - activo) / (poder.final + 0.5), 0, 1);
        const factor = 1 + (poder.modificadores.velocidad - 1) * Math.min(subida, bajada);
        t.poder.modificadores.velocidad = Math.min(this.p.poderes.velocidadMaximaFactor, factor);
        // Corta a quien pase cerca mientras corre.
        t.poder.datos.corte = (t.poder.datos.corte ?? 0) + dt;
        if (t.poder.datos.corte >= poder.cadenciaCorte) {
          t.poder.datos.corte = 0;
          const radio = t.radio * poder.radioCorte;
          for (const o of this.objetivosDeArea(t, sim, radio)) {
            this.aplicarDanio(o, poder.danio, t, sim, "poder:velocidad");
            sim.efectos.corte(o.x, o.y, Math.atan2(o.y - t.y, o.x - t.x), o.radio * 2, poder.color, 3.4);
          }
        }
        break;
      }
      case "viento": {
        // Corriente que arrastra hacia dentro y corta con pulsos.
        t.poder.datos.pulso = (t.poder.datos.pulso ?? 0) + dt;
        if (t.poder.datos.pulso >= poder.cadencia) {
          t.poder.datos.pulso = 0;
          this.rafaga(t, poder, sim);
        }
        break;
      }
      case "cosmico": {
        this.colapso(t, poder, sim, dt);
        break;
      }
      default:
        break;
    }
  }

  tiempoActivo(t) {
    return t.poder?.estado === "activo" ? t.poder.t : 0;
  }

  // ------------------------------------------------------------ efectos

  /** Rival vivo más cercano, dentro de un alcance (o todos si es infinito). */
  masCercano(t, sim, alcance) {
    let mejor = null;
    let mejorD = alcance === Infinity ? Infinity : alcance;
    for (const o of sim.trompos) {
      if (o === t || !o.activo) continue;
      const d = Math.hypot(o.x - t.x, o.y - t.y);
      if (d < mejorD) {
        mejorD = d;
        mejor = o;
      }
    }
    return mejor;
  }

  /**
   * Daño de un poder, con el tope por golpe y una ventana propia de poderes.
   *
   * Un poder **no** lo anula la protección de un choque (si no, un regalo podría caer
   * en saco roto por un roce de hace 0,1 s), pero dos poderes no pueden pegarle al
   * mismo trompo en el mismo instante: para eso está `proteccionPoder`.
   */
  aplicarDanio(victima, cantidad, fuente, sim, tipo = "poder") {
    if (!victima?.activo) return 0;
    if ((victima.proteccionPoder ?? 0) > 0) return 0;
    const tope = victima.vidaMax * this.p.poderes.danioMaximoPorGolpe;
    const danio = limitar(cantidad, 0, tope);
    if (danio <= 0) return 0;
    const real = victima.recibirDanio(danio, fuente, 0, true);
    if (real > 0) {
      victima.proteccionPoder = this.p.poderes.proteccionPoder;
      this.danioDePoderes += real;
      victima.ultimaFuente = tipo;
      // Se apunta a quién ha tocado este poder y cuánto daño lleva: es lo que enseña
      // el historial de regalos.
      if (fuente?.poder) {
        fuente.poder.datos.danioHecho = (fuente.poder.datos.danioHecho ?? 0) + real;
        const lista = fuente.poder.datos.objetivos ?? (fuente.poder.datos.objetivos = []);
        if (!lista.includes(victima.nombre)) lista.push(victima.nombre);
      }
      const clave = tipo.startsWith("poder:") ? tipo.slice(6) : "ataque";
      sim.efectos.numero(victima.x, victima.y - victima.radio * 1.5, real, poderDeDiseno(clave).color, victima.radio);
      sim.efectos.chispas(victima.x, victima.y, 6, poderDeDiseno(clave).color, 300, null, Math.PI * 2);
    }
    return real;
  }

  /** Empuje acotado hacia una dirección (o hacia dentro si `fuerza` es negativa). */
  empujar(t, dx, dy, fuerza, sim) {
    const d = Math.hypot(dx, dy) || 1;
    const acotado = limitar(fuerza, -this.p.poderes.empujeMaximo, this.p.poderes.empujeMaximo);
    t.vx += (dx / d) * acotado;
    t.vy += (dy / d) * acotado;
    // El límite de velocidad de la arena sigue mandando.
    const rapidez = Math.hypot(t.vx, t.vy);
    const tope = sim.p.fisica.velocidadMaxima;
    if (rapidez > tope) {
      t.vx = (t.vx / rapidez) * tope;
      t.vy = (t.vy / rapidez) * tope;
    }
    t.rumbo = Math.atan2(t.vy, t.vx);
  }

  /** Objetivos de una cadena: el más cercano y luego el más cercano al anterior. */
  cadenaDeObjetivos(t, poder, sim) {
    const objetivos = [];
    let actual = t;
    const usados = new Set([t.id]);
    const maxSaltos = Math.min(poder.saltos, this.p.poderes.cadenaMaxima);
    for (let i = 0; i < maxSaltos; i += 1) {
      if (i === 0) {
        // El primer salto lo decide el objetivo: el más cercano, el líder, el de más
        // vida, uno al azar… o el propio donador si el regalo lo pide así.
        const elegido = this.elegirObjetivo(t, sim, poder.alcance);
        if (!elegido) break;
        usados.add(elegido.id);
        objetivos.push({ de: actual, a: elegido, distancia: Math.hypot(elegido.x - actual.x, elegido.y - actual.y) });
        actual = elegido;
        continue;
      }
      let mejor = null;
      let mejorD = poder.alcance * 0.6;
      for (const o of sim.trompos) {
        if (usados.has(o.id) || !o.activo) continue;
        const d = Math.hypot(o.x - actual.x, o.y - actual.y);
        if (d < mejorD) {
          mejorD = d;
          mejor = o;
        }
      }
      if (!mejor) break;
      usados.add(mejor.id);
      objetivos.push({ de: actual, a: mejor, distancia: mejorD });
      actual = mejor;
    }
    return objetivos;
  }

  /** Rayo eléctrico con saltos decrecientes. */
  descarga(t, poder, sim) {
    const cadena = this.cadenaDeObjetivos(t, poder, sim);
    let danio = poder.danio;
    const rayos = [];
    for (const paso of cadena) {
      rayos.push({
        de: { x: paso.de.x, y: paso.de.y },
        a: { x: paso.a.x, y: paso.a.y },
        id: paso.a.id,
        danio,
      });
      this.aplicarDanio(paso.a, danio, t, sim, "poder:electrico");
      sim.efectos.destello(paso.a.x, paso.a.y, poder.color, 90, paso.a.radio * 1.6);
      danio *= poder.caidaSalto;
    }
    t.poder.datos.rayos = rayos;
    t.poder.datos.rayoTiempo = 0;
    if (rayos.length) sim.sacudir(40);
    void danio;
  }

  /** Onda de rebote: salta de un rival a otro con ondas moradas. */
  rebote(t, poder, sim) {
    const cadena = this.cadenaDeObjetivos(t, poder, sim);
    let danio = poder.danio;
    const rebotes = [];
    for (const paso of cadena) {
      rebotes.push({
        de: { x: paso.de.x, y: paso.de.y },
        a: { x: paso.a.x, y: paso.a.y },
        id: paso.a.id,
        // Se guarda el daño de cada salto: el banco comprueba que baja (40 → 25 → 15).
        danio: Math.round(danio),
        t: 0,
      });
      this.aplicarDanio(paso.a, danio, t, sim, "poder:balance");
      sim.efectos.onda(paso.a.x, paso.a.y, poder.color, 160, paso.a.radio * 3.2);
      sim.efectos.destello(paso.a.x, paso.a.y, poder.color, 70, paso.a.radio * 1.4);
      danio *= poder.caidaSalto;
    }
    t.poder.datos.rebotes = rebotes;
    t.poder.datos.rayoTiempo = 0;
    if (rebotes.length) sim.sacudir(36);
  }

  /** Explosión de área con empuje radial. */
  explosion(t, poder, sim) {
    sim.efectos.explosion(t.x, t.y, poder.color, "#ffe08a", t.radio * 1.4);
    sim.efectos.onda(t.x, t.y, poder.color, 260, poder.alcance);
    sim.sacudir(90);
    const afectados = [];
    for (const o of this.objetivosDeArea(t, sim, poder.alcance)) {
      const dx = o.x - t.x;
      const dy = o.y - t.y;
      const d = Math.hypot(dx, dy);
      const cerca = 1 - d / poder.alcance;
      this.aplicarDanio(o, poder.danio * (0.4 + 0.6 * cerca), t, sim, "poder:volcanico");
      this.empujar(o, dx, dy, poder.empuje * (0.35 + 0.65 * cerca), sim);
      afectados.push(o.id);
    }
    t.poder.datos.afectados = afectados;
  }

  /** Cuatro martillos en cruz: cada uno golpea su abanico, con destello en cada punta. */
  martillos(t, poder, sim) {
    const golpes = [];
    const n = poder.martillos ?? 4;
    // Cruz limpia: sin girar con el trompo, para que se lea que salen en cruz.
    for (let i = 0; i < n; i += 1) {
      const rumbo = (i / n) * Math.PI * 2;
      let tocados = 0;
      for (const o of this.objetivosDeArea(t, sim, poder.alcance)) {
        const dx = o.x - t.x;
        const dy = o.y - t.y;
        const d = Math.hypot(dx, dy);
        // ¿Está dentro del abanico de este martillo?
        let dif = Math.atan2(dy, dx) - rumbo;
        while (dif > Math.PI) dif -= Math.PI * 2;
        while (dif < -Math.PI) dif += Math.PI * 2;
        if (Math.abs(dif) > poder.abanico / 2) continue;
        this.aplicarDanio(o, poder.danio, t, sim, "poder:defensa");
        this.empujar(o, dx, dy, poder.empuje, sim);
        sim.efectos.corte(o.x, o.y, rumbo, o.radio * 2.4, poder.color, 4);
        sim.efectos.destello(o.x, o.y, poder.color, 80, o.radio * 1.6);
        tocados += 1;
      }
      // Destello en la punta del martillo, haya tocado o no: se ve el golpe en las
      // cuatro direcciones.
      const puntaX = t.x + Math.cos(rumbo) * poder.alcance * 0.9;
      const puntaY = t.y + Math.sin(rumbo) * poder.alcance * 0.9;
      sim.efectos.destello(puntaX, puntaY, poder.color, 70, 46);
      golpes.push({ rumbo, alcance: poder.alcance, tocados });
    }
    t.poder.datos.martillos = golpes;
    sim.sacudir(50);
    sim.sonido.tocar(poder.sonidos.impacto, { intensidad: 0.8 });
  }

  /**
   * Cristal de Impacto: carga un cristal grande, lo lanza como proyectil y lo rompe
   * al llegar. No hace daño al lanzarlo: el daño ocurre **al impactar**, contra un
   * rival o contra la pared.
   */
  lanzarCristal(t, poder, sim) {
    const objetivo = this.elegirObjetivo(t, sim, poder.alcance);
    const arena = sim.p.lienzo;
    const margen = arena.margenLados;
    let x1;
    let y1;
    let pared = false;
    if (objetivo) {
      x1 = objetivo.x;
      y1 = objetivo.y;
    } else {
      // Sin nadie a tiro: el cristal sale recto y revienta contra la pared.
      const rumbo = t.rumbo;
      x1 = limitar(t.x + Math.cos(rumbo) * poder.alcance, margen, arena.ancho - margen);
      y1 = limitar(t.y + Math.sin(rumbo) * poder.alcance, arena.margenArriba, arena.alto - arena.margenAbajo);
      pared = true;
    }
    t.poder.datos.cristal = {
      x0: t.x,
      y0: t.y,
      x1,
      y1,
      objetivoId: objetivo ? objetivo.id : null,
      pared,
      t: 0,
      golpeado: false,
    };
    sim.sonido.tocar(poder.sonidos.activa, { intensidad: 0.7 });
  }

  /**
   * El cristal llega: golpe directo al objetivo, y las esquirlas salen en abanico.
   *
   * Reglas de daño (orden de ajuste):
   *   * el directo y los fragmentos suman como mucho `danioTotalMaximo` (80), el mismo
   *     presupuesto que tenía la Lluvia de Esquirlas (3 × 26 = 78);
   *   * cada fragmento va a un rival **distinto**: ninguno golpea dos veces al mismo;
   *   * con vida completa es imposible que mate: 38 + 7 = 45 sobre 1800.
   */
  detonarCristal(t, poder, sim) {
    const c = t.poder.datos.cristal;
    const x = c.x1;
    const y = c.y1;
    const tope = poder.danioTotalMaximo ?? Infinity;
    let total = 0;

    sim.efectos.explosion(x, y, poder.color, "#ffffff", t.radio * 1.5);
    sim.efectos.onda(x, y, poder.color, 220, poder.radioFragmentos * 1.3);
    sim.sacudir(c.pared ? 40 : 60);
    sim.sonido.tocar(poder.sonidos.impacto, { intensidad: 0.9 });

    // --- golpe directo
    const objetivo = c.objetivoId ? sim.trompos.find((o) => o.id === c.objetivoId && o.activo) : null;
    if (objetivo) {
      total += this.aplicarDanio(objetivo, poder.danio, t, sim, "poder:cristal");
      this.empujar(objetivo, objetivo.x - x, objetivo.y - y, poder.empuje, sim);
      sim.efectos.corte(x, y, Math.atan2(objetivo.y - y, objetivo.x - x), t.radio * 2.6, poder.color, 5);
    }

    // --- fragmentos: uno por rival distinto, nunca dos al mismo
    const filtro = this.objetivosDeAreaFiltro(t, sim);
    const candidatos = sim.trompos
      .filter((o) => o.activo && o !== t && o !== objetivo && (!filtro || filtro.has(o.id)))
      .map((o) => ({ o, d: Math.hypot(o.x - x, o.y - y) }))
      // Con un objetivo explícito (el líder, el de más vida…) las esquirlas van a por
      // él aunque esté lejos; sin objetivo, sólo alcanzan su radio.
      .filter((q) => (filtro ? q.d <= poder.radioFragmentos * 3 : q.d <= poder.radioFragmentos))
      .sort((a, b) => a.d - b.d)
      .slice(0, poder.fragmentos);

    const fragmentos = [];
    for (let i = 0; i < poder.fragmentos; i += 1) {
      const angulo = (i / poder.fragmentos) * Math.PI * 2 + 0.35;
      const alcance = poder.radioFragmentos * (0.7 + 0.3 * ((i % 3) / 2));
      const conObjetivo = candidatos[i];
      fragmentos.push({
        x,
        y,
        x1: conObjetivo ? conObjetivo.o.x : x + Math.cos(angulo) * alcance,
        y1: conObjetivo ? conObjetivo.o.y : y + Math.sin(angulo) * alcance,
        angulo,
        id: conObjetivo ? conObjetivo.o.id : null,
        t: 0,
      });
      if (conObjetivo && total < tope) {
        total += this.aplicarDanio(conObjetivo.o, poder.danioFragmento, t, sim, "poder:cristal");
      }
    }
    t.poder.datos.fragmentos = fragmentos;
    t.poder.datos.danioTotal = total;
    t.poder.datos.cristal = null;
  }

  /** Ráfaga cortante: arrastra hacia dentro y corta. */
  rafaga(t, poder, sim) {
    for (const o of this.objetivosDeArea(t, sim, poder.alcance)) {
      const dx = t.x - o.x;
      const dy = t.y - o.y;
      const d = Math.hypot(dx, dy);
      const cerca = 1 - d / poder.alcance;
      // Hacia dentro: es un ataque, no un empujón de protección.
      this.empujar(o, dx, dy, poder.arrastre * (0.35 + 0.65 * cerca), sim);
      this.aplicarDanio(o, poder.danio, t, sim, "poder:viento");
    }
    t.poder.datos.onda = { x: t.x, y: t.y, r: poder.alcance, t: 0 };
    sim.sonido.tocar(poder.sonidos.impacto, { intensidad: 0.35 });
  }

  /** Colapso estelar: atrae, frena y aprieta dentro del radio, disipándose al final. */
  colapso(t, poder, sim, dt) {
    const activo = this.tiempoActivo(t);
    const fuerza = limitar((poder.duracion - activo) / (poder.final + 0.4), 0, 1);
    t.poder.datos.pulso = (t.poder.datos.pulso ?? 0) + dt;
    const toca = t.poder.datos.pulso >= poder.cadencia;
    if (toca) t.poder.datos.pulso = 0;
    for (const o of this.objetivosDeArea(t, sim, poder.alcance)) {
      const dx = t.x - o.x;
      const dy = t.y - o.y;
      const d = Math.hypot(dx, dy);
      const cerca = 1 - d / poder.alcance;
      const acel = Math.min(this.p.poderes.aceleracionMaxima, poder.atraccion * cerca * fuerza);
      o.vx += (dx / (d || 1)) * acel * dt;
      o.vy += (dy / (d || 1)) * acel * dt;
      o.vx *= 1 - (1 - poder.frenado) * cerca * dt;
      o.vy *= 1 - (1 - poder.frenado) * cerca * dt;
      if (toca) this.aplicarDanio(o, poder.danio, t, sim, "poder:cosmico");
    }
  }

  // ------------------------------------------------------------ impacto de choque

  /**
   * Filtra el daño de un choque según los poderes de la víctima (defensa, esquiva).
   * Devuelve el daño que finalmente entra.
   *
   * Ojo con el orden: la esquiva gasta azar del flujo de la física (no del de los
   * efectos) porque cambia el resultado y tiene que seguir siendo reproducible.
   */
  filtrarDanio(victima, atacante, cantidad, sim) {
    const poder = victima.poder;
    if (!poder || poder.estado !== "activo" || cantidad <= 0) return cantidad;
    const definicion = poderDeDiseno(poder.clave);
    let danio = cantidad;
    if (poder.modificadores.defensa && poder.modificadores.defensa !== 1) danio *= poder.modificadores.defensa;
    if (definicion.esquiva > 0 && sim.azar.siguiente() < definicion.esquiva) {
      victima.poder.datos.esquivas = (victima.poder.datos.esquivas ?? 0) + 1;
      sim.efectos.texto(victima.x, victima.y - victima.radio * 1.8, "esquiva", definicion.color, victima.radio);
      sim.sonido.tocar("poderEsquiva", { intensidad: 0.5 });
      return 0;
    }
    return Math.max(0, danio);
  }

  /** Golpe dado mientras el poder está activo (filos del ataque, cortes). */
  alImpactar(atacante, victima, sim) {
    const poder = atacante.poder;
    if (!poder || poder.estado !== "activo") return;
    const definicion = poderDeDiseno(poder.clave);
    if (definicion.clase !== "golpe" && definicion.clase !== "embestida") return;
    this.aplicarDanio(victima, definicion.danio, atacante, sim, `poder:${definicion.clave}`);
    poder.datos.cortes = (poder.datos.cortes ?? 0) + 1;
    for (let i = 0; i < 3; i += 1) {
      sim.efectos.corte(
        victima.x + sim.efectos.azar.rango(-8, 8),
        victima.y + sim.efectos.azar.rango(-8, 8),
        sim.efectos.azar.rango(0, Math.PI),
        victima.radio * 2.2,
        definicion.color,
        4,
      );
    }
    sim.sonido.tocar(definicion.sonidos.impacto, { intensidad: 0.6 });
  }

  // ------------------------------------------------------------ demostración

  /** Arranca o para la demostración automática (reproducible). */
  demostracion(activar, sim) {
    this.demo.activa = activar ?? !this.demo.activa;
    this.demo.reloj = this.p.poderes.demo.intervalo;
    this.demo.cursor = 0;
    this.demo.paso = 0;
    this.demo.pasos = [];
    if (this.demo.activa) {
      this.reiniciarEnfriamientos(sim.trompos);
      sim.mensajes.anunciar("DEMOSTRACIÓN DE PODERES", "#ffd76a", "poder");
    } else {
      sim.mensajes.anunciar("DEMOSTRACIÓN PARADA", "#9a9ab0", "poder");
    }
    return this.demo.activa;
  }

  /**
   * Un poder detrás de otro, en orden fijo de participantes y rotando el catálogo: mismo
   * resultado con la misma semilla. Respeta enfriamientos y no deja que dos poderes
   * salten a la vez.
   */
  actualizarDemo(dt, sim) {
    if (!this.demo.activa) return;
    this.demo.reloj -= dt;
    if (this.demo.reloj > 0) return;
    this.demo.reloj = this.p.poderes.demo.intervalo;
    const vivos = sim.trompos.filter((t) => t.activo && t.poder);
    if (!vivos.length) return;
    for (let i = 0; i < vivos.length; i += 1) {
      const idx = (this.demo.cursor + i) % vivos.length;
      const t = vivos[idx];
      if (t.poder.estado !== "listo") continue;
      // Se prueban las claves en orden fijo a partir del paso actual: reproducible.
      for (let k = 0; k < ORDEN_PODERES.length; k += 1) {
        const clave = ORDEN_PODERES[(this.demo.paso + k) % ORDEN_PODERES.length];
        if (this.enfriamientoDe(t, clave) > 0) continue;
        this.demo.cursor = (idx + 1) % vivos.length;
        this.demo.paso = (this.demo.paso + k + 1) % ORDEN_PODERES.length;
        const poder = this.activar(t, sim, true, clave);
        if (poder) {
          this.demo.pasos.push({ nombre: t.nombre, poder: poder.nombre, clave: poder.clave, t: Number(sim.tiempoBatalla.toFixed(2)) });
        }
        return;
      }
    }
    this.demo.cursor = 0;
  }

  // ------------------------------------------------------------ estado

  deUnTrompo(t) {
    if (!t?.poder) return null;
    const enMarcha = t.poder.estado !== "listo" && t.poder.estado !== "enfriando";
    const poder = poderDeDiseno(t.poder.clave);
    const firma = poderDeDiseno(t.poder.firma);
    return {
      id: t.id,
      nombre: t.nombre,
      diseno: t.diseno.clave,
      poder: enMarcha ? poder.nombre : firma.nombre,
      clave: enMarcha ? poder.clave : firma.clave,
      firma: firma.clave,
      firmaNombre: firma.nombre,
      tipo: poder.tipo,
      clase: poder.clase,
      estado: t.poder.estado,
      enfriamiento: Number(t.poder.enfriamiento.toFixed(2)),
      enfriamientoTotal: poder.enfriamiento,
      // Cuántos de los diez tiene listos ahora mismo.
      listos: ORDEN_PODERES.filter((c) => (t.poder.enfriamientos[c] ?? 0) <= 0).length,
      enfriamientos: Object.fromEntries(Object.entries(t.poder.enfriamientos).map(([c, v]) => [c, Number(v.toFixed(1))])),
      duracion: poder.duracion,
      tiempo: Number(t.poder.t.toFixed(2)),
      disparos: t.poder.veces,
      modificadores: this.modificadoresDe(t),
    };
  }

  estado(sim) {
    const lista = sim ? sim.trompos.map((t) => this.deUnTrompo(t)).filter(Boolean) : [];
    return {
      activo: this.p.poderes.activo,
      activaciones: this.activaciones,
      danio: Math.round(this.danioDePoderes),
      eliminaciones: this.eliminacionesPorPoder,
      demo: { activa: this.demo.activa, pasos: this.demo.pasos.slice(-8) },
      enCurso: lista.filter((p) => p.estado === "cargando" || p.estado === "activo" || p.estado === "finalizando").length,
      participantes: lista,
    };
  }
}
