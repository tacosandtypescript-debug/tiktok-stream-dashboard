"""Sidecar de sintesis de voz (edge-tts).

Python se usa **solo** para sintetizar. Todo lo demas —cola, prioridades,
filtros, cache y reproduccion— vive en Rust (docs/decisions.md D3).

Contrato: JSON Lines por stdin/stdout. **Una linea = un mensaje.** stdout es
exclusivamente protocolo; los logs van a stderr, porque un solo `print` suelto
corromperia el canal.

Peticiones:

    {"id": "1", "cmd": "ping"}
    {"id": "2", "cmd": "voices"}
    {"id": "3", "cmd": "synthesize", "text": "hola", "voice": "es-ES-ElviraNeural",
     "rate": "+0%", "pitch": "+0Hz", "volume": "+0%", "out": "C:\\...\\1.mp3"}
    {"cmd": "shutdown"}

Respuestas:

    {"id": "1", "ok": true, "cmd": "pong"}
    {"id": "2", "ok": true, "voices": [{"name": "...", "locale": "es-ES", "gender": "Female"}]}
    {"id": "3", "ok": true, "path": "...", "bytes": 21504, "ms": 1420}
    {"id": "4", "ok": false, "error": "..."}

Una peticion invalida **nunca** tumba el proceso: se responde con `ok: false`.

Uso directo (para pruebas):

    python main.py --once --text "hola" --voice es-ES-ElviraNeural --out salida.mp3
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# El protocolo exige UTF-8 en ambos sentidos; en Windows la consola usa cp1252.
for stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass


def log(message: str) -> None:
    """Log a stderr: stdout esta reservado al protocolo."""
    print(message, file=sys.stderr, flush=True)


def emit(payload: dict[str, Any]) -> None:
    """Escribe una respuesta del protocolo, garantizando el volcado inmediato."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


async def synthesize(request: dict[str, Any]) -> dict[str, Any]:
    """Sintetiza una frase a un fichero MP3."""
    import edge_tts

    text = str(request.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "texto vacio"}

    voice = str(request.get("voice") or "")
    if not voice:
        return {"ok": False, "error": "falta la voz"}

    out = request.get("out")
    if not out:
        return {"ok": False, "error": "falta la ruta de salida"}
    path = Path(str(out))
    ensure_parent(path)

    started = time.perf_counter()
    communicate = edge_tts.Communicate(
        text,
        voice,
        rate=str(request.get("rate") or "+0%"),
        volume=str(request.get("volume") or "+0%"),
        pitch=str(request.get("pitch") or "+0Hz"),
    )

    # `save` escribe el MP3 completo; para frases cortas la latencia es la del
    # servicio (0,4-1,5 s medidos), aceptable para una cola de chat.
    await communicate.save(str(path))

    if not path.exists() or path.stat().st_size == 0:
        return {"ok": False, "error": "el servicio no devolvio audio"}

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    return {
        "ok": True,
        "path": str(path),
        "bytes": path.stat().st_size,
        "ms": elapsed_ms,
    }


async def list_voices() -> dict[str, Any]:
    import edge_tts

    voices = await edge_tts.list_voices()
    return {
        "ok": True,
        "voices": [
            {
                "name": voice.get("ShortName", ""),
                "locale": voice.get("Locale", ""),
                "gender": voice.get("Gender", ""),
            }
            for voice in voices
        ],
    }


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    """Procesa una peticion. Devuelve `None` para indicar "terminar"."""
    command = str(request.get("cmd") or "")
    request_id = request.get("id")

    if command == "shutdown":
        return None

    if command == "ping":
        return {"id": request_id, "ok": True, "cmd": "pong"}

    try:
        if command == "voices":
            result = asyncio.run(list_voices())
        elif command == "synthesize":
            result = asyncio.run(synthesize(request))
        else:
            result = {"ok": False, "error": f"comando desconocido: {command!r}"}
    except Exception as error:  # noqa: BLE001 - el sidecar no debe morir por una peticion
        log(f"error en {command!r}: {type(error).__name__}: {error}")
        result = {"ok": False, "error": f"{type(error).__name__}: {error}"}

    result["id"] = request_id
    return result


def serve() -> int:
    """Bucle principal: lee peticiones de stdin hasta el final de la entrada."""
    log("tts-provider listo")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            # Una linea corrupta se responde y se sigue: nunca se aborta.
            emit({"ok": False, "error": f"JSON invalido: {error}"})
            continue

        if not isinstance(request, dict):
            emit({"ok": False, "error": "se esperaba un objeto JSON"})
            continue

        response = handle(request)
        if response is None:
            log("tts-provider detenido")
            return 0
        emit(response)
    log("stdin cerrado; tts-provider termina")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Sidecar de TTS (edge-tts)")
    parser.add_argument("--once", action="store_true", help="sintetizar una frase y salir")
    parser.add_argument("--text")
    parser.add_argument("--voice")
    parser.add_argument("--out")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    args = parser.parse_args()

    if args.once:
        result = handle(
            {
                "cmd": "synthesize",
                "text": args.text,
                "voice": args.voice,
                "out": args.out,
                "rate": args.rate,
                "pitch": args.pitch,
            }
        )
        emit(result or {"ok": False, "error": "sin resultado"})
        return 0 if (result or {}).get("ok") else 1

    return serve()


if __name__ == "__main__":
    # Sin buffer: si el sidecar se queda con datos sin volcar, Rust no recibe nada.
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    sys.exit(main())
