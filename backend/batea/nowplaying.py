"""Qué está sonando ahora (rekordbox, Serato o Traktor, en esta Mac) y qué poner después.

`state()` detecta qué programa de DJ está abierto y lee el que corresponda (rekordbox acá;
Serato en nowplaying_serato.py; Traktor en nowplaying_traktor.py, contrato en live_base.py).
Nunca se toca nada de los programas. Para rekordbox hay dos pistas:

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
import importlib
import re
import time
import unicodedata
from datetime import datetime, timedelta

from . import config, nowplaying_serato, recommend
from .api_helpers import is_online, mark_online, real_path
from .live_base import LiveReading, PlayRef

LIVE_DIR = config.APP_DIR / "rekordbox-live"
HISTORY_EVERY = 12.0
IGNORE_PREFIXES = ("/Applications/", "/System/", "/Library/", str(config.RB_DIR) + "/")

_lock = threading.Lock()
_seen: dict[str, float] = {}          # archivo abierto -> cuándo lo vimos por primera vez
_hist = {"t": 0.0, "sig": None, "ids": [], "name": None}
_recs_cache: dict[tuple, list] = {}
_titles = {"t": 0.0, "map": {}}
TITLES_EVERY = 60.0
ORDER = ("rekordbox", "serato", "traktor")


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


def _recs_for(c: sqlite3.Connection, now_id: int | None, played: list[int], loaded: list[int], limit: int) -> list[dict]:
    recs: list[dict] = []
    if not now_id:
        return recs
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
    return recs


def _rb_scan() -> tuple[int | None, list[str], float]:
    """pid de rekordbox, archivos abiertos y cuándo apareció el último (su 'actividad')."""
    pid = rekordbox_pid()
    if pid is None:
        _seen.clear()
        return None, [], 0.0
    now_t = time.time()
    files = open_audio_files(pid)
    for f in files:
        _seen.setdefault(f, now_t)
    for f in list(_seen):
        if f not in files:
            del _seen[f]
    return pid, files, max(_seen.values(), default=0.0)


def _rekordbox_state(c: sqlite3.Connection, limit: int, files: list[str]) -> dict:
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

    return {
        "rekordbox": True,
        "source": source,
        "now": _card(c, now_id) if now_id else None,
        "loaded": [x for x in (_card(c, t) for t in loaded[1:]) if x],
        "recs": _recs_for(c, now_id, played, loaded, limit),
        "session": session,
        "played": len(played),
        "open_files": len(files),
    }


# ------------------------------------------------------------------ otros programas
def _norm(s: str | None) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFD", s.casefold())
    return re.sub(r"[^a-z0-9]+", " ", "".join(ch for ch in s if not unicodedata.combining(ch))).strip()


def _title_map(c: sqlite3.Connection) -> dict[str, list[tuple[int, str, str]]]:
    """título normalizado (y 'artista título') -> [(id, artista normalizado, source)]; se rearma cada TITLES_EVERY s."""
    if time.time() - _titles["t"] < TITLES_EVERY and _titles["map"]:
        return _titles["map"]
    m: dict[str, list] = {}
    for r in c.execute("SELECT id, title, artist, source FROM tracks WHERE hidden=0 AND title IS NOT NULL"):
        a = _norm(r["artist"])
        ent = (r["id"], a, r["source"])
        for k in {_norm(r["title"]), _norm(f"{r['artist'] or ''} {r['title']}")}:
            if k:
                m.setdefault(k, []).append(ent)
    _titles.update(t=time.time(), map=m)
    return m


def _track_for_ref(c: sqlite3.Connection, ref: PlayRef, app: str) -> int | None:
    """Tema de Batea para algo que el programa cargó: por ruta; si no, por título y artista."""
    if ref.path:
        tid = _track_for_path(c, ref.path)
        if tid:
            return tid
    t, a = _norm(ref.title), _norm(ref.artist)
    if not t:
        return None
    m = _title_map(c)
    cands = list(dict.fromkeys(m.get(t, []) + (m.get(_norm(f"{ref.artist or ''} {ref.title}"), []) if a else [])))
    if a:
        # artista de Batea vacío = viene dentro del título: se acepta
        cands = [x for x in cands if not x[1] or x[1] == a or x[1] in a or a in x[1]]
    if not cands:
        return None
    pref = [x for x in cands if x[2] == app] or cands
    return pref[0][0]


def _live_state(c: sqlite3.Connection, reading: LiveReading, limit: int) -> dict:
    def ids(refs: list[PlayRef]) -> list[int]:
        out: list[int] = []
        for r in refs:
            tid = _track_for_ref(c, r, reading.app)
            if tid and tid not in out:
                out.append(tid)
        return out

    played = ids(reading.played)
    loaded = ids(reading.loaded)
    now_id = _track_for_ref(c, reading.now, reading.app) if reading.now else None
    if now_id:
        source = "aire"
    elif loaded:
        now_id, source = loaded[0], "deck"
    elif played:
        now_id, source = played[-1], "historial"
    else:
        source = None
    return {
        "rekordbox": False,
        "source": source,
        "now": _card(c, now_id) if now_id else None,
        "loaded": [x for x in (_card(c, t) for t in loaded if t != now_id) if x],
        "recs": _recs_for(c, now_id, played, [t for t in loaded if t != now_id], limit),
        "session": reading.session,
        "played": len(played),
        "open_files": 0,
    }


def _traktor():
    try:
        return importlib.import_module("batea.nowplaying_traktor")
    except Exception:  # noqa: BLE001  (todavía no existe o falla al importar: se ignora)
        return None


def _readers() -> dict:
    out = {"serato": nowplaying_serato}
    t = _traktor()
    if t is not None:
        out["traktor"] = t
    return out


def _is_running(mod) -> bool:
    try:
        return bool(mod.running())
    except Exception:  # noqa: BLE001
        return False


def _label(app: str | None, readers: dict) -> str | None:
    if app == "rekordbox":
        return "rekordbox"
    return getattr(readers.get(app), "LABEL", None) or (app.capitalize() if app else None)


def state(c: sqlite3.Connection, limit: int = 8) -> dict:
    from . import live_settings

    settings = live_settings.get(c)
    if not settings["enabled"]:
        _seen.clear()
        return {"rekordbox": False, "now": None, "loaded": [], "recs": [], "source": None,
                "enabled": False, "app": None, "app_label": None, "running": [], "note": None, "mode": settings["app"]}
    with _lock:
        readers = _readers()
        pid, files, rb_activity = _rb_scan()
        run = (["rekordbox"] if pid is not None else []) + [a for a, m in readers.items() if _is_running(m)]
        run.sort(key=lambda a: ORDER.index(a) if a in ORDER else len(ORDER))
        forced = settings["app"] if settings["app"] != "auto" else None
        if forced:
            run = [a for a in run if a == forced]

        extra: dict[str, LiveReading] = {}
        for app in run:
            if app == "rekordbox":
                continue
            try:
                r = readers[app].read(c)
            except Exception:  # noqa: BLE001
                r = None
            extra[app] = r or LiveReading(app)

        chosen = run[0] if run else None
        if len(run) > 1:
            act = {"rekordbox": rb_activity, **{a: r.activity for a, r in extra.items()}}
            chosen = max(run, key=lambda a: (act.get(a, 0.0), -run.index(a)))

        if chosen is None:
            res = {"rekordbox": False, "now": None, "loaded": [], "recs": [], "source": None}
            note = f"{_label(forced, readers)} no está abierto" if forced else None
        elif chosen == "rekordbox":
            res = _rekordbox_state(c, limit, files)
            note = None
        else:
            res = _live_state(c, extra[chosen], limit)
            note = extra[chosen].note
        res.update(app=chosen, app_label=_label(chosen, readers), running=run, note=note, enabled=True, mode=settings["app"])
        return res
