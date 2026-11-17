"""Universos: el subconjunto de la librería con el que trabajás (ej. "Techno").

Un universo es una lista de cajas (playlists o carpetas de rekordbox, o cajas
tuyas). Mientras está activo, todo Batea —cajas, mapa, sugerencias, bandeja de
sin clasificar— solo ve los temas de esas cajas, más la música nueva que
todavía no está en rekordbox. Nada se borra: es solo un filtro global.
"""
from __future__ import annotations

import json
import sqlite3

from . import db


def active_id(c: sqlite3.Connection) -> int | None:
    v = db.get_meta(c, "active_universe")
    if not v:
        return None
    row = c.execute("SELECT id FROM universes WHERE id=?", (int(v),)).fetchone()
    return row["id"] if row else None


def set_active(c: sqlite3.Connection, uid: int | None) -> None:
    db.set_meta(c, "active_universe", str(uid) if uid else "")


def expand(c: sqlite3.Connection, crate_ids: list[int]) -> list[int]:
    """Las cajas elegidas más todo lo que cuelga de ellas (carpetas dentro de carpetas)."""
    ids = [int(i) for i in crate_ids]
    if not ids:
        return []
    q = ",".join("?" * len(ids))
    rows = c.execute(
        f"WITH RECURSIVE sub(id) AS (SELECT id FROM crates WHERE id IN ({q}) "
        "UNION SELECT c.id FROM crates c JOIN sub ON c.parent_id=sub.id) SELECT id FROM sub",
        ids,
    ).fetchall()
    return [r["id"] for r in rows]


def crate_ids_of(c: sqlite3.Connection, uid: int) -> list[int]:
    row = c.execute("SELECT crate_ids FROM universes WHERE id=?", (uid,)).fetchone()
    return json.loads(row["crate_ids"]) if row else []


def clause_for(c: sqlite3.Connection, crate_ids: list[int], alias: str = "t") -> tuple[str, list]:
    ids = expand(c, crate_ids)
    if not ids:
        return f"{alias}.source='local'", []
    q = ",".join("?" * len(ids))
    return (
        f"({alias}.source='local' OR {alias}.id IN (SELECT track_id FROM crate_tracks WHERE crate_id IN ({q})))",
        ids,
    )


def clause(c: sqlite3.Connection, alias: str = "t") -> tuple[str, list] | None:
    """Condición SQL del universo activo, o None si se ve toda la librería."""
    uid = active_id(c)
    if uid is None:
        return None
    return clause_for(c, crate_ids_of(c, uid), alias)


def track_ids(c: sqlite3.Connection) -> set[int] | None:
    cl = clause(c)
    if cl is None:
        return None
    sql, params = cl
    return {r[0] for r in c.execute(f"SELECT t.id FROM tracks t WHERE {sql}", params)}


def count_for(c: sqlite3.Connection, crate_ids: list[int]) -> int:
    sql, params = clause_for(c, crate_ids)
    return c.execute(f"SELECT COUNT(*) FROM tracks t WHERE t.hidden=0 AND {sql}", params).fetchone()[0]


def listing(c: sqlite3.Connection) -> dict:
    items = []
    for r in c.execute("SELECT id, name, crate_ids FROM universes ORDER BY id"):
        ids = json.loads(r["crate_ids"])
        items.append({"id": r["id"], "name": r["name"], "crate_ids": ids, "count": count_for(c, ids)})
    total = c.execute("SELECT COUNT(*) FROM tracks WHERE hidden=0").fetchone()[0]
    return {"active": active_id(c), "items": items, "total": total}


def add_crate_to_active(c: sqlite3.Connection, crate_id: int) -> None:
    """Una caja creada mientras hay un universo activo pasa a formar parte de él."""
    uid = active_id(c)
    if uid is None:
        return
    ids = crate_ids_of(c, uid)
    if crate_id not in ids:
        ids.append(crate_id)
        c.execute("UPDATE universes SET crate_ids=? WHERE id=?", (json.dumps(ids), uid))


def prune(c: sqlite3.Connection) -> None:
    """Quita de los universos las cajas que ya no existen (p. ej. borradas en rekordbox)."""
    alive = {r["id"] for r in c.execute("SELECT id FROM crates")}
    for r in c.execute("SELECT id, crate_ids FROM universes").fetchall():
        ids = json.loads(r["crate_ids"])
        kept = [i for i in ids if i in alive]
        if kept != ids:
            c.execute("UPDATE universes SET crate_ids=? WHERE id=?", (json.dumps(kept), r["id"]))
