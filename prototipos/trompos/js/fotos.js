// Fotos de los participantes: carga, caché y medallón circular.
//
// La foto va en un **medallón dentro del núcleo** del trompo: máscara circular,
// recorte centrado sin deformar, borde del color del jugador. Nunca es el cuerpo del
// trompo —el cuerpo lo sigue generando el Canvas— ni un sprite: es la cara de una
// persona puesta en una pieza que se dibuja por código.
//
// Tres estados posibles de una foto, y los tres se ven en pantalla:
//   * **listo**: se pinta la imagen recortada en círculo;
//   * **cargando**: se pinta la inicial (y cambia sola cuando termina de cargar);
//   * **fallo** (404, formato roto, sin red): se pinta la inicial sobre el color del
//     jugador. Nunca queda un hueco vacío.
//
// Y un cuarto caso: `foto` a `null`, que es «este participante no tiene foto».

import { TAU } from "./util.js";

export class Fotos {
  constructor() {
    /** url -> { estado, img, url }. `estado`: cargando | listo | fallo | sin-navegador */
    this.mapa = new Map();
    /**
     * Medallones ya recortados, por (foto, inicial, color, tamaño, estado).
     *
     * Por qué una caché: recortar un `<img>` con `clip()` y `drawImage` cuesta caro y
     * con cuarenta participantes son cuarenta recortes por fotograma. El recorte no
     * cambia entre fotogramas, así que se hace una vez y se pega el resultado. Esto NO
     * es un sprite del trompo: el cuerpo se sigue dibujando por código; lo único que se
     * guarda es la foto ya en círculo.
     */
    this.capas = new Map();
    this.listos = 0;
    this.fallos = 0;
    this.pedidas = 0;
  }

  /** Devuelve el registro de una foto, pidiéndola la primera vez. */
  registro(url) {
    if (!url) return { estado: "sin-foto", img: null, url: null };
    const guardado = this.mapa.get(url);
    if (guardado) return guardado;

    const reg = { estado: "cargando", img: null, url };
    this.mapa.set(url, reg);
    this.pedidas += 1;

    // En Node (banco de física) no hay `Image`: se queda en respaldo y no pasa nada.
    if (typeof Image === "undefined") {
      reg.estado = "sin-navegador";
      return reg;
    }

    const img = new Image();
    // Sin `crossOrigin`: las fotos son del propio servidor del prototipo. Cuando sean
    // de TikTok habrá que decidir si se cachean en el motor, como las portadas de voz.
    img.onload = () => {
      reg.estado = "listo";
      reg.img = img;
      this.listos += 1;
    };
    img.onerror = () => {
      reg.estado = "fallo";
      this.fallos += 1;
    };
    img.src = url;
    reg.img = img;
    return reg;
  }

  /** ¿Se puede pintar la foto de verdad? */
  utilizable(url) {
    return this.registro(url).estado === "listo";
  }

  /**
   * Medallón circular: foto recortada y centrada, o inicial de respaldo.
   *
   * @param radio   radio del medallón
   * @param datos   { foto, inicial, color, grosor, fondo }
   */
  medallon(ctx, x, y, radio, datos) {
    const { foto, inicial = "?", color = "#7fd7ff", grosor = 2.5 } = datos;
    const reg = this.registro(foto);
    const r = Math.max(4, radio);
    const lado = Math.max(8, Math.round(r * 2));

    // Mientras la foto va por la red se dibuja el respaldo sin cachear: en cuanto
    // llegue, la clave cambia y se recorta la foto de verdad.
    const clave = `${foto ?? "-"}|${inicial}|${color}|${lado}|${reg.estado}`;
    let capa = reg.estado === "cargando" ? null : this.capas.get(clave);
    if (!capa && reg.estado !== "cargando") {
      capa = this.crearCapa(lado, datos, reg);
      if (capa) {
        if (this.capas.size > 320) this.capas.clear(); // cambio de escala: se rehace
        this.capas.set(clave, capa);
      }
    }

    ctx.save();
    if (capa) {
      ctx.drawImage(capa, x - lado / 2, y - lado / 2);
    } else {
      this.pintarRespaldo(ctx, x, y, lado / 2, inicial, color, datos.fondo);
    }

    // Aro oscuro de separación: despega el medallón del cuerpo del trompo, que detrás
    // tiene plato, patrón y palas del mismo tono.
    const separacion = datos.separacion ?? 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r + separacion / 2, 0, TAU);
    ctx.strokeStyle = "rgba(6,5,14,0.85)";
    ctx.lineWidth = separacion;
    ctx.stroke();

    // Aro del color del jugador: es lo que identifica aunque la foto no cargue.
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.strokeStyle = color;
    ctx.lineWidth = grosor;
    ctx.stroke();
    ctx.restore();
  }

  /** Recorta la foto (o pinta el respaldo) una sola vez, en un lienzo aparte. */
  crearCapa(lado, datos, reg) {
    if (typeof document === "undefined") return null;
    const capa = document.createElement("canvas");
    capa.width = lado;
    capa.height = lado;
    const ctx = capa.getContext("2d");
    const r = lado / 2;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, TAU);
    ctx.clip();
    if (reg.estado === "listo" && reg.img) {
      const img = reg.img;
      const anchoImagen = img.naturalWidth || img.width || 1;
      const altoImagen = img.naturalHeight || img.height || 1;
      // Recorte "cover" y centrado: la imagen no se deforma y el centro (la cara)
      // siempre queda visible, sea cuadrada o panorámica.
      const escala = Math.max(lado / anchoImagen, lado / altoImagen);
      const dw = anchoImagen * escala;
      const dh = altoImagen * escala;
      ctx.drawImage(img, r - dw / 2, r - dh / 2, dw, dh);
    } else {
      this.pintarRespaldo(ctx, r, r, r, datos.inicial ?? "?", datos.color, datos.fondo);
    }
    return capa;
  }

  /** Respaldo: la inicial sobre el color del jugador. */
  pintarRespaldo(ctx, x, y, r, inicial, color, fondo) {
    ctx.fillStyle = fondo ?? "rgba(10,9,18,0.92)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${Math.max(8, Math.round(r * 1.15))}px system-ui, 'Segoe UI', sans-serif`;
    ctx.fillText(inicial, x, y + r * 0.06);
  }

  /** Cuántas fotos hay en cada estado, para el HUD y las pruebas. */
  estado() {
    const cuenta = { cargando: 0, listo: 0, fallo: 0, "sin-navegador": 0, "sin-foto": 0 };
    for (const reg of this.mapa.values()) cuenta[reg.estado] = (cuenta[reg.estado] ?? 0) + 1;
    return {
      pedidas: this.pedidas,
      listas: this.listos,
      fallidas: this.fallos,
      medallonesEnCache: this.capas.size,
      porEstado: cuenta,
    };
  }
}
