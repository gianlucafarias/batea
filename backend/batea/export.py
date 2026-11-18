"""Exportar a otros programas: reparte entre los exportadores por destino.

export_rekordbox (XML), export_traktor (.nml de playlist), export_m3u (.m3u8, también para Serato).
"""
from __future__ import annotations

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


def run(c: sqlite3.Connection, target: str, crate_ids: list, tags_in_comment: bool = False) -> dict:
    """Exporta y devuelve {ok, target, path, files, tracks, missing, warnings}."""
    warnings: list[str] = []
    if target == "rekordbox":
        res = export_rekordbox.export(c, crate_ids, tags_in_comment)
        out = {"path": res["path"], "files": [res["path"]] if res["tracks"] else [], "tracks": res["tracks"],
               "missing": 0, "playlists": res["playlists"]}
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
