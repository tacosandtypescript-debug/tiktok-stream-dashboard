// Primitivas de dibujo: caminos (Path2D), degradados y trazos auxiliares.
//
// Todo lo que hay aquí construye formas con círculos, arcos, polígonos y líneas.
// No hay ni un sprite ni una imagen: el cuerpo de los trompos es aritmética.
//
// Convenio: los caminos de pala se construyen en coordenadas locales con la pala
// creciendo hacia +X, de `r0` (base) a `r1` (punta) y `ancho` de grosor en Y. Quien
// los usa gira el contexto antes de rellenar, así que un mismo camino sirve para
// las N palas de un diseño.

import { TAU, limitar } from "../util.js";
import { Azar } from "../azar.js";

// ------------------------------------------------------------------ caminos

/** Polígono regular. `radios` permite uno irregular (radios por lado). */
export function poligono(cx, cy, r, lados, desfase = 0, radios = null) {
  const p = new Path2D();
  for (let i = 0; i < lados; i += 1) {
    const a = desfase + (i / lados) * TAU;
    const ri = radios ? r * radios[i % radios.length] : r;
    const x = cx + Math.cos(a) * ri;
    const y = cy + Math.sin(a) * ri;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

/** Estrella de `puntas` con radio exterior e interior. */
export function estrella(cx, cy, rExterior, rInterior, puntas, desfase = 0) {
  const p = new Path2D();
  for (let i = 0; i < puntas * 2; i += 1) {
    const a = desfase + (i / (puntas * 2)) * TAU;
    const r = i % 2 === 0 ? rExterior : rInterior;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

/** Sector de anillo (aro grueso) entre dos ángulos. */
export function sectorAnillo(cx, cy, rInterior, rExterior, a0, a1) {
  const p = new Path2D();
  p.arc(cx, cy, rExterior, a0, a1);
  p.arc(cx, cy, rInterior, a1, a0, true);
  p.closePath();
  return p;
}

/**
 * Anillo con huecos: reparte `huecos` muescas a lo largo de la vuelta. Se usa para
 * el anillo agrietado de la vida baja — las muescas crecen con el daño.
 */
export function anilloConHuecos(cx, cy, r, grosor, huecos, anchoHueco, desfase = 0) {
  const p = new Path2D();
  if (huecos <= 0 || anchoHueco <= 0) {
    p.arc(cx, cy, r, 0, TAU);
    return p;
  }
  const paso = TAU / huecos;
  for (let i = 0; i < huecos; i += 1) {
    const centro = desfase + i * paso;
    const a0 = centro + anchoHueco / 2;
    const a1 = centro + paso - anchoHueco / 2;
    if (a1 <= a0) continue;
    const trozo = sectorAnillo(cx, cy, Math.max(1, r - grosor / 2), r + grosor / 2, a0, a1);
    p.addPath(trozo);
  }
  return p;
}

/** Pala en punta: base ancha, punta afilada, lados ligeramente cóncavos. */
function palaFilo(r0, r1, ancho) {
  const p = new Path2D();
  const medio = ancho / 2;
  const codo = r0 + (r1 - r0) * 0.55;
  p.moveTo(r0, -medio);
  p.quadraticCurveTo(codo, -medio * 0.62, r1, 0);
  p.quadraticCurveTo(codo, medio * 0.62, r0, medio);
  p.closePath();
  return p;
}

/** Pala escudo: ancha, roma, con el borde exterior redondeado. */
function palaEscudo(r0, r1, ancho) {
  const p = new Path2D();
  const medio = ancho / 2;
  const borde = r1 - ancho * 0.18;
  p.moveTo(r0, -medio);
  p.lineTo(borde, -medio * 0.86);
  p.quadraticCurveTo(r1 + ancho * 0.1, -medio * 0.5, r1 + ancho * 0.1, 0);
  p.quadraticCurveTo(r1 + ancho * 0.1, medio * 0.5, borde, medio * 0.86);
  p.lineTo(r0, medio);
  p.closePath();
  return p;
}

/** Pala doble: dos puntas opuestas sobre la misma base (balance). */
function palaDoble(r0, r1, ancho, curvatura) {
  const p = new Path2D();
  const medio = ancho / 2;
  const atras = r0 - (r1 - r0) * 0.42;
  p.moveTo(r1, -medio * 0.25);
  p.quadraticCurveTo(r0 + (r1 - r0) * 0.4, -medio, atras, -medio * 0.55 * (1 + curvatura));
  p.lineTo(atras - ancho * 0.2, 0);
  p.lineTo(atras, medio * 0.55 * (1 + curvatura));
  p.quadraticCurveTo(r0 + (r1 - r0) * 0.4, medio, r1, medio * 0.25);
  p.closePath();
  return p;
}

/** Pala espiral: aleta barrida hacia un lado (velocidad). */
function palaEspiral(r0, r1, ancho, curvatura) {
  const p = new Path2D();
  const medio = ancho / 2;
  const vuelo = (r1 - r0) * curvatura;
  p.moveTo(r0, -medio);
  p.quadraticCurveTo(r1 - (r1 - r0) * 0.15, -medio - vuelo * 0.2, r1, vuelo * 0.55);
  p.quadraticCurveTo(r1 - (r1 - r0) * 0.4, vuelo * 0.75, r0 + (r1 - r0) * 0.28, medio * 0.9);
  p.quadraticCurveTo(r0 + (r1 - r0) * 0.1, medio * 0.4, r0, medio);
  p.closePath();
  return p;
}

/** Pala rayo: zigzag que se estrecha hacia la punta. */
function palaRayo(r0, r1, ancho, dientes = 3) {
  const p = new Path2D();
  const largo = r1 - r0;
  const paso = largo / dientes;
  const puntos = [];
  for (let i = 0; i <= dientes; i += 1) {
    const x = r0 + paso * i;
    const escala = 1 - (i / dientes) * 0.85;
    const desvio = (i % 2 === 1 ? 0.62 : -0.38) * (ancho / 2) * escala;
    puntos.push([x, desvio, escala]);
  }
  p.moveTo(puntos[0][0], puntos[0][1]);
  for (let i = 1; i < puntos.length; i += 1) p.lineTo(puntos[i][0], puntos[i][1]);
  for (let i = puntos.length - 1; i >= 0; i -= 1) {
    const [x, y, escala] = puntos[i];
    p.lineTo(x, y + (ancho / 2) * escala * (i === 0 ? 2 : 1.1));
  }
  p.closePath();
  return p;
}

/** Pala roca: polígono irregular y anguloso (volcánico). */
function palaRoca(r0, r1, ancho, semilla = 7) {
  const p = new Path2D();
  const azar = new Azar(semilla);
  const lados = 5 + azar.entero(0, 2);
  const medio = ancho / 2;
  for (let i = 0; i <= lados; i += 1) {
    const t = i / lados;
    const x = r0 + (r1 - r0) * t + azar.rango(-0.06, 0.06) * (r1 - r0);
    const y = -medio * (1 - t * 0.75) * azar.rango(0.82, 1.18);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  for (let i = lados; i >= 0; i -= 1) {
    const t = i / lados;
    const x = r0 + (r1 - r0) * t + azar.rango(-0.06, 0.06) * (r1 - r0);
    const y = medio * (1 - t * 0.75) * azar.rango(0.82, 1.18);
    p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

/** Pala cristal: rombo facetado con hombros marcados. */
function palaCristal(r0, r1, ancho) {
  const p = new Path2D();
  const medio = ancho / 2;
  const hombro = r0 + (r1 - r0) * 0.42;
  p.moveTo(r0, 0);
  p.lineTo(hombro, -medio);
  p.lineTo(r1, -medio * 0.2);
  p.lineTo(r1, medio * 0.2);
  p.lineTo(hombro, medio);
  p.closePath();
  return p;
}

/** Pala guadaña: filo curvo con muesca interior (sombra). */
function palaGuadana(r0, r1, ancho, curvatura) {
  const p = new Path2D();
  const medio = ancho / 2;
  const vuelo = (r1 - r0) * curvatura;
  p.moveTo(r0, -medio * 0.6);
  p.quadraticCurveTo(r1 - (r1 - r0) * 0.1, -medio * 0.2 + vuelo, r1, vuelo * 1.1 + medio * 0.2);
  p.quadraticCurveTo(r1 - (r1 - r0) * 0.55, vuelo * 0.8, r0 + (r1 - r0) * 0.3, medio * 0.5);
  p.lineTo(r0 + (r1 - r0) * 0.14, -medio * 0.1);
  p.closePath();
  return p;
}

/** Pala arco: creciente fina (viento). */
function palaArco(r0, r1, ancho, curvatura) {
  const p = new Path2D();
  const medio = ancho / 2;
  const radio = (r1 - r0) / Math.max(0.2, curvatura);
  const centro = r0 + (r1 - r0) - radio;
  const a = Math.asin(limitar((r1 - r0) / radio, -0.98, 0.98));
  p.moveTo(centro + radio * Math.cos(a), -radio * Math.sin(a));
  p.arc(centro, 0, radio, -a, a);
  p.arc(centro, 0, radio - medio * 1.6, a, -a, true);
  p.closePath();
  return p;
}

/** Pala estrella: brazo con muescas (cósmico). */
function palaEstrella(r0, r1, ancho) {
  const p = new Path2D();
  const medio = ancho / 2;
  const largo = r1 - r0;
  p.moveTo(r0, -medio);
  p.lineTo(r0 + largo * 0.3, -medio * 1.25);
  p.lineTo(r0 + largo * 0.52, -medio * 0.7);
  p.lineTo(r1, 0);
  p.lineTo(r0 + largo * 0.52, medio * 0.7);
  p.lineTo(r0 + largo * 0.3, medio * 1.25);
  p.lineTo(r0, medio);
  p.closePath();
  return p;
}

/** Fábrica de palas: `forma` es la clave que declara cada diseño. */
export function caminoPala(forma, r0, r1, ancho, extras = {}) {
  const curvatura = extras.curvatura ?? 0.6;
  switch (forma) {
    case "filo":
      return palaFilo(r0, r1, ancho);
    case "escudo":
      return palaEscudo(r0, r1, ancho);
    case "doble":
      return palaDoble(r0, r1, ancho, curvatura);
    case "espiral":
      return palaEspiral(r0, r1, ancho, curvatura);
    case "rayo":
      return palaRayo(r0, r1, ancho, extras.dientes ?? 3);
    case "roca":
      return palaRoca(r0, r1, ancho, extras.semilla ?? 7);
    case "cristal":
      return palaCristal(r0, r1, ancho);
    case "guadana":
      return palaGuadana(r0, r1, ancho, curvatura);
    case "arco":
      return palaArco(r0, r1, ancho, curvatura);
    case "estrella":
      return palaEstrella(r0, r1, ancho);
    default:
      return palaFilo(r0, r1, ancho);
  }
}

/** Línea quebrada tipo rayo, de un punto a otro (arcos eléctricos). */
export function caminoRayo(x1, y1, x2, y2, dientes, amplitud, semilla) {
  const p = new Path2D();
  const azar = new Azar(semilla);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const largo = Math.hypot(dx, dy) || 1;
  const nx = -dy / largo;
  const ny = dx / largo;
  p.moveTo(x1, y1);
  for (let i = 1; i < dientes; i += 1) {
    const t = i / dientes;
    const desvio = azar.rango(-amplitud, amplitud);
    p.lineTo(x1 + dx * t + nx * desvio, y1 + dy * t + ny * desvio);
  }
  p.lineTo(x2, y2);
  return p;
}

/** Espiral de Arquímedes (patrón y núcleo de velocidad). */
export function caminoEspiral(vueltas, radio, paso, desfase = 0, segmentos = 90) {
  const p = new Path2D();
  for (let i = 0; i <= segmentos; i += 1) {
    const t = i / segmentos;
    const a = desfase + t * TAU * vueltas;
    const r = radio * (t * (1 - paso) + paso);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  return p;
}

// ------------------------------------------------------------------ degradados

export function degradadoRadial(ctx, radio, paradas) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, radio));
  for (const [pos, color] of paradas) g.addColorStop(limitar(pos, 0, 1), color);
  return g;
}

export function degradadoLineal(ctx, x0, y0, x1, y1, paradas) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [pos, color] of paradas) g.addColorStop(limitar(pos, 0, 1), color);
  return g;
}

/**
 * Degradado cónico aproximado: no todos los navegadores tienen `createConicGradient`,
 * así que se pinta por gajos de sectores. Se usa para el patrón radial giratorio.
 */
export function gajos(ctx, radio, colores, desde = 0) {
  const n = colores.length;
  const paso = TAU / n;
  for (let i = 0; i < n; i += 1) {
    const p = sectorAnillo(0, 0, 0, radio, desde + i * paso, desde + (i + 1) * paso);
    ctx.fillStyle = colores[i];
    ctx.fill(p);
  }
}
