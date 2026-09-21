# TikTok LIVE Stream Dashboard

Panel de control propio para TikTok LIVE, pensado para convivir con OBS y un juego sin convertirse en otra carga para el PC. **Rust es el cerebro**; React solo pinta lo que Rust le dice.

- **Motor:** Rust + Tauri 2. **Interfaz:** React + TypeScript + Vite. **Datos:** SQLite (WAL).
- **Provider TikTok:** nativo en Rust, sin Python (validado en `spikes/tiktok-rust-provider/`).
- **TTS:** `edge-tts` en un sidecar de Python que **solo** sintetiza voz.
- **Repositorio:** público en `https://github.com/tacosandtypescript-debug/tiktok-stream-dashboard`.

---

## Estado actual

Todo lo de abajo está verificado contra directos reales y con la suite en verde (**225 tests**: 206 del núcleo, 14 de flujo completo y 5 de límites). El estado del proyecto y **lo que queda pendiente** están en `TODO.md`.

| Pieza | Estado |
|---|---|
| Provider nativo (sala, firma anónima, WebSocket, `im_enter_room`, gzip, ACK, heartbeat, reconexión con backoff) | ✅ verificado en vivo |
| Normalizador de eventos (protocolo v1, plano y versionado) | ✅ |
| Event bus: `seq` monótono, deduplicación por `(room_id, source_id)`, colas acotadas, contador de eventos perdidos | ✅ |
| Chat en tiempo real | ✅ |
| Regalos con rachas, diamantes, icono y ranking | ✅ |
| Likes, espectadores (pico y acumulado), follows, shares y suscripciones | ✅ |
| Entradas a la sala (`member.joined`) y mensajes borrados (tombstone) | ✅ |
| Fin de directo detectado por el propio protocolo | ✅ |
| Estados de conexión y botón coherentes | ✅ |
| Ficha de perfil del streamer (foto, apodo, contadores y bio) leída de la sala | ✅ verificado en vivo |
| Recuerdo del último usuario, con sugerencias en el campo | ✅ |
| TTS: chat, regalos y follows, con voces, volumen, velocidad, tono, cola y filtros | ✅ |
| TTS: perfil persistido en SQLite y salida de audio enrutable (Voicemeeter/OBS) | ✅ |
| Persistencia con migraciones (v1 → v7), contadores idempotentes, escritor dedicado y lotes | ✅ |
| Errores de escritura de la base visibles en el panel de diagnóstico | ✅ |
| Empaquetado reproducible del sidecar (dependencias fijadas con hashes) y avisos de terceros | ✅ |
| Gates de calidad automatizados (`cargo fmt`, `clippy -D warnings`, tests) y CI en Windows | ✅ |
| Diagnóstico: logs con rotación, métricas y traza del chat en la interfaz | ✅ |
| Overlays para OBS: servidor Axum + WebSocket, con token y **once diseños** (ocho marcadores y tres minijuegos) elegibles por vista | ✅ |
| Alertas para OBS: medios cargados, texto con variables, sonido, **tamaño por aviso**, **animación de entrada, permanencia y salida**, cola que espera a la fuente y monitor de audio propio | ✅ |
| Rediseño de la interfaz: colores de la marca, secciones sin cajas y marcador arriba | ✅ |
| Metas y recompensas | ⏳ siguientes milestones |

## Qué hace, de un vistazo

- **Chat en vivo** con búsqueda que ignora acentos, autoscroll que respeta al usuario que está leyendo hacia arriba, botón de «ir al final», vaciado y **silenciar a un usuario** desde su propia línea.
- **Regalos** con usuario, regalo, cantidad, diamantes, combo/racha, icono y hora; quién aporta más y resumen por tipo.
- **Avisos del directo** en la actividad: follows, shares, suscripciones, ráfagas de likes y cambios de estado.
- **TTS** que lee el chat en voz alta, y también los regalos (una sola vez, al cerrar la racha) y los follows. Voces en español e inglés, volumen, velocidad, pausa, saltar, vaciar cola, silenciar usuarios y motivos de descarte visibles.
- **Estados de conexión** (`desconectado → conectando → conectado → reconectando → error`) reflejados en la cabecera y en el botón: mientras hay una sesión en curso, Conectar se deshabilita y explica por qué, para no reiniciar el backoff ni gastar cuota de firma sin querer.

## Requisitos

- **Windows 10/11** con WebView2 (de serie en Windows 11 y en Windows 10 actualizado).
- **Rust** estable con toolchain `x86_64-pc-windows-msvc` y **Visual Studio Build Tools** (enlazador de MSVC).
- **Node.js 22+** (solo para compilar la interfaz).
- **Python 3.12 con `uv`** para desarrollo y **PyInstaller** para el sidecar de voz. El instalador no necesita Python: Tauri empaqueta `tiktok-tts-provider` como `externalBin`.

## Puesta en marcha

```powershell
# 1. Entorno (rutas de cache dentro del proyecto; ver docs/decisions.md D6/D7)
. .\scripts\env.ps1

# 2. Entornos reproducibles (una sola vez)
.\scripts\setup.ps1

# 3. Dependencias de la interfaz (una sola vez)
cd apps\desktop
npm install
cd ..\..

# 4. Compilar ejecutable y sidecar
.\scripts\build.ps1
.\apps\desktop\src-tauri\target\release\tiktok-stream-dashboard.exe
```

Para generar también el instalador NSIS, con el sidecar validado por la configuración de Tauri:

```powershell
.\scripts\build.ps1 -Bundle
```

`scripts/setup.ps1` sincroniza `services\tts-provider\requirements.lock`, que fija edge-tts, PyInstaller y todas sus dependencias con hashes. `scripts\build-tts-sidecar.ps1` genera `tiktok-tts-provider-x86_64-pc-windows-msvc.exe` en `apps\desktop\src-tauri\binaries\` y en `target\release\`; los binarios generados no se versionan.

El motor Rust resuelve el runtime en este orden: `TTSDASH_TTS_SIDECAR`, un sidecar junto al ejecutable o en `resources`, el staging release/.tooling y, solo en desarrollo, `TTSDASH_PYTHON`, `.tooling\venv\Scripts\python.exe` o `python` del PATH. Si no encuentra ninguno, el error enumera el modo esperado y el comando de preparación.

### Modo desarrollo

```powershell
.\scripts\dev.ps1     # levanta Vite y abre la aplicacion contra el servidor de desarrollo
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

### Modo servidor web

La aplicacion tambien se puede servir por HTTP y usar desde el navegador. Es el
**mismo motor** por otro canal: los comandos van por HTTP y los eventos por
WebSocket, y los dos transportes comparten la misma implementacion (`ipc.rs`).

```powershell
.\scripts\web.ps1                 # compila la interfaz y levanta el panel
.\scripts\web.ps1 -SinCompilar    # arranca lo que ya hay compilado
```

El panel queda en `http://127.0.0.1:8790`. Para tocar React con recarga en
caliente **y datos reales**, deja ese servidor levantado y arranca aparte
`npm run dev` en `apps\desktop`: Vite hace de proxy de `/api` hacia el motor.

`--web` no necesita la feature `desktop` ni abre ninguna ventana, asi que ese
binario se puede compilar y llevar a otra maquina. Escucha en `127.0.0.1` y **no
tiene autenticacion**: leer [`docs/modo-web.md`](docs/modo-web.md) antes de
abrirlo a la red.

### Comprobaciones

```powershell
cd apps\desktop\src-tauri

cargo test --offline                 # suite completa: 225 tests, sin necesitar el sidecar
cargo test --offline --lib           # solo el nucleo (segundos)

# Autoverificacion: arranca el motor con la base de datos y los logs reales
cargo run --offline --no-default-features -- --self-test --seconds 5
cargo run --offline --no-default-features -- --self-test --live usuario --seconds 120

# Voz: sintetiza una frase con el sidecar real y resume el resultado
cargo run --offline --no-default-features -- --tts-test "Hola, esto es una prueba." --rate +25%
cargo run --offline --no-default-features -- --tts-voices
```

`--self-test` resume en JSON lo que ha pasado (eventos publicados, frames del WebSocket, comentarios y regalos persistidos). Con `--live <usuario>` se conecta a un directo real y **consume 1 unidad de la cuota de firma**.

## Uso

1. Escribe el `@usuario` y pulsa **Conectar**. El campo **recuerda el último** con el que te conectaste —y sugiere los cuatro últimos—, pero **no conecta solo**: conectar es cosa tuya. La aplicación resuelve la sala y, si el directo aún no ha empezado, espera sondeando **sin gastar cuota**.
2. Al conectar aparece la **ficha de tu perfil** —foto, apodo, seguidores, likes y bio—, leída de la respuesta de la sala. Un contador que TikTok no mande **no se pinta**, en vez de enseñar un cero falso.
3. El **marcador** está arriba, con el tiempo de directo: primero lo que importa (regalos y diamantes) y después lo de la sesión. Un cero se queda en su sitio pero apagado, para que las cifras que sí valen sean las que se leen.
4. En **Inicio** tienes cuatro paneles: el **chat** de la sesión, los **follows** según entran, la tabla de **seguidores** —pulsando un nombre se abre su perfil de TikTok— y **Actividad** con todo lo demás: regalos, suscripciones, compartidos y ráfagas de likes. El chat lleva búsqueda que ignora acentos, autoscroll que respeta a quien lee hacia arriba, y **silenciar a un usuario** desde su línea.
5. En **Aportaciones** está quién sostiene el directo —tap tap, regalos, seguidores e histórico, por persona y con enlace a su perfil— y, debajo, el detalle de los regalos que han caído.
6. En **Alertas** los avisos van en **lista, editor y biblioteca**: eliges uno —regalos, seguidores, suscripciones, compartidos o ráfagas de likes— y solo se abre ese; están agrupados en «Regalos y seguidores» y «Actividad». La biblioteca queda en la tercera columna con imágenes y audios separados, buscador, **Oír**, **Poner** y **Borrar**, además de la previa del aviso. Se le carga una imagen, un GIF o un vídeo, un sonido, y se escribe el texto con variables (`{usuario} donó {regalo}`), que se ven resaltadas mientras escribes. Cada uno tiene su botón de **probar** —que **suena en tu equipo**, no solo en OBS— y hay una **salida de audio propia** para oírlas tú, con un interruptor para escucharlas también durante el directo. Los ficheros se copian a la carpeta de datos y los sirve la aplicación: no se rompen si mueves el original.
7. En **Overlays** eliges el diseño de cada marcador —tap tap, regalos y seguidores, uno por cada *Browser Source* de OBS— lo ves en vivo con un simulador y copias la dirección que se pega en OBS. La elección se guarda en `overlay.json`, así que **la dirección de OBS no cambia** al cambiar de diseño.
8. En **Voz** está el lector de chat: voz, volumen, velocidad, tono, cola, filtros y el interruptor del histórico de aportaciones.
9. El botón **Desarrollador** de la cabecera abre el diagnóstico: rutas, métricas del motor, tipos de evento reconocidos por la interfaz, la traza del chat (recibidos frente a pintados) y el contador de firmas consumidas. Se refresca a 1 Hz **solo mientras está abierto**.
10. El **simulador del motor** vive en Desarrollador: genera eventos falsos sin conexión a TikTok, para probar la interfaz. El **simulador del overlay** es otra cosa: vive en la vista previa de la pestaña Overlays y solo inventa taps, para juzgar un diseño sin estar en directo.

## Dónde se guardan los datos

| Qué | Dónde |
|---|---|
| Base de datos | `%LOCALAPPDATA%\TikTokStreamDashboard\data\dashboard.db` |
| Logs | `%LOCALAPPDATA%\TikTokStreamDashboard\logs\` (rotación diaria, 14 días) |
| Audio sintetizado | `%LOCALAPPDATA%\TikTokStreamDashboard\cache\tts\` (se poda solo: 200 MB / 7 días) |

El catálogo que trae la aplicación está versionado en
`apps/desktop/src-tauri/alertas-pack/`, separado en `imagenes/` y `audio/`. Tauri lo
incluye como recurso de la instalación. En el primer arranque se copia de forma
**no destructiva** a `%LOCALAPPDATA%\TikTokStreamDashboard\alertas\`: solo entran los
ficheros que falten, no se reemplaza ningún medio local y los nombres que ya usan los
ajustes de Alertas se conservan. En los arranques siguientes la siembra es idempotente.

Los medios importados desde la pestaña Alertas siguen guardándose en AppData y no
escriben en el checkout ni crean cambios Git. La copia actual de AppData se conserva
durante la migración. El catálogo actual de imágenes y audios está autorizado para su
publicación en este repositorio público; `alertas-pack/manifest.json` permite comprobar
los tamaños y SHA-256 de cada archivo.

**Nunca** en `Documents`: una carpeta sincronizada (OneDrive) con SQLite en modo WAL acaba corrompiendo la base. `TTSDASH_DATA_DIR` permite redirigir ambas rutas.

## Cuota del servidor de firma

La firma de las conexiones la hace un servidor de terceros (Euler Stream). Sin API key, la cuota es de **5 conexiones por minuto, 30 por hora y 100 por día**, y **no hay criptografía de firma en el cliente**. Por eso:

- esperar a que empiece el directo **no** consume cuota (solo consulta el estado de la sala);
- reconectar usa backoff exponencial con jitter y un mínimo de 30 s;
- tras un 429 se espera 10 minutos;
- tras 10 fallos consecutivos el provider se detiene en vez de agotar el día **y deja el motivo a la vista**;
- hay una guarda de instancia única, para que dos ventanas no consuman la misma cuota.

El contador de peticiones de firma está visible en el panel de **Desarrollador**.

## Arquitectura

```text
TikTok LIVE
    │ WebSocket + protobuf (Webcast)
    ▼
providers/tiktok.rs  ── trait TikTokProvider ──┐
providers/simulated.rs ───────────────────────┤
                                              ▼
                                  core/event.rs · core/bus.rs
                                              │
        ┌──────────────────────┬──────────────┴─────────────┐
        ▼                      ▼                            ▼
  estado + SQLite        interfaz (IPC de Tauri)      TTS (cola y voz)
```

- El **provider** habla el protocolo de TikTok y no sabe nada del resto. Sustituirlo no toca el núcleo.
- El **normalizador** (`core/event.rs`) convierte cada mensaje en un evento plano con `type`, versionado (`protocol_version`): la interfaz reconoce por nombre y hay un test de contrato que lo congela.
- El **bus** (`core/bus.rs`) asigna `seq`, deduplica por `(room_id, source_id)` y cuenta lo que descarta. Tiene tres consumidores y **ninguno se realimenta**.
- La **interfaz** pide un snapshot al abrirse y luego recibe eventos; **no guarda historial**. La foto del motor se fusiona por `seq` con lo que ya llegó en vivo, para no perder mensajes en la carrera del arranque.
- El canal hacia la interfaz es el **IPC de Tauri** (eventos `dash://event`). OBS no puede usar ese canal —es de `tauri.localhost`— así que los overlays van por un **servidor HTTP + WebSocket** propio, con token por instalación (D18).

Detalles que cuestan un rato entender y están documentados en `docs/decisions.md`:

- El WebSocket de TikTok **exige pedir la entrada a la sala** (`im_enter_room`); sin ese frame el servidor acepta la conexión y no empuja nada (D9).
- `repeat_count` de los regalos es un **incremento por mensaje**, no un acumulado: la aportación de una racha es la suma de sus incrementos, y se liquida al cerrarla, al empezar otra o al terminar el directo (D14).
- La velocidad del TTS vive **en un solo sitio** y viaja con cada petición (D12).
- Los números de campo del protocolo se extraen de la metadata real instalada, nunca de un `.proto` de terceros (D8).

## Rendimiento

El objetivo del proyecto es no molestar al juego, así que la parte pesada (WebView2) se mantiene al mínimo y todo lo demás vive en Rust:

- binario de release: **~9,9 MB**;
- proceso propio del dashboard: **~14 MB** en reposo (medido en release);
- CPU en reposo: por debajo de la resolución de medida (< 0,3 % de un núcleo);
- el consumo dominante es WebView2 (~174 MB repartidos en varios procesos), no el motor.

## Documentación

| Documento | Contenido |
|---|---|
| `docs/interfaz.md` | Las reglas de la interfaz: qué se lee sin mirar, dónde va cada cosa y por qué |
| `docs/modo-web.md` | El panel por HTTP (`--web`): arranque, configuración, API y seguridad |
| `docs/decisions.md` | Decisiones D1–D22 con la evidencia que las respalda |
| `docs/plan-review.md` | Auditoría del plan maestro: bloqueadores, correcciones y gates de rendimiento |
| `docs/architecture-review.md` | Revisión de la arquitectura y huecos conocidos |
| `docs/milestone-1.md` / `docs/milestone-2.md` | Qué se construyó en cada etapa y con qué evidencia |
| `spikes/tiktok-rust-provider/REPORT.md` | Informe del spike: protocolo, rendimiento y hallazgos |
| `spikes/tiktok-rust-provider/PROTOCOL-SPEC.md` | Especificación del protocolo de TikTok LIVE |
| `docs/quality-gates.md` | Qué comprueba cada gate y qué tiene que pasar para publicar |

## Limitaciones conocidas

- **Catálogo de voces curado**: la interfaz ofrece una lista seleccionada de voces es/en (con género y lengua); el listado completo del servicio se puede consultar con `--tts-voices`, pero no se ha volcado a la interfaz.
- **Filtros del TTS no configurables**: las listas de palabras y usuarios bloqueados existen y funcionan, pero se editan en código, no desde la interfaz.
- **El paquete instalable necesita el sidecar**: `cargo test` y `cargo build` funcionan en un clon limpio, pero generar el instalador exige antes `scripts/setup.ps1` y `scripts/build-tts-sidecar.ps1` (es lo que hace `scripts/build.ps1 -Bundle`).
- **Las entradas a la sala se cuentan, no se listan**: es el mensaje más frecuente de TikTok y una fila por entrada taparía el chat.
- **`metrics.subscribers` solo crece**: es un contador acumulado, no un valor vivo.

## Notas de desarrollo

- El **TLS de Windows (schannel) no está disponible** en este entorno para procesos hijos, así que el proyecto usa **rustls** en todo. Es también la opción más portable.
- Las dependencias se **descargan** con permiso ampliado, pero se **compilan** con `cargo build --offline` (ver `docs/decisions.md` D7).
- Los frames reales grabados (`spikes/tiktok-rust-provider/live.jsonl`, 132 frames, y `live2.jsonl`, 58) alimentan tests de regresión que decodifican comentarios, regalos, emotes y entradas **sin tocar la red**.
- Los textos de la interfaz viven **solo** en `apps/desktop/src/i18n/es.ts`. Las frases que se leen en voz alta se componen en Rust (`tts/mod.rs`: `chat_line`, `gift_line`, `follow_line`), porque son parte del motor de voz y no de la pantalla.

## Licencias de terceros

- **TikTokLive** (solo en el spike y en herramientas de desarrollo): AGPL-3.0 modificada. **No forma parte de la aplicación**: el provider es propio. Ver `docs/decisions.md` D1.
- **edge-tts** (sidecar de voz): LGPLv3.
- **Tauri**, **React**, **rusqlite**, **tokio** y **Axum**: MIT/Apache-2.0.
