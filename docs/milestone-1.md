# Milestone 1 — Conexión ligera

**Estado: completado y verificado contra directos reales de TikTok.**

Objetivo (docs/plan-review.md §87 y decisión D8): una aplicación de escritorio que
conecte con un `@usuario` de TikTok, muestre el chat en vivo, se recupere de
cortes, incluya un simulador, registre logs y persista en SQLite, **sin** cargar
el equipo ni agotar la cuota del servidor de firma.

---

## 1. Qué se ha construido

```text
apps/desktop/
├── package.json · vite.config.ts · tsconfig.json · index.html
├── src/                          interfaz (React + TypeScript)
│   ├── App.tsx                   panel, chat y diagnóstico
│   ├── api.ts                    puente con Rust (snapshot + eventos)
│   ├── i18n/es.ts                textos, en un solo módulo
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml · build.rs · tauri.conf.json · icons/icon.ico
    └── src/
        ├── main.rs               entrada + `--self-test`
        ├── lib.rs                módulos y autoverificación
        ├── app.rs                motor: estado, consumidor del bus, persistencia
        ├── desktop.rs            shell Tauri: comandos, puente de eventos, ventana
        ├── core/
        │   ├── event.rs          protocolo v1 (event_id, seq, room_id, source_id)
        │   ├── bus.rs            event bus con deduplicación y métricas
        │   ├── metrics.rs        contadores de diagnóstico
        │   └── single.rs         instancia única por puerto de loopback
        ├── providers/
        │   ├── mod.rs            trait `TikTokProvider` + estados
        │   ├── tiktok.rs         provider nativo (puerto endurecido del spike)
        │   ├── simulated.rs      simulador, misma interfaz
        │   └── proto.rs          protobuf v3 generado por campo
        ├── chat/mod.rs           buffer circular + búsqueda sin acentos
        ├── database/mod.rs       SQLite: migraciones, escritor dedicado, lotes
        └── telemetry.rs          logs con rotación y purga
```

### Decisiones de diseño que se ven en el código

| Decisión | Por qué |
|---|---|
| El motor (`app.rs`) **no depende de Tauri** | El flujo completo se prueba en segundos, sin compilar la interfaz |
| El estado vive en las **métricas** (`provider_state`) | El provider y su supervisor no pueden discrepar |
| El **bus asigna `seq`** y deduplica por `source_id` | Un único escritor del estado; sin duplicados tras reconectar |
| Escritor de SQLite en **hilo propio con lotes** | `rusqlite` es síncrono: no puede bloquear los hilos de Tokio |
| Todo con **rustls** | No depende del almacén de certificados de Windows |
| El chat y los likes se pueden descartar; **regalos y follows no** | Protege lo que mueve dinero y rankings |
| `TTSDASH_DATA_DIR` | Tests, autoverificación y una eventual instalación portátil |

---

## 2. Evidencia

| Comprobación | Resultado |
|---|---|
| Tests del núcleo (`cargo test --no-default-features --lib`) | **33 pasan, 0 fallan** (~1,1 s), estables en 3 pasadas seguidas |
| Compilación con Tauri 2.11.5 (`cargo check` / `cargo build`) | ✅ sin avisos |
| Interfaz (`tsc --noEmit` + `vite build`) | ✅ 232,9 kB (72,8 kB gzip) |
| Autoverificación con simulador | 24 comentarios en memoria y **24 persistidos** (sin pérdidas), 27 regalos, 1 sesión |
| **Autoverificación contra un directo real** | 12 comentarios / 12 persistidos, 22 regalos, 19 eventos de likes (249 likes), 18 actualizaciones de viewers con 1 colapsada, 85 frames, **1 sola petición de firma**, 0 errores, 0 duplicados, 0 descartes |
| Test de regresión con frames reales grabados | ✅ decodifica los 132 frames y produce comentarios y regalos con `group_id` y `is_final` |
| **Ventana real abierta (release)** | ✅ título «TikTok LIVE Dashboard», `aplicación lista port=7879`, **`interfaz conectada con el motor (IPC operativo)`**, cierre limpio |
| Instancia única en ejecución | ✅ el puerto 7879 queda a la escucha y la segunda instancia se cierra sola |
| Consumo en reposo (release) | CPU **0,16 %** de un núcleo; **188,5 MB** de memoria privada total (14,4 MB el motor + 174,1 MB WebView2) |

### Siete fallos que solo aparecieron al abrir la ventana o conectar de verdad

Ninguno era visible con tests unitarios. Los siete están corregidos y cubiertos.

1. **98 frames recibidos, 0 eventos.** El decodificador extraía el ACK y lo enviaba, pero los
   mensajes dentro del envelope **nunca se traducían a eventos**: la función existía y no se
   llamaba desde el bucle de frames. Se unificó la ruta (`decode_frame` devuelve el ACK **y** los
   mensajes) y se añadió un **test de regresión que reproduce frames reales grabados**, sin red y
   sin gastar cuota.

2. **La aplicación no arrancaba** (`tokio::spawn` desde el setup de Tauri). El setup se ejecuta en
   el hilo principal **sin** runtime de Tokio, así que lanzar el consumidor de estado con
   `tokio::spawn` panica. El auto-test no lo veía porque crea su propio runtime. Ahora
   `AppState::consumer_future()` **devuelve** el futuro y cada llamante decide dónde ejecutarlo
   (`tauri::async_runtime` en la aplicación, `tokio::spawn` en los tests).

3. **Condición de carrera en la suscripción.** El consumidor se suscribía al primer `poll`, así que
   todo lo publicado entre el `spawn` y ese primer `poll` se perdía. Lo destapó un test que pasaba
   en aislamiento y fallaba en la suite. Ahora la suscripción se hace al crear el futuro.

4. **La interfaz no dejaba logs.** `telemetry::init()` solo se llamaba en el auto-test; la ruta de
   la ventana no inicializaba los logs. Corregido en `desktop::run()`.

5. **La ventana abría con `ERR_CONNECTION_REFUSED`.** Tauri solo sirve los recursos empaquetados
   cuando está activa la feature `custom-protocol`, y **no está entre las de Tauri por defecto**:
   sin ella la aplicación se comporta como en desarrollo y carga `devUrl`
   (`http://localhost:1420`). Un `cargo build --release` aparentemente correcto producía un
   ejecutable que intentaba conectarse a un servidor de Vite inexistente. Ahora
   `custom-protocol` forma parte de las features por defecto del proyecto, y `scripts/dev.ps1`
   la desactiva explícitamente cuando sí se quiere el servidor de desarrollo.

   Este fallo apareció **en una captura de pantalla del usuario**, no en ninguna comprobación
   automática. Para que no vuelva a pasar sin que nadie lo vea, la primera llamada al comando
   `app_snapshot` registra `interfaz conectada con el motor (IPC operativo)`: si esa línea no
   aparece en el log, la interfaz no cargó.

6. **El chat solo se actualizaba al pulsar un botón.** Faltaba el fichero
   `capabilities/default.json`. En Tauri 2, `listen()` es una API de un plugin del
   núcleo y **sin permisos explícitos la ventana no puede escuchar eventos**: la
   llamada se rechaza en silencio y la interfaz se queda solo con lo que devuelven
   los comandos. Como `invoke` sí funcionaba (los botones responden con un
   snapshot), el síntoma era desconcertante: el chat aparecía únicamente al pulsar
   Conectar o Simulador.

   Lo reportó el usuario al probar la aplicación. Además de añadir
   `capabilities/default.json` con `core:default`, la interfaz avisa a Rust
   (`ui_receiving`) la primera vez que recibe un evento, así que el log distingue
   «la ventana cargó» de «la ventana recibe datos en vivo»:

   ```text
   interfaz conectada con el motor (IPC operativo)
   interfaz recibiendo eventos del bus (flujo en vivo operativo)
   ```

7. **`400 Invalid user agent provided` al conectar a un directo real.** La URL de
   firma se construía con el User-Agent **en crudo**, y contiene espacios,
   paréntesis y barras; el servidor de firma lo rechaza. Lo llamativo es que la
   corrección ya estaba aplicada a medias: `build_ws_url` **sí** codificaba esa
   misma cadena para el WebSocket, pero `fetch_signed` no. Ahora ambas usan una
   función compartida (`sign_url` + `pct`) y hay un test que exige que la URL no
   contenga espacios ni paréntesis.

   Medido con tres variantes contra el servidor real:

   | Variante | Resultado |
   |---|---|
   | User-Agent codificado | **HTTP 200** (37 461 bytes) |
   | User-Agent en crudo | **HTTP 400** `Invalid user agent provided` |
   | Sin el parámetro | HTTP 200 |

   Lo reportó el usuario. El mismo servidor había aceptado la variante en crudo una
   hora antes, así que la lección no es «el servidor cambió» sino que **codificar
   siempre es lo correcto y lo verificado**: la variante cruda funcionaba por
   tolerancia del servidor, no por diseño.

**Lección para el resto del proyecto:** los tests unitarios con structs construidos a mano no
sustituyen ni a una grabación real, ni a abrir la aplicación, ni a **usarla**. Tres de los siete
fallos los encontró el usuario al probar, no una comprobación automática. Las trazas de IPC y las
tres variantes del sondeo de firma convierten «¿funciona?» en algo que queda por escrito.

### Rendimiento: medido en release, con la métrica corregida

| Métrica | Gate propuesto | Debug | **Release** | Veredicto |
|---|---|---|---|---|
| CPU en reposo | < 1,5 % de un núcleo | 0,00 % | **0,16 %** | ✅ |
| Memoria **privada** (comprometida) | < 250 MB | — | **188,5 MB** | ✅ |
| Suma de RSS de todos los procesos | < 250 MB | 372 MB | **366,3 MB** | ❌ métrica inválida |
| Procesos | "los mínimos posibles" | 7 | 7 (1 + 6 de WebView2) | ❌ |

Desglose en release:

| Componente | RSS | Memoria privada |
|---|---|---|
| Proceso propio (motor Rust) | 34,4 MB | **14,4 MB** |
| WebView2 (6 procesos) | 331,9 MB | 174,1 MB |
| **Total** | 366,3 MB | **188,5 MB** |

**Conclusiones:**

1. El motor propio es diminuto: **14,4 MB de memoria privada**. Todo el coste está en WebView2.
2. **Sumar RSS sobreestima gravemente**: las 6 instancias de WebView2 comparten ~140 MB de
   páginas de código y datos, y el RSS las cuenta una vez por proceso. La métrica que importa
   es la memoria privada, y ahí el gate **se cumple** (188,5 MB frente a 250 MB).
3. Sigue siendo exactamente el riesgo P1-2 de `plan-review.md`: **WebView2 es Chromium
   multiproceso**; Tauri ahorra tamaño de instalador, no memoria en ejecución. Cualquier promesa
   de "ligero" debe hablar de CPU y de memoria privada, nunca de "Tauri ocupa poco".
4. El binario en release ocupa **8,63 MB** (23,92 MB en debug).

Pendiente para el Milestone 2 (no bloquea el 1):

- Medir con PDH/ETW en lugar de `Get-Process`, y tomar como línea base **una aplicación Tauri
  vacía** en esta misma máquina para saber cuánto añade este proyecto sobre el mínimo.
- Probar mitigaciones: argumentos de WebView2 para desactivar funciones no usadas, no renderizar
  cuando la ventana está oculta, y no cargar los overlays de OBS en este mismo WebView.

---

## 3. Cuota del servidor de firma

Verificado en vivo: **una conexión completa = 1 petición**. Todo lo demás es gratis.

| Situación | Consumo | Mecanismo |
|---|---|---|
| Esperar a que empiece el directo | 0 | estado `WaitingForLive`, sondeo cada 30 s |
| Conectar | 1 | firma anónima |
| Corte y reconexión | 1 por intento | backoff con jitter, mínimo 30 s |
| Límite alcanzado (429) | — | pausa de 10 min y aviso en la interfaz |
| Fallos repetidos | — | se detiene tras 10 fallos consecutivos |
| Dos ventanas abiertas | — | imposible: guarda de instancia única |

---

## 4. Desviaciones respecto al plan original

| Plan original | Lo construido | Motivo |
|---|---|---|
| Sidecar Python con TikTokLive + JSONL por stdin/stdout | **Provider nativo en Rust** | El spike (D5/D8) demostró que es viable y elimina el AGPL, el empaquetado de Python, ~9 MB de RAM y un proceso |
| `ProcessManager` con `start/stop/restart/health_check` | Supervisor en la misma tarea Tokio | No hay proceso hijo que gestionar; quedan los estados y el backoff |
| Uno o dos sidecars | Python queda **solo** para `edge-tts` (Milestone 3) | El camino crítico de eventos ya no lo necesita |
| `single-instance` como plugin de Tauri | Puerto de loopback reservado | Sin dependencias extra; además detecta el conflicto del futuro puerto de overlays |

El trait `TikTokProvider` se mantiene, con dos implementaciones reales (nativa y
simulada), que es lo que garantiza que el proveedor siga siendo sustituible.

---

## 5. Pendiente (fuera del Milestone 1)

- **Combos de regalos**: el `group_id` y `is_final` ya llegan correctamente; falta el
  `GiftComboTracker` que consolide el streak y emita el evento final.
- **Reconexión observada en vivo**: el backoff está implementado y probado en
  unitarios, pero no se ha provocado un corte real (el siguiente paso natural).
- **ACK contra servidor real**: ninguna sesión observada pidió ACK; el código está
  implementado y a la espera de la primera ocurrencia.
- **Gzip en frames `msg`**: los frames `msg` observados venían sin comprimir.
- **Follow vs share**: el discriminador usa `common.display_text.key` (contiene
  "follow"); no se han observado follows reales todavía.
- **Medición con PDH/ETW**: `Get-Process` no distingue por debajo de ~0,3 % de núcleo.
- **Milestone 2 en adelante**: servidor HTTP + WebSocket para overlays, TTS, regalos y
  rankings, metas y recompensas, overlays de OBS.

---

## 6. Reproducir esta verificación

```powershell
. .\scripts\env.ps1
cd apps\desktop\src-tauri

cargo test --no-default-features --lib                 # 33 tests, ~1 s
cargo run --offline --no-default-features -- --self-test --seconds 5

# Interfaz
cd ..
node node_modules\typescript\bin\tsc --noEmit
node node_modules\vite\bin\vite.js build
```

Para una sala en directo:
`python spikes\provider-probe\find_live_handles.py` obtiene handles activos de los
leaderboards públicos y comprueba `is_live` **sin gastar cuota de firma**.
