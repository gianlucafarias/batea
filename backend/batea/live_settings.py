"""Ajuste general de "Saber qué suena": prendido/apagado y de qué programa leer.

Se guarda en meta `live` = {"enabled": bool, "app": "auto"|"rekordbox"|"serato"|"traktor"}.
Sin guardar nada todavía: prendido y "auto" (como venía funcionando con rekordbox).
El servidor de Broadcasting de Traktor solo corre si está prendido y el programa
elegido es Traktor o "auto".
"""
from __future__ import annotations

import json
import sqlite3

from . import config, db

META_KEY = "live"
APPS = ("auto", "rekordbox", "serato", "traktor")
DEFAULT = {"enabled": True, "app": "auto"}


def get(c: sqlite3.Connection) -> dict:
    try:
        saved = json.loads(db.get_meta(c, META_KEY) or "{}")
    except (TypeError, ValueError):
        saved = {}
    out = dict(DEFAULT)
    if isinstance(saved.get("enabled"), bool):
        out["enabled"] = saved["enabled"]
    if saved.get("app") in APPS:
        out["app"] = saved["app"]
    return out


def set(c: sqlite3.Connection, enabled: bool | None = None, app: str | None = None) -> dict:  # noqa: A001
    cur = get(c)
    if enabled is not None:
        cur["enabled"] = bool(enabled)
    if app is not None:
        if app not in APPS:
            raise ValueError("Programa desconocido")
        cur["app"] = app
    db.set_meta(c, META_KEY, json.dumps(cur))
    c.commit()
    apply(cur)
    return cur


def wants_traktor(s: dict) -> bool:
    return s["enabled"] and s["app"] in ("auto", "traktor")


def apply(s: dict | None = None) -> None:
    """Prende o apaga el servidor de Broadcasting de Traktor según el ajuste general."""
    try:
        from . import traktor_broadcast
    except ImportError:
        return
    if s is None:
        if not config.DB_PATH.is_file():
            return
        with db.conn() as c:
            s = get(c)
    traktor_broadcast.configure(wants_traktor(s))
