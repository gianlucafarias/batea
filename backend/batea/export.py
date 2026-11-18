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
        carries=["Playlists en orden", "Rating, comentario y color", "BPM y tono", "Etiquetas en el comentario (opcional)"],
        loses=["Cues y grillas de Batea"],
        how_to_load="Preferencias → Avanzado → Base de datos → rekordbox xml → elegí el archivo; aparece en la barra lateral",
    ),
    "traktor": dict(
        label="Traktor", format="NML",
        carries=["Playlists y carpetas, en orden", "Título, artista, género, comentario", "BPM, tono y rating"],
        loses=["Cues, loops y grillas", "Etiquetas de Batea", "Color y energía"],
        how_to_load="En el explorador, clic derecho en Playlists → Import Playlist y elegí el archivo. Con Traktor cerrado y vuelto a abrir, o guardá la colección después",
    ),
    "serato": dict(
        label="Serato", format="M3U8",
        carries=["Una lista por caja, en orden"],
        loses=["Cues y grillas", "Etiquetas, rating y comentarios", "Carpetas (quedan como carpetas en disco)"],
        how_to_load="Arrastrá el archivo .m3u8 al panel de crates de Serato",
    ),
    "m3u": dict(
        label="Lista M3U8", format="M3U8",
        carries=["Una lista por caja, en orden", "Artista, título y duración"],
        loses=["Cues, tonos, BPM y etiquetas"],
        how_to_load="Abrilo o arrastralo en cualquier programa que acepte listas M3U",
    ),
}


def targets(sources: list[dict]) -> list[dict]:
    by = {s["kind"]: s for s in sources}
    out = []
    for tid in TARGET_IDS:
        spec = dict(_TARGETS[tid])
        s = by.get(tid)
        ok = tid == "m3u" or bool(s and (s["enabled"] or s["found"]))
        out.append({"id": tid, **spec, "available": ok, "reason": None if ok else f"No usás {spec['label']}"})
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
