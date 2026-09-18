//! Piezas compartidas por las páginas: formateo y bloques de interfaz.
//!
//! Reglas de rendimiento (docs/plan-review.md §38): sin animaciones permanentes,
//! sin blur, sin sombras costosas. Todo es CSS plano y barato de pintar.

import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import type { ChatEntry, FeedItem, FeedKind, RankingEntry, UserRef } from "./api";
import { t } from "./i18n/es";

/** Nombre visible de un usuario: el apodo o, si no lo tiene, su @usuario. */
export function nickname(nickname: string, uniqueId: string): string {
  return nickname && nickname.trim().length > 0 ? nickname : `@${uniqueId}`;
}

/**
 * Texto visible de un comentario del chat.
 *
 * Dos casos que no son texto normal:
 *   * los mensajes que son **solo emote** llegan con `content` vacio y
 *     `emote_count > 0`: sin este rotulo se pintaba una linea en blanco;
 *   * un comentario borrado se rotula, **no** se quita de la lista: quitarlo
 *     perderia el hilo de la conversacion (y el hueco se nota igual).
 *
 * La redaccion vive en `i18n` (docs/decisions.md D4).
 */
export function chatText(entry: ChatEntry, deleted = false): string {
  if (deleted) return t.chat.deleted;
  if (entry.content.length > 0) return entry.content;
  const emotes = entry.emote_count ?? 0;
  return emotes > 0 ? t.chat.emotes(emotes) : t.chat.noText;
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

/**
 * La actividad de la sesión: regalos, follows, shares, suscripciones y las
 * ráfagas grandes de likes.
 *
 * Vive aquí y no dentro de una página porque la enseña el chat, a su lado, y
 * antes también el panel: dos copias del mismo `<li>` acaban pintando distinto en
 * cuanto alguien toca una.
 */
export function FeedList({
  items,
  now,
  empty = t.feed.empty,
}: {
  items: FeedItem[];
  now: number;
  /**
   * Que se dice cuando no hay nada. El estado vacio depende del panel —Inicio
   * parte el mismo feed en dos— y por eso se puede sustituir en vez de dejar el
   * texto de la actividad en un panel que no habla de regalos.
   */
  empty?: string;
}) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="feed">
      {items.map((item) => (
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
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * Tabla de aportación por persona: puesto, foto, nombre y una cifra.
 *
 * Se usa en el panel de rankings y en el overlay de OBS. Por eso el link y los
 * elementos de detalle son opcionales: **un Browser Source de OBS no gestiona
 * clics**, así que el overlay la usa en modo solo lectura (`interactive={false}`)
 * y el dashboard en modo normal.
 *
 * La foto lleva sustituto cuando falta: TikTok no siempre manda el avatar, y sin
 * reserva la columna se desalineaba (unas filas con imagen y otras sin nada).
 */
export function RankingTable({
  entries,
  valueLabel,
  empty,
  interactive = true,
  onOpenProfile,
  formatValue = formatNumber,
}: {
  entries: RankingEntry[];
  /** Rótulo de la columna de cifras ("Taps", "Diamantes"…). */
  valueLabel: string;
  empty: string;
  /** `false` en el overlay: sin enlaces ni `title` que dependan del puntero. */
  interactive?: boolean;
  onOpenProfile?: (uniqueId: string, nickname: string) => void;
  formatValue?: (value: number) => string;
}) {
  if (entries.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ol className="ranking board">
      {entries.map((entry, index) => {
        const nombre = nickname(entry.user.nickname, entry.user.unique_id);
        return (
          <li key={entry.user.id}>
            <span className="rank">{index + 1}</span>
            <RankAvatar user={entry.user} />
            {interactive && onOpenProfile ? (
              <button
                type="button"
                className="user"
                title={`${nombre} · abrir su perfil en TikTok`}
                onClick={() => onOpenProfile(entry.user.unique_id, nombre)}
              >
                {nombre}
              </button>
            ) : (
              <span className="user">{nombre}</span>
            )}
            <span className="rank-value" title={valueLabel}>
              {formatValue(entry.value)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Foto de perfil, con la inicial como sustituto.
 *
 * `referrerPolicy` y `loading` son los mismos que usa la miniatura de regalo: la
 * imagen es de un CDN ajeno y no debe frenar el pintado de la lista.
 */
export function RankAvatar({ user }: { user: UserRef }) {
  if (!user.avatar_url) {
    return (
      <span className="avatar avatar-vacio" aria-hidden="true">
        {(user.nickname || user.unique_id || "?").slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      src={user.avatar_url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
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

/**
 * Una dirección con su botón de copiar y confirmación efímera.
 *
 * Compartido por Overlays y Alertas: las dos enseñan direcciones que se pegan en
 * OBS, y dos copias del botón acabarían confirmando distinto.
 *
 * La confirmación va en el propio botón, no en un aviso arriba: la mirada está
 * ahí. Si el portapapeles falla se dice qué hacer, en vez de dejar la pulsación
 * sin respuesta.
 */
export function Copiar({ texto }: { texto: string | undefined }) {
  const [estado, setEstado] = useState<"listo" | "copiado" | "fallo">("listo");

  const copiar = useCallback(() => {
    if (!texto) return;
    // El portapapeles puede no existir (contexto no seguro) o negarse.
    const portapapeles = navigator.clipboard;
    if (!portapapeles) {
      setEstado("fallo");
      return;
    }
    portapapeles
      .writeText(texto)
      .then(() => {
        setEstado("copiado");
        window.setTimeout(() => setEstado("listo"), 1600);
      })
      .catch(() => setEstado("fallo"));
  }, [texto]);

  if (!texto) return <span className="empty">—</span>;

  return (
    <span className="copiar">
      <code className="path">{texto}</code>
      <button
        type="button"
        className="ghost"
        title={estado === "fallo" ? t.overlay.copyHint : undefined}
        onClick={copiar}
      >
        {estado === "copiado"
          ? t.overlay.copied
          : estado === "fallo"
            ? t.overlay.copyFail
            : t.overlay.copy}
      </button>
    </span>
  );
}
