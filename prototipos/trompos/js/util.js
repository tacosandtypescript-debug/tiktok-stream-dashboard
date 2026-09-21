// Utilidades de número, color y dibujo que usan todos los módulos.

export const TAU = Math.PI * 2;

export function limitar(v, minimo, maximo) {
  return v < minimo ? minimo : v > maximo ? maximo : v;
}

export function mezclar(a, b, t) {
  return a + (b - a) * t;
}

/** Igual que `mezclar` pero recortando t a [0,1]. */
export function interpolacion(a, b, t) {
  return mezclar(a, b, limitar(t, 0, 1));
}

/** Suavizado en S, para que las transiciones no tengan esquina. */
export function suavizar(t) {
  const x = limitar(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Curva de entrada rápida y salida lenta (la del cartel de eliminación). */
export function entradaRapida(t) {
  const x = limitar(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

/** Curva de salida: se va apagando. */
export function salidaGradual(t) {
  const x = limitar(t, 0, 1);
  return 1 - x * x;
}

// ------------------------------------------------------------------ color

/** `#rrggbb` -> [r,g,b]. Acepta también `#rgb`. */
export function aRgb(hex) {
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function aHex([r, g, b]) {
  const c = (v) => limitar(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mezcla dos colores en el espacio RGB (suficiente para auras y daño). */
export function mezclarColor(a, b, t) {
  const ca = aRgb(a);
  const cb = aRgb(b);
  const k = limitar(t, 0, 1);
  return aHex([mezclar(ca[0], cb[0], k), mezclar(ca[1], cb[1], k), mezclar(ca[2], cb[2], k)]);
}

/** El mismo color con otra alfa, para no repetir `rgba(...)` por el código. */
export function conAlfa(hex, alfa) {
  const [r, g, b] = aRgb(hex);
  return `rgba(${r},${g},${b},${limitar(alfa, 0, 1)})`;
}

/** Aclara (t>0) u oscurece (t<0) hacia blanco o negro. */
export function tono(hex, t) {
  return t >= 0 ? mezclarColor(hex, "#ffffff", t) : mezclarColor(hex, "#000000", -t);
}

/** Color por tono, saturación y luminosidad (h en grados, s y l en 0..1). */
export function hslAHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return aHex([(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255]);
}

/**
 * Acorta un texto para que quepa en un ancho, con puntos suspensivos.
 *
 * Se mide con `measureText`, así que depende de la fuente ya puesta en el contexto.
 * El nombre completo no se pierde nunca: en la tabla va en el `title` del nodo y en
 * los datos del participante.
 */
export function acortarTexto(ctx, texto, anchoMaximo) {
  if (ctx.measureText(texto).width <= anchoMaximo) return texto;
  let corte = texto.length;
  while (corte > 1) {
    corte -= 1;
    const recorte = `${texto.slice(0, corte).trimEnd()}…`;
    if (ctx.measureText(recorte).width <= anchoMaximo) return recorte;
  }
  return "…";
}

// ------------------------------------------------------------------ dibujo

/** Rectángulo redondeado como camino, sin depender de `roundRect` (Safari viejo). */
export function caminoRedondeado(ctx, x, y, ancho, alto, radio) {
  const r = Math.min(radio, Math.abs(ancho) / 2, Math.abs(alto) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + ancho - r, y);
  ctx.quadraticCurveTo(x + ancho, y, x + ancho, y + r);
  ctx.lineTo(x + ancho, y + alto - r);
  ctx.quadraticCurveTo(x + ancho, y + alto, x + ancho - r, y + alto);
  ctx.lineTo(x + r, y + alto);
  ctx.quadraticCurveTo(x, y + alto, x, y + alto - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Sombra de contacto bajo el trompo, para que no parezca pegado al aire.
 * Es una elipse oscura y difusa, no una sombra real: el overlay es transparente
 * y no hay suelo que proyecte.
 */
export function sombraDeApoyo(ctx, radio, fuerza) {
  const g = ctx.createRadialGradient(0, radio * 0.55, radio * 0.1, 0, radio * 0.55, radio * 1.15);
  g.addColorStop(0, `rgba(0,0,0,${0.34 * fuerza})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.translate(0, radio * 0.5);
  ctx.scale(1, 0.42);
  ctx.translate(0, -radio * 0.5);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, radio * 0.55, radio * 1.15, 0, TAU);
  ctx.fill();
  ctx.restore();
}
