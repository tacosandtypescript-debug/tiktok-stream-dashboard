//! Página de voz: controla el lector de chat en voz alta.
//!
//! El motor vive en Rust (cola, filtros, síntesis y reproducción); aquí solo se
//! muestran su estado y se envían órdenes. Mientras esta página está abierta se
//! consulta el estado una vez por segundo: **solo entonces** hay temporizador,
//! así que no cuesta nada cuando está cerrada.
//!
//! Hay **dos motores** de voz y se elige aquí: la voz de siempre (el sidecar de
//! `edge-tts`) y Fish Audio (una llamada HTTPS con las claves del streamer). Los
//! dos producen un fichero de audio, así que todo lo de después —cola, volumen,
//! salida de audio— es exactamente igual.
//!
//! De Fish se enseña lo que Rust manda y **nunca la clave**: solo su pista
//! enmascarada. La interfaz escribe claves nuevas y no puede leer las que hay; es
//! la única forma de que una clave no acabe en una captura de pantalla.

import { useEffect, useRef, useState } from "react";

import { api, type TtsCuota, type TtsProvider, type TtsStatus, type TtsVoice, type TtsVozGuardada } from "../api";
import { Anillo, Card, Empty, formatDuration, formatNumber } from "../components";
import { useDispositivosDeAudio } from "../dispositivos";
import { t } from "../i18n/es";
import { BibliotecaVoces } from "../voces/BibliotecaVoces";
import { MenuVoz } from "../voces/MenuVoz";
import { esVozDeFish, vozGuardada } from "../voces/tipos";

/** Ritmos que entiende edge-tts. */
const RATES = ["-50%", "-25%", "+0%", "+25%", "+50%", "+100%"];
const PITCHES = ["-12Hz", "-8Hz", "-4Hz", "+0Hz", "+4Hz", "+8Hz", "+12Hz"];

/**
 * Las variables que entiende una plantilla.
 *
 * Espeja `tts::plantilla::VARIABLES`, que es quien las rellena: aquí solo se
 * enseñan, para que el streamer sepa qué puede escribir. Si algún día se añade una
 * allí, se añade aquí y el texto de ayuda la enseña sola.
 */
const VARIABLES = ["usuario", "mensaje", "regalo", "cantidad", "diamantes"];

/**
 * A partir de que porcentaje el saldo se pinta en rojo.
 *
 * Uno de cada cinco: da tiempo a recargar sin que el aviso salte tan pronto que se
 * acabe ignorando. Es un numero de politica, no de matematica, asi que vive aqui
 * con nombre en vez de suelto dentro del `className`.
 */
const UMBRAL_SALDO_BAJO = 20;

/** Tope de claves, el mismo que impone el motor. */
const TOPE_CLAVES = 10;

interface Props {
  initial: TtsStatus | null;
  /**
   * La dirección del servidor de overlays, que ya trae el token.
   *
   * Es la que sirve las portadas cacheadas y las pruebas sintetizadas: la
   * biblioteca la necesita para armar esas direcciones, y en el navegador (modo
   * web) es la única forma de llegar a los ficheros del disco del streamer.
   */
  urlOverlay?: string;
}

type PlantillaCampo = "chat" | "regalo" | "follow";
type Plantillas = Record<PlantillaCampo, string>;

const CAMPOS_PLANTILLAS: readonly PlantillaCampo[] = ["chat", "regalo", "follow"];

function plantillasDesdeEstado(status: TtsStatus): Plantillas {
  return {
    chat: status.settings.chat_template,
    regalo: status.settings.gift_template,
    follow: status.settings.follow_template,
  };
}

export function Tts({ initial, urlOverlay }: Props) {
  const [status, setStatus] = useState<TtsStatus | null>(initial);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** El saldo de la cuenta, preguntado aparte porque es una consulta de red. */
  const [cuota, setCuota] = useState<TtsCuota | null>(null);
  /** Evita que un intervalo lento abra otra consulta antes de que termine. */
  const cuotaEnVuelo = useRef(false);
  /** Nombre y valor de la clave que se está dando de alta. */
  const [claveNombre, setClaveNombre] = useState("");
  const [claveValor, setClaveValor] = useState("");
  const [errorClave, setErrorClave] = useState<string | null>(null);
  /** Lo que contestó Fish al probar una clave: se enseña, y no cambia su estado. */
  const [avisoClave, setAvisoClave] = useState<string | null>(null);
  /** Si el alta de clave está desplegada. */
  const [altaClave, setAltaClave] = useState(false);
  /** La tarjeta de las claves, para poder llevarle el foco desde la biblioteca. */
  const clavesRef = useRef<HTMLDivElement | null>(null);
  /** Evita que dos consultas de estado se solapen. */
  const estadoEnVuelo = useRef(false);
  /** Invalida respuestas que empezaron antes de una mutacion mas reciente. */
  const versionEstado = useRef(0);
  /** Las mutaciones esperan en orden y mantienen el polling fuera de la carrera. */
  const mutacionesEnCurso = useRef(0);
  const colaMutaciones = useRef(Promise.resolve());

  /**
   * Qué mitad de la página se está mirando.
   *
   * Este hook y los de las plantillas van **aquí arriba, con los demás**, y no
   * junto al código que los usa. El motivo es un fallo que costó encontrar: más
   * abajo hay un `return` temprano para cuando todavía no ha llegado el estado, y
   * un hook que viva detrás de ese `return` no se ejecuta en el primer pintado.
   * React cuenta entonces menos hooks que en el siguiente y aborta con «Rendered
   * more hooks than during the previous render»: la pantalla entera se cae.
   *
   * Se destapó al abrir la aplicación en la pestaña de Voz, que es cuando esta
   * página se monta sin estado. La regla, para no repetirlo: **ningún hook detrás
   * de un `return` temprano**.
   */
  const [vista, setVista] = useState<"sonando" | "voces">("sonando");

  /** Las tres plantillas de lectura, en local mientras se escriben. */
  const [plantillas, setPlantillas] = useState<Plantillas | null>(null);
  /** Campos que el usuario tiene abiertos: no se reemplazan desde el polling. */
  const plantillasEnEdicion = useRef<Set<PlantillaCampo>>(new Set());
  /**
   * Valores que ya se mandaron a Rust, pero que todavía no han sido confirmados
   * por un estado. Protege contra una respuesta vieja del polling que llegue
   * después del `ttsUpdate`.
   */
  const plantillasPendientes = useRef<Partial<Record<PlantillaCampo, string>>>({});
  /** Último valor de backend visto, para distinguir cambio real de otro tick. */
  const ultimoBackendPlantillas = useRef<Plantillas | null>(null);

  useEffect(() => {
    if (!status) return;
    const backend = plantillasDesdeEstado(status);
    const anterior = ultimoBackendPlantillas.current;
    ultimoBackendPlantillas.current = backend;

    setPlantillas((actual) => {
      if (!actual) return backend;

      let siguiente: Plantillas | null = null;
      for (const campo of CAMPOS_PLANTILLAS) {
        if (anterior && anterior[campo] === backend[campo]) continue;

        const pendiente = plantillasPendientes.current[campo];
        if (pendiente !== undefined && pendiente === backend[campo]) {
          delete plantillasPendientes.current[campo];
        }

        if (
          plantillasEnEdicion.current.has(campo) ||
          plantillasPendientes.current[campo] !== undefined
        ) {
          continue;
        }

        if (!siguiente) siguiente = { ...actual };
        siguiente[campo] = backend[campo];
      }
      return siguiente ?? actual;
    });
  }, [
    status?.settings.chat_template,
    status?.settings.gift_template,
    status?.settings.follow_template,
  ]);

  useEffect(() => {
    let active = true;
    void api
      .ttsVoices()
      .then((lista) => {
        if (active) setVoices(lista);
      })
      .catch((cause: unknown) => setError(String(cause)));
    return () => {
      active = false;
    };
  }, []);

  /**
   * Las salidas de audio, con su propio reintento.
   *
   * Se pregunta al abrir, cada vez con mas espera mientras la lista este vacia, y al
   * volver la ventana a primer plano. Antes se preguntaba **una sola vez**: si esa
   * consulta fallaba, la pantalla se quedaba sin ninguna salida hasta reiniciar.
   */
  const { dispositivos: devices, error: errorDispositivos } = useDispositivosDeAudio();

  /**
   * El saldo de la cuenta, preguntado a la API del motor.
   *
   * Se pide **cada 30 s** y no en cada refresco del estado: el estado va a 1 s
   * porque cuenta frases, y el saldo no cambia a ese ritmo. El proveedor cachea
   * las consultas de todos modos —no se pregunta a la API antes de cinco
   * minutos—, pero pedirlo cada segundo serían sesenta llamadas por minuto al
   * motor para leer el mismo número.
   *
   * Un fallo **no borra** lo que ya se sabía: `tts_cuota` devuelve el último
   * estado con su motivo, y aquí solo se guarda lo que llega.
   */
  useEffect(() => {
    let active = true;
    const tick = () => {
      if (cuotaEnVuelo.current) return;
      cuotaEnVuelo.current = true;
      void api
        .ttsCuota()
        .then((nuevo) => {
          if (active) setCuota(nuevo);
        })
        .catch(() => {
          // El comando no falla por red —eso viaja dentro del estado—: si falla
          // es que el puente no está, y de eso ya avisa el estado.
        })
        .finally(() => {
          cuotaEnVuelo.current = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (mutacionesEnCurso.current > 0 || estadoEnVuelo.current) return;
      const version = ++versionEstado.current;
      estadoEnVuelo.current = true;
      void api
        .ttsStatus()
        .then((nuevo) => {
          if (active && version === versionEstado.current && mutacionesEnCurso.current === 0) {
            setStatus(nuevo);
          }
        })
        .catch((cause: unknown) => {
          if (active && version === versionEstado.current && mutacionesEnCurso.current === 0) {
            setError(String(cause));
          }
        })
        .finally(() => {
          estadoEnVuelo.current = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * Ejecuta una orden que cambia el estado TTS y trae una confirmacion despues.
   *
   * El polling de un segundo puede alcanzar a una orden en vuelo. Todas las
   * mutaciones pasan por esta cola, y cada respuesta lleva una version: si otra
   * mutacion comenzo despues, la respuesta anterior ya no puede pintar el estado.
   */
  const encolarMutacion = (
    comando: () => Promise<unknown>,
    callbacks: {
      ok?: () => void;
      fallo?: (cause: unknown) => void;
    } = {},
  ) => {
    mutacionesEnCurso.current += 1;
    // Invalida cualquier tick que ya estuviera esperando antes de la orden.
    versionEstado.current += 1;

    const trabajo = colaMutaciones.current
      .then(async () => {
        await comando();
        const version = ++versionEstado.current;
        const nuevo = await api.ttsStatus();
        if (version === versionEstado.current) setStatus(nuevo);
        callbacks.ok?.();
      })
      .catch((cause: unknown) => {
        (callbacks.fallo ?? ((error) => setError(String(error))))(cause);
      })
      .finally(() => {
        mutacionesEnCurso.current -= 1;
      });

    colaMutaciones.current = trabajo;
    void trabajo;
  };

  const update = (patch: Parameters<typeof api.ttsUpdate>[0]) => {
    encolarMutacion(() => api.ttsUpdate(patch));
  };

  const action = (name: string, value?: string) => {
    encolarMutacion(() => api.ttsAction(name, value));
  };

  /** Cambia de motor de voz. Lo que estaba en cola se descarta (lo explica Rust). */
  const cambiarMotor = (provider: TtsProvider) => {
    if (provider === status?.voz.proveedor) return;
    update({ provider });
  };

  /**
   * Guarda una clave nueva.
   *
   * Va en su propio comando porque es **escritura sola**: el estado que vuelve
   * trae la lista de claves enmascaradas, nunca el valor que se acaba de mandar.
   */
  const guardarClave = () => {
    const nombre = claveNombre.trim();
    const valor = claveValor.trim();
    if (!valor) {
      setErrorClave(t.tts.keyEmpty);
      return;
    }
    setErrorClave(null);
    encolarMutacion(
      () => api.ttsKeyAdd(nombre, valor),
      {
        ok: () => {
          // El campo se vacía: la clave ya está guardada y no se puede volver a leer.
          setClaveNombre("");
          setClaveValor("");
        },
        fallo: (cause) => setErrorClave(String(cause)),
      },
    );
  };

  const accionClave = (accion: "quitar" | "reintentar" | "apagar", id: number) => {
    encolarMutacion(
      () =>
        accion === "quitar"
          ? api.ttsKeyRemove(id)
          : accion === "apagar"
            ? api.ttsKeyDisable(id)
            : api.ttsKeyReset(id),
      { fallo: (cause) => setErrorClave(String(cause)) },
    );
  };

  /**
   * Prueba una clave contra la API, sin gastar saldo.
   *
   * El resultado se enseña tal cual y **no se toca su estado**: probar no es usar, y
   * marcar una clave por un corte de red sería mentir sobre ella. Si la clave no
   * vale, lo dice el motivo que devuelve Fish.
   */
  const probarClave = (id: number) => {
    setAvisoClave(t.tts.keyProbando);
    void api
      .ttsKeyProbar(id)
      .then(() => setAvisoClave(t.tts.keyProbarOk))
      .catch((cause: unknown) => setAvisoClave(t.tts.keyProbarFallo(String(cause))));
  };

  const renombrarClave = (id: number, actual: string) => {
    const propuesto = window.prompt(t.tts.keyRenombrarAviso, actual);
    if (propuesto === null) return;
    encolarMutacion(
      () => api.ttsKeyRename(id, propuesto),
      { fallo: (cause) => setErrorClave(String(cause)) },
    );
  };

  /**
   * Lleva la vista a la tarjeta de las claves.
   *
   * Lo pide la biblioteca cuando no hay ninguna: sin clave no se puede explorar el
   * catálogo, y en vez de dejarlo dicho y ya está se lleva al sitio donde se
   * arregla. En la ventana ancha las claves ya están a la vista y no pasa nada; en
   * la estrecha están debajo, y ahí es donde hace falta el salto.
   */
  const irAClaves = () => {
    clavesRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  if (!status) {
    return <p className="empty">Cargando el estado de la voz…</p>;
  }

  const spanish = voices.filter((voice) => voice.language === "es");
  const english = voices.filter((voice) => voice.language === "en");

  /* El motor que suena, el otro, y cómo se llama cada uno. Van aquí y no repetidos
     en el marcado porque el panel los necesita tres veces (la ficha, el botón y su
     explicación) y con dos copias se acaba diciendo una cosa en cada sitio. */
  const otroMotor: TtsProvider = status.voz.proveedor === "fish" ? "edge" : "fish";
  const nombreDeMotor = (cual: TtsProvider) =>
    cual === "fish" ? t.tts.engineFish : t.tts.engineEdge;
  const descripcionDeMotor = (cual: TtsProvider) =>
    cual === "fish" ? t.tts.engineFishHint : t.tts.engineEdgeHint;

  /** Las voces guardadas con su nombre, tal como las manda el motor. */
  const guardadas = status.settings.fish.voces;

  /**
   * El tono del anillo del saldo.
   *
   * Dos tonos y no tres: la paleta del proyecto usa el color con un significado
   * fijo —cian es «va bien», rojo es «alerta»—, y meter un ambar para el tramo
   * intermedio romperia esa regla en una pantalla mas.
   *
   * `apagado` cuando no hay dato. Eso **no es un cero**: es que no se sabe, y por
   * eso no se pinta arco ninguno.
   */
  /**
   * Las tres plantillas se editan **en local** y se guardan al salir del campo.
   *
   * El estado de la voz llega cada segundo; si el campo se pintara desde ahi, el
   * cursor saltaria al final mientras se escribe. Es el mismo trato que el texto
   * de los avisos de OBS: se siembra al llegar el primer estado, se resincroniza
   * cuando cambia el backend y se respeta el borrador mientras el campo esta en uso.
   */

  const editarPlantilla = (cual: PlantillaCampo, valor: string) => {
    plantillasEnEdicion.current.add(cual);
    setPlantillas((actual) => (actual ? { ...actual, [cual]: valor } : actual));
  };

  const guardarPlantilla = (cual: PlantillaCampo) => {
    if (!plantillas) return;
    plantillasEnEdicion.current.delete(cual);

    const valor = plantillas[cual];
    plantillasPendientes.current[cual] = valor;
    const patch =
      cual === "chat"
        ? { chat_template: valor }
        : cual === "regalo"
          ? { gift_template: valor }
          : { follow_template: valor };

    encolarMutacion(() => api.ttsUpdate(patch), {
      fallo: (cause) => {
        if (plantillasPendientes.current[cual] === valor) {
          delete plantillasPendientes.current[cual];
        }
        setError(String(cause));
      },
    });
  };

  /**
   * Guarda en la lista una voz del catálogo de Edge, con lo que ya se sabe de
   * ella: su idioma y su rótulo. Es lo que evita volver a buscarla en el
   * desplegable cada vez.
   */
  const guardarVozEdge = (referencia: string, idioma: string) => {
    const delCatalogo = voices.find((voz) => voz.id === referencia);
    const nueva = vozGuardada({
      nombre: delCatalogo?.label ?? referencia,
      // De una voz de Edge el catalogo **es** su nombre: no hay otro titulo.
      titulo_original: delCatalogo?.label ?? "",
      referencia,
      proveedor: "edge",
      idioma,
      descripcion: delCatalogo?.label ?? "",
    });
    update({
      fish_voces: [
        nueva,
        ...guardadas.filter(
          (otra) => !(otra.proveedor === "edge" && otra.referencia === referencia),
        ),
      ],
    });
  };

  /**
   * Pone en uso una voz guardada.
   *
   * Una de Edge vuelve a su motor y a su desplegable —el que toque según su
   * idioma—; una de Fish pone su código. Es el ahorro de verdad: el streamer no
   * tiene que acordarse de que «mi voz de mujer» era de Fish, ni de cuál era su
   * código.
   *
   * El motor **solo se manda si cambia**: cambiarlo vacía la cola, y elegir otra
   * voz del mismo motor no tiene por qué cortar lo que está leyendo.
   */
  const usarVoz = (voz: TtsVozGuardada) => {
    const esFish = esVozDeFish(voz.proveedor);
    const motor: TtsProvider = esFish ? "fish" : "edge";
    const cambio = motor === status.voz.proveedor ? {} : { provider: motor };
    if (esFish) {
      update({ ...cambio, fish_reference_id: voz.referencia });
    } else if (voz.idioma === "en") {
      update({ ...cambio, voice_en: voz.referencia });
    } else {
      update({ ...cambio, voice_es: voz.referencia });
    }
  };

  /**
   * El tono del anillo del saldo.
   *
   * Dos tonos y no tres: la paleta del proyecto usa el color con un significado
   * fijo —cian es «va bien», rojo es «alerta»—, y meter un ambar para el tramo
   * intermedio romperia esa regla en una pantalla mas.
   *
   * `apagado` cuando no hay dato. Eso **no es un cero**: es que no se sabe, y por
   * eso no se pinta arco ninguno.
   */
  const tonoSaldo: "normal" | "bajo" | "apagado" =
    cuota?.porcentaje === null || cuota?.porcentaje === undefined
      ? "apagado"
      : cuota.porcentaje <= UMBRAL_SALDO_BAJO
        ? "bajo"
        : "normal";

  return (
    <div className="grid-panel voz" data-vista={vista}>
      {error ? <div className="error">{error}</div> : null}
      {errorDispositivos ? (
        <div className="error">{`${t.tts.deviceLoadError} ${errorDispositivos}`}</div>
      ) : null}
      {status.degraded ? (
        <div className="error">
          {t.tts.degraded(
            `${status.degraded_kind === "provider" ? "Proveedor" : "Audio"}: ${status.degraded}`,
          )}
        </div>
      ) : null}

      <Card
        title={t.tts.title}
        actions={
          <>
            <label className="switch">
              <input
                type="checkbox"
                checked={status.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />
              <span>{t.tts.enabled}</span>
            </label>
            <button
              type="button"
              className="ghost"
              disabled={!status.enabled}
              onClick={() => action(status.paused ? "resume" : "pause")}
            >
              {status.paused ? t.tts.resume : t.tts.pause}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!status.enabled}
              onClick={() => action("skip")}
            >
              {t.tts.skip}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!status.enabled}
              onClick={() => action("clear")}
            >
              {t.tts.clear}
            </button>
          </>
        }
      >
        <div className="session">
          <div className="session-main">
            <span className={`status-pill ${status.enabled ? "status-connected" : ""}`}>
              {status.enabled ? (status.paused ? t.tts.paused : t.tts.nowPlaying) : "Apagado"}
            </span>
            <span className="session-title">
              {status.playing
                ? `${status.playing.user} — ${status.playing.text}`
                : t.tts.idle}
            </span>
          </div>
          {!status.enabled ? <p className="hint">{t.tts.disabledHint}</p> : null}
        </div>

        <div className="session-metrics">
          <Metric label={t.tts.queue} value={formatNumber(status.queued_len)} />
          <Metric label={t.tts.played} value={formatNumber(status.played)} />
          <Metric label={t.tts.fromCache} value={formatNumber(status.from_cache)} />
          <Metric label={t.tts.failures} value={formatNumber(status.synth_failures)} />
        </div>
      </Card>

      {/* Dos vistas en la misma pestaña: **lo que suena** mientras emites y **lo
          que tienes guardado**. Los diez paneles suman 1.831 px para 674 de alto y
          sacarlos a otra pestaña no vale —las otras cinco estan exactamente
          llenas—, asi que se reparten aqui. Se ve todo sin desplazar la pagina.

          El reparto de «Lo que suena» es el de la orden de trabajo: el estado de
          lectura arriba a todo el ancho, **los cinco paneles de trabajo en una sola
          fila** —cola, motor, que se lee, la voz y como se lee— y la salida de audio
          como **franja inferior a todo el ancho**. La salida no es un sexto panel:
          es una tira de una linea que se toca una vez, y metida en la fila obligaba
          a una segunda fila de paneles con 1.000 px de vacio al lado. */}
      <div className="vista-switch" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={vista === "sonando"}
          className={vista === "sonando" ? "active" : "ghost"}
          onClick={() => setVista("sonando")}
        >
          {t.tts.vistaSonando}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={vista === "voces"}
          className={vista === "voces" ? "active" : "ghost"}
          onClick={() => setVista("voces")}
        >
          {t.tts.vistaVoces}
        </button>
      </div>

      <div className="grid-columns">
        {/* Cada tarjeta en su propia celda y con la vista a la que pertenece. La
            rejilla las reparte sola, y esconder las de la otra vista deja que las
            demas se recoloquen: mover una tarjeta de vista es cambiarle la clase, no
            moverla de sitio en el marcado.

            **El orden del marcado es el orden de la pantalla**, asi que las cinco
            tarjetas de trabajo van en el orden de la orden —cola, motor, que se lee,
            la voz y como se lee— y la salida de audio va la ultima y con
            `ancho-completo`, que es lo que la saca de la fila y la pone de franja
            debajo ocupando las cinco columnas. No se hace con `order`: la rejilla
            coloca por orden de marcado y con `order` la vista quedaria al reves de
            como la lee un lector de pantalla. */}
        <div className="stack vista-sonando">
          <Card title={t.tts.queue}>
            {status.queued.length === 0 ? (
              <Empty>{t.tts.queueEmpty}</Empty>
            ) : (
              <ul className="ranking queue">
                {status.queued.map((item) => (
                  <li key={item.id}>
                    <span className="rank">{item.priority}</span>
                    <span className="user">{item.text}</span>
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() => action("remove", String(item.id))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* La biblioteca de voces: es lo primero y lo más grande de esta vista
            porque es a lo que se viene aquí. Dentro lleva sus dos pestañas —Mis
            voces y Explorar—, el buscador, los filtros y el alta, así que la
            tarjeta de «Voces guardadas» que había antes desaparece: era una lista
            sin caras al lado de una biblioteca que sí las tiene. */}
        <div className="stack vista-voces voz-columna-principal">
          <BibliotecaVoces
            urlOverlay={urlOverlay}
            guardadas={guardadas}
            proveedor={status.voz.proveedor}
            referenciaEnUso={status.voz.reference_id}
            edgeEnUso={{ es: status.settings.voice_es, en: status.settings.voice_en }}
            hayClaves={status.consumo.claves.length > 0}
            onStatus={setStatus}
            onUsar={usarVoz}
            onIrAClaves={irAClaves}
          />
        </div>
        {/* Las claves de Fish solo se enseñan cuando Fish es el motor: con la
            voz de siempre no se usan para nada. */}
        {status.voz.proveedor === "fish" ? (
          <div className="stack vista-voces voz-columna-lateral" ref={clavesRef}>
            <Card title={t.tts.keys}>
              <p className="hint">{t.tts.keysHint}</p>
              {errorClave ? <p className="voz-aviso">{errorClave}</p> : null}
              {avisoClave ? <p className="hint">{avisoClave}</p> : null}
              {status.consumo.claves.length === 0 ? (
                <Empty>{t.tts.keysEmpty}</Empty>
              ) : (
                <ul className="claves">
                  {status.consumo.claves.map((clave) => (
                    <li key={clave.id}>
                      <span className="clave-datos">
                        <span className="user">{clave.nombre}</span>
                        <code className="path">{clave.pista}</code>
                      </span>
                      <span
                        className={`status-pill ${clave.en_uso ? "status-connected" : ""}`}
                        title={t.tts.keyStates[clave.estado]}
                      >
                        {clave.en_uso ? t.tts.keyUsed : t.tts.keyStates[clave.estado]}
                      </span>
                      {/* El uso de **esta** clave: los bytes que ha mandado y lo
                          que llevan costando. Es su contador, y vive en su fila
                          para no repetirlo en la seccion de consumo. */}
                      <span className="rank-value" title={t.tts.usageCalls(formatNumber(clave.llamadas))}>
                        {formatoBytes(clave.bytes)} · {formatoDinero(clave.usd)}
                      </span>
                      {/* Las cuatro acciones, dentro del menú: con un botón por
                          acción la fila se llenaba de mandos y dejaba de leerse el
                          estado, que es lo que se viene a mirar aquí. */}
                      <MenuVoz
                        acciones={[
                          {
                            etiqueta: t.tts.keyProbar,
                            pista: t.tts.keyProbarHint,
                            onClick: () => probarClave(clave.id),
                          },
                          {
                            etiqueta: t.tts.keyRenombrar,
                            onClick: () => renombrarClave(clave.id, clave.nombre),
                          },
                          clave.estado === "viva"
                            ? {
                                etiqueta: t.tts.keyDesactivar,
                                pista: t.tts.keyDesactivarHint,
                                onClick: () => accionClave("apagar", clave.id),
                              }
                            : {
                                etiqueta: t.tts.keyActivar,
                                onClick: () => accionClave("reintentar", clave.id),
                              },
                          {
                            etiqueta: t.tts.keyQuitar,
                            peligrosa: true,
                            confirmar: t.tts.keyQuitarAviso,
                            onClick: () => accionClave("quitar", clave.id),
                          },
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {status.consumo.claves.length >= TOPE_CLAVES ? (
                <p className="voz-aviso">{t.tts.keyFull}</p>
              ) : (
                <>
                  {/* El alta, detrás de un botón: se hace una vez al montar la
                      escena, y con el formulario siempre abierto ocupaba tres
                      renglones de una tarjeta que se mira a diario. */}
                  <button
                    type="button"
                    className="ghost clave-alta-boton"
                    aria-expanded={altaClave}
                    onClick={() => setAltaClave((abierta) => !abierta)}
                  >
                    {t.tts.keyAddOpen}
                  </button>
                  {altaClave ? (
                    <div className="alta-linea">
                      <div className="campo">
                        <label htmlFor="clave-nombre">{t.tts.keyName}</label>
                        <input
                          id="clave-nombre"
                          type="text"
                          value={claveNombre}
                          placeholder={t.tts.keyNamePlaceholder}
                          onChange={(event) => setClaveNombre(event.target.value)}
                        />
                      </div>
                      <div className="campo">
                        <label htmlFor="clave-valor">{t.tts.keyValue}</label>
                        {/* De tipo `password` a proposito: la clave no se enseña ni
                            mientras se pega. */}
                        <input
                          id="clave-valor"
                          type="password"
                          value={claveValor}
                          placeholder={t.tts.keyValuePlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => setClaveValor(event.target.value)}
                        />
                      </div>
                      <button type="button" onClick={guardarClave}>
                        {t.tts.keyAdd}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </Card>
          </div>
        ) : null}

        <div className="stack vista-sonando">
          {/* Motor de voz: es lo primero que se elige porque decide todo lo demas
              de esta página (qué voces hay, qué claves hacen falta y a qué precio
              se cuenta). */}
          <Card title={t.tts.engine}>
            {/* El motor que está puesto se enseña como **estado**, no como botón.
                Antes eran dos botones iguales y el activo se pintaba con el cian
                macizo de los botones de acción —el mismo que «Conectar» y que
                «Añadir clave»—, así que se leía como «púlsame» y no como «estás
                usando esto». El streamer lo dijo tal cual: «no sé si uso la de Fish
                o la de Edge».
                Ahora el que suena es una ficha con su punto de color y el único
                botón dice **a dónde se cambia**: las dos cosas se distinguen sin
                leer nada, y el nombre del motor aparece escrito. */}
            <div className="motor">
              <span
                className="motor-actual"
                title={descripcionDeMotor(status.voz.proveedor)}
              >
                <span className="motor-punto" aria-hidden="true" />
                {nombreDeMotor(status.voz.proveedor)}
              </span>
              <button
                type="button"
                className="ghost"
                title={`${descripcionDeMotor(otroMotor)} ${t.tts.engineSwitchHint}`}
                onClick={() => cambiarMotor(otroMotor)}
              >
                {otroMotor === "fish" ? t.tts.engineSwitchToFish : t.tts.engineSwitchToEdge}
              </button>
            </div>
            <p className="hint">{t.tts.engineHint}</p>

            {/* El estado del motor se ve, no se adivina: si falta la clave o el
                código de voz, o si ninguna clave sirve, se dice aquí. Y en la
                misma línea, cuál se está usando: es lo siguiente que se pregunta
                el streamer. */}
            {status.voz.listo === "ready" ? (
              <p className="hint">
                {t.tts.engineReady.ready}
                {status.voz.proveedor === "fish"
                  ? ` · ${t.tts.engineKeys(status.voz.claves_vivas, status.voz.claves_total)}`
                  : ""}
                {status.voz.proveedor === "fish" && status.voz.clave_en_uso
                  ? ` · ${t.tts.engineInUse(status.voz.clave_en_uso)}`
                  : ""}
              </p>
            ) : (
              <p className="voz-aviso">{t.tts.engineReady[status.voz.listo]}</p>
            )}
          </Card>
        </div>

        {/* El consumo solo se enseña cuando Fish es el motor: con la voz de
            siempre no hay saldo que mirar.

            Va **en la misma columna** que las claves —una celda de la rejilla con
            dos tarjetas dentro— porque las dos son el lado derecho de la vista: las
            claves arriba y el consumo debajo. Con dos celdas sueltas, la rejilla
            colocaba el consumo debajo de la biblioteca. */}
        {status.voz.proveedor === "fish" ? (
          <>
            <div className="stack vista-voces voz-columna-lateral">
              <Card title={t.tts.usage}>
                {/* El modelo con el que se sintetiza vive **aqui** y no en la
                    biblioteca: es lo que decide el precio, y este es el panel que
                    habla de precios. En la biblioteca se eligen voces. */}
                <div className="campo">
                  <label htmlFor="voz-modelo">{t.tts.fishModel}</label>
                  <select
                    id="voz-modelo"
                    value={status.voz.modelo}
                    onChange={(event) => update({ fish_model: event.target.value })}
                  >
                    {status.voz.modelos.map((modelo) => (
                      <option key={modelo.id} value={modelo.id}>
                        {modelo.id} — {t.tts.fishModelPrice(String(modelo.precio_por_millon))}
                      </option>
                    ))}
                  </select>
                </div>
                {/* El saldo va arriba del todo del panel porque es la pregunta
                    que se hace de un vistazo —«¿me queda?»—, y el resto del panel
                    es el detalle de a dónde se ha ido. */}
                {/* Dos mitades separadas a proposito: arriba lo que dice **Fish**
                    (el saldo de la cuenta, que solo lo sabe el proveedor) y abajo lo
                    que cuenta **la aplicacion** (los bytes de texto que ha mandado
                    esta instalacion). Mezclarlas hacia pensar que el gasto local y el
                    saldo real salian del mismo sitio. */}
                <span className="tira-rotulo">{t.tts.consumoProveedor}</span>
                <div className="saldo">
                  <Anillo
                    porcentaje={cuota?.porcentaje ?? null}
                    cifra={
                      cuota?.restante === null || cuota?.restante === undefined
                        ? t.tts.saldoSinDato
                        : formatNumber(cuota.restante)
                    }
                    pie={
                      cuota?.total === null || cuota?.total === undefined
                        ? undefined
                        : t.tts.saldoDe(formatNumber(cuota.total))
                    }
                    tono={tonoSaldo}
                    title={t.tts.saldoHint}
                  />
                  <div className="saldo-datos">
                    <span className="saldo-rotulo">{t.tts.saldo}</span>
                    {/* El plan: la API lo llama `free` o `pro`; si algun dia manda
                        otro, se enseña tal cual en vez de tragarselo. */}
                    {cuota && !cuota.error && cuota.tipo ? (
                      <span className="hint">
                        {t.tts.saldoPlanes[cuota.tipo] ?? cuota.tipo}
                      </span>
                    ) : null}
                    {cuota?.error ? (
                      <span className="voz-aviso">{t.tts.saldoError(cuota.error)}</span>
                    ) : cuota ? (
                      <span className="hint">
                        {cuota.hace_segs < 5
                          ? t.tts.saldoAhora
                          : t.tts.saldoHace(formatDuration(cuota.hace_segs * 1000))}
                      </span>
                    ) : null}
                    {status.consumo.claves.length === 0 ? (
                      <span className="hint">{t.tts.saldoSinClave}</span>
                    ) : null}
                  </div>
                </div>

                {/* Este texto decia ademas «no por el audio», que ya no hace falta
                    explicar: el anillo de arriba dice en su `title` de donde sale
                    cada numero, y la linea del modelo dice a que precio se cuenta.
                    Se queda en lo que no se ve en ningun otro sitio. */}
                <span className="tira-rotulo">{t.tts.consumoAplicacion}</span>
                <p className="hint">{t.tts.usageHint}</p>
                <p className="hint">
                  {t.tts.usageModel(status.consumo.modelo, String(status.consumo.precio_por_millon))}
                </p>
                {!status.voz.modelos.some((modelo) => modelo.id === status.consumo.modelo) ? (
                  <p className="voz-aviso">{t.tts.usageUnknownModel}</p>
                ) : null}

                {/* El total de todas las claves juntas. El desglose por clave no
                    se repite aqui: vive en la fila de cada clave, que es donde se
                    pregunta. */}
                <div className="consumo-fila">
                  <span className="consumo-rotulo">{t.tts.usageSession}</span>
                  <span className="consumo-cifra">{formatoDinero(status.consumo.sesion_usd)}</span>
                  <span className="hint">
                    {t.tts.usageBytes(formatoBytes(status.consumo.sesion_bytes))} ·{" "}
                    {t.tts.usageCalls(formatNumber(status.consumo.sesion_llamadas))}
                  </span>
                </div>
                <div className="consumo-fila">
                  <span className="consumo-rotulo">{t.tts.usageTotal}</span>
                  <span className="consumo-cifra">{formatoDinero(status.consumo.total_usd)}</span>
                  <span className="hint">
                    {t.tts.usageBytes(formatoBytes(status.consumo.total_bytes))} ·{" "}
                    {t.tts.usageCalls(formatNumber(status.consumo.total_llamadas))}
                  </span>
                </div>

                {status.consumo.claves.length === 0 ? <Empty>{t.tts.usageEmpty}</Empty> : null}
              </Card>
            </div>
          </>
        ) : null}

        {/* La biblioteca de voces se ha movido arriba del todo de esta vista: es a
            lo que se viene aquí, y en el marcado tiene que ir antes que las claves
            y el consumo —la rejilla coloca por orden de marcado, y con `order` la
            vista quedaría al revés de como la lee un lector de pantalla—. */}

        <div className="stack vista-sonando">
          <Card title={t.tts.sources}>
            <p className="hint">{t.tts.sourcesHint}</p>
            <label className="switch">
              <input
                type="checkbox"
                checked={status.settings.read_gifts}
                onChange={(event) => update({ read_gifts: event.target.checked })}
              />
              <span>{t.tts.readGifts}</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={status.settings.read_follows}
                onChange={(event) => update({ read_follows: event.target.checked })}
              />
              <span>{t.tts.readFollows}</span>
            </label>
          </Card>
        </div>

        <div className="stack vista-sonando">
          {/* El panel se llamaba «Volumen» y aqui dentro estaban **las voces**:
              «Voz en español» y «Voz en inglés». El streamer las busco y no las
              encontro —tuvo que preguntarlo— porque nadie mira debajo de un
              rotulo que dice Volumen para cambiar de voz. Ahora el panel se llama
              por lo que es y el deslizador se fue con la salida de audio, que es
              donde tiene sentido: por donde sale y a que volumen. */}
          <Card title={t.tts.voice}>
            <div className="control">
              <label>
                {t.tts.rate}
                <select
                  value={status.settings.rate}
                  onChange={(event) => update({ rate: event.target.value })}
                >
                  {RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="control">
              <label>
                {t.tts.pitch}
                <select
                  value={status.settings.pitch}
                  onChange={(event) => update({ pitch: event.target.value })}
                >
                  {PITCHES.map((pitch) => (
                    <option key={pitch} value={pitch}>
                      {pitch}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="control">
              <label>
                {t.tts.voiceEs}
                <select
                  value={status.settings.voice_es}
                  onChange={(event) => update({ voice_es: event.target.value })}
                >
                  {spanish.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* Guardar la que esta puesta, **al lado del selector**: es lo que
                  evita volver a buscarla en el desplegable cada vez. Texto y no un
                  simbolo: un icono hay que adivinarlo. */}
              <button
                type="button"
                className="ghost tiny"
                title={t.tts.voiceSaveHint}
                onClick={() => guardarVozEdge(status.settings.voice_es, "es")}
              >
                {t.tts.voiceSave}
              </button>
            </div>
            <div className="control">
              <label>
                {t.tts.voiceEn}
                <select
                  value={status.settings.voice_en}
                  onChange={(event) => update({ voice_en: event.target.value })}
                >
                  {english.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ghost tiny"
                title={t.tts.voiceSaveHint}
                onClick={() => guardarVozEdge(status.settings.voice_en, "en")}
              >
                {t.tts.voiceSave}
              </button>
            </div>
          </Card>
        </div>

        <div className="stack vista-sonando">
          {/* Las plantillas: lo que se dice por cada cosa que pasa. El
              interruptor de «decir quien lo escribio» desaparecio —su trabajo lo
              hace la plantilla del chat, que ademas deja cambiar el verbo—, asi
              que aqui esta lo que antes era un si o un no. */}
          <Card title={t.tts.plantillas}>
            <p className="hint">{t.tts.plantillasHint}</p>
            {plantillas ? (
              <>
                <div className="campo">
                  <label htmlFor="plantilla-chat">{t.tts.chatTemplate}</label>
                  <input
                    id="plantilla-chat"
                    value={plantillas.chat}
                    spellCheck={false}
                    maxLength={160}
                    onFocus={() => plantillasEnEdicion.current.add("chat")}
                    onChange={(event) => editarPlantilla("chat", event.target.value)}
                    onBlur={() => guardarPlantilla("chat")}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="plantilla-regalo">{t.tts.giftTemplate}</label>
                  <input
                    id="plantilla-regalo"
                    value={plantillas.regalo}
                    spellCheck={false}
                    maxLength={160}
                    onFocus={() => plantillasEnEdicion.current.add("regalo")}
                    onChange={(event) => editarPlantilla("regalo", event.target.value)}
                    onBlur={() => guardarPlantilla("regalo")}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="plantilla-follow">{t.tts.followTemplate}</label>
                  <input
                    id="plantilla-follow"
                    value={plantillas.follow}
                    spellCheck={false}
                    maxLength={160}
                    onFocus={() => plantillasEnEdicion.current.add("follow")}
                    onChange={(event) => editarPlantilla("follow", event.target.value)}
                    onBlur={() => guardarPlantilla("follow")}
                  />
                </div>
                <p className="hint">
                  {t.tts.plantillasVariables}: {VARIABLES.map((v) => `{${v}}`).join(" ")}
                </p>
              </>
            ) : null}
          </Card>
        </div>

        {/* La salida de audio va la ultima y con `ancho-completo`: la rejilla la
            baja a su propia fila y le da las cinco columnas. Es una tira —donde
            suena y con que fuerza—, no un panel de trabajo mas: dentro de la fila
            obligaba a una segunda fila de paneles y dejaba 1.000 px de vacio al
            lado. */}
        <div className="stack vista-sonando ancho-completo">
          <Card title={t.tts.output}>
            {/* La franja va **en una linea**, como la pide la orden: dispositivo
                activo, volumen y selector, uno al lado del otro. Apilada medía 152 px
                y la orden pide 90-120; en horizontal entra en una y el ancho que
                sobra —tiene 1.240 px para tres controles— se lo queda el volumen, que
                es el unico que se arrastra. */}
            <div className="salida-audio">
              <p className="hint">
                {status.audio_device
                  ? t.tts.deviceActive(status.audio_device)
                  : t.tts.deviceUnavailable}
              </p>
              {/* El volumen, con la salida: es la misma pregunta —por donde suena y
                  con que fuerza— y antes vivia en un panel que se llamaba Volumen y
                  no tenia el volumen solo. */}
              <div className="control">
                <label htmlFor="voz-volumen">{t.tts.volume}</label>
                <input
                  id="voz-volumen"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(status.settings.volume * 100)}
                  onChange={(event) => update({ volume: Number(event.target.value) / 100 })}
                />
                <span className="rank-value">{Math.round(status.settings.volume * 100)} %</span>
              </div>
              <div className="control">
                <label>
                  {t.tts.device}
                  <select
                    value={status.settings.audio_device ?? ""}
                    onChange={(event) => {
                      encolarMutacion(() => api.ttsSelectDevice(event.target.value || null), {
                        fallo: (cause) =>
                          setError(`${t.tts.deviceSelectError} ${String(cause)}`),
                      });
                    }}
                  >
                    <option value="">{t.tts.deviceDefault}</option>
                    {status.settings.audio_device &&
                    !devices.includes(status.settings.audio_device) ? (
                      <option value={status.settings.audio_device}>
                        {status.settings.audio_device} (no disponible)
                      </option>
                    ) : null}
                    {devices.map((device) => (
                      <option key={device} value={device}>
                        {device}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

/**
 * Dinero en dólares, ya calculado por Rust.
 *
 * Aquí **no se multiplica nada**: la única conversión de bytes a dinero vive en
 * `tts::consumo`. El gratuito se enseña como «gratis» y no como «0,00 $», que es
 * lo que el streamer quiere saber de un modelo que no le cuesta nada.
 */
function formatoDinero(usd: number): string {
  if (usd === 0) return t.tts.usageFree;
  if (usd < 0.01) return `${usd.toLocaleString("es-CO", { maximumFractionDigits: 6 })} $`;
  return `${usd.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

/** Bytes en unidades que se leen de un vistazo: 812 B / 12,4 KB / 1,2 MB. */
function formatoBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${formatNumber(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toLocaleString("es-CO", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1_000_000).toLocaleString("es-CO", { maximumFractionDigits: 2 })} MB`;
}
