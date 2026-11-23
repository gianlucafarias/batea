"""BPM de un tema.

Con Essentia (Macs Apple Silicon) se usa RhythmExtractor2013 "multifeature": sobre 30 temas de
techno/hard techno analizados por rekordbox coincidió en los 30. El detector anterior (tempo de
librosa) se enganchaba en el tresillo o en 4/5 del pulso en los temas duros: 143 → 95,33, 140 → 112.

Sin Essentia (versión Intel) se usa un peine sobre los ataques de graves: en música de baile el
bombo marca cada negra, así que el período que mejor explica el bombo es el pulso.
"""
from __future__ import annotations

import numpy as np

LO_BPM, HI_BPM = 70.0, 200.0


def snap(bpm: float) -> float:
    """rekordbox redondea los temas hechos en computadora: 127,98 → 128."""
    if not bpm or not np.isfinite(bpm):
        return 0.0
    r = round(bpm)
    return float(r) if abs(bpm - r) < 0.1 else round(float(bpm), 2)


def fold(bpm: float, lo: float = 85.0, hi: float = 175.0) -> float:
    if not bpm or bpm <= 0 or not np.isfinite(bpm):
        return 0.0
    while bpm < lo:
        bpm *= 2
    while bpm > hi:
        bpm /= 2
    return bpm


def essentia_bpm(audio44: np.ndarray) -> float:
    import essentia.standard as es

    bpm = float(es.RhythmExtractor2013(method="multifeature", minTempo=60, maxTempo=210)(audio44)[0])
    return snap(fold(bpm))


def _comb(env: np.ndarray, fps: float, bpm: float) -> float:
    """Cuánto se parece la envolvente a sí misma corrida 1, 2 y 4 pulsos."""
    tot = 0.0
    for beats, w in ((1, 1.0), (2, 0.7), (4, 0.5)):
        lag = beats * 60.0 * fps / bpm
        i = int(lag)
        f = lag - i
        if i + 1 >= len(env):
            continue
        a = float(np.dot(env[:-i], env[i:])) if i else 0.0
        b = float(np.dot(env[:-(i + 1)], env[i + 1:]))
        tot += w * ((1 - f) * a + f * b)
    return tot


def _env(lo_flux: np.ndarray, onset: np.ndarray) -> np.ndarray:
    env = lo_flux / (lo_flux.std() or 1) + 0.5 * onset / (onset.std() or 1)
    env = env - env.mean()
    env[env < 0] = 0
    return env


def onset_bpm(lo_flux: np.ndarray, onset: np.ndarray, fps: float) -> float:
    """Pulso por peine de autocorrelación. `lo_flux`: ataques de graves; `onset`: ataques generales."""
    env = _env(lo_flux, onset)
    grid = np.arange(85.0, 175.0, 0.5)
    scores = np.array([_comb(env, fps, b) for b in grid])
    best = float(grid[int(np.argmax(scores))])
    # un pulso más lento también "explica" el peine (cada 2 golpes): preferir el más rápido si casi empata
    dbl = best * 2
    if dbl < 175 and _comb(env, fps, dbl) > 0.8 * scores.max():
        best = dbl
    # afinar a 0,01
    fine = np.arange(best - 0.6, best + 0.6, 0.01)
    fs = np.array([_comb(env, fps, b) for b in fine])
    return snap(float(fine[int(np.argmax(fs))]))


def refine(y: np.ndarray, sr: int, est: float) -> float:
    """La música electrónica tiene tempo fijo: se afina con la autocorrelación a 8 y 16 pulsos
    sobre una envolvente de ataques fina (hop 128), con interpolación parabólica."""
    import librosa

    hop = 128
    fps = sr / hop
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    oenv = oenv - oenv.mean()
    best = est
    for beats in (8, 16):
        lag0 = beats * 60 / est * fps
        lo, hi = int(lag0 * 0.975), int(lag0 * 1.025) + 2
        if hi + 2 >= len(oenv):
            continue
        ac = np.array([np.dot(oenv[:-lag], oenv[lag:]) for lag in range(lo - 1, hi + 2)])
        k = int(np.argmax(ac[1:-1])) + 1
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        den = a - 2 * b + c
        off = 0.5 * (a - c) / den if den != 0 else 0.0
        best = beats * 60 * fps / (lo - 1 + k + off)
    return snap(best) if abs(best - est) / est < 0.03 else snap(est)


def estimate(y: np.ndarray, sr: int, lo: np.ndarray, onset: np.ndarray, hop: int, a44: np.ndarray | None = None) -> float:
    """BPM final. `lo`: energía de graves por cuadro; `onset`: ataques generales (mismo hop).

    Con Essentia se calculan los dos detectores; si no coinciden, gana el pulso que mejor explica el
    bombo (Essentia a veces toma 3/4 del pulso cuando los hi-hats van en tresillo)."""
    fps = sr / hop
    flux = np.maximum(0.0, np.diff(lo, prepend=lo[:1]))
    n = min(len(flux), len(onset))
    flux, onset = flux[:n], onset[:n]
    comb = onset_bpm(flux, onset, fps)
    bpm = comb
    if a44 is not None:
        try:
            ess = essentia_bpm(a44)
        except Exception:  # noqa: BLE001
            ess = 0.0
        if ess:
            if abs(ess - comb) / comb < 0.02:
                bpm = ess
            else:
                env = _env(flux, onset)
                bpm = ess if _comb(env, fps, ess) >= _comb(env, fps, comb) else comb
    try:
        return refine(y, sr, bpm)
    except Exception:  # noqa: BLE001
        return snap(bpm)
