//! Diagnóstico y herramientas de desarrollo.
//!
//! El simulador vive **aquí**, no en la barra principal: es una herramienta de
//! desarrollo (y el proveedor que usan los tests), no parte del flujo normal.

import type { Metrics, Snapshot } from "../api";
import { Card, Rows, formatNumber } from "../components";
import { t } from "../i18n/es";

interface Props {
  snapshot: Snapshot | null;
  metrics: Metrics | null;
  busy: boolean;
  onSimulate: () => void;
  onNative: () => void;
  onClearFeed: () => void;
}

export function Developer({
  snapshot,
  metrics,
  busy,
  onSimulate,
  onNative,
  onClearFeed,
}: Props) {
  if (!snapshot || !metrics) {
    return <p className="empty">Cargando diagnóstico…</p>;
  }

  const tecnicas: Array<[string, string | number]> = [
    [t.developer.protocolVersion, snapshot.protocol_version],
    [t.developer.provider, snapshot.provider],
    [t.developer.streamId, snapshot.stream_id ?? "—"],
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

  return (
    <div className="grid-panel">
      <Card title={t.developer.metrics}>
        <p className="hint">{t.developer.warned}</p>
        <Rows
          rows={tecnicas.map(([label, value]) => [
            label,
            typeof value === "number" ? formatNumber(value) : value,
          ])}
        />
      </Card>

      <div className="grid-columns">
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
      </div>

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
          <button type="button" className="ghost" onClick={onClearFeed}>
            {t.developer.clearFeed}
          </button>
        </div>
      </Card>
    </div>
  );
}
