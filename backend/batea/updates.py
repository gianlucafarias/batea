"""Actualizaciones: Batea lee `update.json` del repositorio de GitHub y sabe si la versión instalada todavía sirve.

    {"version": "0.3.0",            la versión más nueva publicada
     "min_version": "0.3.0",        por debajo de esta, la app NO abre hasta que se actualice
     "notes": "…",                  qué trae
     "page": "https://github.com/…/releases/latest",
     "downloads": {"arm64": "…dmg", "x86_64": "…dmg"}}

Reglas (pensadas para un DJ que toca en lugares sin internet):
  · Solo se bloquea cuando SE SABE que la versión es menor que `min_version`: sea por lo que se leyó recién o por
    la última lectura guardada. Sin conexión y sin ninguna lectura previa, la app abre normal.
  · En desarrollo (corriendo desde el código fuente) nunca bloquea, salvo BATEA_UPDATE_FORCE=1 (para probar).
  · BATEA_UPDATE_URL cambia la dirección (para probar con un archivo file://); BATEA_NO_UPDATE_CHECK=1 lo apaga.
  · Los links de descarga solo se aceptan si apuntan a este repositorio: un update.json ajeno no puede mandar a otro sitio.
"""
from __future__ import annotations

import json
import os
import platform
import re
import time
import urllib.request

from . import db, runtime

REPO = "gianlucafarias/batea"
DEFAULT_URL = f"https://raw.githubusercontent.com/{REPO}/main/update.json"
ALLOWED_PREFIX = f"https://github.com/{REPO}/"
META_KEY = "update_info"
FRESH_FOR = 3600          # no se vuelve a preguntar por internet más seguido que cada hora (salvo que se fuerce)
TIMEOUT = 3               # segundos: que un GitHub lento no demore la apertura

_VER = re.compile(r"^\d+(\.\d+){0,3}$")
_last: dict | None = None  # última respuesta evaluada, en memoria (la usa el bloqueo sin tocar internet)


def parse(v: object) -> tuple[int, ...] | None:
    """'0.2.0' → (0, 2, 0). Lo que no es una versión numérica ('dev', '?') da None y nunca se bloquea."""
    if not isinstance(v, str) or not _VER.match(v.strip()):
        return None
    t = tuple(int(x) for x in v.strip().split("."))
    return t + (0,) * (4 - len(t))


def enforced() -> bool:
    if os.environ.get("BATEA_NO_UPDATE_CHECK") == "1":
        return False
    return runtime.frozen() or os.environ.get("BATEA_UPDATE_FORCE") == "1"


def _clean(raw: object) -> dict | None:
    """Se queda solo con lo que se espera, con el tipo esperado. Algo raro en el archivo → se ignora todo."""
    if not isinstance(raw, dict) or parse(raw.get("version")) is None:
        return None
    out: dict = {"version": raw["version"].strip()}
    out["min_version"] = raw["min_version"].strip() if parse(raw.get("min_version")) else None
    out["notes"] = str(raw.get("notes") or "")[:2000]
    page = raw.get("page")
    out["page"] = page if isinstance(page, str) and page.startswith(ALLOWED_PREFIX) else f"{ALLOWED_PREFIX}releases/latest"
    dl = raw.get("downloads") if isinstance(raw.get("downloads"), dict) else {}
    out["downloads"] = {a: u for a, u in dl.items() if a in ("arm64", "x86_64") and isinstance(u, str) and u.startswith(ALLOWED_PREFIX)}
    return out


def _fetch() -> dict | None:
    url = os.environ.get("BATEA_UPDATE_URL") or DEFAULT_URL
    req = urllib.request.Request(url, headers={"User-Agent": "Batea-updater", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return _clean(json.loads(r.read(64_000).decode("utf-8")))
    except Exception:
        return None            # sin conexión, GitHub caído, archivo mal formado: se usa lo último que se supo


def _load() -> dict | None:
    with db.conn() as c:
        raw = db.get_meta(c, META_KEY)
    try:
        d = json.loads(raw) if raw else None
    except ValueError:
        return None
    return d if isinstance(d, dict) and isinstance(d.get("data"), dict) else None


def _save(data: dict) -> None:
    with db.conn() as c:
        db.set_meta(c, META_KEY, json.dumps({"fetched_at": time.time(), "data": data}))


def evaluate(data: dict | None, current: str | None = None) -> dict:
    """Con lo que se sabe del repositorio (o nada), qué le corresponde a esta versión."""
    cur = current if current is not None else str(runtime.build_info().get("version"))
    c, latest, minimum = parse(cur), parse((data or {}).get("version")), parse((data or {}).get("min_version"))
    must = bool(enforced() and c and minimum and c < minimum)
    return {
        "current": cur,
        "latest": (data or {}).get("version"),
        "min_version": (data or {}).get("min_version"),
        "update_available": bool(c and latest and c < latest),
        "must_update": must,
        "notes": (data or {}).get("notes", ""),
        "page": (data or {}).get("page", f"{ALLOWED_PREFIX}releases/latest"),
        "download": ((data or {}).get("downloads") or {}).get(platform.machine()),
        "enforced": enforced(),
    }


def check(force: bool = False) -> dict:
    """Estado de actualización. Pregunta a GitHub si hace más de una hora que no lo hace (o si se fuerza)."""
    global _last
    if os.environ.get("BATEA_NO_UPDATE_CHECK") == "1":
        _last = evaluate(None)
        return {**_last, "checked_at": None, "online": None}
    cached = _load()
    stale = not cached or force or time.time() - float(cached.get("fetched_at", 0)) > FRESH_FOR
    data = cached["data"] if cached else None
    online: bool | None = None
    checked = cached.get("fetched_at") if cached else None
    if stale:
        fresh = _fetch()
        online = fresh is not None
        if fresh:
            data, checked = fresh, time.time()
            _save(fresh)
    _last = evaluate(data)
    return {**_last, "checked_at": checked, "online": online}


def blocked() -> bool:
    """¿Hay que frenar la app? Solo mira lo ya sabido (memoria o la última lectura guardada): nunca sale a internet."""
    global _last
    if not enforced():
        return False
    if _last is None:
        cached = _load()
        _last = evaluate(cached["data"] if cached else None)
    return bool(_last["must_update"])


def open_target() -> str:
    """Qué abrir en el navegador: el .dmg de esta arquitectura si está, o la página del release."""
    info = _last or evaluate(None)
    url = info.get("download") or info.get("page")
    return url if isinstance(url, str) and url.startswith(ALLOWED_PREFIX) else f"{ALLOWED_PREFIX}releases/latest"
