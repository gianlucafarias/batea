"""Exportación a listas M3U8: una por caja. Sirve para Serato (arrastrar al panel de crates) y para cualquier programa.

No se escribe nada en las bases de Serato: Serato 4/5 borra las cajas que su base no conoce.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from . import config
from .export_common import Node, count_missing, display, leaf_ids, load_tracks, resolve, safe_name, unique


def _line(s: str) -> str:
    return " ".join(str(s).split())


def render(ids: list[int], tracks: dict) -> str:
    lines = ["#EXTM3U"]
    for i in ids:
        t = tracks.get(i)
        if t is None:
            continue
        secs = int(round(t["duration"])) if t["duration"] else -1
        lines.append(f"#EXTINF:{secs},{_line(display(t))}")
        lines.append(t["path"])
    return "\n".join(lines) + "\n"


def _write_node(node: Node, folder: Path, tracks: dict, taken: set[str], files: list[str]) -> None:
    if node.children is not None:
        sub = folder / unique(safe_name(node.name, "Carpeta"), taken)
        sub.mkdir(parents=True, exist_ok=True)
        inner: set[str] = set()
        for ch in node.children:
            _write_node(ch, sub, tracks, inner, files)
        return
    p = folder / (unique(safe_name(node.name), taken) + ".m3u8")
    folder.mkdir(parents=True, exist_ok=True)
    p.write_text(render(node.ids, tracks), encoding="utf-8")
    files.append(str(p))


def export(c: sqlite3.Connection, crate_ids: list, subdir: str = "m3u", out_dir: Path | None = None) -> dict:
    nodes = resolve(c, crate_ids)
    tracks = load_tracks(c, leaf_ids(nodes))
    base = out_dir or (config.EXPORT_DIR / subdir)
    files: list[str] = []
    if not tracks:
        return {"path": str(base), "files": files, "tracks": 0, "missing": 0, "playlists": 0}
    if len(nodes) == 1:
        # una caja = un archivo; una carpeta = su propia carpeta con subcarpetas
        _write_node(nodes[0], base, tracks, set(), files)
        path = files[0] if not nodes[0].is_folder else str(base / safe_name(nodes[0].name, "Carpeta"))
    else:
        top = base / f"Batea {datetime.now():%Y-%m-%d %H%M}"
        taken: set[str] = set()
        for n in nodes:
            _write_node(n, top, tracks, taken, files)
        path = str(top)
    return {"path": path, "files": files, "tracks": len(tracks), "missing": count_missing(tracks), "playlists": len(files)}
