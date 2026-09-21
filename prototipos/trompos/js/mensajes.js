// Carteles de la arena: eliminaciones, nuevo líder y avisos de fase.
//
// El cartel de eliminación no toca la simulación: se dibuja encima y se va solo.
// La orden lo pide explícitamente («el mensaje no debe detener la simulación»), así
// que aquí no hay ni una pausa: sólo una lista con tiempos.
//
// Dónde va cada cosa (orden de layout):
//   * **eliminaciones**: **mitad derecha de la franja superior**, apiladas desde arriba
//     (la más reciente primero) y como mucho dos, para que con cuarenta participantes no
//     se apilen sin leerse. Comparten franja con la clasificación, que ocupa la mitad
//     izquierda: así **toda la franja inferior queda libre** para los trompos;
//   * **avisos cortos** (nuevo líder, poderes): justo debajo de la franja superior, en el
//     centro, donde se leen y no tapan ninguno de los dos bloques;
//   * el cartel de **victoria** (en `capas.js`) cierra la ronda con su propio margen.
//
// Animación: entrada rápida (0,16 s, escala + deslizamiento), permanencia breve y
// salida gradual (0,5 s, se desvanece hacia arriba).

import { TAU, conAlfa, caminoRedondeado, entradaRapida, limitar, acortarTexto } from "./util.js";

const ENTRADA = 0.16;
const PERMANENCIA = 1.5;
const SALIDA = 0.5;
const MAXIMOS = 3;

/** Geometría de la zona de carteles, por si el motor no pasa parámetros. */
const ZONA_POR_DEFECTO = {
  x: 560,
  y: 16,
  ancho: 486,
  altoCabecera: 22,
  altoPlato: 78,
  separacion: 10,
  maxEliminaciones: 2,
  radioMedallon: 20,
};

export class Mensajes {
  constructor() {
    this.lista = [];
  }

  limpiar() {
    this.lista.length = 0;
  }

  /**
   * @param texto   línea principal, en mayúsculas («CARLOS ELIMINÓ A ANA»)
   * @param color   color del diseño que protagoniza el cartel
   * @param tipo    "eliminacion" | "lider" | "aviso"
   * @param subtexto línea pequeña debajo (opcional)
   * @param identidad { nombre, inicial, foto, color } del protagonista: en la
   *        eliminación es quien cae, y en el aviso de líder, el nuevo líder
   */
  anunciar(texto, color, tipo = "eliminacion", subtexto = "", identidad = null) {
    if (tipo === "eliminacion") {
      // Dos eliminaciones a la vez se cuentan las dos; un aluvión, no: se queda
      // con las tres últimas para no tapar la arena.
      const eliminaciones = this.lista.filter((m) => m.tipo === "eliminacion");
      if (eliminaciones.length >= MAXIMOS) this.lista.splice(this.lista.indexOf(eliminaciones[0]), 1);
    } else {
      // De avisos cortos sólo cabe uno: son informativos y se pisan entre ellos.
      const otros = this.lista.filter((m) => m.tipo !== "eliminacion");
      if (otros.length >= 1) this.lista.splice(this.lista.indexOf(otros[0]), 1);
    }
    this.lista.push({ texto, subtexto, color, tipo, tiempo: 0, identidad });
  }

  actualizar(dt) {
    for (let i = this.lista.length - 1; i >= 0; i -= 1) {
      const m = this.lista[i];
      m.tiempo += dt;
      if (m.tiempo > ENTRADA + PERMANENCIA + SALIDA) this.lista.splice(i, 1);
    }
  }

  /** Opacidad y desplazamiento de un cartel según su tiempo. */
  faseDe(m) {
    if (m.tiempo < ENTRADA) {
      const t = entradaRapida(m.tiempo / ENTRADA);
      return { alfa: t, escala: 0.86 + 0.14 * t, subida: (1 - t) * 26 };
    }
    const pasado = m.tiempo - ENTRADA;
    if (pasado < PERMANENCIA) return { alfa: 1, escala: 1, subida: 0 };
    const t = limitar((pasado - PERMANENCIA) / SALIDA, 0, 1);
    return { alfa: 1 - t, escala: 1 - 0.04 * t, subida: -t * 30 };
  }

  /** Cuántas eliminaciones se están enseñando ahora mismo. */
  eliminacionesActivas() {
    return this.lista.filter((m) => m.tipo === "eliminacion").length;
  }

  /**
   * @param opciones.margenArriba  borde superior de la arena (los avisos van justo ahí)
   * @param opciones.carteles      zona de las eliminaciones (mitad derecha de arriba)
   * @param opciones.maxEliminaciones cuántos carteles de eliminación caben
   */
  dibujar(ctx, ancho, alto, opciones = {}) {
    if (!this.lista.length) return;
    const margenArriba = opciones.margenArriba ?? 258;
    const z = { ...ZONA_POR_DEFECTO, ...(opciones.carteles ?? {}) };
    const maxEliminaciones = opciones.maxEliminaciones ?? z.maxEliminaciones;
    const fotos = opciones.fotos ?? null;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // --- eliminaciones: en la mitad derecha de la franja superior, de arriba abajo
    const eliminaciones = this.lista.filter((m) => m.tipo === "eliminacion").slice(-maxEliminaciones);
    if (eliminaciones.length) {
      // Cabecera de la zona, hermana de la de la clasificación: los dos bloques quedan
      // alineados y se ve de un vistazo dónde está cada cosa.
      ctx.save();
      ctx.textAlign = "left";
      ctx.font = "800 18px system-ui, 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(232,240,255,0.85)";
      ctx.fillText("ELIMINACIONES", z.x + 6, z.y + z.altoCabecera / 2);
      ctx.textAlign = "right";
      ctx.font = "600 16px system-ui, 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(154,154,176,0.95)";
      ctx.fillText(`${eliminaciones.length}`, z.x + z.ancho - 6, z.y + z.altoCabecera / 2);
      ctx.restore();
    }

    let y = z.y + z.altoCabecera + 6 + z.altoPlato / 2;
    for (let i = eliminaciones.length - 1; i >= 0; i -= 1) {
      const m = eliminaciones[i];
      const { alfa, escala, subida } = this.faseDe(m);
      if (alfa <= 0.01) continue;
      const anchoTexto = z.ancho;
      const altoPlato = z.altoPlato;

      ctx.save();
      ctx.globalAlpha = alfa;
      ctx.translate(z.x + anchoTexto / 2, y + subida);
      ctx.scale(escala, escala);

      ctx.fillStyle = "rgba(6,5,14,0.8)";
      caminoRedondeado(ctx, -anchoTexto / 2, -altoPlato / 2, anchoTexto, altoPlato, 14);
      ctx.fill();
      ctx.strokeStyle = conAlfa(m.identidad?.color ?? m.color, 0.9);
      ctx.lineWidth = 3;
      ctx.stroke();

      // Barra de color del protagonista a la izquierda.
      ctx.fillStyle = m.identidad?.color ?? m.color;
      caminoRedondeado(ctx, -anchoTexto / 2 + 8, -altoPlato / 2 + 10, 7, altoPlato - 20, 4);
      ctx.fill();

      // Medallón con la cara del protagonista (orden 03): el cartel dice quién es y no
      // sólo cómo se llama. Si no hay foto, la inicial sobre su color.
      let xTexto = -anchoTexto / 2 + 26;
      if (m.identidad && fotos) {
        const radio = z.radioMedallon;
        fotos.medallon(ctx, xTexto + radio, 0, radio, {
          foto: m.identidad.foto,
          inicial: m.identidad.inicial,
          color: m.identidad.color,
          grosor: 3,
        });
        xTexto += radio * 2 + 12;
      }

      const disponible = anchoTexto / 2 - 16 - (xTexto + anchoTexto / 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = "800 26px system-ui, 'Segoe UI', sans-serif";
      ctx.fillText(acortarTexto(ctx, m.texto, Math.max(80, disponible)), xTexto, m.subtexto ? -13 : 0);
      if (m.subtexto) {
        ctx.fillStyle = conAlfa(m.identidad?.color ?? m.color, 0.95);
        ctx.font = "600 17px system-ui, 'Segoe UI', sans-serif";
        ctx.fillText(acortarTexto(ctx, m.subtexto, Math.max(80, disponible)), xTexto, 17);
      }
      ctx.restore();
      y += altoPlato + z.separacion;
    }

    // --- avisos cortos: debajo de la franja superior, centrados
    const avisos = this.lista.filter((m) => m.tipo !== "eliminacion");
    let yAviso = margenArriba + 30;
    for (const m of avisos) {
      const { alfa, escala } = this.faseDe(m);
      if (alfa <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = alfa * 0.95;
      ctx.translate(ancho / 2, yAviso);
      ctx.scale(escala, escala);
      ctx.font = "700 28px system-ui, 'Segoe UI', sans-serif";
      const anchoTexto = ctx.measureText(m.texto).width + 52 + (m.identidad && fotos ? 52 : 0);
      ctx.fillStyle = "rgba(6,5,14,0.75)";
      caminoRedondeado(ctx, -anchoTexto / 2, -24, anchoTexto, 48, 24);
      ctx.fill();
      ctx.strokeStyle = conAlfa(m.identidad?.color ?? m.color, 0.8);
      ctx.lineWidth = 2;
      ctx.stroke();
      let centro = 0;
      if (m.identidad && fotos) {
        fotos.medallon(ctx, -anchoTexto / 2 + 28, 0, 18, {
          foto: m.identidad.foto,
          inicial: m.identidad.inicial,
          color: m.identidad.color,
          grosor: 2,
        });
        centro = 26;
      }
      ctx.fillStyle = conAlfa(m.identidad?.color ?? m.color, 1);
      ctx.fillText(m.texto, centro, 1);
      ctx.restore();
      yAviso += 56;
    }
    ctx.restore();
  }

  /** Rotación de los carteles, para depuración. */
  get cuentas() {
    return { activos: this.lista.length };
  }
}

/** Sello de tiempo para el HUD (no se usa en el dibujo del overlay). */
export function segundos(ms) {
  return (ms / 1000).toFixed(1);
}

/** Punto de un círculo, usado por las capas de fase. */
export function punto(angulo, radio) {
  return { x: Math.cos(angulo) * radio, y: Math.sin(angulo) * radio };
}

export { TAU };
