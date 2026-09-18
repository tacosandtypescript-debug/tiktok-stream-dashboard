/* Runtime compartido de los disenos del overlay: de donde salen los datos.
 *
 * Un solo fichero para los once disenos. Lo que cambia entre ellos es **como se
 * pinta**, no de donde salen los datos: si cada diseno abriera su propio socket,
 * once Browser Sources serian once caminos de conexion distintos y bastaria
 * arreglar uno para dejar los otros diez atras.
 *
 * Dos fuentes de datos:
 *
 *   * el **directo**, por WebSocket contra el servidor de overlays (`?t=<token>`);
 *   * el **simulador** (`?demo=1`), que inventa taps en local y no abre socket.
 *     Existe para la vista previa de la pestana Overlays: sin el, juzgar un
 *     diseno obligaria a estar en directo justo en ese momento, y los disenos de
 *     juego no se podrian ni mirar.
 *
 * El contrato con un diseno es una sola funcion:
 *
 *   window.diseno = {
 *     montar(raiz, ctx) {},              // opcional, se llama una vez
 *     pintar(entradas, tasas, ctx) {},   // en cada actualizacion (~1/s)
 *   };
 *
 * `entradas` es la tabla de esa vista (puesto, persona, cifra) y `tasas` es un
 * mapa clave -> taps/segundo de la ultima actualizacion. Los disenos de juego se
 * mueven con `tasas` (quien esta tocando ahora) y los de tabla con `entradas`.
 *
 * El orden de carga importa: primero `anim.js`, despues el script del diseno
 * —que solo **define** `window.diseno`— y por ultimo este fichero, que arranca.
 */
(() => {
  const VISTAS = ["tap", "gifts", "follows"];
  const TITULOS = { tap: "Tap tap", gifts: "Regalos", follows: "Seguidores" };
  /** Personas que enseña la tabla, igual que `RANKING_TOP` en Rust. */
  const TOPE = 10;

  const parametros = new URLSearchParams(location.search);
  const vista = VISTAS.includes(parametros.get("view")) ? parametros.get("view") : "tap";
  const demo = parametros.get("demo") === "1";
  const token = parametros.get("t") || "";

  const elAviso = document.getElementById("aviso");

  const contexto = {
    vista,
    demo,
    titulo: TITULOS[vista],
    reducido: !!(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ),
    /** Que resume la cabecera: en regalos la cifra son diamantes, no personas. */
    total(entradas) {
      return vista === "gifts"
        ? entradas.reduce((suma, e) => suma + (Number(e.value) || 0), 0)
        : entradas.length;
    },
    numero(valor) {
      return Number(valor || 0).toLocaleString("es-CO");
    },
    nombre(entrada) {
      return entrada.user?.nickname || "@" + (entrada.user?.unique_id ?? "?");
    },
    anunciar(texto, conectado) {
      if (!elAviso) return;
      elAviso.textContent = texto;
      elAviso.className = conectado ? "aviso conectado" : "aviso";
    },
    /**
     * Bucle de dibujo, con red de seguridad.
     *
     * Los disenos de juego no se repintan por evento: animan a 60 fotogramas por
     * segundo y siguen entre actualizaciones. Ese bucle es el punto mas fragil de
     * todo el overlay, porque una excepcion dentro de `requestAnimationFrame`
     * **mata el bucle** y la pagina se queda quieta sin ningun sintoma: OBS sigue
     * enseñando el ultimo fotograma y no hay error en pantalla. Es exactamente lo
     * que paso con el diseno de pelotas, que se quedo congelado en un directo.
     *
     * Aqui el fallo se cuenta, sale en el aviso y **el bucle continua**: un error
     * de un fotograma no puede congelar un marcador.
     *
     * `fn` recibe la marca de tiempo del fotograma, **igual que
     * `requestAnimationFrame`**. No es un detalle: los disenos calculan su `dt`
     * con la diferencia entre dos marcas, y sin ella la resta sale `NaN`, las
     * coordenadas se vuelven `NaN` y el lienzo **no dibuja nada sin dar ningun
     * error** —el canvas ignora los trazos con coordenadas no finitas—. Se
     * descubrio porque el diseno de esgrima aparecia vacio: fichas si, personajes
     * no. La primera version de este ayudante llamaba a `fn()` a secas.
     */
    animar(fn) {
      let fallos = 0;
      const paso = (ahora) => {
        try {
          fn(ahora);
        } catch (error) {
          fallos += 1;
          // Se cuenta una sola vez: si falla en cada fotograma, sesenta lineas
          // por segundo en la consola de OBS no le sirven a nadie.
          if (fallos === 1) {
            console.error("el bucle del diseno fallo al dibujar", error);
            contexto.anunciar("Error al dibujar: " + (error?.message ?? error), false);
          }
        }
        requestAnimationFrame(paso);
      };
      requestAnimationFrame(paso);
    },
  };
  window.overlay = contexto;

  // ---------------------------------------------------------------------------
  // Ritmo de taps
  // ---------------------------------------------------------------------------

  /** Clave estable de una entrada: el id de usuario de TikTok. */
  const clave = (entrada, indice) =>
    String(entrada?.user?.id ?? entrada?.user?.unique_id ?? indice);

  /** clave -> { valor, t, suave } de la vuelta anterior. */
  const previos = new Map();

  /**
   * Taps por segundo de cada persona, suavizados.
   *
   * El overlay solo recibe la tabla agregada (~1 vez por segundo), asi que el
   * ritmo se saca de la **diferencia** entre dos actualizaciones. El suavizado
   * importa: entre dos vueltas puede caer una rafaga de 40 taps y el ritmo bruto
   * daria un pico que haria saltar el juego de golpe.
   *
   * Cuando alguien deja de tocar su tasa **baja sola**: al no llegar taps el
   * valor bruto es cero y el suavizado cae un 45% por vuelta.
   */
  function tasasDe(entradas) {
    const ahora = performance.now();
    const salida = new Map();

    entradas.forEach((entrada, indice) => {
      const k = clave(entrada, indice);
      const previo = previos.get(k);
      const valor = Number(entrada.value) || 0;

      if (!previo) {
        previos.set(k, { valor, t: ahora, suave: 0 });
        salida.set(k, 0);
        return;
      }

      const segundos = Math.max(0.2, (ahora - previo.t) / 1000);
      const bruto = Math.max(0, (valor - previo.valor) / segundos);
      const suave = previo.suave * 0.55 + bruto * 0.45;
      previos.set(k, { valor, t: ahora, suave });
      salida.set(k, suave);
    });

    // Quien ya no esta en la tabla deja de contar.
    const vivas = new Set(entradas.map(clave));
    for (const k of [...previos.keys()]) {
      if (!vivas.has(k)) previos.delete(k);
    }

    return salida;
  }

  window.ritmo = { clave, calcular: tasasDe };

  // ---------------------------------------------------------------------------
  // Reparto y arranque
  // ---------------------------------------------------------------------------

  function repartir(entradas) {
    if (typeof window.diseno?.pintar !== "function") return;
    try {
      window.diseno.pintar(entradas, tasasDe(entradas), contexto);
    } catch (error) {
      // Un fallo al pintar no puede dejar el overlay congelado **en silencio**.
      // Una excepcion dentro del bucle de dibujo fue justo lo que congelo el
      // diseno de pelotas sin que en OBS se viera nada raro: la pagina seguia
      // ahi, simplemente dejaba de moverse. Aqui sale en el aviso.
      console.error("el diseno fallo al pintar", error);
      contexto.anunciar("Error al pintar: " + (error?.message ?? error), false);
    }
  }

  function conectar() {
    const url =
      "ws://" +
      location.host +
      "/overlay?view=" +
      encodeURIComponent(vista) +
      "&t=" +
      encodeURIComponent(token);
    const socket = new WebSocket(url);

    socket.onopen = () => contexto.anunciar("En directo", true);
    socket.onmessage = (evento) => {
      try {
        const mensaje = JSON.parse(evento.data);
        repartir(mensaje[vista] ?? []);
      } catch (error) {
        console.error("mensaje de overlay ilegible", error);
      }
    };
    socket.onclose = () => {
      contexto.anunciar("Reconectando…", false);
      // OBS puede arrancar antes que la aplicacion.
      setTimeout(conectar, 2000);
    };
    socket.onerror = () => contexto.anunciar("Sin conexión con el motor", false);
  }

  // ---------------------------------------------------------------------------
  // Simulador (solo para la vista previa)
  // ---------------------------------------------------------------------------

  /** Generador determinista: la previa tiene que verse igual cada vez. */
  function mulberry32(semilla) {
    let a = semilla >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Retrato de mentira, dibujado en local.
   *
   * No se piden fotos por red a proposito: la previa tiene que funcionar sin
   * conexion y sin filtrar a nadie. Es un SVG en linea, asi que el `<img>` del
   * diseno lo trata igual que una foto de verdad (y los juegos, que la recortan
   * dentro de la cabeza, tambien).
   */
  function retratoFalso(persona) {
    const inicial = (persona.nickname || persona.unique_id || "?").slice(0, 1).toUpperCase();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${persona.color}"/>` +
      `<stop offset="1" stop-color="#0b0d12"/></linearGradient></defs>` +
      '<rect width="96" height="96" fill="url(#g)"/>' +
      `<text x="48" y="64" font-family="Segoe UI, sans-serif" font-size="46" font-weight="700"` +
      ` fill="#ffffff" text-anchor="middle">${inicial}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  /**
   * Elenco: doce personas para que la tabla de diez tenga recambio y se vean las
   * animaciones de entrada y de salida, no solo las de ascenso.
   *
   * `fuerza` es lo que tienden a tocar: sin gente floja y gente fuerte, todos
   * subirian a la vez y el orden no cambiaria nunca.
   */
  const ELENCO = [
    { id: "s01", unique_id: "vane_rt", nickname: "Vanessa", color: "#ff2e63", fuerza: 0.95 },
    { id: "s02", unique_id: "elcarlos", nickname: "Carlos M.", color: "#25f4ee", fuerza: 1.35 },
    { id: "s03", unique_id: "lupe_99", nickname: "Lupe", color: "#f5c451", fuerza: 0.7 },
    { id: "s04", unique_id: "drakoft", nickname: "Drako", color: "#3ddc97", fuerza: 1.15 },
    { id: "s05", unique_id: "mariamar", nickname: "Mariana", color: "#a56bff", fuerza: 0.85 },
    { id: "s06", unique_id: "juanpa", nickname: "Juan Pablo", color: "#ff8a3d", fuerza: 1.5 },
    { id: "s07", unique_id: "sofi_g", nickname: "Sofi", color: "#4d9bff", fuerza: 0.6 },
    { id: "s08", unique_id: "richi", nickname: "Ricardo", color: "#ff5ec4", fuerza: 1.05 },
    { id: "s09", unique_id: "nando_x", nickname: "Fernando", color: "#7ee787", fuerza: 0.9 },
    { id: "s10", unique_id: "camilo_r", nickname: "Camilo", color: "#e8564b", fuerza: 1.25 },
    { id: "s11", unique_id: "paolita", nickname: "Paola", color: "#c9a227", fuerza: 0.75 },
    { id: "s12", unique_id: "andresit", nickname: "Andrés", color: "#12b8a6", fuerza: 1.1 },
  ];

  function simulador() {
    contexto.anunciar("Simulador", true);

    const azar = mulberry32(0x5eed17);
    const retratos = new Map(ELENCO.map((p) => [p.id, retratoFalso(p)]));
    const gente = new Map(ELENCO.map((p) => [p.id, p]));
    /** Valor acumulado y ganas de tocar de cada persona. */
    const valor = new Map();
    const ganas = new Map();
    let activos = ELENCO.slice(0, TOPE).map((p) => p.id);
    let vueltas = 0;

    function paso() {
      vueltas += 1;

      // 1. Cada activo ajusta sus ganas: un paseo aleatorio que vuelve hacia su
      //    caracter, con rafagas cortas de quien se pica.
      for (const id of activos) {
        const persona = gente.get(id);
        let g = ganas.get(id) ?? 0.6 + azar() * 0.9;
        if (azar() < 0.16) g += 1.6 + azar() * 1.4;
        g = Math.max(0.05, Math.min(3.4, g * 0.86 + persona.fuerza * 0.14));
        ganas.set(id, g);
        // Taps enteros: los likes de verdad llegan de uno en uno.
        const taps = Math.max(0, Math.round(g * (0.6 + azar() * 0.9)));
        valor.set(id, (valor.get(id) || 0) + taps);
      }

      // 2. Cada tanto sale el ultimo y entra alguien del recambio, a media tabla.
      //    Es lo que hace que se vean las animaciones de entrada y de salida.
      if (vueltas % 13 === 0) {
        const dentro = ELENCO.map((p) => p.id).find((id) => !activos.includes(id));
        if (dentro) {
          activos = [...activos.slice(0, activos.length - 1), dentro];
          const tabla = activos.map((id) => valor.get(id) || 0).sort((a, b) => b - a);
          valor.set(dentro, Math.round((tabla[Math.floor(TOPE / 2)] || 0) * 0.92));
          ganas.set(dentro, 1.3 + azar());
        }
      }

      // 3. La tabla que veria el overlay: los diez primeros por valor.
      const entradas = activos
        .map((id) => ({ persona: gente.get(id), acumulado: valor.get(id) || 0 }))
        .sort((a, b) => b.acumulado - a.acumulado)
        .slice(0, TOPE)
        .map(({ persona, acumulado }) => ({
          user: {
            id: persona.id,
            unique_id: persona.unique_id,
            nickname: persona.nickname,
            avatar_url: retratos.get(persona.id),
          },
          value: acumulado,
          events: Math.max(1, Math.round(acumulado / 6)),
        }));

      repartir(entradas);
    }

    paso();
    // El mismo ritmo que el directo: `publish_rankings` coalesce a 1/s. Una
    // previa mas rapida mentiria sobre como se ve el overlay de verdad.
    setInterval(paso, 1000);
  }

  // ---------------------------------------------------------------------------

  function arrancar() {
    const diseno = window.diseno;
    if (typeof diseno?.pintar !== "function") {
      contexto.anunciar("Este diseño no cargó", false);
      console.error("el diseno no definio window.diseno.pintar");
      return;
    }

    try {
      if (typeof diseno.montar === "function") {
        diseno.montar(document.getElementById("raiz") || document.body, contexto);
      }
    } catch (error) {
      console.error("el diseno fallo al montar", error);
      contexto.anunciar("Error al montar: " + (error?.message ?? error), false);
      return;
    }

    document.body.dataset.vista = vista;
    if (demo) simulador();
    else conectar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", arrancar, { once: true });
  } else {
    arrancar();
  }
})();
