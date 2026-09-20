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

import { useEffect, useState } from "react";

import { api, type TtsProvider, type TtsStatus, type TtsVoice, type TtsVozGuardada } from "../api";
import { Card, Empty, formatNumber } from "../components";
import { t } from "../i18n/es";

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

/** Tope de claves, el mismo que impone el motor. */
const TOPE_CLAVES = 10;

interface Props {
  initial: TtsStatus | null;
}

export function Tts({ initial }: Props) {
  const [status, setStatus] = useState<TtsStatus | null>(initial);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Nombre y valor de la clave que se está dando de alta. */
  const [claveNombre, setClaveNombre] = useState("");
  const [claveValor, setClaveValor] = useState("");
  const [errorClave, setErrorClave] = useState<string | null>(null);
  /** Nombre y código de la voz que se está dando de alta. */
  const [vozNombre, setVozNombre] = useState("");
  const [vozCodigo, setVozCodigo] = useState("");

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

  useEffect(() => {
    let active = true;
    void api
      .ttsDevices()
      .then((lista) => {
        if (active) setDevices(lista);
      })
      .catch((cause: unknown) => {
        if (active) setError(`${t.tts.deviceLoadError} ${String(cause)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      void api
        .ttsStatus()
        .then((nuevo) => {
          if (active) setStatus(nuevo);
        })
        .catch((cause: unknown) => setError(String(cause)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const update = (patch: Parameters<typeof api.ttsUpdate>[0]) => {
    void api
      .ttsUpdate(patch)
      .then(() => api.ttsStatus())
      .then(setStatus)
      .catch((cause: unknown) => setError(String(cause)));
  };

  const action = (name: string, value?: string) => {
    void api
      .ttsAction(name, value)
      .then(() => api.ttsStatus())
      .then(setStatus)
      .catch((cause: unknown) => setError(String(cause)));
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
    void api
      .ttsKeyAdd(nombre, valor)
      .then((nuevo) => {
        setStatus(nuevo);
        // El campo se vacía: la clave ya está guardada y no se puede volver a leer.
        setClaveNombre("");
        setClaveValor("");
      })
      .catch((cause: unknown) => setErrorClave(String(cause)));
  };

  const accionClave = (accion: "quitar" | "reintentar", id: number) => {
    const llamada = accion === "quitar" ? api.ttsKeyRemove(id) : api.ttsKeyReset(id);
    void llamada
      .then(setStatus)
      .catch((cause: unknown) => setErrorClave(String(cause)));
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
   * Las tres plantillas se editan **en local** y se guardan al salir del campo.
   *
   * El estado de la voz llega cada segundo; si el campo se pintara desde ahi, el
   * cursor saltaria al final mientras se escribe. Es el mismo trato que el texto
   * de los avisos de OBS. Se siembra una sola vez, cuando llega el primer estado.
   */
  const [plantillas, setPlantillas] = useState<{
    chat: string;
    regalo: string;
    follow: string;
  } | null>(null);
  useEffect(() => {
    if (!status || plantillas) return;
    setPlantillas({
      chat: status.settings.chat_template,
      regalo: status.settings.gift_template,
      follow: status.settings.follow_template,
    });
  }, [status, plantillas]);

  const guardarPlantilla = (cual: "chat" | "regalo" | "follow") => {
    if (!plantillas) return;
    if (cual === "chat") update({ chat_template: plantillas.chat });
    else if (cual === "regalo") update({ gift_template: plantillas.regalo });
    else update({ follow_template: plantillas.follow });
  };

  /**
   * Guarda en la lista una voz del catálogo de Edge, con lo que ya se sabe de
   * ella: su idioma y su rótulo. Es lo que evita volver a buscarla en el
   * desplegable cada vez.
   */
  const guardarVozEdge = (referencia: string, idioma: string) => {
    const delCatalogo = voices.find((voz) => voz.id === referencia);
    const nueva = {
      nombre: delCatalogo?.label ?? referencia,
      referencia,
      proveedor: "edge",
      idioma,
      descripcion: delCatalogo?.label ?? "",
    };
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
    const esFish = voz.proveedor === "fish";
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
   * Si una voz guardada es la que está sonando.
   *
   * Depende del motor, y mirar solo la referencia mentiría: una de Fish lo está si
   * su código es el puesto **y** el motor es Fish; una de Edge, si es la elegida
   * del idioma que le toca y el motor es Edge. Sin la primera condición, una voz
   * de Fish aparecería «En uso» con Edge puesto solo porque su código sigue
   * guardado en los ajustes.
   */
  const enUso = (voz: TtsVozGuardada): boolean => {
    if (voz.proveedor === "fish") {
      return status.voz.proveedor === "fish" && voz.referencia === status.voz.reference_id;
    }
    if (status.voz.proveedor !== "edge") return false;
    const elegida = voz.idioma === "en" ? status.settings.voice_en : status.settings.voice_es;
    return voz.referencia === elegida;
  };

  /** Qué mitad de la página se está mirando. */
  const [vista, setVista] = useState<"sonando" | "voces">("sonando");

  /**
   * Guarda una voz con su nombre y la deja en uso.
   *
   * Se manda la lista **entera** y no una orden de alta: el motor guarda lo que
   * recibe, así que añadir, renombrar y quitar son la misma operación y el orden
   * lo decide quien acaba de tocar la pantalla. Si el código ya estaba en la
   * lista, se le cambia el nombre en vez de repetirlo: dos filas con la misma voz
   * solo hacen dudar de cuál está puesta.
   */
  const anadirVoz = () => {
    const referencia = vozCodigo.trim();
    if (!referencia) return;
    const sinLaRepetida = guardadas.filter(
      (voz) => !(voz.proveedor === "fish" && voz.referencia === referencia),
    );
    update({
      fish_voces: [
        {
          nombre: vozNombre.trim(),
          referencia,
          proveedor: "fish",
          // De una voz de Fish no se sabe el idioma ni hay descripción: su API no
          // los da con el identificador. Se dejan vacíos en vez de inventarlos.
          idioma: "",
          descripcion: "",
        },
        ...sinLaRepetida,
      ],
      fish_reference_id: referencia,
    });
    setVozNombre("");
    setVozCodigo("");
  };

  return (
    <div className="grid-panel voz" data-vista={vista}>
      {error ? <div className="error">{error}</div> : null}
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
          llenas—, asi que se reparten aqui. Se ve todo sin desplazar la pagina. */}
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
            rejilla las reparte sola en tres columnas, y esconder las de la otra
            vista deja que las demas se recoloquen: mover una tarjeta de vista es
            cambiarle la clase, no moverla de sitio en el marcado. */}
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

        {/* La lista de voces guardadas, **la primera** de su vista: es a lo que se
            viene aquí. Va fuera del panel de Fish a propósito —una voz de Edge
            tiene que poder elegirse con el motor de Edge puesto, y ese panel solo
            se enseña cuando el motor es Fish—. */}
        <div className="stack vista-voces">
          <Card
            title={t.tts.voicesSaved}
            actions={
              guardadas.length > 0 ? (
                <span className="hint">{t.tts.voicesSavedHint}</span>
              ) : null
            }
          >
            {guardadas.length === 0 ? (
              <p className="hint">{t.tts.voicesEmpty}</p>
            ) : (
              <ul className="voces">
                {guardadas.map((voz) => {
                  const activa = enUso(voz);
                  const clave = `${voz.proveedor}:${voz.referencia}`;
                  return (
                    <li key={clave} className={activa ? "voz activa" : "voz"}>
                      {/* Lo que no cabe en la fila va en el `title`: el
                          identificador son 32 caracteres y la descripción es una
                          línea entera. Guardados se quedan los dos —es lo que
                          evita volver a la API— y aquí se leen al pasar el ratón. */}
                      <span
                        className="voz-nombre"
                        title={
                          voz.descripcion
                            ? `${voz.descripcion} · ${voz.referencia}`
                            : voz.referencia
                        }
                      >
                        {voz.nombre || voz.referencia}
                      </span>
                      <span className="etiqueta">
                        {t.tts.voiceProvider[voz.proveedor] ?? voz.proveedor}
                      </span>
                      {activa ? (
                        <span className="etiqueta">{t.tts.voiceInUse}</span>
                      ) : (
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={() => usarVoz(voz)}
                        >
                          {t.tts.voiceUse}
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost tiny"
                        title={t.tts.voiceRemoveHint}
                        onClick={() =>
                          update({
                            fish_voces: guardadas.filter(
                              (otra) =>
                                !(
                                  otra.proveedor === voz.proveedor &&
                                  otra.referencia === voz.referencia
                                ),
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        {/* Las claves de Fish solo se enseñan cuando Fish es el motor: con la
            voz de siempre no se usan para nada. */}
        {status.voz.proveedor === "fish" ? (
          <div className="stack vista-voces">
            <Card title={t.tts.keys}>
              <p className="hint">{t.tts.keysHint}</p>
              {errorClave ? <p className="voz-aviso">{errorClave}</p> : null}
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
                      <span className="clave-acciones">
                        {clave.estado === "viva" ? null : (
                          <button
                            type="button"
                            className="ghost tiny"
                            onClick={() => accionClave("reintentar", clave.id)}
                          >
                            {t.tts.keyReset}
                          </button>
                        )}
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={() => accionClave("quitar", clave.id)}
                        >
                          {t.tts.keyRemove}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {status.consumo.claves.length >= TOPE_CLAVES ? (
                <p className="voz-aviso">{t.tts.keyFull}</p>
              ) : (
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

        {/* Los ajustes de Fish solo se enseñan cuando Fish es el motor: con la
            voz de siempre no se usan para nada. */}
        {status.voz.proveedor === "fish" ? (
          <>
            <div className="stack vista-voces">
              <Card title={t.tts.fish}>
                <p className="hint">{t.tts.fishHint}</p>

                {/* El alta, en una linea: nombre, codigo y guardar. Al guardar
                    queda **en uso**, que es lo que se quiere al pegar una voz
                    nueva. La lista de las guardadas vive en su propia tarjeta,
                    porque tambien enseña las de Edge y esa tiene que verse con
                    cualquiera de los dos motores puesto. */}
                <div className="alta-linea">
                  <div className="campo">
                    <label htmlFor="voz-nombre">{t.tts.voiceName}</label>
                    <input
                      id="voz-nombre"
                      value={vozNombre}
                      placeholder={t.tts.voiceNamePlaceholder}
                      spellCheck={false}
                      maxLength={40}
                      onChange={(event) => setVozNombre(event.target.value)}
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor="voz-codigo">{t.tts.voiceCode}</label>
                    <input
                      id="voz-codigo"
                      value={vozCodigo}
                      placeholder={t.tts.voiceCodePlaceholder}
                      spellCheck={false}
                      onChange={(event) => setVozCodigo(event.target.value)}
                    />
                  </div>
                  <button type="button" disabled={!vozCodigo.trim()} onClick={anadirVoz}>
                    {t.tts.voiceAdd}
                  </button>
                </div>

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
              </Card>
            </div>

            <div className="stack vista-voces">
              <Card title={t.tts.usage}>
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

        {/* La lista de voces guardadas se ha movido arriba del todo de esta vista:
            es a lo que se viene aquí, y en el marcado tiene que ir antes que las
            claves y los ajustes de Fish —la rejilla coloca por orden, y con
            `order` la vista quedaría al revés de como la lee un lector de
            pantalla—. */}

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
                    onChange={(event) =>
                      setPlantillas({ ...plantillas, chat: event.target.value })
                    }
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
                    onChange={(event) =>
                      setPlantillas({ ...plantillas, regalo: event.target.value })
                    }
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
                    onChange={(event) =>
                      setPlantillas({ ...plantillas, follow: event.target.value })
                    }
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

        <div className="stack vista-sonando">
          <Card title={t.tts.output}>
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
                    void api
                      .ttsSelectDevice(event.target.value || null)
                      .then(setStatus)
                      .catch((cause: unknown) =>
                        setError(`${t.tts.deviceSelectError} ${String(cause)}`),
                      );
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
