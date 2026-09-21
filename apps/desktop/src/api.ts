//! Puente con Rust.
//!
//! Regla de la arquitectura (docs/plan-review.md §39): Rust es la fuente de
//! verdad. La interfaz pide un `snapshot` al abrirse y, a partir de ahi, solo
//! recibe eventos. No guarda historial propio.

import { invoke as invocarTauri } from "@tauri-apps/api/core";
import { listen as escucharTauri, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * ¿Corremos dentro de la aplicación de escritorio?
 *
 * Tauri 2 inyecta `__TAURI_INTERNALS__` en el WebView antes de cargar el bundle,
 * y es justo lo que mira su propia API para saber si el puente existe.
 * Comprobarlo así —y no por la URL o el user agent— es lo que permite que **el
 * mismo bundle** valga para la ventana y para el navegador.
 */
const enEscritorio = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Servidor del panel cuando no hay Tauri.
 *
 * Vacío significa «el mismo origen», que sirve en los dos montajes: tanto si la
 * página la sirve el propio servidor del motor (`--web`) como si la sirve Vite
 * con el proxy de `/api` puesto. Para apuntar a otro sitio se define
 * `window.__DASH_SERVIDOR__` antes de cargar el bundle.
 */
function servidor(): string {
  const configurado = (window as { __DASH_SERVIDOR__?: unknown }).__DASH_SERVIDOR__;
  return typeof configurado === "string" ? configurado.replace(/\/+$/, "") : "";
}

/** El sobre que devuelve el servidor del panel. */
interface Sobre<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function peticion<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const respuesta = await fetch(`${servidor()}/api/cmd/${encodeURIComponent(cmd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!respuesta.ok) {
    throw new Error(`el servidor del panel respondió ${respuesta.status}`);
  }
  const sobre = (await respuesta.json()) as Sobre<T>;
  if (!sobre.ok) {
    throw new Error(sobre.error ?? "el comando falló sin decir por qué");
  }
  return sobre.data as T;
}

async function invocarPorHttp<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Abrir un perfil es lo único que **no** puede hacer el servidor: la pestaña
  // tiene que abrirla el navegador de quien está mirando, no el de la máquina
  // donde corre el motor. El servidor valida el handle y devuelve la URL; abrirla
  // es cosa de aquí. Sin esto, cualquiera con acceso al puerto podría lanzar un
  // navegador en el servidor.
  if (cmd === "abrir_perfil") {
    const unique_id = String(args?.unique_id ?? "");
    const url = await peticion<string>("perfil_url", { unique_id });
    window.open(url, "_blank", "noopener,noreferrer");
    return undefined as T;
  }
  return peticion<T>(cmd, args);
}

/**
 * El puente con Rust, por el camino que haya.
 *
 * Los dos transportes tienen los mismos comandos, los mismos argumentos y el
 * mismo contrato de error, así que el resto del fichero no sabe —ni tiene por qué
 * saber— por dónde va.
 */
const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  enEscritorio ? invocarTauri<T>(cmd, args) : invocarPorHttp<T>(cmd, args);

/** A quién avisar cuando el canal de eventos se vuelve a abrir. */
const reconectados = new Set<() => void>();

/**
 * Avisa cuando el canal de eventos se ha reconectado tras caerse.
 *
 * Un canal caído **pierde** los eventos que pasaron mientras tanto: el servidor
 * no los reproduce. Al volver, la interfaz tiene que pedir otra vez la foto del
 * motor para tapar el hueco; esto es lo que se lo dice.
 *
 * En la aplicación de escritorio no hay reconexiones que avisar: el IPC de Tauri
 * es un canal local que no se cae.
 */
export function onDashReconnect(handler: () => void): () => void {
  reconectados.add(handler);
  return () => {
    reconectados.delete(handler);
  };
}

/**
 * El canal de bajada en el navegador: un WebSocket contra el servidor del panel.
 *
 * Se reconecta solo, con espera creciente, porque el servidor se puede reiniciar
 * mientras se trabaja en él —que es justo lo que se hace al tocar el motor— y la
 * pestaña no debería quedarse muerta por eso.
 */
function escucharPorWebSocket(handler: (event: WireEvent) => void): Promise<UnlistenFn> {
  let cerrado = false;
  let socket: WebSocket | null = null;
  let temporizador: number | undefined;
  let espera = 500;
  let primera = true;

  const destino = () => {
    const base = servidor();
    if (base) return `${base.replace(/^http/, "ws")}/api/eventos`;
    const protocolo = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocolo}//${window.location.host}/api/eventos`;
  };

  const conectar = () => {
    if (cerrado) return;
    const ws = new WebSocket(destino());
    socket = ws;

    ws.onopen = () => {
      espera = 500;
      if (!primera) reconectados.forEach((avisar) => avisar());
      primera = false;
    };

    ws.onmessage = (mensaje) => {
      try {
        handler(JSON.parse(mensaje.data as string) as WireEvent);
      } catch (error) {
        // Un evento que no se entiende no puede tumbar el flujo entero: se
        // aparta y se sigue con el siguiente.
        console.error("evento ilegible del servidor del panel", error);
      }
    };

    ws.onclose = () => {
      if (cerrado) return;
      temporizador = window.setTimeout(conectar, espera);
      espera = Math.min(espera * 2, 10_000);
    };

    ws.onerror = () => ws.close();
  };

  conectar();

  return Promise.resolve(() => {
    cerrado = true;
    if (temporizador !== undefined) window.clearTimeout(temporizador);
    socket?.close();
  });
}

export interface UserRef {
  id: string;
  unique_id: string;
  nickname: string;
  /**
   * Foto de perfil (miniatura). Rust la omite del JSON cuando no hay foto, así
   * que puede faltar aunque el evento traiga usuario.
   */
  avatar_url?: string;
}

/**
 * Perfil del dueño de la sala.
 *
 * Los tres contadores son `number | null` a propósito: Rust los omite cuando
 * TikTok no los manda, y un cero pintado en la ficha sería una mentira.
 */
export interface Perfil {
  unique_id: string;
  nickname: string;
  avatar: string;
  bio: string;
  seguidores: number | null;
  seguidos: number | null;
  likes: number | null;
}

export interface GiftInfo {
  id: string;
  name: string;
  /** Icono del regalo, si TikTok lo envía. */
  image_url?: string;
  diamond_count: number;
  streakable: boolean;
  repeat_count: number;
  is_final: boolean;
  group_id: string;
}

export type DashEvent =
  | { type: "stream.connected"; room_id: string; title: string; perfil: Perfil }
  | { type: "stream.disconnected"; reason: string }
  | { type: "stream.waiting"; handle: string; detail: string }
  | {
      type: "chat.message";
      user: UserRef;
      content: string;
      /**
       * Emotes del fans club que traia el mensaje.
       *
       * TikTok manda los mensajes que son **solo** emote con `content` vacio: sin
       * este dato se pintaban como una linea en blanco. El contrato de Rust lo
       * fija siempre presente (`core/contract.rs`).
       */
      emote_count: number;
    }
  /**
   * Un comentario borrado en TikTok.
   *
   * `target_source_id` es el `msg_id` del mensaje borrado, el mismo que viaja en
   * la envoltura de su `chat.message` (y que la interfaz guarda en `ChatEntry`).
   * Se llama asi y **no** `source_id` porque la envoltura del evento ya tiene su
   * propio `source_id` y el enum va aplanado (`#[serde(flatten)]`): con el mismo
   * nombre, el JSON saldria con la clave duplicada y el valor dependeria del
   * orden.
   */
  | { type: "chat.message.deleted"; target_source_id: string }
  /** Alguien ha entrado en la sala. El evento mas frecuente de TikTok. */
  | { type: "member.joined"; user: UserRef }
  | { type: "gift.received"; user: UserRef; gift: GiftInfo }
  | { type: "like.updated"; user: UserRef | null; count: number; total: number }
  | { type: "viewer.updated"; current: number; cumulative: number }
  | { type: "follow.received"; user: UserRef }
  | { type: "share.received"; user: UserRef }
  | { type: "subscribe.received"; user: UserRef; months: number }
  | {
      type: "gifts.updated";
      total_gifts: number;
      total_diamonds: number;
      gifts_by_type: GiftTypeSummary[];
    }
  /**
   * Las tres tablas de aportación por persona, ya calculadas por Rust.
   *
   * Llegan juntas y coalescidas a ~1/s: llegan de los mismos tres tipos de evento
   * y se pintan en la misma vista, así que separarlas obligaría a llevar tres
   * relojes en vez de uno.
   */
  | {
      type: "rankings.updated";
      tap: RankingEntry[];
      gifts: RankingEntry[];
      follows: RankingEntry[];
    }
  | { type: "provider.status"; status: string; detail: string | null };

/** Envoltorio que Rust añade a cada evento del protocolo. */
export interface Envelope {
  protocol_version: number;
  event_id: string;
  seq: number;
  timestamp_ms: number;
  room_id: string;
  source_id?: string;
}

export type WireEvent = Envelope & DashEvent;

export interface ChatEntry {
  seq: number;
  timestamp_ms: number;
  user: UserRef;
  content: string;
  source_id?: string;
  /**
   * Emotes del mensaje. Opcional a proposito: el snapshot de Rust
   * (`chat::ChatEntry`) todavia no guarda este campo, asi que una entrada que
   * venga de una foto del motor puede no traerlo (se trata como 0).
   */
  emote_count?: number;
}

export type FeedKind = "gift" | "follow" | "share" | "subscribe" | "like" | "info";

/**
 * Linea de actividad. Rust guarda **datos**, no frases: la redaccion vive en
 * `i18n` (docs/decisions.md D4).
 */
export interface FeedItem {
  seq: number;
  timestamp_ms: number;
  kind: FeedKind;
  user?: UserRef;
  gift?: GiftInfo;
  /** Likes: (incremento, total). */
  likes?: [number, number];
  /** Meses de suscripcion, cuando el evento es una suscripcion. */
  months?: number;
  /** Detalle tecnico de un aviso. */
  detail?: string;
}

export interface GiftEventView {
  seq: number;
  timestamp_ms: number;
  user: UserRef;
  gift_id: string;
  gift_name: string;
  image_url?: string;
  repeat_count: number;
  diamond_count: number;
  streakable: boolean;
  is_final: boolean;
  group_id: string;
}

/**
 * Una persona y lo que ha aportado.
 *
 * Es el tipo común de las tres tablas de ranking (regalos, tap tap y follows) y
 * del histórico: las cuatro se pintan igual (puesto, foto, nombre y una cifra), y
 * por eso **también** es la tabla de regalos. Antes había además un `top_gifters`
 * con la misma gente en otra forma, y los mismos diez nombres viajaban dos veces
 * por segundo en cada foto.
 */
export interface RankingEntry {
  user: UserRef;
  /** La cifra que se muestra y por la que se ordena. */
  value: number;
  /** Cuántas veces ha contribuido. */
  events: number;
}

export interface GiftTypeSummary {
  gift_id: string;
  gift_name: string;
  count: number;
  diamonds: number;
}

/**
 * Lo que se configura de un tipo de aviso.
 *
 * `texto` es una plantilla con variables entre llaves (`{usuario}`, `{regalo}`…)
 * que rellena Rust: la interfaz no compone el texto, solo lo edita.
 */
export interface AjusteAviso {
  activo: boolean;
  texto: string;
  /** Nombre del fichero en el almacén de medios, o vacío. */
  medio: string;
  sonido: string;
  duracion_ms: number;
  volumen: number;
  /**
   * Cuánto ocupa el aviso en pantalla. `1` es el tamaño de siempre.
   *
   * Es por tipo y no uno para todos: los tres tramos de regalo existen justo para
   * que una rosa pase discreta y una galaxia llene la pantalla.
   */
  escala: number;
  /** Mínimo para disparar: diamantes en regalos, likes en ráfagas. */
  minimo: number;
  /** Cómo entra el aviso. Identificador del catálogo de `animaciones.ts`. */
  animacion_entrada: string;
  /** Cómo sale. */
  animacion_salida: string;
  /** Cuánto tarda en entrar, en milisegundos. */
  entrada_ms: number;
  /** Cuánto tarda en salir, en milisegundos. */
  salida_ms: number;
  /** El ritmo de las dos. `auto` deja el que traiga la animación. */
  ritmo: string;
  /**
   * Qué hace la alerta **mientras está en pantalla**, ya entrada y antes de salir.
   *
   * Es un bucle, no una transición: se repite durante todo el tiempo visible. Los
   * parámetros que lo acompañan son compartidos entre efectos —`idle_distancia` son
   * píxeles al flotar y un porcentaje al brillar—, y cada efecto usa los que le tocan.
   */
  idle: string;
  idle_distancia: number;
  idle_ms: number;
  idle_intervalo_ms: number;
  idle_brillo: number;
  idle_color: string;
  idle_blur: number;
  idle_modo: string;
  /**
   * El **contenedor del mensaje**: el bloque del texto, con su estilo y sus animaciones.
   *
   * Va aparte del resto porque es otro sistema: lo de arriba mueve la alerta entera y
   * esto mueve solo su mensaje. Ver `mensaje.ts` para los catálogos y los mandos.
   */
  mensaje: MensajeAviso;
}

/**
 * El contenedor del mensaje de una alerta.
 *
 * Los nombres y los topes son los de `alerts/mensaje.rs`, que es quien sanea de verdad:
 * aquí solo se declaran para poder editarlos.
 */
export interface MensajeAviso {
  /** El preset visual. Identificador del catálogo de `mensaje.ts`. */
  estilo: string;
  /** Color del fondo, `#rrggbb`. */
  fondo: string;
  /** El segundo color: solo lo usa el degradado. */
  fondo_2: string;
  /** Cuánto tapa el fondo, en tanto por ciento. */
  fondo_opacidad: number;
  borde_color: string;
  borde_grosor: number;
  radio: number;
  padding_h: number;
  padding_v: number;
  /** Cuánta sombra proyecta la caja, en tanto por ciento. */
  sombra: number;
  /** Lo que se difumina lo de detrás, en píxeles. */
  blur: number;
  /** El resplandor de fuera, en píxeles. */
  glow: number;
  glow_color: string;
  /** El ancho máximo, en tanto por ciento del lienzo. */
  ancho_vw: number;
  altura_minima: number;
  /** El hueco con el medio de arriba, en píxeles. */
  separacion: number;
  fuente: string;
  tamano: number;
  peso: number;
  color: string;
  alineacion: string;
  /** El espacio entre letras, en **décimas** de píxel. */
  espaciado: number;
  /** El alto de línea, en tanto por ciento. */
  interlineado: number;
  /** El grosor del contorno de la letra, en décimas de píxel. */
  contorno: number;
  contorno_color: string;
  /** Lo que se difumina la sombra de la letra, en píxeles. */
  sombra_texto: number;
  /** Cómo aparece el contenedor. */
  animacion: string;
  /** Qué hace mientras está en pantalla. */
  animacion_idle: string;
  /** Cómo aparecen las letras. Va aparte de la del contenedor. */
  animacion_texto: string;
  /** Cuánto espera el mensaje desde que entra la alerta, en milisegundos. */
  retardo_ms: number;
  duracion_ms: number;
  /** Lo que dura un ciclo de la animación de permanencia. */
  ciclo_ms: number;
  /** Cuánto se mueve, cuánto crece o cuánto brilla, en tanto por ciento. */
  intensidad: number;
  /** El ritmo de la entrada. `auto` deja el que traiga la animación. */
  ritmo: string;
}

/**
 * Por dónde se oyen las alertas **en esta máquina**.
 *
 * No confundir con el sonido que oye la audiencia: ese sale por la fuente de OBS.
 * Esto es para que el streamer las oiga él, al probar y —si quiere— en directo.
 */
export interface SalidaAlertas {
  /** Nombre del dispositivo, o vacío para el que tenga el sistema. */
  dispositivo: string;
  volumen: number;
  en_directo: boolean;
}

/**
 * De dónde viene el audio de previsualización que está sonando.
 *
 * Los nombres son los que manda Rust (`preview.rs`): son contrato, no etiquetas.
 */
export type OrigenPreview = "biblioteca-sonidos" | "previa-alerta" | "muestra-voz";

/**
 * Quién tiene el turno del audio de previsualización.
 *
 * Se enseña y se compara, pero **no se guarda** en la interfaz como si fuera
 * estado propio: el turno es de Rust, y la interfaz solo lo refleja.
 */
export interface DuenioPreview {
  origen: OrigenPreview;
  /** Qué suena: el nombre del fichero, el tipo de aviso o la clave de la voz. */
  id: string;
}

/** Los siete avisos, por identificador, más por dónde se oyen aquí. */
export interface AjustesAlertas {
  gift: AjusteAviso;
  /** Tramo medio. El `minimo` decide dónde empieza. */
  gift_grande: AjusteAviso;
  /** Tramo alto. */
  gift_enorme: AjusteAviso;
  follow: AjusteAviso;
  subscribe: AjusteAviso;
  share: AjusteAviso;
  like: AjusteAviso;
  salida: SalidaAlertas;
}

/**
 * Los identificadores de aviso que existen.
 *
 * Va escrito a mano y **no** como `keyof AjustesAlertas`: desde que los ajustes
 * llevan también la salida de audio, `keyof` incluiría `salida` y la interfaz
 * pediría texto y medio para un ajuste que no es un aviso. El compilador no se
 * queja de eso, y en pantalla se vería como una tarjeta de más, vacía.
 */
export type TipoAviso =
  | "gift"
  | "gift_grande"
  | "gift_enorme"
  | "follow"
  | "subscribe"
  | "share"
  | "like";

/**
 * Los tipos, en el orden en que se enseñan.
 *
 * Vive aquí y no en la página porque los identificadores los fija Rust: si
 * mañana hay uno nuevo, el compilador avisa en los dos sitios.
 */
export const TIPOS_AVISO: TipoAviso[] = [
  "gift",
  "gift_grande",
  "gift_enorme",
  "follow",
  "subscribe",
  "share",
  "like",
];

/**
 * Un diseño del overlay: su identificador y dónde se puede elegir.
 *
 * Rust publica **solo** identificadores —el rótulo que lee el streamer está en
 * `i18n` (docs/decisions.md D4)— y el lienzo que espera el diseño, para que la
 * vista previa lo escale en vez de recortarlo.
 */
export interface OverlayDesignInfo {
  id: string;
  /**
   * Si es un **marcador** —la tabla de lo que ha pasado— o un **juego** —algo que se
   * mueve con el ritmo de los taps—.
   *
   * Lo dice el motor y no se adivina aquí: la pestaña los enseña en dos secciones
   * distintas, y un diseño nuevo mal clasificado saldría en la sección equivocada.
   */
  tipo: "marcador" | "juego";
  /** Vistas en las que se puede elegir (`tap`, `gifts`, `follows`). */
  vistas: string[];
  previa: { ancho: number; alto: number };
}

export interface Metrics {
  events_published: number;
  subscription_lagged: number;
  duplicates_dropped: number;
  chat_messages: number;
  gifts: number;
  follows: number;
  likes_total: number;
  like_events: number;
  viewer_updates_coalesced: number;
  viewer_updates_emitted: number;
  sign_requests: number;
  sign_rate_limited: number;
  ws_connects: number;
  ws_frames: number;
  provider_errors: number;
  provider_reconnects: number;
  provider_state: number;
  subscribers: number;
  /** Si no es cero, la sesión quedó degradada: se perdió un evento crítico. */
  db_critical_dropped: number;
}

/**
 * Lo que salió de importar varios medios de golpe.
 *
 * `fallos` lleva el motivo ya escrito, uno por fichero, con su ruta: en una
 * carpeta siempre hay algo que no vale, y saber **cuál** es lo que evita tener que
 * probarlos de uno en uno para encontrarlo.
 */
export interface ImportacionMedios {
  importados: number;
  fallos: string[];
  snapshot: Snapshot;
}

export interface Snapshot {
  protocol_version: number;  provider: string;
  status: string;
  status_detail: string | null;
  handle: string;
  /**
   * Los últimos usuarios con los que se conectó, el más reciente primero.
   *
   * Son las sugerencias del campo de conexión (el `<datalist>`), no el histórico
   * de sesiones: ese es el `handle` de cada fila de `streams`. Al arrancar, el
   * motor ya pone el primero como `handle`, así que el campo nace relleno.
   */
  ultimos_usuarios: string[];
  room_id: string;
  stream_id: string | null;
  title: string;
  /**
   * Perfil del dueño de la sala, para la ficha de la cabecera.
   *
   * Viene vacío mientras la sala no lo traiga: la interfaz deja entonces la
   * cabecera como estaba, sin pintar una ficha sin datos.
   */
  perfil: Perfil;
  started_at_ms: number | null;
  chat: ChatEntry[];
  events: FeedItem[];
  gifts: GiftEventView[];
  gifts_by_type: GiftTypeSummary[];
  total_gifts: number;
  total_diamonds: number;
  /** Tap tap: likes acumulados por persona en esta sesión. */
  tap_ranking: RankingEntry[];
  /** Diamantes aportados por persona en esta sesión. */
  gift_ranking: RankingEntry[];
  /** Seguidores nuevos por persona en esta sesión. */
  follow_ranking: RankingEntry[];
  /** Totales históricos (vacíos si el ajuste está apagado). */
  lifetime_ranking: RankingEntry[];
  /** Si se está guardando el histórico de quienes aportan. */
  lifetime_enabled: boolean;
  /**
   * Dirección que se pega en OBS como Browser Source, **por vista**, con su
   * token.
   *
   * Vacío si el servidor de overlays no arrancó (por ejemplo, sin puerto libre).
   */
  overlay_urls: Record<string, string>;
  /** Diseño elegido de cada vista, ya resuelto contra el catálogo. */
  overlay_seleccion: Record<string, string>;
  /** Los diseños que existen y para qué vistas valen. */
  overlay_disenos: OverlayDesignInfo[];
  /**
   * Raíz del servidor de overlays (HTTP, sin token ni vista).
   *
   * Es la base de la vista previa: la interfaz le añade
   * `?view=&diseno=&demo=1` para pintar un diseño con el simulador.
   */
  overlay_page_url: string | null;
  metrics: Metrics;
  db_path: string;
  schema_version: number;
  db_written: number;
  db_dropped: number;
  /** Lotes SQLite fallidos. */
  db_write_errors: number;
  /** Trabajos críticos incluidos en lotes SQLite fallidos. */
  db_critical_write_errors: number;
  log_dir: string;
  instance_port: number;
  /** Eventos reconocidos por la interfaz, por tipo (diagnóstico). */
  ui_events: Array<[string, number]>;
  /** Estado del lector de chat en voz alta. */
  tts: TtsStatus;
  /** Ajustes de las alertas de OBS. */
  alertas: AjustesAlertas;
  /** Los medios cargados, por nombre de fichero. */
  alertas_medios: string[];
  /** Avisos descartados por cola llena. */
  alertas_descartados: number;
  /**
   * El dispositivo que el monitor de alertas abrió de verdad, si abrió alguno.
   *
   * Se enseña en vez del elegido porque pueden no coincidir: si el que elegiste ya
   * no está, el motor degrada a mudo y lo dice aquí.
   */
  alertas_audio_dispositivo: string | null;
  /** Por qué el monitor de alertas está mudo, si lo está. */
  alertas_audio_problema: string | null;
  /** Traza del chat: recibido en la interfaz frente a renderizado (diagnóstico). */
  ui_chat: UiChatTrace;
}

/** Traza del chat del último tramo: recibido por la interfaz frente a pintado. */
export interface UiChatTrace {
  received: number;
  rendered: number;
  last_received_seq: number;
  last_rendered_seq: number;
  rendered_len: number;
  /** Medida del DOM enviada por la interfaz: quién desplaza de verdad la lista. */
  last_dom: string;
}

export interface TtsVoice {
  id: string;
  label: string;
  language: "es" | "en";
  gender: "female" | "male";
}

export interface TtsQueueItem {
  id: number;
  text: string;
  priority: number;
  effective_priority: number;
  waited_ms: number;
  source: string;
}

export interface TtsNowPlaying {
  id: number;
  user: string;
  text: string;
  priority: number;
}

export interface TtsDuration {
  secs: number;
  nanos: number;
}

export interface TtsFilters {
  enabled: boolean;
  max_chars: number;
  min_chars: number;
  user_cooldown: TtsDuration;
  global_interval: TtsDuration;
  global_burst: number;
  filter_urls: boolean;
  max_repeated_chars: number;
  duplicate_window: TtsDuration;
  spam_window: TtsDuration;
  blocked_words: string[];
  blocked_users: string[];
}

export interface TtsSettings {
  enabled: boolean;
  voice_es: string;
  voice_en: string;
  /** Plantilla de lo que se lee para un mensaje de chat. */
  chat_template: string;
  /** Plantilla de lo que se lee para un regalo que cierra su racha. */
  gift_template: string;
  /** Plantilla de lo que se lee para un seguidor nuevo. */
  follow_template: string;
  volume: number;
  rate: string;
  pitch: string;
  audio_device: string | null;
  /** Leer en voz alta los regalos que cierran su racha. */
  read_gifts: boolean;
  /** Leer los follows (apagado por defecto: son muchos). */
  read_follows: boolean;
  /** Motor de voz: el sidecar de siempre o Fish Audio. */
  provider: TtsProvider;
  /** Ajustes de Fish Audio. **Sin la clave**: los secretos no viajan aqui. */
  fish: TtsFishSettings;
  filters: TtsFilters;
  queue_capacity: number;
}

/** Motor de voz del lector de chat. */
export type TtsProvider = "edge" | "fish";

/**
 * Lo que se configura de Fish Audio.
 *
 * No hay campo para la clave **a proposito**: la interfaz escribe claves nuevas,
 * pero no puede leer las que hay (ver `TtsClave`).
 */
export interface TtsFishSettings {
  /** Codigo de voz (`reference_id`). */
  reference_id: string;
  /** Modelo. El gratuito por defecto. */
  model: string;
  /** Las voces guardadas con su nombre, de la mas nueva a la mas vieja. */
  voces: TtsVozGuardada[];
}

/**
 * El saldo de la cuenta del motor de voz.
 *
 * Es lo unico que **no** se calcula en local: el gasto son bytes por precio y sale
 * de aqui, pero lo que queda en la cuenta lo lleva el proveedor. Por eso lleva
 * `hace_segs` —para poder decir si el dato es de hace un rato— y `error` —un saldo
 * que no se pudo consultar no es un saldo a cero—.
 */
export interface TtsCuota {
  /** Lo que trae el plan. `null` si la API no lo manda. */
  total: number | null;
  /** Lo que queda. */
  restante: number | null;
  /** `free`, `pro`... Tal cual lo dice la API, sin traducir. */
  tipo: string;
  /** Lo que queda, de 0 a 100. `null` si no se puede calcular. */
  porcentaje: number | null;
  /** Hace cuanto se pregunto, en segundos. */
  hace_segs: number;
  /** El motivo del ultimo fallo, si lo hubo. */
  error: string | null;
}

/**
 * Una voz de Fish guardada por el streamer.
 *
 * La `referencia` **no es un secreto**: es el identificador publico de la voz en
 * Fish (`reference_id`), el mismo que se pega a mano. Por eso viaja con los demas
 * ajustes, al contrario que las claves de la API.
 */
export interface TtsVozGuardada {
  /** Como la llama el streamer. */
  nombre: string;
  /** Como la llama su creador en el catalogo. Se guardan los dos. */
  titulo_original: string;
  /** El identificador de la voz en su proveedor. Unico dentro de él. */
  referencia: string;
  /** De qué motor salió: `edge` o `fish`. */
  proveedor: string;
  /** Idioma, si se sabe (`es`, `en`). Vacío cuando no. */
  idioma: string;
  /** Una línea de descripción, o vacío. **Nunca** se guarda audio. */
  descripcion: string;
  /** Si está marcada con la estrella. Las favoritas van primero. */
  favorito: boolean;
  /**
   * Nombre del fichero de portada en la caché local, o vacío.
   *
   * Es un **nombre de fichero**, no una URL: se sirve por el servidor de overlays
   * (`/voces/portada/{archivo}`) y así la biblioteca sigue enseñando la voz
   * aunque Fish no conteste.
   */
  portada: string;
  autor: string;
  /** Identificador del autor, para poder pedir «más de este autor». */
  autor_id: string;
  autor_avatar: string;
  tags: string[];
  /** Las muestras **oficiales**: direcciones a audios ya hechos, no se generan. */
  muestras: TtsMuestraVoz[];
  actualizado_en: string;
}

/**
 * Una muestra ya hecha por Fish.
 *
 * `audio` es una dirección suya y **no se construye nunca a mano**: si no viene,
 * la voz no tiene muestra y se ofrece generarla.
 */
export interface TtsMuestraVoz {
  titulo: string;
  texto: string;
  audio: string;
}

/** Un modelo de Fish, con su tarifa en dolares por millon de bytes de texto. */
export interface TtsModelo {
  id: string;
  precio_por_millon: number;
}

/**
 * Que le falta al motor de voz para poder leer.
 *
 * Es un identificador y no una frase: el texto que se enseña vive en `i18n`,
 * como el resto (docs/decisions.md D4).
 */
export type TtsReadiness = "ready" | "missing_secret" | "missing_voice" | "no_usable_key";

/** En que estado esta una clave guardada. */
export type TtsClaveEstado = "viva" | "invalida" | "agotada" | "apagada";

/* --- La biblioteca de voces del catalogo de Fish ------------------------- */

/**
 * Una voz del catalogo de Fish, tal como la devuelve su API.
 *
 * Es de **solo lectura**: la aplicacion no crea, ni edita, ni borra voces en la
 * cuenta del streamer. `id` es el `reference_id` que se le manda a la sintesis.
 */
export interface TtsVozFish {
  id: string;
  titulo: string;
  descripcion: string;
  /** Portada que da la API. Puede venir vacía. */
  portada: string;
  /** Códigos de idioma (`es`, `en`…) tal cual los da la API. */
  idiomas: string[];
  tags: string[];
  muestras: TtsMuestraVoz[];
  autor: { id: string; nombre: string; avatar: string };
  visibilidad: string;
  /** `created`, `training`, `trained` o `failed`. */
  estado: string;
  me_gusta: number;
  usos: number;
  actualizado_en: string;
}

/** Una pagina del catalogo. */
export interface TtsPaginaVoces {
  total: number;
  pagina: number;
  tamano: number;
  items: TtsVozFish[];
}

/**
 * Lo que se le puede pedir al catalogo.
 *
 * Solo lo que la API confirma: buscar por titulo, un idioma, una etiqueta, un
 * autor y si son las voces propias. `sort_by` **no** se usa: el esquema lo declara
 * sin decir qué valores acepta.
 */
export interface TtsFiltrosVoces {
  buscar?: string;
  idioma?: string;
  tag?: string;
  autor?: string;
  propios?: boolean;
  pagina?: number;
  tamano?: number;
}

/**
 * Una clave de la API **enmascarada**.
 *
 * El valor no esta aqui y no puede estarlo: la interfaz escribe claves nuevas,
 * pero no puede leer las que hay. Es la unica forma de que una clave no acabe en
 * una captura de pantalla o en un log.
 */
export interface TtsClave {
  /** Posicion en la lista (0 = la primera que se intenta). */
  id: number;
  nombre: string;
  /** Pista enmascarada (`••••••••abcd`). */
  pista: string;
  estado: TtsClaveEstado;
  /** `true` en la que se esta usando ahora mismo. */
  en_uso: boolean;
  bytes: number;
  llamadas: number;
  /** Coste acumulado de esta clave, ya calculado por Rust. */
  usd: number;
}

/** Estado del motor de voz y de sus claves. */
export interface TtsVoz {
  proveedor: TtsProvider;
  listo: TtsReadiness;
  reference_id: string;
  modelo: string;
  modelos: TtsModelo[];
  claves_total: number;
  claves_vivas: number;
  clave_en_uso: string | null;
}

/**
 * Consumo medido localmente.
 *
 * Fish cobra por bytes UTF-8 del texto de **entrada**, asi que la aplicacion
 * cuenta su gasto sin preguntar a la API. Los dolares vienen ya calculados en
 * Rust: aqui no se multiplica nada.
 */
export interface TtsConsumo {
  modelo: string;
  precio_por_millon: number;
  sesion_bytes: number;
  sesion_llamadas: number;
  sesion_usd: number;
  total_bytes: number;
  total_llamadas: number;
  total_usd: number;
  /** Desglose por clave, en el orden de la lista. */
  claves: TtsClave[];
}

export interface TtsStatus {
  enabled: boolean;
  paused: boolean;
  /** Ajustes en uso, no los que la interfaz crea recordar. */
  settings: TtsSettings;
  playing: TtsNowPlaying | null;
  queued: TtsQueueItem[];
  queued_len: number;
  played: number;
  dropped: number;
  from_cache: number;
  synthesized: number;
  synth_failures: number;
  muted_users: number;
  rejections: Array<[string, number]>;
  degraded: string | null;
  degraded_kind: "audio" | "provider" | null;
  provider_degraded: string | null;
  audio_degraded: string | null;
  audio_device: string | null;
  /** El motor de voz elegido y el estado de sus claves. */
  voz: TtsVoz;
  /** Lo que se lleva gastado, contado en local. */
  consumo: TtsConsumo;
}

export const api = {
  snapshot: () => invoke<Snapshot>("app_snapshot"),
  metrics: () => invoke<Metrics>("app_metrics"),
  connect: (handle: string) => invoke<Snapshot>("connect", { handle }),
  simulate: (handle?: string) =>
    invoke<Snapshot>("start_simulation", { handle: handle ?? null }),
  useNativeProvider: () => invoke<Snapshot>("use_native_provider"),
  disconnect: () => invoke<Snapshot>("disconnect"),
  clearChat: () => invoke<void>("clear_chat"),
  clearFeed: () => invoke<void>("clear_feed"),
  /** Avisa a Rust de que la interfaz ya recibe eventos (diagnóstico). */
  uiReceiving: () => invoke<void>("ui_receiving"),
  /** Informa a Rust de cuántos eventos de cada tipo se han pintado (diagnóstico). */
  uiEvents: (counts: Record<string, number>) => invoke<void>("ui_events", { counts }),
  /**
   * Diagnóstico temporal del chat: qué mensaje llegó a la interfaz y qué lista
   * llegó a pintarse. `dom` describe quién desplaza de verdad la lista.
   */
  uiChat: (payload: {
    received_seq?: number;
    rendered_len?: number;
    rendered_seq?: number;
    dom?: string;
  }) => invoke<void>("ui_chat", { payload }),
  /** Reporta un error de render para que quede en el log. */
  uiError: (message: string) => invoke<void>("ui_error", { message }),

  ttsStatus: () => invoke<TtsStatus>("tts_status"),
  /**
   * El saldo de la cuenta del motor de voz, preguntado a su API.
   *
   * Va aparte del estado porque es una consulta de red: puede tardar y puede
   * fallar, y el estado no tiene por qué esperarla. `null` cuando el motor puesto
   * no tiene cuenta que mirar (el local no cobra por uso).
   */
  ttsCuota: () => invoke<TtsCuota | null>("tts_cuota"),
  ttsUpdate: (patch: {
    enabled?: boolean;
    volume?: number;
    rate?: string;
    pitch?: string;
    /** Plantilla de lo que se lee para un mensaje de chat. */
    chat_template?: string;
    /** Plantilla de lo que se lee para un regalo. */
    gift_template?: string;
    /** Plantilla de lo que se lee para un seguidor nuevo. */
    follow_template?: string;
    voice_es?: string;
    voice_en?: string;
    read_gifts?: boolean;
    read_follows?: boolean;
    provider?: TtsProvider;
    fish_reference_id?: string;
    fish_model?: string;
    /** La lista **entera**: la interfaz manda el resultado de anadir o quitar. */
    fish_voces?: TtsVozGuardada[];
  }) => invoke<void>("tts_update", { patch }),
  ttsAction: (action: string, value?: string) =>
    invoke<void>("tts_action", { action, value: value ?? null }),
  ttsVoices: () => invoke<TtsVoice[]>("tts_voices"),
  ttsDevices: () => invoke<string[]>("tts_devices"),
  ttsSelectDevice: (device: string | null) =>
    invoke<TtsStatus>("tts_select_device", { device }),

  /**
   * Guarda una clave de la API de voz.
   *
   * Es **escritura sola**: se manda una clave nueva y el motor contesta con el
   * estado, que solo lleva su pista enmascarada. La interfaz no puede leer la
   * clave que hay, ni siquiera la que acaba de mandar.
   */
  ttsKeyAdd: (nombre: string, clave: string) =>
    invoke<TtsStatus>("tts_key_add", { nombre, clave }),

  /** Quita una clave de la lista, por su posicion. */
  ttsKeyRemove: (id: number) => invoke<TtsStatus>("tts_key_remove", { id }),

  /** Vuelve a intentar una clave marcada como invalida o agotada. */
  ttsKeyReset: (id: number) => invoke<TtsStatus>("tts_key_reset", { id }),

  /** Le pone otro nombre a una clave. */
  ttsKeyRename: (id: number, nombre: string) =>
    invoke<TtsStatus>("tts_key_rename", { id, nombre }),

  /** Apaga una clave: deja de intentarse sin perderla. */
  ttsKeyDisable: (id: number) => invoke<TtsStatus>("tts_key_disable", { id }),

  /** Comprueba una clave contra la API. No gasta saldo ni cambia su estado. */
  ttsKeyProbar: (id: number) => invoke<null>("tts_key_probar", { id }),

  // --- La biblioteca de voces ---------------------------------------------

  /** Una pagina del catalogo de Fish. */
  ttsVocesBuscar: (filtros: TtsFiltrosVoces) =>
    invoke<TtsPaginaVoces>("tts_voces_buscar", { filtros }),

  /** Una voz del catalogo, con sus muestras oficiales. */
  ttsVozObtener: (id: string) => invoke<TtsVozFish>("tts_voz_obtener", { id }),

  /** Guarda una voz del catalogo en «Mis voces». Si ya estaba, no la duplica. */
  ttsVozGuardar: (id: string, nombre?: string) =>
    invoke<TtsStatus>("tts_voz_guardar", { id, nombre: nombre ?? null }),

  /** Quita una voz de la lista local. **No** toca la cuenta de Fish. */
  ttsVozQuitar: (referencia: string) =>
    invoke<TtsStatus>("tts_voz_quitar", { referencia }),

  ttsVozRenombrar: (referencia: string, nombre: string) =>
    invoke<TtsStatus>("tts_voz_renombrar", { referencia, nombre }),

  ttsVozFavorita: (referencia: string, favorito: boolean) =>
    invoke<TtsStatus>("tts_voz_favorita", { referencia, favorito }),

  /** Refresca los datos de una voz guardada preguntandoselos otra vez a Fish. */
  ttsVocesActualizar: (referencia: string) =>
    invoke<TtsStatus>("tts_voces_actualizar", { referencia }),

  /** Genera una prueba con el motor de siempre. **Cuesta saldo.** */
  ttsVozProbar: (referencia: string, texto?: string) =>
    invoke<string>("tts_voz_probar", { referencia, texto: texto ?? null }),

  /** Deja la portada de una voz en la cache local y devuelve su fichero. */
  ttsVozPortada: (id: string, url: string) =>
    invoke<string>("tts_voz_portada", { id, url }),

  /**
   * Activa o desactiva el histórico de aportaciones de por vida.
   *
   * Devuelve la foto nueva: el ajuste cambia lo que se enseña, así que la
   * interfaz se repinta con lo que devuelve en vez de pedir otro snapshot.
   */
  setLifetime: (enabled: boolean) => invoke<Snapshot>("set_lifetime", { enabled }),

  /**
   * Cambia el diseño de una vista del overlay.
   *
   * Devuelve la foto nueva: la elección cambia lo que se ve y conviene pintarlo al
   * instante. El motor guarda el fichero **antes** de publicarlo, así que un
   * error aquí significa que no se ha cambiado nada.
   */
  setOverlayDesign: (vista: string, diseno: string) =>
    invoke<Snapshot>("set_overlay_design", { vista, diseno }),

  /**
   * Guarda los ajustes de las alertas.
   *
   * Va entero y no por tipo: son cinco ajustes pequeños y mandar un parche
   * parcial obligaría al motor a fusionar, que es donde se cuelan los campos que
   * nadie quería cambiar.
   */
  setAlertas: (ajustes: AjustesAlertas) => invoke<Snapshot>("set_alertas", { ajustes }),

  /** Copia un fichero del disco al almacén de medios (ruta, no contenido). */
  importarMedioAlerta: (ruta: string) =>
    invoke<Snapshot>("importar_medio_alerta", { ruta }),

  /** Copia al almacén un fichero que llega del selector del navegador. */
  importarMedioAlertaBytes: (nombre: string, bytes: number[]) =>
    invoke<Snapshot>("importar_medio_alerta_bytes", { nombre, bytes }),

  /**
   * Copia **varios** ficheros de una vez.
   *
   * Un fichero que no vale no tira los demás: devuelve cuántos entraron y qué
   * falló en cada uno, y eso se enseña.
   */
  importarMediosAlerta: (rutas: string[]) =>
    invoke<ImportacionMedios>("importar_medios_alerta", { rutas }),

  borrarMedioAlerta: (nombre: string) =>
    invoke<Snapshot>("borrar_medio_alerta", { nombre }),

  /** Encola un aviso de prueba para verlo en OBS sin esperar a que pase algo. */
  probarAlerta: (tipo: string) => invoke<Snapshot>("probar_alerta", { tipo }),

  /**
   * Suena un medio en el monitor del streamer, sin encolar ningún aviso.
   *
   * Es el botón de oír: una lista de nombres no dice cómo suena nada. Corta lo que
   * estuviera sonando en el monitor y **pide el turno del preview**: ver
   * `previewAudio.tsx`.
   */
  oirMedio: (nombre: string) => invoke<void>("oir_medio", { nombre }),

  /**
   * Para el audio de previsualización que esté sonando.
   *
   * Lo llama el coordinador antes de reproducir cualquier cosa —para que no se
   * solapen— y cuando se corta a mano: el mismo sonido pulsado dos veces o el
   * cambio de pestaña.
   *
   * Con `esperado` solo se suelta **ese** preview. Es lo que evita que una orden de
   * parar que llega tarde apague el sonido que acaba de empezar: sin él, parar es
   * incondicional, que es lo que se quiere cuando el streamer pulsa «Parar».
   */
  pararPreview: (esperado?: DuenioPreview | null) =>
    invoke<void>("parar_preview", { esperado: esperado ?? null }),

  /**
   * Quién tiene el turno del preview, si alguien.
   *
   * El motor lo limpia solo cuando el sonido que encoló **ya terminó**, así que
   * preguntarlo es también la forma de saber si sigue sonando.
   */
  previewEstado: () => invoke<DuenioPreview | null>("preview_estado"),

  /**
   * Abre el perfil de TikTok de una persona en el navegador.
   *
   * El handle lo valida y la URL la construye Rust: el WebView nunca arma una
   * URL que el sistema operativo vaya a abrir.
   */
  abrirPerfil: (uniqueId: string) => invoke<void>("abrir_perfil", { unique_id: uniqueId }),};

export function onDashEvent(handler: (event: WireEvent) => void): Promise<UnlistenFn> {
  if (enEscritorio) {
    return escucharTauri<WireEvent>("dash://event", (message) => handler(message.payload));
  }
  return escucharPorWebSocket(handler);
}
