/* Comprueba las piezas del contenedor del mensaje que **no necesitan navegador**.
 *
 *   node scripts/comprobar-mensaje.mjs
 *
 * Los modulos del overlay son guiones sueltos que se cuelgan de `window`, asi que se
 * ejecutan aqui con un `window` y un `document` de mentira: lo justo para el troceado del
 * texto. No hay navegador, y por eso no se comprueba el pintado —para eso estan la previa
 * y el banco de la interfaz—, pero si todo lo que se puede saber sin pintar:
 *
 *   1. **El normalizado**: los valores de fabrica y los topes, que son los mismos que
 *      aplica Rust. Si se separan, el overlay pinta algo que el motor no llego a guardar.
 *   2. **Los planes de animacion**: que cada animacion exista, dure lo pedido y **acabe
 *      en el estado natural** —opacidad 1, sin transformacion y sin recorte—, que es lo
 *      que hace que al terminar quede lo que dice la hoja de estilos.
 *   3. **Las permanencias**: que se repitan sin parar y digan a quien animan.
 *   4. **El troceado del texto**: que no se pierda ni un caracter ni un espacio.
 *   5. **Los presets**: que cada estilo del catalogo tenga receta y sus ganchos.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Los ficheros se buscan **desde donde vive este script** y no desde donde se ejecute: si
// dependiera del directorio actual, lanzarlo desde `apps/desktop` no encontraria nada.
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(raiz, "apps/desktop/src-tauri/src/overlay/web/mensaje");

/** Un nodo de mentira, lo justo para el troceado y las animaciones. */
const nodoFalso = (texto = "") => ({
  textContent: texto,
  children: [],
  appendChild(nodo) {
    this.children.push(nodo);
  },
  animate: () => ({ cancel() {} }),
});

/** El texto de un nodo, contando lo que hay dentro: es como `textContent` de verdad. */
const textoDe = (nodo) =>
  (nodo.textContent || "") + (nodo.children || []).map(textoDe).join("");

const ctx = {
  window: {},
  console,
  document: {
    createElement: () => nodoFalso(),
    createTextNode: (texto) => nodoFalso(texto),
  },
};
vm.createContext(ctx);
for (const fichero of ["config.js", "presets.js", "animaciones.js", "texto.js"]) {
  vm.runInContext(readFileSync(join(dir, fichero), "utf8"), ctx, { filename: fichero });
}
const { window: w } = ctx;
const fallos = [];
const comprobar = (condicion, texto) => {
  if (!condicion) fallos.push(texto);
};

// --- El normalizado ---------------------------------------------------------
const deFabrica = w.DashMensajeConfig.normalizar(undefined);
comprobar(deFabrica.fondo === "#0b0d12", "el fondo de fábrica");
comprobar(deFabrica.fondo_opacidad === 88, "la opacidad de fábrica");
comprobar(deFabrica.radio === 12, "el radio de fábrica");
comprobar(deFabrica.tamano === 40 && deFabrica.peso === 800, "la letra de fábrica");
comprobar(deFabrica.separacion === 14, "la separación de fábrica");
comprobar(deFabrica.animacion === "ninguna", "sin animación de fábrica");

const sucio = w.DashMensajeConfig.normalizar({
  radio: 9999,
  fondo: "rojo; } body { display: none",
  color: "#AABBCC",
  peso: 437,
  ancho_vw: 400,
  intensidad: -20,
  duracion_ms: 1,
  estilo: "  NEON ",
});
comprobar(sucio.radio === 200, "el radio se recorta a 200");
comprobar(sucio.fondo === "#0b0d12", "un color que no es un color cae al de fábrica");
comprobar(sucio.color === "#aabbcc", "un color válido se guarda en minúsculas");
comprobar(sucio.peso === 400, "el peso se redondea a la centena");
comprobar(sucio.ancho_vw === 100, "el ancho se recorta a 100");
comprobar(sucio.intensidad === 0, "la intensidad no baja de cero");
comprobar(sucio.duracion_ms === 80, "la duración no baja de 80 ms");
comprobar(sucio.estilo === "neon", "el estilo se acepta con espacios y mayúsculas");

comprobar(
  w.DashMensajeConfig.rgba("#0b0d12", 88) === "rgba(11, 13, 18, 0.88)",
  "rgba compone bien",
);

// --- Las animaciones del contenedor -----------------------------------------
const { ANIMACIONES, PERMANENCIAS, ANIMACIONES_TEXTO } = w.DashMensajeConfig;
const base = { ...deFabrica, duracion_ms: 400, intensidad: 60, ritmo: "auto" };

for (const id of ANIMACIONES) {
  const plan = w.DashMensajeAnim.entrada({ ...base, animacion: id });
  if (id === "ninguna") {
    comprobar(plan === null, "«ninguna» no anima");
    continue;
  }
  comprobar(Boolean(plan && plan.fotogramas.length >= 2), `«${id}» tiene fotogramas`);
  if (!plan) continue;
  const ultimo = plan.fotogramas[plan.fotogramas.length - 1];
  // La invariante que sostiene todo: la animación **acaba en el estado natural**, para
  // que lo que quede al terminar sea lo que dice la hoja de estilos.
  comprobar(
    ultimo.opacity === undefined || ultimo.opacity === 1,
    `«${id}» acaba con opacidad 1`,
  );
  comprobar(
    ultimo.transform === undefined || /^(scale\(1\)|translate[XY]\(0\)|none)$/.test(ultimo.transform),
    `«${id}» acaba en su sitio (${ultimo.transform})`,
  );
  comprobar(!ultimo.clipPath || ultimo.clipPath === "inset(0 0 0 0)", `«${id}» acaba sin recorte`);
  comprobar(!ultimo.filter || ultimo.filter === "blur(0px)" || ultimo.filter === "brightness(1) blur(0px)", `«${id}» acaba sin filtro`);
  comprobar(plan.opciones.duration === 400, `«${id}» usa la duración pedida`);
  comprobar(plan.opciones.fill === "both", `«${id}» se queda quieto antes de empezar`);
}

for (const id of PERMANENCIAS) {
  const plan = w.DashMensajeAnim.permanencia({ ...base, animacion_idle: id });
  if (id === "ninguna") {
    comprobar(plan === null, "«ninguna» no repite nada");
    continue;
  }
  comprobar(Boolean(plan), `«${id}» tiene plan`);
  if (!plan) continue;
  comprobar(plan.opciones.iterations === Infinity, `«${id}» se repite sin parar`);
  comprobar(plan.opciones.duration >= 120, `«${id}» dura algo`);
  comprobar(["caja", "brillo"].includes(plan.capa), `«${id}» dice a quién anima`);
}

// --- Las animaciones del texto ----------------------------------------------
for (const id of ANIMACIONES_TEXTO) {
  const nodo = nodoFalso("Alguien se suscribió (3 meses)");
  const ms = w.DashMensajeTexto.animar(nodo, { ...base, animacion_texto: id }, nodo.textContent, {});
  if (id === "ninguna") {
    comprobar(ms === 0, "el texto sin animación no dura nada");
    comprobar(nodo.textContent === "Alguien se suscribió (3 meses)", "y se queda entero");
    continue;
  }
  comprobar(ms > 0, `«${id}» del texto dura algo (${ms} ms)`);
  comprobar(ms < 6000, `«${id}» del texto no se eterniza (${ms} ms)`);
}

// El troceado: por palabras y por letras, sin perder ni un carácter ni un espacio.
const texto = "Hola  mundo 👋";
for (const unidades of ["palabras", "letras"]) {
  const nodo = nodoFalso();
  w.DashMensajeTexto.trocear(nodo, texto, unidades);
  comprobar(textoDe(nodo) === texto, `el troceado por ${unidades} conserva el texto`);
}

// --- Los presets -------------------------------------------------------------
for (const id of w.DashMensajeConfig.ESTILOS) {
  const receta = w.DashMensajePresets.receta(id);
  comprobar(Boolean(receta), `el estilo «${id}» tiene receta`);
}
const degradado = w.DashMensajePresets.receta("gradient").variables(deFabrica);
comprobar(
  String(degradado["--mensaje-fondo"]).startsWith("linear-gradient"),
  "el degradado compone sus dos colores",
);
comprobar(
  w.DashMensajePresets.receta("cinta").atributos["data-deco"] === "cinta",
  "la cinta lleva sus puntas",
);
comprobar(
  w.DashMensajePresets.receta("barra").atributos["data-ancho"] === "completo",
  "la barra ocupa el ancho",
);

if (fallos.length > 0) {
  console.error(`FALLOS (${fallos.length}):`);
  for (const fallo of fallos) console.error("  - " + fallo);
  process.exit(1);
}
console.log(
  `ok: normalizado, ${ANIMACIONES.length} animaciones de contenedor, ${PERMANENCIAS.length} permanencias, ` +
    `${ANIMACIONES_TEXTO.length} de texto y ${w.DashMensajeConfig.ESTILOS.length} presets`,
);
