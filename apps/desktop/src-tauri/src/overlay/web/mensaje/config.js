/* La configuración del contenedor del mensaje: topes, valores de fabrica y normalizado.
 *
 * Esto corre en **otro proceso** que el motor, y por el cable puede llegar cualquier
 * cosa: un JSON editado a mano, unos ajustes de una version anterior o un aviso viejo
 * que se quedo en la cola. El motor ya sanea lo que guarda, asi que esto no es la
 * primera defensa: es la **ultima**. Si algo se cuela, el aviso sale con el valor de
 * fabrica en vez de salir roto.
 *
 * Los topes estan repetidos a proposito, como los de la escala y los de la permanencia:
 * el overlay no puede preguntarle al motor, y un valor sin acotar acaba dentro de una
 * variable de CSS.
 */
(() => {
  /** Los mismos topes que `alerts/mensaje.rs`, en el mismo orden. */
  const LIMITES = {
    bordeGrosor: 12,
    radio: 200,
    padding: 80,
    sombra: 100,
    blur: 40,
    glow: 60,
    anchoMin: 20,
    anchoMax: 100,
    alturaMinima: 400,
    separacion: 120,
    tamanoMin: 10,
    tamanoMax: 160,
    pesoMin: 100,
    pesoMax: 900,
    espaciadoMin: -10,
    espaciadoMax: 30,
    interlineadoMin: 80,
    interlineadoMax: 250,
    contorno: 12,
    sombraTexto: 40,
    retardo: 10000,
    duracionMin: 80,
    duracionMax: 5000,
    cicloMin: 400,
    cicloMax: 20000,
    intensidad: 200,
  };

  /**
   * Las familias, con sus reservas.
   *
   * Son fuentes **del sistema**: OBS no tiene por que tener red, y esperar a que baje
   * una tipografia seria un aviso sin texto. La ultima de cada pila es la del proyecto,
   * que es la que sabe pintar los apodos adornados de TikTok.
   */
  const FUENTES = {
    sistema:
      '"Segoe UI", system-ui, "Segoe UI Symbol", "Segoe UI Emoji", "Cambria Math", "Noto Sans Symbols 2", "Noto Sans Math", sans-serif',
    redonda: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"Cascadia Mono", Consolas, "Courier New", monospace',
    impacto: '"Arial Black", Impact, "Segoe UI", sans-serif',
    manuscrita: '"Segoe Script", "Comic Sans MS", cursive',
    condensada: '"Arial Narrow", "Segoe UI", sans-serif',
  };

  /** Donde se apoya el texto. Son los mismos nombres que `ALINEACIONES_MENSAJE`. */
  const ALINEACIONES = {
    izquierda: "left",
    centro: "center",
    derecha: "right",
  };

  /** Los valores de fabrica: los mismos que el aviso pintaba antes de todo esto. */
  const DE_FABRICA = {
    estilo: "default",
    fondo: "#0b0d12",
    fondo_2: "#25f4ee",
    fondo_opacidad: 88,
    borde_color: "#232936",
    borde_grosor: 1,
    radio: 12,
    padding_h: 26,
    padding_v: 14,
    sombra: 0,
    blur: 0,
    glow: 0,
    glow_color: "#25f4ee",
    ancho_vw: 70,
    altura_minima: 0,
    separacion: 14,
    fuente: "sistema",
    tamano: 40,
    peso: 800,
    color: "#e8eaf0",
    alineacion: "centro",
    espaciado: 0,
    interlineado: 115,
    contorno: 0,
    contorno_color: "#000000",
    sombra_texto: 12,
    animacion: "ninguna",
    animacion_idle: "ninguna",
    animacion_texto: "ninguna",
    retardo_ms: 0,
    duracion_ms: 450,
    ciclo_ms: 2200,
    intensidad: 60,
    ritmo: "auto",
  };

  /** Un numero con tope, o el de fabrica si no es un numero. */
  function numero(valor, min, max, defecto) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return defecto;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  /**
   * Un color con forma de color, en minusculas.
   *
   * Solo `#rrggbb`: lo que manda un selector de color y lo unico que se puede meter en
   * una variable de CSS sin miedo. Un `red; } body { display: none` colado aqui no se
   * pintaria mal: se saldria de su sitio y romperia la hoja entera.
   */
  function color(valor, defecto) {
    if (typeof valor !== "string") return defecto;
    const limpio = valor.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(limpio) ? limpio : defecto;
  }

  /** Un nombre de catalogo, o el defecto. Se acepta con espacios y en mayusculas. */
  function delCatalogo(valor, catalogo, defecto) {
    const limpio = typeof valor === "string" ? valor.trim().toLowerCase() : "";
    return catalogo.includes(limpio) ? limpio : defecto;
  }

  /** Un `#rrggbb` con su opacidad, en forma de `rgba()`. */
  function rgba(hex, opacidad) {
    const limpio = color(hex, DE_FABRICA.fondo);
    const r = parseInt(limpio.slice(1, 3), 16);
    const g = parseInt(limpio.slice(3, 5), 16);
    const b = parseInt(limpio.slice(5, 7), 16);
    const alfa = Math.min(100, Math.max(0, Number(opacidad) || 0)) / 100;
    return `rgba(${r}, ${g}, ${b}, ${alfa})`;
  }

  /** Las decimas de pixel, en pixeles. El espaciado y el contorno van asi. */
  const decimas = (valor) => Math.round(Number(valor) || 0) / 10;

  /**
   * Un mensaje completo y valido, venga como venga.
   *
   * Los catalogos se repiten aqui tal cual estan en Rust: es el mismo contrato, y hay
   * un test que compara las dos listas leyendo este fichero.
   */
  function normalizar(mensaje) {
    const bruto = mensaje && typeof mensaje === "object" ? mensaje : {};
    const toma = (campo) => (bruto[campo] === undefined ? DE_FABRICA[campo] : bruto[campo]);
    return {
      estilo: delCatalogo(toma("estilo"), ESTILOS, DE_FABRICA.estilo),
      fondo: color(toma("fondo"), DE_FABRICA.fondo),
      fondo_2: color(toma("fondo_2"), DE_FABRICA.fondo_2),
      fondo_opacidad: numero(toma("fondo_opacidad"), 0, 100, DE_FABRICA.fondo_opacidad),
      borde_color: color(toma("borde_color"), DE_FABRICA.borde_color),
      borde_grosor: numero(toma("borde_grosor"), 0, LIMITES.bordeGrosor, DE_FABRICA.borde_grosor),
      radio: numero(toma("radio"), 0, LIMITES.radio, DE_FABRICA.radio),
      padding_h: numero(toma("padding_h"), 0, LIMITES.padding, DE_FABRICA.padding_h),
      padding_v: numero(toma("padding_v"), 0, LIMITES.padding, DE_FABRICA.padding_v),
      sombra: numero(toma("sombra"), 0, LIMITES.sombra, DE_FABRICA.sombra),
      blur: numero(toma("blur"), 0, LIMITES.blur, DE_FABRICA.blur),
      glow: numero(toma("glow"), 0, LIMITES.glow, DE_FABRICA.glow),
      glow_color: color(toma("glow_color"), DE_FABRICA.glow_color),
      ancho_vw: numero(toma("ancho_vw"), LIMITES.anchoMin, LIMITES.anchoMax, DE_FABRICA.ancho_vw),
      altura_minima: numero(toma("altura_minima"), 0, LIMITES.alturaMinima, DE_FABRICA.altura_minima),
      separacion: numero(toma("separacion"), 0, LIMITES.separacion, DE_FABRICA.separacion),
      fuente: delCatalogo(toma("fuente"), Object.keys(FUENTES), DE_FABRICA.fuente),
      tamano: numero(toma("tamano"), LIMITES.tamanoMin, LIMITES.tamanoMax, DE_FABRICA.tamano),
      peso: redondearPeso(numero(toma("peso"), LIMITES.pesoMin, LIMITES.pesoMax, DE_FABRICA.peso)),
      color: color(toma("color"), DE_FABRICA.color),
      alineacion: delCatalogo(toma("alineacion"), Object.keys(ALINEACIONES), DE_FABRICA.alineacion),
      espaciado: numero(
        toma("espaciado"),
        LIMITES.espaciadoMin,
        LIMITES.espaciadoMax,
        DE_FABRICA.espaciado,
      ),
      interlineado: numero(
        toma("interlineado"),
        LIMITES.interlineadoMin,
        LIMITES.interlineadoMax,
        DE_FABRICA.interlineado,
      ),
      contorno: numero(toma("contorno"), 0, LIMITES.contorno, DE_FABRICA.contorno),
      contorno_color: color(toma("contorno_color"), DE_FABRICA.contorno_color),
      sombra_texto: numero(toma("sombra_texto"), 0, LIMITES.sombraTexto, DE_FABRICA.sombra_texto),
      animacion: delCatalogo(toma("animacion"), ANIMACIONES, DE_FABRICA.animacion),
      animacion_idle: delCatalogo(toma("animacion_idle"), PERMANENCIAS, DE_FABRICA.animacion_idle),
      animacion_texto: delCatalogo(toma("animacion_texto"), ANIMACIONES_TEXTO, DE_FABRICA.animacion_texto),
      retardo_ms: numero(toma("retardo_ms"), 0, LIMITES.retardo, DE_FABRICA.retardo_ms),
      duracion_ms: numero(
        toma("duracion_ms"),
        LIMITES.duracionMin,
        LIMITES.duracionMax,
        DE_FABRICA.duracion_ms,
      ),
      ciclo_ms: numero(toma("ciclo_ms"), LIMITES.cicloMin, LIMITES.cicloMax, DE_FABRICA.ciclo_ms),
      intensidad: numero(toma("intensidad"), 0, LIMITES.intensidad, DE_FABRICA.intensidad),
      ritmo: delCatalogo(toma("ritmo"), Object.keys(RITMOS), DE_FABRICA.ritmo),
    };
  }

  /** El peso, a la centena: un `437` no lo entiende ninguna fuente. */
  function redondearPeso(peso) {
    return Math.min(LIMITES.pesoMax, Math.max(LIMITES.pesoMin, Math.round(peso / 100) * 100));
  }

  /** Los mismos nombres que `ESTILOS_MENSAJE`, `ANIMACIONES_MENSAJE`... en Rust. */
  const ESTILOS = [
    "default",
    "pill",
    "card",
    "glass",
    "outline",
    "glow",
    "neon",
    "gradient",
    "minimal",
    "barra",
    "lateral",
    "flotante",
    "cinta",
    "etiqueta",
    "sombra",
  ];
  const ANIMACIONES = [
    "ninguna",
    "fundido",
    "subir",
    "bajar",
    "izquierda",
    "derecha",
    "pop",
    "escala",
    "rebote",
    "abrir_horizontal",
    "abrir_vertical",
    "revelar",
    "revelar_centro",
    "desenfoque",
    "destello",
    "elastico",
    "caer",
  ];
  const PERMANENCIAS = [
    "ninguna",
    "flotar",
    "pulso",
    "pulso_brillo",
    "borde_brillo",
    "brillo",
    "agitar",
  ];
  const ANIMACIONES_TEXTO = [
    "ninguna",
    "fundido",
    "maquina",
    "palabras",
    "letras",
    "onda",
    "brillo",
    "pop",
  ];

  /** Los ritmos: los mismos que los de la alerta, que ya estan en `alertas.js`. */
  const RITMOS = {
    auto: null,
    suave: "cubic-bezier(0.22, 1, 0.36, 1)",
    rebote: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    lineal: "linear",
    rapido: "cubic-bezier(0.4, 0, 1, 1)",
    lento: "cubic-bezier(0, 0, 0.2, 1)",
  };

  window.DashMensajeConfig = {
    LIMITES,
    FUENTES,
    ALINEACIONES,
    RITMOS,
    ESTILOS,
    ANIMACIONES,
    PERMANENCIAS,
    ANIMACIONES_TEXTO,
    DE_FABRICA,
    normalizar,
    rgba,
    decimas,
    color,
  };
})();
