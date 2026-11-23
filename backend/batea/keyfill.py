"""Completar las tonalidades que rekordbox no tiene.

Usa el detector de Essentia con el perfil "bgate" (pensado para música electrónica); si Essentia no está
(versión Intel), un detector con librosa. Antes de completar, se mide contra temas que SÍ tienen tono en
rekordbox, para mostrar cuánto coincide en tu propia librería. Lo más fiel a la cabina sigue siendo que
rekordbox analice el tono: Batea lo toma de ahí en cuanto existe.

Los tonos estimados con un detector anterior (key_ver) se vuelven a calcular al completar.
"""
from __future__ import annotations

import json
import os
import random
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime

from .analysis import low_priority
from . import db, keys, universe
from .api_helpers import is_online, reset_online_cache
from .jobs import Job

VALIDATION_SAMPLE = 40


# Perfiles de Temperley, para el detector de respaldo
_TP_MAJ = (5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0)
_TP_MIN = (5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0)


def _detect_key_librosa(path: str) -> tuple[str | None, float]:
    """Respaldo cuando Essentia no está (la versión para Macs Intel no la incluye).

    Cromagrama CQT de la parte armónica + perfiles de Temperley. Medido sobre 120 temas de la librería
    contra rekordbox: ~56% exacto y ~73% compatible (Essentia: ~67% y ~83%)."""
    import librosa
    import numpy as np

    sr = 22050
    y, _ = librosa.load(path, sr=sr, mono=True)
    if len(y) < sr * 10:
        return None, 0.0
    if len(y) > sr * 600:                  # sets largos: alcanza con 10 minutos del medio
        mid = len(y) // 2
        y = y[mid - sr * 300: mid + sr * 300]
    y = librosa.effects.harmonic(y, margin=3)
    prof = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=2048, bins_per_octave=36).mean(axis=1)
    if not np.isfinite(prof).all() or prof.sum() == 0:
        return None, 0.0
    best, best_r = None, -2.0
    for pc in range(12):
        for minor, tmpl in ((False, _TP_MAJ), (True, _TP_MIN)):
            r = float(np.corrcoef(prof, np.roll(np.array(tmpl), pc))[0, 1])
            if r > best_r:
                best_r, best = r, (pc, minor)
    return (keys.camelot_from_pitch(*best), max(best_r, 0.0)) if best else (None, 0.0)


def detect_key_file(path: str) -> tuple[str | None, float]:
    """(Camelot, confianza 0..1). Corre en un proceso aparte."""
    try:
        import essentia
    except ImportError:
        return _detect_key_librosa(path)

    essentia.log.infoActive = False
    essentia.log.warningActive = False
    import essentia.standard as es

    return detect_key_audio(es.MonoLoader(filename=path, sampleRate=44100)())


KEY_VERSION = 1   # sube cuando cambie el detector: los tonos estimados con uno anterior se recalculan (key_ver)


def detect_key_audio(audio) -> tuple[str | None, float]:
    """Igual que detect_key_file, con el audio ya cargado a 44100 Hz (Essentia).

    Probado contra rekordbox en 300 temas de una librería real: 52% exacto, 72% compatible. Plantillas
    aprendidas de rekordbox (52%) y la red de madmom (55%) no mejoraron lo suficiente como para cambiarlo:
    el tono de un tema de techno es ambiguo y cada programa elige distinto."""
    import essentia.standard as es

    if len(audio) < 44100 * 10:
        return None, 0.0
    if len(audio) > 44100 * 600:          # sets largos: alcanza con 10 minutos del medio
        mid = len(audio) // 2
        audio = audio[mid - 44100 * 300: mid + 44100 * 300]
    key, scale, strength = es.KeyExtractor(profileType="bgate")(audio)
    return keys.to_camelot(key + ("m" if scale == "minor" else "")), float(strength)


def _safe(path: str) -> tuple[str | None, float, str | None]:
    try:
        k, s = detect_key_file(path)
        return k, s, None
    except Exception as e:  # noqa: BLE001
        return None, 0.0, f"{type(e).__name__}: {e}"


def current_version() -> int:
    return KEY_VERSION


def _todo_sql() -> tuple[str, list]:
    """Temas sin tono, o con un tono (o un "no se pudo") de un detector anterior."""
    return ("((t.key IS NULL AND COALESCE(t.key_source,'')!='none') "
            "OR (t.key_source IN ('batea','none') AND COALESCE(t.key_ver,1) < ?))", [current_version()])


def status(c) -> dict:
    uni = universe.clause(c)
    where, params = ("AND " + uni[0], uni[1]) if uni else ("", [])
    todo, tp = _todo_sql()
    rows = c.execute(f"SELECT t.path, t.key FROM tracks t WHERE {todo} AND t.hidden=0 {where}", tp + params).fetchall()
    total = c.execute(f"SELECT COUNT(*) FROM tracks t WHERE t.hidden=0 {where}", params).fetchone()[0]
    est = c.execute(f"SELECT COUNT(*) FROM tracks t WHERE t.key_source='batea' AND t.hidden=0 {where}", params).fetchone()[0]
    acc = db.get_meta(c, "key_accuracy")
    return {
        "total": total,
        "missing": len(rows),
        "missing_online": sum(1 for r in rows if is_online(r["path"])),
        "outdated": sum(1 for r in rows if r["key"]),     # ya tenían un tono estimado con el detector anterior
        "estimated": est,
        "accuracy": json.loads(acc) if acc else None,
    }


def run(job: Job) -> dict:
    reset_online_cache()
    with db.conn() as c:
        uni = universe.clause(c)
        where, params = ("AND " + uni[0], uni[1]) if uni else ("", [])
        tq, tp = _todo_sql()
        todo = [(r["id"], r["path"]) for r in c.execute(
            f"SELECT t.id, t.path FROM tracks t WHERE {tq} AND t.hidden=0 {where}", tp + params)]
        known = [(r["id"], r["path"], r["key"]) for r in c.execute(
            f"SELECT t.id, t.path, t.key FROM tracks t WHERE t.key IS NOT NULL AND t.key_source='rekordbox' {where}", params)]
    todo = [(i, p) for i, p in todo if is_online(p)]
    known = [k for k in known if is_online(k[1])]
    random.Random(7).shuffle(known)
    known = known[:VALIDATION_SAMPLE]

    workers = 1          # de a un tema, con prioridad baja: no trabar la computadora
    result: dict = {"completados": 0, "sin_resultado": 0, "errores": 0}
    total = len(known) + len(todo)
    if total == 0:
        return {**result, "mensaje": "No hay temas sin tono con el archivo disponible"}
    done = 0

    with ProcessPoolExecutor(max_workers=workers, initializer=low_priority) as pool:
        # 1) medir contra rekordbox
        if known:
            exact = compat = n = 0
            futs = {pool.submit(_safe, p): truth for _, p, truth in known}
            for fut in as_completed(futs):
                k, _, err = fut.result()
                done += 1
                job.update(done / total, f"Midiendo precisión contra rekordbox {done}/{len(known)}")
                if err or not k:
                    continue
                n += 1
                score = keys.compatibility(futs[fut], k)[0]
                exact += score == 1.0
                compat += score >= 0.85
            if n:
                acc = {"sample": n, "exact": round(exact / n, 3), "compatible": round(compat / n, 3),
                       "date": datetime.now().isoformat(timespec="seconds")}
                result["precision"] = acc
                with db.conn() as c:
                    db.set_meta(c, "key_accuracy", json.dumps(acc))

        # 2) completar
        futs = {pool.submit(_safe, p): tid for tid, p in todo}
        batch: list[tuple[str, int]] = []
        none: list[tuple[int]] = []
        for fut in as_completed(futs):
            if job.cancelled:
                for f in futs:
                    f.cancel()
                result["cancelado"] = True
                break
            k, _, err = fut.result()
            done += 1
            if err:
                result["errores"] += 1
            elif k:
                batch.append((k, futs[fut]))
                result["completados"] += 1
            else:
                result["sin_resultado"] += 1
                none.append((futs[fut],))
            if len(batch) >= 25:
                _flush(batch)
            job.update(done / total, f"Tonalidades {done - len(known)}/{len(todo)}")
        _flush(batch)
        if none:
            with db.conn() as c:
                c.executemany("UPDATE tracks SET key=NULL, key_source='none', key_ver=? WHERE id=? AND (key IS NULL OR key_source='batea')",
                              [(current_version(), i) for (i,) in none])
    return result


def _flush(batch: list[tuple[str, int]]) -> None:
    if not batch:
        return
    with db.conn() as c:
        c.executemany(f"UPDATE tracks SET key=?, key_source='batea', key_ver={current_version()} "
                      "WHERE id=? AND (key IS NULL OR key_source IN ('batea','none'))", batch)
    batch.clear()
