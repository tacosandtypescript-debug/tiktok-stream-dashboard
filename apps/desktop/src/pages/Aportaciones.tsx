//! Aportaciones: quién sostiene el directo y qué ha caído.
//!
//! Antes eran dos páginas —Regalos y Rankings— y la misma pregunta («quién ha
//! dado más diamantes») se contestaba en tres sitios, con dos componentes
//! distintos y dos formas distintas del mismo dato: la tabla del panel y la de
//! Regalos no llevaban foto ni enlace al perfil, y la de Rankings sí. Aquí vive
//! **una vez**, y con el componente que ya comparten el panel y el overlay
//! (`RankingTable`), así que los tres no pueden divergir.
//!
//! Reparto: **cuatro columnas por dos filas**, que es lo que cabe con la ventana
//! en 1440x900 sin desplazar la página. Arriba las **cuatro tablas de personas**
//! —tap tap, regalos, seguidores y el histórico—, que son la misma pregunta con
//! distinto reloj; abajo el resumen **por tipo de regalo** y el **flujo de los
//! últimos regalos**, que es lo que se mira de reojo. Cada panel se desplaza por
//! dentro, así que una noche con cien regalos no empuja la página: llena su panel.

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
  /** Mientras el motor confirma el cambio, el interruptor no acepta más pulsaciones. */
  lifetimeBusy: boolean;
  /** Cambia el ajuste; quien lo guarda y revierte si falla es `App`. */
  onLifetimeChange: (enabled: boolean) => void;
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
  lifetimeBusy,
  onLifetimeChange,
  recientes,
  porTipo,
  totalGifts,
  totalDiamonds,
  onOpenProfile,
}: Props) {
  const interactivo = onOpenProfile !== undefined;

  return (
    <div className="grid-panel aportaciones">
      <p className="hint">{t.aportaciones.hint}</p>

      {/* Las seis tarjetas, colocadas una a una en `styles.css`. El orden del
          marcado tiene que ser este: Tap tap, Regalos, Seguidores, Histórico,
          Por tipo y Últimos regalos. Es el mismo criterio que en Inicio, donde los
          `grid-area` también van declarados para que el reparto no dependa de que
          nadie reordene el JSX sin querer. */}
      <div className="aportaciones-rejilla">
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

        {/* El histórico con **su interruptor dentro**. El ajuste vivía en la página
            de Voz —«es la página de ajustes operativos»— y el aviso de la tabla
            mandaba al streamer a otra pestaña para encender lo que estaba mirando.
            Ahora se cambia y se ve en el mismo sitio, que es la regla 3 del
            contrato. Sigue guardándolo `App`: aquí solo se pinta el interruptor.

            Dentro y no en la cabecera: probado en `actions`, a los 303 px que mide
            esta columna el rótulo «Histórico» y el texto del interruptor no caben en
            la misma línea, la cabecera se parte en dos y la tabla pierde 6 px más de
            los que ya le faltaban. */}
        <Card title={t.aportaciones.lifetime}>
          {/* La explicación larga va en el `title` y no en un párrafo debajo: el
              panel mide 363 px y la tabla de ocho personas ya los llena, así que dos
              líneas más de texto dejarían fuera la octava. Al pasar el ratón se lee
              entera. */}
          <label className="switch" title={t.aportaciones.toggleHint}>
            <input
              type="checkbox"
              checked={lifetimeEnabled}
              disabled={lifetimeBusy}
              onChange={(event) => onLifetimeChange(event.target.checked)}
            />
            <span>{t.aportaciones.toggle}</span>
          </label>
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

        {/* El flujo, ancho: es una lista de seis columnas por fila y en una sola
            columna de 300 px se quedaría en un rincón ilegible. Por eso ocupa las
            tres columnas que sobran de la fila de abajo. */}
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
    </div>
  );
}
