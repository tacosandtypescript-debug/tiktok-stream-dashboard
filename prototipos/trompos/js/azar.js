// Azar con semilla.
//
// Por qué no `Math.random`: la orden pide que la asignación sea reproducible. Con
// una semilla fija, la ronda 1 es idéntica siempre —mismos trompos, mismas
// posiciones, mismos choques—, así que un cambio de aspecto se puede comparar sin
// que la física se mueva por debajo. `Math.random` se usa sólo para el ruido que no
// afecta a nada (nada, de hecho: hasta las partículas van con semilla).

/** Generador mulberry32: 32 bits de estado, uniforme y de sobra para esto. */
export class Azar {
  constructor(semilla = 1) {
    this.estado = (semilla | 0) >>> 0;
    if (this.estado === 0) this.estado = 0x9e3779b9;
  }

  /** [0, 1). */
  siguiente() {
    this.estado = (this.estado + 0x6d2b79f5) >>> 0;
    let t = this.estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [a, b). */
  rango(a, b) {
    return a + (b - a) * this.siguiente();
  }

  /** Entero en [a, b]. */
  entero(a, b) {
    return Math.floor(this.rango(a, b + 1));
  }

  /** -1 o 1. */
  signo() {
    return this.siguiente() < 0.5 ? -1 : 1;
  }

  elegir(lista) {
    return lista[Math.floor(this.siguiente() * lista.length) % lista.length];
  }

  /** Mezcla en sitio (Fisher-Yates), sin repetir. */
  barajar(lista) {
    for (let i = lista.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.siguiente() * (i + 1));
      [lista[i], lista[j]] = [lista[j], lista[i]];
    }
    return lista;
  }

  /** Semilla derivada: para que el azar de una ronda no dependa del orden de uso. */
  derivar(sal = 0) {
    return (Math.imul(this.estado ^ (sal + 0x85ebca6b), 0xc2b2ae35) >>> 0) || 1;
  }
}

/**
 * Semilla de la ronda: misma semilla base y misma ronda -> misma batalla.
 * Se mezcla con un primo para que rondas consecutivas no se parezcan.
 */
export function semillaDeRonda(semillaBase, ronda) {
  return (Math.imul(semillaBase >>> 0, 0x9e3779b1) + Math.imul(ronda + 1, 0x85ebca6b)) >>> 0;
}
