// Dibujo de los poderes: fondo, frente e indicadores.
//
// El orden de capas importa para la legibilidad (orden 04):
//
//   fondo de poderes   →  detrás de los trompos (campos, aros de aviso, espirales)
//   cuerpos            →  los trompos
//   frente de poderes  →  filos, martillos, rayos, rebotes, esquirlas (encima del cuerpo)
//   etiquetas          →  medallón de foto, arco de vida y nombre  ← nunca se tapan
//   partículas, números, tabla y carteles
//
// Todo se dibuja con Canvas 2D: gradientes, líneas, círculos, polígonos, espirales,
// rayos, ondas y deformaciones. Ni un sprite ni una imagen, salvo la foto del
// participante.

import { TAU, conAlfa, limitar, caminoRedondeado } from "../util.js";
import { caminoEspiral as espiralGeom, poligono as poligonoGeom } from "./geometria.js";
import { dibujarCuerpo } from "./disenos.js";
import { poderDeDiseno, dibujarIcono } from "../poderes.js";

/** Progreso 0..1 del momento en que esté el poder. */
function fases(t, poder) {
  const p = t.poder;
  if (p.estado === "cargando") return { estado: "cargando", k: limitar(p.t / poder.carga, 0, 1), t: p.t };
  if (p.estado === "activo") return { estado: "activo", k: limitar(p.t / poder.duracion, 0, 1), t: p.t };
  if (p.estado === "finalizando") return { estado: "finalizando", k: limitar(p.t / poder.final, 0, 1), t: p.t };
  return { estado: p.estado, k: 0, t: p.t };
}

// ------------------------------------------------------------------ fondo

export function dibujarFondoPoderes(ctx, sim) {
  for (const t of sim.trompos) {
    const p = t.poder;
    if (!p || (p.estado !== "cargando" && p.estado !== "activo" && p.estado !== "finalizando")) continue;
    const poder = poderDeDiseno(p.clave);
    const f = fases(t, poder);
    ctx.save();
    ctx.translate(t.x, t.y);
    switch (poder.clave) {
      case "cosmico":
        colapsoEstelar(ctx, t, poder, f, sim);
        break;
      case "viento":
        rafagaCortante(ctx, t, poder, f, sim);
        break;
      case "volcanico":
        avisoVolcanico(ctx, t, poder, f);
        break;
      case "velocidad":
        espiralCortante(ctx, t, poder, f);
        break;
      default:
        break;
    }
    ctx.restore();
  }
}

/** Colapso estelar: gravedad dorada con órbitas, puntos de energía y el borde del radio. */
function colapsoEstelar(ctx, t, poder, f, sim) {
  const activo = f.estado === "activo";
  const fuerza = activo
    ? limitar((poder.duracion - f.t) / (poder.final + 0.4), 0, 1)
    : f.estado === "cargando"
      ? f.k * 0.5
      : 0;
  if (fuerza <= 0.02) return;
  const r = poder.alcance * (activo ? 1 : f.estado === "cargando" ? 0.3 + 0.7 * f.k : 0.6);
  const t0 = sim.tiempo;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, conAlfa(poder.color, 0.24 * fuerza));
  g.addColorStop(0.55, conAlfa(poder.color, 0.1 * fuerza));
  g.addColorStop(1, conAlfa(poder.color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = conAlfa(poder.color, 0.35 * fuerza);
  ctx.lineWidth = 2;
  ctx.setLineDash([16, 12]);
  ctx.lineDashOffset = -t0 * 40;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 0; i < 3; i += 1) {
    const incl = 0.35 + i * 0.22;
    ctx.save();
    ctx.rotate(t0 * (0.3 + i * 0.14));
    ctx.scale(1, incl);
    ctx.strokeStyle = conAlfa(poder.color, (0.3 - i * 0.06) * fuerza);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r * (0.45 + i * 0.2), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  // Líneas que caen hacia dentro: se ve que la gravedad aprieta, no que empuja.
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * TAU + t0 * 0.4;
    const k = ((t0 * 0.7 + i / 8) % 1);
    const rr = r * (1 - k);
    ctx.strokeStyle = conAlfa(poder.color, 0.3 * fuerza * k);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr * 0.9);
    ctx.lineTo(Math.cos(a) * (rr * 0.82), Math.sin(a) * (rr * 0.82) * 0.9);
    ctx.stroke();
  }
  for (let i = 0; i < 9; i += 1) {
    const a = t0 * 0.6 + (i / 9) * TAU;
    const rr = r * (0.35 + 0.4 * (((i % 3) / 3) + 0.2));
    ctx.fillStyle = conAlfa(poder.color, 0.5 * fuerza);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.7, 2.6, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Ráfaga cortante: corriente circular que arrastra hacia dentro. */
function rafagaCortante(ctx, t, poder, f, sim) {
  const activo = f.estado === "activo";
  const fuerza = activo ? 1 : f.estado === "cargando" ? f.k : 1 - f.k;
  if (fuerza <= 0.02) return;
  const r = poder.alcance * (activo ? 1 : f.estado === "cargando" ? 0.4 + 0.6 * f.k : 1);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 4; i += 1) {
    const a0 = -sim.tiempo * (1.1 + i * 0.15) + (i / 4) * TAU;
    ctx.strokeStyle = conAlfa(poder.color, (0.32 - i * 0.05) * fuerza);
    ctx.lineWidth = 3 - i * 0.4;
    ctx.beginPath();
    ctx.arc(0, 0, r * (0.5 + i * 0.16), a0, a0 + Math.PI * 0.9);
    ctx.stroke();
  }
  // Líneas curvas hacia DENTRO: se ve que el viento arrastra, no que empuja.
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * TAU - sim.tiempo * 0.5;
    ctx.strokeStyle = conAlfa(poder.color, 0.3 * fuerza);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.quadraticCurveTo(
      Math.cos(a - 0.35) * r * 0.7,
      Math.sin(a - 0.35) * r * 0.7,
      Math.cos(a) * r * 0.32,
      Math.sin(a) * r * 0.32,
    );
    ctx.stroke();
  }
  const onda = t.poder.datos.onda;
  if (onda) {
    onda.t += 0.016;
    const k = limitar(onda.t / 0.5, 0, 1);
    if (k < 1) {
      ctx.strokeStyle = conAlfa(poder.color, 0.4 * (1 - k) * fuerza);
      ctx.lineWidth = 3 * (1 - k);
      ctx.beginPath();
      ctx.arc(0, 0, poder.alcance * (1 - k * 0.6), 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Aviso volcánico: grietas encendidas y el radio de la explosión marcado. */
function avisoVolcanico(ctx, t, poder, f) {
  if (f.estado === "finalizando") return;
  const k = f.estado === "cargando" ? f.k : 1;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  const g = ctx.createRadialGradient(0, 0, t.radio * 0.6, 0, 0, t.radio * (1.4 + 1.4 * k));
  g.addColorStop(0, conAlfa(poder.color, 0.35 * k));
  g.addColorStop(1, conAlfa(poder.color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, t.radio * (1.4 + 1.4 * k), 0, TAU);
  ctx.fill();

  const grietas = 7;
  for (let i = 0; i < grietas; i += 1) {
    const a = (i / grietas) * TAU + 0.4;
    const largo = t.radio * (0.45 + 0.55 * k);
    ctx.strokeStyle = conAlfa(i % 2 === 0 ? "#fff3c4" : poder.color, (0.35 + 0.5 * k) * (0.7 + 0.3 * Math.sin(t.fase + i)));
    ctx.lineWidth = 2 + k * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * t.radio * 0.25, Math.sin(a) * t.radio * 0.25);
    ctx.lineTo(Math.cos(a + 0.14) * largo * 0.7, Math.sin(a + 0.14) * largo * 0.7);
    ctx.lineTo(Math.cos(a - 0.05) * largo, Math.sin(a - 0.05) * largo);
    ctx.stroke();
  }

  ctx.strokeStyle = conAlfa(poder.color, 0.35 + 0.3 * k);
  ctx.lineWidth = 3;
  ctx.setLineDash([18, 14]);
  ctx.lineDashOffset = -performance.now() * 0.05;
  ctx.beginPath();
  ctx.arc(0, 0, poder.alcance * (0.35 + 0.65 * k), 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** Espiral cortante: hélice cian que crece con la velocidad. */
function espiralCortante(ctx, t, poder, f) {
  const activo = f.estado === "activo";
  const fuerza = activo ? limitar(t.poder.modificadores.velocidad ?? 1, 1, 1.6) : f.estado === "cargando" ? 0.5 + 0.5 * f.k : 1;
  const k = (fuerza - 1) / 0.5;
  if (k <= 0.02) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const vueltas = 2.4;
  const r = t.radio * (1.5 + 0.35 * k);
  ctx.strokeStyle = conAlfa(poder.color, 0.5 * k + 0.15);
  ctx.lineWidth = 2.5;
  ctx.stroke(espiralGeom(vueltas, r, 0.25, t.giro * 0.12 * 2.2));
  ctx.strokeStyle = conAlfa("#ffffff", 0.25 * k);
  ctx.lineWidth = 1.2;
  ctx.stroke(espiralGeom(vueltas, r, 0.25, t.giro * 0.12 * 2.2 + Math.PI));
  ctx.restore();
}

// ------------------------------------------------------------------ frente

export function dibujarFrentePoderes(ctx, sim) {
  for (const t of sim.trompos) {
    const p = t.poder;
    if (!p || (p.estado !== "cargando" && p.estado !== "activo" && p.estado !== "finalizando")) continue;
    const poder = poderDeDiseno(p.clave);
    const f = fases(t, poder);
    ctx.save();
    ctx.translate(t.x, t.y);
    switch (poder.clave) {
      case "ataque":
        filosRadiales(ctx, t, poder, f);
        break;
      case "defensa":
        martillosOrbitales(ctx, t, poder, f);
        break;
      case "balance":
        ondasDeRebote(ctx, t, poder, f);
        break;
      case "electrico":
        rayos(ctx, t, poder, f);
        break;
      case "cristal":
        cristalDeImpacto(ctx, t, poder, f);
        break;
      case "sombra":
        veloOscuro(ctx, t, poder, f);
        break;
      default:
        break;
    }
    ctx.restore();
  }
}

/** Filos radiales del ataque: seis hojas de energía que giran y se clavan. */
function filosRadiales(ctx, t, poder, f) {
  const activo = f.estado === "activo";
  const extension = activo ? 1 : f.estado === "cargando" ? 0.25 + 0.75 * f.k : 1 - f.k * 0.6;
  const alfa = activo ? 0.85 : f.estado === "cargando" ? 0.3 + 0.5 * f.k : 0.6 * (1 - f.k);
  if (extension <= 0.05) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.rotate(t.giro * 1.3);
  const r0 = t.radio * 0.75;
  const r1 = t.radio * (1.15 + 0.75 * extension);
  for (let i = 0; i < 6; i += 1) {
    ctx.save();
    ctx.rotate((i / 6) * TAU);
    const g = ctx.createLinearGradient(r0, 0, r1, 0);
    g.addColorStop(0, conAlfa(poder.color, 0.15 * alfa));
    g.addColorStop(0.6, conAlfa(poder.color, 0.85 * alfa));
    g.addColorStop(1, conAlfa("#fff3c4", 0.95 * alfa));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(r0, -t.radio * 0.14);
    ctx.quadraticCurveTo(r1 * 0.8, -t.radio * 0.05, r1, 0);
    ctx.quadraticCurveTo(r1 * 0.8, t.radio * 0.05, r0, t.radio * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = conAlfa(poder.color, 0.5 * alfa);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, t.radio * (1.1 + 0.5 * extension), 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/** Martillos orbitales: cuatro placas que salen en cruz y golpean su abanico. */
function martillosOrbitales(ctx, t, poder, f) {
  const golpes = t.poder.datos.martillos ?? [];
  const activo = f.estado === "activo";
  const k = activo ? limitar(f.t / 0.45, 0, 1) : f.estado === "cargando" ? -1 : 2;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Mientras carga, los martillos se ven montándose alrededor.
  if (k < 0) {
    const kk = f.k;
    ctx.rotate(t.giro * 0.8);
    for (let i = 0; i < 4; i += 1) {
      ctx.save();
      ctx.rotate((i / 4) * TAU);
      ctx.fillStyle = conAlfa(poder.color, 0.35 * kk);
      ctx.fillRect(t.radio * 0.9, -t.radio * 0.22, t.radio * 0.5 * kk, t.radio * 0.44 * kk);
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  if (k > 1.6) {
    ctx.restore();
    return;
  }

  for (const golpe of golpes) {
    const avance = limitar(k, 0, 1);
    const distancia = t.radio * 0.9 + (golpe.alcance - t.radio) * avance;
    const alfa = 1 - Math.max(0, k - 0.75) / 0.85;
    ctx.save();
    ctx.rotate(golpe.rumbo);
    // Placa del martillo.
    ctx.fillStyle = conAlfa(poder.color, 0.85 * alfa);
    ctx.fillRect(distancia - t.radio * 0.3, -t.radio * 0.34, t.radio * 0.5, t.radio * 0.68);
    ctx.strokeStyle = conAlfa("#ffffff", 0.7 * alfa);
    ctx.lineWidth = 2;
    ctx.strokeRect(distancia - t.radio * 0.3, -t.radio * 0.34, t.radio * 0.5, t.radio * 0.68);
    // Rastro del martillo.
    ctx.strokeStyle = conAlfa(poder.color, 0.3 * alfa);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(t.radio * 0.7, 0);
    ctx.lineTo(distancia - t.radio * 0.3, 0);
    ctx.stroke();
    // Onda del golpe al final del recorrido.
    if (k > 0.6) {
      const kk = (k - 0.6) / 0.4;
      ctx.strokeStyle = conAlfa("#ffffff", 0.5 * (1 - kk) * alfa);
      ctx.lineWidth = 4 * (1 - kk);
      ctx.beginPath();
      ctx.arc(0, 0, distancia, -poder.abanico / 2, poder.abanico / 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Ondas de rebote: la cadena morada, salto a salto.
 *
 * Cada salto se dibuja más flojo que el anterior (el primero es el más grueso y
 * brillante, el tercero casi un hilo): así se ve de un vistazo que la cadena pierde
 * fuerza y en qué orden ha ido.
 */
function ondasDeRebote(ctx, t, poder, f) {
  const rebotes = t.poder.datos.rebotes ?? [];
  if (!rebotes.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  rebotes.forEach((r, i) => {
    const salto = i + 1;
    const fuerza = 1 / salto; // 1, 0.5, 0.33
    const avance = limitar(r.t, 0, 1);
    const x1 = r.de.x - t.x;
    const y1 = r.de.y - t.y;
    const x2 = r.a.x - t.x;
    const y2 = r.a.y - t.y;
    // El trayecto: curva que se apaga al llegar, y más fina en cada salto.
    ctx.strokeStyle = conAlfa(poder.color, (0.8 - i * 0.2) * (1 - avance));
    ctx.lineWidth = (5 - i * 1.3) * (1 - avance) + 0.8;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo((x1 + x2) / 2 + (y2 - y1) * 0.18, (y1 + y2) / 2 - (x2 - x1) * 0.18, x2, y2);
    ctx.stroke();
    // Pulso que viaja por la curva: deja claro hacia dónde va el rebote.
    const px = x1 + (x2 - x1) * avance;
    const py = y1 + (y2 - y1) * avance;
    ctx.fillStyle = conAlfa("#ffffff", 0.8 * (1 - avance) * fuerza);
    ctx.beginPath();
    ctx.arc(px, py, 4 + 3 * fuerza, 0, TAU);
    ctx.fill();
    // La onda que revienta en el objetivo, con el tamaño del salto.
    if (avance > 0.45) {
      const kk = (avance - 0.45) / 0.55;
      ctx.strokeStyle = conAlfa(poder.color, 0.7 * (1 - kk) * fuerza);
      ctx.lineWidth = (4 * (1 - kk) + 1) * fuerza;
      ctx.beginPath();
      ctx.arc(x2, y2, t.radio * (0.7 + (2.6 - i * 0.5) * kk), 0, TAU);
      ctx.stroke();
      // El primer salto lleva además un aro blanco: es el objetivo principal.
      if (i === 0) {
        ctx.strokeStyle = conAlfa("#ffffff", 0.5 * (1 - kk));
        ctx.lineWidth = 2 * (1 - kk);
        ctx.beginPath();
        ctx.arc(x2, y2, t.radio * (1 + 1.6 * kk), 0, TAU);
        ctx.stroke();
      }
    }
  });
  ctx.restore();
}

/** Rayos: los segmentos que resolvió la mecánica, parpadeando. */
function rayos(ctx, t, poder, f) {
  const datos = t.poder.datos;
  if (!datos.rayos || !datos.rayos.length) return;
  const vida = datos.rayoTiempo ?? 0;
  if (vida > 0.45) return;
  const alfa = 1 - vida / 0.45;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const rayo of datos.rayos) {
    const semilla = Math.floor(vida * 60) + String(rayo.id).length;
    const p = caminoRayoSimple(rayo.de.x - t.x, rayo.de.y - t.y, rayo.a.x - t.x, rayo.a.y - t.y, 7, 16, semilla);
    ctx.strokeStyle = conAlfa("#ffffff", 0.85 * alfa);
    ctx.lineWidth = 2.4;
    ctx.stroke(p);
    ctx.strokeStyle = conAlfa(poder.color, 0.6 * alfa);
    ctx.lineWidth = 6;
    ctx.stroke(p);
  }
  for (const rayo of datos.rayos) {
    const x = rayo.a.x - t.x;
    const y = rayo.a.y - t.y;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 42);
    g.addColorStop(0, conAlfa("#ffffff", 0.5 * alfa));
    g.addColorStop(1, conAlfa(poder.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 42, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Gema facetada: la silueta del cristal grande.
 *
 * Se dibuja con un polígono de seis vértices (punta, dos hombros, dos caderas y base),
 * un degradado por dentro, facetas marcadas y un brillo especular. A 40 participantes
 * mide 1,5 veces el radio del trompo: se distingue de él a simple vista.
 */
function gema(ctx, x, y, r, color, giro, alfa = 1) {
  if (alfa <= 0.02 || r <= 1) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(giro);
  // Halo del cristal.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.8);
  halo.addColorStop(0, conAlfa(color, 0.4 * alfa));
  halo.addColorStop(1, conAlfa(color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.8, 0, TAU);
  ctx.fill();
  ctx.restore();

  const vertices = [
    [0, -r],
    [r * 0.72, -r * 0.34],
    [r * 0.5, r * 0.72],
    [-r * 0.5, r * 0.72],
    [-r * 0.72, -r * 0.34],
  ];
  const camino = new Path2D();
  vertices.forEach(([vx, vy], i) => (i === 0 ? camino.moveTo(vx, vy) : camino.lineTo(vx, vy)));
  camino.closePath();

  const g = ctx.createLinearGradient(-r * 0.6, -r, r * 0.6, r);
  g.addColorStop(0, conAlfa("#ffffff", 0.98 * alfa));
  g.addColorStop(0.4, conAlfa(color, 0.95 * alfa));
  g.addColorStop(1, conAlfa("#4a1330", 0.95 * alfa));
  ctx.fillStyle = g;
  ctx.fill(camino);

  // Aro oscuro de separación: sin esto el cristal se confunde con el trompo que tiene
  // detrás (el mismo problema que tenía el medallón de la foto).
  ctx.strokeStyle = `rgba(10,6,20,${0.8 * alfa})`;
  ctx.lineWidth = Math.max(3, r * 0.18);
  ctx.stroke(camino);
  // Borde blanco: la silueta facetada tiene que leerse a 40 participantes.
  ctx.strokeStyle = conAlfa("#ffffff", 0.98 * alfa);
  ctx.lineWidth = Math.max(2.2, r * 0.11);
  ctx.stroke(camino);

  // Facetas por dentro: de la punta a los hombros y la arista central.
  ctx.strokeStyle = conAlfa("#ffffff", 0.5 * alfa);
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(0, r * 0.72);
  ctx.moveTo(-r * 0.72, -r * 0.34);
  ctx.lineTo(r * 0.72, -r * 0.34);
  ctx.moveTo(-r * 0.72, -r * 0.34);
  ctx.lineTo(0, r * 0.1);
  ctx.lineTo(r * 0.72, -r * 0.34);
  ctx.stroke();

  // Brillo especular.
  ctx.fillStyle = conAlfa("#ffffff", 0.55 * alfa);
  ctx.beginPath();
  ctx.moveTo(-r * 0.3, -r * 0.72);
  ctx.lineTo(-r * 0.12, -r * 0.2);
  ctx.lineTo(r * 0.06, -r * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Cristal de Impacto: se forma durante la carga, vuela como proyectil y, **al llegar**,
 * revienta en fragmentos. Antes del impacto no hay ni un fragmento.
 */
function cristalDeImpacto(ctx, t, poder, f) {
  const datos = t.poder.datos;
  const cristal = datos.cristal;
  // El cristal es claramente más grande que el trompo: 1,6 veces su radio.
  const radioGrande = t.radio * 1.6;

  if (f.estado === "cargando" && cristal) {
    const k = f.k;
    const rumbo = Math.atan2(cristal.y1 - t.y, cristal.x1 - t.x);
    const distancia = t.radio * (1.1 + 0.55 * k);
    const x = Math.cos(rumbo) * distancia;
    const y = Math.sin(rumbo) * distancia;
    // Línea de apuntado: se ve a quién va a buscar.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = conAlfa(poder.color, 0.28 + 0.25 * k);
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 10]);
    ctx.lineDashOffset = -performance.now() * 0.05;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(cristal.x1 - t.x, cristal.y1 - t.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    gema(ctx, x, y, radioGrande * (0.35 + 0.65 * k), poder.color, t.giro * 0.5, 0.55 + 0.45 * k);
    return;
  }

  if (cristal && !cristal.golpeado) {
    // En vuelo: el cristal grande con su estela de facetas.
    const k = limitar(cristal.t, 0, 1);
    const x = (cristal.x1 - cristal.x0) * k;
    const y = (cristal.y1 - cristal.y0) * k;
    const angulo = Math.atan2(cristal.y1 - cristal.y0, cristal.x1 - cristal.x0);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Estela: tres facetas pequeñas cada vez más apagadas por detrás.
    for (let i = 1; i <= 3; i += 1) {
      const atras = i * 0.16;
      const kk = limitar(k - atras, 0, 1);
      const tx = (cristal.x1 - cristal.x0) * kk;
      const ty = (cristal.y1 - cristal.y0) * kk;
      ctx.strokeStyle = conAlfa(poder.color, 0.35 * (1 - i / 4));
      ctx.lineWidth = 6 - i * 1.4;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(angulo) * t.radio * 0.5, ty - Math.sin(angulo) * t.radio * 0.5);
      ctx.stroke();
    }
    ctx.restore();
    gema(ctx, x, y, radioGrande * (1 - 0.12 * k), poder.color, t.giro * 1.6, 1);
    return;
  }

  // Fragmentos: en abanico desde el punto del impacto, y se apagan rápido.
  const fragmentos = datos.fragmentos;
  if (!fragmentos) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const frag of fragmentos) {
    const avance = limitar(frag.t, 0, 1);
    const x = (frag.x1 - frag.x) * avance;
    const y = (frag.y1 - frag.y) * avance;
    const alfa = 1 - avance;
    // Estela del fragmento.
    ctx.strokeStyle = conAlfa(poder.color, 0.4 * alfa);
    ctx.lineWidth = 3 * alfa + 0.6;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(frag.angulo) * t.radio * 0.9, y - Math.sin(frag.angulo) * t.radio * 0.9);
    ctx.lineTo(x, y);
    ctx.stroke();
    // La esquirla: rombo pequeño girando.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(frag.angulo + t.giro * 1.4);
    ctx.fillStyle = conAlfa("#ffffff", 0.9 * alfa);
    ctx.fill(poligonoGeom(0, 0, t.radio * (0.3 - 0.1 * avance), 4, Math.PI / 4));
    ctx.restore();
    // Al final del recorrido, un chispazo.
    if (avance > 0.8) {
      const kk = (avance - 0.8) / 0.2;
      ctx.strokeStyle = conAlfa(poder.color, 0.6 * (1 - kk));
      ctx.lineWidth = 2.5 * (1 - kk);
      ctx.beginPath();
      ctx.arc(x, y, t.radio * (0.3 + 0.8 * kk), 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Velo oscuro: el cuerpo del que se desliza se apaga, pero la cara y el nombre no. */
function veloOscuro(ctx, t, poder, f) {
  const activo = f.estado === "activo";
  const alfa = activo ? poder.oscuridad : f.estado === "cargando" ? poder.oscuridad * f.k : poder.oscuridad * (1 - f.k);
  if (alfa <= 0.02) return;
  ctx.save();
  const g = ctx.createRadialGradient(0, 0, t.radio * 0.4, 0, 0, t.radio * 1.3);
  g.addColorStop(0, `rgba(10,6,22,${alfa})`);
  g.addColorStop(0.75, `rgba(24,10,44,${alfa * 0.8})`);
  g.addColorStop(1, "rgba(24,10,44,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, t.radio * 1.3, 0, TAU);
  ctx.fill();
  if (activo && f.t < 0.4) {
    const k = 1 - f.t / 0.4;
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = conAlfa(poder.color, 0.5 * k);
    ctx.lineWidth = 4 * k;
    ctx.beginPath();
    ctx.arc(0, 0, t.radio * (1.2 + (1 - k) * 1.6), 0, TAU);
    ctx.stroke();
  }
  // Imágenes residuales: copias del cuerpo en su propio rastro, detrás del velo.
  const puntos = t.rastro;
  if (activo && puntos.length >= 4) {
    for (let i = 1; i <= 2; i += 1) {
      const punto = puntos[Math.max(0, puntos.length - 1 - i * 5)];
      ctx.save();
      ctx.globalAlpha = 0.26 * (1 - i * 0.3);
      ctx.translate(punto.x - t.x, punto.y - t.y);
      ctx.rotate(punto.giro - t.giro);
      dibujarCuerpo(ctx, t.diseno, t.radio * (1 - 0.06 * i), t.vidaPct, 0.4, t.fase);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Rayo quebrado entre dos puntos (mismo criterio que los arcos del trompo eléctrico). */
function caminoRayoSimple(x1, y1, x2, y2, dientes, amplitud, semilla) {
  const p = new Path2D();
  const dx = x2 - x1;
  const dy = y2 - y1;
  const largo = Math.hypot(dx, dy) || 1;
  const nx = -dy / largo;
  const ny = dx / largo;
  p.moveTo(x1, y1);
  for (let i = 1; i < dientes; i += 1) {
    const t = i / dientes;
    const desvio = (((i * 37 + semilla * 91) % 100) / 50 - 1) * amplitud;
    p.lineTo(x1 + dx * t + nx * desvio, y1 + dy * t + ny * desvio);
  }
  p.lineTo(x2, y2);
  return p;
}

// ------------------------------------------------------------------ indicadores

/**
 * Chapa con el nombre del poder, aro de carga alrededor del trompo y aro de
 * enfriamiento. Se dibuja al final (encima de partículas) y por encima del trompo, no
 * debajo: el nombre del participante vive debajo y no se toca.
 */
export function dibujarIndicadoresPoderes(ctx, sim) {
  const p = sim.p;
  if (!p.poderes.verIndicadores) return;
  for (const t of sim.trompos) {
    const est = t.poder;
    if (!est || !t.presente) continue;
    const poder = poderDeDiseno(est.clave);
    const enCurso = est.estado === "cargando" || est.estado === "activo" || est.estado === "finalizando";
    const enfriando = est.estado === "enfriando" && est.enfriamiento > 0;
    if (!enCurso && !enfriando) continue;

    ctx.save();
    ctx.translate(t.x, t.y);

    if (est.estado === "cargando" || est.estado === "finalizando") {
      const k = est.estado === "cargando" ? limitar(est.t / poder.carga, 0, 1) : 1 - limitar(est.t / poder.final, 0, 1);
      ctx.strokeStyle = conAlfa(poder.color, 0.85);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, t.radio * 1.75, -Math.PI / 2, -Math.PI / 2 + TAU * k);
      ctx.stroke();
    }
    if (est.estado === "activo") {
      ctx.strokeStyle = conAlfa(poder.color, 0.6);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = -sim.tiempo * 60;
      ctx.beginPath();
      ctx.arc(0, 0, t.radio * 1.75, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (enfriando) {
      const k = 1 - limitar(est.enfriamiento / Math.max(0.01, poder.enfriamiento), 0, 1);
      ctx.strokeStyle = conAlfa("#9aa4b2", 0.5);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, t.radio * 1.75, -Math.PI / 2, -Math.PI / 2 + TAU * k);
      ctx.stroke();
    }

    // Chapa con el icono y el nombre del poder (o la cuenta atrás del enfriamiento).
    const comprimido = sim.p.simulacion.participantes > 20;
    const alto = comprimido ? 26 : 32;
    const tamanoTexto = comprimido ? 15 : 18;
    ctx.font = `800 ${tamanoTexto}px system-ui, 'Segoe UI', sans-serif`;
    const etiqueta = enCurso ? poder.nombre : `${Math.ceil(est.enfriamiento)} s`;
    const anchoTexto = ctx.measureText(etiqueta).width;
    const ancho = anchoTexto + alto + 18;
    const y = -t.radio - alto * 0.9 - 6;
    ctx.fillStyle = "rgba(6,5,14,0.8)";
    caminoRedondeado(ctx, -ancho / 2, y - alto / 2, ancho, alto, alto / 2);
    ctx.fill();
    ctx.strokeStyle = conAlfa(poder.color, 0.9);
    ctx.lineWidth = 2;
    ctx.stroke();
    dibujarIcono(ctx, poder, -ancho / 2 + alto * 0.5, y, alto * 0.26);
    ctx.fillStyle = enCurso ? "#ffffff" : "#9aa4b2";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(etiqueta, -ancho / 2 + alto + 6, y + 1);
    ctx.restore();
  }
}
