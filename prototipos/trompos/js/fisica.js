// Física de la arena.
//
// Es física programada a mano: nada de motor externo. Cada paso hace, en este orden:
//
//   1. Empuje de crucero (control proporcional) y roce exponencial.
//   2. Integración de la posición y rebote contra los límites de la arena.
//   3. Choques entre parejas: separar, impulso, daño y aviso para los efectos.
//   4. Límite de velocidad y encajonado dentro de la arena.
//
// El paso es fijo (1/120 s) y lo llama un acumulador, así que el resultado no
// depende de la frecuencia de refresco: un navegador a 30 fps y otro a 144 fps dan
// la misma batalla, sólo que uno la enseña más veces por segundo.
//
// Los límites de la arena NO son los del lienzo: arriba está la clasificación y abajo
// los carteles (orden 02), así que los rebotes usan `limitesDe(p, radio)`.

import { limitar } from "./util.js";
import { limitesDe } from "./parametros.js";

/**
 * Un paso de física.
 *
 * @param trompos   lista de trompos
 * @param dt        segundos (ya acotado)
 * @param p         parámetros
 * @param azar      azar con semilla
 * @param alImpacto callback (datos del choque) para el daño y los efectos
 */
export function pasoFisica(trompos, dt, p, azar, alImpacto) {
  const f = p.fisica;

  // --- 1 y 2: fuerzas, integración y paredes
  for (const t of trompos) {
    if (!t.activo) continue;

    // Empuje de crucero. Es la pieza que hace que esto sea una pelea y no cuarenta
    // peonzas rodando hasta pararse: cada trompo tiende a su velocidad de crucero
    // por un control proporcional, con el rumbo paseando solo.
    //
    // Un poder puede subir el crucero mientras está activo (espiral de velocidad,
    // filo radial), pero el tope de velocidad de la arena sigue siendo el de siempre:
    // la velocidad no es infinita ni de broma.
    const factorPoder = t.poder?.estado === "activo" ? (t.poder.modificadores.velocidad ?? 1) : 1;
    const crucero = f.velocidadCrucero * factorPoder;
    t.rumbo += azar.rango(-1, 1) * f.giroRumbo * dt;
    const objetivoX = Math.cos(t.rumbo) * crucero;
    const objetivoY = Math.sin(t.rumbo) * crucero;
    const k = f.empujeCrucero * dt;
    t.vx += (objetivoX - t.vx) * k;
    t.vy += (objetivoY - t.vy) * k;

    // Ruido: dos trompos con el mismo rumbo no van pegados como un tren.
    t.vx += azar.rango(-1, 1) * f.jitter * dt;
    t.vy += azar.rango(-1, 1) * f.jitter * dt;

    // Roce exponencial: v *= e^(-roce·dt). Es independiente del tamaño del paso,
    // así que da igual cuántos pasos se den por segundo.
    const amortiguacion = Math.exp(-f.roce * dt);
    t.vx *= amortiguacion;
    t.vy *= amortiguacion;

    // Integración.
    t.x += t.vx * dt;
    t.y += t.vy * dt;

    // Paredes de la arena.
    const L = limitesDe(p, t.radio);
    if (t.x < L.xMin) {
      t.x = L.xMin + (L.xMin - t.x);
      t.vx = Math.abs(t.vx) * f.rebotePared;
      t.vy *= 0.985;
    } else if (t.x > L.xMax) {
      t.x = L.xMax - (t.x - L.xMax);
      t.vx = -Math.abs(t.vx) * f.rebotePared;
      t.vy *= 0.985;
    }
    if (t.y < L.yMin) {
      t.y = L.yMin + (L.yMin - t.y);
      t.vy = Math.abs(t.vy) * f.rebotePared;
      t.vx *= 0.985;
    } else if (t.y > L.yMax) {
      t.y = L.yMax - (t.y - L.yMax);
      t.vy = -Math.abs(t.vy) * f.rebotePared;
      t.vx *= 0.985;
    }

    // El rumbo se apunta hacia donde salió rebotado: si no, el empuje de crucero
    // volvería a meterlo contra la misma pared y se quedaría pegado al borde.
    t.rumbo = Math.atan2(t.vy, t.vx);

    // Si algo lo deja casi parado, se le da el mínimo para que siga rodando.
    const rapidez = t.rapidez;
    if (rapidez < f.velocidadMinima * 0.5) {
      t.vx = Math.cos(t.rumbo) * f.velocidadMinima;
      t.vy = Math.sin(t.rumbo) * f.velocidadMinima;
    }  }

  // --- 3: choques
  // Primera pasada: separa, impulsa, cobra daño y avisa a los efectos.
  const choques = [];
  for (let i = 0; i < trompos.length; i += 1) {
    const a = trompos[i];
    if (!a.activo) continue;
    for (let j = i + 1; j < trompos.length; j += 1) {
      const b = trompos[j];
      if (!b.activo) continue;
      const choque = resolverPareja(a, b, p, azar, false);
      if (choque) choques.push(choque);
    }
  }

  // Pasadas extra: sólo separación. Con cuarenta trompos en la misma arena, una sola
  // pasada deja solapes residuales y el grupo se ve apelotonado; repetir la
  // separación los desenreda sin volver a cobrar daño ni a inventar impulsos.
  const extra = Math.max(0, Math.round(f.pasadasChoques) - 1);
  for (let pasada = 0; pasada < extra; pasada += 1) {
    for (let i = 0; i < trompos.length; i += 1) {
      const a = trompos[i];
      if (!a.activo) continue;
      for (let j = i + 1; j < trompos.length; j += 1) {
        const b = trompos[j];
        if (!b.activo) continue;
        resolverPareja(a, b, p, azar, true);
      }
    }
  }

  // --- 4: límite de velocidad (después de los impulsos, que son los que se pasan)
  for (const t of trompos) {
    if (!t.activo) continue;
    const rapidez = t.rapidez;
    if (rapidez > f.velocidadMaxima) {
      const k = f.velocidadMaxima / rapidez;
      t.vx *= k;
      t.vy *= k;
    }
    // La separación de choques es posicional y no mira las paredes: si dos trompos
    // se empujan contra el borde, uno puede acabar fuera. Se encajona aquí, una vez
    // por paso: cuesta nada y garantiza que nadie salga de la arena.
    encajonar(t, p);
  }

  // El daño y los efectos se avisan después de que la física esté cerrada: así el
  // que reacciona (efectos, mensajes, tabla) ve velocidades definitivas.
  for (const c of choques) alImpacto(c);

  return choques.length;
}

/**
 * Choque de una pareja. Devuelve los datos del impacto si lo hubo, o `null`.
 *
 * `soloSeparar` sirve para las pasadas de desenredo: separa sin impulso ni daño, que
 * ya se cobraron en la primera pasada.
 *
 * Nota sobre el orden: se separan primero y se aplica el impulso después, con la
 * velocidad relativa medida **antes** de separar. Si se separara y luego se midiera,
 * la velocidad relativa ya sería la de rebote y el impulso saldría al revés.
 */
function resolverPareja(a, b, p, azar, soloSeparar) {
  const f = p.fisica;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d2 = dx * dx + dy * dy;
  const suma = a.radio + b.radio;
  if (d2 >= suma * suma) return null;

  let d = Math.sqrt(d2);
  if (d < 0.0001) {
    // Centros exactamente iguales: se elige una normal cualquiera y se separan.
    const angulo = azar.rango(0, Math.PI * 2);
    dx = Math.cos(angulo);
    dy = Math.sin(angulo);
    d = 0.0001;
  }
  const nx = dx / d;
  const ny = dy / d;
  const solape = suma - d;

  const invA = 1 / a.masa;
  const invB = 1 / b.masa;
  const invSuma = invA + invB;

  // 1) Separación posicional proporcional a la masa inversa: el ligero se corre más.
  const correccion = Math.max(0, solape - f.holgura) * f.correccion;
  a.x -= nx * correccion * (invA / invSuma);
  a.y -= ny * correccion * (invA / invSuma);
  b.x += nx * correccion * (invB / invSuma);
  b.y += ny * correccion * (invB / invSuma);

  if (soloSeparar) return null;

  // 2) Velocidad relativa en la normal. Negativa = se acercan.
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return null; // ya se están separando: sólo roce, sin impulso ni daño

  // 3) Impulso. Fórmula de choque elástico con restitución, repartido por masa
  // inversa: es la misma que usa cualquier motor 2D de círculos.
  const impulso = (-(1 + f.reboteChoque) * vn) / invSuma;
  a.vx -= impulso * nx * invA;
  a.vy -= impulso * ny * invA;
  b.vx += impulso * nx * invB;
  b.vy += impulso * ny * invB;

  // Fricción tangencial: parte del deslizamiento se convierte en giro, que es lo
  // que hace que dos trompos parezcan engancharse en vez de rebotar como bolas.
  const tx = -ny;
  const ty = nx;
  const vt = rvx * tx + rvy * ty;
  const roceTangencial = -vt * f.acopleGiro * 0.08;
  a.vx -= tx * roceTangencial * invA * 0.5;
  a.vy -= ty * roceTangencial * invA * 0.5;
  b.vx += tx * roceTangencial * invB * 0.5;
  b.vy += ty * roceTangencial * invB * 0.5;
  a.velGiro *= 1 + Math.abs(vt) * 0.0004;
  b.velGiro *= 1 + Math.abs(vt) * 0.0004;

  return {
    a,
    b,
    cierre: -vn, // velocidad de acercamiento (px/s), siempre positiva
    nx,
    ny,
    x: a.x + nx * a.radio,
    y: a.y + ny * a.radio,
  };
}

/**
 * Daño de un impacto.
 *
 *   daño = (mínimo + exceso × escala × presión) × (ataque ÷ defensa) × √(masa atacante ÷ masa víctima)
 *
 * El exceso es lo que la velocidad de cierre pasa del umbral: un roce lento no hace
 * daño. La raíz de la masa evita que un trompo pesado sea además el que más daño
 * hace por goleada: pesa, pero no aplasta.
 */
export function calcularDanio(cierre, umbral, minimo, escala, presion, atacante, victima) {
  if (cierre <= umbral) return 0;
  const exceso = cierre - umbral;
  const base = (minimo + exceso * escala) * presion;
  const proporcion = atacante.ataque / Math.max(0.35, victima.defensa);
  const pesoTercio = Math.sqrt(atacante.masa / Math.max(0.35, victima.masa));
  return base * proporcion * pesoTercio;
}

/** Distancia entre dos trompos menos la suma de radios (negativa = solapados). */
export function separacion(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y) - (a.radio + b.radio);
}

/** Choque forzado del taller: se elige la pareja más cercana y se lanzan a chocar. */
export function lanzarChoque(trompos, p) {
  const vivos = trompos.filter((t) => t.activo);
  if (vivos.length < 2) return null;
  let mejor = null;
  for (let i = 0; i < vivos.length; i += 1) {
    for (let j = i + 1; j < vivos.length; j += 1) {
      const d = separacion(vivos[i], vivos[j]);
      if (!mejor || d < mejor.d) mejor = { a: vivos[i], b: vivos[j], d };
    }
  }
  const { a, b } = mejor;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = dx / d;
  const ny = dy / d;
  const rapidez = p.fisica.velocidadMaxima * 0.85;
  a.vx = nx * rapidez;
  a.vy = ny * rapidez;
  b.vx = -nx * rapidez;
  b.vy = -ny * rapidez;
  return { a, b };
}

/** Comprueba que nadie se queda fuera de la arena (prueba de sanidad). */
export function dentroDeLaArena(trompos, p) {
  const fuera = [];
  for (const t of trompos) {
    if (!t.activo) continue;
    const L = limitesDe(p, t.radio);
    if (t.x < L.xMin - 1 || t.x > L.xMax + 1 || t.y < L.yMin - 1 || t.y > L.yMax + 1) {
      fuera.push(t.nombre);
    }
  }
  return fuera;
}

/** El solape más profundo que hay en la arena (px). Sirve para cazar amontonamientos. */
export function peorSolape(trompos) {
  let peor = 0;
  let quien = null;
  const vivos = trompos.filter((t) => t.activo);
  for (let i = 0; i < vivos.length; i += 1) {
    for (let j = i + 1; j < vivos.length; j += 1) {
      const s = -separacion(vivos[i], vivos[j]);
      if (s > peor) {
        peor = s;
        quien = [vivos[i].nombre, vivos[j].nombre];
      }
    }
  }
  return { peor: Number(peor.toFixed(2)), quien };
}

/** Velocidad media de los que siguen en pie (px/s). */
export function velocidadMedia(trompos) {
  const vivos = trompos.filter((t) => t.activo);
  if (!vivos.length) return 0;
  return vivos.reduce((s, t) => s + t.rapidez, 0) / vivos.length;
}

/** Cuántos están pegados a una pared (a menos de `margen` px del límite). */
export function pegadosAlBorde(trompos, p, margen = 12) {
  let cuenta = 0;
  for (const t of trompos) {
    if (!t.activo) continue;
    const L = limitesDe(p, t.radio);
    if (t.x - L.xMin < margen || L.xMax - t.x < margen || t.y - L.yMin < margen || L.yMax - t.y < margen) {
      cuenta += 1;
    }
  }
  return cuenta;
}

/** Resumen numérico de la energía de la arena, para el HUD. */
export function energia(trompos) {
  let total = 0;
  let maxima = 0;
  for (const t of trompos) {
    if (!t.activo) continue;
    total += Math.pow(t.rapidez, 2) * t.masa;
    maxima = Math.max(maxima, t.rapidez);
  }
  return { total: total / 1000, maxima };
}

/** Fuerza la posición dentro de la arena (por si un impulso bestia la saca). */
export function encajonar(t, p) {
  const L = limitesDe(p, t.radio);
  t.x = limitar(t.x, L.xMin, L.xMax);
  t.y = limitar(t.y, L.yMin, L.yMax);
}
