"""Importación desde rekordbox.

Siempre se copia master.db a una carpeta propia y se lee la copia: Batea
nunca escribe en la base de rekordbox. Para devolver cambios a rekordbox se
usa la exportación XML (ver export.py), que es el camino oficial.
"""
from __future__ import annotations

import shutil
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path

import numpy as np

from . import anlz, config, db, features, keys, titles, universe
from .jobs import Job

COLOR_NAMES = {"1": "pink", "2": "red", "3": "orange", "4": "yellow", "5": "green", "6": "aqua", "7": "blue", "8": "purple"}


def rekordbox_available() -> bool:
    return (config.RB_DIR / "master.db").exists()


def snapshot() -> Path:
    src = config.RB_DIR
    dst = config.RB_SNAPSHOT_DIR
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("master.db", "master.db-wal", "master.db-shm", "masterPlaylists6.xml"):
        s = src / name
        d = dst / name
        if s.exists():
            shutil.copy2(s, d)
        elif d.exists():
            d.unlink()
    return dst / "master.db"


def _s(v) -> str | None:
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def _date(*vals) -> str | None:
    for v in vals:
        if not v:
            continue
        if isinstance(v, datetime):
            return v.strftime("%Y-%m-%d")
        s = str(v)[:10]
        if len(s) == 10 and s[4] == "-":
            return s
    return None


def sync(job: Job) -> dict:
    from pyrekordbox import MasterDatabase  # import diferido: tarda en cargar

    job.update(0.02, "Copiando la base de rekordbox…")
    path = snapshot()
    job.update(0.05, "Abriendo la copia…")
    rb = MasterDatabase(path=str(path))

    lookup = {}
    for name, getter in (("artist", rb.get_artist), ("album", rb.get_album), ("genre", rb.get_genre),
                         ("key", rb.get_key), ("label", rb.get_label)):
        lookup[name] = {str(o.ID): o for o in getter()}

    def nm(kind: str, id_) -> str | None:
        o = lookup[kind].get(str(id_)) if id_ is not None else None
        if o is None:
            return None
        return _s(getattr(o, "ScaleName", None) if kind == "key" else o.Name)

    job.update(0.08, "Leyendo temas…")
    contents = [c for c in rb.get_content() if not getattr(c, "rb_local_deleted", 0)]
    total = len(contents)

    stats = Counter()
    with db.conn() as c:
        existing = {r["rb_id"]: r["id"] for r in c.execute("SELECT id, rb_id FROM tracks WHERE rb_id IS NOT NULL")}
        batea_keys = {r["id"] for r in c.execute("SELECT id FROM tracks WHERE key_source='batea' AND key IS NOT NULL")}
        by_path = {r["path"]: r["id"] for r in c.execute("SELECT id, path FROM tracks WHERE rb_id IS NULL AND path IS NOT NULL")}
        rb_to_id: dict[str, int] = {}

        for i, t in enumerate(contents):
            rid = str(t.ID)
            key_raw = nm("key", t.KeyID)
            artwork = _s(t.ImagePath)
            row = dict(
                rb_id=rid,
                path=_s(t.FolderPath),
                title=_s(t.Title),
                artist=nm("artist", t.ArtistID),
                album=nm("album", t.AlbumID),
                label=nm("label", t.LabelID),
                genre=nm("genre", t.GenreID),
                remixer=nm("artist", t.RemixerID),
                bpm=(t.BPM or 0) / 100 or None,
                key=keys.to_camelot(key_raw),
                key_raw=key_raw,
                duration=float(t.Length) if t.Length else None,
                rb_rating=int(t.Rating or 0),
                rb_color=COLOR_NAMES.get(str(t.ColorID)),
                rb_comment=_s(t.Commnt),
                year=int(t.ReleaseYear) if t.ReleaseYear else None,
                bitrate=int(t.BitRate) if t.BitRate else None,
                filetype=Path(t.FolderPath).suffix.lower().lstrip(".") if t.FolderPath else None,
                artwork=artwork,
                anlz_dir=str(anlz.resolve_dir(t.AnalysisDataPath)) if t.AnalysisDataPath else None,
                date_added=_date(t.StockDate, t.created_at, t.DateCreated),
                play_count=int(t.DJPlayCount or 0),
            )
            row["key_source"] = "rekordbox" if row["key"] else None
            cols = list(row.keys())
            tid = existing.get(rid) or by_path.get(row["path"] or "")
            if tid and not row["key"] and tid in batea_keys:
                # rekordbox no tiene tono para este tema: se conserva el que calculó Batea
                cols = [k for k in cols if k not in ("key", "key_source")]
            if tid:
                c.execute(
                    f"UPDATE tracks SET {', '.join(f'{k}=?' for k in cols)}, source='rekordbox' WHERE id=?",
                    [row[k] for k in cols] + [tid],
                )
                stats["actualizados"] += 1
            else:
                cur = c.execute(
                    f"INSERT INTO tracks({', '.join(cols)}, source) VALUES ({', '.join('?' * len(cols))}, 'rekordbox')",
                    [row[k] for k in cols],
                )
                tid = cur.lastrowid
                stats["nuevos"] += 1
            rb_to_id[rid] = tid
            if i % 500 == 0:
                job.update(0.08 + 0.35 * i / max(total, 1), f"Temas {i:,}/{total:,}".replace(",", "."))

        gone = set(existing) - set(rb_to_id)
        if gone:
            c.executemany("UPDATE tracks SET rb_id=NULL, source='local' WHERE rb_id=?", [(g,) for g in gone])
            stats["fuera de rekordbox"] = len(gone)

        # ---- My Tags ------------------------------------------------------
        job.update(0.45, "Importando My Tags…")
        mytags = list(rb.get_my_tag())
        cats = {str(m.ID): m.Name for m in mytags if m.Attribute == 1}
        tag_ids: dict[str, int] = {}
        for m in mytags:
            if m.Attribute == 1:
                continue
            category = f"rekordbox · {cats.get(str(m.ParentID), 'My Tag')}"
            c.execute(
                "INSERT INTO tags(name, category, source, rb_id) VALUES (?,?, 'rekordbox', ?) "
                "ON CONFLICT(rb_id) DO UPDATE SET name=excluded.name, category=excluded.category",
                (m.Name, category, str(m.ID)),
            )
            tag_ids[str(m.ID)] = c.execute("SELECT id FROM tags WHERE rb_id=?", (str(m.ID),)).fetchone()[0]
        c.execute("DELETE FROM track_tags WHERE source='rekordbox'")
        c.executemany(
            "INSERT OR IGNORE INTO track_tags(track_id, tag_id, source) VALUES (?,?, 'rekordbox')",
            [(rb_to_id[str(s.ContentID)], tag_ids[str(s.MyTagID)]) for s in rb.get_my_tag_songs()
             if str(s.ContentID) in rb_to_id and str(s.MyTagID) in tag_ids],
        )

        # ---- Playlists -> cajas -------------------------------------------
        job.update(0.5, "Importando playlists…")
        seen: set[str] = set()
        _import_tree(c, list(rb.get_playlist()), "pl", {0: "playlist", 1: "folder", 4: "smart_rb"}, seen)
        c.execute("DELETE FROM crate_tracks WHERE crate_id IN (SELECT id FROM crates WHERE rb_id LIKE 'pl:%')")
        crate_of = {r["rb_id"]: r["id"] for r in c.execute("SELECT id, rb_id FROM crates WHERE rb_id IS NOT NULL")}
        c.executemany(
            "INSERT OR IGNORE INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)",
            [(crate_of[f"pl:{s.PlaylistID}"], rb_to_id[str(s.ContentID)], int(s.TrackNo or 0))
             for s in rb.get_playlist_songs() if f"pl:{s.PlaylistID}" in crate_of and str(s.ContentID) in rb_to_id],
        )
        stats["playlists"] = sum(1 for k in seen if k.startswith("pl:"))

        # ---- Historial -> sesiones + relaciones "tocados seguidos" ---------
        job.update(0.55, "Importando historial de sesiones…")
        hist = list(rb.get_history())
        _import_tree(c, hist, "h", {0: "session", 1: "session_folder"}, seen)
        for h in hist:
            if h.Attribute == 0:
                c.execute("UPDATE crates SET date=? WHERE rb_id=?", (_date(h.DateCreated, h.created_at), f"h:{h.ID}"))
        c.execute("DELETE FROM crate_tracks WHERE crate_id IN (SELECT id FROM crates WHERE rb_id LIKE 'h:%')")
        crate_of = {r["rb_id"]: r["id"] for r in c.execute("SELECT id, rb_id FROM crates WHERE rb_id IS NOT NULL")}
        sessions: dict[str, list[tuple[int, int]]] = {}
        for s in rb.get_history_songs():
            if str(s.ContentID) in rb_to_id:
                sessions.setdefault(str(s.HistoryID), []).append((int(s.TrackNo or 0), rb_to_id[str(s.ContentID)]))
        rows, pairs = [], Counter()
        last_played: dict[int, str] = {}
        dates = {str(h.ID): _date(h.DateCreated, h.created_at) for h in hist}
        for hid, items in sessions.items():
            items.sort()
            cid = crate_of.get(f"h:{hid}")
            if cid:
                rows.extend((cid, tid, pos) for pos, tid in items)
            d = dates.get(hid)
            for _, tid in items:
                if d and d > last_played.get(tid, ""):
                    last_played[tid] = d
            for (_, a), (_, b) in zip(items, items[1:]):
                if a != b:
                    pairs[(a, b)] += 1
        c.executemany("INSERT OR IGNORE INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", rows)
        c.execute("DELETE FROM relations WHERE source='history'")
        c.executemany(
            "INSERT INTO relations(a, b, kind, source, count, weight) VALUES (?,?, 'history', 'history', ?, ?)",
            [(a, b, n, float(n)) for (a, b), n in pairs.items()],
        )
        c.executemany("UPDATE tracks SET last_played=? WHERE id=?", [(d, t) for t, d in last_played.items()])
        stats["sesiones"] = len(sessions)
        stats["transiciones del historial"] = len(pairs)

        # cajas de rekordbox que ya no existen
        rb_crates = [r["rb_id"] for r in c.execute("SELECT rb_id FROM crates WHERE rb_id IS NOT NULL")]
        c.executemany("DELETE FROM crates WHERE rb_id=?", [(k,) for k in rb_crates if k not in seen])
        universe.prune(c)
        c.commit()

        # ---- Análisis desde los archivos ANLZ ------------------------------
        analyze_from_anlz(c, job, 0.6, 0.97)
        recompute_energy(c)
        db.set_meta(c, "last_sync", datetime.now().isoformat(timespec="seconds"))
        db.set_meta(c, "rb_track_count", str(total))

    rb.close()
    return dict(stats)


def _import_tree(c: sqlite3.Connection, nodes: list, prefix: str, kinds: dict[int, str], seen: set[str]) -> None:
    by_id = {str(n.ID): n for n in nodes}
    done: dict[str, int] = {}

    def ensure(n) -> int | None:
        rid = f"{prefix}:{n.ID}"
        if rid in done:
            return done[rid]
        kind = kinds.get(int(n.Attribute or 0))
        if kind is None:
            return None
        parent_db = None
        parent = by_id.get(str(n.ParentID))
        if parent is not None and parent is not n:
            parent_db = ensure(parent)
        c.execute(
            "INSERT INTO crates(name, kind, parent_id, rb_id, position) VALUES (?,?,?,?,?) "
            "ON CONFLICT(rb_id) DO UPDATE SET name=excluded.name, kind=excluded.kind, "
            "parent_id=excluded.parent_id, position=excluded.position",
            (n.Name or "Sin nombre", kind, parent_db, rid, int(getattr(n, "Seq", 0) or 0)),
        )
        cid = c.execute("SELECT id FROM crates WHERE rb_id=?", (rid,)).fetchone()[0]
        done[rid] = cid
        seen.add(rid)
        return cid

    for n in nodes:
        ensure(n)


def _tag_id_map(c: sqlite3.Connection) -> dict[str, int]:
    return {r["name"]: r["id"] for r in c.execute("SELECT id, name FROM tags WHERE source='user'")}


def store_features(c: sqlite3.Connection, track_id: int, f: features.Features, analyzed: str,
                   first_time: bool, title: str | None, tag_ids: dict[str, int]) -> None:
    c.execute(
        "UPDATE tracks SET energy_raw=?, intro_bars=?, outro_bars=?, breaks=?, analyzed=? WHERE id=?",
        (f.energy_raw, f.intro_bars, f.outro_bars, f.breaks, analyzed, track_id),
    )
    if first_time:
        names = features.auto_structure_tags(f) + titles.auto_version_tags(title)
        c.executemany(
            "INSERT OR IGNORE INTO track_tags(track_id, tag_id, source) VALUES (?,?, 'auto')",
            [(track_id, tag_ids[n]) for n in names if n in tag_ids],
        )


def analyze_from_anlz(c: sqlite3.Connection, job: Job | None, p0: float, p1: float) -> int:
    rows = c.execute(
        "SELECT id, anlz_dir, bpm, title, analyzed FROM tracks "
        "WHERE anlz_dir IS NOT NULL AND (analyzed IS NULL OR analyzed='anlz')"
    ).fetchall()
    tag_ids = _tag_id_map(c)
    done = 0
    for i, r in enumerate(rows):
        curves = anlz.read_curves(Path(r["anlz_dir"]))
        if curves is not None:
            f = features.compute(curves, r["bpm"])
            if f:
                store_features(c, r["id"], f, "anlz", r["analyzed"] is None, r["title"], tag_ids)
                done += 1
        if job and i % 400 == 0:
            job.update(p0 + (p1 - p0) * i / max(len(rows), 1), f"Analizando waveforms {i:,}/{len(rows):,}".replace(",", "."))
    return done


def recompute_energy(c: sqlite3.Connection) -> None:
    """Energía 1-10 relativa a TU librería (por percentiles)."""
    rows = c.execute("SELECT id, energy_raw FROM tracks WHERE energy_raw IS NOT NULL").fetchall()
    if not rows:
        return
    vals = np.array([r["energy_raw"] for r in rows])
    ranks = vals.argsort().argsort() / max(len(vals) - 1, 1)
    c.executemany(
        "UPDATE tracks SET energy_auto=? WHERE id=?",
        [(int(min(10, 1 + rk * 10)), r["id"]) for rk, r in zip(ranks, rows)],
    )
