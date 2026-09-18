"""Descubre salas de TikTok LIVE activas sin consumir el servidor de firma.

Se usa para el spike (D5) y, mas adelante, para el job de canario del CI (P1-12):
necesita una sala real y viva, pero no debe gastar cuota de firma para encontrar
una.

    python find_live.py [--json] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import re
import sys

import httpx

LIVE_URL = "https://www.tiktok.com/live"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
REHYDRATION = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>',
    re.DOTALL,
)


def walk(node, out: list[dict]) -> None:
    """Recoge cualquier objeto que parezca una sala en directo."""
    if isinstance(node, dict):
        unique = node.get("uniqueId") or node.get("unique_id")
        room = node.get("roomId") or node.get("room_id")
        if isinstance(unique, str) and room:
            out.append({
                "unique_id": unique,
                "room_id": str(room),
                "viewers": node.get("userCount") or node.get("user_count"),
            })
        for value in node.values():
            walk(value, out)
    elif isinstance(node, list):
        for item in node:
            walk(item, out)


def discover() -> list[dict]:
    response = httpx.get(
        LIVE_URL,
        headers={"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"},
        follow_redirects=True,
        timeout=30.0,
    )
    response.raise_for_status()
    html = response.text

    found: list[dict] = []
    match = REHYDRATION.search(html)
    if match:
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            print(f"JSON de rehidratacion invalido: {exc}", file=sys.stderr)
        else:
            walk(payload, found)

    if not found:
        # Reserva: buscar pares uniqueId/roomId directamente en el HTML.
        pairs = re.findall(
            r'"uniqueId"\s*:\s*"([A-Za-z0-9._]{2,24})"[^}]{0,400}?"roomId"\s*:\s*"(\d{10,})"',
            html,
        )
        found = [{"unique_id": u, "room_id": r, "viewers": None} for u, r in pairs]

    deduped: dict[str, dict] = {}
    for item in found:
        deduped.setdefault(item["unique_id"], item)
    return list(deduped.values())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="salida en JSON")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    try:
        rooms = discover()
    except Exception as exc:  # noqa: BLE001 - sonda
        print(json.dumps({"error": type(exc).__name__, "detail": str(exc)[:300]}))
        return 1

    rooms = rooms[: args.limit]
    if args.json:
        print(json.dumps(rooms, indent=2))
    else:
        for room in rooms:
            print(f"@{room['unique_id']}\t{room['room_id']}\t{room.get('viewers')}")
    print(f"# total: {len(rooms)}", file=sys.stderr)
    return 0 if rooms else 2


if __name__ == "__main__":
    sys.exit(main())
