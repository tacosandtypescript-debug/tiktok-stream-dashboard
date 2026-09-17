"""Encuentra una sala TikTok LIVE activa AHORA, sin gastar cuota de firma.

Estrategia: el ranking publico de Euler Stream lista streamers que estan
emitiendo; se extraen los handles y se comprueba `is_live` (que solo hace
scraping de la pagina del usuario, no firma nada) hasta dar con uno vivo.

    python find_live_now.py [--max N] [--json]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys

import httpx
from TikTokLive import TikTokLiveClient

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
SOURCES = (
    "https://www.eulerstream.com/leaderboards",
    "https://www.tiktok.com/live",
)
HANDLE_RE = re.compile(r"@([A-Za-z0-9._]{3,24})")
# Palabras que nunca son handles
BLOCKLIST = {
    "eulerstream", "tiktok", "leaderboards", "pricing", "docs", "api", "websockets",
    "captchas", "agencies", "tools", "login", "register", "community", "guides",
    "gmail", "example", "email", "support", "privacy", "terms",
}


def harvest() -> list[str]:
    handles: list[str] = []
    for url in SOURCES:
        try:
            response = httpx.get(
                url,
                headers={"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"},
                follow_redirects=True,
                timeout=30.0,
            )
            print(f"# {url} -> {response.status_code} ({len(response.text)} bytes)", file=sys.stderr)
            for match in HANDLE_RE.findall(response.text):
                low = match.lower()
                if low not in BLOCKLIST and match not in handles:
                    handles.append(match)
        except Exception as exc:  # noqa: BLE001
            print(f"# {url} -> {type(exc).__name__}: {exc}", file=sys.stderr)
    return handles


async def probe(handles: list[str], maximum: int) -> dict | None:
    for handle in handles[:maximum]:
        client = TikTokLiveClient(unique_id=f"@{handle}")
        try:
            if await client.is_live():
                return {"unique_id": handle, "room_id": str(client.room_id)}
            print(f"# @{handle}: offline", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print(f"# @{handle}: {type(exc).__name__}", file=sys.stderr)
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max", type=int, default=25)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    handles = harvest()
    print(f"# {len(handles)} handles candidatos", file=sys.stderr)
    if not handles:
        print(json.dumps({"error": "sin candidatos"}))
        return 2

    found = asyncio.run(probe(handles, args.max))
    print(json.dumps(found) if args.json else (f"@{found['unique_id']} {found['room_id']}" if found else "ninguna sala viva"))
    return 0 if found else 2


if __name__ == "__main__":
    sys.exit(main())
