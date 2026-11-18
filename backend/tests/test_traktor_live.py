import base64
import json
import socket
import struct
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from batea import config, db, nowplaying_traktor, traktor_broadcast


def ogg_page(serial, seq, flags, lacing, payload):
    # El receptor usa el framing, así que alcanza con un CRC ficticio.
    return struct.pack("<4sBBqIIIB", b"OggS", 0, flags, 0, serial, seq, 0, len(lacing)) + bytes(lacing) + payload


def packet_page(serial, seq, flags, *packets):
    lacing = [segment for packet in packets for segment in [255] * (len(packet) // 255) + [len(packet) % 255]]
    return ogg_page(serial, seq, flags, lacing, b"".join(packets))


def vorbis_comment(*comments):
    def field(value):
        value = value.encode()
        return struct.pack("<I", len(value)) + value

    return b"\x03vorbis" + field("Batea test") + struct.pack("<I", len(comments)) + b"".join(map(field, comments)) + b"\x01"


def fake_stream(serial, artist, title):
    return (
        packet_page(serial, 0, 2, b"\x01vorbis")
        + packet_page(serial, 1, 0, vorbis_comment(f"ARTIST={artist}", f"TITLE={title}"), b"\x05vorbis")
        + packet_page(serial, 2, 4, b"\x00fake audio")
    )


def reserve_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    return sock


def free_port():
    with reserve_port() as sock:
        return sock.getsockname()[1]


def source_request(password, method, *, expect=False, chunked=False):
    version = "1.0" if method == "SOURCE" else "1.1"
    auth = base64.b64encode(f"source:{password}".encode())
    return (
        f"{method} /batea HTTP/{version}\r\nHost: localhost\r\n".encode()
        + b"Authorization: Basic " + auth + b"\r\n"
        + b"Ice-Name: Traktor\r\nContent-Type: application/ogg\r\n"
        + (b"Expect: 100-continue\r\n" if expect else b"")
        + (b"Transfer-Encoding: chunked\r\n" if chunked else b"")
        + b"\r\n"
    )


def response_status(sock):
    response = bytearray()
    while not response.endswith(b"\r\n\r\n"):
        char = sock.recv(1)
        if not char:
            raise EOFError("El servidor cerró antes de completar la respuesta")
        response.extend(char)
    return int(response.split()[1])


class OggCommentTests(unittest.TestCase):
    def test_comment_split_across_pages_and_tcp_reads(self):
        packet = vorbis_comment("artist=Björk", "EXTRA=" + "x" * 230, "TITLE=Jóga")
        data = (
            packet_page(42, 0, 2, b"\x01vorbis")
            + ogg_page(42, 1, 0, [255], packet[:255])
            + ogg_page(42, 2, 1, [len(packet) - 255, 7], packet[255:] + b"\x05vorbis")
        )
        parser = traktor_broadcast.OggComments()
        comments = []
        for start in range(0, len(data), 13):
            comments.extend(parser.feed(data[start:start + 13]))
        self.assertEqual(comments, [("Björk", "Jóga")])

    def test_missing_continuation_and_truncated_comment(self):
        packet = vorbis_comment("ARTIST=" + "x" * 260)
        data = (
            ogg_page(42, 1, 0, [255], packet[:255])
            + ogg_page(43, 2, 1, [len(packet) - 255], packet[255:])
            + packet_page(44, 0, 2, vorbis_comment("TITLE=Incompleto")[:-1])
            + fake_stream(45, "Artista", "Título")
        )
        self.assertEqual(list(traktor_broadcast.OggComments().feed(data)), [("Artista", "Título")])


class TraktorLiveTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        settings = patch.object(config, "DB_PATH", Path(tmp.name) / "batea.db")
        settings.start()
        self.addCleanup(settings.stop)
        history = patch.object(traktor_broadcast, "_history", [])
        history.start()
        self.addCleanup(history.stop)
        with db.conn() as c:
            c.executescript(db.SCHEMA)
        self.addCleanup(traktor_broadcast.configure, False)
        traktor_broadcast.start_if_enabled()

    def wait_for(self, condition):
        until = time.monotonic() + 2
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(0.01)
        self.fail("El receptor no llegó al estado esperado")

    def connect(self, settings):
        return socket.create_connection(("127.0.0.1", settings["port"]), timeout=2)

    def test_start_before_database_exists(self):
        missing = config.DB_PATH.with_name("first-run.db")
        with patch.object(config, "DB_PATH", missing):
            traktor_broadcast.start_if_enabled()
            self.assertFalse(traktor_broadcast.status()["enabled"])
            self.assertFalse(missing.exists())

    def test_source_history_path_resolution_and_disconnect(self):
        initial = traktor_broadcast.status()
        self.assertEqual((initial["enabled"], initial["port"], initial["mount"]), (False, 8000, "/batea"))
        settings = traktor_broadcast.configure(True, free_port())
        self.assertTrue(settings["password"])
        first_path = "/Música/Apertura.aiff"
        last_path = "/Música/Cierre.flac"
        with db.conn() as c:
            c.executemany(
                "INSERT INTO tracks(path, artist, title) VALUES (?,?,?)",
                [(first_path, "  ÑANDÚ  ", " APERTURA "), (last_path, "Otro", "CIERRE   DEL SET")],
            )

        with self.connect(settings) as sock:
            sock.sendall(source_request(settings["password"], "SOURCE"))
            self.assertEqual(response_status(sock), 200)
            self.assertTrue(traktor_broadcast.status()["connected"])
            sock.sendall(fake_stream(1, "Ñandú", "Apertura") + fake_stream(2, "Otro", "Cierre del set"))
            self.wait_for(lambda: len(traktor_broadcast.playback()[1]) == 2)
            status = traktor_broadcast.status()
            self.assertTrue(status["connected"])
            self.assertEqual((status["last"]["artist"], status["last"]["title"]), ("Otro", "Cierre del set"))
            with (
                patch.object(nowplaying_traktor, "_traktor_pids", return_value=(123,)),
                patch.object(nowplaying_traktor, "_open_audio", nowplaying_traktor._OpenAudio()),
                patch.object(nowplaying_traktor, "_open_audio_files", return_value=[]),
                db.conn() as c,
            ):
                self.assertTrue(nowplaying_traktor.running())
                reading = nowplaying_traktor.read(c)
                self.assertEqual(reading.app, "traktor")
                self.assertEqual(
                    [(ref.artist, ref.title, ref.path) for ref in reading.played],
                    [("Ñandú", "Apertura", first_path), ("Otro", "Cierre del set", last_path)],
                )
                self.assertEqual(reading.now, reading.played[-1])
                self.assertEqual(reading.activity, status["last"]["at"])
                self.assertEqual(reading.now.start, status["last"]["at"])
                self.assertIsNone(reading.note)
        self.wait_for(lambda: not traktor_broadcast.status()["connected"])

    def test_put_expect_continue_and_chunked_stream(self):
        settings = traktor_broadcast.configure(True, free_port())
        with self.connect(settings) as sock:
            sock.sendall(source_request(settings["password"], "PUT", expect=True, chunked=True))
            self.assertEqual(response_status(sock), 100)
            self.assertTrue(traktor_broadcast.status()["connected"])
            data = fake_stream(6, "Juana", "Un tema")
            for chunk in (data[:20], data[20:]):
                sock.sendall(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
            sock.sendall(b"0\r\n\r\n")
            self.assertEqual(response_status(sock), 200)
        self.assertEqual(traktor_broadcast.status()["last"]["title"], "Un tema")

    def test_wrong_password_is_rejected_before_continue(self):
        settings = traktor_broadcast.configure(True, free_port())
        with self.connect(settings) as sock:
            sock.sendall(source_request(settings["password"] + "x", "PUT", expect=True))
            self.assertEqual(response_status(sock), 401)
        status = traktor_broadcast.status()
        self.assertFalse(status["connected"])
        self.assertIsNone(status["last"])

    def test_ice_source_with_audio_in_the_first_write(self):
        settings = traktor_broadcast.configure(True, free_port())
        request = source_request(settings["password"], "SOURCE").replace(b"HTTP/1.0", b"ICE/1.0", 1)
        with self.connect(settings) as sock:
            sock.sendall(request + fake_stream(8, "Artista", "Tema"))
            self.assertEqual(response_status(sock), 200)
            self.wait_for(lambda: traktor_broadcast.status()["last"] is not None)
            self.assertEqual(traktor_broadcast.status()["last"]["title"], "Tema")

    def test_occupied_port_can_be_retried_and_persists_settings(self):
        with reserve_port() as occupied:
            port = occupied.getsockname()[1]
            failed = traktor_broadcast.configure(True, port)
            self.assertTrue(failed["enabled"])
            self.assertFalse(failed["connected"])
            self.assertIn("ya está en uso", failed["error"])
            with db.conn() as c:
                saved = json.loads(db.get_meta(c, traktor_broadcast.META_KEY))
                self.assertEqual(saved["port"], port)
                self.assertEqual(saved["password"], failed["password"])
        traktor_broadcast.start_if_enabled()
        settings = traktor_broadcast.status()
        self.assertIsNone(settings["error"])
        with self.connect(settings) as sock:
            sock.sendall(source_request(settings["password"], "PUT"))
            self.assertEqual(response_status(sock), 200)
            stopped = traktor_broadcast.configure(False)
            self.assertFalse(stopped["connected"])
            self.assertEqual(stopped["password"], settings["password"])
            self.assertEqual(sock.recv(1), b"")
        with self.assertRaises(ConnectionRefusedError):
            self.connect(settings).close()


class TraktorOpenFilesTests(unittest.TestCase):
    def test_filters_audio_and_throttles_lsof(self):
        first = "/Volumes/Música/Uno.MP3"
        second = "/Users/dj/Music/Dos.ogg"
        third = "/Users/dj/Music/Tres.aiff"
        initial = "\n".join("n" + path for path in (
            first, second, "/Applications/Traktor Pro 4.app/Contents/Resources/Loop.wav",
            "/Users/dj/Documents/Native Instruments/Traktor Content/Loop.wav",
            "/System/Library/Sounds/Funk.aiff", "/Users/dj/Music/demo.txt", first,
        ))
        with (
            patch.object(nowplaying_traktor, "_open_audio", nowplaying_traktor._OpenAudio()),
            patch.object(nowplaying_traktor, "time") as clock,
            patch.object(nowplaying_traktor.subprocess, "run") as run,
            tempfile.TemporaryDirectory() as tmp,
            patch.object(config, "DB_PATH", Path(tmp) / "batea.db"),
            db.conn() as c,
        ):
            def execute(command, **_):
                if command[0].endswith("/pgrep"):
                    return subprocess.CompletedProcess(command, 0, stdout="123\n")
                return subprocess.CompletedProcess(command, 0, stdout=output)

            run.side_effect = execute
            output = initial
            clock.monotonic.return_value, clock.time.return_value = 10.0, 100.0
            one = nowplaying_traktor.read(c)
            self.assertEqual([ref.path for ref in one.loaded], [second, first])
            self.assertIsNone(one.now)
            self.assertEqual(one.note, "Activá Broadcasting en Traktor para saber qué suena")
            output = f"n{second}\nn{third}\n"
            clock.monotonic.return_value, clock.time.return_value = 11.9, 101.9
            self.assertEqual(nowplaying_traktor.read(c).loaded, one.loaded)
            clock.monotonic.return_value, clock.time.return_value = 12.0, 102.0
            latest = nowplaying_traktor.read(c)
            self.assertEqual([ref.path for ref in latest.loaded], [third, second])
            self.assertEqual(latest.activity, 102.0)
            calls = [call.args[0] for call in run.call_args_list if call.args[0][0].endswith("/lsof")]
            self.assertEqual(calls, [["/usr/sbin/lsof", "-n", "-P", "-p", "123", "-Fn"]] * 2)
