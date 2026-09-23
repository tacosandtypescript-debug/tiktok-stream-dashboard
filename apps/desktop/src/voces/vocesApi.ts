//! La puerta de la biblioteca al motor.
//!
//! Todo lo que la biblioteca le pide a Rust pasa por aqui, y **nada de esto habla
//! con Fish por su cuenta**: quien tiene las claves, el relevo y la cache es el
//! motor. Aqui solo se envuelven las llamadas y se traducen sus errores a algo que
//! se pueda enseñar, porque un `Error` de JavaScript en una tarjeta no dice nada.

import { api, type TtsFiltrosVoces, type TtsPaginaVoces, type TtsStatus, type TtsVozFish } from "../api.ts";

/** Cinco minutos: una pestaña reabierta no repite red, pero Fish sigue pudiendo
 * incorporar voces nuevas sin obligar a reiniciar la aplicación. */
export const TTL_CATALOGO_MS = 5 * 60 * 1000;

interface EntradaCatalogo {
  pagina: TtsPaginaVoces;
  expiraEn: number;
}

const catalogoCache = new Map<string, EntradaCatalogo>();
const catalogoEnVuelo = new Map<string, Promise<TtsPaginaVoces>>();

/**
 * La clave incluye todo lo que cambia una respuesta de Fish: filtros, pagina y
 * tamano. `undefined` y los valores de fabrica cuentan igual para que reabrir
 * la pestaña con la misma selección encuentre la entrada anterior.
 */
export function claveCatalogo(filtros: TtsFiltrosVoces): string {
  return JSON.stringify({
    buscar: filtros.buscar ?? "",
    idioma: filtros.idioma ?? "",
    tag: filtros.tag ?? "",
    autor: filtros.autor ?? "",
    propios: filtros.propios ?? false,
    pagina: filtros.pagina ?? 1,
    tamano: filtros.tamano ?? 24,
  });
}

function podarCatalogoCaducado(ahora: number): void {
  for (const [clave, entrada] of catalogoCache) {
    if (entrada.expiraEn <= ahora) catalogoCache.delete(clave);
  }
}

/** Vacía la caché; se usa al probar el contrato y queda disponible para diagnóstico. */
export function limpiarCacheCatalogo(): void {
  catalogoCache.clear();
  catalogoEnVuelo.clear();
}

/** Un fallo ya listo para enseñar. */
export class ErrorVoces extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "ErrorVoces";
  }
}

/**
 * El motivo, en texto.
 *
 * El motor ya escribe sus errores en español y con la causa —«la clave no vale
 * (401)», «no se pudo hablar con …»—, asi que lo unico que se hace aqui es
 * quitarle el ruido de `anyhow` si lo trae.
 */
function motivo(causa: unknown): string {
  const texto = String(causa);
  return texto.replace(/^Error:\s*/, "").trim();
}

async function pedir<T>(llamada: () => Promise<T>): Promise<T> {
  try {
    return await llamada();
  } catch (causa) {
    throw new ErrorVoces(motivo(causa));
  }
}

export const vocesApi = {
  /** Una pagina del catalogo de Fish. */
  buscar: (filtros: TtsFiltrosVoces): Promise<TtsPaginaVoces> => {
    const clave = claveCatalogo(filtros);
    const ahora = Date.now();
    podarCatalogoCaducado(ahora);
    const guardada = catalogoCache.get(clave);
    if (guardada && guardada.expiraEn > ahora) return Promise.resolve(guardada.pagina);

    // La pestaña puede montar dos veces durante un cambio de navegación. No
    // hacen falta dos peticiones idénticas aunque todavía no exista una entrada
    // confirmada en la caché.
    const enVuelo = catalogoEnVuelo.get(clave);
    if (enVuelo) return enVuelo;

    const solicitud = pedir(() => api.ttsVocesBuscar(filtros))
      .then((pagina) => {
        catalogoCache.set(clave, { pagina, expiraEn: Date.now() + TTL_CATALOGO_MS });
        return pagina;
      })
      .finally(() => {
        catalogoEnVuelo.delete(clave);
      });
    catalogoEnVuelo.set(clave, solicitud);
    return solicitud;
  },

  /** Una voz concreta, con sus muestras. */
  obtener: (id: string): Promise<TtsVozFish> => pedir(() => api.ttsVozObtener(id)),

  /** La guarda en «Mis voces», con su portada en la cache local. */
  guardar: (id: string, nombre?: string): Promise<TtsStatus> =>
    pedir(() => api.ttsVozGuardar(id, nombre)),

  quitar: (referencia: string): Promise<TtsStatus> => pedir(() => api.ttsVozQuitar(referencia)),

  renombrar: (referencia: string, nombre: string): Promise<TtsStatus> =>
    pedir(() => api.ttsVozRenombrar(referencia, nombre)),

  favorita: (referencia: string, favorito: boolean): Promise<TtsStatus> =>
    pedir(() => api.ttsVozFavorita(referencia, favorito)),

  actualizar: (referencia: string): Promise<TtsStatus> =>
    pedir(() => api.ttsVocesActualizar(referencia)),

  /** Genera una prueba. **Cuesta saldo**: quien la pide tiene que avisarlo. */
  probar: (referencia: string, texto?: string): Promise<string> =>
    pedir(() => api.ttsVozProbar(referencia, texto)),
};
