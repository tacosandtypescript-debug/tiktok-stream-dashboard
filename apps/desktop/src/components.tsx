//! Piezas compartidas por las páginas: formateo y bloques de interfaz.
//!
//! Reglas de rendimiento (docs/plan-review.md §38): sin animaciones permanentes,
//! sin blur, sin sombras costosas. Todo es CSS plano y barato de pintar.

import type { ReactNode } from "react";

import type { FeedItem, FeedKind, UserRef } from "./api";
import { t } from "./i18n/es";

/** Nombre visible de un usuario: el apodo o, si no lo tiene, su @usuario. */
export function nickname(nickname: string, uniqueId: string): string {
  return nickname && nickname.trim().length > 0 ? nickname : `@${uniqueId}`;
}

export function userLabel(user: UserRef | undefined): string {
  if (!user) return t.feed.unknown;
  return nickname(user.nickname, user.unique_id);
}

/** Redacta una linea de actividad.
 *
 * Rust guarda los datos estructurados y la interfaz los redacta: asi los
 * textos viven solo en `i18n` (docs/decisions.md D4).
 */
export function feedText(item: FeedItem): string {
  switch (item.kind) {
    case "gift": {
      const gift = item.gift;
      if (!gift) return userLabel(item.user);
      const who = userLabel(item.user);
      const name = gift.name || t.feed.genericGift(gift.id);
      if (gift.streakable && !gift.is_final) {
        return t.feed.giftStreak(who, name, gift.repeat_count);
      }
      if (gift.repeat_count > 1) {
        return t.feed.giftMany(who, name, gift.repeat_count);
      }
      return t.feed.giftOne(who, name);
    }
    case "follow":
      return t.feed.follow(userLabel(item.user));
    case "share":
      return t.feed.share(userLabel(item.user));
    case "subscribe":
      return t.feed.subscribe(userLabel(item.user), item.months ?? 1);
    case "like": {
      const [count, total] = item.likes ?? [0, 0];
      return t.feed.likes(userLabel(item.user), count, total);
    }
    default:
      return item.detail ?? "";
  }
}

/** Numero corto y legible: 9.999 / 12,4 K / 1,2 M. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("es-CO", { maximumFractionDigits: 1 })} M`;
  }
  if (absolute >= 10_000) {
    return `${(value / 1_000).toLocaleString("es-CO", { maximumFractionDigits: 1 })} K`;
  }
  return value.toLocaleString("es-CO");
}

/** Duracion en formato corto: 45 s / 12 m 30 s / 1 h 04 m. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} h ${String(minutes).padStart(2, "0")} m`;
  }
  if (minutes > 0) {
    return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
  }
  return `${seconds} s`;
}

/** "hace 3 s", "hace 2 m". */
export function timeAgo(timestampMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestampMs) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} m`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours} h`;
}

export function formatClock(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const FEED_LABEL: Record<FeedKind, string> = {
  gift: "Regalo",
  follow: "Follow",
  share: "Share",
  subscribe: "Suscripción",
  like: "Likes",
  info: "Info",
};

/** Miniatura del regalo. Se carga en diferido y sin bloquear el pintado. */
export function GiftThumb({ url, name }: { url?: string; name: string }) {
  if (!url) return null;
  return (
    <img
      className="gift-thumb"
      src={url}
      alt={name}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}

export function FeedTag({ kind }: { kind: FeedKind }) {
  return <span className={`tag tag-${kind}`}>{FEED_LABEL[kind]}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Card({
  title,
  actions,
  children,
  grow = false,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  grow?: boolean;
}) {
  return (
    <section className={grow ? "card grow" : "card"}>
      {title || actions ? (
        <header className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** Fila de etiqueta y valor, para tablas de datos. */
export function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <table className="rows">
      <tbody>
        {rows.map(([label, value], index) => (
          <tr key={`${label}-${index}`}>
            <td className="rows-label">{label}</td>
            <td className="rows-value">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
