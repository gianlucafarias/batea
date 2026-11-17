"""Buscar música que todavía no está en rekordbox, esté donde esté.

No hay carpetas fijas: se recorre la carpeta del usuario y cada disco conectado.
- Un tema es un archivo de audio de 2 minutos o más (los samples, loops y one-shots quedan afuera).
- Lo que ya está en rekordbox se reconoce por ruta y, si se movió o copió, por nombre de archivo + duración.
- Si un tema que ya estaba en Batea cambió de carpeta, se actualiza la ruta y conserva etiquetas, notas y relaciones.
- Las carpetas que el usuario marca como "no es música" se recuerdan y no se vuelven a revisar.
Las duraciones se guardan en caché (ruta + tamaño + fecha), así que volver a buscar tarda segundos.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path

from . import config, db, jobs
from .api_helpers import is_online, reset_online_cache
from .jobs import Job

MIN_SECONDS = 120          # menos que esto es un sample, un loop o un one-shot
DROP_MIN_SECONDS = 20      # lo que se arrastra a mano entra aunque sea corto (tools, loops largos)
# Por tamaño: lo que pesa menos no puede ser un tema de 2 minutos y ni se abre
MIN_BYTES = {".wav": 10_000_000, ".aif": 10_000_000, ".aiff": 10_000_000, ".flac": 4_000_000}
MIN_BYTES_DEFAULT = 1_200_000     # mp3/m4a: 2 minutos a 80 kbps
# Carpetas de producción: packs de samples, loops, one-shots, presets, proyectos. Se saltean enteras.
SAMPLE_DIR = re.compile(
    r"\b(samples?|sample ?packs?|loops?|one[ -]?shots?|shots?|presets?|midi|stems|kicks?|snares?|hi-?hats?|hats|claps?|"
    r"percussion|perc|fx|sfx|previews?|demos?|construction ?kits?|drum ?kits?|toolkits?|sound ?packs?|multiformat|wav ?midi)\b",
    re.IGNORECASE,
)
PROJECT_MARKERS = ("Ableton Project Info",)
EXTS = config.AUDIO_EXTS - {".mp4"}      # .mp4 casi siempre es video
SKIP_NAMES = {"Library", "Applications", "node_modules", "__pycache__", "site-packages", "Backups.backupdb", "PIONEER",
              "Cache", "Caches", "cache", "Temp", "tmp"}
SKIP_SUFFIXES = (".app", ".bundle", ".framework", ".photoslibrary", ".musiclibrary", ".logicx", ".band", ".tvlibrary")

SCHEMA = """
CREATE TABLE IF NOT EXISTS found_files (
    path TEXT PRIMARY KEY,
    size INTEGER, mtime REAL, duration REAL,
    state TEXT,                 -- short | copy | track | error
    ref_id INTEGER              -- tema de Batea/rekordbox al que corresponde
);
CREATE INDEX IF NOT EXISTS found_files_ref ON found_files(ref_id);
CREATE TABLE IF NOT EXISTS ignored_folders (
    path TEXT PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""


def _n(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _key(name: str) -> str:
    return _n(name).lower()


def init(c) -> None:
    c.executescript(SCHEMA)


# ---------------------------------------------------------------- dónde buscar
def roots() -> list[Path]:
    out = [config.HOME]
    try:
        vols = sorted(os.listdir("/Volumes"))
    except OSError:
        vols = []
    for v in vols:
        p = Path("/Volumes") / v
        try:
            if p.resolve() == Path("/") or not p.is_dir() or not os.access(p, os.R_OK):
                continue
        except OSError:
            continue
        if "timemachine" in v.lower() or v.startswith("com.apple") or (p / "Backups.backupdb").exists():
            continue
        out.append(p)
    return out


def volumes() -> set[str]:
    return {str(p) for p in roots()[1:]}


def _skip_dir(name: str) -> bool:
    return name.startswith(".") or name in SKIP_NAMES or name.endswith(SKIP_SUFFIXES) or bool(SAMPLE_DIR.search(name))


def _min_bytes(path: str) -> int:
    return MIN_BYTES.get(os.path.splitext(path)[1].lower(), MIN_BYTES_DEFAULT)


def _under(path: str, folders: list[str]) -> bool:
    return any(path == f or path.startswith(f.rstrip("/") + "/") for f in folders)


def walk(paths: list[Path], ignored: list[str], job: Job | None = None) -> list[tuple[str, int, float]]:
    """(ruta, tamaño, mtime) de cada archivo de audio candidato."""
    out = []
    seen_dirs = 0
    for root in paths:
        if root.is_file():
            try:
                st = root.stat()
                out.append((_n(str(root)), st.st_size, st.st_mtime))
            except OSError:
                pass
            continue
        for dp, dn, fn in os.walk(root):
            if job and job.cancelled:
                return out
            if any(m in dn for m in PROJECT_MARKERS):      # proyecto de Ableton: no es música terminada
                dn[:] = []
                continue
            dn[:] = [d for d in dn if not _skip_dir(d) and not _under(_n(os.path.join(dp, d)), ignored)]
            seen_dirs += 1
            if job and seen_dirs % 400 == 0:
                job.update(0.02 + min(0.3, seen_dirs / 40000), f"Recorriendo {root}… {len(out):,} archivos de audio".replace(",", "."))
            for f in fn:
                if f.startswith("._") or os.path.splitext(f)[1].lower() not in EXTS:
                    continue
                p = os.path.join(dp, f)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                out.append((_n(p), st.st_size, st.st_mtime))
    return out


def _duration(path: str) -> float | None:
    """Duración leyendo solo la cabecera (sin cargar tags ni carátulas: en un disco externo eso es lo lento)."""
    ext = os.path.splitext(path)[1].lower()
    try:
        with open(path, "rb") as f:
            if ext == ".mp3":
                from mutagen.mp3 import MPEGInfo

                h = f.read(10)
                off = 0
                if h[:3] == b"ID3" and len(h) == 10:
                    size = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9]
                    off = 10 + size + (10 if h[5] & 0x10 else 0)
                return float(MPEGInfo(f, off).length)
            if ext == ".flac":
                if f.read(4) == b"fLaC":
                    f.read(4)
                    si = f.read(34)
                    sr = int.from_bytes(si[10:13], "big") >> 4
                    total = ((si[13] & 0x0F) << 32) | int.from_bytes(si[14:18], "big")
                    if sr and total:
                        return total / sr
    except Exception:  # noqa: BLE001
        pass
    from mutagen import File as MFile

    try:
        m = MFile(path)
        return float(m.info.length) if m is not None and m.info is not None else None
    except Exception:  # noqa: BLE001
        return None


def _durations(items: list[tuple[str, int, float]], cache: dict, job: Job, base: float, span: float) -> dict[str, float | None]:
    """Duraciones de muchos archivos en paralelo (el disco responde mejor con varias lecturas a la vez)."""
    from concurrent.futures import ThreadPoolExecutor

    out: dict[str, float | None] = {}
    todo = []
    for p, size, mtime in items:
        hit = cache.get(p)
        if hit and hit[0] == size and abs((hit[1] or 0) - mtime) < 1 and hit[2] is not None:
            out[p] = hit[2]
        else:
            todo.append(p)
    t_last = time.time()
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, (p, d) in enumerate(zip(todo, pool.map(_duration, todo))):
            out[p] = d
            if time.time() - t_last > 0.3:
                t_last = time.time()
                job.update(base + span * i / max(1, len(todo)), f"Midiendo duraciones {i + 1:,}/{len(todo):,}".replace(",", "."))
                if job.cancelled:
                    break
    return out


# ---------------------------------------------------------------- importar sin analizar
def file_date(path: str) -> str:
    """Cuándo llegó el archivo a la Mac o al disco (fecha de creación del archivo), como "agregado"."""
    try:
        st = os.stat(path)
        ts = getattr(st, "st_birthtime", 0) or st.st_mtime
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    except OSError:
        return datetime.now().strftime("%Y-%m-%d")


def fix_local_dates(c) -> int:
    """Los temas fuera de rekordbox toman como "agregado" la fecha del archivo, no la de cuando Batea los encontró."""
    n = 0
    for r in c.execute("SELECT id, path, date_added FROM tracks WHERE source='local' AND path IS NOT NULL").fetchall():
        if not is_online(r["path"]):
            continue
        d = file_date(r["path"])
        if d != r["date_added"]:
            c.execute("UPDATE tracks SET date_added=? WHERE id=?", (d, r["id"]))
            n += 1
    return n


def _insert_local(c, path: str, duration: float | None) -> int:
    """Alta inmediata con lo que dice el nombre del archivo; tags, carátula, BPM y tono los completa el análisis de fondo."""
    stem = Path(path).stem
    artist, title = None, stem
    for sep in (" - ", " – ", " — "):
        if sep in stem:
            left, right = stem.split(sep, 1)
            left = re.sub(r"^\d{1,3}[\s._-]+", "", left).strip()      # "01 - Artista - Tema"
            if left and right.strip():
                artist, title = left, right.strip()
            break
    cur = c.execute(
        "INSERT INTO tracks(path, title, artist, duration, filetype, source, date_added) VALUES (?,?,?,?,?, 'local', ?)",
        (path, title, artist, duration, Path(path).suffix.lower().lstrip("."), file_date(path)),
    )
    return cur.lastrowid


def _has_user_data(c, tid: int) -> bool:
    r = c.execute(
        """SELECT (COALESCE(rating,0)>0 OR energy IS NOT NULL OR COALESCE(notes,'')!='' OR reviewed IS NOT NULL)
             OR EXISTS(SELECT 1 FROM track_tags WHERE track_id=? AND source='user')
             OR EXISTS(SELECT 1 FROM relations WHERE (a=? OR b=?) AND kind!='history')
             OR EXISTS(SELECT 1 FROM crate_tracks ct JOIN crates cr ON cr.id=ct.crate_id WHERE ct.track_id=? AND cr.kind='user')
           FROM tracks WHERE id=?""",
        (tid, tid, tid, tid, tid),
    ).fetchone()
    return bool(r and r[0])


# ---------------------------------------------------------------- búsqueda
def run(job: Job, paths: list[str] | None = None) -> dict:
    """Busca en todo (paths=None) o solo en lo que el usuario arrastró / eligió."""
    explicit = paths is not None
    reset_online_cache()
    with db.conn() as c:
        init(c)
        ignored = [r[0] for r in c.execute("SELECT path FROM ignored_folders")]
        if explicit:  # lo que se trae a mano deja de estar ignorado
            for p in paths:
                np_ = _n(str(Path(p).expanduser()))
                c.execute("DELETE FROM ignored_folders WHERE path=? OR ?||'/' LIKE path||'/%' OR path LIKE ?||'/%'", (np_, np_, np_))
            ignored = [r[0] for r in c.execute("SELECT path FROM ignored_folders")]
        tracks = c.execute("SELECT id, path, duration, source FROM tracks WHERE path IS NOT NULL").fetchall()
        cache = {r[0]: (r[1], r[2], r[3], r[4], r[5]) for r in c.execute("SELECT path, size, mtime, duration, state, ref_id FROM found_files")}

    known = {_n(t["path"]): t["id"] for t in tracks}
    by_name: dict[str, list[tuple[int, float | None, str, str]]] = {}
    for t in tracks:
        by_name.setdefault(_key(os.path.basename(t["path"])), []).append((t["id"], t["duration"], t["path"], t["source"]))

    targets = [Path(p).expanduser() for p in paths] if explicit else roots()
    first_time = not explicit and not cache
    job.update(0.02, "Recorriendo tus carpetas y discos…" + (" La primera búsqueda tarda unos minutos; después, segundos." if first_time else ""))
    files = walk(targets, [] if explicit else ignored, job)
    min_s = DROP_MIN_SECONDS if explicit else MIN_SECONDS
    cand = [(p, s, m) for p, s, m in files if p not in known and (explicit or s >= _min_bytes(p))]

    res = {"archivos": len(files), "nuevos": 0, "movidos": 0, "copias": 0, "samples": 0, "errores": 0}
    new_ids: list[int] = []
    # si el nombre coincide con un tema que ya conocemos no hace falta abrir el archivo
    durs = _durations([x for x in cand if _key(os.path.basename(x[0])) not in by_name], cache, job, 0.35, 0.45)
    cache_rows: list[tuple] = []
    t_last = time.time()
    with db.conn() as c:
        for i, (p, size, mtime) in enumerate(cand):
            if job.cancelled:
                res["cancelado"] = True
                break
            if time.time() - t_last > 0.25:
                t_last = time.time()
                job.update(0.8 + 0.18 * i / max(1, len(cand)), f"Revisando {i + 1:,}/{len(cand):,} · {os.path.basename(p)}".replace(",", "."))
            namesake = by_name.get(_key(os.path.basename(p)), [])
            if not namesake and p not in durs:
                if job.cancelled:
                    break      # cancelado mientras se medían duraciones
                continue
            dur = durs.get(p)
            if not namesake:
                if dur is None:
                    cache_rows.append((p, size, mtime, None, "error", None)); res["errores"] += 1
                    continue
                if dur < min_s:
                    cache_rows.append((p, size, mtime, dur, "short", None)); res["samples"] += 1
                    continue
            # ¿es un tema que ya conocemos, en otro lugar? (mismo nombre de archivo)
            same = [m for m in namesake if dur is None or m[1] is None or abs(m[1] - dur) <= 2.5]
            moved = next((m for m in same if m[3] == "local" and not os.path.exists(m[2])), None)
            if moved:
                c.execute("UPDATE tracks SET path=? WHERE id=?", (p, moved[0]))
                known[p] = moved[0]
                cache_rows.append((p, size, mtime, dur, "track", moved[0])); res["movidos"] += 1
                continue
            if same and (not explicit or any(m[3] == "rekordbox" for m in same)):
                cache_rows.append((p, size, mtime, dur, "copy", same[0][0])); res["copias"] += 1
                continue
            try:
                tid = _insert_local(c, p, dur)
            except Exception:  # noqa: BLE001
                cache_rows.append((p, size, mtime, dur, "error", None)); res["errores"] += 1
                continue
            known[p] = tid
            by_name.setdefault(_key(os.path.basename(p)), []).append((tid, dur, p, "local"))
            new_ids.append(tid)
            cache_rows.append((p, size, mtime, dur, "manual" if explicit else "track", tid)); res["nuevos"] += 1
        c.executemany("INSERT OR REPLACE INTO found_files(path, size, mtime, duration, state, ref_id) VALUES (?,?,?,?,?,?)", cache_rows)
        if not explicit and not job.cancelled:
            # lo que trajo una búsqueda anterior y ya no pasa las reglas (p. ej. una carpeta de samples) sale,
            # salvo que tenga datos tuyos. Lo que trajiste a mano ("manual") nunca se toca.
            walked = {p for p, _, _ in files}
            for r in c.execute(
                "SELECT t.id, t.path FROM tracks t JOIN found_files f ON f.path=t.path WHERE t.source='local' AND f.state='track'"
            ).fetchall():
                if r["path"] not in walked and os.path.exists(r["path"]) and not _has_user_data(c, r["id"]):
                    c.execute("DELETE FROM tracks WHERE id=?", (r["id"],))
                    c.execute("DELETE FROM found_files WHERE path=?", (r["path"],))
                    res["quitados"] = res.get("quitados", 0) + 1
        fix_local_dates(c)
        summary = {**res, "fecha": datetime.now().isoformat(timespec="seconds"), "donde": [str(t) for t in targets] if explicit else [str(r) for r in targets]}
        if not explicit:
            db.set_meta(c, "discover_last", json.dumps(summary))

    n = res["nuevos"]
    res["mensaje"] = (
        f"{n} {'tema nuevo' if n == 1 else 'temas nuevos'} fuera de rekordbox" if n else "No hay música nueva fuera de rekordbox"
    ) + (f" · {res['movidos']} cambiaron de carpeta" if res["movidos"] else "")
    return res


def analyze_folder(folder: str) -> Job:
    """Analiza (cuando el usuario lo pide) los temas de una carpeta que todavía no se analizaron."""
    from . import analysis
    from .api_helpers import is_online

    folder = _n(folder.rstrip("/"))
    with db.conn() as c:
        todo = [r[0] for r in c.execute(
            "SELECT path FROM tracks WHERE source='local' AND analyzed IS NULL AND hidden=0 AND (path LIKE ? || '/%')", (folder,))]
    todo = [p for p in todo if is_online(p)]
    name = os.path.basename(folder) or folder
    return analysis.enqueue(todo, f"Analizando {name}")


def start(paths: list[str] | None = None) -> Job:
    if paths:
        return jobs.start("discover", "Trayendo a Batea", lambda j: run(j, paths))
    return jobs.start("discover", "Buscando música nueva", lambda j: run(j))


# ---------------------------------------------------------------- carpetas
def folders(c) -> dict:
    init(c)
    rows = c.execute(
        """SELECT t.path, t.analyzed, (t.rating>0 OR t.energy IS NOT NULL OR t.reviewed IS NOT NULL) AS touched
           FROM tracks t WHERE t.source='local' AND t.hidden=0 AND t.path IS NOT NULL"""
    ).fetchall()
    groups: dict[str, dict] = {}
    for r in rows:
        d = os.path.dirname(r["path"])
        g = groups.setdefault(d, {"folder": d, "count": 0, "analyzed": 0, "offline": 0})
        g["count"] += 1
        g["analyzed"] += 1 if r["analyzed"] else 0
    for g in groups.values():
        g["offline"] = 0 if os.path.isdir(g["folder"]) else g["count"]
    copies = c.execute("SELECT COUNT(*) FROM found_files WHERE state='copy'").fetchone()[0]
    samples = c.execute("SELECT COUNT(*) FROM found_files WHERE state='short'").fetchone()[0]
    last = db.get_meta(c, "discover_last")
    return {
        "folders": sorted(groups.values(), key=lambda g: (-g["count"], g["folder"])),
        "ignored": [r[0] for r in c.execute("SELECT path FROM ignored_folders ORDER BY path")],
        "roots": [str(r) for r in roots()],
        "copies": copies,
        "samples": samples,
        "last": json.loads(last) if last else None,
    }


def ignore(c, folder: str) -> dict:
    """La carpeta deja de revisarse. Sus temas salen de Batea, salvo los que ya tienen datos tuyos (esos se ocultan)."""
    init(c)
    folder = _n(folder.rstrip("/"))
    c.execute("INSERT OR IGNORE INTO ignored_folders(path) VALUES (?)", (folder,))
    rows = c.execute("SELECT id FROM tracks WHERE source='local' AND (path LIKE ? || '/%')", (folder,)).fetchall()
    removed = hidden = 0
    for (tid,) in rows:
        if _has_user_data(c, tid):
            c.execute("UPDATE tracks SET hidden=1 WHERE id=?", (tid,)); hidden += 1
        else:
            c.execute("DELETE FROM tracks WHERE id=?", (tid,)); removed += 1
    c.execute("DELETE FROM found_files WHERE path LIKE ? || '/%'", (folder,))
    return {"quitados": removed, "ocultos": hidden}


def unignore(c, folder: str) -> None:
    init(c)
    folder = _n(folder.rstrip("/"))
    c.execute("DELETE FROM ignored_folders WHERE path=?", (folder,))
    c.execute("UPDATE tracks SET hidden=0 WHERE source='local' AND path LIKE ? || '/%'", (folder,))


# ---------------------------------------------------------------- vigilar discos
_watch_started = False


def auto_enabled(c: sqlite3.Connection) -> bool:
    """¿Busca música sola (al abrir y al conectar un disco)?

    Lo decide la persona: en la primera vez se le pregunta y queda guardado. Una instalación nueva que todavía no
    contestó NO busca nada. Las que ya tenían temas antes de existir esta pregunta siguen con la búsqueda automática."""
    v = db.get_meta(c, "autodiscover")
    if v is not None:
        return v == "1"
    return c.execute("SELECT 1 FROM tracks LIMIT 1").fetchone() is not None


def set_auto(enabled: bool) -> None:
    with db.conn() as c:
        db.set_meta(c, "autodiscover", "1" if enabled else "0")


def watch(delay: float = 4.0, every: float = 6.0) -> None:
    """Si la persona lo permitió: busca música nueva al abrir la app y cada vez que se conecta un disco."""
    global _watch_started
    if _watch_started or os.environ.get("BATEA_AUTODISCOVER", "1") == "0":
        return
    _watch_started = True

    def enabled() -> bool:
        with db.conn() as c:
            return auto_enabled(c)

    def loop() -> None:
        time.sleep(delay)
        armed = False                      # ya hizo la búsqueda inicial desde que se activó
        before = volumes()
        while True:
            if not enabled():
                armed = False              # si se vuelve a activar, empieza de nuevo con una búsqueda
                time.sleep(2)
                continue
            if any(j["kind"] == "sync" and j["status"] == "running" for j in jobs.list_jobs()):
                time.sleep(3)              # primero termina la importación de rekordbox
                continue
            if not armed:
                armed = True
                start()
                before = volumes()
                continue
            time.sleep(every)
            now = volumes()
            if now - before:
                reset_online_cache()
                time.sleep(2)              # dar tiempo a que el disco termine de montarse
                if enabled():
                    start()
            elif before - now:
                reset_online_cache()
            before = now

    threading.Thread(target=loop, daemon=True, name="discover-watch").start()
