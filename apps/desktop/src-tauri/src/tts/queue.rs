//! Cola de TTS.
//!
//! Decisiones de la revision (docs/plan-review.md §13-§14, §P1-7):
//!
//!   * cola **acotada**: si se llena, entra lo mejor y se cuenta lo descartado;
//!   * prioridades por tipo de evento;
//!   * **aging**: la prioridad efectiva sube con el tiempo de espera, de modo
//!     que un mensaje normal acabe leyendose aunque lleguen regalos sin parar;
//!   * **reserva**: una parte de la cola se reserva para prioridad baja, para
//!     que una avalancha de regalos no la ocupe entera.
//!
//! Sin estas tres cosas el chat normal no se lee nunca: con cooldown de 20 s por
//! usuario, una sala media genera entre 6 y 90 veces mas frases de las que el
//! motor puede sintetizar.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::filters::RejectReason;

/// Prioridades de docs/plan-review.md §14.
pub mod priority {
    pub const PREMIUM_GIFT: i32 = 100;
    pub const BIG_GIFT: i32 = 80;
    pub const SUBSCRIBER: i32 = 70;
    pub const NORMAL_GIFT: i32 = 60;
    pub const MODERATOR: i32 = 40;
    pub const FOLLOWER: i32 = 30;
    pub const CHAT: i32 = 10;

    /// A partir de aqui un evento se considera prioritario para la reserva.
    pub const HIGH_THRESHOLD: i32 = 50;

    /// Umbral de diamantes para clasificar un regalo.
    pub fn for_gift(diamonds: i32) -> i32 {
        if diamonds >= 100 {
            PREMIUM_GIFT
        } else if diamonds >= 10 {
            BIG_GIFT
        } else {
            NORMAL_GIFT
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsSource {
    Chat,
    Gift,
    Follow,
    Manual,
    Test,
}

#[derive(Debug, Clone)]
pub struct TtsItem {
    pub id: u64,
    pub user_id: String,
    /// Texto ya listo para leer (incluye el prefijo del autor si procede).
    pub text: String,
    pub voice: String,
    pub priority: i32,
    pub source: TtsSource,
    pub queued_at: Instant,
}

impl TtsItem {
    /// Prioridad con envejecimiento: sube `aging_per_10s` cada 10 segundos de
    /// espera. Es lo que impide el starvation indefinido.
    pub fn effective_priority(&self, now: Instant, aging_per_10s: i32) -> i32 {
        let waited = now.duration_since(self.queued_at).as_secs();
        self.priority + (waited / 10) as i32 * aging_per_10s
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    /// Aceptado. `evicted` es el id del mensaje que salio para hacerle sitio.
    Queued {
        evicted: Option<u64>,
    },
    Rejected(RejectReason),
}

#[derive(Debug, Clone)]
pub struct TtsQueue {
    capacity: usize,
    /// Slots reservados para prioridad baja.
    reserve: usize,
    aging_per_10s: i32,
    items: Vec<TtsItem>,
    next_id: u64,
    dropped: u64,
}

impl TtsQueue {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(2);
        Self {
            capacity,
            reserve: (capacity / 5).max(1),
            aging_per_10s: 1,
            items: Vec::with_capacity(capacity),
            next_id: 1,
            dropped: 0,
        }
    }

    pub fn with_aging(mut self, aging_per_10s: i32) -> Self {
        self.aging_per_10s = aging_per_10s;
        self
    }

    /// Reserva de slots para prioridad baja.
    pub fn reserve(&self) -> usize {
        self.reserve
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Reserva el siguiente id.
    pub fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Encola un item. Si no cabe, desaloja el peor candidato cuando el nuevo
    /// merece mas la pena; si no, lo rechaza y lo cuenta.
    pub fn push(&mut self, item: TtsItem, now: Instant) -> PushOutcome {
        let is_high = item.priority >= priority::HIGH_THRESHOLD;
        let high_count = self
            .items
            .iter()
            .filter(|existing| existing.priority >= priority::HIGH_THRESHOLD)
            .count();

        // La reserva se define por cupo, no por grupo de desalojo: los
        // prioritarios solo pueden ocupar `capacity - reserve`, asi que siempre
        // quedan huecos libres para el chat normal.
        let cupo_agotado = is_high && high_count >= self.capacity - self.reserve;
        if self.items.len() < self.capacity && !cupo_agotado {
            self.items.push(item);
            return PushOutcome::Queued { evicted: None };
        }

        // Candidato a salir: un prioritario puede desalojar a cualquiera (es
        // justo lo que se espera de un regalo grande); uno normal solo puede
        // desalojar a otro normal, para no comerse la reserva.
        let nuevo = item.effective_priority(now, self.aging_per_10s);
        let candidato = if cupo_agotado {
            // No hay sitio en el cupo prioritario: solo se compara con otros
            // prioritarios.
            self.items
                .iter()
                .enumerate()
                .filter(|(_, existing)| existing.priority >= priority::HIGH_THRESHOLD)
                .map(|(index, existing)| {
                    (index, existing.effective_priority(now, self.aging_per_10s))
                })
                .min_by_key(|(_, value)| *value)
        } else if is_high {
            self.items
                .iter()
                .enumerate()
                .map(|(index, existing)| {
                    (index, existing.effective_priority(now, self.aging_per_10s))
                })
                .min_by_key(|(_, value)| *value)
        } else {
            self.items
                .iter()
                .enumerate()
                .filter(|(_, existing)| existing.priority < priority::HIGH_THRESHOLD)
                .map(|(index, existing)| {
                    (index, existing.effective_priority(now, self.aging_per_10s))
                })
                .min_by_key(|(_, value)| *value)
        };

        match candidato {
            Some((index, peor)) if nuevo > peor => {
                let evicted = self.items.swap_remove(index);
                self.items.push(item);
                self.dropped += 1;
                PushOutcome::Queued {
                    evicted: Some(evicted.id),
                }
            }
            _ => {
                self.dropped += 1;
                PushOutcome::Rejected(RejectReason::QueueFull)
            }
        }
    }

    /// Saca el siguiente item a leer: la prioridad efectiva mas alta.
    pub fn pop_next(&mut self, now: Instant) -> Option<TtsItem> {
        let index = self
            .items
            .iter()
            .enumerate()
            .max_by_key(|(_, item)| item.effective_priority(now, self.aging_per_10s))
            .map(|(index, _)| index)?;
        Some(self.items.swap_remove(index))
    }

    /// Quita un item concreto (accion "saltar").
    pub fn remove(&mut self, id: u64) -> bool {
        if let Some(index) = self.items.iter().position(|item| item.id == id) {
            self.items.swap_remove(index);
            true
        } else {
            false
        }
    }

    /// Vacia la cola. Devuelve cuantos items se descartaron.
    pub fn clear(&mut self) -> usize {
        let removed = self.items.len();
        self.items.clear();
        removed
    }

    /// Descarta lo que haya encolado de un usuario concreto. Devuelve cuantos
    /// items salieron.
    ///
    /// Lo usa "silenciar": callar a alguien tiene que notarse **ya**, no cuando
    /// termine de sonar lo que ya estaba en la cola.
    pub fn drop_user(&mut self, user_id: &str) -> usize {
        let before = self.items.len();
        self.items.retain(|item| item.user_id != user_id);
        let removed = before - self.items.len();
        self.dropped += removed as u64;
        removed
    }

    /// Vista de la cola para la interfaz, en orden de lectura previsto.
    pub fn preview(&self, now: Instant, limit: usize) -> Vec<TtsPreview> {
        let mut items: Vec<&TtsItem> = self.items.iter().collect();
        items.sort_by_key(|item| -item.effective_priority(now, self.aging_per_10s));
        items
            .into_iter()
            .take(limit)
            .map(|item| TtsPreview {
                id: item.id,
                text: item.text.clone(),
                priority: item.priority,
                effective_priority: item.effective_priority(now, self.aging_per_10s),
                waited_ms: now.duration_since(item.queued_at).as_millis() as u64,
                source: item.source,
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsPreview {
    pub id: u64,
    pub text: String,
    pub priority: i32,
    pub effective_priority: i32,
    pub waited_ms: u64,
    pub source: TtsSource,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn item(id: u64, priority: i32, queued_at: Instant) -> TtsItem {
        TtsItem {
            id,
            user_id: format!("u{id}"),
            text: format!("mensaje {id}"),
            voice: "es-ES-ElviraNeural".into(),
            priority,
            source: TtsSource::Chat,
            queued_at,
        }
    }

    #[test]
    fn saca_siempre_la_prioridad_mas_alta() {
        let mut queue = TtsQueue::new(8);
        let now = Instant::now();
        queue.push(item(1, priority::CHAT, now), now);
        queue.push(item(2, priority::PREMIUM_GIFT, now), now);
        queue.push(item(3, priority::NORMAL_GIFT, now), now);

        assert_eq!(queue.pop_next(now).unwrap().id, 2);
        assert_eq!(queue.pop_next(now).unwrap().id, 3);
        assert_eq!(queue.pop_next(now).unwrap().id, 1);
        assert!(queue.pop_next(now).is_none());
    }

    #[test]
    fn la_cola_esta_acotada_y_desaloja_al_peor() {
        let mut queue = TtsQueue::new(3);
        let now = Instant::now();
        queue.push(item(1, priority::CHAT, now), now);
        queue.push(item(2, priority::CHAT, now), now);
        queue.push(item(3, priority::CHAT, now), now);
        assert_eq!(queue.len(), 3);

        // Entra uno prioritario: desaloja a un normal.
        let outcome = queue.push(item(4, priority::NORMAL_GIFT, now), now);
        assert_eq!(outcome, PushOutcome::Queued { evicted: Some(1) });
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.dropped(), 1);

        // Uno normal no desaloja a otro normal mas antiguo (misma prioridad).
        let outcome = queue.push(item(5, priority::CHAT, now), now);
        assert_eq!(outcome, PushOutcome::Rejected(RejectReason::QueueFull));
        assert_eq!(queue.len(), 3);
    }

    #[test]
    fn la_reserva_evita_que_los_regalos_ahoguen_al_chat() {
        // Capacidad 10 => reserva 2 => los prioritarios solo pueden ocupar 8.
        let mut queue = TtsQueue::new(10);
        let now = Instant::now();
        assert_eq!(queue.reserve(), 2);

        for id in 1..=20 {
            queue.push(item(id, priority::PREMIUM_GIFT, now), now);
        }

        let prioritarios = queue
            .items
            .iter()
            .filter(|item| item.priority >= priority::HIGH_THRESHOLD)
            .count();
        assert_eq!(
            prioritarios,
            queue.capacity() - queue.reserve(),
            "los regalos no pueden ocupar la reserva"
        );

        // Y el chat normal entra en esos dos huecos reservados.
        assert!(matches!(
            queue.push(item(100, priority::CHAT, now), now),
            PushOutcome::Queued { .. }
        ));
        assert!(matches!(
            queue.push(item(101, priority::CHAT, now), now),
            PushOutcome::Queued { .. }
        ));
    }

    #[test]
    fn el_aging_hace_que_lo_antiguo_gane_a_lo_nuevo() {
        let mut queue = TtsQueue::new(4).with_aging(1);
        let inicio = Instant::now();
        // Un mensaje normal encolado al principio.
        queue.push(item(1, priority::CHAT, inicio), inicio);
        // Y un regalo encolado 60 s despues: 10 + 6 = 16 contra 60.
        let despues = inicio + Duration::from_secs(60);
        queue.push(item(2, priority::NORMAL_GIFT, despues), despues);

        assert_eq!(
            queue.pop_next(despues).unwrap().id,
            2,
            "el regalo sigue teniendo mas prioridad"
        );

        // Con 600 s de espera, 10 + 60 = 70 supera al regalo recien llegado.
        let muy_despues = inicio + Duration::from_secs(600);
        assert_eq!(
            queue.pop_next(muy_despues).unwrap().id,
            1,
            "tras mucho tiempo, el chat normal adelanta al regalo"
        );
    }

    #[test]
    fn se_pueden_quitar_items_y_vaciar_la_cola() {
        let mut queue = TtsQueue::new(5);
        let now = Instant::now();
        queue.push(item(1, priority::CHAT, now), now);
        queue.push(item(2, priority::CHAT, now), now);
        assert!(queue.remove(1));
        assert!(!queue.remove(99));
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.clear(), 1);
        assert!(queue.is_empty());
    }

    #[test]
    fn silenciar_a_un_usuario_descarta_lo_suyo_encolado() {
        let mut queue = TtsQueue::new(8);
        let now = Instant::now();
        queue.push(item(1, priority::CHAT, now), now);
        // El mismo usuario, con otro texto.
        let mut segundo = item(2, priority::CHAT, now);
        segundo.user_id = "u1".into();
        queue.push(segundo, now);
        queue.push(item(3, priority::CHAT, now), now);

        assert_eq!(queue.drop_user("u1"), 2);
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.dropped(), 2, "lo descartado tambien se cuenta");
        assert_eq!(queue.drop_user("nadie"), 0);
    }

    #[test]
    fn la_vista_previa_va_en_orden_de_lectura() {
        let mut queue = TtsQueue::new(5);
        let now = Instant::now();
        queue.push(item(1, priority::CHAT, now), now);
        queue.push(item(2, priority::PREMIUM_GIFT, now), now);
        let preview = queue.preview(now, 10);
        assert_eq!(preview[0].id, 2);
        assert_eq!(preview[1].id, 1);
        assert_eq!(preview[0].priority, priority::PREMIUM_GIFT);
    }

    #[test]
    fn clasifica_regalos_por_diamantes() {
        assert_eq!(priority::for_gift(1), priority::NORMAL_GIFT);
        assert_eq!(priority::for_gift(9), priority::NORMAL_GIFT);
        assert_eq!(priority::for_gift(10), priority::BIG_GIFT);
        assert_eq!(priority::for_gift(99), priority::BIG_GIFT);
        assert_eq!(priority::for_gift(100), priority::PREMIUM_GIFT);
    }
}
