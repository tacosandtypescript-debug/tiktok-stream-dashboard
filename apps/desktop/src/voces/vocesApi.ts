//! La puerta de la biblioteca al motor.
//!
//! Todo lo que la biblioteca le pide a Rust pasa por aqui, y **nada de esto habla
//! con Fish por su cuenta**: quien tiene las claves, el relevo y la cache es el
//! motor. Aqui solo se envuelven las llamadas y se traducen sus errores a algo que
//! se pueda enseñar, porque un `Error` de JavaScript en una tarjeta no dice nada.

import { api, type TtsFiltrosVoces, type TtsPaginaVoces, type TtsStatus, type TtsVozFish } from "../api";

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
  buscar: (filtros: TtsFiltrosVoces): Promise<TtsPaginaVoces> =>
    pedir(() => api.ttsVocesBuscar(filtros)),

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
