//! Instancia unica (docs/plan-review.md §P0-4b).
//!
//! Dos instancias significarian dos conexiones consumiendo la misma cuota
//! anonima de firma (5/min, 30/h, 100/dia) y dos escritores sobre la misma base
//! de datos. Se resuelve reservando un puerto de loopback: si el bind falla
//! porque ya esta ocupado, hay otra instancia viva.
//!
//! Se prefiere esto a un mutex con nombre de Windows porque no anade
//! dependencias y ademas detecta el conflicto de puerto del futuro servidor de
//! overlays.

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

/// Puerto reservado para la guarda de instancia unica.
pub const GUARD_PORT: u16 = 7879;

pub struct InstanceGuard {
    listener: TcpListener,
    port: u16,
}

impl InstanceGuard {
    /// Intenta reservar el puerto de guarda.
    ///
    /// `Ok(None)` significa "ya hay otra instancia en ejecucion".
    pub fn acquire() -> std::io::Result<Option<Self>> {
        Self::acquire_on(GUARD_PORT)
    }

    pub fn acquire_on(port: u16) -> std::io::Result<Option<Self>> {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        match TcpListener::bind(address) {
            Ok(listener) => {
                listener.set_nonblocking(true).ok();
                Ok(Some(Self { listener, port }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// El listener se mantiene vivo mientras exista la guarda; no acepta
    /// conexiones a proposito.
    pub fn is_held(&self) -> bool {
        self.listener.local_addr().is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_segunda_instancia_no_consigue_la_guarda() {
        // Puerto efimero: se obtiene uno libre reservando y soltando.
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("puerto libre");
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let first = InstanceGuard::acquire_on(port).expect("sin error de E/S");
        assert!(first.is_some(), "la primera instancia debe obtener la guarda");

        let second = InstanceGuard::acquire_on(port).expect("sin error de E/S");
        assert!(second.is_none(), "la segunda instancia debe ser rechazada");

        drop(first);
        let third = InstanceGuard::acquire_on(port).expect("sin error de E/S");
        assert!(third.is_some(), "al liberar, la guarda vuelve a estar disponible");
    }
}
