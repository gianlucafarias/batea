"""Lector de las colecciones y el historial NML de Traktor Pro 3 y 4."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from collections.abc import Set
from datetime import datetime, timedelta
from pathlib import Path

from batea.keys import camelot_from_pitch

from .base import (
    LABELS,
    Cue,
    GridMarker,
    SourceDump,
    SourceInfo,
    SourceLocation,
    SrcCrate,
    SrcPlay,
    SrcSession,
    SrcTrack,
)

_VERSION = re.compile(r"^Traktor (?:.*? )?(\d+(?:\.\d+)*)$")
_HISTORY_FORMAT = "history_%Yy%mm%dd_%Hh%Mm%Ss.nml"
_XML_ERRORS = (ET.ParseError, LookupError, ValueError)
_CUE_KINDS = {1: "fade_in", 2: "fade_out", 3: "load", 5: "loop"}
_COLORS = {
    1: "#E53935", 2: "#FB8C00", 3: "#FDD835", 4: "#43A047",
    5: "#1E88E5", 6: "#8E24AA", 7: "#D81B60",
}
_FACTORY_DIRS = {"traktorcontent", "traktor content", "traktor factory content"}


def location_to_path(volume: str, dir: str, file: str) -> str:
    """Decodifica una LOCATION de Traktor y prueba las formas NFC y NFD."""
    volume = _path_component(volume)
    directory = _location_dir(dir).strip("/")
    relative = "/".join(part for part in (directory, _path_component(file)) if part)
    root_path = f"/{relative}"
    if not volume:
        candidates = [root_path]
    else:
        mount = f"/Volumes/{volume}"
        candidates = [f"{mount}/{relative}"]
        if any(os.path.realpath(form) == "/" for form in _unicode_forms(mount)):
            candidates.insert(0, root_path)
    for candidate in candidates:
        for form in _unicode_forms(candidate):
            if os.path.exists(form):
                return form
    return unicodedata.normalize("NFC", candidates[-1])


def _path_component(value: str) -> str:
    return value.replace("\ufeff", "").replace("//", ":")


def _location_dir(value: str) -> str:
    return "/".join(_path_component(part) for part in value.replace("\ufeff", "").split("/:"))


def _unicode_forms(path: str) -> tuple[str, str]:
    return unicodedata.normalize("NFC", path), unicodedata.normalize("NFD", path)


def musical_key_to_camelot(value: int) -> str:
    """Traktor numera primero las doce tonalidades mayores y luego las menores."""
    if not 0 <= value < 24:
        raise ValueError(f"Tonalidad Traktor fuera de rango: {value}")
    return camelot_from_pitch(value, minor=value >= 12)


def _version(directory: Path) -> str | None:
    match = _VERSION.fullmatch(directory.name)
    return match.group(1) if match else None


def _version_order(directory: Path) -> tuple[tuple[int, ...], str]:
    version = _version(directory)
    return tuple(map(int, version.split("."))) if version else (), directory.name


def _traktor_folders() -> list[Path]:
    override = os.environ.get("BATEA_TRAKTOR_DIR")
    root = Path(override).expanduser() if override else Path.home() / "Documents" / "Native Instruments"
    try:
        return sorted(
            (path for path in root.iterdir() if path.name.startswith("Traktor ") and path.is_dir()),
            key=_version_order,
            reverse=True,
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return []


def _app_running() -> bool:
    try:
        result = subprocess.run(
            ["pgrep", "-f", r"[Tt]raktor[^/]*[.]app/Contents/MacOS/"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


class TraktorSource:
    kind = "traktor"

    def discover(self) -> SourceInfo:
        locations = []
        for directory in _traktor_folders():
            collection = directory / "collection.nml"
            try:
                status = collection.stat()
            except (FileNotFoundError, PermissionError):
                continue
            if stat.S_ISREG(status.st_mode):
                locations.append(SourceLocation(collection, version=_version(directory), modified=status.st_mtime))
        info = SourceInfo(self.kind, LABELS[self.kind], bool(locations), locations, app_running=_app_running())
        if locations:
            newest = locations[0]
            info.version = newest.version
            if newest.modified is not None:
                saved = datetime.fromtimestamp(newest.modified)
                info.detail = f"guardado el {saved.day}/{saved.month}"
        return info

    def snapshot(self, loc: SourceLocation, cache_dir: Path) -> Path:
        selected = loc.path.parent
        directories = {directory.name: directory for directory in _traktor_folders()}
        directories[selected.name] = selected
        cache_dir.mkdir(parents=True, exist_ok=True)
        snap = Path(tempfile.mkdtemp(prefix="traktor-", dir=cache_dir))
        warnings = []
        try:
            for directory in directories.values():
                copy = snap / directory.name
                copy.mkdir()
                collection = loc.path if directory == selected else directory / "collection.nml"
                if directory == selected or collection.is_file():
                    _snapshot_collection(collection, copy, warnings, required=directory == selected)
                history_files = sorted(path for path in (directory / "History").glob("*.nml") if path.is_file())
                if history_files:
                    history_copy = copy / "History"
                    history_copy.mkdir()
                    for path in history_files:
                        shutil.copyfile(path, history_copy / path.name)
            (snap / "warnings.json").write_text(json.dumps(warnings, ensure_ascii=False), encoding="utf-8")
        except BaseException:
            shutil.rmtree(snap, ignore_errors=True)
            raise
        return snap

    def read(self, snap: Path, loc: SourceLocation) -> SourceDump:
        root = ET.parse(snap / loc.path.parent.name / "collection.nml").getroot()
        warnings = json.loads((snap / "warnings.json").read_text(encoding="utf-8"))
        tracks, filtered = _read_collection(root)
        if filtered == 1:
            warnings.append("Se omitió 1 muestra de Loop Recorder o de fábrica.")
        elif filtered > 1:
            warnings.append(f"Se omitieron {filtered} muestras de Loop Recorder o de fábrica.")
        sessions = _read_history(snap, tracks.keys(), warnings)
        return SourceDump(
            kind=self.kind,
            version=loc.version or _version(loc.path.parent),
            tracks=list(tracks.values()),
            crates=_read_crates(root),
            sessions=sessions,
            warnings=warnings,
        )


def _snapshot_collection(source: Path, directory: Path, warnings: list[str], *, required: bool) -> None:
    target = directory / "collection.nml"
    shutil.copyfile(source, target)
    try:
        ET.parse(target)
        return
    except _XML_ERRORS:
        backup_dir = source.parent / "Backup" / "Collection"
        backups = sorted(
            (path for path in backup_dir.glob("*.nml") if path.is_file()),
            key=lambda path: (path.stat().st_mtime, path.name),
            reverse=True,
        )
        backup_copy = directory / "collection.backup.nml"
        for backup in backups:
            shutil.copyfile(backup, backup_copy)
            try:
                ET.parse(backup_copy)
            except _XML_ERRORS:
                continue
            backup_copy.replace(target)
            warnings.append(f"Se usó el respaldo {backup.name} para la colección de {source.parent.name}.")
            return
        if required:
            raise
        backup_copy.unlink(missing_ok=True)
        warnings.append(f"La colección de {source.parent.name} está dañada y no tiene un respaldo válido.")


def _attr(node: ET.Element | None, name: str) -> str | None:
    return node.get(name) if node is not None else None


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _float(value: str | None) -> float | None:
    try:
        number = float(value) if value is not None else None
    except ValueError:
        return None
    return number if number is not None and math.isfinite(number) else None


def _iso_date(value: str | None) -> str | None:
    try:
        return datetime.strptime(value, "%Y/%m/%d").date().isoformat() if value else None
    except ValueError:
        return None


def _read_collection(root: ET.Element, *, include_cues: bool = True) -> tuple[dict[str, SrcTrack], int]:
    tracks = {}
    filtered = 0
    nml_version = _int(root.get("VERSION"))
    for entry in root.findall("./COLLECTION/ENTRY"):
        location = entry.find("LOCATION")
        directory = _attr(location, "DIR") or ""
        is_factory = any(part.casefold() in _FACTORY_DIRS for part in _location_dir(directory).split("/"))
        if entry.find("LOOPINFO") is not None or is_factory:
            filtered += 1
            continue
        filename = _attr(location, "FILE")
        if filename:
            volume = _attr(location, "VOLUME") or ""
            track = _read_track(entry, volume, directory, filename)
            if include_cues:
                track.cues, track.grid = _read_cues(entry, track.bpm, nml_version)
            tracks[track.ext_id] = track
    return tracks, filtered


def _read_track(entry: ET.Element, volume: str, directory: str, filename: str) -> SrcTrack:
    raw = volume + directory + filename
    info = entry.find("INFO")
    musical_key = entry.find("MUSICAL_KEY")
    if musical_key is not None:
        key_raw = musical_key.get("VALUE")
        value = _int(key_raw)
        camelot = musical_key_to_camelot(value) if value is not None and 0 <= value < 24 else None
    else:
        key_raw = _attr(info, "KEY")
        camelot = None
    bitrate = _int(_attr(info, "BITRATE"))
    filesize = _int(_attr(info, "FILESIZE"))
    ranking = _int(_attr(info, "RANKING"))
    release_date = _attr(info, "RELEASE_DATE") or ""
    year = _int(release_date.split("/", 1)[0])
    return SrcTrack(
        ext_id=raw,
        path=location_to_path(volume, directory, filename),
        path_raw=raw,
        title=entry.get("TITLE"),
        artist=entry.get("ARTIST"),
        album=_attr(entry.find("ALBUM"), "TITLE"),
        label=_attr(info, "LABEL"),
        genre=_attr(info, "GENRE"),
        remixer=_attr(info, "REMIXER"),
        comment=_attr(info, "COMMENT"),
        bpm=_float(_attr(entry.find("TEMPO"), "BPM")),
        key_raw=key_raw,
        key_camelot=camelot,
        duration=_float(_attr(info, "PLAYTIME")),
        rating=ranking / 51 if ranking is not None and 0 <= ranking <= 255 else None,
        color=_COLORS.get(_int(_attr(info, "COLOR"))),
        play_count=_int(_attr(info, "PLAYCOUNT")),
        date_added=_iso_date(_attr(info, "IMPORT_DATE")),
        last_played=_iso_date(_attr(info, "LAST_PLAYED")),
        bitrate=bitrate // 1000 if bitrate is not None else None,
        year=year if year is not None and 1 <= year <= 9999 else None,
        filesize=filesize * 1024 if filesize is not None else None,
    )


def _read_cues(
    entry: ET.Element, track_bpm: float | None, nml_version: int | None,
) -> tuple[list[Cue], list[GridMarker]]:
    cues = []
    grid = []
    nodes = entry.findall("CUE_V2")
    grid_starts = {_float(node.get("START")) for node in nodes if node.get("TYPE") == "4"}
    for node in nodes:
        cue_type = _int(node.get("TYPE"))
        start = _float(node.get("START"))
        if start is None:
            continue
        hotcue = _int(node.get("HOTCUE"))
        slot = hotcue if hotcue is not None and hotcue >= 0 else None
        name = node.get("NAME")
        name = name if name and name != "n.n." else None
        if cue_type == 4:
            bpm = _float(_attr(node.find("GRID"), "BPM"))
            bpm = track_bpm if bpm is None else bpm
            if bpm is not None:
                grid.append(GridMarker(start, bpm))
            if nml_version != 19 or slot is None:
                continue
            kind = "hot"
        elif cue_type == 0:
            if nml_version == 20 and name == "AutoGrid" and slot == 0 and start in grid_starts:
                continue
            kind = "hot" if slot is not None else "memory"
        else:
            kind = _CUE_KINDS.get(cue_type)
            if kind is None:
                continue
        length = _float(node.get("LEN")) if kind == "loop" else None
        cues.append(Cue(kind, start, start + length if length is not None else None, slot, name, node.get("COLOR")))
    return cues, grid


def _track_key(entry: ET.Element) -> str | None:
    key = entry.find("PRIMARYKEY")
    return key.get("KEY") if key is not None and key.get("TYPE") == "TRACK" else None


def _read_crates(root: ET.Element) -> list[SrcCrate]:
    crates = []

    def visit(nodes: list[ET.Element], parent: str | None = None, names: tuple[str, ...] = ()) -> None:
        for position, node in enumerate(nodes):
            name = node.get("NAME", "")
            node_type = node.get("TYPE")
            if name == "$ROOT" and node_type == "FOLDER":
                visit(node.findall("./SUBNODES/NODE"), parent, names)
                continue
            if name == "HISTORY" or node_type not in {"FOLDER", "PLAYLIST", "SMARTLIST"}:
                continue
            path = (*names, name)
            data = node.find(node_type) if node_type != "FOLDER" else None
            ext_id = _attr(data, "UUID") or node.get("UUID") or "/".join(path)
            if node_type == "FOLDER":
                crates.append(SrcCrate(ext_id, name, "folder", parent, position))
                visit(node.findall("./SUBNODES/NODE"), ext_id, path)
            elif node_type == "PLAYLIST":
                entries = data.findall("ENTRY") if data is not None else []
                track_ids = [key for entry in entries if (key := _track_key(entry))]
                crates.append(SrcCrate(ext_id, name, "playlist", parent, position, track_ids))
            else:
                expression = data.find("SEARCH_EXPRESSION") if data is not None else None
                crates.append(SrcCrate(ext_id, name, "smart", parent, position, rules_raw=_attr(expression, "QUERY")))

    visit(root.findall("./PLAYLISTS/NODE"))
    return crates


def _read_history(snap: Path, collection_ids: Set[str], warnings: list[str]) -> list[SrcSession]:
    sessions = {}
    for directory in sorted((path for path in snap.iterdir() if path.is_dir()), key=_version_order, reverse=True):
        for path in sorted((directory / "History").glob("history_*.nml")):
            if path.name in sessions:
                continue
            try:
                start = datetime.strptime(path.name, _HISTORY_FORMAT)
                root = ET.parse(path).getroot()
            except _XML_ERRORS:
                warnings.append(f"Se omitió el historial {path.name} de {directory.name} porque no se pudo leer.")
                continue
            name = f"Sesión {start.day}/{start.month}/{start.year:04d} {start:%H:%M}"
            plays = _read_plays(root, collection_ids)
            sessions[path.name] = SrcSession(path.name, name, start.isoformat(), plays)
    return sorted(sessions.values(), key=lambda session: session.start)


def _read_plays(root: ET.Element, collection_ids: Set[str]) -> list[SrcPlay]:
    historical_tracks, _ = _read_collection(root, include_cues=False)
    plays = []
    for entry in root.findall('.//NODE[@NAME="HISTORY"]/PLAYLIST[@TYPE="PROTOCOL"]/ENTRY'):
        data = entry.find('EXTENDEDDATA[@EXTENDEDTYPE="HistoryData"]')
        if data is None:
            continue
        start_date = _int(data.get("STARTDATE"))
        start_time = _int(data.get("STARTTIME"))
        key = _track_key(entry)
        track = historical_tracks.get(key)
        play = SrcPlay(
            track_ext_id=key if key in collection_ids else None,
            position=0,
            start=_play_start(start_date, start_time),
            duration_s=_float(data.get("DURATION")),
            deck=_int(data.get("DECK")),
            on_air=data.get("PLAYEDPUBLIC") == "1",
            title=track.title if track else None,
            artist=track.artist if track else None,
            path=track.path if track else None,
            bpm=track.bpm if track else None,
            key_camelot=track.key_camelot if track else None,
        )
        plays.append((start_date, start_time, play))
    plays.sort(key=lambda row: (
        row[0] if row[0] is not None else math.inf,
        row[1] if row[1] is not None else math.inf,
    ))
    result = []
    for position, (_, _, play) in enumerate(plays):
        play.position = position
        result.append(play)
    return result


def _play_start(packed_date: int | None, seconds: int | None) -> str | None:
    if packed_date is None or seconds is None or not 0 <= seconds < 86400:
        return None
    try:
        midnight = datetime(packed_date >> 16, packed_date >> 8 & 255, packed_date & 255)
    except ValueError:
        return None
    return (midnight + timedelta(seconds=seconds)).isoformat()
