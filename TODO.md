# Qué se está haciendo y qué falta

Este archivo es el **punto de entrada para continuar el proyecto**. Dice en qué estado está, cómo se trabaja aquí (comandos, gates y convenciones) y qué queda pendiente por orden de importancia. El detalle de cada decisión, con su evidencia, está en `docs/decisions.md`; la descripción del producto, en `README.md`.

---

## 1. Estado ahora mismo

- **Rama:** `main`, en `0204541` (local y remoto coinciden). Repositorio privado: `https://github.com/tacosandtypescript-debug/tiktok-stream-dashboard`.
- **Tests:** **172** (153 del núcleo + 14 de flujo completo + 5 de límites), 0 fallos. Pasan tanto con audio como con `TTSDASH_AUDIO=off`.
- **Gates de calidad:** `cargo fmt --all -- --check` y `cargo clippy --workspace --all-targets --all-features -- -D warnings` pasan limpios en local.
- **Verificado en vivo** con el binario fusionado (120 s, `@azoz._.mx2`, release): 290 frames del WebSocket, 638 comentarios, 1 139 eventos publicados, 7 regalos, 18 follows, 94 746 likes, 52 actualizaciones de espectadores, **9 duplicados descartados** y 0 errores.
- **CI (GitHub Actions):** el *workflow* existía pero **nunca había pasado**. Fallaba con un *access violation* (`0xC0000005`) que mataba el binario de tests: en un runner sin tarjeta de sonido, WASAPI no devuelve un error al enumerar salidas, revienta el proceso. Arreglado con `TTSDASH_AUDIO=off` (commit `0204541`). **La ejecución de comprobación seguía en curso al escribir esto, así que el verde del CI está por confirmar.**
- **Fusión con las ramas de codex:** `main` absorbió 13 commits (`codex/quality-ci-docs`, que estaba construida sobre mi trabajo) más el arreglo del sidecar. La rama `codex/integration-p0p1` se adelantó en el remoto a `62ae345`.

## 2. Cómo se trabaja aquí

### Entorno

```powershell
. .\scripts\env.ps1          # deja CARGO_HOME y las caches dentro del proyecto
.\scripts\setup.ps1          # venv de Python con dependencias fijadas (una vez)
```

`cargo` compila siempre con `--offline` (las dependencias se descargan aparte, una sola vez). Los ficheros nuevos de Rust necesitan un `cargo fetch` con permiso ampliado.

### Comandos

```powershell
cd apps\desktop\src-tauri
cargo test --offline                 # 172 tests; NO necesita el sidecar empaquetado
cargo test --offline --lib           # solo el núcleo (segundos)
cargo fmt --all -- --check           # gate de formato
cargo clippy --workspace --all-targets --all-features --offline -- -D warnings

# Autoverificación del motor (base de datos y logs reales)
cargo run --offline --no-default-features -- --self-test --seconds 5
cargo run --offline --no-default-features -- --self-test --live usuario --seconds 120

# Voz
cargo run --offline --no-default-features -- --tts-test "Hola" --rate +25%
cargo run --offline --no-default-features -- --tts-voices

# Interfaz
cd apps\desktop
node node_modules\typescript\bin\tsc --noEmit
node node_modules\vite\bin\vite.js build

# Empaquetado completo (release + sidecar + instalador NSIS)
.\scripts\build.ps1 -Bundle
```

### Dónde mirar cuando algo no funciona

| Qué | Dónde |
|---|---|
| Log con marcas de tiempo | `%LOCALAPPDATA%\TikTokStreamDashboard\logs\app.log.<fecha>` |
| Avisos y errores | `...\logs\error.log.<fecha>` |
| Base de datos | `...\data\dashboard.db` (esquema v5) |
| Audio sintetizado | `...\cache\tts\` (se poda solo: 200 MB / 7 días) |

El log es la fuente de verdad del proyecto: la interfaz informa al motor de lo que recibe y pinta (`ui_chat`), así que se puede saber si un fallo está en la cadena de eventos o en el render **sin mirar la pantalla**. En el panel de **Desarrollador** (botón de la cabecera) se ven los tipos de evento reconocidos, la traza del chat, los errores de escritura de la base y el contador de firmas.

### Convenciones

- **Comentarios en español, sin acentos** (el código no lleva acentos; los documentos sí).
- **Textos de la interfaz solo en** `apps/desktop/src/i18n/es.ts`. Las frases que se leen en voz alta se componen en Rust (`tts/mod.rs`).
- **Cada decisión en un solo sitio**: si algo se calcula en dos lugares, es un fallo esperando a pasar (costó dos veces: la velocidad del TTS y los diamantes de las rachas).
- **Nada crece sin límite**: buffers, colas, caches y memorias de duplicados tienen tope y se cuenta lo descartado.
- **Sin bucles ocupados ni temporizadores ociosos**: los sondeos solo existen mientras su página está abierta.
- **Los números de campo del protocolo** se extraen de la metadata real instalada (`python spikes/provider-probe/dump_proto.py`), **nunca** de un `.proto` de terceros.
- Toda decisión no obvia va a `docs/decisions.md` con la evidencia que la respalda (medida, no supuesta).

### Verificación en vivo (ojo con la cuota)

Cada conexión consume **1 unidad** de la cuota del servidor de firma: **5/min, 30/h, 100/día**. Esperar a que empiece el directo no gasta. Antes de conectar, comprobar si la sala está en directo:

```powershell
.tooling\venv\Scripts\python.exe spikes\provider-probe\probe.py islive <usuario>
```

Para verificar la interfaz y el TTS: `TTSDASH_AUTOSTART=<usuario>` y `TTSDASH_TTS=on` (el log recoge la traza del chat y el TTS deja sus frases en `debug`). **Cerrar la aplicación antes de compilar**: el ejecutable está bloqueado mientras corre.

## 3. Lo que falta, por orden

### Bloqueantes de la entrega

1. **Confirmar que el CI pasa.** El arreglo del audio está subido; falta ver la ejecución en verde. Si vuelve a fallar, el siguiente sospechoso de tocar hardware/OS es el guardián de instancia única (puerto TCP) y las rutas temporales.
2. **Ejecutar el empaquetado completo** (`scripts/build.ps1 -Bundle`): el CI valida `setup.ps1` + sidecar con PyInstaller + release, pero **el instalador NSIS no se ha ejecutado nunca**.

### Huecos de producto

3. **Interfaz para los filtros del TTS**: las palabras y usuarios bloqueados existen y funcionan, pero se editan en código. Necesita comandos de Tauri, formulario y validación (con tests).
4. **Voces**: el selector usa un catálogo curado; el listado completo del servicio no se ha volcado. Además no se puede forzar el idioma de un mensaje y la heurística clasifica mal español sin acentos ni palabras frecuentes (`vamos a jugar` → inglés).
5. **Métrica de suscriptores**: `metrics.subscribers` solo crece porque nadie la decrementa al soltar un receptor. O se envuelve el receptor para que sea un valor vivo, o se etiqueta como acumulado.
6. **Residuo del Panel**: cerrado (D20). El Panel se quitó, y con él su tarjeta; las cinco páginas que quedan miden 0 px de desbordamiento en `main`, comprobado en el banco de la interfaz.

### El bloque grande del plan

7. **Overlays para OBS**: hecho (D18, D19, D20 y D21). Servidor Axum + WebSocket con token, **once diseños** —ocho marcadores y tres minijuegos— elegibles por vista, **alertas** con medios, texto y sonido, y la dirección de OBS de cada fuente en la interfaz.
   - Queda por **medir el coste de la vista previa de los minijuegos**. Son lienzos de 1080×1920 animando a 60 fotogramas por segundo, y el plan (§175) cuenta cada renderer de WebView2: en OBS el coste es el de siempre, pero el de la previa dentro de la aplicación no está medido. Si sale caro, la salida es no previsualizarlos y dejar solo su ficha.
   - Y queda por **probar las alertas en un directo real**: todo lo verificado es con el simulador. Lo que no se puede comprobar sin un directo de verdad es cómo se encadenan las alertas en una lluvia de regalos.
8. **Metas y recompensas** (los rankings de regalos ya están).
9. **Perfiles múltiples**: hoy solo se persiste el perfil de TTS.

### Cabos sueltos

10. `a2159af` (punta local de la rama de integración de codex) **no existe en el remoto**, así que no se ha podido revisar; el remoto de esa rama está en `62ae345`.
11. `WebcastSubNotifyMessage`: sus tags **sí** se han validado contra la metadata real (1, 2, 4, 5, 9 y 10), así que ese riesgo está cerrado.

## 4. Cosas deliberadas (no son fallos)

- Las **entradas a la sala** se cuentan, no se listan: son el mensaje más frecuente de TikTok y una fila por entrada taparía el chat.
- `WebcastMemberMessage` **no** se filtra por `action`: la spec lo describe como una variedad de eventos y filtrar arriesga perder entradas reales.
- Tras un fin de directo puede aparecer un segundo `StreamDisconnected` (el socket tarda en caer): en el motor es idempotente y solo deja una línea informativa más.
- El **sidecar empaquetado** solo hace falta para el instalador: `cargo build` y `cargo test` funcionan en un clon limpio (la config de empaquetado vive en `tauri.bundle.conf.json`).

## 5. Convención de commits

Un commit por cambio con intención clara, en español, explicando **qué** y **por qué**; los mensajes incluyen la evidencia medida cuando la hay. Nada de `WIP`. El repositorio es privado y de uso personal (ver D1 en `docs/decisions.md`).

19. **El panel de Overlays abre desplazado.** Medido: 76 px, que es justo su maximo (982 de contenido contra 906 de alto), asi que aparece con lo primero de la pagina —la direccion para OBS— fuera de la vista. Se probaron el reseteo al cambiar de pestana y desactivar `overflow-anchor`; ninguno funciono y no se ha encontrado la causa. Ver D22.
