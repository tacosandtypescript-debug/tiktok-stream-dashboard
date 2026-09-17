//! Proveedor simulado.
//!
//! No es una utilidad secundaria: es la implementacion contra la que se testea
//! el nucleo, porque es la unica reproducible (docs/plan-review.md §55). Al
//! implementar el mismo trait que el proveedor real, garantiza **por
//! construccion** que el flujo de eventos es identico.
//!
//! Guion (en bucle): comentarios, un streak de regalo acumulable con su
//! `group_id` compartido y su cierre, likes incrementales con total absoluto,
//! viewers y un follow.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::{BoxFuture, ProviderStatus, StatusReporter, TikTokProvider};
use crate::core::event::{GiftInfo, UserRef};
use crate::core::{EventBus, EventKind, Metrics};

const NOMBRES: [(&str, &str, &str); 6] = [
    ("1", "carlos123", "Carlos"),
    ("2", "maria_g", "María"),
    ("3", "juanpe", "Juan"),
    ("4", "ana.stream", "Ana"),
    ("5", "pedro99", "Pedro"),
    ("6", "sofia.ttv", "Sofía"),
];

const MENSAJES: [&str; 6] = [
    "hola!",
    "juega ranked",
    "buena partida",
    "saludos desde Bogotá",
    "¿cuánto llevas de stream?",
    "vamos con otra",
];

/// (id, nombre, diamantes, acumulable)
const REGALOS: [(&str, &str, i32, bool); 3] = [
    ("5655", "Rose", 1, true),
    ("1000", "Heart Me", 1, false),
    ("2000", "Aogumi", 30, true),
];

pub struct SimulatedProvider {
    bus: Arc<EventBus>,
    metrics: Arc<Metrics>,
    reporter: StatusReporter,
    /// Cadencia del guion en milisegundos. Atomica para poder ajustarla a
    /// traves de un `Arc` (tests y stress tests).
    interval_ms: AtomicU64,
    cancel: Mutex<Option<watch::Sender<bool>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl SimulatedProvider {
    pub fn new(bus: Arc<EventBus>, metrics: Arc<Metrics>) -> Self {
        let reporter = StatusReporter::new(bus.clone(), metrics.clone());
        Self {
            bus,
            metrics,
            reporter,
            interval_ms: AtomicU64::new(700),
            cancel: Mutex::new(None),
            task: Mutex::new(None),
        }
    }

    /// Cadencia del guion. Con 20 ms se generan ~50 eventos/s para los stress
    /// tests de docs/plan-review.md §72.
    pub fn with_interval(self, interval: Duration) -> Self {
        self.set_interval(interval);
        self
    }

    pub fn set_interval(&self, interval: Duration) {
        self.interval_ms
            .store(interval.as_millis().max(1) as u64, Ordering::Relaxed);
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.interval_ms.load(Ordering::Relaxed).max(1))
    }

    async fn stop_task(&self) {
        let sender = self.cancel.lock().ok().and_then(|mut guard| guard.take());
        if let Some(sender) = sender {
            let _ = sender.send(true);
        }
        let task = self.task.lock().ok().and_then(|mut guard| guard.take());
        if let Some(task) = task {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
    }
}

impl TikTokProvider for SimulatedProvider {
    fn name(&self) -> &'static str {
        "simulated"
    }

    fn status(&self) -> ProviderStatus {
        ProviderStatus::from_code(self.metrics.provider_state.load(Ordering::Relaxed))
    }

    fn connect<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.stop_task().await;

            let (cancel_tx, mut cancel_rx) = watch::channel(false);
            if let Ok(mut guard) = self.cancel.lock() {
                *guard = Some(cancel_tx);
            }

            let handle = handle.trim().trim_start_matches('@').to_string();
            self.bus.set_room("simulado");
            self.reporter.set(
                ProviderStatus::Connected,
                Some(format!("simulación de @{handle}")),
            );
            self.bus.publish(
                None,
                EventKind::StreamConnected {
                    room_id: "simulado".into(),
                    title: format!("SIMULACIÓN @{handle}"),
                },
            );

            let guion = Guion {
                bus: self.bus.clone(),
                metrics: self.metrics.clone(),
            };
            let interval = self.interval();

            let task = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(interval);
                ticker.tick().await; // descarta el tick inmediato
                let mut tick: u64 = 0;
                loop {
                    tokio::select! {
                        _ = ticker.tick() => {
                            guion.step(tick);
                            tick += 1;
                        }
                        _ = cancel_rx.changed() => {
                            if *cancel_rx.borrow() {
                                tracing::info!(eventos = tick, "simulador detenido");
                                return;
                            }
                        }
                    }
                }
            });

            if let Ok(mut guard) = self.task.lock() {
                *guard = Some(task);
            }
            Ok(())
        })
    }

    fn disconnect<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.stop_task().await;
            self.reporter.set(ProviderStatus::Stopped, None);
            self.bus.publish(
                None,
                EventKind::StreamDisconnected {
                    reason: "simulación detenida".into(),
                },
            );
        })
    }
}

/// Datos que necesita el guion dentro de la tarea.
struct Guion {
    bus: Arc<EventBus>,
    metrics: Arc<Metrics>,
}

impl Guion {
    fn step(&self, tick: u64) {
        let (id, unique_id, nickname) = NOMBRES[(tick as usize) % NOMBRES.len()];
        let user = UserRef {
            id: id.to_string(),
            unique_id: unique_id.to_string(),
            nickname: nickname.to_string(),
        };

        match tick % 10 {
            // Streak de un regalo acumulable: mismo group_id, cierre al final.
            4 => self.gift(tick, 0, 1, false),
            5 => self.gift(tick, 0, 2, false),
            6 => self.gift(tick, 0, 3, true),
            7 => {
                self.bus.publish(
                    None,
                    EventKind::ViewerUpdated {
                        current: 120 + (tick % 40) as i64,
                        cumulative: 9_000 + tick as i64,
                    },
                );
            }
            8 => {
                self.bus.publish(
                    Some(format!("sim-follow-{tick}")),
                    EventKind::FollowReceived { user },
                );
            }
            // Likes: incremento + total absoluto, como TikTok.
            0 | 1 => {
                let count = 3 + (tick % 5) as i64;
                self.metrics.likes_total.fetch_add(count, Ordering::Relaxed);
                self.bus.publish(
                    Some(format!("sim-like-{tick}")),
                    EventKind::LikeUpdated {
                        user: Some(user),
                        count,
                        total: 25_000 + tick as i64 * 4,
                    },
                );
            }
            _ => {
                self.bus.publish(
                    Some(format!("sim-chat-{tick}")),
                    EventKind::ChatMessage {
                        user,
                        content: MENSAJES[(tick as usize) % MENSAJES.len()].to_string(),
                    },
                );
            }
        }

        // Un regalo suelto no acumulable de vez en cuando, para variar diamantes.
        if tick % 25 == 12 {
            self.gift(tick, 1, 1, true);
        }
    }

    fn gift(&self, tick: u64, gift_index: usize, repeat: i32, final_: bool) {
        let (id, name, diamonds, streakable) = REGALOS[gift_index % REGALOS.len()];
        let (user_id, unique_id, nickname) = NOMBRES[(tick as usize) % 2];
        self.bus.publish(
            Some(format!("sim-gift-{tick}-{repeat}")),
            EventKind::GiftReceived {
                user: UserRef {
                    id: user_id.to_string(),
                    unique_id: unique_id.to_string(),
                    nickname: nickname.to_string(),
                },
                gift: GiftInfo::new(
                    id,
                    name,
                    diamonds,
                    streakable,
                    repeat,
                    final_,
                    // Un streak nuevo cada 50 ticks: identifica al streak.
                    if streakable {
                        format!("sim-group-{}", tick / 50 * 50)
                    } else {
                        "0".to_string()
                    },
                ),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn recoger(
        rx: &mut tokio::sync::broadcast::Receiver<Arc<crate::core::Event>>,
        minimo: usize,
        plazo: Duration,
    ) -> Vec<EventKind> {
        let mut kinds = Vec::new();
        let deadline = tokio::time::Instant::now() + plazo;
        while kinds.len() < minimo && tokio::time::Instant::now() < deadline {
            if let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(60), rx.recv()).await {
                kinds.push(event.kind.clone());
            }
        }
        kinds
    }

    #[tokio::test]
    async fn publica_eventos_de_todos_los_tipos_y_se_detiene() {
        let metrics = Arc::new(Metrics::default());
        let bus = Arc::new(EventBus::new(512, metrics.clone()));
        let provider = SimulatedProvider::new(bus.clone(), metrics.clone())
            .with_interval(Duration::from_millis(5));

        let mut rx = bus.subscribe();
        provider.connect("prueba").await.expect("arranca");
        let kinds = recoger(&mut rx, 20, Duration::from_millis(600)).await;
        provider.disconnect().await;

        let tiene = |nombre: &str| kinds.iter().any(|kind| kind.name() == nombre);
        assert!(tiene("chat.message"), "faltan comentarios: {kinds:?}");
        assert!(tiene("gift.received"), "faltan regalos");
        assert!(tiene("like.updated"), "faltan likes");
        assert!(tiene("viewer.updated"), "faltan viewers");
        assert!(tiene("follow.received"), "faltan follows");
        assert_eq!(provider.status(), ProviderStatus::Stopped);
    }

    #[tokio::test]
    async fn el_streak_simulado_comparte_group_id_y_cierra() {
        let metrics = Arc::new(Metrics::default());
        let bus = Arc::new(EventBus::new(512, metrics.clone()));
        let provider = SimulatedProvider::new(bus.clone(), metrics.clone())
            .with_interval(Duration::from_millis(2));

        let mut rx = bus.subscribe();
        provider.connect("prueba").await.expect("arranca");

        let mut grupos: Vec<(String, bool)> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
        while grupos.len() < 3 && tokio::time::Instant::now() < deadline {
            if let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(60), rx.recv()).await {
                if let EventKind::GiftReceived { gift, .. } = event.kind.clone() {
                    if gift.streakable {
                        grupos.push((gift.group_id, gift.is_final));
                    }
                }
            }
        }
        provider.disconnect().await;

        assert_eq!(grupos.len(), 3, "se esperan tres eventos del streak: {grupos:?}");
        assert_eq!(grupos[0].0, grupos[2].0, "el streak comparte group_id");
        assert!(!grupos[0].1 && !grupos[1].1, "los dos primeros son progreso");
        assert!(grupos[2].1, "el ultimo cierra el streak");
    }
}
