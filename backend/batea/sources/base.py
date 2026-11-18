"""Contrato común de las fuentes (rekordbox, Traktor, Serato, …).

Cada programa tiene un adaptador que:
  1. detecta si está en esta Mac sin leer nada (`discover`, solo `exists()`),
  2. hace una copia consistente de sus archivos (`snapshot`), nunca lee el original en vivo,
  3. lee la copia y devuelve un `SourceDump` con temas, cajas, sesiones y reproducciones.

Después del adaptador, Batea no sabe de qué programa vino cada cosa: el importador
(`sources/importer.py`) fusiona el dump en batea.db. Ningún adaptador escribe jamás
en los archivos del programa.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

# kinds conocidos; el orden es la precedencia por defecto al elegir qué valor mostrar
KINDS = ("rekordbox", "traktor", "serato", "engine", "vdj")
LABELS = {"rekordbox": "rekordbox", "traktor": "Traktor", "serato": "Serato", "engine": "Engine DJ", "vdj": "VirtualDJ"}
SHORT = {"rekordbox": "RB", "traktor": "TK", "serato": "SE", "engine": "EN", "vdj": "VD"}


@dataclass
class SourceLocation:
    """Un lugar concreto donde se encontró la librería (una versión de Traktor, una base de Serato por disco…)."""
    path: Path                     # archivo principal (collection.nml, master.db, master.sqlite, carpeta _Serato_)
    version: str | None = None     # "4.5.1", "7", "5.1"… si se puede saber sin abrir nada pesado
    volume: str | None = None      # nombre del disco si no es el interno
    modified: float | None = None  # mtime del archivo principal (para "guardado el 12/11")


@dataclass
class SourceInfo:
    """Lo que devuelve la detección: alcanza para la pantalla de bienvenida y el panel Fuentes."""
    kind: str
    label: str
    found: bool
    locations: list[SourceLocation] = field(default_factory=list)
    version: str | None = None
    detail: str | None = None       # texto corto para la UI: "guardado el 12/11", "también en el disco MUSICA"
    app_running: bool = False       # el programa está abierto: los datos pueden ser del último guardado


@dataclass
class Cue:
    kind: str                       # memory | hot | loop | load | fade_in | fade_out | grid
    start_ms: float
    end_ms: float | None = None     # loops
    slot: int | None = None         # hot cue 0-7…
    name: str | None = None
    color: str | None = None        # "#RRGGBB"


@dataclass
class GridMarker:
    start_ms: float
    bpm: float


@dataclass
class SrcTrack:
    ext_id: str                     # id estable dentro de la fuente (en Traktor: VOLUME+DIR+FILE tal cual)
    path: str | None                # ruta POSIX real ya resuelta (puede no existir si el disco no está)
    path_raw: str | None = None     # como lo guarda el programa
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    label: str | None = None
    genre: str | None = None
    remixer: str | None = None
    comment: str | None = None
    bpm: float | None = None
    key_raw: str | None = None      # como lo guarda el programa ("14", "Dm", "7A"…)
    key_camelot: str | None = None  # "7A" (usar batea.keys)
    duration: float | None = None   # segundos
    rating: float | None = None     # 0-5 normalizado
    color: str | None = None        # "#RRGGBB" o nombre
    play_count: int | None = None
    date_added: str | None = None   # ISO "YYYY-MM-DD"
    last_played: str | None = None  # ISO
    bitrate: int | None = None      # kbps
    year: int | None = None
    filesize: int | None = None     # bytes
    cues: list[Cue] = field(default_factory=list)
    grid: list[GridMarker] = field(default_factory=list)


@dataclass
class SrcCrate:
    ext_id: str                     # estable dentro de la fuente
    name: str
    kind: str                       # folder | playlist | smart
    parent_ext_id: str | None = None
    position: int = 0
    track_ext_ids: list[str] = field(default_factory=list)  # en orden
    rules_raw: str | None = None    # smartlists: reglas tal cual, sin evaluar


@dataclass
class SrcPlay:
    track_ext_id: str | None        # None si el tema ya no está en la colección
    position: int                   # orden dentro de la sesión
    start: str | None = None        # ISO con hora
    duration_s: float | None = None
    deck: int | None = None
    on_air: bool | None = None      # salió por el master (Traktor PLAYEDPUBLIC, Serato played)
    # copia de los datos al momento de tocarlo: sirve aunque el archivo ya no esté
    title: str | None = None
    artist: str | None = None
    path: str | None = None
    bpm: float | None = None
    key_camelot: str | None = None


@dataclass
class SrcSession:
    ext_id: str
    name: str
    start: str | None = None        # ISO
    plays: list[SrcPlay] = field(default_factory=list)


@dataclass
class SourceDump:
    kind: str
    version: str | None = None
    tracks: list[SrcTrack] = field(default_factory=list)
    crates: list[SrcCrate] = field(default_factory=list)
    sessions: list[SrcSession] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class LibrarySource(Protocol):
    kind: str

    def discover(self) -> SourceInfo: ...
    def snapshot(self, loc: SourceLocation, cache_dir: Path) -> Path: ...
    def read(self, snap: Path, loc: SourceLocation) -> SourceDump: ...
