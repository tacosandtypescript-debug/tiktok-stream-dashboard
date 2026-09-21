// Taller: los controles de desarrollo y las lecturas.
//
// Esto NO forma parte del overlay. La orden lo dice: los controles son sólo para
// probar el prototipo. Por eso viven en HTML, fuera del lienzo, y con `?limpio=1`
// desaparecen y queda sólo la arena.
//
// Orden 02: aquí se cambia el número de participantes (10, 20, 30, 40) y se encienden
// y apagan las capas —nombres, tabla, partículas, hitboxes— y el sonido.

import { DISENOS, ORDEN_DISENOS } from "./dibujo/disenos.js";
import { PODERES, ORDEN_PODERES } from "./poderes.js";
import { RECOMPENSAS, OBJETIVOS, ACUMULACIONES, REGLAS_ESPERA } from "./regalos.js";
import { ESCENARIOS, eventoDePrueba } from "./tiktok.js";
import { escalaTrompos, escalaEfectos } from "./parametros.js";
import { PLANTILLA } from "./participantes.js";
import { limitar } from "./util.js";

const $ = (id) => document.getElementById(id);

export class Taller {
  constructor(simulacion, parametros) {
    this.sim = simulacion;
    this.p = parametros;
    this.reloj = 0;
    this.avisos = [];
  }

  montar() {
    const p = this.p;
    const sim = this.sim;

    // --- participantes
    this.pintarParticipantes();
    for (const boton of document.querySelectorAll("#grupoParticipantes button")) {
      boton.addEventListener("click", () => {
        const n = Number(boton.dataset.participantes);
        const info = sim.cambiarParticipantes(n);
        this.pintarParticipantes();
        this.avisar(
          `${info.participantes} participantes · escala ${info.escala.toFixed(2)} · radio ${info.radio.toFixed(0)} px`,
        );
      });
    }

    // --- botones
    $("btnReiniciar")?.addEventListener("click", () => {
      sim.reiniciar();
      this.avisar("Partida reiniciada con la misma semilla");
    });
    $("btnPausa")?.addEventListener("click", () => {
      const pausa = sim.alternarPausa();
      $("btnPausa").textContent = pausa ? "Continuar" : "Pausar";
      $("btnPausa").dataset.activo = pausa ? "1" : "0";
    });
    $("btnImpacto")?.addEventListener("click", () => {
      const par = sim.impactoForzado();
      this.avisar(par ? `Impacto forzado: ${par.a} contra ${par.b}` : "No hay dos trompos vivos");
    });
    $("btnAnadir")?.addEventListener("click", () => {
      const quien = sim.anadirParticipante();
      this.pintarIdentidades();
      this.avisar(
        quien
          ? `Entra ${quien.nombre} (${quien.disenoId}${quien.variante ? ` v${quien.variante + 1}` : ""}) con ${quien.holguraEntrada} px de holgura`
          : "No caben más participantes",
      );
    });
    $("btnRonda")?.addEventListener("click", () => {
      sim.reiniciarRonda();
      this.avisar(`Ronda ${sim.ronda + 1} repetida desde el principio`);
    });
    $("btnSiguiente")?.addEventListener("click", () => {
      sim.siguienteRonda();
      this.avisar(`Ronda ${sim.ronda + 1}`);
    });
    $("btnSimular")?.addEventListener("click", () => {
      const segundos = Number($("inSimular")?.value ?? 30);
      const estabaPausado = sim.pausa;
      const antes = sim.estadisticas.choques;
      const e = sim.simular(segundos);
      sim.dibujar();
      if (estabaPausado) sim.pausar();
      this.avisar(
        `${segundos} s simulados: ${e.choques - antes} choques, ${e.vivos} vivos` +
          (e.ganador ? `, gana ${e.ganador}` : ""),
      );
    });
    $("btnHastaFinal")?.addEventListener("click", () => {
      const e = sim.simular(0, { hastaElFinal: true, maxSegundos: 400 });
      sim.dibujar();
      this.avisar(e.ganador ? `Final: gana ${e.ganador} (ronda ${e.ronda})` : `Final sin ganador: ${e.fase}`);
    });
    $("btnSemilla")?.addEventListener("click", () => {
      const semilla = Math.floor(Math.random() * 0xffffffff) >>> 0;
      this.p.simulacion.semilla = semilla;
      $("inSemilla").value = String(semilla);
      sim.semillaBase = semilla;
      sim.reiniciar();
      this.avisar(`Semilla nueva: ${semilla}`);
    });

    // --- parámetros
    const semillaInput = $("inSemilla");
    if (semillaInput) {
      semillaInput.value = String(sim.semillaBase);
      semillaInput.addEventListener("change", () => {
        const v = Number(semillaInput.value) >>> 0;
        this.p.simulacion.semilla = v;
        sim.semillaBase = v;
        sim.reiniciar();
      });
    }

    const velocidad = $("inVelocidad");
    if (velocidad) {
      velocidad.value = String(p.tiempo.velocidad);
      $("outVelocidad").textContent = `${p.tiempo.velocidad}×`;
      velocidad.addEventListener("input", () => {
        p.tiempo.velocidad = Number(velocidad.value);
        $("outVelocidad").textContent = `${p.tiempo.velocidad}×`;
      });
    }

    const fondo = $("selFondo");
    if (fondo) {
      fondo.value = p.aspecto.fondo;
      this.aplicarFondo(p.aspecto.fondo);
      fondo.addEventListener("change", () => {
        p.aspecto.fondo = fondo.value;
        this.aplicarFondo(fondo.value);
      });
    }

    const calidad = $("selCalidad");
    if (calidad) {
      calidad.value = String(p.aspecto.calidad);
      calidad.addEventListener("change", () => {
        p.aspecto.calidad = Number(calidad.value);
        sim.efectos.recortar();
      });
    }

    for (const [id, clave] of [
      ["chkHitboxes", null],
      ["chkDepura", null],
      ["chkNombres", "verNombres"],
      ["chkTabla", "verTabla"],
      ["chkParticulas", "verParticulas"],
      ["chkOrbitas", "verOrbitas"],
      ["chkRastro", "verRastro"],
    ]) {
      const casilla = $(id);
      if (!casilla) continue;
      if (clave) {
        casilla.checked = p.aspecto[clave];
        casilla.addEventListener("change", () => {
          p.aspecto[clave] = casilla.checked;
        });
      }
    }
    // «Hitboxes» enciende los radios y los límites a la vez: es lo que se mira para
    // comprobar que nadie se sale ni se solapa.
    $("chkHitboxes")?.addEventListener("change", (ev) => {
      p.aspecto.verRadios = ev.target.checked;
      p.aspecto.verLimites = ev.target.checked;
    });
    $("chkDepura")?.addEventListener("change", (ev) => {
      sim.modoDepuracion = ev.target.checked;
    });

    // --- sonido
    const chkSonido = $("chkSonido");
    if (chkSonido) {
      chkSonido.checked = p.sonido.activo;
      chkSonido.addEventListener("change", () => {
        sim.sonido.silenciar(!chkSonido.checked);
        this.refrescarAudio();
        this.avisar(chkSonido.checked ? "Sonido activado" : "Sonido silenciado");
      });
    }
    const volumen = $("inVolumen");
    if (volumen) {
      volumen.value = String(p.sonido.volumen);
      $("outVolumen").textContent = `${Math.round(p.sonido.volumen * 100)} %`;
      volumen.addEventListener("input", () => {
        sim.sonido.volumen(Number(volumen.value));
        $("outVolumen").textContent = `${Math.round(p.sonido.volumen * 100)} %`;
      });
    }
    $("btnProbarSonidos")?.addEventListener("click", () => {
      sim.desbloquearSonido();
      const nombres = sim.sonido.probar();
      this.refrescarAudio();
      this.avisar(`Suenan: ${nombres.join(", ")}`);
    });
    $("btnSilenciar")?.addEventListener("click", () => {
      const activo = sim.sonido.silenciar(p.sonido.activo);
      if (chkSonido) chkSonido.checked = activo;
      this.refrescarAudio();
      this.avisar(activo ? "Sonido activado" : "Sonido silenciado");
    });

    // El navegador no deja sonar hasta que el usuario toca la página: el primer clic
    // o la primera tecla crean el AudioContext. Se quitan los escuchas al hacerlo.
    const desbloquear = () => {
      sim.desbloquearSonido();
      this.refrescarAudio();
      window.removeEventListener("pointerdown", desbloquear);
      window.removeEventListener("keydown", desbloquear);
    };
    window.addEventListener("pointerdown", desbloquear);
    window.addEventListener("keydown", desbloquear);

    // --- identidad (orden 03)
    this.pintarIdentidades();
    $("selParticipante")?.addEventListener("change", () => this.rellenarIdentidad());
    $("btnGuardarIdentidad")?.addEventListener("click", () => this.aplicarIdentidad());
    $("btnQuitar")?.addEventListener("click", () => {
      const id = $("selParticipante")?.value;
      if (!id) return;
      const salida = sim.quitarParticipante(id);
      this.pintarIdentidades();
      this.avisar(salida ? `${salida.nombre} sale de la arena (retirado)` : "Ese participante ya no está");
    });
    $("btnFotoRota")?.addEventListener("click", () => this.aplicarIdentidad({ foto: "fotos/falta-99.png" }));
    $("btnSinFoto")?.addEventListener("click", () => this.aplicarIdentidad({ foto: null }));
    $("btnFotoPanoramica")?.addEventListener("click", () => this.aplicarIdentidad({ foto: "fotos/panoramica-01.png" }));
    $("btnNombreLargo")?.addEventListener("click", () =>
      this.aplicarIdentidad({ nombre: "María del Carmen de los Ángeles Fernández" }),
    );
    $("btnDuplicarNombre")?.addEventListener("click", () => {
      const otro = sim.trompos.find((t) => t.id !== $("selParticipante")?.value);
      if (otro) this.aplicarIdentidad({ nombre: otro.nombre });
    });
    $("btnRestaurarIdentidad")?.addEventListener("click", () => {
      sim.reiniciar();
      this.pintarIdentidades();
      this.avisar("Plantilla de identidades restaurada (misma semilla)");
    });

    // --- tiktok (orden 06)
    this.pintarTikTok();

    // --- regalos (orden 05)
    this.pintarRegalos();

    // --- poderes (orden 04)
    this.pintarPoderes();
    $("btnDemo")?.addEventListener("click", () => {
      const activa = sim.demostracionPoderes();
      $("btnDemo").dataset.activo = activa ? "1" : "0";
      this.avisar(activa ? "Demostración automática en marcha (reproducible)" : "Demostración parada");
    });
    $("btnPoderLider")?.addEventListener("click", () => {
      const usado = sim.activarPoderDelLider();
      this.avisar(usado ? `${usado.poder} de ${usado.nombre}` : "El líder no tiene el poder listo");
    });
    $("btnPoderesListos")?.addEventListener("click", () => {
      const e = sim.reiniciarPoderes();
      this.avisar(`Enfriamientos reiniciados (${e.participantes.length} poderes listos)`);
    });

    // --- lista de los diez diseños
    this.pintarDisenos();

    // --- atajos de teclado
    window.addEventListener("keydown", (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
      const tecla = ev.key.toLowerCase();
      if (tecla === " ") {
        ev.preventDefault();
        $("btnPausa")?.click();
      } else if (tecla === "r") $("btnReiniciar")?.click();
      else if (tecla === "i") $("btnImpacto")?.click();
      else if (tecla === "a") $("btnAnadir")?.click();
      else if (tecla === "d") $("chkDepura")?.click();
      else if (tecla === "n") $("chkNombres")?.click();
      else if (tecla === "t") $("chkTabla")?.click();
      else if (tecla === "s") $("chkSonido")?.click();
      else if (tecla === "z") $("btnPoderLider")?.click();
      else if (tecla === "x") $("btnDemo")?.click();
      else if (ev.shiftKey && /^[0-9]$/.test(tecla)) {
        // Mayús + número: lanza ese poder en el participante elegido (cualquiera puede
        // usar cualquiera de los diez).
        const indice = tecla === "0" ? 9 : Number(tecla) - 1;
        this.lanzarPoder(ORDEN_PODERES[indice]);
      }
      else if (tecla === "1") document.querySelector('[data-participantes="10"]')?.click();
      else if (tecla === "2") document.querySelector('[data-participantes="20"]')?.click();
      else if (tecla === "3") document.querySelector('[data-participantes="30"]')?.click();
      else if (tecla === "4") document.querySelector('[data-participantes="40"]')?.click();
    });

    this.refrescarAudio();
    return this;
  }

  pintarParticipantes() {
    const n = this.p.simulacion.participantes;
    for (const boton of document.querySelectorAll("#grupoParticipantes button")) {
      const activo = Number(boton.dataset.participantes) === n;
      boton.dataset.activo = activo ? "1" : "0";
    }
    const escala = $("outEscala");
    if (escala) escala.textContent = escalaTrompos(this.p).toFixed(2).replace(".", ",");
    const efectos = $("outEscalaEfectos");
    if (efectos) efectos.textContent = escalaEfectos(this.p).toFixed(2).replace(".", ",");
    this.pintarIdentidades();
  }

  // ------------------------------------------------------------ identidad

  /** Rellena el desplegable de participantes y el de fotos disponibles. */
  pintarIdentidades() {
    const lista = this.sim.trompos;
    const select = $("selParticipante");
    if (select) {
      const antes = select.value;
      select.innerHTML = lista
        .map(
          (t, i) =>
            `<option value="${t.id}">${i + 1}. ${t.nombre}${t.activo ? "" : " (fuera)"}</option>`,
        )
        .join("");
      if (lista.some((t) => t.id === antes)) select.value = antes;
    }
    const fotos = $("selFoto");
    if (fotos && !fotos.dataset.listo) {
      const opciones = ['<option value="">Sin foto (inicial)</option>'];
      const vistas = new Set();
      for (const p of PLANTILLA) {
        if (!p.foto || vistas.has(p.foto)) continue;
        vistas.add(p.foto);
        opciones.push(`<option value="${p.foto}">${p.foto.replace("fotos/", "")}</option>`);
      }
      opciones.push('<option value="fotos/falta-99.png">foto que falta (404)</option>');
      opciones.push('<option value="fotos/panoramica-01.png">panorámica (240×96)</option>');
      fotos.innerHTML = opciones.join("");
      fotos.dataset.listo = "1";
    }
    const disenos = $("selDiseno");
    if (disenos && !disenos.dataset.listo) {
      disenos.innerHTML = ORDEN_DISENOS.map(
        (clave) => `<option value="${clave}">${DISENOS[clave].nombre}</option>`,
      ).join("");
      disenos.dataset.listo = "1";
    }
    this.rellenarIdentidad();
  }

  /** Copia al formulario la identidad del participante elegido. */
  rellenarIdentidad() {
    const id = $("selParticipante")?.value;
    const t = this.sim.trompos.find((x) => x.id === id);
    if (!t) return;
    if ($("inNombre")) $("inNombre").value = t.nombre;
    if ($("selFoto")) $("selFoto").value = t.foto ?? "";
    if ($("selDiseno")) $("selDiseno").value = t.diseno.clave;
    if ($("selVariante")) $("selVariante").value = String(t.diseno.variante ?? 0);
    const vista = $("vistaIdentidad");
    if (vista) {
      vista.style.setProperty("--color", t.color);
      vista.dataset.inicial = t.inicial;
      vista.dataset.foto = t.foto ?? "";
      vista.dataset.nombre = t.nombre;
      // La vista previa usa la misma foto y el mismo respaldo que el lienzo: si la
      // imagen falla, el fondo se queda vacío y se ve la inicial.
      vista.style.backgroundImage = t.foto ? `url("${t.foto}")` : "none";
    }
  }

  /** Aplica los cambios del formulario (o los que se pasen) al participante elegido. */
  aplicarIdentidad(cambios = null) {
    const id = $("selParticipante")?.value;
    if (!id) return;
    const datos = cambios ?? {
      nombre: $("inNombre")?.value ?? "",
      foto: ($("selFoto")?.value ?? "") === "" ? null : $("selFoto").value,
      disenoId: $("selDiseno")?.value,
      variante: Number($("selVariante")?.value ?? 0),
    };
    const ficha = this.sim.editarParticipante(id, datos);
    this.pintarIdentidades();
    if (ficha) {
      this.avisar(
        `${ficha.nombre} · ${ficha.disenoId}${ficha.variante ? ` v${ficha.variante + 1}` : ""} · ` +
          `${ficha.foto ? ficha.foto.replace("fotos/", "") : "sin foto (inicial)"}`,
      );
    }
  }

  refrescarFotos() {
    const el = $("outFotos");
    if (!el) return;
    const f = this.sim.fotos.estado();
    el.textContent = `${f.pedidas} pedidas · ${f.listas} cargadas · ${f.fallidas} con fallo (respaldo de inicial)`;
  }

  aplicarFondo(nombre) {
    const marco = $("marco");
    if (!marco) return;
    marco.dataset.fondo = nombre;
  }

  avisar(texto) {
    this.avisos.unshift(texto);
    this.avisos.length = Math.min(this.avisos.length, 4);
    const el = $("outAviso");
    if (el) el.innerHTML = this.avisos.map((a) => `<div>${a}</div>`).join("");
  }

  refrescarAudio() {
    const el = $("outAudio");
    if (!el) return;
    const e = this.sim.sonido.estado();
    el.textContent =
      `${e.estado} · ${e.activo ? `volumen ${Math.round(e.volumen * 100)} %` : "silenciado"}` +
      ` · ${e.total} efectos · ${e.descartados} descartados por saturación`;
    el.dataset.estado = e.desbloqueado ? "listo" : "esperando";
  }

  /** Ficha de cada diseño: sirve para revisar los diez de un vistazo. */
  pintarDisenos() {
    const contenedor = $("listaDisenos");
    if (!contenedor) return;
    contenedor.innerHTML = ORDEN_DISENOS.map((clave, i) => {
      const d = DISENOS[clave];
      return `<li class="diseno">
        <span class="muestra" style="--c1:${d.colores.base};--c2:${d.colores.claro};--c3:${d.colores.acento}">${String(i + 1).padStart(2, "0")}</span>
        <span class="datos">
          <b>${d.nombre}</b>
          <i>${d.lema}</i>
        </span>
        <span class="cifras">
          <em>atq ${d.ataque.toFixed(2)}</em>
          <em>def ${d.defensa.toFixed(2)}</em>
          <em>masa ${d.densidad.toFixed(2)}</em>
        </span>
      </li>`;
    }).join("");
  }

  /** Los diez botones de poder, con el icono y el nombre. */
  pintarPoderes() {
    const contenedor = $("listaPoderes");
    if (!contenedor || contenedor.dataset.listo) return;
    contenedor.innerHTML = ORDEN_PODERES.map((clave, i) => {
      const poder = PODERES[clave];
      const tecla = i === 9 ? "0" : String(i + 1);
      return `<button type="button" data-poder="${clave}" style="--poder:${poder.color}" title="${poder.lema}">
        <span class="icono"></span>
        <span>${poder.nombre}<br /><i style="opacity:.6">${DISENOS[clave]?.nombre ?? ""} · Mayús+${tecla}</i></span>
      </button>`;
    }).join("");
    contenedor.dataset.listo = "1";
    for (const boton of contenedor.querySelectorAll("button")) {
      boton.addEventListener("click", () => this.lanzarPoder(boton.dataset.poder));
    }
  }

  /**
   * Lanza un poder. Cualquiera puede usar cualquiera: se lanza en el participante
   * elegido en «Identidad» y, si ese lo tiene en enfriamiento, en el primero que pueda.
   */
  lanzarPoder(clave) {
    const elegido = $("selParticipante")?.value;
    const enElegido = elegido ? this.sim.activarPoder(elegido, clave, false) : null;
    if (enElegido) {
      this.avisar(`${enElegido.poder} · ${enElegido.nombre} (en el elegido)`);
      return enElegido;
    }
    const cualquiera = this.sim.activarPoderEnCualquiera(clave);
    this.avisar(
      cualquiera
        ? `${cualquiera.poder} · ${cualquiera.nombre} (el elegido lo tenía en enfriamiento)`
        : `${PODERES[clave].nombre}: nadie lo tiene listo todavía`,
    );
    return cualquiera;
  }

  /** Lista corta con los poderes en marcha y sus enfriamientos. */
  refrescarPoderes(e) {
    const caja = $("estadoPoderes");
    if (!caja) return;
    const poner = (id, valor) => {
      const el = $(id);
      if (el) el.textContent = valor;
    };
    poner("outActivaciones", String(e.poderes.activaciones));
    poner("outDanioPoderes", String(e.poderes.danio));
    poner("outBajasPoder", String(e.poderes.eliminaciones));
    poner("outEnCurso", String(e.poderes.enCurso));

    // Los que están en algo (cargando, activo, finalizando o enfriando), como mucho 8.
    const interesantes = e.poderes.participantes
      .filter((p) => p.estado !== "listo")
      .sort((a, b) => {
        const peso = (x) => (x.estado === "activo" ? 0 : x.estado === "cargando" ? 1 : x.estado === "finalizando" ? 2 : 3);
        return peso(a) - peso(b) || a.enfriamiento - b.enfriamiento;
      })
      .slice(0, 8);
    caja.innerHTML = interesantes.length
      ? interesantes
          .map(
            (p) => `<div class="fila">
              <b>${p.nombre}</b>
              <i>${p.poder}</i>
              <span class="estado-${p.estado}">${
                p.estado === "enfriando" ? `${p.enfriamiento.toFixed(1)} s` : p.estado
              }</span>
            </div>`,
          )
          .join("")
      : `<div class="fila"><b>todos con los diez listos</b><i>sin poderes en marcha</i><span>—</span></div>`;

    // Los botones se apagan sólo si no queda nadie que pueda lanzarlo.
    const contenedor = $("listaPoderes");
    if (contenedor) {
      for (const boton of contenedor.querySelectorAll("button")) {
        const clave = boton.dataset.poder;
        const disponible = this.sim.trompos.some(
          (t) => t.activo && t.poder?.estado === "listo" && this.sim.poderes.enfriamientoDe(t, clave) <= 0,
        );
        boton.disabled = !disponible;
        boton.dataset.activo = this.sim.trompos.some(
          (t) => t.poder?.estado === "activo" && t.poder.clave === clave,
        )
          ? "1"
          : "0";
      }
    }
  }

  /** Lecturas del HUD. Se llama unas cuatro veces por segundo, no cada fotograma. */
  refrescar(dt) {
    this.reloj += dt;
    if (this.reloj < 0.25) return;
    this.reloj = 0;
    const e = this.sim.estado();
    const poner = (id, valor) => {
      const el = $(id);
      if (el) el.textContent = valor;
    };
    poner("outFase", e.fase.toUpperCase());
    poner("outRonda", String(e.ronda));
    poner("outVivos", `${e.vivos} / ${this.sim.trompos.length}`);
    poner("outChoques", String(e.choques));
    poner("outTiempo", `${e.tiempoBatalla.toFixed(1)} s`);
    poner("outPresion", `${e.presion.toFixed(2)}×`);
    poner("outParticulas", `${e.particulas} + ${e.ondas} ondas`);
    poner("outFps", `${e.fps.toFixed(0)} fps`);
    poner("outSaltos", String(e.saltos));
    poner("outSemillaActual", String(e.semilla));
    poner("outGanador", e.ganador ?? "—");
    poner("outEnergia", e.energia.total.toFixed(0));
    poner("outRadio", `${e.escala.radio.toFixed(0)} px`);
    poner("outVelocidadMedia", `${e.velocidadMedia.toFixed(0)} px/s`);
    poner("outSolape", `${e.peorSolape.peor.toFixed(1)} px`);
    poner("outBorde", String(e.pegadosAlBorde));
    poner("outSonidos", `${e.sonido.total} · ${e.sonido.descartados} descartados`);
    const fuera = $("outFuera");
    if (fuera) {
      fuera.textContent = e.fueraDeLaArena.length ? e.fueraDeLaArena.join(", ") : "ninguno";
      fuera.dataset.alerta = e.fueraDeLaArena.length ? "1" : "0";
    }
    const barra = $("barraProgreso");
    if (barra) {
      const pct = limitar(e.vivos / Math.max(1, this.sim.trompos.length), 0, 1);
      barra.style.width = `${(pct * 100).toFixed(0)}%`;
    }
    // Si entran o salen participantes, el desplegable de identidad se rehace.
    if (this.ultimoRecuento !== this.sim.trompos.length) {
      this.ultimoRecuento = this.sim.trompos.length;
      this.pintarIdentidades();
      this.pintarDonadores();
    }
    this.refrescarPoderes(e);
    this.refrescarRegalos(e);
    this.refrescarTikTok();
    this.refrescarAudio();
    this.refrescarFotos();
  }

  // ------------------------------------------------------------ tiktok (orden 06)

  /** Monta la tarjeta de conexión: botones, escenarios y listas. */
  pintarTikTok() {
    const conexion = this.sim.conexion;
    if (!conexion) return;
    const contenedor = $("botonesEscenarios");
    if (contenedor) {
      contenedor.innerHTML = ESCENARIOS.map(
        (e) => `<button type="button" data-escenario="${e.clave}" title="${e.detalle}">${e.nombre}</button>`,
      ).join("");
      contenedor.onclick = (ev) => {
        const boton = ev.target.closest("button");
        if (!boton) return;
        this.probarEscenario(boton.dataset.escenario);
      };
    }
    const clic = (id, fn) => {
      const el = $(id);
      if (el) el.onclick = fn;
    };
    clic("btnConectarTikTok", () => {
      const ok = conexion.conectar();
      this.avisar(ok ? `Escuchando el bus del motor en ${conexion.url}` : "No se pudo conectar");
      this.refrescarTikTok();
    });
    clic("btnConectarPuente", () => {
      conexion.usarPuente(true);
      this.avisar("Escuchando el puente del servidor (eventos empujados por HTTP)");
      this.refrescarTikTok();
    });
    clic("btnDesconectarTikTok", () => {
      conexion.desconectar();
      this.avisar("Desconectado: la batalla sigue igual");
      this.refrescarTikTok();
    });
    clic("btnGuardarUsuarios", async () => {
      try {
        const r = await this.sim.guardarUsuarios();
        this.avisar(`Guardadas ${r.guardado} identidades en ${r.archivo}`);
      } catch (error) {
        this.avisar(`No se pudieron guardar: ${error.message}`);
      }
    });
    clic("btnPromoverEspera", () => {
      const cuantos = this.sim.promoverDeEspera();
      this.avisar(cuantos ? `Han entrado ${cuantos} de la cola` : "No hay sitio o nadie esperando");
      this.pintarUsuarios();
    });
    clic("btnLimpiarTikTok", () => {
      this.sim.regalos.limpiarHistorial();
      conexion.registro = [];
      this.avisar("Historial de regalos y registro técnico limpios");
      this.refrescarRegalos(this.sim.estado());
      this.refrescarTikTok();
    });
    clic("btnReiniciarRonda", () => {
      this.sim.reiniciarRonda();
      this.avisar("Ronda reiniciada (los espectadores siguen dentro)");
      this.pintarUsuarios();
    });
    const modo = $("selModoTikTok");
    if (modo) {
      modo.onchange = () => {
        conexion.usarModo(modo.value);
        this.avisar(`Modo ${modo.value}`);
        this.refrescarTikTok();
      };
    }
    const mudo = $("chkSilenciarTikTok");
    if (mudo) {
      mudo.onchange = () => {
        conexion.mudo = mudo.checked;
        this.avisar(mudo.checked ? "Eventos de prueba silenciados en el overlay" : "Eventos de prueba audibles");
      };
    }
    this.pintarUsuarios();
    this.refrescarTikTok();
  }

  /** Lanza un escenario de prueba y cuenta lo que ha pasado. */
  probarEscenario(escenario) {
    this.sim.conexion.usarModo("simulado");
    const modo = $("selModoTikTok");
    if (modo) modo.value = "simulado";
    if (escenario === "duplicado") {
      // El escenario de duplicado manda el MISMO evento dos veces: aquí se ve que el
      // segundo no vuelve a dar vida ni a lanzar el poder.
      const crudo = eventoDePrueba("duplicado");
      const primero = this.sim.conexion.enviarCrudo(crudo, { simulado: true });
      const segundo = this.sim.conexion.enviarCrudo(crudo, { simulado: true });
      this.avisar(
        `Duplicado: el primero ${primero?.duplicado ? "ignorado" : "aplicado"} y el segundo ${
          segundo?.duplicado ? "ignorado (no hace nada)" : "aplicado"
        }`,
      );
    } else if (escenario === "racha-parcial") {
      const user = { id: "u-racha", unique_id: "racha", nickname: "Racha" };
      for (const n of [1, 3, 5]) {
        this.sim.conexion.enviarCrudo(eventoDePrueba("racha-parcial", { user, repeat: n, grupo: "racha-taller" }), {
          simulado: true,
        });
      }
      this.avisar("Racha parcial 1 → 3 → 5: sólo cuenta la diferencia (5 unidades)");
    } else {
      const evento = this.sim.conexion.enviarCrudo(eventoDePrueba(escenario), { simulado: true });
      this.avisar(evento ? `${evento.displayName} · ${evento.giftName} ×${evento.cantidadNueva}` : "Escenario sin evento");
    }
    this.pintarUsuarios();
    this.refrescarTikTok();
    this.refrescarRegalos(this.sim.estado());
  }

  /** Estado de la conexión, contadores y registro técnico. */
  refrescarTikTok() {
    const conexion = this.sim.conexion;
    if (!conexion) return;
    const e = conexion.estadoActual();
    const caja = $("estadoConexion");
    if (caja) {
      caja.dataset.estado = e.estado;
      const luz = $("luzConexion");
      if (luz) luz.style.background = e.visible.color;
      const estado = $("outConexionEstado");
      if (estado) estado.textContent = e.visible.nombre;
      const detalle = $("outConexionDetalle");
      if (detalle) detalle.textContent = e.detalle || "—";
    }
    const poner = (id, valor) => {
      const el = $(id);
      if (el) el.textContent = valor;
    };
    poner("outTikTokProcesados", String(e.contadores.procesados));
    poner("outTikTokDuplicados", String(e.contadores.duplicados));
    // El contador bueno de regalos desconocidos es el del motor de regalos (el que los
    // apunta para configurarlos), no el del puente.
    poner("outTikTokDesconocidos", String(this.sim.regalos.contadores.desconocidos));
    poner("outTikTokSinUsuario", String(e.contadores.sinUsuario));
    poner("outTikTokReconexiones", String(e.reconexiones));
    poner("outTikTokRachas", String(e.rachasAbiertas));
    const ultimo = $("outTikTokUltimo");
    if (ultimo) {
      ultimo.textContent = e.ultimoEvento
        ? `último: ${e.ultimoEvento.displayName} · ${e.ultimoEvento.giftName} ×${e.ultimoEvento.cantidadNueva} (${e.ultimoEvento.origen})`
        : "todavía no ha llegado ningún evento";
    }
    const registro = $("registroTikTok");
    if (registro) {
      registro.innerHTML = e.registro.length
        ? e.registro
            .map(
              (r) =>
                `<div class="evento" data-estado="${
                  r.tipo === "duplicado" ? "rechazado" : r.tipo === "error" ? "rechazado" : "aplicado"
                }"><span class="meta">${new Date(r.cuando).toLocaleTimeString()}</span> ${r.texto}</div>`,
            )
            .join("")
        : `<div class="evento"><i>sin avisos técnicos</i></div>`;
    }
    const modo = $("selModoTikTok");
    if (modo && modo.value !== e.modo) modo.value = e.modo;
    const mudo = $("chkSilenciarTikTok");
    if (mudo) mudo.checked = e.mudo;
    this.pintarDesconocidos();
    // La lista de espectadores se rehace sólo cuando cambia algo (son 14 filas).
    const usuarios = this.sim.usuarios.estado();
    const firma = `${usuarios.dentro}/${usuarios.enEspera}/${usuarios.usuarios.length}/${usuarios.usuarios.map((u) => u.participantId + u.estado + u.regalos).join(",")}`;
    if (this.firmaUsuarios !== firma) {
      this.firmaUsuarios = firma;
      this.pintarUsuarios();
    }
  }

  /** Espectadores reconocidos: identidad por userId, estado y regalos. */
  pintarUsuarios() {
    const caja = $("tablaUsuarios");
    if (!caja) return;
    const e = this.sim.usuarios.estado();
    const resumen = $("outUsuariosResumen");
    if (resumen) {
      resumen.textContent = `${e.dentro} en la arena de ${e.maximo} · ${e.enEspera} en espera · ${e.contadores.nuevos} conocidos`;
    }
    const filas = [...e.usuarios].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 14);
    caja.innerHTML = filas.length
      ? filas
          .map(
            (u) => `<div class="fila">
        <b title="${u.userId}">${u.displayName}${u.userName ? ` <i>@${u.userName}</i>` : ""}</b>
        <i>${u.regalos} regalos</i>
        <span class="${u.estado}">${u.estado === "espera" ? `EN ESPERA${u.posicionCola >= 0 ? ` (${u.posicionCola + 1}º)` : ""}` : u.estado}</span>
      </div>`,
          )
          .join("")
      : `<div class="fila"><b>—</b><i>ningún espectador todavía</i><span>—</span></div>`;
  }

  /** Regalos que han llegado sin estar en la tabla. */
  pintarDesconocidos() {
    const caja = $("tablaDesconocidos");
    if (!caja) return;
    const lista = this.sim.regalos.desconocidos ?? [];
    caja.innerHTML = lista.length
      ? lista
          .slice(0, 8)
          .map(
            (d) => `<div class="fila">
        <b title="${d.giftId}">${d.giftName || "(sin nombre)"}</b>
        <i>id ${d.giftId || "—"}</i>
        <span>${d.veces}×</span>
      </div>`,
          )
          .join("")
      : `<div class="fila"><b>—</b><i>todos los regalos recibidos están en la tabla</i><span>—</span></div>`;
  }

  // ------------------------------------------------------------ regalos

  /** Monta la tabla de regalos, el formulario y los desplegables del panel. */
  pintarRegalos() {
    const elegir = (id, mapa, valor) => {
      const el = $(id);
      if (!el) return;
      el.innerHTML = Object.values(mapa)
        .map((o) => `<option value="${o.clave}">${o.nombre}</option>`)
        .join("");
      el.value = valor;
    };
    elegir("fRecompensa", RECOMPENSAS, "vida");
    elegir("fObjetivo", OBJETIVOS, "cercano");
    elegir("fAcumulacion", ACUMULACIONES, "inmediata");
    elegir("selEspera", REGLAS_ESPERA, this.sim.regalos.config.reglas.siEnfriando);
    elegir("selExcedente", { conservar: { clave: "conservar", nombre: "Conservar" }, reiniciar: { clave: "reiniciar", nombre: "Reiniciar" } }, this.sim.regalos.config.reglas.excedente);
    const poder = $("fPoder");
    if (poder) {
      poder.innerHTML =
        `<option value="">— sin poder —</option>` +
        ORDEN_PODERES.map((c) => `<option value="${c}">${PODERES[c].nombre}</option>`).join("");
    }

    const delegado = (id, evento, fn) => $(id)?.addEventListener(evento, fn);
    delegado("btnAnadirRegalo", "click", () => this.abrirFormRegalo(null));
    delegado("btnGuardarFila", "click", () => this.guardarFilaRegalo());
    delegado("btnCancelarFila", "click", () => this.cerrarFormRegalo());
    delegado("btnGuardarRegalos", "click", async () => {
      try {
        const r = await this.sim.guardarRegalos();
        this.avisar(`Guardados ${r.guardado} regalos en ${r.archivo}`);
      } catch (error) {
        this.avisar(`No se pudo guardar: ${error.message}`);
      }
    });
    delegado("btnExportarRegalos", "click", () => this.exportarRegalos());
    delegado("btnImportarRegalos", "click", () => $("archivoRegalos")?.click());
    delegado("archivoRegalos", "change", (ev) => this.importarRegalos(ev));
    delegado("btnRestaurarRegalos", "click", () => {
      this.sim.regalos.restaurar();
      this.pintarTablaRegalos();
      this.avisar("Configuración restaurada a los valores de ejemplo (pulsa Guardar para dejarla fija)");
    });
    delegado("selEspera", "change", () => {
      this.sim.regalos.config.reglas.siEnfriando = $("selEspera").value;
    });
    delegado("selExcedente", "change", () => {
      this.sim.regalos.config.reglas.excedente = $("selExcedente").value;
    });
    delegado("btnEnviarRegalo", "click", () => this.enviarRegalo());
    delegado("btnRepetirRegalo", "click", () => this.enviarRegalo(this.ultimoRegalo));
    delegado("btnRafagaRegalos", "click", () => {
      // Cinco seguidos, para ver qué pasa con la cola y con los acumuladores.
      for (let i = 0; i < 5; i += 1) this.enviarRegalo(null, true);
      this.avisar("5 regalos enviados seguidos");
    });
    delegado("btnLimpiarHistorial", "click", () => {
      this.sim.regalos.limpiarHistorial();
      this.refrescarRegalos(this.sim.estado());
    });
    // Tabla: activo, editar y eliminar (con confirmación propia, sin diálogos del navegador).
    delegado("tablaRegalos", "click", (ev) => {
      const boton = ev.target.closest("button");
      if (!boton) return;
      const fila = boton.closest(".fila-regalo");
      if (!fila) return;
      const id = fila.dataset.id;
      if (boton.dataset.accion === "editar") this.abrirFormRegalo(id);
      else if (boton.dataset.accion === "borrar") this.pedirConfirmacion(fila, id);
      else if (boton.dataset.accion === "si") {
        this.sim.quitarRegalo(id);
        this.pintarTablaRegalos();
        this.avisar("Regalo eliminado de la tabla (pulsa Guardar para dejarlo fijo)");
      } else if (boton.dataset.accion === "no") this.pintarTablaRegalos();
    });
    delegado("tablaRegalos", "change", (ev) => {
      const casilla = ev.target.closest('input[type="checkbox"]');
      if (!casilla) return;
      const id = casilla.closest(".fila-regalo").dataset.id;
      this.sim.editarRegalo(id, { activo: casilla.checked });
      this.pintarTablaRegalos();
    });
    this.pintarTablaRegalos();
    this.pintarDonadores();
  }

  pintarDonadores() {
    const sel = $("selDonador");
    if (!sel) return;
    const antes = sel.value;
    sel.innerHTML = this.sim.trompos
      .map((t) => `<option value="${t.id}">${t.nombre}${t.activo ? "" : " (eliminado)"}</option>`)
      .join("");
    if (antes && this.sim.trompos.some((t) => t.id === antes)) sel.value = antes;
    const regalo = $("selRegalo");
    if (regalo) {
      const antesRegalo = regalo.value;
      regalo.innerHTML = this.sim.regalos.config.regalos
        .map((r) => `<option value="${r.id}">${r.regalo}${r.activo ? "" : " (inactivo)"}</option>`)
        .join("");
      if (antesRegalo && this.sim.regalos.regaloPorId(antesRegalo)) regalo.value = antesRegalo;
    }
  }

  /**
   * La tabla de regalos.
   *
   * Cada fila lleva los diez campos de la orden: activo (casilla), regalo, cantidad,
   * recompensa, valor de vida, poder, objetivo, enfriamiento, editar y eliminar. Van en
   * dos líneas porque en el ancho del panel no caben diez columnas sin dejar la letra
   * ilegible o recortar campos.
   */
  pintarTablaRegalos() {
    const caja = $("tablaRegalos");
    if (!caja) return;
    const filas = this.sim.regalos.config.regalos;
    caja.innerHTML =
      filas
        .map((r) => {
          const recompensa = RECOMPENSAS[r.recompensa];
          return `<div class="fila-regalo" data-id="${r.id}" data-activo="${r.activo ? 1 : 0}">
        <input type="checkbox" ${r.activo ? "checked" : ""} title="Activo" />
        <div class="detalle">
          <div class="linea">
            <b title="${r.regalo}${r.regaloId ? ` · id ${r.regaloId}` : ""}">${r.regalo}</b>
            <span class="pastilla">×${r.cantidad}</span>
            <span class="pastilla" style="color:${recompensa.color}">${recompensa.nombre}${r.vida ? ` +${r.vida}` : ""}</span>
          </div>
          <div class="linea">
            <i>Poder: ${r.poder ? PODERES[r.poder].nombre : "—"}</i>
            <i>· ${OBJETIVOS[r.objetivo].nombre}</i>
            <i>· ${r.enfriamiento ? `enfría ${r.enfriamiento} s` : "sin enfriamiento"}</i>
            <i>· ${ACUMULACIONES[r.acumulacion].nombre}</i>
          </div>
        </div>
        <button class="mini" type="button" data-accion="editar">Editar</button>
        <button class="mini" type="button" data-accion="borrar" title="Eliminar">×</button>
      </div>`;
        })
        .join("") ||
      `<div class="fila-regalo"><span></span><div class="detalle"><div class="linea"><i>no hay regalos configurados</i></div></div><span></span><span></span></div>`;
    const estado = $("outRegalosEstado");
    if (estado) {
      const activos = filas.filter((r) => r.activo).length;
      estado.textContent = `${filas.length} regalos (${activos} activos) · origen: ${this.sim.regalos.origen}`;
    }
    this.pintarDonadores();
  }

  /** Confirmación propia de la aplicación: la fila se convierte en «¿Eliminar? Sí / No». */
  pedirConfirmacion(fila, id) {
    const regalo = this.sim.regalos.regaloPorId(id);
    fila.innerHTML = `<div class="confirmar">
      <b>¿Eliminar «${regalo ? regalo.regalo : id}»?</b>
      <span>
        <button class="mini si" type="button" data-accion="si">Sí</button>
        <button class="mini" type="button" data-accion="no">No</button>
      </span>
    </div>`;
  }

  abrirFormRegalo(id) {
    const form = $("formRegalo");
    if (!form) return;
    this.filaEnEdicion = id;
    const r = id ? this.sim.regalos.regaloPorId(id) : null;
    const poner = (campo, valor) => {
      const el = $(campo);
      if (el) el.value = valor;
    };
    poner("fRegalo", r ? r.regalo : "");
    poner("fRegaloId", r ? r.regaloId : "");
    poner("fCantidad", r ? r.cantidad : 1);
    poner("fRecompensa", r ? r.recompensa : "vida");
    poner("fVida", r ? r.vida : 500);
    poner("fPoder", r && r.poder ? r.poder : "");
    poner("fObjetivo", r ? r.objetivo : "propio");
    poner("fEnfriamiento", r ? r.enfriamiento : 0);
    poner("fAcumulacion", r ? r.acumulacion : "inmediata");
    const activo = $("fActivo");
    if (activo) activo.checked = r ? r.activo : true;
    const salida = $("outFormRegalo");
    if (salida) salida.textContent = r ? `Editando «${r.regalo}»` : "Regalo nuevo";
    form.hidden = false;
  }

  cerrarFormRegalo() {
    const form = $("formRegalo");
    if (form) form.hidden = true;
    this.filaEnEdicion = null;
  }

  guardarFilaRegalo() {
    const valor = (id) => $(id)?.value ?? "";
    const fila = {
      regalo: valor("fRegalo").trim() || "Regalo",
      regaloId: valor("fRegaloId").trim(),
      cantidad: Number(valor("fCantidad")) || 1,
      recompensa: valor("fRecompensa"),
      vida: Number(valor("fVida")) || 0,
      poder: valor("fPoder") || null,
      objetivo: valor("fObjetivo"),
      enfriamiento: Number(valor("fEnfriamiento")) || 0,
      acumulacion: valor("fAcumulacion"),
      activo: $("fActivo")?.checked !== false,
    };
    if (this.filaEnEdicion) this.sim.editarRegalo(this.filaEnEdicion, fila);
    else this.sim.anadirRegalo(fila);
    this.cerrarFormRegalo();
    this.pintarTablaRegalos();
    this.avisar(`Fila guardada: ${fila.regalo} (pulsa Guardar para dejarla fija)`);
  }

  exportarRegalos() {
    const texto = this.sim.regalos.exportar();
    const blob = new Blob([texto], { type: "application/json" });
    const enlace = document.createElement("a");
    enlace.href = URL.createObjectURL(blob);
    enlace.download = "regalos.json";
    enlace.click();
    URL.revokeObjectURL(enlace.href);
    this.avisar("Configuración exportada como regalos.json");
  }

  importarRegalos(ev) {
    const archivo = ev.target.files?.[0];
    if (!archivo) return;
    const lector = new FileReader();
    lector.onload = () => {
      try {
        const cuantos = this.sim.regalos.importar(String(lector.result));
        this.pintarTablaRegalos();
        this.avisar(`Importados ${cuantos} regalos (pulsa Guardar para dejarlos fijos)`);
      } catch (error) {
        this.avisar(`No se pudo importar: ${error.message}`);
      }
    };
    lector.readAsText(archivo);
    ev.target.value = "";
  }

  /** Envía el regalo elegido en el panel (o repite el último). */
  enviarRegalo(regaloId = null, silencioso = false) {
    const id = regaloId ?? $("selRegalo")?.value;
    const participanteId = $("selDonador")?.value;
    const cantidad = Number($("inCantidad")?.value) || 1;
    if (!id || !participanteId) {
      this.avisar("Elige participante y regalo");
      return null;
    }
    const evento = this.sim.enviarRegalo({ participanteId, regaloId: id, cantidad });
    this.ultimoRegalo = id;
    if (!silencioso) {
      this.avisar(
        `${evento.donador} envió ${evento.regalo} ×${evento.cantidad}: ${evento.estado}${
          evento.detalle ? ` · ${evento.detalle}` : ""
        }`,
      );
    }
    this.refrescarRegalos(this.sim.estado());
    return evento;
  }

  /** Contadores, cola, acumuladores e historial. */
  refrescarRegalos(e) {
    const r = e?.regalos;
    if (!r) return;
    const poner = (id, valor) => {
      const el = $(id);
      if (el) el.textContent = valor;
    };
    poner("outRegalosEnviados", String(r.contadores.enviados));
    poner("outRegalosAplicados", String(r.contadores.aplicados));
    poner("outRegalosRechazados", String(r.contadores.rechazados));
    poner("outRegalosCola", String(r.pendientes.length));
    poner("outRegalosVida", String(r.contadores.vidaDada));
    poner("outRegalosDanio", String(Math.round(r.contadores.danioDeRegalos ?? 0)));

    const progresos = $("progresosRegalos");
    if (progresos) {
      const filas = r.progreso.filter((p) => p.porRonda > 0 || p.porParticipante.length);
      progresos.innerHTML = filas.length
        ? filas
            .map((p) => {
              const quien = p.porRonda > 0
                ? `ronda ${p.porRonda}/${p.cantidad}`
                : p.porParticipante.map((q) => `${q.lleva}/${p.cantidad}`).join(", ");
              return `<div class="fila"><b>${p.regalo}</b><i>${quien}</i></div>`;
            })
            .join("")
        : "";
    }

    const cola = $("historialRegalos");
    if (cola) {
      const eventos = r.historial.slice(0, 14);
      cola.innerHTML = eventos.length
        ? eventos
            .map(
              (ev) => `<div class="evento" data-estado="${ev.estado}">
          <b>${ev.donador}</b> envió <b>${ev.regalo}</b> ×${ev.cantidad}
          <div class="meta">${ev.estado.toUpperCase()}${ev.detalle ? ` · ${ev.detalle}` : ""}</div>
          ${
            ev.poder && ev.poder !== "—"
              ? `<div class="meta">${ev.donador} activó <b>${ev.poder}</b> · objetivo: ${ev.objetivo}${
                  ev.objetivoDado ? ` → ${ev.objetivoDado}` : ""
                }</div>`
              : ""
          }
          ${
            ev.vida || ev.danio
              ? `<div class="meta">${ev.vida ? `recuperó +${ev.vida} de vida` : ""}${
                  ev.vida && ev.danio ? " · " : ""
                }${ev.danio ? `daño: ${ev.danio}` : ""}</div>`
              : ""
          }
        </div>`,
            )
            .join("")
        : `<div class="evento"><i>todavía no ha llegado ningún regalo</i></div>`;
    }
  }
}
