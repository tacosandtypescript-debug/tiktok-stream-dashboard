/* Motor de animaciones de los disenos de tabla, compartido.
 *
 * Lo que hace, y por que:
 *
 *   1. **Las filas no se mueven todas a la vez.** Se escalona el retardo por
 *      puesto (30 ms cada una): el ojo sigue el movimiento en cascada en vez de
 *      ver un salto colectivo. Es la diferencia entre "algo cambio" y "veo quien
 *      subio".
 *   2. **Quien sale no desaparece de golpe.** Se desvanece y se pliega, y solo
 *      despues se quita del DOM. Antes desaparecia en el mismo fotograma y el
 *      resto saltaba sin explicacion.
 *   3. **La corona no se teletransporta.** Cuando el nº1 cambia de dueno, la que
 *      entra sube con un rebote corto.
 *   4. **Las barras crecen desde su valor anterior**, no desde cero: el valor
 *      nuevo se aplica en el fotograma siguiente para garantizar que el navegador
 *      vea el cambio y haya transicion.
 *   5. **Nada de esto corre en bucle** ni toca propiedades caras (nada de `blur`
 *      ni sombras animadas): el plan prohibe animaciones permanentes porque cada
 *      Browser Source de OBS es un renderer CEF mas.
 *
 * Todo respeta `prefers-reduced-motion`: con esa preferencia activa, los cambios
 * se aplican ya colocados y sin transiciones.
 */

const DURACION_MOVIMIENTO = 380;
const RETARDO_POR_PUESTO = 30;

const prefiereQuieto = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Recoge las posiciones actuales antes de cambiar el DOM.
 * Devuelve un mapa clave -> rectangulo.
 */
function recogerPosiciones(contenedor) {
  const antes = new Map();
  for (const hijo of contenedor.children) {
    antes.set(hijo.dataset.clave, hijo.getBoundingClientRect());
  }
  return antes;
}

/**
 * Lleva cada fila de su posicion vieja a la nueva (patron FLIP), escalonando el
 * retardo para que el movimiento se lea como una cascada.
 */
function animarCambioDePuesto(contenedor, antes, opciones = {}) {
  const { retardo = RETARDO_POR_PUESTO, duracion = DURACION_MOVIMIENTO } = opciones;
  const quieto = prefiereQuieto();

  [...contenedor.children].forEach((hijo, indice) => {
    const previo = antes.get(hijo.dataset.clave);

    if (!previo) {
      // Recien llegado.
      if (quieto) return;
      hijo.animate(
        [
          { opacity: 0, transform: "translateY(8px) scale(0.98)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: 300,
          delay: Math.min(indice, 6) * retardo,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "none",
        },
      );
      return;
    }

    const ahora = hijo.getBoundingClientRect();
    const dy = previo.top - ahora.top;
    if (Math.abs(dy) < 1) return;
    if (quieto) return;

    hijo.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      {
        // OJO: la variable es `duracion`, en espanol. Escribir `duration` aqui
        // lanzaba ReferenceError en cada cambio de puesto y la animacion no se
        // veia: el error solo salia por consola, asi que una comprobacion que
        // solo mire "pinta filas" no lo detecta.
        duration: duracion,
        // El escalonado va por el puesto **nuevo**, que es el que se ve.
        delay: Math.min(indice, 6) * retardo,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "none",
      },
    );
  });
}

/**
 * Quita del DOM las filas que ya no estan, desvaneciendolas antes.
 *
 * Sin esto desaparecian en el mismo fotograma del cambio y las de abajo saltaban
 * sin que se entendiera por que.
 */
function retirarAusentes(contenedor, clavesVivas) {
  const quieto = prefiereQuieto();
  for (const hijo of [...contenedor.children]) {
    if (clavesVivas.has(hijo.dataset.clave)) continue;
    if (quieto) {
      hijo.remove();
      continue;
    }
    const animacion = hijo.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-6px) scale(0.97)" },
      ],
      { duration: 200, easing: "ease-in", fill: "forwards" },
    );
    animacion.addEventListener("finish", () => hijo.remove(), { once: true });
    // Red de seguridad: si la animacion no llega a terminar (pestana oculta,
    // que es justo el caso de un Browser Source que OBS pausa), se quita igual.
    setTimeout(() => hijo.remove(), 600);
  }
}

/**
 * Coloca la corona sobre el nº1 sin teletransportarla.
 *
 * Si ya estaba en esa fila, no hace nada. Si cambia de dueno, la fila nueva no
 * tiene corona (la quito `limpiarCoronas`), asi que se crea aqui y sube con un
 * rebote corto. Es el momento que el publico mira, asi que merece el gesto.
 *
 * `esNueva` es "la corona acaba de llegar a esta fila". La condicion pide
 * `esNueva` **a secas**: la primera version pedia `!esNueva`, y como las dos
 * cosas coinciden siempre —solo se crea cuando cambia el dueno— el rebote no se
 * veia nunca. No lo delataba ningun error de consola: la corona aparecia en su
 * sitio y ya esta. Lo encontro el portado de los disenos, al tener que decidir
 * que bandera pasar.
 */
function colocarCorona(fila, { esNueva = false } = {}) {
  const caja = fila.querySelector(".retrato-caja");
  if (!caja) return;
  let corona = caja.querySelector(".corona");
  if (!corona) {
    corona = document.createElement("span");
    corona.className = "corona";
    corona.textContent = "👑";
    caja.appendChild(corona);
    // La primera vez que aparece (`esNueva` falso porque `liderPrevio` aun es
    // nulo) no se anima: no hay relevo que celebrar, el marcador se esta
    // pintando por primera vez.
    if (esNueva && !prefiereQuieto()) {
      corona.animate(
        [
          { opacity: 0, transform: "translateX(-50%) rotate(-14deg) translateY(-10px)" },
          { opacity: 1, transform: "translateX(-50%) rotate(-14deg) translateY(0)" },
        ],
        { duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
      );
    }
  }
}

/** Quita la corona de todas las filas menos la del nº1. */
function limpiarCoronas(contenedor, filaUno) {
  for (const hijo of contenedor.children) {
    if (hijo !== filaUno) hijo.querySelector(".corona")?.remove();
  }
}

/**
 * Aplica un ancho de barra en el fotograma siguiente.
 *
 * Se hace asi a proposito: si el elemento se acaba de crear con el ancho nuevo,
 * el navegador no ve ningun cambio y no hay transicion. Pintar primero un valor y
 * cambiarlo despues garantiza que la barra **crezca** en vez de aparecer llena.
 */
function animarBarra(barra, porcentaje) {
  if (prefiereQuieto()) {
    barra.style.width = porcentaje + "%";
    return;
  }
  barra.style.width = "0%";
  requestAnimationFrame(() => {
    barra.style.width = porcentaje + "%";
  });
}

window.anim = {
  recogerPosiciones,
  animarCambioDePuesto,
  retirarAusentes,
  colocarCorona,
  limpiarCoronas,
  animarBarra,
  prefiereQuieto,
};
