# Spike: provider TikTok LIVE nativo en Rust — informe final

**Fecha:** 2026-09-17
**Objetivo (docs/decisions.md D5):** decidir si un provider TikTok nativo en Rust es viable, en lugar del sidecar Python con TikTokLive.
**Veredicto: SÍ. Las 4 etapas validadas contra tráfico real en una sala en directo.**

---

## 1. Resultado por etapas

| # | Etapa | Estado | Evidencia |
|---|---|---|---|
| 1 | Resolver `room_id` de un `@usuario` | ✅ | `handle=@_inooori_ live=true room_id=7686341765710269205` |
| 2 | Payload firmado **sin API key** | ✅ | `firma OK: push_server=wss://webcast-ws.tiktokn.com/... cookies=presentes` |
| 3 | Handshake WebSocket | ✅ | `WebSocket CONECTADO (HTTP 101 Switching Protocols)` |
| 4 | Decodificar protobuf | ✅ | Comentarios, regalos, likes, viewers y social decodificados en 2 sesiones reales (132 frames / 120 s y 58 frames / 55 s) |

**Cero Python en el camino de eventos.** El binario Rust resuelve la sala, se firma, conecta, mantiene el heartbeat y decodifica por sí solo. Python queda **solo** para `edge-tts`.

Muestra real capturada (sala japonesa, ~9 300 espectadores):

```
[live] CHAT  そらくん/sorakun (@sorakun._.09): まんじゃろ？
[live] GIFT  mochipuni🫯go.yo (@otetsudai.yo) -> "Heart Me" x1 (diamantes=1, streakable=false, final=false, grupo=0)
[live] GIFT  良蹴🐶 (@yosiki1111) -> "いのりの学校" x1 (diamantes=1, streakable=true, final=false, grupo=1789625806726)
[live] GIFT  良蹴🐶 (@yosiki1111) -> "いのりの学校" x1 (diamantes=1, streakable=true, final=true,  grupo=1789625806726)
[live] LIKE  ねぎ²Jr. (@kinokonoyama_05) +15 (total 25447)
[live] VIEW  espectadores=9123 (total=130)
[live] SOCIAL 石坂ふみ🌙🫧 (@fumifumi04250) action=4 share_type=0 follows=0
```

---

## 2. Rendimiento medido (release, sesión en directo de 55 s)

| Métrica | Valor medido |
|---|---|
| **RAM (RSS)** | **9,4 – 9,8 MB**, estable, sin crecimiento en 55 s |
| **CPU** | por debajo de la resolución de medida (< 0,3 % de un núcleo); 0,02 s acumulados en los primeros 5 s (arranque) y ~0 después |
| Hilos | 16 – 18 |
| Handles | ~140, estables |
| Tamaño del binario | **3,14 MB** |
| Decodificación | **1 630 frames/s · 0,61 ms por frame** (replay de frames reales) |
| Procesos | **1** (frente a 1 + intérprete Python) |

**Comparación con la alternativa Python** (medida en disco): venv de TikTokLive + edge-tts = 24,3 MB, intérprete CPython embebido = 61,4 MB → **85,7 MB solo en disco**, antes de contar su RSS en ejecución.

Estos números entran de sobra en los gates de `docs/plan-review.md` (idle < 1,5 % CPU y < 250 MB RSS para el total de la aplicación).

---

## 3. Hallazgos técnicos verificados (y correcciones al plan)

### 3.1 Crítico: `service` y `method` del frame son `uint64`

```protobuf
message WebcastPushFrame {
  uint64 seqId   = 1;
  uint64 logId   = 2;
  uint64 service = 3;   // uint64, NO string
  uint64 method  = 4;   // uint64, NO string
  repeated PushHeader headers = 5;
  string payloadEncoding = 6;
  string payloadType     = 7;   // "msg" | "ack" | "hb" | "im_enter_room_resp"
  bytes  payload         = 8;
}
```

Declararlos como `string` no produce un error parcial: **prost rechaza el 100 % de los frames** por discrepancia de wire type, y el síntoma es engañoso ("conecta pero no llega nada"). Se detectó volcando los bytes crudos y leyendo los tags a mano (`18 b8 45` = campo 3 varint; `20 08` = campo 4 varint). Ninguna de las tres fuentes MIT consultadas coincidía en estos dos tipos.

**Regla para el proyecto: el frame se valida contra bytes reales grabados, nunca contra un `.proto` de terceros.**

### 3.2 El `group_id` del propio mensaje identifica el streak

Verificado en directo: dos eventos del mismo regalo streakable comparten `group_id=1789625806726`, el primero con `repeat_end=0` (progreso) y el segundo con `repeat_end!=0` (final). Los regalos **no** streakables llegan con `group_id=0`.

Consecuencias:
- **No hay que sintetizar un `combo_id`** como proponía mi propia revisión del plan (`{user}:{gift}:{timestamp}`). El identificador real, gratuito y exacto es `group_id`. Corregido.
- La clave del `GiftComboTracker` es `group_id`, no la tupla usuario+regalo: un mismo usuario puede tener **dos streaks abiertos a la vez** de regalos distintos (se observó: `いのりの学校` y `Popular Vote` intercalados, con grupos diferentes). Un tracker indexado por usuario los habría fusionado.
- Señal de cierre: `repeat_end != 0`. Acumulable: `gift.type == 1`.

### 3.3 Likes: incremento + total absoluto (confirmado)

`count`(campo 2) es el incremento (`+15`, `+8`, `+2`) y `total`(campo 3) es el absoluto y monótono (25432 → 25547). Justo lo que pedía la revisión del plan: en el protocolo interno se enviará el absoluto y Rust calculará el delta.

### 3.4 Los nombres de campo de viewers engañan

| Campo | Número | Qué es realmente | Prueba |
|---|---|---|---|
| `total` | 3 | **Espectadores actuales** (~130, fluctúa) | TikTok reporta `userCount=138` en `api-live/user/room` |
| `total_user` | 7 | **Espectadores acumulados** (9 123, monótono) | Coherente con `enterCount=7314` |

Usar `total_user` como "viewers" (que es lo que sugiere el nombre) mostraría 9 300 en lugar de 130. Verificado contra la fuente de TikTok, no contra documentación.

### 3.5 Cuota anónima: 5/min · 30/h · 100/día

Medida contra `/webcast/rate_limits` sin API key. La URL firmada caduca en ~30 s. Total consumido por este spike: **5 unidades de 100**, en 2 sesiones completas y 3 diagnósticos.

### 3.6 `replay` es la herramienta de desarrollo decisiva

`--record` graba los frames crudos; `replay` los decodifica sin red. Las dos sesiones quedan como fixtures reales, incluido un par de streak completo y regalos de 1 y 30 diamantes:

| Fixture | Contenido |
|---|---|
| `live.jsonl` | 378 KB · 132 frames · 120 s |
| `live2.jsonl` | 169 KB · 58 frames · 55 s |

Estos ficheros son la base directa de los **contract tests** de `plan-review.md` §58: alimentan el decodificador sin gastar cuota ni necesitar una sala viva.

---

## 4. Trabajo pendiente (fuera del alcance del spike)

| Pendiente | Nota |
|---|---|
| Distinguir *follow* de *share* en `WebcastSocialMessage` | `action=4` no es discriminante; el spec apunta a una coincidencia sobre `common.display_text.key`. Hay que verificarlo con una sala donde ocurran follows reales |
| ACK contra servidor real | Nunca se activó `need_ack` en las sesiones observadas; el código está implementado y hay que validarlo con la primera ocurrencia |
| Validar la ruta gzip de un frame `msg` | Los frames `msg` observados venían con `compress_type: none`; el `hb` sí venía gzip. `flate2` está implementado; falta una ocurrencia real |
| Métricas con resolución fina (PDH/ETW) | `Get-Process` no distingue por debajo de ~0,3 % de núcleo; para el gate de release hace falta `Get-Counter` |
| Sesiones bajo carga real (100 msg/s) | La sala observada era moderada; el stress test de §72 sigue pendiente |

---

## 5. Reproducir

```powershell
. .\scripts\env.ps1
cd spikes\tiktok-rust-provider
cargo build --release --offline

target\release\tiktok-rust-provider-spike.exe islive <handle>            # etapa 1, 0 cuota
target\release\tiktok-rust-provider-spike.exe watch <handle> --dry-run   # 0 cuota
target\release\tiktok-rust-provider-spike.exe watch <handle> --skip-ws   # etapa 2, 1 unidad
target\release\tiktok-rust-provider-spike.exe watch <handle> --seconds 120 --record live.jsonl
target\release\tiktok-rust-provider-spike.exe replay live.jsonl          # 0 cuota
```

Para encontrar una sala viva: `spikes/provider-probe/find_live_handles.py` extrae handles de los leaderboards públicos de Euler Stream y comprueba `is_live` (scraping, sin firma y sin cuota).

Especificación completa del protocolo: `PROTOCOL-SPEC.md` (2170 líneas, `.proto` MIT verbatim, tabla de 37 métodos, errores literales observados).
