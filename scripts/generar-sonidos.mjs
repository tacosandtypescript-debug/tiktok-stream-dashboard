// scripts/generar-sonidos.mjs — el pack de sonidos de las alertas.
//
// Son **propios**: se sintetizan aqui, no se descargan de ningun sitio. Por eso
// pueden ir dentro de la release y suenan igual sin internet.
//
// Un WAV PCM es una cabecera de 44 bytes y una ristra de muestras, asi que no hace
// falta ninguna dependencia: Node ya hace falta para compilar la interfaz, y esto
// es aritmetica.
//
// Los WAV que salen de aqui **se versionan**; no se generan durante el build.
// `include_bytes!` los necesita al compilar, y un `cargo build` a secas tiene que
// funcionar sin pasos previos. Este script existe para poder retocarlos.
//
// Uso:  node scripts/generar-sonidos.mjs
//       node scripts/generar-sonidos.mjs --listar
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, "..", "apps", "desktop", "src-tauri", "sonidos");

/** Frecuencia de muestreo. 44,1 kHz es lo que reproduce cualquier navegador. */
const HZ = 44100;

/**
 * Las notas que se usan, para no sembrar el fichero de numeros sueltos.
 *
 * Estan en la octava del do central (do = 523 Hz). Es un registro agudo a
 * proposito: un aviso tiene que colarse por encima de la musica del directo sin
 * hacer falta subirle el volumen, y ahi abajo se pierde.
 */
const N = {
  do: 523.25,
  re: 587.33,
  mi: 659.25,
  fa: 698.46,
  sol: 783.99,
  la: 880.0,
  si: 987.77,
  do2: 1046.5,
  mi2: 1318.5,
  la2: 1760.0,
};

/**
 * Una nota dentro de un sonido.
 *
 * `armonicos` reparte el peso entre el tono base y sus multiplos: con el segundo
 * y el tercero suena a campana y no a pitido de electrodomestico. El 2 suena una
 * octava arriba y el 3 una quinta por encima de esa, que es lo que hace que un
 * tono puro suene a «timbre» al añadirlo.
 */
function nota(frecuencia, inicio, duracion, fuerza = 1, armonicos = [1, 0.35, 0.12]) {
  return { frecuencia, inicio, duracion, fuerza, armonicos };
}

/** Un barrido de frecuencia: la nota sube de `desde` a `hasta` mientras suena. */
function barrido(desde, hasta, inicio, duracion, fuerza = 1) {
  return { frecuencia: desde, hasta, inicio, duracion, fuerza, armonicos: [1, 0.25] };
}

/**
 * Envolvente de una nota: entra rapido y se apaga sola.
 *
 * El ataque es de 4 ms y no de cero: un ataque instantaneo hace «clic» en los
 * altavoces, y ese clic se oye mas que la propia nota.
 *
 * La caida es exponencial porque es lo que hace un instrumento de verdad —un
 * xilofono, una campana—, pero **despacio**: con un factor de 5 la nota llegaba al
 * final a -43 dB, o sea apagada a la tercera parte. Medido con los cruces por cero,
 * en el ultimo tercio ya solo se medía ruido. Con 3 acaba a -26 dB: se sigue oyendo
 * entera, y el barrido de «subida» se oye subir, que es todo su trabajo.
 */
function envolvente(t, duracion) {
  const ataque = 0.004;
  if (t < 0 || t > duracion) return 0;
  const subida = t < ataque ? t / ataque : 1;
  const caida = Math.exp((-3 * (t - ataque)) / Math.max(duracion - ataque, 0.001));
  return subida * caida;
}

/** Convierte una lista de notas en muestras, ya normalizadas. */
function renderizar(notas, duracionTotal) {
  const total = Math.ceil(duracionTotal * HZ);
  const muestras = new Float64Array(total);
  for (const n of notas) {
    const hasta = n.hasta ?? n.frecuencia;
    const inicio = Math.floor(n.inicio * HZ);
    const fin = Math.min(total, Math.ceil((n.inicio + n.duracion) * HZ));
    // La fase se acumula a mano: con un barrido, calcular `sin(2 pi f t)` en cada
    // muestra da un salto de fase en cada paso y suena a chasquido.
    let fase = 0;
    for (let i = inicio; i < fin; i += 1) {
      const t = (i - inicio) / HZ;
      const avance = (i - inicio) / Math.max(fin - inicio - 1, 1);
      const frecuencia = n.frecuencia + (hasta - n.frecuencia) * avance;
      fase += (2 * Math.PI * frecuencia) / HZ;
      let valor = 0;
      for (let a = 0; a < n.armonicos.length; a += 1) {
        valor += n.armonicos[a] * Math.sin(fase * (a + 1));
      }
      // El decaimiento es mas rapido en los armonicos altos, que es lo que pasa en
      // un instrumento real: por eso una campana empieza brillante y acaba dulce.
      const env = envolvente(t, n.duracion);
      muestras[i] += valor * env * n.fuerza;
    }
  }
  return normalizar(muestras, duracionTotal);
}

/**
 * Deja el pico en 0,89 y funde el final.
 *
 * Normalizar **cada sonido por su cuenta** y no todos por el mismo factor es lo
 * que hace que suenen a juego: si no, el redoble —que suma muchas notas— saldria
 * mucho mas alto que la pizca, y en el directo habria que estar tocando el volumen
 * de OBS en cada alerta.
 *
 * El fundido final evita el «toc» que hace cortar una onda a media subida.
 */
function normalizar(muestras, duracionTotal) {
  let pico = 0;
  for (const v of muestras) pico = Math.max(pico, Math.abs(v));
  const escala = pico > 0 ? 0.89 / pico : 1;

  const fundido = Math.floor(0.02 * HZ);
  const total = muestras.length;
  for (let i = 0; i < total; i += 1) {
    let v = muestras[i] * escala;
    const desdeElFinal = total - i;
    if (desdeElFinal < fundido) v *= desdeElFinal / fundido;
    muestras[i] = v;
  }
  return muestras;
}

/** Las muestras a un WAV PCM de 16 bits mono. */
function aWav(muestras) {
  const datos = Buffer.alloc(muestras.length * 2);
  for (let i = 0; i < muestras.length; i += 1) {
    const v = Math.max(-1, Math.min(1, muestras[i]));
    datos.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const cabecera = Buffer.alloc(44);
  cabecera.write("RIFF", 0);
  cabecera.writeUInt32LE(36 + datos.length, 4);
  cabecera.write("WAVE", 8);
  cabecera.write("fmt ", 12);
  cabecera.writeUInt32LE(16, 16); // tamano del bloque fmt
  cabecera.writeUInt16LE(1, 20); // PCM sin comprimir
  cabecera.writeUInt16LE(1, 22); // mono
  cabecera.writeUInt32LE(HZ, 24);
  cabecera.writeUInt32LE(HZ * 2, 28); // bytes por segundo
  cabecera.writeUInt16LE(2, 32); // alineacion de bloque
  cabecera.writeUInt16LE(16, 34); // bits por muestra
  cabecera.write("data", 36);
  cabecera.writeUInt32LE(datos.length, 40);
  return Buffer.concat([cabecera, datos]);
}

/**
 * El pack.
 *
 * Criterios, que son los mismos para los siete: **corto** (un aviso de regalo
 * suena decenas de veces en un directo y a la decima cansa cualquier cosa),
 * **agudo** (tiene que colarse por encima de la musica) y **con final redondo**
 * (nada de cortes secos). Los tres tramos de regalo suben en brillo y en duracion
 * para que se distingan sin mirar la pantalla.
 */
const PACK = [
  {
    fichero: "campana-suave.wav",
    // El regalo normal: dos notas, cortas. Es el que mas suena y el que menos
    // tiene que molestar.
    muestras: () => renderizar([nota(N.do, 0, 0.38, 0.9), nota(N.sol, 0.1, 0.45, 0.8)], 0.6),
  },
  {
    fichero: "campana-brillante.wav",
    // El tramo medio: tres notas que suben y un poco mas de armonico, para que se
    // note que este regalo fue mas grande.
    muestras: () =>
      renderizar(
        [
          nota(N.do, 0, 0.3, 0.8, [1, 0.45, 0.2]),
          nota(N.mi, 0.09, 0.32, 0.85, [1, 0.45, 0.2]),
          nota(N.sol, 0.18, 0.5, 0.95, [1, 0.5, 0.25]),
        ],
        0.78,
      ),
  },
  {
    fichero: "redoble.wav",
    // El tramo grande: una subida rapida y un acorde final que se sostiene. Es el
    // unico largo del pack, y se lo puede permitir porque sale pocas veces.
    muestras: () => {
      const subida = [N.do, N.re, N.mi, N.fa, N.sol, N.la, N.si, N.do2].map((f, i) =>
        nota(f, i * 0.055, 0.22, 0.55 + i * 0.03),
      );
      return renderizar(
        [
          ...subida,
          nota(N.do, 0.46, 0.72, 1, [1, 0.4, 0.18]),
          nota(N.mi, 0.46, 0.72, 0.8, [1, 0.4, 0.18]),
          nota(N.sol, 0.46, 0.78, 0.9, [1, 0.45, 0.2]),
        ],
        1.3,
      );
    },
  },
  {
    fichero: "subida.wav",
    // Seguidor: un barrido corto hacia arriba. Suena a «algo empieza», que es lo
    // que es un seguidor nuevo.
    muestras: () => renderizar([barrido(N.do, N.do2, 0, 0.3, 0.95)], 0.36),
  },
  {
    fichero: "fanfarria.wav",
    // Suscripcion: una cuarta que sube y se queda. Es el gesto de «tachan», sin
    // llegar a ser una melodia que se recuerde y canse.
    muestras: () =>
      renderizar([nota(N.sol, 0, 0.2, 0.8), nota(N.do2, 0.14, 0.6, 1, [1, 0.4, 0.2])], 0.78),
  },
  {
    fichero: "toque.wav",
    // Compartido: un solo golpe seco. Sale poco y no debe llamar mucho.
    muestras: () => renderizar([nota(N.re, 0, 0.22, 0.9)], 0.28),
  },
  {
    fichero: "pizca.wav",
    // Likes: el mas corto y el mas agudo de todos. Puede sonar muy seguido, asi
    // que no puede tener cola: si la tuviera, se solaparian y seria un barullo.
    muestras: () =>
      renderizar([nota(N.la2, 0, 0.1, 0.85, [1, 0.3])], 0.13),
  },
];

if (process.argv.includes("--listar")) {
  for (const p of PACK) console.log(`  ${p.fichero}`);
  process.exit(0);
}

mkdirSync(DESTINO, { recursive: true });
let bytes = 0;
for (const p of PACK) {
  const wav = aWav(p.muestras());
  writeFileSync(join(DESTINO, p.fichero), wav);
  bytes += wav.length;
  const segundos = ((wav.length - 44) / 2 / HZ).toFixed(2);
  console.log(`  ${p.fichero.padEnd(24)} ${String(wav.length).padStart(6)} B   ${segundos} s`);
}
console.log(`\n${PACK.length} sonidos, ${(bytes / 1024).toFixed(0)} KB en total, en ${DESTINO}`);
