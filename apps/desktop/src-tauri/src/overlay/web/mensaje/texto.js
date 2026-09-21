/* Las animaciones del **texto** dentro del contenedor del mensaje.
 *
 * Va aparte de la animacion del contenedor a proposito: el contenedor se puede abrir en
 * horizontal mientras las palabras se descubren una a una, y eso son dos decisiones, no
 * una. Un solo catalogo con las combinaciones dentro tendria un preset por pareja.
 *
 * Las que van **por trozos** —palabras o letras— parten el texto en `span`s. Eso deja de
 * ser un detalle interno en cuanto hay un apodo largo: cada trozo es una caja, y una
 * palabra de sesenta letras ya no se puede partir por la mitad si cada letra es una caja
 * rigida. La hoja de estilos lo tiene en cuenta (`max-width: 100%` en la palabra), y ese
 * es el motivo de que el troceado viva aqui y no en el renderer.
 */
(() => {
  /**
   * Las animaciones.
   *
   * `unidades` dice en cuantos trozos se parte el texto: `todo` no lo parte, `palabras`
   * uno por palabra y `letras` uno por letra. `fotogramas` recibe el mensaje ya
   * normalizado y devuelve los fotogramas de **cada trozo**.
   */
  const ANIMACIONES = {
    /** Sin animacion no se trocea nada: el texto se queda como un solo bloque. */
    ninguna: null,

    fundido: {
      unidades: "todo",
      fotogramas: () => [{ opacity: 0 }, { opacity: 1 }],
    },

    /**
     * Maquina de escribir.
     *
     * Es un descubrimiento **seco**, letra a letra y sin moverse: por eso se distingue
     * de «Letras», que ademas sube. El paso es corto y constante, que es lo que lee como
     * un teclado y no como una cascada.
     */
    maquina: {
      unidades: "letras",
      fotogramas: () => [{ opacity: 0 }, { opacity: 1 }],
      paso: 0.32,
    },

    palabras: {
      unidades: "palabras",
      fotogramas: () => [
        { opacity: 0, transform: "translateY(0.45em)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
    },

    letras: {
      unidades: "letras",
      fotogramas: () => [
        { opacity: 0, transform: "translateY(0.32em)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
    },

    /** Una ola: cada letra sube, se pasa un poco y baja. */
    onda: {
      unidades: "letras",
      fotogramas: () => [
        { transform: "translateY(0.6em)", opacity: 0 },
        { transform: "translateY(-0.22em)", opacity: 1, offset: 0.5 },
        { transform: "translateY(0)", opacity: 1 },
      ],
    },

    /**
     * La letra se enciende con el color del resplandor y se apaga.
     *
     * Es la unica que anima `text-shadow`, y por eso va con `fill: "none"`: la sombra de
     * verdad —la que el streamer haya configurado para el texto— tiene que volver al
     * terminar, y con el fotograma pegado se quedaria encendida para siempre.
     */
    brillo: {
      unidades: "todo",
      fotogramas: (m) => [
        { textShadow: `0 0 0 ${m.glow_color}` },
        { textShadow: `0 0 18px ${m.glow_color}`, offset: 0.35 },
        { textShadow: `0 0 0 ${m.glow_color}` },
      ],
      relleno: "none",
    },

    /** Cada palabra da un bote antes de quedarse en su sitio. */
    pop: {
      unidades: "palabras",
      fotogramas: () => [
        { opacity: 0, transform: "scale(0.55)" },
        { opacity: 1, transform: "scale(1.12)", offset: 0.62 },
        { opacity: 1, transform: "scale(1)" },
      ],
    },
  };

  /** Los nombres de las animaciones, en el orden del catalogo del motor. */
  const CATALOGO = [
    "ninguna",
    "fundido",
    "maquina",
    "palabras",
    "letras",
    "onda",
    "brillo",
    "pop",
  ];

  /** Cuanto dura cada trozo. Es una parte de la duracion pedida, no la duracion entera. */
  const porTrozo = (duracion) => Math.max(110, Math.round(duracion * 0.55));

  /**
   * Cuanto se espera entre trozo y trozo.
   *
   * Se reparte la duracion pedida entre los trozos que hay, con un tope por arriba: en
   * un texto de tres palabras, esperar lo mismo que en uno de treinta dejaria una
   * cascada eterna. `maquina` pide un paso mas corto porque su gracia es esa.
   */
  function pasoEntre(n, duracion, factor) {
    const reparto = (duracion * 0.45 * (factor || 1)) / Math.max(1, n);
    return Math.min(70, Math.max(8, Math.round(reparto)));
  }

  /**
   * Parte el texto en trozos y devuelve las cajas que hay que animar.
   *
   * Los espacios se quedan como texto suelto entre las palabras: asi el navegador puede
   * partir la linea donde toca en vez de tratar el mensaje entero como una sola caja.
   */
  function trocear(nodo, texto, unidades) {
    nodo.textContent = "";
    if (unidades === "todo") return [nodo];

    const cajas = [];
    for (const trozo of String(texto).split(/(\s+)/)) {
      if (trozo === "") continue;
      if (/^\s+$/.test(trozo)) {
        nodo.appendChild(document.createTextNode(trozo));
        continue;
      }
      const palabra = document.createElement("span");
      palabra.className = "mensaje-palabra";
      if (unidades === "palabras") {
        palabra.textContent = trozo;
        cajas.push(palabra);
      } else {
        for (const letra of Array.from(trozo)) {
          const caja = document.createElement("span");
          caja.className = "mensaje-letra";
          caja.textContent = letra;
          palabra.appendChild(caja);
          cajas.push(caja);
        }
      }
      nodo.appendChild(palabra);
    }
    return cajas;
  }

  /** El texto sin trocear, por si hay que devolverlo a su sitio. */
  function liso(nodo, texto) {
    nodo.textContent = texto;
  }

  /**
   * Lanza la animacion del texto y devuelve **cuanto dura entera**.
   *
   * El renderer necesita ese numero para saber cuando puede arrancar la permanencia del
   * contenedor: si empezara antes, el movimiento del texto y el del contenedor se
   * pisarian.
   */
  function animar(nodo, m, texto, opciones) {
    if (!nodo) return 0;
    const quieto = opciones && opciones.quieto;
    const definicion = ANIMACIONES[m.animacion_texto];

    // Sin animacion —o con el sistema pidiendo menos movimiento— el texto se queda de
    // una pieza: trocearlo para nada dejaria cajas que solo estorban.
    if (!definicion || quieto) {
      liso(nodo, texto);
      return 0;
    }

    const cajas = trocear(nodo, texto, definicion.unidades);
    if (cajas.length === 0) return 0;

    const fotogramas = definicion.fotogramas(m);
    if (!fotogramas) return 0;

    const duracion = porTrozo(m.duracion_ms);
    const ritmo = window.DashMensajeConfig.RITMOS[m.ritmo];
    const easing =
      ritmo ||
      (m.animacion_texto === "pop" ? window.DashMensajeConfig.RITMOS.rebote : "ease-out");
    const paso = pasoEntre(cajas.length, m.duracion_ms, definicion.paso);
    const relleno = definicion.relleno || (cajas.length === 1 ? "none" : "both");

    cajas.forEach((caja, indice) => {
      caja.animate(fotogramas, {
        duration: duracion,
        delay: indice * paso,
        easing,
        fill: relleno,
      });
    });

    return (cajas.length - 1) * paso + duracion;
  }

  window.DashMensajeTexto = { animar, trocear, ANIMACIONES, CATALOGO };
})();
