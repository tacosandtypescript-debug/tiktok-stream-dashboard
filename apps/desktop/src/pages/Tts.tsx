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

import { api, type TtsProvider, type TtsStatus, type TtsVoice } from "../api";
import { Card, Empty, formatNumber } from "../components";
import { t } from "../i18n/es";

/** Ritmos que entiende edge-tts. */
const RATES = ["-50%", "-25%", "+0%", "+25%", "+50%", "+100%"];
const PITCHES = ["-12Hz", "-8Hz", "-4Hz", "+0Hz", "+4Hz", "+8Hz", "+12Hz"];

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

  return (
    <div className="grid-panel">
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

      <div className="grid-columns">
        {/* Columna izquierda: las dos listas. La de la cola es lo que va a sonar
            y la de claves es lo que hay guardado; las dos son «lo que hay», y por
            eso van juntas. Los ajustes del motor, en la otra. */}
        <div className="stack">
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

          {/* Las claves de Fish solo se enseñan cuando Fish es el motor: con la
              voz de siempre no se usan para nada. */}
          {status.voz.proveedor === "fish" ? (
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
                <div className="clave-alta">
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
          ) : null}
        </div>

        <div className="stack">
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

          {/* Los ajustes de Fish solo se enseñan cuando Fish es el motor: con la
              voz de siempre no se usan para nada. */}
          {status.voz.proveedor === "fish" ? (
            <>
              <Card title={t.tts.fish}>
                <p className="hint">{t.tts.fishHint}</p>
                <div className="campo">
                  <label htmlFor="voz-fish">{t.tts.fishVoice}</label>
                  <input
                    id="voz-fish"
                    type="text"
                    defaultValue={status.voz.reference_id}
                    placeholder={t.tts.fishVoicePlaceholder}
                    spellCheck={false}
                    /* Se guarda al salir del campo y no en cada tecla: guardar
                       por tecla reescribiria el perfil entero decenas de veces. */
                    onBlur={(event) => update({ fish_reference_id: event.target.value })}
                  />
                  <span className="hint">{t.tts.fishVoiceHint}</span>
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
            </>
          ) : null}
        </div>

        {/* Tercera columna. Antes eran dos columnas de seis tarjetas y la de la
            derecha medía 1.230 px con la ventana en 900: había que desplazar la
            página entera para llegar al volumen. Con las tres columnas que caben en
            1.240 px, la más cargada baja a ~530 y la página entra entera. */}
        <div className="stack">
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

          <Card title={t.tts.volume}>
            <div className="control">
              <input
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
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={status.settings.say_author}
                onChange={(event) => update({ say_author: event.target.checked })}
              />
              <span>{t.tts.sayAuthor}</span>
            </label>
          </Card>

          <Card title={t.tts.device}>
            <p className="hint">
              {status.audio_device
                ? t.tts.deviceActive(status.audio_device)
                : t.tts.deviceUnavailable}
            </p>
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
