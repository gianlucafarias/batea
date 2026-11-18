"""Piezas compartidas por los exportadores a archivo (M3U8, Traktor NML)."""
from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass, field

FOLDER_KINDS = ("folder", "session_folder")


@dataclass
class Node:
    """Una caja (hoja, con temas) o una carpeta (con hijas), ya resuelta contra la base."""
    name: str
    ids: list[int] = field(default_factory=list)
    children: list["Node"] | None = None     # None = playlist

    @property
    def is_folder(self) -> bool:
        return self.children is not None


def _folder_node(c: sqlite3.Connection, cid: int, name: str) -> Node:
    from .api_helpers import crate_track_ids

    kids: list[Node] = []
    rows = c.execute("SELECT id, name, kind FROM crates WHERE parent_id=? AND hidden=0 ORDER BY position, name", (cid,)).fetchall()
    for r in rows:
        if r["kind"] in FOLDER_KINDS:
            sub = _folder_node(c, r["id"], r["name"])
            if sub.children:
                kids.append(sub)
        else:
            _, ids = crate_track_ids(c, r["id"])
            if ids:
                kids.append(Node(r["name"], ids))
    return Node(name, children=kids)


def resolve(c: sqlite3.Connection, crate_ids: list) -> list[Node]:
    """Cajas pedidas → árbol. Una carpeta conserva su jerarquía; el resto son playlists planas."""
    from .api_helpers import crate_track_ids

    out: list[Node] = []
    for cid in crate_ids:
        s = str(cid)
        if s.lstrip("-").isdigit():
            row = c.execute("SELECT name, kind FROM crates WHERE id=?", (int(s),)).fetchone()
            if row and row["kind"] in FOLDER_KINDS:
                node = _folder_node(c, int(s), row["name"])
                if node.children:
                    out.append(node)
                continue
        name, ids = crate_track_ids(c, cid)
        if ids:
            out.append(Node(name, ids))
    return out


def leaf_ids(nodes: list[Node]) -> list[int]:
    seen: dict[int, None] = {}
    for n in nodes:
        for i in (leaf_ids(n.children) if n.children is not None else n.ids):
            seen[i] = None
    return list(seen)


def load_tracks(c: sqlite3.Connection, ids: list[int]) -> dict[int, sqlite3.Row]:
    """Temas con ruta (los que no la tienen no se pueden exportar a ningún formato)."""
    out: dict[int, sqlite3.Row] = {}
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        q = ",".join("?" * len(part))
        for r in c.execute(f"SELECT * FROM tracks WHERE id IN ({q}) AND path IS NOT NULL", part):
            out[r["id"]] = r
    return out


def count_missing(tracks: dict[int, sqlite3.Row]) -> int:
    return sum(1 for t in tracks.values() if not os.path.exists(t["path"]))


def safe_name(name: str, fallback: str = "Caja") -> str:
    s = re.sub(r'[\x00-\x1f/\\:*?"<>|]', " ", name or "")
    s = re.sub(r"\s+", " ", s).strip().lstrip(".").strip()
    return s[:100].strip() or fallback


def unique(name: str, taken: set[str]) -> str:
    base, n, cand = name, 2, name
    while cand.casefold() in taken:
        cand, n = f"{base} ({n})", n + 1
    taken.add(cand.casefold())
    return cand


def display(t: sqlite3.Row) -> str:
    title = t["title"] or os.path.splitext(os.path.basename(t["path"]))[0]
    return f"{t['artist']} - {title}" if t["artist"] else title
