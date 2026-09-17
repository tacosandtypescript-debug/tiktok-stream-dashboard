# Revisión de arquitectura: el flujo de eventos

**Pregunta que responde este documento:** dónde se rompe la cadena
`TikTok LIVE → listener → normalizador → event bus → WebSocket/IPC → interfaz`
y cómo se detecta cada fallo **sin depender de mirar la pantalla**.

El flujo pedido y el flujo real, con nombres de módulo:

```text
TikTok LIVE
   │  WebSocket + protobuf (wss://webcast-ws...)
   ▼
providers/tiktok.rs        ← listener + normalizador (decode_frame + translate_message)
   │  EventKind normalizado
   ▼
core/bus.rs                ← EventBus: seq, deduplicacion por source_id, metricas
   │  tokio::sync::broadcast<Arc<Event>>
   ├──────────────► app.rs::consumer_future   → chat, regalos, actividad, SQLite
   └──────────────► desktop.rs::spawn_ui_bridge → app.emit("dash://event")
                                                     │  IPC de Tauri
                                                     ▼
                                              React (App.tsx) → páginas
```

El bus es el único punto por el que circula el estado: **cinco eslabones**, y cada
uno falla de una forma distinta y reconocible.

---

## 1. Los cinco fallos posibles y su firma

| # | Eslabón | Cómo se rompe | Síntoma que ve el usuario | Cómo se detecta ahora |
|---|---|---|---|---|
| 1 | Provider (decodificación) | Un frame se decodifica pero sus mensajes no se traducen a eventos | "Conecta pero no llega nada" | Test de regresión con **132 frames reales grabados** (`live.jsonl`): si dejan de producir eventos, falla el test |
| 2 | Bus → estado | El consumidor se suscribe tarde y pierde lo publicado antes | Faltan los primeros eventos de cada conexión | La suscripción se hace **al crear el futuro**, no en el primer `poll` (probado con un test que fallaba en la suite) |
| 3 | Bus → WebView | Falta el permiso de eventos en `capabilities/default.json` | **El chat no se actualiza**; los botones sí responden (devuelven un snapshot) | Traza `interfaz recibiendo eventos del bus` en el log |
| 4 | WebView → React | El payload no tiene la forma esperada, o llega un tipo que ningún `case` maneja | Los eventos llegan pero la interfaz no repinta | **Test de contrato en Rust** (serializa cada variante y exige `type` plano + campos) y contador `sin_manejar:<tipo>` que la interfaz reporta a Rust |
| 5 | Render de React | Una excepción dentro de un actualizador de estado desmonta el árbol | **La ventana se congela o queda en blanco** y nada vuelve a actualizarse | Barrera de errores que muestra el fallo y lo reporta: comando `ui_error` → `error.log` |

Los tres últimos comparten un rasgo peligroso: **el motor sigue funcionando** (los
datos se guardan en SQLite), así que sin estas comprobaciones el fallo es
invisible desde fuera.

---

## 2. Garantías que ahora están fijadas por tests

| Garantía | Dónde vive |
|---|---|
| El protocolo lleva `type` plano y los campos que la interfaz lee | `src/core/contract.rs` |
| Un regalo conserva usuario, regalo, cantidad, diamantes, racha, icono y grupo | `src/core/contract.rs` + `providers/tiktok.rs` |
| Los frames reales producen comentarios y regalos con `group_id` e `is_final` | `providers/tiktok.rs` (fixture `live.jsonl`) |
| Los buffers no crecen: chat 200, actividad 150, regalos 150 | `feed.rs`, `chat/mod.rs`, `tests/stress_limits.rs` |
| La deduplicación por `(room_id, source_id)` no duplica nada | `core/bus.rs`, `tests/integration_flow.rs` |
| Las migraciones no destruyen datos (v1 → v2) | `database/mod.rs` |
| El estado del proveedor es único y consistente | `providers/mod.rs` (`StatusReporter` sobre `metrics.provider_state`) |

## 3. Estados de conexión

```text
Desconectado ──► Iniciando ──► Conectando ──► Conectado
                     │              │             │
                     │              │             └──► Reconectando ──┐
                     │              │                                │
                     └──────────────┴────────────► Error ◄───────────┘
                                    │
                                    └──► Esperando directo (no gasta cuota)
```

- El estado vive en **un solo sitio**: `metrics.provider_state`, escrito por
  `StatusReporter`. El proveedor, su supervisor y la interfaz no pueden discrepar.
- La interfaz **no deduce** el estado: lo recibe por eventos `provider.status` y lo
  confirma con el `status` del snapshot.
- `Esperando directo` es propio de este proyecto y obligatorio: esperar a que el
  usuario empiece a emitir **no** consume cuota de firma.

## 4. Qué se emite, qué se guarda y qué se muestra

| Evento | Se emite | Se guarda | Se muestra |
|---|---|---|---|
| `chat.message` | ✅ | `comments` (con `source_id` único) | chat + panel |
| `gift.received` | ✅ (con icono, racha y grupo) | `gift_events` + totales de la sesión | panel, regalos, actividad |
| `like.updated` | ✅ (incremento y total absoluto) | contadores en memoria | pie de estadísticas; al feed solo si es una ráfaga grande |
| `viewer.updated` | ✅ (colapsado a 1/s) | — | pie de estadísticas |
| `follow.received` | ✅ | `follows` | actividad |
| `share.received` | ✅ | `social_events` (kind=`share`) | actividad |
| `subscribe.received` | ✅ | `social_events` (kind=`subscribe`) | actividad |
| `stream.connected` / `disconnected` / `waiting` | ✅ | sesión (inicio, fin, motivo) | cabecera y actividad |
| `provider.status` | ✅ | — | píldora de estado; al feed solo si es error |
| `chat.message.deleted` | ❌ pendiente | — | — |

## 5. Diagnóstico incorporado

Todo lo anterior se puede comprobar **sin ver la pantalla**, leyendo el log:

```text
interfaz conectada con el motor (IPC operativo)          → los recursos y el IPC funcionan
interfaz recibiendo eventos del bus (flujo en vivo...)   → los eventos llegan al WebView
la interfaz ha reconocido un tipo de evento nuevo ...    → hay un case que lo pinta
la interfaz ha reconocido un tipo de evento nuevo sin_manejar:... → llega algo que NO se pinta
```

La página **Desarrollador** muestra además la tabla *Eventos vistos por la
interfaz*: si un tipo aparece con `sin_manejar`, hay un evento de TikTok que se
está perdiendo en silencio.

## 6. Pendiente, con su motivo

| Pendiente | Motivo |
|---|---|
| Verificar `share` y `subscribe` con tráfico real | Los enums de tipo de suscripción no están verificados; se emiten solo cuando llegan meses implicados |
| `WebcastMemberMessage` (entradas al directo) | Es muy frecuente; merece su propia política de ruido antes de mostrarlo |
| Batallas PK, encuestas, moderación | Fuera del alcance de la conexión ligera |
| `chat.message.deleted` | El evento se recibe; falta el borrado en la interfaz |
| Imagen del regalo en todas las vistas | Hoy se muestra en actividad y en la lista de regalos |
