/* Comprueba la carrera mas delicada del overlay de alertas sin abrir un navegador.
 *
 *   node scripts/comprobar-alertas.mjs
 *
 * Se simula un fichero local que tarda en emitir `load`. La alerta no debe arrancar
 * el sonido ni el reloj visible antes de que el medio este listo; una vez que llega
 * el evento, ambos deben empezar y la cola tiene que mostrar la caja.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const raiz = join(fileURLToPath(new URL(".", import.meta.url)), "..");

class Clases {
  #valores = new Set();

  add(nombre) {
    this.#valores.add(nombre);
  }

  remove(nombre) {
    this.#valores.delete(nombre);
  }

  contains(nombre) {
    return this.#valores.has(nombre);
  }
}

class Nodo {
  constructor() {
    this.classList = new Clases();
    this.style = { setProperty() {} };
    this.textContent = "";
    this.listeners = new Map();
    this._src = "";
    this.playCount = 0;
    this.complete = false;
    this.naturalWidth = 0;
    this.readyState = 0;
  }

  set src(valor) {
    this._src = valor;
  }

  get src() {
    return this._src;
  }

  addEventListener(nombre, funcion) {
    const lista = this.listeners.get(nombre) || new Set();
    lista.add(funcion);
    this.listeners.set(nombre, lista);
  }

  removeEventListener(nombre, funcion) {
    this.listeners.get(nombre)?.delete(funcion);
  }

  emitir(nombre) {
    for (const funcion of this.listeners.get(nombre) || []) funcion();
  }

  removeAttribute(nombre) {
    if (nombre === "src") this._src = "";
  }

  pause() {}

  load() {}

  play() {
    this.playCount += 1;
    return Promise.resolve();
  }
}

class SocketFalso {
  static ultimo = null;

  constructor() {
    SocketFalso.ultimo = this;
    this.onmessage = null;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
  }

  emitir(mensaje) {
    this.onmessage?.({ data: JSON.stringify(mensaje) });
  }
}

const nodos = {
  caja: new Nodo(),
  imagen: new Nodo(),
  video: new Nodo(),
  texto: new Nodo(),
  sonido: new Nodo(),
  aviso: new Nodo(),
};
nodos.caja.offsetHeight = 0;

const eventosVentana = new Map();
const windowFalso = {
  addEventListener(nombre, funcion) {
    eventosVentana.set(nombre, funcion);
  },
  DashMensaje: {
    aplicar() {},
    entrar() {},
    parar() {},
  },
};
const documentoFalso = {
  head: { appendChild() {} },
  createElement: () => new Nodo(),
  getElementById: (id) => nodos[id],
};
const almacenamiento = new Map();
const contexto = {
  window: windowFalso,
  document: documentoFalso,
  location: { host: "127.0.0.1:7878", search: "?t=token-de-prueba" },
  localStorage: {
    getItem: (clave) => almacenamiento.get(clave) || null,
    setItem: (clave, valor) => almacenamiento.set(clave, valor),
  },
  WebSocket: SocketFalso,
  URLSearchParams,
  requestAnimationFrame: (funcion) => setTimeout(funcion, 0),
  setTimeout,
  clearTimeout,
  console,
};

vm.createContext(contexto);
vm.runInContext(
  readFileSync(join(raiz, "apps/desktop/src-tauri/src/overlay/web/alertas.js"), "utf8"),
  contexto,
  { filename: "alertas.js" },
);

const comprobar = (condicion, texto) => {
  if (!condicion) throw new Error(texto);
};
const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

SocketFalso.ultimo.emitir({
  kind: "alerta",
  generacion: 1,
  aviso: {
    seq: 1,
    prueba: false,
    medio: "demo.gif",
    sonido: "demo.mp3",
    texto: "Alerta de prueba",
    volumen: 0.8,
    duracion_ms: 120,
    entrada_ms: 0,
    salida_ms: 0,
    animacion_entrada: "ninguna",
    animacion_salida: "ninguna",
    idle: "ninguna",
    mensaje: {},
  },
});

await esperar(30);
comprobar(
  !nodos.imagen.classList.contains("puesto"),
  "el medio no se muestra antes de emitir load",
);
comprobar(nodos.sonido.playCount === 0, "el audio no empieza antes de cargar la imagen");

nodos.imagen.complete = true;
nodos.imagen.naturalWidth = 320;
nodos.imagen.emitir("load");
await esperar(30);

comprobar(nodos.imagen.classList.contains("puesto"), "la imagen se muestra despues de load");
comprobar(nodos.sonido.playCount === 1, "el audio empieza con el medio listo");
comprobar(nodos.caja.classList.contains("visible"), "la caja se muestra con el medio listo");

console.log("ok: el overlay espera la carga del medio antes de iniciar audio y duracion");
