//! Piezas compartidas por las páginas: formateo y bloques de interfaz.
//!
//! Reglas de rendimiento (docs/plan-review.md §38): sin animaciones permanentes,
//! sin blur, sin sombras costosas. Todo es CSS plano y barato de pintar.

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ChatEntry,
  FeedItem,
  FeedKind,
  GiftInfo,
  RankingEntry,
  UserRef,
} from "./api";
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

/**
 * Redacta un combo ya agrupado.
 *
 * Es `feedText` para una racha que crece: por eso el texto y el numero de
 * unidades viven en nodos distintos (`GiftCard`), y asi el numero se puede
 * resaltar sin partir la frase. Se decide por `is_final` del ultimo suceso
 * agrupado y no por el valor de la racha: la racha la cierra el motor, no la
 * interfaz.
 */
export function comboText(gift: GiftInfo, who: string): string {
  const name = gift.name || t.feed.genericGift(gift.id);
  const units = giftUnits(gift);
  if (gift.streakable) {
    return gift.is_final
      ? t.feed.giftMany(who, name, units)
      : t.feed.giftStreak(who, name, units);
  }
  return units > 1 ? t.feed.giftMany(who, name, units) : t.feed.giftOne(who, name);
}

/**
 * Unidades que representa un suceso de regalo.
 *
 * `repeat_count` es un **incremento** y puede llegar a cero en un regalo no
 * acumulable (docs/decisions.md D14): un cero pintado seria un regalo que no
 * existe, asi que vale una unidad.
 */
export function giftUnits(gift: GiftInfo): number {
  return gift.repeat_count > 0 ? gift.repeat_count : 1;
}

/**
 * Diamantes que vale un combo ya agrupado.
 *
 * Es el valor unitario que manda el motor por las unidades de la racha. No se
 * recalcula ningun valor de regalo: `diamond_count` es el del motor y las
 * unidades son la suma de sus incrementos (docs/decisions.md D14).
 */
export function comboDiamonds(gift: GiftInfo): number {
  return gift.diamond_count * giftUnits(gift);
}

/**
 * Agrupa las rachas del feed y deja los demas sucesos como estaban.
 *
 * Los regalos **no acumulables** tambien se agrupan por `group_id`: TikTok manda
 * ahi el identificador del mensaje, asi que cada uno es su propio grupo y no se
 * pegan dos regalos distintos por compartir el `"0"` de los no acumulables.
 */
export function buildFeedView(items: FeedItem[]): FeedItem[] {
  const vistos = new Map<string, FeedItem>();
  const salida: FeedItem[] = [];
  for (const item of items) {
    const gift = item.gift;
    if (item.kind !== "gift" || !gift) {
      salida.push(item);
      continue;
    }
    const id = gift.group_id;
    if (id === undefined || id.length === 0) {
      salida.push(item);
      continue;
    }
    const acumulado = vistos.get(id);
    if (!acumulado || !acumulado.gift) {
      // El primer suceso de la racha marca el sitio: los siguientes crecen esa
      // misma entrada en vez de apilar lineas nuevas.
      const copia: FeedItem = { ...item, gift: { ...gift } };
      vistos.set(id, copia);
      salida.push(copia);
      continue;
    }
    const previo = acumulado.gift;
    acumulado.gift = {
      ...previo,
      repeat_count: previo.repeat_count + (gift.repeat_count > 0 ? gift.repeat_count : 1),
      is_final: gift.is_final,
    };
  }
  return salida;
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

/**
 * La hora, en **24 horas y sin el «p. m.»**.
 *
 * Ya no la usa la actividad —las horas se quitaron de Inicio— pero si el flujo de
 * «Últimos regalos» de Aportaciones, que es un registro y ahí el instante sí es el
 * dato. Se queda en 24 horas por lo mismo que entonces: `11:13 p. m.` son once
 * caracteres y no caben en una columna estrecha, y `23:13` son cinco.
 */
export function formatClock(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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

/**
 * Miniatura del regalo, en diferido y sin bloquear el pintado.
 *
 * Si el regalo viene **sin icono**, la celda desaparece con ella y la frase no
 * arranca con un hueco: eso ya estaba decidido y se respeta.
 *
 * Lo que faltaba es el otro caso, el del icono que **falla**: cuando la direccion
 * existe pero el CDN de TikTok no la sirve —o se cae la red—, el `<img>` se pintaba
 * roto. No es un hueco: es el cuadro con el icono de imagen partida en mitad de la
 * fila, que se lee como que la aplicacion esta mal. Ahora se recuerda el fallo por
 * direccion, igual que en la foto de perfil, y la celda se va con el.
 */
export function GiftThumb({ url, name }: { url?: string; name: string }) {
  const [fallida, setFallida] = useState<string | undefined>(undefined);
  if (!url || url === fallida) return null;
  return (
    <img
      className="gift-thumb"
      src={url}
      alt={name}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFallida(url)}
    />
  );
}

export function FeedTag({ kind }: { kind: FeedKind }) {
  return <span className={`tag tag-${kind}`}>{FEED_LABEL[kind]}</span>;
}

/** Cuanto dura el realce del combo grande. Es lo que dura su animacion. */
const DESTACADO_MS = 1800;

/**
 * Si el combo que acaba de cambiar merece un realce momentaneo.
 *
 * El umbral no es decorativo: si se destacara una rosa suelta, el realce saldria
 * cada pocos segundos y dejaria de significar nada. Se destacan las rachas largas
 * y los regalos caros, que son las dos cosas que se miran de reojo.
 *
 * Los dos numeros son **politica de interfaz** y siguen la que ya usa el motor
 * para lo notable: una rafaga de likes entra en el feed a partir de diez
 * (`feed::like_is_notable`). Aqui no entra un combo de cuatro regalos, que es una
 * traca cualquiera, y si uno de mil diamantes, que es dinero.
 */
const COMBO_UNIDADES_DESTACADAS = 10;
const COMBO_DIAMANTES_DESTACADOS = 200;

export function comboDestacado(gift: GiftInfo): boolean {
  return (
    giftUnits(gift) >= COMBO_UNIDADES_DESTACADAS ||
    comboDiamonds(gift) >= COMBO_DIAMANTES_DESTACADOS
  );
}

/**
 * Enciende el realce al cambiar el suceso y lo apaga solo.
 *
 * El estado se apaga **al terminar la animacion**, no se deja puesto: una clase
 * que se queda encendida deja la animacion corriendo para siempre en la lista,
 * que es justo lo que prohibe el plan (docs/plan-review.md §38). Y si el suceso
 * cambia mientras el realce esta puesto (la racha crece), el temporizador se
 * reinicia: el realce acompana al ultimo incremento.
 */
function useDestacado(seq: number): boolean {
  const [destacado, setDestacado] = useState(false);
  const primero = useRef(true);
  useEffect(() => {
    // Al montar no se realza nada: si no, al abrir la pestana se encenderian de
    // golpe todos los combos grandes de la lista.
    if (primero.current) {
      primero.current = false;
      return;
    }
    setDestacado(true);
    const timer = window.setTimeout(() => setDestacado(false), DESTACADO_MS);
    return () => window.clearTimeout(timer);
  }, [seq]);
  return destacado;
}

/**
 * Un regalo de la actividad: foto de quien lo manda, imagen del regalo, su
 * nombre y la cantidad.
 *
 * Es la **tarjeta** del regalo y a la vez el combo: la racha entera vive en esta
 * misma fila y crece en el sitio (cuando la entrada se agrupa en
 * `buildFeedView`, React reusa el nodo y solo cambia el numero). No se apila una
 * linea por incremento.
 *
 * Sin hora. La llevaba —`23:23`— y se ha quitado de toda la actividad: el panel
 * enseña lo que acaba de pasar, y para eso el orden de la lista ya lo dice todo.
 * Ocupaba una columna entera de la rejilla en cada fila y el dato no se usaba.
 */
function GiftCard({ item }: { item: FeedItem }) {
  const gift = item.gift;
  if (!gift) return null;
  const destacado = useDestacado(item.seq) && comboDestacado(gift);
  const diamonds = t.feed.comboValue(comboDiamonds(gift));
  return (
    <li className={destacado ? "destacado" : undefined}>
      <FeedTag kind={item.kind} />
      {/* La foto de quien lo manda y la imagen del regalo, en la **misma** celda:
          separarlas anadia una columna y la fila pedia mas ancho del que hay. */}
      <span className="feed-user">
        <Avatar user={item.user} size="chico" />
        <span className="feed-sello">
          <GiftThumb url={gift.image_url} name={gift.name} />
        </span>
      </span>
      <span className="feed-texto">
        <span className="feed-text">{comboText(gift, userLabel(item.user))}</span>
        <span className="feed-value" title={diamonds}>
          {diamonds}
        </span>
      </span>
    </li>
  );
}

/**
 * La actividad de la sesión: regalos, follows, shares, suscripciones y las
 * ráfagas grandes de likes.
 *
 * Vive aquí y no dentro de una página porque la enseña el chat, a su lado, y
 * antes también el panel: dos copias del mismo `<li>` acaban pintando distinto en
 * cuanto alguien toca una.
 *
 * El feed que entra ya viene agrupado por rachas (`buildFeedView`): aqui se pinta
 * lo que llega, no se agrupa nada.
 */
export function FeedList({
  items,
  empty = t.feed.empty,
}: {
  items: FeedItem[];
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
      {items.map((item) =>
        item.kind === "gift" && item.gift ? (
          <GiftCard key={item.seq} item={item} />
        ) : (
          <li key={item.seq}>
            <FeedTag kind={item.kind} />
            {/* Quien lo hizo, en celda propia **igual que en los regalos**: asi
                todas las filas de la actividad tienen la misma forma —rotulo,
                quien, que— y la rejilla es una sola en los cinco paneles. Antes la
                foto iba dentro de la frase para no gastar una columna, pero esa
                columna ya la ocupaba la hora, que es la que se ha ido. Un aviso
                tecnico no trae usuario y la celda queda vacia, que es lo correcto:
                no hay nadie a quien ponerle cara. */}
            <span className="feed-user">
              <Avatar user={item.user} size="chico" />
            </span>
            <span className="feed-texto">
              <span className="feed-text">{feedText(item)}</span>
            </span>
          </li>
        ),
      )}
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
 * Un solo componente para las tres fotos de la interfaz (tablas, actividad y
 * chat): antes cada sitio la pintaba a su manera y solo uno de ellos tenia
 * respaldo, asi que una foto que no cargaba dejaba un hueco roto en el chat y en
 * la actividad.
 *
 * `referrerPolicy` y `loading` son los mismos que usa la miniatura de regalo: la
 * imagen es de un CDN ajeno y no debe frenar el pintado de la lista.
 *
 * El fallo se recuerda **por direccion**, no con un simple «fallo»: si la persona
 * cambia de foto, la direccion es otra y el error anterior no le corresponde.
 */
export function Avatar({
  user,
  size = "normal",
}: {
  user: UserRef | undefined;
  /** `chico` para el chat y la actividad, donde la fila mide 30 px. */
  size?: "normal" | "chico";
}) {
  const [fallida, setFallida] = useState<string | undefined>(undefined);
  const url = user?.avatar_url;
  const inicial = (user?.nickname || user?.unique_id || "?").slice(0, 1).toUpperCase();
  const clase = size === "chico" ? "avatar avatar-chico" : "avatar";
  if (!url || url === fallida) {
    return (
      <span className={`${clase} avatar-vacio`} aria-hidden="true">
        {inicial}
      </span>
    );
  }
  return (
    <img
      className={clase}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFallida(url)}
    />
  );
}

/** La foto de una fila de tabla, con su celda de ancho fijo. */
export function RankAvatar({ user }: { user: UserRef }) {
  return <Avatar user={user} />;
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
