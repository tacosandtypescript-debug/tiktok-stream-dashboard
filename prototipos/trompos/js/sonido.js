// Sonido del prototipo: efectos sintetizados con WebAudio, sin un solo archivo.
//
// Por qué sintetizado y no WAV: el prototipo tiene que ser independiente (nada de
// TikTok ni de la aplicación), y aquí los sonidos se generan con osciladores y ruido
// filtrado. Se ajustan en el sitio, no hay binarios que versionar y no hace falta
// cargar nada por red.
//
// Tres controles que pide la orden 02:
//   * **silencio**: `silenciar(true)` no crea ni un nodo (más barato que un gain a 0);
//   * **volumen**: un `GainNode` maestro;
//   * **desbloqueo**: los navegadores no dejan sonar nada hasta que el usuario toca
//     la página, así que el AudioContext se crea en la primera interacción.
//
// Y un **limitador**: con cuarenta trompos chocando hay decenas de impactos por
// segundo; sin freno esto sería una ametralladora. Cada sonido tiene su tiempo mínimo
// entre repeticiones y hay un tope global por segundo. Los sonidos importantes
// (eliminación, victoria, líder, inicio) se saltan el tope global.

const REPETIBLE = {
  inicio: 1,
  cuenta: 0.12,
  choqueLeve: 0.045,
  choqueFuerte: 0.06,
  dano: 0.07,
  eliminacion: 0.12,
  lider: 0.9,
  victoria: 2,
  // Poderes (orden 04).
  poderCarga: 0.6,
  poderActiva: 0.35,
  poderImpacto: 0.08,
  poderEscudo: 0.12,
  poderElectrico: 0.3,
  poderExplosion: 0.5,
  poderViento: 0.45,
  poderCampo: 1,
  poderSombra: 0.5,
  poderFinal: 0.3,
  poderRotura: 0.5,
  poderEsquiva: 0.22,
};

/** Los que no se descartan nunca por saturación: son los que hay que oír. */
const IMPORTANTES = new Set([
  "inicio",
  "victoria",
  "eliminacion",
  "lider",
  "cuenta",
  "poderExplosion",
  "poderRotura",
  "poderActiva",
]);

export class Sonido {
  constructor(p) {
    this.p = p;
    this.ctx = null;
    this.maestro = null;
    this.ruido = null;
    this.desbloqueado = false;
    this.reproducidos = {};
    this.descartados = 0;
    this.ultimo = {};
    this.marcas = [];
    this.sonando = 0;
  }

  /**
   * Se llama en la primera interacción del usuario (clic o tecla).
   *
   * Si el contexto ya se había creado antes (porque la simulación intentó sonar algo),
   * no basta con devolver: hay que **reanudarlo**, porque los navegadores lo dejan
   * suspendido hasta que hay un gesto. Ese era el fallo: el primer clic no reanudaba
   * un contexto creado por su cuenta.
   */
  desbloquear() {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) return this.estado();
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.maestro = this.ctx.createGain();
      this.maestro.gain.value = this.p.sonido.activo ? this.p.sonido.volumen : 0;
      this.maestro.connect(this.ctx.destination);
      this.ruido = this.crearRuido();
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    this.desbloqueado = true;
    return this.estado();
  }

  crearRuido() {
    const segundos = 0.6;
    const buffer = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * segundos), this.ctx.sampleRate);
    const datos = buffer.getChannelData(0);
    let anterior = 0;
    for (let i = 0; i < datos.length; i += 1) {
      // Ruido rosa aproximado: más suave que el blanco para impactos.
      const blanco = Math.random() * 2 - 1;
      anterior = 0.98 * anterior + 0.02 * blanco;
      datos[i] = anterior * 3.2;
    }
    return buffer;
  }

  silenciar(si) {
    this.p.sonido.activo = !si;
    if (this.maestro) {
      this.maestro.gain.setTargetAtTime(si ? 0 : this.p.sonido.volumen, this.ctx.currentTime, 0.02);
    }
    return this.p.sonido.activo;
  }

  volumen(v) {
    this.p.sonido.volumen = Math.max(0, Math.min(1, v));
    if (this.maestro && this.p.sonido.activo) {
      this.maestro.gain.setTargetAtTime(this.p.sonido.volumen, this.ctx.currentTime, 0.02);
    }
    return this.p.sonido.volumen;
  }

  /** ¿Deja pasar este sonido ahora mismo? (freno por sonido y tope global) */
  pasa(nombre, ahora) {
    const repetible = REPETIBLE[nombre] ?? 0.1;
    if (this.ultimo[nombre] !== undefined && ahora - this.ultimo[nombre] < repetible) {
      this.descartados += 1;
      return false;
    }
    if (!IMPORTANTES.has(nombre)) {
      this.marcas = this.marcas.filter((m) => ahora - m < 1);
      if (this.marcas.length >= this.p.sonido.maxPorSegundo) {
        this.descartados += 1;
        return false;
      }
    }
    this.ultimo[nombre] = ahora;
    this.marcas.push(ahora);
    return true;
  }

  /**
   * Toca un efecto.
   * @param nombre  inicio | cuenta | choqueLeve | choqueFuerte | dano | eliminacion | lider | victoria
   * @param datos   { intensidad: 0..1, paso: 3|2|1 }
   */
  tocar(nombre, datos = {}) {
    if (!this.p.sonido.activo) {
      this.descartados += 1;
      return false;
    }
    if (!this.desbloqueado) this.desbloquear();
    if (!this.ctx || this.ctx.state === "closed") return false;
    if (!this.pasa(nombre, this.ctx.currentTime)) return false;

    const parche = this.parches()[nombre];
    if (!parche) return false;
    parche(this, datos);
    this.reproducidos[nombre] = (this.reproducidos[nombre] ?? 0) + 1;
    return true;
  }

  // ------------------------------------------------------------ generadores

  /** Tono con envolvente de ataque y caída. `f2` permite un barrido de frecuencia. */
  tono({ f, f2 = null, tipo = "sine", dur = 0.18, vol = 0.25, retardo = 0, ataque = 0.006 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + retardo;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = tipo;
    osc.frequency.setValueAtTime(Math.max(20, f), t0);
    if (f2 !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + ataque);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.maestro);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    this.contar(osc, dur + retardo);
  }

  /** Golpe de ruido filtrado: la base de los choques. */
  golpeRuido({ dur = 0.08, vol = 0.2, filtro = 1200, tipoFiltro = "lowpass", q = 1, retardo = 0, barrido = null }) {
    if (!this.ctx || !this.ruido) return;
    const t0 = this.ctx.currentTime + retardo;
    const src = this.ctx.createBufferSource();
    src.buffer = this.ruido;
    const bq = this.ctx.createBiquadFilter();
    bq.type = tipoFiltro;
    bq.frequency.setValueAtTime(filtro, t0);
    if (barrido) bq.frequency.exponentialRampToValueAtTime(Math.max(60, barrido), t0 + dur);
    bq.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bq).connect(g).connect(this.maestro);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    this.contar(src, dur + retardo);
  }

  contar(nodo, dur) {
    this.sonando += 1;
    nodo.onended = () => {
      this.sonando = Math.max(0, this.sonando - 1);
    };
  }

  // ------------------------------------------------------------ parches

  parches() {
    return {
      // Arranque de la batalla: barrido ascendente y un golpe grave detrás.
      inicio: (s) => {
        s.tono({ f: 160, f2: 640, tipo: "sawtooth", dur: 0.5, vol: 0.26 });
        s.tono({ f: 80, f2: 240, tipo: "triangle", dur: 0.6, vol: 0.22, retardo: 0.04 });
        s.golpeRuido({ dur: 0.45, vol: 0.16, filtro: 400, barrido: 1800 });
      },
      // Cuenta atrás: un pitido por número, más agudo según se acerca el final.
      cuenta: (s, d = {}) => {
        const paso = d.paso ?? 1;
        const f = 380 + (3 - paso) * 150;
        s.tono({ f, tipo: "triangle", dur: 0.16, vol: 0.24 });
        s.tono({ f: f * 2, tipo: "sine", dur: 0.1, vol: 0.08 });
      },
      // Choque leve: chasquido corto.
      choqueLeve: (s, d = {}) => {
        const i = d.intensidad ?? 0.4;
        s.golpeRuido({ dur: 0.06, vol: 0.1 + 0.12 * i, filtro: 1800, tipoFiltro: "bandpass", q: 1.2 });
        s.tono({ f: 190, f2: 120, tipo: "square", dur: 0.06, vol: 0.05 + 0.06 * i });
      },
      // Choque fuerte: golpe con cuerpo y cola grave.
      choqueFuerte: (s, d = {}) => {
        const i = d.intensidad ?? 0.8;
        s.golpeRuido({ dur: 0.14, vol: 0.16 + 0.2 * i, filtro: 1200, barrido: 300 });
        s.tono({ f: 130, f2: 55, tipo: "triangle", dur: 0.22, vol: 0.12 + 0.16 * i });
        s.tono({ f: 320, f2: 160, tipo: "sawtooth", dur: 0.1, vol: 0.06 + 0.08 * i });
      },
      // Daño importante: el anterior más un chasquido metálico.
      dano: (s, d = {}) => {
        const i = d.intensidad ?? 0.6;
        s.golpeRuido({ dur: 0.18, vol: 0.14 + 0.18 * i, filtro: 900, barrido: 220 });
        s.tono({ f: 520, f2: 260, tipo: "square", dur: 0.12, vol: 0.08 + 0.1 * i });
        s.tono({ f: 90, f2: 60, tipo: "sine", dur: 0.26, vol: 0.1 + 0.12 * i });
      },
      // Eliminación: caída larga y estruendo.
      eliminacion: (s, d = {}) => {
        const i = d.intensidad ?? 1;
        s.tono({ f: 620, f2: 70, tipo: "sawtooth", dur: 0.55, vol: 0.2 + 0.12 * i });
        s.golpeRuido({ dur: 0.6, vol: 0.2 + 0.16 * i, filtro: 1400, barrido: 120 });
        s.tono({ f: 60, tipo: "sine", dur: 0.5, vol: 0.16 + 0.14 * i, retardo: 0.03 });
      },
      // Cambio de líder: campanilla de dos notas.
      lider: (s) => {
        s.tono({ f: 880, tipo: "sine", dur: 0.28, vol: 0.16 });
        s.tono({ f: 1320, tipo: "sine", dur: 0.34, vol: 0.12, retardo: 0.1 });
        s.tono({ f: 1760, tipo: "sine", dur: 0.4, vol: 0.07, retardo: 0.2 });
      },
      // Victoria: arpegio corto, sin música.
      victoria: (s) => {
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          s.tono({ f, tipo: "triangle", dur: 0.4, vol: 0.16, retardo: i * 0.11 });
          s.tono({ f: f * 2, tipo: "sine", dur: 0.3, vol: 0.05, retardo: i * 0.11 });
        });
      },

      // --- poderes (orden 04) -------------------------------------------------

      // Carga: zumbido que sube, el aviso de que algo va a pasar.
      poderCarga: (s) => {
        s.tono({ f: 140, f2: 420, tipo: "sawtooth", dur: 0.65, vol: 0.16 });
        s.tono({ f: 210, f2: 630, tipo: "triangle", dur: 0.65, vol: 0.08 });
        s.golpeRuido({ dur: 0.5, vol: 0.06, filtro: 600, barrido: 2200, tipoFiltro: "bandpass", q: 1.4 });
      },
      // Activación: barrido brillante con golpe seco detrás.
      poderActiva: (s) => {
        s.tono({ f: 320, f2: 1200, tipo: "sawtooth", dur: 0.3, vol: 0.2 });
        s.tono({ f: 90, f2: 60, tipo: "sine", dur: 0.35, vol: 0.22, retardo: 0.02 });
        s.golpeRuido({ dur: 0.25, vol: 0.16, filtro: 2400, barrido: 500 });
      },
      // Impacto de poder: golpe con cuerpo.
      poderImpacto: (s, d = {}) => {
        const i = d.intensidad ?? 0.7;
        s.golpeRuido({ dur: 0.16, vol: 0.18 + 0.18 * i, filtro: 1100, barrido: 260 });
        s.tono({ f: 120, f2: 48, tipo: "triangle", dur: 0.24, vol: 0.14 + 0.14 * i });
      },
      // Escudo: campana metálica corta.
      poderEscudo: (s, d = {}) => {
        const i = d.intensidad ?? 0.5;
        s.tono({ f: 1180, tipo: "sine", dur: 0.22, vol: 0.13 * (0.5 + i) });
        s.tono({ f: 1760, tipo: "sine", dur: 0.18, vol: 0.07 * (0.5 + i) });
        s.golpeRuido({ dur: 0.12, vol: 0.08 * (0.5 + i), filtro: 3200, tipoFiltro: "bandpass", q: 2 });
      },
      // Electricidad: chisporroteo con picos agudos.
      poderElectrico: (s) => {
        s.golpeRuido({ dur: 0.3, vol: 0.2, filtro: 2600, barrido: 900, tipoFiltro: "bandpass", q: 1.6 });
        [0, 0.05, 0.11, 0.18].forEach((r, i) => {
          s.tono({ f: 1800 + i * 400, tipo: "square", dur: 0.05, vol: 0.07, retardo: r });
        });
        s.tono({ f: 70, tipo: "sine", dur: 0.3, vol: 0.12 });
      },
      // Explosión: estruendo grave con cola.
      poderExplosion: (s) => {
        s.golpeRuido({ dur: 0.8, vol: 0.34, filtro: 1500, barrido: 90 });
        s.tono({ f: 70, f2: 32, tipo: "sine", dur: 0.7, vol: 0.28 });
        s.tono({ f: 180, f2: 60, tipo: "sawtooth", dur: 0.35, vol: 0.12 });
      },
      // Viento: ráfaga con filtro que barre.
      poderViento: (s) => {
        s.golpeRuido({ dur: 0.6, vol: 0.16, filtro: 400, barrido: 1800, tipoFiltro: "bandpass", q: 0.9 });
        s.tono({ f: 220, f2: 330, tipo: "sine", dur: 0.5, vol: 0.05 });
      },
      // Campo cósmico: zumbido profundo que crece y se va.
      poderCampo: (s) => {
        s.tono({ f: 55, tipo: "sine", dur: 1.1, vol: 0.2, ataque: 0.25 });
        s.tono({ f: 82.5, tipo: "sine", dur: 1.1, vol: 0.1, ataque: 0.3 });
        s.tono({ f: 220, f2: 330, tipo: "triangle", dur: 0.9, vol: 0.05, ataque: 0.2 });
      },
      // Sombra: barrido oscuro hacia abajo.
      poderSombra: (s) => {
        s.tono({ f: 420, f2: 90, tipo: "sine", dur: 0.6, vol: 0.16 });
        s.golpeRuido({ dur: 0.5, vol: 0.1, filtro: 900, barrido: 200, tipoFiltro: "lowpass" });
      },
      // Finalización: el poder se apaga.
      poderFinal: (s) => {
        s.tono({ f: 520, f2: 180, tipo: "triangle", dur: 0.3, vol: 0.1 });
        s.golpeRuido({ dur: 0.25, vol: 0.05, filtro: 1200, barrido: 300 });
      },
      // Rotura de la armadura de cristal.
      poderRotura: (s) => {
        s.golpeRuido({ dur: 0.4, vol: 0.24, filtro: 3600, barrido: 1400, tipoFiltro: "bandpass", q: 1.2 });
        [0, 0.06, 0.13, 0.21].forEach((r, i) => {
          s.tono({ f: 2200 + i * 350, tipo: "triangle", dur: 0.12, vol: 0.07, retardo: r });
        });
      },
      // Esquiva del velo de sombra.
      poderEsquiva: (s) => {
        s.tono({ f: 1500, f2: 2400, tipo: "sine", dur: 0.09, vol: 0.09 });
        s.golpeRuido({ dur: 0.07, vol: 0.05, filtro: 4000, tipoFiltro: "highpass" });
      },
    };
  }

  /** Reproduce todos los efectos seguidos, para revisarlos de oído. */
  probar(separacion = 0.55) {
    const nombres = ["inicio", "cuenta", "choqueLeve", "choqueFuerte", "dano", "eliminacion", "lider", "victoria"];
    if (!this.desbloqueado) this.desbloquear();
    nombres.forEach((nombre, i) => {
      setTimeout(() => this.tocar(nombre, { intensidad: 0.7, paso: 3 - (i % 3) }), i * separacion * 1000);
    });
    return nombres;
  }

  estado() {
    return {
      desbloqueado: this.desbloqueado,
      estado: this.ctx ? this.ctx.state : "sin contexto",
      activo: this.p.sonido.activo,
      volumen: this.p.sonido.volumen,
      reproducidos: { ...this.reproducidos },
      total: Object.values(this.reproducidos).reduce((s, v) => s + v, 0),
      descartados: this.descartados,
      sonando: this.sonando,
    };
  }
}
