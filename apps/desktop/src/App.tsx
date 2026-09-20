import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  onDashEvent,
  type AjustesAlertas,
  type ChatEntry,
  type FeedItem,
  type GiftEventView,
  type GiftTypeSummary,
  type Metrics,
  type Perfil,
  type RankingEntry,
  type Snapshot,
  type WireEvent,
} from "./api";
import { formatDuration, formatNumber } from "./components";
import { t } from "./i18n/es";
import { Aportaciones } from "./pages/Aportaciones";
import { Alertas } from "./pages/Alertas";
import { Chat } from "./pages/Chat";
import { Developer } from "./pages/Developer";
import { Overlays } from "./pages/Overlays";
import { Tts } from "./pages/Tts";

/**
 * Las pestañas del panel.
 *
 * Cuatro, y no siete: `panel` era la union de chat y regalos —con las versiones
 * peores de cada uno—, `gifts` y `rankings` contestaban la misma pregunta con dos
 * componentes distintos, y `developer` es una herramienta, no una pagina del
 * directo: ahora es un boton de la cabecera.
 */
type Tab = "chat" | "aportaciones" | "alertas" | "overlays" | "tts" | "developer";

/**
 * Las pestañas que van en la barra: todas menos diagnóstico, que es un botón.
 *
 * Se declara aparte para que el compilador no deje iterar `t.nav` como si tuviera
 * todas las pestañas: con el tipo ancho, `t.nav["developer"]` compilaba y salía un
 * botón sin rótulo.
 */
type Pestana = Exclude<Tab, "developer">;

/**
 * Contadores de la sesión que la interfaz lleva ella misma.
 *
 * Los que llegan por evento (espectadores, entradas) no están en la foto del
 * motor, así que se acumulan aquí; los que sí (likes, regalos, diamantes,
 * comentarios, follows) se toman del snapshot y nunca retroceden. Vivía en la
 * página del panel, que ya no existe.
 */
export interface Totals {
  viewers: number;
  cumulativeViewers: number;
  likes: number;
  gifts: number;
  diamonds: number;
  comments: number;
  follows: number;
  joined: number;
}

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
/**
 * Mensajes borrados que la interfaz recuerda.
 *
 * Se guardan **aparte** del chat y no marcando la entrada, por dos motivos: una
 * foto del motor (`applySnapshot`) puede reemplazar la entrada y perderia la
 * marca, y el chat se recorta a `CHAT_WINDOW` mientras que el borrado puede
 * llegar despues. El conjunto va acotado: los borrados son raros, y cuando el
 * mensaje ya ha salido de la ventana su marca deja de hacer falta.
 */
const DELETED_WINDOW = 512;

const EMPTY_TOTALS: Totals = {
  viewers: 0,
  cumulativeViewers: 0,
  likes: 0,
  gifts: 0,
  diamonds: 0,
  comments: 0,
  follows: 0,
  joined: 0,
};

/**
 * Los ajustes de alertas mientras el motor no ha dicho nada.
 *
 * Todo apagado y sin texto: la página se pinta igual y no inventa una
 * configuración que el motor no tiene. En cuanto llega la primera foto, se
 * sustituyen por los de verdad.
 */
const ALERTAS_VACIAS: AjustesAlertas = {
  gift: { activo: false, texto: "", medio: "", sonido: "", duracion_ms: 5000, volumen: 0.8, minimo: 0 },
  gift_grande: { activo: false, texto: "", medio: "", sonido: "", duracion_ms: 6000, volumen: 0.85, minimo: 0 },
  gift_enorme: { activo: false, texto: "", medio: "", sonido: "", duracion_ms: 8000, volumen: 0.9, minimo: 0 },
  follow: { activo: false, texto: "", medio: "", sonido: "", duracion_ms: 4000, volumen: 0.8, minimo: 0 },
  subscribe: { activo: false, texto: "", medio: "", sonido: "", duracion_ms: 5000, volumen: 0.8, minimo: 0 },
  share: { activo: false, texto: "", medio: "", sonido: "", duracion_ms: 4000, volumen: 0.75, minimo: 0 },
  like: { activo: false, texto: "", medio: "", sonido: "", duracion_ms: 3500, volumen: 0.6, minimo: 0 },
  salida: { dispositivo: "", volumen: 0.8, en_directo: false },
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
  "chat.message.deleted",
  "member.joined",
  "gift.received",
  "like.updated",
  "viewer.updated",
  "follow.received",
  "share.received",
  "subscribe.received",
  "gifts.updated",
  // OJO: el `case` de este evento vive mas abajo. Si se anade un `case` y se
  // olvida esta lista, el motor lo reporta como `sin_manejar:` en el log aunque
  // la interfaz si lo pinte, que es justo el diagnostico contrario al real.
  "rankings.updated",
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
  /** Agregados de regalos calculados por Rust (no se recalculan aquí). */
  const [giftsByType, setGiftsByType] = useState<GiftTypeSummary[]>([]);
  /** Las tres tablas de aportación por persona de la sesión. */
  const [tapRanking, setTapRanking] = useState<RankingEntry[]>([]);
  const [giftRanking, setGiftRanking] = useState<RankingEntry[]>([]);
  const [followRanking, setFollowRanking] = useState<RankingEntry[]>([]);
  /** Totales históricos: solo vienen poblados si el ajuste está activado. */
  const [lifetimeRanking, setLifetimeRanking] = useState<RankingEntry[]>([]);
  const [lifetimeEnabled, setLifetimeEnabled] = useState(false);
  /** Mientras el motor confirma el cambio del histórico. */
  const [lifetimeBusy, setLifetimeBusy] = useState(false);
  /** Mientras el motor confirma el cambio de diseño de un overlay. */
  const [overlayBusy, setOverlayBusy] = useState(false);
  /** Mientras el motor confirma un cambio de alertas o importa un medio. */
  const [alertasBusy, setAlertasBusy] = useState(false);
  const [totals, setTotals] = useState<Totals>(EMPTY_TOTALS);
  const [tab, setTab] = useState<Tab>("chat");
  const [handle, setHandle] = useState("");
  /**
   * Los últimos usuarios con los que se conectó, el más reciente primero.
   *
   * Son las sugerencias del campo (el `<datalist>`). No es el histórico de
   * sesiones: eso es el `handle` de cada fila de `streams`.
   */
  const [recordados, setRecordados] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Métricas en vivo de la página Developer (solo se sondea con esa pestaña abierta). */
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  /**
   * Espejos locales de dos cosas que el motor no publica por lista:
   *   * `deleted`: `source_id` de los comentarios borrados en TikTok;
   *   * `muted`: ids de usuario silenciados en la voz desde este chat.
   *
   * Ninguno de los dos toca el chat en si (las entradas no se mutan): el chat se
   * fusiona con las fotos del motor y perderia cualquier marca guardada dentro.
   */
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [muted, setMuted] = useState<ReadonlySet<string>>(() => new Set<string>());

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
  /**
   * Si hay una sesión de directo abierta: **la** fuente de ese estado.
   *
   * De aquí salen el reloj de la duración, el vacío del chat y el `@usuario` de
   * la franja de emisión. Antes el vacío del chat miraba si el campo tenía
   * texto, y desde que el usuario recordado lo rellena eso es cierto **antes**
   * de conectar: el aviso de arranque no volvía a salir nunca.
   */
  const sessionActive = snapshot?.started_at_ms != null && status !== "stopped";
  /**
   * Cuánto lleva el directo. Se enseña en la cabecera desde que no hay página de
   * sesión: es el único dato de la sesión que no estaba ya en la cabecera o en el
   * pie. El título lo pone `detail` y el `@usuario`, la caja de estado.
   */
  const duracion =
    sessionActive && snapshot?.started_at_ms != null
      ? formatDuration(now - snapshot.started_at_ms)
      : "—";

  /**
   * La ficha del streamer, si la sala trajo perfil.
   *
   * Se exige identidad (apodo o @usuario): un perfil solo con contadores no sería
   * una ficha, y el motor manda el objeto vacío cuando TikTok no da nada. Sin
   * perfil, la cabecera se queda como estaba, con el @usuario.
   */
  const perfil =
    snapshot?.perfil && (snapshot.perfil.unique_id || snapshot.perfil.nickname)
      ? snapshot.perfil
      : null;

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

  /**
   * Aplica una foto del motor.
   *
   * Acepta `null` **a proposito**, aunque el tipo del puente diga que siempre viene
   * una foto: el puente puede devolver nada —sin la inyeccion de Tauri, que es el
   * caso del banco de la interfaz en un navegador, o si el comando falla— y sin esta
   * guarda `next.status` reventaba con «Cannot read properties of null (reading
   * 'status')» y se caia la pantalla entera. Una foto que no llega tiene que dejar
   * lo que ya habia, no llevarse por delante lo que el streamer esta viendo.
   */
  const applySnapshot = useCallback((next: Snapshot | null | undefined) => {
    if (!next) return;
    setSnapshot(next);
    setStatus(next.status);
    setDetail(next.status_detail);
    // Fusionado, no reemplazo: ver `mergeSnapshot`. Y los emotes que la foto del
    // motor no trae se recuperan de la copia en memoria: ver `conservarEmotes`.
    setChat((previous) =>
      conservarEmotes(previous, mergeSnapshot(previous, next.chat, CHAT_WINDOW, false)),
    );
    setFeed((previous) => mergeSnapshot(previous, next.events, FEED_WINDOW, true));
    setGifts((previous) => mergeSnapshot(previous, next.gifts, GIFT_WINDOW, true));
    // Los agregados vienen calculados del motor: la interfaz no los recalcula,
    // asi la contabilidad de rachas vive en un solo sitio.
    setGiftsByType(next.gifts_by_type);
    // Las tablas de ranking llegan ya calculadas por Rust: la interfaz no agrega
    // nada, solo pinta. Recalcularlas aquí sería un segundo contador que puede
    // discrepar del que ven el overlay y la base de datos.
    setTapRanking(next.tap_ranking);
    setGiftRanking(next.gift_ranking);
    setFollowRanking(next.follow_ranking);
    setLifetimeRanking(next.lifetime_ranking);
    setLifetimeEnabled(next.lifetime_enabled);
    // Sugerencias del campo de conexión. `?? []` porque el tipo lo declara
    // obligatorio, pero una foto de una versión anterior del motor no lo trae y
    // no puede dejar la lista en `undefined`.
    setRecordados(next.ultimos_usuarios ?? []);
    setTotals({
      // Los espectadores solo llegan por eventos: hasta el primero, se desconoce.
      viewers: totalsRef.current.viewers,
      cumulativeViewers: totalsRef.current.cumulativeViewers,
      // Las entradas tambien son solo de eventos: el snapshot no las cuenta.
      joined: totalsRef.current.joined,
      // Una foto puede haberse construido antes de un evento que ya llegó a
      // React. Los contadores monotónicos no deben retroceder al fusionarla.
      likes: Math.max(totalsRef.current.likes, next.metrics.likes_total),
      gifts: Math.max(totalsRef.current.gifts, next.total_gifts),
      diamonds: Math.max(totalsRef.current.diamonds, next.total_diamonds),
      comments: Math.max(totalsRef.current.comments, next.metrics.chat_messages),
      follows: Math.max(totalsRef.current.follows, next.metrics.follows),
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
              ? {
                  ...previous,
                  started_at_ms: event.timestamp_ms,
                  room_id: event.room_id,
                  // El perfil viaja con la conexión: es cuando la sala se
                  // resuelve y lo único que lo trae.
                  perfil: event.perfil,
                }
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
              emote_count: event.emote_count,
            };
            const next = [...previous, entry];
            return next.length > CHAT_WINDOW ? next.slice(next.length - CHAT_WINDOW) : next;
          });
          setTotals((previous) => ({ ...previous, comments: previous.comments + 1 }));
          // Diagnóstico temporal: deja constancia de que ESTE mensaje llegó aquí.
          void api.uiChat({ received_seq: event.seq }).catch(() => undefined);
          break;
        case "chat.message.deleted": {
          // Se marca, no se quita: ver `DELETED_WINDOW` y `chatText`. El campo
          // se llama `target_source_id` (no `source_id`) porque el sobre del
          // evento ya trae el suyo y aplanado daria clave duplicada en el JSON.
          // Si no viene, no hay forma de saber que linea es: no se inventa nada.
          const id = event.target_source_id;
          if (id !== undefined && id.length > 0) {
            setDeleted((previous) => {
              if (previous.has(id)) return previous;
              const next = new Set(previous);
              next.add(id);
              // Los mas antiguos sobran: su mensaje ya salio de la ventana.
              let sobra = next.size - DELETED_WINDOW;
              for (const viejo of next) {
                if (sobra <= 0) break;
                next.delete(viejo);
                sobra -= 1;
              }
              return next;
            });
          }
          break;
        }
        case "member.joined":
          // Es el evento mas frecuente de TikTok: se cuenta en el pie, nunca se
          // pinta una linea por entrada (taparia el chat y la actividad).
          setTotals((previous) => ({ ...previous, joined: previous.joined + 1 }));
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
          // Agregados ya calculados por Rust (coalescidos a 1/s). La tabla de
          // **quién** aporta no viaja aquí: llega en `rankings.updated`, que es
          // donde vive una sola vez.
          setGiftsByType(event.gifts_by_type);
          setTotals((previous) => ({
            ...previous,
            gifts: event.total_gifts,
            diamonds: event.total_diamonds,
          }));
          break;
        case "rankings.updated":
          // Llegan las tres juntas (coalescidas a 1/s) para que la foto sea
          // coherente: pintarlas por separado mezclaría un tap tap de antes con
          // unos regalos de después.
          setTapRanking(event.tap);
          setGiftRanking(event.gifts);
          setFollowRanking(event.follows);
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
        // Sin foto no hay nada que aplicar **ni de donde sacar el ultimo usuario**:
        // el `?.` de `ultimos_usuarios` no basta, porque el `?? initial.handle` de
        // detras se evalua igual y revienta con la foto en `null`.
        if (!cancelled && initial) {
          applySnapshot(initial);
          // El campo se rellena con el último usuario recordado, y se rellena
          // **solo si está vacío**: si el streamer ya ha empezado a teclear,
          // pisárselo sería un desaire. Se rellena, no se conecta: conectar sin
          // que lo pida sería una sorpresa desagradable si no está emitiendo.
          setHandle((actual) =>
            actual.trim().length > 0
              ? actual
              : (initial.ultimos_usuarios?.[0] ?? initial.handle),
          );
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

  /**
   * Silencia o vuelve a leer a un usuario en la voz.
   *
   * `tts_action` ya existia y lo usaba la pagina de Voz, pero desde el chat no
   * habia forma de llamarlo. El motor sigue siendo la fuente de verdad: la
   * interfaz no puede consultar **quien** esta silenciado (el estado solo publica
   * cuantos), asi que lleva un espejo optimista para marcar los mensajes; si la
   * orden falla, se ve el error arriba.
   */
  const setUserMuted = useCallback((userId: string, silenciar: boolean) => {    setMuted((previous) => {
      const next = new Set(previous);
      if (silenciar) next.add(userId);
      else next.delete(userId);
      return next;
    });
    // La llamada al motor va fuera del actualizador de estado, que debe ser puro.
    void api
      .ttsAction(silenciar ? "mute" : "unmute", userId)
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  /**
   * Abre el perfil de TikTok de una persona en el navegador.
   *
   * El `unique_id` se manda a Rust, que lo valida y construye la URL: el WebView
   * no arma URLs que el sistema operativo vaya a abrir. Si falla, el aviso sale
   * en la banda de error de arriba, como el resto de acciones.
   */
  const openProfile = useCallback((uniqueId: string, nickname: string) => {
    void api
      .abrirPerfil(uniqueId)
      .catch((cause: unknown) => setError(`${nickname}: ${String(cause)}`));
  }, []);

  /**
   * Cambia el ajuste de histórico de aportaciones.
   *
   * Optimista a propósito (el interruptor responde al instante), pero **se
   * revierte si el motor falla**: dejarlo pulsado cuando no se está guardando
   * nada mentiría sobre lo que hay en disco. La respuesta trae la foto nueva, así
   * que no hace falta pedir otra.
   */
  const changeLifetime = useCallback((enabled: boolean) => {
    const previo = !enabled;
    setLifetimeEnabled(enabled);
    setLifetimeBusy(true);
    void api
      .setLifetime(enabled)
      .then((next) => {
        applySnapshot(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        setLifetimeEnabled(previo);
        setError(String(cause));
      })
      .finally(() => setLifetimeBusy(false));
  }, [applySnapshot]);

  /**
   * Cambia el diseño del overlay de una vista.
   *
   * No es optimista a propósito, al contrario que el histórico: aquí el motor
   * escribe el fichero **antes** de publicar, así que si falla no se ha cambiado
   * nada, y pintarlo de todas formas mentiría sobre lo que va a cargar OBS en el
   * siguiente arranque.
   */
  const changeOverlayDesign = useCallback((vista: string, diseno: string) => {
    setOverlayBusy(true);
    void api
      .setOverlayDesign(vista, diseno)
      .then((next) => {
        applySnapshot(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setOverlayBusy(false));
  }, [applySnapshot]);

  /**
   * Al cambiar de pestaña, el panel vuelve arriba.
   *
   * Las páginas comparten el mismo `main`, así que el desplazamiento se hereda: si
   * vienes de una larga, la nueva puede aparecer cortada por arriba. Se resetean los
   * dos, el `main` y el panel de la página, porque cada uno lleva el suyo.
   *
   * OJO: esto **no** arregla el desplazamiento inicial de la pestaña Overlays. Se
   * probó también a desactivar el anclaje de desplazamiento y tampoco: el panel sigue
   * abriendo con 76 px, que es justo su máximo. La causa está sin encontrar.
   */
  useEffect(() => {
    const principal = document.querySelector("main");
    if (!principal) return;
    principal.scrollTop = 0;
    principal.querySelectorAll(".grid-panel").forEach((panel) => {
      panel.scrollTop = 0;
    });
  }, [tab]);

  /**
   * Las acciones de alertas comparten forma: marcar ocupado, pedir al motor y
   * pintar la foto que devuelve. Se escriben una vez y cada botón pasa la suya.
   *
   * Las de abajo van memoizadas a propósito: la página de Alertas las usa como
   * dependencia de un `useEffect` que registra el arrastre de ficheros, y una
   * función nueva por render volvería a registrar el oyente cada vez.
   */
  const accionAlertas = useCallback(
    (accion: () => Promise<Snapshot>) => {
      setAlertasBusy(true);
      void accion()
        .then((next) => {
          applySnapshot(next);
          setError(null);
        })
        .catch((cause: unknown) => setError(String(cause)))
        .finally(() => setAlertasBusy(false));
    },
    [applySnapshot],
  );

  const guardarAlertas = useCallback(
    (ajustes: AjustesAlertas) => accionAlertas(() => api.setAlertas(ajustes)),
    [accionAlertas],
  );
  const importarMedioBytes = useCallback(
    (nombre: string, bytes: number[]) =>
      accionAlertas(() => api.importarMedioAlertaBytes(nombre, bytes)),
    [accionAlertas],
  );
  /**
   * Importa varios ficheros de golpe y devuelve el recuento.
   *
   * No pasa por `accionAlertas` porque devuelve algo más que el estado —cuántos
   * entraron y cuáles no— y eso hay que enseñarlo: un fichero que se queda fuera
   * sin decirlo es un fichero que el streamer cree que tiene.
   */
  const importarMediosRutas = useCallback(
    async (rutas: string[]) => {
      setAlertasBusy(true);
      try {
        const resultado = await api.importarMediosAlerta(rutas);
        applySnapshot(resultado.snapshot);
        setError(null);
        return resultado;
      } finally {
        setAlertasBusy(false);
      }
    },
    [applySnapshot],
  );
  const borrarMedio = useCallback(
    (nombre: string) => accionAlertas(() => api.borrarMedioAlerta(nombre)),
    [accionAlertas],
  );
  const probarAlerta = useCallback(
    (tipo: string) => accionAlertas(() => api.probarAlerta(tipo)),
    [accionAlertas],
  );
  /**
   * Suena un medio en el monitor, sin encolar ningún aviso.
   *
   * El error **sí** se enseña aquí, al contrario que en el resto de acciones de
   * alertas: si el streamer pulsa oír y no suena nada, tiene que saber si es que el
   * fichero ya no está o que el monitor está mudo. Callarlo dejaría un botón que
   * parece roto.
   */
  const oirMedio = useCallback((nombre: string) => {
    void api.oirMedio(nombre).catch((cause: unknown) => setError(String(cause)));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`dot dot-${status}`} />
          <h1>{t.appName}</h1>
          {/* El estado, en pastilla y **visible**: es lo primero que se mira de
              reojo. Antes iba dentro de la caja de texto, al mismo peso que el
              handle y el motivo, y habia que leerlo. */}
          <span className={`estado estado-${status}`}>{t.status[status] ?? status}</span>
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
            // Las sugerencias son los últimos usuarios: un `datalist` basta y no
            // inventa un desplegable propio. Va sin `@` porque es como se guarda
            // el usuario y como lo espera el motor.
            list="usuarios-recordados"
          />
          <datalist id="usuarios-recordados">
            {recordados.map((usuario) => (
              <option key={usuario} value={usuario} />
            ))}
          </datalist>
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

        {/* Desarrollador no es una pestaña: es una herramienta de diagnóstico y en
            la barra competía con las páginas del directo. */}
        <button
          type="button"
          className={tab === "developer" ? "ghost active" : "ghost"}
          title={t.developer.title}
          onClick={() => setTab("developer")}
        >
          {t.developer.open}
        </button>
      </header>

      {/*
       * La franja de emision: quien emite, cuanto lleva y por que esta asi.
       *
       * Va **fuera de la cabecera** porque una ficha de perfil —avatar, nombre,
       * @usuario, contadores y bio— no cabe en una barra de una sola fila. Metida
       * ahi empujaba `Conectar` y `Desconectar` a dos alturas y recortaba los
       * contadores y la bio: se veia desalineado y a medias.
       *
       * El reparto queda claro: la cabecera es para lo que se **pulsa** y esta
       * franja para lo que se **mira**. Y el tiempo de directo vive aqui siempre,
       * haya ficha o no, para que no cambie de sitio segun lo que tarde TikTok en
       * mandar el perfil.
       */}
      <div className="emision-banda">
        {perfil ? (
          <TarjetaPerfil perfil={perfil} />
        ) : sessionActive && snapshot?.handle ? (
          // Sin ficha todavia: se queda el @usuario de la sesion y el titulo dice
          // por que no hay tarjeta, en vez de dejar la franja muda. Se exige
          // sesion abierta: con el usuario recordado el `handle` ya trae texto
          // antes de conectar, y esta franja dice quien **emite**, no quien
          // podria emitir (eso ya lo dice el campo de arriba).
          <span className="emision-usuario" title={t.perfil.sinDatos}>
            @{snapshot.handle}
          </span>
        ) : null}
        {duracion === "—" ? null : <span className="emision-tiempo">{duracion}</span>}
        {/* El motivo, siempre a la vista: un error o una espera no pueden quedar
            escondidos detras del handle. */}
        {detail ? (
          <span className="topbar-motivo" title={detail}>
            {detail}
          </span>
        ) : null}
      </div>

      {/*
       * El marcador, **justo debajo de la franja de emision**.
       *
       * Estaba abajo del todo y obligaba a bajar la vista en cada regalo; aqui
       * vive con la foto y el tiempo de directo, que es lo que se mira de reojo
       * mientras se emite. Se muda, no se copia: una cifra grande en dos sitios
       * deja al ojo sin saber donde mirar (docs/interfaz.md §2).
       *
       * Dos bloques, no siete cifras iguales. Primero el **dinero** —regalos y
       * diamantes, que es lo que de verdad importa— y detras la **sesion**
       * —espectadores, likes, comentarios, seguidores y entradas—. Los separa el
       * aire y no un rotulo: el hueco se lee de un vistazo y no hay nada que
       * leer. El orden de cada bloque es el de siempre.
       */}
      <footer className="stats">
        <div className="stats-grupo stats-grupo-dinero">
          <Stat label={t.stats.gifts} value={totals.gifts} />
          <Stat label={t.stats.diamonds} value={totals.diamonds} />
        </div>
        <div className="stats-grupo stats-grupo-sesion">
          <Stat label={t.stats.viewers} value={totals.viewers} />
          <Stat label={t.stats.likes} value={totals.likes} />
          <Stat label={t.stats.comments} value={totals.comments} />
          <Stat label={t.stats.follows} value={totals.follows} />
          {/* Entradas a la sala: el evento mas frecuente de TikTok se resume aqui
              en vez de pintar una linea por persona. */}
          <Stat label={t.stats.joined} value={totals.joined} />
        </div>
      </footer>

      <div className="body">
        <nav className="sidebar">
          {(Object.keys(t.nav) as Pestana[]).map((key) => (
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

          {tab === "chat" ? (
            <Chat
              chat={chat}
              feed={feed}
              followRanking={followRanking}
              onOpenProfile={openProfile}
              deleted={deleted}
              muted={muted}
              /* `sinSesion` mira la **sesion de verdad**, no el campo de texto.
                 Antes salia de `snapshot.handle === ""`, y desde que la aplicacion
                 recuerda el ultimo usuario ese campo arranca relleno: el aviso de
                 arranque del chat —el que explica que hay que escribir el usuario y
                 pulsar Conectar— no volvia a salir nunca, ni la primera vez que
                 alguien abre la aplicacion. `sessionActive` es la misma fuente que ya
                 usa el tiempo de directo: un estado, un sitio. */
              sinSesion={!sessionBusy && !sessionActive}
              onToggleMute={setUserMuted}
              onClear={() => {
                void api.clearChat();
                setChat([]);
              }}
              onClearFeed={() => {
                void api.clearFeed();
                setFeed([]);
              }}
            />
          ) : null}

          {tab === "aportaciones" ? (
            <Aportaciones
              tap={tapRanking}
              gifts={giftRanking}
              follows={followRanking}
              lifetime={lifetimeRanking}
              lifetimeEnabled={lifetimeEnabled}
              lifetimeBusy={lifetimeBusy}
              onLifetimeChange={changeLifetime}
              recientes={gifts}
              porTipo={giftsByType}
              totalGifts={totals.gifts}
              totalDiamonds={totals.diamonds}
              onOpenProfile={openProfile}
            />
          ) : null}

          {tab === "alertas" ? (
            <Alertas
              ajustes={snapshot?.alertas ?? ALERTAS_VACIAS}
              medios={snapshot?.alertas_medios ?? []}
              descartados={snapshot?.alertas_descartados ?? 0}
              audioDispositivo={snapshot?.alertas_audio_dispositivo ?? null}
              audioProblema={snapshot?.alertas_audio_problema ?? null}
              url={snapshot?.overlay_urls?.["alerts"]}
              busy={alertasBusy}
              onGuardar={guardarAlertas}
              onImportarBytes={importarMedioBytes}
              onImportarRutas={importarMediosRutas}
              onBorrarMedio={borrarMedio}
              onProbar={probarAlerta}
              onOir={oirMedio}
            />
          ) : null}

          {tab === "overlays" ? (
            <Overlays
              base={snapshot?.overlay_page_url ?? null}
              urls={snapshot?.overlay_urls ?? {}}
              seleccion={snapshot?.overlay_seleccion ?? {}}
              disenos={snapshot?.overlay_disenos ?? []}
              busy={overlayBusy}
              onChoose={changeOverlayDesign}
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
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

/**
 * Recupera los emotes que la foto del motor no trae.
 *
 * `chat.message` viaja con `emote_count`, pero el `ChatEntry` del snapshot de
 * Rust (`chat::ChatEntry`) todavia no guarda ese campo: al fusionar una foto, el
 * comentario volvia sin el dato y los mensajes que son **solo emote** se pintaban
 * como «sin texto». Se rellena desde la copia que ya estaba en memoria (misma
 * `seq`). Cuando Rust lo guarde en el buffer de chat, esto sobra.
 */
function conservarEmotes(previous: ChatEntry[], merged: ChatEntry[]): ChatEntry[] {
  const emotes = new Map<number, number>();
  for (const entry of previous) {
    if ((entry.emote_count ?? 0) > 0) emotes.set(entry.seq, entry.emote_count ?? 0);
  }
  if (emotes.size === 0) return merged;
  return merged.map((entry) => {
    if ((entry.emote_count ?? 0) > 0) return entry;
    const recordado = emotes.get(entry.seq);
    return recordado === undefined ? entry : { ...entry, emote_count: recordado };
  });
}

/**
 * Una cifra del marcador.
 *
 * El valor entra como **numero** y no como texto ya formateado porque hay que
 * saber si es cero. Un cero no se quita: quitarlo moveria las demas cifras en
 * cuanto llegue el primer evento, y eso es peor que un cero. Se queda en su
 * sitio, pero pintado con el color de los rotulos, para que no compita con las
 * que si tienen numero; en cuanto deja de ser cero vuelve al color normal.
 *
 * Sin transicion a proposito: esta tira cambia muchas veces por minuto y una
 * animacion en cada cambio seria ruido.
 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={value === 0 ? "stat-value stat-value-cero" : "stat-value"}>
        {formatNumber(value)}
      </span>
    </div>
  );
}

/**
 * La ficha del streamer: foto, nombre, contadores y bio.
 *
 * Sin botones a propósito: «Editar perfil», «Promocionar» o compartir son mandos
 * de la página de TikTok y aquí no harían nada.
 */
function TarjetaPerfil({ perfil }: { perfil: Perfil }) {
  // Solo los contadores que la sala haya traído: `null` es «no lo sé», y pintar
  // un cero sería mentir. El orden es el de la ficha: seguidos, seguidores y
  // likes.
  const contadores: string[] = [];
  if (perfil.seguidos != null) {
    contadores.push(`${formatNumber(perfil.seguidos)} ${t.perfil.seguidos}`);
  }
  if (perfil.seguidores != null) {
    contadores.push(`${formatNumber(perfil.seguidores)} ${t.perfil.seguidores}`);
  }
  if (perfil.likes != null) {
    contadores.push(`${formatNumber(perfil.likes)} ${t.perfil.likes}`);
  }
  const nombre = perfil.nickname || `@${perfil.unique_id}`;
  return (
    <div className="perfil">
      <AvatarPerfil perfil={perfil} />
      <div className="perfil-datos">
        <span className="perfil-nombre" title={nombre}>
          {nombre}
        </span>
        {perfil.unique_id ? (
          <span className="perfil-usuario">@{perfil.unique_id}</span>
        ) : null}
        {contadores.length > 0 ? (
          <span className="perfil-contadores">{contadores.join(t.perfil.separador)}</span>
        ) : null}
        {perfil.bio ? (
          <span className="perfil-bio" title={perfil.bio}>
            {perfil.bio}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Foto de perfil del streamer, con la inicial como sustituto.
 *
 * El disco con la inicial es el mismo recurso que usa el overlay de esgrima: si
 * el CDN no da la foto, la cabecera no puede quedarse con un hueco roto.
 */
function AvatarPerfil({ perfil }: { perfil: Perfil }) {
  // Se recuerda **qué** dirección falló, no un simple «falló»: al cambiar de
  // streamer la foto es otra y el fallo anterior no le corresponde.
  const [fallida, setFallida] = useState<string | null>(null);
  const inicial = (perfil.nickname || perfil.unique_id || "?").slice(0, 1).toUpperCase();
  if (!perfil.avatar || fallida === perfil.avatar) {
    return (
      <span className="perfil-avatar perfil-avatar-vacio" aria-hidden="true">
        {inicial}
      </span>
    );
  }
  return (
    <img
      className="perfil-avatar"
      src={perfil.avatar}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFallida(perfil.avatar)}
    />
  );
}
