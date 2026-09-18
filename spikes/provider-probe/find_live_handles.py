"""Obtiene handles de los leaderboards de Euler Stream y busca uno EN DIRECTO.

`is_live` solo hace scraping de la pagina del usuario: no firma nada y no
consume la cuota de 100/dia del servidor de firma.

    python find_live_handles.py [--max N] [--json]
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
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
PAGES = (
    "https://www.eulerstream.com/leaderboards",
    "https://www.eulerstream.com/leaderboards/country/us",
    "https://www.eulerstream.com/leaderboards/country/co",
    "https://www.eulerstream.com/leaderboards/country/es",
    "https://www.eulerstream.com/leaderboards/country/mx",
    "https://www.eulerstream.com/leaderboards/country/ph",
)
USER_LINK = re.compile(r"/leaderboards/users/([A-Za-z0-9._]{3,24})")


def harvest() -> list[str]:
    handles: list[str] = []
    for url in PAGES:
        try:
            response = httpx.get(url, headers={"User-Agent": UA}, follow_redirects=True, timeout=30.0)
            found = USER_LINK.findall(response.text)
            print(f"# {url} -> {response.status_code}, {len(found)} handles", file=sys.stderr)
            for handle in found:
                if handle not in handles:
                    handles.append(handle)
        except Exception as exc:  # noqa: BLE001
            print(f"# {url} -> {type(exc).__name__}", file=sys.stderr)
    return handles


async def find_live(handles: list[str], maximum: int) -> dict | None:
    for index, handle in enumerate(handles[:maximum], start=1):
        client = TikTokLiveClient(unique_id=f"@{handle}")
        try:
            live = await client.is_live()
        except Exception as exc:  # noqa: BLE001
            print(f"# [{index}] @{handle}: {type(exc).__name__}", file=sys.stderr)
            continue
        if live:
            print(f"# [{index}] @{handle}: EN DIRECTO", file=sys.stderr)
            return {"unique_id": handle, "room_id": str(client.room_id)}
        print(f"# [{index}] @{handle}: offline", file=sys.stderr)
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max", type=int, default=40)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    handles = harvest()
    print(f"# {len(handles)} handles unicos", file=sys.stderr)
    if not handles:
        print(json.dumps({"error": "sin handles"}))
        return 2

    found = asyncio.run(find_live(handles, args.max))
    if found is None:
        print(json.dumps({"error": "ninguna sala en directo"}))
        return 2
    print(json.dumps(found) if args.json else f"@{found['unique_id']} {found['room_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
