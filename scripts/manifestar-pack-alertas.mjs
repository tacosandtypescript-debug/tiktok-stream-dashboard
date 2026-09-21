// Genera el inventario verificable del pack versionado de Alertas.
//
// El manifiesto forma parte del recurso que se revisa en Git: no lo consume la
// aplicación para servir medios, pero deja registrado el camino relativo, el
// tipo, el tamaño y el hash de cada byte que se publica.
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const pack = join(aqui, "..", "apps", "desktop", "src-tauri", "alertas-pack");
const destino = join(pack, "manifest.json");

async function archivosEn(directorio) {
  const entradas = await readdir(directorio, { withFileTypes: true });
  const archivos = [];
  for (const entrada of entradas) {
    const ruta = join(directorio, entrada.name);
    if (entrada.isDirectory()) archivos.push(...(await archivosEn(ruta)));
    else if (entrada.isFile()) archivos.push(ruta);
  }
  return archivos;
}

const archivos = (await archivosEn(pack))
  .filter((ruta) => ruta !== destino)
  .sort((a, b) => relative(pack, a).localeCompare(relative(pack, b), "en"));

const files = [];
for (const ruta of archivos) {
  const bytes = await readFile(ruta);
  const informacion = await stat(ruta);
  const extension = ruta.includes(".") ? ruta.slice(ruta.lastIndexOf(".") + 1).toLowerCase() : "";
  files.push({
    path: relative(pack, ruta).split(sep).join("/"),
    extension,
    bytes: informacion.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const counts = files.reduce(
  (acumulado, archivo) => {
    acumulado[archivo.extension] = (acumulado[archivo.extension] ?? 0) + 1;
    acumulado.bytes += archivo.bytes;
    return acumulado;
  },
  { bytes: 0 },
);

const manifiesto = {
  version: 1,
  generated_by: "scripts/manifestar-pack-alertas.mjs",
  files,
  counts,
};

await writeFile(destino, `${JSON.stringify(manifiesto, null, 2)}\n`, "utf8");
console.log(`Manifestado ${files.length} archivos (${counts.bytes} bytes) en ${destino}`);
