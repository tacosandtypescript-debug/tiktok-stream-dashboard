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

import { useCallback, useEffect, useRef, useState } from "react";

import {
  TIPOS_AVISO,
  api,
  type AjusteAviso,
  type AjustesAlertas,
  type ImportacionMedios,
  type SalidaAlertas,
  type TipoAviso,
} from "../api";
import { Card, Copiar, Empty, VistaPrevia } from "../components";
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
  onBorrarMedio: (nombre: string) => void;
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
   * Las miniaturas que no cargaron.
   *
   * Se recuerda el fallo para no volver a pedirlas en cada pintado: sin esto, un
   * fichero que ya no está se reintentaría cada segundo y la consola se llenaría de
   * errores de red.
   */
  const [rotas, setRotas] = useState<Set<string>>(() => new Set());
  /**
   * Lo que se ha escrito en el buscador de medios.
   *
   * Se filtra en cada pintado y sin `useMemo` a propósito: son ciento cincuenta
   * cadenas y el estado se refresca cada segundo, así que la cuenta es despreciable
   * y a cambio no hay que acordarse de meter la lista en las dependencias.
   */
  const [busqueda, setBusqueda] = useState("");
  /**
   * Qué enseña la tercera columna: los medios cargados o la previa del aviso.
   *
   * Dos modos y no dos tarjetas porque la página mide 674 px y está llena: la previa
   * es lo que se mira antes de dar un aviso por bueno, y los medios lo que se mira
   * mientras se elige. No hacen falta a la vez.
   */
  const [modo, setModo] = useState<"medios" | "previa">("medios");
  const selector = useRef<HTMLInputElement | null>(null);
  // La lista de dispositivos es la misma que la del lector de voz: una sola fuente.
  const [dispositivos, setDispositivos] = useState<string[]>([]);
  /**
   * El aviso que se esta editando.
   *
   * Empieza en el primero de la lista y no en el que este encendido: adivinar cual
   * quiere tocar el streamer es peor que enseñarle siempre el mismo sitio, y el
   * primero es el que mas se usa.
   */
  const [elegido, setElegido] = useState<TipoAviso>(TIPOS_AVISO[0]);

  useEffect(() => {
    let vivo = true;
    void api
      .ttsDevices()
      .then((lista) => {
        // Se comprueba que sea una lista y no se da por hecho: si el motor contesta
        // otra cosa —o nada, como en el banco de la interfaz—, `dispositivos.map`
        // reventaria la pagina entera. Un desplegable vacio es un problema; una
        // pantalla en blanco es otro mucho peor.
        if (vivo) setDispositivos(Array.isArray(lista) ? lista : []);
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);

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

  return (
    <div className="grid-panel alertas">      <p className="hint">{t.alertas.hint}</p>

      {/* Primero lo que se configura —la lista y su editor— y despues el resto: los
          ficheros con los que se configura, donde se oye y, al final, la direccion
          de OBS, que se copia una vez al montar la escena. Con la direccion y los
          medios delante, los dos grupos de avisos caian bajo el pliegue y la
          pantalla parecia no tener lista. */}
      <div className="alertas-panel">
        {/* Sin rotulo de seccion a proposito: los dos encabezados de grupo dicen mas
            —y mas concreto— que un «Avisos» encima, y con el mismo tratamiento los
            dos serian dos rotulos iguales seguidos. `Card` sin `title` no pinta
            cabecera, asi que el contenedor se queda sin la fila del rotulo. */}
        <Card>
          <p className="hint">{t.alertas.listaHint}</p>
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

        <Aviso
          /* `key` por aviso a proposito: el borrador del texto vive dentro de
             `Aviso`, y sin remontar el componente el del aviso anterior seguiria
             escrito en el campo del nuevo. */
          key={elegido}
          tipo={elegido}
          ajuste={ajustes[elegido]}
          busy={busy}
          onCambiar={cambiar}
          onProbar={onProbar}
          onOir={onOir}
        />

        {/* Los medios, en la misma fila que la lista y el editor: es la tercera
            pieza del mismo trabajo —elegir el aviso, escribirlo y darle su medio—,
            y con ellos en una fila propia la pagina medía 1.121 px para 674 de
            alto. Aqui cabe. */}
        <Card
          title={modo === "previa" ? t.alertas.previa : t.alertas.medios}
          actions={
            // Dos modos en la misma columna y no una tarjeta más: la página mide
            // 674 px y está llena. La previa es lo que se mira **antes** de dar por
            // bueno un aviso; los medios, lo que se mira mientras se elige, así que
            // no hacen falta a la vez.
            <div className="vista-switch">
              <button
                type="button"
                role="tab"
                aria-selected={modo === "medios"}
                className={modo === "medios" ? "active" : "ghost"}
                onClick={() => setModo("medios")}
              >
                {t.alertas.mediosCorto}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={modo === "previa"}
                className={modo === "previa" ? "active" : "ghost"}
                onClick={() => setModo("previa")}
              >
                {t.alertas.previaCorto}
              </button>
            </div>
          }
        >
          {modo === "previa" ? (
            <>
              {/* **El overlay de verdad**, no una maqueta: es el mismo documento que
                  carga OBS, así que lo que se ve aquí es lo que sale en antena. Dale a
                  Probar en el editor y sale en esta previa.

                  El lienzo que se le supone son 1920×1080, que es lo que suele tener
                  la escena de OBS: es lo único que se puede suponer, porque la página
                  ocupa lo que le dé la fuente. */}
              {url ? (
                <VistaPrevia
                  url={url}
                  ancho={1920}
                  alto={1080}
                  etiqueta={t.alertas.previa}
                  nota={t.alertas.previaNota}
                />
              ) : (
                <Empty>{t.alertas.previaSinServidor}</Empty>
              )}
              <p className="hint">{t.alertas.previaHint}</p>
            </>
          ) : (
            <>
          <p className="hint">{t.alertas.mediosHint}</p>
          <div
            className={encima ? "soltar encima" : "soltar"}
            onClick={() => selector.current?.click()}
            onDragOver={(evento) => evento.preventDefault()}
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
            <button
              type="button"
              className="ghost"
              onClick={(evento) => {
                evento.stopPropagation();
                selector.current?.click();
              }}
            >
              {t.alertas.elegir}
            </button>
            <p className="hint">{t.alertas.formatos}</p>
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
              una lista que se desplaza es peor que no tener lista. */}
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
            </div>
          ) : null}

          {medios.length === 0 ? (
            <Empty>{t.alertas.vacio}</Empty>
          ) : encontrados.length === 0 ? (
            <Empty>{t.alertas.sinResultados(busqueda)}</Empty>
          ) : (
            /* **Dos bloques y no un filtro**: las imágenes arriba, en rejilla, y los
               sonidos debajo, en lista. Cada uno con su rótulo, su cuenta y su propio
               scroll, así que ninguno le quita el sitio al otro.

               Un filtro obligaba a elegir entre ver una cosa o la otra; y lo que se
               hace al montar un aviso es justo mirar las dos —«¿qué sticker le pongo
               y qué suena?»—. */
            <>
              <section className="medio-grupo">
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
                      const url = urlMedio(nombre);
                      const rota = rotas.has(nombre) || !url;
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
                                onError={() => setRotas((antes) => new Set(antes).add(nombre))}
                              />
                            ) : (
                              <img
                                className="galeria-mini"
                                src={url}
                                alt=""
                                loading="lazy"
                                onError={() => setRotas((antes) => new Set(antes).add(nombre))}
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

              <section className="medio-grupo">
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
                      return (
                        <li key={nombre} className={puesto ? "puesto" : undefined}>
                          <span className="medio-icono suena">{t.alertas.suena}</span>
                          <span className="medio-nombre" title={nombre}>
                            {nombre}
                          </span>
                          <button
                            type="button"
                            className="ghost tiny"
                            title={t.alertas.oirHint}
                            onClick={() => onOir(nombre)}
                          >
                            {t.alertas.oir}
                          </button>
                          <button
                            type="button"
                            className="ghost tiny"
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
                            className="ghost"
                            title={t.alertas.borrarHint}
                            disabled={busy}
                            onClick={() => onBorrarMedio(nombre)}
                          >
                            {t.alertas.borrar}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
            </>
          )}
        </Card>
      </div>

      {/* La salida de audio y la direccion de OBS, en la fila de abajo. Son las dos
          piezas que se tocan una vez —al montar la escena— y no se vuelven a mirar,
          asi que van juntas y **sin envoltorio**: la propia rejilla de la pagina las
          coloca en las dos columnas de su ultima fila (`styles.css`,
          `.grid-panel.alertas`). Un `div` de mas solo añadiria un nivel. */}

      <Card title={t.alertas.salida}>
        <p className="hint">{t.alertas.salidaHint}</p>

        <div className="campo">
          <label htmlFor="salida-dispositivo">{t.alertas.salidaDispositivo}</label>
          <select
            id="salida-dispositivo"
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
        </div>

        <div className="campo">
          <label htmlFor="salida-volumen">
            {t.alertas.salidaVolumen} · {Math.round(ajustes.salida.volumen * 100)} %
          </label>
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
        </div>

        <label className="switch" title={t.alertas.salidaEnDirectoHint}>
          <input
            type="checkbox"
            checked={ajustes.salida.en_directo}
            disabled={busy}
            onChange={(evento) => onSalida({ en_directo: evento.target.checked })}
          />
          <span>{t.alertas.salidaEnDirecto}</span>
        </label>

        <p className="hint">
          {audioProblema
            ? t.alertas.salidaMuda(audioProblema)
            : audioDispositivo
              ? t.alertas.salidaActiva(audioDispositivo)
              : t.alertas.salidaSistemaActivo}
        </p>
      </Card>

      {/* La direccion para OBS, al final: es fontaneria de puesta en marcha —se copia
          una vez al montar la escena y no se vuelve—, y con ella viaja el aviso de
          avisos descartados, que es lo unico vivo que queda aqui. */}
      <Card title={t.alertas.direccion}>
        <ul className="direcciones">
          <li>
            <span className="direccion-vista">{t.alertas.title}</span>
            <Copiar texto={url} />
          </li>
        </ul>
        <p className="hint">{t.alertas.direccionHint}</p>
        {descartados > 0 ? (
          <p className="hint">{t.alertas.descartados(descartados)}</p>
        ) : null}
      </Card>
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
  onCambiar,
  onProbar,
  onOir,
}: {
  tipo: TipoAviso;
  ajuste: AjusteAviso;
  busy: boolean;
  onCambiar: (tipo: TipoAviso, campo: keyof AjusteAviso, valor: AjusteAviso[keyof AjusteAviso]) => void;
  onProbar: (tipo: TipoAviso) => void;
  onOir: (nombre: string) => void;
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
    <Card
      title={rotulo?.nombre ?? tipo}
      actions={
        <button
          type="button"
          className="ghost"
          title={t.alertas.probarHint}
          disabled={busy}
          onClick={() => onProbar(tipo)}
        >
          {t.alertas.probar}
        </button>
      }
    >
      <p className="hint">{rotulo?.descripcion}</p>

      <div className="campo">
        <label htmlFor={`texto-${tipo}`}>{t.alertas.texto}</label>
        <input
          id={`texto-${tipo}`}
          value={texto}
          maxLength={TEXTO_MAXIMO}
          disabled={busy}
          spellCheck={false}
          onChange={(evento) => setTexto(evento.target.value)}
          onBlur={confirmarTexto}
          onKeyDown={(evento) => {
            if (evento.key === "Enter") confirmarTexto();
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
                —con su texto y su medio— para averiguarlo. */}
            {ajuste.sonido ? (
              <>
                <button
                  type="button"
                  className="ghost tiny"
                  title={t.alertas.oirHint}
                  onClick={() => onOir(ajuste.sonido)}
                >
                  {t.alertas.oir}
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

      <div className="campos-par">
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
      </div>

      {/* El mínimo solo donde tiene sentido: un follow no trae cantidad con la que
          filtrar, y un campo que no hace nada es peor que no tenerlo. */}
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
    </Card>
  );
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
