"""Descubre salas TikTok LIVE activas para cerrar la etapa 4 del spike.

Sin firma y sin gastar cuota de Euler:
  1. obtiene candidatos (leaderboard publico de Euler Stream / feed webcast)
  2. comprueba `check_alive` de TikTok, que es un endpoint SIN firma

    python discover.py [--json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

import httpx

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/html;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.tiktok.com/",
    "Origin": "https://www.tiktok.com",
}

BASE_PARAMS = {
    "aid": "1988",
    "app_language": "en",
    "app_name": "tiktok_web",
    "browser_language": "en-US",
    "browser_name": "Mozilla",
    "browser_online": "true",
    "browser_platform": "Win32",
    "browser_version": "5.0%20(Windows)",
    "channel": "tiktok_web",
    "cookie_enabled": "true",
    "device_platform": "web",
    "focus_state": "true",
    "history_len": "8",
    "is_fullscreen": "false",
    "is_page_visible": "true",
    "os": "windows",
    "priority_region": "CA",
    "region": "CA",
    "screen_height": "1080",
    "screen_width": "1920",
    "tz_name": "America/Toronto",
    "user_is_login": "false",
    "webcast_language": "en",
}

NEXT_DATA = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL
)


def walk(node: Any, out: list[dict]) -> None:
    """Recoge objetos con pinta de usuario/sala en vivo."""
    if isinstance(node, dict):
        for key in ("uniqueId", "unique_id", "handle", "username"):
            value = node.get(key)
            if isinstance(value, str) and 2 < len(value) < 25 and " " not in value:
                out.append({"unique_id": value, "room_id": node.get("roomId") or node.get("room_id")})
                break
        for value in node.values():
            walk(value, out)
    elif isinstance(node, list):
        for item in node:
            walk(item, out)


def from_leaderboards() -> list[dict]:
    response = httpx.get(
        "https://www.eulerstream.com/leaderboards",
        headers={"User-Agent": UA},
        follow_redirects=True,
        timeout=30.0,
    )
    print(f"# leaderboards -> {response.status_code} ({len(response.text)} bytes)", file=sys.stderr)
    match = NEXT_DATA.search(response.text)
    if not match:
        print("# sin __NEXT_DATA__", file=sys.stderr)
        return []
    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        print(f"# __NEXT_DATA__ invalido: {exc}", file=sys.stderr)
        return []
    found: list[dict] = []
    walk(data, found)
    print(f"# leaderboards: {len(found)} candidatos", file=sys.stderr)
    return found


def from_webcast_feed() -> list[dict]:
    params = dict(BASE_PARAMS)
    params.update({"count": "20", "feed_type": "1", "client_enter": "0"})
    url = "https://webcast.tiktok.com/webcast/feed/?" + "&".join(f"{k}={v}" for k, v in params.items())
    try:
        response = httpx.get(url, headers=HEADERS, timeout=30.0)
    except Exception as exc:  # noqa: BLE001
        print(f"# webcast/feed -> {type(exc).__name__}", file=sys.stderr)
        return []
    print(f"# webcast/feed -> {response.status_code} ({len(response.text)} bytes)", file=sys.stderr)
    if response.status_code != 200:
        print(f"#   cuerpo: {response.text[:200]}", file=sys.stderr)
        return []
    try:
        data = response.json()
    except Exception:  # noqa: BLE001
        print(f"#   no es JSON: {response.text[:150]}", file=sys.stderr)
        return []
    found: list[dict] = []
    walk(data, found)
    print(f"# webcast/feed: {len(found)} candidatos", file=sys.stderr)
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    candidates: dict[str, dict] = {}
    for source in (from_webcast_feed, from_leaderboards):
        for item in source():
            candidates.setdefault(item["unique_id"], item)

    if not candidates:
        print(json.dumps({"error": "sin candidatos"}))
        return 2

    print(f"# total unicos: {len(candidates)}", file=sys.stderr)
    listing = list(candidates.values())
    print(json.dumps(listing, indent=2) if args.json else "\n".join("@" + c["unique_id"] for c in listing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
