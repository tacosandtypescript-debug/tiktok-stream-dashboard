//! Página de voz: controla el lector de chat en voz alta.
//!
//! El motor vive en Rust (cola, filtros, síntesis y reproducción); aquí solo se
//! muestran su estado y se envían órdenes. Mientras esta página está abierta se
//! consulta el estado una vez por segundo: **solo entonces** hay temporizador,
//! así que no cuesta nada cuando está cerrada.

import { useEffect, useState } from "react";

import { api, type TtsStatus, type TtsVoice } from "../api";
import { Card, Empty, Rows, formatNumber } from "../components";
import { t } from "../i18n/es";

/** Ritmos que entiende edge-tts. */
const RATES = ["-50%", "-25%", "+0%", "+25%", "+50%", "+100%"];
const PITCHES = ["-12Hz", "-8Hz", "-4Hz", "+0Hz", "+4Hz", "+8Hz", "+12Hz"];

interface Props {
  initial: TtsStatus | null;
}

export function Tts({ initial }: Props) {
  const [status, setStatus] = useState<TtsStatus | null>(initial);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  if (!status) {
    return <p className="empty">Cargando el estado de la voz…</p>;
  }

  const spanish = voices.filter((voice) => voice.language === "es");
  const english = voices.filter((voice) => voice.language === "en");

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

          <Card title={t.tts.rejected}>
            {status.rejections.length === 0 ? (
              <Empty>{t.tts.rejectedEmpty}</Empty>
            ) : (
              <Rows
                rows={status.rejections.map(([motivo, cuenta]) => [
                  motivo,
                  formatNumber(cuenta),
                ])}
              />
            )}
          </Card>
        </div>
      </div>

      <Card title={t.tts.counters}>
        <Rows
          rows={[
            [t.tts.synthesized, formatNumber(status.synthesized)],
            [t.tts.dropped, formatNumber(status.dropped)],
            [t.tts.muted, formatNumber(status.muted_users)],
          ]}
        />
        <p className="hint">{t.tts.hint}</p>
      </Card>
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
