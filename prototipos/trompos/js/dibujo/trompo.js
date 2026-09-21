// Composición de un trompo en pantalla: rastro, aura, cuerpo, órbitas y daño.
//
// Las etiquetas (arco de vida, nombre, inicial) viven en `etiquetas.js`, porque se
// colocan todas juntas al final para que no se pisen entre ellas.
//
// Orden de capas del cuerpo (de atrás hacia delante): aura → órbitas traseras →
// plato y palas → órbitas delanteras → grietas de daño.

import { TAU, conAlfa, suavizar, sombraDeApoyo } from "../util.js";
import { dibujarAura, dibujarCuerpo, dibujarOrbitas, dibujarDanio, colorDe } from "./disenos.js";
import { dibujarEtiquetas, colorDeVida } from "./etiquetas.js";

export { colorDeVida };

/**
 * Rastros de todos los trompos, agrupados por diseño.
 *
 * Se dibuja con **tres trazos por tramo** de anchura y opacidad decrecientes en vez de
 * un círculo por punto: con cuarenta trompos y dieciocho puntos cada uno eran 720
 * rellenos aditivos por fotograma. Y los trompos del mismo diseño tienen el mismo
 * radio, así que sus trazos se juntan en un solo camino: 30 trazos en total en vez de
 * 120. Medido en Chrome con GPU: 43 → 55 fps con cuarenta participantes.
 */
export function dibujarRastros(ctx, trompos, p) {
  if (!p.aspecto.verRastro) return;
  const grupos = new Map();
  for (const tr of trompos) {
    if (tr.rastro.length < 3) continue;
    const grupo = grupos.get(tr.diseno.clave) ?? { diseno: tr.diseno, lista: [] };
    grupo.lista.push(tr);
    grupos.set(tr.diseno.clave, grupo);
  }
  if (!grupos.size) return;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const tramos = 3;
  for (const { diseno, lista } of grupos.values()) {
    const ancho = lista[0].radio * diseno.rastro.ancho;
    const vidaMedia = lista.reduce((s, t) => s + t.vidaPct, 0) / lista.length;
    for (let k = 0; k < tramos; k += 1) {
      const camino = new Path2D();
      let hay = false;
      for (const tr of lista) {
        const n = tr.rastro.length;
        const desde = Math.floor((k / tramos) * n);
        const hasta = Math.floor(((k + 1) / tramos) * n);
        if (hasta - desde < 2) continue;
        camino.moveTo(tr.rastro[desde].x, tr.rastro[desde].y);
        for (let i = desde + 1; i < hasta; i += 1) camino.lineTo(tr.rastro[i].x, tr.rastro[i].y);
        hay = true;
      }
      if (!hay) continue;
      const kk = (k + 1) / tramos;
      ctx.strokeStyle = conAlfa(colorDe(diseno, "claro"), (0.05 + 0.22 * kk * kk) * vidaMedia);
      ctx.lineWidth = Math.max(1, ancho * (0.35 + 0.65 * kk));
      ctx.stroke(camino);
    }
  }
  ctx.restore();
}

/**
 * El cuerpo del trompo, sin etiqueta. `t` es el tiempo acumulado (giros y pulsos).
 *
 * Todo lo que se dibuja aquí sale del radio del trompo, así que la escala por número
 * de participantes (orden 02) se aplica sola: aura, plato, anillos, palas, patrones,
 * núcleo, órbitas, grietas y sombra.
 */
export function dibujarTrompo(ctx, tr, t, p) {
  if (tr.estado === "fuera") return;
  const aparece = suavizar(tr.aparicion);
  const alfa = aparece * (1 - tr.muerte);
  if (alfa <= 0.02) return;

  const vida = tr.vidaPct;
  const debil = vida < p.vida.baja;
  const inestable = debil ? 1 - vida / p.vida.baja : 0;

  // Parpadeo moderado cuando está bajo: se nota que está a punto de romperse. Con
  // muchos trompos el parpadeo es más suave, para no convertir la arena en un estrobo.
  const amplitudParpadeo = p.simulacion.participantes > 20 ? 0.16 : 0.26;
  const parpadeo = debil ? 1 - amplitudParpadeo * (0.5 + 0.5 * Math.sin(t * 16 + tr.fase)) : 1;
  // Movimiento inestable: bamboleo y achatado, sólo visual (no toca la física).
  const bamboleoX = Math.sin(t * 8.5 + tr.fase) * tr.radio * 0.09 * inestable;
  const bamboleoY = Math.cos(t * 6.7 + tr.fase * 1.6) * tr.radio * 0.07 * inestable;
  const aplaste = 1 - 0.1 * inestable;
  const apareceEscala = 0.6 + 0.4 * aparece;

  ctx.save();
  ctx.globalAlpha = alfa * parpadeo;
  ctx.translate(tr.x + bamboleoX, tr.y + bamboleoY);
  ctx.scale(apareceEscala, apareceEscala);

  // Sombra de apoyo en el suelo imaginario: da peso, sobre todo al aparecer. Con el
  // trompo pequeño se ahorra (es un degradado radial por trompo y fotograma y a 34 px
  // de radio casi no se ve).
  if (tr.activo && tr.radio >= 46) sombraDeApoyo(ctx, tr.radio, 0.4 + 0.6 * vida);

  const recorteAura = p.efectos.recorteAura ?? 1;
  dibujarAura(ctx, tr.diseno, tr.radio, vida, tr.esLider, t, tr.fase, recorteAura);
  if (p.aspecto.verOrbitas) dibujarOrbitas(ctx, tr.diseno, tr.radio, t, tr.fase, "atras");

  ctx.save();
  ctx.rotate(tr.giro);
  ctx.scale(1, aplaste);
  dibujarCuerpo(ctx, tr.diseno, tr.radio, vida, t, tr.fase);
  ctx.restore();

  if (p.aspecto.verOrbitas) dibujarOrbitas(ctx, tr.diseno, tr.radio, t, tr.fase, "delante");
  dibujarDanio(ctx, tr.diseno, tr.radio, tr.danio, tr.fase, t);

  if (p.aspecto.verRadios) {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, tr.radio, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Todos los trompos en una pasada: rastros y cuerpos ordenados por altura.
 *
 * Va separado de las etiquetas porque **los poderes se dibujan en medio** (orden 04):
 * los efectos grandes van detrás de los cuerpos y los del frente justo después, pero
 * siempre por debajo de los nombres, el medallón y el arco de vida.
 */
export function dibujarCuerpos(ctx, trompos, t, p) {
  const orden = [...trompos].sort((a, b) => a.y - b.y);
  dibujarRastros(ctx, orden, p);
  for (const tr of orden) dibujarTrompo(ctx, tr, t, p);
  return orden;
}

/**
 * Todo junto (cuerpos + etiquetas), para quien no necesite intercalar nada: la lámina
 * de identidades y las pruebas.
 */
export function dibujarTrompos(ctx, trompos, t, p, fotos) {
  const orden = dibujarCuerpos(ctx, trompos, t, p);
  dibujarEtiquetas(ctx, orden, t, p, fotos);
}
