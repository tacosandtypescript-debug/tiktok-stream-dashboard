// La simulación: fases, bucle, daño, eliminaciones, clasificación y sonido.
//
// Es el único módulo que conoce el conjunto. Todo lo demás es una pieza:
// `fisica.js` mueve, `efectos.js` decora, `mensajes.js` avisa, `sonido.js` suena,
// `dibujo/*` pinta. Aquí se decide cuándo ocurre cada cosa.
//
// Fases (las diez de la orden 01):
//   espera → aparicion → cuenta → batalla → victoria → reinicio → (ronda siguiente)
//
// El bucle usa paso fijo con acumulador. Es lo que hace que la batalla sea la misma
// en un portátil a 30 fps y en un sobremesa a 144: la física no depende del
// fotograma, sólo de cuántos pasos de 1/120 s hayan pasado.
//
// Orden 02: la escala de todo (trompos, efectos, etiquetas) sale del número de
// participantes, y la clasificación se dibuja arriba, en la franja reservada.

import { PARAMETROS, escalaTrompos, escalaEfectos, factorDanio, radioDe, limitesDe } from "./parametros.js";
import { Azar, semillaDeRonda } from "./azar.js";
import {
  crearAlineacion,
  anadirParticipante,
  disenoDeParticipante,
  ficha,
  PLANTILLA,
} from "./participantes.js";
import { Fotos } from "./fotos.js";
import {
  pasoFisica,
  calcularDanio,
  lanzarChoque,
  energia,
  dentroDeLaArena,
  peorSolape,
  velocidadMedia,
  pegadosAlBorde,
} from "./fisica.js";
import { Efectos } from "./efectos.js";
import { Mensajes } from "./mensajes.js";
import { Sonido } from "./sonido.js";
import { Tabla } from "./tabla.js";
import { Poderes, poderDeDiseno } from "./poderes.js";
import { Regalos } from "./regalos.js";
import { Usuarios } from "./usuarios.js";
import { dibujarCuerpos } from "./dibujo/trompo.js";
import { dibujarEtiquetas, escalaEtiqueta } from "./dibujo/etiquetas.js";
import { Clasificacion } from "./dibujo/clasificacion.js";
import {
  dibujarFondoPoderes,
  dibujarFrentePoderes,
  dibujarIndicadoresPoderes,
} from "./dibujo/poderes.js";
import {
  dibujarLimites,
  dibujarEspera,
  dibujarCuenta,
  dibujarVictoria,
  dibujarFase,
} from "./dibujo/capas.js";
import { TAU, limitar, mezclarColor } from "./util.js";

export const FASES = ["espera", "aparicion", "cuenta", "batalla", "victoria", "reinicio"];

export class Simulacion {
  constructor({ canvas, tabla, p = PARAMETROS }) {
    this.canvas = canvas ?? null;
    // El lienzo es opcional: sin él la simulación funciona igual (el banco de
    // pruebas de física corre en Node, sin navegador ni Canvas).
    this.ctx = canvas ? canvas.getContext("2d", { alpha: true }) : null;
    this.p = p;
    this.tabla = tabla instanceof Tabla ? tabla : new Tabla(tabla);
    this.clasificacion = new Clasificacion();
    this.sonido = new Sonido(p);
    // Los poderes: un estado por trompo (`trompo.poder`) y el gestor de la ronda.
    this.poderes = new Poderes(p);
    // Los regalos (orden 05): configuración, acumuladores, cola de espera e historial.
    this.regalos = new Regalos(p);
    // El registro de usuarios de TikTok (orden 06): identidad por userId y cola de espera.
    this.usuarios = new Usuarios(p);
    // El puente con TikTok lo conecta `principal.js` (el taller lo enseña y lo manda).
    this.conexion = null;
    // Las fotos se cargan una vez y se reutilizan: la identidad no depende de la ronda.
    this.fotos = new Fotos();

    // El lienzo tiene que ser exactamente 1080x1920: es el tamaño del overlay.
    if (canvas) {
      canvas.width = p.lienzo.ancho;
      canvas.height = p.lienzo.alto;
    }

    this.semillaBase = p.simulacion.semilla >>> 0;
    this.ronda = 0;
    this.trompos = [];
    this.mensajes = new Mensajes();
    this.efectos = new Efectos(new Azar(this.semillaBase), p);
    this.entradas = [];

    this.fase = "espera";
    this.tiempo = 0;
    this.tiempoFase = 0;
    this.tiempoBatalla = 0;
    this.arranque = 0;
    this.ganador = null;
    this.liderAnterior = null;
    this.pausa = false;
    this.sacudida = { x: 0, y: 0 };
    this.modoDepuracion = false;
    this.ultimoNumeroCuenta = null;

    this.acumulador = 0;
    this.ultimo = 0;
    this.fps = 0;
    this.cuadros = 0;
    this.relojFps = 0;
    this.relojClasificacion = 0;

    this.estadisticas = this.estadisticasVacias();
    this.montarRonda();
  }

  estadisticasVacias() {
    return {
      choques: 0,
      danio: 0,
      eliminaciones: [],
      // Historial de la ronda: quién cayó, quién lo tiró y quién se retiró a mano.
      retirados: [],
      rondas: 1,
      saltos: 0,
    };
  }

  // ------------------------------------------------------------ montaje

  /** Monta una ronda desde cero. Misma semilla y misma ronda = misma batalla. */
  montarRonda() {
    // La escala de los efectos depende del número de participantes: se recalcula
    // antes de crear la lista de efectos para que las partículas ya salgan a escala.
    this.p.efectos.escala = escalaEfectos(this.p);
    // Y la calibración del daño, que compensa que con los trompos pequeños hay menos
    // choques por segundo: así la ronda dura lo mismo con diez que con cuarenta.
    this.calibracion = factorDanio(this.p);
    // Con mucha gente el aura se recorta: es adorno, y cuarenta auras aditivas son
    // medio millón de píxeles de sobrecarga por fotograma.
    this.p.efectos.recorteAura =
      this.p.simulacion.participantes >= this.p.efectos.umbralAuraMuchos
        ? this.p.efectos.escalaAuraMuchos
        : 1;
    this.azar = new Azar(semillaDeRonda(this.semillaBase, this.ronda));
    // Los primeros sitios son de los espectadores de verdad (orden 06): conservan
    // nombre, foto y sitio de ronda en ronda.
    this.trompos = crearAlineacion(this.azar, this.p, this.ronda, this.usuarios.listar().filter((u) => u.active));
    // Los efectos llevan su propio flujo de azar, derivado de la semilla de la ronda.
    // Así un cambio de aspecto (más chispas, otras partículas) no puede alterar la
    // física: la pelea sigue siendo idéntica aunque se toque el dibujo.
    this.efectos = new Efectos(new Azar(this.azar.derivar(0x5eed)), this.p);
    // Cada trompo estrena su poder (los enfriamientos vuelven a cero con la ronda).
    this.poderes.limpiar();
    this.poderes.preparar(this.trompos);
    // Los acumuladores de ronda y la cola de regalos empiezan de cero en cada ronda.
    this.regalos.nuevaRonda();
    // Quien esperaba sitio entra en la ronda nueva.
    this.promoverDeEspera();
    this.mensajes.limpiar();
    this.clasificacion.limpiar();
    this.entradas = [];
    this.actualizarClasificacion(0, true);
    this.ganador = null;
    this.liderAnterior = null;
    this.fase = "espera";
    this.tiempoFase = 0;
    this.tiempoBatalla = 0;
    this.arranque = 0;
    this.ultimoNumeroCuenta = null;
    this.sacudida.x = 0;
    this.sacudida.y = 0;
    this.estadisticas = this.estadisticasVacias();
    this.estadisticas.rondas = this.ronda + 1;
    this.tabla.limpiar();
  }

  /** Vuelve a empezar todo: misma semilla (o nueva, si se pide). */
  reiniciar({ nuevaSemilla = false } = {}) {
    if (nuevaSemilla) this.semillaBase = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.ronda = 0;
    this.montarRonda();
    return this.semillaBase;
  }

  /** Repite la ronda actual tal cual (misma alineación, mismos choques). */
  reiniciarRonda() {
    this.montarRonda();
  }

  /** Pasa a la ronda siguiente. */
  siguienteRonda() {
    this.ronda += 1;
    this.montarRonda();
  }

  /**
   * Cambia el número de participantes y vuelve a montar la ronda.
   *
   * Se admite **0** a propósito (orden 03: hay que probar los casos límite). Con 0 o 1
   * la ronda se queda esperando en vez de declarar ganador a alguien que está solo.
   */
  cambiarParticipantes(n) {
    this.p.simulacion.participantes = limitar(Math.round(n), 0, Math.min(this.p.simulacion.maxParticipantes, PLANTILLA.length));
    this.reiniciar();
    return {
      participantes: this.p.simulacion.participantes,
      escala: escalaTrompos(this.p),
      radio: this.trompos[0]?.radio ?? 0,
    };
  }

  // ------------------------------------------------------------ taller

  impactoForzado() {
    const par = lanzarChoque(this.trompos, this.p);
    if (!par) return null;
    this.mensajes.anunciar("IMPACTO FORZADO", "#7fd7ff", "aviso");
    return { a: par.a.nombre, b: par.b.nombre };
  }

  anadirParticipante(identidad = null) {
    const t = anadirParticipante(this.azar, this.p, this.trompos, this.ronda, identidad);
    if (!t) return null;
    // Si ya se está peleando, entra en liza de inmediato; si no, espera su turno.
    t.enLiza = this.fase === "batalla" || this.fase === "victoria";
    if (t.enLiza) t.estado = "espera";
    this.tabla.firma = "";
    // El que entra estrena su poder: si no, se quedaría sin poder toda la ronda.
    this.poderes.preparar([t]);
    this.actualizarClasificacion(0, true);
    // Se pide la foto en cuanto entra, para que el medallón no salga en blanco.
    this.fotos.registro(t.foto);
    // Devuelve la ficha de identidad, con el sitio donde ha entrado.
    return { ...t.participante.ficha(), holguraEntrada: t.holguraEntrada ?? null, x: Math.round(t.x), y: Math.round(t.y) };
  }

  /**
   * Retira a un participante en mitad de la ronda (orden 03): usa el mismo fade que
   * una eliminación, se registra el motivo y se conserva en el historial.
   */
  quitarParticipante(id) {
    const t = this.trompos.find((x) => x.id === id && x.estado !== "fuera");
    if (!t) return null;
    const identidad = {
      nombre: t.nombre,
      inicial: t.inicial,
      foto: t.foto,
      color: t.color,
    };
    t.retirar(this.tiempo);
    this.estadisticas.retirados.push({
      id: t.id,
      nombre: t.nombre,
      momento: Number(this.tiempoBatalla.toFixed(2)),
      motivo: "retirado a mano desde el taller",
    });
    this.mensajes.anunciar(`${t.nombre.toUpperCase()} SALE DE LA ARENA`, t.color, "eliminacion", "retirado · no cuenta como baja", identidad);
    this.actualizarClasificacion(0, true);
    this.tabla.actualizar(this.trompos, { fase: this.fase, lider: this.lider() });
    return identidad;
  }

  /**
   * Cambia la identidad de un participante en caliente: nombre, foto, diseño y
   * variante. No reinicia la batalla: el trompo sigue donde estaba con su vida.
   */
  editarParticipante(id, cambios = {}) {
    const t = this.trompos.find((x) => x.id === id);
    if (!t || !t.participante) return null;
    const p = t.participante;
    if (cambios.nombre !== undefined) p.nombre = String(cambios.nombre).slice(0, 60) || p.nombre;
    if (cambios.foto !== undefined) {
      p.foto = cambios.foto;
      this.fotos.registro(p.foto);
    }
    if (cambios.disenoId !== undefined) p.disenoId = cambios.disenoId;
    if (cambios.variante !== undefined) p.variante = Number(cambios.variante) || 0;
    if (cambios.color !== undefined) p.color = cambios.color;

    if (cambios.disenoId !== undefined || cambios.variante !== undefined || cambios.color !== undefined) {
      // El diseño se rehace con la variante nueva. El radio y la masa cambian (cada
      // diseño tiene el suyo); el ataque y la defensa se quedan como estaban para no
      // alterar la pelea en curso.
      t.diseno = disenoDeParticipante(p.disenoId, p.color, p.variante);
      t.radio = radioDe(this.p, t.diseno);
      t.masa = this.p.trompo.densidadBase * t.diseno.densidad * Math.pow(t.radio / this.p.trompo.radioBase, 2);
      const L = limitesDe(this.p, t.radio);
      t.x = limitar(t.x, L.xMin, L.xMax);
      t.y = limitar(t.y, L.yMin, L.yMax);
    }
    this.tabla.firma = "";
    this.actualizarClasificacion(0, true);
    return p.ficha();
  }

  /** Devuelve todas las identidades de la ronda (para el editor del taller). */
  identidades() {
    return this.trompos.map((t) => ({
      ...t.participante.ficha(),
      vivo: t.activo,
      disenoNombre: t.diseno.nombre,
    }));
  }

  pausar() {
    this.pausa = true;
  }

  continuar() {
    this.pausa = false;
    this.acumulador = 0;
  }

  alternarPausa() {
    if (this.pausa) this.continuar();
    else this.pausar();
    return this.pausa;
  }

  /** Desbloquea el audio: hay que llamarlo desde una interacción del usuario. */
  desbloquearSonido() {
    return this.sonido.desbloquear();
  }

  // ------------------------------------------------------------ poderes

  /**
   * Lanza un poder en un participante concreto. Cualquiera puede lanzar cualquiera:
   * si no se dice clave, usa la de su diseño (su firma).
   */
  activarPoder(id, clave = null, forzar = false, objetivo = null) {
    const t = this.trompos.find((x) => x.id === id);
    if (!t) return null;
    const poder = this.poderes.activar(t, this, forzar, clave, objetivo);
    if (!poder) return null;
    const estado = this.poderes.deUnTrompo(t);
    return { ...estado, poder: poder.nombre, clave: poder.clave };
  }

  /** Lanza un poder en el primer participante que lo tenga listo. */
  activarPoderEnCualquiera(clave, forzar = true, objetivo = null) {
    const t = this.trompos.find(
      (x) => x.activo && x.poder?.estado === "listo" && this.poderes.enfriamientoDe(x, clave) <= 0,
    );
    return t ? this.activarPoder(t.id, clave, forzar, objetivo) : null;
  }

  /** Lanza un poder (o la firma del líder) en el que va primero en la clasificación. */
  activarPoderDelLider(clave = null, objetivo = null) {
    const orden = this.ordenarClasificacion();
    const t = orden.find(
      (x) => x.activo && x.poder?.estado === "listo" && (clave === null || this.poderes.enfriamientoDe(x, clave) <= 0),
    );
    return t ? this.activarPoder(t.id, clave, true, objetivo) : null;
  }

  /** Demostración automática reproducible (un poder detrás de otro). */
  demostracionPoderes(activar = null) {
    return this.poderes.demostracion(activar, this);
  }

  reiniciarPoderes() {
    this.poderes.reiniciarEnfriamientos(this.trompos);
    return this.poderes.estado(this);
  }

  // ------------------------------------------------------------ regalos

  /** ¿Queda sitio en la arena? (los que están «fuera» no ocupan). */
  haySitio() {
    const dentro = this.trompos.filter((t) => t.estado !== "fuera").length;
    return dentro < Math.min(this.p.simulacion.maxParticipantes, 40);
  }

  /**
   * Procesa un evento normalizado de TikTok (orden 06).
   *
   * Camino único: registro del usuario → recompensa según la tabla → efecto en su
   * trompo. Lo usan igual los eventos reales del bus y los simulados.
   */
  procesarEvento(evento) {
    const registro = this.usuarios.registrar(evento, this);
    const resultado = this.regalos.procesarEvento(this, evento, registro);
    if (registro.estado === "espera") {
      this.contadoresEspera = (this.contadoresEspera ?? 0) + 1;
      // Aviso en el overlay: el espectador entra, pero no cabe en la arena.
      if (registro.entraEnEspera || this.contadoresEspera % 3 === 1) {
        this.mensajes.anunciar(
          `EN ESPERA · ${registro.usuario.displayName.toUpperCase()}`,
          "#ffcc44",
          "poder",
          `arena llena (${this.usuarios.maximo}) · en cola ${this.usuarios.cuantosEnEspera}`,
          {
            nombre: registro.usuario.displayName,
            inicial: (registro.usuario.displayName ?? "?").charAt(0).toUpperCase(),
            foto: registro.usuario.avatarUrl || null,
            color: "#ffcc44",
          },
        );
      }
    }
    return { evento, resultado, usuario: registro.usuario, estadoUsuario: registro.estado, motivo: registro.motivo };
  }

  /** Mete en la arena a los que esperan y les aplica lo que tenían apuntado. */
  promoverDeEspera() {
    if (!this.usuarios.cuantosEnEspera || !this.haySitio()) return 0;
    const entrados = this.usuarios.promover(this);
    for (const { usuario, ficha, pendientes } of entrados) {
      const trompo = this.trompos.find((t) => t.id === ficha.id);
      for (const pendiente of pendientes) {
        const fila = this.regalos.regaloPorId(pendiente.regaloId);
        if (!fila || !trompo) continue;
        this.regalos.aplicar(this, {
          fila,
          trompo,
          cantidad: pendiente.cantidad,
          meta: {
            origen: "espera",
            userId: usuario.userId,
            displayName: usuario.displayName,
            avatarUrl: usuario.avatarUrl,
          },
          claveAcumulador: usuario.userId,
        });
      }
      // Se tacha lo apuntado para no aplicarlo dos veces.
      this.regalos.usuariosPendientes = this.regalos.usuariosPendientes.filter((u) => u.userId !== usuario.userId);
      this.mensajes.anunciar(
        `ENTRA ${usuario.displayName.toUpperCase()}`,
        "#4ade80",
        "poder",
        "venía de la cola de espera",
        {
          nombre: usuario.displayName,
          inicial: (usuario.displayName ?? "?").charAt(0).toUpperCase(),
          foto: usuario.avatarUrl || null,
          color: "#4ade80",
        },
      );
    }
    return entrados.length;
  }

  /** Envía un regalo simulado a mano desde el taller: {participanteId, regaloId, cantidad}. */
  enviarRegalo(datos) {
    return this.regalos.enviar(this, datos);
  }

  editarRegalo(id, cambios) {
    return this.regalos.editarRegalo(id, cambios);
  }

  anadirRegalo(fila) {
    return this.regalos.anadirRegalo(fila);
  }

  quitarRegalo(id) {
    return this.regalos.quitarRegalo(id);
  }

  guardarRegalos() {
    return this.regalos.guardar();
  }

  cargarRegalos() {
    return this.regalos.cargar();
  }

  estadoRegalos() {
    return this.regalos.estado();
  }

  /** Envía el registro de identidades al servidor del prototipo. */
  guardarUsuarios() {
    return fetch("/api/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.usuarios.exportar()),
    }).then((r) => r.json());
  }

  // ------------------------------------------------------------ paso

  /** Un paso de simulación. No dibuja: por eso se puede llamar en bucle. */
  paso(dt) {
    const p = this.p;
    this.tiempo += dt;
    this.tiempoFase += dt;

    // Decaimiento de la sacudida de cámara (sólo visual).
    const amortiguacion = Math.exp(-7 * dt);
    this.sacudida.x *= amortiguacion;
    this.sacudida.y *= amortiguacion;

    switch (this.fase) {
      case "espera": {
        // Con menos de dos participantes no hay batalla: se queda esperando en vez de
        // declarar ganador a alguien que está solo (orden 03: de 0 a 40).
        if (this.tiempoFase >= p.simulacion.espera && this.trompos.filter((t) => t.presente).length >= 2) {
          this.cambiarFase("aparicion");
        } else if (this.tiempoFase >= p.simulacion.espera && this.trompos.length < 2) {
          this.tiempoFase = p.simulacion.espera; // se queda aquí, sin avanzar
        }
        break;
      }
      case "aparicion": {
        if (this.tiempoFase >= p.simulacion.aparicion) this.cambiarFase("cuenta");
        break;
      }
      case "cuenta": {
        // Un pitido por número, no uno por paso.
        const numero = Math.max(1, Math.ceil(p.simulacion.cuenta - this.tiempoFase));
        if (numero !== this.ultimoNumeroCuenta) {
          this.ultimoNumeroCuenta = numero;
          this.sonido.tocar("cuenta", { paso: numero });
        }
        if (this.tiempoFase >= p.simulacion.cuenta) {
          this.cambiarFase("batalla");
          this.arranque = 0.85;
          for (const t of this.trompos) {
            t.enLiza = true;
            if (t.estado === "apareciendo") t.estado = "activo";
          }
          this.sonido.tocar("inicio", { intensidad: 1 });
        }
        break;
      }
      case "batalla": {
        this.tiempoBatalla += dt;
        if (this.arranque > 0) this.arranque -= dt;
        this.mover(dt);
        this.comprobarFinal();
        break;
      }
      case "victoria": {
        // La física sigue: el ganador no se queda congelado en mitad de un giro.
        this.mover(dt);
        break;
      }
      case "reinicio": {
        if (this.tiempoFase >= p.simulacion.reinicio) this.siguienteRonda();
        break;
      }
      default:
        break;
    }

    // Envejecimiento de las piezas y de los efectos: en todas las fases, para que
    // la aparición y el fade de muerte avancen aunque no haya física.
    const permitirAparicion = this.fase !== "espera";
    for (const t of this.trompos) t.actualizar(dt, p, this.azar, permitirAparicion);
    this.efectos.actualizar(dt);
    this.mensajes.actualizar(dt);
    // Los poderes avanzan en todas las fases: los enfriamientos tienen que correr
    // aunque la ronda esté en la cuenta atrás.
    this.poderes.actualizar(dt, this);
    // Y los regalos: saca de la cola lo que ya pueda lanzarse.
    this.regalos.actualizar(dt, this);
    // Cada segundo se mira si ha quedado sitio para quien espera (orden 06).
    this.relojEspera = (this.relojEspera ?? 0) + dt;
    if (this.relojEspera >= 1) {
      this.relojEspera = 0;
      this.promoverDeEspera();
    }

    // Eliminación por desgaste (sin culpable): la vida también se va sola.
    if (this.fase === "batalla") {
      for (const t of this.trompos) {
        if (t.activo && t.vida <= 0) this.eliminar(t, null);
      }
      this.comprobarLider();
      this.tabla.actualizar(this.trompos, { fase: this.fase, lider: this.lider() });
      this.actualizarClasificacion(dt);
    }

    this.cuadros += 1;
  }

  cambiarFase(fase) {
    this.fase = fase;
    this.tiempoFase = 0;
  }

  mover(dt) {
    const p = this.p;
    pasoFisica(this.trompos, dt, p, this.azar, (choque) => this.resolverImpacto(choque));
    for (const t of this.trompos) {
      if (t.activo) {
        // Seguro anti-teletransporte: nadie sale de la arena ni con un impulso bestia.
        const L = limitesRapidos(p, t.radio);
        if (t.x < L.xMin || t.x > L.xMax || t.y < L.yMin || t.y > L.yMax) {
          this.estadisticas.saltos += 1;
        }
      }
    }
    // Energía ambiental y chispas de avería: cosas de aspecto, así que van con el
    // azar de los efectos y no con el de la física.
    const azarVisual = this.efectos.azar;
    for (const t of this.trompos) {
      if (!t.activo) continue;
      const cuantas = p.efectos.energiaPorSegundo * p.aspecto.calidad * t.vidaPct * dt;
      if (azarVisual.siguiente() < cuantas) {
        this.efectos.energia(t.x, t.y, t.diseno.colores.claro, 0.5 + t.vidaPct, t.radio);
      }
      // Con la vida baja el trompo suelta chispas: se ve que está a punto de romperse.
      if (t.vidaPct < p.vida.baja) {
        const averia = (1 - t.vidaPct / p.vida.baja) * p.efectos.chispasAveria * p.aspecto.calidad * dt;
        if (azarVisual.siguiente() < averia) {
          this.efectos.chispas(
            t.x + azarVisual.rango(-t.radio, t.radio) * 0.7,
            t.y + azarVisual.rango(-t.radio, t.radio) * 0.7,
            2,
            t.diseno.colores.acento,
            160,
            null,
            Math.PI * 2,
          );
        }
      }
    }
  }

  /**
   * Presión de tiempo: a partir de `presionDesde` el daño sube para cerrar rondas.
   * Con mucha gente el umbral baja, porque hay más choques por segundo y la ronda se
   * cerraría antes de que se vea nada.
   */
  factorPresion() {
    const d = this.p.danio;
    const n = this.p.simulacion.participantes;
    const desde = limitar(
      d.presionDesde - (n - 10) * ((d.presionDesde - d.presionDesdeMinimo) / 30),
      d.presionDesdeMinimo,
      d.presionDesde,
    );
    const t = limitar((this.tiempoBatalla - desde) / 45, 0, 1);
    return 1 + t * (d.presionMaxima - 1);
  }

  /**
   * Resuelve un choque: daño, marcador, efectos, sonido y posible eliminación.
   * La física ya está hecha: aquí sólo se cobra el golpe.
   */
  resolverImpacto(c) {
    const p = this.p;
    const { a, b, cierre, x, y, nx, ny } = c;
    this.estadisticas.choques += 1;

    const presion = this.factorPresion() * this.calibracion;
    const d = p.danio;
    // Los poderes entran aquí, y sólo aquí, en el daño: el atacante puede pegar más
    // (filo radial) y la víctima puede esquivar, protegerse o absorber (escudo, cristal,
    // velo). La fórmula base del daño no se toca.
    const modA = this.poderes.modificadoresDe(a);
    const modB = this.poderes.modificadoresDe(b);
    const brutoA = calcularDanio(cierre, d.umbral, d.minimo, d.escala, presion, b, a) * modB.danioContacto;
    const brutoB = calcularDanio(cierre, d.umbral, d.minimo, d.escala, presion, a, b) * modA.danioContacto;
    const danioA = this.poderes.filtrarDanio(a, b, brutoA, this);
    const danioB = this.poderes.filtrarDanio(b, a, brutoB, this);
    const realA = a.recibirDanio(danioA, b, d.proteccion);
    const realB = b.recibirDanio(danioB, a, d.proteccion);
    const total = realA + realB;
    this.estadisticas.danio += total;

    // Y los filos (o la embestida umbría) cobran su parte extra al golpear.
    if (realB > 0) this.poderes.alImpactar(a, b, this);
    if (realA > 0) this.poderes.alImpactar(b, a, this);

    // Desempate del último duelo: si el choque final mata a los dos a la vez, se
    // queda en pie el que recibió menos daño en proporción a su vida. Sin esto la
    // ronda puede acabar sin nadie en la arena —un empate técnico— justo cuando la
    // orden pide «victoria del último trompo».
    const muereA = realA > 0 && a.vida <= 0;
    const muereB = realB > 0 && b.vida <= 0;
    if (muereA && muereB && this.trompos.filter((t) => t.activo).length <= 2) {
      const relativoA = realA / a.vidaMax;
      const relativoB = realB / b.vidaMax;
      const superviviente = relativoA <= relativoB ? a : b;
      // Se le deja un 1 % de vida: aguantó el último golpe. Con 1 punto exacto la
      // tabla enseñaría «0 %» al ganador, que se lee fatal.
      superviviente.vida = Math.max(1, superviviente.vidaMax * 0.01);
    }

    // Registro de quién pegó a quién: es lo que pide la orden (saber quién recibió el
    // golpe y quién lo produjo) y lo que usan el cartel, la tabla y las pruebas.
    if (realA > 0) {
      b.danioHecho += realA;
      b.ultimoGolpeado = a;
      b.relojAtaque = p.etiquetas.prioridadAtaque;
      a.relojGolpe = p.etiquetas.prioridadGolpe;
    }
    if (realB > 0) {
      a.danioHecho += realB;
      a.ultimoGolpeado = b;
      a.relojAtaque = p.etiquetas.prioridadAtaque;
      b.relojGolpe = p.etiquetas.prioridadGolpe;
    }

    // Un roce por debajo del umbral no hace daño y se dibuja flojo: se ve que ha
    // habido contacto, pero no cuenta.
    const fuerza = limitar(cierre, 40, 900);
    const color = mezclarColor(a.diseno.colores.base, b.diseno.colores.base, 0.5);
    const escala = (fuerza / 420) * p.aspecto.calidad;

    this.efectos.onda(x, y, color, fuerza * 0.7);
    this.efectos.chispas(
      x,
      y,
      Math.max(3, Math.round(p.efectos.chispasChoque * escala)),
      total > 0 ? a.diseno.colores.acento : color,
      fuerza * 0.9,
      { x: nx, y: ny },
      Math.PI * 0.7,
    );
    if (total > 0) {
      this.efectos.destello(x, y, color, limitar(total * 2.2, 30, 220));
      const k = limitar(total * 0.06, 0, p.efectos.sacudidaMaxima);
      const angulo = this.efectos.azar.rango(0, TAU);
      this.sacudida.x += Math.cos(angulo) * k;
      this.sacudida.y += Math.sin(angulo) * k;

      // Número de daño: quién lo recibe lo enseña encima de su trompo.
      if (realA > p.efectos.numeroMinimo * 0.2) {
        this.efectos.numero(a.x, a.y - a.radio * 1.4, realA, "#ffffff", a.radio);
      }
      if (realB > p.efectos.numeroMinimo * 0.2) {
        this.efectos.numero(b.x, b.y - b.radio * 1.4, realB, "#ffffff", b.radio);
      }

      // Un solo sonido por choque, y el más fuerte manda: si suenan los dos a la vez
      // con cuarenta trompos, aquello es una lavadora.
      const fuerte = total >= p.sonido.umbralFuerte;
      const intensidad = limitar(total / 40, 0.2, 1);
      this.sonido.tocar(fuerte ? "choqueFuerte" : "choqueLeve", { intensidad });
      if (total >= p.sonido.umbralFuerte * 2.2) this.sonido.tocar("dano", { intensidad });
    }

    if (realA > 0 && a.vida <= 0) this.eliminar(a, b);
    if (realB > 0 && b.vida <= 0) this.eliminar(b, a);
  }

  /** Eliminación: mensaje, explosión, sonido y recuento. */
  eliminar(t, asesinoDirecto) {
    if (!t.activo) return;
    const antes = t.ultimoAtacante;
    const culpable = t.morir(this.tiempo, this.azar) ?? asesinoDirecto ?? antes;
    this.efectos.explosion(t.x, t.y, t.diseno.colores.base, t.diseno.colores.acento, t.radio);
    this.estadisticas.eliminaciones.push({
      id: t.id,
      nombre: t.nombre,
      inicial: t.inicial,
      foto: t.foto,
      color: t.color,
      por: culpable ? culpable.nombre : null,
      porId: culpable ? culpable.id : null,
      momento: Number(this.tiempoBatalla.toFixed(2)),
      motivo: "eliminado en combate",
    });
    this.sacudir(70);
    this.sonido.tocar("eliminacion", { intensidad: 0.8 });

    // Si el golpe que la ha matado venía de un poder, el cartel lo dice: atacante,
    // objetivo y tipo de poder (orden 04, legibilidad).
    const clavePoder = typeof t.ultimaFuente === "string" && t.ultimaFuente.startsWith("poder:")
      ? t.ultimaFuente.slice(6)
      : null;
    if (clavePoder) this.poderes.eliminacionesPorPoder += 1;

    const vivos = this.trompos.filter((x) => x.activo).length;
    const color = t.color;
    const texto = culpable
      ? `${culpable.nombre.toUpperCase()} ELIMINÓ A ${t.nombre.toUpperCase()}`
      : `${t.nombre.toUpperCase()} SE QUEDÓ SIN ENERGÍA`;
    const subtexto = clavePoder
      ? `${poderDeDiseno(clavePoder).nombre} · quedan ${vivos}`
      : `${t.diseno.nombre} fuera · quedan ${vivos}`;
    // La identidad va en el cartel: la cara de quien cae, para que se sepa quién es.
    this.mensajes.anunciar(texto, color, "eliminacion", subtexto, {
      nombre: t.nombre,
      inicial: t.inicial,
      foto: t.foto,
      color: t.color,
    });
  }

  /** El líder es el que más vida tiene de los que siguen en pie. */
  lider() {
    let mejor = null;
    for (const t of this.trompos) {
      if (!t.activo) continue;
      if (!mejor || t.vida > mejor.vida) mejor = t;
    }
    return mejor;
  }

  comprobarLider() {
    const lider = this.lider();
    for (const t of this.trompos) t.esLider = t === lider && this.fase === "batalla";
    if (this.fase !== "batalla" || !lider) return;

    if (!this.liderAnterior) {
      this.liderAnterior = lider;
      this.momentoLider = this.tiempo;
      return;
    }
    if (lider === this.liderAnterior) return;

    // El liderato cambia con cada choque. Se anuncia sólo si el anterior aguantó lo
    // suficiente y el nuevo le saca ventaja clara; si no, el cartel taparía la pelea.
    const aguante = this.tiempo - (this.momentoLider ?? 0);
    const ventaja = lider.vida / Math.max(1, this.liderAnterior?.vida ?? 1);
    if (this.liderAnterior && aguante >= this.p.simulacion.liderAvisoDesde && ventaja >= this.p.simulacion.liderVentaja) {
      this.mensajes.anunciar(
        `NUEVO LÍDER: ${lider.nombre.toUpperCase()}`,
        lider.color,
        "lider",
        "",
        { nombre: lider.nombre, inicial: lider.inicial, foto: lider.foto, color: lider.color },
      );
      this.liderAnterior = lider;
      this.momentoLider = this.tiempo;
    }
  }

  comprobarFinal() {
    // Con menos de dos participantes no hay ronda que cerrar.
    if (this.trompos.filter((t) => t.presente).length < 2) return;
    const vivos = this.trompos.filter((t) => t.activo);
    const agotado = this.tiempoBatalla >= this.p.simulacion.batallaMaxima;
    if (vivos.length > 1 && !agotado) return;

    // Si se agotó el tiempo, gana el que más vida tiene; si no queda nadie, empate.
    this.ganador = vivos.length === 1 ? vivos[0] : vivos.sort((a, b) => b.vida - a.vida)[0] ?? null;
    if (agotado && this.ganador) {
      // Los que quedan se apagan a la vez: la ronda termina limpia.
      for (const t of vivos) {
        if (t !== this.ganador) this.eliminar(t, null);
      }
    }
    // El cartel de ganador ocupa la franja inferior: se retiran las eliminaciones
    // para que no se pisen (la orden pide que no se cubra la arena de efectos).
    this.mensajes.limpiar();
    for (const t of this.trompos) t.esLider = t === this.ganador;
    // La clasificación se refresca con el resultado final: si no, quedaría congelada
    // en el fotograma anterior al último golpe y enseñaría como líder a quien acaba
    // de caer.
    this.actualizarClasificacion(0, true);
    this.tabla.actualizar(this.trompos, { fase: "victoria", lider: this.lider() });
    this.sonido.tocar("victoria", { intensidad: 1 });
    this.cambiarFase("victoria");
  }

  sacudir(k) {
    const max = this.p.efectos.sacudidaMaxima;
    const magnitud = limitar((k * this.p.fisica.sacudida) / 10, 0, max);
    const angulo = this.efectos.azar.rango(0, TAU);
    this.sacudida.x = limitar(this.sacudida.x + Math.cos(angulo) * magnitud, -max, max);
    this.sacudida.y = limitar(this.sacudida.y + Math.sin(angulo) * magnitud, -max, max);
  }

  // ------------------------------------------------------------ clasificación

  /**
   * Orden de la clasificación (orden 02): vida actual, daño hecho, eliminaciones y,
   * para desempatar, el identificador. Los eliminados van al final, por orden de
   * caída, pero siguen en la lista hasta que desaparecen.
   */
  ordenarClasificacion() {
    return [...this.trompos].sort((a, b) => {
      const vivoA = a.activo ? 0 : 1;
      const vivoB = b.activo ? 0 : 1;
      if (vivoA !== vivoB) return vivoA - vivoB;
      if (vivoA === 0) {
        if (b.vidaPct !== a.vidaPct) return b.vidaPct - a.vidaPct;
        if (b.danioHecho !== a.danioHecho) return b.danioHecho - a.danioHecho;
        if (b.eliminaciones !== a.eliminaciones) return b.eliminaciones - a.eliminaciones;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }
      return (a.momentoMuerte ?? 0) - (b.momentoMuerte ?? 0);
    });
  }

  /** Entradas listas para pintar (posición, identidad, vida y estado). */
  entradasDeClasificacion() {
    const lider = this.lider();
    const orden = this.ordenarClasificacion();
    // Se sincronizan las fichas de identidad con lo que pasa en la arena: es lo que
    // pide la orden (vida actual, posición, estado, eliminaciones y daño realizado).
    orden.forEach((t, i) => t.participante?.sincronizar(t, i + 1));
    return orden.map((t, i) => ({
      id: t.id,
      nombre: t.nombre,
      nombreCompleto: t.nombre,
      inicial: t.inicial,
      foto: t.foto,
      color: t.color,
      acento: t.diseno.colores.acento,
      disenoId: t.diseno.clave,
      disenoNombre: t.diseno.nombre,
      variante: t.diseno.variante ?? 0,
      vida: t.vida,
      vidaPct: t.vidaPct,
      posicion: i + 1,
      eliminaciones: t.eliminaciones,
      danioHecho: Math.round(t.danioHecho),
      estado: this.estadoDe(t, lider),
      motivo: t.motivo,
      activo: t.activo,
    }));
  }

  estadoDe(t, lider) {
    if (!t.activo) return t.motivo === "retirado" ? "RETIRADO" : "KO";
    if (this.fase === "espera" || this.fase === "aparicion" || this.fase === "cuenta") return "LISTO";
    if (lider && t === lider) return "LÍDER";
    if (t.vidaPct < this.p.vida.baja) return "DÉBIL";
    return "ACTIVO";
  }

  /** Recalcula la clasificación como mucho 30 veces por segundo. */
  actualizarClasificacion(dt, forzar = false) {
    this.relojClasificacion += dt;
    if (!forzar && this.relojClasificacion < 1 / 30) return;
    this.relojClasificacion = 0;
    this.entradas = this.entradasDeClasificacion();
    this.clasificacion.actualizar(this.entradas, forzar ? 0 : 1 / 30);
  }

  // ------------------------------------------------------------ dibujo

  dibujar() {
    if (!this.ctx) return;
    const p = this.p;
    const ctx = this.ctx;
    const { ancho, alto } = p.lienzo;

    // Sin relleno de fondo: el lienzo se queda transparente. Es lo que permite
    // ponerlo sobre la cámara en OBS.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, ancho, alto);

    ctx.save();
    ctx.translate(this.sacudida.x, this.sacudida.y);

    if (p.aspecto.verLimites) dibujarLimites(ctx, p);
    if (this.fase === "espera") dibujarEspera(ctx, p, this.trompos.length, this.tiempo);

    // Orden de capas (orden 04): lo grande de los poderes detrás de los trompos, los
    // efectos de encima del cuerpo, y **después** las etiquetas: los nombres, la foto y
    // el arco de vida no los tapa ningún poder.
    if (p.poderes.verEfectos) dibujarFondoPoderes(ctx, this);
    const orden = dibujarCuerpos(ctx, this.trompos, this.tiempo, p);
    if (p.poderes.verEfectos) dibujarFrentePoderes(ctx, this);
    dibujarEtiquetas(ctx, orden, this.tiempo, p, this.fotos);

    this.efectos.dibujarOndas(ctx);
    this.efectos.dibujarParticulas(ctx);
    this.efectos.dibujarCortes(ctx);
    this.efectos.dibujarDestellos(ctx);
    this.efectos.dibujarNumeros(ctx);
    // Los indicadores de poder (chapa con el nombre, aros) van encima de las partículas
    // pero por debajo de la tabla y de los carteles.
    dibujarIndicadoresPoderes(ctx, this);

    if (this.fase === "cuenta") {
      const dentro = this.tiempoFase % 1;
      const numero = Math.max(1, Math.ceil(p.simulacion.cuenta - this.tiempoFase));
      dibujarCuenta(ctx, p, numero, dentro, false);
    }
    if (this.fase === "batalla" && this.arranque > 0) {
      dibujarCuenta(ctx, p, 0, this.arranque / 0.85, true);
    }
    if (this.fase === "victoria") {
      dibujarVictoria(ctx, p, this.ganador, this.tiempoFase, p.simulacion.victoria, this.ronda + 1, this.tiempo);
    }

    this.mensajes.dibujar(ctx, ancho, alto, {
      margenArriba: p.lienzo.margenArriba,
      maxEliminaciones: this.fase === "victoria" ? 0 : 2,
      fotos: this.fotos,
    });

    // La clasificación va encima de todo: es la franja reservada de arriba.
    if (p.aspecto.verTabla) {
      if (!this.entradas.length) this.actualizarClasificacion(0, true);
      this.clasificacion.dibujar(
        ctx,
        this.entradas,
        p,
        {
          ronda: this.ronda + 1,
          vivos: this.trompos.filter((t) => t.activo).length,
          total: this.trompos.length,
        },
        this.fotos,
      );
    }

    if (this.modoDepuracion) {
      const e = energia(this.trompos);
      dibujarFase(
        ctx,
        p,
        `${this.fase}  batalla ${this.tiempoBatalla.toFixed(1)}s  vivos ${this.trompos.filter((t) => t.activo).length}  ` +
          `choques ${this.estadisticas.choques}  partículas ${this.efectos.particulas.length}  ` +
          `energía ${e.total.toFixed(0)}  ${this.fps.toFixed(0)} fps`,
        this.tiempo,
      );
    }

    ctx.restore();
  }

  // ------------------------------------------------------------ bucle

  arrancar() {
    this.ultimo = 0;
    const bucle = (ts) => {
      this.manejador = requestAnimationFrame(bucle);
      this.fotograma(ts);
    };
    this.manejador = requestAnimationFrame(bucle);
    return this;
  }

  fotograma(ts) {
    if (!this.ultimo) this.ultimo = ts;
    let bruto = (ts - this.ultimo) / 1000;
    this.ultimo = ts;

    // Tiempo delta limitado: si la pestaña estuvo en segundo plano o el navegador
    // se atrasó, no se simulan 30 s de golpe (eso teletransportaría a los trompos).
    bruto = limitar(bruto, 0, 0.25);

    if (!this.pausa) {
      this.acumulador += bruto * this.p.tiempo.velocidad;
      let pasos = 0;
      const maxPasos = this.p.tiempo.pasosMaximos;
      while (this.acumulador >= this.p.tiempo.paso && pasos < maxPasos) {
        this.paso(this.p.tiempo.paso);
        this.acumulador -= this.p.tiempo.paso;
        pasos += 1;
      }
      // Si aún queda atraso por encima del techo, se tira: prefiero perder tiempo
      // de simulación a dar un salto.
      if (this.acumulador > this.p.tiempo.paso * maxPasos) this.acumulador = 0;
      if (pasos === 0 && bruto > 0) this.acumulador = Math.min(this.acumulador, this.p.tiempo.paso);
    }

    this.dibujar();
    this.medirFps(bruto);
  }

  medirFps(dt) {
    if (dt <= 0) return;
    this.relojFps += dt;
    const fps = 1 / dt;
    this.fps = this.fps ? this.fps * 0.9 + fps * 0.1 : fps;
    if (this.relojFps > 0.5) this.relojFps = 0;
  }

  detener() {
    if (this.manejador) cancelAnimationFrame(this.manejador);
    this.manejador = null;
  }

  // ------------------------------------------------------------ banco de pruebas

  /**
   * Simula `segundos` de golpe, sin dibujar. Sirve para dos cosas: revisar la
   * física en un instante (el botón «Simular 30 s» del taller) y comprobar en
   * automático que las rondas terminan con un ganador.
   */
  simular(segundos, { hastaElFinal = false, maxSegundos = 300 } = {}) {
    const paso = this.p.tiempo.paso;
    const objetivo = Math.floor((hastaElFinal ? maxSegundos : segundos) / paso);
    let pasos = 0;
    let vueltas = 0;
    while (pasos < objetivo) {
      this.paso(paso);
      pasos += 1;
      if (this.fase === "victoria" && hastaElFinal) break;
      // Tope de seguridad: 5 rondas seguidas bastan para saber si algo no cierra.
      if (this.fase === "reinicio") {
        vueltas += 1;
        if (vueltas > 5) break;
      }
    }
    return this.estado();
  }

  /** Foto numérica del estado, para el HUD y para las comprobaciones. */
  estado() {
    const vivos = this.trompos.filter((t) => t.activo);
    const p = this.p;
    return {
      fase: this.fase,
      ronda: this.ronda + 1,
      semilla: this.semillaBase,
      participantes: p.simulacion.participantes,
      tiempo: Number(this.tiempo.toFixed(2)),
      tiempoBatalla: Number(this.tiempoBatalla.toFixed(2)),
      presion: Number(this.factorPresion().toFixed(2)),
      vivos: vivos.length,
      eliminados: this.trompos.length - vivos.length,
      ganador: this.ganador ? this.ganador.nombre : null,
      choques: this.estadisticas.choques,
      danio: Math.round(this.estadisticas.danio),
      eliminaciones: this.estadisticas.eliminaciones,
      retirados: this.estadisticas.retirados,
      saltos: this.estadisticas.saltos,
      fueraDeLaArena: dentroDeLaArena(this.trompos, p),
      peorSolape: peorSolape(this.trompos),
      velocidadMedia: Number(velocidadMedia(this.trompos).toFixed(1)),
      pegadosAlBorde: pegadosAlBorde(this.trompos, p),
      particulas: this.efectos.particulas.length,
      ondas: this.efectos.ondas.length,
      numeros: this.efectos.numeros.length,
      mensajes: this.mensajes.lista.length,
      fps: Number(this.fps.toFixed(1)),
      pausa: this.pausa,
      escala: {
        trompos: Number(escalaTrompos(p).toFixed(3)),
        efectos: Number(p.efectos.escala.toFixed(3)),
        etiquetas: Number(escalaEtiqueta(p).toFixed(3)),
        radio: Number((this.trompos[0]?.radio ?? 0).toFixed(1)),
        calibracionDanio: Number((this.calibracion ?? 1).toFixed(3)),
      },
      lienzo: { ancho: p.lienzo.ancho, alto: p.lienzo.alto },
      energia: energia(this.trompos),
      sonido: this.sonido.estado(),
      fotos: this.fotos.estado(),
      poderes: this.poderes.estado(this),
      regalos: this.regalos.estado(),
      usuarios: this.usuarios.estado(),
      identidades: this.identidades(),
      clasificacion: this.entradas.slice(0, 6),
      trompos: this.trompos.map(ficha),
    };
  }
}

/** Límites de la arena sin importar el módulo de física (para el contador de saltos). */
function limitesRapidos(p, radio) {
  return {
    xMin: p.lienzo.margenLados + radio,
    xMax: p.lienzo.ancho - p.lienzo.margenLados - radio,
    yMin: p.lienzo.margenArriba + radio,
    yMax: p.lienzo.alto - p.lienzo.margenAbajo - radio,
  };
}
