import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  onDashEvent,
  type ChatEntry,
  type FeedItem,
  type GiftEventView,
  type GifterEntry,
  type GiftTypeSummary,
  type Metrics,
  type Snapshot,
  type WireEvent,
} from "./api";
import { formatNumber } from "./components";
import { t } from "./i18n/es";
import { Chat } from "./pages/Chat";
import { Developer } from "./pages/Developer";
import { Gifts } from "./pages/Gifts";
import { Panel, type Totals } from "./pages/Panel";
import { Tts } from "./pages/Tts";

type Tab = "panel" | "chat" | "gifts" | "tts" | "developer";

/** Mensajes que se conservan en memoria de la interfaz. */
const CHAT_WINDOW = 400;
/** Regalos recientes que se conservan para el resumen local. */
const GIFT_WINDOW = 200;
/** Actividad que se conserva en memoria de la interfaz. */
const FEED_WINDOW = 150;
/**
 * Solo las rafagas grandes de likes aparecen en la actividad. Es la misma
 * politica que aplica Rust (`feed::like_is_notable`).
 */
const LIKE_FEED_THRESHOLD = 10;

const EMPTY_TOTALS: Totals = {
  viewers: 0,
  cumulativeViewers: 0,
  likes: 0,
  gifts: 0,
  diamonds: 0,
  comments: 0,
  follows: 0,
};

/**
 * Tipos de evento que la interfaz sabe pintar.
 *
 * Si llega uno que no está aquí se reporta a Rust como `sin_manejar:<tipo>`:
 * así un evento nuevo de TikTok no se pierde en silencio, queda en el log y en
 * el panel de diagnóstico.
 */
const HANDLED_TYPES = new Set([
  "provider.status",
  "stream.connected",
  "stream.disconnected",
  "stream.waiting",
  "chat.message",
  "gift.received",
  "like.updated",
  "viewer.updated",
  "follow.received",
  "share.received",
  "subscribe.received",
  "gifts.updated",
]);

/** Cada cuánto se informa a Rust de lo reconocido (sin temporizadores propios). */
const REPORT_INTERVAL_MS = 2000;

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState("stopped");
  const [detail, setDetail] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [gifts, setGifts] = useState<GiftEventView[]>([]);
  /** Agregados de regalos calculados por Rust (no se recalculan aqui). */
  const [topGifters, setTopGifters] = useState<GifterEntry[]>([]);
  const [giftsByType, setGiftsByType] = useState<GiftTypeSummary[]>([]);
  const [totals, setTotals] = useState<Totals>(EMPTY_TOTALS);
  const [tab, setTab] = useState<Tab>("panel");
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Métricas en vivo de la página Developer (solo se sondea con esa pestaña abierta). */
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  /**
   * Estados en los que el motor ya tiene una sesión en curso.
   *
   * Sin esto el botón Conectar seguía activo y rotulado «Conectar» mientras
   * reconectaba: pulsarlo mataba el supervisor, reiniciaba el backoff y gastaba
   * cuota de firma antes de tiempo.
   */
  const sessionBusy =
    status === "starting" ||
    status === "connecting" ||
    status === "connected" ||
    status === "reconnecting" ||
    status === "waiting_for_live";

  const totalsRef = useRef(totals);
  totalsRef.current = totals;
  /** Eventos reconocidos desde el último informe a Rust. */
  const seenRef = useRef<Record<string, number>>({});
  const lastReportRef = useRef(0);
  const sessionActive = snapshot?.started_at_ms != null && status !== "stopped";

  /**
   * Fusiona una foto del motor con lo que ya se ha pintado en vivo.
   *
   * El snapshot se construye en Rust antes de que el invoke resuelva, así que
   * puede ser **más viejo** que los eventos ya aplicados. Reemplazar a ciegas
   * hacía desaparecer mensajes recién llegados (y volver a aparecer al pulsar
   * Conectar). Se conserva lo que tenga `seq` mayor que la foto.
   */
  const mergeSnapshot = useCallback(
    <T extends { seq: number }>(previous: T[], incoming: T[], window: number, newestFirst: boolean) => {
      const ultimo = incoming.length > 0 ? (newestFirst ? incoming[0].seq : incoming[incoming.length - 1].seq) : 0;
      const vistos = new Set(incoming.map((item) => item.seq));
      const masNuevos = previous.filter((item) => item.seq > ultimo && !vistos.has(item.seq));
      const merged = newestFirst ? [...masNuevos, ...incoming] : [...incoming, ...masNuevos];
      return merged.length > window ? (newestFirst ? merged.slice(0, window) : merged.slice(merged.length - window)) : merged;
    },
    [],
  );

  const applySnapshot = useCallback((next: Snapshot) => {
    setSnapshot(next);
    setStatus(next.status);
    setDetail(null);
    // Fusionado, no reemplazo: ver `mergeSnapshot`.
    setChat((previous) => mergeSnapshot(previous, next.chat, CHAT_WINDOW, false));
    setFeed((previous) => mergeSnapshot(previous, next.events, FEED_WINDOW, true));
    setGifts((previous) => mergeSnapshot(previous, next.gifts, GIFT_WINDOW, true));
    // Los agregados vienen calculados del motor: la interfaz no los recalcula,
    // asi la contabilidad de rachas vive en un solo sitio.
    setTopGifters(next.top_gifters);
    setGiftsByType(next.gifts_by_type);
    setTotals({
      // Los espectadores solo llegan por eventos: hasta el primero, se desconoce.
      viewers: totalsRef.current.viewers,
      cumulativeViewers: totalsRef.current.cumulativeViewers,
      likes: next.metrics.likes_total,
      gifts: next.total_gifts,
      diamonds: next.total_diamonds,
      comments: next.metrics.chat_messages,
      follows: next.metrics.follows,
    });
  }, [mergeSnapshot]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let announced = false;

    // Se escucha ANTES de pedir la foto del motor: al revés, los eventos
    // publicados mientras el invoke resuelve no llegarían nunca (Tauri no los
    // reproduce) y el chat parecería perder mensajes.
    onDashEvent((event: WireEvent) => {
      // La primera vez se avisa a Rust: deja constancia en el log de que el flujo
      // en vivo funciona, sin necesidad de mirar la pantalla.
      if (!announced) {
        announced = true;
        void api.uiReceiving().catch(() => undefined);
      }

      const pushFeed = (item: FeedItem) => {
        setFeed((previous) => {
          const next = [item, ...previous];
          return next.length > FEED_WINDOW ? next.slice(0, FEED_WINDOW) : next;
        });
      };

      // Recuento de lo pintado: se envia a Rust como mucho cada 2 s, usando el
      // propio flujo de eventos como reloj (sin temporizadores ociosos).
      seenRef.current[event.type] = (seenRef.current[event.type] ?? 0) + 1;
      if (!HANDLED_TYPES.has(event.type)) {
        const clave = `sin_manejar:${event.type}`;
        seenRef.current[clave] = (seenRef.current[clave] ?? 0) + 1;
      }
      const ahora = Date.now();
      if (ahora - lastReportRef.current >= REPORT_INTERVAL_MS) {
        lastReportRef.current = ahora;
        const pendiente = seenRef.current;
        seenRef.current = {};
        if (Object.keys(pendiente).length > 0) {
          void api.uiEvents(pendiente).catch(() => undefined);
        }
      }

      switch (event.type) {
        case "provider.status":
          setStatus(event.status);
          setDetail(event.detail ?? null);
          if (event.status === "error") {
            pushFeed({
              seq: event.seq,
              timestamp_ms: event.timestamp_ms,
              kind: "info",
              detail: `error de conexión · ${event.detail ?? "sin detalle"}`,
            });
          }
          break;
        case "stream.connected":
          setDetail(event.title);
          setSnapshot((previous) =>
            previous
              ? { ...previous, started_at_ms: event.timestamp_ms, room_id: event.room_id }
              : previous,
          );
          pushFeed({
            seq: event.seq,
            timestamp_ms: event.timestamp_ms,
            kind: "info",
            detail: `conectado a la sala ${event.room_id}`,
          });
          break;
        case "stream.disconnected":
          setSnapshot((previous) =>
            previous ? { ...previous, started_at_ms: null } : previous,
          );
          pushFeed({
            seq: event.seq,
            timestamp_ms: event.timestamp_ms,
            kind: "info",
            detail: `conexión cerrada · ${event.reason}`,
          });
          break;
        case "stream.waiting":
          // El motor sigue sondeando sin gastar cuota: el motivo se ve en la
          // cabecera (el feed ya lo escribe Rust, aquí no se duplica).
          setDetail(event.detail);
          break;
        case "chat.message":
          setChat((previous) => {
            const entry: ChatEntry = {
              seq: event.seq,
              timestamp_ms: event.timestamp_ms,
              user: event.user,
              content: event.content,
              source_id: event.source_id,
            };
            const next = [...previous, entry];
            return next.length > CHAT_WINDOW ? next.slice(next.length - CHAT_WINDOW) : next;
          });
          setTotals((previous) => ({ ...previous, comments: previous.comments + 1 }));
          // Diagnóstico temporal: deja constancia de que ESTE mensaje llegó aquí.
          void api.uiChat({ received_seq: event.seq }).catch(() => undefined);
          break;
        case "gift.received":
          pushFeed({
            seq: event.seq,
            timestamp_ms: event.timestamp_ms,
            kind: "gift",
            user: event.user,
            gift: event.gift,
          });
          setGifts((previous) => {
            const entry: GiftEventView = {
              seq: event.seq,
              timestamp_ms: event.timestamp_ms,
              user: event.user,
              gift_id: event.gift.id,
              gift_name: event.gift.name,
              image_url: event.gift.image_url,
              repeat_count: event.gift.repeat_count,
              diamond_count: event.gift.diamond_count,
              streakable: event.gift.streakable,
              is_final: event.gift.is_final,
              group_id: event.gift.group_id,
            };
            const next = [entry, ...previous];
            return next.length > GIFT_WINDOW ? next.slice(0, GIFT_WINDOW) : next;
          });
          break;
        case "gifts.updated":
          // Agregados ya calculados por Rust (coalescidos a 1/s).
          setTopGifters(event.top_gifters);
          setGiftsByType(event.gifts_by_type);
          setTotals((previous) => ({
            ...previous,
            gifts: event.total_gifts,
            diamonds: event.total_diamonds,
          }));
          break;
        case "like.updated":
          setTotals((previous) => ({ ...previous, likes: event.total }));
          if (event.count >= LIKE_FEED_THRESHOLD) {
            pushFeed({
              seq: event.seq,
              timestamp_ms: event.timestamp_ms,
              kind: "like",
              user: event.user ?? undefined,
              likes: [event.count, event.total],
            });
          }
          break;
        case "viewer.updated":
          setTotals((previous) => ({
            ...previous,
            viewers: event.current,
            cumulativeViewers: event.cumulative,
          }));
          break;
        case "follow.received":
          setTotals((previous) => ({ ...previous, follows: previous.follows + 1 }));
          pushFeed({
            seq: event.seq,
            timestamp_ms: event.timestamp_ms,
            kind: "follow",
            user: event.user,
          });
          break;
        case "share.received":
          pushFeed({
            seq: event.seq,
            timestamp_ms: event.timestamp_ms,
            kind: "share",
            user: event.user,
          });
          break;
        case "subscribe.received":
          pushFeed({
            seq: event.seq,
            timestamp_ms: event.timestamp_ms,
            kind: "subscribe",
            user: event.user,
            months: event.months,
          });
          break;
        default:
          break;
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause: unknown) => setError(String(cause)));

    // La foto llega después de empezar a escuchar; `applySnapshot` la fusiona
    // con lo que ya haya entrado en vivo en vez de reemplazarlo.
    api
      .snapshot()
      .then((initial) => {
        if (!cancelled) {
          applySnapshot(initial);
          setHandle(initial.handle);
        }
      })
      .catch((cause: unknown) => setError(String(cause)));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applySnapshot]);

  // Reloj de la sesion: un ticker de 1 s **solo mientras hay conexion**, para
  // poder mostrar la duracion. Se detiene al desconectar.
  useEffect(() => {
    if (!sessionActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sessionActive]);

  // Diagnóstico temporal del chat. Comprueba los dos últimos eslabones que no se
  // pueden ver desde Rust: si React llegó a repintar la lista y **quién** la
  // desplaza de verdad (la propia lista o el contenedor de la página).
  //
  // Solo cuenta como «pintado» si hay una lista montada: si el usuario está en
  // otra pestaña no hay nada que pintar, y contarlo invalidaba el aviso de
  // «recibe mensajes pero no renderiza ninguna lista».
  useEffect(() => {
    if (chat.length === 0) return;
    const pagina = document.querySelector<HTMLElement>("main");
    const listas = Array.from(document.querySelectorAll<HTMLElement>("ul.chat"));
    const dom =
      `tab=${tab} ` +
      (listas.length === 0
        ? "sin lista montada"
        : listas
            .map((lista) => {
              const desborda = lista.scrollHeight > lista.clientHeight + 2;
              const alFinal =
                lista.scrollHeight - lista.clientHeight - Math.round(lista.scrollTop) < 8;
              const nombre = lista.classList.contains("compact") ? "ul.chat.compact" : "ul.chat";
              return (
                `${nombre} ${lista.clientHeight}/${lista.scrollHeight} top=${Math.round(lista.scrollTop)}` +
                ` desborda=${desborda ? "si" : "no"} alFinal=${alFinal ? "si" : "no"}`
              );
            })
            .join(" | ") +
          (pagina
            ? ` || main ${pagina.clientHeight}/${pagina.scrollHeight} top=${Math.round(pagina.scrollTop)}`
            : ""));
    void api
      .uiChat({
        ...(listas.length > 0
          ? { rendered_len: chat.length, rendered_seq: chat[chat.length - 1]?.seq }
          : {}),
        dom,
      })
      .catch(() => undefined);
  }, [chat, tab]);

  // La página Developer enseña contadores del motor: sin este sondeo se quedaba
  // congelada con la foto del arranque (y `api.metrics` no se usaba en ningún
  // sitio). Solo late mientras esa pestaña está abierta.
  useEffect(() => {
    if (tab !== "developer") return;
    let active = true;
    const tick = () => {
      void api
        .metrics()
        .then((next) => {
          if (active) setMetrics(next);
        })
        .catch(() => undefined);
      void api
        .snapshot()
        .then((next) => {
          if (active) applySnapshot(next);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [tab, applySnapshot]);

  const run = useCallback(
    async (action: () => Promise<Snapshot>) => {
      setBusy(true);
      setError(null);
      try {
        applySnapshot(await action());
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applySnapshot],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`dot dot-${status}`} />
          <h1>{t.appName}</h1>
        </div>

        <form
          className="connect"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => api.connect(handle));
          }}
        >
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder={t.connect.placeholder}
            spellCheck={false}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || sessionBusy || handle.trim().length === 0}
            title={sessionBusy ? t.connect.activeHint : undefined}
          >
            {busy || status === "starting" || status === "connecting"
              ? t.connect.connecting
              : t.connect.button}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy || status === "stopped"}
            onClick={() => void run(() => api.disconnect())}
          >
            {t.connect.disconnect}
          </button>
        </form>

        <div className="status-box">
          <strong>{t.status[status] ?? status}</strong>
          {/* El motivo se muestra siempre: antes quedaba oculto en cuanto había
              un handle, así que un error o una espera no se veían. */}
          <span title={detail ?? undefined}>
            {[snapshot?.handle ? `@${snapshot.handle}` : "", detail ?? ""]
              .filter((part) => part.length > 0)
              .join(" · ")}
          </span>
        </div>
      </header>

      <div className="body">
        <nav className="sidebar">
          {(Object.keys(t.nav) as Tab[]).map((key) => (
            <button
              key={key}
              type="button"
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {t.nav[key]}
            </button>
          ))}
        </nav>

        <main>
          {error ? <div className="error">{error}</div> : null}

          {tab === "panel" ? (
            <Panel
              snapshot={snapshot}
              status={status}
              detail={detail}
              chat={chat}
              feed={feed}
              topGifters={topGifters}
              giftsByType={giftsByType}
              totals={totals}
              now={now}
            />
          ) : null}

          {tab === "chat" ? (
            <Chat
              chat={chat}
              onClear={() => {
                void api.clearChat();
                setChat([]);
              }}
            />
          ) : null}

          {tab === "gifts" ? (
            <Gifts
              gifts={gifts}
              topGifters={topGifters}
              byType={giftsByType}
              totalGifts={totals.gifts}
              totalDiamonds={totals.diamonds}
            />
          ) : null}

          {tab === "tts" ? <Tts initial={snapshot?.tts ?? null} /> : null}

          {tab === "developer" ? (
            <Developer
              snapshot={snapshot}
              metrics={metrics ?? snapshot?.metrics ?? null}
              busy={busy}
              onSimulate={() => void run(() => api.simulate("simulado"))}
              onNative={() => void run(() => api.useNativeProvider())}
              onClearFeed={() => {
                void api.clearFeed();
                setFeed([]);
              }}
            />
          ) : null}
        </main>
      </div>

      <footer className="stats">
        <Stat label={t.stats.viewers} value={formatNumber(totals.viewers)} />
        <Stat label={t.stats.likes} value={formatNumber(totals.likes)} />
        <Stat label={t.stats.gifts} value={formatNumber(totals.gifts)} />
        <Stat label={t.stats.diamonds} value={formatNumber(totals.diamonds)} />
        <Stat label={t.stats.comments} value={formatNumber(totals.comments)} />
        <Stat label={t.stats.follows} value={formatNumber(totals.follows)} />
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
