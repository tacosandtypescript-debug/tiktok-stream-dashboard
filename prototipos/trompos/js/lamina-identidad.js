// Lámina de identidades: todos los participantes con la cara grande.
//
// Existe porque en el lienzo del overlay el medallón mide entre 15 y 25 px de radio:
// ahí se reconoce, pero para *juzgar* si una cara se distingue hace falta verla mayor.
// Aquí se dibujan los mismos participantes, con el mismo código de trompo y el mismo
// cargador de fotos, pero a un tamaño en el que la cara se mira a gusto.
//
// Uso: http://127.0.0.1:8123/identidad.html
//      http://127.0.0.1:8123/identidad.html?participantes=10

import { PARAMETROS, radioDe } from "./parametros.js";
import { crearAlineacion, PLANTILLA } from "./participantes.js";
import { Fotos } from "./fotos.js";
import { DISENOS, dibujarCuerpo } from "./dibujo/disenos.js";
import { conAlfa } from "./util.js";
import { Azar } from "./azar.js";

const consulta = new URLSearchParams(location.search);
const cuantos = Math.max(1, Math.min(40, Number(consulta.get("participantes") ?? 10) || 10));
PARAMETROS.simulacion.participantes = cuantos;

const lienzo = document.getElementById("lamina");
const ctx = lienzo.getContext("2d", { alpha: true });
lienzo.width = PARAMETROS.lienzo.ancho;
lienzo.height = PARAMETROS.lienzo.alto;
const ANCHO = lienzo.width;
const ALTO = lienzo.height;

const fotos = new Fotos();
// Alineación de verdad: mismos diseños, mismos colores y mismas variantes que en la
// arena, con el azar de la ronda 0.
const azar = new Azar(PARAMETROS.simulacion.semilla);
const trompos = crearAlineacion(azar, PARAMETROS, 0);

function rotulo(texto, x, y, tamano, color, peso = 600, alineacion = "center") {
  ctx.font = `${peso} ${tamano}px system-ui, 'Segoe UI', sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = alineacion;
  ctx.textBaseline = "middle";
  ctx.fillText(texto, x, y);
}

/** Rejilla: más columnas cuanta más gente, para que la cara no se haga pequeña. */
function rejilla(n) {
  const columnas = n <= 12 ? 2 : n <= 24 ? 3 : 5;
  const filas = Math.ceil(n / columnas);
  return { columnas, filas };
}

function recortar(texto, ancho) {
  if (ctx.measureText(texto).width <= ancho) return texto;
  let corte = texto.length;
  while (corte > 1) {
    corte -= 1;
    const prueba = `${texto.slice(0, corte).trimEnd()}…`;
    if (ctx.measureText(prueba).width <= ancho) return prueba;
  }
  return "…";
}

function pintar() {
  const cabecera = 104;
  ctx.clearRect(0, 0, ANCHO, ALTO);
  ctx.fillStyle = "#0d0d12";
  ctx.fillRect(0, 0, ANCHO, ALTO);

  rotulo("IDENTIDADES", 44, 52, 42, "#ffffff", 800, "left");
  rotulo(
    `${trompos.length} participantes · cara en el medallón del núcleo, color propio y variante del diseño`,
    44,
    88,
    21,
    "#9a9ab0",
    600,
    "left",
  );

  const { columnas, filas } = rejilla(trompos.length);
  const margen = 40;
  const anchoCelda = (ANCHO - margen * 2) / columnas;
  const altoCelda = (ALTO - cabecera - margen) / filas;
  const desplazamiento = (ALTO - cabecera - margen - altoCelda * filas) / 2;

  trompos.forEach((t, i) => {
    const col = i % columnas;
    const fil = Math.floor(i / columnas);
    const x = margen + col * anchoCelda;
    const y = cabecera + desplazamiento + fil * altoCelda;
    const radio = Math.min(anchoCelda * 0.3, altoCelda * 0.26, 110);

    // --- marco de la celda
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.strokeStyle = conAlfa(t.color, 0.5);
    ctx.lineWidth = 2;
    const r = 16;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + anchoCelda - 10 - r, y);
    ctx.quadraticCurveTo(x + anchoCelda - 10, y, x + anchoCelda - 10, y + r);
    ctx.lineTo(x + anchoCelda - 10, y + altoCelda - 10 - r);
    ctx.quadraticCurveTo(x + anchoCelda - 10, y + altoCelda - 10, x + anchoCelda - 10 - r, y + altoCelda - 10);
    ctx.lineTo(x + r, y + altoCelda - 10);
    ctx.quadraticCurveTo(x, y + altoCelda - 10, x, y + altoCelda - 10 - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // --- el trompo, con su medallón de identidad (mismo código que en la arena)
    const cx = x + anchoCelda / 2;
    const cy = y + altoCelda * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    dibujarCuerpo(ctx, t.diseno, radio, 1, 0.6, t.fase);
    ctx.restore();
    fotos.medallon(ctx, cx, cy, Math.max(15, radio * PARAMETROS.fotos.medallon), {
      foto: t.foto,
      inicial: t.inicial,
      color: t.color,
      grosor: Math.max(2, radio * 0.045),
      separacion: Math.max(1.6, radio * 0.03),
    });

    // --- ficha
    const anchoTexto = anchoCelda - 30;
    ctx.font = "700 20px system-ui, 'Segoe UI', sans-serif";
    const nombre = recortar(t.nombre, anchoTexto);
    rotulo(nombre, cx, y + altoCelda * 0.72, 20, "#ffffff", 700);
    rotulo(
      `${t.diseno.nombre}${t.diseno.variante ? ` · variante ${t.diseno.variante + 1}` : ""}`,
      cx,
      y + altoCelda * 0.72 + 24,
      15,
      conAlfa(t.color, 0.95),
    );
    rotulo(
      `${t.foto ? t.foto.replace("fotos/", "") : "sin foto → inicial"}`,
      cx,
      y + altoCelda * 0.72 + 44,
      13,
      "#9a9ab0",
    );
  });

  document.body.dataset.listos = String(fotos.estado().listas);
  document.body.dataset.fallidas = String(fotos.estado().fallidas);
  document.body.dataset.listo = "1";
}

// Las fotos llegan por la red: se repinta hasta que todas se hayan resuelto (o hasta
// que pasen tres segundos, para que la página nunca se quede en blanco).
let intentos = 0;
pintar();
const reloj = setInterval(() => {
  intentos += 1;
  pintar();
  const e = fotos.estado();
  if (e.listas + e.fallidas >= e.pedidas || intentos > 20) clearInterval(reloj);
}, 150);

window.LAMINA_IDENTIDAD = {
  participantes: trompos.length,
  fotos: () => fotos.estado(),
  identidades: () => trompos.map((t) => ({ ...t.participante.ficha(), diseno: t.diseno.clave, variante: t.diseno.variante ?? 0 })),
  medir: () => ({ ancho: ANCHO, alto: ALTO, radioMedallon: Math.max(15, 90 * PARAMETROS.fotos.medallon) }),
};
