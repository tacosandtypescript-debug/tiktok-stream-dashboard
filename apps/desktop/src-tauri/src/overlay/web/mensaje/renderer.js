/* El pintor del contenedor del mensaje: recibe los ajustes y los pone en pantalla.
 *
 * Es el unico sitio que toca el DOM del mensaje. Recibe algo con esta forma —lo que
 * manda el motor en cada aviso, o el editor cuando se cambia un mando en vivo—:
 *
 *     { estilo, fondo, fondo_opacidad, ..., animacion, animacion_idle, animacion_texto,
 *       retardo_ms, duracion_ms, ciclo_ms, intensidad, ritmo }
 *
 * y hace tres cosas, en este orden:
 *
 *   1. **Pinta**: los ajustes se escriben como variables de CSS en el contenedor y en el
 *      texto. Nada de clases por estilo: con quince estilos y sus combinaciones, una
 *      clase por cada uno seria una hoja que crece con cada preset nuevo.
 *   2. **Anima la entrada**: el contenedor y, por separado, sus letras. El retardo es
 *      respecto a la alerta, que es lo que deja entrar primero la imagen y despues el
 *      texto.
 *   3. **Anima la permanencia**, cuando las dos entradas han terminado.
 *
 * Y una cosa que **no** hace: tocar la caja del aviso. Sus animaciones son de `alertas.js`
 * y no se mezclan. Lo unico que escribe en ella es el hueco que separa el medio del
 * mensaje, porque ese hueco es del mensaje.
 *
 * `prefers-reduced-motion`: con esa preferencia activa no se anima nada y el mensaje
 * aparece de una pieza con la alerta. La alerta si conserva su fundido corto —eso lo
 * decide `alertas.js`—, pero el movimiento se queda fuera entero.
 */
(() => {
  const config = window.DashMensajeConfig;
  const presets = window.DashMensajePresets;
  const anim = window.DashMensajeAnim;
  const textoAnim = window.DashMensajeTexto;

  let nodoCaja = null;
  let nodoMensaje = null;
  let nodoTexto = null;
  let nodoBrillo = null;

  /** Lo que hay que cancelar cuando el aviso se va o cuando llega otro. */
  const lanzadas = [];
  const temporizadores = [];

  /** Si hay un aviso en pantalla ahora mismo. */
  let enPantalla = false;
  /** Las animaciones que estan puestas, para no repetirlas si no han cambiado. */
  let puestas = { animacion: null, animacion_texto: null };

  const prefiereQuieto = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function montar() {
    nodoCaja = document.getElementById("caja");
    nodoMensaje = document.getElementById("mensaje");
    nodoTexto = document.getElementById("texto");
    nodoBrillo = document.getElementById("mensaje-brillo");
    return !!(nodoMensaje && nodoTexto);
  }

  /**
   * La sombra de la caja, a partir de un tanto por ciento.
   *
   * Un solo mando —«Sombra»— y de el salen el desplazamiento, el difuminado y la
   * opacidad: tres numeros que hay que mover a la vez para que la sombra se vea mas
   * grande sin verse mas negra. Con tres mandos, dos de ellos siempre estarian mal.
   *
   * Cuando no hay sombra se devuelve **una sombra que no se ve** y no `none`: las
   * sombras se suman en una lista, y `none` no se puede mezclar con las demas. Asi un
   * estilo que enciende el resplandor no apaga la sombra, ni al reves.
   */
  function sombra(porcentaje) {
    if (!porcentaje) return "0 0 0 transparent";
    const desplazamiento = Math.round(4 + porcentaje * 0.16);
    const difuminado = Math.round(8 + porcentaje * 0.45);
    const alfa = Math.min(0.75, 0.18 + porcentaje * 0.005).toFixed(2);
    return `0 ${desplazamiento}px ${difuminado}px rgba(0, 0, 0, ${alfa})`;
  }

  /** Las variables que salen de los ajustes, sin el estilo. */
  function base(m) {
    return {
      "--mensaje-fondo": config.rgba(m.fondo, m.fondo_opacidad),
      "--mensaje-borde": m.borde_color,
      "--mensaje-borde-grosor": `${m.borde_grosor}px`,
      "--mensaje-radio": `${m.radio}px`,
      "--mensaje-pad-h": `${m.padding_h}px`,
      "--mensaje-pad-v": `${m.padding_v}px`,
      "--mensaje-sombra": sombra(m.sombra),
      "--mensaje-glow": m.glow ? `0 0 ${m.glow}px ${m.glow_color}` : "0 0 0 transparent",
      "--mensaje-glow-color": m.glow_color,
      // El radio del resplandor, suelto: los estilos que componen el suyo —el neon—
      // necesitan el numero, no la lista entera.
      "--mensaje-glow-radio": `${m.glow}px`,
      "--mensaje-ancho": `${m.ancho_vw}vw`,
      "--mensaje-alto-min": `${m.altura_minima}px`,
      "--mensaje-blur": `${m.blur}px`,
      "--mensaje-fuente": config.FUENTES[m.fuente],
      "--mensaje-tamano": `${m.tamano}px`,
      "--mensaje-peso": String(m.peso),
      "--mensaje-color": m.color,
      "--mensaje-alineacion": config.ALINEACIONES[m.alineacion],
      "--mensaje-espaciado": `${config.decimas(m.espaciado)}px`,
      "--mensaje-interlineado": `${m.interlineado}%`,
      "--mensaje-contorno": `${config.decimas(m.contorno)}px`,
      "--mensaje-contorno-color": m.contorno_color,
      "--mensaje-sombra-texto": m.sombra_texto
        ? `0 3px ${m.sombra_texto}px rgba(0, 0, 0, 0.95)`
        : "0 0 0 transparent",
    };
  }

  /**
   * Pinta los ajustes y devuelve el mensaje ya normalizado.
   *
   * Se puede llamar tantas veces como haga falta: es lo que usa la previa del panel para
   * cambiar un mando **en vivo**, sin volver a disparar el aviso.
   */
  function aplicar(mensajeBruto) {
    if (!montar()) return null;
    const m = config.normalizar(mensajeBruto);
    const receta = presets.receta(m.estilo);
    const extras = receta.variables ? receta.variables(m) : {};

    for (const [nombre, valor] of Object.entries(Object.assign(base(m), extras))) {
      nodoMensaje.style.setProperty(nombre, String(valor));
    }

    // Los ganchos del estilo —la decoracion y el ancho completo— se ponen y se quitan:
    // un `data-deco` que se quedara de un estilo anterior seguiria dibujando su barra.
    const atributos = receta.atributos || {};
    for (const gancho of ["data-deco", "data-ancho"]) {
      if (atributos[gancho]) nodoMensaje.setAttribute(gancho, atributos[gancho]);
      else nodoMensaje.removeAttribute(gancho);
    }
    nodoMensaje.dataset.estilo = m.estilo;

    const hayTexto = nodoTexto.textContent.trim().length > 0;
    nodoMensaje.hidden = !hayTexto;
    // La separacion con el medio es el hueco de la caja del aviso, que es quien los
    // junta. Se escribe como variable y no como `gap` a pelo: asi el valor de fabrica
    // sigue estando en la hoja y quitar la propiedad devuelve ese valor.
    if (nodoCaja) nodoCaja.style.setProperty("--mensaje-separacion", `${m.separacion}px`);

    puestas = { animacion: m.animacion, animacion_texto: m.animacion_texto };
    return m;
  }

  /** Cancela las animaciones y los temporizadores en curso. */
  function pararLanzadas() {
    for (const animacion of lanzadas.splice(0)) {
      try {
        animacion.cancel();
      } catch (error) {
        // Una animacion ya terminada no se puede cancelar y no pasa nada.
      }
    }
    for (const temporizador of temporizadores.splice(0)) clearTimeout(temporizador);
  }

  /**
   * El aviso acaba de aparecer: se programa la entrada del mensaje.
   *
   * `inmediato` es para la previa del panel: alli el streamer acaba de cambiar la
   * animacion y quiere verla **ya**, no dentro del retardo que haya configurado.
   */
  function entrar(mensajeBruto, opciones) {
    const m = aplicar(mensajeBruto);
    if (!m) return;
    pararLanzadas();
    enPantalla = true;
    if (nodoMensaje.hidden) return;

    const inmediato = !!(opciones && opciones.inmediato);
    const espera = inmediato ? 0 : m.retardo_ms;
    if (espera <= 0) {
      arrancarEntrada(m);
      return;
    }
    // Mientras dura el retardo el mensaje **no se ve**, aunque no haya animacion que lo
    // esconda: poner «aparece a los 0,25 s» con la animacion en «ninguna» tiene que
    // dejar ver la imagen primero, que es exactamente la secuencia que se viene a montar.
    nodoMensaje.style.opacity = "0";
    temporizadores.push(
      setTimeout(() => {
        nodoMensaje.style.removeProperty("opacity");
        arrancarEntrada(m);
      }, espera),
    );
  }

  function arrancarEntrada(m) {
    if (!enPantalla || !nodoMensaje || nodoMensaje.hidden) return;
    const quieto = prefiereQuieto();
    let msContenedor = 0;

    const plan = quieto ? null : anim.entrada(m);
    if (plan) {
      const lanzada = nodoMensaje.animate(plan.fotogramas, plan.opciones);
      lanzadas.push(lanzada);
      msContenedor = plan.opciones.duration;
    }

    // El texto, por su cuenta: puede ir mas despacio que el contenedor, y hasta que no
    // acaba no empieza la permanencia.
    const msTexto = textoAnim.animar(nodoTexto, m, nodoTexto.textContent || "", { quieto });

    if (quieto) return;
    const total = Math.max(msContenedor, msTexto);
    temporizadores.push(setTimeout(() => arrancarPermanencia(m), total));
  }

  function arrancarPermanencia(m) {
    if (!enPantalla || !nodoMensaje || nodoMensaje.hidden) return;
    const plan = anim.permanencia(m);
    if (!plan) return;
    const objetivo = plan.capa === "brillo" ? nodoBrillo : nodoMensaje;
    if (!objetivo) return;
    lanzadas.push(objetivo.animate(plan.fotogramas, plan.opciones));
  }

  /**
   * El aviso se va: se para todo y el mensaje queda listo para el siguiente.
   *
   * El texto vuelve a ser de una pieza: si se quedo troceado por una animacion de letras,
   * las cajas se quedarian para el aviso siguiente.
   */
  function parar() {
    enPantalla = false;
    pararLanzadas();
    if (nodoMensaje) {
      // El mensaje puede haberse quedado opaco del retardo a medias: se devuelve a su
      // sitio, o el aviso siguiente saldria invisible.
      nodoMensaje.style.removeProperty("opacity");
      nodoMensaje.hidden = true;
    }
    if (nodoTexto) {
      const texto = nodoTexto.textContent || "";
      if (nodoTexto.children.length > 0) nodoTexto.textContent = texto;
    }
    if (nodoCaja) nodoCaja.style.removeProperty("--mensaje-separacion");
  }

  /**
   * Un cambio desde el editor de la previa, en vivo.
   *
   * El estilo se aplica **siempre**: mover un mando tiene que verse al instante. La
   * animacion solo se repite si ha cambiado, porque repetirla en cada tecla dejaria el
   * mensaje saltando todo el rato mientras se escribe.
   */
  function previa(mensajeBruto) {
    if (!montar()) return;
    const antes = puestas;
    const m = aplicar(mensajeBruto);
    if (!m) return;
    const cambio =
      antes.animacion !== m.animacion || antes.animacion_texto !== m.animacion_texto;
    if (cambio && enPantalla && !nodoMensaje.hidden) entrar(mensajeBruto, { inmediato: true });
  }

  window.DashMensaje = { montar, aplicar, entrar, parar, previa, sombra };
})();
