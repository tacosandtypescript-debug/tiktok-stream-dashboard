"""Sonda de conectividad TikTok LIVE - spike M0.

Valida empiricamente las etapas 1-3 del spike (docs/decisions.md D5) usando el
cliente Python de referencia, antes de reimplementarlas en Rust:

    python probe.py islive <handle> [<handle> ...]
    python probe.py watch  <handle> [segundos] [--raw salida.bin]

`--raw` vuelca los frames crudos del WebSocket a disco: permite desarrollar y
probar el decodificador de Rust contra datos reales SIN volver a conectarse
(importante: la cuota del servidor de firma gratuito es limitada, D2).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from TikTokLive import TikTokLiveClient
from TikTokLive.client.web.web_settings import WebDefaults
from TikTokLive.events import (
    CommentEvent,
    ConnectEvent,
    DisconnectEvent,
    FollowEvent,
    GiftEvent,
    LikeEvent,
    RoomUserSeqEvent,
    WebsocketResponseEvent,
)

ATTRS_EVENT = (
    "content", "comment", "repeat_count", "repeat_end", "streaking", "combo_count",
    "total", "count", "total_like_count", "member_count", "viewer_count",
    "like_count", "message", "msg_id",
)
ATTRS_USER = ("id", "unique_id", "nickname", "avatar_thumb", "avatar")
ATTRS_GIFT = ("id", "name", "diamond_count", "type", "image", "describe")


def _plain(value):
    """Convierte valores no serializables (protobuf objects) en algo legible."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    return repr(value)[:120]


def brief(event) -> dict:
    data: dict = {"type": type(event).__name__}
    for key in ATTRS_EVENT:
        if hasattr(event, key):
            value = getattr(event, key)
            if not callable(value):
                data[key] = _plain(value)

    user = getattr(event, "user", None)
    if user is not None:
        data["user"] = {k: _plain(getattr(user, k, None)) for k in ATTRS_USER}

    gift = getattr(event, "gift", None)
    if gift is not None:
        data["gift"] = {k: _plain(getattr(gift, k, None)) for k in ATTRS_GIFT}

    return data


def norm_handle(handle: str) -> str:
    return handle if handle.startswith("@") else f"@{handle}"


async def cmd_islive(handles: list[str]) -> int:
    print(json.dumps({
        "sign_url": WebDefaults.tiktok_sign_url,
        "api_key_configured": bool(WebDefaults.tiktok_sign_api_key),
        "app_url": WebDefaults.tiktok_app_url,
    }))
    exit_code = 0
    for handle in handles:
        uid = norm_handle(handle)
        started = time.perf_counter()
        try:
            client = TikTokLiveClient(unique_id=uid)
            live = await client.is_live()
            print(json.dumps({
                "handle": uid,
                "is_live": live,
                "room_id": _plain(client.room_id),
                "ms": round((time.perf_counter() - started) * 1000),
            }), flush=True)
        except Exception as exc:  # noqa: BLE001 - sonda: queremos el error crudo
            exit_code = 1
            print(json.dumps({
                "handle": uid,
                "error": type(exc).__name__,
                "detail": str(exc)[:400],
                "ms": round((time.perf_counter() - started) * 1000),
            }), flush=True)
    return exit_code


async def cmd_watch(handle: str, seconds: int, raw_path: Path | None) -> int:
    uid = norm_handle(handle)
    client = TikTokLiveClient(unique_id=uid)
    raw_file = raw_path.open("ab") if raw_path else None
    counts: dict[str, int] = {}
    started = time.perf_counter()

    if raw_file is not None:
        async def on_response(event: WebsocketResponseEvent) -> None:
            payload = getattr(event, "event", None)
            raw_file.write(json.dumps(brief(payload)).encode("utf-8") + b"\n")
            raw_file.flush()
        client.add_listener(WebsocketResponseEvent, on_response)

    @client.on(ConnectEvent)
    async def on_connect(event: ConnectEvent) -> None:
        print(json.dumps({"connected": True, "room_id": _plain(client.room_id),
                          "unique_id": _plain(getattr(event, "unique_id", None))}), flush=True)

    @client.on(DisconnectEvent)
    async def on_disconnect(event: DisconnectEvent) -> None:
        print(json.dumps({"disconnected": True}), flush=True)

    def make_logger(name: str):
        async def log(event) -> None:
            counts[name] = counts.get(name, 0) + 1
            print(json.dumps({"t": round(time.perf_counter() - started, 1), **brief(event)}), flush=True)
        return log

    for event_type, name in (
        (CommentEvent, "comment"),
        (GiftEvent, "gift"),
        (LikeEvent, "like"),
        (FollowEvent, "follow"),
        (RoomUserSeqEvent, "viewers"),
    ):
        client.add_listener(event_type, make_logger(name))

    try:
        await client.connect(fetch_gift_info=True)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"connect_error": type(exc).__name__, "detail": str(exc)[:400]}), flush=True)
        return 1

    try:
        await asyncio.sleep(seconds)
    finally:
        await client.disconnect()
        if raw_file is not None:
            raw_file.close()

    print(json.dumps({"summary": counts, "seconds": seconds}), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Sonda TikTok LIVE (spike M0)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_live = sub.add_parser("islive", help="comprobar si un usuario esta en directo")
    p_live.add_argument("handles", nargs="+")

    p_watch = sub.add_parser("watch", help="conectar y volcar eventos")
    p_watch.add_argument("handle")
    p_watch.add_argument("seconds", nargs="?", type=int, default=30)
    p_watch.add_argument("--raw", type=Path, default=None)

    args = parser.parse_args()

    if args.cmd == "islive":
        return asyncio.run(cmd_islive(args.handles))
    return asyncio.run(cmd_watch(args.handle, args.seconds, args.raw))


if __name__ == "__main__":
    sys.exit(main())
