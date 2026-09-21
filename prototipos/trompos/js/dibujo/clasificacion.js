// Tabla de clasificación dentro del lienzo (orden 02, repartida en la orden de layout).
//
// Va en la **mitad izquierda de la franja superior**: la otra mitad es para los carteles
// de eliminación, así que la franja inferior queda entera para los trompos.
//
// Cada fila ocupa dos líneas dentro de su plato —arriba puesto, cara y nombre con su
// estado; abajo la barra de vida y el porcentaje— porque en media franja (486 px) una
// sola línea obligaría a letra diminuta o a recortar el nombre.
//
// Enseña cinco filas y resume el resto en una línea («+25 participantes más»). El primero
// se distingue con fondo, borde dorado y el rótulo «1.º», y la fila que cambia de vida o
// de puesto parpadea un momento: así se ve el efecto del golpe sin leer un número.

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
    const anchoNombre = c.anchoNombre ?? 236;
    // Diagnóstico para el banco: nombres que se acercan al estado de su fila.
    this.diagnostico = [];
    ctx.save();
    ctx.textBaseline = "middle";

    // --- cabecera: título a la izquierda y, si cabe, la ronda a la derecha
    ctx.textAlign = "left";
    ctx.font = "800 18px system-ui, 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(232,240,255,0.85)";
    ctx.fillText("CLASIFICACIÓN", c.x + 6, c.y + c.altoCabecera / 2);
    const anchoTitulo = ctx.measureText("CLASIFICACIÓN").width;
    ctx.font = "600 16px system-ui, 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(154,154,176,0.95)";
    ctx.textAlign = "right";
    ctx.fillText(
      `ronda ${ronda} · ${vivos} de ${total}`,
      c.x + c.ancho - 6,
      c.y + c.altoCabecera / 2,
    );
    void anchoTitulo;

    filas.forEach((e, i) => {
      const y = c.y + c.altoCabecera + 6 + i * (c.altoFila + c.separacionFilas);
      const primero = e.posicion === 1;
      const resaltado = this.flash.get(e.nombre) ?? 0;
      const pulso = resaltado > 0 ? 0.5 + 0.5 * Math.sin(resaltado * 26) : 0;
      const medio = y + c.altoFila / 2;
      const linea1 = medio - 8;
      const linea2 = medio + 10;

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

      let x = c.x + 10;

      // --- puesto (línea de arriba)
      ctx.font = "800 19px system-ui, 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = primero ? "#ffd76a" : "rgba(232,240,255,0.75)";
      ctx.fillText(`${e.posicion}.º`, x, linea1);
      x += 46;

      // --- medallón con la cara (o la inicial sobre el color del jugador)
      const radio = 13;
      if (fotos && p.fotos.activo) {
        fotos.medallon(ctx, x + radio, linea1, radio - 1, {
          foto: e.foto,
          inicial: e.inicial,
          color: e.color,
          grosor: 2,
          fondo: primero ? "rgba(70,54,16,0.9)" : "rgba(255,255,255,0.08)",
        });
      } else {
        ctx.fillStyle = primero ? "rgba(255,215,106,0.22)" : "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.arc(x + radio, linea1, radio, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = conAlfa(e.color, 0.9);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.font = "800 15px system-ui, 'Segoe UI', sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(e.inicial, x + radio, linea1 + 1);
      }
      x += radio * 2 + 10;

      // --- el estado se mide ANTES de escribir el nombre: su hueco se reserva, que es
      // lo que evita que el nombre (o la etiqueta de variante) se le eche encima.
      ctx.textAlign = "right";
      ctx.font = "800 14px system-ui, 'Segoe UI', sans-serif";
      const colorEstado =
        e.estado === "LÍDER"
          ? "#ffd76a"
          : e.estado === "DÉBIL"
            ? "#f87171"
            : e.estado === "KO"
              ? "#7a7a90"
              : "rgba(200,210,230,0.8)";
      const anchoEstado = ctx.measureText(e.estado).width;
      ctx.fillStyle = colorEstado;
      ctx.fillText(e.estado, c.x + c.ancho - 12, linea1);

      // --- nombre y variante dentro del hueco que queda libre
      const yEstado = c.x + c.ancho - 12 - anchoEstado;
      const espacio = yEstado - 10 - x;
      ctx.textAlign = "left";
      ctx.font = `${primero ? 800 : 700} 19px system-ui, 'Segoe UI', sans-serif`;
      ctx.fillStyle = e.estado === "KO" ? "rgba(232,240,255,0.45)" : "#ffffff";
      // Si hay variante se aparta su hueco (28 px) antes de acortar el nombre: así los
      // dos caben y ninguno pisa el estado.
      const huecoVariante = e.variante > 0 ? 28 : 0;
      const nombre = acortarTexto(ctx, e.nombre, Math.max(40, Math.min(anchoNombre, espacio - huecoVariante)));
      const anchoDibujado = ctx.measureText(nombre).width;
      ctx.fillText(nombre, x, linea1 + 1);
      let finNombre = x + anchoDibujado;
      if (e.variante > 0 && anchoDibujado + 6 + 16 <= espacio) {
        ctx.font = "700 13px system-ui, 'Segoe UI', sans-serif";
        ctx.fillStyle = conAlfa(e.acento, 0.9);
        ctx.fillText(`v${e.variante + 1}`, x + anchoDibujado + 6, linea1 + 2);
        finNombre = x + anchoDibujado + 6 + ctx.measureText(`v${e.variante + 1}`).width;
      }
      // Diagnóstico para el banco: cuánto se acercan el nombre y el estado.
      this.diagnostico.push({
        nombre: e.nombre,
        finNombre: Math.round(finNombre),
        inicioEstado: Math.round(yEstado),
        solapa: finNombre > yEstado - 4,
      });

      // --- barra de vida y porcentaje (línea de abajo)
      const pct = limitar(e.vidaPct, 0, 1);
      const xBarra = x;
      const anchoBarra = Math.max(40, c.ancho - (xBarra - c.x) - 62);
      ctx.fillStyle = "rgba(10,9,18,0.85)";
      caminoRedondeado(ctx, xBarra, linea2 - 5, anchoBarra, 11, 6);
      ctx.fill();
      if (pct > 0) {
        ctx.fillStyle = colorDeVida(pct);
        caminoRedondeado(ctx, xBarra, linea2 - 5, Math.max(6, anchoBarra * pct), 11, 6);
        ctx.fill();
      }
      ctx.textAlign = "right";
      ctx.font = "700 17px ui-monospace, 'Cascadia Mono', monospace";
      ctx.fillStyle = "rgba(232,240,255,0.92)";
      ctx.fillText(`${Math.round(pct * 100)} %`, c.x + c.ancho - 10, linea2 + 1);
    });

    // --- resumen del resto: una línea fina justo debajo de la última fila
    if (entradas.length > c.filas) {
      const y =
        c.y + c.altoCabecera + 6 + c.filas * (c.altoFila + c.separacionFilas) + c.altoResumen / 2;
      ctx.textAlign = "left";
      ctx.font = "700 16px system-ui, 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(154,154,176,0.95)";
      ctx.fillText(`+${entradas.length - c.filas} participantes más`, c.x + 12, y);
    }
    ctx.restore();
  }
}
