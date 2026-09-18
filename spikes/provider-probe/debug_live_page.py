"""Diagnostico: por que no se descubren salas en /live."""
from __future__ import annotations

import re

import httpx

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
REHYDRATION = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>',
    re.DOTALL,
)

for url in ("https://www.tiktok.com/live", "https://www.tiktok.com/live?lang=es"):
    try:
        response = httpx.get(
            url,
            headers={"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"},
            follow_redirects=True,
            timeout=30.0,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"{url} -> EXCEPCION {type(exc).__name__}: {exc}")
        continue

    html = response.text
    match = REHYDRATION.search(html)
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
    print(f"--- {url}")
    print(f"status={response.status_code} final={response.url} bytes={len(html)}")
    print(f"title={title.group(1)[:120] if title else None!r}")
    print(f"rehydration={'SI' if match else 'NO'} uniqueId_count={html.count('uniqueId')} "
          f"roomId_count={html.count('roomId')} capture_count={html.count('captcha')}")
    print(f"head={html[:300]!r}")
    if match:
        import json
        try:
            data = json.loads(match.group(1))
            print("scope keys:", list(data.get("__DEFAULT_SCOPE__", {}).keys())[:30])
        except Exception as exc:  # noqa: BLE001
            print(f"json error: {exc}")
