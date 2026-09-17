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
// Mensajes concretos
// ---------------------------------------------------------------------------

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
}

#[derive(Clone, PartialEq, Message)]
pub struct User {
    #[prost(int64, tag = "1")]
    pub id: i64,
    #[prost(string, tag = "3")]
    pub nickname: String,
    /// v3: antiguo `unique_id`, el @handle.
    #[prost(string, tag = "38")]
    pub display_id: String,
    #[prost(string, tag = "46")]
    pub sec_uid: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct WebcastChatMessage {
    #[prost(message, tag = "1")]
    pub common: Option<CommonMessageData>,
    #[prost(message, tag = "2")]
    pub user: Option<User>,
    #[prost(string, tag = "3")]
    pub content: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct Gift {
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
}
