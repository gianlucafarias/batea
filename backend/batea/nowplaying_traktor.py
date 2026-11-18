"""Qué suena en Traktor Pro 3/4, a partir de Broadcasting y los archivos abiertos."""
from __future__ import annotations

import os
import sqlite3
import subprocess
import threading
import time
import unicodedata

from . import config, traktor_broadcast
from .live_base import LiveReading, PlayRef
from .sources.traktor import _FACTORY_DIRS

APP = "traktor"
LABEL = "Traktor"
_NOTE = "Activá Broadcasting en Traktor para saber qué suena"
_PROCESS_PATTERN = r"(^|/)traktor[^/]*[.]app/Contents/MacOS/traktor|^traktor( pro)?( [34])?$"
_IGNORE_PREFIXES = ("/applications/", "/system/", "/library/", "/usr/", "/private/var/")
_AUDIO_EXTS = config.AUDIO_EXTS | {".aac", ".oga", ".opus", ".wma"}
_SCAN_INTERVAL = 2.0


def _traktor_pids() -> tuple[int, ...]:
    try:
        result = subprocess.run(
            ["/usr/bin/pgrep", "-if", _PROCESS_PATTERN], capture_output=True, text=True, timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ()
    return tuple(sorted(int(pid) for pid in result.stdout.split() if pid.isascii() and pid.isdigit()))


def running() -> bool:
    return bool(_traktor_pids())


def _open_audio_files(pids: tuple[int, ...]) -> list[str] | None:
    try:
        result = subprocess.run(
            ["/usr/sbin/lsof", "-n", "-P", "-p", ",".join(map(str, pids)), "-Fn"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    files = {}
    for line in result.stdout.splitlines():
        if not line.startswith("n/"):
            continue
        path = line[1:]
        lower_path = path.casefold()
        if os.path.splitext(lower_path)[1] not in _AUDIO_EXTS:
            continue
        if lower_path.startswith(_IGNORE_PREFIXES) or any(part in _FACTORY_DIRS for part in lower_path.split("/")[:-1]):
            continue
        if ".app/contents/" not in lower_path:
            files[path] = None
    return list(files)


class _OpenAudio:
    """Los archivos abiertos son una pista de carga pendiente de verificar en Traktor real."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pids: tuple[int, ...] = ()
        self._files: list[str] = []
        self._last_scan = float("-inf")
        self._activity = 0.0

    def read(self, pids: tuple[int, ...]) -> tuple[list[PlayRef], float]:
        with self._lock:
            if pids != self._pids:
                self._files.clear()
                self._activity = 0.0
                self._pids = pids
            tick = time.monotonic()
            if pids and tick - self._last_scan >= _SCAN_INTERVAL:
                self._last_scan = tick
                files = _open_audio_files(pids)
                if files is not None:
                    seen, current = set(self._files), set(files)
                    if seen != current:
                        self._files = [path for path in self._files if path in current]
                        # Si aparecieron juntos, toma el orden de descriptores de lsof.
                        self._files.extend(path for path in files if path not in seen)
                        self._activity = time.time()
            return [PlayRef(path=path) for path in reversed(self._files)], self._activity


_open_audio = _OpenAudio()


def _normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def _paths_for_tracks(
    c: sqlite3.Connection, tracks: tuple[traktor_broadcast.BroadcastTrack, ...],
) -> dict[tuple[str, str], str]:
    keys = {(_normalized(track.artist), _normalized(track.title)) for track in tracks if track.artist and track.title}
    if not keys:
        return {}
    titles = {title for _, title in keys}
    paths: dict[tuple[str, str], str] = {}
    ambiguous = set()
    for path, artist, title in c.execute("SELECT path, artist, title FROM tracks WHERE path <> '' AND artist <> '' AND title <> ''"):
        title_key = _normalized(title)
        if title_key not in titles:
            continue
        key = (_normalized(artist), title_key)
        if key in keys and paths.setdefault(key, path) != path:
            ambiguous.add(key)
    for key in ambiguous:
        del paths[key]
    return paths


def read(c: sqlite3.Connection) -> LiveReading | None:
    pids = _traktor_pids()
    loaded, loaded_at = _open_audio.read(pids)
    if not pids:
        return None

    enabled, tracks = traktor_broadcast.playback()
    paths = _paths_for_tracks(c, tracks)
    played = [
        PlayRef(path=paths.get((_normalized(track.artist), _normalized(track.title))),
                artist=track.artist or None, title=track.title or None, start=track.at)
        for track in tracks
    ]
    now = played[-1] if enabled and played else None
    return LiveReading(
        app=APP,
        now=now,
        played=played,
        loaded=loaded,
        activity=max(loaded_at, tracks[-1].at if tracks else 0.0),
        note=_NOTE if now is None else None,
    )
