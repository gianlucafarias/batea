"""Tonalidades: normalización a Camelot y compatibilidad armónica."""
from __future__ import annotations

import re

_MINOR = ["G#m", "D#m", "A#m", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m"]
_MAJOR = ["B", "F#", "C#", "G#", "D#", "A#", "F", "C", "G", "D", "A", "E"]
_ENHARMONIC = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#", "Cb": "B", "Fb": "E", "E#": "F", "B#": "C"}

_TO_CAMELOT: dict[str, str] = {}
for i, k in enumerate(_MINOR):
    _TO_CAMELOT[k] = f"{i + 1}A"
for i, k in enumerate(_MAJOR):
    _TO_CAMELOT[k] = f"{i + 1}B"

# Para el análisis propio: índice de clase de altura (C=0) -> Camelot
PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def camelot_from_pitch(pc: int, minor: bool) -> str:
    name = PITCHES[pc % 12] + ("m" if minor else "")
    return _TO_CAMELOT[name]


def to_camelot(raw: str | None) -> str | None:
    """Convierte cualquier notación que guarde rekordbox (8A, Am, A#m, Amin, 1m, 1d...) a Camelot."""
    if not raw:
        return None
    s = raw.strip().replace(" ", "")
    m = re.fullmatch(r"(\d{1,2})([ABab])", s)
    if m:
        n = int(m.group(1))
        return f"{n}{m.group(2).upper()}" if 1 <= n <= 12 else None
    m = re.fullmatch(r"(\d{1,2})([dm])", s)  # Open Key: 1m = Am = 8A, 1d = C = 8B
    if m:
        n = int(m.group(1))
        if not 1 <= n <= 12:
            return None
        cam = (n + 6) % 12 + 1
        return f"{cam}{'A' if m.group(2) == 'm' else 'B'}"
    m = re.fullmatch(r"([A-Ga-g])([#b♯♭]?)(m|min|minor|maj|major)?", s)
    if not m:
        return None
    root = m.group(1).upper() + m.group(2).replace("♯", "#").replace("♭", "b")
    root = _ENHARMONIC.get(root, root)
    minor = (m.group(3) or "") in ("m", "min", "minor")
    return _TO_CAMELOT.get(root + ("m" if minor else ""))


def parse(cam: str | None) -> tuple[int, str] | None:
    if not cam:
        return None
    m = re.fullmatch(r"(\d{1,2})([AB])", cam)
    return (int(m.group(1)), m.group(2)) if m else None


def _dist(a: int, b: int) -> int:
    d = abs(a - b) % 12
    return min(d, 12 - d)


def compatibility(k1: str | None, k2: str | None) -> tuple[float, str]:
    """Puntaje 0..1 y descripción corta de la transición armónica."""
    p1, p2 = parse(k1), parse(k2)
    if not p1 or not p2:
        return 0.5, ""
    (n1, l1), (n2, l2) = p1, p2
    d = _dist(n1, n2)
    if d == 0 and l1 == l2:
        return 1.0, "misma tonalidad"
    if d == 1 and l1 == l2:
        return 0.9, "tonalidad vecina"
    if d == 0:
        return 0.85, "relativa mayor/menor"
    if d == 2 and l1 == l2:
        return 0.55, "salto de energía (+2)"
    if d == 1:
        return 0.5, "diagonal"
    return 0.15, "choque armónico"
