// Efectos: ondas de choque, chispas, destellos, explosiones, números de daño y
// energía ambiental.
//
// Todo son partículas y degradados dibujados en el momento. Se guardan en listas
// con tope (`particulasMaximas`, `ondasMaximas`) y se descartan las más viejas:
// en un directo de dos horas esto tiene que seguir a 60 fps, y con cuarenta trompos
// hay muchas más partículas por segundo que con diez.
//
// La escala: `this.escala` sale de la escala de los trompos (orden 02). Todo lo que
// era un tamaño fijo —chispas, ondas, fogonazos— se multiplica por ella, así que con
// cuarenta participantes los efectos acompañan al tamaño de los trompos en vez de
// quedar desproporcionados.

import { TAU, conAlfa, limitar } from "./util.js";

export class Efectos {
  constructor(azar, p) {
    this.azar = azar;
    this.p = p;
    this.particulas = [];
    this.numeros = [];
    this.cortes = [];
    this.ondas = [];
    this.destellos = [];
    // Escala de los efectos y freno por número de participantes: con cuarenta trompos
    // no se puede soltar la misma lluvia de partículas por impacto que con diez.
    this.escala = p.efectos.escala ?? 1;
    this.freno = limitar(Math.sqrt(12 / Math.max(8, p.simulacion.participantes)), 0.45, 1);
    this.contadores = { chispas: 0, ondas: 0, explosiones: 0, numeros: 0 };
  }

  limpiar() {
    this.particulas.length = 0;
    this.numeros.length = 0;
    this.cortes.length = 0;
    this.ondas.length = 0;
    this.destellos.length = 0;
    this.contadores = { chispas: 0, ondas: 0, explosiones: 0, numeros: 0, cortes: 0 };
  }

  /** Recalcula la escala cuando cambia el número de participantes. */
  ajustarEscala(p) {
    this.escala = p.efectos.escala ?? 1;
    this.freno = limitar(Math.sqrt(12 / Math.max(8, p.simulacion.participantes)), 0.45, 1);
  }

  /** Chispas de choque: salen en abanico desde el punto de contacto. */
  chispas(x, y, cantidad, color, fuerza, normal = null, dispersion = Math.PI) {
    const az = this.azar;
    const base = normal ? Math.atan2(normal.y, normal.x) : az.rango(0, TAU);
    const cuantas = Math.max(2, Math.round(cantidad * this.freno));
    for (let i = 0; i < cuantas; i += 1) {
      const a = base + az.rango(-dispersion / 2, dispersion / 2);
      const v = az.rango(0.35, 1.35) * fuerza;
      this.particulas.push({
        tipo: "chispa",
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        vida: az.rango(0.18, 0.5),
        vidaMax: 0.5,
        tam: az.rango(1.2, 3.2) * this.escala,
        color,
        roce: 2.2,
      });
    }
    this.contadores.chispas += cuantas;
    this.recortar();
  }

  /** Grano de energía que suelta un trompo vivo. */
  energia(x, y, color, fuerza = 1, radio = 40) {
    const az = this.azar;
    const a = az.rango(0, TAU);
    const r = az.rango(0.4, 1) * radio;
    this.particulas.push({
      tipo: "energia",
      x: x + Math.cos(a) * r,
      y: y + Math.sin(a) * r,
      vx: Math.cos(a) * az.rango(10, 60) * fuerza,
      vy: Math.sin(a) * az.rango(10, 60) * fuerza - az.rango(0, 30),
      vida: az.rango(0.5, 1.4),
      vidaMax: 1.4,
      tam: az.rango(1.4, 3.4) * this.escala,
      color,
      roce: 0.6,
    });
  }

  /** Onda circular de impacto. */
  onda(x, y, color, fuerza, radioMaximo = null) {
    const max = (radioMaximo ?? limitar(120 + fuerza * 0.35, 120, 420)) * this.escala;
    this.ondas.push({
      x,
      y,
      radio: max * 0.12,
      radioMax: max,
      vida: this.p.efectos.onda,
      vidaMax: this.p.efectos.onda,
      color,
      grosor: limitar(3 + fuerza * 0.02, 3, 12) * this.escala,
    });
    this.contadores.ondas += 1;
    this.recortar();
  }

  /** Destello de daño: un fogonazo corto en el punto de contacto. */
  destello(x, y, color, fuerza, radio = null) {
    this.destellos.push({
      x,
      y,
      radio: (radio ?? limitar(40 + fuerza * 0.25, 40, 190)) * this.escala,
      vida: this.p.efectos.destello,
      vidaMax: this.p.efectos.destello,
      color,
    });
    this.recortar();
  }

  /**
   * Número de daño flotante: es lo que hace que el golpe se lea sin mirar la tabla.
   * Se dibuja con contorno oscuro para que se vea sobre cualquier color.
   */
  numero(x, y, valor, color, radio = 42) {
    if (!this.p.efectos.numerosDanio) return;
    const cuantos = Math.round(valor);
    if (cuantos < this.p.efectos.numeroMinimo) return;
    this.numeros.push({
      x: x + this.azar.rango(-6, 6),
      y,
      vx: this.azar.rango(-18, 18),
      vy: -70,
      texto: `-${cuantos}`,
      color,
      vida: this.p.efectos.numeroDuracion,
      vidaMax: this.p.efectos.numeroDuracion,
      tam: Math.max(17, radio * 0.55),
    });
    this.contadores.numeros += 1;
    if (this.numeros.length > this.p.efectos.numerosMaximos) {
      this.numeros.splice(0, this.numeros.length - this.p.efectos.numerosMaximos);
    }
  }

  /**
   * Texto suelto que sube y se apaga: «esquiva», «contra 42»… Lo usan los poderes
   * para decir qué ha pasado, sin taps ni carteles.
   */
  texto(x, y, texto, color, radio = 42, tamano = null) {
    this.numeros.push({
      x,
      y,
      vx: this.azar.rango(-14, 14),
      vy: -58,
      texto,
      color,
      vida: this.p.efectos.numeroDuracion,
      vidaMax: this.p.efectos.numeroDuracion,
      tam: tamano ?? Math.max(15, radio * 0.46),
    });
    if (this.numeros.length > this.p.efectos.numerosMaximos) {
      this.numeros.splice(0, this.numeros.length - this.p.efectos.numerosMaximos);
    }
  }

  /**
   * Corte luminoso: la raya que deja un filo o un rayo sobre el punto de impacto.
   * Se dibuja como una estela blanca que se apaga en menos de medio segundo.
   */
  corte(x, y, angulo, largo, color, grosor = 3, duracion = 0.42) {
    this.cortes.push({
      x,
      y,
      angulo,
      largo,
      color,
      grosor,
      vida: duracion,
      vidaMax: duracion,
    });
    if (this.cortes.length > 40) this.cortes.splice(0, this.cortes.length - 40);
  }

  /** Explosión de eliminación: chispas, escombros, onda doble y fogonazo. */
  explosion(x, y, colorBase, colorAcento, radio) {
    const n = Math.round(this.p.efectos.chispasExplosion * this.p.aspecto.calidad * this.freno * (radio / 42));
    const az = this.azar;
    for (let i = 0; i < n; i += 1) {
      const a = az.rango(0, TAU);
      const v = az.rango(120, 620) * this.escala;
      this.particulas.push({
        tipo: i % 3 === 0 ? "escombro" : "chispa",
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        vida: az.rango(0.3, 1.1),
        vidaMax: 1.1,
        tam: az.rango(1.6, 4.2) * this.escala,
        color: i % 4 === 0 ? colorAcento : colorBase,
        roce: 1.6,
      });
    }
    this.onda(x, y, colorAcento, 220, radio * 5.5);
    this.onda(x, y, colorBase, 140, radio * 3.2);
    this.destello(x, y, colorAcento, 260, radio * 2.6);
    this.contadores.explosiones += 1;
    this.recortar();
  }

  recortar() {
    const maxP = Math.round(this.p.efectos.particulasMaximas * this.p.aspecto.calidad);
    if (this.particulas.length > maxP) this.particulas.splice(0, this.particulas.length - maxP);
    if (this.ondas.length > this.p.efectos.ondasMaximas) {
      this.ondas.splice(0, this.ondas.length - this.p.efectos.ondasMaximas);
    }
    if (this.destellos.length > 24) this.destellos.splice(0, this.destellos.length - 24);
  }

  actualizar(dt) {
    for (let i = this.particulas.length - 1; i >= 0; i -= 1) {
      const q = this.particulas[i];
      q.vida -= dt;
      if (q.vida <= 0) {
        this.particulas.splice(i, 1);
        continue;
      }
      const amortiguacion = Math.exp(-q.roce * dt);
      q.vx *= amortiguacion;
      q.vy *= amortiguacion;
      // Los escombros caen; las chispas no (es una arena sin suelo, y la gravedad
      // en el aire se vería rara en un overlay).
      if (q.tipo === "escombro") q.vy += 260 * dt * this.escala;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }

    for (let i = this.numeros.length - 1; i >= 0; i -= 1) {
      const num = this.numeros[i];
      num.vida -= dt;
      if (num.vida <= 0) {
        this.numeros.splice(i, 1);
        continue;
      }
      num.vy += 26 * dt; // frena la subida
      num.x += num.vx * dt;
      num.y += num.vy * dt;
    }

    for (let i = this.cortes.length - 1; i >= 0; i -= 1) {
      const c = this.cortes[i];
      c.vida -= dt;
      if (c.vida <= 0) this.cortes.splice(i, 1);
    }

    for (let i = this.ondas.length - 1; i >= 0; i -= 1) {
      const o = this.ondas[i];
      o.vida -= dt;
      if (o.vida <= 0) {
        this.ondas.splice(i, 1);
        continue;
      }
      const t = 1 - o.vida / o.vidaMax;
      o.radio = o.radioMax * (1 - Math.pow(1 - t, 2.4));
    }

    for (let i = this.destellos.length - 1; i >= 0; i -= 1) {
      const d = this.destellos[i];
      d.vida -= dt;
      if (d.vida <= 0) this.destellos.splice(i, 1);
    }
  }

  /** Ondas: van encima de los cuerpos, para que el impacto se lea. */
  dibujarOndas(ctx) {
    if (!this.p.aspecto.verParticulas || !this.ondas.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const o of this.ondas) {
      const t = 1 - o.vida / o.vidaMax;
      const alfa = Math.pow(1 - t, 1.7) * 0.75;
      ctx.strokeStyle = conAlfa(o.color, alfa);
      ctx.lineWidth = Math.max(1, o.grosor * (1 - t));
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.radio, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = conAlfa("#ffffff", alfa * 0.4);
      ctx.lineWidth = Math.max(1, o.grosor * 0.4 * (1 - t));
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.radio * 0.92, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Partículas. Dos pasadas: aditivas (chispas, energía) y sólidas (escombros). */
  dibujarParticulas(ctx) {
    if (!this.p.aspecto.verParticulas || !this.particulas.length) return;
    ctx.save();

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (const q of this.particulas) {
      if (q.tipo === "escombro") continue;
      const k = limitar(q.vida / q.vidaMax, 0, 1);
      if (q.tipo === "chispa") {
        // Chispa = estela: una raya corta en el sentido de la velocidad.
        const largo = limitar(Math.hypot(q.vx, q.vy) * 0.03, 2, 22) * this.escala;
        const a = Math.atan2(q.vy, q.vx);
        ctx.strokeStyle = conAlfa(q.color, 0.25 + 0.75 * k);
        ctx.lineWidth = q.tam;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x - Math.cos(a) * largo, q.y - Math.sin(a) * largo);
        ctx.stroke();
      } else {
        ctx.fillStyle = conAlfa(q.color, 0.2 + 0.6 * k);
        ctx.beginPath();
        ctx.arc(q.x, q.y, q.tam * (0.5 + k * 0.5), 0, TAU);
        ctx.fill();
      }
    }

    ctx.globalCompositeOperation = "source-over";
    for (const q of this.particulas) {
      if (q.tipo !== "escombro") continue;
      const k = limitar(q.vida / q.vidaMax, 0, 1);
      const a = Math.atan2(q.vy, q.vx);
      ctx.strokeStyle = conAlfa(q.color, 0.35 + 0.5 * k);
      ctx.lineWidth = q.tam;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - Math.cos(a) * q.tam * 2.2, q.y - Math.sin(a) * q.tam * 2.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Números de daño. Van aparte de las partículas y no los apaga el interruptor de
   * partículas: son información, no adorno.
   */
  dibujarNumeros(ctx) {
    if (!this.p.efectos.numerosDanio || !this.numeros.length) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const n of this.numeros) {
      const k = limitar(n.vida / n.vidaMax, 0, 1);
      const crece = 1 + (1 - k) * 0.12;
      ctx.font = `800 ${Math.round(n.tam * crece)}px system-ui, 'Segoe UI', sans-serif`;
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.lineWidth = Math.max(2, n.tam * 0.14);
      ctx.strokeStyle = "rgba(8,6,16,0.85)";
      ctx.strokeText(n.texto, n.x, n.y);
      ctx.fillStyle = n.color;
      ctx.fillText(n.texto, n.x, n.y);
    }
    ctx.restore();
  }

  /**
   * Cortes luminosos: rayas aditivas sobre el punto de impacto. Van en la capa de
   * efectos (debajo de los nombres y del medallón del participante).
   */
  dibujarCortes(ctx) {
    if (!this.cortes.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (const c of this.cortes) {
      const k = limitar(c.vida / c.vidaMax, 0, 1);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angulo);
      ctx.strokeStyle = conAlfa(c.color, 0.2 + 0.8 * k);
      ctx.lineWidth = c.grosor * k;
      ctx.beginPath();
      ctx.moveTo(-c.largo / 2, 0);
      ctx.lineTo(c.largo / 2, 0);
      ctx.stroke();
      ctx.strokeStyle = conAlfa("#ffffff", 0.5 * k);
      ctx.lineWidth = Math.max(1, c.grosor * 0.4 * k);
      ctx.beginPath();
      ctx.moveTo(-c.largo / 2, 0);
      ctx.lineTo(c.largo / 2, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /** Destellos. */
  dibujarDestellos(ctx) {
    if (!this.p.aspecto.verParticulas || !this.destellos.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const d of this.destellos) {
      const k = limitar(d.vida / d.vidaMax, 0, 1);
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.radio);
      g.addColorStop(0, conAlfa("#ffffff", 0.85 * k));
      g.addColorStop(0.35, conAlfa(d.color, 0.5 * k));
      g.addColorStop(1, conAlfa(d.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.radio, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  get cuentas() {
    return {
      particulas: this.particulas.length,
      ondas: this.ondas.length,
      destellos: this.destellos.length,
      numeros: this.numeros.length,
      cortes: this.cortes.length,
      ...this.contadores,
    };
  }
}
