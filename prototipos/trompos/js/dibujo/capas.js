// Capas de fase: lo que se ve antes, durante y después de la batalla.
//
// Todas se dibujan dentro del lienzo porque forman parte del overlay (la cuenta
// atrás y el cartel de ganador tienen que salir en OBS). El HUD de desarrollo, en
// cambio, vive fuera del lienzo, en HTML.
//
// Posiciones (orden 02): la cuenta atrás y la espera van en el centro de **la arena**
// (no del lienzo, que ahora tiene la clasificación arriba), y el cartel de victoria en
// la franja inferior, que es la zona reservada para los mensajes.

import { TAU, conAlfa, caminoRedondeado, limitar, entradaRapida, suavizar } from "../util.js";
import { medidaArena } from "../parametros.js";
import { colorDeVida } from "./etiquetas.js";

/** Límites de la arena (depuración y encuadre de los carteles). */
export function dibujarLimites(ctx, p) {
  const a = medidaArena(p);
  ctx.save();
  ctx.strokeStyle = "rgba(120,200,255,0.35)";
  ctx.lineWidth = 2;
  ctx.setLineDash([18, 14]);
  ctx.strokeRect(a.xMin, a.yMin, a.ancho, a.alto);
  ctx.restore();
}

/** Fase 1: esperando participantes. */
export function dibujarEspera(ctx, p, cuantos, t) {
  const a = medidaArena(p);
  const cx = a.xMin + a.ancho / 2;
  const cy = a.yMin + a.alto / 2;
  const pulso = 0.5 + 0.5 * Math.sin(t * 2.4);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 3; i += 1) {
    const k = (t * 0.35 + i / 3) % 1;
    ctx.strokeStyle = conAlfa("#7fd7ff", 0.18 * (1 - k));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 90 + k * 460, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = conAlfa("#e8f6ff", 0.75 + 0.25 * pulso);
  ctx.font = "800 46px system-ui, 'Segoe UI', sans-serif";
  ctx.fillText("ESPERANDO PARTICIPANTES", cx, cy - 20);
  ctx.fillStyle = conAlfa("#7fd7ff", 0.85);
  ctx.font = "700 34px system-ui, 'Segoe UI', sans-serif";
  ctx.fillText(`${cuantos} en la arena`, cx, cy + 44);
  ctx.restore();
}

/** Fase 3: cuenta regresiva (3, 2, 1) y el arranque. */
export function dibujarCuenta(ctx, p, valor, resto, esArranque) {
  const a = medidaArena(p);
  const cx = a.xMin + a.ancho / 2;
  const cy = a.yMin + a.alto / 2;
  const t = limitar(1 - resto, 0, 1);
  const escala = esArranque ? 0.9 + entradaRapida(t) * 0.6 : 1.5 - 0.5 * suavizar(t);
  const alfa = esArranque ? 1 - t * 0.7 : 1 - Math.pow(t, 3) * 0.35;

  ctx.save();
  ctx.globalAlpha = alfa;
  ctx.translate(cx, cy);
  ctx.scale(escala, escala);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (esArranque) {
    ctx.fillStyle = "rgba(6,5,14,0.6)";
    caminoRedondeado(ctx, -300, -70, 600, 140, 24);
    ctx.fill();
    ctx.strokeStyle = conAlfa("#ffd76a", 0.9);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#ffe9a8";
    ctx.font = "900 76px system-ui, 'Segoe UI', sans-serif";
    ctx.fillText("¡BATALLA!", 0, 4);
  } else {
    ctx.fillStyle = "rgba(6,5,14,0.42)";
    ctx.beginPath();
    ctx.arc(0, 0, 120, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = conAlfa("#7fd7ff", 0.85);
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, 132, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - t));
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 150px system-ui, 'Segoe UI', sans-serif";
    ctx.fillText(String(valor), 0, 8);
  }
  ctx.restore();
}

/** Fase 9: victoria del último trompo. Va en la franja inferior reservada. */
export function dibujarVictoria(ctx, p, ganador, resto, duracion, ronda, t) {
  const cx = p.lienzo.ancho / 2;
  // La franja inferior ya no es de los carteles: la placa de victoria se coloca con su
  // propio margen, despegada del borde.
  const cy = p.lienzo.alto - 170;
  const t2 = limitar(1 - resto / duracion, 0, 1);
  const entra = entradaRapida(limitar(t2 * 4, 0, 1));
  const color = ganador ? colorDeVida(1) : "#9aa4b2";
  const acento = ganador ? ganador.diseno.colores.acento : "#cbd5e1";

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 4; i += 1) {
    const k = (t * 0.5 + i / 4) % 1;
    ctx.strokeStyle = conAlfa(acento, 0.22 * (1 - k));
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(medidaArena(p).xMin + medidaArena(p).ancho / 2, medidaArena(p).yMin + medidaArena(p).alto / 2, 60 + k * 520, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = entra;
  ctx.translate(cx, cy - (1 - entra) * 30);

  const texto = ganador ? `¡GANA ${ganador.nombre.toUpperCase()}!` : "EMPATE EN LA ARENA";
  ctx.font = "900 62px system-ui, 'Segoe UI', sans-serif";
  const ancho = Math.max(520, ctx.measureText(texto).width + 90);
  ctx.fillStyle = "rgba(6,5,14,0.82)";
  caminoRedondeado(ctx, -ancho / 2, -76, ancho, 152, 26);
  ctx.fill();
  ctx.strokeStyle = conAlfa(color, 0.95);
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(texto, 0, -20);
  ctx.fillStyle = conAlfa(acento, 0.95);
  ctx.font = "700 30px system-ui, 'Segoe UI', sans-serif";
  const pie = ganador
    ? `${ganador.diseno.nombre} · ${ganador.eliminaciones} eliminaciones · ronda ${ronda}`
    : `ronda ${ronda}`;
  ctx.fillText(pie, 0, 40);
  ctx.restore();
}

/**
 * Aviso de estado en la esquina del lienzo (depuración). Va pegado al borde superior
 * izquierdo del propio lienzo, no al de la arena: así no se confunde con el HUD.
 */
export function dibujarFase(ctx, p, texto, t) {
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#9fd8ff";
  ctx.font = "700 22px ui-monospace, 'Cascadia Mono', monospace";
  ctx.fillText(texto, 12, p.lienzo.alto - 26);
  ctx.restore();
}

export { conAlfa };
