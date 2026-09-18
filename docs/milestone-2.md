# Milestone 2 — TTS (en curso)

**Estado: base completa y verificada; falta la reproducción de audio y la interfaz.**

Objetivo (docs/decisions.md D3): leer el chat con `edge-tts` en español e inglés.
Python se usa **solo** para convertir texto en audio; Rust decide **qué** se lee,
**cuándo** y **con qué prioridad**.

---

## 1. Arquitectura

```text
chat.message (event bus)
        │
        ▼
   filters.rs      normalizar → bloqueados → URL → spam → duplicado →
                   repetidos → longitud → cooldown por usuario → límite global
        │
        ▼
   queue.rs        prioridades + aging + reserva anti-inanición + tope
        │
        ▼
   provider.rs     sidecar Python (JSONL por stdin/stdout) + caché en disco
        │
        ▼
   edge-tts        (Microsoft)     ← único punto donde interviene Python
```

| Fichero | Responsabilidad |
|---|---|
| `tts/filters.rs` | Pipeline de descarte y cooldowns |
| `tts/queue.rs` | Cola acotada con prioridades, aging y reserva |
| `tts/voices.rs` | Catálogo curado ES/EN y detección de idioma |
| `tts/provider.rs` | Cliente del sidecar: arranque, protocolo, timeout, caché |
| `services/tts-provider/src/main.py` | Sidecar: una frase → un MP3 |
| `tts/mod.rs` | Configuración, localización del intérprete y ayudas |

---

## 2. Evidencia

| Comprobación | Resultado |
|---|---|
| Tests del núcleo | **58 pasan, 0 fallan** (18 nuevos de TTS) |
| Compilación con la interfaz | ✅ sin avisos |
| Sidecar: modo directo | `--once` → 16 992 bytes en **657 ms** |
| Sidecar: protocolo JSONL | `ping`, `synthesize`, comando desconocido y línea corrupta → responde a todo **sin morir** |
| Sondeo completo (`--tts-test`) | síntesis en **566 ms**, MP3 de 25 200 bytes, **segunda llamada desde caché**, poda de caché ejecutada |
| Voz en español y en inglés | 21 KB y 15,9 KB, MP3 válido (cabecera `ff f3`) |

Ejemplo real de salida:

```json
{
  "interprete": ".tooling/venv/Scripts/python.exe",
  "voz": "es-ES-ElviraNeural",
  "texto": "Carlos dice: hola a todos, vamos con otra partida.",
  "bytes": 25200,
  "sintesis_ms": 566,
  "desde_cache": true,
  "aciertos_de_cache": 1,
  "sidecar_arranques": 1
}
```

---

## 3. Decisiones que no son obvias

1. **La firma de la caché es FNV-1a propia**, no el hasher de la biblioteca
   estándar: la salida de `DefaultHasher` no está garantizada entre versiones de
   Rust, y una actualización del compilador invalidaría toda la caché.
2. **La normalización trata los espacios antes que los caracteres de control.**
   En Rust `\n` y `\t` **son** caracteres de control; comprobarlos primero
   convertía `"hola\nmundo"` en `"holamundo"`, y el TTS habría leído una palabra
   inventada. Lo detectó un test.
3. **Un regalo prioritario puede desalojar a cualquiera; un mensaje normal solo
   desaloja a otro normal.** La reserva se define por cupo (`capacity - reserve`
   para los prioritarios) en lugar de por grupo de desalojo: así una avalancha de
   regalos no puede ocupar la cola entera, pero un regalo grande sí adelanta al
   chat.
4. **`tracing-appender` entra en pánico si no puede crear el fichero de log.** Un
   sondeo de TTS murió por eso cuando el sandbox denegó la escritura en
   `%LOCALAPPDATA%`. Ahora la telemetría comprueba la escritura **antes** y, si
   falla, sigue solo por consola: quedarse sin logs es molesto, no poder abrir la
   aplicación es inaceptable.
5. **La caché se poda por caducidad y por tamaño** (200 MB, 7 días): el audio
   sintetizado no puede llenar el disco (plan-review.md §50).
6. **Los logs del sidecar van a stderr** y se reenvían a `tracing`. stdout es
   exclusivamente protocolo: un `print` suelto en Python corrompería el canal.

---

## 4. Pendiente para cerrar el Milestone 2

| Pendiente | Nota |
|---|---|
| **Reproducción de audio** | `rodio` ya está en las dependencias. Un **único flujo de salida persistente**, nunca un reproductor por frase, con selección de dispositivo (permite rutear el TTS a un cable virtual para OBS) |
| **`TtsManager`** | Une bus → filtros → cola → sidecar → reproductor, con pause / resume / skip / clear / mute por usuario |
| **Página de TTS en la interfaz** | Cola visible, voz por idioma, controles, contador de descartes por motivo |
| **Persistencia de ajustes** | Los `FilterConfig` deben guardarse en SQLite por perfil |
| **Verificación en directo** | Que un mensaje real de un directo suene por los altavoces |
| **Arranque en release** | Localizar el intérprete embebido cuando no exista `.tooling/venv` (empaquetado, P0-3) |
| **Cancelación de síntesis en vuelo** | Hoy «saltar» descarta el elemento de la cola; la síntesis ya lanzada termina y se ignora |

---

## 5. Reproducir

```powershell
. .\scripts\env.ps1
cd apps\desktop\src-tauri

cargo test --no-default-features --lib

# Sintetiza una frase y resume el resultado (usa el sidecar real)
cargo run --offline --no-default-features -- --tts-test "Hola, esto es una prueba."

# Voces disponibles en el sidecar y catálogo curado del proyecto
cargo run --offline --no-default-features -- --tts-voices
```

El sondeo usa el intérprete del proyecto (`.tooling/venv`). Se puede forzar otro
con `TTSDASH_PYTHON` y la raíz del repositorio con `TTSDASH_ROOT`.
