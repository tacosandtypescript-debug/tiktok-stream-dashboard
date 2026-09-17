"""Inspecciona la base de datos de la aplicacion (solo lectura).

Sirve para comprobar si el motor ha estado recibiendo y persistiendo eventos.

    python scripts/inspect_db.py [ruta_del_dashboard.db]
"""

from __future__ import annotations

import os
import pathlib
import sqlite3
import sys

TABLES = ("streams", "users", "comments", "gift_events", "follows")


def default_path() -> pathlib.Path:
    local = os.environ.get("TTSDASH_DATA_DIR")
    if local:
        return pathlib.Path(local) / "data" / "dashboard.db"
    return pathlib.Path(os.environ["LOCALAPPDATA"]) / "TikTokStreamDashboard" / "data" / "dashboard.db"


def main() -> int:
    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else default_path()
    print(f"base de datos: {path}")
    if not path.exists():
        print("no existe")
        return 1

    # En modo lectura: la aplicacion puede tener la base abierta en WAL.
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for table in TABLES:
            try:
                count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                print(f"  {table}: {count}")
            except sqlite3.Error as error:
                print(f"  {table}: error {error}")

        print("\nultimas sesiones:")
        for row in connection.execute(
            "SELECT id, handle, started_at, ended_at, comment_count, gift_count, diamond_total"
            " FROM streams ORDER BY started_at DESC LIMIT 5"
        ):
            ident, handle, started, ended, comments, gifts, diamonds = row
            estado = "cerrada" if ended else "ABIERTA"
            print(
                f"  @{handle} {estado} comentarios={comments} regalos={gifts}"
                f" diamantes={diamonds} (id={ident})"
            )

        print("\nultimos comentarios:")
        for row in connection.execute(
            "SELECT nickname, content FROM comments ORDER BY id DESC LIMIT 5"
        ):
            nickname, content = row
            print(f"  {nickname}: {content[:60]}")
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
