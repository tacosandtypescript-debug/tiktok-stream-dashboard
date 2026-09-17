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



