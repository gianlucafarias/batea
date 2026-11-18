"""Receptor local de Broadcasting de Traktor. Solo conserva los metadatos."""
from __future__ import annotations

import base64
import errno
import hmac
import json
import secrets
import socket
import sqlite3
import struct
import threading
import time
from dataclasses import asdict, dataclass, replace
from typing import BinaryIO, Iterator

from . import config, db

META_KEY = "traktor_broadcast"
HOST = "127.0.0.1"
READ_SIZE = 8192
MAX_HEADERS = 16384
MAX_COMMENT = 256 * 1024
_COMMENT = b"\x03vorbis"
_OK = b"200 OK\r\nContent-Length: 0\r\n\r\n"


# Ogg lacing and Vorbis comments: https://xiph.org/vorbis/doc/framing.html
# https://www.xiph.org/vorbis/doc/v-comment.html
class OggComments:
    """Reensambla comentarios Vorbis de streams lógicos encadenados de Traktor."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._serial: int | None = None
        self._sequence: int | None = None
        self._packet: bytearray | None = None

    def feed(self, data: bytes) -> Iterator[tuple[str, str]]:
        buf = self._buffer
        buf.extend(data)
        while len(buf) >= 27:
            start = buf.find(b"OggS")
            if start == -1:
                del buf[:-3]
                return
            del buf[:start]
            if len(buf) < 27:
                return
            if buf[4] != 0:
                del buf[0]
                continue
            header_end = 27 + buf[26]
            if len(buf) < header_end:
                return
            lacing = buf[27:header_end]
            page_end = header_end + sum(lacing)
            if len(buf) < page_end:
                return
            flags = buf[5]
            serial, sequence = struct.unpack_from("<II", buf, 14)
            if not flags & 1:
                self._packet = bytearray()
            elif flags & 2 or serial != self._serial or sequence != self._sequence:
                self._packet = None  # se perdió el comienzo del paquete
            self._serial = serial
            self._sequence = (sequence + 1) & 0xFFFFFFFF
            offset = header_end
            for size in lacing:
                end = offset + size
                if self._packet is not None:
                    self._packet.extend(buf[offset:end])
                    # Descarta audio y otros headers tras su primer segmento.
                    if not self._packet.startswith(_COMMENT) or len(self._packet) > MAX_COMMENT:
                        self._packet = None
                if size < 255:
                    if self._packet:
                        metadata = _vorbis_comment(self._packet)
                        if metadata:
                            yield metadata
                    self._packet = bytearray()
                offset = end
            del buf[:page_end]


def _vorbis_comment(packet: bytearray) -> tuple[str, str] | None:
    offset = len(_COMMENT)

    def read_u32() -> int:
        nonlocal offset
        value, = struct.unpack_from("<I", packet, offset)
        offset += 4
        return value

    try:
        vendor_size = read_u32()
        offset += vendor_size
        count = read_u32()
        tags: dict[bytes, str] = {}
        for _ in range(count):
            size = read_u32()
            end = offset + size
            if end >= len(packet):  # debe quedar el bit de framing
                return None
            key, sep, value = packet[offset:end].partition(b"=")
            key = bytes(key.upper())
            if sep and key in (b"ARTIST", b"TITLE"):
                tags[key] = value.decode("utf-8", errors="replace").strip()
            offset = end
        if not packet[offset] & 1:
            return None
    except (IndexError, struct.error):
        return None
    artist, title = tags.get(b"ARTIST", ""), tags.get(b"TITLE", "")
    return (artist, title) if artist or title else None


@dataclass(frozen=True)
class BroadcastConfig:
    enabled: bool = False
    port: int = 8000
    mount: str = "/batea"
    password: str = ""


@dataclass(frozen=True)
class BroadcastTrack:
    artist: str
    title: str
    at: float


def _read_config(c: sqlite3.Connection) -> BroadcastConfig:
    defaults = BroadcastConfig()
    try:
        saved = json.loads(db.get_meta(c, META_KEY) or "{}")
    except ValueError:
        return defaults
    if not isinstance(saved, dict):
        return defaults
    port, mount, password = (saved.get(key) for key in ("port", "mount", "password"))
    return BroadcastConfig(
        enabled=saved.get("enabled") is True,
        port=port if type(port) is int and 1 <= port <= 65535 else defaults.port,
        mount=mount if isinstance(mount, str) and mount.startswith("/") else defaults.mount,
        password=password if isinstance(password, str) else defaults.password,
    )


def _with_password(settings: BroadcastConfig) -> BroadcastConfig:
    if settings.enabled and not settings.password:
        alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
        return replace(settings, password="".join(secrets.choice(alphabet) for _ in range(10)))
    return settings


def _read_headers(stream: BinaryIO) -> tuple[str, str, dict[str, str]] | None:
    remaining = MAX_HEADERS
    line = stream.readline(remaining)
    remaining -= len(line)
    request = line.decode("iso-8859-1").split()
    if len(request) != 3:
        return None
    method, mount, version = request
    # También se ve SOURCE con ICE/1.0 en Traktor:
    # https://github.com/whatsnowplaying/whats-now-playing/blob/main/tests/test_icecast.py
    if version not in ("HTTP/1.0", "HTTP/1.1") and not (method == "SOURCE" and version == "ICE/1.0"):
        return None
    headers: dict[str, str] = {}
    while remaining:
        line = stream.readline(remaining)
        remaining -= len(line)
        if line in (b"\r\n", b"\n"):
            return method, mount, headers
        name, sep, value = line.decode("iso-8859-1").partition(":")
        if not sep:
            return None
        headers[name.lower()] = value.strip()
    return None


def _body(stream: BinaryIO, headers: dict[str, str]) -> Iterator[bytes]:
    remaining = int(headers["content-length"]) if "content-length" in headers else None
    chunked = headers.get("transfer-encoding", "").lower() == "chunked"
    while True:
        if chunked:
            header = stream.readline(128)
            if not header.endswith(b"\r\n"):
                return
            remaining = int(header.split(b";", 1)[0], 16)
            if remaining <= 0:
                return
        while remaining is None or remaining > 0:
            data = stream.read1(READ_SIZE if remaining is None else min(remaining, READ_SIZE))
            if not data:
                return
            yield data
            if remaining is not None:
                remaining -= len(data)
        if not chunked or stream.read(2) != b"\r\n":
            return


class _Listener:
    def __init__(self, settings: BroadcastConfig) -> None:
        self.settings = settings
        self.connected = threading.Event()
        self._stopping = threading.Event()
        self._client_lock = threading.Lock()
        self._client: socket.socket | None = None
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._socket.bind((HOST, settings.port))
            self._socket.listen()
            self._socket.settimeout(0.2)
        except OSError:
            self._socket.close()
            raise
        self._thread = threading.Thread(target=self._serve, name="traktor-broadcast", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        with self._client_lock:
            if self._client is not None:
                try:
                    self._client.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        self._thread.join()
        self._socket.close()

    def _serve(self) -> None:
        while not self._stopping.is_set():
            try:
                client, _ = self._socket.accept()
            except TimeoutError:
                continue
            with client:
                with self._client_lock:
                    if self._stopping.is_set():
                        return
                    self._client = client
                try:
                    client.settimeout(10)
                    self._receive(client)
                except (OSError, ValueError):
                    pass  # desconexión, timeout o stream incompleto
                finally:
                    self.connected.clear()
                    with self._client_lock:
                        self._client = None

    def _receive(self, client: socket.socket) -> None:
        with client.makefile("rb") as stream:
            request = _read_headers(stream)
            if request is None:
                return
            method, mount, headers = request
            if method not in ("SOURCE", "PUT"):
                client.sendall(b"HTTP/1.0 405 Method Not Allowed\r\nAllow: SOURCE, PUT\r\nContent-Length: 0\r\n\r\n")
                return
            if mount != self.settings.mount:
                client.sendall(b"HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                return
            auth = headers.get("authorization", "").split()
            expected = base64.b64encode(f"source:{self.settings.password}".encode())
            if (
                len(auth) != 2 or auth[0].lower() != "basic"
                or not hmac.compare_digest(auth[1].encode("iso-8859-1"), expected)
            ):
                client.sendall(
                    b'HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Icecast"\r\nContent-Length: 0\r\n\r\n'
                )
                return
            media_type = headers.get("content-type", "").partition(";")[0].strip().lower()
            if media_type not in ("application/ogg", "audio/ogg", "application/x-ogg"):
                client.sendall(b"HTTP/1.0 415 Unsupported Media Type\r\nContent-Length: 0\r\n\r\n")
                return

            # Icecast acepta SOURCE con 200 y PUT con Expect con 100, seguido
            # de un 200 al terminar la transmisión. PUT sin Expect también puede
            # empezar ante un 2xx en libshout.
            # https://github.com/xiph/icecast-server/blob/master/src/connection_handle.c
            # https://github.com/xiph/icecast-server/blob/master/src/source.c
            # https://github.com/xiph/Icecast-libshout/blob/master/src/proto_http.c
            # Traktor por SOURCE y comentarios encadenados:
            # https://github.com/radusuciu/traktor_nowplaying/blob/master/traktor_nowplaying/core.py
            expect_continue = method == "PUT" and headers.get("expect", "").lower() == "100-continue"
            version = b"HTTP/1.1 " if method == "PUT" else b"HTTP/1.0 "
            self.connected.set()
            client.sendall(b"HTTP/1.1 100 Continue\r\n\r\n" if expect_continue else version + _OK)
            parser = OggComments()
            for data in _body(stream, headers):
                for artist, title in parser.feed(data):
                    with _history_lock:
                        _history.append(BroadcastTrack(artist, title, time.time()))
            if expect_continue:
                client.sendall(version + _OK)


_settings_lock = threading.Lock()
_settings = BroadcastConfig()
_listener: _Listener | None = None
_error: str | None = None
_history_lock = threading.Lock()
_history: list[BroadcastTrack] = []


def _apply(settings: BroadcastConfig) -> None:
    global _settings, _listener, _error
    if _listener is not None and _listener.settings == settings:
        return
    if _listener is not None:
        _listener.stop()
        _listener = None
    _settings, _error = settings, None
    if settings.enabled:
        try:
            _listener = _Listener(settings)
        except OSError as exc:
            if exc.errno == errno.EADDRINUSE:
                _error = f"El puerto {settings.port} ya está en uso."
            else:
                _error = f"No pude abrir el puerto {settings.port}."


def _status() -> dict:
    with _history_lock:
        last = asdict(_history[-1]) if _history else None
    return {
        **asdict(_settings),
        "connected": _listener is not None and _listener.connected.is_set(),
        "last": last,
        "error": _error,
    }


def status() -> dict:
    with _settings_lock:
        return _status()


def start_if_enabled() -> None:
    with _settings_lock:
        if not config.DB_PATH.is_file():
            _apply(BroadcastConfig())
            return
        with db.conn() as c:
            saved = _read_config(c)
            settings = _with_password(saved)
            if settings != saved:
                db.set_meta(c, META_KEY, json.dumps(asdict(settings)))
        _apply(settings)


def configure(enabled: bool, port: int | None = None) -> dict:
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("El puerto tiene que estar entre 1 y 65535.")
    with _settings_lock:
        with db.conn() as c:
            saved = _read_config(c)
            settings = _with_password(replace(saved, enabled=enabled, port=saved.port if port is None else port))
            db.set_meta(c, META_KEY, json.dumps(asdict(settings)))
        _apply(settings)
        return _status()


def playback() -> tuple[bool, tuple[BroadcastTrack, ...]]:
    """Devuelve una copia del historial de la sesión de Batea."""
    with _settings_lock, _history_lock:
        return _settings.enabled, tuple(_history)
