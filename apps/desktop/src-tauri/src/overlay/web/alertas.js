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
 */
(() => {
  const parametros = new URLSearchParams(location.search);
  const token = parametros.get("t") || "";

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

  function anunciar(mensaje, conectado) {
    if (!elAviso) return;
    elAviso.textContent = mensaje;
    elAviso.className = conectado ? "aviso conectado" : "aviso";
  }

  function dormir(ms) {
    return new Promise((seguir) => setTimeout(seguir, ms));
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

  // ---------------------------------------------------------------------------
  // La cola
  // ---------------------------------------------------------------------------

  function encolar(aviso) {
    if (!aviso) return;
    if (cola.length >= COLA_MAXIMA) {
      // Se tira el mas viejo: si hay treinta esperando, los primeros ya no
      // interesan a nadie.
      cola.shift();
      console.warn("la cola de alertas esta llena; se descarta la mas antigua");
    }
    cola.push(aviso);
    if (!representando) void sacar();
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
    caja.classList.remove("visible");
    imagen.classList.remove("puesto");
    video.classList.remove("puesto");
    video.pause();
    video.removeAttribute("src");
    sonido.pause();
    sonido.removeAttribute("src");
    texto.textContent = "";
    texto.classList.remove("error");
    imagen.removeAttribute("src");
  }

  async function representar(aviso) {
    limpiar();

    const medio = typeof aviso.medio === "string" ? aviso.medio : "";
    const audio = typeof aviso.sonido === "string" ? aviso.sonido : "";
    const textoDelAviso = typeof aviso.texto === "string" ? aviso.texto : "";
    const volumen = Number.isFinite(aviso.volumen) ? Math.min(1, Math.max(0, aviso.volumen)) : 0.8;

    // Ni medio ni texto: no hay nada que enseñar, y esperar la duracion entera
    // por nada retrasaria la cola.
    if (!medio && !textoDelAviso.trim()) return;

    let espera = 0;

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
        video.classList.add("puesto");
        // `play()` puede rechazar (autoplay). No es motivo para no enseñar el
        // aviso: se ve igual, sin sonido.
        video.play().catch(() => undefined);
      } else {
        imagen.src = url;
        imagen.classList.add("puesto");
      }
    }

    if (textoDelAviso.trim()) texto.textContent = textoDelAviso;

    if (audio) {
      sonido.src = urlDeMedio(audio);
      sonido.volume = volumen;
      sonido.play().catch(() => undefined);
    }

    // Se enseña en el fotograma siguiente: si se añade la clase en el mismo
    // fotograma en que se crea el contenido, el navegador no ve el cambio y no
    // hay transicion de entrada. Con respaldo, porque el fotograma puede no llegar.
    await siguienteFotograma();
    caja.classList.add("visible");

    espera = Number.isFinite(aviso.duracion_ms) ? aviso.duracion_ms : 4000;
    await dormir(espera);

    // Salida: se quita la clase y se deja que la transicion termine antes de
    // limpiar, para que no desaparezca de golpe.
    caja.classList.remove("visible");
    await dormir(240);
    limpiar();
  }

  // ---------------------------------------------------------------------------
  // Conexion
  // ---------------------------------------------------------------------------

  function conectar() {
    const url =
      "ws://" + location.host + "/overlay?view=alerts&t=" + encodeURIComponent(token);
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
      // Al conectar llegan los que se quedaron esperando; despues, uno a uno.
      if (Array.isArray(mensaje.avisos)) mensaje.avisos.forEach(encolar);
      if (mensaje.aviso) encolar(mensaje.aviso);
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
