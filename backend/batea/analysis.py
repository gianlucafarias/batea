"""Análisis propio de audio para temas que todavía no pasaron por rekordbox.

BPM, tonalidad (Camelot), curvas de volumen/bandas -> mismos rasgos que con ANLZ
(energía, intro, outro, breaks) y waveform. Corre en procesos aparte.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from . import config, db, features, jobs, keys, tempo
from .anlz import Curves
from .jobs import Job

SR = 22050
HOP = 512

# Perfiles de Krumhansl-Kessler
_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def waveform_cache(track_id: int) -> Path:
    d = config.CACHE_DIR / "waveforms"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{track_id}.json"


def _detect_key(y: np.ndarray) -> str | None:
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP * 4, bins_per_octave=36)
    prof = chroma.mean(axis=1)
    if not np.isfinite(prof).all() or prof.sum() == 0:
        return None
    best, best_r = None, -2.0
    for pc in range(12):
        for minor, tmpl in ((False, _MAJ), (True, _MIN)):
            r = np.corrcoef(prof, np.roll(tmpl, pc))[0, 1]
            if r > best_r:
                best_r, best = r, (pc, minor)
    return keys.camelot_from_pitch(*best) if best else None


def read_tags(path: str) -> dict:
    """Metadatos y carátula embebida con mutagen."""
    from mutagen import File as MFile

    out: dict = {}
    try:
        f = MFile(path, easy=False)
    except Exception:  # noqa: BLE001
        return out
    if f is None:
        return out
    tags = f.tags or {}

    def first(*names):
        for n in names:
            try:  # los tags Vorbis (FLAC/OGG) rechazan claves de otros formatos con ValueError
                v = tags.get(n) if hasattr(tags, "get") else None
            except (ValueError, KeyError):
                v = None
            if v is None:
                continue
            v = v.text[0] if hasattr(v, "text") else (v[0] if isinstance(v, list) else v)
            v = str(v).strip()
            if v:
                return v
        return None

    out["title"] = first("TIT2", "title", "\xa9nam", "TITLE")
    out["artist"] = first("TPE1", "artist", "\xa9ART", "ARTIST")
    out["album"] = first("TALB", "album", "\xa9alb", "ALBUM")
    out["genre"] = first("TCON", "genre", "\xa9gen", "GENRE")
    out["label"] = first("TPUB", "organization", "label", "LABEL")
    out["remixer"] = first("TPE4", "remixer", "REMIXER")
    out["key_tag"] = first("TKEY", "initialkey", "INITIALKEY", "----:com.apple.iTunes:initialkey")
    out["bpm_tag"] = first("TBPM", "bpm", "BPM", "tmpo")
    out["year"] = first("TDRC", "date", "\xa9day", "DATE")
    if f.info is not None:
        out["duration"] = float(getattr(f.info, "length", 0) or 0)
        out["bitrate"] = int((getattr(f.info, "bitrate", 0) or 0) / 1000) or None

    pic = None
    if hasattr(tags, "getall"):
        apics = tags.getall("APIC")
        pic = apics[0].data if apics else None
    elif "covr" in tags:
        pic = bytes(tags["covr"][0])
    if pic is None and hasattr(f, "pictures") and f.pictures:
        pic = f.pictures[0].data
    if pic:
        h = hashlib.md5(path.encode()).hexdigest()
        dst = config.ARTWORK_CACHE / f"{h}.jpg"
        try:
            dst.write_bytes(pic)
            out["artwork_file"] = str(dst)
        except OSError:
            pass
    return out


def _fit_grid(onset: np.ndarray, lo: np.ndarray, bpm: float, dur: float) -> tuple[np.ndarray, np.ndarray]:
    """Grilla de tempo fijo (como la de rekordbox): fase por la envolvente de ataques,
    y el "1" del compás por el primer golpe con bombo."""
    period = 60.0 / bpm
    fps = SR / HOP
    # la fase se busca con los ataques de graves (el bombo): la envolvente general
    # suele preferir el hi-hat del contratiempo y deja la grilla corrida medio beat
    flux = np.maximum(0.0, np.diff(lo, prepend=lo[:1]))
    if flux.max() > 0:
        onset = flux
    n = len(onset)
    best_phi, best = 0.0, -1.0
    for phi in np.arange(0, period, 0.004):
        idx = ((phi + np.arange(0, dur - phi, period)) * fps).astype(int)
        idx = idx[idx < n]
        v = float(onset[idx].mean()) if len(idx) else 0.0
        if v > best:
            best, best_phi = v, float(phi)
    beats = best_phi + np.arange(0, max(dur - best_phi, period), period)
    idx = np.clip((beats * fps).astype(int), 0, len(lo) - 1)
    lo_b = np.array([lo[max(0, i - 2): i + 3].max() for i in idx])
    strong = np.sort(lo_b)[len(lo_b) // 2:]
    thr = 0.5 * float(np.median(strong)) if len(strong) else 0.0
    first = int(np.argmax(lo_b >= thr)) if thr > 0 and (lo_b >= thr).any() else 0
    return beats, beats[first % 4::4]


def _key_version() -> int:
    from .keyfill import current_version

    return current_version()


ANALYSIS_VERSION = 2   # 2: BPM con RhythmExtractor2013 / peine de graves (antes: tempo de librosa, fallaba en temas duros)


def _load(path: str) -> tuple[np.ndarray, np.ndarray | None]:
    """(audio a 22050 Hz para curvas y grilla, audio a 44100 Hz para Essentia o None)."""
    import librosa

    try:
        import essentia

        essentia.log.infoActive = False
        essentia.log.warningActive = False
        import essentia.standard as es

        a44 = es.MonoLoader(filename=path, sampleRate=44100)()
        if len(a44):
            return librosa.resample(a44, orig_sr=44100, target_sr=SR, res_type="soxr_hq"), a44
    except ImportError:
        pass
    except Exception:  # noqa: BLE001  (formato que Essentia no lee: probamos con librosa)
        pass
    y, _ = librosa.load(path, sr=SR, mono=True)
    return y, None


def analyze_file(path: str) -> dict:
    """Corre en un proceso aparte. Devuelve todo serializable."""
    import librosa

    meta = read_tags(path)
    y, a44 = _load(path)
    if len(y) < SR * 5:
        raise ValueError("archivo demasiado corto")
    dur = len(y) / SR

    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    lo = np.sqrt((S[freqs < 200] ** 2).sum(axis=0))
    onset = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)

    bpm = tempo.estimate(y, SR, lo, onset, HOP, a44)
    try:  # si el archivo trae BPM (Beatport, etc.) y coincide, confiamos en él
        tag_bpm = tempo.fold(float(str(meta.get("bpm_tag") or "0").replace(",", ".")))
        if tag_bpm and bpm and abs(tag_bpm - bpm) < 0.25:   # los tags suelen venir redondeados: solo para afinar
            bpm = tag_bpm
    except ValueError:
        pass

    tag_key = keys.to_camelot(meta.get("key_tag"))
    try:
        from .keyfill import detect_key_audio, detect_key_file

        detected_key = (detect_key_audio(a44) if a44 is not None else detect_key_file(path))[0]
    except Exception:  # noqa: BLE001
        detected_key = _detect_key(y)

    # Curvas de volumen y bandas
    mi = np.sqrt((S[(freqs >= 200) & (freqs < 2500)] ** 2).sum(axis=0))
    hi = np.sqrt((S[freqs >= 2500] ** 2).sum(axis=0))
    tot = lo + mi + hi + 1e-9
    bands = np.clip(np.stack([lo, mi, hi], axis=1) / tot[:, None] * 1.6, 0, 1).astype(np.float32)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    n = min(len(rms), len(bands))
    db_ = 20 * np.log10(rms[:n] + 1e-9)
    height = np.clip((db_ + 36) / 33, 0, 1).astype(np.float32)
    rate = SR / HOP

    beats, downbeats = _fit_grid(onset, lo, bpm, dur)
    curves = Curves(rate, height, bands[:n], beats, downbeats if len(downbeats) >= 8 else None)
    f = features.compute(curves, bpm)
    wave = features.waveform(curves)
    wave["downbeats"] = [round(float(x), 3) for x in downbeats]
    return {
        "path": path,
        "meta": meta,
        "duration": dur,
        "bpm": round(bpm, 2),
        "key": tag_key or detected_key,
        "key_source": "tag" if tag_key else ("batea" if detected_key else None),
        "key_detected": detected_key,
        "key_ver": _key_version() if (not tag_key and detected_key) else None,
        "features": f.__dict__ if f else None,
        "waveform": wave,
    }


def scan_folder(folder: str) -> list[str]:
    out = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if not name.startswith("._") and Path(name).suffix.lower() in config.AUDIO_EXTS:
                out.append(os.path.join(root, name))
    return sorted(out)


def run_folder(job: Job, folder: str, reanalyze: bool = False) -> dict:
    job.update(0.01, "Buscando archivos…")
    files = scan_folder(folder)
    with db.conn() as c:
        known = {r["path"]: (r["id"], r["analyzed"], r["source"]) for r in c.execute("SELECT id, path, analyzed, source FROM tracks WHERE path IS NOT NULL")}
    in_rb = sum(1 for p in files if p in known and known[p][2] != "local")      # de rekordbox, Traktor…: lo analiza su programa
    todo = [p for p in files if not (p in known and known[p][2] != "local")
            and (reanalyze or p not in known or known[p][1] is None)]
    job.update(0.03, f"{len(todo)} temas para analizar ({in_rb} ya están en rekordbox)")
    res = run_paths(job, todo) if todo else {"analizados": 0}
    return {"archivos": len(files), **res, "ya en rekordbox": in_rb}


def low_priority() -> None:
    """Corre en cada proceso de análisis: cede la CPU a todo lo demás."""
    try:
        os.nice(15)
    except OSError:
        pass


def run_paths(job: Job, todo: list[str]) -> dict:
    """Analiza una lista de archivos (nuevos o ya cargados en Batea sin analizar)."""
    from . import rbsync

    with db.conn() as c:
        known = {r["path"]: r["id"] for r in c.execute("SELECT id, path FROM tracks WHERE path IS NOT NULL AND source='local'")}
    ok, errors = 0, []
    # de a un tema y con prioridad baja: analizar no puede trabar la computadora
    with ProcessPoolExecutor(max_workers=1, initializer=low_priority) as pool:
        futs = {pool.submit(analyze_file, p): p for p in todo}
        for i, fut in enumerate(as_completed(futs)):
            if job.cancelled:
                for f in futs:
                    f.cancel()
                break
            p = futs[fut]
            try:
                res = fut.result()
                _store(res, known.get(p))
                ok += 1
            except Exception as e:  # noqa: BLE001
                errors.append(f"{Path(p).name}: {e}")
                with db.conn() as c:   # no reintentar en cada búsqueda
                    c.execute("UPDATE tracks SET analyzed='error' WHERE path=? AND source='local' AND analyzed IS NULL", (p,))
            job.update(0.03 + 0.95 * (i + 1) / len(todo), f"Analizado {i + 1}/{len(todo)} · {Path(p).name}")

    with db.conn() as c:
        rbsync.recompute_energy(c)
    return {"analizados": ok, "errores": len(errors), "detalle_errores": errors[:20]}


# ---------------------------------------------------------------- fila de espera
# Todo lo que el usuario pide analizar (un tema, varios, una carpeta) entra en una sola fila
# que se procesa de a un tema por vez. Pedir más mientras corre lo suma a la misma fila.
_queue: list[str] = []
_qlock = threading.Lock()
_draining = False
_current: Job | None = None
_now: str | None = None          # el que se está analizando en este momento


def queued() -> tuple[str | None, list[str]]:
    with _qlock:
        return _now, list(_queue)


def enqueue(paths: list[str], label: str = "Analizando temas") -> Job:
    global _draining, _current
    for _ in range(20):
        with _qlock:
            for p in paths:
                if p not in _queue:
                    _queue.append(p)
            if _draining and _current is not None:
                return _current
            prev = _current
            job = jobs.start("analyze", label, _drain)
            if job is not prev:          # si no, el análisis anterior está terminando: reintentar
                _draining, _current = True, job
                return job
        time.sleep(0.05)
    raise RuntimeError("No pude empezar el análisis")


def _drain(job: Job) -> dict:
    global _draining, _now
    from . import rbsync

    ok, errors, done = 0, [], 0
    try:
        with ProcessPoolExecutor(max_workers=1, initializer=low_priority) as pool:
            while True:
                with _qlock:
                    if job.cancelled:
                        _queue.clear()
                    if not _queue:
                        _draining = False
                        break
                    p = _now = _queue.pop(0)
                    total = done + 1 + len(_queue)
                job.update(0.02 + 0.96 * done / total, f"Analizando {done + 1}/{total} · {Path(p).name}")
                try:
                    res = pool.submit(analyze_file, p).result()
                    with db.conn() as c:
                        r = c.execute("SELECT id FROM tracks WHERE path=? AND source='local'", (p,)).fetchone()
                    _store(res, r[0] if r else None)
                    ok += 1
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{Path(p).name}: {e}")
                    with db.conn() as c:
                        c.execute("UPDATE tracks SET analyzed='error' WHERE path=? AND source='local'", (p,))
                done += 1
    finally:
        with _qlock:
            _draining, _now = False, None
    with db.conn() as c:
        rbsync.recompute_energy(c)
    msg = f"{ok} {'tema analizado' if ok == 1 else 'temas analizados'}" + (f" · {len(errors)} no se pudieron leer" if errors else "")
    return {"analizados": ok, "errores": len(errors), "detalle_errores": errors[:20], "mensaje": msg}


def _store(res: dict, existing_id: int | None) -> int:
    from . import rbsync

    m = res["meta"]
    title = m.get("title") or Path(res["path"]).stem
    year = None
    if m.get("year"):
        try:
            year = int(str(m["year"])[:4])
        except ValueError:
            pass
    row = dict(
        path=res["path"], title=title, artist=m.get("artist"), album=m.get("album"), genre=m.get("genre"),
        label=m.get("label"), remixer=m.get("remixer"), bpm=float(res["bpm"]) if res["bpm"] else None, key=res["key"],
        key_source=res.get("key_source"), key_ver=res.get("key_ver"),
        key_raw=m.get("key_tag") or res.get("key_detected"), duration=float(res["duration"]) if res["duration"] else None, year=year,
        bitrate=m.get("bitrate"), filetype=Path(res["path"]).suffix.lower().lstrip("."),
        artwork=m.get("artwork_file"), analysis_ver=ANALYSIS_VERSION,
    )
    from .discover import file_date as _file_date  # import diferido: evita ciclos
    with db.conn() as c:
        if existing_id:
            mu = c.execute("SELECT meta_user FROM tracks WHERE id=?", (existing_id,)).fetchone()
            if mu and mu[0]:   # datos editados a mano: el análisis no los pisa
                for k in ("title", "artist", "album", "genre", "label", "remixer", "year"):
                    row.pop(k, None)
            else:              # sin etiqueta en el archivo se conserva lo que ya había (p. ej. artista y título sacados del nombre)
                for k in ("title", "artist", "album", "genre", "label", "remixer"):
                    if not m.get(k):
                        row.pop(k, None)
                if year is None:
                    row.pop("year", None)
            c.execute(f"UPDATE tracks SET {', '.join(f'{k}=?' for k in row)} WHERE id=?", [*row.values(), existing_id])
            tid, first = existing_id, False
        else:
            cur = c.execute(
                f"INSERT INTO tracks({', '.join(row)}, source, date_added) VALUES ({', '.join('?' * len(row))}, 'local', ?)",
                [*row.values(), _file_date(res["path"])],
            )
            tid, first = cur.lastrowid, True
        if res["features"]:
            f = features.Features(**res["features"])
            # el título del tag suele omitir "(Acapella)", "(Extended Mix)"… que sí está en el nombre del archivo
            rbsync.store_features(c, tid, f, "audio", first, f"{title} {Path(res['path']).stem}", rbsync._tag_id_map(c))
        else:
            c.execute("UPDATE tracks SET analyzed='audio' WHERE id=?", (tid,))
    waveform_cache(tid).write_text(json.dumps(res["waveform"]))
    return tid
