# Revisión crítica del plan maestro — TikTok LIVE Stream Dashboard

**Documento revisado:** plan maestro §1–§88 (Tauri 2 + Rust + React + TikTokLive + edge-tts + SQLite + Axum + OBS).
**Fecha de revisión:** 2026-09-17.
**Alcance:** auditoría técnica y de riesgos **antes** de escribir código. No se ha creado ningún proyecto ni dependencia.

---

## 0. Veredicto ejecutivo

El plan es **arquitectónicamente sólido en su forma** y muy por encima del promedio para un proyecto de este tipo:

- Rust como fuente de verdad y dueño del estado. ✅
- Provider/adapter pattern para TikTokLive y para TTS (permite sustituirlos). ✅
- Diseño event-driven con colas acotadas, coalescing e incrementalidad explícita. ✅
- Contrato versionado + fixtures + tests de compatibilidad para la dependencia frágil. ✅
- Simulador obligatorio y definición de "Done" medible. ✅

El problema no es el diseño, es que el plan **subestima tres cosas y contiene ~12 defectos concretos de diseño**:

| # | Subestimación | Consecuencia si no se corrige |
|---|---|---|
| A | La capa TikTok es un **proyecto de reverse engineering en AGPL modificada, explícitamente declarado "no production-ready"**, que además depende de un **servidor de firma de terceros con rate limits**. | El plan se apoya en la única pieza que no controla, la más frágil y la que tiene implicaciones legales. |
| B | **Tauri + OBS no son ligeros en RAM en runtime.** WebView2 es Chromium multiproceso y cada Browser Source de OBS añade procesos CEF. | El objetivo central (§45 "presupuesto de rendimiento") puede fallar sin que nadie lo vea hasta el día del stream. |
| C | **Empaquetar Python** (que hoy no existe en la máquina) es una decisión de producto, no un detalle de build. | Instalador de 150 MB, falsos positivos de antivirus, 2–6 s de arranque, y la estrategia de updates de §10 se vuelve inviable. |

**Recomendación:** mantener la arquitectura, corregir los 12 defectos, y **resolver 3 decisiones de producto antes de la Fase 0** (§9 de este documento). Añadir además un **spike de 1–2 días** para evaluar un provider TikTok nativo en Rust, porque existe un precedente MIT y eso cambiaría el perfil de recursos de todo el proyecto.

---

## 1. Evidencia verificada (no opinión)

### 1.1 Entorno de la máquina

| Componente | Estado real | Comando |
|---|---|---|
| rustc / cargo | ✅ 1.98.1, host `x86_64-pc-windows-msvc` | `rustc --version` |
| Enlazador MSVC | ✅ Build Tools 2022 17.14 + Windows SDK 10.0.26100 · `cargo build` de prueba OK (exit 0) | `cargo build` |
| Node / npm | ✅ v22.23.2 / npm presente | `node --version` |
| pnpm | ❌ ausente — **`corepack` sí está** → `corepack enable pnpm` | `Get-Command corepack` |
| Python | ❌ **solo el alias falso de Microsoft Store** (`python --version` → exit 9009) | `python --version` |
| `uv` | ✅ ya instalado | `Get-Command uv` |
| WebView2 Runtime | ✅ 145.0.3800.97 / 153.0.4234.32 | registro + carpeta EdgeWebView |
| git / cmake | ✅ | — |
| Trampa detectada | ⚠️ `link.exe` en PATH resuelve a `git\usr\bin\link.exe` (el de Git, no el de MSVC). Los builds funcionan hoy, pero es un footgun clásico si algún build script lo invoca primero. | `Get-Command link.exe` |

### 1.2 Hallazgos sobre las dependencias (verificados contra las fuentes)

| Hallazgo | Evidencia | Impacto |
|---|---|---|
| **TikTokLive ≠ MIT. Es "Modified AGPL-3.0"** | `pyproject.toml` v7.0.1: `license = { text = "Modified AGPL-3.0" }` y comentario explícito: *"Not a plain SPDX identifier: LICENSE is AGPL-3.0 plus added Sections 18-21 (library-integration exception, SaaS/relay carve-out, excepted parties)"*. GitHub API reporta `AGPL-3.0`. | **Bloqueador de licencia.** El plan nunca lo menciona. Distribuir el instalador = distribuir código AGPL. |
| **TikTokLive se declara NO production-ready** | README v7, cita literal: *"This is not a production-ready API. It is a reverse engineering project."* | El plan lo trata como motor estable. |
| **Requiere servidor de firma de terceros (Euler Stream)** | README `WebDefaults`: `tiktok_sign_url` "By default, this is Euler Stream"; FAQ: *"Signing is handled by a third-party signature server (Euler Stream) with free community rate limits; an API key raises those limits"*. Dependencia `EulerApiSdk==0.1.0` en `pyproject.toml`. | Rate limits + disponibilidad de un tercero en la ruta crítica del stream. |
| **Python >= 3.10** (classifiers 3.10–3.13) | `pyproject.toml` | Python 3.12 es la elección correcta; 3.14 no está declarado. |
| **Deps pesadas y con pin estricto** | `betterproto2==0.9.1`, `TikTokLiveProto==0.2.2`, `protobuf>=3.19.4`, `protobuf3-to-dict`, `httpx`, `websockets_proxy`, `ffmpy` | Congelar esto con PyInstaller es delicado (codegen dinámico de betterproto2). |
| **API v7 rompió nombres** | README: *"In v3 the canonical `Gift` field names are `name`, `type`, and `image`"*; `gift_name`/`gift_type`/`gift_image` son **aliases legacy**. `gift.type == 1` = streakable. `event.repeat_end == 1` (**int, no bool**). Helper `event.streaking`. | El modelo de regalos del plan (§18) y el esquema de evento (§5) usan los nombres viejos y un `repeat_end` booleano. |
| **No existe `combo_id` en TikTokLive** | El README describe streaks vía `repeat_count` + `repeat_end` + `streaking`, sin identificador de combo. | El plan inventa `"combo_id": "abc123"` en §5 como si viniera de TikTok. El adapter debe **sintetizarlo**. |
| **`fetch_gift_info=True` es necesario para metadatos de regalos** | README: `gift_info` se obtiene al conectar con ese flag, cacheado en `client.gift_info`. | Sin esto no hay `diamond_value` ni imagen fiables. |
| **Muchos más eventos de los que el plan modela** | README lista `LiveEndEvent`, `LivePauseEvent`, `LiveUnpauseEvent`, `ControlEvent`, `ImDeleteEvent` (moderador borra mensajes), `UnknownEvent`, `GoalUpdateEvent` (meta nativa de TikTok), `SubNotifyEvent`, `RoomUserSeqEvent`, batallas PK. | Faltan estados de stream, borrado de chat y colisión de nombres con "goal". |
| **`client.is_live()` existe** | README: *"It is considered inefficient to use the connect method to check if a user is live"* | El plan no lo usa: reconectar en bucle para esperar al LIVE quema rate limits. |
| **edge-tts es LGPLv3** (no GPL-3.0 como se repite) | `LICENSE` de rany2/edge-tts: *"The MIT license is used for `src/edge_tts/srt_composer.py` only. All remaining files are licensed under the LGPLv3."* | Menos grave de lo temido: proceso separado + atribución + oferta de fuentes es manejable. |
| **edge-tts es frágil por diseño** | Issue abierta #290: *"403 error is back/need to implement Sec-MS-GEC token"* — el servicio online de Microsoft cambia requisitos sin avisar. Además, uso comercial: respuesta oficial ambigua en Microsoft Q&A. | TTS puede morir a mitad de stream, y hay incertidumbre de uso comercial. |
| **Existe precedente Rust, pero está archivado** | `jwdeveloper/TikTokLiveRust`: **MIT**, último push 2024-08-31, `archived: true`, 45 ★. | No es un reemplazo listo, **pero sí una referencia MIT legalmente limpia** para escribir un provider nativo. |

---

## 2. Bloqueadores (P0) — decidir antes de la Fase 0

### P0-1 · Licencia AGPL de TikTokLive

**Problema.** El plan asume implícitamente que TikTokLive es una dependencia normal. No lo es: AGPL-3.0 (modificada) es copyleft fuerte. Un instalador que incluye el sidecar distribuye código AGPL.

**Matices a favor (importantes).** Esa licencia **no es AGPL estándar**: añade Secciones 18–21 con una *library-integration exception*, un *SaaS/relay carve-out* y *excepted parties*. Eso sugiere que el autor quiso permitir precisamente el uso como componente dentro de otro software. **No pude leer el texto exacto** (la descarga del `LICENSE` de 37 KB falló por error TLS en esta máquina), así que esto **no es una opinión legal** y hay que leerlo antes de distribuir.

**Mitigaciones, de menos a más costosa:**

1. **Herramienta personal, código abierto bajo AGPL**: la ruta sin fricción. El repo se publica, se cumple la licencia, nadie reclama.
2. **Sidecar como proceso separado + obras separadas**: mantener TikTokLive en un **ejecutable aparte**, comunicado por IPC (que ya es el diseño), sin enlazarlo; incluir `LICENSE` completo, `THIRD_PARTY_NOTICES.md`, y oferta de fuentes. Es la posición más defendible sin abrir todo el código, pero es *gray area* si se empaqueta dentro de un mismo instalador.
3. **No usar TikTokLive**: consumir la WebSocket API comercial de Euler Stream (pago), o escribir un provider propio en Rust tomando `TikTokLiveRust` (MIT) como referencia.
4. **Abrir toda la app bajo AGPL**. Para un panel de streamer esto no cuesta nada real y elimina el problema entero.

**Acción obligatoria:** leer `LICENSE` completo de TikTokLive y decidir entre (1)/(3)/(4). Añadir `cargo-deny` con política de licencias al CI para que esto no vuelva a pasar desapercibido.

---

### P0-2 · La pieza central es la más frágil y depende de un tercero

**Problema.** El plan pone la fiabilidad del producto en la única dependencia que:
- se autodeclara *no production-ready* y de *reverse engineering*,
- firma sus conexiones contra un **servidor de terceros con rate limits comunitarios gratuitos**,
- y cambia su API entre versiones mayores (v6 → v7 ya renombró campos de `Gift`).

**Riesgos concretos para un stream real:**
- `SignatureRateLimitError` / 429 al conectar (issue #306 del propio repo).
- Cortes de TikTok a mitad de stream, con campos que desaparecen del esquema proto (*"Only events whose proto messages are present in v3 are emitted; if you don't see one you used to rely on, it's because TikTok removed it"*).
- Bloqueo por IP/región en el scraping de `@usuario/live`.

**Mitigaciones exigibles en el diseño:**
1. `is_live()` antes de conectar; nunca bucle de `connect()` para esperar al LIVE.
2. Backoff exponencial **con jitter** y tope de intentos; estado explícito `WAITING_FOR_LIVE` (el plan §9 no lo tiene).
3. Rate limiting propio de conexiones (p. ej. máximo 1 intento cada 30 s, y pausa de 10 min tras N fallos de firma) para no auto-bloquearse.
4. Estimar el techo de rate limits **en la Fase 1**, no en la 12, y decidir entonces si se paga API key de Euler Stream. Si el proyecto aspira a uso comercial, presupuestarlo desde ya.
5. Un flag `--record` en el provider que vuelque eventos crudos a fixtures: convierte §58 (contract tests) en algo práctico y da capacidad de reproducir incidentes reales.

**Spike recomendado (1–2 días, antes de Fase 1):** conectar en Rust puro (firma HTTP → `room_id` → WebSocket → decodificar `Comment`/`Gift`), usando `TikTokLiveRust` (MIT) como referencia. Si sale, se elimina Python del camino crítico, desaparece el problema de empaquetado de P0-3, baja el RAM y bajan los procesos. Si no sale, se documenta y se sigue con el sidecar con la conciencia tranquila.

---

### P0-3 · Empaquetar Python: es una decisión de producto

**Problema.** Hoy no hay Python en la máquina (solo el alias de la Store). El plan §7 dice "sidecar Python" como si fuera gratuito. En producción implica una de estas tres rutas, con costes muy distintos:

| Ruta | Tamaño añadido | Arranque | Riesgos |
|---|---|---|---|
| **PyInstaller `--onefile`** | ~40–60 MB | **2–6 s** (extrae a `%TEMP%` en cada arranque) + escaneo del antivirus | Falsos positivos de AV frecuentes; `betterproto2` con codegen dinámico puede requerir hooks |
| **PyInstaller `--onedir`** | ~40–60 MB | ~0.5–1 s | Recomendado si se congela; se lanza por ruta, no como `externalBin` |
| **Intérprete embebido** (`python-build-standalone` + venv propio, instalado con `uv`) | ~50–80 MB | ~0.3 s | Interprete real y wheels reales; puede `pip install` en runtime |

**Recomendación: intérprete embebido + venv, no freeze.** Motivos decisivos:

1. **Hace viable la estrategia de updates §10.** Con un intérprete real, actualizar TikTokLive es **reemplazar un wheel** (y validar con los contract tests), sin recompilar ni republicar la app. Con PyInstaller, cada actualización de TikTokLive obliga a un rebuild completo del sidecar y a revalidar todo.
2. **Evita la fragilidad de congelar protobuf/betterproto2.**
3. Un `uv.lock` o `requirements.lock` da reproducibilidad real de la cadena de dependencias.

**Nota de Tauri:** `externalBin` exige **un binario único con sufijo de target triple** (`tiktok-provider-x86_64-pc-windows-msvc.exe`). Un árbol onedir o un venv **no** encajan en `externalBin`: hay que empaquetarlos como `resources` y lanzarlos resolviendo `BaseDirectory::Resource`. Documentarlo ahora evita una tarde perdida después.

**Detalles de proceso obligatorios en Windows (el plan §9 no los menciona):**
- `CREATE_NO_WINDOW` (0x08000000) al lanzar el sidecar, o parpadeará una consola.
- **Job Object con `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**: `kill_on_drop` de Tokio **no mata nietos**; un `onefile` de PyInstaller sí crea un hijo → sidecar huérfano (§73 lo pide, pero no basta con lo que el plan propone).
- `PYTHONIOENCODING=utf-8`, `PYTHONUNBUFFERED=1` / `-u`, y **stderr exclusivamente para logs**: un solo `print()` a stdout corrompe el protocolo JSONL.
- Guarda de longitud máxima de línea en el lector de Rust (una línea gigante = OOM del core).

---

### P0-4 · SQLite en `Documents` (riesgo real en esta máquina) y sin instancia única

**P0-4a — Ubicación de la base de datos.** El workspace es `C:\Users\ISAAC\Documents`, típicamente sincronizado por OneDrive. **WAL + carpeta sincronizada = corrupción y bloqueos** (el sync copia `-wal`/`-shm` a medias). El plan §33 fija `data/dashboard.db` sin decir dónde.

**Corrección:** `%LOCALAPPDATA%\<app>\data\dashboard.db` vía `app_data_dir()` de Tauri. Nunca Documents, nunca una ruta sincronizada. Los backups (§75) también fuera del sync, y hechos con la API de backup de SQLite, no copiando el archivo.

**P0-4b — Sin guarda de instancia única.** Dos instancias de la app = dos servidores en el puerto 7878 (conflicto), dos escritores sobre la misma DB y eventos duplicados en OBS. El plan no lo menciona en ninguna sección.

**Corrección:** `tauri-plugin-single-instance` (enfoca la ventana existente), y port binding con fallback si 7878 está ocupado (persistir el puerto elegido para que las URLs de OBS no cambien entre arranques).

---

## 3. Correcciones de arquitectura (P1) — afectan al código desde el día 1

### P1-1 · El dashboard no debería ir por WebSocket propio

§29–§31 enrutan **todo** (dashboard + OBS) por el mismo WebSocket local de Axum. Eso mete un stack TCP + HTTP + serialización JSON en la ruta de UI, y acopla el dashboard a que el servidor HTTP esté vivo.

**Corrección:** dos canales con contratos distintos:

| Consumidor | Transporte | Motivo |
|---|---|---|
| Dashboard (React en Tauri) | **`tauri::ipc::Channel`** para streams de alta frecuencia + `emit` para eventos dispersos | IPC nativo, sin puerto, sin handshake; Tauri 2 soporta canales de streaming Rust→JS |
| Overlays OBS | **WebSocket** en Axum | Es lo único que OBS Browser Source entiende |

Beneficio colateral: se puede desarrollar y testear todo el dashboard **sin** arrancar el servidor HTTP, y un fallo en Axum no tumba la UI.

Además, la UI necesita un mecanismo explícito de **snapshot + delta** al abrir cada página (últimos 100 chats, top 10, meta actual). El plan §39 dice qué datos, pero no cómo se piden: definir `state.snapshot` (invoke) antes de suscribirse al canal evita ventanas inconsistentes y renderizados parciales.

### P1-2 · El presupuesto de procesos del plan es irreal

§7 promete "el menor número posible de procesos". La cuenta real en Windows:

| Componente | Procesos |
|---|---|
| Rust core + Tauri | 1 |
| **WebView2** (browser, gpu, renderer, utility, crashpad) | **4–8** (es Chromium multiproceso, aunque Tauri no lo *empaquete*) |
| Sidecar provider | 1 (+1 si es onefile) |
| **Cada Browser Source de OBS** | **1+ renderer CEF** |

Con los **8 overlays** de §29 → ~8 renderers CEF extra, todos dibujando sobre el canvas del stream, más RAM de GPU. Esto es lo contrario de "ligero".

**Corrección:**
- **Consolidar overlays a 2 fuentes como máximo**: una de "eventos/alertas" y una de "información persistente" (chat + metas + ranking compuestos), seleccionando la vista por query param (`/overlay?view=goals`). Menos procesos, y una sola conexión WS.
- En OBS: `Shutdown source when not visible` **sí**, pero `Refresh browser when scene becomes active` **solo si** el overlay re-pide snapshot al conectar (lo cual hay que implementar de todas formas). FPS de Browser Source a **30**, no 60.
- Los overlays deben ser **stateless**: al conectar, piden snapshot por WS y se pintan; así un refresh de OBS nunca pierde estado.
- Definir el presupuesto de RAM como **gate numérico** (ver P1-8).

### P1-3 · Los 12 defectos concretos de diseño

| # | Sección | Defecto | Corrección |
|---|---|---|---|
| 1 | §5, §18 | `combo_id` se presenta como campo de TikTok. **No existe en TikTokLive.** | Sintetizarlo en el adapter: `combo_id = f"{user_id}:{gift_id}:{streak_start_ms}"` |
| 2 | §5, §18 | `repeat_end` modelado como booleano. En v7 es **`int`** (`== 1`). | Normalizar a bool en el adapter, validado por contract test |
| 3 | §5, §18 | Uso de `gift_name`/`gift_image` (aliases legacy v2). | Usar `gift.name`/`gift.image` (v3 canónico); el adapter traduce |
| 4 | §5 | El evento **no tiene `event_id` ni `seq`**. | Añadir `event_id` (dedupe/idempotencia) y `seq` monótono por stream (detección de huecos) |
| 5 | §5 | El sidecar envía `stream_id` (identidad **de Rust**). | El sidecar envía `room_id`; **Rust** lo mapea a su propio `stream_id` |
| 6 | §21, §23, §37 | Confusión **coins vs diamonds**: "COINS 6420/10000" pero el dashboard muestra "Diamonds 8430". Son unidades distintas (lo que gasta el viewer vs lo que gana el creador). | Una sola unidad canónica (`diamond_count`, lo que reporta TikTok) + "coins (estimado)" como valor **derivado y configurable**, nunca persistido como métrica |
| 7 | §18 | `diamond_value` se toma del evento, pero requiere `fetch_gift_info=True` y el catálogo es **por sala** y cambia. | Catálogo local versionado (JSON/SQLite) con fecha de vigencia + refresh + fallback al valor del evento. **No recalcular históricos** con valores nuevos |
| 8 | §15, §14 | Imposible de cumplir: cooldown 20 s + queue 10 + chat real → **sobresuscripción de 6–90x** sobre la capacidad de TTS (ver P1-7) | Cooldown por usuario **y** token bucket global; política de descarte explícita; aging para evitar starvation |
| 9 | §26, §27 | Metas/recompensas sin **idempotencia**. Un replay tras reconexión puede completar una meta dos veces y disparar la recompensa dos veces | Clave de idempotencia `(goal_id, completion_seq)` + índice único en `reward_events` + persistir "ejecutado" antes de la acción |
| 10 | §20 | "Rankings incrementales" sin **persistencia de agregados**: week/month/all-time no se pueden calcular incrementales en memoria tras un reinicio | Tablas rollup (`user_gift_daily`) + mapas en memoria solo para la sesión + reconciliación al arrancar |
| 11 | §28 | Alertas con propiedades pero **sin cola**: sin límite de concurrencia, cooldown por tipo ni backlog máximo | Cola serializada (concurrencia 1), cooldown por tipo, prioridad con preempción, descarte con contador |
| 12 | §34 | `users` sin clave canónica ni historial de alias (el `unique_id` de TikTok **cambia**) | PK = id numérico de TikTok + tabla de alias; los rankings se agregan por id canónico |

### P1-4 · El protocolo necesita 6 campos más y un modelo de combo correcto

Esquema propuesto (v1, compatible con lo que el plan quiere pero sin sus defectos):

```json
{
  "protocol_version": 1,
  "event_id": "7412345678901234567",
  "seq": 1043,
  "type": "gift.received",
  "timestamp_ms": 1790000000000,
  "provider": { "name": "tiktoklive", "version": "7.0.1" },
  "room_id": "7412345678901234567",
  "user": { "id": "123456", "unique_id": "carlos123", "nickname": "Carlos", "avatar_url": "https://..." },
  "gift": {
    "id": "5655",
    "name": "Rose",
    "image_url": "https://...",
    "diamond_count": 1,
    "streakable": true,
    "is_final": true,
    "repeat_count": 25,
    "combo_id": "123456:5655:1790000000000"
  }
}
```

Reglas que el adapter debe garantizar (y que los contract tests deben verificar):

- `is_final = true` **solo** para el último evento de un streak (`repeat_end == 1`) — equivalente a `not event.streaking`.
- Regalos **no streakables** (`gift.type != 1`) → `is_final = true` y `repeat_count` real del evento; no se fusionan en un combo.
- **Timeout de flush**: si no llega `repeat_end` en N segundos (p. ej. 5 s), el tracker cierra el combo igualmente. `repeat_end` **no está garantizado** (desconexión, cierre del viewer, pérdida de paquete).
- `gift` puede venir **`None`** → el adapter debe descartar el evento sin romper (§ el propio README lo contempla).
- **Dedupe obligatorio** por `event_id` con LRU acotada: en reconexión TikTok puede reenviar mensajes y duplicar diamantes en rankings y metas.
- `likes`: definir **absoluto** (`total_like_count` monótono) y calcular el delta en Rust. El plan nunca dice si son absolutos o incrementales, y de eso depende toda la aritmética de metas.
- `viewers`: viene de `RoomUserSeqEvent`, es **grueso** (no hay joins/leaves por usuario). Documentarlo para no prometer precisión.
- Añadir tipos que el plan ignora y que afectan a la UI: `chat.message.deleted` (`ImDeleteEvent`), `stream.paused` / `stream.resumed` / `stream.ended` (`LivePause/LiveUnpause/LiveEnd`), y `event.unknown` (passthrough de `UnknownEvent` con payload hash → oro para los contract tests cuando TikTok añada tipos).
- **Colisión de nombres**: TikTok tiene su propio `GoalUpdateEvent` (meta nativa de suscriptores/seguidores). Nuestro Goal Engine es otra cosa → el adapter debe emitir `tiktok.goal.updated` o descartarlo. Nunca `goal.updated`.

### P1-5 · Un solo sidecar, no dos

§7 propone sidecar TikTok y sidecar TTS, con la sugerencia tímida de "idealmente reutilizar el runtime". **Recomendación firme: un único sidecar Python** con dos módulos (tiktok, tts) en el **mismo event loop asyncio**, porque:

- TikTokLive y edge-tts son ambos asyncio: cero coste de convivencia.
- Un proceso y ~50–80 MB menos (o ~40–60 MB si se congela).
- La **cola TTS vive en Rust** y la **reproducción también**, así que si el sidecar muere, el stream no se queda sin audio: solo se pausa la síntesis y el supervisor lo reinicia. El desacoplamiento ya está garantizado por el diseño, no hace falta separar procesos para lograrlo.
- Actualizar edge-tts o TikTokLive = actualizar el mismo venv.

### P1-6 · edge-tts no puede ser el único motor TTS

Ya pasó y volverá a pasar: el issue #290 documenta que el servicio de Microsoft empezó a exigir el token `Sec-MS-GEC` y **todo el mundo dejó de tener TTS de golpe**. Un fallo así, en directo, no tiene recuperación posible si no hay alternativa local.

**Corrección:** implementar **dos** providers desde el principio, no "en el futuro":
- `EdgeTtsProvider` (nube, buena calidad, requiere red).
- `PiperProvider` (**local, offline, MIT en el motor**, RTF bajo, voces ONNX) como **fallback automático** cuando edge-tts falle o el usuario lo elija.

⚠️ Verificar la licencia **de cada voz** de Piper por separado: hay voces con licencias no comerciales aunque el motor sea MIT.

Además:
- Los 403 de Edge son a menudo por **desfase de reloj del sistema** → chequeo de skew de reloj al arrancar y aviso claro al usuario.
- **No lanzar un proceso por frase**: un único stream de audio persistente (`rodio`/`cpal`) con selección explícita de dispositivo (esto además permite rutear TTS a un cable virtual para que OBS lo capture aparte — relevante en esta máquina, que ya usa Voicemeeter).
- **Empezar a reproducir con el primer chunk** de edge-tts en lugar de esperar el MP3 completo: reduce la latencia percibida a la mitad.
- Cancelación real de la síntesis en vuelo al hacer "skip" (aiohttp/asyncio cancel), o el skip seguirá leyendo lo cancelado.

### P1-7 · La aritmética del TTS no cierra

Datos del plan: `max_chars: 150`, `queue_max: 10`, `user_cooldown: 20 s`.

Estimación de capacidad real: sintetizar 60 caracteres con edge-tts tarda ~0.4–1.5 s (red + servicio) y su reproducción dura ~2–4 s → **capacidad efectiva ≈ 0.25–0.4 frases/s**.

Demanda con cooldown de 20 s por usuario:

| Sala | Mensajes/s | Frases elegibles/20 s | Demanda | Sobresuscripción |
|---|---|---|---|---|
| Pequeña | 2 | 40 | 2/s | **~6x** |
| Mediana | 10 | 200 | 10/s | **~30x** |
| Grande | 30 | 600 | 30/s | **~90x** |

Con `queue_max: 10` y prioridades §14, la consecuencia real es que **el chat normal (prioridad 10) nunca se lee** y la cola se llena de regalos: exactamente el "starvation indefinido" que §14 prohíbe.

**Corrección:** tres capas, no dos:
1. **Cooldown por usuario** (ya previsto).
2. **Token bucket global** configurable (p. ej. 1 frase cada 3–5 s, ráfaga 3) — la pieza que falta.
3. **Admisión por prioridad con aging**: reservar ~20 % de la cola para prioridad baja, y subir la prioridad efectiva +1 por cada 10 s de espera.

Además, el descarte debe ser un **contador visible en la UI** ("142 mensajes descartados"), no un silencio invisible: el streamer necesita saber por qué no se lee el chat.

### P1-8 · El "presupuesto de rendimiento" no es medible

§45 y §71 dicen "idealmente muy bajo", "comparar baseline vs test", sin **un solo número**. Eso no es un gate, es un deseo: no se puede aprobar ni rechazar una release con ello.

Propuesta de gates concretos (a ajustar tras la primera medición real, pero deben existir):

| Métrica | Idle (conectado, chat tranquilo) | Carga (100 msg/s + 50 regalos/s) |
|---|---|---|
| CPU total (proceso + WebView2 + sidecar) | **< 1.5 %** de un núcleo, media 5 min | < 15 % de un núcleo, sin picos > 300 ms |
| RAM total (RSS sumado) | **< 250 MB** | < 400 MB, **estable** |
| Crecimiento de RSS | **< 5 MB/hora** | < 5 MB/hora |
| Mensajes WS/segundo | ~0 (sin timers activos) | **< 100/s** (coalescing funcionando) |
| Latencia de escritura DB | p95 < 5 ms | p95 < 20 ms |
| Impacto en frame time del juego | **< 1 % en 1 % lows** | < 3 % |
| Timers activos en idle | **0** (todos los tickers se detienen cuando no hay eventos) | — |

> **Actualización (2026-09-17, tras el Milestone 1):** medido en la aplicación real, el gate de
> **CPU se cumple con holgura** (0,00 % de un núcleo en reposo) pero el de **RAM no**: 372 MB
> totales en build de debug, de los cuales 331 MB son los **6 procesos de WebView2**. Es
> exactamente el riesgo P1-2 de este documento. Antes de fijar el gate definitivo hay que
> (a) medir en release, (b) usar memoria privada en lugar de sumar RSS —que cuenta la memoria
> compartida varias veces— y (c) tomar como línea base una aplicación Tauri vacía en esta misma
> máquina. Detalle en `docs/milestone-1.md` §2.

Instrumentación necesaria: **PresentMon** para frame time y 1 % lows (es la herramienta correcta, no FRAPS ni métricas internas), contadores propios en Rust (profundidad de colas, descartes, lagged, clientes WS, latencia de DB, reinicios de sidecar, latencia de síntesis TTS) expuestos en `/health` y visibles en la página **Developer**. Guardar la línea base en `tests/performance/baseline.json` y **fallar el CI/la release si se degrada** — si no, el gate se erosiona en dos semanas.

**Regla transversal que falta en §46:** todo ticker (coalescing de likes/viewers, notificador de ranking, refresco de stats) debe **detenerse cuando no hay eventos** y reanudarse al primero nuevo. Un `interval` de 1 Hz perpetuo ya rompe el presupuesto de idle.

### P1-9 · Faltan funciones de alto valor y bajo coste

| Falta | Por qué importa | Coste |
|---|---|---|
| **Hotkeys globales** (skip/pausa TTS, silenciar, TTS on/off) | El streamer está **en el juego**; sin hotkey tiene que hacer alt-tab para saltar un TTS atascado | Bajo (`tauri-plugin-global-shortcut`) |
| **Página de diagnósticos** | Sin métricas no se puede cumplir §45 ni depurar un stream en vivo | Bajo (reutiliza los contadores de P1-8) |
| **Control de OBS por WebSocket** (`obs-websocket` v5 vía `obws`) | "Cambiar de skin/escena" es la recompensa más pedida y el plan solo tiene acciones locales (alerta, sonido, TTS) | Medio — dejarlo como `RewardAction::ObsScene` tras feature flag, con credenciales en DPAPI |
| **Replay de un stream desde la DB** | El simulador genera eventos sintéticos; reproducir un stream real grabado es lo que de verdad reproduce bugs | Bajo si se implementa el `--record` de P0-2 |
| **Retención/PII** | Se guarda chat de terceros indefinidamente; §34 no define retención | Bajo (job de purga configurable) |

### P1-10 · Seguridad del servidor local

§54 acierta con `127.0.0.1` (y además, ventaja práctica: **no dispara el aviso del Firewall de Windows**, a diferencia de `0.0.0.0`). Falta lo siguiente:

- **Token por instalación en la URL del overlay** (`/overlay/chat?t=<token>`): un WebSocket en loopback sin autenticación lo puede abrir **cualquier página web** que el usuario visite (DNS rebinding / CSRF), y leería el chat del stream.
- **Validación de Origin** con excepción para `null` (OBS envía Origin nulo) → por eso el token es la defensa principal, no el Origin.
- Sin TLS: correcto, y documentar por qué.
- Si algún día se habilita modo LAN (§54 lo menciona), debe ser **opt-in explícito**, con aviso de firewall y sin exponer el token en la UI.

### P1-11 · Actualizaciones y arranque

- **Nunca auto-actualizar durante un LIVE** (§62 no lo contempla): descargar sí, aplicar al cerrar o con el stream parado. Un reinicio a mitad de directo es un incidente.
- **Recuperación de crash (§74)**: al arrancar, detectar stream sin `ended_at`, cerrarlo con una marca `crashed: true` y **reconciliar** metas y rankings desde la DB antes de aceptar eventos nuevos. El plan dice "detectar" pero no "reconciliar", que es lo que evita contadores raros.
- **Migraciones (§76)**: correcto, pero falta la práctica de **backup automático antes de migrar** (§75 lo dice: hacerlo obligatorio en el código, no opcional).

### P1-12 · Añadidos al CI (§60)

Faltan: `cargo-deny` (**imprescindible aquí**: política de licencias + advisories), `cargo-audit`, `ruff` + `mypy` para el provider, `uv lock` para reproducibilidad, `vitest` para el frontend, y un **job de canario** programado que conecte a una sala pública real y verifique que llega al menos un evento de cada tipo (lo único que detecta que TikTok cambió algo antes de que lo detecte un streamer). Este último no puede bloquear un PR, pero sí debe abrir un issue automáticamente.

---

## 4. Detalles que el plan hace bien y hay que proteger

1. **JSONL por stdin/stdout en vez de FastAPI**: correcto. Sin puertos, sin servidor, reiniciable, trivial de loguear. Añadir solo el guardarraíl de longitud máxima de línea.
2. **Rechazar Electron**: correcto en tamaño de instalador y en integración nativa.
3. **SQLite + WAL + writer dedicado + batching**: correcto. Añadir `synchronous=NORMAL`, `busy_timeout`, `foreign_keys=ON`, `rusqlite` con feature `bundled` (no depender del SQLite del sistema), y ejecutar las llamadas bloqueantes de `rusqlite` en un hilo dedicado / `spawn_blocking` — "no bloquear el hilo de UI" (§36) no basta: tampoco se deben bloquear los hilos worker de Tokio.
4. **Coalescing de likes/viewers** (§49) y **colas acotadas** (§48): correcto, y son las dos decisiones que más van a salvar el rendimiento.
5. **Simulador obligatorio** (§55): correcto. Implementarlo como **una implementación más del trait `TikTokProvider`** (`SimulatedProvider`), no como una ruta de inyección aparte: así §55 ("exactamente el mismo flujo") se cumple **por construcción**, no por disciplina.
6. **Fixtures + contract tests** (§58) y **no auto-merge si fallan** (§59): correcto y poco común. Es la mitigación más valiosa contra P0-2.
7. **La lista de §69 (qué NO hacer)** y el **orden de milestones de §87**: acertados. Solo cambiaría que el esqueleto de DB entre en el Milestone 1 (ver §8).
8. **§86 (las 10 preguntas antes de añadir una función)**: es la mejor sección del documento. Mantenerla como checklist de PR.

---

## 5. Cómo debería verse el árbol de decisión de providers

```
TikTokProvider (trait, en Rust)
├── TiktokLiveSidecarProvider   ← plan actual; Python + JSONL; AGPL; frágil pero completo
├── RustNativeProvider          ← spike P0-2; usa el servidor de firma; MIT de referencia
├── EulerStreamWsProvider       ← comercial; sin reverse engineering; coste mensual
└── SimulatedProvider           ← obligatorio; usado por dev y por el replay de DB

TtsProvider (trait, en Rust)
├── EdgeTtsProvider             ← nube; calidad alta; puede caer (Sec-MS-GEC)
├── PiperProvider               ← local/offline; fallback automático; voces con licencia variable
└── (futuro) ElevenLabsProvider
```

El trait debe existir **desde el Milestone 1** y debe incluir `health()`, `status()`, `connect()`, `disconnect()` y un stream de eventos normalizados — como propone §11 — pero con una diferencia importante: **`SimulatedProvider` no es opcional ni "de desarrollo"**; es la implementación contra la que se testea el core en CI, porque es la única reproducible.

---

## 6. Ajustes al modelo de datos

Además de las correcciones de P1-3:

```sql
-- Unidad canónica y catálogo versionado de regalos
gift_catalog(gift_id, name, image_url, diamond_count, currency, valid_from, valid_to, source)

-- Identidad: el unique_id cambia
users(user_id PK, unique_id, nickname, avatar_url, first_seen, last_seen)
user_aliases(user_id, unique_id, seen_at)

-- Idempotencia: nunca procesar dos veces la misma recompensa
reward_events(id, reward_id, trigger_event_id, goal_id, executed_at)
  UNIQUE(reward_id, goal_id, trigger_event_id)
event_dedupe(event_id PK, seen_at)   -- LRU con purga, no crece sin límite

-- Rollups para week/month/all-time sin escanear eventos
user_gift_daily(user_id, day, gift_count, diamond_total, UNIQUE(user_id, day))

-- Retención
comments(..., deleted_at)            -- ImDeleteEvent -> tombstone, no borrado físico
retention_policy(table_name, keep_days)
```

Y dos reglas de escritura: **transacción por lote** (p. ej. 200 filas o 250 ms, lo que ocurra primero) y **política de descarte por clase de evento**:

| Clase | Política si la cola de DB está llena |
|---|---|
| Comentarios (persistencia) | **Descartable**, contabilizado |
| Likes / viewers | **Descartable** (se agregan) |
| **Regalos, follows, metas, recompensas** | **Nunca descartar**: bloqueo con timeout; si expira, marcar la sesión como `degraded` y avisar visiblemente |

---

## 7. Milestones revisados (cambios sobre §87)

| # | Nombre | Cambios respecto al plan |
|---|---|---|
| **M0** | **Decisiones y spike** | Leer licencia AGPL; decidir ruta de distribución; spike de provider Rust (1–2 días); spike de arranque del sidecar con intérprete embebido |
| **M1** | Conexión ligera | **+ esqueleto de DB con migraciones y tabla `streams` desde el inicio** (si no, los ids de sesión se inventan dos veces), **+ guarda de instancia única**, **+ job object para el sidecar**, **+ `SimulatedProvider` como trait real**, **+ contadores de diagnóstico** |
| **M2** | Event bus + Chat | **+ servidor Axum/WS y snapshot stateless** (aunque solo haya un overlay de chat): el contrato WS se valida aquí, no se retrofitea en M5 |
| **M3** | TTS | **+ Piper como fallback desde el principio**, **+ token bucket global**, **+ selección de dispositivo de audio**, **+ hotkeys**, **+ caché con TTL y tope de tamaño** |
| **M4** | Regalos + Combos + Rankings | **+ catálogo versionado de regalos**, **+ dedupe por `event_id`**, **+ rollups diarios** |
| **M5** | Metas + Recompensas | **+ idempotencia de recompensas**, **+ reconciliación al arrancar**, **+ cola de alertas serializada** |
| **M6** | Overlays OBS | **2 fuentes como máximo**; medir RAM/GPU por fuente antes de añadir una tercera |
| **M7** | Estadísticas | + retención/PII configurable |
| **M8** | Performance Pass | **+ gates numéricos de §45 convertidos en tests con línea base** |
| **M9** | Packaging | **+ intérprete embebido + venv (no freeze)**, + firma de código, + instalador NSIS/MSI |

---

## 8. Riesgos residuales que no se pueden eliminar

1. **TikTok cambia la firma y el provider se rompe** hasta que el upstream publique fix. Mitigación: provider sustituible, fixtures, canario, y un modo "solo overlays locales" que siga sirviendo para practicar.
2. **`FollowEvent` es poco fiable** en TikTok (los follows a veces no llegan). Las metas de followers (§25) van a **subcontar** y no hay forma de arreglarlo desde fuera. Documentarlo en la UI de la meta.
3. **Viewers es una cifra gruesa** (`RoomUserSeqEvent`, cada varios segundos). No prometer precisión ni histórico fino.
4. **El catálogo de regalos y sus valores en diamantes** cambia por región y por tiempo. Nunca recalcular estadísticas históricas con valores nuevos.
5. **Uso comercial de edge-tts**: la respuesta oficial de Microsoft es ambigua y el servicio no es una API pública. Si el proyecto alguna vez se monetiza, Piper (o un TTS de pago) debe ser el motor por defecto.
6. **Falsos positivos de antivirus** si algún día se congela Python, y **SmartScreen** mientras el instalador no esté firmado.

---

## 9. Decisiones que necesito de ti antes de la Fase 0

1. **¿Distribución personal o producto/comercial?** Determina si el AGPL de TikTokLive es un problema real (personal → no lo es) o un bloqueador (comercial → hay que elegir entre abrir la app, pagar Euler Stream o reescribir en Rust).
2. **¿Estás dispuesto a comprar una API key de Euler Stream** si los rate limits gratuitos no alcanzan? Cambia el diseño del backoff y de la espera de LIVE.
3. **¿TTS offline obligatorio?** Si sí, Piper entra en M3 como motor de primera clase (no como fallback).
4. **¿Idioma de la UI?** El plan está en español con nombres de UI en inglés (§37). Hay que fijarlo antes de escribir componentes.
5. **¿Autorizas el spike del provider nativo en Rust (1–2 días)?** Es la única vía para que "ligero" sea literal y para eliminar Python del camino crítico; si prefieres velocidad de entrega, se va directo al sidecar.

---

## Anexo · Resumen de severidades

| Severidad | Ítems |
|---|---|
| **P0 (bloqueador)** | Licencia AGPL (P0-1) · Fragilidad y rate limits del provider (P0-2) · Empaquetado de Python (P0-3) · DB en Documents + sin instancia única (P0-4) |
| **P1 (arquitectura, antes de codificar)** | IPC vs WS para el dashboard · Presupuesto real de procesos · 12 defectos de diseño y protocolo · Protocolo incompleto · Un solo sidecar · edge-tts como único TTS · Aritmética de capacidad TTS · Gates numéricos e instrumentación · Hotkeys/diagnóstico/obs-websocket/replay · Seguridad del WS local · Updates y reconciliación · CI |
| **P2 (durante el desarrollo)** | Caché de imágenes de regalos · `content-visibility` y animaciones idle en overlays · i18n · retención PII · licencias por voz de Piper · code signing / SmartScreen |

**Lo que NO cambiaría del plan:** Rust como núcleo y fuente de verdad, JSONL sobre stdin/stdout, SQLite con writer dedicado, coalescing y colas acotadas, simulador obligatorio, fixtures y contract tests, el orden general de milestones, y §86 como checklist obligatoria de PR.
