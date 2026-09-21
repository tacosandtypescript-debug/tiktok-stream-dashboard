// El trompo: estado, vida y ciclo de cada pieza.
//
// Aquí no se dibuja nada (eso vive en `dibujo/trompo.js`) ni se resuelven choques
// (eso es `fisica.js`). Este módulo sólo sabe qué es un trompo y cómo envejece:
// gira, se desgasta, recibe daño, muere y desaparece.

import { limitar } from "./util.js";

export const ESTADOS = {
  ESPERA: "espera", // colocado pero todavía invisible (fase de espera)
  APARECIENDO: "apareciendo",
  ACTIVO: "activo",
  KO: "ko", // sin vida, despedido y desvaneciéndose
  FUERA: "fuera", // ya no se dibuja
};

export class Trompo {
  constructor(datos) {
    this.id = datos.id;
    // Identidad: el trompo es la pieza física, el participante es la persona. Todo lo
    // que se enseña (nombre, inicial, foto, color) sale de aquí.
    this.participante = datos.participante ?? null;
    // Identidad de TikTok del dueño (orden 06), si la tiene: es la clave con la que el
    // registro de usuarios encuentra su trompo en cada ronda.
    this.userId = this.participante?.userId ?? datos.userId ?? null;
    this.diseno = datos.diseno;
    // Motivo de la baja: "eliminado" o "retirado" (lo quita el taller a mano).
    this.motivo = null;

    // --- física
    this.x = datos.x;
    this.y = datos.y;
    this.vx = datos.vx;
    this.vy = datos.vy;
    this.radio = datos.radio;
    this.masa = datos.masa;
    this.ataque = datos.ataque;
    this.defensa = datos.defensa;

    // --- vida
    this.vidaMax = datos.vidaMax;
    this.vida = datos.vidaMax;
    this.proteccion = 0;
    this.eliminaciones = 0;
    this.ultimoAtacante = null;
    this.eliminadoPor = null;
    this.momentoMuerte = null;
    this.danioRecibido = 0;
    // Daño que ha hecho a los demás: es el segundo criterio de la clasificación.
    this.danioHecho = 0;
    // Quién me pegó a mí y a quién le pegué yo (para el cartel y para las pruebas).
    this.ultimoGolpeado = null;
    // Relojes de las etiquetas: un trompo que acaba de recibir o de dar un golpe
    // tiene derecho a que su nombre se lea por encima de los demás.
    this.relojGolpe = 0;
    // Ventana propia de los poderes (regalos incluidos): un poder no debe quedar
    // anulado por la protección de un choque, pero dos poderes tampoco deben
    // encadenarse en el mismo instante sobre el mismo trompo.
    this.proteccionPoder = 0;
    this.relojAtaque = 0;

    // --- aspecto
    this.giro = datos.fase * Math.PI * 2;
    this.velGiro = datos.velGiro ?? 14;
    // Rumbo del empuje de crucero (rad): hacia dónde quiere ir mientras nadie le pega.
    this.rumbo = datos.rumbo ?? Math.atan2(this.vy, this.vx);
    this.fase = datos.fase; // desfase propio: evita que todos latan a la vez
    this.aparicion = 0;
    this.muerte = 0;
    this.rastro = [];
    this.relojRastro = 0;
    this.estado = ESTADOS.ESPERA;
    this.esLider = false;
    this.marcaAparicion = datos.marcaAparicion ?? 0;
  }

  get vidaPct() {
    return limitar(this.vida / this.vidaMax, 0, 1);
  }

  // ------------------------------------------------------------ identidad
  get nombre() {
    return this.participante ? this.participante.nombre : "Sin nombre";
  }

  get inicial() {
    return this.participante ? this.participante.inicial : "?";
  }

  get foto() {
    return this.participante ? this.participante.foto : null;
  }

  /** Color identificador del jugador (no el del diseño). */
  get color() {
    return this.participante ? this.participante.color : this.diseno.colores.base;
  }

  get activo() {
    return this.estado === ESTADOS.ACTIVO;
  }

  get presente() {
    return this.estado !== ESTADOS.FUERA;
  }

  get danio() {
    return 1 - this.vidaPct;
  }

  /** Velocidad actual (px/s). */
  get rapidez() {
    return Math.hypot(this.vx, this.vy);
  }

  /**
   * Prioridad de la etiqueta (orden 02): cuanto más alta, más derecho tiene el nombre
   * a dibujarse aunque pise a otro. El líder y el que acaba de recibir un golpe van
   * primero; el que se está muriendo, después; el que pegó, luego; el resto, al final.
   */
  get prioridadEtiqueta() {
    if (this.esLider) return 6;
    if (this.relojGolpe > 0) return 5;
    if (this.estado === ESTADOS.KO) return 4;
    if (this.relojAtaque > 0) return 3;
    return 1;
  }

  /**
   * Resta vida. Devuelve el daño real aplicado (0 si estaba protegido).
   *
   * La protección es la que evita que un amontonamiento cuente como cinco choques
   * en el mismo instante: el impulso y el rebote se aplican siempre, porque son
   * física, pero el daño no.
   */
  recibirDanio(cantidad, atacante, proteccion, ignorarProteccion = false) {
    if (!this.activo || cantidad <= 0) return 0;
    // `ignorarProteccion` lo usan los poderes: un regalo no puede quedarse en nada
    // porque el trompo haya rozado a otro 0,1 s antes. La ventana que impide que dos
    // poderes se apilen es `proteccionPoder`, que se comprueba en `Poderes`.
    if (this.proteccion > 0 && !ignorarProteccion) return 0;
    const real = Math.min(cantidad, this.vida);
    this.vida -= real;
    this.danioRecibido += real;
    this.proteccion = Math.max(this.proteccion, proteccion);
    if (atacante) this.ultimoAtacante = atacante;
    return real;
  }

  /** Eliminación: sale despedido y empieza el fade. */
  morir(momento, azar) {
    this.estado = ESTADOS.KO;
    this.vida = 0;
    this.momentoMuerte = momento;
    this.motivo = "eliminado";
    this.eliminadoPor = this.ultimoAtacante ?? null;
    if (this.eliminadoPor) this.eliminadoPor.eliminaciones += 1;
    // El empujón de salida: se va hacia donde iba, con un extra radial.
    const angulo = Math.atan2(this.vy, this.vx) + azar.rango(-0.5, 0.5);
    const fuerza = Math.max(320, this.rapidez * 1.9);
    this.vx = Math.cos(angulo) * fuerza;
    this.vy = Math.sin(angulo) * fuerza;
    this.velGiro *= 2.4;
    return this.eliminadoPor;
  }

  /**
   * Retirada: es una baja sin choque (el taller quita al participante a mano). Usa el
   * mismo fade que la eliminación, pero sin salir despedido ni contar como baja de
   * nadie: la orden pide registrar el motivo.
   */
  retirar(momento) {
    if (this.estado === ESTADOS.FUERA || this.estado === ESTADOS.KO) return false;
    this.estado = ESTADOS.KO;
    this.vida = 0;
    this.momentoMuerte = momento;
    this.motivo = "retirado";
    this.eliminadoPor = null;
    this.velGiro *= 0.6;
    return true;
  }

  /**
   * Giros, desgaste, protección, rastro y fades. Se llama en todas las fases.
   *
   * `permitirAparicion` está en falso durante la fase de espera: si no, los trompos
   * se colarían apareciendo mientras el cartel dice que todavía se está esperando.
   */
  actualizar(dt, p, azar, permitirAparicion = true) {
    if (this.estado === ESTADOS.FUERA) return;

    // Aparición escalonada: cada trompo entra en su momento.
    if (this.estado === ESTADOS.ESPERA) {
      if (!permitirAparicion) {
        // Quieto: sólo se mantiene el giro y el reloj de la fase.
      } else if (this.marcaAparicion > 0) this.marcaAparicion -= dt;
      else this.estado = ESTADOS.APARECIENDO;
    }
    if (this.estado === ESTADOS.APARECIENDO) {
      this.aparicion += dt / p.vida.aparicion;
      if (this.aparicion >= 1) {
        this.aparicion = 1;
        // Si la ronda ya empezó, entra directo a la batalla; si no, espera.
        if (this.enLiza) this.estado = ESTADOS.ACTIVO;
        else this.estado = ESTADOS.APARECIENDO;
      }
    }

    // El giro se va cizando solo: el trompo se duerme.
    this.velGiro *= Math.exp(-p.fisica.roceGiro * dt);
    this.giro += this.velGiro * dt;

    if (this.proteccion > 0) this.proteccion -= dt;
    if (this.relojGolpe > 0) this.relojGolpe -= dt;
    if (this.proteccionPoder > 0) this.proteccionPoder = Math.max(0, this.proteccionPoder - dt);
    if (this.relojAtaque > 0) this.relojAtaque -= dt;

    // Desgaste: la vida también se va sin que nadie te toque.
    if (this.activo) {
      this.vida = Math.max(0, this.vida - p.danio.desgaste * dt);
    }

    if (this.estado === ESTADOS.KO) {
      this.muerte += dt / p.vida.muerte;
      if (this.muerte >= 1) {
        this.muerte = 1;
        this.estado = ESTADOS.FUERA;
      }
    }

    // Rastro: se guarda un punto cada `rastroCada` segundos, no en cada paso,
    // para que el trazo no dependa de la frecuencia de refresco.
    if (this.activo || this.estado === ESTADOS.KO) {
      this.relojRastro -= dt;
      if (this.relojRastro <= 0) {
        this.relojRastro = p.efectos.rastroCada;
        this.rastro.push({ x: this.x, y: this.y, giro: this.giro });
        while (this.rastro.length > p.efectos.rastroPuntos) this.rastro.shift();
      }
    } else if (this.rastro.length) {
      this.rastro.shift();
    }
  }

  /** Vuelve al estado inicial de la ronda (para «Reiniciar ronda»). */
  restaurar(instantanea) {
    this.x = instantanea.x;
    this.y = instantanea.y;
    this.vx = instantanea.vx;
    this.vy = instantanea.vy;
    this.vida = this.vidaMax;
    this.estado = ESTADOS.ESPERA;
    this.proteccion = 0;
    this.aparicion = 0;
    this.muerte = 0;
    this.rastro.length = 0;
    this.ultimoAtacante = null;
    this.eliminadoPor = null;
    this.momentoMuerte = null;
    this.eliminaciones = 0;
    this.danioRecibido = 0;
    this.danioHecho = 0;
    this.relojGolpe = 0;
    // Ventana propia de los poderes (regalos incluidos): un poder no debe quedar
    // anulado por la protección de un choque, pero dos poderes tampoco deben
    // encadenarse en el mismo instante sobre el mismo trompo.
    this.proteccionPoder = 0;
    this.relojAtaque = 0;
    this.esLider = false;
    this.marcaAparicion = instantanea.marcaAparicion ?? 0;
    this.giro = this.fase * Math.PI * 2;
    this.velGiro = instantanea.velGiro ?? 14;
    this.rumbo = instantanea.rumbo ?? Math.atan2(this.vy, this.vx);
  }
}
