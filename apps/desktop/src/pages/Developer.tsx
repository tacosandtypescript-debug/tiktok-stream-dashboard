//! Diagnóstico y herramientas de desarrollo.
//!
//! El simulador vive **aquí**, no en la barra principal: es una herramienta de
//! desarrollo (y el proveedor que usan los tests), no parte del flujo normal.
//!
//! Aquí también está **todo lo que solo sirve cuando algo va mal**. La página de
//! Voz tenía doce tarjetas y la mitad eran diagnóstico: los avisos descartados por
//! los filtros y los contadores de síntesis no se miran mientras se emite, se miran
//! cuando la voz no suena. Con ellos dentro, Voz medía 1.518 px de contenido para
//! 674 de alto y había que desplazar la página entera. El contrato ya lo decía
//! («el histórico y los descartados, a Desarrollador»); esto lo cumple.

import type { Metrics, Snapshot } from "../api";
import { Card, Empty, Rows, formatNumber } from "../components";
import { t } from "../i18n/es";

/** Las métricas del motor, en cuántas columnas se pintan. */
const COLUMNAS_METRICAS = 3;

interface Props {
  snapshot: Snapshot | null;
  metrics: Metrics | null;
  busy: boolean;
  onSimulate: () => void;
  onNative: () => void;
}

export function Developer({ snapshot, metrics, busy, onSimulate, onNative }: Props) {
  if (!snapshot || !metrics) {
    return <p className="empty">Cargando diagnóstico…</p>;
  }

  const tecnicas: Array<[string, string | number]> = [
    [t.developer.protocolVersion, snapshot.protocol_version],
    [t.developer.provider, snapshot.provider],
    [t.developer.streamId, snapshot.stream_id ?? "—"],
    // La sala vivia en la pagina de sesion, que ya no existe: es un identificador
    // tecnico y su sitio es el diagnostico.
    [t.session.room, snapshot.room_id || "—"],
    [t.developer.schemaVersion, snapshot.schema_version],
    [t.developer.instancePort, snapshot.instance_port],
    [t.developer.dbWritten, snapshot.db_written],
    [t.developer.dbDropped, snapshot.db_dropped],
    ["db_write_errors", snapshot.db_write_errors],
    ["db_critical_write_errors", snapshot.db_critical_write_errors],
    ["events_published", metrics.events_published],
    ["ws_connects", metrics.ws_connects],
    ["ws_frames", metrics.ws_frames],
    ["sign_requests", metrics.sign_requests],
    ["sign_rate_limited", metrics.sign_rate_limited],
    ["duplicates_dropped", metrics.duplicates_dropped],
    ["subscription_lagged", metrics.subscription_lagged],
    ["viewer_updates_coalesced", metrics.viewer_updates_coalesced],
    ["provider_errors", metrics.provider_errors],
    ["provider_reconnects", metrics.provider_reconnects],
    // Si esto no es cero, la sesion quedo degradada: se perdio un regalo.
    ["db_critical_dropped", metrics.db_critical_dropped],
  ];

  // Se parte en **trozos contiguos**, no alternos: son veintiún contadores y se
  // leen en orden, asi que la primera columna va entera antes de saltar a la
  // segunda. Repartidos de uno en uno (1, 4, 7…) el orden de lectura se pierde.
  const porColumna = Math.ceil(tecnicas.length / COLUMNAS_METRICAS);
  const columnas = Array.from({ length: COLUMNAS_METRICAS }, (_, i) =>
    tecnicas.slice(i * porColumna, (i + 1) * porColumna),
  ).filter((tramo) => tramo.length > 0);

  return (
    <div className="grid-panel developer">
      <Card title={t.developer.metrics}>
        <p className="hint">{t.developer.warned}</p>
        {/* Una tabla por columna y no una tabla con `columns`: en CSS, una tabla no
            se parte entre columnas, asi que saldria una sola tira larga. */}
        <div className="metricas-columnas">
          {columnas.map((tramo, indice) => (
            <Rows
              key={indice}
              rows={tramo.map(([label, value]) => [
                label,
                typeof value === "number" ? formatNumber(value) : value,
              ])}
            />
          ))}
        </div>
      </Card>

      {/* El orden del marcado es el que colocan las reglas de `styles.css`:
          rutas, traza del chat, eventos, herramientas, descartados y contadores. */}
      <div className="developer-rejilla">
        <Card title={t.developer.paths}>
          <Rows
            rows={[
              [t.developer.database, <span className="path">{snapshot.db_path}</span>],
              [t.developer.logs, <span className="path">{snapshot.log_dir}</span>],
            ]}
          />
        </Card>

        <Card title={t.developer.chatTrace}>
          <p className="hint">{t.developer.chatTraceHint}</p>
          {snapshot.ui_chat.received === 0 ? (
            <p className="empty">{t.developer.chatTraceEmpty}</p>
          ) : (
            <ul className="ranking">
              <li>
                <span className="rank">·</span>
                <span className="user">
                  {t.developer.chatTraceCounts(
                    snapshot.ui_chat.received,
                    snapshot.ui_chat.rendered,
                  )}
                </span>
                <span className="rank-value">{formatNumber(snapshot.ui_chat.rendered_len)}</span>
              </li>
              <li>
                <span className="rank">·</span>
                <span className="rank-value">
                  {t.developer.chatTraceSeq(
                    snapshot.ui_chat.last_received_seq,
                    snapshot.ui_chat.last_rendered_seq,
                  )}
                </span>
              </li>
              <li>
                <span className="rank">·</span>
                <span className="rank-value">
                  {snapshot.ui_chat.last_dom || t.developer.chatTraceDomEmpty}
                </span>
              </li>
            </ul>
          )}
        </Card>

        <Card title={t.developer.uiEvents}>
          <p className="hint">{t.developer.uiEventsHint}</p>
          {snapshot.ui_events.length === 0 ? (
            <p className="empty">{t.developer.uiEventsEmpty}</p>
          ) : (
            <ul className="ranking">
              {snapshot.ui_events.map(([kind, count]) => (
                <li key={kind}>
                  <span className="rank">·</span>
                  <span className={kind.startsWith("sin_manejar") ? "unhandled" : "user"}>
                    {kind}
                  </span>
                  <span className="rank-value">{formatNumber(count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t.developer.tools}>
          <p className="hint">{t.developer.simulatorHint}</p>
          <div className="tools">
            <button type="button" disabled={busy} onClick={onSimulate}>
              {t.developer.simulator}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || snapshot.provider !== "simulated"}
              onClick={onNative}
            >
              {t.developer.backToNative}
            </button>
          </div>
        </Card>

        {/* Venían de la página de Voz. Se leen cuando la voz no suena: los motivos
            por los que el lector descartó un mensaje. */}
        <Card title={t.tts.rejected}>
          {snapshot.tts.rejections.length === 0 ? (
            <Empty>{t.tts.rejectedEmpty}</Empty>
          ) : (
            <Rows
              rows={snapshot.tts.rejections.map(([motivo, cuenta]) => [
                motivo,
                formatNumber(cuenta),
              ])}
            />
          )}
        </Card>

        {/* Los contadores del lector. También de Voz: son totales de la sesión, no
            algo que se mire mientras se emite. */}
        <Card title={t.tts.counters}>
          <Rows
            rows={[
              [t.tts.synthesized, formatNumber(snapshot.tts.synthesized)],
              [t.tts.dropped, formatNumber(snapshot.tts.dropped)],
              [t.tts.muted, formatNumber(snapshot.tts.muted_users)],
            ]}
          />
          <p className="hint">{t.tts.hint}</p>
        </Card>
      </div>
    </div>
  );
}
