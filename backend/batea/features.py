"""Rasgos derivados de las curvas de volumen/bandas: energía, intro, outro, breaks y waveform."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .anlz import Curves


@dataclass
class Features:
    energy_raw: float
    intro_bars: int
    outro_bars: int
    breaks: int
    longest_break: int
    duration: float


def _bar_edges(c: Curves, bpm: float | None) -> np.ndarray:
    dur = len(c.height) / c.rate
    if c.downbeats is not None and len(c.downbeats) >= 8:
        edges = np.asarray(c.downbeats, dtype=np.float64)
        if edges[0] > 0.5:
            edges = np.concatenate([[0.0], edges])
        return np.concatenate([edges, [dur]])
    bar = 240.0 / bpm if bpm and bpm > 40 else 2.0
    return np.arange(0, dur + bar, bar)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    runs, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def compute(c: Curves, bpm: float | None) -> Features | None:
    n = len(c.height)
    if n < 50:
        return None
    edges = _bar_edges(c, bpm)
    idx = np.clip((edges * c.rate).astype(int), 0, n)
    loud, low, high = [], [], []
    for a, b in zip(idx[:-1], idx[1:]):
        if b <= a:
            continue
        h = c.height[a:b]
        bd = c.bands[a:b]
        loud.append(float(h.mean()))
        low.append(float((h * bd[:, 0]).mean()))
        high.append(float((h * bd[:, 2]).mean()))
    if len(loud) < 8:
        return None
    L, Lo, Hi = np.array(loud), np.array(low), np.array(high)
    nb = len(L)
    body = slice(int(nb * 0.2), max(int(nb * 0.8), int(nb * 0.2) + 1))
    lb = float(np.median(L[body])) or 1e-6
    lob = float(np.median(Lo[body])) or 1e-6
    # "lleno" = volumen de cuerpo Y graves presentes (el kick está)
    full = (L >= 0.85 * lb) & (Lo >= 0.7 * lob)

    intro = next((i for i in range(nb - 3) if full[i:i + 4].all()), 0)
    outro = next((i for i in range(nb - 3) if full[nb - 4 - i:nb - i].all()), 0)

    # break = baja el volumen o se va el bombo (en techno los pads suelen seguir arriba)
    quiet = (L < 0.6 * lb) | (Lo < 0.45 * lob)
    breaks = [(a, b) for a, b in _runs(quiet) if a > intro and b < nb - outro and b - a >= 4]
    longest = max((b - a for a, b in breaks), default=0)

    bpm_f = float(np.clip(((bpm or 125) - 110) / 40, 0, 1))
    energy = (
        0.40 * lb
        + 0.15 * float(np.median(Lo[body]))
        + 0.15 * float(np.median(Hi[body]))
        + 0.15 * float(full.mean())
        + 0.15 * bpm_f
    )
    return Features(
        energy_raw=round(energy, 5),
        intro_bars=int(intro),
        outro_bars=int(outro),
        breaks=len(breaks),
        longest_break=int(longest),
        duration=n / c.rate,
    )


def waveform(c: Curves, cols: int = 720) -> dict:
    """Waveform compacta para el frontend: alturas y color por columna."""
    n = len(c.height)
    cols = min(cols, n)
    idx = np.linspace(0, n, cols + 1).astype(int)
    hs, rs, gs, bs = [], [], [], []
    for a, b in zip(idx[:-1], idx[1:]):
        b = max(b, a + 1)
        h = c.height[a:b]
        bd = c.bands[a:b]
        hs.append(int(round(float(h.max()) * 255)))
        w = h[:, None] + 1e-6
        m = (bd * w).sum(axis=0) / w.sum()
        rs.append(int(m[0] * 255)); gs.append(int(m[1] * 255)); bs.append(int(m[2] * 255))
    return {"duration": n / c.rate, "h": hs, "low": rs, "mid": gs, "high": bs}


def auto_structure_tags(f: Features) -> list[str]:
    tags = []
    if f.intro_bars >= 32:
        tags.append("Intro larga")
    elif 0 < f.intro_bars <= 8:
        tags.append("Intro corta")
    if f.outro_bars >= 32:
        tags.append("Outro larga")
    elif 0 < f.outro_bars <= 8:
        tags.append("Outro corta")
    if f.longest_break >= 16:
        tags.append("Break largo")
    elif f.breaks == 0:
        tags.append("Sin break")
    return tags
