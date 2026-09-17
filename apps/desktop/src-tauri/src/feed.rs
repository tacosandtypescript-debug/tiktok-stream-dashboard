//! Buffers de lo que se muestra en el panel: feed de eventos y resumen de regalos.
//!
//! Son memorias **acotadas** que viven en Rust, no en React: el panel pide un
//! snapshot al abrirse y recibe eventos a partir de ahí (docs/plan-review.md §39).
//! Asi el historial no crece con el directo y el panel se repinta igual tras
//! recargar la ventana.
//!
//! El tracker de combos completo y los rankings con ventanas temporales son del
//! Milestone 4; esto es el resumen **de la sesion actual**, que es lo que el
//! panel necesita para estar vivo.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::core::event::UserRef;
// Los tipos del tablero viven en el protocolo porque viajan a la interfaz.
pub use crate::core::event::{GifterEntry, GiftTypeSummary};

/// Eventos que se muestran en la columna de actividad.
///
/// **El chat no entra aqui a proposito**: tiene su propio buffer (`chat/mod.rs`)
/// y su propia columna en el panel. Meterlo duplicaria memoria y desplazaria del
/// feed lo que de verdad interesa ver de un vistazo (regalos, follows, avisos).
pub const FEED_CAPACITY: usize = 150;
/// Regalos recientes que se conservan para la pagina de regalos.
pub const GIFT_CAPACITY: usize = 150;

/// Solo los likes grandes merecen aparecer en el feed: si no, lo inundan.
const LIKE_FEED_THRESHOLD: i64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedKind {
    Gift,
    Follow,
    Share,
    Subscribe,
    Like,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedItem {
    pub seq: u64,
    pub timestamp_ms: i64,
    pub kind: FeedKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<UserRef>,
    /// Regalo, cuando el evento es un regalo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gift: Option<crate::core::event::GiftInfo>,
    /// Likes: (incremento, total).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likes: Option<(i64, i64)>,
    /// Meses de suscripcion, cuando el evento es una suscripcion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub months: Option<i64>,
    /// Detalle tecnico de un aviso (motivo de cierre, error del proveedor...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl FeedItem {
    pub fn info(seq: u64, timestamp_ms: i64, detail: impl Into<String>) -> Self {
        Self {
            seq,
            timestamp_ms,
            kind: FeedKind::Info,
            user: None,
            gift: None,
            likes: None,
            months: None,
            detail: Some(detail.into()),
        }
    }

    pub fn gift(seq: u64, timestamp_ms: i64, user: UserRef, gift: crate::core::event::GiftInfo) -> Self {
        Self {
            seq,
            timestamp_ms,
            kind: FeedKind::Gift,
            user: Some(user),
            gift: Some(gift),
            likes: None,
            months: None,
            detail: None,
        }
    }

    pub fn social(seq: u64, timestamp_ms: i64, kind: FeedKind, user: UserRef) -> Self {
        Self {
            seq,
            timestamp_ms,
            kind,
            user: Some(user),
            gift: None,
            likes: None,
            months: None,
            detail: None,
        }
    }

    pub fn subscribe(seq: u64, timestamp_ms: i64, user: UserRef, months: i64) -> Self {
        Self {
            seq,
            timestamp_ms,
            kind: FeedKind::Subscribe,
            user: Some(user),
            gift: None,
            likes: None,
            months: Some(months),
            detail: None,
        }
    }

    pub fn likes(seq: u64, timestamp_ms: i64, user: Option<UserRef>, count: i64, total: i64) -> Self {
        Self {
            seq,
            timestamp_ms,
            kind: FeedKind::Like,
            user,
            gift: None,
            likes: Some((count, total)),
            months: None,
            detail: None,
        }
    }
}

/// Feed acotado de actividad.
#[derive(Debug)]
pub struct EventFeed {
    capacity: usize,
    items: VecDeque<FeedItem>,
    total: u64,
}

impl EventFeed {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            items: VecDeque::with_capacity(capacity),
            total: 0,
        }
    }

    pub fn push(&mut self, item: FeedItem) {
        self.total += 1;
        if self.items.len() >= self.capacity {
            self.items.pop_front();
        }
        self.items.push_back(item);
    }

    /// Los `count` mas recientes, del mas nuevo al mas antiguo (como se lee un
    /// feed de actividad).
    pub fn recent(&self, count: usize) -> Vec<FeedItem> {
        self.items.iter().rev().take(count).cloned().collect()
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn total(&self) -> u64 {
        self.total
    }
}

/// Un regalo tal como se muestra en la lista.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GiftEventView {
    pub seq: u64,
    pub timestamp_ms: i64,
    pub user: UserRef,
    pub gift_id: String,
    pub gift_name: String,
    /// Icono del regalo, si TikTok lo envio.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub image_url: String,
    pub repeat_count: i32,
    pub diamond_count: i32,
    pub streakable: bool,
    pub is_final: bool,
    pub group_id: String,
}

impl GiftEventView {
    /// Diamantes que aporta la fila. Para una racha abierta es lo acumulado
    /// hasta ahora, que es lo que tiene sentido mostrar.
    pub fn total_diamonds(&self) -> i64 {
        i64::from(self.diamond_count) * i64::from(self.repeat_count.max(1))
    }

    /// Si esta fila cierra la aportacion del regalo.
    pub fn commits(&self) -> bool {
        self.is_final || !self.streakable
    }
}

/// Resumen de regalos de la sesion: recientes, top de gifters y por tipo.
#[derive(Debug, Default)]
pub struct GiftBoard {
    recent: VecDeque<GiftEventView>,
    per_user: HashMap<String, GifterEntry>,
    per_gift: HashMap<String, GiftTypeSummary>,
    total_gifts: i64,
    total_diamonds: i64,
}

impl GiftBoard {
    pub fn new(capacity: usize) -> Self {
        Self {
            recent: VecDeque::with_capacity(capacity.max(1)),
            ..Default::default()
        }
    }

    /// Registra un regalo.
    ///
    /// El evento se guarda **siempre** para poder mostrarlo, pero solo se
    /// contabiliza cuando cierra su aportacion: los eventos de progreso de una
    /// racha son acumulativos y sumarlos daria 1+2+3 en lugar de 3.
    pub fn record(&mut self, view: GiftEventView) {
        if self.recent.len() >= GIFT_CAPACITY {
            self.recent.pop_front();
        }
        let commits = view.commits();
        let units = i64::from(view.repeat_count.max(1));
        let diamonds = i64::from(view.diamond_count) * units;
        let user = view.user.clone();
        let gift_id = view.gift_id.clone();
        let gift_name = view.gift_name.clone();
        self.recent.push_back(view);

        if !commits {
            return;
        }

        self.total_gifts += units;
        self.total_diamonds += diamonds;

        let entry = self
            .per_user
            .entry(user.id.clone())
            .or_insert_with(|| GifterEntry {
                user,
                diamonds: 0,
                gifts: 0,
            });
        entry.diamonds += diamonds;
        entry.gifts += units;

        let summary = self.per_gift.entry(gift_id.clone()).or_insert_with(|| GiftTypeSummary {
            gift_id,
            gift_name,
            count: 0,
            diamonds: 0,
        });
        summary.count += units;
        summary.diamonds += diamonds;
    }

    pub fn recent(&self, count: usize) -> Vec<GiftEventView> {
        self.recent.iter().rev().take(count).cloned().collect()
    }

    pub fn top_gifters(&self, count: usize) -> Vec<GifterEntry> {
        let mut entries: Vec<GifterEntry> = self.per_user.values().cloned().collect();
        entries.sort_by(|a, b| {
            b.diamonds
                .cmp(&a.diamonds)
                .then_with(|| a.user.nickname.cmp(&b.user.nickname))
        });
        entries.truncate(count);
        entries
    }

    pub fn by_gift(&self, count: usize) -> Vec<GiftTypeSummary> {
        let mut entries: Vec<GiftTypeSummary> = self.per_gift.values().cloned().collect();
        entries.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.gift_name.cmp(&b.gift_name)));
        entries.truncate(count);
        entries
    }

    pub fn total_gifts(&self) -> i64 {
        self.total_gifts
    }

    pub fn total_diamonds(&self) -> i64 {
        self.total_diamonds
    }

    pub fn clear(&mut self) {
        self.recent.clear();
        self.per_user.clear();
        self.per_gift.clear();
        self.total_gifts = 0;
        self.total_diamonds = 0;
    }
}

/// Indica si una rafaga de likes merece aparecer en el feed.
///
/// Es una decision de **politica** (que es relevante), no de presentacion: la
/// frase que se muestra la construye la interfaz.
pub fn like_is_notable(count: i64) -> bool {
    count >= LIKE_FEED_THRESHOLD
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str, nickname: &str) -> UserRef {
        UserRef {
            id: id.into(),
            unique_id: format!("u{id}"),
            nickname: nickname.into(),
        }
    }

    fn gift(seq: u64, user_id: &str, nickname: &str, diamonds: i32, repeat: i32, final_: bool) -> GiftEventView {
        GiftEventView {
            seq,
            timestamp_ms: seq as i64,
            user: user(user_id, nickname),
            gift_id: "5655".into(),
            gift_name: "Rose".into(),
            image_url: String::new(),
            repeat_count: repeat,
            diamond_count: diamonds,
            streakable: true,
            is_final: final_,
            group_id: "g1".into(),
        }
    }

    #[test]
    fn el_feed_esta_acotado_y_devuelve_lo_mas_nuevo_primero() {
        let mut feed = EventFeed::new(3);
        for seq in 1..=5 {
            feed.push(FeedItem::info(seq, seq as i64, format!("evento {seq}")));
        }
        assert_eq!(feed.len(), 3);
        assert_eq!(feed.total(), 5);
        let recent = feed.recent(10);
        assert_eq!(recent.first().unwrap().seq, 5, "lo mas nuevo primero");
        assert_eq!(recent.last().unwrap().seq, 3);
    }

    #[test]
    fn el_resumen_de_regalos_cuenta_unidades_y_ordena_gifters() {
        let mut board = GiftBoard::new(10);
        board.record(gift(1, "1", "Carlos", 30, 1, true));
        board.record(gift(2, "1", "Carlos", 30, 2, true));
        board.record(gift(3, "2", "María", 1, 10, true));
        board.record(gift(4, "3", "Juan", 100, 1, true));

        // `total_gifts` cuenta unidades enviadas, no eventos recibidos.
        assert_eq!(board.total_gifts(), 14, "1 + 2 + 10 + 1 unidades");
        // 30*1 + 30*2 + 1*10 + 100*1 = 200
        assert_eq!(board.total_diamonds(), 200);

        let top = board.top_gifters(3);
        assert_eq!(top[0].user.nickname, "Juan", "100 diamantes manda");
        assert_eq!(top[0].diamonds, 100);
        assert_eq!(top[1].user.nickname, "Carlos");
        assert_eq!(top[1].diamonds, 90);
        assert_eq!(top[2].user.nickname, "María");
        assert_eq!(top[2].diamonds, 10);
    }

    #[test]
    fn el_progreso_de_una_racha_no_se_suma_ronda_a_ronda() {
        let mut board = GiftBoard::new(10);
        // Una racha de 3 rosas llega como tres eventos acumulativos, y solo el
        // ultimo cierra: la aportacion son 3 rosas, no 1+2+3.
        board.record(gift(1, "1", "Carlos", 1, 1, false));
        board.record(gift(2, "1", "Carlos", 1, 2, false));
        assert_eq!(board.total_diamonds(), 0, "mientras la racha sigue abierta no cuenta");
        board.record(gift(3, "1", "Carlos", 1, 3, true));

        assert_eq!(board.total_diamonds(), 3, "3 rosas de 1 diamante");
        assert_eq!(board.total_gifts(), 3, "3 unidades, no 6");

        let resumen = board.by_gift(5);
        assert_eq!(resumen.len(), 1);
        assert_eq!(resumen[0].count, 3, "unidades, no eventos");
        assert_eq!(resumen[0].diamonds, 3);

        // Y los tres eventos siguen visibles en la lista.
        assert_eq!(board.recent(10).len(), 3);
    }

    #[test]
    fn un_regalo_sin_repeat_count_vale_una_unidad() {
        let mut board = GiftBoard::new(10);
        // Un regalo no acumulable puede llegar sin repeat_count: son 5 diamantes.
        let mut evento = gift(1, "1", "Carlos", 5, 1, true);
        evento.repeat_count = 0;
        evento.streakable = false;
        board.record(evento);

        assert_eq!(board.total_diamonds(), 5, "no puede aportar cero");
        assert_eq!(board.total_gifts(), 1);
    }

    #[test]
    fn los_items_estructurados_llevan_lo_que_la_interfaz_necesita() {
        let quien = user("1", "Carlos");
        // Regalo: la interfaz necesita saber si la racha sigue abierta para
        // redactar "va por 5" o "x5".
        let en_progreso =
            crate::core::event::GiftInfo::new("5655", "Rose", 1, true, 5, false, "g1");
        let item = FeedItem::gift(1, 100, quien.clone(), en_progreso);
        assert_eq!(item.kind, FeedKind::Gift);
        let gift = item.gift.as_ref().expect("regalo presente");
        assert_eq!(gift.repeat_count, 5);
        assert!(!gift.is_final, "la racha sigue abierta");
        assert_eq!(item.user.as_ref().unwrap().nickname, "Carlos");

        // Likes: incremento y total.
        let likes = FeedItem::likes(2, 200, Some(quien), 15, 25_000);
        assert_eq!(likes.likes, Some((15, 25_000)));

        // Follow, share, suscripcion y aviso.
        assert_eq!(
            FeedItem::social(3, 300, FeedKind::Follow, user("2", "Ana")).kind,
            FeedKind::Follow
        );
        assert_eq!(
            FeedItem::social(4, 400, FeedKind::Share, user("3", "Luis")).kind,
            FeedKind::Share
        );
        let suscripcion = FeedItem::subscribe(5, 500, user("4", "Marta"), 3);
        assert_eq!(suscripcion.kind, FeedKind::Subscribe);
        assert_eq!(suscripcion.months, Some(3));

        let aviso = FeedItem::info(6, 600, "el servidor cerro la conexion");
        assert_eq!(aviso.detail.as_deref(), Some("el servidor cerro la conexion"));
    }

    #[test]
    fn solo_los_likes_grandes_van_al_feed() {
        assert!(!like_is_notable(1));
        assert!(!like_is_notable(9));
        assert!(like_is_notable(10));
        assert!(like_is_notable(500));
    }
}
