"""Árbol de carpetas reales con música, para el menú de la izquierda.

Se arma con dónde están los archivos hoy: la ruta de cada tema si existe, y las copias que
encontró la búsqueda (rekordbox suele tener rutas viejas, p. ej. del Escritorio, aunque el
archivo ahora viva en el SSD). Las rutas que ya no existen no aparecen. Un disco desconectado
se muestra igual, apagado, con lo que se sabía de él.
"""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

from . import universe
from .api_helpers import _volume_mounted

HOME = str(Path.home())


def _root(d: str) -> tuple[str, str] | None:
    if d.startswith("/Volumes/"):
        parts = d.split("/")
        return "/".join(parts[:3]), parts[2]
    if d == HOME or d.startswith(HOME + "/"):
        return HOME, "Tu Mac"
    return None


def _natural(name: str) -> list:
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", name.lower())]


def _new(path: str, name: str) -> dict:
    return {"p": path, "n": name, "ids": set(), "direct": False, "kids": {}}


def _out(node: dict, is_root: bool = False) -> dict:
    name, cur = node["n"], node
    if not is_root:  # "Music › Music › Media.localized" en una sola fila
        while not cur["direct"] and len(cur["kids"]) == 1:
            cur = next(iter(cur["kids"].values()))
            name += " › " + cur["n"]
    res: dict = {"p": cur["p"], "n": name, "c": len(node["ids"])}
    kids = sorted(cur["kids"].values(), key=lambda k: _natural(k["n"]))
    if kids:
        res["k"] = [_out(k) for k in kids]
    return res


ACTIVE = object()


def tree(c: sqlite3.Connection, uni_clause: tuple[str, list] | None | object = ACTIVE) -> list[dict]:
    """`uni_clause`: condición de un universo (None = toda la librería); por defecto, el universo activo."""
    uni = universe.clause(c) if uni_clause is ACTIVE else uni_clause
    extra, params = (" AND " + uni[0], uni[1]) if uni else ("", [])
    items: list[tuple[str, int]] = []
    exists: dict[str, bool] = {}

    for tid, path in c.execute(f"SELECT t.id, t.path FROM tracks t WHERE t.hidden=0 AND t.path IS NOT NULL{extra}", params):
        d = os.path.dirname(path)
        r = _root(d)
        if not r:
            continue
        if r[0].startswith("/Volumes/") and not _volume_mounted(r[0]):
            items.append((d, tid))  # disco desconectado: no se puede comprobar
            continue
        ok = exists.get(d)
        if ok is None:
            ok = exists[d] = os.path.isdir(d)
        if ok:
            items.append((d, tid))
    try:
        for tid, path in c.execute(
            "SELECT t.id, f.path FROM found_files f JOIN tracks t ON t.id=f.ref_id "
            f"WHERE f.state IN ('copy','track') AND t.hidden=0{extra}", params):
            items.append((os.path.dirname(path), tid))
    except sqlite3.OperationalError:
        pass

    roots: dict[str, dict] = {}
    for d, tid in items:
        r = _root(d)
        if not r:
            continue
        root = roots.get(r[0])
        if root is None:
            root = roots[r[0]] = _new(r[0], r[1])
        root["ids"].add(tid)
        cur, acc = root, r[0]
        for part in d[len(r[0]):].strip("/").split("/"):
            if not part:
                continue
            acc += "/" + part
            nxt = cur["kids"].get(part)
            if nxt is None:
                nxt = cur["kids"][part] = _new(acc, part)
            nxt["ids"].add(tid)
            cur = nxt
        cur["direct"] = True

    order = sorted(roots.values(), key=lambda n: (n["p"] != HOME, _natural(n["n"])))
    out = []
    for n in order:
        o = _out(n, is_root=True)
        o["root"] = True
        if n["p"].startswith("/Volumes/") and not _volume_mounted(n["p"]):
            o["off"] = True
        out.append(o)
    return out
