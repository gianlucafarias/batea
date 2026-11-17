"""Consultas compartidas: filtros, cajas virtuales/inteligentes y serialización."""
from __future__ import annotations

import json
import os
import re
import unicodedata
import sqlite3
from functools import lru_cache
from typing import Any

from . import keys, universe

VIRTUAL_CRATES = {
    "all": "Toda la colección",
    "inbox": "Sin clasificar",
    "local": "Fuera de rekordbox",
    "recent": "Agregados (60 días)",
    "top": "Mejor puntuados",
    "hidden": "Eliminados de Batea",
}

EFFECTIVE_ENERGY = "COALESCE(t.energy, t.energy_auto)"
EFFECTIVE_RATING = "COALESCE(t.rating, t.rb_rating, 0)"

TRACK_COLUMNS = f"""
    t.id, t.title, t.artist, t.album, t.label, t.genre, t.remixer, t.bpm, t.key, t.duration,
    {EFFECTIVE_RATING} AS rating, {EFFECTIVE_ENERGY} AS energy, t.energy AS energy_user, t.energy_auto,
    t.intro_bars, t.outro_bars, t.breaks, t.date_added, t.play_count, t.last_played, t.source,
    t.rb_color AS color, t.path, (t.artwork IS NOT NULL) AS has_art, t.year, t.filetype, t.bitrate, t.hidden,
    (t.key_source = 'batea') AS key_est, (t.reviewed IS NOT NULL) AS reviewed,
    CASE WHEN t.source='local' AND t.analyzed IS NULL THEN 'pending'
         WHEN t.source='local' AND t.analyzed='error' THEN 'error'
         WHEN t.source='rekordbox' AND t.bpm IS NULL THEN 'rb' END AS unanalyzed
"""


def compatible_keys(cam: str) -> list[str]:
    p = keys.parse(cam)
    if not p:
        return []
    n, letter = p
    other = "B" if letter == "A" else "A"
    up, down = n % 12 + 1, (n - 2) % 12 + 1
    return [f"{n}{letter}", f"{up}{letter}", f"{down}{letter}", f"{n}{other}"]


def build_where(f: dict[str, Any], params: list) -> list[str]:
    w: list[str] = []
    if not f.get("show_hidden"):
        w.append("t.hidden=0")
    q = (f.get("q") or "").strip()
    for word in q.split():
        w.append("(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ? OR t.label LIKE ? OR t.remixer LIKE ? OR t.genre LIKE ?)")
        params.extend([f"%{word}%"] * 6)
    for tag in f.get("tags") or []:
        w.append("EXISTS (SELECT 1 FROM track_tags x WHERE x.track_id=t.id AND x.tag_id=?)")
        params.append(int(tag))
    for tag in f.get("not_tags") or []:
        w.append("NOT EXISTS (SELECT 1 FROM track_tags x WHERE x.track_id=t.id AND x.tag_id=?)")
        params.append(int(tag))
    if f.get("bpm_min"):
        w.append("t.bpm >= ?"); params.append(float(f["bpm_min"]))
    if f.get("bpm_max"):
        w.append("t.bpm <= ?"); params.append(float(f["bpm_max"]))
    if f.get("energy_min"):
        w.append(f"{EFFECTIVE_ENERGY} >= ?"); params.append(int(f["energy_min"]))
    if f.get("energy_max"):
        w.append(f"{EFFECTIVE_ENERGY} <= ?"); params.append(int(f["energy_max"]))
    ks = list(f.get("keys") or [])
    if f.get("key_compat"):
        ks += compatible_keys(f["key_compat"])
    if ks:
        w.append(f"t.key IN ({','.join('?' * len(ks))})"); params.extend(ks)
    if f.get("rating_min"):
        w.append(f"{EFFECTIVE_RATING} >= ?"); params.append(int(f["rating_min"]))
    if f.get("source"):
        w.append("t.source = ?"); params.append(f["source"])
    if f.get("added_after"):
        w.append("t.date_added >= ?"); params.append(f["added_after"])
    return w


def crate_filter(c: sqlite3.Connection, crate: str | None) -> tuple[str | None, list, dict]:
    """Devuelve (join/where extra, params, filtros de la caja inteligente)."""
    if not crate or crate == "all":
        return None, [], {}
    if crate == "inbox":
        return ("NOT EXISTS (SELECT 1 FROM track_tags x JOIN tags g ON g.id=x.tag_id "
                "WHERE x.track_id=t.id AND x.source='user') AND t.energy IS NULL AND COALESCE(t.rating, 0)=0 "
                "AND t.reviewed IS NULL"), [], {}
    if crate == "local":
        return "t.source='local'", [], {}
    if crate == "recent":
        return "t.date_added >= date('now','-60 day')", [], {}
    if crate == "top":
        return f"{EFFECTIVE_RATING} >= 4", [], {}
    if crate.startswith("artist:"):
        # temas del artista: como intérprete, en colaboraciones o como remixer (palabra completa, sin importar acentos)
        c.create_function("batea_artist", 4, _artist_match, deterministic=True)
        return "batea_artist(?, t.artist, t.remixer, t.title)", [crate[7:].strip()], {}
    if crate == "hidden":
        return "t.hidden=1", [], {"show_hidden": True}
    if crate.startswith("dir:"):
        # Carpeta real: temas cuya ruta está ahí, o que tienen una copia del archivo ahí
        # (rekordbox a veces guarda una ruta vieja y el archivo hoy vive en otro disco).
        pre = dir_prefix(crate)
        n = len(pre)
        return ("(substr(t.path,1,?)=? OR t.id IN (SELECT ref_id FROM found_files "
                "WHERE state IN ('copy','track') AND substr(path,1,?)=?))"), [n, pre, n, pre], {}
    cid = int(crate)
    row = c.execute("SELECT kind, query FROM crates WHERE id=?", (cid,)).fetchone()
    if row and row["kind"] == "smart":
        return None, [], json.loads(row["query"] or "{}")
    if row and row["kind"] in ("folder", "session_folder"):
        return ("t.id IN (SELECT ct.track_id FROM crate_tracks ct WHERE ct.crate_id IN "
                "(WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM crates c JOIN sub ON c.parent_id=sub.id) SELECT id FROM sub))"), [cid], {}
    return "t.id IN (SELECT track_id FROM crate_tracks WHERE crate_id=?)", [cid], {}


def _fold(s: str) -> str:
    """minúsculas y sin acentos, para comparar nombres"""
    return "".join(ch for ch in unicodedata.normalize("NFKD", s.casefold()) if not unicodedata.combining(ch))


@lru_cache(maxsize=64)
def _artist_re(name: str) -> re.Pattern:
    return re.compile(r"(?<!\w)" + re.escape(_fold(name)) + r"(?!\w)")


def _artist_match(name: str, *fields: str | None) -> int:
    rx = _artist_re(name)
    return int(any(f and rx.search(_fold(f)) for f in fields))


def dir_prefix(crate: str) -> str:
    return crate[4:].rstrip("/") + "/"


def _query_parts(c: sqlite3.Connection, crate: str | None, filters: dict, use_universe: bool) -> tuple[list[str], list]:
    params: list = []
    extra, extra_params, smart = crate_filter(c, crate)
    merged = {**smart, **{k: v for k, v in filters.items() if v not in (None, "", [])}}
    where = build_where(merged, params)
    uni = universe.clause(c) if use_universe else None
    if uni:
        where.append(uni[0])
        params.extend(uni[1])
    if extra:
        where.append(extra)
        params.extend(extra_params)
    return where, params


def count_tracks(c: sqlite3.Connection, crate: str | None, filters: dict | None = None, use_universe: bool = True) -> int:
    where, params = _query_parts(c, crate, filters or {}, use_universe)
    sql = "SELECT COUNT(*) FROM tracks t" + (" WHERE " + " AND ".join(where) if where else "")
    return c.execute(sql, params).fetchone()[0]


def query_tracks(c: sqlite3.Connection, crate: str | None, filters: dict, limit: int | None = None,
                 use_universe: bool = True) -> list[dict]:
    where, params = _query_parts(c, crate, filters, use_universe)
    order = "t.date_added DESC, t.id DESC"
    join = ""
    if crate and crate.startswith("dir:"):
        order = "t.path"
    if crate and crate.startswith("artist:"):
        order = "t.date_added DESC, t.title"
    if crate and crate.isdigit():
        kind = c.execute("SELECT kind FROM crates WHERE id=?", (int(crate),)).fetchone()
        if kind and kind["kind"] in ("playlist", "session", "user"):
            join = "LEFT JOIN crate_tracks cp ON cp.track_id=t.id AND cp.crate_id=" + str(int(crate))
            order = "cp.position, t.id"
    sql = f"SELECT {TRACK_COLUMNS} FROM tracks t {join}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {order}"
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = [dict(r) for r in c.execute(sql, params)]
    attach_tags(c, rows)
    mark_online(c, rows)
    return rows


def attach_tags(c: sqlite3.Connection, rows: list[dict]) -> None:
    if not rows:
        return
    by_id = {r["id"]: r for r in rows}
    for r in rows:
        r["tags"] = []
    if len(rows) > 900:
        tag_rows = c.execute("SELECT track_id, tag_id FROM track_tags")
    else:
        q = ",".join("?" * len(rows))
        tag_rows = c.execute(f"SELECT track_id, tag_id FROM track_tags WHERE track_id IN ({q})", list(by_id))
    for tr in tag_rows:
        r = by_id.get(tr["track_id"])
        if r is not None:
            r["tags"].append(tr["tag_id"])


@lru_cache(maxsize=64)
def _volume_mounted(vol: str) -> bool:
    return os.path.isdir(vol)


def is_online(path: str | None) -> bool:
    if not path:
        return False
    if path.startswith("/Volumes/"):
        vol = "/".join(path.split("/")[:3])
        if not _volume_mounted(vol):
            return False
    return os.path.exists(path)


def _copies(c: sqlite3.Connection, tid: int | None = None) -> list[tuple[int, str]]:
    sql = "SELECT ref_id, path FROM found_files WHERE state IN ('copy','track') AND ref_id IS NOT NULL"
    try:
        if tid is not None:
            return list(c.execute(sql + " AND ref_id=?", (tid,)))
        return list(c.execute(sql))
    except sqlite3.OperationalError:  # base vieja sin la tabla de la búsqueda
        return []


def mark_online(c: sqlite3.Connection, rows: list[dict]) -> None:
    """Pone `online` y saca `path`. Si la ruta guardada no existe pero la búsqueda encontró
    el mismo archivo en otra carpeta (típico de rutas viejas de rekordbox), cuenta como disponible."""
    off = []
    for r in rows:
        r["online"] = is_online(r.pop("path"))
        if not r["online"]:
            off.append(r)
    if not off:
        return
    alt: dict[int, str] = {}
    for rid, p in _copies(c):
        alt.setdefault(rid, p)
    for r in off:
        p = alt.get(r["id"])
        if p and (not p.startswith("/Volumes/") or _volume_mounted("/".join(p.split("/")[:3]))):
            r["online"] = True


def real_path(c: sqlite3.Connection, tid: int) -> str | None:
    """Ruta donde el archivo existe hoy: la guardada o, si no, una copia encontrada en el disco."""
    r = c.execute("SELECT path FROM tracks WHERE id=?", (tid,)).fetchone()
    if r and is_online(r[0]):
        return r[0]
    for _, p in _copies(c, tid):
        if is_online(p):
            return p
    return None


def reset_online_cache() -> None:
    _volume_mounted.cache_clear()


def crate_track_ids(c: sqlite3.Connection, crate_id: int | str) -> tuple[str, list[int]]:
    crate = str(crate_id)
    if crate in VIRTUAL_CRATES:
        name = VIRTUAL_CRATES[crate]
    elif crate.startswith("dir:"):
        name = os.path.basename(crate[4:].rstrip("/")) or "Carpeta"
    elif crate.startswith("artist:"):
        name = crate[7:].strip() or "Artista"
    else:
        row = c.execute("SELECT name FROM crates WHERE id=?", (int(crate),)).fetchone()
        name = row["name"] if row else "Caja"
    rows = query_tracks(c, crate, {})
    return name, [r["id"] for r in rows]
