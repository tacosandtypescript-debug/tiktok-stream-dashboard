//! TikTok LIVE Stream Dashboard — nucleo y shell de escritorio.
//!
//! Arquitectura (docs/plan-review.md): Rust es la fuente de verdad y el
//! cerebro; React solo pinta lo que Rust le dice. El provider TikTok es nativo
//! en Rust (validado en el spike, ver spikes/tiktok-rust-provider/REPORT.md),
//! detras del trait `TikTokProvider`.
//!
//! Modulos del Milestone 1:
//!   app         motor: estado, consumidor del bus y persistencia
//!   core/       protocolo de eventos versionado, event bus, metricas
//!   providers/  trait TikTokProvider + implementacion nativa + simulador
//!   chat/       buffer circular de los ultimos N mensajes
//!   database/   SQLite con migraciones (schema_version)
//!   telemetry/  logs con rotacion
//!   core::single  instancia unica
//!   overlay/    servidor HTTP + WebSocket para los Browser Source de OBS
//!   desktop.rs  shell Tauri (comandos y ventana)

pub mod alerts;
pub mod app;
pub mod chat;
pub mod core;
pub mod database;
pub mod feed;
pub mod overlay;
pub mod providers;
pub mod secreto;
pub mod telemetry;
pub mod tts;

#[cfg(feature = "desktop")]
mod desktop;

/// Arranque del nucleo, sin depender de Tauri.
///
/// Devuelve el runtime y el estado compartido para que el shell de escritorio
/// (o los tests de integracion) puedan usarlo.
pub fn init() -> anyhow::Result<()> {
    telemetry::init()?;
    tracing::info!(
        "TikTok LIVE Stream Dashboard v{}",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}

#[cfg(feature = "desktop")]
pub fn run() {
    desktop::run();
}

/// Sintetiza una frase con el sidecar real y resume el resultado.
///
/// Es la comprobacion de que la cadena completa funciona en este equipo:
/// interprete localizado, sidecar arrancado, protocolo JSONL, fichero MP3
/// escrito y cache podada. Acepta velocidad y tono para poder comprobar de punta
/// a punta que el ajuste llega al sintetizador (no solo a la interfaz).
pub fn tts_probe(
    text: &str,
    voice: Option<&str>,
    rate: Option<&str>,
    pitch: Option<&str>,
) -> anyhow::Result<()> {
    telemetry::init()?;

    let rate = rate.unwrap_or("+0%");
    let pitch = pitch.unwrap_or("+0Hz");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("no se pudo crear el runtime: {error}"))?;

    runtime.block_on(async move {
        let config = tts::default_config();
        let provider = tts::EdgeTtsSidecar::new(config.clone());

        let voice = match voice {
            Some(voice) if !voice.is_empty() => voice.to_string(),
            _ => tts::voice_for(text, tts::DEFAULT_VOICE, "en-US-AriaNeural"),
        };

        let started = std::time::Instant::now();
        let audio = tts::TtsProvider::synthesize(
            &provider,
            &tts::TtsRequest {
                id: 1,
                text: text.to_string(),
                voice: voice.clone(),
                rate: rate.to_string(),
                pitch: pitch.to_string(),
            },
        )
        .await
        .map_err(|error| anyhow::anyhow!("la sintesis fallo: {error:#}"))?;
        let total_ms = started.elapsed().as_millis() as u64;

        // Segunda pasada: debe salir de cache y ser practicamente instantanea.
        let cached = tts::TtsProvider::synthesize(
            &provider,
            &tts::TtsRequest {
                id: 2,
                text: text.to_string(),
                voice: voice.clone(),
                rate: rate.to_string(),
                pitch: pitch.to_string(),
            },
        )
        .await?;

        let removed = tts::prune_cache(
            &config.cache_dir,
            config.cache_max_bytes,
            config.cache_max_age,
            std::time::SystemTime::now(),
        );
        let (arranques, peticiones, fallos, aciertos) = provider.stats();
        let runtime_path = config
            .executable
            .as_ref()
            .unwrap_or(&config.python)
            .display()
            .to_string();
        let runtime_kind = if config.executable.is_some() {
            "frozen-pyinstaller"
        } else {
            "python-script"
        };
        let resumen = serde_json::json!({
            "proveedor": "edge-tts (sidecar)",
            "runtime": runtime_kind,
            "runtime_path": runtime_path,
            "sidecar": config.script.display().to_string(),
            "voz": voice,
            "texto": text,
            "audio": audio.path.display().to_string(),
            "bytes": audio.bytes,
            "sintesis_ms": audio.ms,
            "total_ms": total_ms,
            "desde_cache": cached.cached,
            "cache_entradas_borradas": removed,
            "sidecar_arranques": arranques,
            "peticiones": peticiones,
            "fallos": fallos,
            "aciertos_de_cache": aciertos,
        });
        println!("{}", serde_json::to_string_pretty(&resumen)?);

        tts::TtsProvider::shutdown(&provider).await;
        Ok(())
    })
}

/// Lista las voces que ofrece el sidecar (todas las de edge-tts).
pub fn tts_voices() -> anyhow::Result<()> {
    telemetry::init()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("no se pudo crear el runtime: {error}"))?;

    runtime.block_on(async move {
        let provider = tts::EdgeTtsSidecar::new(tts::default_config());
        let voices = tts::TtsProvider::available_voices(&provider)
            .await
            .map_err(|error| anyhow::anyhow!("no se pudieron listar las voces: {error:#}"))?;
        let espanol: Vec<&String> = voices.iter().filter(|v| v.starts_with("es-")).collect();
        let ingles: Vec<&String> = voices.iter().filter(|v| v.starts_with("en-")).collect();
        let resumen = serde_json::json!({
            "total": voices.len(),
            "espanol": espanol,
            "ingles": ingles,
            "catalogo_curado": tts::catalog(),
        });
        println!("{}", serde_json::to_string_pretty(&resumen)?);
        tts::TtsProvider::shutdown(&provider).await;
        Ok(())
    })
}

/// Autoverificacion sin ventana.
///
/// Arranca el motor de verdad (con la base de datos y los logs reales del
/// usuario), lo alimenta con el simulador o con un directo real, y resume el
/// resultado. Sirve para comprobar la integracion completa en CI y en una
/// maquina nueva sin abrir la interfaz.
pub fn self_test(seconds: u64, live: Option<&str>) -> anyhow::Result<()> {
    use std::time::Duration;

    use providers::TikTokProvider;

    telemetry::init()?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("no se pudo crear el runtime: {error}"))?;

    runtime.block_on(async move {
        let state = std::sync::Arc::new(app::AppState::new(core::single::GUARD_PORT)?);
        let _consumer = tokio::spawn(state.consumer_future());

        match live {
            Some(handle) => {
                tracing::info!(handle, "autoverificacion contra un directo real");
                // Se conecta por el motor para que la sesion guarde el handle.
                state
                    .connect(handle)
                    .await
                    .map_err(|error| anyhow::anyhow!("no se pudo conectar: {error}"))?;
                let provider = state.current_provider();
                tokio::time::sleep(Duration::from_secs(seconds)).await;
                provider.disconnect().await;
            }
            None => {
                tracing::info!("autoverificacion con el proveedor simulado");
                {
                    let mut guard = state
                        .provider
                        .write()
                        .map_err(|_| anyhow::anyhow!("cerrojo envenenado"))?;
                    *guard =
                        state.simulated.clone() as std::sync::Arc<dyn providers::TikTokProvider>;
                }
                state.simulated.set_interval(Duration::from_millis(50));
                state
                    .connect("autoverificacion")
                    .await
                    .map_err(|error| anyhow::anyhow!("no arranco el simulador: {error}"))?;
                tokio::time::sleep(Duration::from_secs(seconds)).await;
                state.simulated.disconnect().await;
            }
        }

        // Margen para que el consumidor procese lo ultimo que quedo en el bus.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let snapshot = state.snapshot();
        state.shutdown();

        // Se reabre la base para comprobar que los datos llegaron al disco.
        let database = database::Database::open(&state.db_path)?;
        let resumen = serde_json::json!({
            "protocol_version": snapshot.protocol_version,
            "provider": snapshot.provider,
            "status": snapshot.status,
            "chat_en_memoria": snapshot.chat.len(),
            "comentarios_persistidos": database.count("comments")?,
            "regalos_persistidos": database.count("gift_events")?,
            "sesiones": database.count("streams")?,
            "esquema": snapshot.schema_version,
            "base_de_datos": snapshot.db_path,
            "logs": snapshot.log_dir,
            "metricas": snapshot.metrics,
        });
        println!("{}", serde_json::to_string_pretty(&resumen)?);
        Ok(())
    })
}
