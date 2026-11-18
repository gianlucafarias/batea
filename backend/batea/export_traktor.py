"""Exportación a Traktor: un .nml de playlists aparte, para "Import Playlist".

Nunca se toca collection.nml. No se exportan cues ni grillas de Batea: al importar,
Traktor podría pisar los que la persona ya tiene en su colección.
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from . import config, keys
from .export_common import Node, count_missing, leaf_ids, load_tracks, resolve, safe_name


@lru_cache(maxsize=1)
def boot_volume_name() -> str:
    """Nombre del disco de arranque: el que en /Volumes es un enlace a "/"."""
    try:
        for name in sorted(os.listdir("/Volumes")):
            p = os.path.join("/Volumes", name)
            if os.path.islink(p) and os.path.realpath(p) == "/":
                return name
    except OSError:
        pass
    try:
        out = subprocess.run(["diskutil", "info", "/"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            if line.strip().startswith("Volume Name:"):
                name = line.split(":", 1)[1].strip()
                if name:
                    return name
    except (OSError, subprocess.SubprocessError):
        pass
    return "Macintosh HD"


def _esc(s: str) -> str:
    return s.replace(":", "//")


def split_location(path: str, boot: str | None = None) -> tuple[str, str, str]:
    """Ruta POSIX → (VOLUME, DIR, FILE) en la notación de Traktor."""
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2 and parts[0] == "Volumes":
        volume, parts = parts[1], parts[2:]
    else:
        volume = boot or boot_volume_name()
    file = parts[-1] if parts else ""
    dirs = parts[:-1]
    d = "/:" + "".join(_esc(p) + "/:" for p in dirs)
    return volume, d, _esc(file)


def _key_table() -> dict[str, int]:
    from .sources.traktor import musical_key_to_camelot
    return {musical_key_to_camelot(v): v for v in range(24)}


def _entry(coll: ET.Element, t, volume: str, d: str, f: str) -> None:
    e = ET.SubElement(coll, "ENTRY", TITLE=t["title"] or Path(t["path"]).stem, ARTIST=t["artist"] or "")
    ET.SubElement(e, "LOCATION", DIR=d, FILE=f, VOLUME=volume, VOLUMEID=volume)
    if t["album"]:
        ET.SubElement(e, "ALBUM", TITLE=t["album"])
    rating = t["rating"] if t["rating"] is not None else (t["rb_rating"] or 0)
    info = {}
    if t["genre"]:
        info["GENRE"] = t["genre"]
    if t["label"]:
        info["LABEL"] = t["label"]
    if t["rb_comment"]:
        info["COMMENT"] = t["rb_comment"]
    if t["duration"]:
        info["PLAYTIME"] = str(int(t["duration"]))
    r = min(5, max(0, int(rating)))
    if r:
        info["RANKING"] = str(r * 51)
    if info:
        ET.SubElement(e, "INFO", **info)
    if t["bpm"]:
        ET.SubElement(e, "TEMPO", BPM=f"{t['bpm']:.6f}", BPM_QUALITY="100")
    value = _key_table().get(keys.to_camelot(t["key"]) or "")
    if value is not None:
        ET.SubElement(e, "MUSICAL_KEY", VALUE=str(value))


def _playlist(parent: ET.Element, node: Node, keys_of: dict[int, str]) -> None:
    n = ET.SubElement(parent, "NODE", TYPE="PLAYLIST", NAME=node.name)
    ids = [i for i in node.ids if i in keys_of]
    pl = ET.SubElement(n, "PLAYLIST", ENTRIES=str(len(ids)), TYPE="LIST", UUID=uuid.uuid4().hex)
    for i in ids:
        ET.SubElement(ET.SubElement(pl, "ENTRY"), "PRIMARYKEY", TYPE="TRACK", KEY=keys_of[i])


def _subnodes(parent: ET.Element, nodes: list[Node], keys_of: dict[int, str]) -> None:
    sub = ET.SubElement(parent, "SUBNODES", COUNT=str(len(nodes)))
    for n in nodes:
        if n.children is not None:
            f = ET.SubElement(sub, "NODE", TYPE="FOLDER", NAME=n.name)
            _subnodes(f, n.children, keys_of)
        else:
            _playlist(sub, n, keys_of)


def build(nodes: list[Node], tracks: dict) -> ET.Element:
    root = ET.Element("NML", VERSION="19")
    ET.SubElement(root, "HEAD", COMPANY="www.native-instruments.com", PROGRAM="Traktor")
    keys_of: dict[int, str] = {}
    coll = ET.SubElement(root, "COLLECTION", ENTRIES="0")
    seen: set[str] = set()
    boot = boot_volume_name()
    for tid, t in tracks.items():
        v, d, f = split_location(t["path"], boot)
        k = v + d + f
        keys_of[tid] = k
        if k not in seen:
            seen.add(k)
            _entry(coll, t, v, d, f)
    coll.set("ENTRIES", str(len(seen)))
    pls = ET.SubElement(root, "PLAYLISTS")
    top = ET.SubElement(pls, "NODE", TYPE="FOLDER", NAME="$ROOT")
    _subnodes(top, nodes, keys_of)
    return root


def export(c: sqlite3.Connection, crate_ids: list, out_dir: Path | None = None) -> dict:
    nodes = resolve(c, crate_ids)
    tracks = load_tracks(c, leaf_ids(nodes))
    base = out_dir or (config.EXPORT_DIR / "traktor")
    if not tracks:
        return {"path": str(base), "files": [], "tracks": 0, "missing": 0, "playlists": 0}
    name = safe_name(nodes[0].name) if len(nodes) == 1 else f"Batea {datetime.now():%Y-%m-%d %H%M}"
    out = base / f"{name}.nml"
    out.parent.mkdir(parents=True, exist_ok=True)
    root = build(nodes, tracks)
    ET.indent(root)
    ET.ElementTree(root).write(out, encoding="UTF-8", xml_declaration=True)

    def count(ns: list[Node]) -> int:
        return sum(count(n.children) if n.children is not None else 1 for n in ns)

    return {"path": str(out), "files": [str(out)], "tracks": len(tracks), "missing": count_missing(tracks), "playlists": count(nodes)}
