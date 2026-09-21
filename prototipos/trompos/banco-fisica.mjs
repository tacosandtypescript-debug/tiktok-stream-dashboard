// Banco de física: corre rondas completas en Node, sin navegador ni lienzo.
//
// Por qué existe: afinar el daño, el roce y la escala de la orden 02 mirando la
// pantalla es adivinar. Aquí se simulan rondas enteras con paso fijo para 10, 20, 30
// y 40 participantes y se leen los números: cuánto dura la batalla, cuántos choques
// hay, si alguien se sale de la arena, si se forman grupos inmóviles, si se pegan a
// las esquinas y si la escala deja trompos que siguen moviéndose y chocando.
//
//   node banco-fisica.mjs                      10, 20, 30 y 40 participantes
//   node banco-fisica.mjs --rondas 12           más rondas por cantidad
//   node banco-fisica.mjs --participantes 40    sólo una cantidad
//   node banco-fisica.mjs --variantes           compara juegos de parámetros

import { PARAMETROS, copiaProfunda, escalaTrompos } from "./js/parametros.js";
import { Simulacion } from "./js/simulacion.js";
import { pegadosAlBorde } from "./js/fisica.js";

const argumento = (nombre, porDefecto) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
};
const RONDAS = Number(argumento("rondas", 8));
const SEMILLA = Number(argumento("semilla", 20260214));
const CANTIDADES = String(argumento("participantes", "10,20,30,40"))
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);

/** Una ronda completa, del principio al cartel de victoria, tomando muestras. */
function correrRonda(p, semilla, maxSegundos = 300) {
  const sim = new Simulacion({ canvas: null, tabla: null, p });
  sim.semillaBase = semilla >>> 0;
  sim.montarRonda();

  // Muestras durante la batalla: movimiento, esquinas y solapes.
  const muestras = [];
  let siguienteMuestra = 0;
  const solapeInicial = (() => {
    let peor = 0;
    const lista = sim.trompos;
    for (let i = 0; i < lista.length; i += 1) {
      for (let j = i + 1; j < lista.length; j += 1) {
        const d = Math.hypot(lista[j].x - lista[i].x, lista[j].y - lista[i].y);
        peor = Math.max(peor, lista[i].radio + lista[j].radio - d);
      }
    }
    return Number(peor.toFixed(2));
  })();

  const paso = p.tiempo.paso;
  const tope = Math.ceil(maxSegundos / paso);
  let pasos = 0;
  while (pasos < tope) {
    sim.paso(paso);
    pasos += 1;
    if (sim.fase === "batalla" && sim.tiempoBatalla >= siguienteMuestra) {
      siguienteMuestra += 0.25;
      const vivos = sim.trompos.filter((t) => t.activo);
      let parados = 0;
      for (const t of vivos) if (t.rapidez < p.fisica.velocidadCrucero * 0.2) parados += 1;
      muestras.push({
        vivos: vivos.length,
        media: vivos.reduce((s, t) => s + t.rapidez, 0) / Math.max(1, vivos.length),
        parados,
        borde: pegadosAlBorde(sim.trompos, p, 10),
      });
    }
    if (sim.fase === "victoria") break;
  }

  const e = sim.estado();
  const desgaste = e.eliminaciones.filter((x) => !x.por).length;
  const medias = muestras.map((m) => m.media);
  return {
    participantes: e.participantes,
    radio: e.escala.radio,
    fase: e.fase,
    ganador: e.ganador,
    batalla: e.tiempoBatalla,
    vivos: e.vivos,
    choques: e.choques,
    eliminaciones: e.eliminaciones.length,
    desgaste,
    saltos: e.saltos,
    fuera: e.fueraDeLaArena.length,
    solapeInicial,
    solapeTarde: e.peorSolape.peor,
    velocidadMedia: Number((medias.reduce((s, v) => s + v, 0) / Math.max(1, medias.length)).toFixed(0)),
    velocidadMinimaMuestra: Number(Math.min(...medias, 0).toFixed(0)),
    mediaBaja: medias.filter((v) => v < p.fisica.velocidadCrucero * 0.35).length,
    parados: muestras.reduce((s, m) => s + m.parados, 0),
    borde: Math.max(...muestras.map((m) => m.borde), 0),
    trompoMuestras: muestras.reduce((s, m) => s + m.vivos, 0),
    muestras: muestras.length,
    vivosFinales: e.vivos,
    totalSegundos: Number((pasos * paso).toFixed(1)),
    firma: `${e.choques}|${Math.round(e.danio)}|${e.trompos.map((t) => Math.round(t.vida)).join(",")}`,
    duracionPorTrompo: Number((e.tiempoBatalla / e.participantes).toFixed(2)),
  };
}

function mediana(valores) {
  const v = [...valores].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function resumen(p, cantidad, rondas = RONDAS, semilla = SEMILLA, silencioso = false) {
  const guardado = p.simulacion.participantes;
  p.simulacion.participantes = cantidad;
  const datos = [];
  for (let r = 0; r < rondas; r += 1) datos.push(correrRonda(p, semilla + r * 7919));
  p.simulacion.participantes = guardado;

  const batallas = datos.map((d) => d.batalla);
  const porTiempo = datos.filter((d) => d.batalla >= p.simulacion.batallaMaxima - 0.05).length;
  const conGanador = datos.filter((d) => d.ganador).length;
  const choques = datos.reduce((s, d) => s + d.choques, 0);
  const eliminaciones = datos.reduce((s, d) => s + d.eliminaciones, 0);
  const salida = {
    cantidad,
    escala: escalaTrompos(p),
    radio: datos[0].radio,
    rondas,
    batallaMediana: mediana(batallas),
    batallaMin: Math.min(...batallas),
    batallaMax: Math.max(...batallas),
    porTiempo,
    conGanador,
    choquesPorRonda: Number((choques / rondas).toFixed(0)),
    // Con más gente el reloj no debe dispararse: se mide la duración por trompo.
    batallaPorTrompo: Number((mediana(batallas) / cantidad).toFixed(2)),
    eliminacionesPorRonda: Number((eliminaciones / rondas).toFixed(1)),
    saltos: datos.reduce((s, d) => s + d.saltos, 0),
    fuera: datos.reduce((s, d) => s + d.fuera, 0),
    solapeInicial: Math.max(...datos.map((d) => d.solapeInicial)),
    solapeTarde: Math.max(...datos.map((d) => d.solapeTarde)),
    velocidadMedia: Math.round(mediana(datos.map((d) => d.velocidadMedia))),
    mediaBaja: datos.reduce((s, d) => s + d.mediaBaja, 0),
    parados: datos.reduce((s, d) => s + d.parados, 0),
    borde: Math.max(...datos.map((d) => d.borde)),
    trompoMuestras: datos.reduce((s, d) => s + d.trompoMuestras, 0),
    muestras: datos.reduce((s, d) => s + d.muestras, 0),
    datos,
  };

  if (!silencioso) {
    console.log(
      `  batalla: mediana ${salida.batallaMediana.toFixed(1)} s (${salida.batallaMin.toFixed(1)}–${salida.batallaMax.toFixed(1)})` +
        ` · por tiempo ${porTiempo}/${rondas} · con ganador ${conGanador}/${rondas}`,
    );
    console.log(
      `  choques/ronda ${salida.choquesPorRonda} · bajas/ronda ${salida.eliminacionesPorRonda} · saltos ${salida.saltos} · fuera ${salida.fuera}`,
    );
    console.log(
      `  radio ${salida.radio} px · solape al nacer ${salida.solapeInicial} px · peor solape en pelea ${salida.solapeTarde} px`,
    );
    console.log(
      `  velocidad media ${salida.velocidadMedia} px/s · muestras con velocidad baja ${salida.mediaBaja}/${salida.muestras} ·` +
        ` trompos casi parados ${salida.parados} de ${salida.trompoMuestras} (${((salida.parados / Math.max(1, salida.trompoMuestras)) * 100).toFixed(2)} %)`,
    );
    console.log(`  máximo de trompos pegados al borde a la vez: ${salida.borde} de ${salida.cantidad}`);
  }
  return salida;
}

function comprobar(titulo, condicion, detalle) {
  console.log(`  [${condicion ? "OK   " : "FALLA"}] ${titulo}${detalle ? ` — ${detalle}` : ""}`);
  return Boolean(condicion);
}

/** Variantes candidatas: se comparan y se elige con números, no a ojo. */
function variantes() {
  const base = () => copiaProfunda(PARAMETROS);
  const con = (cambios) => {
    const p = base();
    for (const [ruta, valor] of Object.entries(cambios)) {
      const [grupo, clave] = ruta.split(".");
      p[grupo][clave] = valor;
    }
    return p;
  };
  // Los valores de fábrica salen de comparar estas variantes. Se dejan aquí para
  // poder volver a afinar cuando cambie cualquier otra cosa de la física.
  return {
    actual: base(),
    "escala plana": con({
      "trompo.escalaPorParticipantes": [
        { participantes: 10, escala: 0.5 },
        { participantes: 20, escala: 0.5 },
        { participantes: 30, escala: 0.5 },
        { participantes: 40, escala: 0.5 },
      ],
    }),
    "escala fuerte": con({
      "trompo.escalaPorParticipantes": [
        { participantes: 10, escala: 0.5 },
        { participantes: 20, escala: 0.42 },
        { participantes: 30, escala: 0.36 },
        { participantes: 40, escala: 0.32 },
      ],
    }),
    "más crucero": con({ "fisica.velocidadCrucero": 620 }),
    "menos crucero": con({ "fisica.velocidadCrucero": 360 }),
    "más vida": con({ "vida.inicial": 2600 }),
    "menos vida": con({ "vida.inicial": 1200 }),
  };
}

// ------------------------------------------------------------------ principal

console.log("Arena de trompos · banco de física (sin navegador)");
console.log(`  rondas por cantidad: ${RONDAS}   semilla base: ${SEMILLA}\n`);

let todoOk = true;

if (process.argv.includes("--factores")) {
  // Barrido de la calibración del daño: con los trompos pequeños hay menos choques por
  // segundo y, con poca gente, cada golpe tiene que pesar más para que la ronda dure
  // lo mismo con 10 que con 40.
  console.log("Barrido de danio.factorPorParticipantes");
  for (const cantidad of CANTIDADES) {
    const linea = [];
    for (const factor of [1.4, 1.75, 2.1, 2.5, 3]) {
      const p = copiaProfunda(PARAMETROS);
      p.danio.factorPorParticipantes = p.danio.factorPorParticipantes.map((f) => ({ ...f, factor }));
      const r = resumen(p, cantidad, RONDAS, SEMILLA, true);
      linea.push(
        `×${factor.toFixed(2)}: ${r.batallaMediana.toFixed(0)} s (${r.porTiempo} por tiempo)`,
      );
    }
    console.log(`  ${String(cantidad).padStart(2)} participantes · ${linea.join(" · ")}`);
  }
} else if (process.argv.includes("--variantes")) {
  const lista = variantes();
  const filas = [];
  for (const [nombre, p] of Object.entries(lista)) {
    console.log(`${nombre}:`);
    for (const cantidad of CANTIDADES) {
      console.log(` ${cantidad} participantes`);
      const r = resumen(p, cantidad, RONDAS, SEMILLA, true);
      filas.push({ nombre, ...r });
      console.log(
        `    batalla ${r.batallaMediana.toFixed(1)} s · choques ${r.choquesPorRonda} · por tiempo ${r.porTiempo}/${RONDAS} ·` +
          ` media ${r.velocidadMedia} px/s · solape ${r.solapeTarde} px`,
      );
    }
    console.log("");
  }
  console.log("Comparación");
  console.log("  variante        n   batalla  porTiempo  choques  vel.media  solape");
  for (const f of filas) {
    console.log(
      `  ${f.nombre.padEnd(14)} ${String(f.cantidad).padStart(2)} ` +
        `${String(f.batallaMediana.toFixed(1)).padStart(6)} s ${String(`${f.porTiempo}/${RONDAS}`).padStart(9)} ` +
        `${String(f.choquesPorRonda).padStart(8)} ${String(f.velocidadMedia).padStart(10)} ${String(f.solapeTarde).padStart(7)}`,
    );
  }
} else {
  const resultados = [];
  for (const cantidad of CANTIDADES) {
    const p = copiaProfunda(PARAMETROS);
    console.log(`\n${cantidad} participantes (escala ${escalaTrompos(Object.assign(p, { simulacion: { ...p.simulacion, participantes: cantidad } })).toFixed(2)})`);
    const r = resumen(p, cantidad);
    resultados.push(r);
    const antes = todoOk;
    todoOk =
      comprobar("Todas las rondas terminan en victoria", r.datos.every((d) => d.fase === "victoria"), `${r.datos.filter((d) => d.fase === "victoria").length}/${r.rondas}`) && todoOk;
    todoOk = comprobar("Todas las rondas tienen ganador", r.conGanador === r.rondas, `${r.conGanador}/${r.rondas}`) && todoOk;
    todoOk = comprobar("Ninguna ronda se decide por el reloj", r.porTiempo === 0, `${r.porTiempo}/${r.rondas} por tiempo`) && todoOk;
    todoOk = comprobar("La batalla dura lo que tiene que durar (ni dos minutos ni un suspiro)", r.batallaMediana >= 45 && r.batallaMediana <= 120 && r.batallaMax < p.simulacion.batallaMaxima, `mediana ${r.batallaMediana.toFixed(1)} s, máxima ${r.batallaMax.toFixed(1)} s (tope del reloj ${p.simulacion.batallaMaxima} s)`) && todoOk;
    todoOk = comprobar("Nadie se sale de la arena", r.saltos === 0 && r.fuera === 0, `${r.saltos} saltos, ${r.fuera} fuera`) && todoOk;
    todoOk = comprobar("Nadie nace encima de otro", r.solapeInicial <= 1, `peor solape al empezar ${r.solapeInicial} px`) && todoOk;
    todoOk = comprobar("No se apelotonan en la pelea", r.solapeTarde < r.radio * 0.6, `peor solape ${r.solapeTarde} px con radio ${r.radio} px`) && todoOk;
    todoOk = comprobar("Siguen moviéndose", r.velocidadMedia >= p.fisica.velocidadCrucero * 0.6 && r.mediaBaja === 0, `velocidad media ${r.velocidadMedia} px/s (crucero ${p.fisica.velocidadCrucero}), ${r.mediaBaja} muestras lentas`) && todoOk;
    const proporcionParados = r.parados / Math.max(1, r.trompoMuestras);
    todoOk = comprobar("Nadie se queda parado", proporcionParados < 0.02, `${(proporcionParados * 100).toFixed(2)} % de trompo-muestras casi paradas`) && todoOk;
    todoOk = comprobar("No se apiñan en las esquinas", r.borde <= Math.ceil(cantidad * 0.3), `máximo ${r.borde} trompos pegados al borde de ${cantidad}`) && todoOk;
    todoOk = comprobar("Siguen habiendo choques", r.choquesPorRonda >= cantidad * 2, `${r.choquesPorRonda} choques (${(r.choquesPorRonda / cantidad).toFixed(1)} por trompo)`) && todoOk;
    todoOk = comprobar("Se elimina a todos menos a uno", r.eliminacionesPorRonda >= cantidad - 1, `${r.eliminacionesPorRonda} bajas de ${cantidad - 1}`) && todoOk;
    if (!antes) todoOk = false;

    // Determinismo con esta cantidad.
    const a = correrRonda(p, SEMILLA);
    const b = correrRonda(p, SEMILLA);
    todoOk = comprobar("Misma semilla, misma batalla", a.firma === b.firma, `${a.choques} choques idénticos`) && todoOk;
  }

  console.log("\nResumen por cantidad");
  console.log("   n   radio  escala  batalla  batalla/n  choques  choques/n  bajas  vel.media  solape");
  for (const r of resultados) {
    console.log(
      `  ${String(r.cantidad).padStart(3)} ${String(r.radio).padStart(6)} ${r.escala.toFixed(2).padStart(7)} ` +
        `${r.batallaMediana.toFixed(1).padStart(7)} s ${r.batallaPorTrompo.toFixed(2).padStart(9)} s ` +
        `${String(r.choquesPorRonda).padStart(8)} ${(r.choquesPorRonda / r.cantidad).toFixed(1).padStart(9)} ` +
        `${String(r.eliminacionesPorRonda).padStart(6)} ${String(r.velocidadMedia).padStart(10)} ${String(r.solapeTarde).padStart(7)}`,
    );
  }
  console.log(`\n${todoOk ? "Todo correcto" : "Hay comprobaciones en rojo"}`);
  if (!todoOk) process.exitCode = 1;
}
