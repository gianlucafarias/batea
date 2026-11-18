"""Registro de fuentes: qué programas hay, cuáles están activos y cómo se sincroniza cada uno.

Los adaptadores se importan al usarlos: si uno no existe o falla al cargar, esa fuente figura
como "no encontrada" y el resto sigue funcionando.
"""
from __future__ import annotations

import contextlib
import importlib
import inspect
import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from .. import config, db
from ..jobs import Job
from .base import KINDS, LABELS, SHORT

ADAPTERS = {
    "rekordbox": ("batea.sources.rekordbox", "RekordboxSource"),
    "traktor": ("batea.sources.traktor", "TraktorSource"),
}
ALWAYS_LISTED = ("rekordbox", "traktor", "serato")   # el resto (Engine, VirtualDJ) solo aparece si se encuentra
_env_lock = threading.Lock()
_cache: dict[tuple, tuple[float, object]] = {}      # detección reciente (exists + pgrep): evita repetirla en cada /api/status
CACHE_S = 5.0


# ---------------------------------------------------------------- adaptadores
def _traktor_root(path: str) -> Path:
    """La persona puede indicar collection.nml, la carpeta "Traktor 4.x" o la que las contiene."""
    p = Path(path).expanduser()
    if p.is_file():
        p = p.parent
    return p.parent if p.name.startswith("Traktor ") else p


@contextlib.contextmanager
def adapter(kind: str, path: str | None = None):
    """Instancia del adaptador (o None si no existe / no carga). `path` = ruta manual de esa fuente."""
    spec = ADAPTERS.get(kind)
    if spec is None:
        yield None
        return
    try:
        cls = getattr(importlib.import_module(spec[0]), spec[1])
    except Exception:  # noqa: BLE001  (falta el archivo o falla al importar: fuente no disponible)
        yield None
        return
    if not path or kind != "traktor":
        yield cls()
        return
    root = _traktor_root(path)
    if "root" in inspect.signature(cls).parameters:
        yield cls(root=root)
        return
    # el adaptador solo lee BATEA_TRAKTOR_DIR: se fija mientras dura el uso
    with _env_lock:
        old = os.environ.get("BATEA_TRAKTOR_DIR")
        os.environ["BATEA_TRAKTOR_DIR"] = str(root)
        try:
            yield cls()
        finally:
            if old is None:
                os.environ.pop("BATEA_TRAKTOR_DIR", None)
            else:
                os.environ["BATEA_TRAKTOR_DIR"] = old


def _discover(kind: str, path: str | None):
    key = (kind, path or "", os.environ.get("BATEA_TRAKTOR_DIR", ""), str(config.RB_DIR))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    info = None
    with adapter(kind, path) as ad:
        if ad is not None:
            try:
                info = ad.discover()
            except Exception:  # noqa: BLE001
                info = None
    _cache[key] = (time.time(), info)
    return info


def forget() -> None:
    _cache.clear()


# ---------------------------------------------------------------- estado en la base
def enabled_kinds(c: sqlite3.Connection) -> list[str]:
    raw = db.get_meta(c, "sources_enabled")
    if raw is not None:
        try:
            return [k for k in json.loads(raw) if isinstance(k, str)]
        except ValueError:
            pass
    # base sin esa meta: quien ya tiene temas de rekordbox sigue viéndolo todo igual
    has_rb = c.execute("SELECT 1 FROM tracks WHERE rb_id IS NOT NULL LIMIT 1").fetchone()
    return ["rekordbox"] if has_rb else []


def set_enabled(c: sqlite3.Connection, kinds: list[str]) -> None:
    db.set_meta(c, "sources_enabled", json.dumps([k for k in KINDS if k in kinds]))


def source_path(c: sqlite3.Connection, kind: str) -> str | None:
    return db.get_meta(c, f"source_path:{kind}") or None


def last_sync(c: sqlite3.Connection, kind: str) -> str | None:
    v = db.get_meta(c, f"last_sync:{kind}")
    return v or (db.get_meta(c, "last_sync") if kind == "rekordbox" else None)


def _pretty(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%d/%m %H:%M")
    except ValueError:
        return iso


def detect_one(c: sqlite3.Connection, kind: str, enabled: list[str] | None = None) -> dict:
    enabled = enabled_kinds(c) if enabled is None else enabled
    info = _discover(kind, source_path(c, kind))
    ls = last_sync(c, kind)
    detail = info.detail if info else None
    if kind == "rekordbox" and info and ls:
        detail = f"sincronizado el {_pretty(ls)}"
    return {
        "kind": kind,
        "label": LABELS.get(kind, kind),
        "short": SHORT.get(kind, kind[:2].upper()),
        "found": bool(info and info.found),
        "enabled": kind in enabled,
        "version": info.version if info else None,
        "detail": detail,
        "app_running": bool(info and info.app_running),
        "last_sync": ls,
        "track_count": c.execute("SELECT COUNT(*) FROM track_sources WHERE source=?", (kind,)).fetchone()[0],
        "locations": [
            {"path": str(loc.path), "version": loc.version, "volume": loc.volume, "modified": loc.modified}
            for loc in (info.locations if info else [])
        ],
    }


def detect_all(c: sqlite3.Connection | None = None) -> list[dict]:
    if c is None:
        with db.conn() as c2:
            return detect_all(c2)
    enabled = enabled_kinds(c)
    out = [detect_one(c, k, enabled) for k in KINDS]
    return [s for s in out if s["found"] or s["kind"] in ALWAYS_LISTED]


def is_known(kind: str) -> bool:
    return kind in KINDS


# ---------------------------------------------------------------- sincronizar
def job_kind(kind: str) -> str:
    return "sync" if kind == "rekordbox" else f"sync:{kind}"


def job_label(kind: str) -> str:
    return f"Sincronizando con {LABELS.get(kind, kind)}"


def sync(kind: str, job: Job) -> dict:
    """Trae la librería de `kind` a Batea. rekordbox usa rbsync; el resto: copia → lectura → importador genérico."""
    from . import importer

    if kind == "rekordbox":
        with adapter(kind) as ad:
            res = ad.sync(job)
    else:
        with db.conn() as c:
            path = source_path(c, kind)
        with adapter(kind, path) as ad:
            if ad is None:
                raise RuntimeError(f"Todavía no sé leer {LABELS.get(kind, kind)}")
            info = ad.discover()
            if not info.found or not info.locations:
                raise RuntimeError(f"No encontré la librería de {LABELS.get(kind, kind)}")
            loc = info.locations[0]
            job.update(0.02, f"Copiando la librería de {LABELS.get(kind, kind)}…")
            cache = config.SOURCES_DIR / kind
            cache.mkdir(parents=True, exist_ok=True)
            snap = ad.snapshot(loc, cache)
            job.update(0.1, "Leyendo la copia…")
            dump = ad.read(snap, loc)
        with db.conn() as c:
            res = importer.import_dump(c, dump, job)
        res = dict(res)
        res["warnings"] = list(dump.warnings)
        if dump.version:
            res["version"] = dump.version
    with db.conn() as c:
        db.set_meta(c, f"last_sync:{kind}", datetime.now().isoformat(timespec="seconds"))
    forget()
    return res
