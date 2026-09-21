/* Los estilos del contenedor del mensaje.
 *
 * Un preset **no es un componente**: es lo que un puñado de numeros no puede decir. Los
 * colores, el radio, el relleno, la sombra y el resplandor ya viajan en los ajustes —el
 * editor escribe los valores sugeridos del preset al elegirlo, igual que hace con los
 * efectos de permanencia—, asi que aqui solo vive lo que no cabe en un campo:
 *
 *   - el **degradado**, que necesita los dos colores en un `linear-gradient`;
 *   - las **decoraciones**: la barra lateral, las puntas de la cinta y la linea del
 *     estilo minimo, que van en un pseudo-elemento y no en un valor;
 *   - el **ancho completo** de la barra inferior y la cinta, que es una decision de
 *     colocacion y no un numero.
 *
 * La lista de identificadores es el **contrato**: los mismos que `ESTILOS_MENSAJE` en
 * `alerts/mensaje.rs`, y hay un test que compara las dos listas.
 */
(() => {
  const { rgba } = window.DashMensajeConfig;

  /**
   * Cada estilo, con lo que añade.
   *
   * `variables(m)` devuelve variables de CSS que **pisan** las que arma el renderer con
   * los ajustes; `atributos` se escriben en el propio elemento y son los ganchos que usa
   * `estilos.css` para las decoraciones.
   */
  const ESTILOS = {
    /** El de siempre: solo los ajustes. */
    default: {},

    /** Capsula: el radio de los ajustes, y el navegador lo recorta a media altura. */
    pill: {},

    /** Tarjeta solida: fondo, borde, radio y sombra, todo de los ajustes. */
    card: {},

    /** Cristal: el `backdrop-filter` sale del ajuste de difuminado, en la hoja. */
    glass: {},

    /** Contorno: fondo transparente y borde visible, de los ajustes. */
    outline: {},

    /** Resplandor de fuera: el `glow` de los ajustes. */
    glow: {},

    /** Neón: la hoja enciende la letra con el color del resplandor. */
    neon: {},

    /** Degradado: los dos colores, en diagonal. */
    gradient: {
      variables: (m) => ({
        "--mensaje-fondo": `linear-gradient(135deg, ${rgba(m.fondo, m.fondo_opacidad)}, ${rgba(
          m.fondo_2,
          m.fondo_opacidad,
        )})`,
      }),
    },

    /** Minimo: casi solo texto, con una linea de acento debajo. */
    minimal: {
      atributos: { "data-deco": "linea" },
    },

    /** Barra inferior: ocupa el ancho entero del lienzo. */
    barra: {
      atributos: { "data-ancho": "completo" },
    },

    /** Acento lateral: una barra de color pegada al borde de la izquierda. */
    lateral: {
      atributos: { "data-deco": "lateral" },
    },

    /** Etiqueta flotante: separada del medio por el ajuste de separacion, con sombra. */
    flotante: {},

    /** Cinta: con las dos puntas dobladas por detras. */
    cinta: {
      atributos: { "data-deco": "cinta" },
    },

    /** Distintivo: una etiqueta pequeña, con su relleno y su letra de los ajustes. */
    etiqueta: {},

    /** Sombra suave: la sombra, mas larga y mas difusa, la saca la hoja del ajuste. */
    sombra: {},
  };

  /** Lo que hay que escribir en el elemento para el estilo elegido. */
  function receta(estilo) {
    return ESTILOS[estilo] || ESTILOS.default;
  }

  window.DashMensajePresets = { ESTILOS, receta };
})();
