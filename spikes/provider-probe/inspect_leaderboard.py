"""Inspecciona como carga el leaderboard de Euler Stream (para hallar salas vivas)."""
from __future__ import annotations

import re

import httpx

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)

url = "https://www.eulerstream.com/leaderboards"
response = httpx.get(url, headers={"User-Agent": UA}, follow_redirects=True, timeout=30.0)
html = response.text

print(f"status={response.status_code} bytes={len(html)}")

print("\n=== <script> etiquetas ===")
for match in re.finditer(r"<script([^>]*)>", html):
    attrs = match.group(1).strip()
    print(f"  {attrs[:160]}")

print("\n=== ids de script con JSON ===")
for match in re.finditer(r'<script[^>]*id="([^"]+)"[^>]*>', html):
    print(f"  id={match.group(1)}")

print("\n=== posibles endpoints de API ===")
for match in sorted(set(re.findall(r'"(/[a-z0-9\-/]*(?:api|leaderboard|rank|live)[a-z0-9\-/]*)"', html, re.I))):
    print(f"  {match}")
for match in sorted(set(re.findall(r'https://[a-z0-9.\-]+/[a-z0-9\-/]*(?:api|leaderboard)[a-z0-9\-/]*', html, re.I))):
    print(f"  {match}")

print("\n=== ocurrencias de claves utiles ===")
for key in ("uniqueId", "unique_id", "roomId", "room_id", "nickname", "handle", "tiktok.com/@", "avatar"):
    print(f"  {key}: {html.count(key)}")

print("\n=== texto visible (recortado) ===")
text = re.sub(r"<script.*?</script>", " ", html, flags=re.DOTALL)
text = re.sub(r"<style.*?</style>", " ", text, flags=re.DOTALL)
text = re.sub(r"<[^>]+>", " ", text)
text = re.sub(r"\s+", " ", text).strip()
print(text[:1200])
