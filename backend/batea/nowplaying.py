"""Qué está sonando ahora en rekordbox (en esta Mac) y qué poner después.

Dos pistas, sin tocar nunca nada de rekordbox:

1. Archivos abiertos: mientras un tema está cargado en un deck, rekordbox suele tener el
   archivo abierto. `lsof` lo muestra al instante. El último que apareció cuenta como "ahora".
2. Historial: rekordbox anota en su sesión de historial lo que ya sonó un rato. Se lee una
   copia propia de master.db (aparte de la que usa la sincronización), renovada como mucho
   cada `HISTORY_EVERY` segundos y solo si rekordbox la cambió.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import threading
import time
import unicodedata
from datetime import datetime, timedelta

from . import config, recommend
from .api_helpers import is_online, mark_online, real_path

LIVE_DIR = config.APP_DIR / "rekordbox-live"
HISTORY_EVERY = 12.0
IGNORE_PREFIXES = ("/Applications/", "/System/", "/Library/", str(config.RB_DIR) + "/")

_lock = threading.Lock()
_seen: dict[str, float] = {}          # archivo abierto -> cuándo lo vimos por primera vez
_hist = {"t": 0.0, "sig": None, "ids": [], "name": None}
_recs_cache: dict[tuple, list] = {}


# ------------------------------------------------------------------ rekordbox
def rekordbox_pid() -> int | None:
    try:
        out = subprocess.run(["/usr/bin/pgrep", "-x", "rekordbox"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    pids = [int(p) for p in out.split() if p.isdigit()]
    return pids[0] if pids else None


def open_audio_files(pid: int) -> list[str]:
    try:
        out = subprocess.run(["/usr/sbin/lsof", "-n", "-P", "-p", str(pid), "-Fn"],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    files = []
    for line in out.splitlines():
        if not line.startswith("n/"):
            continue
        p = line[1:]
        if os.path.splitext(p)[1].lower() in config.AUDIO_EXTS and not p.startswith(IGNORE_PREFIXES) and p not in files:
            files.append(p)
    return files


def _history() -> tuple[list[str], str | None]:
    """rb ContentIDs de la sesión de historial de hoy, en orden, y su nombre."""
    src = config.RB_DIR / "master.db"
    now = time.time()
    if now - _hist["t"] < HISTORY_EVERY or not src.exists():
        return _hist["ids"], _hist["name"]
    _hist["t"] = now
    sig = tuple((config.RB_DIR / n).stat().st_mtime if (config.RB_DIR / n).exists() else 0
                for n in ("master.db", "master.db-wal"))
    if sig == _hist["sig"]:
        return _hist["ids"], _hist["name"]
    try:
        LIVE_DIR.mkdir(parents=True, exist_ok=True)
        for n in ("master.db", "master.db-wal", "master.db-shm"):
            s, d = config.RB_DIR / n, LIVE_DIR / n
            if s.exists():
                shutil.copy2(s, d)
            elif d.exists():
                d.unlink()
        from pyrekordbox import MasterDatabase

        rb = MasterDatabase(path=str(LIVE_DIR / "master.db"))
        try:
            sessions = [h for h in rb.get_history() if h.Attribute == 0 and h.created_at]
            sessions.sort(key=lambda h: h.created_at)
            ids, name = [], None
            if sessions and sessions[-1].created_at > datetime.now() - timedelta(hours=14):
                last = sessions[-1]
                songs = sorted(rb.get_history_songs(HistoryID=last.ID).all(), key=lambda s: int(s.TrackNo or 0))
                ids, name = [str(s.ContentID) for s in songs], last.Name
        finally:
            rb.close()
        _hist.update(sig=sig, ids=ids, name=name)
    except Exception:  # noqa: BLE001  (base a medio escribir: se reintenta en la próxima vuelta)
        _hist["sig"] = None
    return _hist["ids"], _hist["name"]


# ------------------------------------------------------------------ Batea
def _track_for_path(c: sqlite3.Connection, p: str) -> int | None:
    for v in dict.fromkeys((p, unicodedata.normalize("NFC", p), unicodedata.normalize("NFD", p))):
        r = c.execute("SELECT id FROM tracks WHERE path=? ORDER BY source='rekordbox' DESC LIMIT 1", (v,)).fetchone()
        if r:
            return r[0]
        try:
            r = c.execute("SELECT ref_id FROM found_files WHERE path=? AND ref_id IS NOT NULL LIMIT 1", (v,)).fetchone()
        except sqlite3.OperationalError:
            r = None
        if r:
            return r[0]
    return None


def drag_path(c: sqlite3.Connection, tid: int) -> tuple[str | None, str]:
    """Qué archivo entregar al arrastrar a rekordbox, y de qué tipo es:
    'rekordbox' = la ruta que rekordbox ya conoce (no duplica), 'copia' = el mismo tema en otra
    carpeta (rekordbox puede tomarlo como nuevo), 'nuevo' = no está en rekordbox."""
    r = c.execute("SELECT path, source FROM tracks WHERE id=?", (tid,)).fetchone()
    if not r:
        return None, "nuevo"
    if r["source"] == "rekordbox" and is_online(r["path"]):
        return r["path"], "rekordbox"
    p = real_path(c, tid)
    return p, ("copia" if r["source"] == "rekordbox" else "nuevo")


def _card(c: sqlite3.Connection, tid: int) -> dict | None:
    r = c.execute("SELECT id, title, artist, bpm, key, COALESCE(energy, energy_auto) AS energy, path "
                  "FROM tracks WHERE id=?", (tid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    mark_online(c, [d])
    d["drag_path"], d["drag_kind"] = drag_path(c, tid)
    return d


def state(c: sqlite3.Connection, limit: int = 8) -> dict:
    with _lock:
        pid = rekordbox_pid()
        if pid is None:
            _seen.clear()
            return {"rekordbox": False, "now": None, "loaded": [], "recs": [], "source": None}

        now_t = time.time()
        files = open_audio_files(pid)
        for f in files:
            _seen.setdefault(f, now_t)
        for f in list(_seen):
            if f not in files:
                del _seen[f]

        rb_ids, session = _history()
        by_rb = {}
        if rb_ids:
            q = ",".join("?" * len(set(rb_ids)))
            by_rb = {r["rb_id"]: r["id"] for r in c.execute(f"SELECT id, rb_id FROM tracks WHERE rb_id IN ({q})", list(set(rb_ids)))}
        played = [by_rb[x] for x in rb_ids if x in by_rb]
        hist_pos = {tid: i for i, tid in enumerate(played)}

        loaded: list[int] = []
        # el último que se cargó primero; si aparecieron juntos, decide el historial
        for f in sorted(_seen, key=lambda f: (-_seen[f], -hist_pos.get(_track_for_path(c, f) or -1, -1))):
            tid = _track_for_path(c, f)
            if tid and tid not in loaded:
                loaded.append(tid)

        if loaded:
            now_id, source = loaded[0], "deck"
        elif played:
            now_id, source = played[-1], "historial"
        else:
            now_id, source = None, None

        recs: list[dict] = []
        if now_id:
            exclude = set(played) | set(loaded)
            key = (now_id, tuple(sorted(exclude)))
            items = _recs_cache.get(key)
            if items is None:
                res = recommend.recommend(c, now_id, limit + len(exclude) + 4)
                items = [i for i in res["items"] if i["id"] not in exclude][:limit]
                _recs_cache.clear()
                _recs_cache[key] = items
            for i in items:
                card = _card(c, i["id"])
                if card:
                    card["reasons"] = i["reasons"]
                    card["learned"] = i["learned"]
                    recs.append(card)
            recs.sort(key=lambda r: not r["drag_path"])  # lo que se puede arrastrar ya, primero

        return {
            "rekordbox": True,
            "source": source,
            "now": _card(c, now_id) if now_id else None,
            "loaded": [x for x in (_card(c, t) for t in loaded[1:]) if x],
            "recs": recs,
            "session": session,
            "played": len(played),
            "open_files": len(files),
        }
