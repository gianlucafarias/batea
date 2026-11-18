"""API HTTP local de Batea (FastAPI)."""
from __future__ import annotations

import json
import mimetypes
import subprocess
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agents, analysis, anlz, config, db, discover, export, features, folders, jobs, keyfill, links, rbsync, recommend, runtime, universe, updates
from .sources import registry
from .sources.base import KINDS, LABELS
from .api_helpers import (
    VIRTUAL_CRATES, attach_sources, attach_tags, count_tracks, crate_track_ids, is_online, mark_online, query_tracks, real_path, reset_online_cache, TRACK_COLUMNS,
)

app = FastAPI(title="Batea")
db.init()
with db.conn() as _c:
    discover.init(_c)


@app.on_event("startup")
def _start_watch() -> None:
    discover.watch()


# ---------------------------------------------------------------- actualizaciones
_OPEN_ROUTES = ("/api/update", "/api/status")


@app.middleware("http")
async def _update_gate(request, call_next):
    """Una versión por debajo de la mínima publicada no trabaja: solo contesta lo que necesita la pantalla de actualizar."""
    p = request.url.path
    if p.startswith("/api/") and not p.startswith(_OPEN_ROUTES) and updates.blocked():
        return JSONResponse({"detail": "Hay que actualizar Batea para seguir usándola.", "update_required": True}, status_code=426)
    return await call_next(request)


@app.get("/api/update")
def update_status(force: bool = False) -> dict:
    return updates.check(force=force)


@app.post("/api/update/open")
def update_open() -> dict:
    """Abre en el navegador la descarga de la versión nueva (solo direcciones de este repositorio)."""
    url = updates.open_target()
    subprocess.run(["open", url], check=False)
    return {"opened": url}


# ---------------------------------------------------------------- estado
@app.get("/api/status")
def status() -> dict:
    with db.conn() as c:
        total = c.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
        local = c.execute("SELECT COUNT(*) FROM tracks WHERE source='local'").fetchone()[0]
        uid = universe.active_id(c)
        uni = c.execute("SELECT id, name FROM universes WHERE id=?", (uid,)).fetchone() if uid else None
        return {
            "version": runtime.build_info(),
            "tracks": count_tracks(c, "all") if uni else total,
            "library_tracks": total,
            "universe": dict(uni) if uni else None,
            "inbox": count_tracks(c, "inbox"),
            "local": local,
            "rekordbox_found": rbsync.rekordbox_available(),
            "rekordbox_dir": str(config.RB_DIR),
            "sources": registry.detect_all(c),
            "last_sync": db.get_meta(c, "last_sync"),
            "welcome_done": db.get_meta(c, "welcome_done") == "1",
            "autodiscover": discover.auto_enabled(c),
            "export_path": str(config.EXPORT_DIR / "batea.xml"),
            "jobs": jobs.list_jobs(),
        }


class SetupIn(BaseModel):
    sources: list[str] = []       # kinds elegidos: ["rekordbox", "traktor", …]
    rekordbox: bool = False       # formato viejo: equivale a sources=["rekordbox"]
    search: str = "none"          # none | all | folder
    path: str | None = None


@app.post("/api/setup")
def setup(body: SetupIn) -> dict:
    """Primera vez: hace SOLO lo que la persona eligió. Hasta que se llama acá no arranca ninguna importación ni búsqueda."""
    if body.search not in ("none", "all", "folder"):
        raise HTTPException(400, "Opción de búsqueda desconocida")
    wanted = [k for k in KINDS if k in body.sources or (k == "rekordbox" and body.rekordbox)]
    unknown = [k for k in body.sources if k not in KINDS]
    if unknown:
        raise HTTPException(400, f"No conozco esa fuente: {unknown[0]}")
    with db.conn() as c:
        found = {s["kind"]: s for s in registry.detect_all(c)}
    for k in wanted:
        if not found.get(k, {}).get("found"):
            raise HTTPException(404, "No encontré la base de rekordbox" if k == "rekordbox" else f"No encontré la librería de {LABELS[k]}")
    folder = None
    if body.search == "folder":
        folder = Path(body.path).expanduser() if body.path else None
        if folder is None or not folder.exists():
            raise HTTPException(400, "No encontré esa carpeta")
    out: dict = {}
    # la búsqueda automática (al abrir y al conectar un disco) queda activada solo si lo eligió; después espera la importación
    discover.set_auto(body.search == "all")
    with db.conn() as c:
        registry.set_enabled(c, wanted)
    out["jobs"] = [j.__dict__ for j in _start_syncs(wanted)]
    rb = next((j for j in out["jobs"] if j["kind"] == "sync"), None)
    if rb:
        out["sync"] = rb
    if folder is not None:
        out["discover"] = discover.start([str(folder)]).__dict__
    return out


def _start_syncs(kinds: list[str]) -> list:
    """Sincroniza las fuentes en orden (rekordbox primero), una a la vez."""
    if not kinds:
        return []
    reset_online_cache()
    return jobs.start_chain([(registry.job_kind(k), registry.job_label(k), lambda j, k=k: registry.sync(k, j)) for k in kinds])


# ---------------------------------------------------------------- fuentes (rekordbox, Traktor, Serato…)
def _check_kind(kind: str) -> None:
    if kind not in KINDS:
        raise HTTPException(404, "No conozco esa fuente")


@app.get("/api/sources")
def list_sources() -> dict:
    return {"sources": registry.detect_all()}


@app.post("/api/sources/sync-all")
def sync_all_sources() -> dict:
    with db.conn() as c:
        kinds = [s["kind"] for s in registry.detect_all(c) if s["found"] and s["enabled"]]
    return {"jobs": [j.__dict__ for j in _start_syncs(kinds)]}


@app.post("/api/sources/{kind}/sync")
def sync_source(kind: str) -> dict:
    _check_kind(kind)
    with db.conn() as c:
        src = registry.detect_one(c, kind)
        if not src["found"]:
            raise HTTPException(404, "No encontré la base de rekordbox" if kind == "rekordbox" else f"No encontré la librería de {LABELS[kind]}")
        if not src["enabled"]:       # pedir una sincronización es activar la fuente
            registry.set_enabled(c, [*registry.enabled_kinds(c), kind])
    return _start_syncs([kind])[0].__dict__


class EnabledIn(BaseModel):
    enabled: bool


@app.post("/api/sources/{kind}/enabled")
def set_source_enabled(kind: str, body: EnabledIn) -> dict:
    """Activar/desactivar: solo decide si entra en "sincronizar todo". No borra ni oculta nada."""
    _check_kind(kind)
    with db.conn() as c:
        cur = [k for k in registry.enabled_kinds(c) if k != kind]
        registry.set_enabled(c, cur + [kind] if body.enabled else cur)
    return {"ok": True, "kind": kind, "enabled": body.enabled}


class LocationIn(BaseModel):
    path: str = ""


@app.post("/api/sources/{kind}/location")
def set_source_location(kind: str, body: LocationIn) -> dict:
    """Ruta manual de la librería (collection.nml o la carpeta que la contiene). Vacía = volver a buscarla sola."""
    _check_kind(kind)
    if kind not in registry.ADAPTERS or kind == "rekordbox":
        raise HTTPException(400, "Esa fuente no admite cambiar la ruta todavía")
    path = body.path.strip()
    if path and not Path(path).expanduser().exists():
        raise HTTPException(400, "No encontré esa ruta")
    with db.conn() as c:
        db.set_meta(c, f"source_path:{kind}", str(Path(path).expanduser()) if path else "")
        registry.forget()
        return registry.detect_one(c, kind)


@app.get("/api/tracks/{tid}/sources")
def track_sources(tid: int) -> dict:
    """Qué dice cada programa de este tema (BPM, tono, rating…), para comparar."""
    with db.conn() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM track_sources WHERE track_id=?", (tid,))]
        rb = c.execute("SELECT 1 FROM tracks WHERE id=? AND rb_id IS NOT NULL", (tid,)).fetchone()
    order = {k: i for i, k in enumerate(KINDS)}
    out = []
    for r in sorted(rows, key=lambda r: order.get(r["source"], len(order))):
        cues = json.loads(r["cues_json"]) if r["cues_json"] else None
        out.append({
            "source": r["source"], "label": LABELS.get(r["source"], r["source"]), "bpm": r["bpm"],
            "key_camelot": r["key_camelot"], "key_raw": r["key_raw"], "rating": r["rating"],
            "play_count": r["play_count"], "cues_count": len(cues) if cues is not None else None,
            "date_added": r["date_added"], "last_played": r["last_played"], "synced_at": r["synced_at"],
        })
    if rb and not any(o["source"] == "rekordbox" for o in out):   # sincronizado antes de track_sources
        out.insert(0, {"source": "rekordbox", "label": LABELS["rekordbox"], "bpm": None, "key_camelot": None, "key_raw": None,
                       "rating": None, "play_count": None, "cues_count": None, "date_added": None, "last_played": None,
                       "synced_at": None})
    return {"sources": out}


class AutoIn(BaseModel):
    enabled: bool


@app.post("/api/autodiscover")
def set_autodiscover(body: AutoIn) -> dict:
    discover.set_auto(body.enabled)
    return {"autodiscover": body.enabled}


@app.post("/api/welcome/done")
def welcome_done() -> dict:
    """La presentación de la primera vez ya se vio (o se salteó): no volver a mostrarla sola."""
    with db.conn() as c:
        db.set_meta(c, "welcome_done", "1")
    return {"ok": True}


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    return jobs.list_jobs()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    return {"ok": jobs.cancel(job_id)}


@app.post("/api/sync/rekordbox")
def sync_rekordbox() -> dict:
    if not rbsync.rekordbox_available():
        raise HTTPException(404, "No encontré la base de rekordbox")
    reset_online_cache()
    return _start_syncs(["rekordbox"])[0].__dict__


class AnalyzeFolder(BaseModel):
    path: str
    reanalyze: bool = False


@app.post("/api/analyze/folder")
def analyze_folder(body: AnalyzeFolder) -> dict:
    p = Path(body.path).expanduser()
    if not p.is_dir():
        raise HTTPException(400, "La carpeta no existe")
    reset_online_cache()
    if body.reanalyze:
        return jobs.start("analyze", f"Analizando {p.name}", lambda j: analysis.run_folder(j, str(p), True)).__dict__
    return discover.start([str(p)]).__dict__


# ---------------------------------------------------------------- música fuera de rekordbox
class Paths(BaseModel):
    paths: list[str] = []


class Folder(BaseModel):
    folder: str


@app.post("/api/discover")
def discover_run(body: Paths | None = None) -> dict:
    paths = [p for p in (body.paths if body else []) if Path(p).expanduser().exists()]
    if body and body.paths and not paths:
        raise HTTPException(400, "No encontré esos archivos")
    return discover.start(paths or None).__dict__


@app.get("/api/discover")
def discover_state() -> dict:
    with db.conn() as c:
        return discover.folders(c)


@app.post("/api/discover/ignore")
def discover_ignore(body: Folder) -> dict:
    with db.conn() as c:
        return discover.ignore(c, body.folder)


@app.post("/api/discover/analyze")
def discover_analyze(body: Folder) -> dict:
    reset_online_cache()
    return discover.analyze_folder(body.folder).__dict__


@app.post("/api/discover/reveal")
def discover_reveal(body: Folder) -> dict:
    p = Path(body.folder)
    if not p.is_dir():
        raise HTTPException(404, "La carpeta no está disponible")
    subprocess.run(["open", str(p)], check=False)
    return {"ok": True}


@app.post("/api/discover/unignore")
def discover_unignore(body: Folder) -> dict:
    with db.conn() as c:
        discover.unignore(c, body.folder)
    return discover.start().__dict__


# ---------------------------------------------------------------- carpetas reales
@app.get("/api/folders")
def folder_tree() -> list[dict]:
    reset_online_cache()
    with db.conn() as c:
        return folders.tree(c)


# ---------------------------------------------------------------- cajas
@app.get("/api/crates")
def crates() -> dict:
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            """SELECT c.id, c.name, c.kind, c.parent_id, c.hidden, c.date, c.query, c.position, COALESCE(c.source, 'user') AS source,
                      (SELECT COUNT(*) FROM crate_tracks ct WHERE ct.crate_id=c.id) AS count
               FROM crates c ORDER BY c.position, c.name"""
        )]
        uni = universe.clause(c)
        if uni:
            counts = {r[0]: r[1] for r in c.execute(
                f"SELECT ct.crate_id, COUNT(*) FROM crate_tracks ct JOIN tracks t ON t.id=ct.track_id WHERE {uni[0]} GROUP BY ct.crate_id",
                uni[1])}
            for r in rows:
                r["count"] = counts.get(r["id"], 0)
        virtual = [{"id": key, "name": name, "kind": "virtual", "count": count_tracks(c, key)}
                   for key, name in VIRTUAL_CRATES.items()]
        for r in rows:
            if r["kind"] == "smart":
                r["count"] = count_tracks(c, str(r["id"]))
                r["query"] = json.loads(r["query"] or "{}")
            else:
                r.pop("query", None)
        return {"virtual": virtual, "crates": rows}


@app.get("/api/crates/previews")
def crate_previews() -> dict:
    """Primeros discos de cada caja, para dibujar los que asoman en la estantería."""
    out: dict[str, list] = {}
    with db.conn() as c:
        uni = universe.clause(c)
        rows = c.execute(
            """SELECT crate_id, id, title, artist, key, bpm, has_art FROM (
                 SELECT ct.crate_id, t.id, t.title, t.artist, t.key, t.bpm, (t.artwork IS NOT NULL) AS has_art,
                        ROW_NUMBER() OVER (PARTITION BY ct.crate_id ORDER BY (t.artwork IS NULL), ct.position) AS rn
                 FROM crate_tracks ct JOIN tracks t ON t.id = ct.track_id
                 JOIN crates cr ON cr.id = ct.crate_id WHERE cr.kind IN ('playlist','user','session') AND t.hidden=0 {uni_sql}
               ) WHERE rn <= 5""".format(uni_sql=("AND " + uni[0]) if uni else ""),
            uni[1] if uni else [],
        ).fetchall()
        for r in rows:
            out.setdefault(str(r["crate_id"]), []).append([r["id"], r["title"], r["artist"], r["key"], r["bpm"], r["has_art"]])
        smart = [str(r["id"]) for r in c.execute("SELECT id FROM crates WHERE kind IN ('smart','folder')")]
        for key in list(VIRTUAL_CRATES) + smart:
            tr = query_tracks(c, key, {}, limit=40)
            tr.sort(key=lambda t: -t["has_art"])
            out[key] = [[t["id"], t["title"], t["artist"], t["key"], t["bpm"], t["has_art"]] for t in tr[:5]]
    return out


class CrateIn(BaseModel):
    name: str
    parent_id: int | None = None
    query: dict | None = None
    track_ids: list[int] | None = None


@app.post("/api/crates")
def create_crate(body: CrateIn) -> dict:
    with db.conn() as c:
        kind = "smart" if body.query is not None else "user"
        cur = c.execute(
            "INSERT INTO crates(name, kind, parent_id, query, position, source) VALUES (?,?,?,?, (SELECT COALESCE(MAX(position),0)+1 FROM crates), 'user')",
            (body.name, kind, body.parent_id, json.dumps(body.query) if body.query is not None else None),
        )
        cid = cur.lastrowid
        if kind == "user":
            universe.add_crate_to_active(c, cid)
        if body.track_ids:
            c.executemany("INSERT OR IGNORE INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)",
                          [(cid, t, i) for i, t in enumerate(body.track_ids)])
        return {"id": cid}


class CratePatch(BaseModel):
    name: str | None = None
    hidden: bool | None = None
    query: dict | None = None


@app.patch("/api/crates/{cid}")
def patch_crate(cid: int, body: CratePatch) -> dict:
    with db.conn() as c:
        if body.name is not None:
            c.execute("UPDATE crates SET name=? WHERE id=? AND rb_id IS NULL", (body.name, cid))
        if body.hidden is not None:
            ids = [r[0] for r in c.execute(
                "WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT c.id FROM crates c JOIN sub ON c.parent_id=sub.id) SELECT id FROM sub",
                (cid,))]
            c.executemany("UPDATE crates SET hidden=? WHERE id=?", [(int(body.hidden), i) for i in ids])
        if body.query is not None:
            c.execute("UPDATE crates SET query=? WHERE id=? AND kind='smart'", (json.dumps(body.query), cid))
    return {"ok": True}


@app.delete("/api/crates/{cid}")
def delete_crate(cid: int) -> dict:
    with db.conn() as c:
        c.execute("DELETE FROM crates WHERE id=? AND rb_id IS NULL", (cid,))
    return {"ok": True}


class TrackIds(BaseModel):
    track_ids: list[int]


@app.post("/api/analyze/tracks")
def analyze_tracks(body: TrackIds) -> dict:
    """Analiza los temas elegidos (solo los que están fuera de rekordbox: los de rekordbox los analiza rekordbox)."""
    reset_online_cache()
    with db.conn() as c:
        q = ",".join("?" * len(body.track_ids)) or "NULL"
        rows = c.execute(f"SELECT path FROM tracks WHERE id IN ({q}) AND source='local' AND path IS NOT NULL", body.track_ids).fetchall()
    todo = [r[0] for r in rows if is_online(r[0])]
    if not todo:
        raise HTTPException(400, "No hay temas para analizar (o el disco está desconectado)")
    label = f"Analizando {Path(todo[0]).stem}" if len(todo) == 1 else f"Analizando {len(todo)} temas"
    return analysis.enqueue(todo, label).__dict__


@app.get("/api/analyze/queue")
def analyze_queue() -> dict:
    now, paths = analysis.queued()
    if not now and not paths:
        return {"now": None, "ids": []}
    with db.conn() as c:
        ids = {r[1]: r[0] for r in c.execute(
            f"SELECT id, path FROM tracks WHERE path IN ({','.join('?' * (len(paths) + 1))}) AND source='local'", [now, *paths])}
    return {"now": ids.get(now), "ids": [ids[p] for p in paths if p in ids]}


@app.post("/api/crates/{cid}/tracks")
def add_to_crate(cid: int, body: TrackIds) -> dict:
    with db.conn() as c:
        kind = c.execute("SELECT kind FROM crates WHERE id=?", (cid,)).fetchone()
        if not kind or kind["kind"] != "user":
            raise HTTPException(400, "Solo se pueden editar tus cajas (las de rekordbox se editan en rekordbox)")
        start = c.execute("SELECT COALESCE(MAX(position), 0) FROM crate_tracks WHERE crate_id=?", (cid,)).fetchone()[0]
        c.executemany("INSERT OR IGNORE INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)",
                      [(cid, t, start + i + 1) for i, t in enumerate(body.track_ids)])
    return {"ok": True}


@app.delete("/api/crates/{cid}/tracks/{tid}")
def remove_from_crate(cid: int, tid: int) -> dict:
    with db.conn() as c:
        c.execute("DELETE FROM crate_tracks WHERE crate_id=? AND track_id=? AND crate_id IN (SELECT id FROM crates WHERE kind='user')", (cid, tid))
    return {"ok": True}


# ---------------------------------------------------------------- temas
def _filters(q, tags, not_tags, bpm_min, bpm_max, energy_min, energy_max, keys_, key_compat, rating_min, source, added_after, in_source=None):
    split = lambda s: [x for x in (s or "").split(",") if x]  # noqa: E731
    return {
        "q": q, "tags": split(tags), "not_tags": split(not_tags), "bpm_min": bpm_min, "bpm_max": bpm_max,
        "energy_min": energy_min, "energy_max": energy_max, "keys": split(keys_), "key_compat": key_compat,
        "rating_min": rating_min, "source": source, "added_after": added_after,
        "in_source": in_source,
    }


@app.get("/api/tracks")
def tracks(
    crate: str | None = None, q: str | None = None, tags: str | None = None, not_tags: str | None = None,
    bpm_min: float | None = None, bpm_max: float | None = None, energy_min: int | None = None,
    energy_max: int | None = None, keys: str | None = Query(None), key_compat: str | None = None,
    rating_min: int | None = None, source: str | None = None, added_after: str | None = None,
    in_source: str | None = None, limit: int | None = None,
) -> list[dict]:
    f = _filters(q, tags, not_tags, bpm_min, bpm_max, energy_min, energy_max, keys, key_compat, rating_min, source, added_after, in_source)
    with db.conn() as c:
        return query_tracks(c, crate, f, limit)


def _track_detail(c, tid: int) -> dict:
    r = c.execute(f"SELECT {TRACK_COLUMNS}, t.notes, t.rb_comment, t.key_raw, t.analyzed, t.rb_id FROM tracks t WHERE t.id=?", (tid,)).fetchone()
    if not r:
        raise HTTPException(404, "No existe")
    d = dict(r)
    attach_tags(c, [d])
    attach_sources(c, [d])
    d["online"] = real_path(c, tid) is not None
    d["tag_sources"] = {row["tag_id"]: row["source"] for row in c.execute("SELECT tag_id, source FROM track_tags WHERE track_id=?", (tid,))}
    d["crates"] = [dict(x) for x in c.execute(
        "SELECT c.id, c.name, c.kind FROM crate_tracks ct JOIN crates c ON c.id=ct.crate_id WHERE ct.track_id=? AND c.kind IN ('playlist','user') ORDER BY c.name", (tid,))]
    d["sessions"] = [dict(x) for x in c.execute(
        "SELECT c.id, c.name, c.date FROM crate_tracks ct JOIN crates c ON c.id=ct.crate_id WHERE ct.track_id=? AND c.kind='session' ORDER BY c.date DESC LIMIT 12", (tid,))]
    d["relations"] = relations_of(c, tid)
    return d


def relations_of(c, tid: int) -> list[dict]:
    rows = c.execute(
        """SELECT r.id, r.a, r.b, r.kind, r.source, r.count, r.note, t.id AS other_id, t.title, t.artist, t.bpm, t.key,
                  COALESCE(t.energy, t.energy_auto) AS energy, (t.artwork IS NOT NULL) AS has_art
           FROM relations r JOIN tracks t ON t.id = CASE WHEN r.a=? THEN r.b ELSE r.a END
           WHERE (r.a=? OR r.b=?) ORDER BY (r.source='user') DESC, r.count DESC LIMIT 80""",
        (tid, tid, tid),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["direction"] = "out" if r["a"] == tid else "in"
        out.append(d)
    return out


@app.get("/api/tracks/{tid}")
def track(tid: int) -> dict:
    with db.conn() as c:
        return _track_detail(c, tid)


class TrackPatch(BaseModel):
    rating: int | None = None
    energy: int | None = None
    notes: str | None = None
    hidden: bool | None = None
    clear_energy: bool = False
    clear_rating: bool = False
    reviewed: bool | None = None
    meta: dict[str, Any] | None = None   # título, artista… (solo temas fuera de rekordbox)


META_FIELDS = ("title", "artist", "remixer", "album", "label", "genre", "year")


class TrackBatch(BaseModel):
    track_ids: list[int]
    rating: int | None = None
    energy: int | None = None
    clear_energy: bool = False
    reviewed: bool | None = None
    hidden: bool | None = None


@app.post("/api/tracks/batch")
def batch_tracks(body: TrackBatch) -> dict:
    """Aplica el mismo puntaje / energía / estado a varios temas a la vez."""
    ids = [(i,) for i in body.track_ids]
    with db.conn() as c:
        if body.rating is not None:
            c.executemany(f"UPDATE tracks SET rating={max(0, min(5, body.rating))} WHERE id=?", ids)
        if body.energy is not None:
            c.executemany(f"UPDATE tracks SET energy={max(1, min(10, body.energy))} WHERE id=?", ids)
        if body.clear_energy:
            c.executemany("UPDATE tracks SET energy=NULL WHERE id=?", ids)
        if body.reviewed is not None:
            c.executemany("UPDATE tracks SET reviewed=" + ("datetime('now')" if body.reviewed else "NULL") + " WHERE id=?", ids)
        if body.hidden is not None:
            c.executemany(f"UPDATE tracks SET hidden={int(body.hidden)} WHERE id=?", ids)
    return {"ok": True, "count": len(ids)}


@app.patch("/api/tracks/{tid}")
def patch_track(tid: int, body: TrackPatch) -> dict:
    with db.conn() as c:
        if body.rating is not None:
            c.execute("UPDATE tracks SET rating=? WHERE id=?", (max(0, min(5, body.rating)), tid))
        if body.clear_rating:
            c.execute("UPDATE tracks SET rating=NULL WHERE id=?", (tid,))
        if body.energy is not None:
            c.execute("UPDATE tracks SET energy=? WHERE id=?", (max(1, min(10, body.energy)), tid))
        if body.clear_energy:
            c.execute("UPDATE tracks SET energy=NULL WHERE id=?", (tid,))
        if body.notes is not None:
            c.execute("UPDATE tracks SET notes=? WHERE id=?", (body.notes, tid))
        if body.hidden is not None:
            c.execute("UPDATE tracks SET hidden=? WHERE id=?", (int(body.hidden), tid))
        if body.reviewed is not None:
            c.execute("UPDATE tracks SET reviewed=" + ("datetime('now')" if body.reviewed else "NULL") + " WHERE id=?", (tid,))
        if body.meta:
            src = c.execute("SELECT source FROM tracks WHERE id=?", (tid,)).fetchone()
            if not src or src[0] != "local":
                raise HTTPException(400, "Los datos de los temas de un programa se editan en ese programa")
            vals: dict[str, Any] = {}
            for k in META_FIELDS:
                if k in body.meta:
                    v = body.meta[k]
                    v = str(v).strip() if v is not None else ""
                    if k == "year":
                        vals[k] = int(v) if v.isdigit() else None
                    else:
                        vals[k] = v or None
            if "title" in vals and not vals["title"]:
                raise HTTPException(400, "El título no puede quedar vacío")
            if vals:
                c.execute(f"UPDATE tracks SET {', '.join(f'{k}=?' for k in vals)}, meta_user=1 WHERE id=?", [*vals.values(), tid])
        return _track_detail(c, tid)


_wave_cache: OrderedDict[tuple[int, int, float], dict] = OrderedDict()


@app.get("/api/tracks/{tid}/waveform")
def waveform(tid: int, cols: int = 720) -> dict:
    cols = max(200, min(4000, cols))
    cache = analysis.waveform_cache(tid)
    # la fecha del archivo entra en la clave: si el tema se vuelve a analizar, no se sirve la vieja
    ck = (tid, cols, cache.stat().st_mtime if cache.exists() else 0)
    if ck in _wave_cache:
        _wave_cache.move_to_end(ck)
        return _wave_cache[ck]
    data = None
    if cache.exists():
        data = json.loads(cache.read_text())
    else:
        with db.conn() as c:
            r = c.execute("SELECT anlz_dir, bpm FROM tracks WHERE id=?", (tid,)).fetchone()
        if r and r["anlz_dir"]:
            curves = anlz.read_curves(Path(r["anlz_dir"]))
            if curves is not None:
                data = features.waveform(curves, cols)
                if curves.downbeats is not None:
                    data["downbeats"] = [round(float(x), 3) for x in curves.downbeats]
    if data is None:
        raise HTTPException(404, "Sin waveform")
    _wave_cache[ck] = data
    if len(_wave_cache) > 300:
        _wave_cache.popitem(last=False)
    return data


@app.get("/api/tracks/{tid}/grid")
def grid(tid: int) -> dict:
    """Compases (tiempos de cada "1") para sincronizar dos temas al probar una mezcla."""
    with db.conn() as c:
        r = c.execute("SELECT anlz_dir, bpm, duration, intro_bars, outro_bars FROM tracks WHERE id=?", (tid,)).fetchone()
    if not r:
        raise HTTPException(404, "No existe")
    downbeats: list[float] = []
    approx = False
    if r["anlz_dir"]:
        dat = anlz._read(Path(r["anlz_dir"]) / "ANLZ0000.DAT")
        bg = anlz.read_beatgrid(dat) if dat else None
        if bg and len(bg[1]) >= 4:
            downbeats = [round(float(x), 4) for x in bg[1]]
    if not downbeats:
        cache = analysis.waveform_cache(tid)
        if cache.exists():
            downbeats = json.loads(cache.read_text()).get("downbeats") or []
        approx = True                      # grilla propia: suele acertar, pero puede necesitar ajuste
    if not downbeats and r["bpm"] and r["duration"]:
        bar = 240.0 / r["bpm"]
        downbeats = [round(i * bar, 4) for i in range(int(r["duration"] / bar))]
    return {"bpm": r["bpm"], "duration": r["duration"], "downbeats": downbeats, "approx": approx,
            "intro_bars": r["intro_bars"], "outro_bars": r["outro_bars"]}


def _real_path(tid: int) -> str | None:
    with db.conn() as c:
        return real_path(c, tid)


def _path_of(tid: int, col: str = "path") -> str | None:
    with db.conn() as c:
        r = c.execute(f"SELECT {col} FROM tracks WHERE id=?", (tid,)).fetchone()
    return r[0] if r else None


AUDIO_MIME = {
    ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff",
    ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".mpeg": "audio/mpeg",
}


@app.get("/api/tracks/{tid}/audio")
def audio(tid: int):
    p = _real_path(tid)
    if not p:
        raise HTTPException(404, "El archivo no está disponible (¿disco desconectado?)")
    # WebKit solo reconoce los nombres estándar (rechaza audio/x-flac, que es lo que da Python)
    ext = Path(p).suffix.lower()
    mt = AUDIO_MIME.get(ext) or mimetypes.guess_type(p)[0] or "audio/mpeg"
    return FileResponse(p, media_type=mt)


@app.get("/api/tracks/{tid}/artwork")
def artwork(tid: int, size: str = "m"):
    a = _path_of(tid, "artwork")
    if not a:
        raise HTTPException(404)
    if a.startswith("/PIONEER"):
        base = config.RB_SHARE / a.lstrip("/")
        suffix = {"s": "_s", "m": "_m", "l": ""}.get(size, "_m")
        p = base.with_name(base.stem + suffix + base.suffix)
        if not p.exists():
            p = base
    else:
        p = Path(a)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=604800"})


@app.post("/api/tracks/{tid}/reveal")
def reveal(tid: int) -> dict:
    p = _real_path(tid)
    if p:
        subprocess.run(["open", "-R", p], check=False)
        return {"ok": True}
    raise HTTPException(404, "Archivo no disponible")


@app.get("/api/tracks/{tid}/recommendations")
def recs(tid: int, crate: str | None = None, limit: int = 30) -> dict:
    with db.conn() as c:
        scope = None
        if crate:
            _, ids = crate_track_ids(c, crate)
            scope = set(ids)
        res = recommend.recommend(c, tid, limit, scope)
        ids = [i["id"] for i in res["items"]]
        if ids:
            q = ",".join("?" * len(ids))
            rows = {r["id"]: dict(r) for r in c.execute(f"SELECT {TRACK_COLUMNS} FROM tracks t WHERE t.id IN ({q})", ids)}
            attach_tags(c, list(rows.values()))
            attach_sources(c, list(rows.values()))
            mark_online(c, list(rows.values()))
            for item in res["items"]:
                item["track"] = rows[item["id"]]
        return res


@app.get("/api/nowplaying")
def now_playing(limit: int = 8) -> dict:
    """Lo que suena en el programa de DJ abierto (rekordbox, Serato o Traktor) y qué poner después (ícono de la barra de arriba)."""
    from . import nowplaying

    with db.conn() as c:
        return nowplaying.state(c, limit)


@app.get("/api/style")
def style() -> dict:
    with db.conn() as c:
        return recommend.style_profile(c)


# ---------------------------------------------------------------- etiquetas
@app.get("/api/tags")
def tags() -> list[dict]:
    with db.conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT g.*, (SELECT COUNT(*) FROM track_tags x WHERE x.tag_id=g.id) AS count FROM tags g "
            "ORDER BY g.source DESC, g.position, g.name")]


class TagIn(BaseModel):
    name: str
    category: str
    color: str | None = None


@app.post("/api/tags")
def create_tag(body: TagIn) -> dict:
    with db.conn() as c:
        c.execute("INSERT OR IGNORE INTO tags(name, category, color, source, position, hotkey) VALUES (?,?,?, 'user', (SELECT COALESCE(MAX(position),0)+1 FROM tags), ?)",
                  (body.name.strip(), body.category.strip().lower(), body.color, db.free_hotkey(c, body.name)))
        r = c.execute("SELECT * FROM tags WHERE name=? AND category=?", (body.name.strip(), body.category.strip().lower())).fetchone()
        return dict(r)


class TagPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    category: str | None = None
    hotkey: str | None = None      # una letra; "" la quita


@app.patch("/api/tags/{tag_id}")
def patch_tag(tag_id: int, body: TagPatch) -> dict:
    with db.conn() as c:
        if body.hotkey is not None:
            key = body.hotkey.strip().lower()[:1]
            if key and not ("a" <= key <= "z"):
                raise HTTPException(400, "El atajo tiene que ser una letra")
            if key:
                c.execute("UPDATE tags SET hotkey=NULL WHERE hotkey=?", (key,))
            c.execute("UPDATE tags SET hotkey=? WHERE id=?", (key or None, tag_id))
        for col in ("name", "color", "category"):
            v = getattr(body, col)
            if v is not None:
                c.execute(f"UPDATE tags SET {col}=? WHERE id=? AND source='user'", (v, tag_id))
    return {"ok": True}


@app.delete("/api/tags/{tag_id}")
def delete_tag(tag_id: int) -> dict:
    with db.conn() as c:
        c.execute("DELETE FROM tags WHERE id=? AND source='user'", (tag_id,))
    return {"ok": True}


class TagAssign(BaseModel):
    track_ids: list[int]
    tag_id: int
    on: bool = True


@app.post("/api/tags/assign")
def assign_tag(body: TagAssign) -> dict:
    with db.conn() as c:
        if body.on:
            c.executemany(
                "INSERT INTO track_tags(track_id, tag_id, source) VALUES (?,?, 'user') "
                "ON CONFLICT(track_id, tag_id) DO UPDATE SET source=CASE WHEN source='rekordbox' THEN source ELSE 'user' END",
                [(t, body.tag_id) for t in body.track_ids])
        else:
            c.executemany("DELETE FROM track_tags WHERE track_id=? AND tag_id=? AND source!='rekordbox'",
                          [(t, body.tag_id) for t in body.track_ids])
    return {"ok": True}


# ---------------------------------------------------------------- relaciones
class RelationIn(BaseModel):
    a: int
    b: int
    kind: str  # mix | similar | mashup | avoid
    note: str | None = None


def _canon(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


@app.post("/api/relations")
def create_relation(body: RelationIn) -> dict:
    if body.a == body.b or body.kind not in recommend.SYMMETRIC:
        raise HTTPException(400, "Relación inválida")
    a, b = _canon(body.a, body.b)
    with db.conn() as c:
        if body.kind == "avoid":
            c.execute("DELETE FROM relations WHERE a=? AND b=? AND kind IN ('mix','mashup','similar') AND source IN ('user','feedback')", (a, b))
        else:
            c.execute("DELETE FROM relations WHERE a=? AND b=? AND kind='avoid'", (a, b))
        c.execute(
            "INSERT INTO relations(a, b, kind, source, note) VALUES (?,?,?, 'user', ?) "
            "ON CONFLICT(a, b, kind, source) DO UPDATE SET note=COALESCE(excluded.note, note)",
            (a, b, body.kind, body.note),
        )
        return {"relations": relations_of(c, body.a)}


@app.delete("/api/relations/{rid}")
def delete_relation(rid: int) -> dict:
    with db.conn() as c:
        c.execute("DELETE FROM relations WHERE id=? AND source NOT LIKE 'history%'", (rid,))
    return {"ok": True}


class Feedback(BaseModel):
    seed: int
    other: int
    good: bool


@app.post("/api/feedback")
def feedback(body: Feedback) -> dict:
    a, b = _canon(body.seed, body.other)
    with db.conn() as c:
        if body.good:
            c.execute("DELETE FROM relations WHERE a=? AND b=? AND kind='avoid'", (a, b))
            c.execute(
                "INSERT INTO relations(a, b, kind, source, weight) VALUES (?,?, 'mix', 'feedback', 1) "
                "ON CONFLICT(a, b, kind, source) DO UPDATE SET weight=MIN(weight+0.5, 3), count=count+1", (a, b))
        else:
            c.execute("DELETE FROM relations WHERE a=? AND b=? AND kind IN ('mix','mashup','similar') AND source='feedback'", (a, b))
            c.execute("INSERT OR IGNORE INTO relations(a, b, kind, source) VALUES (?,?, 'avoid', 'feedback')", (a, b))
    return {"ok": True}


# ---------------------------------------------------------------- mapa
@app.get("/api/map")
def map_points(crate: str | None = None) -> dict:
    with db.conn() as c:
        rows = query_tracks(c, crate or "all", {})
        pts = [r for r in rows if r["bpm"]]
        ids = {r["id"] for r in pts}
        # energía continua (percentil dentro de la librería) para que el mapa no quede en franjas
        raw = c.execute("SELECT id, energy_raw FROM tracks WHERE energy_raw IS NOT NULL ORDER BY energy_raw").fetchall()
        cont = {r["id"]: 1 + 9 * i / max(len(raw) - 1, 1) for i, r in enumerate(raw)}
        for r in pts:
            if r["energy_user"] is None and r["id"] in cont:
                r["energy"] = round(cont[r["id"]], 2)
        edges = []
        for r in c.execute("SELECT a, b, kind, source, count FROM relations"):
            if r["a"] in ids and r["b"] in ids:
                edges.append([r["a"], r["b"], r["kind"], r["count"]])
        return {
            "points": [
                [r["id"], r["bpm"], r["energy"], r["key"], r["rating"], r["title"], r["artist"], r["play_count"], int(r["online"]), r["tags"]]
                for r in pts
            ],
            "edges": edges,
        }


# ---------------------------------------------------------------- universos
class UniverseIn(BaseModel):
    name: str
    crate_ids: list[int] = []
    activate: bool = True


class UniversePatch(BaseModel):
    name: str | None = None
    crate_ids: list[int] | None = None


class CrateIds(BaseModel):
    crate_ids: list[int]


class Activate(BaseModel):
    id: int | None = None


@app.get("/api/universes")
def universes() -> dict:
    with db.conn() as c:
        return universe.listing(c)


@app.get("/api/universes/editor")
def universe_editor() -> list[dict]:
    """Todas las cajas (sin filtro de universo) con cantidad y BPM mediano, para elegir."""
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id, name, kind, parent_id FROM crates WHERE kind IN ('folder','playlist','user') ORDER BY position, name")]
        bpms: dict[int, list[float]] = {}
        counts: dict[int, int] = {}
        for r in c.execute("SELECT ct.crate_id, t.bpm FROM crate_tracks ct JOIN tracks t ON t.id=ct.track_id"):
            counts[r[0]] = counts.get(r[0], 0) + 1
            if r[1]:
                bpms.setdefault(r[0], []).append(r[1])
        for r in rows:
            b = sorted(bpms.get(r["id"], []))
            r["count"] = counts.get(r["id"], 0)
            r["bpm"] = round(b[len(b) // 2]) if b else None
        return rows


@app.post("/api/universes/count")
def universe_count(body: CrateIds) -> dict:
    with db.conn() as c:
        return {"count": universe.count_for(c, body.crate_ids) if body.crate_ids else 0}


@app.post("/api/universes")
def create_universe(body: UniverseIn) -> dict:
    with db.conn() as c:
        cur = c.execute("INSERT INTO universes(name, crate_ids) VALUES (?,?)", (body.name.strip(), json.dumps(body.crate_ids)))
        if body.activate:
            universe.set_active(c, cur.lastrowid)
        return universe.listing(c)


@app.post("/api/universes/activate")
def activate_universe(body: Activate) -> dict:
    with db.conn() as c:
        universe.set_active(c, body.id)
        return universe.listing(c)


@app.patch("/api/universes/{uid}")
def patch_universe(uid: int, body: UniversePatch) -> dict:
    with db.conn() as c:
        if body.name is not None:
            c.execute("UPDATE universes SET name=? WHERE id=?", (body.name.strip(), uid))
        if body.crate_ids is not None:
            c.execute("UPDATE universes SET crate_ids=? WHERE id=?", (json.dumps(body.crate_ids), uid))
        return universe.listing(c)


@app.delete("/api/universes/{uid}")
def delete_universe(uid: int) -> dict:
    with db.conn() as c:
        if universe.active_id(c) == uid:
            universe.set_active(c, None)
        c.execute("DELETE FROM universes WHERE id=?", (uid,))
        return universe.listing(c)


# ---------------------------------------------------------------- tonalidades
@app.get("/api/keys/status")
def keys_status() -> dict:
    reset_online_cache()
    with db.conn() as c:
        return keyfill.status(c)


@app.post("/api/keys/fill")
def keys_fill() -> dict:
    return jobs.start("keys", "Completando tonalidades", keyfill.run).__dict__


# ---------------------------------------------------------------- exportar
class ExportIn(BaseModel):
    crate_ids: list[Any]
    tags_in_comment: bool = False


@app.get("/api/export/targets")
def export_targets() -> dict:
    with db.conn() as c:
        return {"targets": export.targets(registry.detect_all(c))}


class ExportRunIn(BaseModel):
    target: str
    crate_ids: list[Any]
    tags_in_comment: bool = False


@app.post("/api/export")
def export_run(body: ExportRunIn) -> dict:
    if body.target not in export.TARGET_IDS:
        raise HTTPException(400, "Destino desconocido")
    with db.conn() as c:
        return export.run(c, body.target, body.crate_ids, body.tags_in_comment)


@app.post("/api/export/rekordbox")
def export_rb(body: ExportIn) -> dict:
    with db.conn() as c:
        res = export.export(c, body.crate_ids, body.tags_in_comment)
    return res


class RevealIn(BaseModel):
    path: str | None = None


@app.post("/api/reveal-export")
def reveal_export(body: RevealIn | None = None) -> dict:
    p = config.EXPORT_DIR / "batea.xml"
    if body and body.path:
        root = config.EXPORT_DIR.resolve()
        p = Path(body.path).resolve()
        if p != root and root not in p.parents:
            raise HTTPException(400, "Ese archivo no está en la carpeta de exportación")
    subprocess.run(["open", "-R", str(p)] if p.exists() else ["open", str(config.EXPORT_DIR)], check=False)
    return {"ok": True}


# ---------------------------------------------------------------- links batea:// (desde otras apps y el MCP)
class OpenIn(BaseModel):
    url: str


def _check_token(tok: str | None) -> None:
    # Solo procesos locales que pueden leer app.json (el abridor de links, el MCP) mandan pedidos.
    if not links.token() or tok != links.token():
        raise HTTPException(403, "Token inválido")


@app.post("/api/open")
def open_link(body: OpenIn, x_batea_token: str | None = Header(None)) -> dict:
    _check_token(x_batea_token)
    try:
        target = links.parse(body.url)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    with db.conn() as c:
        if target["kind"] == "tema" and not c.execute("SELECT 1 FROM tracks WHERE id=?", (int(target["value"]),)).fetchone():
            raise HTTPException(404, "Ese tema no está en Batea")
        if target["kind"] == "caja" and target["value"] not in VIRTUAL_CRATES and not (
                target["value"].isdigit() and c.execute("SELECT 1 FROM crates WHERE id=?", (int(target["value"]),)).fetchone()):
            raise HTTPException(404, "Esa caja no está en Batea")
    links.push(target)
    return {"ok": True}


@app.post("/api/open/refresh")
def open_refresh(x_batea_token: str | None = Header(None)) -> dict:
    """Algo cambió desde afuera (p. ej. el MCP creó una caja): la interfaz recarga sin ponerse al frente."""
    _check_token(x_batea_token)
    links.push({"kind": "refresh"}, focus=False)
    return {"ok": True}


@app.get("/api/open/pending")
def open_pending() -> list[dict]:
    return links.drain()


# ---------------------------------------------------------------- agentes de IA (MCP)
@app.get("/api/agents")
def agents_list() -> dict:
    return agents.listing()


class AgentSet(BaseModel):
    connected: bool


@app.post("/api/agents/{agent_id}")
def agents_set(agent_id: str, body: AgentSet) -> dict:
    try:
        return agents.set_connected(agent_id, body.connected)
    except KeyError as e:
        raise HTTPException(404, "Agente desconocido") from e
    except (RuntimeError, OSError, ValueError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/agents-test")
def agents_test() -> dict:
    return agents.test()


# ---------------------------------------------------------------- Traktor en vivo
class TraktorBroadcastIn(BaseModel):
    enabled: bool
    port: int | None = None


@app.get("/api/live/traktor-broadcast")
def traktor_broadcast_status() -> dict:
    from . import traktor_broadcast

    return traktor_broadcast.status()


@app.post("/api/live/traktor-broadcast")
def traktor_broadcast_configure(body: TraktorBroadcastIn) -> dict:
    from . import traktor_broadcast

    try:
        return traktor_broadcast.configure(body.enabled, body.port)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


# ---------------------------------------------------------------- frontend
if config.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        f = config.FRONTEND_DIST / full_path
        if full_path and f.is_file():
            return FileResponse(f)
        return FileResponse(config.FRONTEND_DIST / "index.html")
else:
    @app.get("/")
    def no_frontend():
        return JSONResponse({"error": "Falta compilar el frontend: cd frontend && npm run build"})
