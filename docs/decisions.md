# Decisiones del proyecto

Registro de decisiones tomadas por el usuario. Cada una condiciona el diseño; ninguna se reabre sin una decisión explícita nueva.

---

## D1 · Distribución: **personal** (2026-09-17)

**Decisión:** la aplicación es de uso propio. No se distribuye a terceros ni se comercializa.

**Consecuencias:**
- El AGPL modificado de TikTokLive (P0-1 de `plan-review.md`) **deja de ser bloqueador**: sin distribución no hay obligaciones de copyleft que cumplir.
- Se mantiene el sidecar como **proceso separado** (buena práctica y, si algún día se distribuye, es la posición más defendible).
- Aun sin obligación legal, se incluirá `THIRD_PARTY_NOTICES.md` con TikTokLive (AGPL-3.0 modificada), edge-tts (LGPLv3) y el resto: cuesta minutos y evita sorpresas si el proyecto cambia de alcance.
- Si en el futuro se quisiera distribuir, la decisión se reabre y las rutas están documentadas en `plan-review.md` §P0-1.

---

## D2 · Sin API key de Euler Stream (2026-09-17)

**Decisión:** no se paga API key. Se usan los **límites comunitarios gratuitos** del servidor de firma.

**Consecuencias (obligatorias en el diseño, no opcionales):**
- `is_live()` **antes** de conectar. Nunca usar `connect()` en bucle para esperar a que empiece el LIVE: cada intento consume cuota y puede acabar en bloqueo.
- Estado explícito `WAITING_FOR_LIVE` en la máquina de estados del provider.
- **Backoff exponencial con jitter**, máximo 1 intento cada 30 s, y pausa larga (≥ 10 min) tras N fallos consecutivos de firma (`SignatureRateLimitError` / 429).
- **Instancia única obligatoria** (P0-4b): dos instancias = dos conexiones consumiendo la misma cuota.
- Al agotar cuota: mensaje claro y accionable en la UI ("límite gratuito del servidor de firma alcanzado, reintento en X min"), **nunca** un bucle silencioso.
- Métrica visible de "conexiones consumidas / reintentos" en la página Developer.
- El host del servidor de firma será **configurable** (`tiktok_sign_url`), lo que permite cambiar a un servidor propio o a otro proveedor sin tocar código.

---

## D3 · TTS: edge-tts en español e inglés (2026-09-17)

**Decisión:** edge-tts como motor TTS, con voces **ES** y **EN**. No se implementa Piper por ahora.

**Consecuencias:**
- Catálogo curado de voces, al menos: `es-ES-ElviraNeural`, `es-ES-AlvaroNeural`, `es-MX-DaliaNeural`, `es-AR-ElenaNeural`, `en-US-AriaNeural`, `en-US-GuyNeural`, `en-GB-SoniaNeural`. Selector de voz por perfil, con la posibilidad de **una voz por idioma** y detección automática de idioma del mensaje (heurística simple, configurable).
- Se mantiene el trait `TtsProvider` desde el día 1: añadir Piper después no debe requerir refactor.
- **Robustez obligatoria**, porque edge-tts ya se ha caído globalmente una vez (issue #290, token `Sec-MS-GEC`):
  - Comprobación de **desfase de reloj** al arrancar (el 403 de Edge suele ser skew de reloj) con aviso claro.
  - Reintentos con backoff y **aviso visible en la UI cuando el TTS está degradado** — el streamer debe saberlo antes de que lo note el chat.
  - Caché de audio con TTL y tope de tamaño (corta latencia y reduce llamadas al servicio).
- Reproducción en Rust con **un único stream de audio persistente** y selección explícita de dispositivo (permite rutear el TTS a un cable virtual para OBS).
- Token bucket global además del cooldown por usuario (P1-7 de `plan-review.md`): sigue siendo obligatorio, el motor no cambia la aritmética.

---

## D4 · Idioma de la UI: **español** (2026-09-17, por defecto)

**Decisión:** interfaz en español. Todos los textos en un único módulo de i18n (`src/i18n/es.ts`) para poder añadir inglés sin refactor.

**Consecuencias:** los nombres de las páginas del plan §64 (`chat`, `gifts`, `tts`, `goals`, `rankings`, `rewards`, `overlays`, `statistics`, `settings`, `developer`) se mantienen en inglés como identificadores de código, y su etiqueta visible va en español ("Regalos", "Metas", "Rankings", "Recompensas", "Overlays", "Estadísticas", "Ajustes", "Desarrollador").

---

## D5 · Spike del provider TikTok nativo en Rust: **autorizado** (2026-09-17)

**Decisión:** se autoriza el spike de 1–2 días antes de comprometerse al sidecar Python.

**Objetivo del spike:** demostrar sin ambigüedad las cuatro etapas — resolver `room_id`, obtener la URL firmada del servidor de firma gratuito, conectar por WebSocket, y **decodificar protobuf** de comentarios y regalos — midiendo además el consumo real (CPU/RAM) del proceso.

**Criterios de éxito:**
| Etapa | Éxito | Fallo |
|---|---|---|
| 1. `room_id` | Se resuelve para un `@usuario` | → sidecar Python |
| 2. Firma | URL firmada obtenida sin API key | → sidecar Python |
| 3. WebSocket | Conecta y recibe frames | → sidecar Python |
| 4. Decodificación | Comentarios **y** regalos legibles con `repeat_count`/`repeat_end` correctos | → sidecar Python |

**Regla:** si el spike falla, se documenta el motivo exacto y se pasa al sidecar Python sin más debate. Si el spike tiene éxito, el provider nativo pasa a ser la ruta por defecto y Python queda **solo** para TTS.

---

## D6 · Restricciones del entorno detectadas (2026-09-17)

Hechos verificados que condicionan el desarrollo en esta máquina:

| Hecho | Evidencia | Implicación |
|---|---|---|
| **TLS schannel roto en procesos hijos confinados** | `curl` → `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`; PowerShell y `git` idénticos | Toda dependencia que use schannel falla en modo confinado |
| **cargo usa libcurl+schannel** | `cargo search` → `[35] SSL connect error` | `cargo` requiere permiso ampliado para descargar crates; luego `--offline` |
| **Node funciona** | `fetch` a api.github.com → **200** | npm/pnpm y todo el frontend no tienen problema |
| **MSVC + Windows SDK + WebView2 presentes** | Build Tools 17.14, SDK 10.0.26100, WebView2 145/153 | La cadena de compilación de Tauri está completa |
| `link.exe` en PATH apunta a Git, no a MSVC | `git\usr\bin\link.exe` | Vigilar si algún build script invoca `link` directamente |
| `uv` instalado, `pnpm` no | — | `corepack enable pnpm`; `uv` gestiona Python 3.12 |

**Decisión derivada:** usar **rustls** (no `native-tls`/schannel) en todo el proyecto. Motivos: funciona en este entorno y además evita depender del almacén de certificados de Windows, lo que reduce sorpresas en las máquinas de otros usuarios si el proyecto se comparte.

---

## D7 · Flujo de trabajo verificado (2026-09-17)

Comprobado empíricamente, no supuesto:

| Tarea | ¿Permiso ampliado? | Evidencia |
|---|---|---|
| **Descargar crates** (`cargo fetch`, `cargo add`) | **Sí** | crates.io inalcanzable con schannel; con acceso ampliado: 181 crates descargados |
| **Compilar Rust** (`cargo build --offline`) | **No** | 181 crates compilados y binario generado en modo confinado, 57 s |
| **Instalar Python/deps** (`uv python install`, `uv pip install`) | **Sí** | el sandbox deniega el wheel de `protobuf3-to-dict` al subproceso de build |
| **Ejecutar Rust/Python** | **No** | — |
| **npm/pnpm** | **No** | Node usa OpenSSL, no schannel |

**Regla práctica:** *descargar* dependencias requiere permiso ampliado una vez; *compilar y ejecutar* no.

**Mecánica:**
- `CARGO_HOME` vive en `.tooling\cargo` (dentro del workspace) → el registro de crates queda accesible para builds offline confinados.
- `UV_PYTHON_INSTALL_DIR` = `.tooling\python`; venv en `.tooling\venv`.
- `UV_CACHE_DIR` = `%TEMP%\ttdash-build` (uv crea directorios temporales con permisos que el sandbox deniega dentro del workspace).
- uv avisa de que no pudo crear el shim en `~\.local\bin` ni las entradas de registro: **es esperado e inocuo**, siempre invocamos el Python del venv por ruta absoluta.
- Todo el flujo está encapsulado en `scripts/env.ps1` (dot-source) con `Invoke-CargoOffline` e `Invoke-CargoFetch`.

**Nada de esto afecta al usuario final:** son restricciones de este entorno de desarrollo. La aplicación distribuirá su propio intérprete y usará rustls, sin schannel.

---

## D8 · Resultado del spike Rust: viable (2026-09-17)

**Decisión:** el provider TikTok nativo en Rust pasa a ser la **ruta por defecto**. Python queda **solo** para `edge-tts`.

**Evidencia** (informe completo en `spikes/tiktok-rust-provider/REPORT.md`): 3 de 4 etapas validadas contra tráfico real — resolución de `room_id`, firma anónima sin API key, handshake WebSocket `101`, y decodificación de frames (`im_enter_room_resp`, envelope `msg` con cursor real, `hb`). La 4ª (comentarios y regalos reales) queda pendiente de una sala en directo.

**Consecuencias sobre el plan revisado:**

| Riesgo del plan | Estado tras el spike |
|---|---|
| P0-1 · AGPL de TikTokLive | **Eliminado**: no se usa ni se distribuye |
| P0-3 · Empaquetar Python para el provider | **Eliminado** para eventos; queda solo el sidecar TTS |
| P0-2 · Fragilidad del provider | **Reducido**: el código es nuestro; la dependencia del servidor de firma sigue |
| P1-2 · Presupuesto de procesos | **Mejorado**: un binario Rust en lugar de un intérprete Python |

**Restricciones nuevas, ahora cuantificadas:**

1. **Cuota anónima medida: 5/min, 30/h, 100/día.** Es un requisito duro: `WAITING_FOR_LIVE`, backoff con jitter, instancia única y contador visible de conexiones consumidas en la página Developer.
2. **La URL firmada caduca en ~30 s** → reconectar siempre exige firma nueva y consume cuota.
3. **Herramienta obligatoria de desarrollo: `--record` / `replay`.** Grabar frames y decodificarlos sin red es la única forma de iterar sin agotar la cuota diaria.
4. **No fiarse de los `.proto` de terceros.** El frame real tiene `service` y `method` como `uint64`; ninguna fuente MIT coincidía, y declararlos mal hace fallar el 100% de los frames de forma silenciosa. La validación de referencia son bytes reales grabados.

**Estado: CERRADO — las 4 etapas validadas en salas en directo reales.**

Medido en release con sesión en vivo: **RSS 9,4–9,8 MB estable**, CPU por debajo de la resolución de medida (< 0,3 % de un núcleo), binario de **3,14 MB**, decodificación a **1 630 frames/s**. Frente a **85,7 MB en disco** (venv 24,3 MB + intérprete CPython 61,4 MB) de la alternativa Python.

Correcciones que el spike aporta al modelo de combos propuesto en `plan-review.md`:

- **El `group_id` del propio `WebcastGiftMessage` ES el identificador del streak**, y es gratis. No hay que sintetizar un `combo_id`. Los regalos no acumulables llegan con `group_id=0`.
- El tracker debe indexarse por `group_id`, **no** por usuario+regalo: se observó a un mismo usuario con dos streaks abiertos intercalados de regalos distintos.
- Señal de cierre: `repeat_end != 0`; acumulable: `gift.type == 1`.
- `WebcastRoomUserSeqMessage.total`(3) son los **espectadores actuales** y `total_user`(7) los **acumulados** — al revés de lo que sugieren los nombres (verificado contra el `userCount` de TikTok).

Fixtures reales grabados como base de los contract tests: `spikes/tiktok-rust-provider/live.jsonl` (132 frames) y `live2.jsonl` (58 frames).

---

## D9 · El WebSocket exige `im_enter_room`: sin él no llega nada (2026-09-17)

**Síntoma:** el chat «no se actualizaba» en la interfaz. La conexión se establecía (`WebSocket conectado status=101`) y aparecían los 6 mensajes del arranque, pero **después, silencio absoluto**.

**Diagnóstico (medido, no supuesto):** en 150 s conectado a una sala en directo con actividad, `metrics.ws_frames = 0`. Los 6 comentarios no venían del WebSocket sino del **sobre de la respuesta firmada** (`signed.envelope.messages`). El servidor de firma devolvía:

```
push_server = wss://webcast-ws.eu.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/
need_ack=false  heartbeat_duration=0  is_first=true  route_params=4
```

Ese endpoint acepta el handshake y **no empuja nada** mientras el cliente no se suscriba. El cliente de referencia (`TikTokLive`) envía, en cuanto la respuesta trae `is_first=true`, un frame `payload_type="im_enter_room"` con `WebcastImEnterRoomMessage`. Nuestra app nunca lo enviaba: se conectaba y se quedaba escuchando un socket mudo.

**Arreglo:** enviar el frame `im_enter_room` tras conectar (solo si `is_first`), y latir con un `HeartBeatMessage{room_id, send_packet_seq_id}` real en vez de 4 bytes sueltos; el ACK reenvía `internal_ext` (o `"-"`) con `payload_encoding="pb"`.

**Números de campo:** v3 añade `live_region` en el tag 3 y **desplaza `live_id` al 4**. Se extrajeron de la metadata real de `TikTokLiveProto` con `spikes/provider-probe/dump_proto.py` (que ahora incluye estos dos mensajes). Es la enésima confirmación de la regla del proyecto: **ningún `.proto` de terceros, siempre la metadata instalada**.

**Evidencia (misma sala, 120 s, antes → después):**

| Métrica | Antes | Después |
|---|---|---|
| `ws_frames` | 0 | **169** |
| `chat_messages` | 6 (solo el sobre) | **26 en vivo** |
| `events_published` | 14 | **152** |
| likes · viewers · regalos · follows | 4 · 1 · 0 · 0 | **679 · 53 · 3 · 3** |

Lo que se registra ahora de serie: `sobre firmado recibido` (con `push_server`) y `peticion de entrada en la sala enviada`, una vez por conexión. El detalle por frame queda en `debug` (`RUST_LOG=dashboard=debug`) porque una sala grande escribe decenas de líneas por segundo.

## D10 · La lista del chat tiene que ser el contenedor que desplaza (2026-09-17)

**Síntoma secundario:** aun con el protocolo arreglado, en la página de chat los mensajes nuevos entraban **fuera de la vista**: la lista parecía congelada.

**Causa:** `ul.chat` se diseñó como contenedor (`flex: 1; min-height: 0; overflow-y: auto`) dentro de `.card`, y el autoscroll apunta a esa lista. Pero `Chat.tsx` era la **única** página que montaba su tarjeta directamente en `main` (todas las demás la envuelven en `.grid-panel`); `main` es un contenedor de bloque, así que `flex: 1` no hacía nada: la tarjeta crecía con el contenido, el que desplazaba era `main` —al que nadie mueve— y el autoscroll no tenía nada que desplazar.

**Arreglo:** la página de chat usa `.page-fill` (`display: flex; flex-direction: column; height: 100%; min-height: 0`), el alto queda acotado y la lista vuelve a ser el contenedor que desplaza.

**Evidencia** (instrumentación `ui_chat` + sonda del DOM, tráfico real, 30 mensajes):

| | `ul.chat` | `main` |
|---|---|---|
| Antes | `160/160 desborda=no` (crecía con el contenido) | `713/713`, scroller real sin nadie que lo mueva |
| Después | `595/798 top=203 desborda=si alFinal=si` | `713/713 top=0` |

`798 − 595 = 203` es exactamente el fondo: el autoscroll deja el mensaje nuevo a la vista.

**Diagnóstico permanente:** `Snapshot.ui_chat` (recibidos vs pintados, último seq, medida del DOM) se ve en la página Developer, y el motor avisa con un `WARN` si la interfaz recibe comentarios y no pinta ninguna lista. Permite distinguir «no llega» de «no se pinta» sin mirar la pantalla.

## D11 · Preguntar antes de dar por bueno un arreglo (2026-09-17)

**Lección:** el primer diagnóstico (D10) era cierto pero **no era el problema del usuario**. El chat «no se actualizaba» porque no llegaba nada (D9): los únicos mensajes visibles eran los del sobre inicial. Se dio por bueno un arreglo de maquetación antes de medir el eslabón más cercano al origen.

**Regla:** ante «no se actualiza», medir primero **cuántos eventos entran** (`ws_frames`, `chat_messages`) y **cuántos se pintan** (`ui_chat`). Un log sin eventos no se arregla en el frontend.

## D12 · El TTS: velocidad real, avisos de regalo/follow y un solo dueño del dato (2026-09-17)

**Síntoma:** el selector de velocidad de la página de voz no hacía nada. El ajuste se guardaba (`TtsSettings.rate`), la interfaz lo mostraba, y la síntesis seguía saliendo a `+0%`.

**Causa:** el ritmo y el tono vivían **en dos sitios**: `TtsSettings` (lo que movía la interfaz) y `TtsConfig` (lo que usaba el proveedor al construir la petición y la clave de caché). La interfaz tocaba el primero; el audio se generaba con el segundo, que era constante desde el arranque. Dos dueños del mismo dato es la causa, no el síntoma.

**Arreglo:** `rate`/`pitch` viajan **dentro de `TtsRequest`** y se leen en `dispatch` en el momento de sintetizar (así un cambio afecta a lo que suene después, no a lo que ya está en cola); se eliminan de `TtsConfig`. La clave de caché ya los incluía, de modo que ahora un cambio de velocidad no reutiliza el audio viejo. `--tts-test` acepta `--rate`/`--pitch` para poder comprobarlo de punta a punta.

**Avisos que no son chat (regalos y follows):** el único punto de decisión es `TtsManager::wants`, y ahora tiene sus brazos; las plantillas viven en `tts::gift_line`/`follow_line` (junto a `chat_line`). Un regalo se lee **una sola vez, al cerrar su racha** (`gift.commits()`, la misma regla que la contabilidad de `feed.rs`) y su prioridad sale de los diamantes (`priority::for_gift`). Los avisos **no** pasan por el pipeline de contenido —el cooldown de 20 s o el mínimo de caracteres los descartarían casi siempre— sino por `Filters::admit_announcement`, que solo gasta el cupo global. Dos interruptores nuevos (`read_gifts`, `read_follows`) deciden si se leen; los follows vienen apagados porque una sala media genera decenas por hora.

Añadir un aviso nuevo (suscripción, share, meta de OBS) es un brazo más en `wants` y una plantilla: ni la cola, ni los filtros, ni el proveedor se tocan.

## D13 · Estados de conexión: el botón deja de mentir y la foto no pisa el directo (2026-09-17)

**Tres fallos distintos, con el mismo síntoma («no refleja el estado real»):**

1. **El botón Conectar estaba activo en todos los estados.** En `reconnecting` el motor ya estaba reconectando con backoff; pulsar Conectar mataba el supervisor, reiniciaba el backoff y **gastaba una firma de la cuota** antes de tiempo. Ahora se deshabilita mientras hay sesión en curso (`starting`, `connecting`, `connected`, `reconnecting`, `waiting_for_live`) con un `title` que explica por qué, y se rotula «Conectando…» también durante `starting`/`connecting` (antes solo con `busy`, así que pulsar Desconectar ponía «Conectando…» en el otro botón).
2. **El motivo del estado era invisible.** La cabecera mostraba `@handle` **o** el detalle: en cuanto `connect` fijaba el handle, el motivo de un error o de una espera solo se veía como tooltip. Ahora se muestran los dos (`@handle · motivo`).
3. **El error terminal se pisaba con `Stopped`.** Tras «cuota o firma inservible; detenido para no agotar el día» el supervisor hacía `break` y el `set(Stopped, None)` final borraba el motivo: la interfaz decía «Desconectado», idéntico a no haber conectado nunca, y el usuario volvía a pulsar Conectar —justo lo que ese freno intenta evitar—. Ahora el motivo terminal se conserva.

**Además, dos fugas de datos en la interfaz:**

- **Carrera snapshot ↔ eventos:** la foto del motor se pedía **antes** de registrar el listener y `applySnapshot` reemplazaba las listas. Los eventos publicados mientras el invoke resolvía no llegaban nunca (Tauri no los reproduce) y los ya pintados se descartaban con una foto más vieja: mensajes que desaparecían y reaparecían al pulsar Conectar. Ahora se escucha **primero** y la foto se **fusiona** por `seq` (se conserva lo más nuevo que la foto).
- **Desconectar no cerraba la sesión:** el proveedor nativo no publicaba `stream.disconnected` al cancelar (el supervisor sale por cancelación, no por caída), así que la fila de `streams` quedaba abierta y `mark_crashed_streams` la marcaba como interrumpida en el siguiente arranque. Ahora `disconnect` lo publica si había sesión.

**Diagnóstico honesto:** la sonda del chat contaba como «pintado» cualquier render, aunque no hubiera lista montada, de modo que el aviso «recibe mensajes pero no renderiza» no podía dispararse nunca. Ahora solo cuenta si hay `ul.chat` en el DOM y el registro incluye la pestaña activa (`tab=…`), que es lo que permitió descubrir que el usuario estaba mirando otra página. La página Developer, además, tenía los contadores congelados desde el arranque (`api.metrics` no se usaba): ahora se sondea a 1 Hz **solo mientras esa pestaña está abierta**.

## D14 · `repeat_count` es un incremento: los diamantes estaban a la mitad (2026-09-17)

**Medido sobre los datos reales guardados**, en la sesión de `azoz._.mx2`:

| | Valor |
|---|---|
| `streams.diamond_total` que escribió el motor | **4** |
| Eventos de regalo guardados | 8 (4 rachas × 2 eventos) |
| `repeat_count` de cada evento | **1** en todos, con `ultimo_valor = 1` |
| Suma real de incrementos | **8** |
| Rachas del histórico que nunca reciben `repeat_end` | **35 de 176** |

`repeat_count` es lo que **suma ese mensaje** a la racha, no el acumulado. El código contaba solo el valor del evento que cierra (`commits()`), así que una racha de dos rosas aportaba 1 diamante en vez de 2: en esa sesión se contabilizaron 4 de 8. Y una racha que nunca recibe su cierre no aportaba **nada**.

**Arreglo:** la contabilidad vive en un solo sitio, `GiftBoard` (feed.rs), que ahora acumula los incrementos por `group_id` en un mapa de rachas abiertas y los liquida cuando la racha cierra. Si el mismo usuario empieza otra racha, la anterior se liquida en ese momento en vez de perderse (cubre las 35 sin cierre por cambio de racha; las que se quedan abiertas al terminar el directo siguen pendientes de un cierre de sesión explícito). `GiftBoard::record` devuelve la aportación liquidada y `app.rs` escribe **ese** número en `gift_events.committed_*`: el mismo valor que se enseña es el que se guarda, sin una segunda suma en paralelo.

`GiftEventView::total_diamonds` sigue siendo lo que aporta **la fila** (su incremento por el valor unitario), que es lo que tiene sentido en la lista de eventos.

## D15 · El avatar viaja en el protocolo y no se estaba usando (2026-09-17)

`User` declara tres fotos de perfil y el struct solo leía cuatro campos, así que la imagen se descartaba en cada evento:

| Campo | Tag | Fuente |
|---|---|---|
| `avatar_thumb` | 9 | `spikes/provider-probe/proto-fields.json` (metadata real instalada) |
| `avatar_medium` | 10 | idem |
| `avatar_large` | 11 | idem |

**Decisión:** se declaran los tres y se usa **`avatar_thumb`** (miniatura). El avatar viaja en *todos* los eventos con usuario —chat, regalos, likes, follows y entradas—, así que su tamaño se multiplica por el tráfico del directo; la miniatura es la que se pinta en las tablas y la que menos pesa. `User::avatar_url()` devuelve cadena vacía cuando TikTok no manda foto, y `UserRef` la omite del JSON con `skip_serializing_if`, de modo que el contrato de los eventos no cambia de forma para quien no tiene avatar.

**Sobre escribir la foto:** se guarda **una sola vez por persona** (memoria `avatars_guardados`). Sin esa caché, el `INSERT` del perfil se repetiría en cada comentario. La caché solo se rellena cuando el trabajo queda **encolado**: si la cola lo rechaza, se reintenta en el siguiente evento en vez de darlo por guardado.

## D16 · El "tap tap" se agrega en local; el rank oficial de TikTok no se usa (2026-09-17)

`WebcastLikeMessage` trae el campo `user` (tag 5) y el decoder **ya lo usaba**: cada ráfaga de likes llega con quién la manda y cuántos puntos suma. Lo que faltaba era sumarlos por persona.

**Decisión:** las tablas se calculan en local desde los eventos, no se pide el rank a TikTok. `WebcastRoomUserSeqMessage.ranks` (tag 2, mensajes `Contributor`) existe y sería el rank oficial, pero **no está en el volcado de campos validados** y la convención del proyecto prohíbe usar tags sin validar contra la metadata instalada. Queda como mejora futura: primero hay que validar esos tags con `dump_proto.py`.

Las tres tablas (tap tap, regalos y follows) comparten el tipo `RankingEntry` y el tablero `RankingBoard` (acotado a `RANKING_CAPACITY` personas, con contador de descartes), porque las tres se pintan igual: puesto, foto, nombre y una cifra.

**La tabla de regalos NO tiene tablero propio:** se deriva de `GiftBoard`, que ya lleva el gasto por persona y ya sabe liquidar rachas. Un segundo acumulador habría duplicado esa contabilidad (la regla del proyecto es un solo sitio por número) y además se habría desincronizado cuando una racha se liquida por fin de directo en vez de por un regalo nuevo.

## D17 · El histórico de por vida es opt-in y se escribe agregado (2026-09-17)

Guardar quién aporta y cuánto **entre directos** es un dato con más recorrido que un ranking de sesión, así que no se activa solo:

- Va **apagado** por defecto. El ajuste vive en la página de Voz y su efecto se ve en Rankings; al apagarlo se **vuelca lo pendiente** en lugar de tirarlo.
- Se acumula en memoria y se escribe **por ventana de 1 s** (mismo latido que `flush_progress`, sin temporizador propio). Un tap no puede costar una escritura: en un directo movido llegan decenas por segundo.
- La escritura es `ON CONFLICT ... DO UPDATE` que **suma**, nunca reemplaza; el cierre de sesión **fuerza** el último volcado.
- El `UPDATE` del avatar es condicional (`WHEN excluded.avatar_url <> ''`): TikTok no manda la foto en todos los mensajes y un evento sin foto no debe borrar la que ya había.
- La consulta del histórico abre su **propia conexión de lectura**, en lugar de meter una consulta por la cola del escritor: el escritor es dueño de su `Connection` en su hilo y una consulta por ahí obligaría a un viaje de ida y vuelta con canal para algo que SQLite permite en paralelo.

Migración **v5**, aditiva: `avatar_url` y los tres `lifetime_*` en `users`, más un índice por diamantes para el ranking histórico.

## D18 · El overlay de OBS: servidor propio, token y foto por conexión (2026-09-17)

OBS carga un *Browser Source*, que es un WebView y **solo entiende HTTP y WebSocket**. No puede usar el IPC de Tauri (ese canal es del origen `tauri.localhost`), así que los overlays no pueden reutilizar el canal de la interfaz y necesitan un servidor. Se implementa con **Axum** como fija el plan §29, en `src/overlay/`:

| Pieza | Decisión |
|---|---|
| Puerto | 7878 por defecto, con búsqueda del siguiente libre y **persistido** para que la URL de OBS no cambie entre arranques (plan-review P0-4b) |
| Token | 32 hex por instalación, en `overlay.json` junto a la base; se genera una sola vez |
| `Origin` | se acepta ausente y `null` (es lo que manda OBS) y los host **exactos** `127.0.0.1`, `localhost`, `[::1]` |
| Arranque | hilo y runtime propios: el dashboard va por IPC, así que un fallo de Axum no lo tumba (§151) |
| Página | `overlay.html` servida por el propio servidor, autocontenida (sin build ni React) |

**El `Origin` se compara entero, no por prefijo.** La primera versión usaba `starts_with("http://localhost")`, que deja pasar `https://localhost.ejemplo.com` — precisamente el ataque de DNS rebinding que esto debe impedir. Lo cazó `una_web_externa_no_puede_conectarse`; ahora solo se aceptan los tres host locales exactos.

**La foto de bienvenida se compone en cada conexión, no una vez.** La primera versión la mandaba solo al arrancar el servidor, así que si el primer evento del directo llegaba antes que el cliente, el `watch` ya contenía un incremental y quien se conectaba después **no recibía nunca la foto completa**: el overlay se quedaba en blanco hasta el siguiente cambio y un refresco de OBS no se repintaba. Ahora cada conexión une las tablas que haya en ese momento con los datos de sesión y manda un `state`; después llegan los `rankings`. Es lo que hace al overlay verdaderamente stateless (§180).

Se añadió `axum 0.8` (con `ws`). Convive con el `tokio-tungstenite 0.24` del provider TikTok, que Axum arrastra en su 0.29: son dos copias del mismo crate en el árbol. Cuesta tiempo de compilación, no es un conflicto.

**Para OBS:** pegar la dirección que aparece en la página *Desarrollador* (lleva el token) como *Fuente de navegador*, con 400×620 y fondo transparente. La página se sirve en `http://127.0.0.1:7878/`.




## D19 · Los diseños del overlay: uno por vista, con simulador (2026-09-17)

D18 dejó el overlay con **una** página y el diseño de carriles incrustado en Rust. Con ocho diseños diseñados y probados como maquetas, meterlos obligaba a decidir tres cosas: dónde vive un diseño, cómo se elige y cómo se ve antes de ponerlo en antena.

| Pieza | Decisión |
|---|---|
| Un diseño | **un fichero HTML autocontenido** en `overlay/web/disenos/`, con su estilo y su pintado dentro |
| Lo compartido | `comun.css` (tokens y base), `comun.js` (datos, ritmo y arranque) y `anim.js` (FLIP, cambio de puesto, corona, barras) |
| Catálogo | `overlay/disenos.rs`: identificador, vistas en las que vale, **lienzo medido** y el `include_str!` del documento |
| Elección | **por vista**, guardada en `overlay.json`; el de fábrica sigue siendo carriles, para no cambiarle el overlay a quien ya lo tenía |
| Vista previa | un `iframe` al **mismo documento** que carga OBS, con `?demo=1` |
| Simulador | `comun.js` inventa los taps en local: la previa se mueve sin directo y **sin abrir WebSocket** |

**Lo que se sirve en OBS es el fichero, tal cual.** No hay plantillas ni composición en Rust: el documento referencia los assets compartidos por su ruta y el servidor los sirve en `/`. Eso hace que la vista previa sea literalmente lo que sale en antena —no hay dos implementaciones que puedan divergir— y que añadir un diseño sea dejar un fichero y una entrada en el catálogo.

**El simulador evita abrir el `Origin` y el `connect-src`.** Una previa contra el directo habría necesitado que el servidor aceptara el origen de la propia aplicación (`tauri.localhost`, que D18 rechaza a propósito: solo acepta los tres host locales exactos) y ampliar el CSP de Tauri. Como el simulador no abre socket, basta con `frame-src http://127.0.0.1:*`; el `Origin` sigue igual de estricto. Además resuelve el problema real de la previa: sin directo —o sin taps en ese momento— un diseño que se mueve con el ritmo no se puede ni mirar.

**La dirección de OBS no lleva el diseño.** `?view=tap&t=<token>` sigue siendo la misma al cambiar de diseño: la elección vive en el servidor, así que se cambia el aspecto **sin volver a tocar la escena de OBS**. Y al revés, `?diseno=<id>` pinta cualquier diseño sin cambiar el que está en antena, que es justo lo que hace la previa.

**Un identificador guardado que ya no existe no deja el overlay en blanco.** `para_vista` resuelve contra el catálogo y cae en el de fábrica: en mitad de un directo, un marcador de más vale más que una página vacía. Es el caso de una instalación que guardó un diseño retirado en una actualización.

**Una sola conexión al bus.** El servidor lee la configuración de la **misma celda** que escribe la interfaz (`Arc<RwLock<..>>`), así que cambiar de diseño se ve en la siguiente petición de OBS sin reiniciar nada y no hay dos copias del token que puedan discrepar.

### Lo que se arregló al portar

- **`ctx.animar` no entregaba la marca de tiempo.** El ayudante del bucle de dibujo llamaba a `fn()` a secas, cuando todo el mundo espera la semántica de `requestAnimationFrame`. Los diseños de juego calculan su `dt` restando dos marcas, así que la resta salía `NaN`, las coordenadas también y **el lienzo no dibujaba nada sin dar ningún error**: el canvas ignora los trazos con coordenadas no finitas. Se vio porque la esgrima aparecía con sus fichas y su suelo pero **sin los personajes**. Lo delató instrumentar `translate`/`lineTo`/`arc` antes de cargar la página y apuntar el primer argumento no finito; ninguna excepción de consola lo habría dicho.
- **El duelo pasaba el envoltorio donde esperaba la entrada.** `duelo.duo` guarda `{clave, entrada, valor, tasa}` y quien pinta el retrato y el rótulo espera la entrada —la que tiene `user` y `value`—. Tampoco da error: `ctx.nombre` cae a su reserva y el marcador enseñaba `@?`, un `0` y un hueco en vez de la foto, con el total correcto, que es lo que despistaba.
- **Una clase compartida con otro significado.** El duelo usa `.cab` para su cabecera y `comun.css` define `.cab` como **fila flex** (la cabecera de las tablas, con el total a la derecha), así que el rótulo y el total salían pegados en la misma línea. Se deshace con `display: block` en el diseño y un comentario que explica por qué.
- **`colocarCorona` animaba al revés.** La condición pedía `!esNueva`, de modo que el rebote de la corona no se veía **nunca**: la corona solo se crea cuando cambia de dueño, así que las dos condiciones coincidían siempre. No salía ningún error en consola —la corona aparecía en su sitio— y las maquetas lo arrastraban desde el principio. Lo encontró el portado, al tener que decidir qué bandera pasar.
- **La URL de OBS era la del WebSocket.** `overlay_url` devolvía `ws://…` y la pestaña Desarrollador la enseñaba con la etiqueta «Browser Source». Pegada en OBS no carga nada: OBS abre un documento y es el documento el que abre el socket. Ahora el snapshot publica `overlay_urls`, una dirección **HTTP por vista** con su token.
- **La tarjeta de overlay de Desarrollador se quitó**: la pestaña Overlays hace ese trabajo, y tener lo mismo en dos sitios es tener dos verdades.

Los tres primeros son el mismo fallo de fondo: **un overlay puede quedarse mudo sin un solo error**. Por eso el catálogo comprueba por texto lo que se puede comprobar así, y la verificación abre cada diseño y mira que el lienzo se mueva, que la zona de juego tenga píxeles y que no haya coordenadas no finitas.

### Los minijuegos

Los tres se mueven con el **ritmo** de los taps, no con el total, así que declaran una sola vista (`tap`): ofrecerlos en regalos o seguidores sería prometer algo que no puede pasar. Se sirven con el mismo runtime y reciben `tasas` (`clave -> taps por segundo`) además de las entradas.

- **Pelotas** conserva el lienzo de 1080×1920 y su zona del cuarto de abajo: ahí la altura es el diseño, porque el juego vive debajo del vídeo.
- **Duelo** y **esgrima** se quedaron en la altura de su contenido (1080×1080 y 1080×520) en vez de los 1920 de la maqueta, que era una simulación de pantalla de móvil con la mitad de abajo vacía. Es la desviación más visible del portado y conviene saberla: el tamaño de la fuente en OBS lo pone la escena, no el documento.
- **El duelo añadió las barras de aguante**, que la maqueta no tenía: el encargo las pedía y son el mismo pulso medido de otra forma, pero no salen del fichero original.

El bucle de los tres pasa por `ctx.animar`, que es lo único que garantiza que una excepción de un fotograma no deje el marcador congelado en el último fotograma.

### Lo que no se puede olvidar al añadir un diseño

`el_catalogo_es_coherente` comprueba, para cada documento: que carga el runtime y los estilos compartidos, que **no** lleva el rótulo de la vista escrito a mano (y que quien tiene `h1#titulo` lo rellena desde el contexto), que no conserva el andamiaje de maqueta (`cliente-vivo`, `enVivo`, `new WebSocket`), que no formatea cifras por su cuenta, que no se desplaza y que no carga nada de la red. Son restricciones que no rompen nada de forma visible —el diseño se pinta igual— y fallan solo en el caso raro, que es la peor clase de fallo para un overlay.

La correspondencia entre el identificador de Rust y el rótulo que lee el streamer vive en `i18n` (D4): el catálogo publica **solo** identificadores y vistas, así que un diseño sin rótulo enseña su identificador en vez de un hueco en blanco.

## D20 · El panel, ordenado: cuatro pestañas y cada dato en un sitio (2026-09-17)

Siete pestañas, y tres de ellas contestaban lo mismo. El repaso de lo que enseñaba cada una dejó el solapamiento a la vista:

| Bloque | Panel | Chat | Regalos | Rankings |
|---|---|---|---|---|
| Sesión (título, duración, sala) | sí | | | |
| Contadores | sí | | sí | |
| Chat | sí (10 líneas, sin buscar ni silenciar) | sí (completo) | | |
| **Actividad** | sí | | | |
| **Quién aporta** (diamantes por persona) | sí (sin foto) | | sí (sin foto) | sí (**con foto y enlace**) |
| Por tipo de regalo | sí | | sí | |
| **Últimos regalos con racha** | | | sí | |
| **Tap tap / seguidores / histórico** | | | | sí |

**El Panel era la unión de Chat y Regalos, con la versión peor de cada uno**, y el plan del proyecto (§64, citado en D4) tampoco tiene página «Panel». En Rust, además, `gift_ranking` se construía **derivando** `top_gifters`: el mismo dato en dos tipos, serializado dos veces en cada foto y pintado en tres sitios.

| Antes | Ahora |
|---|---|
| Panel, Chat, Regalos, Rankings, Overlays, Voz, Desarrollador | Chat, Aportaciones, Overlays, Voz — y Desarrollador como **botón de la cabecera** |
| Chat reciente duplicado en el Panel | el chat completo y, **al lado**, la actividad |
| «Quién aporta» en tres sitios y dos formas | una vez, en Aportaciones, con foto y enlace |
| La actividad, solo en el Panel | en Chat, junto al chat, con su botón de limpiar |
| La sesión, en el Panel | la **duración** en la cabecera, la **sala** en Desarrollador |
| `Snapshot.top_gifters` **y** `Snapshot.gift_ranking` | solo `gift_ranking` |

Desarrollador deja de ser pestaña porque es una herramienta de diagnóstico, no una página de directo: en la barra competía con lo que se mira mientras se emite. El botón se marca cuando está abierto, que es la única señal de que lo está al no tener pestaña.

### Y apareció un fallo de verdad al mirarlo

El manejador de regalos publicaba `gifts.updated` y **nunca** `publish_rankings`, que solo salía de los likes y los follows. En un directo donde llegan regalos pero nadie da taps ni sigue a nadie, **la tabla de regalos del overlay de OBS (`?view=gifts`) no se actualizaba nunca**, ni tampoco la de Rankings. Y sin ningún error: la fuente se quedaba con el último marcador, que es la peor forma de fallar porque parece que no pasa nada.

Lo cubre `un_regalo_publica_las_tablas_de_ranking`, y se comprobó que **falla** sin el arreglo (el campo se quitó a propósito para verlo fallar antes de dejarlo puesto). Es también lo que hace segura la limpieza del payload: con dos representaciones del mismo número, la que se quedaba sin refrescar era la que nadie miraba.

## D21 · Alertas para OBS: medios, plantilla y cola que espera (2026-09-17)

Lo que en StreamElements o StreamLabs se llama *alert box*: cuando alguien regala, sigue, comparte, se suscribe o suelta una rafaga de likes, sale un aviso en pantalla con su medio y su sonido.

| Pieza | Decision |
|---|---|
| Disparadores | **siete**: los tres tramos de regalo y los cuatro de siempre. **No** las entradas a la sala: es el mensaje mas frecuente de TikTok y la cola se comeria las alertas de los regalos, que son las que importan |
| Regalos | disparan **al cerrar la racha**, y con la aportacion comprometida, no con el ultimo incremento. Uno por rosa seria una alerta cada pocos segundos |
| Tramos | normal, grande y enorme, con el `minimo` de cada uno como frontera. Un regalo de diez diamantes no puede sonar igual que uno de cinco mil |
| Texto | plantilla con variables (`{usuario}`, `{regalo}`, `{cantidad}`…) **rellenada en Rust**: el overlay solo pinta. Es el mismo criterio que las frases del lector de voz |
| Medio | se **copia** a `%LOCALAPPDATA%\…\alertas\` y lo sirve el servidor de overlays con token. Una ruta del escritorio se rompe en cuanto se mueve el fichero, y entonces en OBS sale un hueco |
| Sonido | el del propio fichero de la alerta. **No se toca el lector de voz**: es otra cosa y se configura en otro sitio |
| Cola | en el servidor, con tope de 20; lo que sobra se descarta y **se cuenta**, que es la regla del proyecto |
| Fuente | `?view=alerts`. Es exactamente la «fuente de eventos/alertas» que el plan ya preveia en §178 |

**Los medios los sirve la aplicacion, no el disco del streamer.** Se aceptan doce formatos (lista blanca, no lista negra), con tope de 48 MB, y el nombre final lo pone el almacen: se limpia el que venga y se le añade un numero si ya existe. El nombre viaja en la URL, asi que `ruta_de` rechaza `/`, `\`, `..` y lo que empiece por punto; sin eso, `/media/../../base.db` seria una lectura arbitraria.

**Los ajustes se sanean al guardar.** Duracion entre 0,5 y 60 s, volumen entre 0 y 1, texto de 200 caracteres, minimo nunca negativo y solo donde tiene sentido (un follow no trae cantidad con la que filtrar). El motor no se fia del renderer: un `duracion_ms` de un millon dejaria la fuente de OBS ocupada durante horas.

### D23 · Los tramos de regalo y los sonidos propios (2026-09-19)

**Los regalos van por tramos** (normal, grande y enorme), y el tramo lo elige el motor en `alerts::tramo_de_regalo`, no quien llama: cual de los tres toca es politica de las alertas y vive con ellas. Los umbrales son el `minimo` que cada aviso ya tenia —100 y 1.000 diamantes de fabrica—, asi que **no hizo falta ni un campo nuevo**.

Se recorre la lista **de mayor a menor** y gana el primero que sirva. Si el tramo de arriba esta apagado o sin nada que enseñar, **se cae al de abajo**: apagar el aviso de los regalos enormes no puede significar que un leon entre sin ninguna alerta. Lo que si se respeta es el minimo del tramo al que se cae, asi que una racha por debajo del minimo del normal sigue sin sonar, igual que antes.

**Los sonidos de fabrica son del proyecto.** Los sintetiza `scripts/generar-sonidos.mjs` —Node pelado, sin dependencias: un WAV PCM es una cabecera de 44 bytes y aritmetica— y se versionan en `src-tauri/sonidos/`. Van **dentro del ejecutable** con `include_bytes!` y el almacen los siembra al arrancar, sin pisar lo que ya haya.

El motivo de hacerlos en vez de traerlos es concreto: los bancos de sonidos de internet son en su mayoria clips con dueño, y este proyecto **publica releases publicas**. Repartirlos seria redistribuir material ajeno. Y los de myinstants, ademas, no se pueden ni leer: el dominio entero responde **403 de Cloudflare** al acceso automatico, incluido su `robots.txt`.

Quien quiera sus propios memes los baja en su navegador y los **suelta en la ventana** —ficheros o la carpeta entera—: el importador en lote recorre el mismo camino validado que el de a uno, con la misma lista blanca. Nada de eso sale del equipo ni acaba en la release.

**Los siete avisos de fabrica traen sonido y texto**, para que un directo recien instalado suene sin tocar nada. Los cinco que el streamer espera ver vienen encendidos; compartidos y likes siguen apagados por el motivo de siempre.

### El fallo que aparecio, y es el peor de los que han salido

La cola esperaba al fotograma siguiente con `requestAnimationFrame` **a secas**, para que la caja se viera entrar en vez de aparecer de golpe. En una pagina oculta —y una fuente de OBS puede estarlo— el navegador **no llama nunca** a `requestAnimationFrame`, asi que el aviso se quedaba a medio enseñar y **ninguna alerta volvia a salir**: un atasco mudo, sin un solo error en consola.

Lo delato la verificacion de punta a punta: el texto y la imagen ya estaban puestos y la caja seguia sin la clase de visible. Ahora hay un temporizador de respaldo de 150 ms, y **se comprobo que la prueba falla sin el** quitandolo a proposito: sin respaldo, el aviso no llega a enseñarse nunca y la cola se queda con el texto puesto para siempre.

Es la tercera vez en este proyecto que un overlay se queda mudo sin decir nada. La regla que lo cubre: **ningun camino del overlay puede depender de que llegue un fotograma**.

## D22 · Salida de audio de las alertas (2026-09-18)

El lector de voz ya tenia selector de dispositivo; las alertas no tenian ninguno, y no por olvido: **el sonido de una alerta no sale de la aplicacion, sale de la fuente de OBS**. Eso esta bien y no se toca — es lo que hace que lo oiga la audiencia, y OBS ya da su mando de volumen y su enrutado.

Pero dejaba un hueco real: **le dabas a «Probar» con OBS cerrado y no oias nada**, que es justo cuando estas configurando.

Asi que la tarjeta nueva de **Alertas** no es la salida de la audiencia, es el **monitor del streamer**:

| | |
|---|---|
| Dispositivo | la misma lista que la del lector de voz (`list_devices()`), una sola fuente |
| Volumen aqui | no toca el que oye el publico |
| En directo | apagado por defecto: en directo ya se oyen por OBS, y oirlas dos veces es peor que no oirlas |
| Probar | suena **siempre** aqui: es la unica forma de comprobar el sonido sin OBS delante |

**Reutiliza el reproductor que ya existia** (`FallbackSink`), asi que no entra ninguna dependencia nueva, y si el dispositivo elegido ya no esta **degrada a mudo y lo dice** en vez de fallar en silencio. El audio solo se reabre cuando el dispositivo cambia de verdad: reabrir en cada guardado cortaria el sonido cada vez que se suelta una tecla en un texto.

Dos cosas que cazo el ciclo rapido, y las dos valen como leccion:

- **`TipoAviso` estaba definido como `keyof AjustesAlertas`.** Al anadir `salida`, el campo habria pasado a ser un **sexto tipo de aviso** y la pagina habria pintado una tarjeta de mas, vacia y sin un solo error. Un `keyof` sobre una estructura que crece es una trampa: se cambio por una lista explicita.
- **La pagina se caia** con `Cannot read properties of null (reading 'map')` si la lista de dispositivos llegaba vacia. Lo vio el banco de la interfaz, no el compilador: el tipo decia `string[]` y por el cable puede llegar cualquier cosa.

## D24 · Un solo audio de prueba a la vez (2026-09-20)

Habia **tres** sitios que reproducen un audio al pulsar algo: el boton **Oir** de la biblioteca de sonidos de Alertas, el boton **Probar** de la previa —los dos por el monitor del streamer, o sea en Rust— y la **muestra de una voz**, que suena en un `<audio>` de la interfaz. Y el fallo medido era exacto:

```
Oír sonido A           → suena A
Oír sonido B           → suena B, pero A sigue sonando por debajo
Probar alerta          → suena la alerta, y A sigue sonando por debajo
```

La causa del primer caso no era el estado de la interfaz: `RodioSink::play` **encola** en el mismo `Sink` de `rodio`, que mezcla las fuentes. Encolar es lo correcto para el **lector de voz** —dos frases del chat se leen una detras de otra—, asi que el arreglo no es cambiar `play`, es tener un camino que reemplace.

Lo que se hizo, en tres capas:

| Capa | Que hace |
|---|---|
| `tts/player.rs` | `AudioSink::play_exclusive`: corta y encola **en la misma orden** del hilo de audio |
| `preview.rs` | el **turno** del audio de prueba: quien lo pide, se lo quita al anterior; con marca para que un final tardio no suelte el turno de otro |
| `previewAudio.tsx` | el coordinador de la interfaz: un unico `<audio>`, y el estado visual de lo que suena |

**El corte viaja en la misma orden que el encolado.** Partirlo en un `stop()` y luego un `play()` deja un hueco por el que se cuelan dos clics rapidos, y el resultado es justo el fallo que se estaba arreglando. Va como una variante de la orden (`PlayExclusive`) para que el hilo de audio pare y encole sin soltar el turno, y `FallbackSink` la releva tal cual: si `rodio` sabe hacerlo atomico, el envoltorio no puede romperlo.

**El turno lleva marca.** Cada toma se numera, y el final de un audio solo suelta si su numero sigue siendo el vigente. Sin esto, «Oir A → Oir B» y el final de A dos segundos despues dejaria el turno vacio mientras suena B: el estado visual diria que no suena nada y el siguiente clic empezaria de cero.

**El motor sigue siendo la fuente de verdad de lo que suena por el monitor.** La interfaz no adivina la duracion de un fichero: mientras suena un preview del motor le pregunta a `preview_estado`, que contesta quien tiene el turno **y lo suelta solo** cuando el monitor ya no tiene nada encolado. Un monitor **degradado** —sin tarjeta, o apagado con `TTSDASH_AUDIO`— contesta que no suena nunca: su reproductor es un doble que se quedaria «sonando» para siempre, y eso dejaria el boton clavado en «Parar» hasta cerrar la aplicacion.

**La previa del panel va muda.** El documento del overlay tambien sabe reproducir el sonido del aviso —en OBS **es** el audio de la audiencia—, asi que dentro de la previa serian dos copias del mismo aviso: la del marco y la del monitor. La pestana de Alertas le anade `previa=1` a la direccion del marco y ahi el `<audio>` del overlay no se usa. La direccion que se pega en OBS **no** lleva la marca, y alli el audio del overlay sigue siendo el que oye el publico.

**Al cambiar de pestaña se para.** Lo hace `App` en un solo sitio y no cada pagina al desmontarse: el coordinador es uno, y una alerta probada sigue sonando mientras se mira otra cosa. Si no sonaba nada, parar no hace nada —y sobre todo no corta una alerta **de verdad**, porque `parar_preview` solo toca el monitor cuando el turno era de un preview que suena en el: una alerta real que este sonando en ese momento no se cae por cambiar de pestaña—.

Lo que queda **fuera** a proposito: el **lector de voz** (lo que se lee del chat). No es un preview, y cortarlo porque alguien prueba un sonido seria parar el directo para configurarlo. Sigue encolando, que es lo suyo.

## D25 · El contenedor del mensaje: un sistema aparte del aviso (2026-09-20)

El bloque del texto —el «Alguien se suscribió (3 meses)»— tenía **un solo estilo**: fondo `--velo`, borde de un píxel, radio 12, relleno 26×14, letra de 40 px con sombra. Para darle quince estilos, veinte animaciones propias y diez animaciones de letra hacía falta algo más que añadir reglas: hacía falta que **no se mezclara** con las animaciones de la alerta.

Esa es la decisión de fondo: **la alerta entera y su mensaje son dos sistemas**. La alerta ya tiene entrada, permanencia y salida —mueven la caja, con el medio y el texto dentro—; el mensaje tiene las suyas, que mueven solo su bloque y sus letras. Si compartieran catálogo, elegir «Abrir en horizontal» para el mensaje cambiaría cómo entra la alerta, que es justo lo que no puede pasar.

| Pieza | Dónde vive | Qué es |
|---|---|---|
| El modelo | `alerts/mensaje.rs` | `MensajeAviso`: 34 campos, con sus catálogos y su saneado |
| La configuración | `overlay/web/mensaje/config.js` | los mismos topes y catálogos, y el normalizado |
| Los estilos | `overlay/web/mensaje/presets.js` | quince presets: lo que un número no puede decir |
| Las animaciones | `overlay/web/mensaje/animaciones.js` | entrada y permanencia del contenedor |
| Las del texto | `overlay/web/mensaje/texto.js` | las de las letras, y el troceado |
| El pintor | `overlay/web/mensaje/renderer.js` | el único que toca el DOM del mensaje |

**Un preset es una configuración, no un componente.** Lo que un puñado de números puede decir —el fondo, el borde, el radio, el relleno, la sombra, el resplandor, la letra— viaja en los ajustes, y **el editor escribe los valores sugeridos del preset al elegirlo**, igual que hace con los efectos de permanencia. En el overlay solo queda lo que no cabe en un campo: el degradado (dos colores en un `linear-gradient`), las decoraciones —la barra lateral, las puntas de la cinta, la línea del mínimo— y el ancho completo de la barra. Eso son tres `data-*` y una función, no quince componentes.

**Las animaciones se lanzan con la API del navegador, no con `@keyframes` generados.** La permanencia de la alerta genera su hoja porque es un bucle y necesita repartir el ciclo; estas son de **una sola vez** y llevan su retardo, su duración y su ritmo en la propia llamada (`element.animate`). Y hay una invariante que sostiene todo: **la última fotograma de cada animación es el estado natural** —opacidad 1, sin transformación, sin recorte—, así que al terminar queda lo que dice la hoja de estilos y no un fotograma pegado.

**El retardo es del mensaje, no de la alerta.** `retardo_ms` cuenta desde que la alerta ha entrado, y con él se monta la secuencia que se venía a buscar: entra la imagen, y 250 ms después se abre el mensaje con sus palabras saliendo una a una. Con la animación en «ninguna» el mensaje se queda oculto durante el retardo, porque si no el mando no haría nada.

**El panel ocupa el sitio del editor, no un diálogo.** Son treinta mandos y el editor mide 351 px, así que van en tres pestañas —estilo, texto, animación— con los mandos desplazándose por dentro. Y va ahí y no en una ventana modal por lo mismo que la previa dejó de estar detrás de una pestaña (D20): **la previa tiene que seguir a la vista** mientras se cambia el estilo. Los cambios van al marco por `postMessage` —el mismo camino que el tamaño—, así que se ven en el aviso que ya está en pantalla sin volver a dispararlo; la animación solo se repite si la han cambiado, para que escribir en un campo no deje el mensaje saltando.

**La previa del panel no inventa nada.** Sigue siendo el documento que carga OBS, con el mismo renderer: lo que se ve en el marco es lo que sale en antena. Si no hay ningún aviso en pantalla no hay nada que repintar, y se pulsa Probar —que es lo que ya hacía falta para ver cualquier otro ajuste—.

Dos guardas para que las dos mitades no se separen, que es la forma de romperse que este proyecto persigue:

- un test en `alerts/mensaje.rs` que **lee los ficheros del overlay** y compara los catálogos en los dos sentidos: un estilo que el motor acepte y el overlay no conozca saldría con el de fábrica, sin un error y sin que nada fallara;
- `scripts/comprobar-mensaje.mjs`, que ejecuta los módulos del overlay en Node con un `window` de mentira y comprueba el normalizado, los planes de animación —incluida la invariante de la última fotograma—, el troceado del texto y los presets.

**Lo que no se toca**: `ANIMACIONES`, `PERMANENCIAS` y `RITMOS` de la alerta, ni `prepararAnimacion`, ni la cola. El mensaje se engancha donde ya se pintaba el texto —al aplicar el aviso, al enseñar la caja y al limpiar— y en ningún otro sitio.

### El estilo que volvía solo a «Default» (2026-09-20)

El primer día de uso salió el fallo, y su causa no estaba en la interfaz: **el motor que respondía era anterior a este ajuste**. Al elegir «Neón», la interfaz mandaba los ajustes con el campo `mensaje` dentro; el motor viejo deserializaba su estructura —que no tiene ese campo—, lo **descartaba sin dar error** y devolvía la foto sin él. La interfaz, que rellena lo que falta con lo de fábrica para poder pintar, mostraba «Default» otra vez. Tres cosas se arreglaron a raíz de eso:

- **El fallback deja de ser silencioso.** Cuando el motor no manda el campo, el panel lo dice arriba y en rojo, y explica qué hacer. Rellenar lo que falta sigue siendo necesario —una foto vieja no puede tumbar la pantalla—, pero *callarse* que falta es lo que convertía un motor viejo en un «fallo del panel» imposible de diagnosticar.
- **Un estilo no reinicia lo que no es suyo.** `parcheDeEstilo` partía de los valores de fábrica **enteros**, así que elegir «Cristal» después de poner «Máquina de escribir» borraba la animación del texto, y cambiar de preset perdía el retardo. Ahora la caja entera parte de fábrica —un estilo es una forma completa, no una mezcla con el anterior—, la letra solo se toca en lo que el estilo pide de verdad, y **las animaciones no se tocan nunca**: tienen su pestaña.
- **Una respuesta que llega tarde no pinta.** Las acciones de alertas no se serializaban: dos guardados seguidos podían resolverse al revés y la foto vieja pisaba la nueva, con el desplegable volviendo al valor anterior. Ahora se pinta solo la foto de la última acción **pedida** (y el «ocupado» lo quita esa misma).

Y quedó una prueba que faltaba: `integration_flow` guarda un estilo, comprueba que vuelve en la foto, **reabre la aplicación** y comprueba que sigue ahí; y que probar una alerta sale con el estilo guardado **sin tocar** la configuración. Es la mitad «persistencia» del sistema, que hasta entonces solo estaba cubierta por el serde de los ajustes.

## Pendiente y sin resolver: el desplazamiento inicial de la pestana Overlays

Medido: al abrir **Overlays**, su panel aparece desplazado 76 px, que es **exactamente su maximo** (982 de contenido, 906 de alto). O sea, abajo del todo, con la direccion que hay que copiar fuera de la vista.

Se probaron dos cosas y **ninguna funciono**, asi que no se dejan en el arbol:

1. Resetear el desplazamiento al cambiar de pestana.
2. Desactivar el anclaje de desplazamiento (`overflow-anchor: none`), pensando que la vista previa al crecer empujaba el panel.

La causa esta **sin encontrar**. Queda anotado en `TODO.md` en vez de tapado con un arreglo que no arregla.

## La biblioteca de voces: lo que se lee de Fish Audio y lo que no

La vista «Voces y claves» es una **biblioteca**: se exploran voces, se escuchan sus
muestras, se guardan y se administran las claves. Todo lo que se le pide al proveedor
sale de **endpoints que su esquema confirma** (`https://api.fish.audio/openapi.json`,
contrastado con los tipos de su SDK), y nada se inventa:

| se usa | para que |
|---|---|
| `GET /model` con `title`, `language`, `tag`, `author_id`, `self`, `page_size`, `page_number` | el catalogo, con sus filtros y su paginacion |
| `GET /model/{id}` | comprobar un identificador pegado y refrescar una voz guardada |
| `samples[].audio` del propio modelo | **escuchar sin generar**: son audios ya hechos |
| `POST /v1/tts` (el de siempre) | solo cuando la voz **no trae muestra**, y avisando de que se cobra |
| `GET /wallet/self/package` | el saldo, que ya se usaba |

**`sort_by` no se usa**: el esquema lo declara como una cadena sin decir que valores
acepta, y mandar uno inventado es pedirle a la API algo que no esta escrito en ningun
sitio. Los idiomas del desplegable salen de las voces cargadas, no de una lista de codigos
supuesta.

Tres cosas que solo se ven hablando con la API de verdad, y que quedan escritas porque
costaron encontrarlas:

- **`cover_image` viene relativo** (`coverimage/<id>`), no como direccion completa. Los
  medios publicos de Fish se sirven desde `https://public-platform.r2.fish.audio/`
  —comprobado contra su propia web, que devuelve esa portada con un 200 y `image/jpeg`—.
  Sin resolverlo, el navegador pide `coverimage/<id>` **al panel** y la biblioteca se queda
  sin caras.
- **Las muestras van firmadas y caducan en una hora.** Por eso no se guardan como si
  fueran para siempre: antes de reproducir una voz guardada se le pide la direccion buena
  al catalogo —leer no gasta saldo— y lo guardado queda de respaldo. Y suenan **desde la
  direccion de Fish**, sin pasar por el motor, asi que hicieron falta `media-src 'self'
  https:` en el CSP de la aplicacion de escritorio: `img-src` ya dejaba ver las portadas
  —que son imagenes—, pero el audio remoto se habria quedado mudo sin decirlo.
- **La respuesta trae `total` e `items`**, y una voz puede venir con `_id` o con `id`: el
  mapeo acepta los dos y no revienta si falta cualquier campo. Un catalogo ajeno no puede
  tumbar una pantalla por una respuesta rara.

**La clave sigue sin salir del motor.** El catalogo se lee con el **mismo relevo de
claves** que la sintesis —un 401 marca la clave y pasa a la siguiente, un 429 reintenta la
misma—, asi que el catalogo hereda lo que ya estaba probado en vez de tener su propia
copia. Y las claves se pueden **probar** sin gastar saldo y sin que probar cambie su
estado: una clave que falla por un corte de red no es una clave invalida.

**Guardar una voz del catalogo no toca la cuenta de Fish.** Se guarda la **referencia**:
su identificador, su nombre original, su portada en cache y sus muestras. «Eliminar de Mis
voces» quita la fila local y nada mas. La aplicacion **solo lee** modelos: no crea, ni
edita, ni borra nada en la cuenta del streamer.

**Lo local manda sobre lo del catalogo.** Al refrescar una voz se traen portada,
descripcion, idioma, etiquetas y muestras, y se conservan **su nombre y su estrella**. Un
nombre propio es del streamer: una actualizacion de datos no puede pisarlo.
