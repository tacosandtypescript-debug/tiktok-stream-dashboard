// Servidor de desarrollo del prototipo. Sin dependencias: `node servidor.mjs`.
//
// Por qué un servidor y no abrir el archivo con doble clic: el prototipo usa
// módulos ES (`<script type="module">`), y con `file://` el navegador los bloquea
// por política de origen. Además así se puede recargar sin recompilar nada.
//
// No hay compilación, ni empaquetado, ni build de producción: se sirven los mismos
// archivos que se editan.
//
// Orden 05: además de los archivos, el servidor guarda la **configuración de regalos**
// en `datos/regalos.json`. Es un archivo del prototipo, no la base de datos de la
// aplicación: se escribe al guardar desde el taller y se lee al arrancar, así que al
// reiniciar el servidor los regalos configurados siguen ahí.

import { createServer } from "node:http";
import { readFile, stat, rename, mkdir, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizarEvento, Deduplicador } from "./js/tiktok.js";

const RAIZ = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ARCHIVO_REGLAS = resolve(RAIZ, "datos/regalos.json");
const ARCHIVO_USUARIOS = resolve(RAIZ, "datos/usuarios.json");
const CARPETA_AVATARES = resolve(RAIZ, "datos/avatares");
const LIMITE_CUERPO = 512 * 1024; // 512 KB: una tabla de regalos no llega ni de lejos
const LIMITE_AVATAR = 2 * 1024 * 1024; // 2 MB: una foto de perfil no pasa de ahí

/**
 * Puente de eventos de TikTok (orden 06).
 *
 * El motor de la aplicación ya tiene su proveedor nativo y publica los eventos por
 * WebSocket en `ws://127.0.0.1:8790/api/eventos`. Este servidor **no abre ninguna
 * conexión con TikTok**: sólo acepta por HTTP los eventos que le empuje cualquier
 * listener autorizado (el propio motor, un script, o el taller en modo prueba) y los
 * deja en una cola para que el prototipo los recoja. Así hay un único camino de
 * ingesta y el motor del juego nunca depende del proveedor.
 */
const COLA_EVENTOS = [];
const LIMITE_COLA = 500;
const deduplicadorServidor = new Deduplicador();
let ingesta = { recibidos: 0, encolados: 0, duplicados: 0, descartados: 0, ultimo: null };

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function leerArgumento(nombre, porDefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return porDefecto;
}

const PUERTO = Number(leerArgumento("puerto", process.env.PUERTO ?? 8123));
const HOST = leerArgumento("host", "127.0.0.1");

/** Lee el cuerpo de una petición con tope de tamaño. */
function leerCuerpo(peticion) {
  return new Promise((ok, mal) => {
    let datos = "";
    peticion.on("data", (trozo) => {
      datos += trozo;
      if (datos.length > LIMITE_CUERPO) {
        mal(new Error("el cuerpo es demasiado grande"));
        peticion.destroy();
      }
    });
    peticion.on("end", () => ok(datos));
    peticion.on("error", mal);
  });
}

/** Responde JSON. */
function responderJson(respuesta, codigo, objeto) {
  const texto = JSON.stringify(objeto, null, 2);
  respuesta.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, must-revalidate",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  });
  respuesta.end(texto);
}

/**
 * Configuración de regalos: se lee del archivo y, si no existe, se responde 404 con
 * `existe: false` para que el taller sepa que tiene que usar los valores de ejemplo.
 */
async function leerRegalos(respuesta) {
  try {
    const texto = await readFile(ARCHIVO_REGLAS, "utf8");
    const datos = JSON.parse(texto);
    responderJson(respuesta, 200, { ok: true, existe: true, ...datos });
  } catch {
    responderJson(respuesta, 200, { ok: true, existe: false });
  }
}

/** Guarda la configuración de regalos: escritura atómica (tmp + rename). */
async function guardarRegalos(peticion, respuesta) {
  try {
    const texto = await leerCuerpo(peticion);
    const datos = JSON.parse(texto);
    if (!datos || !Array.isArray(datos.regalos)) {
      responderJson(respuesta, 400, { ok: false, error: "faltan los regalos" });
      return;
    }
    await mkdir(resolve(RAIZ, "datos"), { recursive: true });
    const temporal = `${ARCHIVO_REGLAS}.tmp`;
    await writeFile(temporal, JSON.stringify(datos, null, 2), "utf8");
    await rename(temporal, ARCHIVO_REGLAS);
    responderJson(respuesta, 200, { ok: true, guardado: datos.regalos.length, archivo: "datos/regalos.json" });
  } catch (error) {
    responderJson(respuesta, 400, { ok: false, error: String(error.message ?? error) });
  }
}

/** Registro de usuarios de TikTok: identidades reconocidas entre reinicios. */
async function leerUsuarios(respuesta) {
  try {
    const texto = await readFile(ARCHIVO_USUARIOS, "utf8");
    responderJson(respuesta, 200, { ok: true, existe: true, ...JSON.parse(texto) });
  } catch {
    responderJson(respuesta, 200, { ok: true, existe: false, usuarios: [], cola: [] });
  }
}

async function guardarUsuarios(peticion, respuesta) {
  try {
    const datos = JSON.parse(await leerCuerpo(peticion));
    if (!datos || !Array.isArray(datos.usuarios)) {
      responderJson(respuesta, 400, { ok: false, error: "faltan los usuarios" });
      return;
    }
    await mkdir(resolve(RAIZ, "datos"), { recursive: true });
    const temporal = `${ARCHIVO_USUARIOS}.tmp`;
    await writeFile(temporal, JSON.stringify(datos, null, 2), "utf8");
    await rename(temporal, ARCHIVO_USUARIOS);
    responderJson(respuesta, 200, { ok: true, guardado: datos.usuarios.length, archivo: "datos/usuarios.json" });
  } catch (error) {
    responderJson(respuesta, 400, { ok: false, error: String(error.message ?? error) });
  }
}

/**
 * Ingesta de un evento de TikTok.
 *
 * Acepta el sobre del motor (protocolo 1) y también un formato plano equivalente, y lo
 * normaliza con **el mismo módulo** que usa el navegador. Si el evento está repetido no
 * se encola: la idempotencia empieza aquí.
 */
async function ingestarEvento(peticion, respuesta) {
  try {
    const crudo = JSON.parse(await leerCuerpo(peticion));
    ingesta.recibidos += 1;
    const evento = normalizarEvento(crudo);
    if (!evento) {
      ingesta.descartados += 1;
      responderJson(respuesta, 202, { ok: false, descartado: true, motivo: "no es un regalo atribuible a un usuario" });
      return;
    }
    if (deduplicadorServidor.repetido(evento.eventId)) {
      ingesta.duplicados += 1;
      responderJson(respuesta, 200, { ok: true, duplicado: true, eventId: evento.eventId });
      return;
    }
    const conOrigen = { ...evento, origen: crudo.__origen ?? "ingesta" };
    COLA_EVENTOS.push(conOrigen);
    if (COLA_EVENTOS.length > LIMITE_COLA) COLA_EVENTOS.splice(0, COLA_EVENTOS.length - LIMITE_COLA);
    ingesta.encolados += 1;
    ingesta.ultimo = { eventId: evento.eventId, giftName: evento.giftName, displayName: evento.displayName, cuando: Date.now() };
    responderJson(respuesta, 200, { ok: true, evento: conOrigen, encolados: COLA_EVENTOS.length });
  } catch (error) {
    responderJson(respuesta, 400, { ok: false, error: String(error.message ?? error) });
  }
}

/** Lo que ha llegado desde un índice (lo consume el prototipo). */
function leerEventos(url, respuesta) {
  const desde = Math.max(0, Number(url.searchParams.get("desde")) || 0);
  const eventos = COLA_EVENTOS.slice(desde);
  responderJson(respuesta, 200, {
    ok: true,
    total: COLA_EVENTOS.length,
    desde,
    eventos,
    ingesta: { ...ingesta, duplicados: deduplicadorServidor.duplicados, cola: COLA_EVENTOS.length },
  });
}

/**
 * Proxy de avatares.
 *
 * El lienzo no puede pintar una imagen de otro dominio sin «ensuciarlo» (y entonces
 * `toDataURL` falla, que es lo que usan las capturas y el OBS). Aquí se pide desde el
 * servidor del prototipo y se sirve desde el mismo origen. Sólo se aceptan hosts de
 * TikTok y hay tope de tamaño; la URL se guarda **hasheada**, no en claro, y no se
 * apunta en ningún registro.
 */
const HOSTS_AVATAR = ["tiktokcdn.com", "tiktokcdn-us.com", "tiktok.com", "ibytedtos.com", "byteoversea.com", "muscdn.com"];

function hostPermitido(url) {
  try {
    const destino = new URL(url);
    if (destino.protocol !== "https:") return false;
    return HOSTS_AVATAR.some((h) => destino.hostname === h || destino.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function servirAvatar(url, respuesta) {
  const pedida = url.searchParams.get("u") ?? "";
  if (!pedida || !hostPermitido(pedida)) {
    respuesta.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    respuesta.end("avatar no permitido");
    return;
  }
  const huella = createHash("sha256").update(pedida).digest("hex").slice(0, 32);
  const cache = resolve(CARPETA_AVATARES, `${huella}.bin`);
  try {
    const guardado = await readFile(cache);
    respuesta.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
    respuesta.end(guardado);
    return;
  } catch {
    /* no estaba en caché: se pide */
  }
  try {
    const remota = await fetch(pedida, { signal: AbortSignal.timeout(6000) });
    if (!remota.ok) throw new Error(`el CDN contestó ${remota.status}`);
    const tipo = remota.headers.get("content-type") ?? "image/jpeg";
    const datos = Buffer.from(await remota.arrayBuffer());
    if (datos.length > LIMITE_AVATAR) throw new Error("el avatar es demasiado grande");
    await mkdir(CARPETA_AVATARES, { recursive: true });
    await writeFile(cache, datos).catch(() => {});
    respuesta.writeHead(200, { "Content-Type": tipo, "Cache-Control": "max-age=3600" });
    respuesta.end(datos);
  } catch (error) {
    // Nunca se registra la URL: lleva parámetros firmados.
    respuesta.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    respuesta.end(`no se pudo traer el avatar: ${String(error.message ?? error)}`);
  }
}

const servidor = createServer(async (peticion, respuesta) => {
  const url = new URL(peticion.url, `http://${peticion.headers.host ?? HOST}`);

  // --- API del prototipo
  if (url.pathname === "/api/regalos") {
    if (peticion.method === "OPTIONS") {
      responderJson(respuesta, 204, {});
      return;
    }
    if (peticion.method === "GET") {
      await leerRegalos(respuesta);
      return;
    }
    if (peticion.method === "POST") {
      await guardarRegalos(peticion, respuesta);
      return;
    }
    responderJson(respuesta, 405, { ok: false, error: "método no permitido" });
    return;
  }

  // --- eventos de TikTok (orden 06): ingesta y cola para el prototipo
  if (url.pathname === "/api/tiktok/evento") {
    if (peticion.method === "POST") {
      await ingestarEvento(peticion, respuesta);
      return;
    }
    responderJson(respuesta, 405, { ok: false, error: "usa POST" });
    return;
  }
  if (url.pathname === "/api/tiktok/eventos") {
    leerEventos(url, respuesta);
    return;
  }
  if (url.pathname === "/api/tiktok/estado") {
    responderJson(respuesta, 200, {
      ok: true,
      // El bus del motor se escucha desde el navegador; aquí sólo se informa de dónde.
      bus: `ws://127.0.0.1:${process.env.TTSDASH_WEB_PORT ?? 8790}/api/eventos`,
      ingesta: { ...ingesta, duplicados: deduplicadorServidor.duplicados, cola: COLA_EVENTOS.length },
    });
    return;
  }

  // --- identidades de los espectadores
  if (url.pathname === "/api/usuarios") {
    if (peticion.method === "GET") {
      await leerUsuarios(respuesta);
      return;
    }
    if (peticion.method === "POST") {
      await guardarUsuarios(peticion, respuesta);
      return;
    }
    responderJson(respuesta, 405, { ok: false, error: "método no permitido" });
    return;
  }

  // --- avatares (mismo origen, para que el lienzo no se ensucie)
  if (url.pathname === "/api/avatar") {
    await servirAvatar(url, respuesta);
    return;
  }

  // --- archivos
  let ruta = decodeURIComponent(url.pathname);
  if (ruta.endsWith("/")) ruta += "index.html";

  // Nadie sale de la carpeta del prototipo.
  const destino = normalize(join(RAIZ, ruta));
  if (!destino.startsWith(RAIZ)) {
    respuesta.writeHead(403).end("fuera de la carpeta del prototipo");
    return;
  }

  try {
    let archivo = destino;
    const info = await stat(archivo).catch(() => null);
    if (info?.isDirectory()) archivo = join(archivo, "index.html");
    const contenido = await readFile(archivo);
    respuesta.writeHead(200, {
      "Content-Type": TIPOS[extname(archivo).toLowerCase()] ?? "application/octet-stream",
      // Sin caché: se está revisando, cada recarga tiene que traer lo último.
      "Cache-Control": "no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    });
    respuesta.end(contenido);
  } catch {
    respuesta.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    respuesta.end(`no existe: ${ruta}`);
  }
});

servidor.listen(PUERTO, HOST, () => {
  const base = `http://${HOST}:${PUERTO}/`;
  console.log("Arena de trompos · prototipo");
  console.log(`  taller    ${base}`);
  console.log(`  limpio    ${base}?limpio=1        (sólo el lienzo, para OBS)`);
  console.log(`  depuración ${base}?verLimites=1&verRadios=1&calidad=0.6`);
  console.log(`  regalos   ${base}api/regalos      (configuración guardada en datos/regalos.json)`);
  console.log("  Ctrl+C para parar");
});

process.on("SIGINT", () => {
  servidor.close(() => process.exit(0));
});
