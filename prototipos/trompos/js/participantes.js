// Identidad de los participantes (orden 03).
//
// Cada trompo representa a una persona, y la persona es un dato, no un dibujo:
//
//   { id, nombre, foto, inicial, color, disenoId, variante,
//     vidaMaxima, vidaActual, estado, posicion, eliminaciones, danioRealizado }
//
// Los datos son **simulados** (nombres inventados y caras geométricas generadas por
// `generar-fotos.mjs`), pero el camino es el real: la foto se carga con un `<img>` de
// verdad desde `fotos/`, así que se puede probar qué pasa cuando falta, cuando pesa
// demasiado, cuando tiene otra proporción o cuando el servidor devuelve 404.
//
// Los trompos del mismo diseño se reparten por **variante**: el mismo modelo con otro
// tinte y un anillo de órbita de más, para que con 40 participantes no haya dos
// trompos idénticos. El nombre del diseño no cambia.

import { Trompo } from "./trompo.js";
import { DISENOS, ORDEN_DISENOS } from "./dibujo/disenos.js";
import { limitar, mezclarColor, hslAHex } from "./util.js";
import { medidaArena, radioDe, limitesDe } from "./parametros.js";

/**
 * Plantilla simulada: 44 identidades. Los diez primeros son los de la orden 01.
 *
 * Casos metidos a propósito, para poder probarlos sin inventarse nada:
 *   * `indice 10` — nombre largo (se recorta en la etiqueta, entero en la tabla);
 *   * `indice 11` — **mismo nombre** que el 0 (dos Carlos), con identidad distinta;
 *   * `indice 12` — **sin foto** (respaldo de inicial);
 *   * `indice 13` — **foto que falta** (`fotos/falta-99.png` da 404);
 *   * `indice 14` — foto **panorámica** (240×96), para el recorte centrado.
 */
export const PLANTILLA = [
  { nombre: "Carlos", foto: "fotos/retrato-01.png" },
  { nombre: "Ana", foto: "fotos/retrato-02.png" },
  { nombre: "Mariana", foto: "fotos/retrato-03.png" },
  { nombre: "Juan", foto: "fotos/retrato-04.png" },
  { nombre: "Sofi", foto: "fotos/retrato-05.png" },
  { nombre: "Drako", foto: "fotos/retrato-06.png" },
  { nombre: "Vanessa", foto: "fotos/retrato-07.png" },
  { nombre: "Lupe", foto: "fotos/retrato-08.png" },
  { nombre: "Ricardo", foto: "fotos/retrato-09.png" },
  { nombre: "Camilo", foto: "fotos/retrato-10.png" },
  { nombre: "María de los Ángeles Fernández", foto: "fotos/retrato-11.png" },
  { nombre: "Carlos", foto: "fotos/retrato-12.png" },
  { nombre: "Nova", foto: null },
  { nombre: "Zafiro", foto: "fotos/falta-99.png" },
  { nombre: "Rayo", foto: "fotos/panoramica-01.png" },
  { nombre: "Cobalto", foto: "fotos/retrato-15.png" },
  { nombre: "Ónix", foto: "fotos/retrato-16.png" },
  { nombre: "Titán", foto: "fotos/retrato-17.png" },
  { nombre: "Vega", foto: "fotos/retrato-18.png" },
  { nombre: "Kuma", foto: "fotos/retrato-19.png" },
  { nombre: "Iris", foto: "fotos/retrato-20.png" },
  { nombre: "Duna", foto: "fotos/retrato-21.png" },
  { nombre: "Fénix", foto: "fotos/retrato-22.png" },
  { nombre: "Lince", foto: "fotos/retrato-23.png" },
  { nombre: "Maya", foto: "fotos/retrato-24.png" },
  { nombre: "Nerón", foto: "fotos/retrato-25.png" },
  { nombre: "Orbe", foto: "fotos/retrato-26.png" },
  { nombre: "Perla", foto: "fotos/retrato-27.png" },
  { nombre: "Quásar", foto: "fotos/retrato-28.png" },
  { nombre: "Rubí", foto: "fotos/retrato-29.png" },
  { nombre: "Sable", foto: "fotos/retrato-30.png" },
  { nombre: "Trueno", foto: "fotos/retrato-31.png" },
  { nombre: "Umbra", foto: "fotos/retrato-32.png" },
  { nombre: "Vértigo", foto: "fotos/retrato-33.png" },
  { nombre: "Wanda", foto: "fotos/retrato-34.png" },
  { nombre: "Xena", foto: "fotos/retrato-35.png" },
  { nombre: "Yuki", foto: "fotos/retrato-36.png" },
  { nombre: "Zeta", foto: "fotos/retrato-37.png" },
  { nombre: "Alba", foto: "fotos/retrato-38.png" },
  { nombre: "Bruno", foto: "fotos/retrato-39.png" },
  { nombre: "Cira", foto: "fotos/retrato-40.png" },
  { nombre: "Dante", foto: "fotos/retrato-41.png" },
  { nombre: "Elena", foto: "fotos/retrato-42.png" },
  { nombre: "Juan Pablo de la Cruz y Ríos", foto: "fotos/retrato-43.png" },
];

/** Colores identificadores: uno por participante, repartidos por el círculo cromático. */
export function colorDeIndice(indice) {
  return hslAHex(indice * 137.508, 0.62, 0.52);
}

/**
 * Diseño de un participante: el mismo modelo, con su variante.
 *
 * La variante cambia el tinte (más cuanto más repetido esté el diseño) y añade una
 * órbita, para que cuatro copias del mismo diseño no parezcan cuatro trompos iguales.
 * El nombre del diseño y su geometría base no cambian.
 */
export function disenoDeParticipante(clave, colorJugador, variante = 0) {
  const base = DISENOS[clave] ?? DISENOS.ataque;
  if (variante <= 0) return base;
  const tinte = 0.16 + 0.16 * variante;
  const colores = {
    base: mezclarColor(base.colores.base, colorJugador, tinte),
    claro: mezclarColor(base.colores.claro, colorJugador, tinte * 0.6),
    oscuro: mezclarColor(base.colores.oscuro, colorJugador, tinte * 0.35),
    acento: mezclarColor(base.colores.acento, colorJugador, 0.32 + 0.15 * variante),
    brillo: base.colores.brillo,
  };
  const orbitas = [
    ...base.orbitas,
    {
      radio: 1.55 + 0.06 * variante,
      inclinacion: 0.5 + 0.1 * variante,
      grosor: 1.8,
      puntos: 1 + (variante % 3),
      velocidad: (variante % 2 === 0 ? 1 : -1) * 0.6,
      capa: variante % 2 === 0 ? 1 : -1,
      color: "acento",
    },
  ];
  return { ...base, colores, orbitas, variante };
}

export class Participante {
  constructor({ id, nombre, foto, color, disenoId, variante, indice, userId = null }) {
    this.id = id;
    // Identidad de TikTok (orden 06): el userId es la clave estable; el nombre puede
    // cambiar y la foto puede caer, pero el participante sigue siendo el mismo.
    this.userId = userId;
    this.nombre = nombre;
    this.nombreCompleto = nombre;
    this.foto = foto;
    this.color = color;
    this.disenoId = disenoId;
    this.variante = variante;
    this.indice = indice;

    // Estado de batalla (lo mantiene `sincronizar`).
    this.vidaMaxima = 0;
    this.vidaActual = 0;
    this.estado = "esperando";
    this.posicion = 0;
    this.eliminaciones = 0;
    this.danioRealizado = 0;
    this.eliminadoPor = null;
    this.motivo = null;
  }

  /** Inicial de respaldo: la primera letra con algo que se vea. */
  get inicial() {
    const letra = (this.nombre ?? "?").trim().charAt(0);
    return letra ? letra.toUpperCase() : "?";
  }

  /** Diseño con la variante de este participante. */
  diseno() {
    return disenoDeParticipante(this.disenoId, this.color, this.variante);
  }

  /** Copia los valores de batalla del trompo a la ficha de identidad. */
  sincronizar(trompo, posicion) {
    if (!trompo) return this;
    this.vidaMaxima = trompo.vidaMax;
    this.vidaActual = Math.max(0, trompo.vida);
    this.eliminaciones = trompo.eliminaciones;
    this.danioRealizado = Math.round(trompo.danioHecho);
    this.danioRecibido = Math.round(trompo.danioRecibido);
    this.eliminadoPor = trompo.eliminadoPor ? trompo.eliminadoPor.nombre : null;
    this.posicion = posicion ?? 0;
    this.estado =
      trompo.estado === "activo"
        ? "activo"
        : trompo.estado === "ko"
          ? "ko"
          : trompo.estado === "fuera"
            ? "fuera"
            : "esperando";
    return this;
  }

  /** Ficha plana, con los nombres que pide la orden. */
  ficha() {
    return {
      id: this.id,
      nombre: this.nombre,
      nombreCompleto: this.nombreCompleto,
      foto: this.foto,
      inicial: this.inicial,
      color: this.color,
      disenoId: this.disenoId,
      variante: this.variante,
      vidaMaxima: this.vidaMaxima,
      vidaActual: Math.round(this.vidaActual),
      estado: this.estado,
      posicion: this.posicion,
      eliminaciones: this.eliminaciones,
      danioRealizado: this.danioRealizado,
      eliminadoPor: this.eliminadoPor,
      motivo: this.motivo,
    };
  }
}

let contadorIds = 0;

/** Crea un participante de la plantilla por su índice. */
export function participanteDeIndice(indice, datos = {}) {
  const base = PLANTILLA[indice % PLANTILLA.length] ?? { nombre: `Jugador ${indice + 1}`, foto: null };
  const disenoId = ORDEN_DISENOS[indice % ORDEN_DISENOS.length];
  contadorIds += 1;
  return new Participante({
    id: `p${contadorIds}`,
    nombre: datos.nombre ?? base.nombre,
    foto: datos.foto !== undefined ? datos.foto : base.foto,
    color: datos.color ?? colorDeIndice(indice),
    disenoId: datos.disenoId ?? disenoId,
    // La variante sale de cuántas veces se ha repetido el diseño en la plantilla.
    variante: datos.variante ?? Math.floor(indice / ORDEN_DISENOS.length),
    indice,
    userId: datos.userId ?? null,
  });
}

/**
 * Crea los trompos de una ronda.
 *
 * Se juega con los `participantes` primeros de la plantilla: ni uno de relleno. Si se
 * piden menos de diez, se juega con menos.
 */
export function crearAlineacion(azar, p, ronda = 0, usuarios = []) {
  const cuantos = limitar(p.simulacion.participantes, 0, PLANTILLA.length);
  const lista = [];
  for (let i = 0; i < cuantos; i += 1) {
    // Los primeros sitios son para los espectadores de verdad (orden 06): conservan
    // su nombre y su foto de ronda en ronda. El resto se rellena con la plantilla.
    const usuario = usuarios[i];
    const participante = usuario
      ? participanteDeIndice(i, {
          nombre: usuario.displayName || usuario.userName || usuario.userId,
          foto: usuario.avatarUrl || null,
          userId: usuario.userId,
        })
      : participanteDeIndice(i);
    lista.push(crearTrompo(azar, p, participante, i));
  }
  repartir(lista, p, azar);
  return lista;
}

export function crearTrompo(azar, p, participante, indice = 0) {
  const diseno = participante.diseno();
  const radio = radioDe(p, diseno);
  const masa = p.trompo.densidadBase * diseno.densidad * Math.pow(radio / p.trompo.radioBase, 2);
  const t = new Trompo({
    id: participante.id,
    participante,
    diseno,
    x: p.lienzo.ancho * 0.5,
    y: p.lienzo.alto * 0.5,
    vx: 0,
    vy: 0,
    radio,
    masa,
    vidaMax: p.vida.inicial,
    ataque: diseno.ataque * azar.rango(1 - p.trompo.desvio, 1 + p.trompo.desvio),
    defensa: diseno.defensa * azar.rango(1 - p.trompo.desvio, 1 + p.trompo.desvio),
    fase: azar.siguiente() * Math.PI * 2 + indice * 0.7,
    velGiro: azar.rango(p.trompo.giroMinimo, p.trompo.giroMaximo) * (indice % 2 === 0 ? 1 : -1),
    marcaAparicion: p.trompo.aparicionEscalon * (indice % 8),
  });
  participante.sincronizar(t, indice + 1);
  return t;
}

/**
 * Reparte los trompos por la arena: rejilla lo más cuadrada posible para su número,
 * con un desvío pequeño y reproducible dentro de cada celda.
 */
function repartir(lista, p, azar) {
  const arena = medidaArena(p);
  const n = lista.length;
  if (!n) return;
  const radioMayor = lista.reduce((m, t) => Math.max(m, t.radio), 0);

  const ideal = Math.max(1, Math.round(Math.sqrt((n * arena.ancho) / arena.alto)));
  const caben = Math.max(1, Math.floor(arena.ancho / (2.6 * radioMayor)));
  const columnas = limitar(ideal, 1, caben);
  const filas = Math.ceil(n / columnas);
  const celdaAncho = arena.ancho / columnas;
  const celdaAlto = arena.alto / filas;

  lista.forEach((t, i) => {
    const col = i % columnas;
    const fil = Math.floor(i / columnas);
    const columnaReal = fil % 2 === 0 ? col : columnas - 1 - col;
    const cx = arena.x + celdaAncho * (columnaReal + 0.5);
    const cy = arena.y + celdaAlto * (fil + 0.5);

    const margenX = Math.max(0, celdaAncho / 2 - t.radio - 6);
    const margenY = Math.max(0, celdaAlto / 2 - t.radio * 1.3 - 22);
    const L = limitesDe(p, t.radio);
    t.x = limitar(cx + azar.rango(-margenX, margenX), L.xMin, L.xMax);
    t.y = limitar(cy + azar.rango(-margenY, margenY), L.yMin, L.yMax);

    const angulo = azar.rango(0, Math.PI * 2);
    const rapidez = azar.rango(p.trompo.rapidezMinima, p.trompo.rapidezMaxima);
    t.vx = Math.cos(angulo) * rapidez;
    t.vy = Math.sin(angulo) * rapidez;
    t.rumbo = angulo;
    t.instantaneaInicial = {
      x: t.x,
      y: t.y,
      vx: t.vx,
      vy: t.vy,
      rumbo: t.rumbo,
      marcaAparicion: t.marcaAparicion,
      velGiro: t.velGiro,
    };
  });
}

/**
 * Busca un sitio libre para que alguien entre en la arena sin caerle encima a nadie.
 *
 * Se prueban 60 candidatos al azar y se elige el que esté más lejos del trompo más
 * cercano. Si el mejor sitio no llega a dos radios y medio de distancia, se devuelve
 * igualmente: es preferible que entre pegado a que no entre.
 */
export function buscarSitioLibre(lista, radio, p, azar) {
  const L = limitesDe(p, radio);
  let mejor = null;
  for (let i = 0; i < 60; i += 1) {
    const x = azar.rango(L.xMin, L.xMax);
    const y = azar.rango(L.yMin, L.yMax);
    let minimo = Infinity;
    for (const t of lista) {
      if (!t.activo) continue;
      minimo = Math.min(minimo, Math.hypot(t.x - x, t.y - y) - (t.radio + radio));
    }
    if (minimo === Infinity) minimo = 1e6;
    if (!mejor || minimo > mejor.minimo) mejor = { x, y, minimo };
  }
  return { x: mejor.x, y: mejor.y, holgura: Number(mejor.minimo.toFixed(1)) };
}

/**
 * Añade un participante durante la ronda: entra por un sitio libre, con su aparición
 * y sin reiniciar la batalla.
 */
export function anadirParticipante(azar, p, lista, ronda = 0, identidad = null) {
  // El tope cuenta sólo a los que están dentro: uno retirado (con su fade) libera sitio.
  const dentro = lista.filter((t) => t.estado !== "fuera").length;
  if (dentro >= Math.min(p.simulacion.maxParticipantes, PLANTILLA.length)) return null;
  const indice = lista.length;
  const participante = identidad
    ? participanteDeIndice(indice, {
        nombre: identidad.nombre,
        foto: identidad.foto ?? null,
        userId: identidad.userId ?? null,
        disenoId: identidad.disenoId ?? undefined,
      })
    : participanteDeIndice(indice);
  const t = crearTrompo(azar, p, participante, indice);
  const sitio = buscarSitioLibre(lista, t.radio, p, azar);
  t.x = sitio.x;
  t.y = sitio.y;
  t.holguraEntrada = sitio.holgura;
  const angulo = -Math.PI / 2 + azar.rango(-0.6, 0.6);
  t.vx = Math.cos(angulo) * 420;
  t.vy = Math.sin(angulo) * 420;
  t.rumbo = angulo;
  t.estado = "espera";
  t.marcaAparicion = 0;
  t.aparicion = 0;
  t.enLiza = true;
  t.instantaneaInicial = {
    x: t.x,
    y: t.y,
    vx: t.vx,
    vy: t.vy,
    rumbo: angulo,
    marcaAparicion: 0,
    velGiro: t.velGiro,
  };
  lista.push(t);
  return t;
}

/** Ficha legible de un trompo (para las pruebas y el HUD). */
export function ficha(t) {
  return {
    ...t.participante.ficha(),
    // La identidad usa `vidaActual`/`vidaMaxima`; los bancos y el HUD miran `vida` y
    // `vidaMax`. Se dan las dos, con el mismo valor.
    vida: Math.round(t.vida),
    vidaMax: t.vidaMax,
    diseno: t.diseno.clave,
    disenoNombre: t.diseno.nombre,
    variante: t.diseno.variante ?? 0,
    estadoTrompo: t.estado,
    ataque: Number(t.ataque.toFixed(2)),
    defensa: Number(t.defensa.toFixed(2)),
    masa: Number(t.masa.toFixed(3)),
    radio: Number(t.radio.toFixed(1)),
    rapidez: Number(t.rapidez.toFixed(1)),
  };
}
