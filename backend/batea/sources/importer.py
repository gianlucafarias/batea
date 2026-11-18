"""Importador genérico: mete un `SourceDump` (Traktor, Serato…) en batea.db.

Reglas:
- Un tema se reconoce por (fuente, ext_id) y, si no, por ruta canónica (NFC + sin mayúsculas).
- `tracks.source` es la fuente principal. Si el tema ya era de otro programa (rekordbox…), sus campos
  no se pisan: solo se completan los vacíos. Si era música suelta ('local'), pasa a ser de esta fuente.
- Lo que cada programa dice de cada tema queda en `track_sources`, siempre.
- Nunca se tocan los campos del usuario (rating, energía, notas, etiquetas, hidden).
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from .. import db, keys, universe
from ..jobs import Job
from .base import KINDS, SourceDump, SrcCrate, SrcTrack

CRATE_KINDS = {"folder": "folder", "playlist": "playlist", "smart": "smart_rb"}
# campos de `tracks` que viene de la fuente (se completan si faltan o, si la fuente manda, se pisan)
_FIELDS = ("title", "artist", "album", "label", "genre", "remixer", "bpm", "duration", "date_added", "year", "bitrate")
# los editados a mano (meta_user=1) no se pisan
_TEXT = {"title", "artist", "album", "label", "genre", "remixer", "year"}


def _chunks(ids: list, n: int = 500):
    for i in range(0, len(ids), n):
        yield ids[i:i + n]


def _order(kind: str) -> int:
    return KINDS.index(kind) if kind in KINDS else len(KINDS)


def drop_source(c: sqlite3.Connection, kind: str, track_ids: list[int]) -> None:
    """Estos temas ya no están en `kind`: se borra su registro y, si era su fuente principal, pasan al siguiente
    programa que los tenga (orden de KINDS) o a 'local' (= no están en ningún programa)."""
    for part in _chunks(list(track_ids)):
        q = ",".join("?" * len(part))
        c.execute(f"DELETE FROM track_sources WHERE source=? AND track_id IN ({q})", [kind, *part])
        main = [r[0] for r in c.execute(f"SELECT id FROM tracks WHERE source=? AND id IN ({q})", [kind, *part])]
        for tid in main:
            rest = sorted((r[0] for r in c.execute("SELECT source FROM track_sources WHERE track_id=?", (tid,))), key=_order)
            c.execute("UPDATE tracks SET source=? WHERE id=?", (rest[0] if rest else "local", tid))


def _camelot(t: SrcTrack) -> str | None:
    return t.key_camelot or keys.to_camelot(t.key_raw)


def _values(t: SrcTrack, kind: str) -> dict:
    vals = {k: getattr(t, k) for k in _FIELDS}
    vals["key"] = _camelot(t)
    vals["key_raw"] = t.key_raw
    vals["key_source"] = kind if vals["key"] else None
    if t.path:
        vals["filetype"] = Path(t.path).suffix.lower().lstrip(".") or None
    return {k: v for k, v in vals.items() if v is not None}


def _apply(c: sqlite3.Connection, tid: int, row: sqlite3.Row, vals: dict, kind: str) -> str:
    """Actualiza `tracks`; devuelve la clave de estadística: 'actualizados', 'completados' (era de otro programa) o 'sueltos que pasan al programa'."""
    own = row["source"] in (kind, "local")      # la fuente manda sobre sus propios datos y sobre música suelta
    sets: dict = {}
    for k, v in vals.items():
        if k in ("key", "key_raw", "key_source"):
            continue
        if own:
            if row["meta_user"] and k in _TEXT:
                continue
            sets[k] = v
        elif row[k] is None:
            sets[k] = v
    if "key" in vals:
        # el tono de la fuente pisa al calculado por Batea (como hace rekordbox), pero solo si la fuente tiene uno
        if row["key"] is None or (own and row["key_source"] != "tag"):
            sets.update(key=vals["key"], key_raw=vals["key_raw"], key_source=kind)
        elif row["key_raw"] is None and vals.get("key_raw"):
            sets["key_raw"] = vals["key_raw"]
    status = "completados"
    if row["source"] == "local":
        sets["source"] = kind
        status = "sueltos que pasan al programa"
    elif own:
        status = "actualizados"
    sets = {k: v for k, v in sets.items() if row[k] != v or k == "source"}
    if sets:
        c.execute(f"UPDATE tracks SET {', '.join(f'{k}=?' for k in sets)} WHERE id=?", [*sets.values(), tid])
    return status


def import_dump(c: sqlite3.Connection, dump: SourceDump, job: Job | None = None) -> dict:
    kind = dump.kind
    if kind == "rekordbox":
        raise ValueError("rekordbox se sincroniza con rbsync")

    def upd(p: float, msg: str) -> None:
        if job:
            job.update(p, msg)

    stats: Counter = Counter()
    now = datetime.now().isoformat(timespec="seconds")
    try:
        upd(0.02, f"Preparando {kind}…")
        by_ext = {r["ext_id"]: r["track_id"] for r in c.execute(
            "SELECT track_id, ext_id FROM track_sources WHERE source=? AND ext_id IS NOT NULL", (kind,))}
        previous = {r[0] for r in c.execute("SELECT track_id FROM track_sources WHERE source=?", (kind,))}
        by_path: dict[str, int] = {}
        for r in c.execute("SELECT id, path FROM tracks WHERE path IS NOT NULL ORDER BY (source='local'), id DESC"):
            by_path[db.canon_path(r["path"])] = r["id"]       # ante duplicados gana el que ya es de un programa

        ext_to_id: dict[str, int] = {}
        seen: set[int] = set()
        total = max(len(dump.tracks), 1)
        for i, t in enumerate(dump.tracks):
            tid = by_ext.get(t.ext_id)
            if tid is None and t.path:
                tid = by_path.get(db.canon_path(t.path))
            vals = _values(t, kind)
            row = c.execute("SELECT * FROM tracks WHERE id=?", (tid,)).fetchone() if tid else None
            if row is None:
                cols = {**vals, "path": t.path, "source": kind}
                if t.play_count:
                    cols["play_count"] = t.play_count
                cur = c.execute(
                    f"INSERT INTO tracks({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", list(cols.values()))
                tid = cur.lastrowid
                stats["nuevos"] += 1
                if t.path:
                    by_path[db.canon_path(t.path)] = tid
            else:
                stats[_apply(c, tid, row, vals, kind)] += 1
                if row["source"] == kind and t.play_count is not None:
                    c.execute("UPDATE tracks SET play_count=? WHERE id=?", (t.play_count, tid))
            ext_to_id[t.ext_id] = tid
            seen.add(tid)
            c.execute(
                "INSERT INTO track_sources(track_id, source, ext_id, path_raw, bpm, key_raw, key_camelot, rating, color, "
                "play_count, date_added, last_played, comment, cues_json, grid_json, synced_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(track_id, source) DO UPDATE SET "
                "ext_id=excluded.ext_id, path_raw=excluded.path_raw, bpm=excluded.bpm, key_raw=excluded.key_raw, "
                "key_camelot=excluded.key_camelot, rating=excluded.rating, color=excluded.color, "
                "play_count=excluded.play_count, date_added=excluded.date_added, last_played=excluded.last_played, "
                "comment=excluded.comment, cues_json=excluded.cues_json, grid_json=excluded.grid_json, "
                "synced_at=excluded.synced_at",
                (tid, kind, t.ext_id, t.path_raw or t.path, t.bpm, t.key_raw, _camelot(t), t.rating, t.color,
                 t.play_count, t.date_added, t.last_played, t.comment,
                 json.dumps([asdict(x) for x in t.cues]), json.dumps([asdict(x) for x in t.grid]), now),
            )
            if i % 500 == 0:
                upd(0.05 + 0.4 * i / total, f"Temas {i:,}/{total:,}".replace(",", "."))

        gone = sorted(previous - seen)
        if gone:
            drop_source(c, kind, gone)
            stats["fuera de la fuente"] = len(gone)

        upd(0.5, "Importando cajas…")
        seen_crates = _import_crates(c, kind, dump.crates, ext_to_id, stats)

        upd(0.7, "Importando historial…")
        last = _import_history(c, kind, dump, ext_to_id, by_path, seen_crates, stats)
        if last:
            c.executemany("UPDATE tracks SET last_played=? WHERE id=? AND (last_played IS NULL OR last_played<?)",
                          [(d, t, d) for t, d in last.items()])
        for t in dump.tracks:   # el último reproducido que ya trae el programa también cuenta
            if t.last_played and ext_to_id.get(t.ext_id):
                d = t.last_played[:10]
                c.execute("UPDATE tracks SET last_played=? WHERE id=? AND (last_played IS NULL OR last_played<?)",
                          (d, ext_to_id[t.ext_id], d))
        universe.prune(c)
        c.commit()
    except Exception:
        c.rollback()
        raise
    upd(0.98, "Listo")
    return dict(stats)


def _import_crates(c: sqlite3.Connection, kind: str, crates: list[SrcCrate], ext_to_id: dict[str, int], stats: Counter) -> set[str]:
    seen: set[str] = set()
    ids: dict[str, int] = {}
    for sc in crates:
        rid = f"{kind}:{sc.ext_id}"
        c.execute(
            "INSERT INTO crates(name, kind, rb_id, position, query, source) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(rb_id) DO UPDATE SET name=excluded.name, kind=excluded.kind, position=excluded.position, "
            "query=excluded.query, source=excluded.source",
            (sc.name or "Sin nombre", CRATE_KINDS.get(sc.kind, "playlist"), rid, sc.position, sc.rules_raw, kind),
        )
        ids[sc.ext_id] = c.execute("SELECT id FROM crates WHERE rb_id=?", (rid,)).fetchone()[0]
        seen.add(rid)
    for sc in crates:
        parent = ids.get(sc.parent_ext_id) if sc.parent_ext_id and sc.parent_ext_id != sc.ext_id else None
        c.execute("UPDATE crates SET parent_id=? WHERE id=?", (parent, ids[sc.ext_id]))
    # membresía: se reescribe entera (en orden)
    c.execute("DELETE FROM crate_tracks WHERE crate_id IN (SELECT id FROM crates WHERE source=? AND kind IN ('folder','playlist','smart_rb'))", (kind,))
    rows = []
    for sc in crates:
        if sc.kind == "folder":
            continue
        pos = 0
        for ext in sc.track_ext_ids:
            tid = ext_to_id.get(ext)
            if tid is not None:
                rows.append((ids[sc.ext_id], tid, pos))
                pos += 1
    c.executemany("INSERT OR IGNORE INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", rows)
    stats["cajas"] = len(crates)
    return seen


def _import_history(c: sqlite3.Connection, kind: str, dump: SourceDump, ext_to_id: dict[str, int],
                    by_path: dict[str, int], seen: set[str], stats: Counter) -> dict[int, str]:
    last: dict[int, str] = {}
    pairs: Counter = Counter()
    if dump.sessions:
        root_rid = f"{kind}:h:root"
        c.execute(
            "INSERT INTO crates(name, kind, rb_id, position, source) VALUES ('Historial','session_folder',?, 100000, ?) "
            "ON CONFLICT(rb_id) DO UPDATE SET name=excluded.name, kind=excluded.kind, source=excluded.source",
            (root_rid, kind),
        )
        root = c.execute("SELECT id FROM crates WHERE rb_id=?", (root_rid,)).fetchone()[0]
        seen.add(root_rid)
    c.execute("DELETE FROM crate_tracks WHERE crate_id IN (SELECT id FROM crates WHERE source=? AND kind='session')", (kind,))
    rows, unknown, nsessions = [], 0, 0
    for n, s in enumerate(dump.sessions):
        rid = f"{kind}:h:{s.ext_id}"
        date = (s.start or "")[:10] or None
        c.execute(
            "INSERT INTO crates(name, kind, parent_id, rb_id, position, date, source) VALUES (?, 'session', ?,?,?,?,?) "
            "ON CONFLICT(rb_id) DO UPDATE SET name=excluded.name, kind=excluded.kind, parent_id=excluded.parent_id, "
            "position=excluded.position, date=excluded.date, source=excluded.source",
            (s.name or date or "Sesión", root, rid, n, date, kind),
        )
        cid = c.execute("SELECT id FROM crates WHERE rb_id=?", (rid,)).fetchone()[0]
        seen.add(rid)
        seq: list[tuple[int, bool]] = []
        for p in sorted(s.plays, key=lambda p: p.position):
            tid = ext_to_id.get(p.track_ext_id) if p.track_ext_id else None
            if tid is None and p.path:
                tid = by_path.get(db.canon_path(p.path))
            if tid is None:
                unknown += 1
                continue
            seq.append((tid, p.on_air is not False))
            d = (p.start or s.start or "")[:10]
            if d and d > last.get(tid, ""):
                last[tid] = d
        rows.extend((cid, tid, i) for i, (tid, _) in enumerate(seq))
        air = [tid for tid, on in seq if on]
        for a, b in zip(air, air[1:]):
            if a != b:
                pairs[(a, b)] += 1
        nsessions += 1
    c.executemany("INSERT OR IGNORE INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", rows)
    src = f"history:{kind}"
    c.execute("DELETE FROM relations WHERE source=?", (src,))
    c.executemany(
        "INSERT INTO relations(a, b, kind, source, count, weight) VALUES (?,?, 'history', ?, ?, ?)",
        [(a, b, src, n, float(n)) for (a, b), n in pairs.items()],
    )
    # cajas de esta fuente que ya no vienen
    stale = [r[0] for r in c.execute("SELECT rb_id FROM crates WHERE source=? AND rb_id IS NOT NULL", (kind,)) if r[0] not in seen]
    c.executemany("DELETE FROM crates WHERE rb_id=?", [(k,) for k in stale])
    stats["sesiones"] = nsessions
    stats["transiciones del historial"] = len(pairs)
    if unknown:
        stats["reproducciones sin tema"] = unknown
    return last
