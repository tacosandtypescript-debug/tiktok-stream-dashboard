// Los diez diseños de trompo, generados por código.
//
// Cada diseño declara su geometría —número y forma de palas, lados del anillo,
// patrón, núcleo, órbitas, adorno— y aquí se pinta. Cambiar de diseño cambia la
// silueta de verdad: no es un recoloreado. Lo que se repite entre diseños son las
// capas (anillo exterior, palas, anillo interior, patrón, núcleo), que es
// exactamente la lista que pide la orden.
//
// Nada de esto usa imágenes: sólo arcos, polígonos, líneas, degradados y
// transparencias.

import { TAU, conAlfa, mezclarColor, tono, limitar } from "../util.js";
import {
  poligono,
  estrella,
  sectorAnillo,
  anilloConHuecos,
  caminoPala,
  caminoRayo,
  caminoEspiral,
  degradadoRadial,
  degradadoLineal,
  gajos,
} from "./geometria.js";

// ------------------------------------------------------------------ diseños

export const DISENOS = {
  ataque: {
    clave: "ataque",
    nombre: "Ataque radial",
    lema: "Seis filos hacia fuera",
    colores: { base: "#c62828", claro: "#ff6b4a", oscuro: "#4a0b12", acento: "#ffcf5c", brillo: "#fff0c2" },
    radio: 1,
    densidad: 0.98,
    ataque: 1.35,
    defensa: 0.88,
    anillo: { lados: 12, grosor: 0.15, estilo: "muescas", muescas: 12 },
    palas: { n: 6, forma: "filo", r0: 0.62, r1: 1.34, ancho: 0.3, curvatura: 0, desfase: 0 },
    patron: "radial",
    nucleo: "circulo",
    orbitas: [{ radio: 1.46, inclinacion: 0.34, grosor: 2.4, puntos: 0, velocidad: 0.7, capa: 1, color: "acento" }],
    aura: { radio: 1.9, fuerza: 1 },
    rastro: { largo: 16, ancho: 0.5 },
  },

  defensa: {
    clave: "defensa",
    nombre: "Defensa orbital",
    lema: "Cuatro placas y tres aros",
    colores: { base: "#1e5fb4", claro: "#63b4ff", oscuro: "#0a1c3d", acento: "#a8e6ff", brillo: "#e6f7ff" },
    radio: 1.1,
    densidad: 1.22,
    ataque: 0.86,
    defensa: 1.42,
    anillo: { lados: 8, grosor: 0.19, estilo: "placas", placas: 8 },
    palas: { n: 4, forma: "escudo", r0: 0.6, r1: 1.12, ancho: 0.52, curvatura: 0, desfase: Math.PI / 4 },
    patron: "orbital",
    nucleo: "hexagono",
    orbitas: [
      { radio: 1.28, inclinacion: 0.22, grosor: 2, puntos: 0, velocidad: -0.5, capa: -1, color: "claro" },
      { radio: 1.52, inclinacion: 0.5, grosor: 2.6, puntos: 3, velocidad: 0.85, capa: 1, color: "acento" },
    ],
    aura: { radio: 1.75, fuerza: 0.9 },
    rastro: { largo: 14, ancho: 0.6 },
  },

  balance: {
    clave: "balance",
    nombre: "Balance doble",
    lema: "Dos hojas opuestas",
    colores: { base: "#7b2fbe", claro: "#c07bff", oscuro: "#2a0a45", acento: "#ffd1f7", brillo: "#f3e2ff" },
    radio: 1.04,
    densidad: 1.02,
    ataque: 1.1,
    defensa: 1.12,
    anillo: { lados: 8, grosor: 0.09, estilo: "doble", separacion: 0.14 },
    palas: { n: 2, forma: "doble", r0: 0.5, r1: 1.42, ancho: 0.44, curvatura: 0.35, desfase: 0 },
    patron: "espejo",
    nucleo: "estrella",
    orbitas: [{ radio: 1.3, inclinacion: 0.62, grosor: 2.2, puntos: 2, velocidad: 0.6, capa: 1, color: "acento" }],
    aura: { radio: 1.8, fuerza: 0.95 },
    rastro: { largo: 15, ancho: 0.55 },
  },

  velocidad: {
    clave: "velocidad",
    nombre: "Velocidad espiral",
    lema: "Cinco aletas barridas",
    colores: { base: "#0f9bb0", claro: "#67f2ff", oscuro: "#053642", acento: "#c9fbff", brillo: "#eafeff" },
    radio: 0.93,
    densidad: 0.82,
    ataque: 1.18,
    defensa: 0.84,
    anillo: { lados: 24, grosor: 0.055, estilo: "discontinuo", trazos: [14, 8] },
    palas: { n: 5, forma: "espiral", r0: 0.44, r1: 1.3, ancho: 0.17, curvatura: 0.85, desfase: 0.4 },
    patron: "espiral",
    nucleo: "espiral",
    orbitas: [
      { radio: 1.22, inclinacion: 0.75, grosor: 1.6, puntos: 0, velocidad: -1.1, capa: -1, color: "claro" },
      { radio: 1.44, inclinacion: 0.3, grosor: 1.8, puntos: 0, velocidad: 1.4, capa: 1, color: "acento" },
    ],
    aura: { radio: 1.85, fuerza: 0.8 },
    rastro: { largo: 26, ancho: 0.4 },
  },

  electrico: {
    clave: "electrico",
    nombre: "Eléctrico",
    lema: "Tres rayos y un anillo roto",
    colores: { base: "#e5b100", claro: "#ffe873", oscuro: "#4a3a00", acento: "#8ad7ff", brillo: "#fffbe0" },
    radio: 1,
    densidad: 0.94,
    ataque: 1.28,
    defensa: 0.92,
    anillo: { lados: 9, grosor: 0.12, estilo: "cortado", cortes: 3 },
    palas: { n: 3, forma: "rayo", r0: 0.56, r1: 1.36, ancho: 0.34, curvatura: 0, dientes: 4, desfase: 0.3 },
    patron: "zigzag",
    nucleo: "bolt",
    orbitas: [{ radio: 1.38, inclinacion: 0.45, grosor: 2, puntos: 4, velocidad: 1.6, capa: 1, color: "acento" }],
    aura: { radio: 1.95, fuerza: 1.05 },
    rastro: { largo: 18, ancho: 0.45 },
    adorno: "arcos",
  },

  volcanico: {
    clave: "volcanico",
    nombre: "Volcánico",
    lema: "Ocho rocas y lava",
    colores: { base: "#e2600a", claro: "#ffa53d", oscuro: "#421200", acento: "#ffe08a", brillo: "#fff3d0" },
    radio: 1.06,
    densidad: 1.16,
    ataque: 1.24,
    defensa: 1.05,
    anillo: { lados: 7, grosor: 0.17, estilo: "roca", semilla: 91 },
    palas: { n: 8, forma: "roca", r0: 0.6, r1: 1.16, ancho: 0.34, curvatura: 0, desfase: 0.2, semilla: 55 },
    patron: "grietas",
    nucleo: "lava",
    orbitas: [{ radio: 1.42, inclinacion: 0.25, grosor: 3.2, puntos: 0, velocidad: 0.5, capa: 1, color: "acento" }],
    aura: { radio: 2, fuerza: 1.1 },
    rastro: { largo: 15, ancho: 0.62 },
    adorno: "brasas",
  },

  cristal: {
    clave: "cristal",
    nombre: "Cristal",
    lema: "Seis facetas translúcidas",
    colores: { base: "#d6467f", claro: "#ff9ec7", oscuro: "#4d0f2c", acento: "#ffe3f1", brillo: "#fff5fa" },
    radio: 1.02,
    densidad: 0.9,
    ataque: 1.14,
    defensa: 0.98,
    anillo: { lados: 5, grosor: 0.1, estilo: "facetas" },
    palas: { n: 6, forma: "cristal", r0: 0.5, r1: 1.28, ancho: 0.3, curvatura: 0, desfase: 0.26 },
    patron: "facetas",
    nucleo: "cristal",
    orbitas: [
      { radio: 1.24, inclinacion: 0.55, grosor: 1.6, puntos: 0, velocidad: 0.9, capa: -1, color: "claro" },
      { radio: 1.5, inclinacion: 0.18, grosor: 1.4, puntos: 0, velocidad: -0.7, capa: 1, color: "brillo" },
    ],
    aura: { radio: 1.8, fuerza: 0.85 },
    rastro: { largo: 17, ancho: 0.48 },
    adorno: "destellos",
  },

  sombra: {
    clave: "sombra",
    nombre: "Sombra",
    lema: "Cuatro guadañas y humo",
    colores: { base: "#4b2a8c", claro: "#8f6bd8", oscuro: "#140a2e", acento: "#c9a6ff", brillo: "#e8dcff" },
    radio: 1.02,
    densidad: 0.96,
    ataque: 1.3,
    defensa: 0.95,
    anillo: { lados: 10, grosor: 0.16, estilo: "difuso" },
    palas: { n: 4, forma: "guadana", r0: 0.48, r1: 1.4, ancho: 0.26, curvatura: 0.75, desfase: 0.5 },
    patron: "humo",
    nucleo: "ojo",
    orbitas: [{ radio: 1.34, inclinacion: 0.68, grosor: 2.2, puntos: 2, velocidad: -0.9, capa: 1, color: "acento" }],
    aura: { radio: 2.05, fuerza: 1.05 },
    rastro: { largo: 20, ancho: 0.7 },
    adorno: "humo",
  },

  viento: {
    clave: "viento",
    nombre: "Viento",
    lema: "Tres crecientes verdes",
    colores: { base: "#1f9d4d", claro: "#7ef0a4", oscuro: "#07331b", acento: "#d6ffe4", brillo: "#f0fff5" },
    radio: 0.98,
    densidad: 0.86,
    ataque: 1.06,
    defensa: 0.9,
    anillo: { lados: 16, grosor: 0.07, estilo: "segmentos", segmentos: 16 },
    palas: { n: 3, forma: "arco", r0: 0.42, r1: 1.32, ancho: 0.42, curvatura: 0.62, desfase: 0.9 },
    patron: "plumas",
    nucleo: "aspas",
    orbitas: [
      { radio: 1.2, inclinacion: 0.85, grosor: 1.8, puntos: 0, velocidad: 1.2, capa: -1, color: "claro" },
      { radio: 1.48, inclinacion: 0.42, grosor: 1.6, puntos: 0, velocidad: -1, capa: 1, color: "acento" },
    ],
    aura: { radio: 1.9, fuerza: 0.9 },
    rastro: { largo: 24, ancho: 0.42 },
    adorno: "viento",
  },

  cosmico: {
    clave: "cosmico",
    nombre: "Cósmico",
    lema: "Blanco y dorado con tres órbitas",
    colores: { base: "#e8e3d0", claro: "#ffffff", oscuro: "#3a3428", acento: "#ffcc44", brillo: "#fff8dd" },
    radio: 1.05,
    densidad: 1.08,
    ataque: 1.2,
    defensa: 1.18,
    anillo: { lados: 12, grosor: 0.08, estilo: "doble", separacion: 0.16 },
    palas: { n: 5, forma: "estrella", r0: 0.5, r1: 1.3, ancho: 0.36, curvatura: 0, desfase: 0.15 },
    patron: "orbes",
    nucleo: "astro",
    orbitas: [
      { radio: 1.26, inclinacion: 0.6, grosor: 1.8, puntos: 3, velocidad: 0.75, capa: -1, color: "acento" },
      { radio: 1.5, inclinacion: 0.3, grosor: 2.2, puntos: 5, velocidad: -0.55, capa: 1, color: "brillo" },
    ],
    aura: { radio: 2.1, fuerza: 1.15 },
    rastro: { largo: 19, ancho: 0.52 },
    adorno: "polvo",
  },
};

/** Orden de presentación (el de la orden). */
export const ORDEN_DISENOS = [
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

/** Color del diseño por nombre de ranura, para no repetir el mapa en cada capa. */
export function colorDe(d, ranura = "base") {
  return d.colores[ranura] ?? d.colores.base;
}

// ------------------------------------------------------------------ capas

/**
 * Aura radial. Es un degradado, no un `shadowBlur`: la sombra difusa del lienzo
 * cuesta carísima con diez trompos a 60 fps y aquí se pinta una vez por trompo.
 * La vida decide radio, fuerza y color (rojo/naranja cuando está bajo).
 */
export function dibujarAura(ctx, d, radio, vida, esLider, t, fase, recorte = 1) {
  const apagado = vida < 0.33;
  const color = apagado ? mezclarColor(colorDe(d, "claro"), "#ff4a1e", 1 - vida / 0.33) : colorDe(d, "claro");
  const fuerza = (0.16 + 0.3 * vida * vida) * d.aura.fuerza * (esLider ? 1.35 : 1);
  const pulso = 1 + Math.sin(t * 2.2 + fase) * 0.05;
  const r = radio * d.aura.radio * pulso * (esLider ? 1.08 : 1) * recorte;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = degradadoRadial(ctx, r, [
    [0, conAlfa(color, fuerza)],
    [0.42, conAlfa(color, fuerza * 0.55)],
    [0.72, conAlfa(colorDe(d, "base"), fuerza * 0.18)],
    [1, conAlfa(colorDe(d, "base"), 0)],
  ]);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  // El líder lleva además un anillo dorado giratorio: se distingue de un vistazo.
  if (esLider) {
    ctx.strokeStyle = conAlfa("#ffd76a", 0.35 + 0.25 * Math.sin(t * 4.5));
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 12]);
    ctx.lineDashOffset = -t * 60;
    ctx.beginPath();
    ctx.arc(0, 0, radio * 1.62, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** Anillos orbitando: elipses giradas con inclinación, y bolitas en algunos. */
export function dibujarOrbitas(ctx, d, radio, t, fase, cuando) {
  const orbitas = d.orbitas ?? [];
  for (let i = 0; i < orbitas.length; i += 1) {
    const o = orbitas[i];
    const capa = o.capa ?? 1;
    if (cuando === "atras" ? capa >= 0 : capa < 0) continue;
    const color = colorDe(d, o.color ?? "acento");
    const giro = t * o.velocidad * 0.6 + fase + i;
    const r = radio * o.radio;
    // Los anillos orbitales sí se afinan con el radio: son decorativos y a tamaño
    // pequeño un aro grueso convertiría el trompo en una jaula. El suelo de 1,2 px
    // es para que no desaparezcan.
    const grosor = Math.max(1.2, o.grosor * Math.min(1, radio / 60));
    const bolita = Math.max(2.4, o.grosor * 1.5 * Math.min(1, radio / 60));

    ctx.save();
    ctx.rotate(giro);
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = conAlfa(color, 0.5);
    ctx.lineWidth = grosor;
    ctx.save();
    ctx.scale(1, o.inclinacion);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // Bolitas: se colocan a mano para que no salgan achatadas por el `scale`.
    // Sin degradado: con cuarenta trompos hay más de cien bolitas por fotograma y un
    // `createRadialGradient` por bolita se come el presupuesto de dibujo. Dos círculos
    // aditivos (halo y núcleo) dan el mismo efecto.
    const puntos = o.puntos ?? 0;
    for (let k = 0; k < puntos; k += 1) {
      const a = giro * 1.4 + (k / puntos) * TAU;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * o.inclinacion;
      ctx.fillStyle = conAlfa(color, 0.22);
      ctx.beginPath();
      ctx.arc(x, y, bolita * 1.7, 0, TAU);
      ctx.fill();
      ctx.fillStyle = conAlfa(color, 0.85);
      ctx.beginPath();
      ctx.arc(x, y, bolita, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Anillo exterior: la silueta. Cada diseño usa un estilo distinto. */
export function dibujarAnilloExterior(ctx, d, radio, vida) {
  const a = d.anillo;
  const color = colorDe(d, "base");
  const luz = 0.35 + 0.65 * vida;
  const r = radio * 0.97;
  const grosor = Math.max(1.6, radio * a.grosor);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  switch (a.estilo) {
    case "placas": {
      const n = a.placas ?? 8;
      const paso = TAU / n;
      for (let i = 0; i < n; i += 1) {
        const p = sectorAnillo(0, 0, r - grosor * 0.9, r + grosor * 0.55, i * paso + 0.06, (i + 1) * paso - 0.06);
        ctx.fillStyle = degradadoRadial(ctx, r, [
          [0.6, conAlfa(color, 0.25 * luz)],
          [0.82, conAlfa(colorDe(d, "claro"), 0.85 * luz)],
          [1, conAlfa(colorDe(d, "acento"), 0.5 * luz)],
        ]);
        ctx.fill(p);
        ctx.strokeStyle = conAlfa(colorDe(d, "brillo"), 0.35 * luz);
        ctx.lineWidth = 1.4;
        ctx.stroke(p);
      }
      break;
    }
    case "doble": {
      const sep = radio * (a.separacion ?? 0.14);
      for (const [rr, alfa] of [
        [r - sep, 0.85],
        [r + sep * 0.55, 0.55],
      ]) {
        ctx.strokeStyle = conAlfa(colorDe(d, "claro"), alfa * luz);
        ctx.lineWidth = grosor;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.stroke();
      }
      break;
    }
    case "cortado": {
      const n = a.cortes ?? 3;
      ctx.strokeStyle = conAlfa(colorDe(d, "claro"), 0.9 * luz);
      ctx.lineWidth = grosor;
      const paso = TAU / n;
      for (let i = 0; i < n; i += 1) {
        ctx.beginPath();
        ctx.arc(0, 0, r, i * paso + 0.22, (i + 1) * paso - 0.22);
        ctx.stroke();
      }
      // Chispas en los cortes: donde el anillo se rompe, salta la luz.
      for (let i = 0; i < n; i += 1) {
        const ang = i * paso;
        const x = Math.cos(ang) * r;
        const y = Math.sin(ang) * r;
        ctx.fillStyle = conAlfa(colorDe(d, "acento"), 0.5 * luz);
        ctx.beginPath();
        ctx.arc(x, y, grosor * 1.1, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case "roca": {
      const azarRadios = [];
      for (let i = 0; i < a.lados; i += 1) azarRadios.push(0.9 + ((i * 37) % 11) / 55);
      const p = poligono(0, 0, r, a.lados, 0.28, azarRadios);
      ctx.fillStyle = degradadoRadial(ctx, r, [
        [0.55, conAlfa(color, 0.18 * luz)],
        [0.88, conAlfa(color, 0.78 * luz)],
        [1, conAlfa(colorDe(d, "claro"), 0.35 * luz)],
      ]);
      ctx.fill(p);
      ctx.strokeStyle = conAlfa(colorDe(d, "acento"), 0.45 * luz);
      ctx.lineWidth = 2;
      ctx.stroke(p);
      break;
    }
    case "facetas": {
      const p = poligono(0, 0, r, a.lados, 0.4);
      ctx.fillStyle = conAlfa(colorDe(d, "claro"), 0.22 * luz);
      ctx.fill(p);
      ctx.strokeStyle = conAlfa(colorDe(d, "brillo"), 0.7 * luz);
      ctx.lineWidth = grosor;
      ctx.stroke(p);
      ctx.lineWidth = 1;
      ctx.strokeStyle = conAlfa(colorDe(d, "brillo"), 0.28 * luz);
      for (let i = 0; i < a.lados; i += 1) {
        const ang = 0.4 + (i / a.lados) * TAU;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
        ctx.stroke();
      }
      break;
    }
    case "difuso": {
      for (let i = 3; i >= 1; i -= 1) {
        ctx.strokeStyle = conAlfa(colorDe(d, "claro"), 0.16 * luz * i);
        ctx.lineWidth = grosor * (0.6 + i * 0.5);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.stroke();
      }
      break;
    }
    case "discontinuo": {
      ctx.strokeStyle = conAlfa(colorDe(d, "claro"), 0.85 * luz);
      ctx.lineWidth = grosor;
      ctx.setLineDash(a.trazos ?? [14, 8]);
      ctx.lineDashOffset = -performance.now() * 0.02;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case "segmentos": {
      const n = a.segmentos ?? 16;
      const paso = TAU / n;
      for (let i = 0; i < n; i += 1) {
        ctx.strokeStyle = conAlfa(i % 2 === 0 ? colorDe(d, "claro") : colorDe(d, "acento"), 0.75 * luz);
        ctx.lineWidth = grosor;
        ctx.beginPath();
        ctx.arc(0, 0, r, i * paso, (i + 1) * paso - 0.05);
        ctx.stroke();
      }
      break;
    }
    default: {
      // muescas: polígono de N lados con dientes hacia fuera.
      const p = poligono(0, 0, r, a.lados, 0.2);
      ctx.strokeStyle = conAlfa(colorDe(d, "claro"), 0.9 * luz);
      ctx.lineWidth = grosor;
      ctx.stroke(p);
      const muescas = a.muescas ?? a.lados;
      for (let i = 0; i < muescas; i += 1) {
        const ang = 0.2 + (i / muescas) * TAU;
        const x0 = Math.cos(ang) * (r + grosor * 0.4);
        const y0 = Math.sin(ang) * (r + grosor * 0.4);
        const x1 = Math.cos(ang) * (r + grosor * 2.4);
        const y1 = Math.sin(ang) * (r + grosor * 2.4);
        ctx.strokeStyle = conAlfa(colorDe(d, "acento"), 0.55 * luz);
        ctx.lineWidth = Math.max(1.2, grosor * 0.5);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/** Palas: la parte que de verdad cambia la silueta de cada diseño. */
export function dibujarPalas(ctx, d, radio, vida, t) {
  const pal = d.palas;
  const luz = 0.4 + 0.6 * vida;
  const r0 = radio * pal.r0;
  const r1 = radio * pal.r1;
  const ancho = radio * pal.ancho;
  const camino = caminoPala(pal.forma, r0, r1, ancho, {
    curvatura: pal.curvatura,
    dientes: pal.dientes,
    semilla: pal.semilla ?? 7,
  });

  ctx.save();
  for (let i = 0; i < pal.n; i += 1) {
    ctx.save();
    ctx.rotate((pal.desfase ?? 0) + (i / pal.n) * TAU);
    // El relleno va del color oscuro en la base al claro en la punta: da volumen
    // sin necesidad de iluminar nada de verdad.
    const g = degradadoLineal(ctx, r0, 0, r1, 0, [
      [0, conAlfa(colorDe(d, "oscuro"), 0.95)],
      [0.45, conAlfa(colorDe(d, "base"), 0.95 * luz + 0.05)],
      [1, conAlfa(colorDe(d, "claro"), 0.9)],
    ]);
    ctx.fillStyle = g;
    ctx.fill(camino);
    ctx.strokeStyle = conAlfa(colorDe(d, "brillo"), 0.42 * luz);
    ctx.lineWidth = 1.6;
    ctx.stroke(camino);

    // Nervio central: una línea de la base a la punta, más brillante con vida alta.
    ctx.strokeStyle = conAlfa(colorDe(d, "brillo"), 0.5 * luz);
    ctx.lineWidth = Math.max(1, ancho * 0.08);
    ctx.beginPath();
    ctx.moveTo(r0, 0);
    ctx.lineTo(r1 * 0.94, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** Anillo interior: une las palas con el núcleo y da sensación de pieza cerrada. */
export function dibujarAnilloInterior(ctx, d, radio, vida) {
  const luz = 0.35 + 0.65 * vida;
  const r = radio * 0.56;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = conAlfa(colorDe(d, "acento"), 0.5 * luz);
  ctx.lineWidth = Math.max(2, radio * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();

  // Aro de sujeción: sectores que sugieren las piezas que aguantan las palas.
  const n = Math.max(4, d.palas.n);
  const paso = TAU / n;
  for (let i = 0; i < n; i += 1) {
    const p = sectorAnillo(0, 0, r - radio * 0.03, r + radio * 0.09, i * paso + 0.1, (i + 1) * paso - 0.1);
    ctx.fillStyle = conAlfa(colorDe(d, "claro"), 0.28 * luz);
    ctx.fill(p);
  }
  ctx.restore();
}

/** Patrón: el dibujo que gira dentro. Cambia por completo entre diseños. */
export function dibujarPatron(ctx, d, radio, vida, t, fase) {
  const luz = 0.3 + 0.7 * vida;
  const color = colorDe(d, "claro");
  const r = radio * 0.82;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  switch (d.patron) {
    case "radial": {
      const n = 24;
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * TAU;
        const largo = i % 2 === 0 ? r * 0.72 : r * 0.5;
        ctx.strokeStyle = conAlfa(color, (i % 2 === 0 ? 0.4 : 0.22) * luz);
        ctx.lineWidth = i % 2 === 0 ? 2.4 : 1.4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * radio * 0.3, Math.sin(a) * radio * 0.3);
        ctx.lineTo(Math.cos(a) * largo, Math.sin(a) * largo);
        ctx.stroke();
      }
      break;
    }
    case "orbital": {
      for (let k = 0; k < 3; k += 1) {
        const rr = radio * (0.44 + k * 0.14);
        ctx.strokeStyle = conAlfa(k % 2 === 0 ? color : colorDe(d, "acento"), 0.32 * luz);
        ctx.lineWidth = 2;
        ctx.setLineDash([18, 14]);
        ctx.lineDashOffset = t * (k % 2 === 0 ? 26 : -22);
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      break;
    }
    case "espejo": {
      ctx.fillStyle = conAlfa(color, 0.16 * luz);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.78, 0, Math.PI);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 4; i += 1) {
        const a = (i / 4) * TAU;
        ctx.strokeStyle = conAlfa(colorDe(d, "acento"), 0.36 * luz);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42, r * 0.26, 0, TAU);
        ctx.stroke();
      }
      break;
    }
    case "espiral": {
      ctx.strokeStyle = conAlfa(color, 0.55 * luz);
      ctx.lineWidth = 3;
      ctx.stroke(caminoEspiral(2.4, r * 0.9, 0.18, t * 0.8));
      ctx.strokeStyle = conAlfa(colorDe(d, "acento"), 0.3 * luz);
      ctx.lineWidth = 1.4;
      ctx.stroke(caminoEspiral(2.4, r * 0.9, 0.18, t * 0.8 + Math.PI));
      break;
    }
    case "zigzag": {
      const n = 18;
      const paso = TAU / n;
      ctx.strokeStyle = conAlfa(color, 0.5 * luz);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let i = 0; i <= n; i += 1) {
        const a = i * paso;
        const rr = radio * (i % 2 === 0 ? 0.78 : 0.56);
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case "grietas": {
      // Grietas fijas por diseño, con brillo que crece al perder vida.
      const azar = [[0.2, 0.9], [2.1, 0.7], [3.4, 0.95], [4.6, 0.6], [5.4, 0.85]];
      ctx.lineWidth = 1.8;
      for (const [ang, largo] of azar) {
        ctx.strokeStyle = conAlfa(colorDe(d, "acento"), 0.45 * luz);
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * radio * 0.28, Math.sin(ang) * radio * 0.28);
        ctx.lineTo(Math.cos(ang + 0.12) * radio * 0.5, Math.sin(ang + 0.12) * radio * 0.5);
        ctx.lineTo(Math.cos(ang - 0.06) * radio * 0.78 * largo, Math.sin(ang - 0.06) * radio * 0.78 * largo);
        ctx.stroke();
      }
      break;
    }
    case "facetas": {
      const lados = 6;
      for (let i = 0; i < lados; i += 1) {
        const a0 = (i / lados) * TAU;
        const a1 = ((i + 1) / lados) * TAU;
        ctx.fillStyle = conAlfa(i % 2 === 0 ? color : colorDe(d, "acento"), (i % 2 === 0 ? 0.16 : 0.28) * luz);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a0) * r * 0.8, Math.sin(a0) * r * 0.8);
        ctx.lineTo(Math.cos(a1) * r * 0.8, Math.sin(a1) * r * 0.8);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "humo": {
      for (let i = 0; i < 5; i += 1) {
        const a = t * 0.5 + (i / 5) * TAU + fase;
        const rr = radio * (0.5 + 0.16 * Math.sin(t * 0.9 + i));
        const x = Math.cos(a) * rr * 0.7;
        const y = Math.sin(a) * rr * 0.7;
        const g = degradadoRadial(ctx, radio * 0.36, [
          [0, conAlfa(colorDe(d, "oscuro"), 0.5 * luz)],
          [0.6, conAlfa(colorDe(d, "base"), 0.3 * luz)],
          [1, conAlfa(colorDe(d, "base"), 0)],
        ]);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, radio * 0.36, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case "plumas": {
      for (let i = 0; i < 3; i += 1) {
        const a = t * 0.6 + (i / 3) * TAU;
        ctx.strokeStyle = conAlfa(color, 0.45 * luz);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, r * (0.55 + i * 0.12), a, a + 1.5);
        ctx.stroke();
      }
      break;
    }
    case "orbes": {
      for (let i = 0; i < 6; i += 1) {
        const a = t * 0.7 + (i / 6) * TAU;
        const rr = radio * 0.62;
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        const g = degradadoRadial(ctx, radio * 0.14, [
          [0, conAlfa(colorDe(d, "brillo"), 0.95 * luz)],
          [0.4, conAlfa(colorDe(d, "acento"), 0.4 * luz)],
          [1, conAlfa(colorDe(d, "acento"), 0)],
        ]);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, radio * 0.14, 0, TAU);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

/** Núcleo: el centro del trompo, donde luego va la inicial del participante. */
export function dibujarNucleo(ctx, d, radio, vida, t) {
  const luz = 0.4 + 0.6 * vida;
  const color = colorDe(d, "base");
  const r = radio * 0.34;

  ctx.save();
  switch (d.nucleo) {
    case "estrella":
      ctx.fillStyle = conAlfa(colorDe(d, "acento"), 0.9 * luz);
      ctx.fill(estrella(0, 0, r * 1.15, r * 0.48, 6, -t * 0.6));
      break;
    case "hexagono":
      ctx.fillStyle = conAlfa(colorDe(d, "oscuro"), 0.95);
      ctx.fill(poligono(0, 0, r, 6, t * 0.4));
      ctx.strokeStyle = conAlfa(colorDe(d, "claro"), 0.8 * luz);
      ctx.lineWidth = 2;
      ctx.stroke(poligono(0, 0, r, 6, t * 0.4));
      break;
    case "espiral":
      ctx.strokeStyle = conAlfa(colorDe(d, "brillo"), 0.8 * luz);
      ctx.lineWidth = 3;
      ctx.stroke(caminoEspiral(1.7, r * 1.1, 0.2, t * 1.2));
      break;
    case "bolt":
      ctx.fillStyle = conAlfa(colorDe(d, "brillo"), 0.85 * luz);
      ctx.fill(caminoRayo(-r * 0.5, -r, r * 0.5, r, 4, r * 0.35, 3));
      break;
    case "lava": {
      const radios = [1, 0.86, 1.12, 0.9, 1.06, 0.94, 1.1, 0.88, 1.02];
      const p = poligono(0, 0, r, radios.length, t * 0.3, radios);
      ctx.fillStyle = degradadoRadial(ctx, r * 1.2, [
        [0, conAlfa("#fff3c4", 0.95)],
        [0.45, conAlfa(colorDe(d, "claro"), 0.9)],
        [1, conAlfa(colorDe(d, "oscuro"), 0.9)],
      ]);
      ctx.fill(p);
      break;
    }
    case "cristal":
      ctx.fillStyle = conAlfa(colorDe(d, "brillo"), 0.5 * luz);
      ctx.fill(poligono(0, 0, r * 1.1, 3, -Math.PI / 2 + t * 0.5));
      ctx.fillStyle = conAlfa(colorDe(d, "claro"), 0.45 * luz);
      ctx.fill(poligono(0, 0, r * 1.1, 3, Math.PI / 2 - t * 0.5));
      break;
    case "ojo": {
      ctx.fillStyle = conAlfa(colorDe(d, "brillo"), 0.85 * luz);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.15, r * 0.8, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#0b0518";
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.26, r * 0.72, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = conAlfa(colorDe(d, "acento"), 0.6 * luz);
      ctx.beginPath();
      ctx.arc(-r * 0.32, -r * 0.24, r * 0.16, 0, TAU);
      ctx.fill();
      break;
    }
    case "astro":
      ctx.fillStyle = conAlfa(colorDe(d, "acento"), 0.95 * luz);
      ctx.fill(estrella(0, 0, r * 1.3, r * 0.42, 8, t * 0.35));
      ctx.fillStyle = conAlfa("#ffffff", 0.9 * luz);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.4, 0, TAU);
      ctx.fill();
      break;
    case "aspas": {
      ctx.fillStyle = conAlfa(colorDe(d, "claro"), 0.55 * luz);
      for (let i = 0; i < 4; i += 1) {
        ctx.save();
        ctx.rotate(t * 0.9 + (i / 4) * TAU);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(r * 0.6, -r * 0.5, r * 1.15, 0);
        ctx.quadraticCurveTo(r * 0.5, r * 0.18, 0, 0);
        ctx.fill();
        ctx.restore();
      }
      break;
    }
    default: {
      ctx.fillStyle = degradadoRadial(ctx, r * 1.1, [
        [0, conAlfa(colorDe(d, "brillo"), 0.9 * luz)],
        [0.5, conAlfa(colorDe(d, "claro"), 0.75 * luz)],
        [1, conAlfa(colorDe(d, "oscuro"), 0.9)],
      ]);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      break;
    }
  }

  // Borde del núcleo: separa el centro del patrón y deja sitio a la inicial.
  ctx.strokeStyle = conAlfa("#05040a", 0.55);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.22, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/**
 * Grietas e interrupciones del anillo cuando la vida baja: son muescas que se
 * comen el borde según el daño. Se dibujan encima del cuerpo, sin girar con él
 * (una grieta no gira, el trompo sí).
 */
export function dibujarDanio(ctx, d, radio, danio, fase, t) {
  if (danio <= 0.02) return;
  const color = mezclarColor(colorDe(d, "acento"), "#120608", limitar(danio, 0, 1) * 0.7);
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const huecos = Math.max(3, Math.round(4 + danio * 8));
  const p = anilloConHuecos(0, 0, radio * 0.98, radio * 0.34, huecos, 0.09 + danio * 0.3, fase);
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fill(p);
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = conAlfa(color, 0.35 + 0.4 * danio);
  ctx.lineWidth = 1.6;
  for (let i = 0; i < huecos; i += 1) {
    const a = fase + (i / huecos) * TAU;
    const x = Math.cos(a) * radio * 0.98;
    const y = Math.sin(a) * radio * 0.98;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x * 0.62 + Math.sin(t * 3 + i) * 3, y * 0.62);
    ctx.stroke();
  }
  ctx.restore();
}

/** Adornos exclusivos de algunos diseños, para que ninguno se confunda con otro. */
export function dibujarAdorno(ctx, d, radio, vida, t, fase) {
  if (!d.adorno) return;
  const luz = 0.4 + 0.6 * vida;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  switch (d.adorno) {
    case "arcos": {
      // Arcos eléctricos: cambian de forma muy rápido, como una chispa real.
      const n = 3;
      for (let i = 0; i < n; i += 1) {
        const semilla = Math.floor(t * 14) + i * 31 + Math.floor(fase * 100);
        const a0 = (i / n) * TAU + t * 1.5;
        const a1 = a0 + 1.1;
        ctx.strokeStyle = conAlfa(colorDe(d, "acento"), 0.55 * luz);
        ctx.lineWidth = 2;
        ctx.stroke(
          caminoRayo(
            Math.cos(a0) * radio * 0.8,
            Math.sin(a0) * radio * 0.8,
            Math.cos(a1) * radio * 1.5,
            Math.sin(a1) * radio * 1.5,
            5,
            radio * 0.16,
            semilla,
          ),
        );
      }
      break;
    }
    case "brasas": {
      for (let i = 0; i < 7; i += 1) {
        const a = t * 0.8 + (i / 7) * TAU;
        const rr = radio * (0.9 + 0.3 * ((i * 13) % 7) / 7);
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr - ((t * 40 + i * 17) % 30);
        const tam = 2 + (i % 3);
        ctx.fillStyle = conAlfa(i % 2 === 0 ? "#ffd27a" : colorDe(d, "claro"), 0.5 * luz);
        ctx.beginPath();
        ctx.arc(x, y, tam, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case "humo": {
      for (let i = 0; i < 4; i += 1) {
        const a = -t * 0.6 + (i / 4) * TAU;
        const rr = radio * 1.25;
        const g = degradadoRadial(ctx, radio * 0.5, [
          [0, conAlfa("#2a1147", 0.4 * luz)],
          [1, conAlfa("#2a1147", 0)],
        ]);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, radio * 0.5, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case "viento": {
      for (let i = 0; i < 3; i += 1) {
        const a = t * 1.1 + (i / 3) * TAU;
        ctx.strokeStyle = conAlfa(colorDe(d, "claro"), 0.4 * luz);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, radio * (1.15 + i * 0.08), a, a + 1.9);
        ctx.stroke();
      }
      break;
    }
    case "destellos": {
      for (let i = 0; i < d.palas.n; i += 1) {
        const a = (i / d.palas.n) * TAU + (d.palas.desfase ?? 0);
        const brillo = Math.max(0, Math.sin(t * 2.4 + i * 1.7));
        if (brillo < 0.55) continue;
        const x = Math.cos(a) * radio * 1.05;
        const y = Math.sin(a) * radio * 1.05;
        const tam = radio * 0.1 * (0.6 + brillo);
        ctx.fillStyle = conAlfa("#ffffff", 0.5 * (brillo - 0.55) * luz * 3);
        ctx.beginPath();
        ctx.moveTo(x, y - tam);
        ctx.lineTo(x + tam * 0.3, y);
        ctx.lineTo(x, y + tam);
        ctx.lineTo(x - tam * 0.3, y);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "polvo": {
      for (let i = 0; i < 9; i += 1) {
        const a = t * 0.4 + (i / 9) * TAU * 3;
        const rr = radio * (1.2 + 0.35 * Math.sin(t + i));
        ctx.fillStyle = conAlfa("#fff3c0", 0.35 * luz);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.8, 1.6, 0, TAU);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

/**
 * Cuerpo completo. Se llama con el contexto ya centrado en el trompo y girado:
 * todo lo de aquí gira con él. `vida` es la fracción 0..1.
 */
export function dibujarCuerpo(ctx, d, radio, vida, t, fase) {
  const luz = 0.3 + 0.7 * vida;
  // Plato base: el disco sobre el que se montan las capas. Es lo que hace que el
  // trompo se lea como una pieza sólida y no como un montón de líneas.
  ctx.save();
  ctx.fillStyle = degradadoRadial(ctx, radio, [
    [0, conAlfa(colorDe(d, "oscuro"), 0.94)],
    [0.62, conAlfa(tono(colorDe(d, "base"), -0.25), 0.96)],
    [1, conAlfa(colorDe(d, "oscuro"), 0.7)],
  ]);
  ctx.beginPath();
  ctx.arc(0, 0, radio, 0, TAU);
  ctx.fill();
  // Gajos del plato: sectores con distinta transparencia, para que al girar se note
  // la velocidad. Con el trompo pequeño se ahorran: a 34 px de radio no se distinguen
  // y son 12 rellenos por trompo y fotograma (480 con cuarenta participantes).
  if (radio >= 46) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radio, 0, TAU);
    ctx.clip();
    gajos(
      ctx,
      radio,
      Array.from({ length: 12 }, (_, i) =>
        conAlfa(i % 2 === 0 ? colorDe(d, "base") : colorDe(d, "oscuro"), 0.14 * luz),
      ),
      0,
    );
    ctx.restore();
  }
  ctx.restore();

  dibujarAnilloExterior(ctx, d, radio, vida);
  dibujarPalas(ctx, d, radio, vida, t);
  dibujarAnilloInterior(ctx, d, radio, vida);
  dibujarPatron(ctx, d, radio, vida, t, fase);
  dibujarNucleo(ctx, d, radio, vida, t);
  dibujarAdorno(ctx, d, radio, vida, t, fase);
}
