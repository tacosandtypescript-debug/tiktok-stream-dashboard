//! Proveedores de eventos de TikTok.
//!
//! El resto de la aplicacion solo conoce este trait: cambiar de proveedor (o
//! anadir uno nuevo) no debe tocar el nucleo (docs/plan-review.md §11).
//!
//! `async fn` en traits aun no es compatible con `dyn`, asi que los metodos
//! asincronos devuelven `BoxFuture`. Asi el proveedor activo puede guardarse
//! como `Arc<dyn TikTokProvider>` sin dependencias extra.

pub mod proto;
pub mod simulated;
pub mod tiktok;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};

use crate::core::{EventBus, EventKind, Metrics};

pub use simulated::SimulatedProvider;
pub use tiktok::{NativeProvider, ProviderConfig};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Unico punto donde cambia el estado del proveedor.
///
/// El estado vive en las metricas (`provider_state`), de modo que el proveedor,
/// su supervisor y la UI no pueden discrepar. Es `Clone` y barato de copiar.
#[derive(Clone)]
pub(crate) struct StatusReporter {
    metrics: Arc<Metrics>,
    bus: Arc<EventBus>,
}

impl StatusReporter {
    pub(crate) fn new(bus: Arc<EventBus>, metrics: Arc<Metrics>) -> Self {
        Self { metrics, bus }
    }

    pub(crate) fn set(&self, status: ProviderStatus, detail: Option<String>) {
        self.metrics
            .provider_state
            .store(status.code(), Ordering::Relaxed);
        tracing::info!(status = status.as_str(), detail = ?detail, "provider");
        self.bus.publish(
            None,
            EventKind::ProviderStatus {
                status: status.as_str().to_string(),
                detail,
            },
        );
    }
}

/// Estados del proveedor (docs/plan-review.md §9, ampliado).
///
/// `WaitingForLive` es nuevo y es obligatorio con la cuota anonima: no se puede
/// usar `connect()` en bucle para esperar a que el usuario empiece a emitir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Stopped,
    Starting,
    WaitingForLive,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

impl ProviderStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderStatus::Stopped => "stopped",
            ProviderStatus::Starting => "starting",
            ProviderStatus::WaitingForLive => "waiting_for_live",
            ProviderStatus::Connecting => "connecting",
            ProviderStatus::Connected => "connected",
            ProviderStatus::Reconnecting => "reconnecting",
            ProviderStatus::Error => "error",
        }
    }

    /// Codigo estable para las metricas (evita serializar cadenas).
    pub fn code(self) -> i64 {
        match self {
            ProviderStatus::Stopped => 0,
            ProviderStatus::Starting => 1,
            ProviderStatus::WaitingForLive => 2,
            ProviderStatus::Connecting => 3,
            ProviderStatus::Connected => 4,
            ProviderStatus::Reconnecting => 5,
            ProviderStatus::Error => 6,
        }
    }

    /// Inversa de `code`. El estado vive en las metricas para no duplicar la
    /// fuente de verdad entre el provider y su supervisor.
    pub fn from_code(code: i64) -> Self {
        match code {
            1 => ProviderStatus::Starting,
            2 => ProviderStatus::WaitingForLive,
            3 => ProviderStatus::Connecting,
            4 => ProviderStatus::Connected,
            5 => ProviderStatus::Reconnecting,
            6 => ProviderStatus::Error,
            _ => ProviderStatus::Stopped,
        }
    }
}

pub trait TikTokProvider: Send + Sync {
    /// Nombre corto y estable del proveedor (`native`, `simulated`).
    fn name(&self) -> &'static str;

    fn status(&self) -> ProviderStatus;

    /// Arranca el proveedor para `handle`. Debe regresar en cuanto el
    /// supervisor esta lanzado: el trabajo real ocurre en segundo plano.
    fn connect<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, anyhow::Result<()>>;

    /// Detiene el proveedor y libera los recursos. Idempotente.
    fn disconnect<'a>(&'a self) -> BoxFuture<'a, ()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn los_estados_tienen_codigo_estable() {
        // Los codigos alimentan las metricas y la UI; cambiarlos es un cambio
        // de protocolo.
        assert_eq!(ProviderStatus::Stopped.code(), 0);
        assert_eq!(ProviderStatus::Connected.code(), 4);
        assert_eq!(ProviderStatus::Error.as_str(), "error");
        for status in [
            ProviderStatus::Stopped,
            ProviderStatus::Starting,
            ProviderStatus::WaitingForLive,
            ProviderStatus::Connecting,
            ProviderStatus::Connected,
            ProviderStatus::Reconnecting,
            ProviderStatus::Error,
        ] {
            assert_eq!(ProviderStatus::from_code(status.code()), status);
        }
    }
}
