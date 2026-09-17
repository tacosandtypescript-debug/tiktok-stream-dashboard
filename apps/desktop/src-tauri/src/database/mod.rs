//! Persistencia en SQLite.
//!
//! Decisiones de docs/plan-review.md:
//!   * la base vive en el directorio de datos de la aplicacion, **nunca** en
//!     `Documents` (una carpeta sincronizada por OneDrive con WAL se corrompe);
//!   * WAL, `synchronous=NORMAL`, `busy_timeout` y `foreign_keys=ON`;
//!   * un **escritor dedicado** en su propio hilo con `rusqlite` (que es
//!     sincrono) para no bloquear los hilos de Tokio;
//!   * escritura **por lotes** en transacciones: cientos de mensajes por segundo
//!     no pueden ser cientos de transacciones;
//!   * esquema versionado con migraciones: jamas se borra la base porque cambie
//!     el esquema (§76).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};

/// Version de esquema actual. Subirla obliga a anadir la migracion.
pub const SCHEMA_VERSION: u32 = 4;

/// Filas por transaccion. Mas grande = menos I/O, mas memoria en vuelo.
const BATCH_SIZE: usize = 200;
/// Espera maxima antes de vaciar un lote incompleto.
const BATCH_TIMEOUT: Duration = Duration::from_millis(250);

/// Migraciones en orden. Nunca se edita una migracion ya publicada: se anade.
///
/// La v2 anade los eventos sociales (follow, share, suscripcion) en una sola
/// tabla con discriminador, en lugar de una tabla por tipo: comparten forma y
/// solo cambia el significado. En la v1 los follows estaban en su propia tabla;
/// se mantiene (tiene datos) y los shares y suscripciones van aqui.
const MIGRATIONS: &[(u32, &str)] = &[
    (
        1,
        r#"
    CREATE TABLE IF NOT EXISTS streams (
        id            TEXT PRIMARY KEY,
        handle        TEXT NOT NULL,
        room_id       TEXT NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,
        crashed       INTEGER NOT NULL DEFAULT 0,
        peak_viewers  INTEGER NOT NULL DEFAULT 0,
        like_total    INTEGER NOT NULL DEFAULT 0,
        gift_count    INTEGER NOT NULL DEFAULT 0,
        diamond_total INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        unique_id  TEXT NOT NULL,
        nickname   TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_unique_id ON users(unique_id);

    CREATE TABLE IF NOT EXISTS comments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id    TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL,
        nickname     TEXT NOT NULL DEFAULT '',
        content      TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        source_id    TEXT,
        deleted_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_comments_stream ON comments(stream_id, timestamp_ms);
    -- `source_id` es el msg_id de TikTok: evita duplicar tras una reconexion.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_source
        ON comments(source_id) WHERE source_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS gift_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id     TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL,
        gift_id       TEXT NOT NULL,
        gift_name     TEXT NOT NULL DEFAULT '',
        diamond_count INTEGER NOT NULL DEFAULT 0,
        repeat_count  INTEGER NOT NULL DEFAULT 0,
        is_final      INTEGER NOT NULL DEFAULT 0,
        group_id      TEXT NOT NULL DEFAULT '0',
        timestamp_ms  INTEGER NOT NULL,
        source_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gifts_stream ON gift_events(stream_id, timestamp_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gifts_source
        ON gift_events(source_id) WHERE source_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS follows (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id    TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        source_id    TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_source
        ON follows(source_id) WHERE source_id IS NOT NULL;
    "#,
    ),
    (
        2,
        r#"
    CREATE TABLE IF NOT EXISTS social_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id    TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        nickname     TEXT NOT NULL DEFAULT '',
        timestamp_ms INTEGER NOT NULL,
        source_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_social_stream ON social_events(stream_id, kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_source
        ON social_events(source_id) WHERE source_id IS NOT NULL;
    "#,
    ),
    (
        3,
        r#"
    -- El icono del regalo se pinta en la interfaz (`GiftEventView.image_url`) y
    -- sin esta columna se perdia al reabrir la aplicacion: la lista se
    -- reconstruia desde la base y salia sin imagen.
    --
    -- `ALTER TABLE ADD COLUMN` no admite `IF NOT EXISTS` en SQLite; la
    -- idempotencia la garantiza el registro de `schema_migrations`, que solo
    -- aplica esta migracion una vez y dentro de una transaccion (si fallara a
    -- medias, no quedaria registrada).
    ALTER TABLE gift_events ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
    "#,
    ),
    (
        4,
        r#"
    -- TTS profiles are intentionally extensible: settings live in JSON so a
    -- new TTS option does not require a destructive schema change. The stable
    -- row id `default` gives existing installations a profile to use.
    CREATE TABLE IF NOT EXISTS tts_profiles (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
        is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tts_profiles_name
        ON tts_profiles(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tts_profiles_default
        ON tts_profiles(is_default) WHERE is_default = 1;
    INSERT OR IGNORE INTO tts_profiles
        (id, name, settings_json, is_default, created_at, updated_at)
    VALUES
        ('default', 'Predeterminado', '{}', 1,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    "#,
    ),
];

/// Directorio de datos de la aplicacion.
///
/// En Windows, `%LOCALAPPDATA%`: fuera de cualquier carpeta sincronizada (una
/// carpeta de OneDrive con WAL acaba corrompiendo la base).
///
/// `TTSDASH_DATA_DIR` permite redirigirlo: lo usan los tests, la
/// autoverificacion y una eventual instalacion portatil.
pub fn data_dir() -> PathBuf {
    resolve_data_dir(
        std::env::var("TTSDASH_DATA_DIR").ok().as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// Constructor puro de `data_dir`, para poder probarlo sin tocar el entorno
/// del proceso (que en tests es compartido y por tanto racy).
fn resolve_data_dir(
    custom: Option<&str>,
    local_app_data: Option<&str>,
    home: Option<&str>,
) -> PathBuf {
    if let Some(custom) = custom {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Some(local) = local_app_data {
        return Path::new(local).join("TikTokStreamDashboard");
    }
    if let Some(home) = home {
        return Path::new(home)
            .join(".local")
            .join("share")
            .join("tiktok-stream-dashboard");
    }
    PathBuf::from(".").join("data")
}

pub fn database_path() -> PathBuf {
    data_dir().join("data").join("dashboard.db")
}

/// Trabajos de escritura. El chat y los likes se pueden descartar; los regalos
/// y los follows no (docs/plan-review.md §6).
#[derive(Debug, Clone)]
pub enum WriteJob {
    /// Perfil TTS completo. Se guarda como un snapshot JSON para que anadir
    /// ajustes no obligue a otra migracion de columnas.
    TtsProfile {
        settings_json: String,
    },
    StreamStarted {
        stream_id: String,
        handle: String,
        room_id: String,
        title: String,
        started_at: i64,
    },
    StreamEnded {
        stream_id: String,
        ended_at: i64,
        crashed: bool,
    },
    Comment {
        stream_id: String,
        user_id: String,
        nickname: String,
        content: String,
        timestamp_ms: i64,
        source_id: Option<String>,
    },
    Gift {
        stream_id: String,
        user_id: String,
        gift_id: String,
        gift_name: String,
        /// Icono del regalo: sin el, la lista de regalos se reconstruia sin
        /// imagen al reabrir la aplicacion.
        image_url: String,
        diamond_count: i32,
        repeat_count: i32,
        is_final: bool,
        group_id: String,
        timestamp_ms: i64,
        source_id: Option<String>,
        /// Unidades que se contabilizan en la sesion (0 mientras la racha sigue
        /// abierta: los progresos son acumulativos y no se suman).
        committed_units: i64,
        /// Diamantes que se contabilizan en la sesion.
        committed_diamonds: i64,
    },
    /// Racha que TikTok dejo abierta y se liquida al cerrar la sesion.
    ///
    /// No se inventa una fila de regalo falsa en `gift_events`: se marca como
    /// cerrada la ultima fila **real** de esa racha (asi el historico no muestra
    /// un streak colgando) y se suman sus unidades y diamantes a la sesion con
    /// la misma sentencia que un cierre normal.
    GiftSettlement {
        stream_id: String,
        /// Identifica las filas de la racha en `gift_events`.
        group_id: String,
        units: i64,
        diamonds: i64,
    },
    /// Pico de espectadores y total de likes de la sesion.
    ///
    /// Van en una sola orden y no en dos: los dos numeros viven en la fila de
    /// `streams` y el coalescing de `app.rs` los agrupa en la misma ventana, asi
    /// que una unica sentencia por volcado es lo que de verdad ocurre.
    StreamProgress {
        stream_id: String,
        /// Pico visto desde el ultimo volcado, o `None` si no hubo viewers.
        peak_viewers: Option<i64>,
        /// Ultimo total absoluto de likes, o `None` si no hubo likes.
        like_total: Option<i64>,
    },
    /// Tombstone de un comentario borrado en TikTok.
    ///
    /// No se borra la fila: se marca **cuando** dejo de estar visible, para que
    /// el historico conserve el texto y el rastro (docs/plan-review.md: "ImDelete
    /// -> tombstone, no borrado fisico"). Un aviso de TikTok puede borrar varios
    /// mensajes, asi que llega una orden por mensaje.
    ChatDeleted {
        stream_id: String,
        /// `msg_id` de TikTok del mensaje borrado.
        source_id: String,
        deleted_at: i64,
    },
    Follow {
        stream_id: String,
        user_id: String,
        timestamp_ms: i64,
        source_id: Option<String>,
    },
    /// Follow, share o suscripcion, con el tipo como discriminador.
    Social {
        stream_id: String,
        kind: String,
        user_id: String,
        nickname: String,
        timestamp_ms: i64,
        source_id: Option<String>,
    },
    Shutdown,
}

impl WriteJob {
    /// Trabajos cuya perdida cambia los totales economicos o el historico de
    /// la sesion. Se usa para identificar un fallo de transaccion, distinto de
    /// un descarte normal por saturacion de la cola.
    fn is_critical(&self) -> bool {
        matches!(
            self,
            Self::StreamStarted { .. }
                | Self::StreamEnded { .. }
                | Self::Gift { .. }
                | Self::GiftSettlement { .. }
                | Self::Follow { .. }
                | Self::Social { .. }
        )
    }
}

/// Conexion configurada. Una sola instancia por proceso.
pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creando {}", parent.display()))?;
        }
        let conn =
            Connection::open(path).with_context(|| format!("abriendo {}", path.display()))?;
        let database = Self { conn };
        database.apply_pragmas()?;
        Ok(database)
    }

    pub fn open_in_memory() -> Result<Self> {
        let database = Self {
            conn: Connection::open_in_memory().context("abriendo base en memoria")?,
        };
        database.apply_pragmas()?;
        Ok(database)
    }

    fn apply_pragmas(&self) -> Result<()> {
        // WAL: lecturas concurrentes sin bloquear al escritor.
        self.conn.pragma_update(None, "journal_mode", "WAL")?;
        self.conn.pragma_update(None, "synchronous", "NORMAL")?;
        self.conn.pragma_update(None, "foreign_keys", "ON")?;
        self.conn.pragma_update(None, "temp_store", "MEMORY")?;
        self.conn.busy_timeout(Duration::from_secs(5))?;
        Ok(())
    }

    /// Aplica las migraciones pendientes. Devuelve la version resultante.
    pub fn migrate(&self) -> Result<u32> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                 version    INTEGER PRIMARY KEY,
                 applied_at INTEGER NOT NULL
             );",
        )?;

        let current: u32 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        for (version, sql) in MIGRATIONS {
            if *version <= current {
                continue;
            }
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(sql)
                .with_context(|| format!("aplicando la migracion v{version}"))?;
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                params![version, now_ms()],
            )?;
            tx.commit()?;
            tracing::info!(version, "migracion aplicada");
        }

        Ok(self.schema_version())
    }

    pub fn schema_version(&self) -> u32 {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0)
    }

    /// Aplica un lote de trabajos en **una** transaccion.
    ///
    /// Devuelve cuantas filas se escribieron de verdad (los duplicados por
    /// `source_id` se ignoran silenciosamente).
    pub fn write_batch(&mut self, jobs: &[WriteJob]) -> Result<usize> {
        if jobs.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.transaction()?;
        let mut written = 0usize;
        {
            let mut comment = tx.prepare_cached(
                "INSERT OR IGNORE INTO comments
                   (stream_id, user_id, nickname, content, timestamp_ms, source_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            let mut gift = tx.prepare_cached(
                "INSERT OR IGNORE INTO gift_events
                   (stream_id, user_id, gift_id, gift_name, image_url, diamond_count,
                    repeat_count, is_final, group_id, timestamp_ms, source_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            let mut follow = tx.prepare_cached(
                "INSERT OR IGNORE INTO follows (stream_id, user_id, timestamp_ms, source_id)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            let mut social = tx.prepare_cached(
                "INSERT OR IGNORE INTO social_events
                   (stream_id, kind, user_id, nickname, timestamp_ms, source_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            let mut user = tx.prepare_cached(
                "INSERT INTO users (id, unique_id, nickname, first_seen, last_seen)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen",
            )?;
            let mut stream_start = tx.prepare_cached(
                "INSERT OR REPLACE INTO streams
                   (id, handle, room_id, title, started_at, crashed)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            )?;
            let mut stream_end =
                tx.prepare_cached("UPDATE streams SET ended_at = ?2, crashed = ?3 WHERE id = ?1")?;
            let mut bump = tx.prepare_cached(
                "UPDATE streams SET comment_count = comment_count + 1 WHERE id = ?1",
            )?;
            // `deleted_at IS NULL` lo hace idempotente: un segundo aviso del
            // mismo mensaje no reescribe cuando se borro.
            let mut comment_deleted = tx.prepare_cached(
                "UPDATE comments SET deleted_at = ?1
                  WHERE stream_id = ?2 AND source_id = ?3 AND deleted_at IS NULL",
            )?;
            let mut bump_gift = tx.prepare_cached(
                "UPDATE streams SET gift_count = gift_count + ?2,
                                    diamond_total = diamond_total + ?3
                 WHERE id = ?1",
            )?;
            // Cierra el historico de una racha abandonada: la ultima fila real
            // pasa a ser la que la cierra. Se busca por `MAX(id)` porque el
            // orden de llegada es el unico orden disponible.
            let mut close_streak = tx.prepare_cached(
                "UPDATE gift_events SET is_final = 1
                  WHERE id = (SELECT MAX(id) FROM gift_events
                               WHERE stream_id = ?1 AND group_id = ?2 AND is_final = 0)
                    AND NOT EXISTS (SELECT 1 FROM gift_events
                                    WHERE stream_id = ?1 AND group_id = ?2 AND is_final = 1)",
            )?;
            // `MAX` con dos argumentos es una funcion escalar de SQLite: deja el
            // pico anterior si el nuevo es menor. `COALESCE` respeta la columna
            // que este volcado no toca.
            let mut stream_progress = tx.prepare_cached(
                "UPDATE streams
                    SET peak_viewers = MAX(peak_viewers, COALESCE(?2, peak_viewers)),
                        like_total    = MAX(like_total, COALESCE(?3, like_total))
                  WHERE id = ?1",
            )?;
            // El indice unico de `is_default = 1` protege la base, pero se
            // desmarca primero cualquier fila antigua que pudiera haber sido
            // creada antes del indice. El perfil estable `default` es el unico
            // que escribe el gestor en esta version.
            let mut clear_other_tts_defaults = tx.prepare_cached(
                "UPDATE tts_profiles SET is_default = 0
                 WHERE is_default = 1 AND id <> 'default'",
            )?;
            let mut tts_profile = tx.prepare_cached(
                "INSERT INTO tts_profiles
                   (id, name, settings_json, is_default, created_at, updated_at)
                 VALUES ('default', 'Predeterminado', ?1, 1, ?2, ?2)
                 ON CONFLICT(id) DO UPDATE SET
                   settings_json = excluded.settings_json,
                   is_default = 1,
                   updated_at = excluded.updated_at",
            )?;

            for job in jobs {
                match job {
                    WriteJob::TtsProfile { settings_json } => {
                        clear_other_tts_defaults.execute([])?;
                        written += tts_profile.execute(params![settings_json, now_ms()])?;
                    }
                    WriteJob::StreamStarted {
                        stream_id,
                        handle,
                        room_id,
                        title,
                        started_at,
                    } => {
                        written += stream_start
                            .execute(params![stream_id, handle, room_id, title, started_at])?;
                    }
                    WriteJob::StreamEnded {
                        stream_id,
                        ended_at,
                        crashed,
                    } => {
                        written += stream_end.execute(params![stream_id, ended_at, crashed])?;
                    }
                    WriteJob::Comment {
                        stream_id,
                        user_id,
                        nickname,
                        content,
                        timestamp_ms,
                        source_id,
                    } => {
                        user.execute(params![user_id, user_id, nickname, timestamp_ms])?;
                        let inserted = comment.execute(params![
                            stream_id,
                            user_id,
                            nickname,
                            content,
                            timestamp_ms,
                            source_id
                        ])?;
                        written += inserted;
                        if inserted > 0 {
                            bump.execute(params![stream_id])?;
                        }
                    }
                    WriteJob::ChatDeleted {
                        stream_id,
                        source_id,
                        deleted_at,
                    } => {
                        // No suma a `written` como una fila nueva: es una marca
                        // sobre una fila que ya existe (y puede no existir, si el
                        // mensaje salio de la ventana antes de llegar el aviso).
                        comment_deleted.execute(params![deleted_at, stream_id, source_id])?;
                    }
                    WriteJob::Gift {
                        stream_id,
                        user_id,
                        gift_id,
                        gift_name,
                        image_url,
                        diamond_count,
                        repeat_count,
                        is_final,
                        group_id,
                        timestamp_ms,
                        source_id,
                        committed_units,
                        committed_diamonds,
                    } => {
                        user.execute(params![user_id, user_id, "", timestamp_ms])?;
                        let inserted = gift.execute(params![
                            stream_id,
                            user_id,
                            gift_id,
                            gift_name,
                            image_url,
                            diamond_count,
                            repeat_count,
                            is_final,
                            group_id,
                            timestamp_ms,
                            source_id
                        ])?;
                        written += inserted;
                        // Solo se suman las aportaciones completas: los progresos
                        // de una racha llegan con 0. El `INSERT OR IGNORE` es la
                        // frontera de idempotencia: un replay no vuelve a sumar.
                        if inserted > 0 && (*committed_units > 0 || *committed_diamonds > 0) {
                            bump_gift.execute(params![
                                stream_id,
                                committed_units,
                                committed_diamonds
                            ])?;
                        }
                    }
                    WriteJob::GiftSettlement {
                        stream_id,
                        group_id,
                        units,
                        diamonds,
                    } => {
                        let closed = close_streak.execute(params![stream_id, group_id])?;
                        written += closed;
                        // Solo la primera liquidacion cambia el historico.
                        if closed > 0 && (*units > 0 || *diamonds > 0) {
                            written += bump_gift.execute(params![stream_id, units, diamonds])?;
                        }
                    }
                    WriteJob::StreamProgress {
                        stream_id,
                        peak_viewers,
                        like_total,
                    } => {
                        written += stream_progress.execute(params![
                            stream_id,
                            peak_viewers,
                            like_total
                        ])?;
                    }
                    WriteJob::Follow {
                        stream_id,
                        user_id,
                        timestamp_ms,
                        source_id,
                    } => {
                        user.execute(params![user_id, user_id, "", timestamp_ms])?;
                        written +=
                            follow.execute(params![stream_id, user_id, timestamp_ms, source_id])?;
                    }
                    WriteJob::Social {
                        stream_id,
                        kind,
                        user_id,
                        nickname,
                        timestamp_ms,
                        source_id,
                    } => {
                        user.execute(params![user_id, user_id, nickname, timestamp_ms])?;
                        written += social.execute(params![
                            stream_id,
                            kind,
                            user_id,
                            nickname,
                            timestamp_ms,
                            source_id
                        ])?;
                    }
                    WriteJob::Shutdown => {}
                }
            }
        }
        tx.commit()?;
        Ok(written)
    }

    pub fn count(&self, table: &str) -> Result<i64> {
        // Solo para tests y diagnostico: la tabla no viene de entrada externa.
        let sql = format!("SELECT COUNT(*) FROM {table}");
        Ok(self.conn.query_row(&sql, [], |row| row.get(0))?)
    }

    pub fn query_string(&self, sql: &str, index: usize) -> Result<Option<String>> {
        let mut statement = self.conn.prepare(sql)?;
        let mut rows = statement.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(index)?)),
            None => Ok(None),
        }
    }

    pub fn query_i64(&self, sql: &str, index: usize) -> Result<Option<i64>> {
        let mut statement = self.conn.prepare(sql)?;
        let mut rows = statement.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(index)?)),
            None => Ok(None),
        }
    }

    /// Lee el JSON del perfil TTS que la migracion marca como predeterminado.
    ///
    /// La lectura ocurre antes de arrancar `DbWriter` para que `TtsManager`
    /// nazca ya con la configuracion persistida y no haya una ventana de audio
    /// usando valores de fabrica.
    pub fn default_tts_profile(&self) -> Result<Option<String>> {
        self.query_string(
            "SELECT settings_json FROM tts_profiles
             WHERE is_default = 1
             ORDER BY updated_at DESC
             LIMIT 1",
            0,
        )
    }

    /// Cierra las sesiones que quedaron abiertas por un cierre inesperado.
    pub fn mark_crashed_streams(&self) -> Result<usize> {
        let updated = self.conn.execute(
            "UPDATE streams SET ended_at = ?1, crashed = 1 WHERE ended_at IS NULL",
            params![now_ms()],
        )?;
        if updated > 0 {
            tracing::warn!(updated, "sesiones anteriores cerradas como interrumpidas");
        }
        Ok(updated)
    }
}

/// Escritor dedicado: consume trabajos y los escribe por lotes.
pub struct DbWriter {
    tx: SyncSender<WriteJob>,
    dropped: Arc<AtomicU64>,
    join: Mutex<Option<std::thread::JoinHandle<()>>>,
    written: Arc<AtomicU64>,
    write_errors: Arc<AtomicU64>,
    critical_write_errors: Arc<AtomicU64>,
}

impl DbWriter {
    /// Arranca el hilo escritor. `capacity` acota la cola: si se llena, los
    /// trabajos descartables se descartan y se cuentan.
    pub fn start(mut database: Database, capacity: usize) -> Self {
        let (tx, rx) = sync_channel::<WriteJob>(capacity);
        let dropped = Arc::new(AtomicU64::new(0));
        let written = Arc::new(AtomicU64::new(0));
        let thread_written = written.clone();
        let write_errors = Arc::new(AtomicU64::new(0));
        let critical_write_errors = Arc::new(AtomicU64::new(0));
        let thread_write_errors = write_errors.clone();
        let thread_critical_write_errors = critical_write_errors.clone();

        let join = std::thread::Builder::new()
            .name("db-writer".into())
            .spawn(move || {
                let mut batch: Vec<WriteJob> = Vec::with_capacity(BATCH_SIZE);
                loop {
                    let first = if batch.is_empty() {
                        match rx.recv() {
                            Ok(job) => Some(job),
                            Err(_) => break,
                        }
                    } else {
                        match rx.recv_timeout(BATCH_TIMEOUT) {
                            Ok(job) => Some(job),
                            Err(RecvTimeoutError::Timeout) => None,
                            Err(RecvTimeoutError::Disconnected) => {
                                flush(
                                    &mut database,
                                    &mut batch,
                                    &thread_written,
                                    &thread_write_errors,
                                    &thread_critical_write_errors,
                                );
                                break;
                            }
                        }
                    };

                    match first {
                        Some(WriteJob::Shutdown) => {
                            flush(
                                &mut database,
                                &mut batch,
                                &thread_written,
                                &thread_write_errors,
                                &thread_critical_write_errors,
                            );
                            tracing::info!("escritor de base de datos detenido");
                            break;
                        }
                        Some(job) => {
                            batch.push(job);
                            // Se drena lo que quepa sin bloquear para llenar el lote.
                            while batch.len() < BATCH_SIZE {
                                match rx.try_recv() {
                                    Ok(WriteJob::Shutdown) => {
                                        flush(
                                            &mut database,
                                            &mut batch,
                                            &thread_written,
                                            &thread_write_errors,
                                            &thread_critical_write_errors,
                                        );
                                        tracing::info!("escritor de base de datos detenido");
                                        return;
                                    }
                                    Ok(job) => batch.push(job),
                                    Err(_) => break,
                                }
                            }
                            if batch.len() >= BATCH_SIZE {
                                flush(
                                    &mut database,
                                    &mut batch,
                                    &thread_written,
                                    &thread_write_errors,
                                    &thread_critical_write_errors,
                                );
                            }
                        }
                        None => flush(
                            &mut database,
                            &mut batch,
                            &thread_written,
                            &thread_write_errors,
                            &thread_critical_write_errors,
                        ),
                    }
                }
            })
            .expect("no se pudo arrancar el hilo escritor");

        Self {
            tx,
            dropped,
            join: Mutex::new(Some(join)),
            written,
            write_errors,
            critical_write_errors,
        }
    }

    /// Envio no bloqueante. Devuelve `false` si la cola estaba llena (el
    /// llamante decide si eso es aceptable para ese tipo de evento).
    pub fn try_send(&self, job: WriteJob) -> bool {
        match self.tx.try_send(job) {
            Ok(()) => true,
            Err(_) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Envio de un evento que **no se puede perder** (un regalo).
    ///
    /// Reintenta hasta agotar el plazo mientras el escritor drena en paralelo.
    /// El plazo acota el bloqueo: dejar esperando al consumidor de eventos para
    /// siempre seria peor que el problema que se quiere evitar. Devuelve `false`
    /// solo si se agoto el tiempo; entonces el llamante debe contabilizarlo y
    /// marcar la sesion como degradada, nunca perderlo en silencio
    /// (docs/plan-review.md §6).
    pub fn send_critical(&self, job: WriteJob, timeout: Duration) -> bool {
        let plazo = Instant::now() + timeout;
        let mut pendiente = job;
        loop {
            match self.tx.try_send(pendiente) {
                Ok(()) => return true,
                Err(TrySendError::Full(devuelto)) => {
                    if Instant::now() >= plazo {
                        self.dropped.fetch_add(1, Ordering::Relaxed);
                        return false;
                    }
                    pendiente = devuelto;
                    // Espera corta: el escritor esta vaciando la cola en su hilo.
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(TrySendError::Disconnected(_)) => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
            }
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn written(&self) -> u64 {
        self.written.load(Ordering::Relaxed)
    }

    /// Numero de lotes que fallaron por un error SQLite.
    pub fn write_errors(&self) -> u64 {
        self.write_errors.load(Ordering::Relaxed)
    }

    /// Numero de trabajos criticos incluidos en lotes fallidos.
    pub fn critical_write_errors(&self) -> u64 {
        self.critical_write_errors.load(Ordering::Relaxed)
    }

    /// Cierra el escritor y espera a que vacie la cola.
    ///
    /// Toma `&self` para poder consultar los contadores despues del cierre.
    /// Llamarlo dos veces es inocuo.
    pub fn close(&self) {
        let _ = self.tx.send(WriteJob::Shutdown);
        let join = self.join.lock().ok().and_then(|mut guard| guard.take());
        if let Some(join) = join {
            let _ = join.join();
        }
    }
}

fn flush(
    database: &mut Database,
    batch: &mut Vec<WriteJob>,
    written: &AtomicU64,
    write_errors: &AtomicU64,
    critical_write_errors: &AtomicU64,
) {
    if batch.is_empty() {
        return;
    }
    match database.write_batch(batch) {
        Ok(rows) => {
            written.fetch_add(rows as u64, Ordering::Relaxed);
        }
        Err(error) => {
            let critical = batch.iter().filter(|job| job.is_critical()).count() as u64;
            write_errors.fetch_add(1, Ordering::Relaxed);
            critical_write_errors.fetch_add(critical, Ordering::Relaxed);
            tracing::error!(
                %error,
                filas = batch.len(),
                criticos = critical,
                "fallo el lote de escritura; se perdieron los trabajos del lote"
            );
        }
    }
    batch.clear();
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(seq: i64) -> WriteJob {
        WriteJob::Comment {
            stream_id: "s1".into(),
            user_id: format!("u{seq}"),
            nickname: "Carlos".into(),
            content: format!("mensaje {seq}"),
            timestamp_ms: seq,
            source_id: Some(format!("msg-{seq}")),
        }
    }

    fn open() -> Database {
        let database = Database::open_in_memory().expect("base en memoria");
        database.migrate().expect("migraciones");
        database
    }

    #[test]
    fn el_directorio_de_datos_se_resuelve_por_prioridad() {
        // El override manda: es lo que usan la autoverificacion y los tests.
        assert_eq!(
            resolve_data_dir(Some("C:\\tmp\\ttdash"), Some("C:\\Local"), Some("/home/u")),
            PathBuf::from("C:\\tmp\\ttdash")
        );
        // Un override vacio se ignora y no rompe la resolucion normal.
        assert_eq!(
            resolve_data_dir(Some("   "), Some("C:\\Local"), None),
            Path::new("C:\\Local").join("TikTokStreamDashboard")
        );
        // En Windows se prefiere LOCALAPPDATA, nunca una carpeta sincronizada.
        assert_eq!(
            resolve_data_dir(None, Some("C:\\Local"), Some("/home/u")),
            Path::new("C:\\Local").join("TikTokStreamDashboard")
        );
        // Sin ninguna variable, se cae a una ruta relativa en lugar de fallar.
        assert_eq!(
            resolve_data_dir(None, None, None),
            PathBuf::from(".").join("data")
        );
    }

    #[test]
    fn las_migraciones_son_idempotentes() {
        let database = open();
        assert_eq!(database.schema_version(), SCHEMA_VERSION);
        // Aplicarlas otra vez no debe fallar ni duplicar nada.
        assert_eq!(database.migrate().expect("segunda pasada"), SCHEMA_VERSION);
    }

    #[test]
    fn escribe_un_lote_y_deduplica_por_source_id() {
        let mut database = open();
        database
            .write_batch(&[WriteJob::StreamStarted {
                stream_id: "s1".into(),
                handle: "usuario".into(),
                room_id: "123".into(),
                title: "directo".into(),
                started_at: 1,
            }])
            .expect("stream");

        let filas = database
            .write_batch(&[comment(1), comment(2), comment(2)])
            .expect("comentarios");
        assert_eq!(filas, 2, "el duplicado por source_id no se escribe");
        assert_eq!(database.count("comments").unwrap(), 2);
        assert_eq!(database.count("users").unwrap(), 2);
        assert_eq!(database.count("streams").unwrap(), 1);
    }

    #[test]
    fn los_regalos_guardan_el_streak_y_suman_diamantes() {
        let mut database = open();
        database
            .write_batch(&[WriteJob::StreamStarted {
                stream_id: "s1".into(),
                handle: "usuario".into(),
                room_id: "123".into(),
                title: String::new(),
                started_at: 1,
            }])
            .expect("stream");

        database
            .write_batch(&[
                WriteJob::Gift {
                    stream_id: "s1".into(),
                    user_id: "u1".into(),
                    gift_id: "5655".into(),
                    gift_name: "Rose".into(),
                    image_url: "https://cdn.example/rose.png".into(),
                    diamond_count: 1,
                    repeat_count: 1,
                    is_final: false,
                    group_id: "g1".into(),
                    timestamp_ms: 10,
                    source_id: Some("m1".into()),
                    // Progreso de la racha: no se contabiliza todavia.
                    committed_units: 0,
                    committed_diamonds: 0,
                },
                WriteJob::Gift {
                    stream_id: "s1".into(),
                    user_id: "u1".into(),
                    gift_id: "5655".into(),
                    gift_name: "Rose".into(),
                    image_url: "https://cdn.example/rose.png".into(),
                    diamond_count: 1,
                    repeat_count: 3,
                    is_final: true,
                    group_id: "g1".into(),
                    timestamp_ms: 11,
                    source_id: Some("m2".into()),
                    // Cierra la racha: 3 rosas de 1 diamante.
                    committed_units: 3,
                    committed_diamonds: 3,
                },
            ])
            .expect("regalos");

        assert_eq!(
            database.count("gift_events").unwrap(),
            2,
            "se guardan los dos eventos"
        );
        let diamantes = database
            .query_i64("SELECT diamond_total FROM streams WHERE id = 's1'", 0)
            .unwrap();
        assert_eq!(diamantes, Some(3), "la racha son 3 rosas, no 1+3 diamantes");
        let unidades = database
            .query_i64("SELECT gift_count FROM streams WHERE id = 's1'", 0)
            .unwrap();
        assert_eq!(unidades, Some(3), "y se cuentan unidades, no eventos");

        let grupo = database
            .query_string("SELECT group_id FROM gift_events ORDER BY id LIMIT 1", 0)
            .unwrap();
        assert_eq!(grupo.as_deref(), Some("g1"));

        let finales = database
            .query_i64("SELECT COUNT(*) FROM gift_events WHERE is_final = 1", 0)
            .unwrap();
        assert_eq!(finales, Some(1), "solo el ultimo evento cierra el streak");

        // El icono se guarda: sin el, la lista de regalos salia sin imagen al
        // reabrir la aplicacion (migracion v3).
        assert_eq!(
            database
                .query_string("SELECT image_url FROM gift_events ORDER BY id LIMIT 1", 0)
                .unwrap()
                .as_deref(),
            Some("https://cdn.example/rose.png"),
            "el icono del regalo debe persistirse"
        );
    }

    /// La migracion v3 anade `image_url`; la v4 crea el perfil TTS inicial.
    #[test]
    fn las_migraciones_actuales_anaden_icono_y_perfil_tts() {
        let database = open();
        assert_eq!(database.schema_version(), 4, "el esquema llega a la v4");
        // La columna existe y su valor por defecto es vacio (no NULL): las filas
        // antiguas siguen siendo legibles.
        let columnas = database
            .query_i64(
                "SELECT COUNT(*) FROM pragma_table_info('gift_events') WHERE name = 'image_url'",
                0,
            )
            .unwrap();
        assert_eq!(columnas, Some(1), "gift_events debe tener image_url");
        assert_eq!(database.count("tts_profiles").unwrap(), 1);
        assert_eq!(
            database
                .query_string("SELECT id FROM tts_profiles WHERE is_default = 1", 0)
                .unwrap()
                .as_deref(),
            Some("default")
        );
        assert_eq!(
            database
                .query_string(
                    "SELECT settings_json FROM tts_profiles WHERE id = 'default'",
                    0
                )
                .unwrap()
                .as_deref(),
            Some("{}")
        );
        // El perfil admite opciones futuras sin otra migracion de columnas.
        database
            .conn
            .execute(
                "INSERT INTO tts_profiles
                    (id, name, settings_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, 1)",
                params!["custom", "Personalizado", r#"{"new_option":true}"#],
            )
            .unwrap();
        assert_eq!(database.count("tts_profiles").unwrap(), 2);
    }

    #[test]
    fn el_perfil_tts_se_guarda_completo_y_solo_deja_un_default() {
        let mut database = open();
        let settings_json = r#"{
            "enabled": false,
            "voice_es": "es-MX-DaliaNeural",
            "voice_en": "en-GB-SoniaNeural",
            "say_author": false,
            "volume": 0.35,
            "rate": "+25%",
            "pitch": "-4Hz",
            "audio_device": "Cable Input",
            "read_gifts": false,
            "read_follows": true,
            "filters": {"max_chars": 99, "blocked_words": ["spoiler"]},
            "queue_capacity": 64
        }"#;

        assert_eq!(
            database
                .write_batch(&[WriteJob::TtsProfile {
                    settings_json: settings_json.into()
                }])
                .unwrap(),
            1
        );
        assert_eq!(
            database.default_tts_profile().unwrap().as_deref(),
            Some(settings_json)
        );
        assert_eq!(
            database
                .query_i64("SELECT COUNT(*) FROM tts_profiles WHERE is_default = 1", 0)
                .unwrap(),
            Some(1)
        );
    }

    /// El caso real de la migracion: una instalacion que ya tenia datos en la v2
    /// se actualiza sin perder las filas de regalos que ya estaban guardadas ni
    /// duplicar el perfil predeterminado.
    #[test]
    fn una_base_anterior_se_actualiza_a_la_v4_sin_perder_regalos() {
        let database = Database::open_in_memory().expect("base en memoria");
        // Se aplica el esquema hasta la v2, como una instalacion anterior.
        database
            .conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations (
                     version    INTEGER PRIMARY KEY,
                     applied_at INTEGER NOT NULL
                 );",
            )
            .unwrap();
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version <= 2) {
            database.conn.execute_batch(sql).unwrap();
            database
                .conn
                .execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
                    params![version],
                )
                .unwrap();
        }
        database
            .conn
            .execute(
                "INSERT INTO streams (id, handle, room_id, started_at) VALUES ('s1', 'u', '1', 1)",
                [],
            )
            .unwrap();
        database
            .conn
            .execute(
                "INSERT INTO gift_events (stream_id, user_id, gift_id, diamond_count, timestamp_ms)
                 VALUES ('s1', 'u', '5655', 1, 10)",
                [],
            )
            .unwrap();

        assert_eq!(database.migrate().expect("migrando"), 4);
        assert_eq!(
            database.count("gift_events").unwrap(),
            1,
            "no se pierde la fila"
        );
        assert_eq!(
            database
                .query_string("SELECT image_url FROM gift_events", 0)
                .unwrap()
                .as_deref(),
            Some(""),
            "las filas anteriores quedan con el icono vacio, no nulas"
        );
        assert_eq!(database.count("tts_profiles").unwrap(), 1);
        // Y aplicar la migracion otra vez no rompe nada.
        assert_eq!(database.migrate().expect("segunda pasada"), 4);
        assert_eq!(database.count("tts_profiles").unwrap(), 1);
    }

    /// El pico de espectadores se guarda con `MAX` y el total de likes con el
    /// ultimo valor; un volcado que solo trae uno de los dos no pisa el otro.
    #[test]
    fn el_progreso_de_la_sesion_solo_avanza() {
        let mut database = open();
        database
            .write_batch(&[WriteJob::StreamStarted {
                stream_id: "s1".into(),
                handle: "usuario".into(),
                room_id: "123".into(),
                title: String::new(),
                started_at: 1,
            }])
            .expect("stream");

        database
            .write_batch(&[
                WriteJob::StreamProgress {
                    stream_id: "s1".into(),
                    peak_viewers: Some(100),
                    like_total: Some(500),
                },
                // Los espectadores bajan: el pico no puede bajar con ellos.
                WriteJob::StreamProgress {
                    stream_id: "s1".into(),
                    peak_viewers: Some(80),
                    like_total: Some(900),
                },
                // Un volcado solo de viewers no toca los likes.
                WriteJob::StreamProgress {
                    stream_id: "s1".into(),
                    peak_viewers: Some(150),
                    like_total: None,
                },
                // Y uno solo de likes no toca los viewers.
                WriteJob::StreamProgress {
                    stream_id: "s1".into(),
                    peak_viewers: None,
                    like_total: Some(1200),
                },
                // Un frameo retrasado no puede hacer retroceder el total
                // absoluto ya persistido.
                WriteJob::StreamProgress {
                    stream_id: "s1".into(),
                    peak_viewers: None,
                    like_total: Some(700),
                },
            ])
            .expect("progreso");

        assert_eq!(
            database
                .query_i64("SELECT peak_viewers FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(150),
            "el pico es el mayor visto, no el ultimo"
        );
        assert_eq!(
            database
                .query_i64("SELECT like_total FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(1200),
            "los likes son un total absoluto monotono"
        );
        assert_eq!(
            database
                .query_i64("SELECT comment_count FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(0),
            "el progreso no toca otros contadores"
        );
    }

    #[test]
    fn los_contadores_de_comentarios_y_regalos_son_idempotentes() {
        let mut database = open();
        database
            .write_batch(&[WriteJob::StreamStarted {
                stream_id: "s1".into(),
                handle: "usuario".into(),
                room_id: "123".into(),
                title: String::new(),
                started_at: 1,
            }])
            .expect("stream");

        let comentario = comment(1);
        assert_eq!(
            database
                .write_batch(std::slice::from_ref(&comentario))
                .unwrap(),
            1
        );
        assert_eq!(database.write_batch(&[comentario]).unwrap(), 0);
        assert_eq!(
            database
                .query_i64("SELECT comment_count FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(1),
            "un replay no vuelve a contar el comentario"
        );

        let regalo = WriteJob::Gift {
            stream_id: "s1".into(),
            user_id: "u1".into(),
            gift_id: "5655".into(),
            gift_name: "Rose".into(),
            image_url: String::new(),
            diamond_count: 2,
            repeat_count: 3,
            is_final: true,
            group_id: "g1".into(),
            timestamp_ms: 10,
            source_id: Some("gift-1".into()),
            committed_units: 3,
            committed_diamonds: 6,
        };
        assert_eq!(
            database.write_batch(std::slice::from_ref(&regalo)).unwrap(),
            1
        );
        assert_eq!(database.write_batch(&[regalo]).unwrap(), 0);
        assert_eq!(
            database
                .query_i64("SELECT gift_count FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(3),
            "un replay no vuelve a contar las unidades"
        );
        assert_eq!(
            database
                .query_i64("SELECT diamond_total FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(6),
            "un replay no vuelve a contar los diamantes"
        );
    }

    /// Al cerrar la sesion se liquida la racha que TikTok dejo abierta: se marca
    /// como cerrada su ultima fila real y se suman sus diamantes a la sesion.
    #[test]
    fn la_liquidacion_de_una_racha_abierta_cierra_la_fila_y_suma() {
        let mut database = open();
        database
            .write_batch(&[WriteJob::StreamStarted {
                stream_id: "s1".into(),
                handle: "usuario".into(),
                room_id: "123".into(),
                title: String::new(),
                started_at: 1,
            }])
            .expect("stream");
        // Dos progresos de una racha que nunca recibe `repeat_end`.
        for (source, timestamp) in [("m1", 10), ("m2", 11)] {
            database
                .write_batch(&[WriteJob::Gift {
                    stream_id: "s1".into(),
                    user_id: "u1".into(),
                    gift_id: "5655".into(),
                    gift_name: "Rose".into(),
                    image_url: String::new(),
                    diamond_count: 1,
                    repeat_count: 1,
                    is_final: false,
                    group_id: "g1".into(),
                    timestamp_ms: timestamp,
                    source_id: Some(source.into()),
                    committed_units: 0,
                    committed_diamonds: 0,
                }])
                .expect("regalo");
        }
        assert_eq!(
            database
                .query_i64("SELECT diamond_total FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(0),
            "mientras la racha sigue abierta no se contabiliza nada"
        );

        database
            .write_batch(&[WriteJob::GiftSettlement {
                stream_id: "s1".into(),
                group_id: "g1".into(),
                units: 2,
                diamonds: 2,
            }])
            .expect("liquidacion");

        database
            .write_batch(&[WriteJob::GiftSettlement {
                stream_id: "s1".into(),
                group_id: "g1".into(),
                units: 2,
                diamonds: 2,
            }])
            .expect("liquidacion repetida");

        assert_eq!(
            database
                .query_i64("SELECT diamond_total FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(2),
            "los diamantes de la racha abandonada no se pierden"
        );
        assert_eq!(
            database
                .query_i64("SELECT gift_count FROM streams WHERE id = 's1'", 0)
                .unwrap(),
            Some(2),
            "y las unidades tampoco"
        );
        assert_eq!(
            database
                .query_i64(
                    "SELECT COUNT(*) FROM gift_events WHERE group_id = 'g1' AND is_final = 1",
                    0
                )
                .unwrap(),
            Some(1),
            "solo la ultima fila de la racha queda marcada como cierre"
        );
        assert_eq!(
            database
                .query_i64(
                    "SELECT is_final FROM gift_events WHERE group_id = 'g1' ORDER BY id DESC LIMIT 1",
                    0
                )
                .unwrap(),
            Some(1),
            "y es la mas reciente"
        );
        assert_eq!(
            database.count("gift_events").unwrap(),
            2,
            "no se inventa una fila de regalo para ajustar"
        );
    }

    #[test]
    fn el_borrado_deja_tombstone_y_no_borra_la_fila() {
        let mut database = open();
        database
            .write_batch(&[
                WriteJob::StreamStarted {
                    stream_id: "s1".into(),
                    handle: "carlos".into(),
                    room_id: "r1".into(),
                    title: "directo".into(),
                    started_at: 1,
                },
                WriteJob::Comment {
                    stream_id: "s1".into(),
                    user_id: "u1".into(),
                    nickname: "Carlos".into(),
                    content: "hola".into(),
                    timestamp_ms: 10,
                    source_id: Some("m1".into()),
                },
            ])
            .expect("comentario");

        database
            .write_batch(&[WriteJob::ChatDeleted {
                stream_id: "s1".into(),
                source_id: "m1".into(),
                deleted_at: 99,
            }])
            .expect("borrado");

        assert_eq!(
            database
                .query_i64("SELECT COUNT(*) FROM comments", 0)
                .unwrap(),
            Some(1),
            "el borrado es un tombstone: la fila se conserva"
        );
        assert_eq!(
            database
                .query_i64("SELECT deleted_at FROM comments WHERE source_id = 'm1'", 0)
                .unwrap(),
            Some(99),
            "y queda marcada con cuando se borro"
        );

        // Un segundo aviso (o el mismo repetido) no reescribe la marca.
        database
            .write_batch(&[WriteJob::ChatDeleted {
                stream_id: "s1".into(),
                source_id: "m1".into(),
                deleted_at: 12345,
            }])
            .expect("borrado repetido");
        assert_eq!(
            database
                .query_i64("SELECT deleted_at FROM comments WHERE source_id = 'm1'", 0)
                .unwrap(),
            Some(99),
            "la marca es idempotente"
        );

        // Un id que no esta en la tabla no rompe nada.
        database
            .write_batch(&[WriteJob::ChatDeleted {
                stream_id: "s1".into(),
                source_id: "no-existe".into(),
                deleted_at: 200,
            }])
            .expect("borrado de algo que ya no esta");
        assert_eq!(database.count("comments").unwrap(), 1);
    }

    #[test]
    fn el_escritor_dedicado_escribe_en_disco_y_se_cierra_limpiamente() {
        let path = std::env::temp_dir().join(format!(
            "ttdash-writer-{}-{}.db",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_file(&path);

        let database = Database::open(&path).expect("base en disco");
        database.migrate().expect("migraciones");
        let writer = DbWriter::start(database, 4096);

        assert!(writer.try_send(WriteJob::StreamStarted {
            stream_id: "s1".into(),
            handle: "usuario".into(),
            room_id: "123".into(),
            title: "directo".into(),
            started_at: 1,
        }));
        for seq in 1..=50 {
            writer.try_send(comment(seq));
        }
        writer.close();
        assert_eq!(writer.dropped(), 0, "la cola no deberia haberse llenado");
        assert!(writer.written() >= 51, "escrito: {}", writer.written());
        // Se reabre para comprobar que los datos llegaron al disco.
        let check = Database::open(&path).expect("reabriendo");
        assert_eq!(check.count("comments").unwrap(), 50);
        assert_eq!(check.count("streams").unwrap(), 1);

        drop(check);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn el_escritor_espera_la_ventana_para_completar_un_lote() {
        let path = std::env::temp_dir().join(format!(
            "ttdash-writer-batch-{}-{}.db",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_file(&path);

        let database = Database::open(&path).expect("base en disco");
        database.migrate().expect("migraciones");
        let writer = DbWriter::start(database, 8);
        assert!(writer.try_send(WriteJob::StreamStarted {
            stream_id: "s1".into(),
            handle: "usuario".into(),
            room_id: "123".into(),
            title: String::new(),
            started_at: 1,
        }));

        // Un lote incompleto no debe convertirse en una transaccion por cada
        // mensaje: permanece abierto hasta el timeout o hasta llenarse.
        std::thread::sleep(Duration::from_millis(25));
        assert_eq!(writer.written(), 0, "el lote se vacio antes de tiempo");
        std::thread::sleep(BATCH_TIMEOUT + Duration::from_millis(25));
        assert_eq!(writer.written(), 1, "el timeout debe vaciar el lote");
        writer.close();

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn un_error_de_transaccion_se_cuenta_y_marca_los_trabajos_criticos() {
        let path = std::env::temp_dir().join(format!(
            "ttdash-writer-error-{}-{}.db",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_file(&path);

        let database = Database::open(&path).expect("base en disco");
        database.migrate().expect("migraciones");
        let writer = DbWriter::start(database, 8);
        assert!(writer.try_send(WriteJob::Gift {
            // No existe el stream: la transaccion debe fallar por foreign key.
            stream_id: "missing".into(),
            user_id: "u1".into(),
            gift_id: "5655".into(),
            gift_name: "Rose".into(),
            image_url: String::new(),
            diamond_count: 1,
            repeat_count: 1,
            is_final: true,
            group_id: "g1".into(),
            timestamp_ms: 10,
            source_id: Some("gift-error".into()),
            committed_units: 1,
            committed_diamonds: 1,
        }));
        writer.close();

        assert_eq!(writer.write_errors(), 1);
        assert_eq!(writer.critical_write_errors(), 1);
        assert_eq!(writer.written(), 0);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn detecta_sesiones_interrumpidas() {
        let database = open();
        database
            .conn
            .execute(
                "INSERT INTO streams (id, handle, room_id, started_at) VALUES ('s9', 'u', '1', 5)",
                [],
            )
            .unwrap();
        assert_eq!(database.mark_crashed_streams().unwrap(), 1);
        assert_eq!(database.mark_crashed_streams().unwrap(), 0);
    }
}
