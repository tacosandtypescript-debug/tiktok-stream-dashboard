//! Nucleo: protocolo de eventos, bus y metricas.

pub mod bus;
pub mod event;
pub mod metrics;
pub mod single;

#[cfg(test)]
mod contract;

pub use bus::EventBus;
pub use event::{Event, EventKind, GiftInfo, UserRef, PROTOCOL_VERSION};
pub use metrics::{Metrics, MetricsSnapshot};
