//! Alertas para OBS: qué dispara un aviso, con qué medio, con qué texto y con qué
//! sonido.
//!
//! Es lo que en StreamElements o StreamLabs es el *alert box*. Tres decisiones que
//! se ven en esta página:
//!
//!   * **Los medios se importan, no se enlazan.** Un fichero del escritorio se
//!     rompe en cuanto se mueve, y entonces en OBS sale un hueco. Al importarlo se
//!     copia a la carpeta de datos y lo sirve la propia aplicación.
//!   * **El texto tiene variables** (`{usuario}`, `{regalo}`…). Se editan aquí pero
//!     las rellena Rust: la interfaz no compone el texto, solo lo escribe.
//!   * **Cada tipo se prueba por separado.** Sin botón de probar, ajustar la
//!     duración o el volumen de una alerta es a ciegas: habría que esperar a que
//!     alguien regale algo.
//!   * **Se elige un aviso y se edita ese.** Cinco formularios iguales apilados eran
//!     27 campos a la vez y ninguno se distinguia de los otros: la lista dice cual
//!     esta encendido y cual se esta tocando, y el editor solo existe para el
//!     elegido.
//!   * **Los regalos van por tramos.** Un regalo de diez diamantes y uno de cinco
//!     mil no pueden sonar igual: son tres avisos —normal, grande y enorme— y cual
//!     toca lo decide Rust por los diamantes, no esta pagina.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  TIPOS_AVISO,
  type AjusteAviso,
  type AjustesAlertas,
  type ImportacionMedios,
  type MensajeAviso,
  type SalidaAlertas,
  type TipoAviso,
} from "../api";
import { Card, Copiar, DialogoConfirmacion, Empty, VistaPrevia } from "../components";
import { useDispositivosDeAudio } from "../dispositivos";
import { PanelMensaje, rotuloMensaje } from "../PanelMensaje";
import { mensajeDe } from "../mensaje";
import { usePreviewAudio } from "../previewAudio";
import {
  ANIMACIONES,
  ANIMACION_MAXIMA_S,
  ANIMACION_MINIMA_S,
  PERMANENCIAS,
  RITMOS,
  efectoPermanencia,
  type ParametroPermanencia,
  nombreAnimacion,
} from "../animaciones";
import { t } from "../i18n/es";

/** Tope del selector de archivos. Arrastrar no tiene tope: va por ruta. */
const TOPE_BYTES = 24 * 1024 * 1024;
/** Lo mismo que acepta el motor (`alerts::ACEPTADOS`), para el `accept`. */
const ACEPTADOS = ".png,.jpg,.jpeg,.gif,.webp,.awebp,.apng,.mp4,.webm,.mp3,.ogg,.wav,.m4a";
/** Lo mismo que recorta Rust en el saneado. */
const TEXTO_MAXIMO = 200;
/** Lo que se puede **oír**. Una imagen no suena: no se ofrece en la lista. */
const SUENA = [".mp3", ".ogg", ".wav", ".m4a"];
/** Vídeo: se ve, pero no en miniatura —pintar un fotograma suelto de un `.webm` no
 *  lo hace el navegador solo— y suena con su propio audio. */
const ES_VIDEO = [".mp4", ".webm"];

/** La extensión en minúsculas, con el punto. */
function extensionDe(nombre: string): string {
  const punto = nombre.lastIndexOf(".");
  return punto < 0 ? "" : nombre.slice(punto).toLowerCase();
}

/** Si un medio del almacén es de los que suenan. */
function suena(nombre: string): boolean {
  return SUENA.includes(extensionDe(nombre));
}

/** Si es un vídeo. Va aparte porque se pinta con su primer fotograma y no con una
 *  imagen: llamar «Imagen» a un `.webm` es mentir sobre lo que se va a ver. */
function esVideo(nombre: string): boolean {
  return ES_VIDEO.includes(extensionDe(nombre));
}

/**
 * La dirección de la previa, con la marca de «aquí **no** suena».
 *
 * El sonido de una alerta lo pone el **monitor** del streamer —el mismo que el
 * botón de oír—, y el documento del overlay también sabe reproducirlo: dentro de la
 * previa eso serían dos copias del mismo sonido, que es justo lo que se está
 * arreglando. Con `previa=1` la página se queda muda y el audio lo lleva el
 * coordinador, que es el único que puede garantizar que suene uno a la vez.
 *
 * La marca se añade solo aquí: la dirección que se pega en OBS no la lleva, y ahí
 * el sonido del overlay **es** el que oye la audiencia.
 */
function urlDeLaPrevia(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const destino = new URL(url);
    destino.searchParams.set("previa", "1");
    return destino.toString();
  } catch {
    // Una dirección que no se entiende se deja tal cual: sonaría también en el
    // marco, pero quedarse sin previa por no poder añadir un parámetro es peor.
    return url;
  }
}

/**
 * Texto para comparar: sin acentos y en minúsculas.
 *
 * Los ficheros se llaman como los llamó quien los subió —«¡Trae ese qlo para acá!»,
 * «Duermete alv ya»—, así que buscar «trae» tiene que encontrarlo y buscar «aca»
 * también, aunque el original lleve tilde. Sin esto, la mitad de las búsquedas
 * fallarían por una letra que el streamer ni ve.
 */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
const DURACION_MINIMA_MS = 500;
const DURACION_MAXIMA_MS = 60_000;

/**
 * Milisegundos a segundos, para el campo de las animaciones.
 *
 * La interfaz habla en segundos porque es como se piensa un tiempo que se ve: «medio
 * segundo», no «quinientos milisegundos». El motor guarda milisegundos, que es lo que
 * espera el temporizador. La conversión vive aquí, en un sitio, y no repartida por los
 * cuatro campos.
 */
function enSegundos(ms: number): number {
  return Math.round(ms) / 1000;
}

function enMilisegundos(segundos: string): number {
  const valor = Number(segundos);
  if (!Number.isFinite(valor)) return ANIMACION_MINIMA_S * 1000;
  return Math.round(
    Math.min(ANIMACION_MAXIMA_S, Math.max(ANIMACION_MINIMA_S, valor)) * 1000,
  );
}

/**
 * Cuánto puede crecer o encogerse un aviso, en porcentaje.
 *
 * Son los mismos topes que `ESCALA_MINIMA` y `ESCALA_MAXIMA` del motor
 * (`alerts/mod.rs`), que es quien los hace cumplir de verdad. Aquí solo evitan que
 * el deslizador ofrezca un valor que el motor va a rechazar al guardar. El de arriba
 * tiene motivo: el aviso se centra en la fuente de OBS, así que por encima de 2× el
 * medio se saldría del cuadro.
 */
const ESCALA_MINIMA = 25;
const ESCALA_MAXIMA = 200;

/** Los dos rótulos de grupo que existen. */
type RotuloGrupo = "grupoRegalos" | "grupoActividad";

/**
 * Los cinco avisos, en los dos grupos en que los lee el streamer.
 *
 * Se guarda el **nombre del texto** y no el texto: los rotulos viven en `i18n`
 * (docs/decisions.md D4) y leerlos al pintar es lo que dejaria traducirlos despues
 * sin tocar esto. Los identificadores siguen siendo los de Rust: aqui solo se
 * reparten, no se inventan ni se dejan fuera.
 */
const GRUPOS: Array<{ rotulo: RotuloGrupo; tipos: TipoAviso[] }> = [
  { rotulo: "grupoRegalos", tipos: ["gift", "gift_grande", "gift_enorme", "follow"] },
  { rotulo: "grupoActividad", tipos: ["subscribe", "share", "like"] },
];

interface Props {
  ajustes: AjustesAlertas;
  /** Nombres de los ficheros del almacén. */
  medios: string[];
  /** Avisos tirados por cola llena. */
  descartados: number;
  /** Dirección del Browser Source de las alertas, con su token. */
  url: string | undefined;
  /**
   * El dispositivo que el monitor de alertas abrió de verdad, y por qué está mudo si
   * lo está. Se enseña lo que pasó, no lo que se pidió: si el elegido ya no está, el
   * motor degrada y hay que poder verlo.
   */
  audioDispositivo: string | null;
  audioProblema: string | null;
  busy: boolean;
  onGuardar: (ajustes: AjustesAlertas) => void;
  onImportarBytes: (nombre: string, bytes: number[]) => void;
  /** Importa varios ficheros —o una carpeta— de golpe. */
  onImportarRutas: (rutas: string[]) => Promise<ImportacionMedios>;
  onBorrarMedio: (nombre: string) => Promise<void>;
  onProbar: (tipo: TipoAviso) => void;
  /** Suena un medio en el monitor, sin encolar ningún aviso. */
  onOir: (nombre: string) => void;
}

export function Alertas({
  ajustes,
  medios,
  descartados,
  url,
  audioDispositivo,
  audioProblema,
  busy,
  onGuardar,
  onImportarBytes,
  onImportarRutas,
  onBorrarMedio,
  onProbar,
  onOir,
}: Props) {
  const [encima, setEncima] = useState(false);
  const [avisoMedio, setAvisoMedio] = useState<string | null>(null);
  /**
   * Lo que pasó en la última importación en lote.
   *
   * Se enseña siempre, aunque haya ido bien: «entraron 12» es la confirmación de
   * que el trabajo está hecho, y con una carpeta de cuarenta ficheros nadie va a
   * contarlos a mano.
   */
  const [resultado, setResultado] = useState<ImportacionMedios | null>(null);
  /**
   * Fallos de miniaturas por nombre: 0 no ha fallado, 1 permite un reintento y 2
   * enseña el placeholder. El primer fallo puede ser la carrera normal entre el
   * arranque del servidor de overlays y el WebView; dejarlo muerto para siempre
   * hacia que la biblioteca pareciera rota hasta desmontar la pestaña.
   */
  const [fallosMiniaturas, setFallosMiniaturas] = useState<Map<string, number>>(
    () => new Map(),
  );

  useEffect(() => {
    // El token y el origen pueden cambiar al reiniciar el servidor. Los fallos de la
    // URL anterior no describen la nueva y no deben conservar un placeholder viejo.
    setFallosMiniaturas(new Map());
  }, [url]);
  /**
   * Lo que se ha escrito en el buscador de medios.
   *
   * Se filtra en cada pintado y sin `useMemo` a propósito: son ciento cincuenta
   * cadenas y el estado se refresca cada segundo, así que la cuenta es despreciable
   * y a cambio no hay que acordarse de meter la lista en las dependencias.
   */
  const [busqueda, setBusqueda] = useState("");
  const [medioPendiente, setMedioPendiente] = useState<string | null>(null);
  const [borrandoMedio, setBorrandoMedio] = useState(false);
  const disparadorBorrado = useRef<HTMLButtonElement | null>(null);
  const selector = useRef<HTMLInputElement | null>(null);
  // La lista de dispositivos es la misma que la del lector de voz: una sola fuente,
  // con el reintento que trae el gancho (antes se preguntaba una sola vez al montar).
  const { dispositivos } = useDispositivosDeAudio();
  /**
   * El aviso que se esta editando.
   *
   * Empieza en el primero de la lista y no en el que este encendido: adivinar cual
   * quiere tocar el streamer es peor que enseñarle siempre el mismo sitio, y el
   * primero es el que mas se usa.
   */
  const [elegido, setElegido] = useState<TipoAviso>(TIPOS_AVISO[0]);
  /**
   * Si el panel abierto es el del **mensaje** en vez del editor del aviso.
   *
   * No es un diálogo a propósito: el panel ocupa el sitio del editor, así que la lista de
   * avisos y —lo que importa— la **previa** siguen a la vista mientras se cambia el
   * estilo. Un diálogo taparía justo lo que hay que mirar.
   */
  const [editandoMensaje, setEditandoMensaje] = useState(false);
  /**
   * El coordinador del audio de prueba.
   *
   * De aquí sale **qué está sonando** —para pintar el botón que suena como
   * interruptor— y por aquí pasan los dos botones que reproducen algo. Ninguna
   * tarjeta toca un `<audio>`: piden, y el coordinador decide.
   */
  const preview = usePreviewAudio();
  const pedirBorrado = useCallback((nombre: string, disparador: HTMLButtonElement) => {
    disparadorBorrado.current = disparador;
    setMedioPendiente(nombre);
  }, []);

  const cancelarBorrado = useCallback(() => {
    if (borrandoMedio || busy) return;
    setMedioPendiente(null);
    disparadorBorrado.current?.focus();
  }, [borrandoMedio, busy]);

  const confirmarBorrado = useCallback(async () => {
    const nombre = medioPendiente;
    if (!nombre || borrandoMedio || busy) return;
    setBorrandoMedio(true);
    try {
      await onBorrarMedio(nombre);
      setMedioPendiente(null);
      disparadorBorrado.current?.focus();
    } finally {
      setBorrandoMedio(false);
    }
  }, [borrandoMedio, busy, medioPendiente, onBorrarMedio]);


  /**
   * Un cambio en un aviso se guarda entero.
   *
   * Entero y no un parche porque son cinco ajustes pequeños: mandar solo el campo
   * tocado obligaría al motor a fusionar, que es donde se cuelan los campos que
   * nadie quería cambiar.
   */
  /**
   * Un cambio en la salida de audio se guarda entero, como los avisos.
   *
   * El dispositivo solo se manda cuando cambia de verdad: el motor reabre el audio
   * al verlo distinto, y mandarlo igual en cada guardado cortaría el sonido.
   */
  const onSalida = useCallback(
    (parche: Partial<SalidaAlertas>) => {
      onGuardar({ ...ajustes, salida: { ...ajustes.salida, ...parche } });
    },
    [ajustes, onGuardar],
  );

  const cambiar = useCallback(
    (tipo: TipoAviso, campo: keyof AjusteAviso, valor: AjusteAviso[keyof AjusteAviso]) => {
      onGuardar({
        ...ajustes,
        [tipo]: { ...ajustes[tipo], [campo]: valor },
      });
    },
    [ajustes, onGuardar],
  );

  /**
   * Varios campos de un aviso, de una vez.
   *
   * Existe por la permanencia: elegir un efecto trae **sus** valores sugeridos, y
   * mandarlos de uno en uno serían cinco viajes al motor construidos todos sobre los
   * mismos ajustes viejos —el segundo pisaría al primero y solo sobreviviría el
   * último—. Un solo guardado con todo dentro.
   */
  const cambiarVarios = useCallback(
    (tipo: TipoAviso, parche: Partial<AjusteAviso>) => {
      onGuardar({
        ...ajustes,
        [tipo]: { ...ajustes[tipo], ...parche },
      });
    },
    [ajustes, onGuardar],
  );

  /**
   * Un cambio del mensaje.
   *
   * Va entero —el objeto del mensaje completo— y no campo a campo: es lo que hace que
   * elegir un estilo pueda traer de una vez su fondo, su radio y su sombra, y que el
   * motor guarde **una** versión coherente en lugar de cinco a medias.
   */
  const cambiarMensaje = useCallback(
    (parche: Partial<MensajeAviso>) => {
      cambiarVarios(elegido, { mensaje: { ...mensajeDe(ajustes[elegido]), ...parche } });
    },
    [ajustes, cambiarVarios, elegido],
  );

  // Arrastrar un fichero a la ventana. Tauri da la **ruta**, que es justo lo que
  // hace falta para copiarlo sin mover decenas de megas por el IPC.
  //
  // Se define **antes** del efecto que lo usa: un `useCallback` no se eleva como una
  // función normal, y llamarlo desde arriba lo dejaría sin asignar en el primer
  // pintado.
  const importarLote = useCallback(
    async (rutas: string[]) => {
      if (rutas.length === 0) return;
      setAvisoMedio(null);
      setResultado(null);
      try {
        setResultado(await onImportarRutas(rutas));
      } catch (cause: unknown) {
        setAvisoMedio(String(cause));
      }
    },
    [onImportarRutas],
  );

  useEffect(() => {
    let cancelar: (() => void) | undefined;
    let cancelado = false;

    // Se importa dentro del `try` porque `@tauri-apps/api/webview` no existe
    // fuera de la aplicación: el banco de la interfaz corre en un navegador y esta
    // página tiene que seguir funcionando allí.
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const quitar = await getCurrentWebview().onDragDropEvent((evento) => {
          if (evento.payload.type === "drop") {
            setEncima(false);
            // Todo de una vez, incluida una **carpeta**: el motor la abre y saca lo
            // que haya dentro. Antes era un comando por fichero, con su refresco del
            // estado cada uno: soltar la carpeta de sonidos entera eran cuarenta
            // viajes de ida y vuelta.
            void importarLote(evento.payload.paths);
          } else if (evento.payload.type === "over" || evento.payload.type === "enter") {
            setEncima(true);
          } else {
            setEncima(false);
          }
        });
        if (cancelado) quitar();
        else cancelar = quitar;
      } catch {
        // Sin arrastre: queda el selector de archivos.
      }
    })();

    return () => {
      cancelado = true;
      cancelar?.();
    };
  }, [importarLote]);

  const elegir = useCallback(
    async (archivo: File | undefined) => {
      setAvisoMedio(null);
      setResultado(null);
      if (!archivo) return;
      if (archivo.size > TOPE_BYTES) {
        setAvisoMedio(t.alertas.demasiadoGrande(Math.round(TOPE_BYTES / (1024 * 1024))));
        return;
      }
      const datos = new Uint8Array(await archivo.arrayBuffer());
      onImportarBytes(archivo.name, Array.from(datos));
    },
    [onImportarBytes],
  );

  /**
   * La dirección de un medio dentro del servidor de overlays.
   *
   * Se arma desde la del Browser Source, que ya trae el token: los medios los sirve
   * el mismo servidor y con la misma credencial, así que no hay una segunda
   * dirección que mantener. Sin dirección —el servidor todavía no ha arrancado— no
   * hay miniatura, y la fila se queda con su nombre.
   */
  const urlMedio = useCallback(
    (nombre: string) => {
      if (!url) return undefined;
      try {
        const base = new URL(url);
        const token = base.searchParams.get("t") ?? "";
        return `${base.origin}/media/${encodeURIComponent(nombre)}?t=${encodeURIComponent(token)}`;
      } catch {
        return undefined;
      }
    },
    [url],
  );

  /** Agrega un intento acotado sin convertir un error transitorio en estado final. */
  const urlMiniatura = useCallback((direccion: string | undefined, intento: number) => {
    if (!direccion || intento < 1) return direccion;
    try {
      const destino = new URL(direccion);
      destino.searchParams.set("reintento", String(intento));
      return destino.toString();
    } catch {
      return direccion;
    }
  }, []);

  /**
   * Una miniatura que no se pudo pintar.
   *
   * Se permite un solo reintento con una URL distinta para sacar de la caché un 404
   * o un fallo de arranque. Si vuelve a fallar se deja el placeholder y se conserva
   * la dirección exacta en la consola: es lo que permite distinguir un fichero que
   * falta, un token inválido o una política del WebView.
   */
  const marcarRota = useCallback((nombre: string, direccion: string | undefined) => {
    console.error(
      `no se pudo cargar la miniatura de «${nombre}»: ${direccion ?? "sin dirección: el servidor de overlays todavía no ha dado su URL"}`,
    );
    setFallosMiniaturas((antes) => {
      const intento = antes.get(nombre) ?? 0;
      if (intento >= 2) return antes;
      const siguiente = new Map(antes);
      siguiente.set(nombre, intento + 1);
      return siguiente;
    });
  }, []);

  /**
   * Los medios que pasan el buscador.
   *
   * Se compara **sin acentos y sin mayúsculas**: los ficheros se llaman como los
   * llamó quien los subió, y buscar «aca» tiene que encontrar «para acá».
   */
  const encontrados = busqueda.trim()
    ? medios.filter((nombre) => normalizar(nombre).includes(normalizar(busqueda.trim())))
    : medios;

  /**
   * Los que se ven —imágenes, GIF y vídeos— y los que suenan, **separados**.
   *
   * Antes había un filtro para elegir entre unos y otros, y un filtro obliga a
   * mirar una cosa o la otra; lo que se hace al montar un aviso es mirar las dos
   * —«¿qué sticker le pongo y qué suena?»—.
   */
  const imagenes = encontrados.filter((nombre) => !suena(nombre));
  const sonidos = encontrados.filter((nombre) => suena(nombre));

  /** El nombre del aviso que se está editando. Lo usan los rótulos de «Poner». */
  const rotuloElegido = t.alertas.tipos[elegido]?.nombre ?? elegido;

  /**
   * Lo que está sonando de prueba, según el coordinador.
   *
   * Se lee aquí y no se lleva en estado propio: el turno es del coordinador —y, por
   * debajo, del motor—, y un espejo local se quedaría diciendo «sonando» cuando el
   * fichero ya se ha acabado.
   */
  const sonando = preview?.actual ?? null;
  /** Si lo que suena es este fichero de la biblioteca. */
  const suenaMedio = (nombre: string) =>
    sonando?.origen === "biblioteca-sonidos" && sonando.id === nombre;
  /** Si lo que suena es la previa del aviso que se está editando. */
  const probando = sonando?.origen === "previa-alerta" && sonando.id === elegido;
  /** La dirección que carga el marco de la previa: la de OBS, pero muda. */
  const urlPrevia = urlDeLaPrevia(url);
  /**
   * El mensaje del aviso elegido, **completo**.
   *
   * Se calcula una vez por foto y no en cada pintado: `mensajeDe` devuelve un objeto
   * nuevo, y `VistaPrevia` manda un mensaje al marco cada vez que cambia el suyo. Con el
   * objeto nuevo en cada pintado, la previa recibiría un aviso por cada repintado de la
   * página sin que nadie hubiera tocado nada.
   */
  const mensajeElegido = useMemo(() => mensajeDe(ajustes[elegido]), [ajustes, elegido]);

  return (
    <div className="grid-panel alertas">
      <p className="hint">{t.alertas.hint}</p>

      {/* La consola: las tres piezas del mismo trabajo, las tres a la vista.
          Los avisos, para saber qué está armado; el editor, para cambiarlo; y la
          previa, para ver lo que sale en antena **mientras** se cambia.

          La previa estuvo detrás de una pestaña —«Medios | Previa»— y ese era el
          error de fondo: aquí se viene a mirar cómo queda un aviso, y la regla del
          proyecto es que el mando y su resultado se vean a la vez
          (`docs/interfaz.md`, regla 3). Una previa que hay que abrir no previsualiza
          nada. */}
      <div className="alertas-consola">
        {/* Sin rotulo de seccion a proposito: los dos encabezados de grupo dicen mas
            —y mas concreto— que un «Avisos» encima, y con el mismo tratamiento los
            dos serian dos rotulos iguales seguidos. `Card` sin `title` no pinta
            cabecera, asi que el contenedor se queda sin la fila del rotulo.

            Tampoco lleva frase de ayuda: la de arriba ya dice qué es esta pantalla y
            que el interruptor enciende sin abrir. Una línea menos es una fila más de
            avisos a la vista. */}
        <Card>
          {/* El nombre del bloque no se pierde aunque no se vea: va de etiqueta del
              grupo, que es lo unico que un encabezado de grupo no puede dar. */}
          <div className="grupos-avisos" role="group" aria-label={t.alertas.lista}>
            {GRUPOS.map((grupo, indice) => (
              <section
                key={grupo.rotulo}
                className="grupo-avisos"
                aria-labelledby={`grupo-aviso-${indice}`}
              >
                {/* En `h2`, no en `h3`: el rotulo de seccion ha desaparecido, asi que
                    este es ahora el primer nivel de la lista y con `h3` se saltaria un
                    escalon (el `h1` de la cabecera y nada en medio). */}
                <h2 className="grupo-rotulo" id={`grupo-aviso-${indice}`}>
                  {t.alertas[grupo.rotulo]}
                </h2>
                <ul className="avisos">
                  {grupo.tipos.map((tipo) => {
                    const ajuste = ajustes[tipo];
                    const rotulo = t.alertas.tipos[tipo];
                    return (
                      <li key={tipo} className={claseDeFila(tipo === elegido, ajuste.activo)}>
                        <button
                          type="button"
                          className="aviso-nombre"
                          aria-current={tipo === elegido ? "true" : undefined}
                          onClick={() => setElegido(tipo)}
                        >
                          {rotulo?.nombre ?? tipo}
                        </button>
                        <label
                          className="switch aviso-interruptor"
                          title={`${rotulo?.nombre ?? tipo} · ${
                            ajuste.activo ? t.alertas.activo : t.alertas.apagado
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={ajuste.activo}
                            disabled={busy}
                            aria-label={rotulo?.nombre ?? tipo}
                            onChange={(evento) => cambiar(tipo, "activo", evento.target.checked)}
                          />
                          {/* La señal del estado: anillo apagado, disco encendido. Forma y
                              color, sin una sola palabra que haya que leer. */}
                          <span className="luz" aria-hidden="true" />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </Card>

        {/* El editor del aviso **o** el del mensaje, en el mismo sitio.
            El del mensaje ocupa esta columna y no una nueva: el ancho que pide un
            formulario es el que ya tiene el editor, y así ni la lista de avisos ni la
            previa se mueven de sitio al abrirlo. */}
        {editandoMensaje ? (
          <PanelMensaje
            aviso={rotuloElegido}
            ajuste={ajustes[elegido]}
            busy={busy}
            onCambiar={cambiarMensaje}
            onCerrar={() => setEditandoMensaje(false)}
          />
        ) : (
          <Aviso
            /* `key` por aviso a proposito: el borrador del texto vive dentro de
               `Aviso`, y sin remontar el componente el del aviso anterior seguiria
               escrito en el campo del nuevo. */
            key={elegido}
            tipo={elegido}
            ajuste={ajustes[elegido]}
            busy={busy}
            onCambiar={cambiar}
            onCambiarVarios={cambiarVarios}
            onOir={onOir}
            sonando={suenaMedio(ajustes[elegido].sonido)}
            onMensaje={() => setEditandoMensaje(true)}
          />
        )}

        {/* **El overlay de verdad**, no una maqueta: es el mismo documento que carga
            OBS, así que lo que se ve aquí es lo que sale en antena.

            **El lienzo es cuadrado.** Lo era 1920×1080 —lo que suele tener la escena
            de OBS— y sobraba sitio por los lados: un aviso se centra y su medio va
            limitado por el **alto** (62 vh), así que en un marco ancho quedaba un
            aviso pequeño nadando entre dos franjas negras. Cuadrado, el mismo aviso
            ocupa la misma **proporción** del marco y no se desperdicia nada. La
            proporción es lo único que la previa puede prometer: el tamaño real lo
            pone la fuente de OBS, que ocupa lo que el streamer le haya dado.

            **Probar y el tamaño viven aquí**, no en el editor, y es a propósito: el
            mando está pegado a lo que cambia. Se mueve el deslizador y el aviso que ya
            está en pantalla cambia de tamaño al momento —`VistaPrevia` se lo manda al
            marco, que es de otro origen—, y al pulsar Probar sale así en OBS. */}
        <Card
          title={t.alertas.previa}
          actions={
            // El botón es un **interruptor**: mientras suena este aviso dice «Parar»,
            // que es lo único que hace falta saber de un vistazo. Suena un audio de
            // prueba a la vez —el coordinador corta el anterior—, así que no puede
            // haber dos botones diciendo «Parar» a la vez.
            <button
              type="button"
              className={probando ? "ghost sonando" : "ghost"}
              aria-pressed={probando}
              title={probando ? t.alertas.pararHint : t.alertas.probarHint}
              disabled={busy}
              onClick={() => onProbar(elegido)}
            >
              {probando ? t.alertas.parar : t.alertas.probar}
            </button>
          }
        >
          {urlPrevia ? (
            <VistaPrevia
              url={urlPrevia}
              ancho={1080}
              alto={1080}
              etiqueta={rotuloElegido}
              nota={t.alertas.previaNota}
              escala={ajustes[elegido].escala}
              /* El mensaje va a la previa **siempre**, no solo cuando su panel está
                 abierto: así el aviso que se está viendo ya lleva el estilo que tiene
                 puesto, en vez de estrenarlo al pulsar Probar. */
              mensaje={mensajeElegido}
            />
          ) : (
            <Empty>{t.alertas.previaSinServidor}</Empty>
          )}

          {/* El mando del tamaño, debajo de lo que cambia. El rótulo lleva la cifra
              —«Tamaño · 90 %»— porque es un ajuste del aviso elegido y hay que poder
              leerlo sin contar los pasos del deslizador. */}
          <div className="previa-tamano">
            <label htmlFor={`escala-${elegido}`} title={t.alertas.tamanoHint}>
              {t.alertas.tamano} · {Math.round(ajustes[elegido].escala * 100)} %
            </label>
            <input
              id={`escala-${elegido}`}
              type="range"
              min={ESCALA_MINIMA}
              max={ESCALA_MAXIMA}
              step={5}
              value={Math.round(ajustes[elegido].escala * 100)}
              disabled={busy}
              title={t.alertas.tamanoHint}
              onChange={(evento) => cambiar(elegido, "escala", Number(evento.target.value) / 100)}
            />
          </div>
        </Card>
      </div>

      {/* La biblioteca, **a todo el ancho**. Estaba en una columna de 370 px, y con
          219 ficheros eso son cinco miniaturas y dos nombres: buscar mirando no es
          buscar. A lo ancho cada zona tiene el sitio que pide su trabajo. */}
      <Card
        title={t.alertas.medios}
        actions={
          medios.length > 0 ? (
            <span className="buscar-cuenta" aria-live="polite">
              {t.alertas.cuenta(encontrados.length, medios.length)}
            </span>
          ) : null
        }
      >
        <div className="biblioteca">
          <div className="bib-alta">
          <div
            className={encima ? "soltar encima" : "soltar"}
            onDragOver={(evento) => evento.preventDefault()}
          >
            <div
              className="soltar-control"
              role="button"
              tabIndex={0}
              aria-label={t.alertas.soltar}
              onClick={() => selector.current?.click()}
              onKeyDown={(evento) => {
                if (evento.key === "Enter" || evento.key === " ") {
                  evento.preventDefault();
                  selector.current?.click();
                }
              }}
            >
              <input
                ref={selector}
                type="file"
                accept={ACEPTADOS}
                hidden
                onChange={(evento) => {
                  void elegir(evento.target.files?.[0]);
                  // Se limpia para poder volver a elegir el mismo fichero.
                  evento.target.value = "";
                }}
              />
              <strong>{t.alertas.soltar}</strong>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => selector.current?.click()}
            >
              {t.alertas.elegir}
            </button>
            {/* La lista de formatos se va al `title`: es un dato que se consulta
                cuando un fichero no entra, no una frase que haya que leer cada vez
                que se abre la pestaña. Aquí queda la versión de una línea. */}
            <p className="hint" title={t.alertas.formatos}>
              {t.alertas.formatosCorto}
            </p>
          </div>
          {avisoMedio ? <p className="empty">{avisoMedio}</p> : null}
          {/* El recuento se enseña aunque haya ido bien: con una carpeta de cuarenta
              ficheros, «entraron 12» es la confirmación de que el trabajo está hecho
              y no hay que contarlos a mano. Los que fallan van uno a uno con su
              motivo: saber **cuál** es lo que evita probarlos de uno en uno. */}
          {resultado ? (
            <p className="empty">
              {t.alertas.importados(resultado.importados)}
              {resultado.fallos.length > 0
                ? ` · ${t.alertas.fallos(resultado.fallos.length)}`
                : ""}
            </p>
          ) : null}
          {resultado && resultado.fallos.length > 0 ? (
            <ul className="fallos">
              {resultado.fallos.map((fallo) => (
                <li key={fallo}>{fallo}</li>
              ))}
            </ul>
          ) : null}

          {/* El buscador, y la lista filtrada por él.
              Con ciento cincuenta ficheros, encontrar «vine boom» bajando a ojo por
              una lista que se desplaza es peor que no tener lista. El recuento vive
              en el rótulo de la tarjeta: decir dos veces cuántos hay es ruido. */}
          {medios.length > 0 ? (
            <div className="buscar">
              <input
                type="search"
                value={busqueda}
                placeholder={t.alertas.buscarPlaceholder}
                spellCheck={false}
                aria-label={t.alertas.buscar}
                onChange={(evento) => setBusqueda(evento.target.value)}
              />
              {busqueda ? (
                <button
                  type="button"
                  className="ghost tiny"
                  aria-label={t.alertas.limpiarBusqueda}
                  title={t.alertas.limpiarBusqueda}
                  onClick={() => setBusqueda("")}
                >
                  {t.alertas.limpiarBusqueda}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {medios.length === 0 ? (
          <p className="empty bib-vacio">{t.alertas.vacio}</p>
        ) : encontrados.length === 0 ? (
          <p className="empty bib-vacio">{t.alertas.sinResultados(busqueda)}</p>
        ) : (
          /* **Dos bloques y no un filtro**: las imágenes a la izquierda, en rejilla,
             y los sonidos a la derecha, en lista. Cada uno con su rótulo, su cuenta y
             su propio scroll, así que ninguno le quita el sitio al otro.

             Un filtro obligaba a elegir entre ver una cosa o la otra; y lo que se
             hace al montar un aviso es justo mirar las dos —«¿qué sticker le pongo
             y qué suena?»—. */
          <>
            <section className="medio-grupo imagenes-grupo">
                <h3 className="grupo-rotulo">
                  {t.alertas.soloImagenes} · {imagenes.length}
                </h3>
                {imagenes.length === 0 ? (
                  <p className="hint">{t.alertas.nadaDeEseTipo}</p>
                ) : (
                  <ul className="galeria">
                    {imagenes.map((nombre) => {
                      const puesto =
                        ajustes[elegido].medio === nombre || ajustes[elegido].sonido === nombre;
                      const intento = fallosMiniaturas.get(nombre) ?? 0;
                      const url = urlMiniatura(urlMedio(nombre), intento);
                      const rota = intento >= 2 || !url;
                      return (
                        <li key={nombre} className={puesto ? "puesto" : undefined}>
                          <button
                            type="button"
                            className="galeria-celda"
                            title={`${nombre} · ${t.alertas.ponerMedio(rotuloElegido)}`}
                            disabled={busy}
                            onClick={() => cambiar(elegido, "medio", nombre)}
                          >
                            {rota ? (
                              <span className="medio-icono">{t.alertas.seVe}</span>
                            ) : esVideo(nombre) ? (
                              <video
                                className="galeria-mini"
                                src={url}
                                muted
                                preload="metadata"
                                onError={() => marcarRota(nombre, url)}
                              />
                            ) : (
                              <img
                                className="galeria-mini"
                                src={url}
                                alt=""
                                loading="lazy"
                                onError={() => marcarRota(nombre, url)}
                              />
                            )}
                            <span className="galeria-nombre">{nombre}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="medio-grupo sonidos-grupo">
                <h3 className="grupo-rotulo">
                  {t.alertas.soloSonidos} · {sonidos.length}
                </h3>
                {sonidos.length === 0 ? (
                  <p className="hint">{t.alertas.nadaDeEseTipo}</p>
                ) : (
                  <ul className="medios">
                    {sonidos.map((nombre) => {
                      const puesto =
                        ajustes[elegido].medio === nombre || ajustes[elegido].sonido === nombre;
                      // Suena **este** fichero: el botón hace de interruptor y la fila
                      // se marca. Es la única señal de que lo que se oye es lo que se
                      // acaba de pulsar cuando la lista es larga.
                      const suenaEste = suenaMedio(nombre);
                      return (
                        <li
                          key={nombre}
                          className={claseDeSonido(puesto, suenaEste) || undefined}
                        >
                          <span className="medio-icono suena">{t.alertas.suena}</span>
                          <span className="medio-nombre" title={nombre}>
                            {nombre}
                          </span>
                          <span className="medio-acciones">
                            <button
                              type="button"
                              className={suenaEste ? "ghost tiny sonando" : "ghost tiny"}
                              aria-pressed={suenaEste}
                              aria-label={`${suenaEste ? t.alertas.parar : t.alertas.oir}: ${nombre}`}
                              title={suenaEste ? t.alertas.pararHint : t.alertas.oirHint}
                              onClick={() => onOir(nombre)}
                            >
                              {suenaEste ? t.alertas.parar : t.alertas.oir}
                            </button>
                            <button
                              type="button"
                              className="ghost tiny"
                              aria-label={`${puesto ? t.alertas.puesto : t.alertas.poner}: ${nombre}`}
                              title={
                                suena(nombre)
                                  ? t.alertas.ponerSonido(rotuloElegido)
                                  : t.alertas.ponerMedio(rotuloElegido)
                              }
                              disabled={busy}
                              onClick={() =>
                                cambiar(elegido, suena(nombre) ? "sonido" : "medio", nombre)
                              }
                            >
                              {puesto ? t.alertas.puesto : t.alertas.poner}
                            </button>
                            <button
                              type="button"
                              className="ghost tiny"
                              aria-label={`${t.alertas.borrar}: ${nombre}`}
                              title={t.alertas.borrarHint}
                              disabled={busy}
                              onClick={(evento) => pedirBorrado(nombre, evento.currentTarget)}
                            >
                              {t.alertas.borrar}
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
          </>
        )}
        </div>
      </Card>

      {/* La salida de audio y la direccion de OBS: lo que se toca **una vez**, al
          montar la escena.

          Ocupaban dos tarjetas de media pantalla con mas hueco que contenido, y ese
          hueco salia de donde no sobraba: de la biblioteca y de la lista de avisos.
          Ahora son una tira de una linea cada una. El aviso de avisos descartados se
          queda aqui porque es lo unico vivo de las dos y habla de la cola de OBS. */}
      <div className="alertas-tira">
        <Card>
          <div className="tira-linea">
            <span className="tira-rotulo">{t.alertas.salida}</span>
            <select
              id="salida-dispositivo"
              aria-label={t.alertas.salidaDispositivo}
              title={t.alertas.salidaHint}
              value={ajustes.salida.dispositivo}
              disabled={busy}
              onChange={(evento) => onSalida({ dispositivo: evento.target.value })}
            >
              <option value="">{t.alertas.salidaSistema}</option>
              {/* El elegido puede no estar en la lista —un cable desconectado— y sin esta
                  opción el desplegable se quedaría en blanco sin decir por qué. */}
              {ajustes.salida.dispositivo && !dispositivos.includes(ajustes.salida.dispositivo) ? (
                <option value={ajustes.salida.dispositivo}>
                  {t.alertas.salidaNoDisponible(ajustes.salida.dispositivo)}
                </option>
              ) : null}
              {dispositivos.map((nombre) => (
                <option key={nombre} value={nombre}>
                  {nombre}
                </option>
              ))}
            </select>

            {/* El volumen, con su cifra al lado y no encima: en una línea, un rótulo
                encima del mando lo convertiría en dos. */}
            <label className="tira-mando" htmlFor="salida-volumen">
              <span className="tira-etiqueta">{t.alertas.salidaVolumen}</span>
              <input
                id="salida-volumen"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(ajustes.salida.volumen * 100)}
                disabled={busy}
                onChange={(evento) => onSalida({ volumen: Number(evento.target.value) / 100 })}
              />
              <span className="tira-cifra">{Math.round(ajustes.salida.volumen * 100)} %</span>
            </label>

            <label className="switch tira-switch" title={t.alertas.salidaEnDirectoHint}>
              <input
                type="checkbox"
                checked={ajustes.salida.en_directo}
                disabled={busy}
                onChange={(evento) => onSalida({ en_directo: evento.target.checked })}
              />
              <span>{t.alertas.salidaEnDirecto}</span>
            </label>

            {/* El estado, al final y en una línea: es la confirmación de que el
                dispositivo elegido está sonando de verdad. */}
            <span
              className={audioProblema ? "tira-estado malo" : "tira-estado"}
              title={t.alertas.salidaHint}
            >
              {audioProblema
                ? t.alertas.salidaMuda(audioProblema)
                : audioDispositivo
                  ? t.alertas.salidaActiva(audioDispositivo)
                  : t.alertas.salidaSistemaActivo}
            </span>
          </div>
        </Card>

        <Card>
          <div className="tira-linea" title={t.alertas.direccionHint}>
            <span className="tira-rotulo">{t.alertas.direccion}</span>
            <Copiar texto={url} />
            {descartados > 0 ? (
              <span className="tira-estado malo">{t.alertas.descartados(descartados)}</span>
            ) : null}
          </div>
        </Card>
      </div>

      <DialogoConfirmacion
        abierto={medioPendiente !== null}
        titulo={t.alertas.borrarTitulo}
        mensaje={
          <>
            {t.alertas.borrarConfirmacion} <strong title={medioPendiente ?? undefined}>{medioPendiente}</strong>
          </>
        }
        confirmar={t.alertas.borrar}
        cancelar={t.alertas.cancelar}
        ocupado={borrandoMedio || busy}
        onConfirmar={() => void confirmarBorrado()}
        onCancelar={cancelarBorrado}
      />
    </div>
  );
}

/** Las clases de una fila de la lista: la elegida y la que esta encendida. */
function claseDeFila(elegida: boolean, activa: boolean): string {
  return ["aviso", elegida ? "elegido" : "", activa ? "" : "apagado"]
    .filter((parte) => parte.length > 0)
    .join(" ");
}

/**
 * Las clases de una fila de sonido.
 *
 * `puesto` y `suena` son dos cosas distintas y pueden darse a la vez: la fila puede
 * ser el sonido del aviso elegido **y** estar sonando ahora mismo. Van separadas
 * porque significan cosas distintas —una es «lo que sonará en antena», la otra «lo
 * que estás oyendo tú ahora»—, y con una sola clase no se podrían distinguir.
 */
function claseDeSonido(puesto: boolean, suena: boolean): string {
  return [puesto ? "puesto" : "", suena ? "sonando" : ""]
    .filter((parte) => parte.length > 0)
    .join(" ");
}

/**
 * El editor de **un** aviso: el que se acaba de elegir en la lista.
 *
 * Se conserva tal cual la tarjeta de antes —los mismos campos, el mismo guardado—,
 * porque el unico problema era que hubiera cinco a la vez. Lo unico que cambia es
 * que el interruptor se ha ido a la lista: mando y señal juntos, y el mismo estado
 * en un solo sitio.
 */
function Aviso({
  tipo,
  ajuste,
  busy,
  sonando,
  onCambiar,
  onCambiarVarios,
  onOir,
  onMensaje,
}: {
  tipo: TipoAviso;
  ajuste: AjusteAviso;
  busy: boolean;
  /** Si el sonido de este aviso es el que está sonando ahora mismo. */
  sonando: boolean;
  onCambiar: (tipo: TipoAviso, campo: keyof AjusteAviso, valor: AjusteAviso[keyof AjusteAviso]) => void;
  onCambiarVarios: (tipo: TipoAviso, parche: Partial<AjusteAviso>) => void;
  onOir: (nombre: string) => void;
  /** Abre el panel del contenedor del mensaje. */
  onMensaje: () => void;
}) {
  const rotulo = t.alertas.tipos[tipo];
  // El mínimo vale para los tres tramos de regalo y para los likes: un follow o un
  // share no traen cantidad con la que filtrar.
  const admiteMinimo =
    tipo === "gift" || tipo === "gift_grande" || tipo === "gift_enorme" || tipo === "like";

  /**
   * El texto se edita en local y se guarda al salir del campo.
   *
   * No se guarda en cada tecla —sería una escritura por letra— y tampoco se
   * rellena desde las props en cada cambio: la aplicación recibe fotos del motor
   * a menudo y el campo se vaciaría mientras se escribe.
   */
  const [texto, setTexto] = useState(ajuste.texto);
  const enviado = useRef(ajuste.texto);

  const confirmarTexto = useCallback(() => {
    if (texto === enviado.current) return;
    enviado.current = texto;
    onCambiar(tipo, "texto", texto);
  }, [onCambiar, texto, tipo]);

  return (
    <Card title={rotulo?.nombre ?? tipo} nota={rotulo?.descripcion}>

      <div className="campo">
        {/* El rótulo y el botón del mensaje, en la **misma línea**: el botón no cuesta
            alto —la línea del rótulo ya estaba— y queda pegado a lo que formatea, que es
            el texto de abajo. Y lleva el estilo puesto, así que se sabe cómo está el
            mensaje sin abrir nada. */}
        <div className="campo-cabeza">
          <label htmlFor={`texto-${tipo}`}>{t.alertas.texto}</label>
          <button
            type="button"
            className="ghost tiny"
            disabled={busy}
            title={t.mensaje.botonHint}
            onClick={onMensaje}
          >
            {rotuloMensaje(mensajeDe(ajuste).estilo)}
          </button>
        </div>
        <input
          id={`texto-${tipo}`}
          value={texto}
          maxLength={TEXTO_MAXIMO}
          disabled={busy}
          spellCheck={false}
          onChange={(evento) => setTexto(evento.target.value)}
          onBlur={confirmarTexto}
          onKeyDown={(evento) => {
            // `isComposing` vive en el evento **nativo**: el sintético de React no
            // lo expone. Sin esta comprobación, escribir con un teclado que compone
            // (japonés, coreano, y también los acentos de algunos IME) cerraría el
            // editor al confirmar el primer carácter.
            if (evento.key === "Enter" && !evento.nativeEvent.isComposing) confirmarTexto();
          }}
        />
        <Plantilla texto={texto} />
        <p className="hint">
          {t.alertas.variables}: {variablesDe(tipo).map((v) => `{${v}}`).join(" ")}
        </p>
      </div>

      {/* Dos pares de campos, cada uno en su fila y **siempre a dos columnas**.
          No se usa `.grid-columns` porque esa rejilla es `auto-fit` y con el ancho
          que tiene el editor por dentro (640 px) daba **una** sola columna: los
          campos se apilaban, la tarjeta pasaba de 382 a 533 px de alto y su fila
          solo le daba 379, así que el marco le recortaba 154. Un par de campos que
          se leen juntos no debe replegarse. */}
      <div className="campos-par">
        {/* Lo que tiene puesto, en una línea, y **no un desplegable**: los mismos
            ficheros ya están en la lista de medios, y repetirlos aquí dentro era
            tener dos listas de lo mismo —con ciento cincuenta nombres en cada una—.
            Se elige allí, con su buscador; aquí solo se ve qué hay puesto y se
            quita. */}
        <div className="campo">
          {/* La regla del audio va en el **rótulo** y no en una línea aparte: el
              editor mide 379 px y una línea más lo sacaba del marco por 6. Aquí no
              ocupa alto y se lee igual. */}
          <label htmlFor={`medio-${tipo}`}>
            {t.alertas.medio} · {t.alertas.videoMudo}
          </label>
          <div className="asignado" id={`medio-${tipo}`}>
            <span className={ajuste.medio ? "asignado-nombre" : "asignado-nombre vacio"}>
              {ajuste.medio || t.alertas.sinMedio}
            </span>
            {ajuste.medio ? (
              <button
                type="button"
                className="ghost tiny"
                title={t.alertas.quitarHint}
                disabled={busy}
                onClick={() => onCambiar(tipo, "medio", "")}
              >
                {t.alertas.quitar}
              </button>
            ) : null}
          </div>
        </div>

        <div className="campo">
          <label htmlFor={`sonido-${tipo}`}>{t.alertas.sonido}</label>
          <div className="asignado" id={`sonido-${tipo}`}>
            <span className={ajuste.sonido ? "asignado-nombre" : "asignado-nombre vacio"}>
              {ajuste.sonido || t.alertas.sinSonido}
            </span>
            {/* Oír, al lado de lo que está puesto: elegir un sonido de una lista de
                nombres no dice cómo suena, y había que probar la alerta entera
                —con su texto y su medio— para averiguarlo. Mientras suena, el botón
                dice «Parar»: es el mismo sonido pulsado dos veces. */}
            {ajuste.sonido ? (
              <>
                <button
                  type="button"
                  className={sonando ? "ghost tiny sonando" : "ghost tiny"}
                  aria-pressed={sonando}
                  title={sonando ? t.alertas.pararHint : t.alertas.oirHint}
                  onClick={() => onOir(ajuste.sonido)}
                >
                  {sonando ? t.alertas.parar : t.alertas.oir}
                </button>
                <button
                  type="button"
                  className="ghost tiny"
                  title={t.alertas.quitarHint}
                  disabled={busy}
                  onClick={() => onCambiar(tipo, "sonido", "")}
                >
                  {t.alertas.quitar}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Los mandos del aviso: cuánto se queda, cuánto suena y a partir de cuánto
          dispara. En **dos columnas**, o en tres cuando el aviso admite mínimo.

          El mínimo ocupaba una fila entera para un número de tres cifras, y esa fila es
          justo la que paga la animación: el editor mide 376 px de contenido y su fila le
          da 352, así que el marco le recortaba 24 px por abajo —en silencio, que es como
          recorta—. En vez de apretar el aire entre los campos, que es lo que se lee, se
          aprovecha el ancho que sobraba.

          El del **tamaño** no está aquí: se fue a la previa, que es donde se ve lo que
          cambia. */}
      <div className={admiteMinimo ? "campos-par campos-par-tres" : "campos-par"}>
        <div className="campo">
          <label htmlFor={`duracion-${tipo}`}>
            {t.alertas.duracion} · {(ajuste.duracion_ms / 1000).toFixed(1)} s
          </label>
          <input
            id={`duracion-${tipo}`}
            type="range"
            min={DURACION_MINIMA_MS}
            max={DURACION_MAXIMA_MS}
            step={500}
            value={ajuste.duracion_ms}
            disabled={busy}
            onChange={(evento) => onCambiar(tipo, "duracion_ms", Number(evento.target.value))}
          />
        </div>

        <div className="campo">
          <label htmlFor={`volumen-${tipo}`}>
            {t.alertas.volumen} · {Math.round(ajuste.volumen * 100)} %
          </label>
          <input
            id={`volumen-${tipo}`}
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(ajuste.volumen * 100)}
            disabled={busy}
            onChange={(evento) => onCambiar(tipo, "volumen", Number(evento.target.value) / 100)}
          />
        </div>

        {/* Solo donde tiene sentido: un follow no trae cantidad con la que filtrar, y un
            campo que no hace nada es peor que no tenerlo. */}
        {admiteMinimo ? (
          <div className="campo">
            <label htmlFor={`minimo-${tipo}`}>
              {t.alertas.minimo} ·{" "}
              {/* En un tramo de regalo el mínimo **no filtra: es la frontera**. Por
                  debajo de él, el regalo cae al tramo de abajo, así que el rótulo
                  tiene que decir eso y no «solo a partir de», que suena a descarte. */}
              {tipo === "like"
                ? t.alertas.minimoLike
                : tipo === "gift"
                  ? t.alertas.minimoGift
                  : t.alertas.minimoTramo}
            </label>
            <input
              id={`minimo-${tipo}`}
              type="number"
              min={0}
              max={100_000}
              value={ajuste.minimo}
              disabled={busy}
              onChange={(evento) =>
                onCambiar(tipo, "minimo", Math.max(0, Number(evento.target.value) || 0))
              }
            />
          </div>
        ) : null}
      </div>

      {/* La animación, en **una línea**: cómo entra, cuánto tarda, cómo sale, cuánto
          tarda y a qué ritmo.

          Va en una sola fila con el rótulo al lado —como la tira de abajo— porque son
          cinco mandos cortos. Repartidos en dos filas de campos costaban 86 px de alto,
          y ese alto sale de la biblioteca, que es la que peor está: el editor ya mide
          351 px y su fila le da 355. */}
      <div className="animacion-linea">
        <span className="tira-rotulo" title={t.alertas.animacionHint}>
          {t.alertas.animacion}
        </span>

        <span className="animacion-etiqueta">{t.alertas.entra}</span>
        <select
          value={ajuste.animacion_entrada}
          disabled={busy}
          aria-label={t.alertas.animacionEntrada}
          title={t.alertas.animacionEntrada}
          onChange={(evento) => onCambiar(tipo, "animacion_entrada", evento.target.value)}
        >
          {ANIMACIONES.map((id) => (
            <option key={id} value={id}>
              {nombreAnimacion(id, "entrada")}
            </option>
          ))}
        </select>
        <input
          type="number"
          className="animacion-ms"
          min={ANIMACION_MINIMA_S}
          max={ANIMACION_MAXIMA_S}
          step={0.05}
          value={enSegundos(ajuste.entrada_ms)}
          disabled={busy}
          aria-label={t.alertas.entradaMs}
          title={t.alertas.entradaMs}
          onChange={(evento) =>
            onCambiar(tipo, "entrada_ms", enMilisegundos(evento.target.value))
          }
        />

        <span className="animacion-etiqueta">{t.alertas.sale}</span>
        <select
          value={ajuste.animacion_salida}
          disabled={busy}
          aria-label={t.alertas.animacionSalida}
          title={t.alertas.animacionSalida}
          onChange={(evento) => onCambiar(tipo, "animacion_salida", evento.target.value)}
        >
          {ANIMACIONES.map((id) => (
            <option key={id} value={id}>
              {nombreAnimacion(id, "salida")}
            </option>
          ))}
        </select>
        <input
          type="number"
          className="animacion-ms"
          min={ANIMACION_MINIMA_S}
          max={ANIMACION_MAXIMA_S}
          step={0.05}
          value={enSegundos(ajuste.salida_ms)}
          disabled={busy}
          aria-label={t.alertas.salidaMs}
          title={t.alertas.salidaMs}
          onChange={(evento) =>
            onCambiar(tipo, "salida_ms", enMilisegundos(evento.target.value))
          }
        />

        {/* El ritmo no lleva rótulo: sus opciones ya se explican solas —«Automático»,
            «Con rebote», «Frenando»— y el hueco que ahorra se lo quedan los dos
            desplegables de las animaciones, que sí tienen nombres largos. */}
        <select
          value={ajuste.ritmo}
          disabled={busy}
          aria-label={t.alertas.ritmo}
          title={t.alertas.ritmoHint}
          onChange={(evento) => onCambiar(tipo, "ritmo", evento.target.value)}
        >
          {RITMOS.map((ritmo) => (
            <option key={ritmo.id} value={ritmo.id}>
              {ritmo.nombre}
            </option>
          ))}
        </select>
      </div>

      {/* La permanencia: lo que hace la alerta **mientras está en pantalla**, ya
          entrada y antes de salir.

          Va en su propia línea porque cada efecto trae sus propios mandos —flotar pide
          distancia y velocidad; el resplandor pide color, intensidad, difuminado y
          modo— y solo se pintan los del elegido. La línea **envuelve** cuando el efecto
          tiene muchos: con cinco mandos no caben en un renglón, y reservar dos filas
          fijas costaría alto en todos los efectos para que lo aproveche uno. */}
      <div className="permanencia-linea">
        <span className="tira-rotulo" title={t.alertas.permanenciaHint}>
          {t.alertas.permanencia}
        </span>

        <select
          className="permanencia-efecto"
          value={ajuste.idle}
          disabled={busy}
          aria-label={t.alertas.permanencia}
          title={t.alertas.permanenciaHint}
          onChange={(evento) => onCambiarVarios(tipo, parcheDePermanencia(evento.target.value))}
        >
          {PERMANENCIAS.map((efecto) => (
            <option key={efecto.id} value={efecto.id}>
              {efecto.nombre}
            </option>
          ))}
        </select>

        {efectoPermanencia(ajuste.idle)?.parametros.map((parametro) => (
          <label className="permanencia-mando" key={parametro.campo}>
            <span className="animacion-etiqueta">
              {/* La unidad va en el rótulo y no detrás del campo: pegada al número
                  parece parte de él, y en un renglón con cinco mandos el hueco que
                  ahorra es justo el que deja entrar al último. */}
              {parametro.etiqueta}
              {parametro.unidad ? ` ${parametro.unidad}` : ""}
            </span>
            {parametro.tipo === "modo" ? (
              <select
                value={String(ajuste[parametro.campo])}
                disabled={busy}
                aria-label={parametro.etiqueta}
                onChange={(evento) => aplicarParametro(parametro, evento.target.value)}
              >
                {(parametro.opciones ?? []).map((opcion) => (
                  <option key={opcion.valor} value={opcion.valor}>
                    {opcion.nombre}
                  </option>
                ))}
              </select>
            ) : parametro.tipo === "color" ? (
              <input
                type="color"
                className="permanencia-color"
                value={String(ajuste[parametro.campo])}
                disabled={busy}
                aria-label={parametro.etiqueta}
                onChange={(evento) => aplicarParametro(parametro, evento.target.value)}
              />
            ) : (
              <input
                type="number"
                className="animacion-ms"
                min={parametro.min}
                max={parametro.max}
                step={parametro.paso}
                value={valorDeParametro(parametro)}
                disabled={busy}
                aria-label={parametro.etiqueta}
                onChange={(evento) => aplicarParametro(parametro, evento.target.value)}
              />
            )}
          </label>
        ))}
      </div>
    </Card>
  );

  /** Lo que se enseña en el campo: los tiempos, en segundos. */
  function valorDeParametro(parametro: ParametroPermanencia): number | string {
    const bruto = ajuste[parametro.campo];
    if (parametro.tipo !== "numero") return String(bruto);
    const numero = Number(bruto);
    return parametro.unidad === "s" ? enSegundos(numero) : numero;
  }

  /** Un mando tocado: se guarda en las unidades del motor y con sus topes. */
  function aplicarParametro(parametro: ParametroPermanencia, bruto: string) {
    if (parametro.tipo !== "numero") {
      onCambiar(tipo, parametro.campo, bruto);
      return;
    }
    const numero = Number(bruto);
    const conTope = Number.isFinite(numero) ? numero : Number(parametro.sugerido);
    const limitado = Math.min(
      Number(parametro.max ?? 1000),
      Math.max(Number(parametro.min ?? 0), conTope),
    );
    onCambiar(
      tipo,
      parametro.campo,
      parametro.unidad === "s" ? Math.round(limitado * 1000) : Math.round(limitado),
    );
  }
}

/**
 * Lo que hay que guardar al elegir un efecto de permanencia: el efecto **y sus valores
 * sugeridos**.
 *
 * Se aplican al elegirlo y no antes, porque son un punto de partida: cada efecto tiene
 * los suyos —flotar 8 px y 2,5 s; agitar 2 px, 0,5 s y uno cada 2 s— y arrastrar los del
 * anterior dejaria, por ejemplo, un temblor de 8 px donde el encargo pide 2. En cuanto
 * el streamer toca un mando, manda el suyo.
 */
function parcheDePermanencia(id: string): Partial<AjusteAviso> {
  const parche: Record<string, string | number> = { idle: id };
  for (const parametro of efectoPermanencia(id)?.parametros ?? []) {
    parche[parametro.campo] =
      parametro.unidad === "s"
        ? Math.round(Number(parametro.sugerido) * 1000)
        : parametro.sugerido;
  }
  return parche as Partial<AjusteAviso>;
}

/**
 * La plantilla con sus variables a la vista.
 *
 * Se resalta **lo que hay escrito**, no la frase final: rellenar las variables es
 * trabajo de Rust (`alerts::componer`), y componerla tambien aqui seria una segunda
 * fuente de verdad que mentiria en cuanto cambiara la primera. En esta fase solo se
 * marca; el ejemplo compuesto lo anadira el motor.
 */
function Plantilla({ texto }: { texto: string }) {
  if (texto.length === 0) return null;
  return (
    <p className="plantilla">
      {partesDe(texto).map((parte, indice) =>
        parte.variable ? (
          <mark key={indice} className="variable">
            {parte.texto}
          </mark>
        ) : (
          <span key={indice}>{parte.texto}</span>
        ),
      )}
    </p>
  );
}

/** Parte la plantilla en texto suelto y variables, para poder resaltar estas. */
function partesDe(plantilla: string): Array<{ texto: string; variable: boolean }> {
  return (
    plantilla
      // El grupo de captura es lo que hace que `split` conserve la variable en el
      // resultado en vez de tirarla.
      .split(/(\{[^{}]*\})/g)
      .filter((trozo) => trozo.length > 0)
      .map((trozo) => ({
        texto: trozo,
        variable: trozo.startsWith("{") && trozo.endsWith("}"),
      }))
  );
}

/** Las variables que acepta la plantilla de cada tipo. */
function variablesDe(tipo: TipoAviso): string[] {
  switch (tipo) {
    case "gift":
      return ["usuario", "regalo", "cantidad", "diamantes"];
    case "subscribe":
      return ["usuario", "meses", "meses_texto"];
    case "like":
      return ["usuario", "likes"];
    default:
      return ["usuario"];
  }
}
