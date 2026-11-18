"""Qué está sonando ahora en Serato DJ (Pro o Lite), sin tocar nada de Serato.

Serato 4/5 escribe el historial en vivo en master.sqlite (history_session / history_entry);
Serato 3.x va escribiendo el archivo de sesión (.session). En los dos casos se lee una COPIA
en config.APP_DIR/"serato-live", renovada como mucho cada COPY_EVERY segundos y solo si algo cambió.
"""
from __future__ import annotations

import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

from . import config
from .live_base import LiveReading, PlayRef
from .sources import serato_tlv as tlv
from .sources.serato import (
    _MASTER, _MUSIC, _SUPPORT, SeratoSource, _audio_path, _copy_sqlite, _deck, _float, _sqlite_signature, _text,
    _volume_roots,
)

APP = "serato"
LABEL = "Serato"
COPY_EVERY = 3.0
STALE_AFTER = 14 * 3600          # una sesión más vieja que esto ya no es "lo de ahora"
_OPEN_END = 0xFFFFFFFF

_lock = threading.Lock()
_cache: dict = {"t": 0.0, "sig": None, "reading": None}


def _live_dir() -> Path:
    return config.APP_DIR / "serato-live"


def running() -> bool:
    try:
        r = subprocess.run(["pgrep", "-f", r"[S]erato DJ (Pro|Lite)($|[.]app/Contents/MacOS/)"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _home() -> Path:
    return SeratoSource().home


def _open_end(v) -> bool:
    f = _float(v)
    return f is None or f <= 0 or f == _OPEN_END


# ------------------------------------------------------------------ Serato 4/5
def _columns(con: sqlite3.Connection, table: str) -> set[str]:
    return {r[1].lower() for r in con.execute(f'PRAGMA table_info("{table}")')}


def _select(con: sqlite3.Connection, table: str, names: str) -> list[dict]:
    have = _columns(con, table)
    sel = [n for n in names.split() if n in have]
    if not sel:
        return []
    cur = con.execute(f'SELECT {", ".join(chr(34) + n + chr(34) for n in sel)} FROM "{table}"')
    return [dict(zip(sel, row)) for row in cur]


def _entry_ref(row: dict, roots: dict) -> PlayRef:
    raw = _text(row.get("portable_id")) or None
    if not raw:
        fn = _text(row.get("file_name"))
        raw = fn if fn and "/" in fn else None
    root = roots.get(row.get("location_id")) or Path("/")
    path = _audio_path(raw, root) if raw else None
    start = _float(row.get("start_time"))
    return PlayRef(path=path, title=_text(row.get("name")), artist=_text(row.get("artist")),
                   deck=_deck(row.get("deck")), start=start if start and start > 0 else None)


def _read_sqlite(copy: Path) -> LiveReading:
    con = sqlite3.connect(f"file:{copy}?mode=ro", uri=True)
    try:
        sessions = [s for s in _select(con, "history_session", "id name start_time") if s.get("id") is not None]
        entries = _select(con, "history_entry", "id session_id portable_id file_name location_id name artist "
                                                "deck start_time end_time played")
        roots = _volume_roots(con)
    finally:
        con.close()

    session = None
    if sessions:
        session = max(sessions, key=lambda s: (_float(s.get("start_time")) or 0, s["id"]))
        entries = [e for e in entries if e.get("session_id") == session["id"]]
    entries.sort(key=lambda e: (_float(e.get("start_time")) or 0, e.get("id") or 0))

    activity = 0.0
    for e in entries:
        activity = max(activity, _float(e.get("start_time")) or 0,
                       0 if _open_end(e.get("end_time")) else _float(e.get("end_time")) or 0)
    if not entries:
        activity = (_float(session.get("start_time")) or 0) if session else 0.0
    name = _text(session.get("name")) if session else None

    played_rows = [e for e in entries if _float(e.get("played")) == 1]
    open_rows = [e for e in entries if _open_end(e.get("end_time"))]
    # "al aire" solo si sigue sonando; si no, el dispatcher cae al último de `played` como historial
    now_row = next((e for e in reversed(played_rows) if _open_end(e.get("end_time"))), None)
    return LiveReading(
        APP,
        now=_entry_ref(now_row, roots) if now_row else None,
        loaded=[_entry_ref(e, roots) for e in reversed(open_rows)],
        played=[_entry_ref(e, roots) for e in played_rows],
        session=name, activity=activity,
    )


# ------------------------------------------------------------------ Serato 3.x
def _read_session_file(copy: Path, mtime: float) -> LiveReading:
    rows = list(tlv.adat_records(copy.read_bytes(), "oent", strings={2, 6, 7}, numbers={28, 29, 31, 50}))
    refs, played, loaded, now = [], [], [], None
    for row in rows:
        start = row.get(28)
        ref = PlayRef(path=_audio_path(_text(row.get(2)), Path("/")), title=_text(row.get(6)),
                      artist=_text(row.get(7)), deck=row.get(31), start=float(start) if start else None)
        refs.append((row, ref))
    refs.sort(key=lambda x: x[0].get(28) or 0)
    for row, ref in refs:
        if row.get(50) == 1:
            played.append(ref)
            if _open_end(row.get(29)):
                now = ref
        if _open_end(row.get(29)):
            loaded.append(ref)
    activity = max([mtime, *(r.start or 0 for _, r in refs)])
    return LiveReading(APP, now=now, loaded=list(reversed(loaded)), played=played, activity=activity)


# ------------------------------------------------------------------ copia y lectura
def _latest_session(home: Path) -> Path | None:
    files = [p for p in (home / _MUSIC / "History" / "Sessions").glob("*.session") if p.is_file()]
    return max(files, key=lambda p: p.stat().st_mtime, default=None)


def _compute() -> LiveReading | None:
    home = _home()
    master = home / _SUPPORT / _MASTER
    live = _live_dir()
    live.mkdir(parents=True, exist_ok=True)
    if master.exists():
        _copy_sqlite(master, live / _MASTER)
        return _read_sqlite(live / _MASTER)
    sess = _latest_session(home)
    if sess is None:
        return None
    copy = live / "current.session"
    shutil.copyfile(sess, copy)
    return _read_session_file(copy, sess.stat().st_mtime)


def _signature() -> list:
    home = _home()
    master = home / _SUPPORT / _MASTER
    if master.exists():
        return _sqlite_signature([master, master.with_name(master.name + "-wal"), master.with_name(master.name + "-shm")])
    sess = _latest_session(home)
    return _sqlite_signature([sess]) + [str(sess)] if sess else []


def _fresh(reading: LiveReading | None) -> LiveReading | None:
    """Una sesión de hace más de STALE_AFTER no cuenta como "lo de ahora"."""
    if reading and reading.activity and time.time() - reading.activity > STALE_AFTER:
        return LiveReading(APP, session=reading.session, activity=reading.activity)
    return reading


def read(c: sqlite3.Connection | None = None) -> LiveReading | None:
    with _lock:
        now = time.time()
        if now - _cache["t"] < COPY_EVERY:
            return _fresh(_cache["reading"])
        _cache["t"] = now
        try:
            sig = _signature()
            if not sig or sig != _cache["sig"]:
                _cache.update(sig=sig, reading=_compute())
        except Exception:  # noqa: BLE001  (base a medio escribir: se reintenta en la próxima vuelta)
            _cache["sig"] = None
        return _fresh(_cache["reading"])


def reset() -> None:
    with _lock:
        _cache.update(t=0.0, sig=None, reading=None)
