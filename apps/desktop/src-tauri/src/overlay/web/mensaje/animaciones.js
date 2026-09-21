/* Las animaciones del contenedor del mensaje.
 *
 * Son **solo del contenedor**: la alerta entera tiene las suyas en `alertas.js` y no se
 * tocan. Aqui no hay ninguna animacion de la caja del aviso.
 *
 * Cada animacion devuelve los fotogramas que hay que ponerle al elemento, y el renderer
 * los lanza con la API de animaciones del navegador. Se hace asi y no con `@keyframes`
 * generados —como la permanencia de la alerta— por una razon: estas animaciones son de
 * **una sola vez** y llevan su retardo, su duracion y su ritmo en la propia llamada, sin
 * tener que escribir una hoja por combinacion ni limpiarla despues.
 *
 * Lo que **no** se hace aqui, a proposito: tocar `transform` de la caja del aviso. El
 * contenedor es un hijo, asi que su `transform` es suyo y no se pelea con el de la
 * entrada ni con el de la permanencia de la alerta.
 *
 * Rendimiento: se animan `opacity`, `transform`, `clip-path` y `filter`. Nada de
 * `width`, `height` ni `margin`, que obligarian a recalcular la pagina en cada
 * fotograma —y esto corre dentro de un Browser Source de OBS, que es un renderizador
 * mas—.
 */
(() => {
  /** Cuanto se mueve una animacion con la intensidad al 100 %, en pixeles. */
  const MOVIMIENTO = 46;

  const desplazamiento = (m) => Math.round((MOVIMIENTO * m.intensidad) / 100);

  /**
   * Las animaciones de entrada.
   *
   * Cada una devuelve los fotogramas, o `null` si no hay nada que animar. El ultimo
   * fotograma es **siempre el estado natural** del elemento: asi, cuando la animacion
   * termina, lo que queda es lo que dice la hoja de estilos y no un fotograma pegado.
   */
  const ENTRADAS = {
    ninguna: null,

    fundido: () => [{ opacity: 0 }, { opacity: 1 }],

    subir: (m) => [
      { opacity: 0, transform: `translateY(${desplazamiento(m)}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],

    bajar: (m) => [
      { opacity: 0, transform: `translateY(-${desplazamiento(m)}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],

    izquierda: (m) => [
      { opacity: 0, transform: `translateX(-${desplazamiento(m)}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ],

    derecha: (m) => [
      { opacity: 0, transform: `translateX(${desplazamiento(m)}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ],

    /** Un zoom pequeño que se pasa un poco y vuelve. */
    pop: () => [
      { opacity: 0, transform: "scale(0.55)" },
      { opacity: 1, transform: "scale(1.09)", offset: 0.62 },
      { opacity: 1, transform: "scale(1)" },
    ],

    escala: () => [
      { opacity: 0, transform: "scale(0.86)" },
      { opacity: 1, transform: "scale(1)" },
    ],

    /** Rebote de verdad: se pasa de largo dos veces, cada una mas pequeña. */
    rebote: () => [
      { opacity: 0, transform: "scale(0.45)" },
      { opacity: 1, transform: "scale(1.14)", offset: 0.55 },
      { opacity: 1, transform: "scale(0.96)", offset: 0.78 },
      { opacity: 1, transform: "scale(1)" },
    ],

    /** Se abre desde el centro hacia los lados. */
    abrir_horizontal: () => [
      { clipPath: "inset(0 50% 0 50%)", opacity: 0.2 },
      { clipPath: "inset(0 0 0 0)", opacity: 1 },
    ],

    /** Se despliega de arriba abajo. */
    abrir_vertical: () => [
      { clipPath: "inset(0 0 100% 0)", opacity: 0.2 },
      { clipPath: "inset(0 0 0 0)", opacity: 1 },
    ],

    /** Se descubre de izquierda a derecha. */
    revelar: () => [
      { clipPath: "inset(0 100% 0 0)", opacity: 0.2 },
      { clipPath: "inset(0 0 0 0)", opacity: 1 },
    ],

    /** Se abre desde el centro, en las dos direcciones. */
    revelar_centro: () => [
      { clipPath: "inset(45% 45% 45% 45%)", opacity: 0.15 },
      { clipPath: "inset(0 0 0 0)", opacity: 1 },
    ],

    desenfoque: (m) => [
      { opacity: 0, filter: `blur(${Math.round(4 + (m.intensidad * 14) / 100)}px)` },
      { opacity: 1, filter: "blur(0px)" },
    ],

    /** Un destello: se enciende de mas y se apaga hasta su sitio. */
    destello: () => [
      { opacity: 0, filter: "brightness(2.8) blur(4px)", transform: "scale(1.03)" },
      { opacity: 1, filter: "brightness(1) blur(0px)", transform: "scale(1)" },
    ],

    /** Elastico: se estira y se aprieta antes de quedarse. */
    elastico: () => [
      { opacity: 0, transform: "scale(0.72, 0.9)" },
      { opacity: 1, transform: "scale(1.06, 0.96)", offset: 0.5 },
      { opacity: 1, transform: "scale(0.98, 1.02)", offset: 0.76 },
      { opacity: 1, transform: "scale(1)" },
    ],

    /** Cae unos pixeles hasta su sitio. */
    caer: (m) => [
      { opacity: 0, transform: `translateY(-${Math.round(desplazamiento(m) * 1.4)}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
  };

  /**
   * Lo que hace el contenedor **mientras esta en pantalla**.
   *
   * Se repiten, y son mas suaves que las de la alerta a proposito: la alerta ya se esta
   * moviendo, y dos cosas con la misma fuerza a la vez se ven como un temblor.
   *
   * `capa` dice a quien se le pone la animacion: al contenedor (`caja`) o a la franja
   * del brillo (`brillo`), que es un elemento aparte.
   */
  const PERMANENCIAS = {
    ninguna: null,

    flotar: (m) => ({
      capa: "caja",
      fotogramas: [
        { transform: "translateY(0)" },
        { transform: `translateY(-${Math.round(3 + (m.intensidad * 0.07))}px)`, offset: 0.5 },
        { transform: "translateY(0)" },
      ],
      opciones: { easing: "ease-in-out" },
    }),

    pulso: (m) => ({
      capa: "caja",
      fotogramas: [
        { transform: "scale(1)" },
        { transform: `scale(${(1 + (m.intensidad * 0.035) / 100).toFixed(3)})`, offset: 0.5 },
        { transform: "scale(1)" },
      ],
      opciones: { easing: "ease-in-out" },
    }),

    /** Un latido de luz: se enciende y se apaga. */
    pulso_brillo: (m) => ({
      capa: "caja",
      fotogramas: [
        { filter: `drop-shadow(0 0 0 ${m.glow_color})` },
        {
          filter: `drop-shadow(0 0 ${Math.round(4 + (m.intensidad * 0.18))}px ${m.glow_color})`,
          offset: 0.5,
        },
        { filter: `drop-shadow(0 0 0 ${m.glow_color})` },
      ],
      opciones: { easing: "ease-in-out" },
    }),

    /**
     * El borde encendido todo el rato.
     *
     * A diferencia del latido, **no llega a apagarse**: va y viene entre dos
     * intensidades, que es lo que lo lee como un borde de luz y no como un parpadeo.
     */
    borde_brillo: (m) => ({
      capa: "caja",
      fotogramas: [
        { filter: `drop-shadow(0 0 ${Math.round(2 + (m.intensidad * 0.08))}px ${m.glow_color})` },
        {
          filter: `drop-shadow(0 0 ${Math.round(6 + (m.intensidad * 0.22))}px ${m.glow_color})`,
        },
      ],
      opciones: { easing: "ease-in-out", direction: "alternate" },
    }),

    /** Una franja de luz que cruza el mensaje. */
    brillo: () => ({
      capa: "brillo",
      fotogramas: [
        { transform: "translateX(-130%) skewX(-18deg)", opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { transform: "translateX(130%) skewX(-18deg)", opacity: 0 },
      ],
      opciones: { easing: "linear" },
    }),

    /** Un temblor corto y luego quieto hasta el siguiente ciclo. */
    agitar: (m) => {
      const a = Math.max(1, Math.round((m.intensidad * 0.05) / 1));
      return {
        capa: "caja",
        fotogramas: [
          { transform: "translateX(0)" },
          { transform: `translateX(-${a}px)`, offset: 0.12 },
          { transform: `translateX(${a}px)`, offset: 0.24 },
          { transform: `translateX(-${Math.round(a * 0.6)}px)`, offset: 0.36 },
          { transform: `translateX(${Math.round(a * 0.6)}px)`, offset: 0.48 },
          { transform: "translateX(0)", offset: 0.62 },
          { transform: "translateX(0)" },
        ],
        opciones: { easing: "ease-in-out" },
      };
    },
  };

  /** El ritmo de la entrada: el elegido, o el que traiga la animacion. */
  function ritmo(m, porDefecto) {
    const elegido = window.DashMensajeConfig.RITMOS[m.ritmo];
    return elegido || porDefecto || "ease-out";
  }

  /**
   * El plan de la entrada: fotogramas y opciones listos para `element.animate`.
   *
   * Devuelve `null` si no hay nada que animar —«ninguna», o el sistema pidiendo menos
   * movimiento—, y entonces el renderer no anima: el mensaje aparece con la alerta, que
   * es como salia antes de todo esto.
   */
  function entrada(m) {
    const fabrica = ENTRADAS[m.animacion];
    if (!fabrica) return null;
    const fotogramas = fabrica(m);
    if (!fotogramas) return null;
    // Un rebote trae su propio ritmo: pedir un rebote y que no rebote seria una promesa
    // incumplida. Solo se pierde si el streamer elige un ritmo a mano.
    const porDefecto = m.animacion === "rebote" || m.animacion === "pop" || m.animacion === "elastico"
      ? window.DashMensajeConfig.RITMOS.rebote
      : "ease-out";
    return {
      fotogramas,
      opciones: {
        duration: m.duracion_ms,
        easing: ritmo(m, porDefecto),
        fill: "both",
      },
    };
  }

  /** El plan de la permanencia. Se repite hasta que el aviso se va. */
  function permanencia(m) {
    const fabrica = PERMANENCIAS[m.animacion_idle];
    if (!fabrica) return null;
    const plan = fabrica(m);
    if (!plan) return null;
    // El ciclo entero es lo que dura `ciclo_ms`; en el borde encendido, que va y viene,
    // la mitad: dos tramos iguales sumarian el doble de lo pedido.
    const duracion =
      plan.opciones && plan.opciones.direction === "alternate"
        ? Math.round(m.ciclo_ms / 2)
        : m.ciclo_ms;
    return {
      capa: plan.capa,
      fotogramas: plan.fotogramas,
      opciones: Object.assign({}, plan.opciones, {
        duration: Math.max(120, duracion),
        iterations: Infinity,
      }),
    };
  }

  window.DashMensajeAnim = { entrada, permanencia, ENTRADAS, PERMANENCIAS };
})();
