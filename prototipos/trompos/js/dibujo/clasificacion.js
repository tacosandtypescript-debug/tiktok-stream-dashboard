// Tabla de clasificación dentro del lienzo (orden 02).
//
// Va arriba, en la franja reservada: la tabla no tapa la arena porque los trompos
// rebotan contra `lienzo.margenArriba`, que empieza justo debajo.
//
// Enseña cinco filas —posición, inicial, nombre, barra y porcentaje de vida y estado—
// y resume el resto en una línea («+25 participantes»). El primero se distingue con
// fondo, borde dorado y el rótulo «1.º», y la fila que cambia de vida o de puesto
// parpadea un momento: así se ve el efecto del golpe sin leer un número.

import { TAU, conAlfa, caminoRedondeado, limitar, acortarTexto } from "../util.js";
import { colorDeVida } from "./etiquetas.js";

const FLASH = 0.7; // segundos que se resalta una fila que acaba de cambiar

export class Clasificacion {
  constructor() {
    this.vidas = new Map();
    this.puestos = new Map();
    this.flash = new Map();
  }

  limpiar() {
    this.vidas.clear();
    this.puestos.clear();
    this.flash.clear();
  }

  /** Detecta cambios para el resaltado: vida que baja o puesto que se mueve. */
  actualizar(entradas, dt) {
    for (const e of entradas) {
      const antes = this.vidas.get(e.nombre);
      const puestoAntes = this.puestos.get(e.nombre);
      if (antes !== undefined && e.vida < antes - 1) {
        this.flash.set(e.nombre, FLASH);
      } else if (puestoAntes !== undefined && puestoAntes !== e.posicion) {
        this.flash.set(e.nombre, Math.max(this.flash.get(e.nombre) ?? 0, FLASH * 0.6));
      }
      this.vidas.set(e.nombre, e.vida);
      this.puestos.set(e.nombre, e.posicion);
    }
    for (const [nombre, resto] of this.flash) {
      const nuevo = resto - dt;
      if (nuevo <= 0) this.flash.delete(nombre);
      else this.flash.set(nombre, nuevo);
    }
  }

  dibujar(ctx, entradas, p, { ronda = 1, vivos = 0, total = 0 } = {}, fotos = null) {
    const c = p.clasificacion;
    const filas = entradas.slice(0, c.filas);
    ctx.save();
    ctx.textBaseline = "middle";

    // --- cabecera
    ctx.textAlign = "left";
    ctx.font = "800 19px system-ui, 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(232,240,255,0.85)";
    ctx.fillText("CLASIFICACIÓN", c.x + 6, c.y + c.altoCabecera / 2);
    ctx.textAlign = "right";
    ctx.font = "600 17px system-ui, 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(154,154,176,0.95)";
    ctx.fillText(
      `ronda ${ronda} · ${vivos} en pie de ${total}`,
      c.x + c.ancho - 6,
      c.y + c.altoCabecera / 2,
    );

    filas.forEach((e, i) => {
      const y = c.y + c.altoCabecera + 6 + i * (c.altoFila + c.separacionFilas);
      const primero = e.posicion === 1;
      const resaltado = this.flash.get(e.nombre) ?? 0;
      const pulso = resaltado > 0 ? 0.5 + 0.5 * Math.sin(resaltado * 26) : 0;

      // --- plato de la fila
      ctx.fillStyle = primero ? "rgba(52,40,12,0.82)" : "rgba(6,5,14,0.66)";
      caminoRedondeado(ctx, c.x, y, c.ancho, c.altoFila, 10);
      ctx.fill();
      if (primero) {
        ctx.strokeStyle = conAlfa("#ffd76a", 0.8 + 0.2 * pulso);
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (resaltado > 0) {
        ctx.strokeStyle = conAlfa(e.acento, 0.35 + 0.45 * pulso);
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.07)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      const medio = y + c.altoFila / 2;
      let x = c.x + 14;

      // --- puesto
      ctx.font = "800 21px system-ui, 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = primero ? "#ffd76a" : "rgba(232,240,255,0.75)";
      ctx.fillText(`${e.posicion}.º`, x, medio + 1);
      x += 58;

      // --- inicial o foto (medallón del color del jugador)
      const radio = 15;
      if (fotos) {
        fotos.medallon(ctx, x + radio, medio, radio - 1, {
          foto: e.foto,
          inicial: e.inicial,
          color: e.color,
          grosor: 2,
          fondo: primero ? "rgba(70,54,16,0.9)" : "rgba(255,255,255,0.08)",
        });
      } else {
        ctx.fillStyle = primero ? "rgba(255,215,106,0.22)" : "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.arc(x + radio, medio, radio, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = conAlfa(e.color, 0.9);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.font = "800 17px system-ui, 'Segoe UI', sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(e.inicial, x + radio, medio + 1);
      }
      x += radio * 2 + 12;

      // --- nombre (acortado si no cabe; el completo vive en los datos y en el `title`)
      ctx.textAlign = "left";
      ctx.font = `${primero ? 800 : 700} 22px system-ui, 'Segoe UI', sans-serif`;
      ctx.fillStyle = e.estado === "KO" ? "rgba(232,240,255,0.45)" : "#ffffff";
      const nombre = acortarTexto(ctx, e.nombre, 300);
      ctx.fillText(nombre, x, medio + 1);
      // Variante del diseño, si el modelo está repetido: se ve que es el mismo modelo.
      if (e.variante > 0) {
        const anchoNombre = ctx.measureText(nombre).width;
        ctx.font = "700 15px system-ui, 'Segoe UI', sans-serif";
        ctx.fillStyle = conAlfa(e.acento, 0.9);
        ctx.fillText(`· variante ${e.variante + 1}`, x + anchoNombre + 10, medio + 2);
      }

      // --- barra de vida
      const xBarra = c.x + 470;
      const anchoBarra = c.ancho - (xBarra - c.x) - 210;
      ctx.fillStyle = "rgba(10,9,18,0.85)";
      caminoRedondeado(ctx, xBarra, medio - 7, anchoBarra, 14, 7);
      ctx.fill();
      const pct = limitar(e.vidaPct, 0, 1);
      if (pct > 0) {
        ctx.fillStyle = colorDeVida(pct);
        caminoRedondeado(ctx, xBarra, medio - 7, Math.max(6, anchoBarra * pct), 14, 7);
        ctx.fill();
      }

      // --- porcentaje
      ctx.textAlign = "right";
      ctx.font = "700 20px ui-monospace, 'Cascadia Mono', monospace";
      ctx.fillStyle = "rgba(232,240,255,0.92)";
      ctx.fillText(`${Math.round(pct * 100)} %`, c.x + c.ancho - 118, medio + 1);

      // --- estado
      ctx.font = "800 15px system-ui, 'Segoe UI', sans-serif";
      const colorEstado =
        e.estado === "LÍDER"
          ? "#ffd76a"
          : e.estado === "DÉBIL"
            ? "#f87171"
            : e.estado === "KO"
              ? "#7a7a90"
              : "rgba(200,210,230,0.8)";
      ctx.fillStyle = colorEstado;
      ctx.fillText(e.estado, c.x + c.ancho - 18, medio + 1);
    });

    // --- resumen del resto: una línea fina justo debajo de la última fila
    if (entradas.length > c.filas) {
      const y =
        c.y + c.altoCabecera + 6 + c.filas * (c.altoFila + c.separacionFilas) + c.altoResumen / 2;
      ctx.textAlign = "left";
      ctx.font = "700 18px system-ui, 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(154,154,176,0.95)";
      ctx.fillText(`+${entradas.length - c.filas} participantes más`, c.x + 16, y);
    }
    ctx.restore();
  }
}
