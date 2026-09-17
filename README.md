# TikTok LIVE Stream Dashboard

Panel de control propio para TikTok LIVE, pensado para convivir con OBS y un juego sin convertirse en otra carga para el PC. **Rust es el cerebro**; React solo pinta lo que Rust le dice.

- **Estado:** Milestone 1 (conexión ligera) completado y verificado contra directos reales.
- **Motor:** Rust + Tauri 2. **Interfaz:** React + TypeScript + Vite.
- **Provider TikTok:** nativo en Rust, sin Python (validado en `spikes/tiktok-rust-provider/`).
- **Persistencia:** SQLite con migraciones. **TTS:** pendiente (Milestone 3), será `edge-tts`.

---

## Estado actual

| Pieza | Estado |
|---|---|
| Event bus con protocolo versionado, deduplicación y colas acotadas | ✅ |
| Provider TikTok nativo (sala, firma anónima, WebSocket, protobuf, ACK, heartbeat) | ✅ verificado en vivo |
| Chat con buffer circular y búsqueda sin acentos | ✅ |
| Simulador como implementación del trait `TikTokProvider` | ✅ |
| SQLite con migraciones, escritor dedicado y escritura por lotes | ✅ |
| Logs con rotación diaria y purga | ✅ |
| Instancia única | ✅ |
| Métricas de diagnóstico | ✅ |
| Interfaz (panel, chat, diagnóstico) | ✅ |
| TTS, regalos con combos, rankings, metas, recompensas, overlays OBS | ⏳ siguientes milestones |

---

## Requisitos

- **Windows 10/11** con WebView2 (viene de serie en Windows 11 y en Windows 10 actualizado).
- **Rust** estable con toolchain `x86_64-pc-windows-msvc` y **Visual Studio Build Tools** (para el enlazador de MSVC).
- **Node.js 22+** (solo para compilar la interfaz).

## Puesta en marcha

```powershell
# 1. Entorno (rutas de cache dentro del proyecto; ver docs/decisions.md D6/D7)
. .\scripts\env.ps1

# 2. Dependencias de la interfaz (una sola vez)
cd apps\desktop
npm install
cd ..\..

# 3. Compilar y ejecutar la aplicacion
.\scripts\build.ps1
.\apps\desktop\src-tauri\target\release\tiktok-stream-dashboard.exe
```

### Modo desarrollo

```powershell
.\scripts\dev.ps1     # levanta Vite y abre la aplicacion contra el
```

> **Importante:** Tauri solo sirve la interfaz **embebida** cuando está activa la feature
> `custom-protocol`, que este proyecto incluye por defecto. Si compilas desactivando las features
> por defecto (es lo que hace `scripts\dev.ps1`), la aplicación carga `devUrl`
> (`http://localhost:1420`) y, sin el servidor de Vite levantado, la ventana muestra
> `ERR_CONNECTION_REFUSED` («localhost rechazó la conexión»). En ese caso usa `scripts\dev.ps1`,
> o compila con las features por defecto.
>
> Si tras abrir la ventana el log **no** contiene `interfaz conectada con el motor`, la interfaz
> no llegó a cargar: revisa el log antes de dar por bueno un arranque.

### Comprobaciones

```powershell
cd apps\desktop\src-tauri
cargo test --no-default-features --lib      # tests del nucleo (segundos)

# Autoverificacion: arranca el motor con la base de datos y los logs reales
cargo run --offline --no-default-features -- --self-test --seconds 5

# TTS: sintetiza una frase con el sidecar real y resume el resultado
cargo run --offline --no-default-features -- --tts-test "Hola, esto es una prueba."
cargo run --offline --no-default-features -- --tts-voices
```

`--self-test` resume en JSON lo que ha pasado. Con `--live <usuario>` se conecta
a un directo real (consume 1 unidad de la cuota de firma). Si el log contiene
`interfaz conectada con el motor`, la ventana cargó la interfaz y el IPC funciona.

## Uso

1. Escribe el `@usuario` y pulsa **Conectar**. La aplicación resuelve la sala y espera al directo si aún no ha empezado (esperar **no** consume cuota).
2. Pulsa **Simulador** para probar la interfaz sin estar en directo.
3. La pestaña **Desarrollador** muestra rutas, métricas y el estado de la base de datos.

## Dónde se guardan los datos

| Qué | Dónde |
|---|---|
| Base de datos | `%LOCALAPPDATA%\TikTokStreamDashboard\data\dashboard.db` |
| Logs | `%LOCALAPPDATA%\TikTokStreamDashboard\logs\` (rotación diaria, 14 días) |

**Nunca** en `Documents`: una carpeta sincronizada (OneDrive) con SQLite en modo WAL acaba corrompiendo la base. `TTSDASH_DATA_DIR` permite redirigir ambas rutas.

## Cuota del servidor de firma

La firma de las conexiones la hace un servidor de terceros (Euler Stream). Sin API key, la cuota es de **5 conexiones por minuto, 30 por hora y 100 por día**, y **no hay criptografía de firma en el cliente**. Por eso:

- esperar a que empiece el directo **no** consume cuota (solo consulta el estado de la sala);
- reconectar usa backoff exponencial con jitter y un mínimo de 30 s;
- tras un 429 se espera 10 minutos;
- tras 10 fallos consecutivos el provider se detiene en vez de agotar el día;
- hay una guarda de instancia única, para que dos ventanas no consuman la misma cuota.

El contador de peticiones de firma está visible en la pestaña **Desarrollador**.

## Arquitectura en una imagen

```text
TikTok LIVE
    │ (WebSocket + protobuf)
    ▼
providers/tiktok.rs  ── trait TikTokProvider ──┐
providers/simulated.rs ───────────────────────┤
                                              ▼
                                   core/event.rs · core/bus.rs
                                              │
              ┌───────────────┬───────────────┴────────────┐
              ▼               ▼                            ▼
        chat (anillo)   database (SQLite)          interfaz (Tauri)
```

- El bus asigna `seq`, deduplica por `source_id` y cuenta lo que descarta: **un solo escritor del estado**.
- La interfaz pide un snapshot al abrirse y recibe eventos; **no guarda historial**.
- El provider es sustituible: cambiar de proveedor no toca el núcleo.

## Documentación

| Documento | Contenido |
|---|---|
| `docs/plan-review.md` | Auditoría del plan maestro: bloqueadores, correcciones y gates de rendimiento |
| `docs/decisions.md` | Decisiones D1–D8 y restricciones del entorno de desarrollo |
| `docs/milestone-1.md` | Qué se ha construido, con qué evidencia y qué queda pendiente |
| `spikes/tiktok-rust-provider/REPORT.md` | Informe del spike: protocolo, rendimiento y hallazgos |
| `spikes/tiktok-rust-provider/PROTOCOL-SPEC.md` | Especificación completa del protocolo de TikTok LIVE |

## Notas de desarrollo

- El **TLS de Windows (schannel) no está disponible** en este entorno de desarrollo para procesos hijos, así que el proyecto usa **rustls** en todo. Es también la opción más portable.
- Las dependencias se **descargan** con permiso ampliado, pero se **compilan** con `cargo build --offline` en modo confinado (ver `docs/decisions.md` D7).
- Los frames reales grabados (`spikes/tiktok-rust-provider/live.jsonl`) alimentan un test de regresión que decodifica comentarios y regalos sin tocar la red.

## Licencias de terceros

- **TikTokLive** (solo en el spike y en las herramientas de desarrollo): AGPL-3.0 modificada. **No forma parte de la aplicación**: el provider es propio. Ver `docs/decisions.md` D1.
- **edge-tts** (TTS, pendiente): LGPLv3.
- **Tauri**, **React**, **rusqlite**, **tokio**, **axum** (pendiente): MIT/Apache-2.0.
