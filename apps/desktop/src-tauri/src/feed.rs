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
    /// Diamantes que aporta **esta fila**: su incremento por el valor unitario.
    ///
    /// `repeat_count` es lo que suma este evento a la racha, no el acumulado
    /// (verificado contra los eventos reales guardados: una racha de dos rosas
    /// llega como dos eventos con `repeat_count = 1`). Lo que aporta la racha
    /// entera lo lleva la fila que la cierra.
    pub fn total_diamonds(&self) -> i64 {
        i64::from(self.diamond_count) * i64::from(self.repeat_count.max(1))
    }

    /// Si esta fila cierra la aportacion del regalo.
    pub fn commits(&self) -> bool {
        self.is_final || !self.streakable
    }
}

/// Aportacion que hay que contabilizar al registrar un evento.
///
/// Casi siempre es cero: mientras una racha sigue abierta no se contabiliza
/// nada. Se llena en el evento que la cierra y cuando hay que liquidar una racha
/// que se quedo sin cierre.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Settlement {
    pub units: i64,
    pub diamonds: i64,
}

impl Settlement {
    pub const NONE: Self = Self {
        units: 0,
        diamonds: 0,
    };
}

/// Lo que hay que contabilizar despues de registrar un evento de regalo.
///
/// Son **dos cosas distintas** y por eso no se devuelve un solo numero:
///   * `current`: lo que aporta el evento recien llegado (cero mientras su racha
///     sigue abierta). Va en su propia fila de `gift_events`.
///   * `abandoned`: rachas anteriores que se liquidan en esta misma llamada
///     porque el mismo usuario ha empezado otra. Tienen su propio `group_id`, y
///     sin devolverlas se quedaban contadas en memoria pero **sin persistir**:
///     el total de la interfaz y el de `streams` divergian.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordOutcome {
    pub current: Settlement,
    pub abandoned: Vec<StreakSettlement>,
}

/// Racha abierta que se liquida al cerrar la sesion.
///
/// Lleva lo imprescindible para persistirla: `group_id` identifica las filas de
/// la racha en `gift_events` y las unidades y diamantes son lo que hay que sumar
/// a la sesion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreakSettlement {
    pub group_id: String,
    pub units: i64,
    pub diamonds: i64,
}

/// Racha abierta a la espera de cierre.
#[derive(Debug, Clone)]
struct PendingGift {
    user: UserRef,
    gift_id: String,
    gift_name: String,
    units: i64,
    diamonds: i64,
}

/// Resumen de regalos de la sesion: recientes, top de gifters y por tipo.
#[derive(Debug, Default)]
pub struct GiftBoard {
    recent: VecDeque<GiftEventView>,
    per_user: HashMap<String, GifterEntry>,
    per_gift: HashMap<String, GiftTypeSummary>,
    total_gifts: i64,
    total_diamonds: i64,
    /// Rachas abiertas por `group_id`: lo recibido y aun no contabilizado.
    open: HashMap<String, PendingGift>,
    /// Ultima racha de cada usuario, para liquidarla si empieza otra sin que
    /// aquella recibiera su cierre.
    open_by_user: HashMap<String, String>,
}

impl GiftBoard {
    pub fn new(capacity: usize) -> Self {
        Self {
            recent: VecDeque::with_capacity(capacity.max(1)),
            ..Default::default()
        }
    }

    /// Registra un regalo y devuelve lo que hay que contabilizar por él.
    ///
    /// El evento se guarda **siempre** para poder mostrarlo, pero solo se
    /// contabiliza cuando su aportacion esta completa. La aportacion de una
    /// racha es la **suma de sus incrementos**, no el valor del ultimo evento:
    /// `repeat_count` es un incremento por mensaje. Contar solo el ultimo
    /// infravaloraba los diamantes a la mitad en una racha de dos rosas.
    pub fn record(&mut self, view: GiftEventView) -> RecordOutcome {
        if self.recent.len() >= GIFT_CAPACITY {
            self.recent.pop_front();
        }
        let units = i64::from(view.repeat_count.max(1));
        let diamonds = i64::from(view.diamond_count) * units;
        let user_id = view.user.id.clone();
        let user = view.user.clone();
        let gift_id = view.gift_id.clone();
        let gift_name = view.gift_name.clone();
        let group_id = view.group_id.clone();
        let commits = view.commits();
        self.recent.push_back(view);

        // Un regalo no acumulable no tiene racha: se contabiliza tal cual.
        if !commits && (group_id.is_empty() || group_id == "0") {
            self.settle(PendingGift {
                user,
                gift_id,
                gift_name,
                units,
                diamonds,
            });
            return RecordOutcome {
                current: Settlement { units, diamonds },
                abandoned: Vec::new(),
            };
        }

        // Si este usuario ha empezado otra racha, la anterior se quedo sin
        // cierre: se liquida lo que llevaba en lugar de perderlo (35 de 176
        // rachas del historico no reciben `repeat_end`). Se devuelve para que el
        // llamante la persista: contarla solo en memoria dejaba el total de la
        // sesion por debajo del que ve el streamer.
        let mut abandoned = Vec::new();
        if let Some(previo) = self.open_by_user.get(&user_id).cloned() {
            if previo != group_id {
                if let Some(pendiente) = self.open.remove(&previo) {
                    abandoned.push(StreakSettlement {
                        group_id: previo,
                        units: pendiente.units,
                        diamonds: pendiente.diamonds,
                    });
                    self.settle(pendiente);
                }
            }
        }

        let pendiente = self
            .open
            .entry(group_id.clone())
            .or_insert_with(|| PendingGift {
                user,
                gift_id,
                gift_name,
                units: 0,
                diamonds: 0,
            });
        pendiente.units += units;
        pendiente.diamonds += diamonds;
        self.open_by_user.insert(user_id.clone(), group_id.clone());

        if !commits {
            return RecordOutcome {
                current: Settlement::NONE,
                abandoned,
            };
        }

        self.open_by_user.remove(&user_id);
        let current = match self.open.remove(&group_id) {
            Some(pendiente) => {
                let liquidado = Settlement {
                    units: pendiente.units,
                    diamonds: pendiente.diamonds,
                };
                self.settle(pendiente);
                liquidado
            }
            None => Settlement::NONE,
        };
        RecordOutcome { current, abandoned }
    }

    /// Liquida **todas** las rachas abiertas y devuelve lo que ha contabilizado.
    ///
    /// Se llama al cerrar la sesion: una racha que nunca recibe su `repeat_end`
    /// (35 de 176 en el historico medido) se quedaba abierta y sus diamantes se
    /// perdian enteros. `record` no cambia: la liquidacion al empezar otra racha
    /// sigue siendo suya, y esto solo cubre el final del directo.
    pub fn settle_open(&mut self) -> Vec<StreakSettlement> {
        let abiertas: Vec<(String, PendingGift)> = self.open.drain().collect();
        // El indice por usuario apunta a rachas que ya no existen: si quedara,
        // el proximo regalo de ese usuario intentaria liquidar una racha ya
        // contabilizada.
        self.open_by_user.clear();
        let mut liquidado = Vec::with_capacity(abiertas.len());
        for (group_id, pendiente) in abiertas {
            liquidado.push(StreakSettlement {
                group_id,
                units: pendiente.units,
                diamonds: pendiente.diamonds,
            });
            self.settle(pendiente);
        }
        liquidado
    }

    /// Contabiliza una aportacion ya completa.
    fn settle(&mut self, pendiente: PendingGift) {
        self.total_gifts += pendiente.units;
        self.total_diamonds += pendiente.diamonds;

        let entry = self
            .per_user
            .entry(pendiente.user.id.clone())
            .or_insert_with(|| GifterEntry {
                user: pendiente.user.clone(),
                diamonds: 0,
                gifts: 0,
            });
        entry.diamonds += pendiente.diamonds;
        entry.gifts += pendiente.units;

        let summary = self
            .per_gift
            .entry(pendiente.gift_id.clone())
            .or_insert_with(|| GiftTypeSummary {
                gift_id: pendiente.gift_id.clone(),
                gift_name: pendiente.gift_name.clone(),
                count: 0,
                diamonds: 0,
            });
        summary.count += pendiente.units;
        summary.diamonds += pendiente.diamonds;
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
        // Las rachas abiertas tambien se olvidan: una sesion nueva no liquida
        // diamantes de la anterior.
        self.open.clear();
        self.open_by_user.clear();
        self.total_gifts = 0;
        self.total_diamonds = 0;
    }

    /// Rachas abiertas ahora mismo (diagnostico y tests).
    pub fn open_streaks(&self) -> usize {
        self.open.len()
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
        // Una racha de 3 rosas: tres eventos de **un** incremento cada uno (es
        // lo que llega de verdad: misma racha, `repeat_count = 1` en todos) y
        // solo el ultimo cierra. La aportacion son 3 rosas.
        assert_eq!(
            board.record(gift(1, "1", "Carlos", 1, 1, false)).current,
            Settlement::NONE
        );
        assert_eq!(
            board.record(gift(2, "1", "Carlos", 1, 1, false)).current,
            Settlement::NONE
        );
        assert_eq!(board.total_diamonds(), 0, "mientras la racha sigue abierta no cuenta");
        assert_eq!(board.open_streaks(), 1);

        assert_eq!(
            board.record(gift(3, "1", "Carlos", 1, 1, true)).current,
            Settlement { units: 3, diamonds: 3 }
        );
        assert_eq!(board.total_diamonds(), 3, "3 rosas de 1 diamante");
        assert_eq!(board.total_gifts(), 3, "3 unidades, no 6");
        assert_eq!(board.open_streaks(), 0, "la racha ya esta liquidada");

        let resumen = board.by_gift(5);
        assert_eq!(resumen.len(), 1);
        assert_eq!(resumen[0].count, 3, "unidades, no eventos");
        assert_eq!(resumen[0].diamonds, 3);

        // Y los tres eventos siguen visibles en la lista.
        assert_eq!(board.recent(10).len(), 3);
    }

    /// Regresion medida con datos reales: una racha de dos rosas llega como dos
    /// eventos con `repeat_count = 1`, y contar solo el ultimo daba la mitad de
    /// los diamantes (4 en vez de 8 en la sesion del 17/09).
    #[test]
    fn una_racha_suma_todos_sus_incrementos() {
        let mut board = GiftBoard::new(10);
        board.record(gift(1, "1", "Carlos", 1, 1, false));
        let liquidado = board.record(gift(2, "1", "Carlos", 1, 1, true));

        assert_eq!(
            liquidado.current,
            Settlement { units: 2, diamonds: 2 },
            "dos rosas, no una"
        );
        assert_eq!(board.total_diamonds(), 2);
        assert_eq!(board.total_gifts(), 2);
    }

    /// Si el incremento llega agrupado (un solo evento con `repeat_count = 5`),
    /// la racha vale 5 y se contabiliza de una vez.
    #[test]
    fn un_incremento_mayor_que_uno_cuenta_entero() {
        let mut board = GiftBoard::new(10);
        let liquidado = board.record(gift(1, "1", "Carlos", 1, 5, true));
        assert_eq!(liquidado.current, Settlement { units: 5, diamonds: 5 });
        assert_eq!(board.total_diamonds(), 5);
    }

    /// 35 de 176 rachas del historico no reciben nunca `repeat_end`. Antes esas
    /// aportaciones se perdian enteras; ahora se liquidan cuando el mismo
    /// usuario empieza otra racha, **y se devuelven** para poder persistirlas:
    /// contarlas solo en memoria dejaba el total de la sesion en disco corto.
    #[test]
    fn una_racha_sin_cierre_se_liquida_al_empezar_otra() {
        let mut board = GiftBoard::new(10);
        let mut primera = gift(1, "1", "Carlos", 1, 1, false);
        primera.group_id = "g1".into();
        let mut segunda = gift(2, "1", "Carlos", 1, 1, false);
        segunda.group_id = "g2".into();

        assert_eq!(board.record(primera).current, Settlement::NONE);
        let al_empezar_otra = board.record(segunda);

        // La racha abandonada se devuelve con **su** grupo, que es lo que hace
        // falta para persistirla en la fila correcta.
        assert_eq!(
            al_empezar_otra.abandoned,
            vec![StreakSettlement {
                group_id: "g1".into(),
                units: 1,
                diamonds: 1,
            }],
            "la liquidacion de la racha abandonada tiene que salir hacia la base"
        );
        assert_eq!(al_empezar_otra.current, Settlement::NONE);

        // Al abrir la segunda, la primera (que nunca cerro) se contabiliza.
        assert_eq!(board.total_gifts(), 1, "la racha abandonada no se pierde");
        assert_eq!(board.total_diamonds(), 1);

        // Y cerrar la segunda liquida solo lo suyo.
        let mut cierre = gift(3, "1", "Carlos", 1, 1, true);
        cierre.group_id = "g2".into();
        let cierre = board.record(cierre);
        assert_eq!(cierre.current, Settlement { units: 2, diamonds: 2 });
        assert!(
            cierre.abandoned.is_empty(),
            "cerrar la racha vigente no abandona ninguna"
        );
        assert_eq!(board.total_diamonds(), 3, "1 de la abandonada + 2 de esta");
        assert_eq!(board.open_streaks(), 0);
    }

    /// Al terminar el directo, las rachas que seguian abiertas se liquidan: si
    /// no, sus diamantes se perdian enteros (docs/decisions.md D14).
    #[test]
    fn cerrar_la_sesion_liquida_las_rachas_abiertas() {
        let mut board = GiftBoard::new(10);
        // Carlos con una rosa a medias y Ana con dos TikTok de 5 diamantes a
        // medias: dos rachas abiertas de dos usuarios distintos.
        board.record(gift(1, "1", "Carlos", 1, 1, false));
        let mut de_ana = gift(2, "2", "Ana", 5, 2, false);
        de_ana.group_id = "g2".into();
        board.record(de_ana);

        assert_eq!(board.open_streaks(), 2);
        assert_eq!(board.total_diamonds(), 0, "abiertas no cuentan todavia");

        let liquidado = board.settle_open();
        assert_eq!(liquidado.len(), 2, "se liquidan las dos");
        let carlos = liquidado
            .iter()
            .find(|racha| racha.group_id == "g1")
            .expect("la racha de Carlos deberia estar liquidada");
        assert_eq!(carlos.units, 1);
        assert_eq!(carlos.diamonds, 1);
        let ana = liquidado
            .iter()
            .find(|racha| racha.group_id == "g2")
            .expect("la racha de Ana deberia estar liquidada");
        assert_eq!(ana.units, 2, "dos unidades, no el valor de la ultima");
        assert_eq!(ana.diamonds, 10, "2 TikTok de 5 diamantes");

        assert_eq!(board.total_diamonds(), 11, "todo lo pendiente se contabiliza");
        assert_eq!(board.total_gifts(), 3);
        assert_eq!(board.open_streaks(), 0, "no queda ninguna racha abierta");
        // El ranking se actualiza con lo liquidado.
        let top = board.top_gifters(2);
        assert_eq!(top[0].user.nickname, "Ana");
        assert_eq!(top[0].diamonds, 10);

        // Liquidar dos veces no puede contabilizar dos veces.
        assert!(board.settle_open().is_empty());
        assert_eq!(board.total_diamonds(), 11);

        // Y la siguiente racha del mismo usuario empieza de cero, sin arrastrar
        // la que ya se liquido.
        board.record(gift(3, "1", "Carlos", 1, 1, false));
        assert_eq!(board.total_diamonds(), 11, "no se reliquida lo ya contado");
        assert_eq!(board.open_streaks(), 1);
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
