//! Aportaciones: quién sostiene el directo y qué ha caído.
//!
//! Antes eran dos páginas —Regalos y Rankings— y la misma pregunta («quién ha
//! dado más diamantes») se contestaba en tres sitios, con dos componentes
//! distintos y dos formas distintas del mismo dato: la tabla del panel y la de
//! Regalos no llevaban foto ni enlace al perfil, y la de Rankings sí. Aquí vive
//! **una vez**, y con el componente que ya comparten el panel y el overlay
//! (`RankingTable`), así que los tres no pueden divergir.
//!
//! Orden: primero las personas —que es lo que se enseña en pantalla— y debajo el
//! detalle de los regalos, que es lo que se mira de reojo.

import type { GiftEventView, GiftTypeSummary, RankingEntry } from "../api";
import { Card, Empty, GiftThumb, RankingTable, formatClock, formatNumber, nickname } from "../components";
import { t } from "../i18n/es";

/** Regalos recientes que se listan. El resto sigue en memoria de Rust. */
const RECIENTES = 25;

interface Props {
  /** Tap tap: likes acumulados por persona en la sesión. */
  tap: RankingEntry[];
  /** Diamantes aportados por persona en la sesión. */
  gifts: RankingEntry[];
  /** Seguidores nuevos por persona en la sesión. */
  follows: RankingEntry[];
  /** Totales históricos; vacío si el ajuste está apagado. */
  lifetime: RankingEntry[];
  lifetimeEnabled: boolean;
  /** Los últimos regalos, del más reciente al más antiguo. */
  recientes: GiftEventView[];
  /** Resumen por tipo de regalo. */
  porTipo: GiftTypeSummary[];
  totalGifts: number;
  totalDiamonds: number;
  /** Abre el perfil de TikTok. En el overlay no se pasa. */
  onOpenProfile?: (uniqueId: string, nickname: string) => void;
}

export function Aportaciones({
  tap,
  gifts,
  follows,
  lifetime,
  lifetimeEnabled,
  recientes,
  porTipo,
  totalGifts,
  totalDiamonds,
  onOpenProfile,
}: Props) {
  const interactivo = onOpenProfile !== undefined;

  return (
    <div className="grid-panel">
      <p className="hint">{t.aportaciones.hint}</p>

      <div className="grid-columns">
        <Card title={t.aportaciones.tap}>
          <RankingTable
            entries={tap}
            valueLabel={t.aportaciones.value.taps}
            empty={t.aportaciones.empty}
            interactive={interactivo}
            onOpenProfile={onOpenProfile}
          />
          <p className="hint">{t.aportaciones.tapHint}</p>
        </Card>

        <Card title={t.aportaciones.gifts}>
          <RankingTable
            entries={gifts}
            valueLabel={t.aportaciones.value.diamonds}
            empty={t.aportaciones.empty}
            interactive={interactivo}
            onOpenProfile={onOpenProfile}
          />
          <p className="hint">{t.aportaciones.giftsHint}</p>
        </Card>

        <Card title={t.aportaciones.follows}>
          <RankingTable
            entries={follows}
            valueLabel={t.aportaciones.value.follows}
            empty={t.aportaciones.empty}
            interactive={interactivo}
            onOpenProfile={onOpenProfile}
          />
          <p className="hint">{t.aportaciones.followsHint}</p>
        </Card>
      </div>

      <div className="grid-columns">
        {/* El histórico solo se enseña si está activado: una tabla vacía con un
            aviso es más honesta que esconderla sin explicar por qué. */}
        <Card title={t.aportaciones.lifetime}>
          {lifetimeEnabled ? (
            <>
              <RankingTable
                entries={lifetime}
                valueLabel={t.aportaciones.value.lifetime}
                empty={t.aportaciones.empty}
                interactive={interactivo}
                onOpenProfile={onOpenProfile}
              />
              <p className="hint">{t.aportaciones.lifetimeHint}</p>
            </>
          ) : (
            <p className="hint">{t.aportaciones.lifetimeEmpty}</p>
          )}
        </Card>

        <Card title={t.aportaciones.porTipo}>
          {porTipo.length === 0 ? (
            <Empty>{t.aportaciones.none}</Empty>
          ) : (
            <ul className="ranking">
              {porTipo.map((gift) => (
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

      {/* El detalle, a lo ancho: es una lista larga y en columna se quedaría en
          un rincón con scroll propio. */}
      <Card title={t.aportaciones.recientes}>
        <p className="hint">{t.aportaciones.total(totalGifts, totalDiamonds)}</p>
        {recientes.length === 0 ? (
          <Empty>{t.aportaciones.none}</Empty>
        ) : (
          <ul className="feed gifts">
            {recientes.slice(0, RECIENTES).map((gift) => (
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
                    {gift.is_final ? t.aportaciones.streakFinal : t.aportaciones.streak}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
