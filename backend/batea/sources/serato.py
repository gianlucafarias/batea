"""Lector de solo lectura para Serato DJ Pro y Lite (SQLite 4/5 y binarios 3.x).

El historial incluye únicamente reproducciones con played=1.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import unicodedata
from collections import Counter, defaultdict
from contextlib import ExitStack, closing
from dataclasses import dataclass, fields
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

from ..db import canon_path as _path_id
from ..keys import to_camelot
from . import serato_tlv as tlv
from .base import LABELS, SourceDump, SourceInfo, SourceLocation, SrcCrate, SrcPlay, SrcSession, SrcTrack

_LEGACY = "database V2"
_MASTER = "master.sqlite"
_ROOT = "root.sqlite"
_LOCATION = "location.sqlite"
_DATABASES = {_LEGACY, _MASTER, _ROOT, _LOCATION}
_SUPPORT = Path("Library/Application Support/Serato/Library")
_MUSIC = Path("Music/_Serato_")
_LEGACY_FILES = ("Subcrates/*.crate", "SmartCrates/*.scrate", "History/Sessions/*.session",
                 "History/history.database", "neworder.pref")


@dataclass(frozen=True)
class _Library:
    path: Path
    root: Path

    @property
    def version(self) -> str:
        return "3.x" if self.path.name == _LEGACY else "4/5"

    @property
    def volume(self) -> str | None:
        return self.root.name or None


def _app_running() -> bool:
    try:
        result = subprocess.run(
            ["pgrep", "-f", r"[S]erato DJ (Pro|Lite)($|[.]app/Contents/MacOS/)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


class SeratoSource:
    kind = "serato"

    def __init__(self, root: Path | None = None, *, volumes: Path | None = None):
        override = root or os.environ.get("BATEA_SERATO_DIR")
        self.override = Path(override).expanduser().absolute() if override else None
        self.directory = self.override
        if self.override and self.override.name in _DATABASES:
            self.directory = self.override.parent
        real_home = Path.home()
        self.home = _library_home(self.directory) if self.directory else real_home
        self.volumes = volumes or (Path("/Volumes") if self.home == real_home else self.home / "Volumes")

    def _candidates(self) -> list[_Library]:
        boot = Path("/")
        libraries = [
            _Library(self.home / _SUPPORT / _MASTER, boot),
            _Library(self.home / _MUSIC / _LEGACY, boot),
        ]
        try:
            mounts = sorted(self.volumes.iterdir())
        except OSError:
            mounts = []
        for mount in mounts:
            if mount.is_dir():
                libraries.extend(_drive_libraries(mount / "_Serato_", mount))

        if self.directory:
            directory = self.directory
            parent = directory.parent if directory.name == "Library" else directory
            legacy_dir = parent if parent.name == "_Serato_" else directory / "_Serato_"
            mount = legacy_dir.parent
            on_external_drive = (
                mount.parent == self.volumes or mount.parent.name == "Volumes"
                or (mount == directory and legacy_dir.is_dir())
                or (mount.name != "Music" and (legacy_dir / "Library" / _LOCATION).is_file())
            )
            volume_root = mount if on_external_drive else boot
            for folder in (directory, directory / "Library"):
                libraries.extend(_Library(folder / name, boot) for name in (_MASTER, _ROOT))
            libraries.extend(_drive_libraries(legacy_dir, volume_root))
            libraries.extend(_Library(directory / name, volume_root) for name in (_LEGACY, _LOCATION))

        # SQLite tiene precedencia sobre las exportaciones de compatibilidad.
        unique = {lib.path: lib for lib in reversed(libraries)}
        return sorted(unique.values(), key=lambda lib: (lib.version == "3.x", lib.root != boot, str(lib.path)))

    def discover(self) -> SourceInfo:
        locations = []
        for library in self._candidates():
            if library.path.name == _ROOT and (library.path.parent / _MASTER).is_file():
                if self.override != library.path:
                    continue
            try:
                status = library.path.stat()
            except OSError:
                continue
            if stat.S_ISREG(status.st_mode):
                locations.append(SourceLocation(library.path, library.version, library.volume, status.st_mtime))
        volumes = list(dict.fromkeys(loc.volume for loc in locations if loc.volume))
        detail = None
        if volumes:
            detail = ("también en el disco " if len(volumes) == 1 else "también en los discos ") + ", ".join(volumes)
        return SourceInfo(
            self.kind, LABELS[self.kind], bool(locations), locations,
            version=locations[0].version if locations else None, detail=detail, app_running=_app_running(),
        )

    def snapshot(self, loc: SourceLocation, cache_dir: Path) -> Path:
        candidates = self._candidates()
        selected = next((lib for lib in candidates if lib.path == loc.path), None)
        if selected is None:
            root = loc.path.parent if loc.path.name == _LEGACY else loc.path.parent.parent
            selected = _Library(loc.path, root.parent if loc.volume else Path("/"))
            candidates.insert(0, selected)
        companions = [_Library(lib.path.with_name(_ROOT), Path("/"))
                      for lib in candidates if lib.path.name == _MASTER and lib.path.is_file()]
        candidates.extend(companions)
        candidates.append(_Library(self.home / _SUPPORT / _ROOT, Path("/")))

        cache_dir.mkdir(parents=True, exist_ok=True)
        snap = Path(tempfile.mkdtemp(prefix="serato-", dir=cache_dir))
        manifest = []
        try:
            for library in dict.fromkeys(candidates):
                source = library.path
                has_db = source.is_file()
                is_legacy = library.version == "3.x"
                if not has_db and library == selected:
                    raise FileNotFoundError(source)
                if not has_db and (not is_legacy or not source.parent.is_dir()):
                    continue
                target = snap / str(len(manifest)) / source.name
                target.parent.mkdir()
                if is_legacy:
                    _copy_legacy(source, target, has_db)
                else:
                    _copy_sqlite(source, target)
                manifest.append({"path": str(target.relative_to(snap)), "root": str(library.root)})
            (snap / "libraries.json").write_text(json.dumps(manifest), encoding="utf-8")
        except BaseException:
            shutil.rmtree(snap, ignore_errors=True)
            raise
        return snap

    def read(self, snap: Path, loc: SourceLocation) -> SourceDump:
        manifest = json.loads((snap / "libraries.json").read_text(encoding="utf-8"))
        libraries = [_Library(snap / item["path"], Path(item["root"])) for item in manifest]
        tracks: dict[str, SrcTrack] = {}
        modern = [lib for lib in libraries if lib.version == "4/5"]
        legacy = [lib for lib in libraries if lib.version == "3.x"]

        crate_batches, modern_sessions = _read_sqlite(modern, tracks)
        old_sessions = []
        for library in legacy:
            for track in _legacy_tracks(library):
                _add_track(tracks, track)
            crate_batches.append(_legacy_crates(library))
            old_sessions.extend(_legacy_sessions(library))

        sessions = _merge_sessions(modern_sessions, old_sessions)
        for session in sessions:
            for play in session.plays:
                if play.track_ext_id not in tracks:
                    play.track_ext_id = _path_id(play.path)
                if play.track_ext_id not in tracks:
                    play.track_ext_id = None
        return SourceDump(
            self.kind, loc.version or ("3.x" if loc.path.name == _LEGACY else "4/5"),
            list(tracks.values()), _merge_crates(crate_batches), sessions,
        )


def _library_home(directory: Path) -> Path:
    for suffix in (_SUPPORT, _SUPPORT.parent, _MUSIC, _MUSIC / "Library"):
        if directory.parts[-len(suffix.parts):] == suffix.parts:
            return directory.parents[len(suffix.parts) - 1]
    return directory


def _drive_libraries(serato_dir: Path, mount: Path) -> list[_Library]:
    return [_Library(serato_dir / "Library" / _LOCATION, mount), _Library(serato_dir / _LEGACY, mount)]


def _copy_legacy(source: Path, target: Path, has_db: bool) -> None:
    if has_db:
        shutil.copyfile(source, target)
    for pattern in _LEGACY_FILES:
        for path in sorted(source.parent.glob(pattern)):
            if path.is_file():
                copy = target.parent / path.relative_to(source.parent)
                copy.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, copy)


def _sqlite_signature(paths: list[Path]) -> list[tuple | None]:
    result = []
    for path in paths:
        try:
            status = path.stat()
            result.append((status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns))
        except FileNotFoundError:
            result.append(None)
    return result


def _copy_sqlite(source: Path, target: Path) -> None:
    suffixes = ("", "-wal", "-shm")
    originals = [source.with_name(source.name + suffix) for suffix in suffixes]
    copies = [target.with_name(target.name + suffix) for suffix in suffixes]
    for _ in range(3):
        before = _sqlite_signature(originals)
        try:
            for original, copy, present in zip(originals, copies, before):
                if present is not None:
                    shutil.copyfile(original, copy)
                else:
                    copy.unlink(missing_ok=True)
        except FileNotFoundError:
            continue  # Un checkpoint pudo quitar el WAL durante la copia.
        if before[0] and _sqlite_signature(originals) == before:
            return
    raise RuntimeError(f"La base de Serato cambió mientras se copiaba: {source}")


def _text(value) -> str | None:
    if isinstance(value, str) and value.strip():
        return value
    return None


def _int(value) -> int | None:
    try:
        return int(value)
    except (ValueError, TypeError, OverflowError):
        return None


def _float(value) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _timestamp(value) -> str | None:
    seconds = _float(value)
    if seconds is None or seconds <= 0:
        return None
    try:
        return datetime.fromtimestamp(seconds).isoformat(timespec="seconds")  # hora local, como rekordbox y Traktor
    except (ValueError, OverflowError, OSError):
        return None


def _date(value) -> str | None:
    iso = _timestamp(value)
    return iso[:10] if iso else None


def key_to_camelot(raw: str | None) -> str | None:
    mapped = to_camelot(raw)
    if mapped or not raw:
        return mapped
    # La M de una nota indica mayor. Los nombres largos no distinguen mayúsculas.
    note = re.fullmatch(r"([A-Ga-g][#b♯♭]?)(.*)", "".join(raw.split()))
    if note:
        root, mode = note.groups()
        return to_camelot(root + ("maj" if mode == "M" else mode.lower()))
    return to_camelot(raw.lower())


def _color(value) -> str | None:
    color = _int(value)
    return f"#{color:06X}" if color is not None and 0 <= color <= 0xFFFFFF else None


def _uri_path(value: str) -> str | None:
    if value.lower().startswith("file:"):
        try:
            uri = urlsplit(value)
        except ValueError:
            return None
        return unquote(uri.path) if uri.netloc in {"", "localhost"} else None
    return value if "://" not in value else None


def _audio_path(raw: str | None, root: Path) -> str | None:
    decoded = _uri_path(raw) if raw else None
    if not decoded or "\0" in decoded:
        return None
    path = os.path.normpath(str(root / decoded))
    nfc = unicodedata.normalize("NFC", path)
    nfd = unicodedata.normalize("NFD", path)
    if Path(path).is_relative_to(root):
        # El montaje puede tener una normalización distinta de la del nombre del archivo.
        relative = unicodedata.normalize("NFD", str(Path(path).relative_to(root)))
        nfd_on_mount = str(root / relative)
    else:
        nfd_on_mount = nfd
    for candidate in dict.fromkeys((nfc, path, nfd_on_mount, nfd)):
        if os.path.exists(candidate):
            return candidate
    return nfc


def _add_track(tracks: dict[str, SrcTrack], track: SrcTrack) -> None:
    old = tracks.setdefault(track.ext_id, track)
    if old is not track:
        for field in fields(SrcTrack):
            if getattr(old, field.name) is None:
                setattr(old, field.name, getattr(track, field.name))


def _rows(db: sqlite3.Connection, table: str, names: str):
    columns = {column[1].lower() for column in db.execute(f'PRAGMA table_info("{table}")')}
    selected = [name for name in names.split() if name in columns]
    if selected:
        projection = ", ".join(f'"{name}"' for name in selected)
        for row in db.execute(f'SELECT {projection} FROM "{table}"'):
            yield dict(zip(selected, row))


def _volume_roots(db: sqlite3.Connection) -> dict:
    roots = {}
    for row in _rows(db, "location", "id path"):
        raw = _text(row.get("path"))
        path = _uri_path(raw) if raw else None
        if row.get("id") is not None and path and path.startswith("/"):
            roots[row["id"]] = Path(path)
    for row in _rows(db, "connection", "location_id database_uri"):
        raw = _text(row.get("database_uri"))
        path = _uri_path(raw) if raw else None
        if row.get("location_id") is None or not path:
            continue
        db_path = Path(path)
        if db_path.name == _ROOT:
            roots[row["location_id"]] = Path("/")
        elif db_path.is_absolute() and db_path.name == _LOCATION and db_path.parent.parent.name == "_Serato_":
            roots[row["location_id"]] = db_path.parent.parent.parent
    return roots


def _file_reference(row: dict) -> str | None:
    portable_id = _text(row.get("portable_id"))
    filename = _text(row.get("file_name"))
    # file_name suele ser solo el nombre, sin directorio. No inventar una ruta.
    return portable_id or (filename if filename and "/" in filename else None)


def _sqlite_track(row: dict, library: _Library, root: Path) -> SrcTrack | None:
    raw = _file_reference(row)
    path = _audio_path(raw, root)
    ext_id = _path_id(path)
    if ext_id is None and raw and raw.startswith("streaming://"):
        ext_id = raw
    if ext_id is None and row.get("id") is not None:
        ext_id = f"asset:{library.root}:{library.path.name}:{row['id']}"
    if ext_id is None:
        return None
    key = _text(row.get("key"))
    key_value = row.get("key_value")
    if key is None and key_value is not None:
        key = str(key_value)
    rating = _float(row.get("rating"))
    length_ms = _float(row.get("length_ms"))
    bitrate = _int(row.get("file_bit_rate"))
    return SrcTrack(
        ext_id, path, raw,
        title=_text(row.get("name")), artist=_text(row.get("artist")), album=_text(row.get("album")),
        label=_text(row.get("label")), genre=_text(row.get("genre")), remixer=_text(row.get("remixer")),
        comment=_text(row.get("comments")), bpm=_float(row.get("bpm")),
        key_raw=key, key_camelot=key_to_camelot(key),
        duration=length_ms / 1000 if length_ms is not None else _float(row.get("length_sec")),
        rating=max(0, min(1, rating)) * 5 if rating is not None else None,
        color=_color(row.get("color")), play_count=_int(row.get("dj_play_count")),
        date_added=_date(row.get("time_added")), bitrate=bitrate // 1000 if bitrate is not None else None,
        year=_int(row.get("year")), filesize=_int(row.get("file_size")),
    )


def _read_sqlite(libraries: list[_Library], tracks: dict[str, SrcTrack]):
    crate_batches = []
    sessions = []
    with ExitStack() as stack:
        databases = []
        master_roots = {}
        for library in libraries:
            con = stack.enter_context(closing(sqlite3.connect(f"{library.path.absolute().as_uri()}?mode=ro", uri=True)))
            roots = _volume_roots(con)
            if library.path.name == _MASTER:
                master_roots.update(roots)
            databases.append((library, con, roots))

        by_volume = defaultdict(set)
        by_portable = defaultdict(set)
        asset_ids = []
        for library, con, roots in databases:
            local = {}
            for row in _rows(con, "asset", """id name artist album label genre remixer comments key key_value bpm
                    color rating time_added dj_play_count portable_id file_name file_size length_ms length_sec
                    location_id file_bit_rate year"""):
                root = roots.get(row.get("location_id"), library.root)
                track = _sqlite_track(row, library, root)
                if track is None:
                    continue
                _add_track(tracks, track)
                if row.get("id") is not None:
                    local[row["id"]] = (root, track.ext_id)
                    by_volume[root, row["id"]].add(track.ext_id)
                if track.path_raw:
                    by_portable[_portable_key(track.path_raw)].add(track.ext_id)
            asset_ids.append(local)

        for (library, con, roots), local in zip(databases, asset_ids):
            maps = {**master_roots, **roots}
            crate_batches.append(_sqlite_crates(con, library, maps, local, by_volume))
            sessions.extend(_sqlite_sessions(con, library, maps, local, by_volume, by_portable, tracks))

    return crate_batches, sessions


def _portable_key(raw: str) -> str:
    return unicodedata.normalize("NFC", raw).casefold()


def _asset_id(asset, root: Path | None, local: dict, by_volume: dict) -> str | None:
    exact = local.get(asset)
    if exact is not None and (root is None or exact[0] == root):
        return exact[1]
    options = by_volume.get((root, asset), ())
    return next(iter(options)) if len(options) == 1 else None


def _sqlite_crates(con, library: _Library, roots: dict, local: dict, by_volume: dict) -> list[SrcCrate]:
    containers = {
        row["id"]: row for row in _rows(con, "container", "id parent_id name type list_order space_id")
        if row.get("id") is not None
    }
    spaces = {row.get("id"): row.get("name") for row in _rows(con, "space", "id name") if row.get("id") is not None}
    library_space = "Serato Library" in spaces.values()
    crates = {
        cid: row for cid, row in containers.items()
        if _text(row.get("name")) and str(row.get("type")).lower() not in {"0", "library", "root"}
        and (not library_space or spaces.get(row.get("space_id")) in {None, "Serato Library"})
    }
    links = {row["id"]: row for row in _rows(con, "location_container", "id container_id location_id")
             if row.get("id") is not None}
    space_assets = {row["id"]: row.get("asset_id") for row in _rows(con, "space_asset", "id asset_id")
                    if row.get("id") is not None}
    members = defaultdict(list)
    for n, row in enumerate(_rows(con, "container_asset", "container_id location_container_id asset_id space_asset_id list_order")):
        link = links.get(row.get("location_container_id"), {})
        container = row.get("container_id")
        if container not in crates:
            container = link.get("container_id")
        if container not in crates:
            continue
        asset = row.get("asset_id")
        if asset is None:
            asset = space_assets.get(row.get("space_asset_id"))
        root = roots.get(link.get("location_id"))
        if root is None and library.path.name != _MASTER:
            root = library.root
        ext_id = _asset_id(asset, root, local, by_volume)
        if ext_id is None and root is None:
            ext_id = _asset_id(asset, library.root, local, by_volume)
        if ext_id is not None:
            order = _int(row.get("list_order"))
            members[container].append((order if order is not None else n, n, ext_id))

    rules = {row["container_id"]: _text(row.get("rules"))
             for row in _rows(con, "smart_crate_rules", "container_id rules") if row.get("container_id") is not None}
    has_children = {row.get("parent_id") for row in crates.values()}
    prefix = f"sqlite:{library.root}:{library.path.name}:"
    result = []
    for n, (cid, row) in enumerate(crates.items()):
        parent = row.get("parent_id")
        crate_type = str(row.get("type")).lower()
        track_ids = [track for _, _, track in sorted(members[cid])]
        kind = "playlist"
        if cid in rules or crate_type == "smart":
            kind = "smart"
        elif not track_ids and (cid in has_children or crate_type == "folder"):
            kind = "folder"
        position = _int(row.get("list_order"))
        result.append(SrcCrate(
            prefix + str(cid), row["name"], kind,
            prefix + str(parent) if parent in crates and parent != cid else None,
            position if position is not None else n, track_ids, rules.get(cid),
        ))
    return sorted(result, key=lambda crate: crate.position)


def _duration(start, end) -> float | None:
    first, last = _float(start), _float(end)
    if first is not None and last is not None and 0 < first <= last:
        return last - first
    return None


def _deck(value) -> int | None:
    if isinstance(value, str) and value.strip().upper() in {"A", "B", "C", "D"}:
        return "ABCD".index(value.strip().upper()) + 1
    return _int(value)


def _session(prefix: str, sid, name: str | None, start, plays: list[SrcPlay]) -> SrcSession:
    iso = _timestamp(start) or min((p.start for p in plays if p.start), default=None)
    if not name and iso:
        d = datetime.fromisoformat(iso)
        name = f"Sesión {d.day}/{d.month}/{d.year:04d} {d:%H:%M}"  # mismo formato que Traktor
    return SrcSession(prefix + str(sid), name or f"Sesión {sid}",
                      iso, plays)


def _sqlite_sessions(con, library: _Library, roots: dict, local: dict, by_volume: dict,
                     by_portable: dict, tracks: dict[str, SrcTrack]) -> list[SrcSession]:
    sessions = {
        row["id"]: row for row in _rows(con, "history_session", "id name start_time")
        if row.get("id") is not None
    }
    entries = defaultdict(list)
    for row in _rows(con, "history_entry", """id session_id asset_id name artist portable_id file_name
                     location_id start_time end_time deck played bpm key"""):
        sid = row.get("session_id")
        if sid is None:
            continue
        sessions.setdefault(sid, {})
        # La fila se crea al cargar el deck, antes de que el tema salga al aire.
        if _float(row.get("played")) != 1:
            continue
        raw = _file_reference(row)
        root = roots.get(row.get("location_id"))
        asset = row.get("asset_id")
        matches = by_portable.get(_portable_key(raw), ()) if root is None and raw else ()
        portable_match = next(iter(matches)) if len(matches) == 1 else None
        ext_id = portable_match or _asset_id(asset, root, local, by_volume)
        track = tracks.get(ext_id)
        if raw and not portable_match:
            asset_root = local.get(asset, (library.root, None))[0]
            path = _audio_path(raw, root or asset_root)
        else:
            path = track.path if track else None
        if (path_id := _path_id(path)) in tracks:
            ext_id, track = path_id, tracks[path_id]
        bpm = _float(row.get("bpm"))
        key = _text(row.get("key"))
        entries[sid].append(SrcPlay(
            ext_id, 0, start=_timestamp(row.get("start_time")),
            duration_s=_duration(row.get("start_time"), row.get("end_time")),
            deck=_deck(row.get("deck")), on_air=True,
            title=_text(row.get("name")) or (track.title if track else None),
            artist=_text(row.get("artist")) or (track.artist if track else None),
            path=path, bpm=bpm if bpm is not None else (track.bpm if track else None),
            key_camelot=key_to_camelot(key) if key else (track.key_camelot if track else None),
        ))

    prefix = f"sqlite:{library.root}:{library.path.name}:"
    return [_session(prefix, sid, _text(meta.get("name")), meta.get("start_time"), entries[sid])
            for sid, meta in sessions.items()]


def _legacy_length(value: str | None) -> float | None:
    parts = (value or "").split(":")
    seconds = 0.0
    for part in parts:
        number = _float(part)
        if number is None or number < 0:
            return None
        seconds = seconds * 60 + number
    return seconds


def _legacy_size(value: str | None) -> int | None:
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([KMG]?)(?:B)?\s*", value or "", re.IGNORECASE)
    if match:
        number, unit = match.groups()
        size = float(number) * 1024 ** (" KMG".index(unit.upper() or " "))
        return _int(size)
    return None


def _legacy_tracks(library: _Library):
    if not library.path.is_file():
        return
    for tag, payload in tlv.records(library.path.read_bytes()):
        if tag != "otrk":
            continue
        row = tlv.fields(payload, *"""pfil tsng tart talb tlbl tgen trmx tcom tbpm tkey tlen tsiz ufsb
                                        uadd tadd utpc ulbl tbit ttyr""".split())
        raw = _text(row.get("pfil"))
        path = _audio_path(raw, library.root)
        if not path:
            continue
        key = _text(row.get("tkey"))
        bitrate = _float((row.get("tbit") or "").lower().removesuffix("kbps"))
        size = row.get("ufsb")
        yield SrcTrack(
            _path_id(path), path, raw,
            title=_text(row.get("tsng")), artist=_text(row.get("tart")), album=_text(row.get("talb")),
            label=_text(row.get("tlbl")), genre=_text(row.get("tgen")), remixer=_text(row.get("trmx")),
            comment=_text(row.get("tcom")), bpm=_float(row.get("tbpm")), key_raw=key, key_camelot=key_to_camelot(key),
            duration=_legacy_length(row.get("tlen")), color=_color(row.get("ulbl")), play_count=row.get("utpc"),
            date_added=_date(row.get("uadd")) or _date(row.get("tadd")), bitrate=_int(bitrate),
            year=_int(row.get("ttyr")), filesize=size if size is not None else _legacy_size(row.get("tsiz")),
        )


def _legacy_rules(data: bytes) -> str:
    raw = {"rules": []}
    for tag, payload in tlv.records(data):
        if tag in {"rart", "rlut"}:
            flag = tlv.fields(payload, "brut").get("brut")
            raw["match_all" if tag == "rart" else "live_update"] = flag
        elif tag == "rurt":
            row = tlv.fields(payload, "urkt", "trft", "trpt", "trtt", "urpt")
            raw["rules"].append({
                "field_id": row.get("urkt"), "operator": row.get("trft"),
                "value": next((row[tag] for tag in ("trpt", "trtt", "urpt") if tag in row), None),
            })
    return json.dumps(raw, ensure_ascii=False)


def _legacy_order(file: Path) -> dict[tuple[str, ...], int]:
    order = {}
    if file.is_file():
        text = tlv.string(file.read_bytes())
        for n, line in enumerate((text or "").splitlines()):
            if line.startswith("[crate]"):
                name = line.removeprefix("[crate]").removesuffix(".crate").removesuffix(".scrate")
                order.setdefault(tuple(name.split("%%")), n)
    return order


def _legacy_crates(library: _Library) -> list[SrcCrate]:
    directory = library.path.parent
    prefix = f"legacy:{library.root}:"
    order = _legacy_order(directory / "neworder.pref")
    crates = {}
    parents = set()
    for pattern in _LEGACY_FILES[:2]:
        for file in sorted(directory.glob(pattern)):
            if not file.is_file():
                continue
            names = tuple(file.stem.split("%%"))
            for end in range(1, len(names) + 1):
                parts = names[:end]
                parent = prefix + "%%".join(parts[:-1]) if end > 1 else None
                crates.setdefault(parts, SrcCrate(prefix + "%%".join(parts), parts[-1], "folder", parent))
                if end > 1:
                    parents.add(parts[:-1])
            crate = crates[names]
            data = file.read_bytes()
            if file.suffix == ".scrate":
                crate.kind = "smart"
                crate.rules_raw = _legacy_rules(data)
                continue
            for tag, payload in tlv.records(data):
                if tag == "otrk":
                    path = _audio_path(tlv.fields(payload, "ptrk").get("ptrk"), library.root)
                    if path:
                        crate.track_ext_ids.append(_path_id(path))
            if crate.kind != "smart":
                crate.kind = "playlist"

    # Un padre implícito puede heredar el orden de su primer hijo listado.
    inherited = {}
    for names, position in order.items():
        for end in range(1, len(names)):
            inherited.setdefault(names[:end], position)
    siblings = Counter()
    result = []
    for names in sorted(crates, key=lambda parts: (order.get(parts, inherited.get(parts, math.inf)), parts)):
        crate = crates[names]
        if names in parents and crate.kind == "playlist" and not crate.track_ext_ids:
            crate.kind = "folder"
        crate.position = siblings[crate.parent_ext_id]
        siblings[crate.parent_ext_id] += 1
        result.append(crate)
    return result


def _legacy_sessions(library: _Library) -> list[SrcSession]:
    history = library.path.parent / "History"
    index = history / "history.database"
    meta = {}
    if index.is_file():
        for row in tlv.adat_records(index.read_bytes(), "oses", strings={41}, numbers={1, 43}):
            if row.get(1) is not None:
                meta[str(row[1])] = row

    prefix = f"legacy:{library.root}:"
    sessions = []
    for file in sorted((history / "Sessions").glob("*.session")):
        if not file.is_file():
            continue
        plays = []
        for row in tlv.adat_records(file.read_bytes(), "oent", strings={2, 6, 7, 51}, numbers={15, 28, 29, 31, 45, 50}):
            if row.get(50) != 1:
                continue
            path = _audio_path(_text(row.get(2)), library.root)
            end = row.get(29)
            duration = _duration(row.get(28), end if end != 0xFFFFFFFF else None)
            plays.append(SrcPlay(
                _path_id(path), 0, start=_timestamp(row.get(28)),
                duration_s=duration if duration is not None else row.get(45) or None,
                deck=row.get(31), on_air=True, title=_text(row.get(6)), artist=_text(row.get(7)),
                path=path, bpm=_float(row.get(15)), key_camelot=key_to_camelot(_text(row.get(51))),
            ))
        session = meta.get(file.stem, {})
        sessions.append(_session(prefix, file.stem, _text(session.get(41)), session.get(43), plays))
    return sessions


def _crate_paths(batch: list[SrcCrate]) -> dict[str, tuple[str, ...]]:
    by_id = {crate.ext_id: crate for crate in batch}
    paths = {}
    for crate in batch:
        names = []
        visited = set()
        node = crate
        while node is not None and node.ext_id not in visited:
            names.append(node.name)
            visited.add(node.ext_id)
            node = by_id.get(node.parent_ext_id)
        paths[crate.ext_id] = tuple(reversed(names))
    return paths


def _merge_crates(batches: list[list[SrcCrate]]) -> list[SrcCrate]:
    result = []
    existing = {}
    for batch in batches:
        paths = _crate_paths(batch)
        counts = Counter(paths.values())
        targets = {}
        for crate in batch:
            path = paths[crate.ext_id]
            target = existing.get(path) if counts[path] == 1 else None
            targets[crate.ext_id] = target or crate
        for crate in batch:
            path = paths[crate.ext_id]
            target = targets[crate.ext_id]
            if target is crate:
                parent = targets.get(crate.parent_ext_id)
                crate.parent_ext_id = parent.ext_id if parent is not None else None
                result.append(crate)
                existing[path] = crate if counts[path] == 1 else None
                continue
            present = set(target.track_ext_ids)
            target.track_ext_ids.extend(track for track in dict.fromkeys(crate.track_ext_ids) if track not in present)
            if target.kind == "folder" and target.track_ext_ids:
                target.kind = "playlist"
            if target.rules_raw is None and crate.kind == "smart":
                target.kind = "smart"
                target.rules_raw = crate.rules_raw
    return result


def _play_identity(play: SrcPlay) -> tuple[str, str] | None:
    path = _path_id(play.path)
    return (play.start, path) if play.start and path else None


def _merge_sessions(modern: list[SrcSession], legacy: list[SrcSession]) -> list[SrcSession]:
    sessions = {}
    by_play = {}
    by_start = defaultdict(set)
    for session in [*modern, *legacy]:
        target = None
        if session.ext_id.startswith("legacy:"):
            overlap = Counter(by_play[key][0] for play in session.plays if (key := _play_identity(play)) in by_play)
            if overlap:
                target = sessions[overlap.most_common(1)[0][0]]
            elif session.start and len(by_start[session.start]) == 1:
                target = sessions[next(iter(by_start[session.start]))]
        unique = []
        for play in session.plays:
            key = _play_identity(play)
            if key is not None:
                if key in by_play:
                    _, earlier = by_play[key]
                    for name in ("track_ext_id", "duration_s", "deck", "title", "artist", "bpm", "key_camelot"):
                        if getattr(earlier, name) is None:
                            setattr(earlier, name, getattr(play, name))
                    continue
                by_play[key] = ((target or session).ext_id, play)
            unique.append(play)
        if target is not None:
            target.plays.extend(unique)
        elif unique or not session.plays:
            session.plays = unique
            sessions[session.ext_id] = session
            if session.start and session.ext_id.startswith("sqlite:"):
                by_start[session.start].add(session.ext_id)

    result = sorted(sessions.values(), key=lambda session: (session.start is None, session.start or ""))
    for session in result:
        session.plays.sort(key=lambda play: (play.start is None, play.start or ""))
        for n, play in enumerate(session.plays):
            play.position = n
    return result
