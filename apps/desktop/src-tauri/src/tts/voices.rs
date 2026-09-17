//! Catalogo de voces.
//!
//! edge-tts ofrece 45 voces en español. Se curan las mas utiles para un stream
//! en lugar de exponer la lista entera (docs/decisions.md D3), pero el catalogo
//! completo se puede consultar desde el sidecar.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Voice {
    pub id: String,
    pub label: String,
    pub language: Language,
    pub gender: Gender,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Es,
    En,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Gender {
    Female,
    Male,
}

impl Language {
    pub fn code(self) -> &'static str {
        match self {
            Language::Es => "es",
            Language::En => "en",
        }
    }
}

/// Voz por defecto: español neutro y femenino, la mas habitual en directo.
pub const DEFAULT_VOICE: &str = "es-ES-ElviraNeural";

const CATALOG: &[(&str, &str, Language, Gender)] = &[
    // Espanol: Espana
    ("es-ES-ElviraNeural", "Elvira (España)", Language::Es, Gender::Female),
    ("es-ES-AlvaroNeural", "Álvaro (España)", Language::Es, Gender::Male),
    ("es-ES-XimenaNeural", "Ximena (España)", Language::Es, Gender::Female),
    // Espanol: Latinoamerica
    ("es-MX-DaliaNeural", "Dalia (México)", Language::Es, Gender::Female),
    ("es-MX-JorgeNeural", "Jorge (México)", Language::Es, Gender::Male),
    ("es-AR-ElenaNeural", "Elena (Argentina)", Language::Es, Gender::Female),
    ("es-AR-TomasNeural", "Tomás (Argentina)", Language::Es, Gender::Male),
    ("es-CO-SalomeNeural", "Salomé (Colombia)", Language::Es, Gender::Female),
    ("es-CO-GonzaloNeural", "Gonzalo (Colombia)", Language::Es, Gender::Male),
    ("es-PE-CamilaNeural", "Camila (Perú)", Language::Es, Gender::Female),
    ("es-CL-CatalinaNeural", "Catalina (Chile)", Language::Es, Gender::Female),
    ("es-VE-PaolaNeural", "Paola (Venezuela)", Language::Es, Gender::Female),
    ("es-US-PalomaNeural", "Paloma (EE. UU.)", Language::Es, Gender::Female),
    // Ingles
    ("en-US-AriaNeural", "Aria (EE. UU.)", Language::En, Gender::Female),
    ("en-US-GuyNeural", "Guy (EE. UU.)", Language::En, Gender::Male),
    ("en-GB-SoniaNeural", "Sonia (Reino Unido)", Language::En, Gender::Female),
];

pub fn catalog() -> Vec<Voice> {
    CATALOG
        .iter()
        .map(|(id, label, language, gender)| Voice {
            id: (*id).to_string(),
            label: (*label).to_string(),
            language: *language,
            gender: *gender,
        })
        .collect()
}

pub fn by_language(language: Language) -> Vec<Voice> {
    catalog()
        .into_iter()
        .filter(|voice| voice.language == language)
        .collect()
}

pub fn is_known(id: &str) -> bool {
    CATALOG.iter().any(|(known, ..)| *known == id)
}

/// Heuristica de idioma para elegir voz automaticamente.
///
/// Deliberadamente simple: cuenta caracteres propios del español (incluidas
/// las vocales acentuadas y la eñe, que no aparecen en ingles). No pretende ser
/// deteccion de idioma, solo evitar leer un chat español con voz inglesa.
pub fn detect_language(text: &str) -> Language {
    let mut spanish_markers = 0usize;
    let mut letters = 0usize;
    for character in text.chars() {
        if !character.is_alphabetic() {
            continue;
        }
        letters += 1;
        if matches!(
            character,
            'á' | 'é' | 'í' | 'ó' | 'ú' | 'ü' | 'ñ' | '¿' | '¡'
                | 'Á' | 'É' | 'Í' | 'Ó' | 'Ú' | 'Ñ'
        ) {
            spanish_markers += 2;
        }
    }
    let lower = text.to_lowercase();
    for word in [
        "que", "de", "no", "hola", "gracias", "como", "pero", "porque", "jajaja", "buenas",
    ] {
        if lower.split_whitespace().any(|token| token == word) {
            spanish_markers += 1;
        }
    }

    if letters == 0 {
        return Language::Es;
    }
    // Un solo marcador claro ya inclina la balanza hacia el español.
    if spanish_markers >= 1 {
        Language::Es
    } else {
        Language::En
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_catalogo_no_tiene_duplicados_y_cubre_los_dos_idiomas() {
        let voices = catalog();
        assert!(voices.len() >= 16, "catalogo demasiado corto");
        let mut ids: Vec<&str> = voices.iter().map(|voice| voice.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), voices.len(), "hay voces repetidas");
        assert!(!by_language(Language::Es).is_empty());
        assert!(!by_language(Language::En).is_empty());
        assert!(is_known(DEFAULT_VOICE), "la voz por defecto debe existir");
        assert!(!is_known("es-XX-InventadaNeural"));
    }

    #[test]
    fn detecta_espanol_por_acentos_y_palabras() {
        assert_eq!(detect_language("hola, ¿qué tal?"), Language::Es);
        assert_eq!(detect_language("buenas a todos"), Language::Es);
        assert_eq!(detect_language("hola amigo"), Language::Es);
        assert_eq!(detect_language("hello everyone"), Language::En);
        assert_eq!(detect_language("gg wp"), Language::En);
        // Sin letras no hay nada que detectar: se cae al idioma por defecto.
        assert_eq!(detect_language("123 456"), Language::Es);
    }
}
