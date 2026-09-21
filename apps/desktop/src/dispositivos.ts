//! La lista de salidas de audio, con reintento propio.
//!
//! Por que existe: la lista se pedia **una sola vez, al montar la pantalla**, y si esa
//! consulta fallaba —o llegaba vacia porque el dispositivo de turno estaba ocupado— la
//! pantalla se quedaba sin ninguna salida hasta cerrar y volver a abrir la aplicacion.
//!
//! En el motor ya no se abre nada para enumerar (ver `tts::player`), pero el sistema
//! sigue teniendo momentos malos: unos auriculares Bluetooth a medio conectar, un cable
//! virtual que otro programa acaba de coger, un cambio de dispositivo predeterminado.
//! Que la lista se recupere sola es parte del arreglo, no un adorno.
//!
//! Se pregunta en tres momentos:
//!
//!   * al abrir la pantalla;
//!   * **mientras la lista este vacia**, con espera creciente para no martillear;
//!   * cuando la ventana vuelve a primer plano, que es justo cuando acabas de
//!     enchufar algo y volver a la aplicacion.
//!
//! Vive en un gancho y no en cada pantalla porque las dos que eligen salida —Voz y
//! Alertas— tienen el mismo problema y no tiene sentido resolverlo dos veces.

import { useCallback, useEffect, useState } from "react";

import { api } from "./api";

/**
 * Esperas entre reintentos cuando la lista sigue vacia, en milisegundos.
 *
 * Creciente y con tope: un equipo sin tarjeta de sonido no puede quedarse
 * preguntando cada segundo para siempre, y uno al que le acaban de conectar los
 * auriculares tiene que enterarse en pocos segundos.
 */
const ESPERAS = [1_000, 2_000, 4_000, 8_000, 15_000];

export interface DispositivosDeAudio {
  /** Los nombres disponibles, en el orden que da el sistema. */
  dispositivos: string[];
  /** El motivo del ultimo fallo, si lo hubo. `null` cuando la ultima consulta fue bien. */
  error: string | null;
  /** Vuelve a preguntar ahora mismo. */
  recargar: () => void;
}

export function useDispositivosDeAudio(): DispositivosDeAudio {
  const [dispositivos, setDispositivos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * Cuantas veces se ha preguntado.
   *
   * Es la palanca del reintento: al cambiar, el efecto vuelve a preguntar. Se cuenta
   * en vez de guardar un temporizador porque el efecto ya sabe limpiarlo al desmontar.
   */
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let activo = true;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const espera = ESPERAS[Math.min(intento, ESPERAS.length - 1)];

    const reintentar = () => {
      // Vacia **no** es «este equipo no tiene salidas»: es un momento malo del
      // sistema, y por eso se vuelve a preguntar en vez de darse por vencido.
      reloj = setTimeout(() => setIntento((n) => n + 1), espera);
    };

    void api
      .ttsDevices()
      .then((lista) => {
        if (!activo) return;
        // Se comprueba que sea una lista y no se da por hecho: si el motor contesta
        // otra cosa, `dispositivos.map` reventaria la pantalla entera. Un desplegable
        // vacio es un problema; una pantalla en blanco es otro mucho peor.
        const buena = Array.isArray(lista) ? lista : [];
        setDispositivos(buena);
        setError(null);
        if (buena.length === 0) reintentar();
      })
      .catch((cause: unknown) => {
        if (!activo) return;
        setError(String(cause));
        reintentar();
      });

    return () => {
      activo = false;
      if (reloj) clearTimeout(reloj);
    };
  }, [intento]);

  const recargar = useCallback(() => setIntento((n) => n + 1), []);

  useEffect(() => {
    const alVolver = () => recargar();
    window.addEventListener("focus", alVolver);
    return () => window.removeEventListener("focus", alVolver);
  }, [recargar]);

  return { dispositivos, error, recargar };
}
