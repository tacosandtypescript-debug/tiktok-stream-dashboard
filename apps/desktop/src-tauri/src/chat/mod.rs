//! Buffer circular de chat.
//!
//! React no guarda el historial: Rust mantiene los ultimos N mensajes y la UI
//! pide el estado visible (docs/plan-review.md §39). La capacidad es fija, asi
//! que la memoria no crece con el stream.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::core::event::UserRef;

/// Capacidad por defecto: los 200 ultimos mensajes.
pub const DEFAULT_CAPACITY: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatEntry {
    pub seq: u64,
    pub timestamp_ms: i64,
    pub user: UserRef,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
}

pub struct ChatBuffer {
    capacity: usize,
    entries: VecDeque<ChatEntry>,
    total: u64,
    dropped: u64,
}

impl ChatBuffer {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            entries: VecDeque::with_capacity(capacity),
            total: 0,
            dropped: 0,
        }
    }

    /// Anade un mensaje. Devuelve el desalojado, si lo hubo.
    pub fn push(&mut self, entry: ChatEntry) -> Option<ChatEntry> {
        self.total += 1;
        let evicted = if self.entries.len() >= self.capacity {
            self.dropped += 1;
            self.entries.pop_front()
        } else {
            None
        };
        self.entries.push_back(entry);
        evicted
    }

    /// Los `count` mensajes mas recientes, en orden cronologico.
    pub fn recent(&self, count: usize) -> Vec<ChatEntry> {
        let skip = self.entries.len().saturating_sub(count);
        self.entries.iter().skip(skip).cloned().collect()
    }

    /// Busca en el contenido o en el nombre de usuario.
    ///
    /// La busqueda ignora mayusculas **y acentos**: en una interfaz en español,
    /// escribir "maria" tiene que encontrar a "María".
    pub fn search(&self, needle: &str, limit: usize) -> Vec<ChatEntry> {
        if needle.trim().is_empty() {
            return self.recent(limit);
        }
        let needle = normalize(needle);
        self.entries
            .iter()
            .rev()
            .filter(|entry| {
                normalize(&entry.content).contains(&needle)
                    || normalize(&entry.user.nickname).contains(&needle)
                    || normalize(&entry.user.unique_id).contains(&needle)
            })
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Mensajes totales vistos, aunque ya no esten en el buffer.
    pub fn total(&self) -> u64 {
        self.total
    }

    /// Mensajes desalojados por capacidad.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

/// Normaliza para buscar: minusculas y sin diacriticos.
///
/// Se hace a mano en lugar de anadir una dependencia de unicode: los
/// diacriticos que aparecen en nombres y chat en español son un conjunto
/// pequeno y cerrado.
fn normalize(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'Á' | 'À' | 'Ä' | 'Â' | 'Ã' => 'a',
            'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
            'ñ' | 'Ñ' => 'n',
            'ç' | 'Ç' => 'c',
            other => other.to_ascii_lowercase(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(seq: u64, content: &str, nickname: &str) -> ChatEntry {
        ChatEntry {
            seq,
            timestamp_ms: seq as i64,
            user: UserRef {
                id: seq.to_string(),
                unique_id: format!("user{seq}"),
                nickname: nickname.to_string(),
            },
            content: content.to_string(),
            source_id: Some(format!("msg-{seq}")),
        }
    }

    #[test]
    fn respeta_la_capacidad_y_cuenta_lo_desalojado() {
        let mut buffer = ChatBuffer::new(3);
        for seq in 1..=5 {
            buffer.push(entry(seq, "hola", "Carlos"));
        }

        assert_eq!(buffer.len(), 3);
        assert_eq!(buffer.total(), 5);
        assert_eq!(buffer.dropped(), 2);

        // Se conservan los tres ultimos, en orden.
        let recent = buffer.recent(10);
        assert_eq!(recent.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![3, 4, 5]);
    }

    #[test]
    fn recent_devuelve_los_ultimos_en_orden_cronologico() {
        let mut buffer = ChatBuffer::new(DEFAULT_CAPACITY);
        for seq in 1..=10 {
            buffer.push(entry(seq, "hola", "Carlos"));
        }
        let recent = buffer.recent(3);
        assert_eq!(recent.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![8, 9, 10]);
        assert_eq!(buffer.recent(0).len(), 0);
    }

    #[test]
    fn busca_por_contenido_y_por_usuario() {
        let mut buffer = ChatBuffer::new(10);
        buffer.push(entry(1, "juega ranked", "Carlos"));
        buffer.push(entry(2, "HOLA a todos", "María"));
        buffer.push(entry(3, "gg", "Juan"));

        let por_contenido = buffer.search("hola", 5);
        assert_eq!(por_contenido.len(), 1);
        assert_eq!(por_contenido[0].seq, 2, "la busqueda ignora mayusculas");

        let por_usuario = buffer.search("maria", 5);
        assert_eq!(por_usuario.len(), 1, "la busqueda ignora acentos");
        assert_eq!(por_usuario[0].seq, 2);

        assert_eq!(buffer.search("  ", 5).len(), 3, "busqueda vacia = recientes");
    }

    #[test]
    fn normaliza_acentos_y_mayusculas() {
        assert_eq!(normalize("María"), "maria");
        assert_eq!(normalize("JOSÉ"), "jose");
        assert_eq!(normalize("ñandú"), "nandu");
        assert_eq!(normalize("Ünïcôdé"), "unicode");
    }

    #[test]
    fn clear_no_resetea_los_contadores() {
        let mut buffer = ChatBuffer::new(4);
        for seq in 1..=6 {
            buffer.push(entry(seq, "hola", "Carlos"));
        }
        buffer.clear();
        assert!(buffer.is_empty());
        assert_eq!(buffer.total(), 6);
        assert_eq!(buffer.dropped(), 2);
    }
}
