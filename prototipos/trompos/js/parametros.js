// Todos los números que se pueden tocar, en un solo sitio.
//
// Por qué un objeto único y no constantes repartidas: la orden pide «una lista de
// los parámetros que se pueden ajustar», y para afinar la física hace falta cambiar
// valores sin buscar por diez archivos. Además el HUD y la URL escriben aquí, así
// que este objeto es la única fuente de verdad.
//
// Cualquier valor se puede forzar desde la URL por su nombre: `?friccion=0.4&velocidad=2`.
// Si el nombre está repetido en dos grupos, gana el primero: los nombres son únicos.

export const PARAMETROS = {
  // ---------------------------------------------------------------- lienzo
  lienzo: {
    ancho: 1080,
    alto: 1920,
    // Zonas reservadas (orden 02): arriba la clasificación, en medio la arena, abajo
    // los mensajes. Los trompos rebotan contra la arena, nunca contra el lienzo, así
    // que ni la tabla ni los carteles tapan la pelea.
    margenLados: 76,
    margenArriba: 258, // debajo de la tabla de clasificación
    margenAbajo: 230, // encima de los carteles de eliminación
  },

  // ---------------------------------------------------------------- tiempo
  tiempo: {
    // Paso fijo de la física. 120 Hz: a 480 px/s un trompo avanza 4 px por paso,
    // muy por debajo del radio (42 px con diez participantes), así que nadie
    // atraviesa a nadie ni con cuarenta trompos en la arena.
    paso: 1 / 120,
    // Techo de pasos por fotograma. Si el navegador se atrasa 1 s, se simulan
    // como mucho 8 pasos (66 ms) y el resto se tira: el movimiento se frena,
    // nunca da un salto que teletransporte un trompo dentro de otro.
    pasosMaximos: 8,
    // Reloj de la simulación. 1 = tiempo real; 2 = doble para revisar rápido.
    velocidad: 1,
  },

  // ---------------------------------------------------------------- física
  // Con cuarenta trompos la arena está mucho más apretada: los choques se multiplican
  // por cuatro. El roce y el empuje de crucero no cambian; lo que cambia es que hay
  // más gente chocando, así que la vida por ronda se ajusta sola con la presión.
  fisica: {
    // Roce exponencial por segundo: v *= e^(-roce·dt). Pequeño a propósito: el
    // empuje de crucero es quien mantiene la pelea viva, no la inercia.
    roce: 0.05,
    // Velocidad de crucero: a la que tiende cada trompo mientras nadie le pega.
    // Es el parámetro que decide cuánto se ve la pelea: más crucero, más choques.
    // Orden 05 (ajuste): se bajó de 480 a 400 para que el desplazamiento sea más
    // pausado y la ronda dure más, sin que la arena llegue a verse lenta.
    velocidadCrucero: 400,
    // Empuje de crucero (1/s): control proporcional hacia la velocidad de crucero.
    empujeCrucero: 1.3,
    // El rumbo de cada trompo pasea solo (rad/s): así no se cruzan siempre igual.
    giroRumbo: 0.55,
    // Ruido (px/s²) para que no vayan en línea recta perfecta.
    jitter: 52,
    // Por debajo de esta velocidad se les da un empujón mínimo (red de seguridad).
    velocidadMinima: 90,
    velocidadMaxima: 1500,
    // Rebote contra las paredes (1 = choque perfecto, sin pérdida).
    rebotePared: 0.92,
    // Rebote entre trompos. Alto: los trompos se separan de verdad al chocar.
    reboteChoque: 0.94,
    // Cuánto se corrige el solape por paso. 0.85 quita el encajado sin vibrar.
    correccion: 0.85,
    // Solape que se tolera (px) antes de separar: evita temblores en reposo.
    holgura: 0.4,
    // Con mucha gente apelotonada, una sola pasada de separación deja solapes. Se
    // repite la resolución de choques hasta `pasadasMaximas` veces por paso: cuesta
    // poco (n² con n=40 son 780 parejas) y evita que se amontonen sin separarse.
    pasadasChoques: 2,
    // Parte del impulso que se convierte en giro (los trompos se enroscan).
    acopleGiro: 0.35,
    // Cuánto se ciza el giro con el tiempo: el trompo se va durmiendo.
    roceGiro: 0.1,
    // Sacudida de la cámara por impacto, en px por unidad de daño.
    sacudida: 0.05,
  },

  // ---------------------------------------------------------------- piezas
  trompo: {
    // Radio de referencia del dibujo (el que tenía el prototipo en la orden 01).
    radioBase: 84,
    // Escala por número de participantes. La orden 02 pide que con diez sea la mitad
    // de la orden 01 (0,50) y que con más gente se adapte sin volverse ilegible: por
    // debajo de 0,40 los diseños ya no se distinguen. Se interpola entre los puntos.
    escalaPorParticipantes: [
      { participantes: 10, escala: 0.5 },
      { participantes: 20, escala: 0.46 },
      { participantes: 30, escala: 0.43 },
      { participantes: 40, escala: 0.41 },
    ],
    // Masa base: un disco de radio `radioBase` y densidad 1.
    densidadBase: 1,
    // Rapidez con la que sale cada trompo al empezar la ronda (px/s). Baja con el
    // crucero: si salieran igual de rápidos, el arranque se comería media ronda.
    rapidezMinima: 350,
    rapidezMaxima: 560,
    // Margen de variación de ataque y defensa entre participantes del mismo diseño.
    desvio: 0.08,
    // Velocidad de giro inicial (rad/s), en valor absoluto.
    giroMinimo: 12,
    giroMaximo: 18,
    // Retardo de entrada entre un trompo y el siguiente (s).
    aparicionEscalon: 0.08,
  },

  // ---------------------------------------------------------------- daño
  danio: {
    // Por debajo de esta velocidad de cierre (px/s) el choque suena pero no hace
    // daño: así dos trompos lentos que se rozan no se matan a besos. Sube con el
    // ajuste de la orden 05: con la arena más pausada, los roces son más frecuentes y
    // no deben contar.
    umbral: 100,
    // Daño mínimo de un choque que supera el umbral.
    minimo: 11,
    // Daño por px/s de cierre que pasa del umbral. Se afinó con
    // `node banco-fisica.mjs --variantes` y se re-ajustó en la orden 05 (de 0,12 a
    // 0,085) para que la ronda dure en torno a los 75 s y termine por KO, no por reloj.
    escala: 0.085,
    // Ventana de invulnerabilidad tras recibir daño (s). Evita que un amontonamiento
    // cuente como cinco choques en el mismo instante.
    proteccion: 0.17,
    // Desgaste continuo: la vida también se va sola. 3 sobre 1800 son 10 minutos:
    // no decide la ronda, sólo se nota en los trompos que se quedan rezagados.
    desgaste: 3,
    // A partir de aquí (s) la presión sube: el daño se multiplica hasta ×2 para que
    // ninguna ronda se quede sin final. Con el ajuste de la orden 05 (arena más
    // pausada y golpes más suaves) la ronda dura en torno a los 75 s, así que la
    // presión entra más tarde: sólo tiene que rematar las que se atascan.
    presionDesde: 55,
    presionMaxima: 2,
    // A partir de este número de participantes la presión empieza antes: con cuarenta
    // trompos hay tantos choques que la ronda se cerraría sola, pero el reloj de
    // seguridad no debe depender de eso.
    presionDesdePorParticipante: 55, // s con 10 participantes o menos
    presionDesdeMinimo: 34, // s con 40 participantes o más
    // Calibración del daño por número de participantes. Con los trompos a la mitad de
    // tamaño (orden 02) la sección de choque se reduce y hay menos impactos por segundo
    // con diez participantes, así que en poca gente cada golpe tiene que pesar más.
    //
    // Re-medido en la orden 05 tras bajar el crucero (480 → 400) y el daño
    // (escala 0,12 → 0,085): con la arena más pausada la diferencia entre 10 y 40 se
    // estrecha y la curva queda casi plana. Los números salen de
    // `node banco-fisica.mjs --factores`.
    factorPorParticipantes: [
      { participantes: 10, factor: 1.45 },
      { participantes: 20, factor: 1.45 },
      { participantes: 30, factor: 1.5 },
      { participantes: 40, factor: 1.45 },
    ],
  },

  // ---------------------------------------------------------------- vida
  vida: {
    inicial: 1800,
    // Umbrales de aspecto (fracción de vida).
    alta: 0.66,
    baja: 0.33,
    // Duración del fade de aparición y de la muerte (s).
    aparicion: 0.55,
    muerte: 0.9,
    // Salto de vida mínimo para refrescar la tabla (evita repintar cada paso).
    refrescoTabla: 0.1,
  },

  // ---------------------------------------------------------------- etiquetas
  etiquetas: {
    // A partir de este número de participantes las etiquetas pasan a modo compacto:
    // nombre solo, más pequeñas y sin placa redondeada grande.
    umbralCompactas: 14,
    // Escala del texto en modo normal y en modo compacto (fracción del tamaño base).
    escalaNormal: 0.88,
    escalaCompacta: 0.78,
    // Suelo de la escala: por debajo de esto el nombre dejaría de leerse.
    escalaMinima: 0.62,
    // Cuánto dura la prioridad de una etiqueta tras un golpe recibido / dado (s).
    prioridadGolpe: 1.3,
    prioridadAtaque: 1,
    // Si una etiqueta pisa a otra ya colocada y no tiene prioridad, no se dibuja.
    // Con prioridad sí se dibuja, pero encima de la otra.
    evitarSolapes: true,
    // Distancia mínima entre el nombre y el borde inferior de la vida.
    separacion: 6,
    // Ancho máximo de la placa: si el nombre no cabe, se acorta con puntos suspensivos
    // (el nombre entero sigue en los datos y en el `title` de la tabla).
    anchoMaximo: 260,
    anchoMaximoCompacta: 155,
  },

  // ---------------------------------------------------------------- fotos
  fotos: {
    // Radio del medallón dentro del núcleo, en fracción del radio del trompo.
    //
    // Historia de este número: empezó en 0,36 (dentro del anillo del núcleo, 0,41) y al
    // mirarlo en pantalla las caras se veían pequeñas. Con 0,48 el medallón queda justo
    // por dentro del anillo interior del diseño (0,53–0,65): la cara se reconoce, y por
    // fuera siguen viéndose el patrón, las palas y las grietas de daño, que van del
    // 0,83 al 1,13 del radio.
    // Interruptor del panel de la aplicación (orden 07): con esto en falso no se pinta
    // el medallón y el núcleo queda con el diseño, pero ni la foto ni la inicial.
    activo: true,
    medallon: 0.48,
    // Radio mínimo en píxeles: con cuarenta participantes el trompo mide 34 px de radio
    // y 0,48 daría 16,5; el suelo de 15 evita que en los diseños pequeños se quede en
    // una mota.
    medallonMinimo: 15,
    // Grosor del aro del color del jugador y aro oscuro de separación, para que el
    // medallón se despegue del cuerpo del trompo.
    grosorAro: 3,
    separacion: 1.6,
  },

  // ---------------------------------------------------------------- clasificación
  clasificacion: {
    x: 34,
    y: 16,
    ancho: 1012,
    // Cabecera fina con el título, la ronda y el total de participantes.
    altoCabecera: 22,
    // Cinco filas de 36 px más la línea de resumen tienen que caber por encima de
    // `lienzo.margenArriba` (258): 22 + 5·(36+3) + 22 = 239 px.
    altoFila: 36,
    separacionFilas: 3,
    altoResumen: 22,
    // Cuántas filas se enseñan enteras; el resto se resume en una línea.
    filas: 5,
    // Con la vida muy baja el nombre se apaga, pero sigue estando.
    brilloMinimo: 0.5,
  },

  // ---------------------------------------------------------------- efectos
  efectos: {
    particulasMaximas: 1200,
    ondasMaximas: 48,
    // Partículas por impacto, escaladas por el daño y por la gente que haya.
    chispasChoque: 22,
    chispasExplosion: 90,
    // Partículas de energía que suelta cada trompo vivo por segundo.
    energiaPorSegundo: 12,
    // Chispas por segundo de un trompo con la vida baja (avería a la vista).
    chispasAveria: 3.5,
    rastroPuntos: 18,
    rastroCada: 0.028,
    // Duración de la onda de choque y del destello (s).
    onda: 0.55,
    destello: 0.14,
    // Sacudida máxima acumulada (px).
    sacudidaMaxima: 14,
    // Números de daño flotantes (orden 02: el daño tiene que leerse sin la tabla).
    numerosDanio: true,
    numerosMaximos: 26,
    // Por debajo de este daño no se enseña número: sería una lluvia de cifras.
    numeroMinimo: 9,
    numeroDuracion: 0.85,
    // Escala de los efectos respecto a los valores de la orden 01 (calculada a partir
    // de la escala de los trompos; se escribe desde `escalaTrompos`).
    escala: 1,
    // Con mucha gente el aura se recorta un poco: cuarenta auras aditivas de 65 px de
    // radio son medio millón de píxeles de sobrecarga por fotograma.
    escalaAuraMuchos: 0.78,
    umbralAuraMuchos: 22,
  },

  // ---------------------------------------------------------------- sonido
  sonido: {
    activo: true,
    volumen: 0.6,
    // Ningún sonido se repite más de una vez cada `repetible` segundos, y en total no
    // suenan más de `maxPorSegundo` por segundo: con cuarenta trompos, si no, sería
    // una ametralladora.
    maxPorSegundo: 12,
    // Umbral de daño para que un choque suene «fuerte» en vez de «leve».
    umbralFuerte: 26,
  },

  // ---------------------------------------------------------------- poderes
  poderes: {
    activo: true,
    // Indicadores en el lienzo: nombre del poder, aro de carga y aro de enfriamiento.
    verIndicadores: true,
    // Efectos grandes (campos, rayos, escudos, explosiones). Se puede apagar para
    // comprobar que no tapan nada: con esto en falso el lienzo queda igual que sin
    // poderes activos.
    verEfectos: true,
    // Límites duros: un poder no puede dar velocidad infinita ni sacar a nadie de la
    // arena ni matar de un golpe sin aviso.
    empujeMaximo: 560, // px/s de impulso máximo que puede aplicar un poder
    aceleracionMaxima: 420, // px/s² de los campos (atracción del cósmico, viento)
    velocidadMaximaFactor: 1.6, // tope del multiplicador de crucero
    danioMaximoPorGolpe: 0.22, // fracción de la vida máxima que quita un poder de una vez
    proteccionPoder: 0.25, // s de invulnerabilidad tras un daño causado por poder
    cadenaMaxima: 3, // saltos máximos del rayo eléctrico
    // Freno entre activaciones distintas: evita que nueve poderes salten a la vez.
    enfriamientoGlobal: 0.45,
    // Demostración automática: secuencia reproducible, un poder detrás de otro.
    demo: {
      activa: false,
      intervalo: 1.7, // s entre activaciones
    },
  },

  // ---------------------------------------------------------------- simulación
  simulacion: {
    // Semilla base. Todo el azar de la partida sale de aquí: con la misma semilla
    // y la misma ronda, la batalla es idéntica, choque a choque.
    semilla: 20260214,
    espera: 1.2,
    aparicion: 1.1,
    cuenta: 3,
    // Tope de la batalla (s). Sólo existe para que ninguna ronda se eternice: con los
    // valores de fábrica las rondas acaban por KO en torno a los 75 s. Se subió de 90
    // a 180 en la orden 05, al alargar las rondas, para que el reloj siga sin decidir.
    batallaMaxima: 180,
    victoria: 4.5,
    reinicio: 1,
    // Participantes iniciales (el taller lo cambia a 10, 20, 30 o 40).
    participantes: 10,
    maxParticipantes: 40,
    // Aviso de «nuevo líder»: como el liderato cambia con cada choque, sólo se
    // anuncia si el anterior aguantó `liderAvisoDesde` segundos y el nuevo le saca
    // al menos `liderVentaja` de ventaja. Sin esto el cartel no deja ver la arena.
    liderAvisoDesde: 6,
    liderVentaja: 1.06,
  },

  // ---------------------------------------------------------------- aspecto
  aspecto: {
    // Fondo del escenario del navegador. El lienzo NO se pinta nunca: sigue
    // transparente, esto sólo cambia lo que hay detrás para poder comprobarlo.
    fondo: "cuadros", // cuadros | negro | blanco | magenta
    // Capas de depuración.
    verRadios: false,
    verLimites: false,
    verNombres: true,
    verTabla: true,
    verOrbitas: true,
    verRastro: true,
    verParticulas: true,
    // Escala de la interfaz de depuración.
    calidad: 1, // 1 = todo; 0.6 = menos partículas (para portátiles flojos)
  },
};

/** Copia profunda, para poder volver a los valores de fábrica. */
export function copiaProfunda(valor) {
  return JSON.parse(JSON.stringify(valor));
}

export const FABRICA = copiaProfunda(PARAMETROS);

/**
 * Escala de los trompos para un número de participantes.
 *
 * Se interpola entre los puntos de `trompo.escalaPorParticipantes` (la orden 02 fija
 * 0,50 con diez) y se mantiene plana fuera del rango: por debajo de diez no se
 * agranda más, y por encima de cuarenta no se encoge más, porque el diseño dejaría de
 * reconocerse.
 */
export function escalaTrompos(p = PARAMETROS) {
  const n = Math.max(1, p.simulacion.participantes);
  const puntos = p.trompo.escalaPorParticipantes;
  if (n <= puntos[0].participantes) return puntos[0].escala;
  for (let i = 1; i < puntos.length; i += 1) {
    const a = puntos[i - 1];
    const b = puntos[i];
    if (n <= b.participantes) {
      const t = (n - a.participantes) / (b.participantes - a.participantes);
      return a.escala + (b.escala - a.escala) * t;
    }
  }
  return puntos[puntos.length - 1].escala;
}

/** Radio de un trompo de un diseño dado, ya con la escala de participantes aplicada. */
export function radioDe(p, diseno, radioBase = null) {
  const base = radioBase ?? p.trompo.radioBase;
  return base * escalaTrompos(p) * (diseno?.radio ?? 1);
}

/**
 * Escala de los efectos (chispas, ondas, fogonazos). Siguen a los trompos, pero con
 * suelo 0,7: por debajo de eso un fogonazo de 30 px ya no se ve.
 */
export function escalaEfectos(p = PARAMETROS) {
  const k = escalaTrompos(p) / 0.5;
  return k < 0.7 ? 0.7 : k > 1 ? 1 : k;
}

/** Interpola una tabla `[{participantes, <clave>}]` por número de participantes. */
function interpolar(p, tabla, clave) {
  const n = Math.max(1, p.simulacion.participantes);
  if (n <= tabla[0].participantes) return tabla[0][clave];
  for (let i = 1; i < tabla.length; i += 1) {
    const a = tabla[i - 1];
    const b = tabla[i];
    if (n <= b.participantes) {
      const t = (n - a.participantes) / (b.participantes - a.participantes);
      return a[clave] + (b[clave] - a[clave]) * t;
    }
  }
  return tabla[tabla.length - 1][clave];
}

/** Factor de calibración del daño para que la ronda dure lo mismo con 10 que con 40. */
export function factorDanio(p = PARAMETROS) {
  return interpolar(p, p.danio.factorPorParticipantes, "factor");
}

/** Rectángulo de la arena (sin contar el radio de nadie). */
export function cajaArena(p = PARAMETROS) {
  return {
    xMin: p.lienzo.margenLados,
    xMax: p.lienzo.ancho - p.lienzo.margenLados,
    yMin: p.lienzo.margenArriba,
    yMax: p.lienzo.alto - p.lienzo.margenAbajo,
  };
}

/** Centro y tamaño de la arena, para repartir y para comprobar. */
export function medidaArena(p = PARAMETROS) {
  const c = cajaArena(p);
  return { x: c.xMin, y: c.yMin, ancho: c.xMax - c.xMin, alto: c.yMax - c.yMin, ...c };
}

/** Límites que puede pisar el centro de un trompo de radio `radio`. */
export function limitesDe(p, radio) {
  const c = cajaArena(p);
  return {
    xMin: c.xMin + radio,
    xMax: c.xMax - radio,
    yMin: c.yMin + radio,
    yMax: c.yMax - radio,
  };
}

/** Aplana `{grupo: {clave: valor}}` a `{clave: valor}` para poder buscar por nombre. */
function aplanar(objeto, salida = {}) {
  for (const [clave, valor] of Object.entries(objeto)) {
    if (valor && typeof valor === "object") aplanar(valor, salida);
    else salida[clave] = valor;
  }
  return salida;
}

/**
 * Escribe en `PARAMETROS` lo que venga en la URL: `?friccion=0.4&verRadios=1`.
 * Devuelve la lista de lo aplicado, para poder enseñarlo en el HUD y no tener
 * que adivinar por qué la simulación se comporta raro.
 */
export function aplicarUrl(url = globalThis.location?.search ?? "") {
  const aplicados = [];
  const consulta = new URLSearchParams(url);
  const plano = aplanar(PARAMETROS);
  for (const [nombre, valor] of consulta) {
    if (!(nombre in plano)) continue;
    const actual = plano[nombre];
    let convertido;
    if (typeof actual === "boolean") convertido = valor !== "0" && valor !== "false";
    else if (typeof actual === "number") convertido = Number(valor);
    else convertido = valor;
    if (typeof actual === "number" && !Number.isFinite(convertido)) continue;
    escribir(nombre, convertido);
    aplicados.push(`${nombre}=${convertido}`);
  }
  return aplicados;
}

/** Escribe un parámetro por nombre, esté en el grupo que esté. */
export function escribir(nombre, valor) {
  for (const grupo of Object.values(PARAMETROS)) {
    if (grupo && typeof grupo === "object" && nombre in grupo) {
      grupo[nombre] = valor;
      return true;
    }
  }
  return false;
}

/** Lee un parámetro por nombre. */
export function leer(nombre) {
  for (const grupo of Object.values(PARAMETROS)) {
    if (grupo && typeof grupo === "object" && nombre in grupo) return grupo[nombre];
  }
  return undefined;
}
