//! Regalos de la sesión: últimos eventos con su racha, ranking y totales.

import type { GiftEventView, GiftTypeSummary, GifterEntry } from "../api";
import {
  Card,
  Empty,
  GiftThumb,
  formatClock,
  formatNumber,
  nickname,
} from "../components";
import { t } from "../i18n/es";

interface Props {
  gifts: GiftEventView[];
  topGifters: GifterEntry[];
  byType: GiftTypeSummary[];
  totalGifts: number;
  totalDiamonds: number;
}

export function Gifts({ gifts, topGifters, byType, totalGifts, totalDiamonds }: Props) {
  return (
    <div className="grid-panel">
      <Card title={t.gifts.title}>
        <p className="session-title">{t.gifts.total(totalGifts, totalDiamonds)}</p>
      </Card>

      <div className="grid-columns">
        <Card title={t.gifts.recent}>
          {gifts.length === 0 ? (
            <Empty>{t.gifts.empty}</Empty>
          ) : (
            <ul className="feed gifts">
              {gifts.slice(0, 60).map((gift) => (
                <li key={gift.seq}>
                  <span className="time">{formatClock(gift.timestamp_ms)}</span>
                  <GiftThumb url={gift.image_url} name={gift.gift_name} />
                  <span className="user">
                    {nickname(gift.user.nickname, gift.user.unique_id)}
                  </span>
                  <span className="feed-text">
                    <strong>{gift.gift_name || `regalo ${gift.gift_id}`}</strong>
                    {gift.repeat_count > 1 ? ` ×${gift.repeat_count}` : ""}
                  </span>
                  <span className="rank-value">
                    {formatNumber(gift.diamond_count * Math.max(1, gift.repeat_count))} 💎
                  </span>
                  {gift.streakable ? (
                    <span className={gift.is_final ? "tag tag-gift" : "tag tag-info"}>
                      {gift.is_final ? t.gifts.streakFinal : t.gifts.streak}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="stack">
          <Card title={t.gifts.top}>
            {topGifters.length === 0 ? (
              <Empty>{t.gifts.none}</Empty>
            ) : (
              <ol className="ranking">
                {topGifters.map((entry, index) => (
                  <li key={entry.user.id}>
                    <span className="rank">{index + 1}</span>
                    <span className="user">
                      {nickname(entry.user.nickname, entry.user.unique_id)}
                    </span>
                    <span className="rank-value">{formatNumber(entry.diamonds)} 💎</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title={t.gifts.byType}>
            {byType.length === 0 ? (
              <Empty>{t.gifts.none}</Empty>
            ) : (
              <ul className="ranking">
                {byType.map((gift) => (
                  <li key={gift.gift_id}>
                    <span className="rank">×</span>
                    <span className="user">{gift.gift_name || gift.gift_id}</span>
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
    </div>
  );
}
