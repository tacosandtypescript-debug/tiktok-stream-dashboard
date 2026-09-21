// Tabla de posiciones completa (la que va fuera del lienzo, en el taller).
//
// La tabla compacta del overlay vive en `dibujo/clasificacion.js`; esta de aquí es la
// de revisión: los 40 participantes con su foto, su nombre entero, la vida, el estado
// y los KOs. Va en HTML y no dentro del lienzo a propósito: el lienzo es el overlay que
// irá a OBS y tiene que quedar limpio.
//
// Se repinta sólo cuando cambia algo (firma de texto), no en cada paso de física.
// Orden 03: cada fila lleva la **foto** del participante (con la inicial de respaldo si
// la imagen no carga) y el nombre completo en el `title`, aunque en la fila se acorte.

import { limitar, acortarTexto } from "./util.js";

/**
 * Contexto de medida para acortar nombres. Se crea una sola vez: crear un canvas por
 * fila y por refresco sería tirar el trabajo.
 */
let ctxMedida = null;
function medidor() {
  if (!ctxMedida && typeof document !== "undefined") {
    ctxMedida = document.createElement("canvas").getContext("2d");
  }
  if (ctxMedida) ctxMedida.font = "700 14px system-ui, 'Segoe UI', sans-serif";
  return ctxMedida;
}

export class Tabla {
  constructor(elemento) {
    this.el = elemento;
    this.firma = "";
    this.filas = new Map();
    if (this.el) {
      this.el.innerHTML = `
        <div class="tabla-cabecera" role="row">
          <span>#</span><span>Participante</span><span>Vida</span><span>Estado</span><span>KOs</span>
        </div>
        <div class="tabla-cuerpo"></div>`;
      this.cuerpo = this.el.querySelector(".tabla-cuerpo");
      this.el.setAttribute("role", "table");
    }
  }

  /** Orden: vivos por vida descendente, después los eliminados por orden de caída. */
  static ordenar(trompos) {
    return [...trompos].sort((a, b) => {
      const vivoA = a.activo ? 0 : 1;
      const vivoB = b.activo ? 0 : 1;
      if (vivoA !== vivoB) return vivoA - vivoB;
      if (vivoA === 0) return b.vida - a.vida;
      return (a.momentoMuerte ?? 0) - (b.momentoMuerte ?? 0);
    });
  }

  static estadoDe(t, lider, fase) {
    if (!t.activo) return t.motivo === "retirado" ? "RETIRADO" : "KO";
    if (fase === "espera" || fase === "aparicion" || fase === "cuenta") return "LISTO";
    if (lider && t === lider) return "LÍDER";
    if (t.vidaPct < 0.33) return "DÉBIL";
    return "ACTIVO";
  }

  actualizar(trompos, { fase, lider } = {}) {
    if (!this.el) return;
    const filas = Tabla.ordenar(trompos);
    const firma = filas
      .map((t, i) => `${i}|${t.nombre}|${t.foto}|${Math.round(t.vida)}|${t.activo ? 1 : 0}|${t.eliminaciones}`)
      .join(";");
    if (firma === this.firma) return;
    this.firma = firma;

    const vivas = new Set();
    filas.forEach((t, i) => {
      const estado = Tabla.estadoDe(t, lider, fase);
      vivas.add(t.id);
      let fila = this.filas.get(t.id);
      if (!fila) {
        fila = document.createElement("div");
        fila.className = "tabla-fila";
        fila.setAttribute("role", "row");
        fila.innerHTML = `<span class="pos"></span>
          <span class="quien">
            <span class="foto"><i class="inicial"></i><img alt="" /></span>
            <b class="nombre"></b>
          </span>
          <span class="vida"><b class="num"></b><i class="barra"><u></u></i></span>
          <span class="estado"></span><span class="kos"></span>`;
        const img = fila.querySelector(".foto img");
        // Si la foto no carga, se esconde la imagen y queda la inicial con el color
        // del jugador: nunca un hueco roto.
        img.addEventListener("error", () => {
          img.dataset.fallo = "1";
        });
        img.addEventListener("load", () => {
          delete img.dataset.fallo;
        });
        this.filas.set(t.id, fila);
      }

      const pct = limitar(t.vidaPct, 0, 1);
      const foto = fila.querySelector(".foto");
      const img = fila.querySelector(".foto img");
      const inicial = fila.querySelector(".inicial");
      foto.style.setProperty("--color", t.color);
      inicial.textContent = t.inicial;
      if (t.foto) {
        if (img.getAttribute("src") !== t.foto) {
          delete img.dataset.fallo;
          img.setAttribute("src", t.foto);
        }
      } else {
        // Sin foto: se queda la inicial, sin pedir nada al servidor.
        img.removeAttribute("src");
        img.dataset.fallo = "1";
      }

      fila.querySelector(".pos").textContent = String(i + 1);
      const nombre = fila.querySelector(".nombre");
      // El nombre entero, siempre disponible aunque la fila lo acorte: va en el
      // `title` y en un `data-` (orden 03: truncar sin perder el nombre completo).
      fila.title = `${t.nombre} · ${t.diseno.nombre}${t.diseno.variante ? ` (variante ${t.diseno.variante + 1})` : ""} · ${Math.round(t.vida)} / ${t.vidaMax} de vida · ${estado}`;
      fila.dataset.nombreCompleto = t.nombre;
      nombre.textContent = acortarTexto(medidor(), t.nombre, 260);

      fila.querySelector(".num").textContent = Math.round(t.vida);
      const barra = fila.querySelector(".barra u");
      barra.style.width = `${(pct * 100).toFixed(1)}%`;
      barra.style.background = pct > 0.66 ? "#4ade80" : pct > 0.33 ? "#fbbf24" : "#f87171";
      const estadoEl = fila.querySelector(".estado");
      estadoEl.textContent = estado;
      estadoEl.dataset.estado = estado;
      fila.querySelector(".kos").textContent = t.eliminaciones > 0 ? `×${t.eliminaciones}` : "—";
      fila.classList.toggle("es-lider", estado === "LÍDER");
      fila.classList.toggle("es-ko", !t.activo);
    });

    // Se reordenan las filas existentes (mover nodos ya creados) en vez de
    // reconstruir la tabla: así no se pierden los nodos ni parpadea.
    for (const [id, fila] of this.filas) {
      if (!vivas.has(id)) {
        fila.remove();
        this.filas.delete(id);
      }
    }
    filas.forEach((t) => this.cuerpo.appendChild(this.filas.get(t.id)));
  }

  limpiar() {
    if (!this.el) return;
    this.firma = "";
    this.filas.clear();
    if (this.cuerpo) this.cuerpo.innerHTML = "";
  }
}
