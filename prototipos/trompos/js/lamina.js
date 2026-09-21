// Hoja de diseños: los diez trompos en fila, con su geometría escrita.
//
// Existe para poder revisar los diez diseños de un vistazo y sin física de por medio
// (nada se mueve aquí): es la lámina que se mira para aprobar o rechazar el aspecto.
// Cada diseño se dibuja tres veces de pequeño con vida alta, media y baja, para ver
// cómo cambia el aspecto al perder energía.
//
// Uso: http://127.0.0.1:8123/disenos.html

import { PARAMETROS } from "./parametros.js";
import { DISENOS, ORDEN_DISENOS, dibujarCuerpo, dibujarDanio } from "./dibujo/disenos.js";
import { conAlfa } from "./util.js";

const lienzo = document.getElementById("lamina");
const ctx = lienzo.getContext("2d", { alpha: true });
lienzo.width = PARAMETROS.lienzo.ancho;
lienzo.height = PARAMETROS.lienzo.alto;

const ANCHO = lienzo.width;
const ALTO = lienzo.height;

function textoGeometria(d) {
  return `${d.palas.n} palas ${d.palas.forma}`;
}

function textoAnillo(d) {
  return `anillo ${d.anillo.lados} lados ${d.anillo.estilo}`;
}

function textoPatron(d) {
  return `patrón ${d.patron} · núcleo ${d.nucleo}`;
}

function textoCifras(d) {
  return `atq ${d.ataque.toFixed(2)} · def ${d.defensa.toFixed(2)} · masa ${d.densidad.toFixed(2)}`;
}

function rotulo(texto, x, y, tamano, color, peso = 600) {
  ctx.font = `${peso} ${tamano}px system-ui, 'Segoe UI', sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(texto, x, y);
}

function pintar() {
  ctx.clearRect(0, 0, ANCHO, ALTO);
  // La lámina no es el overlay: aquí sí se pinta un fondo oscuro para que se lea
  // como un documento (y para que el PNG suelto no salga con texto blanco sobre
  // blanco). El lienzo del taller sigue transparente.
  ctx.fillStyle = "#0d0d12";
  ctx.fillRect(0, 0, ANCHO, ALTO);

  // --- cabecera
  rotulo("LOS DIEZ DISEÑOS", 60, 76, 46, "#ffffff", 800);
  rotulo(
    "Generados por código con arcos, polígonos, degradados y transparencias · sin sprites ni imágenes",
    60,
    124,
    22,
    "#9a9ab0",
  );

  const margen = 54;
  const arriba = 178;
  const columnas = 2;
  const filas = 5;
  const separacion = 14;
  const anchoCelda = (ANCHO - margen * 2 - separacion) / columnas;
  const altoCelda = (ALTO - arriba - margen - separacion * (filas - 1)) / filas;

  ORDEN_DISENOS.forEach((clave, i) => {
    const d = DISENOS[clave];
    const col = i % columnas;
    const fil = Math.floor(i / columnas);
    const x = margen + col * (anchoCelda + separacion);
    const y = arriba + fil * (altoCelda + separacion);

    // --- marco de la celda
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.strokeStyle = conAlfa(d.colores.base, 0.5);
    ctx.lineWidth = 2;
    const r = 18;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + anchoCelda - r, y);
    ctx.quadraticCurveTo(x + anchoCelda, y, x + anchoCelda, y + r);
    ctx.lineTo(x + anchoCelda, y + altoCelda - r);
    ctx.quadraticCurveTo(x + anchoCelda, y + altoCelda, x + anchoCelda - r, y + altoCelda);
    ctx.lineTo(x + r, y + altoCelda);
    ctx.quadraticCurveTo(x, y + altoCelda, x, y + altoCelda - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // --- el trompo, a la izquierda de la celda
    const radio = 58;
    const cx = x + 24 + radio + 20;
    const cy = y + altoCelda / 2 + 6;
    ctx.save();
    ctx.translate(cx, cy);
    dibujarCuerpo(ctx, d, radio, 1, 0.6, 0.2);
    ctx.restore();

    // --- ficha a la derecha: no invade la celda vecina ni pisa el dibujo
    const tx = x + 200;
    rotulo(String(i + 1).padStart(2, "0"), tx, y + 30, 22, conAlfa(d.colores.claro, 0.95), 800);
    rotulo(d.nombre, tx + 44, y + 30, 27, "#ffffff", 800);
    rotulo(d.lema, tx, y + 60, 18, "#9a9ab0");
    rotulo(textoGeometria(d), tx, y + 96, 17, "#d8d8e8");
    rotulo(textoAnillo(d), tx, y + 122, 17, "#d8d8e8");
    rotulo(textoPatron(d), tx, y + 148, 17, "#d8d8e8");
    rotulo(textoCifras(d), tx, y + 174, 17, conAlfa(d.colores.acento, 0.95));

    // --- la vida cambia el aspecto: alta, media y baja
    rotulo("vida alta · media · baja", tx, y + 210, 16, "#9a9ab0");
    [
      [1, "alta"],
      [0.5, "media"],
      [0.2, "baja"],
    ].forEach(([vida], k) => {
      const mx = tx + 30 + k * 62;
      const my = y + 258;
      ctx.save();
      ctx.translate(mx, my);
      dibujarCuerpo(ctx, d, 26, vida, 0.6 + k * 0.3, 0.2);
      // Las grietas del anillo son justo lo que aparece al perder vida: sin esto la
      // lámina enseñaría tres copias iguales y no el cambio de aspecto.
      dibujarDanio(ctx, d, 26, 1 - vida, 0.4 + k, 0.6 + k * 0.3);
      ctx.restore();
    });
  });

  document.body.dataset.listo = "1";
}

pintar();

// Ayuda para las comprobaciones: la lámina es fija, no hay simulación que mirar.
window.LAMINA = {
  disenos: ORDEN_DISENOS.map((clave) => ({
    clave,
    nombre: DISENOS[clave].nombre,
    geometria: `${textoGeometria(DISENOS[clave])} · ${textoAnillo(DISENOS[clave])} · ${textoPatron(DISENOS[clave])}`,
  })),
  medir: () => ({ ancho: lienzo.width, alto: lienzo.height }),
};
