//! Spike: provider TikTok LIVE nativo en Rust, sin Python.
//!
//! Valida las 4 etapas de docs/decisions.md D5:
//!   1. resolver `room_id` de un @usuario
//!   2. obtener el payload firmado del servidor de firma (anonimo, sin API key)
//!   3. conectar por WebSocket
//!   4. decodificar protobuf (comentarios y regalos con streak correcto)
//!
//! Uso:
//!   spike islive <handle>
//!   spike watch  <handle> [--seconds N] [--record FILE] [--no-connect]
//!   spike replay <FILE>
//!
//! `replay` decodifica frames grabados sin tocar la red: la cuota anonima del
//! servidor de firma es de 5/min, 30/h, 100/dia (ver PROTOCOL-SPEC.md), asi que
//! iterar contra una grabacion es obligatorio, no un lujo.

mod proto;

use std::io::Write;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use proto::*;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const SIGN_BASE: &str = "https://api.eulerstream.com";
const CLIENT_NAME: &str = "ttlive-python";
const TIKTOK_WEB: &str = "https://www.tiktok.com";
const IDC_COOKIE: &str = "tt-target-idc=useast1a";

/// WebcastPushFrame{payload_type: "hb"} — frame minimo de heartbeat, 4 bytes.
const HEARTBEAT_FRAME: [u8; 4] = [0x3a, 0x02, 0x68, 0x62];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/// Percent-encoding estricto (equivalente a `urllib.parse.quote(s, safe='')`).
///
/// Se implementa a mano para que los valores de `route_params` que devuelve el
/// servidor de firma (que incluyen el User-Agent crudo, con espacios y
/// parentesis) no rompan el request-target del WebSocket con un 400.
fn pct(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn query(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// device_id de 19 digitos (TikTok lo exige con ese formato).
fn device_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut id = String::with_capacity(19);
    id.push(char::from_digit(rng.gen_range(1..=9), 10).unwrap());
    for _ in 0..18 {
        id.push(char::from_digit(rng.gen_range(0..=9), 10).unwrap());
    }
    id
}

fn browser_version() -> String {
    pct(UA.split_once('/').map(|(_, rest)| rest).unwrap_or(UA))
}

/// Parametros base de la API web (device_platform=web_pc).
fn web_params(handle: &str) -> Vec<(String, String)> {
    let owned = |k: &str, v: &str| (k.to_string(), v.to_string());
    vec![
        owned("aid", "1988"),
        owned("app_language", "en"),
        owned("app_name", "tiktok_web"),
        owned("browser_language", "en-US"),
        owned("browser_name", "Mozilla"),
        owned("browser_online", "true"),
        owned("browser_platform", "Win32"),
        owned("browser_version", &browser_version()),
        owned("channel", "tiktok_web"),
        owned("cookie_enabled", "true"),
        owned("data_collection_enabled", "true"),
        owned("device_platform", "web_pc"),
        owned("device_id", &device_id()),
        owned("focus_state", "true"),
        owned("from_page", ""),
        owned("history_len", "8"),
        owned("is_fullscreen", "false"),
        owned("is_page_visible", "true"),
        owned("os", "windows"),
        owned("priority_region", "CA"),
        owned("region", "CA"),
        owned("root_referer", &format!("{TIKTOK_WEB}/@{handle}")),
        owned("screen_height", "1080"),
        owned("screen_width", "1920"),
        owned("tz_name", "America/Toronto"),
        owned("user_is_login", "false"),
        owned("webcast_language", "en"),
        owned("msToken", ""),
    ]
}

/// Parametros base del WebSocket. Los valores ya van pre-codificados: NO se
/// vuelven a codificar (evita el doble encoding de `browser_version`).
fn ws_params() -> Vec<(String, String)> {
    let owned = |k: &str, v: &str| (k.to_string(), v.to_string());
    vec![
        owned("aid", "1988"),
        owned("app_language", "en"),
        owned("app_name", "tiktok_web"),
        owned("browser_platform", "Win32"),
        owned("browser_language", "en-US"),
        owned("browser_name", "Mozilla"),
        owned("browser_version", &browser_version()),
        owned("browser_online", "true"),
        owned("cookie_enabled", "true"),
        owned("tz_name", "America/Toronto"),
        owned("device_platform", "web"),
        owned("identity", "audience"),
        owned("live_id", "12"),
        owned("sup_ws_ds_opt", "1"),
        owned("update_version_code", "2.0.0"),
        owned("version_code", "180800"),
        owned("client_enter", "1"),
        owned("ws_direct", "1"),
        owned("did_rule", "3"),
        owned("webcast_language", "en"),
        owned("screen_height", "1080"),
        owned("screen_width", "1920"),
        owned("heartbeat_duration", "10000"),
        owned("resp_content_type", "protobuf"),
        owned("history_comment_count", "6"),
        owned("last_rtt", "137"),
    ]
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(30))
        .build()
        .context("construyendo cliente HTTP")
}

// ---------------------------------------------------------------------------
// Etapa 1: room_id
// ---------------------------------------------------------------------------

struct RoomInfo {
    room_id: String,
    live: bool,
    title: String,
    /// `liveRoomStats.userCount` segun TikTok, para contrastar con los campos
    /// `total` / `total_user` de WebcastRoomUserSeqMessage.
    user_count: Option<i64>,
    enter_count: Option<i64>,
}

async fn resolve_room(http: &reqwest::Client, handle: &str) -> Result<RoomInfo> {
    let mut params = web_params(handle);
    params.push(("sourceType".into(), "54".into()));
    params.push(("uniqueId".into(), handle.to_string()));
    let url = format!("{TIKTOK_WEB}/api-live/user/room/?{}", query(&params));

    let response = http
        .get(&url)
        .header("Accept", "application/json")
        .header("Referer", TIKTOK_WEB)
        .header("Origin", TIKTOK_WEB)
        .send()
        .await
        .context("GET api-live/user/room")?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("api-live/user/room devolvio HTTP {status}: {}", &body[..body.len().min(300)]);
    }

    let json: Value = serde_json::from_str(&body)
        .with_context(|| format!("JSON inesperado: {}", &body[..body.len().min(200)]))?;

    let message = json.get("message").and_then(Value::as_str).unwrap_or("");
    if !message.is_empty() {
        bail!("TikTok respondio: {message}");
    }

    // Trampa verificada: `roomId` sigue poblado aunque el usuario este offline.
    // La unica senal fiable es `liveRoom.status == 4`.
    let room_id = json
        .pointer("/data/user/roomId")
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("sin roomId en la respuesta"))?;

    let live_status = json.pointer("/data/liveRoom/status").and_then(Value::as_i64);
    let title = json
        .pointer("/data/liveRoom/title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Ok(RoomInfo {
        room_id,
        live: live_status != Some(4),
        title,
        user_count: json.pointer("/data/liveRoom/liveRoomStats/userCount").and_then(Value::as_i64),
        enter_count: json.pointer("/data/liveRoom/liveRoomStats/enterCount").and_then(Value::as_i64),
    })
}

// ---------------------------------------------------------------------------
// Etapa 2: payload firmado
// ---------------------------------------------------------------------------

struct SignedFetch {
    envelope: ProtoMessageFetchResult,
    /// `X-Set-TT-Cookie`: obligatorio, se reenvia al WebSocket.
    cookies: String,
}

async fn fetch_signed(http: &reqwest::Client, room_id: &str) -> Result<SignedFetch> {
    let params = [
        ("client".to_string(), CLIENT_NAME.to_string()),
        ("room_id".to_string(), room_id.to_string()),
        ("user_agent".to_string(), UA.to_string()),
        ("platform".to_string(), "web".to_string()),
        ("client_enter".to_string(), "true".to_string()),
    ];
    let url = format!("{SIGN_BASE}/webcast/fetch?{}", query(&params));

    let response = http
        .get(&url)
        .header("Accept", "application/json, application/protobuf")
        .header("Referer", TIKTOK_WEB)
        .header("Origin", TIKTOK_WEB)
        .send()
        .await
        .context("GET webcast/fetch")?;

    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.context("leyendo cuerpo del sign server")?;

    if status.as_u16() == 429 {
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let message = json.get("message").and_then(Value::as_str).unwrap_or("(sin mensaje)");
        let label = json.get("limit_label").and_then(Value::as_str).unwrap_or("");
        // D2: nunca reintentar en bucle. La cuota anonima es 5/min, 30/h, 100/dia.
        bail!("LIMITE DEL SERVIDOR DE FIRMA {label}: {message}");
    }
    if !status.is_success() {
        bail!(
            "sign server HTTP {status}: {}",
            String::from_utf8_lossy(&bytes[..bytes.len().min(300)])
        );
    }
    if bytes.is_empty() {
        bail!("el sign server devolvio un cuerpo vacio (posible deteccion de TikTok)");
    }

    let cookies = headers
        .get("x-set-tt-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let envelope = ProtoMessageFetchResult::decode(&bytes[..])
        .context("decodificando ProtoMessageFetchResult del sign server")?;

    Ok(SignedFetch { envelope, cookies })
}

// ---------------------------------------------------------------------------
// Etapa 3: URL del WebSocket
// ---------------------------------------------------------------------------

fn build_ws_url(envelope: &ProtoMessageFetchResult, room_id: &str) -> Result<String> {
    if envelope.push_server.is_empty() {
        bail!("sin push_server en la respuesta inicial");
    }
    if envelope.cursor.is_empty() {
        bail!("sin cursor en la respuesta inicial");
    }

    let mut route: Vec<(String, String)> = envelope
        .route_params
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.clone(), pct(v)))
        .collect();
    route.sort();

    let mut params = route;
    params.extend(ws_params());
    params.push(("room_id".into(), room_id.to_string()));
    params.push(("compress".into(), "gzip".into()));

    // TikTok espera un `version_code` duplicado al final, tal cual.
    Ok(format!(
        "{}?{}&version_code=270000",
        envelope.push_server,
        query(&params)
    ))
}

// ---------------------------------------------------------------------------
// Etapa 4: decodificacion
// ---------------------------------------------------------------------------

fn gunzip(payload: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = flate2::read::GzDecoder::new(payload);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).context("gunzip del payload")?;
    Ok(out)
}

fn hex_prefix(bytes: &[u8], max: usize) -> String {
    bytes
        .iter()
        .take(max)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Decodifica un frame crudo del WebSocket y lo imprime.
/// Devuelve el ACK a enviar, si el frame lo requiere.
fn handle_raw_frame(raw: &[u8], label: &str) -> Result<Option<Vec<u8>>> {
    let frame = WebcastPushFrame::decode(raw).context("decodificando WebcastPushFrame")?;

    if frame.payload_type != "msg" {
        tracing::debug!(payload_type = %frame.payload_type, "frame ignorado");
        return Ok(None);
    }

    let payload = match frame.compress_type() {
        Some("gzip") => gunzip(&frame.payload)?,
        Some("none") | None => frame.payload.clone(),
        Some(other) => {
            tracing::warn!(compress_type = other, "compresion desconocida");
            frame.payload.clone()
        }
    };

    let envelope = ProtoMessageFetchResult::decode(&payload[..])
        .context("decodificando ProtoMessageFetchResult")?;

    let ack = if envelope.need_ack && frame.log_id != 0 {
        let ack = WebcastPushFrame {
            seq_id: frame.seq_id,
            log_id: frame.log_id,
            service: 0,
            method: 0,
            headers: Vec::new(),
            payload_encoding: String::new(),
            payload_type: "ack".into(),
            payload: envelope.internal_ext.clone(),
        };
        Some(ack.encode_to_vec())
    } else {
        None
    };

    if envelope.is_first || !envelope.cursor.is_empty() {
        tracing::debug!(cursor = %envelope.cursor, msgs = envelope.messages.len(), "envelope");
    }

    for message in &envelope.messages {
        print_message(&message.method, &message.payload, label);
    }

    Ok(ack)
}

fn user_label(user: &Option<User>) -> String {
    match user {
        Some(u) if !u.display_id.is_empty() => {
            format!("{} (@{})", u.nickname, u.display_id)
        }
        Some(u) => format!("id={}", u.id),
        None => "desconocido".into(),
    }
}

fn print_message(method: &str, payload: &[u8], label: &str) {
    match method {
        "WebcastChatMessage" => match WebcastChatMessage::decode(payload) {
            Ok(m) => println!(
                "[{label}] CHAT  {}: {}",
                user_label(&m.user),
                m.content
            ),
            Err(e) => tracing::warn!(%e, "chat no decodificable"),
        },
        "WebcastGiftMessage" => match WebcastGiftMessage::decode(payload) {
            Ok(m) => {
                let gift = m.gift.as_ref();
                let name = gift.map(|g| g.name.clone()).unwrap_or_default();
                let diamonds = gift.map(|g| g.diamond_count).unwrap_or(0);
                let streakable = gift.map(Gift::streakable).unwrap_or(false);
                let is_final = m.repeat_end != 0;
                println!(
                    "[{label}] GIFT  {} -> \"{name}\" x{} (combo={}, diamantes={}, streakable={}, final={}, grupo={})",
                    user_label(&m.user),
                    m.repeat_count,
                    m.combo_count,
                    diamonds,
                    streakable,
                    is_final,
                    m.group_id
                );
            }
            Err(e) => tracing::warn!(%e, "regalo no decodificable"),
        },
        "WebcastLikeMessage" => match WebcastLikeMessage::decode(payload) {
            Ok(m) => println!(
                "[{label}] LIKE  {} +{} (total {})",
                user_label(&m.user),
                m.count,
                m.total
            ),
            Err(e) => tracing::warn!(%e, "like no decodificable"),
        },
        "WebcastRoomUserSeqMessage" => match WebcastRoomUserSeqMessage::decode(payload) {
            Ok(m) => println!("[{label}] VIEW  espectadores={} (total={})", m.total_user, m.total),
            Err(e) => tracing::warn!(%e, "viewers no decodificable"),
        },
        "WebcastSocialMessage" => match WebcastSocialMessage::decode(payload) {
            Ok(m) => println!(
                "[{label}] SOCIAL {} action={} share_type={} follows={}",
                user_label(&m.user),
                m.action,
                m.share_type,
                m.follow_count
            ),
            Err(e) => tracing::warn!(%e, "social no decodificable"),
        },
        other => tracing::debug!(method = other, "mensaje no modelado"),
    }
}

// ---------------------------------------------------------------------------
// Modos
// ---------------------------------------------------------------------------

async fn cmd_islive(handle: &str) -> Result<()> {
    let http = http_client()?;
    let room = resolve_room(&http, handle).await?;
    println!(
        "handle=@{handle} live={} room_id={} title={:?} segun_tiktok: userCount={:?} enterCount={:?}",
        room.live, room.room_id, room.title, room.user_count, room.enter_count
    );
    if !room.live {
        println!("(offline: status==4; el roomId anterior NO es una senal de directo)");
    }
    Ok(())
}

async fn cmd_watch(
    handle: &str,
    seconds: u64,
    record: Option<&str>,
    dry_run: bool,
    skip_ws: bool,
    force: bool,
) -> Result<()> {
    let http = http_client()?;

    tracing::info!("etapa 1/4: resolviendo room_id de @{handle}");
    let room = resolve_room(&http, handle).await?;
    println!(
        "room_id={} live={} title={:?}",
        room.room_id, room.live, room.title
    );
    if !room.live && !force {
        bail!("@{handle} no esta en directo (status==4); abortando para no gastar cuota");
    }
    if !room.live {
        tracing::warn!("--force: la sala parece offline; se continua solo para diagnostico");
    }
    if dry_run {
        println!("--dry-run: parando antes de firmar (cuota intacta)");
        return Ok(());
    }

    tracing::info!("etapa 2/4: solicitando payload firmado (anonimo)");
    let signed = fetch_signed(&http, &room.room_id).await?;
    println!(
        "firma OK: push_server={} cursor={} route_params={} cookies={} mensajes_iniciales={}",
        if signed.envelope.push_server.is_empty() { "VACIO" } else { signed.envelope.push_server.as_str() },
        if signed.envelope.cursor.is_empty() { "VACIO" } else { signed.envelope.cursor.as_str() },
        signed.envelope.route_params.len(),
        if signed.cookies.is_empty() { "AUSENTES" } else { "presentes" },
        signed.envelope.messages.len()
    );
    for message in &signed.envelope.messages {
        print_message(&message.method, &message.payload, "init");
    }
    if skip_ws {
        println!(
            "envelope decodificado por Rust: need_ack={} is_first={} heartbeat_duration={} internal_ext={} bytes",
            signed.envelope.need_ack,
            signed.envelope.is_first,
            signed.envelope.heartbeat_duration,
            signed.envelope.internal_ext.len()
        );
        println!("--skip-ws: parando antes del WebSocket");
        return Ok(());
    }

    let ws_url = build_ws_url(&signed.envelope, &room.room_id)?;
    tracing::info!("etapa 3/4: conectando WebSocket");

    let mut request = ws_url.clone().into_client_request()?;
    {
        let headers = request.headers_mut();
        headers.insert("User-Agent", HeaderValue::from_str(UA)?);
        headers.insert("Origin", HeaderValue::from_static(TIKTOK_WEB_VALUE));
        headers.insert("Pragma", HeaderValue::from_static("no-cache"));
        let cookie = if signed.cookies.is_empty() {
            IDC_COOKIE.to_string()
        } else {
            format!("{IDC_COOKIE}; {}", signed.cookies)
        };
        headers.insert("Cookie", HeaderValue::from_str(&cookie)?);
    }

    let (stream, response) = tokio_tungstenite::connect_async(request)
        .await
        .context("handshake WebSocket")?;
    println!("WebSocket CONECTADO (HTTP {})", response.status());

    let mut recorder = match record {
        Some(path) => {
            let file = std::fs::File::create(path)
                .with_context(|| format!("creando {path}"))?;
            Some(std::io::BufWriter::new(file))
        }
        None => None,
    };

    let (mut write, mut read) = stream.split();
    let started = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_millis(9_000));
    heartbeat.tick().await; // consume el tick inmediato
    let mut frames = 0u64;

    loop {
        if started.elapsed() > Duration::from_secs(seconds) {
            tracing::info!(frames, "tiempo cumplido, cerrando");
            break;
        }

        tokio::select! {
            _ = heartbeat.tick() => {
                write.send(Message::Binary(HEARTBEAT_FRAME.to_vec())).await
                    .context("enviando heartbeat")?;
                tracing::debug!("heartbeat enviado");
            }
            incoming = read.next() => {
                match incoming {
                    None => { tracing::info!("el servidor cerro la conexion"); break; }
                    Some(Err(e)) => { tracing::warn!(%e, "error de WebSocket"); break; }
                    Some(Ok(Message::Binary(raw))) => {
                        frames += 1;
                        if let Some(file) = recorder.as_mut() {
                            let line = serde_json::json!({
                                "t": started.elapsed().as_millis() as u64,
                                "b64": base64::engine::general_purpose::STANDARD.encode(&raw),
                            });
                            writeln!(file, "{line}").context("grabando frame")?;
                        }
                        match handle_raw_frame(&raw, "live") {
                            Ok(Some(ack)) => {
                                write.send(Message::Binary(ack)).await
                                    .context("enviando ACK")?;
                                tracing::debug!("ACK enviado");
                            }
                            Ok(None) => {}
                            Err(e) => tracing::warn!(
                                error = %e,
                                len = raw.len(),
                                head = %hex_prefix(&raw, 48),
                                "frame no procesable"
                            ),
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        tracing::debug!(len = text.len(), "frame de texto inesperado");
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        write.send(Message::Pong(payload)).await.ok();
                    }
                    Some(Ok(other)) => tracing::debug!(?other, "frame no binario"),
                }
            }
        }
    }

    if let Some(mut file) = recorder {
        file.flush().ok();
    }
    println!("frames recibidos: {frames}");
    println!("grabacion: {}", record.unwrap_or("(ninguna)"));
    Ok(())
}

fn cmd_replay(path: &str) -> Result<()> {
    let content = std::fs::read_to_string(path).with_context(|| format!("leyendo {path}"))?;
    let mut frames = 0u64;
    for (index, line) in content.lines().enumerate() {
        let parsed: Value = serde_json::from_str(line)
            .with_context(|| format!("linea {} no es JSON", index + 1))?;
        let encoded = parsed.get("b64").and_then(Value::as_str).unwrap_or_default();
        let raw = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .with_context(|| format!("base64 invalido en la linea {}", index + 1))?;
        frames += 1;
        match handle_raw_frame(&raw, "replay") {
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, line = index + 1, "frame no procesable"),
        }
    }
    println!("frames reproducidos: {frames}");
    Ok(())
}

const TIKTOK_WEB_VALUE: &str = "https://www.tiktok.com";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        eprintln!("uso: spike <islive|watch|replay> ...");
        std::process::exit(2);
    };

    match command {
        "islive" => {
            let handle = args.get(1).ok_or_else(|| anyhow!("falta el handle"))?;
            cmd_islive(handle.trim_start_matches('@')).await
        }
        "watch" => {
            let handle = args.get(1).ok_or_else(|| anyhow!("falta el handle"))?;
            let mut seconds = 60u64;
            let mut record = None;
            let mut dry_run = false;
            let mut skip_ws = false;
            let mut force = false;
            let mut index = 2;
            while index < args.len() {
                match args[index].as_str() {
                    "--seconds" => {
                        seconds = args
                            .get(index + 1)
                            .ok_or_else(|| anyhow!("--seconds sin valor"))?
                            .parse()
                            .context("--seconds debe ser un numero")?;
                        index += 2;
                    }
                    "--record" => {
                        record = Some(
                            args.get(index + 1)
                                .ok_or_else(|| anyhow!("--record sin ruta"))?
                                .as_str(),
                        );
                        index += 2;
                    }
                    "--dry-run" => {
                        dry_run = true;
                        index += 1;
                    }
                    "--skip-ws" => {
                        skip_ws = true;
                        index += 1;
                    }
                    "--force" => {
                        force = true;
                        index += 1;
                    }
                    other => bail!("argumento desconocido: {other}"),
                }
            }
            cmd_watch(
                handle.trim_start_matches('@'),
                seconds,
                record,
                dry_run,
                skip_ws,
                force,
            )
            .await
        }
        "replay" => {
            let path = args.get(1).ok_or_else(|| anyhow!("falta la ruta"))?;
            cmd_replay(path)
        }
        other => bail!("comando desconocido: {other}"),
    }
}
