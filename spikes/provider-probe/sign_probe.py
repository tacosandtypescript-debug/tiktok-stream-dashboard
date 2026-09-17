"""Reproduce la peticion de firma contra el servidor de Euler Stream.

Compara variantes del User-Agent para averiguar cual acepta el servidor.
Cada variante es **una** peticion a /webcast/fetch (consume cuota de firma).

    python spikes/provider-probe/sign_probe.py <room_id> --variants
"""

from __future__ import annotations

import argparse
from urllib.parse import urlencode

import httpx

SIGN_BASE = "https://api.eulerstream.com"
CORRECT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)


def build_url(room_id: str, user_agent: str | None, encode: bool) -> str:
    """Construye la URL como la construye cada implementacion.

    `encode=False` imita a Rust: el valor se inserta tal cual, con espacios y
    parentesis crudos.
    """
    params: list[tuple[str, str]] = [
        ("client", "ttlive-python"),
        ("room_id", room_id),
    ]
    if user_agent is not None:
        params.append(("user_agent", user_agent))
    params += [("platform", "web"), ("client_enter", "true")]

    if encode:
        return f"{SIGN_BASE}/webcast/fetch?{urlencode(params)}"
    query = "&".join(f"{key}={value}" for key, value in params)
    return f"{SIGN_BASE}/webcast/fetch?{query}"


def call(room_id: str, user_agent: str | None, encode: bool) -> tuple[int, str]:
    url = build_url(room_id, user_agent, encode)
    print(f"    URL: {url[:150]}{'...' if len(url) > 150 else ''}")
    response = httpx.get(
        url,
        headers={
            "Accept": "application/json, application/protobuf",
            "Referer": "https://www.tiktok.com/",
            "Origin": "https://www.tiktok.com",
            "User-Agent": user_agent or CORRECT_UA,
        },
        timeout=30.0,
    )
    if response.headers.get("content-type", "").startswith("application/json"):
        body = response.text[:200]
    else:
        body = f"<protobuf: {len(response.content)} bytes>"
    return response.status_code, body


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("room_id")
    parser.add_argument("--variants", action="store_true")
    args = parser.parse_args()

    cases: list[tuple[str, str | None, bool]] = [
        ("ua_codificado", CORRECT_UA, True),
        ("ua_crudo", CORRECT_UA, False),
        ("sin_parametro_ua", None, True),
    ]
    if not args.variants:
        cases = cases[:1]

    for name, user_agent, encode in cases:
        print(f"  {name}:")
        try:
            status, body = call(args.room_id, user_agent, encode)
        except Exception as error:  # noqa: BLE001
            print(f"    -> EXCEPCION {type(error).__name__}: {error}")
            continue
        print(f"    -> HTTP {status}  {body}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
