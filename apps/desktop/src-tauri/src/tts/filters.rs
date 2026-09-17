//! Filtros del TTS.
//!
//! El pipeline de docs/plan-review.md §15, en este orden:
//!
//! ```text
//! normalize -> enabled -> usuario bloqueado -> palabras bloqueadas -> URL
//!   -> spam -> duplicado -> caracteres repetidos -> longitud
//!   -> cooldown por usuario
//! ```
//!
//! El **cupo global** (token bucket) queda fuera del pipeline a proposito: es
//! una decision de admision, no de contenido. Un mensaje puede pasar todos los
//! filtros y no leerse porque no toca leer todavia; mezclarlo con el pipeline
//! haria que el descarte se contase dos veces y que no se pudiera gastar la
//! cuota solo cuando la frase va a encolarse de verdad. De eso se encarga
//! `admit`.
//!
//! Toda la logica vive aqui, sin E/S: es lo que permite probarla a fondo (y lo
//! que hace que el TTS no lea basura en directo).

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Motivo de descarte. Se contabiliza y se muestra en la interfaz: el streamer
/// necesita saber por que no se lee el chat (plan-review.md §P1-7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    Disabled,
    Empty,
    TooShort,
    TooLong,
    BlockedUser,
    BlockedWord,
    Url,
    Spam,
    Duplicate,
    RepeatedChars,
    UserCooldown,
    GlobalRateLimit,
    QueueFull,
}

impl RejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RejectReason::Disabled => "desactivado",
            RejectReason::Empty => "vacío",
            RejectReason::TooShort => "demasiado corto",
            RejectReason::TooLong => "demasiado largo",
            RejectReason::BlockedUser => "usuario bloqueado",
            RejectReason::BlockedWord => "palabra bloqueada",
            RejectReason::Url => "contiene un enlace",
            RejectReason::Spam => "spam",
            RejectReason::Duplicate => "mensaje duplicado",
            RejectReason::RepeatedChars => "caracteres repetidos",
            RejectReason::UserCooldown => "en espera (cooldown)",
            RejectReason::GlobalRateLimit => "límite global de lectura",
            RejectReason::QueueFull => "cola llena",
        }
    }
}

/// Configuracion de los filtros. Los valores por defecto son los del plan §15,
/// mas el token bucket global que la revision anadio porque sin el la cola se
/// satura de forma inevitable (§P1-7).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FilterConfig {
    pub enabled: bool,
    /// Longitud maxima leida.
    pub max_chars: usize,
    /// Longitud minima: por debajo suele ser ruido ("gg", "+").
    pub min_chars: usize,
    /// Espera minima por usuario entre dos lecturas.
    pub user_cooldown: Duration,
    /// Token bucket global: una frase cada `global_interval`, con rafagas.
    pub global_interval: Duration,
    pub global_burst: u32,
    /// Descarta mensajes con enlaces.
    pub filter_urls: bool,
    /// Repeticiones seguidas del mismo caracter que se toleran (aaaa...).
    pub max_repeated_chars: usize,
    /// Ventana en la que un mensaje identico se considera duplicado.
    pub duplicate_window: Duration,
    /// Ventana en la que el mismo usuario enviando lo mismo se considera spam.
    pub spam_window: Duration,
    pub blocked_words: Vec<String>,
    pub blocked_users: Vec<String>,
}

impl Default for FilterConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_chars: 150,
            min_chars: 2,
            user_cooldown: Duration::from_secs(20),
            // 1 frase cada 4 s con rafaga de 3: la capacidad real de edge-tts
            // (~0,3-0,5 frases/s) no da para mas.
            global_interval: Duration::from_secs(4),
            global_burst: 3,
            filter_urls: true,
            max_repeated_chars: 8,
            duplicate_window: Duration::from_secs(30),
            spam_window: Duration::from_secs(60),
            blocked_words: Vec::new(),
            blocked_users: Vec::new(),
        }
    }
}

/// Resultado de pasar un mensaje por los filtros.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterOutcome {
    Accept { text: String },
    Reject(RejectReason),
}

#[derive(Debug, Clone)]
struct Recent {
    text: String,
    at: Instant,
}

/// Estado mutable de los filtros: cooldowns y memoria de mensajes recientes.
pub struct Filters {
    config: FilterConfig,
    last_user: HashMap<String, Instant>,
    recent: VecDeque<Recent>,
    global_tokens: f64,
    global_last: Instant,
    /// Cuantas frases se han descartado, por motivo.
    rejected: HashMap<&'static str, u64>,
}

/// Capacidad de la memoria de mensajes recientes.
const RECENT_CAPACITY: usize = 256;

/// Los cooldowns solo necesitan recordar usuarios que siguen dentro de su
/// ventana. El tope adicional protege el proceso frente a una sala con miles
/// de usuarios distintos en poco tiempo.
pub const LAST_USER_CAPACITY: usize = 1024;

impl Filters {
    pub fn new(config: FilterConfig, now: Instant) -> Self {
        Self {
            global_tokens: config.global_burst as f64,
            config,
            last_user: HashMap::new(),
            recent: VecDeque::with_capacity(RECENT_CAPACITY),
            global_last: now,
            rejected: HashMap::new(),
        }
    }

    pub fn config(&self) -> &FilterConfig {
        &self.config
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.config.enabled = enabled;
    }

    /// Aplica el pipeline de **contenido** y **cuenta** el motivo cuando
    /// descarta.
    ///
    /// El conteo vive aqui, en un unico punto: si el llamante tuviera que
    /// contar los motivos que ya cuenta el pipeline, cualquier descarte se
    /// contabilizaria dos veces en el estado de la interfaz.
    ///
    /// El cupo global **no** se mira aqui. `evaluate` no lo consume (no interesa
    /// gastar cuota de lectura si la cola esta llena) y, si lo contara sin
    /// consumirlo, el descarte acabaria contado dos veces. Quien decide leer usa
    /// `admit`, que agrupa las dos cosas.
    pub fn evaluate(&mut self, user_id: &str, raw_text: &str, now: Instant) -> FilterOutcome {
        let text = normalize(raw_text);

        let rejection = self
            .check_disabled()
            .or_else(|| self.check_length(&text))
            .or_else(|| self.check_blocked_user(user_id))
            .or_else(|| self.check_blocked_word(&text))
            .or_else(|| self.check_url(&text))
            .or_else(|| self.check_repeated_chars(&text))
            .or_else(|| self.check_duplicate(&text, now))
            .or_else(|| self.check_cooldown(user_id, now));

        match rejection {
            Some(reason) => {
                self.count(reason);
                FilterOutcome::Reject(reason)
            }
            None => FilterOutcome::Accept { text },
        }
    }

    /// Admite una frase ya evaluada: consume el cupo global y, si lo habia,
    /// registra el cooldown y el mensaje reciente.
    ///
    /// Es el unico camino que gasta cuota de lectura y el unico que cuenta el
    /// limite global, de modo que el descarte no puede duplicarse.
    pub fn admit(&mut self, user_id: &str, text: &str, now: Instant) -> bool {
        if !self.consume_global_token(now) {
            self.count(RejectReason::GlobalRateLimit);
            return false;
        }
        self.commit(user_id, text, now);
        true
    }

    /// Admision de un aviso que **no es chat** (regalo, follow): gasta el cupo
    /// global, pero no toca el cooldown por usuario ni la memoria de textos
    /// recientes.
    ///
    /// Es la costura que permite leer regalos sin que un regalo bloquee durante
    /// 20 s el chat de quien lo mando, ni cuente como "mensaje repetido" si esa
    /// persona escribe lo mismo en el chat.
    pub fn admit_announcement(&mut self, now: Instant) -> bool {
        if !self.consume_global_token(now) {
            self.count(RejectReason::GlobalRateLimit);
            return false;
        }
        true
    }

    /// Contabiliza un descarte. Lo usa el pipeline, y tambien el llamante que
    /// decide no leer por un motivo propio (cola llena).
    pub fn count(&mut self, reason: RejectReason) {
        *self.rejected.entry(reason.as_str()).or_insert(0) += 1;
    }

    /// Registra que una frase se ha aceptado y va a leerse.
    pub fn commit(&mut self, user_id: &str, text: &str, now: Instant) {
        self.prune_last_users(now);
        if !self.last_user.contains_key(user_id) && self.last_user.len() >= LAST_USER_CAPACITY {
            if let Some((oldest, _)) = self
                .last_user
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(user, at)| (user.clone(), *at))
            {
                self.last_user.remove(&oldest);
            }
        }
        self.last_user.insert(user_id.to_string(), now);
        if self.recent.len() >= RECENT_CAPACITY {
            self.recent.pop_front();
        }
        self.recent.push_back(Recent {
            text: text.to_lowercase(),
            at: now,
        });
    }

    /// Contadores de descartes, para la interfaz.
    pub fn rejected_counts(&self) -> Vec<(&'static str, u64)> {
        let mut counts: Vec<(&'static str, u64)> =
            self.rejected.iter().map(|(k, v)| (*k, *v)).collect();
        counts.sort_by_key(|item| std::cmp::Reverse(item.1));
        counts
    }

    fn reject(&mut self, reason: RejectReason) -> Option<RejectReason> {
        Some(reason)
    }

    fn check_disabled(&mut self) -> Option<RejectReason> {
        if self.config.enabled {
            None
        } else {
            self.reject(RejectReason::Disabled)
        }
    }

    fn check_length(&mut self, text: &str) -> Option<RejectReason> {
        let characters = text.chars().count();
        if characters < self.config.min_chars {
            return self.reject(RejectReason::TooShort);
        }
        if characters > self.config.max_chars {
            return self.reject(RejectReason::TooLong);
        }
        None
    }

    fn check_blocked_user(&mut self, user_id: &str) -> Option<RejectReason> {
        if self
            .config
            .blocked_users
            .iter()
            .any(|blocked| blocked == user_id)
        {
            return self.reject(RejectReason::BlockedUser);
        }
        None
    }

    fn check_blocked_word(&mut self, text: &str) -> Option<RejectReason> {
        let lower = text.to_lowercase();
        for word in &self.config.blocked_words {
            let word = word.trim().to_lowercase();
            if !word.is_empty() && lower.contains(&word) {
                return self.reject(RejectReason::BlockedWord);
            }
        }
        None
    }

    fn check_url(&mut self, text: &str) -> Option<RejectReason> {
        if !self.config.filter_urls {
            return None;
        }
        let lower = text.to_lowercase();
        let has_url = lower.contains("http://")
            || lower.contains("https://")
            || lower.contains("www.")
            || lower.split_whitespace().any(|token| {
                // dominio.tld: el sufijo debe parecer un TLD real (2-6 letras,
                // cubre .com, .online, .store o .museum).
                match token.rsplit_once('.') {
                    Some((label, tld)) => {
                        !label.is_empty()
                            && (2..=6).contains(&tld.len())
                            && tld.chars().all(|c| c.is_ascii_alphabetic())
                    }
                    None => false,
                }
            });
        if has_url {
            return self.reject(RejectReason::Url);
        }
        None
    }

    fn check_repeated_chars(&mut self, text: &str) -> Option<RejectReason> {
        let mut previous: Option<char> = None;
        let mut run = 0usize;
        for character in text.chars() {
            if Some(character) == previous {
                run += 1;
                if run > self.config.max_repeated_chars {
                    return self.reject(RejectReason::RepeatedChars);
                }
            } else {
                run = 1;
                previous = Some(character);
            }
        }
        None
    }

    fn check_duplicate(&mut self, text: &str, now: Instant) -> Option<RejectReason> {
        let lower = text.to_lowercase();
        let duplicate = self.recent.iter().any(|recent| {
            recent.text == lower && now.duration_since(recent.at) <= self.config.duplicate_window
        });
        if duplicate {
            return self.reject(RejectReason::Duplicate);
        }
        None
    }

    fn check_cooldown(&mut self, user_id: &str, now: Instant) -> Option<RejectReason> {
        self.prune_last_users(now);
        if let Some(last) = self.last_user.get(user_id) {
            if now.duration_since(*last) < self.config.user_cooldown {
                return self.reject(RejectReason::UserCooldown);
            }
        }
        None
    }

    fn prune_last_users(&mut self, now: Instant) {
        if self.config.user_cooldown.is_zero() {
            self.last_user.clear();
            return;
        }
        self.last_user
            .retain(|_, last| now.duration_since(*last) < self.config.user_cooldown);
    }

    /// Consume un token global. Devuelve `false` si no habia.
    pub fn consume_global_token(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.global_tokens >= 1.0 {
            self.global_tokens -= 1.0;
            true
        } else {
            false
        }
    }

    fn refill(&mut self, now: Instant) {
        let interval = self.config.global_interval.as_secs_f64().max(0.1);
        let elapsed = now.duration_since(self.global_last).as_secs_f64();
        if elapsed > 0.0 {
            self.global_tokens =
                (self.global_tokens + elapsed / interval).min(self.config.global_burst as f64);
            self.global_last = now;
        }
    }
}

/// Normaliza el texto: colapsa espacios, quita caracteres de control y recorta.
///
/// El orden importa: en Rust `\n` y `\t` **son** caracteres de control, asi que
/// hay que tratar primero los espacios. Si no, "hola\nmundo" se convertiria en
/// "holamundo" y el TTS leeria una palabra inventada.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = true;
    for character in text.chars() {
        if character.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
            continue;
        }
        // Solo se descartan los caracteres de control que no son espacios.
        if character.is_control() {
            continue;
        }
        out.push(character);
        last_space = false;
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Instant {
        Instant::now()
    }

    fn filters() -> Filters {
        Filters::new(FilterConfig::default(), now())
    }

    fn accepted(filters: &mut Filters, text: &str) -> bool {
        matches!(
            filters.evaluate("u1", text, now()),
            FilterOutcome::Accept { .. }
        )
    }

    #[test]
    fn normaliza_espacios_y_caracteres_de_control() {
        assert_eq!(normalize("  hola   mundo  "), "hola mundo");
        assert_eq!(normalize("hola\nmundo\t!"), "hola mundo !");
        assert_eq!(normalize("\u{0}hola\u{7}"), "hola");
    }

    #[test]
    fn descarta_por_longitud() {
        let mut filters = filters();
        assert_eq!(
            filters.evaluate("u1", "a", now()),
            FilterOutcome::Reject(RejectReason::TooShort)
        );
        let largo = "a".repeat(151);
        assert_eq!(
            filters.evaluate("u1", &largo, now()),
            FilterOutcome::Reject(RejectReason::TooLong)
        );
        // 150 caracteres exactos entran.
        let justo = "ab".repeat(75);
        assert!(accepted(&mut filters, &justo));
    }

    #[test]
    fn descarta_enlaces_de_varias_formas() {
        let mut filters = filters();
        for texto in [
            "mira https://spam.example",
            "entra en www.spam.example",
            "pasa por spam.com",
            "compra en TIENDA.ONLINE",
        ] {
            assert_eq!(
                filters.evaluate("u1", texto, now()),
                FilterOutcome::Reject(RejectReason::Url),
                "deberia descartar {texto:?}"
            );
        }
        // Un punto normal no es un enlace.
        assert!(accepted(&mut filters, "hola, que tal."));
        assert!(accepted(&mut filters, "vamos a jugar"));
    }

    #[test]
    fn descarta_caracteres_repetidos() {
        let mut filters = filters();
        assert_eq!(
            filters.evaluate("u1", "aaaaaaaaaaaaaaaaa", now()),
            FilterOutcome::Reject(RejectReason::RepeatedChars)
        );
        assert!(accepted(&mut filters, "jajajajaja"), "una risa normal pasa");
    }

    #[test]
    fn descarta_palabras_y_usuarios_bloqueados() {
        let config = FilterConfig {
            blocked_words: vec!["spoiler".into()],
            blocked_users: vec!["999".into()],
            ..FilterConfig::default()
        };
        let mut filters = Filters::new(config, now());

        assert_eq!(
            filters.evaluate("u1", "cuidado con el SPOILER", now()),
            FilterOutcome::Reject(RejectReason::BlockedWord)
        );
        assert_eq!(
            filters.evaluate("999", "hola", now()),
            FilterOutcome::Reject(RejectReason::BlockedUser)
        );
    }

    #[test]
    fn aplica_cooldown_por_usuario() {
        let mut filters = filters();
        let inicio = now();

        let primero = filters.evaluate("u1", "hola a todos", inicio);
        assert!(matches!(primero, FilterOutcome::Accept { .. }));
        filters.commit("u1", "hola a todos", inicio);

        // El mismo usuario, con otro mensaje, dentro del cooldown.
        assert_eq!(
            filters.evaluate("u1", "otra cosa distinta", inicio + Duration::from_secs(5)),
            FilterOutcome::Reject(RejectReason::UserCooldown)
        );
        // Otro usuario si puede.
        assert!(matches!(
            filters.evaluate("u2", "buenas", inicio + Duration::from_secs(5)),
            FilterOutcome::Accept { .. }
        ));
        // Pasado el cooldown, vuelve a entrar.
        assert!(matches!(
            filters.evaluate("u1", "ya pasó el rato", inicio + Duration::from_secs(25)),
            FilterOutcome::Accept { .. }
        ));
    }

    #[test]
    fn el_cooldown_por_usuario_no_crece_sin_limite() {
        let mut filters = filters();
        let inicio = now();
        for index in 0..(LAST_USER_CAPACITY * 3) {
            filters.commit(&format!("usuario-{index}"), "mensaje distinto", inicio);
        }

        assert_eq!(
            filters.last_user.len(),
            LAST_USER_CAPACITY,
            "la memoria de cooldown debe tener un tope duro"
        );

        // La antigüedad también poda entradas aunque todavía no se haya
        // alcanzado la capacidad: un usuario fuera del cooldown no necesita
        // ocupar memoria.
        let despues = inicio + filters.config.user_cooldown;
        let _ = filters.evaluate("usuario-nuevo", "otro mensaje", despues);
        assert!(filters.last_user.is_empty());
    }

    #[test]
    fn descarta_duplicados_en_la_ventana() {
        let mut filters = filters();
        let inicio = now();
        filters.commit("u2", "gg wp", inicio);

        assert_eq!(
            filters.evaluate("u1", "GG WP", inicio + Duration::from_secs(5)),
            FilterOutcome::Reject(RejectReason::Duplicate)
        );
        // Fuera de la ventana, deja de ser duplicado.
        assert!(matches!(
            filters.evaluate("u1", "gg wp", inicio + Duration::from_secs(60)),
            FilterOutcome::Accept { .. }
        ));
    }

    #[test]
    fn el_token_bucket_global_limita_la_tasa() {
        let mut filters = filters();
        let inicio = now();

        // Ráfaga inicial de 3.
        assert!(filters.consume_global_token(inicio));
        assert!(filters.consume_global_token(inicio));
        assert!(filters.consume_global_token(inicio));
        assert!(
            !filters.consume_global_token(inicio),
            "la ráfaga no puede superar global_burst"
        );

        // Un token por intervalo.
        assert!(filters.consume_global_token(inicio + Duration::from_secs(4)));
        assert!(!filters.consume_global_token(inicio + Duration::from_secs(4)));

        // Y se recarga con el tiempo, sin pasar de la ráfaga: tres consumos
        // seguidos tras una espera larga, y el cuarto ya no.
        let muy_despues = inicio + Duration::from_secs(120);
        assert!(filters.consume_global_token(muy_despues));
        assert!(filters.consume_global_token(muy_despues));
        assert!(filters.consume_global_token(muy_despues));
        assert!(
            !filters.consume_global_token(muy_despues),
            "no puede superar la ráfaga ni tras una espera larga"
        );
    }

    #[test]
    fn desactivado_lo_descarta_todo() {
        let mut filters = filters();
        filters.set_enabled(false);
        assert_eq!(
            filters.evaluate("u1", "hola", now()),
            FilterOutcome::Reject(RejectReason::Disabled)
        );
        filters.set_enabled(true);
        assert!(accepted(&mut filters, "hola"));
    }

    #[test]
    fn cuenta_los_motivos_de_descarte() {
        let mut filters = filters();
        let _ = filters.evaluate("u1", "a", now());
        let _ = filters.evaluate("u1", "aaaaaaaaaaaa", now());
        let counts = filters.rejected_counts();
        assert_eq!(counts.iter().map(|(_, n)| n).sum::<u64>(), 2);
        let motivos: Vec<&str> = counts.iter().map(|(m, _)| *m).collect();
        assert!(motivos.contains(&"demasiado corto"));
        assert!(motivos.contains(&"caracteres repetidos"));
    }
}
