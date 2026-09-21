//! Tipos y reglas de la biblioteca de voces.
//!
//! Aqui vive lo que se puede decidir **sin pintar nada**: como se llama una voz,
//! como se ordena la lista, que idiomas existen de verdad y como se arma la
//! direccion de una portada. Son funciones puras a proposito: son las que tienen
//! reglas (el nombre propio manda, las favoritas van primero) y las que conviene
//! poder leer de un vistazo.

import type { TtsMuestraVoz, TtsVozFish, TtsVozGuardada } from "../api";

/**
 * Una voz guardada con todos sus campos puestos.
 *
 * Guardar una voz desde sitios distintos —el catalogo, el importador, el catalogo
 * de Edge— no puede depender de que quien la cree se acuerde de los trece campos.
 * Lo que no se sabe se deja vacio, que es la verdad: una voz de Edge no tiene
 * portada ni autor, y una de Fish recien guardada no tiene descripcion hasta que
 * el catalogo la devuelva.
 */
export function vozGuardada(
  parcial: Pick<TtsVozGuardada, "referencia" | "proveedor"> & Partial<TtsVozGuardada>,
): TtsVozGuardada {
  return {
    nombre: "",
    titulo_original: "",
    idioma: "",
    descripcion: "",
    favorito: false,
    portada: "",
    autor: "",
    autor_id: "",
    autor_avatar: "",
    tags: [],
    muestras: [],
    actualizado_en: "",
    ...parcial,
  };
}

/**
 * El nombre que se enseña.
 *
 * Manda el del streamer y, si no ha puesto ninguno, el del catalogo. Y si
 * tampoco lo hay —una voz pegada a mano por su identificador— se enseña el
 * identificador, que es feo pero es lo unico cierto que se sabe de ella.
 */
export function nombreDeVoz(voz: {
  nombre?: string;
  titulo_original?: string;
  referencia: string;
}): string {
  const propio = (voz.nombre ?? "").trim();
  if (propio) return propio;
  const original = (voz.titulo_original ?? "").trim();
  if (original) return original;
  return voz.referencia;
}

/** El rotulo de debajo del nombre: idioma y de donde salio. */
export function rotuloDeVoz(voz: TtsVozGuardada, nombreDelMotor: string): string {
  const idioma = idiomaLegible(voz.idioma);
  return [idioma, nombreDelMotor].filter(Boolean).join(" · ");
}

/** Los idiomas que habla una voz del catalogo, legibles y juntos. */
export function idiomasDeVoz(voz: TtsVozFish): string {
  return voz.idiomas.map(idiomaLegible).filter(Boolean).join(" · ");
}

/**
 * Un codigo de idioma, en palabras.
 *
 * Se traducen los que Fish usa de verdad y cualquier otro se enseña **tal cual en
 * mayusculas**: inventarse un nombre para un codigo que no se conoce seria peor
 * que enseñar el codigo.
 */
export function idiomaLegible(codigo: string): string {
  const limpio = (codigo ?? "").trim().toLowerCase();
  if (!limpio) return "";
  // La API puede mandar `es-ES` o `pt-BR`: para el rotulo sobra el pais.
  const base = limpio.split(/[-_]/)[0];
  const nombres: Record<string, string> = {
    es: "Español",
    en: "Inglés",
    pt: "Portugués",
    fr: "Francés",
    de: "Alemán",
    it: "Italiano",
    ru: "Ruso",
    zh: "Chino",
    ja: "Japonés",
    ko: "Coreano",
    ar: "Árabe",
    hi: "Hindi",
    nl: "Neerlandés",
    pl: "Polaco",
    tr: "Turco",
    vi: "Vietnamita",
    id: "Indonesio",
    th: "Tailandés",
    uk: "Ucraniano",
    sv: "Sueco",
  };
  return nombres[base] ?? base.toUpperCase();
}

/**
 * Los idiomas que **existen** en una lista de voces.
 *
 * Es lo que llena el filtro: ofrecer un idioma que no tiene ninguna voz seria
 * ofrecer una busqueda que no devuelve nada. Se sacan de lo cargado, sin inventar
 * una lista de codigos.
 */
export function idiomasDisponibles(voces: TtsVozGuardada[]): string[] {
  const vistos = new Map<string, string>();
  for (const voz of voces) {
    const base = (voz.idioma ?? "").trim().toLowerCase().split(/[-_]/)[0];
    if (base && !vistos.has(base)) vistos.set(base, idiomaLegible(base));
  }
  return [...vistos.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "es"))
    .map(([codigo]) => codigo);
}

/**
 * La lista como se enseña: **favoritas primero** y, dentro de cada grupo, el
 * orden que ya tenia (la ultima guardada arriba).
 *
 * `Array.prototype.sort` es estable desde ES2019, asi que las favoritas suben sin
 * desordenar lo demas.
 */
export function ordenarVoces(voces: TtsVozGuardada[]): TtsVozGuardada[] {
  return [...voces].sort((a, b) => Number(b.favorito) - Number(a.favorito));
}

/** Las voces que pasan el filtro de idioma y el de favoritas. */
export function filtrarVoces(
  voces: TtsVozGuardada[],
  filtro: { idioma: string; soloFavoritas: boolean },
): TtsVozGuardada[] {
  return voces.filter((voz) => {
    if (filtro.soloFavoritas && !voz.favorito) return false;
    if (!filtro.idioma) return true;
    const base = (voz.idioma ?? "").trim().toLowerCase().split(/[-_]/)[0];
    return base === filtro.idioma;
  });
}

/**
 * La direccion de una portada cacheada, dentro del servidor de overlays.
 *
 * Se arma desde la del Browser Source, que ya trae el token: las portadas las
 * sirve el mismo servidor y con la misma credencial, asi que no hay una segunda
 * direccion que mantener. Sin direccion no hay imagen y la tarjeta se queda con su
 * placeholder.
 */
export function urlPortada(
  urlOverlay: string | undefined,
  archivo: string,
): string | undefined {
  const nombre = (archivo ?? "").trim();
  if (!urlOverlay || !nombre) return undefined;
  try {
    const base = new URL(urlOverlay);
    const token = base.searchParams.get("t") ?? "";
    return `${base.origin}/voces/portada/${encodeURIComponent(nombre)}?t=${encodeURIComponent(token)}`;
  } catch {
    return undefined;
  }
}

/** La direccion de una prueba sintetizada, servida por el mismo servidor. */
export function urlPrueba(
  urlOverlay: string | undefined,
  archivo: string,
): string | undefined {
  const nombre = (archivo ?? "").trim();
  if (!urlOverlay || !nombre) return undefined;
  try {
    const base = new URL(urlOverlay);
    const token = base.searchParams.get("t") ?? "";
    return `${base.origin}/voces/prueba/${encodeURIComponent(nombre)}?t=${encodeURIComponent(token)}`;
  } catch {
    return undefined;
  }
}

/**
 * La imagen de una voz del catalogo: su portada y, si no la hay, el avatar.
 *
 * Es el mismo orden que pide el encargo y **nunca** se inventa una direccion a
 * partir del identificador: si no hay ninguna de las dos, no hay imagen.
 */
export function imagenDeVoz(voz: TtsVozFish): string {
  const portada = (voz.portada ?? "").trim();
  if (portada) return portada;
  return (voz.autor?.avatar ?? "").trim();
}

/** Si una voz del catalogo ya se puede usar (esta entrenada). */
export function vozLista(voz: TtsVozFish): boolean {
  return !voz.estado || voz.estado === "trained";
}

/**
 * La muestra que se ofrece primero, si hay alguna.
 *
 * Las muestras sin audio se descartan al leerlas en Rust, asi que aqui basta con
 * mirar la primera.
 */
export function primeraMuestra(voz: { muestras: TtsMuestraVoz[] }): TtsMuestraVoz | null {
  return voz.muestras.length > 0 ? voz.muestras[0] : null;
}

/**
 * La clave con la que se reconoce una voz en cualquier lista.
 *
 * Lleva el proveedor delante porque dos motores pueden usar el mismo
 * identificador sin ser la misma voz —es el mismo criterio que usa el motor para
 * no duplicarlas al guardarlas—.
 */
export function claveDeVoz(voz: { proveedor: string; referencia: string }): string {
  return `${voz.proveedor}:${voz.referencia}`;
}

/**
 * Si una voz guardada es de Fish Audio.
 *
 * El proveedor de Fish tiene **dos formas** en el repositorio y las dos son
 * legitimas: el catalogo guarda `fish-audio` —que es el `PROVIDER_ID` de Rust— y
 * el motor se llama `fish`. Comparar con una sola de las dos fue un fallo real:
 * una voz guardada desde el catalogo no se reconocia como de Fish, su codigo se
 * escribia en «Voz en español» y, con la voz de siempre puesta, el sidecar
 * respondia `ValueError: Invalid voice '8d2c17a9…'`. La comprobacion vive aqui,
 * en un solo sitio, para que no vuelva a haber dos listas que se desincronicen.
 */
export function esVozDeFish(proveedor: string): boolean {
  return proveedor === "fish" || proveedor === "fish-audio";
}

/** Si esa voz ya esta en «Mis voces». */
export function estaGuardada(
  guardadas: TtsVozGuardada[],
  voz: { proveedor: string; referencia: string },
): boolean {
  const clave = claveDeVoz(voz);
  return guardadas.some((otra) => claveDeVoz(otra) === clave);
}

/**
 * La imagen de una voz **guardada**.
 *
 * Primero la portada cacheada —que es la que funciona sin red—, y si no hay, el
 * avatar del autor. Nunca se enseña la portada remota de una voz guardada: para eso
 * se cachea al guardarla, y si no se pudo, es mejor el avatar que una imagen que
 * puede tardar o no llegar.
 */
export function imagenDeGuardada(
  voz: TtsVozGuardada,
  urlOverlay: string | undefined,
): string | undefined {
  const cacheada = urlPortada(urlOverlay, voz.portada);
  if (cacheada) return cacheada;
  return (voz.autor_avatar ?? "").trim() || undefined;
}

/**
 * Los datos de una voz guardada, con la forma que espera el detalle.
 *
 * El detalle es **el mismo** para las dos pestañas: una voz del catalogo y una
 * guardada enseñan lo mismo, y lo unico que cambia es de donde salen los datos y si
 * se puede generar una prueba. Tener dos paneles de detalle seria duplicar la
 * pantalla entera por una diferencia de tres campos.
 */
export function detalleDeGuardada(voz: TtsVozGuardada): {
  id: string;
  titulo: string;
  descripcion: string;
  portada: string;
  idiomas: string[];
  tags: string[];
  muestras: TtsMuestraVoz[];
  autor: { id: string; nombre: string; avatar: string };
  actualizado_en: string;
} {
  return {
    id: voz.referencia,
    titulo: voz.titulo_original,
    descripcion: voz.descripcion,
    // Vacio a proposito: el detalle arma la imagen con la cache y el avatar, que
    // es lo unico que se guarda de una voz guardada.
    portada: "",
    idiomas: voz.idioma ? [voz.idioma] : [],
    tags: voz.tags,
    muestras: voz.muestras,
    autor: { id: voz.autor_id, nombre: voz.autor, avatar: voz.autor_avatar },
    actualizado_en: voz.actualizado_en,
  };
}
