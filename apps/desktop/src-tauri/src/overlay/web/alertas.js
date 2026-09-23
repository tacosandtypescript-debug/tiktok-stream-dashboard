/* Cliente de las alertas: recibe avisos y los representa **de uno en uno**.
 *
 * Tres cosas que este fichero tiene que hacer bien, porque en directo se notan:
 *
 *   1. **Nunca se queda mudo.** Un medio que no carga, un video que no arranca o
 *      un aviso sin nada que enseñar **no** pueden parar la cola: el siguiente
 *      aviso sale igual. Una alerta perdida se nota; una cola atascada, no.
 *   2. **Los avisos se encolan aqui, no en el servidor.** El motor manda lo que
 *      pasa y esta pagina los va sacando; asi el servidor no tiene que saber
 *      cuanto dura cada uno.
 *   3. **El audio de un aviso sale siempre del fichero de sonido, y de ningun otro
 *      sitio.** El video va **siempre** en silencio. Antes sonaba con su propio
 *      audio cuando la alerta no traia sonido, y eso eran dos maneras de que un
 *      aviso tuviera audio: para saber si una alerta suena habia que mirar dos
 *      campos, y el mismo video sonaba o no segun lo que tuviera el otro. Una
 *      regla, un sitio.
 *
 * Aqui vive **la alerta entera**: su entrada, su permanencia y su salida. El
 * **contenedor del mensaje** —el bloque del texto, con su estilo y sus animaciones— es
 * otro sistema, en `mensaje/`: esto lo pinta y le pide que se anime, y no sabe como.
 * Separarlos es lo que permite cambiar un preset del mensaje sin tocar como entra el
 * aviso, que es justo lo que no se puede romper.
 */
(() => {
  const parametros = new URLSearchParams(location.search);
  const token = parametros.get("t") || "";
  /**
   * Si esta pagina es la **previa del panel** (`previa=1`) y por tanto va muda.
   *
   * En OBS este documento es la fuente de la audiencia y su `<audio>` es el sonido
   * que sale en antena. En la previa del panel, en cambio, el sonido del aviso lo
   * pone el **monitor** de esta maquina —el mismo que el boton de oir—, asi que
   * dejar que suene aqui tambien seria oir dos copias del mismo aviso. La marca la
   * añade la pestana de Alertas y **solo** ella: la direccion que se pega en OBS no
   * la lleva.
   */
  const enPrevia = parametros.get("previa") === "1";

  /**
   * Cursor de esta fuente, separado para la previa y para OBS.
   *
   * El WebSocket puede reconectar mientras un Browser Source cambia de escena.
   * Guardar el cursor permite pedir solo lo que falto; la generacion evita que un
   * `seq` de una ejecucion anterior se confunda con el primero del proceso nuevo.
   * `localStorage` puede estar bloqueado en algun WebView, asi que no es requisito
   * para que el overlay funcione.
   */
  const claveCursor = `ttdash-alertas:${location.host}:${enPrevia ? "previa" : "obs"}`;

  function leerCursor() {
    try {
      const guardado = JSON.parse(localStorage.getItem(claveCursor) || "null");
      const generacion = Number(guardado?.generacion);
      const seq = Number(guardado?.seq);
      return {
        generacion: Number.isSafeInteger(generacion) && generacion > 0 ? generacion : 0,
        seq: Number.isSafeInteger(seq) && seq > 0 ? seq : 0,
      };
    } catch {
      return { generacion: 0, seq: 0 };
    }
  }

  const cursorInicial = leerCursor();
  let generacion = cursorInicial.generacion;
  let ultimoSeq = cursorInicial.seq;

  function guardarCursor() {
    try {
      localStorage.setItem(claveCursor, JSON.stringify({ generacion, seq: ultimoSeq }));
    } catch {
      // El cursor es una mejora de recuperacion, no una razon para romper la alerta.
    }
  }

  const caja = document.getElementById("caja");
  const imagen = document.getElementById("imagen");
  const video = document.getElementById("video");
  const texto = document.getElementById("texto");
  const sonido = document.getElementById("sonido");
  const elAviso = document.getElementById("aviso");

  /** Avisos esperando su turno. Se acota: una lista sin tope es una fuga. */
  const COLA_MAXIMA = 30;
  const cola = [];
  let representando = false;

  /**
   * Que hay ahora mismo en pantalla: `"prueba"`, `"real"` o `null`.
   *
   * Hay que distinguirlo porque una prueba y un aviso de verdad **no se comportan
   * igual**: una prueba sustituye a la prueba que este puesta —se esta configurando, y
   * esperar a que acabe la anterior es justo lo que hacia que la previa pareciera
   * atascada—, mientras que un aviso de verdad espera su turno y no lo corta nadie.
   */
  let enPantalla = null;

  /**
   * Sube cada vez que una prueba toma el relevo de otra.
   *
   * Es lo que permite cortar limpiamente: el aviso que se esta representando se queda
   * con el numero que tenia al empezar y, en cada paso, comprueba si sigue siendo el
   * suyo. Sin esto habria que esperar a que terminara su duracion —17 s con la que
   * trae «Regalos»— para ver la siguiente.
   */
  let relevo = 0;

  /** Corta la espera en curso, si la hay. La pone `esperar`. */
  let cortarEspera = null;

  function anunciar(mensaje, conectado) {
    if (!elAviso) return;
    elAviso.textContent = mensaje;
    elAviso.className = conectado ? "aviso conectado" : "aviso";
  }

  /**
   * El tamaño, cambiado **en vivo** desde la previa del panel.
   *
   * El panel enseña este mismo documento dentro de un marco, y el mando del tamaño
   * vive alli: al moverlo manda la escala por `postMessage` para que el aviso que ya
   * esta en pantalla cambie de tamaño sin volver a dispararlo. Antes habia que pulsar
   * Probar despues de cada movimiento, asi que ajustar a ojo era a ciegas.
   *
   * Aqui solo se escribe **una variable de CSS**: un mensaje de mas no puede hacer
   * nada peor que cambiar lo que ocupa el aviso que se esta viendo. Los topes son los
   * mismos que los del motor, repetidos porque esto corre en otro proceso.
   */
  window.addEventListener("message", (evento) => {
    const dato = evento.data;
    if (!dato || typeof dato !== "object") return;

    // El **mensaje**, cambiado en vivo desde el editor: es el mismo camino que el
    // tamaño, pero para los ajustes del contenedor. El renderer aplica el estilo al
    // momento y solo repite la animacion si la han cambiado, para que mover un mando no
    // deje el mensaje saltando.
    if (dato.dash === "mensaje") {
      window.DashMensaje?.previa(dato.mensaje);
      return;
    }

    if (dato.dash !== "escala") return;
    const valor = Number(dato.escala);
    if (!Number.isFinite(valor)) return;
    caja.style.setProperty("--escala", String(Math.min(2, Math.max(0.25, valor))));
  });

  function dormir(ms) {
    return new Promise((seguir) => setTimeout(seguir, ms));
  }

  /**
   * Una espera que se puede cortar. Devuelve `true` si la cortaron.
   *
   * El aviso dura lo que dura, y sin poder cortarlo probar otra alerta obliga a
   * esperar a que la anterior termine: con los 17 s que trae «Regalos» de fabrica, la
   * previa se queda enseñando lo viejo y parece colgada. Esa es exactamente la queja
   * que esto resuelve.
   *
   * Se usa un `setTimeout` de verdad y no `dormir` porque hay que poder cancelarlo.
   */
  function esperar(ms) {
    return new Promise((seguir) => {
      const temporizador = setTimeout(() => {
        cortarEspera = null;
        seguir(false);
      }, ms);
      cortarEspera = () => {
        clearTimeout(temporizador);
        cortarEspera = null;
        seguir(true);
      };
    });
  }

  /**
   * Espera al fotograma siguiente, pero **no para siempre**.
   *
   * En una pagina oculta —y una fuente de OBS puede estarlo, o estar detras de
   * otra— el navegador **no llama a `requestAnimationFrame`**. Si la cola esperase
   * solo a eso, el aviso se quedaria a medio enseñar y **ninguna alerta volveria a
   * salir**: un atasco mudo, que es la peor forma de fallar. El temporizador de
   * respaldo tarda mas en una pagina oculta, pero siempre llega.
   *
   * Lo delato la verificacion: el texto y la imagen ya estaban puestos y la caja
   * seguia sin la clase de visible.
   */
  function siguienteFotograma() {
    return new Promise((seguir) => {
      let hecho = false;
      const terminar = () => {
        if (hecho) return;
        hecho = true;
        seguir();
      };
      requestAnimationFrame(terminar);
      setTimeout(terminar, 150);
    });
  }

  /** La direccion de un medio del almacen, con el token que ya trae la pagina. */
  function urlDeMedio(nombre) {
    if (!nombre) return "";
    return "/media/" + encodeURIComponent(nombre) + "?t=" + encodeURIComponent(token);
  }

  function esVideo(nombre) {
    return /\.(mp4|webm)$/i.test(nombre);
  }

  /**
   * Espera a que el medio pueda pintarse, pero nunca deja la cola esperando para
   * siempre. El servidor entrega ficheros locales, aun asi un GIF grande puede
   * necesitar varios turnos del navegador para decodificarse y `src` no significa
   * que ya haya un fotograma visible.
   *
   * La misma cancelacion que usa la permanencia permite que el boton Probar tome el
   * relevo durante una carga lenta. El resultado falso no es un error fatal: quien
   * llama quita el medio roto y deja pasar el texto o el siguiente aviso.
   */
  const TIEMPO_MAXIMO_CARGA_MEDIO_MS = 2000;
  function esperarCargaMedio(elemento, eventoListo, estaListo, mio) {
    return new Promise((resolver) => {
      let terminado = false;
      let temporizador = null;

      const quitarEscuchas = () => {
        elemento.removeEventListener(eventoListo, listo);
        elemento.removeEventListener("error", fallo);
        if (cortarEspera === cancelar) cortarEspera = null;
      };

      const terminar = (cargado) => {
        if (terminado) return;
        terminado = true;
        if (temporizador !== null) clearTimeout(temporizador);
        quitarEscuchas();
        resolver(cargado && mio === relevo);
      };

      const cancelar = () => terminar(false);
      const listo = () => terminar(true);
      const fallo = () => terminar(false);

      elemento.addEventListener(eventoListo, listo);
      elemento.addEventListener("error", fallo);
      cortarEspera = cancelar;
      temporizador = setTimeout(() => terminar(false), TIEMPO_MAXIMO_CARGA_MEDIO_MS);

      // El evento puede haber ocurrido entre la asignacion de `src` y la instalacion
      // de los listeners, sobre todo con un fichero pequeño en la cache de WebView.
      if (estaListo()) terminar(true);
    });
  }

  // ---------------------------------------------------------------------------
  // El motor de animaciones
  // ---------------------------------------------------------------------------

  /**
   * Las animaciones, como **un estado de partida** cada una.
   *
   * El aviso siempre acaba en el mismo sitio —en su sitio, opaco y sin desenfoque—,
   * asi que lo unico que distingue una animacion de otra es **de donde viene**. Con
   * eso, la salida es la misma animacion al reves y un solo catalogo sirve para las
   * dos: elegir «arriba» de salida significa salir hacia arriba, y por eso la interfaz
   * lo rotula con esas palabras y no con las de la entrada.
   *
   * Añadir una animacion nueva es **una linea aqui** mas su nombre en el catalogo del
   * motor (`ANIMACIONES`, en `alerts/mod.rs`). No hay nada que tocar en la cola ni en
   * la hoja de estilos: el CSS solo sabe de tres variables —de donde, cuanto tarda y
   * con que ritmo— y no de once animaciones. Eso es lo que evita las veintidos
   * combinaciones de entrada y salida que habria con clases.
   */
  const ANIMACIONES = {
    ninguna: null,
    fundido: { desde: { opacidad: 0 } },
    arriba: { desde: { opacidad: 0, transformacion: "translateY(-70%)" } },
    abajo: { desde: { opacidad: 0, transformacion: "translateY(70%)" } },
    izquierda: { desde: { opacidad: 0, transformacion: "translateX(-70%)" } },
    derecha: { desde: { opacidad: 0, transformacion: "translateX(70%)" } },
    acercar: { desde: { opacidad: 0, transformacion: "scale(0.55)" } },
    alejar: { desde: { opacidad: 0, transformacion: "scale(1.6)" } },
    // El rebote trae su propio ritmo: pedir un rebote y que no rebote seria una
    // promesa incumplida. Solo se pierde si el streamer elige un ritmo a mano.
    rebote: { desde: { opacidad: 0, transformacion: "scale(0.72)" }, ritmo: "rebote" },
    giro: { desde: { opacidad: 0, transformacion: "perspective(900px) rotateY(85deg)" } },
    desenfoque: { desde: { opacidad: 0, desenfoque: "blur(16px)" } },
  };

  /** Los ritmos. `auto` —el de fabrica— deja el que traiga la animacion. */
  const RITMOS = {
    auto: null,
    suave: "cubic-bezier(0.22, 1, 0.36, 1)",
    rebote: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    lineal: "linear",
    rapido: "cubic-bezier(0.4, 0, 1, 1)",
    lento: "cubic-bezier(0, 0, 0.2, 1)",
  };

  /** El aviso en su sitio: opaco, sin transformacion y sin desenfoque. */
  const EN_SU_SITIO = { opacidad: 1, transformacion: "none", desenfoque: "none" };

  /**
   * Escribe en la caja el estado de partida de una animacion y devuelve sus ms.
   *
   * El estado que se escribe es **siempre el de partida**, y quien llama decide si
   * añade o quita `visible`:
   *
   *   - al entrar, la caja arranca en ese estado y `visible` la lleva a su sitio;
   *   - al salir, la caja esta en su sitio y quitar `visible` la devuelve ahi.
   *
   * Una sola direccion, dos usos. Ese es el truco que hace que once animaciones sean
   * suficientes para entradas y salidas.
   *
   * Se llama **antes** de enseñar nada: sin esto, el aviso aparece un instante en su
   * sitio y luego salta al punto de partida, que se ve peor que no animarlo.
   */
  function prepararAnimacion(aviso, sentido) {
    const esEntrada = sentido === "entrada";
    const definicion = ANIMACIONES[esEntrada ? aviso.animacion_entrada : aviso.animacion_salida] ?? null;
    const ms = (esEntrada ? aviso.entrada_ms : aviso.salida_ms) || 0;
    const desde = definicion ? definicion.desde : EN_SU_SITIO;

    // `||` y no `??`: un ritmo vacio —o uno que ya no exista— tiene que caer al de la
    // animacion, no dejar la transicion sin ritmo.
    const ritmo = RITMOS[aviso.ritmo] || (definicion && definicion.ritmo && RITMOS[definicion.ritmo]) || "";

    // --- El estado de partida se escribe SIN transicion ----------------------
    //
    // Y esto es lo que hace que la animacion exista. Con la transicion puesta, el
    // navegador anima **tambien el viaje hasta el punto de partida**: cuando un
    // fotograma despues se añade `visible`, el aviso ya esta casi en su sitio y el
    // camino que le queda por recorrer es de un pixel. Resultado: aparece de golpe.
    //
    // Medido, que es como se encontro: muestreando la opacidad calculada cada 40 ms,
    // pasaba de 1,00 a 1,00 sin un solo fotograma intermedio. El deslizador guardaba
    // bien, el motor escribia las variables correctas y no se movia nada.
    caja.style.setProperty("--ms-animacion", "0ms");
    caja.style.setProperty("--entra-opacidad", String(desde.opacidad ?? 1));
    caja.style.setProperty("--entra-transformacion", desde.transformacion ?? "none");
    caja.style.setProperty("--entra-desenfoque", desde.desenfoque ?? "none");

    // Se obliga al navegador a calcular el estilo con ese estado **antes** de devolverle
    // la transicion. Sin esta linea los dos cambios caen en el mismo fotograma y el
    // navegador solo ve el de despues: el aviso se quedaria donde estaba y no habria
    // animacion que valga.
    void caja.offsetHeight;

    // Ya se puede viajar: la transicion vuelve con su duracion y su ritmo.
    caja.style.setProperty("--ms-animacion", ms + "ms");
    caja.style.setProperty("--ritmo-animacion", ritmo || "ease-out");

    return ms;
  }

  // ---------------------------------------------------------------------------
  // Las animaciones de permanencia
  // ---------------------------------------------------------------------------

  /**
   * Lo que hace la alerta **mientras esta en pantalla**: ya entrada y antes de salir.
   *
   * Es un bucle, no una transicion, y por eso no se hace con transiciones como las de
   * entrada y salida: se hace con fotogramas. La diferencia importa — una transicion va
   * de un estado a otro y termina; esto se repite hasta que el aviso se va.
   *
   * **Los fotogramas se generan**, no estan escritos en `alertas.html`, porque el
   * «intervalo entre repeticiones» mueve **donde acaba el movimiento dentro del ciclo**,
   * y los selectores de un `@keyframes` son numeros escritos: no admiten un porcentaje
   * que venga de una variable. Generarlos es lo que deja que cada efecto tenga sus
   * propios parametros sin escribir un fotograma por combinacion.
   *
   * Cada efecto es **una entrada** aqui. Un efecto nuevo no toca ni la cola ni la hoja
   * de estilos.
   */
  const NOMBRE_PERMANENCIA = "dash-permanencia";

  /** Donde se escriben los fotogramas del efecto que este puesto. */
  const hojaPermanencia = document.createElement("style");
  document.head.appendChild(hojaPermanencia);

  /**
   * Reparte el ciclo entre el movimiento y la espera.
   *
   * Devuelve el ciclo entero y el porcentaje en el que el movimiento termina. Sin
   * intervalo, el movimiento ocupa el ciclo entero y ese porcentaje es 100.
   */
  function reparto(ms, intervalo) {
    const total = ms + intervalo;
    return { total, fin: Math.round((ms / total) * 1000) / 10 };
  }

  /** Un porcentaje dentro de la parte que se mueve, ya escalado al ciclo entero. */
  const dentro = (fraccion, fin) => Math.round(fraccion * fin * 10) / 10;

  /**
   * El cierre del ciclo: donde el movimiento ya acabo y el aviso se queda quieto.
   *
   * Sin intervalo el movimiento ocupa el ciclo entero, asi que el cierre **es** el
   * ultimo fotograma; escribirlo como `${fin}%, 100%` diria `100%, 100%`, que es el
   * mismo fotograma declarado dos veces. Con intervalo si son dos de verdad —el
   * movimiento acaba antes y lo que queda es la espera—, y por eso el cierre se
   * escribe aparte en vez de darlo por hecho.
   */
  const cierre = (fin) => (fin >= 100 ? "100%" : `${fin}%, 100%`);

  /**
   * Los efectos. Cada uno recibe sus parametros y devuelve el CSS que hay que escribir.
   *
   * Todos mueven **la alerta entera** —la caja, con su medio y su texto dentro—, y por
   * eso usan `translate`, `scale` y `rotate` en vez de `transform`: esas tres propiedades
   * se **componen** con el `transform` que usan la entrada y la salida, en vez de
   * pisarselo. Con `transform` aqui, entrar deslizando y quedarse flotando serian dos
   * animaciones peleandose por la misma propiedad y ganaria la ultima.
   */
  const PERMANENCIAS = {
    ninguna: null,

    /** Sube y baja despacio, sin parar. */
    flotar: ({ distancia, ms, intervalo }) => {
      const { total, fin } = reparto(ms, intervalo);
      return `
        @keyframes ${NOMBRE_PERMANENCIA} {
          0%, ${cierre(fin)} { translate: 0 0; }
          ${dentro(0.25, fin)}% { translate: 0 -${distancia}px; }
          ${dentro(0.75, fin)}% { translate: 0 ${distancia}px; }
        }
        #caja { animation: ${NOMBRE_PERMANENCIA} ${total}ms ease-in-out infinite; }
      `;
    },

    /**
     * Un rebote pequeño y continuo.
     *
     * La curva no es la misma al subir que al bajar, y ahi esta todo: sube frenando y
     * cae acelerando. Con la misma curva en los dos sentidos aquello no rebota, flota.
     */
    rebotar: ({ distancia, ms, intervalo }) => {
      const { total, fin } = reparto(ms, intervalo);
      return `
        @keyframes ${NOMBRE_PERMANENCIA} {
          0% { translate: 0 0; animation-timing-function: cubic-bezier(0.3, 0, 0.7, 0.2); }
          ${dentro(0.45, fin)}% { translate: 0 -${distancia}px; animation-timing-function: cubic-bezier(0.3, 0.8, 0.7, 1); }
          ${cierre(fin)} { translate: 0 0; }
        }
        #caja { animation: ${NOMBRE_PERMANENCIA} ${total}ms linear infinite; }
      `;
    },

    /** Una vibracion corta, y luego quieto hasta la siguiente. */
    agitar: ({ distancia, ms, intervalo }) => {
      const { total, fin } = reparto(ms, intervalo);
      return `
        @keyframes ${NOMBRE_PERMANENCIA} {
          0% { translate: 0 0; }
          ${dentro(0.2, fin)}% { translate: -${distancia}px 0; }
          ${dentro(0.4, fin)}% { translate: ${distancia}px 0; }
          ${dentro(0.6, fin)}% { translate: -${distancia}px 0; }
          ${dentro(0.8, fin)}% { translate: ${distancia}px 0; }
          ${cierre(fin)} { translate: 0 0; }
        }
        #caja { animation: ${NOMBRE_PERMANENCIA} ${total}ms linear infinite; }
      `;
    },

    /**
     * Una franja de luz que cruza la alerta.
     *
     * Va en un `::before` que cubre la caja entera y se mueve con `background-position`:
     * asi la franja **no puede salirse** del aviso, porque un fondo nunca desborda su
     * caja. Mover un elemento obligaria a recortarlo con `overflow: hidden`, y eso
     * cortaria tambien el resplandor del borde.
     */
    brillo: ({ brillo, distancia: ancho, ms, intervalo, modo }) => {
      const { total, fin } = reparto(ms, intervalo);
      const mitad = Math.max(2, Math.min(48, ancho / 2));
      // Los dos modos, nombrados los dos en un mapa. La franja entra por un lado y sale
      // por el otro, y cualquier modo que no se conozca —uno que ya no exista— entra por
      // la izquierda, que es el de fabrica.
      const ENTRADA = { izquierda: 0, derecha: 100 };
      const desde = ENTRADA[modo] ?? ENTRADA.izquierda;
      const hasta = desde === 0 ? 100 : 0;
      return `
        @keyframes ${NOMBRE_PERMANENCIA} {
          0% { background-position: ${desde}% 0; }
          ${cierre(fin)} { background-position: ${hasta}% 0; }
        }
        #caja::before {
          background-image: linear-gradient(105deg,
            transparent ${50 - mitad}%,
            rgba(255, 255, 255, ${brillo / 100}) 50%,
            transparent ${50 + mitad}%);
          background-position: ${desde}% 0;
          background-repeat: no-repeat;
          background-size: 300% 100%;
          animation: ${NOMBRE_PERMANENCIA} ${total}ms linear infinite;
        }
      `;
    },

    /** Una deformacion suave de gelatina: se ensancha y se estrecha. */
    gelatina: ({ distancia: intensidad, ms, intervalo }) => {
      const { total, fin } = reparto(ms, intervalo);
      const mucho = 1 + intensidad / 100;
      const poco = 1 - intensidad / 100;
      return `
        @keyframes ${NOMBRE_PERMANENCIA} {
          0%, ${cierre(fin)} { scale: 1 1; }
          ${dentro(0.2, fin)}% { scale: ${mucho} ${poco}; }
          ${dentro(0.45, fin)}% { scale: ${poco} ${mucho}; }
          ${dentro(0.7, fin)}% { scale: ${mucho} ${poco}; }
        }
        #caja { animation: ${NOMBRE_PERMANENCIA} ${total}ms ease-in-out infinite; }
      `;
    },

    /**
     * El resplandor del contorno, de dos maneras.
     *
     * `pulso` usa `drop-shadow`, que sigue la **silueta real** de lo que hay dentro: si
     * el aviso es un sticker con esquinas redondeadas, el resplandor tambien. `recorrido`
     * dibuja un anillo con un degradado conico y lo gira, que es una luz que da la vuelta
     * al contorno.
     */
    borde: ({ brillo, ms, intervalo, color, blur, modo }) => {
      const { total, fin } = reparto(ms, intervalo);
      const alfa = Math.min(1, Math.max(0.05, brillo / 100));
      // Los dos modos, nombrados los dos: `pulso` late entero y `recorrido` da la vuelta
      // al contorno. Se normaliza en una linea —y no se deja al `else`— para que un modo
      // que no se conozca caiga en `pulso` **a proposito** y no por descuido, y para que
      // los dos nombres esten escritos donde el test de catalogo los busca.
      const modoBorde = modo === "recorrido" ? "recorrido" : "pulso";

      if (modoBorde === "recorrido") {
        return `
          @property --${NOMBRE_PERMANENCIA}-giro {
            syntax: "<angle>";
            initial-value: 0deg;
            inherits: false;
          }
          @keyframes ${NOMBRE_PERMANENCIA} {
            0% { --${NOMBRE_PERMANENCIA}-giro: 0deg; }
            ${cierre(fin)} { --${NOMBRE_PERMANENCIA}-giro: 360deg; }
          }
          #caja::after {
            background: conic-gradient(from var(--${NOMBRE_PERMANENCIA}-giro),
              transparent 0 55%, ${color} 78%, transparent 95%);
            animation: ${NOMBRE_PERMANENCIA} ${total}ms linear infinite;
          }
        `;
      }

      return `
        @keyframes ${NOMBRE_PERMANENCIA} {
          0%, ${cierre(fin)} { filter: drop-shadow(0 0 ${Math.round(blur * 0.4)}px ${color}); }
          ${dentro(0.5, fin)}% { filter: drop-shadow(0 0 ${blur}px ${color}); }
        }
        #caja { animation: ${NOMBRE_PERMANENCIA} ${total}ms ease-in-out infinite; }
      `;
    },
  };

  /** Los parametros del aviso, ya saneados: lo que llega puede venir de cualquier sitio. */
  function parametrosDePermanencia(aviso) {
    const numero = (valor, defecto) => (Number.isFinite(valor) ? valor : defecto);
    return {
      distancia: Math.max(0, Math.min(400, numero(aviso.idle_distancia, 8))),
      ms: Math.max(200, numero(aviso.idle_ms, 2500)),
      intervalo: Math.max(0, numero(aviso.idle_intervalo_ms, 0)),
      brillo: Math.max(0, Math.min(100, numero(aviso.idle_brillo, 40))),
      color: typeof aviso.idle_color === "string" ? aviso.idle_color : "#25f4ee",
      blur: Math.max(0, Math.min(120, numero(aviso.idle_blur, 12))),
      modo: typeof aviso.idle_modo === "string" ? aviso.idle_modo : "pulso",
    };
  }

  /**
   * Arranca la permanencia del aviso que este en pantalla.
   *
   * Se llama **cuando termina la entrada**, no antes: si empezara a la vez, el temblor
   * se comeria la entrada y no se veria ninguna de las dos.
   */
  function arrancarPermanencia(aviso) {
    const efecto = PERMANENCIAS[aviso.idle] ?? null;
    if (!efecto) return;
    hojaPermanencia.textContent = efecto(parametrosDePermanencia(aviso));
  }

  /**
   * La para y deja el aviso donde estaba.
   *
   * Al quitar los fotogramas, `translate`, `scale` y `filter` vuelven a su sitio. Como
   * esas tres estan en la lista de transiciones de la caja, **vuelven suavemente**
   * durante la salida en vez de dar un salto: si el aviso estaba seis pixeles mas
   * arriba, no pega un tiron, se coloca mientras se desvanece.
   */
  function pararPermanencia() {
    hojaPermanencia.textContent = "";
  }

  // ---------------------------------------------------------------------------
  // La cola
  // ---------------------------------------------------------------------------

  function encolar(aviso) {
    if (!aviso) return;

    /**
     * Una prueba **sustituye** a la prueba que este en pantalla.
     *
     * Es lo que se viene a hacer al pulsar Probar: probar Regalos, cambiar a Seguidores
     * y volver a pulsar tiene que enseñar Seguidores **ya**, no cuando la anterior
     * termine. Y no toca nada mas: los avisos de verdad que esten esperando se quedan
     * donde estan, y una prueba tampoco corta un aviso de verdad que este saliendo.
     */
    const sustituye = aviso.prueba === true && enPantalla === "prueba";

    if (sustituye) {
      // Las pruebas que esperaban su turno ya no valen: la que se acaba de pulsar es
      // la que el streamer quiere ver. Se quitan **solo las pruebas**, uno a uno y de
      // atras hacia delante, para no llevarse por delante un aviso real encolado.
      for (let i = cola.length - 1; i >= 0; i -= 1) {
        if (cola[i].prueba === true) cola.splice(i, 1);
      }
    }

    if (cola.length >= COLA_MAXIMA) {
      // Se tira el mas viejo: si hay treinta esperando, los primeros ya no
      // interesan a nadie.
      cola.shift();
      console.warn("la cola de alertas esta llena; se descarta la mas antigua");
    }
    cola.push(aviso);

    if (sustituye) {
      // Se le da el relevo a la nueva: la que estaba se entera en su siguiente paso y
      // se retira limpia, sin esperar a que acabe su duracion.
      relevo += 1;
      if (cortarEspera) cortarEspera();
    }
    if (!representando) void sacar();
  }

  /**
   * Acepta una alerta del protocolo y la fusiona por `seq`.
   *
   * La foto inicial y los incrementales llegan por el mismo socket, pero una
   * reconexion puede dejar la misma alerta en la foto pendiente y en el broadcast.
   * El cursor es el equivalente de la fusion que usa la interfaz principal.
   */
  function recibir(aviso, generacionMensaje) {
    if (!aviso) return;

    const nuevaGeneracion = Number(generacionMensaje);
    if (Number.isSafeInteger(nuevaGeneracion) && nuevaGeneracion > 0) {
      if (generacion !== 0 && generacion !== nuevaGeneracion) {
        // El servidor reinicio su cola: los seq viejos ya no representan alertas
        // de esta ejecucion. Lo que ya esta visible termina; lo que esperaba era
        // del proceso anterior y no debe reaparecer.
        cola.length = 0;
        ultimoSeq = 0;
      }
      generacion = nuevaGeneracion;
    }

    const seq = Number(aviso.seq);
    if (Number.isSafeInteger(seq) && seq > 0) {
      if (seq <= ultimoSeq) return;
      ultimoSeq = seq;
      guardarCursor();
    }
    encolar(aviso);
  }

  function recibirVarios(avisos, generacionMensaje) {
    avisos
      .filter((aviso) => aviso && Number.isSafeInteger(Number(aviso.seq)))
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .forEach((aviso) => recibir(aviso, generacionMensaje));
  }

  async function sacar() {
    representando = true;
    while (cola.length > 0) {
      const aviso = cola.shift();
      try {
        await representar(aviso);
      } catch (error) {
        // Un aviso roto no puede parar los siguientes. Se cuenta y se sigue.
        console.error("no se pudo representar la alerta", error);
      }
    }
    representando = false;
  }

  /** Deja la caja vacia y lista para el siguiente aviso. */
  function limpiar() {
    // La permanencia se para **aqui** y no solo donde acaba un aviso: por este camino
    // pasan todos, incluidos los que se retiran a medias. Un efecto que siguiera
    // corriendo se quedaria pegado a la caja y lo heredaria el aviso siguiente.
    pararPermanencia();
    caja.classList.remove("visible");
    imagen.classList.remove("puesto");
    video.classList.remove("puesto");
    video.pause();
    video.removeAttribute("src");
    video.load();
    sonido.pause();
    sonido.removeAttribute("src");
    sonido.load();
    // El mensaje se para antes de vaciar la caja: deja el texto de una pieza —las
    // animaciones por letra lo trocean— y cancela lo que estuviera corriendo, para que
    // el aviso siguiente no herede ni una caja suelta ni un temporizador.
    window.DashMensaje?.parar();
    texto.textContent = "";
    texto.classList.remove("error");
    imagen.removeAttribute("src");
  }

  async function representar(aviso) {
    limpiar();
    enPantalla = null;

    /** El relevo que le toca a este aviso. Ver `relevo`. */
    const mio = relevo;

    const medio = typeof aviso.medio === "string" ? aviso.medio : "";
    const audio = typeof aviso.sonido === "string" ? aviso.sonido : "";
    const textoDelAviso = typeof aviso.texto === "string" ? aviso.texto : "";
    const volumen = Number.isFinite(aviso.volumen) ? Math.min(1, Math.max(0, aviso.volumen)) : 0.8;
    // El tamaño lo decide el aviso, no la hoja de estilos: cada tipo tiene el suyo.
    // Los topes son los mismos que los del motor (`ESCALA_MINIMA`/`ESCALA_MAXIMA`);
    // se repiten aqui porque este fichero corre en otro proceso y un valor sin
    // acotar acabaria dentro de un `calc()`.
    const escala = Number.isFinite(aviso.escala)
      ? Math.min(2, Math.max(0.25, aviso.escala))
      : 1;
    caja.style.setProperty("--escala", String(escala));

    // Ni medio ni texto: no hay nada que enseñar, y esperar la duracion entera
    // por nada retrasaria la cola.
    if (!medio && !textoDelAviso.trim()) return;

    // Desde aqui este aviso es el dueño de la pantalla, aunque tarde un fotograma en
    // pintarse. Es lo que hace que una prueba pulsada justo despues sepa que puede
    // tomar el relevo en vez de ponerse a la cola.
    enPantalla = aviso.prueba === true ? "prueba" : "real";

    if (medio) {
      const url = urlDeMedio(medio);
      if (esVideo(medio)) {
        video.src = url;
        // **Siempre en silencio**, tenga o no sonido la alerta. El audio de un
        // aviso sale del campo de sonido y de ningun otro sitio: si el video sonara
        // cuando no hay sonido, la misma alerta se oiria o no segun un campo que no
        // es el del audio, y eso es lo que confundia.
        video.muted = true;
        video.volume = volumen;
        video.loop = false;
        const cargado = await esperarCargaMedio(
          video,
          "loadeddata",
          () => video.readyState >= 2,
          mio,
        );
        if (mio !== relevo) {
          limpiar();
          return;
        }
        if (cargado) {
          video.classList.add("puesto");
          // `play()` puede rechazar (autoplay). No es motivo para no enseñar el
          // aviso: se ve igual, sin sonido.
          video.play().catch(() => undefined);
        } else {
          video.removeAttribute("src");
          video.load();
        }
      } else {
        imagen.src = url;
        const cargado = await esperarCargaMedio(
          imagen,
          "load",
          () => imagen.complete && imagen.naturalWidth > 0,
          mio,
        );
        if (mio !== relevo) {
          limpiar();
          return;
        }
        if (cargado) {
          imagen.classList.add("puesto");
        } else {
          imagen.removeAttribute("src");
        }
      }
    }

    if (textoDelAviso.trim()) texto.textContent = textoDelAviso;

    // Un aviso que era solo un fichero roto no tiene nada que enseñar; no ocupa el
    // turno entero ni retrasa los siguientes. Si trae texto, ese texto sigue siendo
    // una alerta valida aunque el medio haya fallado.
    if (!imagen.classList.contains("puesto") && !video.classList.contains("puesto") && !textoDelAviso.trim()) {
      enPantalla = null;
      limpiar();
      return;
    }

    // El contenedor del mensaje: **primero el estilo**, antes de que se vea nada. Si se
    // pintara despues, el primer fotograma del aviso saldria con el estilo del anterior,
    // y eso se ve como un parpadeo del fondo y de la letra.
    //
    // La animacion del mensaje se lanza mas abajo, cuando la caja ya es visible: su
    // retardo cuenta desde que la alerta ha entrado, que es lo que deja entrar primero
    // la imagen y despues el texto.
    window.DashMensaje?.aplicar(aviso.mensaje);

    if (audio && !enPrevia) {
      sonido.src = urlDeMedio(audio);
      sonido.volume = volumen;
      sonido.play().catch(() => undefined);
    }

    // El estado de partida, **antes** de que se vea nada: es lo que hace que la
    // entrada empiece de verdad donde dice la animacion en vez de dar un salto.
    const entradaMs = prepararAnimacion(aviso, "entrada");

    // Se enseña en el fotograma siguiente: si se añade la clase en el mismo
    // fotograma en que se crea el contenido, el navegador no ve el cambio y no
    // hay transicion de entrada. Con respaldo, porque el fotograma puede no llegar.
    await siguienteFotograma();
    if (mio !== relevo) {
      // Otra prueba ha tomado el relevo mientras esto se pintaba.
      limpiar();
      return;
    }
    caja.classList.add("visible");

    // La entrada del **mensaje**, con su propio retardo, su duracion y su ritmo. Va
    // despues de enseñar la caja porque su reloj empieza aqui: el retardo del mensaje se
    // cuenta desde que la alerta ha entrado, no desde que llego el aviso.
    //
    // Y es otra animacion, no esta: la alerta mueve la caja entera y el mensaje mueve su
    // bloque. Por eso el mensaje puede entrar deslizando mientras la alerta ya esta
    // quieta, que es la secuencia que se viene a montar.
    window.DashMensaje?.entrar(aviso.mensaje);

    // La permanencia arranca **cuando termina la entrada**, no antes: si empezara a la
    // vez, el temblor del efecto se comeria la entrada y no se veria ninguna de las dos.
    // Es un temporizador y no `await` porque la cola tiene que seguir contando desde
    // que el aviso entra, no desde que la permanencia empieza.
    const temporizadorPermanencia = setTimeout(() => arrancarPermanencia(aviso), entradaMs);

    // La cola espera **lo que dura la animacion mas lo que el aviso se queda**, y esa
    // cuenta la lleva esta espera, no la animacion. Es a proposito: en una pagina
    // oculta —una fuente de OBS en una escena que no se ve— el navegador puede no
    // hacer correr las animaciones, y si la cola esperase a que terminaran, no
    // volveria a salir ninguna alerta. Un atasco mudo es la peor forma de fallar.
    const visibleMs = Number.isFinite(aviso.duracion_ms) ? aviso.duracion_ms : 4000;
    const cortada = await esperar(entradaMs + visibleMs);

    clearTimeout(temporizadorPermanencia);

    if (cortada || mio !== relevo) {
      // Se retira **sin** la salida animada: la que viene tiene que entrar desde cero,
      // y encadenar salida y entrada se veria como un parpadeo.
      pararPermanencia();
      enPantalla = null;
      limpiar();
      return;
    }

    // La salida usa **su** animacion y **sus** milisegundos: quitar `visible` devuelve
    // la caja al estado que acaba de escribir el motor. Se espera lo que dura para no
    // limpiar a media transicion, que se veria como un corte.
    //
    // La permanencia se para **aqui**, con la duracion de la salida ya puesta: asi lo
    // que estuviera movido vuelve a su sitio desvaneciendose con el aviso, en vez de
    // dar un tiron justo antes de irse.
    const salidaMs = prepararAnimacion(aviso, "salida");
    pararPermanencia();
    caja.classList.remove("visible");
    await dormir(salidaMs);

    enPantalla = null;
    limpiar();
  }

  // ---------------------------------------------------------------------------
  // Conexion
  // ---------------------------------------------------------------------------

  function conectar() {
    const url =
      "ws://" +
      location.host +
      "/overlay?view=alerts&t=" +
      encodeURIComponent(token) +
      "&desde=" +
      encodeURIComponent(String(ultimoSeq)) +
      "&generacion=" +
      encodeURIComponent(String(generacion)) +
      "&origen=" +
      encodeURIComponent(enPrevia ? "previa" : "obs");
    const socket = new WebSocket(url);

    socket.onopen = () => anunciar("En directo", true);
    socket.onmessage = (evento) => {
      let mensaje;
      try {
        mensaje = JSON.parse(evento.data);
      } catch (error) {
        console.error("mensaje de alertas ilegible", error);
        return;
      }
      // Al conectar llega una foto acotada por cursor; despues, uno a uno. Ambos
      // caminos entran por `recibir`, asi que la alerta no se duplica si se cruzan.
      if (Array.isArray(mensaje.avisos)) recibirVarios(mensaje.avisos, mensaje.generacion);
      if (mensaje.aviso) recibir(mensaje.aviso, mensaje.generacion);
    };
    socket.onclose = () => {
      anunciar("Reconectando…", false);
      // OBS puede arrancar antes que la aplicacion.
      setTimeout(conectar, 2000);
    };
    socket.onerror = () => anunciar("Sin conexión con el motor", false);
  }

  conectar();
})();
