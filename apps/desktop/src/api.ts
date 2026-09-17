//! Puente con Rust.
//!
//! Regla de la arquitectura (docs/plan-review.md §39): Rust es la fuente de
//! verdad. La interfaz pide un `snapshot` al abrirse y, a partir de ahi, solo
//! recibe eventos. No guarda historial propio.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface UserRef {
  id: string;
  unique_id: string;
  nickname: string;
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
  | { type: "stream.connected"; room_id: string; title: string }
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
   * `source_id` es el `msg_id` del mensaje borrado, el mismo que viaja en la
   * envoltura de su `chat.message` (y que la interfaz guarda en `ChatEntry`).
   * Ojo: la envoltura del evento **tambien** tiene un `source_id` y el enum va
   * aplanado (`#[serde(flatten)]`), asi que la clave se escribe dos veces; el
   * campo del payload se serializa despues y es el que gana.
   */
  | { type: "chat.message.deleted"; source_id: string }
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
      top_gifters: GifterEntry[];
      gifts_by_type: GiftTypeSummary[];
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

export interface GifterEntry {
  user: UserRef;
  diamonds: number;
  gifts: number;
}

export interface GiftTypeSummary {
  gift_id: string;
  gift_name: string;
  count: number;
  diamonds: number;
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

export interface Snapshot {
  protocol_version: number;
  provider: string;
  status: string;
  handle: string;
  room_id: string;
  stream_id: string | null;
  title: string;
  started_at_ms: number | null;
  chat: ChatEntry[];
  events: FeedItem[];
  gifts: GiftEventView[];
  top_gifters: GifterEntry[];
  gifts_by_type: GiftTypeSummary[];
  total_gifts: number;
  total_diamonds: number;
  metrics: Metrics;
  db_path: string;
  schema_version: number;
  db_written: number;
  db_dropped: number;
  log_dir: string;
  instance_port: number;
  /** Eventos reconocidos por la interfaz, por tipo (diagnóstico). */
  ui_events: Array<[string, number]>;
  /** Estado del lector de chat en voz alta. */
  tts: TtsStatus;
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

export interface TtsSettings {
  enabled: boolean;
  voice_es: string;
  voice_en: string;
  say_author: boolean;
  volume: number;
  rate: string;
  pitch: string;
  /** Leer en voz alta los regalos que cierran su racha. */
  read_gifts: boolean;
  /** Leer los follows (apagado por defecto: son muchos). */
  read_follows: boolean;
  queue_capacity: number;
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
  ttsUpdate: (patch: {
    enabled?: boolean;
    volume?: number;
    rate?: string;
    pitch?: string;
    say_author?: boolean;
    voice_es?: string;
    voice_en?: string;
    read_gifts?: boolean;
    read_follows?: boolean;
  }) => invoke<void>("tts_update", { patch }),
  ttsAction: (action: string, value?: string) =>
    invoke<void>("tts_action", { action, value: value ?? null }),
  ttsVoices: () => invoke<TtsVoice[]>("tts_voices"),
};

export function onDashEvent(handler: (event: WireEvent) => void): Promise<UnlistenFn> {
  return listen<WireEvent>("dash://event", (message) => handler(message.payload));
}
