"""Exportación a rekordbox vía XML (el camino oficial y seguro).

En rekordbox: Preferencias → Avanzado → Base de datos → "rekordbox xml" →
elegir ~/Music/Batea/batea.xml. Aparece "rekordbox xml" en la barra lateral y
de ahí se arrastran las playlists a la colección.
"""
from __future__ import annotations

import sqlite3
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from . import config, keys

_CLASSICAL_MINOR = ["G#m", "D#m", "A#m", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m"]
_CLASSICAL_MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"]
_KIND = {"mp3": "MP3 File", "wav": "WAV File", "flac": "FLAC File", "aif": "AIFF File", "aiff": "AIFF File", "m4a": "M4A File"}


def _classical(cam: str | None) -> str:
    p = keys.parse(cam)
    if not p:
        return ""
    n, letter = p
    return (_CLASSICAL_MINOR if letter == "A" else _CLASSICAL_MAJOR)[n - 1]


def _location(path: str) -> str:
    return "file://localhost" + quote(path, safe="/")


def export(c: sqlite3.Connection, crate_ids: list[int], tags_in_comment: bool, out_path: Path | None = None,
           folder_name: str = "Batea") -> dict:
    out_path = out_path or (config.EXPORT_DIR / "batea.xml")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    from .api_helpers import crate_track_ids  # evita import circular

    playlists: list[tuple[str, list[int]]] = []
    for cid in crate_ids:
        name, ids = crate_track_ids(c, cid)
        playlists.append((name, ids))
    all_ids = sorted({i for _, ids in playlists for i in ids})
    if not all_ids:
        return {"path": str(out_path), "tracks": 0, "playlists": 0}

    q = ",".join("?" * len(all_ids))
    tracks = {r["id"]: r for r in c.execute(f"SELECT * FROM tracks WHERE id IN ({q}) AND path IS NOT NULL", all_ids)}
    tagnames: dict[int, list[str]] = {}
    if tags_in_comment:
        for r in c.execute(
            f"SELECT tt.track_id, t.name FROM track_tags tt JOIN tags t ON t.id=tt.tag_id "
            f"WHERE tt.track_id IN ({q}) AND t.source='user' ORDER BY t.position", all_ids,
        ):
            tagnames.setdefault(r["track_id"], []).append(r["name"])

    root = ET.Element("DJ_PLAYLISTS", Version="1.0.0")
    ET.SubElement(root, "PRODUCT", Name="Batea", Version="0.1", Company="Batea")
    coll = ET.SubElement(root, "COLLECTION", Entries=str(len(tracks)))
    for tid, t in tracks.items():
        rating = t["rating"] if t["rating"] is not None else (t["rb_rating"] or 0)
        comment = t["rb_comment"] or ""
        if tags_in_comment and tagnames.get(tid):
            hashtags = " ".join("#" + "-".join(n.lower().replace("/", " ").replace("(", "").replace(")", "").split()) for n in tagnames[tid])
            comment = (comment + " " + hashtags).strip() if hashtags not in comment else comment
        attrs = {
            "TrackID": str(tid),
            "Name": t["title"] or Path(t["path"]).stem,
            "Artist": t["artist"] or "",
            "Album": t["album"] or "",
            "Genre": t["genre"] or "",
            "Label": t["label"] or "",
            "Kind": _KIND.get((t["filetype"] or "").lower(), ""),
            "TotalTime": str(int(t["duration"] or 0)),
            "AverageBpm": f"{t['bpm']:.2f}" if t["bpm"] else "0.00",
            "Tonality": _classical(t["key"]),
            "Rating": str(min(5, max(0, int(rating))) * 51),
            "Comments": comment,
            "Location": _location(t["path"]),
        }
        if t["date_added"]:
            attrs["DateAdded"] = t["date_added"]
        ET.SubElement(coll, "TRACK", **attrs)

    pls = ET.SubElement(root, "PLAYLISTS")
    rootnode = ET.SubElement(pls, "NODE", Type="0", Name="ROOT", Count="1")
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    folder = ET.SubElement(rootnode, "NODE", Type="0", Name=f"{folder_name} · {stamp}", Count=str(len(playlists)))
    for name, ids in playlists:
        ids = [i for i in ids if i in tracks]
        node = ET.SubElement(folder, "NODE", Name=name, Type="1", KeyType="0", Entries=str(len(ids)))
        for i in ids:
            ET.SubElement(node, "TRACK", Key=str(i))

    ET.indent(root)
    ET.ElementTree(root).write(out_path, encoding="UTF-8", xml_declaration=True)
    return {"path": str(out_path), "tracks": len(tracks), "playlists": len(playlists)}
