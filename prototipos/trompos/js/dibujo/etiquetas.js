// Etiquetas e identidad en pantalla: medallón del núcleo, arco de vida y nombre.
//
// Orden 03: cada trompo representa a una persona, así que lleva
//
//   1. un **medallón en el núcleo** con su foto (máscara circular, recorte centrado,
//      borde de su color) o su inicial si no hay foto o si la foto falla;
//   2. el **arco de vida**, que se dibuja siempre y para todos;
//   3. la **placa del nombre**, con el color identificador en el borde. Con mucha
//      gente se hace compacta y el nombre se acorta con puntos suspensivos (el nombre
//      entero sigue en los datos y en el `title` de la tabla).
//
// El medallón se dibuja SIN girar con el trompo: una cara que da vueltas no se
// reconoce. Por eso la identidad va en esta pasada, después de los cuerpos, y no
// dentro del grupo que rota en `dibujo/trompo.js`.
//
// Prioridad y anti-solape: primero el líder, después el que acaba de recibir un golpe,
// el que se está muriendo, el que pegó y por último el resto. Una etiqueta que pisaría
// a otra ya colocada no se dibuja, salvo que tenga prioridad.

import { TAU, conAlfa, limitar, suavizar, caminoRedondeado, acortarTexto } from "../util.js";
import { escalaTrompos } from "../parametros.js";

/** Color del arco de vida según lo que le queda. */
export function colorDeVida(pct) {
  if (pct > 0.66) return "#4ade80";
  if (pct > 0.33) return "#fbbf24";
  return "#f87171";
}

/** ¿Hay que usar etiquetas compactas con este número de participantes? */
export function modoCompacto(p) {
  return p.simulacion.participantes > p.etiquetas.umbralCompactas;
}

/**
 * Factor de tamaño de la etiqueta. Sale de la escala de los trompos, pero con suelo:
 * por debajo de 0,5 el nombre dejaría de leerse en un móvil.
 */
export function escalaEtiqueta(p) {
  const ratio = escalaTrompos(p) / 0.5;
  const base = Math.max(p.etiquetas.escalaMinima ?? 0.62, ratio);
  const modo = modoCompacto(p) ? p.etiquetas.escalaCompacta : p.etiquetas.escalaNormal;
  return limitar(base * modo, 0.45, 1.4);
}

/** Radio del medallón del núcleo: proporcional, con un mínimo para que se vea. */
export function radioMedallon(tr, p) {
  return Math.max(p.fotos.medallonMinimo, tr.radio * p.fotos.medallon);
}
/**
 * Ancho de un texto, con caché: `measureText` cuesta y con cuarenta participantes se
 * pediría el mismo ancho sesenta veces por segundo.
 */
const cacheTextos = new Map();

function anchoDeTexto(ctx, texto, fuente) {
  const clave = `${fuente}|${texto}`;
  let ancho = cacheTextos.get(clave);
  if (ancho === undefined) {
    ctx.font = `700 ${fuente}px system-ui, 'Segoe UI', sans-serif`;
    ancho = ctx.measureText(texto).width;
    cacheTextos.set(clave, ancho);
  }
  return ancho;
}

/** Medidas de la etiqueta de un trompo, en píxeles, para poder detectar solapes. */
export function medidasEtiqueta(ctx, tr, p, compacta) {
  const k = escalaEtiqueta(p);
  const separacion = p.etiquetas.separacion * k;
  const fuente = Math.round(30 * k);
  const anchoMaximo = (compacta ? p.etiquetas.anchoMaximoCompacta : p.etiquetas.anchoMaximo) * k;
  const relleno = (compacta ? 16 : 24) * k;
  const texto = acortarTexto(ctx, tr.nombre, Math.max(30, anchoMaximo - relleno));
  const alto = Math.round((compacta ? 32 : 44) * k);
  const ancho = anchoDeTexto(ctx, texto, fuente) + relleno;
  const y = tr.radio * (compacta ? 1.04 : 1.06) + separacion + alto / 2;
  const x = limitar(tr.x - ancho / 2, 6, p.lienzo.ancho - ancho - 6);
  return { x, y: tr.y + y, ancho, alto, fuente, k, compacta, texto };
}

function sePisan(a, b) {
  return a.x < b.x + b.ancho && a.x + a.ancho > b.x && a.y < b.y + b.alto && a.y + a.alto > b.y;
}

/** Arco de vida alrededor del cuerpo. Se dibuja siempre, también en modo compacto. */
export function dibujarArcoDeVida(ctx, tr, t, p, k) {
  const vida = tr.vidaPct;
  const rArco = tr.radio * 1.16;
  ctx.lineCap = "round";

  // Fondo del arco: el color del jugador muy apagado, para que se vea de quién es la
  // barra incluso cuando está llena.
  ctx.strokeStyle = "rgba(8,6,16,0.6)";
  ctx.lineWidth = Math.max(3, 8 * k);
  ctx.beginPath();
  ctx.arc(0, 0, rArco, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = conAlfa(colorDeVida(vida), 0.95);
  ctx.lineWidth = Math.max(2.6, 7 * k);
  ctx.beginPath();
  // El arco empieza arriba y va menguando en el sentido de las agujas: se ve de un
  // vistazo cuánta vida queda sin leer un número.
  ctx.arc(0, 0, rArco, -Math.PI / 2, -Math.PI / 2 + TAU * vida);
  ctx.stroke();

  if (tr.esLider) {
    ctx.strokeStyle = conAlfa("#ffd76a", 0.3 + 0.25 * Math.sin(t * 5));
    ctx.lineWidth = Math.max(1.6, 2 * k);
    ctx.beginPath();
    ctx.arc(0, 0, rArco + 9 * k, 0, TAU);
    ctx.stroke();
  }
}

/**
 * Medallón del núcleo: la foto del participante (o su inicial) dentro del centro del
 * trompo, con el borde de su color. Es la identidad, no el cuerpo: el cuerpo lo sigue
 * generando el Canvas.
 */
export function dibujarMedallonNucleo(ctx, tr, p, fotos, k) {
  if (!fotos) return;
  const r = radioMedallon(tr, p);
  fotos.medallon(ctx, tr.x, tr.y, r, {
    foto: tr.foto,
    inicial: tr.inicial,
    color: tr.color,
    grosor: Math.max(2, p.fotos.grosorAro * Math.max(0.7, k)),
    separacion: Math.max(1.2, p.fotos.separacion * Math.max(0.7, k)),
  });
}

/** Placa con el nombre, con el color identificador en el borde. */
export function dibujarEtiqueta(ctx, tr, t, p, aparece, compacta) {
  const alfa = aparece * (1 - tr.muerte * 0.6);
  if (alfa <= 0.05) return;

  ctx.save();
  ctx.globalAlpha = alfa;
  ctx.translate(tr.x, tr.y);
  const m = medidasEtiqueta(ctx, tr, p, compacta);
  const y = m.y - tr.y;
  const x = -m.ancho / 2;
  const alto = m.alto;
  const k = m.k;

  ctx.fillStyle = "rgba(6,5,14,0.72)";
  caminoRedondeado(ctx, x, y - alto / 2, m.ancho, alto, alto / 2);
  ctx.fill();
  ctx.strokeStyle = conAlfa(tr.color, tr.prioridadEtiqueta >= 5 ? 1 : 0.85);
  ctx.lineWidth = tr.prioridadEtiqueta >= 5 ? 2.6 : 1.8;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${m.fuente}px system-ui, 'Segoe UI', sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(m.texto, 0, y + 1);

  if (!compacta && tr.eliminaciones > 0) {
    ctx.textAlign = "left";
    ctx.fillStyle = conAlfa("#ffd76a", 0.95);
    ctx.font = `800 ${Math.round(24 * k)}px system-ui, 'Segoe UI', sans-serif`;
    ctx.fillText(`×${tr.eliminaciones}`, x + m.ancho + 12 * k, y + 1);
  }
  if (!tr.activo && tr.estado === "ko") {
    ctx.textAlign = "right";
    ctx.fillStyle = conAlfa(tr.motivo === "retirado" ? "#93c5fd" : "#f87171", 0.95);
    ctx.font = `800 ${Math.round(22 * k)}px system-ui, 'Segoe UI', sans-serif`;
    ctx.fillText(tr.motivo === "retirado" ? "SALE" : "KO", x - 5 * k, y + 1);
  }
  ctx.restore();
}

/** Estado de la última colocación de etiquetas: lo lee el banco de pruebas. */
let ultimaColocacion = {
  colocadas: 0,
  omitidas: 0,
  total: 0,
  compactas: false,
  medallones: 0,
  fotos: 0,
  respaldos: 0,
};

export function estadisticasEtiquetas() {
  return { ...ultimaColocacion };
}

/**
 * Dibuja los arcos de vida (todos), los medallones de identidad (todos) y después las
 * etiquetas por prioridad, saltándose las que pisarían a otra ya colocada.
 */
export function dibujarEtiquetas(ctx, trompos, t, p, fotos) {
  const compacta = modoCompacto(p);
  const k = escalaEtiqueta(p);
  let medallones = 0;
  let fotosPintadas = 0;
  let respaldos = 0;

  // 1) Arco de vida y medallón: van todos, no se recortan por prioridad.
  for (const tr of trompos) {
    if (tr.estado === "fuera" || tr.aparicion < 0.5) continue;
    ctx.save();
    ctx.globalAlpha = suavizar(tr.aparicion) * (1 - tr.muerte * 0.6);
    ctx.translate(tr.x, tr.y);
    dibujarArcoDeVida(ctx, tr, t, p, k);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = suavizar(tr.aparicion) * (1 - tr.muerte * 0.7);
    if (p.fotos.activo) dibujarMedallonNucleo(ctx, tr, p, fotos, k);
    ctx.restore();
    medallones += 1;
    if (fotos && fotos.utilizable(tr.foto)) fotosPintadas += 1;
    else respaldos += 1;
  }

  const candidatas = trompos.filter((tr) => tr.estado !== "fuera" && tr.aparicion > 0.55);
  if (!p.aspecto.verNombres) {
    ultimaColocacion = {
      colocadas: 0,
      omitidas: 0,
      total: candidatas.length,
      compactas: compacta,
      medallones,
      fotos: fotosPintadas,
      respaldos,
    };
    return;
  }

  // 2) Nombres por prioridad, sin solapes.
  const orden = [...candidatas].sort(
    (a, b) => b.prioridadEtiqueta - a.prioridadEtiqueta || b.vida - a.vida,
  );

  const colocadas = [];
  let omitidas = 0;
  for (const tr of orden) {
    const caja = medidasEtiqueta(ctx, tr, p, compacta);
    const obligatoria = tr.prioridadEtiqueta >= 5;
    if (p.etiquetas.evitarSolapes && !obligatoria && colocadas.some((c) => sePisan(c, caja))) {
      omitidas += 1;
      continue; // sin prioridad y pisando a otra: este fotograma no se dibuja
    }
    colocadas.push(caja);
    dibujarEtiqueta(ctx, tr, t, p, suavizar(tr.aparicion), compacta);
  }
  ultimaColocacion = {
    colocadas: colocadas.length,
    omitidas,
    total: candidatas.length,
    compactas: compacta,
    medallones,
    fotos: fotosPintadas,
    respaldos,
  };
}

/** Medidas de todas las etiquetas, para las comprobaciones del banco. */
export function medirEtiquetas(ctx, trompos, p) {
  const compacta = modoCompacto(p);
  return trompos
    .filter((tr) => tr.estado !== "fuera")
    .map((tr) => ({ nombre: tr.nombre, ...medidasEtiqueta(ctx, tr, p, compacta) }));
}
