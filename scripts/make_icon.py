"""Genera el icono .ico que tauri-build exige para el recurso de Windows.

Sin dependencias: construye a mano un ICO de 32x32 en BGRA (cabecera + DIB +
mascara AND). Dibujo: fondo oscuro con dos circulos estilo nota de TikTok.
"""

from __future__ import annotations

import struct
from pathlib import Path

SIZE = 32
BG = (0x14, 0x10, 0x18)          # BGR fondo
CYAN = (0xEE, 0xF4, 0x25)        # BGR #25F4EE
RED = (0x55, 0x2C, 0xFE)         # BGR #FE2C55


def circle(cx: float, cy: float, radius: float, x: int, y: int) -> bool:
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def pixels() -> bytes:
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            if circle(11.0, 11.0, 7.5, x, y):
                color = CYAN
            elif circle(20.0, 20.0, 7.5, x, y):
                color = RED
            elif circle(20.0, 20.0, 7.5, x, y) or circle(11.0, 11.0, 7.5, x, y):
                color = CYAN
            else:
                color = BG
            row += bytes((color[0], color[1], color[2], 0xFF))
        rows.append(bytes(row))
    # El DIB va de abajo hacia arriba.
    return b"".join(reversed(rows))


def build_ico() -> bytes:
    dib = struct.pack(
        "<IiiHHIIiiII",
        40,          # biSize
        SIZE,        # biWidth
        SIZE * 2,    # biHeight (XOR + AND)
        1,           # biPlanes
        32,          # biBitCount
        0,           # biCompression
        0,           # biSizeImage
        0, 0, 0, 0,  # resolucion y colores
    )
    colour = pixels()
    mask = bytes(SIZE * 4)  # 32 filas x 4 bytes, todo opaco segun el canal alfa
    image = dib + colour + mask

    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", SIZE, SIZE, 0, 0, 1, 32, len(image), 6 + 16)
    return header + entry + image


def main() -> int:
    target = Path(__file__).resolve().parent.parent / "apps" / "desktop" / "src-tauri" / "icons"
    target.mkdir(parents=True, exist_ok=True)
    path = target / "icon.ico"
    path.write_bytes(build_ico())
    print(f"escrito: {path} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
