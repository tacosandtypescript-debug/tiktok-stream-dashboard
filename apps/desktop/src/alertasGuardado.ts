/**
 * Cola de guardados que conserva un objeto completo en el motor.
 *
 * La interfaz recibe cambios funcionales, no objetos construidos durante un
 * render. Cada cambio se evalua cuando le toca salir y parte de la ultima
 * confirmacion del motor. Asi se pueden pulsar dos avisos seguidos sin que el
 * segundo vuelva a mandar una foto vieja de toda la configuracion.
 */
export type Actualizar<T> = (actual: T) => T;

export interface ColaDeGuardados<T> {
  /** Sincroniza la base confirmada cuando llega una foto externa. */
  sincronizar(confirmado: T): void;
  /** Encola un cambio y devuelve su confirmacion. */
  encolar(actualizar: Actualizar<T>, guardar: (siguiente: T) => Promise<T>): Promise<T>;
  /** Indica si queda algun guardado local por confirmar. */
  hayPendientes(): boolean;
}

export function crearColaDeGuardados<T>(inicial: T): ColaDeGuardados<T> {
  let confirmado = inicial;
  let cola: Promise<unknown> = Promise.resolve();
  let pendientes = 0;

  return {
    sincronizar(nuevo) {
      // Mientras haya una escritura local, una foto de un polling puede ser
      // anterior a ella. No se permite que esa foto haga retroceder la base que
      // usara el siguiente guardado.
      if (pendientes === 0) confirmado = nuevo;
    },

    encolar(actualizar, guardar) {
      pendientes += 1;
      const trabajo = cola.then(async () => {
        const siguiente = actualizar(confirmado);
        try {
          const respuesta = await guardar(siguiente);
          confirmado = respuesta;
          return respuesta;
        } finally {
          pendientes -= 1;
        }
      });

      // Un fallo no debe atascar los guardados posteriores. El trabajo que
      // llama al motor conserva el rechazo para mostrar el error a la interfaz;
      // esta rama solo mantiene viva la cadena interna.
      cola = trabajo.then(
        () => undefined,
        () => undefined,
      );
      return trabajo;
    },

    hayPendientes() {
      return pendientes > 0;
    },
  };
}
