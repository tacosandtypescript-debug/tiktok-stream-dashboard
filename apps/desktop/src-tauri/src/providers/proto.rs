//! Structs de prost para el subconjunto del esquema TikTok Webcast v3 que el
//! spike necesita.
//!
//! Los numeros de campo NO se han copiado a mano de un `.proto`: se han
//! extraido de la metadata real de `betterproto2` del paquete `TikTokLiveProto`
//! v3 instalado (ver `spikes/provider-probe/dump_proto.py` y `proto-fields.json`).
//!
//! Desviaciones deliberadas del proto original, todas irrelevantes para el
//! cable pero mas simples en Rust:
//!   * se decodifica con semantica proto3 (escalares con valor por defecto en
//!     lugar de `Option<T>`), asi que "ausente" y "cero" se confunden;
//!   * los campos que el spike no usa (imagenes, badges, efectos) se omiten:
//!     prost ignora los campos desconocidos.
//!
//! OJO con la nomenclatura v3 (v7 de TikTokLive la cambio sin cambiar los
//! numeros): `User.display_id` es el antiguo `unique_id`, y `Gift.name` es el
//! antiguo `gift_name`.

use std::collections::HashMap;

use prost::Message;

// ---------------------------------------------------------------------------
// Envoltorio de frame
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct PushHeader {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(string, tag = "2")]
    pub value: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct WebcastPushFrame {
    #[prost(uint64, tag = "1")]
    pub seq_id: u64,
    /// Debe reenviarse tal cual en el ACK.
    #[prost(uint64, tag = "2")]
    pub log_id: u64,
    /// OJO: en el proto real es `uint64`, no una cadena. Declararlo como string
    /// hace que prost rechace TODOS los frames por discrepancia de wire type.
    #[prost(uint64, tag = "3")]
    pub service: u64,
    /// Idem: `uint64`.
    #[prost(uint64, tag = "4")]
    pub method: u64,
    /// Aqui vive `compress_type == "gzip"`.
    #[prost(message, repeated, tag = "5")]
    pub headers: Vec<PushHeader>,
    #[prost(string, tag = "6")]
    pub payload_encoding: String,
    /// `"msg"` para eventos, `"ack"`, `"hb"`.
    #[prost(string, tag = "7")]
    pub payload_type: String,
    /// Bytes crudos (nunca base64).
    #[prost(bytes = "vec", tag = "8")]
    pub payload: Vec<u8>,
}

impl WebcastPushFrame {
    pub fn compress_type(&self) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == "compress_type")
            .map(|h| h.value.as_str())
    }
}

// ---------------------------------------------------------------------------
// Respuesta envolvente
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct BaseProtoMessage {
    #[prost(string, tag = "1")]
    pub method: String,
    #[prost(bytes = "vec", tag = "2")]
    pub payload: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoMessageFetchResult {
    #[prost(message, repeated, tag = "1")]
    pub messages: Vec<BaseProtoMessage>,
    #[prost(string, tag = "2")]
    pub cursor: String,
    #[prost(int64, tag = "3")]
    pub fetch_interval: i64,
    #[prost(int64, tag = "4")]
    pub now: i64,
    /// En el proto original es `bytes`; el ACK lo reenvia tal cual.
    #[prost(bytes = "vec", tag = "5")]
    pub internal_ext: Vec<u8>,
    #[prost(int32, tag = "6")]
    pub fetch_type: i32,
    #[prost(map = "string, string", tag = "7")]
    pub route_params: HashMap<String, String>,
    #[prost(int64, tag = "8")]
    pub heartbeat_duration: i64,
    #[prost(bool, tag = "9")]
    pub need_ack: bool,
    #[prost(string, tag = "10")]
    pub push_server: String,
    #[prost(bool, tag = "11")]
    pub is_first: bool,
}

// ---------------------------------------------------------------------------
// Handshake del WebSocket
// ---------------------------------------------------------------------------

/// Peticion de entrada en la sala (`payload_type = "im_enter_room"`).
///
/// **Es obligatoria**: sin ella el push server acepta el WebSocket pero no
/// empuja ni un solo frame (ver `docs/decisions.md` D9). La implementacion de
/// referencia la envia en cuanto la respuesta firmada llega con `is_first`.
#[derive(Clone, PartialEq, Message)]
pub struct WebcastImEnterRoomMessage {
    #[prost(int64, tag = "1")]
    pub room_id: i64,
    #[prost(string, tag = "2")]
    pub room_tag: String,
    /// Solo existe en v3: desplaza `live_id` al tag 4 (por eso no vale copiar
    /// los numeros de un `.proto` de terceros).
    #[prost(string, tag = "3")]
    pub live_region: String,
    #[prost(int64, tag = "4")]
    pub live_id: i64,
    #[prost(string, tag = "5")]
    pub identity: String,
    #[prost(string, tag = "6")]
    pub cursor: String,
    #[prost(int64, tag = "7")]
    pub account_type: i64,
    #[prost(int64, tag = "8")]
    pub enter_unique_id: i64,
    #[prost(string, tag = "9")]
    pub filter_welcome_msg: String,
    #[prost(bool, tag = "10")]
    pub is_anchor_continue_keep_msg: bool,
}

/// Latido que viaja dentro de los frames `hb`.
#[derive(Clone, PartialEq, Message)]
pub struct HeartBeatMessage {
    #[prost(int64, tag = "1")]
    pub room_id: i64,
    #[prost(int64, tag = "2")]
    pub send_packet_seq_id: i64,
}

// ---------------------------------------------------------------------------
// Mensajes concretos
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct Text {
    /// En v3 este campo se llama `key` (antes `display_type`).
    #[prost(string, tag = "1")]
    pub key: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct CommonMessageData {
    #[prost(string, tag = "1")]
    pub method: String,
    #[prost(int64, tag = "2")]
    pub msg_id: i64,
    #[prost(int64, tag = "3")]
    pub room_id: i64,
    #[prost(int64, tag = "4")]
    pub create_time: i64,
    #[prost(string, tag = "7")]
    pub describe: String,
    /// Texto de sistema del mensaje. Su `key` es el discriminador fiable entre
    /// follow y share: el campo `action` de WebcastSocialMessage no lo es.
    #[prost(message, tag = "8")]
    pub display_text: Option<Text>,
}

impl CommonMessageData {
    pub fn display_key(&self) -> &str {
        self.display_text
            .as_ref()
            .map(|text| text.key.as_str())
            .unwrap_or("")
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct User {
    #[prost(int64, tag = "1")]
    pub id: i64,
    #[prost(string, tag = "3")]
    pub nickname: String,
    /// Foto de perfil en tres calidades. Los tags (9, 10 y 11) salen de la
    /// metadata real instalada (`spikes/provider-probe/proto-fields.json`), la
    /// misma fuente que el resto de campos; no se copian de un `.proto` de
    /// terceros (convencion del proyecto).
    ///
    /// Se declaran las tres porque las tres viajan, pero solo se usa
    /// `avatar_thumb`: es la que se pinta en las tablas y la que menos pesa en
    /// cada evento (el avatar viaja en **todos** los eventos con usuario, asi que
    /// su tamano se multiplica por el trafico del directo).
    #[prost(message, tag = "9")]
    pub avatar_thumb: Option<ImageModel>,
    #[prost(message, tag = "10")]
    pub avatar_medium: Option<ImageModel>,
    #[prost(message, tag = "11")]
    pub avatar_large: Option<ImageModel>,
    /// v3: antiguo `unique_id`, el @handle.
    #[prost(string, tag = "38")]
    pub display_id: String,
    #[prost(string, tag = "46")]
    pub sec_uid: String,
}

impl User {
    /// URL de la foto de perfil que se muestra. Cadena vacia si TikTok no la
    /// manda (el usuario puede tener el avatar oculto): quien pinta decide el
    /// sustituto, aqui no se inventa una imagen.
    pub fn avatar_url(&self) -> String {
        self.avatar_thumb
            .as_ref()
            .map(ImageModel::best_url)
            .unwrap_or_default()
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct WebcastChatMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, tag = "2")]
    pub user: Option<User>,
    #[prost(string, tag = "3")]
    pub content: String,
    /// Emotes que trae el mensaje (`emotes`, tag 13, `EmoteWithIndex`).
    ///
    /// Existe porque TikTok manda los mensajes que son **solo** emote con
    /// `content` vacio (un espacio) y la lista aparte: sin este campo se
    /// descartaban enteros y desaparecian lineas del chat.
    #[prost(message, repeated, tag = "13")]
    pub emotes: Vec<EmoteWithIndex>,
}

/// Elemento de la lista de emotes de un comentario.
///
/// Solo se declara `index` (tag 1): de la lista interesa **cuantos** emotes hay,
/// no cuales (un mensaje que es solo emote llega con `content` vacio). Declarar
/// aqui el `Emote` entero (tag 2) seria copiar media tabla de tipos para nada, y
/// prost ignora los campos que no se declaran.
#[derive(Clone, PartialEq, Message)]
pub struct EmoteWithIndex {
    #[prost(int64, tag = "1")]
    pub index: i64,
}

/// Entrada (o salida) de alguien en la sala.
///
/// Es el mensaje **mas frecuente** de TikTok: 60 de los 180 mensajes de la
/// grabacion `spikes/tiktok-rust-provider/live.jsonl`. Solo se declaran `common`
/// y `user` porque es lo unico que necesita el evento `member.joined`.
///
/// **No** se declara `action` (tag 10, enum `MemberMessageAction`) a proposito:
/// la spec describe este mensaje como "una variedad de eventos, incluidas
/// entradas y suscripciones", asi que filtrar por ese enum arriesgaria descartar
/// entradas reales; el contador de la interfaz no distingue el motivo de la
/// entrada. Los valores del enum (`JOINED = 1`, `SUBSCRIBED = 3`) si estan
/// verificados en la metadata instalada, pero no se usan.
#[derive(Clone, PartialEq, Message)]
pub struct WebcastMemberMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, tag = "2")]
    pub user: Option<User>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ImageModel {
    /// Lista de URLs por calidades alternativas; la primera es la principal.
    #[prost(string, repeated, tag = "1")]
    pub url_list: Vec<String>,
    #[prost(string, tag = "2")]
    pub uri: String,
    #[prost(int32, tag = "3")]
    pub height: i32,
    #[prost(int32, tag = "4")]
    pub width: i32,
}

impl ImageModel {
    pub fn best_url(&self) -> String {
        self.url_list.first().cloned().unwrap_or_default()
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct Gift {
    /// Icono del regalo. Es lo que permite mostrar el regalo en el panel.
    #[prost(message, tag = "1")]
    pub image: Option<ImageModel>,
    #[prost(string, tag = "2")]
    pub describe: String,
    #[prost(int32, tag = "4")]
    pub duration: i32,
    #[prost(int64, tag = "5")]
    pub id: i64,
    #[prost(bool, tag = "10")]
    pub combo: bool,
    /// `1` == streakable.
    #[prost(int32, tag = "11")]
    pub r#type: i32,
    #[prost(int32, tag = "12")]
    pub diamond_count: i32,
    /// v3: antiguo `gift_name`.
    #[prost(string, tag = "16")]
    pub name: String,
}

impl Gift {
    /// Un regalo es acumulable (streak) solo si `type == 1`.
    pub fn streakable(&self) -> bool {
        self.r#type == 1
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct WebcastGiftMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "2")]
    pub gift_id: i64,
    #[prost(int32, tag = "5")]
    pub repeat_count: i32,
    #[prost(int32, tag = "6")]
    pub combo_count: i32,
    #[prost(message, tag = "7")]
    pub user: Option<User>,
    /// `!= 0` marca el ultimo regalo del streak.
    #[prost(int32, tag = "9")]
    pub repeat_end: i32,
    /// Para deduplicar.
    #[prost(int64, tag = "11")]
    pub group_id: i64,
    #[prost(message, tag = "15")]
    pub gift: Option<Gift>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WebcastLikeMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    /// Incremento desde el ultimo evento.
    #[prost(int32, tag = "2")]
    pub count: i32,
    /// Total absoluto del directo.
    #[prost(int64, tag = "3")]
    pub total: i64,
    #[prost(message, tag = "5")]
    pub user: Option<User>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WebcastRoomUserSeqMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, tag = "3")]
    pub total: i64,
    #[prost(int64, tag = "7")]
    pub total_user: i64,
}

#[derive(Clone, PartialEq, Message)]
pub struct WebcastSocialMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, tag = "2")]
    pub user: Option<User>,
    #[prost(int64, tag = "3")]
    pub share_type: i64,
    #[prost(int64, tag = "4")]
    pub action: i64,
    #[prost(int64, tag = "6")]
    pub follow_count: i64,
    #[prost(int32, tag = "8")]
    pub share_count: i32,
}

/// Control del directo (pausa, reanudacion, fin, suspension).
///
/// `action` (tag 2, enum `ControlAction`) es el discriminador y sus valores se
/// verificaron en la metadata instalada (ver `dump_proto.py`). Se declara como
/// `int32` en lugar de como enumeracion de prost porque en el cable un enum es
/// un varint y el resto del modulo ya modela los enums asi; los valores utiles
/// son constantes con nombre para que el numero no quede suelto en la rama de
/// traduccion.
#[derive(Clone, PartialEq, Message)]
pub struct WebcastControlMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int32, tag = "2")]
    pub action: i32,
}

impl WebcastControlMessage {
    /// `ControlAction::STREAM_ENDED`: el directo ha terminado.
    pub const STREAM_ENDED: i32 = 3;
    /// `ControlAction::STREAM_SUSPENDED`: TikTok ha cortado el directo.
    ///
    /// La spec lo agrupa con `STREAM_ENDED` en el mismo evento de fin
    /// (`LiveEndEvent`), asi que aqui tambien cierra la sesion.
    pub const STREAM_SUSPENDED: i32 = 4;
}

/// Borrado de comentarios por moderacion.
///
/// `delete_msg_ids` (tag 2) trae los `msg_id` de los mensajes borrados, y un
/// mismo aviso puede borrar varios. `delete_user_ids` (tag 3) no se declara: el
/// evento interno identifica el mensaje borrado, no el usuario.
#[derive(Clone, PartialEq, Message)]
pub struct WebcastImDeleteMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(int64, repeated, tag = "2")]
    pub delete_msg_ids: Vec<i64>,
}

/// Aviso de suscripcion (subscribe, renovacion o regalo de suscripcion).
///
/// Los enums `subscribe_type` y `gift_source` no estan verificados en directo,
/// asi que solo se emite un evento cuando llega `sub_month`, que es un dato
/// inequivoco: hay meses de suscripcion implicados.
#[derive(Clone, PartialEq, Message)]
pub struct WebcastSubNotifyMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, tag = "2")]
    pub user: Option<User>,
    #[prost(int64, tag = "4")]
    pub sub_month: i64,
    #[prost(int32, tag = "5")]
    pub subscribe_type: i32,
    #[prost(bool, tag = "9")]
    pub is_send: bool,
    #[prost(bool, tag = "10")]
    pub is_custom: bool,
}
