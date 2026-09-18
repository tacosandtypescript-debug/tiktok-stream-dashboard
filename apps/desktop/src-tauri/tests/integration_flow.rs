//! Pruebas de integracion del flujo completo: proveedor -> bus -> estado -> SQLite.
//!
//! Vive en `tests/` (y no en `src/`) a proposito: consume **solo la API publica**
//! del crate, que es la que el shell de escritorio usa. Si un cambio rompe este
//! fichero, rompe tambien la interfaz; si el test necesita tocar campos
//! `pub(crate)`, es que la API publica se ha quedado corta.
//!
//! Cada prueba usa un fichero SQLite temporal propio (el nombre incluye pid,
//! marca de tiempo y un contador atomico) y lo borra **siempre**, incluso si las
//! aserciones fallan: para eso esta `DbTemp`, cuyo `Drop` limpia el fichero y sus
//! acompanantes `-wal` y `-shm`.
//!
//! Sobre la sincronizacion: cuando se conduce el bus de verdad no se usan
//! `sleep` fijos. El consumidor procesa en orden estricto, asi que se publica un
//! evento **centinela** (`FollowReceived`) y se espera, con un plazo acotado, a
//! que sus metricas aparezcan en el snapshot: en ese momento todo lo publicado
//! antes ya esta aplicado al estado.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashboard::app::{AppState, CHAT_CAPACITY};
use dashboard::core::bus::EventBus;
use dashboard::core::event::{Event, EventKind, GiftInfo, UserRef};
use dashboard::core::metrics::Metrics;
use dashboard::database::{Database, SCHEMA_VERSION};
use dashboard::feed::{like_is_notable, FeedKind, FEED_CAPACITY};

/// Plazo maximo para que el consumidor aplique un evento centinela.
const SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// Periodo de comprobacion del centinela. Basta para no girar en vacio.
const SYNC_POLL: std::time::Duration = std::time::Duration::from_millis(20);
/// Sala con la que se etiquetan los eventos de prueba.
const SALA: &str = "7686341765710269205";

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

static SECUENCIA: AtomicU64 = AtomicU64::new(0);

/// Base de datos temporal que se borra sola al salir del ambito.
///
/// El `Drop` **si** corre cuando una asercion falla (el harness atrapa el panic
/// y desenrolla la pila), asi que un test rojo no deja basura en `%TEMP%`. Hay
/// que borrar tambien los acompanantes `-wal` y `-shm` de SQLite: sin ellos el
/// `temp_dir` se llena entre ejecuciones.
struct DbTemp {
    path: PathBuf,
}

impl DbTemp {
    fn nueva(etiqueta: &str) -> Self {
        let unico = SECUENCIA.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let name = format!(
            "ttdash-it-{etiqueta}-{}-{nanos}-{unico}.db",
            std::process::id()
        );
        let path = std::env::temp_dir().join(&name);
        // Si un fichero homonimo sobrevivio a una ejecucion anterior, arrancar
        // con el esquema viejo haria fallar el test por un motivo equivocado.
        Self::borrar(&path);
        Self { path }
    }

    fn path(&self) -> PathBuf {
        self.path.clone()
    }

    fn borrar(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(sidecar(path, "-wal"));
        let _ = std::fs::remove_file(sidecar(path, "-shm"));
    }

    /// Cierre del camino feliz: la base tiene que seguir en disco y se deja
    /// limpia. No se comprueba que el borrado haya surtido efecto porque en
    /// Windows un descriptor todavia abierto puede retrasarlo: de la limpieza
    /// final se encarga el `Drop`, que si corre cuando una asercion falla.
    fn finalizar(&self) {
        assert!(
            std::fs::metadata(&self.path).is_ok(),
            "la base temporal deberia existir mientras el test corre: {}",
            self.path.display()
        );
        Self::borrar(&self.path);
    }
}

impl Drop for DbTemp {
    fn drop(&mut self) {
        Self::borrar(&self.path);
    }
}

/// Companero de SQLite (`dashboard.db` -> `dashboard.db-wal`).
fn sidecar(path: &Path, sufijo: &str) -> PathBuf {
    let mut texto = path.as_os_str().to_os_string();
    texto.push(sufijo);
    PathBuf::from(texto)
}

fn usuario(id: &str, nickname: &str) -> UserRef {
    UserRef {
        id: id.to_string(),
        unique_id: format!("u{id}"),
        nickname: nickname.to_string(),
        ..Default::default()
    }
}

/// `image_url` se rellena vacio: el protocolo lo declara opcional y las pruebas
/// de contabilidad no dependen del icono.
fn regalo(
    id: &str,
    name: &str,
    diamond_count: i32,
    repeat_count: i32,
    streakable: bool,
    is_final: bool,
    group_id: &str,
) -> GiftInfo {
    GiftInfo {
        id: id.to_string(),
        name: name.to_string(),
        image_url: String::new(),
        diamond_count,
        streakable,
        repeat_count,
        is_final,
        group_id: group_id.to_string(),
    }
}

fn conectar(seq: u64) -> Event {
    Event::new(
        seq,
        SALA.to_string(),
        Some(format!("sys-{seq}")),
        EventKind::StreamConnected {
            room_id: SALA.to_string(),
            title: "prueba de integracion".to_string(),
            perfil: Default::default(),
        },
    )
}

fn chat(seq: u64, user: &UserRef, content: &str) -> Event {
    Event::new(
        seq,
        SALA.to_string(),
        Some(format!("msg-{seq}")),
        EventKind::ChatMessage {
            user: user.clone(),
            content: content.to_string(),
            emote_count: 0,
        },
    )
}

/// Constructor de la desconexion, para que la prueba diga **que** envia sin
/// repetir seis lineas de `Event::new`.
fn desconectar(seq: u64) -> Event {
    Event::new(
        seq,
        SALA.to_string(),
        Some(format!("sys-{seq}")),
        EventKind::StreamDisconnected {
            reason: "fin de la prueba".to_string(),
        },
    )
}

/// Banco de pruebas con un bus **propio** y el estado real.
///
/// El bus interno de `AppState` es `pub(crate)`: desde `tests/` no se puede
/// publicar en el, solo suscribirse. Para probar de verdad la deduplicacion y el
/// orden hay que conducir un `EventBus` real y aplicar sus eventos con
/// `on_event`, que si es publico. El consumidor de aqui replica el bucle de
/// `AppState::consumer_future` (recibir -> aplicar -> contar el lag) sin tocar
/// nada privado, y el centinela es lo que garantiza el orden: si se ve el
/// centinela en el estado, todo lo publicado antes ya se aplico.
struct Banco {
    estado: Arc<AppState>,
    bus: Arc<EventBus>,
    /// Metricas **del bus de este banco**: son las que cuentan la deduplicacion
    /// y el lag, porque las del estado solo miden su bus interno.
    metricas_del_bus: Arc<Metrics>,
    centinelas: u64,
}

impl Banco {
    fn nuevo(estado: Arc<AppState>, capacidad: usize) -> Self {
        let metricas = Arc::new(Metrics::default());
        let bus = Arc::new(EventBus::new(capacidad, metricas.clone()));
        let mut receptor = bus.subscribe();
        let aplicador = estado.clone();
        let contador = metricas.clone();
        tokio::spawn(async move {
            loop {
                match receptor.recv().await {
                    Ok(evento) => aplicador.on_event(&evento),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(saltados)) => {
                        contador
                            .subscription_lagged
                            .fetch_add(saltados, std::sync::atomic::Ordering::Relaxed);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Self {
            estado,
            bus,
            metricas_del_bus: metricas,
            centinelas: 0,
        }
    }

    fn publicar(&self, source_id: &str, kind: EventKind) -> bool {
        self.bus.publish(Some(source_id.to_string()), kind)
    }

    /// Publica un `FollowReceived` centinela y espera a que aparezca en la
    /// actividad del estado. Esperar al feed y no a un contador es a proposito:
    /// las metricas del estado solo cuentan lo que pasa por **su** bus, que no
    /// es este.
    async fn sincronizar(&mut self, contexto: &str) {
        self.centinelas += 1;
        let marca = format!("centinela-{}", self.centinelas);
        let centinela = UserRef {
            id: "900000".to_string(),
            unique_id: marca.clone(),
            nickname: marca.clone(),
            ..Default::default()
        };
        assert!(
            self.publicar(&marca, EventKind::FollowReceived { user: centinela }),
            "el centinela no deberia ser un duplicado"
        );

        let mut intentos = 0u32;
        loop {
            let visto = self.estado.snapshot().events.iter().any(|item| {
                item.user.as_ref().map(|user| user.nickname.as_str()) == Some(marca.as_str())
            });
            if visto {
                return;
            }
            intentos += 1;
            if intentos * SYNC_POLL >= SYNC_TIMEOUT {
                panic!("el consumidor no aplico {contexto} en {SYNC_TIMEOUT:?}");
            }
            tokio::time::sleep(SYNC_POLL).await;
        }
    }
}

// ---------------------------------------------------------------------------
// A1 · Conectar + N mensajes de chat: memoria, metricas y SQLite
// ---------------------------------------------------------------------------

#[test]
fn un_directo_con_n_mensajes_llega_al_chat_a_las_metricas_y_a_sqlite() {
    const N: usize = 50;

    let db = DbTemp::nueva("flujo-chat");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let carlos = usuario("1", "Carlos");

    // `on_event` no pasa por el bus: aqui se prueba la cadena estado -> SQLite.
    // El camino con bus y consumidor se cubre en los tests de deduplicacion y
    // de cierre de sesion, que si lo necesitan para significar algo.
    estado.on_event(&conectar(1));
    let mut enviados: Vec<(u64, String)> = Vec::with_capacity(N);
    for index in 0..N {
        let seq = 2 + index as u64;
        let content = format!("mensaje {index}");
        estado.on_event(&chat(seq, &carlos, &content));
        enviados.push((seq, content));
    }

    let snapshot = estado.snapshot();
    assert_eq!(snapshot.schema_version, SCHEMA_VERSION, "esquema migrado");
    // `on_event` no pasa por el bus, asi que el contador de chat del bus sigue a
    // cero: lo que se comprueba aqui es el buffer y la persistencia, no el
    // recuento del bus (eso lo cubren las pruebas que si conducen un `EventBus`).
    assert_eq!(
        snapshot.metrics.chat_messages, 0,
        "las metricas del bus no cuentan lo aplicado a mano"
    );
    assert_eq!(snapshot.chat.len(), N, "deben estar los {N} mensajes");
    assert!(
        snapshot.stream_id.is_some(),
        "mientras haya sesion, el stream_id no puede ser nulo"
    );
    assert!(snapshot.started_at_ms.is_some(), "la sesion tiene inicio");

    // Orden cronologico: el buffer devuelve de mas antiguo a mas nuevo.
    let seqs: Vec<u64> = snapshot.chat.iter().map(|entry| entry.seq).collect();
    let esperados: Vec<u64> = enviados.iter().map(|(seq, _)| *seq).collect();
    assert_eq!(seqs, esperados, "el chat conserva el orden de llegada");
    assert_eq!(
        snapshot.chat.first().map(|entry| entry.content.as_str()),
        Some(enviados[0].1.as_str())
    );
    assert_eq!(
        snapshot.chat.last().map(|entry| entry.content.as_str()),
        Some(enviados[N - 1].1.as_str())
    );
    assert_eq!(snapshot.chat[0].user.nickname, "Carlos");

    estado.shutdown(); // vuelca la cola del escritor antes de mirar el disco

    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.count("comments").expect("contando comments"),
        N as i64,
        "todos los comentarios deben estar persistidos"
    );
    assert_eq!(
        base.count("streams").expect("contando streams"),
        1,
        "una sola sesion abierta"
    );
    assert_eq!(
        base.query_i64("SELECT comment_count FROM streams", 0)
            .expect("contando el resumen de la sesion"),
        Some(N as i64),
        "el resumen de la sesion cuadra con los comentarios"
    );
    assert_eq!(
        base.query_i64("SELECT COUNT(*) FROM comments WHERE source_id IS NULL", 0)
            .expect("buscando comentarios sin origen"),
        Some(0),
        "todos los comentarios llevan su source_id"
    );

    db.finalizar();
}

// ---------------------------------------------------------------------------
// La capacidad del chat es la documentada
// ---------------------------------------------------------------------------

#[test]
fn el_chat_en_memoria_es_del_tamano_documentado() {
    assert_eq!(CHAT_CAPACITY, 200, "capacidad de chat documentada");
    assert_eq!(FEED_CAPACITY, 150, "capacidad de actividad documentada");
}

// ---------------------------------------------------------------------------
// A2 · Regalos: streak con `group_id`, diamantes y ranking
// ---------------------------------------------------------------------------

#[test]
fn un_streak_de_regalos_cuenta_unidades_y_aparece_entero_en_el_resumen() {
    let db = DbTemp::nueva("flujo-regalos");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let carlos = usuario("1", "Carlos");
    let lucas = usuario("2", "Lucas");

    estado.on_event(&conectar(1));

    // Streak real de rosa (1 diamante): cada evento trae **su incremento** (1, 1
    // y 1: asi lo envia TikTok, ver D14 en docs/decisions.md) y solo el ultimo
    // lleva `is_final`.
    let progreso = [(2u64, 1, false), (3, 1, false), (4, 1, true)];
    for (seq, cuantas, final_) in progreso {
        let evento = Event::new(
            seq,
            SALA.to_string(),
            Some(format!("gift-{seq}")),
            EventKind::GiftReceived {
                user: carlos.clone(),
                gift: regalo("5655", "Rose", 1, cuantas, true, final_, "g-1"),
            },
        );
        estado.on_event(&evento);
    }

    // Regalo no acumulable: llega suelto, con `group_id` "0".
    estado.on_event(&Event::new(
        5,
        SALA.to_string(),
        Some("gift-5".to_string()),
        EventKind::GiftReceived {
            user: lucas.clone(),
            gift: regalo("5601", "TikTok", 5, 1, false, true, "0"),
        },
    ));

    let snapshot = estado.snapshot();

    // Todos los eventos llegan al resumen y al feed, incluido el progreso: la
    // lista y la actividad son un registro, no un acumulador.
    // (`metrics.gifts` lo incrementa el bus, y aqui se aplica con `on_event`.)
    assert_eq!(
        snapshot.metrics.gifts, 0,
        "las metricas del bus no cuentan esto"
    );
    assert_eq!(snapshot.gifts.len(), 4, "ninguno se pierde en la lista");
    let finales: Vec<&dashboard::feed::GiftEventView> =
        snapshot.gifts.iter().filter(|view| view.is_final).collect();
    assert_eq!(
        finales.len(),
        2,
        "solo cierran la racha el ultimo y el suelto"
    );
    let del_grupo = snapshot
        .gifts
        .iter()
        .filter(|view| view.group_id == "g-1")
        .count();
    assert_eq!(del_grupo, 3, "la racha llega entera con su group_id");
    let en_feed = snapshot
        .events
        .iter()
        .filter(|item| item.kind == FeedKind::Gift)
        .count();
    assert_eq!(en_feed, 4, "cada regalo aparece en la actividad");

    // La contabilidad solo cuenta lo que **cierra** su aportacion, y la
    // aportacion de una racha es la **suma de sus incrementos** (tres eventos de
    // una rosa): 3 unidades, no 6. Antes se contaba solo el ultimo evento, que
    // con incrementos de 1 daba la mitad.
    assert_eq!(snapshot.total_gifts, 4, "3 rosas + 1 TikTok");
    let rosas = snapshot
        .gifts_by_type
        .iter()
        .find(|resumen| resumen.gift_name == "Rose")
        .expect("el resumen por tipo deberia incluir Rose");
    assert_eq!(
        rosas.count, 3,
        "la racha cierra en 3: son 3 unidades, no 1+2+3"
    );
    assert_eq!(rosas.diamonds, 3, "una rosa vale un diamante");
    let tiktok = snapshot
        .gifts_by_type
        .iter()
        .find(|resumen| resumen.gift_name == "TikTok")
        .expect("el resumen por tipo deberia incluir TikTok");
    assert_eq!(tiktok.count, 1, "el regalo no acumulable es una unidad");
    assert_eq!(tiktok.diamonds, 5, "y vale sus cinco diamantes");

    // Ranking: Lucas aporta 5 diamantes y Carlos 3, asi que Lucas manda.
    //
    // La tabla vive en `gift_ranking` y no en un `top_gifters` aparte: era el
    // mismo dato serializado dos veces, con dos formas distintas.
    assert_eq!(snapshot.gift_ranking.len(), 2);
    assert_eq!(
        snapshot.gift_ranking[0].user.nickname, "Lucas",
        "5 diamantes sueltos mandan sobre los 3 de la rosa final"
    );
    assert_eq!(snapshot.gift_ranking[0].value, 5);
    assert_eq!(snapshot.gift_ranking[0].events, 1, "una unidad");
    assert_eq!(snapshot.gift_ranking[1].user.nickname, "Carlos");
    assert_eq!(snapshot.gift_ranking[1].value, 3);
    assert_eq!(snapshot.gift_ranking[1].events, 3, "tres rosas");

    estado.shutdown();
    db.finalizar();
}

/// Una racha contabiliza **solo al cerrar**, y su aportacion es la suma de los
/// incrementos que ha ido trayendo cada evento.
///
/// La evidencia esta en una grabacion real
/// (`spikes/tiktok-rust-provider/live.jsonl`) y en la base de datos de una
/// sesion real: un regalo produce **dos** eventos con el mismo `group_id` y
/// **ambos con `repeat_count = 1`**. Es decir, `repeat_count` es lo que suma ese
/// mensaje a la racha, no el acumulado (docs/decisions.md D14). Contar solo el
/// evento final daba la mitad de los diamantes: en la sesion medida, 4 en vez de
/// 8. Este test exige la regla nueva y que el total en memoria y el persistido
/// usen el mismo criterio.
#[test]
fn los_diamantes_de_un_streak_no_se_suman_ronda_a_ronda() {
    let db = DbTemp::nueva("flujo-diamantes");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let carlos = usuario("1", "Carlos");
    let lucas = usuario("2", "Lucas");

    estado.on_event(&conectar(1));
    // Tres rosas, cada evento con su incremento (la forma real).
    for (seq, cuantas) in [(2u64, 1), (3, 1), (4, 1)] {
        let final_ = seq == 4;
        estado.on_event(&Event::new(
            seq,
            SALA.to_string(),
            Some(format!("gift-{seq}")),
            EventKind::GiftReceived {
                user: carlos.clone(),
                gift: regalo("5655", "Rose", 1, cuantas, true, final_, "g-1"),
            },
        ));
    }
    // Regalo suelto y no acumulable de 5 diamantes.
    estado.on_event(&Event::new(
        5,
        SALA.to_string(),
        Some("gift-5".to_string()),
        EventKind::GiftReceived {
            user: lucas.clone(),
            gift: regalo("5601", "TikTok", 5, 1, false, true, "0"),
        },
    ));

    let snapshot = estado.snapshot();
    // Carlos mando 3 rosas (un incremento por evento) y Lucas 1 TikTok de 5.
    assert_eq!(
        snapshot.total_diamonds, 8,
        "diamantes de la sesion: 3 rosas + 5 diamantes, no 1+1+1+5"
    );
    // El ranking tiene que mirar los diamantes, no los eventos.
    assert_eq!(
        snapshot.gift_ranking[0].user.nickname,
        "Lucas",
        "5 diamantes sueltos mandan sobre los 3 de la rosa final: {:?}",
        snapshot
            .gift_ranking
            .iter()
            .map(|gifter| (gifter.user.nickname.as_str(), gifter.value))
            .collect::<Vec<_>>()
    );

    estado.shutdown();
    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.query_i64("SELECT diamond_total FROM streams", 0)
            .expect("leyendo el total de diamantes"),
        Some(8),
        "el resumen persistido debe usar la misma regla que la memoria"
    );
    assert_eq!(
        base.count("gift_events").expect("contando regalos"),
        4,
        "los cuatro eventos de regalo se guardan igualmente"
    );

    db.finalizar();
}

/// Una racha suma **todos** sus incrementos, no solo el ultimo evento.
///
/// Es el caso que estaba mal medido: en la base de datos de una sesion real,
/// cuatro rachas de dos rosas produjeron 8 eventos con `repeat_count = 1` cada
/// uno y el motor guardo 4 diamantes en vez de 8 (docs/decisions.md D14). Aqui se
/// comprueba tambien el caso agrupado: un unico evento con `repeat_count = 2`
/// vale dos unidades.
#[test]
fn una_racha_suma_todos_sus_incrementos_y_el_persistido_coincide() {
    let db = DbTemp::nueva("flujo-incrementos");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let ana = usuario("3", "Ana");

    estado.on_event(&conectar(1));
    // Racha de dos rosas: dos eventos de un incremento cada uno.
    for (seq, final_) in [(2u64, false), (3, true)] {
        estado.on_event(&Event::new(
            seq,
            SALA.to_string(),
            Some(format!("gift-{seq}")),
            EventKind::GiftReceived {
                user: ana.clone(),
                gift: regalo("5655", "Rose", 1, 1, true, final_, "g-1"),
            },
        ));
    }
    // Y una racha cuyo incremento llega agrupado en un solo evento.
    estado.on_event(&Event::new(
        4,
        SALA.to_string(),
        Some("gift-4".to_string()),
        EventKind::GiftReceived {
            user: ana.clone(),
            gift: regalo("5655", "Rose", 1, 2, true, true, "g-2"),
        },
    ));

    let snapshot = estado.snapshot();
    assert_eq!(
        snapshot.total_diamonds, 4,
        "2 rosas incrementales + 2 agrupadas = 4 diamantes, no 1 + 2"
    );
    assert_eq!(snapshot.total_gifts, 4, "cuatro unidades, no tres eventos");

    // Y lo persistido tiene que decir lo mismo.
    estado.shutdown();
    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.query_i64("SELECT diamond_total FROM streams", 0)
            .expect("leyendo el total de diamantes"),
        Some(4),
        "el resumen persistido debe usar la misma regla que la memoria"
    );

    db.finalizar();
}

/// Un regalo no acumulable puede llegar sin `repeat_count` (0) y sigue valiendo
/// **una** unidad con todos sus diamantes.
///
/// `GiftInfo::units` trata el 0 como 1 unidad y `commits` da por cerrado
/// cualquier regalo no acumulable, asi que el total y el resumen por tipo tienen
/// que coincidir: si el resumen contara una unidad y los diamantes fueran 0, el
/// mismo evento valdria dos cosas distintas segun donde se mire.
#[test]
fn un_regalo_no_acumulable_sin_repeat_count_conserva_sus_diamantes() {
    let db = DbTemp::nueva("flujo-sin-repeat");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let ana = usuario("3", "Ana");

    estado.on_event(&conectar(1));
    estado.on_event(&Event::new(
        2,
        SALA.to_string(),
        Some("gift-2".to_string()),
        EventKind::GiftReceived {
            user: ana.clone(),
            gift: regalo("5601", "TikTok", 5, 0, false, true, "0"),
        },
    ));

    let snapshot = estado.snapshot();
    let unidades = snapshot
        .gifts_by_type
        .iter()
        .find(|resumen| resumen.gift_name == "TikTok")
        .map(|resumen| resumen.count)
        .unwrap_or(0);
    assert_eq!(unidades, 1, "el resumen por tipo lo cuenta como un regalo");
    assert_eq!(
        snapshot.total_diamonds, 5,
        "y el total debe valer lo mismo que el evento: 5 diamantes"
    );

    // El cierre va **antes** de borrar: el escritor mantiene abierto el fichero
    // hasta que termina su hilo.
    estado.shutdown();
    db.finalizar();
}

// ---------------------------------------------------------------------------
// A3 · Follows y likes en la actividad
// ---------------------------------------------------------------------------

#[test]
fn solo_los_likes_notables_y_los_follows_aparecen_en_la_actividad() {
    let db = DbTemp::nueva("flujo-actividad");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let ana = usuario("2", "Ana");
    let luis = usuario("3", "Luis");

    estado.on_event(&conectar(1));
    estado.on_event(&Event::new(
        2,
        SALA.to_string(),
        Some("follow-2".to_string()),
        EventKind::FollowReceived { user: ana.clone() },
    ));

    // El umbral se importa del propio modulo: si cambia la politica, el test
    // cambia con ella en lugar de quedarse obsoleto en silencio.
    let pequeno = 3;
    let grande = 250;
    assert!(
        !like_is_notable(pequeno),
        "el incremento debe estar bajo el umbral"
    );
    assert!(
        like_is_notable(grande),
        "el incremento debe superar el umbral"
    );

    estado.on_event(&Event::new(
        3,
        SALA.to_string(),
        Some("like-3".to_string()),
        EventKind::LikeUpdated {
            user: Some(luis.clone()),
            count: pequeno,
            total: 1_000,
        },
    ));
    estado.on_event(&Event::new(
        4,
        SALA.to_string(),
        Some("like-4".to_string()),
        EventKind::LikeUpdated {
            user: Some(luis.clone()),
            count: grande,
            total: 1_250,
        },
    ));

    let snapshot = estado.snapshot();
    // Se aplica con `on_event`, asi que los contadores del bus siguen a cero;
    // lo que se comprueba aqui es que solo el like grande llega a la actividad.
    assert_eq!(snapshot.metrics.follows, 0);
    assert_eq!(
        snapshot.metrics.like_events, 0,
        "las metricas del bus no cuentan esto"
    );
    assert_eq!(snapshot.metrics.likes_total, 0);
    assert_eq!(
        snapshot
            .events
            .iter()
            .filter(|item| item.kind == FeedKind::Follow)
            .count(),
        1,
        "el follow aparece en la actividad"
    );
    assert_eq!(
        snapshot
            .events
            .iter()
            .filter(|item| item.kind == FeedKind::Like)
            .count(),
        1,
        "solo el like grande aparece en la actividad"
    );
    let like = snapshot
        .events
        .iter()
        .find(|item| item.kind == FeedKind::Like)
        .expect("el like grande deberia estar en el feed");
    assert_eq!(like.likes, Some((grande, 1_250)));
    assert_eq!(
        like.user.as_ref().map(|user| user.nickname.as_str()),
        Some("Luis")
    );

    estado.shutdown();
    db.finalizar();
}

// ---------------------------------------------------------------------------
// A4 · Deduplicacion por `source_id` a traves del bus real
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn el_bus_descarta_el_mismo_source_id_antes_de_llegar_al_estado() {
    let db = DbTemp::nueva("flujo-duplicado");
    let estado =
        Arc::new(AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal"));
    // La sala la fija el bus, como hace el provider al conectar.
    let mut banco = Banco::nuevo(estado.clone(), 64);
    banco.bus.set_room(SALA);
    let carlos = usuario("1", "Carlos");

    // El chat llega **por el bus**: hay que abrir sesion antes, o el motor no
    // tiene stream_id al que colgar el comentario.
    assert!(
        banco.publicar(
            "sys-1",
            EventKind::StreamConnected {
                room_id: SALA.to_string(),
                title: "directo de prueba".to_string(),
                perfil: Default::default(),
            }
        ),
        "la conexion es un evento nuevo"
    );

    // Mismo `source_id` dos veces: TikTok repite mensajes tras reconectar.
    assert!(
        banco.publicar(
            "msg-repetido",
            EventKind::ChatMessage {
                user: carlos.clone(),
                content: "hola".to_string(),
                emote_count: 0,
            }
        ),
        "la primera publicacion es nueva"
    );
    assert!(
        !banco.publicar(
            "msg-repetido",
            EventKind::ChatMessage {
                user: carlos.clone(),
                content: "hola".to_string(),
                emote_count: 0,
            }
        ),
        "el duplicado debe descartarse en el bus"
    );

    banco
        .sincronizar("la conexion, el chat y su duplicado")
        .await;

    let snapshot = estado.snapshot();
    assert_eq!(
        banco.metricas_del_bus.snapshot().duplicates_dropped,
        1,
        "el descarte por duplicado se contabiliza"
    );
    assert_eq!(
        snapshot.chat.len(),
        1,
        "el chat no puede duplicar el mensaje: {:?}",
        snapshot
            .chat
            .iter()
            .map(|entry| entry.content.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(snapshot.chat[0].content, "hola");
    assert_eq!(
        snapshot.chat[0].source_id.as_deref(),
        Some("msg-repetido"),
        "el mensaje conserva su identificador de origen"
    );

    estado.shutdown();

    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.count("comments").expect("contando comments"),
        1,
        "tampoco puede duplicarse en la base"
    );
    drop(base);
    db.finalizar();
}

// ---------------------------------------------------------------------------
// A5 · La desconexion cierra la sesion
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn la_desconexion_cierra_la_sesion_en_la_base_de_datos() {
    let db = DbTemp::nueva("flujo-cierre");
    let estado =
        Arc::new(AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal"));
    let mut banco = Banco::nuevo(estado.clone(), 64);
    banco.bus.set_room(SALA);
    let carlos = usuario("1", "Carlos");

    assert!(
        banco.publicar(
            "sys-1",
            EventKind::StreamConnected {
                room_id: SALA.to_string(),
                title: "directo de prueba".to_string(),
                perfil: Default::default(),
            }
        ),
        "la conexion es un evento nuevo"
    );
    // Este mensaje debe persistirse: llega despues de conectar.
    assert!(
        banco.publicar(
            "msg-2",
            EventKind::ChatMessage {
                user: carlos.clone(),
                content: "esto se persiste".to_string(),
                emote_count: 0,
            }
        ),
        "el mensaje es un evento nuevo"
    );
    banco.sincronizar("la conexion y el chat").await;

    let snapshot = estado.snapshot();
    let stream_id = snapshot
        .stream_id
        .clone()
        .expect("la sesion deberia estar abierta tras conectar");
    assert!(
        stream_id.starts_with(SALA),
        "el stream_id lo construye el motor a partir de la sala: {stream_id}"
    );

    assert!(
        // El bus asigna `seq`, la sala y el `source_id`: aqui solo importa el
        // `kind` de la desconexion.
        banco.publicar("sys-4", desconectar(4).kind),
        "la desconexion es un evento nuevo"
    );
    banco.sincronizar("el cierre de sesion").await;

    let snapshot = estado.snapshot();
    assert!(
        snapshot.stream_id.is_none(),
        "al desconectar, el motor suelta la sesion"
    );
    assert!(
        snapshot.started_at_ms.is_none(),
        "y deja de contar duracion"
    );

    estado.shutdown();

    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(base.count("streams").expect("contando sesiones"), 1);
    assert_eq!(
        base.query_i64("SELECT COUNT(*) FROM streams WHERE ended_at IS NULL", 0)
            .expect("buscando sesiones abiertas"),
        Some(0),
        "la sesion no puede quedar abierta"
    );
    assert_eq!(
        base.query_i64("SELECT COUNT(*) FROM streams WHERE ended_at IS NOT NULL", 0)
            .expect("buscando sesiones cerradas"),
        Some(1)
    );
    assert_eq!(
        base.query_i64("SELECT crashed FROM streams", 0)
            .expect("leyendo el motivo de cierre"),
        Some(0),
        "un cierre ordenado no es una interrupcion"
    );
    assert!(
        base.query_i64("SELECT ended_at FROM streams", 0)
            .expect("leyendo ended_at")
            .is_some_and(|ended_at| ended_at > 0),
        "ended_at debe llevar marca de tiempo"
    );
    assert_eq!(
        base.count("comments").expect("contando comments"),
        1,
        "el comentario del directo se persistio"
    );

    drop(base);
    db.finalizar();
}

// ---------------------------------------------------------------------------
// A6 · El pico de espectadores y el total de likes llegan a la sesion
// ---------------------------------------------------------------------------

/// `streams.peak_viewers` y `streams.like_total` existian desde la v1 y nadie
/// los escribia: el pico de la sesion y los likes se perdian.
///
/// Las cifras se agrupan en una ventana (como los viewers en el proveedor) y lo
/// que queda pendiente se vuelca al cerrar la sesion, asi que despues de
/// desconectar tienen que estar todas: el pico es el **mayor** visto, no el
/// ultimo.
#[test]
fn el_pico_de_espectadores_y_los_likes_se_guardan_al_cerrar_la_sesion() {
    let db = DbTemp::nueva("flujo-progreso");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");

    estado.on_event(&conectar(1));
    // Los espectadores suben y bajan: interesa el pico.
    for (seq, current) in [(2u64, 120i64), (3, 340), (4, 250)] {
        estado.on_event(&Event::new(
            seq,
            SALA.to_string(),
            None,
            EventKind::ViewerUpdated {
                current,
                cumulative: 900 + current,
            },
        ));
    }
    // Los likes traen el total absoluto del directo.
    for (seq, total) in [(5u64, 1_000i64), (6, 2_500)] {
        estado.on_event(&Event::new(
            seq,
            SALA.to_string(),
            None,
            EventKind::LikeUpdated {
                user: None,
                count: 5,
                total,
            },
        ));
    }
    estado.on_event(&desconectar(7));

    estado.shutdown();
    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.query_i64("SELECT peak_viewers FROM streams", 0)
            .expect("leyendo el pico"),
        Some(340),
        "el pico es el mayor numero de espectadores, no el ultimo"
    );
    assert_eq!(
        base.query_i64("SELECT like_total FROM streams", 0)
            .expect("leyendo los likes"),
        Some(2_500),
        "los likes de la sesion son el ultimo total absoluto"
    );

    drop(base);
    db.finalizar();
}

// ---------------------------------------------------------------------------
// A7 · La sesion guarda el handle real
// ---------------------------------------------------------------------------

/// El arranque automatico conectaba el proveedor sin pasar por el motor, asi que
/// la fila de `streams` quedaba con `handle = ''` aunque el proveedor se hubiera
/// conectado a un usuario concreto. `AppState::connect` es ahora el unico sitio
/// que abre sesion y el que guarda el handle.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn la_sesion_guarda_el_handle_con_el_que_se_conecta() {
    let db = DbTemp::nueva("flujo-handle");
    let estado =
        Arc::new(AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal"));
    let _consumer = tokio::spawn(estado.consumer_future());
    // Se usa el simulador para no tocar la red; el camino que se prueba
    // (motor -> handle -> base) es el mismo que el del proveedor real.
    // Con `@` delante a proposito: el motor lo normaliza.
    estado
        .start_simulation("@carlos")
        .await
        .expect("arranca la simulacion");

    let mut abierta = false;
    for _ in 0..250 {
        abierta = estado.snapshot().stream_id.is_some();
        if abierta {
            break;
        }
        tokio::time::sleep(SYNC_POLL).await;
    }
    assert!(abierta, "la sesion deberia abrirse al conectar");
    estado.current_provider().disconnect().await;
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    estado.shutdown();

    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.query_string("SELECT handle FROM streams", 0)
            .expect("leyendo el handle"),
        Some("carlos".to_string()),
        "la sesion debe guardar a que usuario se conecto, sin arroba"
    );

    drop(base);
    db.finalizar();
}

// ---------------------------------------------------------------------------
// A8 · Las rachas abiertas se liquidan al cerrar la sesion
// ---------------------------------------------------------------------------

/// Una racha que no recibe `repeat_end` (35 de 176 en el historico medido) se
/// quedaba abierta al terminar el directo y sus diamantes se perdian: ni en el
/// resumen de la sesion ni en la base.
#[test]
fn las_rachas_abiertas_se_liquidan_al_cerrar_la_sesion() {
    let db = DbTemp::nueva("flujo-liquidacion");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let carlos = usuario("1", "Carlos");

    estado.on_event(&conectar(1));
    // Dos rosas de la misma racha, ninguna con `is_final`: el directo termina
    // antes de que TikTok mande el cierre.
    for (seq, final_) in [(2u64, false), (3, false)] {
        estado.on_event(&Event::new(
            seq,
            SALA.to_string(),
            Some(format!("gift-{seq}")),
            EventKind::GiftReceived {
                user: carlos.clone(),
                gift: regalo("5655", "Rose", 1, 1, true, final_, "g-1"),
            },
        ));
    }
    assert_eq!(
        estado.snapshot().total_diamonds,
        0,
        "mientras la racha sigue abierta no se contabiliza nada"
    );

    estado.on_event(&desconectar(4));

    let snapshot = estado.snapshot();
    assert_eq!(
        snapshot.total_diamonds, 2,
        "al cerrar la sesion, la racha abierta se liquida"
    );
    assert_eq!(snapshot.total_gifts, 2, "dos rosas, no dos eventos");

    estado.shutdown();
    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.query_i64("SELECT diamond_total FROM streams", 0)
            .expect("leyendo los diamantes"),
        Some(2),
        "los diamantes de la racha abandonada deben persistirse"
    );
    assert_eq!(
        base.query_i64("SELECT gift_count FROM streams", 0)
            .expect("leyendo las unidades"),
        Some(2)
    );
    assert_eq!(
        base.count("gift_events").expect("contando regalos"),
        2,
        "no se inventa una fila de ajuste: se marcan las filas reales"
    );
    assert_eq!(
        base.query_i64(
            "SELECT is_final FROM gift_events WHERE group_id = 'g-1' ORDER BY id DESC LIMIT 1",
            0
        )
        .expect("leyendo el cierre"),
        Some(1),
        "la ultima fila de la racha queda como la que la cierra"
    );

    drop(base);
    db.finalizar();
}

/// Una racha abandonada a mitad de sesion tiene que llegar a la base.
///
/// `GiftBoard` la contabiliza cuando el mismo usuario empieza otra racha, pero
/// hasta ahora ese numero se quedaba **solo en memoria**: el total que veia el
/// streamer y el de `streams` divergian (el mismo tipo de fallo que D14). Ahora
/// la liquidacion se devuelve y se persiste con la orden del cierre de sesion.
#[test]
fn la_racha_abandonada_llega_a_la_base_al_empezar_otra() {
    let db = DbTemp::nueva("flujo-abandonada");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let carlos = usuario("1", "Carlos");

    estado.on_event(&conectar(1));
    // Racha g1: no cierra nunca.
    estado.on_event(&Event::new(
        2,
        SALA.to_string(),
        Some("gift-2".to_string()),
        EventKind::GiftReceived {
            user: carlos.clone(),
            gift: regalo("5655", "Rose", 1, 1, true, false, "g-1"),
        },
    ));
    // Y el mismo usuario empieza otra (g2) que si cierra.
    estado.on_event(&Event::new(
        3,
        SALA.to_string(),
        Some("gift-3".to_string()),
        EventKind::GiftReceived {
            user: carlos.clone(),
            gift: regalo("5655", "Rose", 1, 1, true, true, "g-2"),
        },
    ));

    // Lo que ve la interfaz.
    let snapshot = estado.snapshot();
    assert_eq!(
        snapshot.total_diamonds, 2,
        "1 de la racha abandonada + 1 de la que cierra"
    );

    estado.shutdown();
    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.query_i64("SELECT diamond_total FROM streams", 0)
            .expect("leyendo los diamantes"),
        Some(2),
        "y lo persistido tiene que decir lo mismo que la memoria"
    );
    assert_eq!(
        base.query_i64("SELECT gift_count FROM streams", 0)
            .expect("leyendo las unidades"),
        Some(2)
    );
    assert_eq!(
        base.query_i64(
            "SELECT COUNT(*) FROM gift_events WHERE group_id = 'g-1' AND is_final = 1",
            0
        )
        .expect("leyendo el cierre de la abandonada"),
        Some(1),
        "la racha abandonada queda cerrada en el historico"
    );
    assert_eq!(
        base.count("gift_events").expect("contando regalos"),
        2,
        "sin filas de ajuste: se marcan las filas reales"
    );

    drop(base);
    db.finalizar();
}

/// Un comentario borrado en TikTok deja **tombstone** en la base.
///
/// No se borra la fila: se marca cuando dejo de estar visible, para no perder ni
/// el texto ni el rastro (docs/plan-review.md). El evento se llama
/// `target_source_id` para no chocar con el `source_id` del sobre al serializar
/// el enum aplanado.
#[test]
fn el_borrado_de_un_comentario_deja_tombstone_en_la_base() {
    let db = DbTemp::nueva("flujo-borrado");
    let estado = AppState::open(db.path(), 0).expect("el estado deberia abrir la base temporal");
    let carlos = usuario("1", "Carlos");

    estado.on_event(&conectar(1));
    estado.on_event(&Event::new(
        2,
        SALA.to_string(),
        Some("m1".to_string()),
        EventKind::ChatMessage {
            user: carlos.clone(),
            content: "se va a borrar".into(),
            emote_count: 0,
        },
    ));
    estado.on_event(&Event::new(
        3,
        SALA.to_string(),
        None,
        EventKind::ChatMessageDeleted {
            target_source_id: "m1".into(),
        },
    ));

    estado.shutdown();
    let base = Database::open(&db.path()).expect("la base temporal deberia reabrirse");
    assert_eq!(
        base.count("comments").expect("contando comentarios"),
        1,
        "el texto se conserva: el borrado es una marca, no un DELETE"
    );
    assert_eq!(
        base.query_i64(
            "SELECT COUNT(*) FROM comments WHERE source_id = 'm1' AND deleted_at IS NOT NULL",
            0
        )
        .expect("leyendo la marca"),
        Some(1),
        "y queda marcado cuando se borro"
    );

    drop(base);
    db.finalizar();
}
