// Carteles de la arena: eliminaciones, nuevo líder y avisos de fase.
//
// El cartel de eliminación no toca la simulación: se dibuja encima y se va solo.
// La orden lo pide explícitamente («el mensaje no debe detener la simulación»), así
// que aquí no hay ni una pausa: sólo una lista con tiempos.
//
// Dónde va cada cosa (orden 02, zonas reservadas):
//   * **eliminaciones**: franja inferior, apiladas desde abajo y como mucho dos, para
//     que con cuarenta participantes no llenen la pantalla;
//   * **avisos cortos** (nuevo líder): franja superior, pegados al borde de la arena,
//     donde no estorban a las eliminaciones;
//   * el cartel de **victoria** (en `capas.js`) ocupa el centro de la franja inferior.
//
// Animación: entrada rápida (0,16 s, escala + deslizamiento), permanencia breve y
// salida gradual (0,5 s, se desvanece hacia arriba).

import { TAU, conAlfa, caminoRedondeado, entradaRapida, limitar, acortarTexto } from "./util.js";

const ENTRADA = 0.16;
const PERMANENCIA = 1.5;
const SALIDA = 0.5;
const MAXIMOS = 3;

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
   * @param opciones.margenArriba  borde superior de la arena (los avisos van ahí)
   * @param opciones.maxEliminaciones cuántos carteles de eliminación caben
   */
  dibujar(ctx, ancho, alto, opciones = {}) {
    if (!this.lista.length) return;
    const margenArriba = opciones.margenArriba ?? 258;
    const maxEliminaciones = opciones.maxEliminaciones ?? 2;
    const fotos = opciones.fotos ?? null;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // --- eliminaciones: desde abajo hacia arriba, la más reciente la primera
    const eliminaciones = this.lista.filter((m) => m.tipo === "eliminacion").slice(-maxEliminaciones);
    let y = alto - 52;
    for (let i = eliminaciones.length - 1; i >= 0; i -= 1) {
      const m = eliminaciones[i];
      const { alfa, escala, subida } = this.faseDe(m);
      if (alfa <= 0.01) continue;
      const tieneIdentidad = Boolean(m.identidad);
      const anchoTexto = Math.min(ancho * 0.86, 250 + m.texto.length * 24 + (tieneIdentidad ? 76 : 0));
      const altoPlato = m.subtexto ? 104 : 84;

      ctx.save();
      ctx.globalAlpha = alfa;
      ctx.translate(ancho / 2, y + subida);
      ctx.scale(escala, escala);

      ctx.fillStyle = "rgba(6,5,14,0.8)";
      caminoRedondeado(ctx, -anchoTexto / 2, -altoPlato / 2, anchoTexto, altoPlato, 16);
      ctx.fill();
      ctx.strokeStyle = conAlfa(m.identidad?.color ?? m.color, 0.9);
      ctx.lineWidth = 3;
      ctx.stroke();

      // Barra de color del protagonista a la izquierda.
      ctx.fillStyle = m.identidad?.color ?? m.color;
      caminoRedondeado(ctx, -anchoTexto / 2 + 8, -altoPlato / 2 + 10, 8, altoPlato - 20, 4);
      ctx.fill();

      // Medallón con la cara del protagonista, para que el cartel diga quién es y no
      // sólo cómo se llama (orden 03).
      let desplazamiento = 0;
      if (m.identidad && fotos) {
        const radio = 28;
        const xMedallon = -anchoTexto / 2 + 30 + radio;
        fotos.medallon(ctx, xMedallon, 0, radio, {
          foto: m.identidad.foto,
          inicial: m.identidad.inicial,
          color: m.identidad.color,
          grosor: 3,
        });
        desplazamiento = radio * 2 + 12;
      }

      ctx.fillStyle = "#ffffff";
      ctx.font = "800 40px system-ui, 'Segoe UI', sans-serif";
      const texto = acortarTexto(ctx, m.texto, anchoTexto - 40 - desplazamiento);
      ctx.fillText(texto, desplazamiento / 2, m.subtexto ? -14 : 0);
      if (m.subtexto) {
        ctx.fillStyle = conAlfa(m.identidad?.color ?? m.color, 0.95);
        ctx.font = "600 24px system-ui, 'Segoe UI', sans-serif";
        ctx.fillText(acortarTexto(ctx, m.subtexto, anchoTexto - 40 - desplazamiento), desplazamiento / 2, 26);
      }
      ctx.restore();
      y -= altoPlato + 16;
    }

    // --- avisos cortos: arriba, pegados al borde de la arena
    const avisos = this.lista.filter((m) => m.tipo !== "eliminacion");
    let yAviso = margenArriba + 34;
    for (const m of avisos) {
      const { alfa, escala } = this.faseDe(m);
      if (alfa <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = alfa * 0.95;
      ctx.translate(ancho / 2, yAviso);
      ctx.scale(escala, escala);
      ctx.font = "700 30px system-ui, 'Segoe UI', sans-serif";
      const anchoTexto = ctx.measureText(m.texto).width + 56 + (m.identidad && fotos ? 56 : 0);
      ctx.fillStyle = "rgba(6,5,14,0.75)";
      caminoRedondeado(ctx, -anchoTexto / 2, -26, anchoTexto, 52, 26);
      ctx.fill();
      ctx.strokeStyle = conAlfa(m.identidad?.color ?? m.color, 0.8);
      ctx.lineWidth = 2;
      ctx.stroke();
      let centro = 0;
      if (m.identidad && fotos) {
        fotos.medallon(ctx, -anchoTexto / 2 + 30, 0, 19, {
          foto: m.identidad.foto,
          inicial: m.identidad.inicial,
          color: m.identidad.color,
          grosor: 2,
        });
        centro = 28;
      }
      ctx.fillStyle = conAlfa(m.identidad?.color ?? m.color, 1);
      ctx.fillText(m.texto, centro, 1);
      ctx.restore();
      yAviso += 60;
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
