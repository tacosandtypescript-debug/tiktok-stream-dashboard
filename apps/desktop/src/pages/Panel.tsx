//! Panel principal: estado de la sesión, chat reciente y actividad.

import type { ChatEntry, FeedItem, GiftTypeSummary, GifterEntry, Snapshot } from "../api";
import {
  Card,
  Empty,
  FeedTag,
  GiftThumb,
  chatText,
  feedText,
  formatDuration,
  formatNumber,
  nickname,
  timeAgo,
} from "../components";
import { t } from "../i18n/es";

interface Props {
  snapshot: Snapshot | null;
  status: string;
  detail: string | null;
  chat: ChatEntry[];
  feed: FeedItem[];
  topGifters: GifterEntry[];
  giftsByType: GiftTypeSummary[];
  totals: Totals;
  now: number;
  /** `source_id` de los comentarios borrados (se pintan atenuados y rotulados). */
  deleted: ReadonlySet<string>;
}

export interface Totals {
  viewers: number;
  cumulativeViewers: number;
  likes: number;
  gifts: number;
  diamonds: number;
  comments: number;
  follows: number;
  /** Entradas a la sala acumuladas en la sesion (`member.joined`). */
  joined: number;
}

export function Panel({
  snapshot,
  status,
  detail,
  chat,
  feed,
  topGifters,
  giftsByType,
  totals,
  now,
  deleted,
}: Props) {
  const connected = status === "connected";
  const startedAt = snapshot?.started_at_ms ?? null;
  const duration = connected && startedAt ? formatDuration(now - startedAt) : "—";
  const recientes = chat.slice(-10).reverse();

  return (
    <div className="grid-panel">
      <Card title={t.session.title}>
        <div className={`session ${connected ? "session-live" : ""}`}>
          <div className="session-main">
            <span className="session-handle">
              {snapshot?.handle ? `@${snapshot.handle}` : "—"}
            </span>
            <span className={`status-pill status-${status}`}>
              {t.status[status] ?? status}
            </span>
          </div>
          <p className="session-title">
            {snapshot?.title || detail || t.session.noSession}
          </p>
          <div className="session-metrics">
            <Metric label={t.session.duration} value={duration} />
            <Metric label={t.stats.viewers} value={formatNumber(totals.viewers)} />
            <Metric label={t.stats.likes} value={formatNumber(totals.likes)} />
            <Metric label={t.stats.diamonds} value={formatNumber(totals.diamonds)} />
          </div>
          {!connected && !snapshot?.handle ? (
            <p className="hint">{t.session.hint}</p>
          ) : null}
          {snapshot?.room_id ? (
            <p className="hint">
              {t.session.room}: {snapshot.room_id}
            </p>
          ) : null}
        </div>
      </Card>

      <div className="grid-columns">
        <Card title={t.chat.title}>
          {recientes.length === 0 ? (
            <Empty>{t.chat.empty}</Empty>
          ) : (
            <ul className="chat compact">
              {recientes.map((entry) => {
                // Misma regla que en la pagina de Chat: el borrado se marca, no
                // se quita (si no, aqui seguiria leyendose como si nada).
                const borrado = entry.source_id !== undefined && deleted.has(entry.source_id);
                return (
                  <li key={entry.seq}>
                    <span className="user">
                      {nickname(entry.user.nickname, entry.user.unique_id)}
                    </span>
                    <span className={borrado ? "content deleted" : "content"}>
                      {chatText(entry, borrado)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title={t.feed.title}>
          {feed.length === 0 ? (
            <Empty>{t.feed.empty}</Empty>
          ) : (
            <ul className="feed">
              {feed.slice(0, 25).map((item) => (
                <li key={item.seq}>
                  <FeedTag kind={item.kind} />
                  <span className="feed-text">
                    <GiftThumb url={item.gift?.image_url} name={item.gift?.name ?? ""} />
                    {feedText(item)}
                  </span>
                  <span className="feed-time">{timeAgo(item.timestamp_ms, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid-columns">
        <Card title={t.gifts.top}>
          {topGifters.length === 0 ? (
            <Empty>{t.gifts.empty}</Empty>
          ) : (
            <ol className="ranking">
              {topGifters.map((entry, index) => (
                <li key={entry.user.id}>
                  <span className="rank">{index + 1}</span>
                  <span className="user">{nickname(entry.user.nickname, entry.user.unique_id)}</span>
                  <span className="rank-value">{formatNumber(entry.diamonds)} 💎</span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title={t.gifts.byType}>
          {giftsByType.length === 0 ? (
            <Empty>{t.gifts.empty}</Empty>
          ) : (
            <ul className="ranking">
              {giftsByType.map((gift) => (
                <li key={gift.gift_id}>
                  <span className="rank">×</span>
                  <span className="user">{gift.gift_name || `regalo ${gift.gift_id}`}</span>
                  <span className="rank-value">
                    {formatNumber(gift.count)} · {formatNumber(gift.diamonds)} 💎
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
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
