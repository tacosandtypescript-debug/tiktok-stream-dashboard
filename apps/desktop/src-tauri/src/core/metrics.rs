//! Metricas de diagnostico (docs/plan-review.md §P1-8).
//!
//! Todos los contadores son atomicos y sin bloqueo: medir no debe costar mas
//! que el trabajo medido. La pagina Developer las muestra a 1 Hz solo mientras
//! esta visible.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::RwLock;

use serde::Serialize;

#[derive(Debug, Default)]
pub struct Metrics {
    /// Eventos aceptados por el bus.
    pub events_published: AtomicU64,
    /// Eventos descartados por un suscriptor lento (`RecvError::Lagged`).
    pub subscription_lagged: AtomicU64,
    /// Duplicados descartados por `source_id`.
    pub duplicates_dropped: AtomicU64,

    pub chat_messages: AtomicU64,
    pub gifts: AtomicU64,
    pub follows: AtomicU64,
    /// Ultimo total absoluto de likes del proveedor; no es la suma de deltas.
    pub likes_total: AtomicI64,
    /// Numero de actualizaciones de likes recibidas, independiente del total.
    pub like_events: AtomicU64,
    /// Actualizaciones de viewers que se colapsaron (coalescing).
    pub viewer_updates_coalesced: AtomicU64,
    pub viewer_updates_emitted: AtomicU64,

    /// Peticiones al servidor de firma: cuota anonima 5/min, 30/h, 100/dia.
    pub sign_requests: AtomicU64,
    pub sign_rate_limited: AtomicU64,
    pub ws_connects: AtomicU64,
    pub ws_frames: AtomicU64,
    pub provider_errors: AtomicU64,
    pub provider_reconnects: AtomicU64,
    pub provider_state: AtomicI64,
    /// Ultimo detalle publicado por el proveedor. A diferencia de un evento,
    /// este valor sobrevive a una nueva peticion de snapshot.
    pub provider_detail: RwLock<Option<String>>,
    pub subscribers: AtomicI64,
    /// Eventos criticos (regalos, follows) que no cupieron en la cola de
    /// escritura ni esperando. Si es mayor que cero, la sesion esta degradada.
    pub db_critical_dropped: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSnapshot {
    pub events_published: u64,
    pub subscription_lagged: u64,
    pub duplicates_dropped: u64,
    pub chat_messages: u64,
    pub gifts: u64,
    pub follows: u64,
    pub likes_total: i64,
    pub like_events: u64,
    pub viewer_updates_coalesced: u64,
    pub viewer_updates_emitted: u64,
    pub sign_requests: u64,
    pub sign_rate_limited: u64,
    pub ws_connects: u64,
    pub ws_frames: u64,
    pub provider_errors: u64,
    pub provider_reconnects: u64,
    pub provider_state: i64,
    pub subscribers: i64,
    pub db_critical_dropped: u64,
}

impl Metrics {
    pub fn set_provider_detail(&self, detail: Option<String>) {
        if let Ok(mut current) = self.provider_detail.write() {
            *current = detail;
        }
    }

    pub fn provider_detail(&self) -> Option<String> {
        self.provider_detail
            .read()
            .map(|detail| detail.clone())
            .unwrap_or(None)
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            events_published: self.events_published.load(Ordering::Relaxed),
            subscription_lagged: self.subscription_lagged.load(Ordering::Relaxed),
            duplicates_dropped: self.duplicates_dropped.load(Ordering::Relaxed),
            chat_messages: self.chat_messages.load(Ordering::Relaxed),
            gifts: self.gifts.load(Ordering::Relaxed),
            follows: self.follows.load(Ordering::Relaxed),
            likes_total: self.likes_total.load(Ordering::Relaxed),
            like_events: self.like_events.load(Ordering::Relaxed),
            viewer_updates_coalesced: self.viewer_updates_coalesced.load(Ordering::Relaxed),
            viewer_updates_emitted: self.viewer_updates_emitted.load(Ordering::Relaxed),
            sign_requests: self.sign_requests.load(Ordering::Relaxed),
            sign_rate_limited: self.sign_rate_limited.load(Ordering::Relaxed),
            ws_connects: self.ws_connects.load(Ordering::Relaxed),
            ws_frames: self.ws_frames.load(Ordering::Relaxed),
            provider_errors: self.provider_errors.load(Ordering::Relaxed),
            provider_reconnects: self.provider_reconnects.load(Ordering::Relaxed),
            provider_state: self.provider_state.load(Ordering::Relaxed),
            subscribers: self.subscribers.load(Ordering::Relaxed),
            db_critical_dropped: self.db_critical_dropped.load(Ordering::Relaxed),
        }
    }
}
