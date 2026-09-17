//! Event bus: el unico canal por el que circula el estado.
//!
//! Decisiones (docs/plan-review.md §32, §48, §P1-3):
//!   * `tokio::sync::broadcast` con capacidad acotada; un suscriptor lento
//!     pierde eventos antiguos y se contabiliza, nunca bloquea al productor.
//!   * los eventos viajan como `Arc<Event>`: una sola serializacion por evento
//!     para todos los suscriptores.
//!   * deduplicacion por `source_id` con memoria acotada: tras una reconexion
//!     TikTok puede reenviar mensajes y duplicar diamantes en rankings y metas.
//!   * el bus asigna `seq`, de modo que hay un unico escritor del contador.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::broadcast;

use super::event::{Event, EventKind};
use super::metrics::Metrics;

/// Memoria de ids ya vistos. Acotada: no crece sin limite.
const DEDUPE_CAPACITY: usize = 8192;

struct Dedupe {
    order: VecDeque<String>,
    seen: HashSet<String>,
}

impl Dedupe {
    fn new() -> Self {
        Self {
            order: VecDeque::with_capacity(DEDUPE_CAPACITY),
            seen: HashSet::with_capacity(DEDUPE_CAPACITY),
        }
    }

    /// Devuelve `true` si el id es nuevo (y lo registra).
    fn insert(&mut self, id: &str) -> bool {
        if self.seen.contains(id) {
            return false;
        }
        if self.order.len() >= DEDUPE_CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        self.order.push_back(id.to_string());
        self.seen.insert(id.to_string());
        true
    }
}

pub struct EventBus {
    sender: broadcast::Sender<Arc<Event>>,
    seq: std::sync::atomic::AtomicU64,
    room_id: RwLock<String>,
    dedupe: Mutex<Dedupe>,
    metrics: Arc<Metrics>,
}

impl EventBus {
    pub fn new(capacity: usize, metrics: Arc<Metrics>) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender,
            seq: std::sync::atomic::AtomicU64::new(0),
            room_id: RwLock::new(String::new()),
            dedupe: Mutex::new(Dedupe::new()),
            metrics,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.metrics.subscribers.fetch_add(1, Ordering::Relaxed);
        self.sender.subscribe()
    }

    /// Fija la sala actual. La llama el provider al conectar.
    pub fn set_room(&self, room_id: impl Into<String>) {
        if let Ok(mut guard) = self.room_id.write() {
            *guard = room_id.into();
        }
    }

    pub fn room_id(&self) -> String {
        self.room_id
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Publica un evento. Devuelve `false` si se descarto por duplicado.
    ///
    /// Sin suscriptores activos el evento se descarta silenciosamente: es lo
    /// correcto, nadie lo esta mirando.
    pub fn publish(&self, source_id: Option<String>, kind: EventKind) -> bool {
        if let Some(id) = source_id.as_deref() {
            let is_new = self
                .dedupe
                .lock()
                .map(|mut dedupe| dedupe.insert(id))
                .unwrap_or(true);
            if !is_new {
                self.metrics.duplicates_dropped.fetch_add(1, Ordering::Relaxed);
                return false;
            }
        }

        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.count(&kind);
        let event = Arc::new(Event::new(seq, self.room_id(), source_id, kind));
        // `send` falla solo si no hay receptores; no es un error.
        let _ = self.sender.send(event);
        self.metrics.events_published.fetch_add(1, Ordering::Relaxed);
        true
    }

    fn count(&self, kind: &EventKind) {
        let metrics = &self.metrics;
        match kind {
            EventKind::ChatMessage { .. } => {
                metrics.chat_messages.fetch_add(1, Ordering::Relaxed);
            }
            EventKind::GiftReceived { .. } => {
                metrics.gifts.fetch_add(1, Ordering::Relaxed);
            }
            EventKind::FollowReceived { .. } => {
                metrics.follows.fetch_add(1, Ordering::Relaxed);
            }
            EventKind::LikeUpdated { count, .. } => {
                metrics.like_events.fetch_add(1, Ordering::Relaxed);
                metrics.likes_total.fetch_add(*count, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::UserRef;

    fn user(id: &str) -> UserRef {
        UserRef {
            id: id.into(),
            unique_id: format!("user{id}"),
            nickname: format!("Nick {id}"),
        }
    }

    fn chat(id: &str) -> EventKind {
        EventKind::ChatMessage {
            user: user(id),
            content: "hola".into(),
            emote_count: 0,
        }
    }

    #[tokio::test]
    async fn publica_y_entrega_eventos() {
        let metrics = Arc::new(Metrics::default());
        let bus = EventBus::new(16, metrics.clone());
        let mut rx = bus.subscribe();

        assert!(bus.publish(Some("m1".into()), chat("1")));
        let event = rx.recv().await.expect("evento recibido");
        assert_eq!(event.seq, 1);
        assert_eq!(event.protocol_version, crate::core::event::PROTOCOL_VERSION);
        assert_eq!(event.kind.name(), "chat.message");
        assert_eq!(metrics.snapshot().chat_messages, 1);
    }

    #[tokio::test]
    async fn descarta_duplicados_por_source_id() {
        let bus = EventBus::new(16, Arc::new(Metrics::default()));
        let mut rx = bus.subscribe();

        assert!(bus.publish(Some("msg-1".into()), chat("1")));
        assert!(!bus.publish(Some("msg-1".into()), chat("1")), "duplicado aceptado");
        // Sin source_id no hay deduplicacion posible.
        assert!(bus.publish(None, chat("1")));

        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2, "el duplicado no debe consumir seq");
    }

    #[tokio::test]
    async fn asigna_secuencia_monotona_y_sala() {
        let bus = EventBus::new(16, Arc::new(Metrics::default()));
        bus.set_room("7686341765710269205");
        let mut rx = bus.subscribe();
        for _ in 0..5 {
            bus.publish(None, chat("1"));
        }
        let mut expected = 1;
        while let Ok(event) = rx.try_recv() {
            assert_eq!(event.seq, expected);
            assert_eq!(event.room_id, "7686341765710269205");
            expected += 1;
        }
        assert_eq!(expected, 6);
    }

    #[test]
    fn la_memoria_de_duplicados_esta_acotada() {
        let mut dedupe = Dedupe::new();
        for index in 0..(DEDUPE_CAPACITY + 100) {
            assert!(dedupe.insert(&format!("id-{index}")));
        }
        assert!(dedupe.seen.len() <= DEDUPE_CAPACITY);
        // El mas antiguo ya se olvido; el mas reciente sigue presente.
        assert!(dedupe.insert(&format!("id-{}", DEDUPE_CAPACITY + 99)) == false);
    }
}
