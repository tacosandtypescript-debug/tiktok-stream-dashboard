// Genera las "fotos" simuladas de los participantes: son PNG de verdad, escritos a
// mano (sin dependencias), para que el prototipo pueda probar el camino real de una
// imagen: descarga, recorte circular, proporción distinta y fallo de carga.
//
//   node generar-fotos.mjs            escribe fotos/ (44 retratos + 1 panorámica)
//   node generar-fotos.mjs --ver 7    sólo el retrato 7, para mirarlo
//
// Por qué no se dibujan al vuelo en el navegador: porque lo que hay que validar es el
// <img> que carga (o no carga), no un dibujo. Aquí se generan los archivos y el
// prototipo los carga como cargaría la foto real de un espectador.
//
// No hay ni una cara real ni un asset de terceros: son caras geométricas originales.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SALIDA = resolve(RAIZ, "fotos");

// ------------------------------------------------------------------ PNG

const TABLA_CRC = (() => {
  const tabla = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c;
  }
  return tabla;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function trozo(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length, 0);
  const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([largo, cuerpo, crc]);
}

/** Codifica un lienzo RGBA a PNG (color tipo 6, 8 bits por canal, sin filtros). */
function aPng(lienzo) {
  const { ancho, alto, datos } = lienzo;
  const fila = ancho * 4 + 1;
  const crudo = Buffer.alloc(fila * alto);
  for (let y = 0; y < alto; y += 1) {
    crudo[y * fila] = 0;
    datos.copy(crudo, y * fila + 1, y * ancho * 4, (y + 1) * ancho * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo("IHDR", ihdr),
    trozo("IDAT", deflateSync(crudo, { level: 9 })),
    trozo("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ dibujo

function lienzo(ancho, alto) {
  return { ancho, alto, datos: Buffer.alloc(ancho * alto * 4) };
}

function mezcla(l, x, y, [r, g, b], alfa = 1) {
  if (x < 0 || y < 0 || x >= l.ancho || y >= l.alto) return;
  const i = (y * l.ancho + x) * 4;
  const a = Math.max(0, Math.min(1, alfa));
  l.datos[i] = Math.round(l.datos[i] * (1 - a) + r * a);
  l.datos[i + 1] = Math.round(l.datos[i + 1] * (1 - a) + g * a);
  l.datos[i + 2] = Math.round(l.datos[i + 2] * (1 - a) + b * a);
  l.datos[i + 3] = Math.round(l.datos[i + 3] * (1 - a) + 255 * a);
}

function elipse(l, cx, cy, rx, ry, color, alfa = 1) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) mezcla(l, x, y, color, alfa);
    }
  }
}

function anillo(l, cx, cy, rx, ry, grosor, color, alfa = 1) {
  for (let y = Math.floor(cy - ry - grosor); y <= Math.ceil(cy + ry + grosor); y += 1) {
    for (let x = Math.floor(cx - rx - grosor); x <= Math.ceil(cx + rx + grosor); x += 1) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const fuera = (rx + grosor) / rx;
      if (d <= 1 && d >= 1 - grosor / rx) mezcla(l, x, y, color, alfa);
      void fuera;
    }
  }
}

function rect(l, x0, y0, x1, y1, color, alfa = 1) {
  for (let y = Math.floor(y0); y < y1; y += 1) {
    for (let x = Math.floor(x0); x < x1; x += 1) mezcla(l, x, y, color, alfa);
  }
}

function fondoDegradado(l, c1, c2, diagonal = true) {
  for (let y = 0; y < l.alto; y += 1) {
    for (let x = 0; x < l.ancho; x += 1) {
      const t = diagonal ? (x / l.ancho + y / l.alto) / 2 : y / l.alto;
      mezcla(l, x, y, [
        c1[0] + (c2[0] - c1[0]) * t,
        c1[1] + (c2[1] - c1[1]) * t,
        c1[2] + (c2[2] - c1[2]) * t,
      ], 1);
    }
  }
}

// ------------------------------------------------------------------ color

function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

const PIELES = [
  [242, 205, 178],
  [229, 184, 148],
  [206, 156, 118],
  [171, 122, 88],
  [131, 89, 62],
  [96, 63, 44],
];

const PELOS = [
  [38, 28, 24],
  [66, 44, 30],
  [120, 76, 40],
  [196, 152, 74],
  [150, 40, 40],
  [90, 60, 140],
  [40, 40, 46],
];

// ------------------------------------------------------------------ retrato

/**
 * Retrato geométrico: fondo del color del jugador, cabeza, pelo, ojos, boca y un
 * accesorio distinto cada cinco. Todo determinista a partir del índice.
 */
function retrato(indice, lado = 96) {
  const l = lienzo(lado, lado);
  const c = lado / 2;
  const color = hsl(indice * 137.508, 0.62, 0.52);
  const colorClaro = hsl(indice * 137.508, 0.68, 0.68);
  const colorOscuro = hsl(indice * 137.508, 0.55, 0.3);

  fondoDegradado(l, color, colorOscuro);
  // Rayas diagonales suaves: dan textura sin tapar la cara.
  for (let y = 0; y < lado; y += 1) {
    for (let x = 0; x < lado; x += 1) {
      if ((x + y) % 12 < 3) mezcla(l, x, y, [255, 255, 255], 0.06);
    }
  }

  const piel = PIELES[indice % PIELES.length];
  const pelo = PELOS[(indice * 3) % PELOS.length];
  const cx = c;
  const cy = c + lado * 0.06;
  const rx = lado * 0.24;
  const ry = lado * 0.28;

  // Hombros: un trapecio redondeado para que no sea una cabeza flotante.
  elipse(l, cx, lado * 1.05, lado * 0.42, lado * 0.3, hsl(indice * 137.508, 0.4, 0.35));

  // Pelo de fondo (por detrás de la cara).
  const estilo = indice % 5;
  if (estilo === 1) {
    elipse(l, cx - rx * 0.9, cy + ry * 0.15, rx * 0.5, ry * 0.9, pelo);
    elipse(l, cx + rx * 0.9, cy + ry * 0.15, rx * 0.5, ry * 0.9, pelo);
  }
  elipse(l, cx, cy - ry * 0.28, rx * 1.08, ry * 0.85, pelo);

  // Cara.
  elipse(l, cx, cy, rx, ry, piel);

  // Flequillo: media luna sobre la frente.
  elipse(l, cx, cy - ry * 0.62, rx * 1.02, ry * 0.42, pelo);

  // Cejas y ojos.
  const ojo = [26, 22, 26];
  const dx = rx * 0.42;
  const dy = -ry * 0.06;
  rect(l, cx - dx - rx * 0.2, cy + dy - ry * 0.26, cx - dx + rx * 0.2, cy + dy - ry * 0.19, pelo);
  rect(l, cx + dx - rx * 0.2, cy + dy - ry * 0.26, cx + dx + rx * 0.2, cy + dy - ry * 0.19, pelo);
  elipse(l, cx - dx, cy + dy, rx * 0.15, ry * 0.09, [250, 250, 250]);
  elipse(l, cx + dx, cy + dy, rx * 0.15, ry * 0.09, [250, 250, 250]);
  elipse(l, cx - dx, cy + dy, rx * 0.07, ry * 0.07, ojo);
  elipse(l, cx + dx, cy + dy, rx * 0.07, ry * 0.07, ojo);

  // Nariz y boca.
  elipse(l, cx, cy + ry * 0.2, rx * 0.07, ry * 0.09, [0, 0, 0], 0.12);
  elipse(l, cx, cy + ry * 0.5, rx * 0.22, ry * 0.09, [120, 40, 46]);

  // Accesorios: gafas, gorro, cascos, barba o nada.
  if (estilo === 0) {
    anillo(l, cx - dx, cy + dy, rx * 0.2, ry * 0.13, 1.6, [30, 30, 36]);
    anillo(l, cx + dx, cy + dy, rx * 0.2, ry * 0.13, 1.6, [30, 30, 36]);
    rect(l, cx - dx * 0.3, cy + dy - 1, cx + dx * 0.3, cy + dy + 1, [30, 30, 36]);
  } else if (estilo === 2) {
    elipse(l, cx, cy - ry * 0.95, rx * 1.15, ry * 0.4, colorClaro);
    rect(l, cx - rx * 1.15, cy - ry * 0.95, cx + rx * 1.15, cy - ry * 0.78, colorOscuro);
  } else if (estilo === 3) {
    anillo(l, cx - rx * 1.05, cy, rx * 0.34, ry * 0.36, 3, [40, 42, 50]);
    anillo(l, cx + rx * 1.05, cy, rx * 0.34, ry * 0.36, 3, [40, 42, 50]);
  } else if (estilo === 4) {
    elipse(l, cx, cy + ry * 0.62, rx * 0.86, ry * 0.42, pelo, 0.9);
    elipse(l, cx, cy + ry * 0.5, rx * 0.22, ry * 0.09, [120, 40, 46]);
  }

  // Borde del color del jugador: el mismo que llevará el medallón en el trompo.
  anillo(l, c, c, lado * 0.47, lado * 0.47, 2.6, colorClaro);
  return l;
}

/** Panorámica (240×96): sirve para comprobar que el recorte circular no deforma. */
function panoramica(indice) {
  const l = lienzo(240, 96);
  const color = hsl(indice * 137.508, 0.6, 0.5);
  fondoDegradado(l, color, [20, 20, 28], false);
  const cara = retrato(indice, 96);
  // Se pega el retrato en el centro: al recortar en círculo desde el centro, la cara
  // queda entera y el fondo sobra a los lados.
  for (let y = 0; y < 96; y += 1) {
    for (let x = 0; x < 96; x += 1) {
      const i = (y * 96 + x) * 4;
      const alfa = cara.datos[i + 3] / 255;
      if (alfa > 0.9) mezcla(l, x + 72, y, [cara.datos[i], cara.datos[i + 1], cara.datos[i + 2]], 1);
    }
  }
  return l;
}

// ------------------------------------------------------------------ salida

const ver = process.argv.indexOf("--ver");
if (ver >= 0) {
  const indice = Number(process.argv[ver + 1] ?? 0);
  const ruta = resolve(RAIZ, `foto-prueba-${indice}.png`);
  writeFileSync(ruta, aPng(retrato(indice)));
  console.log(`escrito ${ruta}`);
} else {
  mkdirSync(SALIDA, { recursive: true });
  const CUANTOS = 44;
  for (let i = 0; i < CUANTOS; i += 1) {
    const nombre = `retrato-${String(i + 1).padStart(2, "0")}.png`;
    writeFileSync(resolve(SALIDA, nombre), aPng(retrato(i)));
  }
  writeFileSync(resolve(SALIDA, "panoramica-01.png"), aPng(panoramica(5)));
  console.log(`escritos ${CUANTOS} retratos de 96×96 y 1 panorámica de 240×96 en ${SALIDA}`);
  console.log("La foto que falta (para probar el respaldo) no se genera a propósito:");
  console.log("el prototipo apunta a fotos/falta-99.png, que devuelve 404.");
}
