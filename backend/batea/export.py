"""Exportar a otros programas: reparte entre los exportadores por destino.

export_rekordbox (XML), export_traktor (.nml de playlist), export_m3u (.m3u8, también para Serato).
"""
from __future__ import annotations

import hashlib
import sqlite3

from . import export_m3u, export_rekordbox, export_traktor
from .export_rekordbox import _classical, _location, export  # noqa: F401  (compatibilidad con imports viejos)

TARGET_IDS = ("rekordbox", "traktor", "serato", "m3u")

_TARGETS = {
    "rekordbox": dict(
        label="rekordbox", format="XML",
        carries=["Las cajas, en orden", "Rating, comentario y color", "BPM y tono", "Tus etiquetas, en el comentario (si lo marcás)"],
        loses=["Cues y grillas"],
        how_to_load="En rekordbox: Preferencias → Avanzado → Base de datos → rekordbox xml, y elegí el archivo. Las cajas aparecen en la barra lateral.",
    ),
    "traktor": dict(
        label="Traktor", format="NML",
        carries=["Las cajas y carpetas, en orden", "Título, artista, género y comentario", "BPM, tono y rating"],
        loses=["Cues, loops y grillas", "Etiquetas, color y energía"],
        how_to_load="En Traktor: clic derecho en Playlists → Import Playlist, y elegí el archivo. Después guardá la colección.",
    ),
    "serato": dict(
        label="Serato", format="M3U8",
        carries=["Cada caja como una lista, en orden"],
        loses=["Cues y grillas", "Etiquetas, rating y comentarios", "Las carpetas de cajas (quedan como carpetas en el disco)"],
        how_to_load="Arrastrá el archivo .m3u8 a la columna de crates de Serato.",
    ),
    "m3u": dict(
        label="Otro programa (M3U)", format="M3U8",
        carries=["Cada caja como una lista, en orden", "Artista, título y duración"],
        loses=["BPM, tono, cues y etiquetas"],
        how_to_load="Arrastralo a cualquier programa que acepte listas M3U.",
    ),
}


def targets(sources: list[dict]) -> list[dict]:
    by = {s["kind"]: s for s in sources}
    out = []
    for tid in TARGET_IDS:
        spec = dict(_TARGETS[tid])
        s = by.get(tid)
        ok = tid == "m3u" or bool(s and (s["enabled"] or s["found"]))
        out.append({"id": tid, **spec, "available": ok, "reason": None if ok else f"No encontré {spec['label']} en esta Mac"})
    return out


def run(c: sqlite3.Connection, target: str, crate_ids: list, tags_in_comment: bool = False, with_cues: bool = False) -> dict:
    """Exporta y devuelve {ok, target, path, files, tracks, missing, warnings}."""
    warnings: list[str] = []
    if target == "rekordbox":
        res = export_rekordbox.export(c, crate_ids, tags_in_comment, with_cues=with_cues)
        out = {"path": res["path"], "files": [res["path"]] if res["tracks"] else [], "tracks": res["tracks"],
               "missing": 0, "playlists": res["playlists"], **{k: res[k] for k in ("cue_tracks", "grid_missing") if k in res}}
    elif target == "traktor":
        out = export_traktor.export(c, crate_ids)
    elif target == "serato":
        out = export_m3u.export(c, crate_ids, "serato")
    elif target == "m3u":
        out = export_m3u.export(c, crate_ids, "m3u")
    else:
        raise ValueError(f"Destino desconocido: {target}")
    if not out["tracks"]:
        warnings.append("Las cajas elegidas no tienen temas con archivo.")
    if out.get("missing"):
        n = out["missing"]
        warnings.append(f"{n} {'tema' if n == 1 else 'temas'} sin archivo en este momento (disco desconectado); igual quedan en la lista.")
    return {"ok": True, "target": target, **out, "warnings": warnings}


# ------------------------------------------------------------------ qué se exportó
def signature(c: sqlite3.Connection, cid: int) -> str | None:
    """Huella del contenido de una caja propia (nombre + temas en orden, o la búsqueda si es inteligente)."""
    row = c.execute("SELECT name, kind, query FROM crates WHERE id=?", (cid,)).fetchone()
    if not row:
        return None
    if row["kind"] == "smart":
        body = row["query"] or ""
    else:
        body = ",".join(str(r[0]) for r in c.execute(
            "SELECT track_id FROM crate_tracks WHERE crate_id=? ORDER BY position, track_id", (cid,)))
    return hashlib.sha1(f"{row['name']}|{row['kind']}|{body}".encode()).hexdigest()


def record(c: sqlite3.Connection, target: str, crate_ids: list) -> None:
    """Anota que estas cajas propias (y las de adentro, si es una carpeta) se exportaron tal como están ahora."""
    for raw in crate_ids:
        s = str(raw)
        if not s.isdigit():
            continue
        for r in c.execute(
            "WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM crates c JOIN sub ON c.parent_id=sub.id) "
            "SELECT c.id FROM crates c JOIN sub ON c.id=sub.id WHERE c.kind IN ('user','smart') AND c.rb_id IS NULL", (int(s),)).fetchall():
            sig = signature(c, r["id"])
            if sig:
                c.execute("INSERT INTO crate_exports(crate_id, target, signature) VALUES (?,?,?) "
                          "ON CONFLICT(crate_id, target) DO UPDATE SET signature=excluded.signature, exported_at=CURRENT_TIMESTAMP",
                          (r["id"], target, sig))


def states(c: sqlite3.Connection, target: str = "rekordbox") -> dict[int, str]:
    """Para cada caja propia: never (nunca se exportó) · stale (cambió desde la última exportación) · done."""
    done = {r["crate_id"]: r["signature"] for r in c.execute("SELECT crate_id, signature FROM crate_exports WHERE target=?", (target,))}
    out: dict[int, str] = {}
    for r in c.execute("SELECT id FROM crates WHERE kind IN ('user','smart') AND rb_id IS NULL"):
        sig = done.get(r["id"])
        out[r["id"]] = "never" if sig is None else ("done" if sig == signature(c, r["id"]) else "stale")
    return out


def selection(c: sqlite3.Connection, target: str) -> list[str]:
    """Cajas que ya estaban en el archivo de este destino y todavía existen."""
    out = []
    for r in c.execute("SELECT crate_id FROM export_selection WHERE target=? ORDER BY position", (target,)):
        cid = r["crate_id"]
        if cid.isdigit() and not c.execute("SELECT 1 FROM crates WHERE id=?", (int(cid),)).fetchone():
            continue          # la caja se borró
        out.append(cid)
    return out


def remember(c: sqlite3.Connection, target: str, crate_ids: list) -> None:
    ids = list(dict.fromkeys(str(i) for i in crate_ids))
    c.execute("DELETE FROM export_selection WHERE target=?", (target,))
    c.executemany("INSERT INTO export_selection(target, crate_id, position) VALUES (?,?,?)", [(target, i, n) for n, i in enumerate(ids)])
