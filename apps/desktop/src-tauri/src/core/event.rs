//! Protocolo interno de eventos, versionado.
//!
//! Es el unico contrato entre el provider y el resto de la aplicacion: ningun
//! modulo conoce los tipos de TikTok (docs/plan-review.md §4-§5).
//!
//! Correcciones de la revision incorporadas aqui:
//!   * `event_id` y `seq` (deduplicacion y deteccion de huecos)
//!   * `source_id`: identificador del mensaje en origen (TikTok `msg_id`), que
//!     permite descartar duplicados dentro de una sala tras una reconexion
//!   * el provider envia `room_id`, no un `stream_id` propio de Rust
//!   * los regalos llevan `group_id` (identifica el streak real), `is_final`
//!     (`repeat_end != 0`) y `streakable` (`type == 1`)

use serde::{Deserialize, Serialize};

/// Version del protocolo. Cambiarla obliga a revisar el adapter.
pub const PROTOCOL_VERSION: u32 = 1;

/// Perfil publico del duenio de la sala.
///
/// Se declara aqui, con el resto de formas del contrato (`UserRef`, `GiftInfo`),
/// y no en el provider: la capa de abajo no puede conocer a la de arriba. El
/// provider solo lo rellena con lo que le conteste TikTok.
///
/// Los tres contadores van en `Option` a proposito: TikTok renombra estos campos
/// cada temporada y un cero pintado en la interfaz seria una mentira. Sin dato,
/// la ficha simplemente no ensena esa cifra.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Perfil {
    pub unique_id: String,
    pub nickname: String,
    pub avatar: String,
    pub bio: String,
    pub seguidores: Option<u64>,
    pub seguidos: Option<u64>,
    pub likes: Option<u64>,
}

impl Perfil {
    /// Sin apodo ni identificador no hay ficha que pintar.
    ///
    /// El perfil es un adorno de la cabecera, no un requisito: cuando TikTok no
    /// lo manda, conectar tiene que seguir funcionando exactamente igual.
    pub fn esta_vacio(&self) -> bool {
        self.unique_id.is_empty() && self.nickname.is_empty()
    }
}

/// Referencia a un usuario de TikTok. La clave canonica es `id` numerico: el
/// `unique_id` (el @handle) puede cambiar.
///
/// Lleva `Default` a proposito: `avatar_url` es opcional y son muchos los sitios
/// (simulador, `fixtures` y tests) que construyen un usuario sin foto. Con
/// `Default` esos sitios hacen `..Default::default()` y anadir un campo nuevo
/// manana no obliga a tocar once literales.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserRef {
    pub id: String,
    pub unique_id: String,
    pub nickname: String,
    /// Foto de perfil (miniatura). Cadena vacia cuando TikTok no la manda.
    ///
    /// Se omite del JSON si esta vacia: asi el contrato de los eventos no cambia
    /// de forma para quien no tiene avatar, y las fotos de `fixtures`/tests
    /// anteriores siguen siendo validas.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub avatar_url: String,
}

impl UserRef {
    pub fn display(&self) -> String {
        if self.nickname.is_empty() {
            format!("@{}", self.unique_id)
        } else {
            format!("{} (@{})", self.nickname, self.unique_id)
        }
    }
}

/// Regalo normalizado. `diamond_count` es la unidad canonica (lo que reporta
/// TikTok); no se persiste ninguna conversion a "coins" (ver plan-review §P1-3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GiftInfo {
    pub id: String,
    pub name: String,
    /// Icono del regalo, si TikTok lo envia.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub image_url: String,
    pub diamond_count: i32,
    /// `gift.type == 1`
    pub streakable: bool,
    /// Progreso del streak tal como lo envia TikTok (es un incremento).
    pub repeat_count: i32,
    /// `repeat_end != 0`: ultimo evento del streak.
    pub is_final: bool,
    /// Identifica el streak. `"0"`/vacio para regalos no acumulables.
    pub group_id: String,
}

impl GiftInfo {
    /// Constructor con lo imprescindible. El icono se anade aparte con
    /// `with_image`.
    ///
    /// Existe para que anadir campos nuevos a `GiftInfo` (como el icono) no
    /// obligue a tocar cada sitio que construye un regalo: el compilador deja
    /// de ser un obstaculo y el cambio queda en un solo lugar.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        diamond_count: i32,
        streakable: bool,
        repeat_count: i32,
        is_final: bool,
        group_id: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            image_url: String::new(),
            diamond_count,
            streakable,
            repeat_count,
            is_final,
            group_id: group_id.into(),
        }
    }

    pub fn with_image(mut self, image_url: impl Into<String>) -> Self {
        self.image_url = image_url.into();
        self
    }

    /// Unidades que representa este evento. Un regalo no acumulable puede llegar
    /// sin `repeat_count` (0), y entonces vale una unidad.
    pub fn units(&self) -> i32 {
        self.repeat_count.max(1)
    }

    /// Diamantes que aporta el evento **si se contabiliza**.
    pub fn diamonds(&self) -> i32 {
        self.diamond_count.saturating_mul(self.units())
    }

    /// Si este evento cierra su aportacion.
    ///
    /// Los eventos de progreso de una racha son **acumulativos**: sumarlos uno a
    /// uno convertiria una racha de 5 rosas en 1+2+3+4+5. Solo cuenta el evento
    /// que cierra la racha (`is_final`), y los regalos no acumulables cuentan
    /// siempre.
    pub fn commits(&self) -> bool {
        self.is_final || !self.streakable
    }
}

/// Quien mas ha aportado en la sesion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GifterEntry {
    pub user: UserRef,
    pub diamonds: i64,
    pub gifts: i64,
}

/// Regalos agrupados por tipo (unidades, no eventos).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GiftTypeSummary {
    pub gift_id: String,
    pub gift_name: String,
    pub count: i64,
    pub diamonds: i64,
}

/// Una persona y lo que ha aportado en la sesion.
///
/// Es el tipo comun de las tres tablas de ranking: tap tap (likes), regalos y
/// follows. Se unifica a proposito porque las tres se pintan igual (puesto, foto,
/// nombre y una cifra); una forma distinta por tabla obligaria a tres componentes
/// de interfaz para lo mismo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RankingEntry {
    pub user: UserRef,
    /// La cifra que se muestra y por la que se ordena.
    pub value: i64,
    /// Cuantas veces ha contribuido (tap, regalo o follow).
    pub events: u64,
}

/// Tipos de evento del protocolo interno.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EventKind {
    #[serde(rename = "stream.connected")]
    StreamConnected {
        room_id: String,
        title: String,
        /// Perfil del duenio de la sala.
        ///
        /// Viaja con la conexion y no en un evento aparte porque se conoce en el
        /// mismo instante: los dos caminos que resuelven la sala ya lo traen en
        /// su misma respuesta.
        ///
        /// `default` para poder leer un evento grabado antes de que existiera
        /// este campo.
        #[serde(default)]
        perfil: Perfil,
    },

    #[serde(rename = "stream.disconnected")]
    StreamDisconnected { reason: String },

    #[serde(rename = "stream.waiting")]
    StreamWaiting { handle: String, detail: String },

    #[serde(rename = "chat.message")]
    ChatMessage {
        user: UserRef,
        content: String,
        /// Cuantos emotes del fansclub traia el mensaje.
        ///
        /// TikTok manda los mensajes que son **solo** emote con `content` vacio
        /// y la lista de emotes aparte; sin este dato se descartaban enteros y
        /// desaparecian lineas del chat.
        #[serde(default)]
        emote_count: u32,
    },

    /// Un comentario ha sido borrado en TikTok.
    ///
    /// El campo se llama `target_source_id` y **no** `source_id` a proposito: el
    /// sobre del evento ya lleva su propio `source_id` (`core/event.rs`) y el
    /// enum se serializa con `#[serde(flatten)]`, asi que dos campos con el
    /// mismo nombre producen una **clave duplicada** en el JSON. `JSON.parse` se
    /// queda con la ultima y el resultado depende del orden, que es justo el
    /// tipo de ambiguedad que rompe un contrato en silencio.
    #[serde(rename = "chat.message.deleted")]
    ChatMessageDeleted {
        /// `msg_id` de TikTok del mensaje borrado.
        target_source_id: String,
    },

    /// Alguien ha entrado en la sala.
    ///
    /// Es el mensaje **mas frecuente** de TikTok (un tercio del trafico medido
    /// en `live.jsonl`). Se publica para no descartar en silencio, pero la
    /// interfaz lo resume en un contador: una fila por entrada taparia el chat.
    #[serde(rename = "member.joined")]
    MemberJoined { user: UserRef },

    #[serde(rename = "gift.received")]
    GiftReceived { user: UserRef, gift: GiftInfo },

    #[serde(rename = "like.updated")]
    LikeUpdated {
        user: Option<UserRef>,
        /// Incremento desde el ultimo evento.
        count: i64,
        /// Total absoluto del directo (monotono).
        total: i64,
    },

    #[serde(rename = "viewer.updated")]
    ViewerUpdated {
        /// Espectadores actuales: en TikTok es el campo `total` del
        /// WebcastRoomUserSeqMessage, NO `total_user`.
        current: i64,
        /// Espectadores acumulados (`total_user`).
        cumulative: i64,
    },

    #[serde(rename = "follow.received")]
    FollowReceived { user: UserRef },

    #[serde(rename = "share.received")]
    ShareReceived { user: UserRef },

    #[serde(rename = "subscribe.received")]
    SubscribeReceived {
        user: UserRef,
        /// Meses de suscripcion implicados.
        months: i64,
    },

    #[serde(rename = "provider.status")]
    ProviderStatus {
        status: String,
        detail: Option<String>,
    },

    /// Agregados de regalos ya calculados por Rust.
    ///
    /// Existe para que la interfaz **no repita** la contabilidad: los eventos de
    /// progreso de una racha son acumulativos y sumarlos mal es un error
    /// facil de cometer en dos sitios y de arreglar en uno. Se emite como mucho
    /// una vez por segundo mientras llegan regalos.
    ///
    /// Lleva **cuanto** y **de que tipo**, no **quien**: la tabla por persona es
    /// `RankingsUpdated.gifts`, y tenerla tambien aqui mandaba los mismos diez
    /// nombres dos veces por segundo en dos formas distintas (`GifterEntry` y
    /// `RankingEntry`). Un dato, un sitio.
    #[serde(rename = "gifts.updated")]
    GiftsUpdated {
        total_gifts: i64,
        total_diamonds: i64,
        gifts_by_type: Vec<GiftTypeSummary>,
    },

    /// Las tres tablas de aportacion por persona, ya calculadas por Rust.
    ///
    /// Va **junto** en un solo evento a proposito: las tres tablas se pintan en
    /// la misma vista y llegan de los mismos tres tipos de evento, asi que
    /// emitirlas por separado obligaria a la interfaz y al overlay a llevar tres
    /// relojes de coalescing en vez de uno.
    ///
    /// El tap tap **no** es el rank oficial de TikTok: ese mensaje
    /// (`WebcastRoomUserSeqMessage.ranks`) todavia no esta validado contra la
    /// metadata real y el proyecto no usa tags sin validar. Aqui se agregan los
    /// likes por persona, que es lo que el publico toca y lo unico con identidad
    /// verificada (`WebcastLikeMessage.user`).
    #[serde(rename = "rankings.updated")]
    RankingsUpdated {
        /// Tap tap: likes acumulados por persona en la sesion.
        tap: Vec<RankingEntry>,
        /// Diamantes y unidades de regalo por persona en la sesion.
        gifts: Vec<RankingEntry>,
        /// Seguidores nuevos por persona en la sesion.
        follows: Vec<RankingEntry>,
    },
}

impl EventKind {
    /// Nombre estable, util para metricas y logs.
    pub fn name(&self) -> &'static str {
        match self {
            EventKind::StreamConnected { .. } => "stream.connected",
            EventKind::StreamDisconnected { .. } => "stream.disconnected",
            EventKind::StreamWaiting { .. } => "stream.waiting",
            EventKind::ChatMessage { .. } => "chat.message",
            EventKind::ChatMessageDeleted { .. } => "chat.message.deleted",
            EventKind::MemberJoined { .. } => "member.joined",
            EventKind::GiftReceived { .. } => "gift.received",
            EventKind::LikeUpdated { .. } => "like.updated",
            EventKind::ViewerUpdated { .. } => "viewer.updated",
            EventKind::FollowReceived { .. } => "follow.received",
            EventKind::ShareReceived { .. } => "share.received",
            EventKind::SubscribeReceived { .. } => "subscribe.received",
            EventKind::ProviderStatus { .. } => "provider.status",
            EventKind::GiftsUpdated { .. } => "gifts.updated",
            EventKind::RankingsUpdated { .. } => "rankings.updated",
        }
    }
}

/// Evento del protocolo interno.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub protocol_version: u32,
    /// Identificador unico de este evento dentro de la sesion.
    pub event_id: String,
    /// Secuencia monotona; un hueco indica eventos descartados.
    pub seq: u64,
    pub timestamp_ms: i64,
    /// Sala de la que proviene. Lo asigna Rust desde el `room_id` del provider.
    pub room_id: String,
    /// Identificador en origen (TikTok `msg_id`), para deduplicar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    pub fn now_ms() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    pub fn new(seq: u64, room_id: String, source_id: Option<String>, kind: EventKind) -> Self {
        let timestamp_ms = Self::now_ms();
        Self {
            protocol_version: PROTOCOL_VERSION,
            event_id: format!("{seq}-{timestamp_ms}"),
            seq,
            timestamp_ms,
            room_id,
            source_id,
            kind,
        }
    }
}
