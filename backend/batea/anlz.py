"""Lectura rápida de los archivos de análisis de rekordbox (USBANLZ).

Se parsean a mano (numpy) en vez de con construct porque es ~30x más rápido,
lo que permite procesar una librería de 20k temas en menos de un minuto.
Estos archivos están en el disco interno, así que sirven aunque el disco
con la música esté desconectado.

Formato: https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import config


def _tags(buf: bytes) -> dict[str, tuple[int, int, int]]:
    """fourcc -> (offset, len_header, len_tag)"""
    out: dict[str, tuple[int, int, int]] = {}
    if buf[:4] != b"PMAI":
        return out
    pos = struct.unpack_from(">I", buf, 4)[0]
    n = len(buf)
    while pos + 12 <= n:
        fourcc = buf[pos:pos + 4].decode("ascii", "replace")
        lh, lt = struct.unpack_from(">II", buf, pos + 4)
        if lt < 12 or pos + lt > n:
            break
        out.setdefault(fourcc, (pos, lh, lt))
        pos += lt
    return out


@dataclass
class Curves:
    """Curvas a ~150 cuadros/seg: volumen 0..1 y proporción de graves/medios/agudos."""
    rate: float
    height: np.ndarray        # (n,)
    bands: np.ndarray         # (n, 3) low/mid/high en 0..1
    beats: np.ndarray | None  # tiempos (s) de cada beat
    downbeats: np.ndarray | None


def _read(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def resolve_dir(anlz_path: str | None) -> Path | None:
    if not anlz_path:
        return None
    p = config.RB_SHARE / anlz_path.lstrip("/")
    return p.parent


def read_beatgrid(dat: bytes) -> tuple[np.ndarray, np.ndarray] | None:
    tags = _tags(dat)
    if "PQTZ" not in tags:
        return None
    off, lh, lt = tags["PQTZ"]
    count = (lt - lh) // 8
    if count <= 0:
        return None
    raw = np.frombuffer(dat, dtype=np.dtype([("beat", ">u2"), ("tempo", ">u2"), ("time", ">u4")]), count=count, offset=off + lh)
    times = raw["time"].astype(np.float64) / 1000.0
    down = times[raw["beat"] == 1]
    return times, down


def read_curves(anlz_dir: Path) -> Curves | None:
    ext = _read(anlz_dir / "ANLZ0000.EXT")
    dat = _read(anlz_dir / "ANLZ0000.DAT")
    beats = down = None
    if dat:
        bg = read_beatgrid(dat)
        if bg:
            beats, down = bg

    if ext:
        tags = _tags(ext)
        if "PWV5" in tags:
            off, lh, lt = tags["PWV5"]
            n = struct.unpack_from(">I", ext, off + 16)[0]
            n = min(n, (lt - lh) // 2)
            if n > 0:
                v = np.frombuffer(ext, dtype=">u2", count=n, offset=off + lh).astype(np.uint32)
                r = (v >> 13) & 7
                g = (v >> 10) & 7
                b = (v >> 7) & 7
                h = ((v >> 2) & 31) / 31.0
                bands = np.stack([r, g, b], axis=1).astype(np.float32) / 7.0
                return Curves(150.0, h.astype(np.float32), bands, beats, down)

    if dat:  # Fallback: preview de 400 columnas (monocromo)
        tags = _tags(dat)
        if "PWAV" in tags:
            off, lh, lt = tags["PWAV"]
            n = (lt - lh)
            v = np.frombuffer(dat, dtype=np.uint8, count=n, offset=off + lh)
            h = (v & 31) / 31.0
            white = (v >> 5) / 7.0
            bands = np.stack([1 - white, np.full_like(white, 0.5), white], axis=1).astype(np.float32)
            dur = float(beats[-1]) if beats is not None and len(beats) else 0
            rate = n / dur if dur > 0 else 1.0
            return Curves(rate, h.astype(np.float32), bands, beats, down)
    return None
