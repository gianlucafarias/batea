import json
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import textwrap
import unicodedata
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from batea.db import canon_path
from batea.sources import serato_tlv as tlv
from batea.sources.serato import SeratoSource, key_to_camelot
from tests.fixtures.serato.build import (
    BASS, GARDEN, LEGACY, MASTER, SHARD, START, SUN, VOLUME, legacy_library, modern_library, record,
)

FIXTURES = Path(__file__).parent / "fixtures" / "serato"


def iso(seconds):
    return datetime.fromtimestamp(seconds).isoformat(timespec="seconds")


class SeratoMappingTests(unittest.TestCase):
    def test_tlv_values_nested_unknown_and_truncated(self):
        inner = (
            record("pfil", "Sets/Año.mp3")
            + record("uadd", 0x01020304)
            + record("sfoo", 0x1234)
            + record("bmis", True)
            + record("bply", False)
            + record("xnew", b"\x00")
            + record("tnew", "texto desconocido")
            + record("uend", 12)[:-1]
        )
        stream = record("otrk", inner) + struct.pack(">4sI", b"bad!", 8) + b"x"
        [(tag, payload)] = list(tlv.records(stream))
        self.assertEqual(tag, "otrk")
        child_tags = [child for child, _ in tlv.value(tag, payload)]
        self.assertEqual(child_tags, ["pfil", "uadd", "sfoo", "bmis", "bply", "xnew", "tnew"])
        self.assertEqual(tlv.fields(payload, "pfil", "uadd", "sfoo", "bmis", "bply", "uend"), {
            "pfil": "Sets/Año.mp3", "uadd": 0x01020304, "sfoo": 0x1234, "bmis": True, "bply": False,
        })
        self.assertIsNone(tlv.value("xnew", b"\x00"))
        self.assertIsNone(tlv.value("tbad", b"\x00"))

    def test_keys(self):
        cases = {
            "Am": "8A", "G#m": "1A", "Abm": "1A", "8a": "8A", "12B": "12B", "1m": "8A",
            "1D": "8B", "D♭ minor": "12A", "F♯ MIN": "11A", "AM": "11B", "F# Major": "2B",
            "Cb": "1B", "0A": None, "13m": None, "14": None, "": None, None: None,
        }
        for key, camelot in cases.items():
            with self.subTest(key=key):
                self.assertEqual(key_to_camelot(key), camelot)


class SeratoSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(self.enterContext(tempfile.TemporaryDirectory(prefix=".test-", dir=FIXTURES))).absolute()
        self.home = self.temp / "home"
        self.volume = self.home / "Volumes" / VOLUME
        self.cache = self.temp / "cache"
        self.enterContext(patch.dict(os.environ, {"BATEA_SERATO_DIR": str(self.home)}))
        self.pgrep = Mock(return_value=SimpleNamespace(returncode=1))
        self.enterContext(patch("batea.sources.serato.subprocess", SimpleNamespace(
            run=self.pgrep, DEVNULL=subprocess.DEVNULL, SubprocessError=subprocess.SubprocessError,
        )))
        self.source = SeratoSource()

    def test_discover_lists_both_formats_and_external_volume_without_reads(self):
        legacy_library(self.home, self.volume)
        self.enterContext(modern_library(self.home, self.volume))
        self.pgrep.return_value.returncode = 0
        with (
            patch.object(Path, "read_bytes", side_effect=AssertionError("discover leyó un archivo")),
            patch("batea.sources.serato.sqlite3.connect", side_effect=AssertionError("discover abrió SQLite")),
        ):
            info = self.source.discover()
        self.assertEqual((info.kind, info.label, info.found, info.version), ("serato", "Serato", True, "4/5"))
        self.assertEqual(info.detail, f"también en el disco {VOLUME}")
        self.assertEqual(info.locations[0].path, self.home / MASTER)
        self.assertEqual({(loc.path, loc.version, loc.volume) for loc in info.locations}, {
            (self.home / MASTER, "4/5", None),
            (self.home / LEGACY / "database V2", "3.x", None),
            (self.volume / SHARD, "4/5", VOLUME),
            (self.volume / "_Serato_/database V2", "3.x", VOLUME),
        })
        self.assertEqual(info.locations[0].modified, (self.home / MASTER).stat().st_mtime)
        self.assertTrue(info.app_running)
        self.assertEqual(self.pgrep.call_args.args[0][:2], ["pgrep", "-f"])
        self.assertIn("Pro|Lite", self.pgrep.call_args.args[0][2])

    def test_missing_libraries_and_pgrep_failure(self):
        for error in (FileNotFoundError("pgrep"), subprocess.TimeoutExpired("pgrep", 2)):
            self.pgrep.side_effect = error
            info = self.source.discover()
            self.assertEqual((info.found, info.locations, info.version, info.detail, info.app_running),
                             (False, [], None, None, False))

    def test_manual_file_directory_and_custom_mounts(self):
        legacy = legacy_library(self.home, self.volume)
        master = self.enterContext(modern_library(self.home, self.volume))
        for root in (master, master.parent, master.parent.parent, legacy, legacy / "database V2"):
            with self.subTest(root=root):
                paths = {loc.path for loc in SeratoSource(root).discover().locations}
                self.assertEqual(paths, {master, legacy / "database V2",
                                         self.volume / SHARD, self.volume / "_Serato_/database V2"})

        drive = self.temp / "mounts" / "Copia"
        shutil.copytree(self.volume, drive)
        source = SeratoSource(root=self.home, volumes=drive.parent)
        locations = {(loc.path, loc.volume) for loc in source.discover().locations}
        self.assertIn((drive / SHARD, "Copia"), locations)
        self.assertNotIn((self.volume / SHARD, VOLUME), locations)

        for root in (drive, drive / "_Serato_", drive / SHARD):
            with self.subTest(root=root):
                loc = SeratoSource(root).discover().locations[0]
                self.assertEqual((loc.path, loc.volume), (drive / SHARD, "Copia"))

    def test_legacy_snapshot_tracks_crates_rules_and_history(self):
        serato = legacy_library(self.home, self.volume)
        local_garden = self.volume / unicodedata.normalize("NFD", GARDEN)
        local_garden.parent.mkdir()
        local_garden.touch()
        loc = self.source.discover().locations[0]
        self.assertEqual(loc.version, "3.x")
        snap = self.source.snapshot(loc, self.cache)
        self.assertEqual(snap.parent, self.cache)
        for pattern in ("database V2", "neworder.pref", "History/history.database", "History/Sessions/42.session",
                        "Subcrates/Cajas%%Tarde%%Apertura.crate", "SmartCrates/Cálidas.scrate"):
            original = serato / pattern
            self.assertTrue(any(copy.read_bytes() == original.read_bytes() for copy in snap.glob("*/" + pattern)))
        shutil.rmtree(serato)
        shutil.rmtree(self.volume / "_Serato_")
        dump = self.source.read(snap, loc)
        self.assertEqual((dump.kind, dump.version, dump.warnings), ("serato", "3.x", []))
        tracks = {track.ext_id: track for track in dump.tracks}
        self.assertEqual(len(tracks), 4)
        bass_id, sun_id, garden_id = map(canon_path, ("/" + BASS, "/" + SUN, str(local_garden)))
        bass = tracks[bass_id]
        self.assertEqual((bass.path_raw, bass.path, bass.title, bass.artist, bass.album, bass.genre),
                         (BASS, "/" + BASS, "Bajo (versión 3)", "Dúo", "Isla", "House"))
        self.assertEqual((bass.label, bass.comment, bass.bpm, bass.key_raw, bass.key_camelot),
                         ("Río", "Entrada fría", 123.5, "Abm", "1A"))
        self.assertEqual((bass.duration, bass.filesize, bass.bitrate, bass.year), (192.5, 2621440, 320, 2020))
        self.assertEqual((bass.color, bass.rating, bass.play_count, bass.date_added, bass.cues, bass.grid),
                         ("#123ABC", None, 7, "2023-11-14", [], []))
        with patch("batea.sources.serato.os.path.exists", side_effect=lambda path: path == str(local_garden)):
            unicode_dump = self.source.read(snap, loc)
        self.assertEqual(next(track.path for track in unicode_dump.tracks if track.ext_id == garden_id), str(local_garden))
        self.assertEqual(tracks[sun_id].filesize, 12345)

        crates = {crate.name: crate for crate in dump.crates}
        self.assertEqual(len(crates), 5)
        parent, implicit, child = [crates[name] for name in ("Cajas", "Tarde", "Apertura")]
        self.assertEqual((parent.kind, parent.position, parent.track_ext_ids), ("playlist", 1, [bass_id]))
        self.assertEqual((implicit.kind, implicit.parent_ext_id), ("folder", parent.ext_id))
        self.assertEqual((child.parent_ext_id, child.track_ext_ids), (implicit.ext_id, [sun_id, bass_id, sun_id, garden_id]))
        self.assertEqual(crates["Archivo"].position, 0)
        smart = crates["Cálidas"]
        self.assertEqual(smart.kind, "smart")
        self.assertEqual(json.loads(smart.rules_raw), {"match_all": True, "live_update": False, "rules": [
            {"field_id": 9, "operator": "cond_con_str", "value": "Música"},
            {"field_id": 15, "operator": "cond_greq_uint", "value": 110},
        ]})

        lost, session = dump.sessions
        self.assertEqual((lost.plays[0].track_ext_id, lost.plays[0].title), (None, "Borrado"))
        self.assertEqual((session.name, session.start), ("Noche antigua", iso(START)))
        self.assertEqual([p.track_ext_id for p in session.plays], [bass_id, sun_id, garden_id])
        self.assertEqual([p.position for p in session.plays], [0, 1, 2])
        self.assertEqual([p.duration_s for p in session.plays], [28, 14, 18])
        play = session.plays[0]
        self.assertEqual((play.on_air, play.title, play.artist, play.path, play.bpm, play.key_camelot, play.deck),
                         (True, "Bajo de archivo", "Dúo de archivo", "/" + BASS, 124, "1A", 2))

    def test_sqlite_snapshot_includes_wal_assets_across_disks_and_sparse_schema(self):
        master = self.enterContext(modern_library(self.home, self.volume))
        loc = self.source.discover().locations[0]
        snap = self.source.snapshot(loc, self.cache)
        copy, = snap.glob("*/master.sqlite")
        sidecars = [master, master.with_name("master.sqlite-wal"), master.with_name("master.sqlite-shm")]
        contents = {file: file.read_bytes() for file in sidecars}
        for file in sidecars:
            self.assertEqual(contents[file], copy.with_name(file.name).read_bytes())
        self.assertEqual(len(list(snap.glob("*/location.sqlite"))), 1)
        self.assertEqual(len(list(snap.glob("*/root.sqlite"))), 1)
        connect = sqlite3.connect
        with patch("batea.sources.serato.sqlite3.connect", wraps=connect) as opened:
            dump = self.source.read(snap, loc)
        self.assertEqual(opened.call_count, 3)
        for call in opened.call_args_list:
            self.assertIn(snap.as_uri(), call.args[0])
            self.assertTrue(call.args[0].endswith("?mode=ro"))
            self.assertEqual(call.kwargs, {"uri": True})
        self.assertEqual(contents, {file: file.read_bytes() for file in sidecars})

        tracks = {t.ext_id: t for t in dump.tracks}
        self.assertEqual(len(tracks), 4)
        bass, sun, garden = map(canon_path, ("/" + BASS, "/" + SUN, str(self.volume / GARDEN)))
        self.assertEqual((tracks[bass].title, tracks[bass].comment, tracks[bass].rating, tracks[bass].color),
                         ("Bajo 4", "Remaster", 3.5, "#112233"))
        self.assertEqual((tracks[bass].duration, tracks[bass].filesize, tracks[bass].play_count,
                          tracks[bass].key_camelot), (192.5, 20155, 13, "8A"))
        self.assertEqual((tracks[garden].duration, tracks[garden].key_camelot, tracks[garden].rating),
                         (211.5, "12A", None))
        self.assertEqual(tracks[sun].path, "/" + SUN)
        crates = {crate.name: crate for crate in dump.crates}
        self.assertNotIn("Library", crates)
        self.assertNotIn("Prepare", crates)
        self.assertEqual((crates["Cajas"].kind, crates["Cajas"].track_ext_ids), ("playlist", [bass]))
        self.assertEqual((crates["Cruces"].parent_ext_id, crates["Cruces"].track_ext_ids),
                         (crates["Cajas"].ext_id, [garden, bass]))
        self.assertEqual(crates["Vacía"].kind, "folder")
        self.assertEqual(crates["Padre sin temas"].kind, "folder")
        self.assertEqual(crates["SSD"].track_ext_ids, [garden])
        self.assertEqual((crates["Cálidas"].kind, crates["Cálidas"].rules_raw),
                         ("smart", '{"rules":[{"field":"bpm","value":120}]}'))
        session, = dump.sessions
        self.assertEqual((session.name, session.start), ("Sesión de club", iso(START)))
        self.assertEqual([p.track_ext_id for p in session.plays], [bass, garden, sun, None])
        self.assertEqual([p.duration_s for p in session.plays], [28, None, None, None])
        self.assertEqual([p.deck for p in session.plays], [1, 3, 4, 2])
        self.assertEqual(session.plays[-1].path, str(self.volume / "Sets/Borrado.wav"))

    def test_merges_partial_migration_and_preserves_distinct_repeats(self):
        legacy_library(self.home, self.volume)
        self.enterContext(modern_library(self.home, self.volume))
        loc = self.source.discover().locations[-1]  # el snapshot también incluye las bases modernas desde una selección 3.x
        dump = self.source.read(self.source.snapshot(loc, self.cache), loc)
        self.assertEqual(len(dump.tracks), 4)
        bass = next(track for track in dump.tracks if track.path_raw == BASS)
        self.assertEqual((bass.title, bass.bpm, bass.rating, bass.label), ("Bajo 4", 127.25, 3.5, "Río"))
        self.assertEqual(len([crate for crate in dump.crates if crate.name == "Cajas"]), 1)
        lost, merged = dump.sessions
        self.assertEqual(lost.plays[0].title, "Borrado")
        self.assertEqual(merged.name, "Sesión de club")
        self.assertEqual([p.title for p in merged.plays],
                         ["Bajo en vivo", "Sol de archivo", "Jardín en vivo", "Sol en vivo", "Corte"])
        self.assertEqual([p.position for p in merged.plays], list(range(5)))
        self.assertEqual(merged.plays[2].duration_s, 18)

    def test_reads_legacy_sessions_even_if_only_modern_database_remains(self):
        serato = legacy_library(self.home, self.volume)
        (serato / "database V2").unlink()
        (self.volume / "_Serato_/database V2").unlink()
        self.enterContext(modern_library(self.home, self.volume))
        loc = self.source.discover().locations[0]
        dump = self.source.read(self.source.snapshot(loc, self.cache), loc)
        self.assertEqual([s.plays[0].title for s in dump.sessions], ["Borrado", "Bajo en vivo"])
        self.assertIn("Sol de archivo", [p.title for p in dump.sessions[1].plays])

    def test_registry_sync_imports_tracks_crates_sessions_and_transitions(self):
        legacy_library(self.home, self.volume)
        app = self.temp / "Batea"
        # Un proceso limpio lee BATEA_HOME antes de importar config.
        run = subprocess.check_output([sys.executable, "-c", textwrap.dedent("""
            import json
            import sys
            from unittest.mock import Mock
            from batea import config, db
            from batea.sources import registry

            config.EXPORT_DIR = config.APP_DIR / "export"
            db.init()
            with db.conn() as con:
                db.set_meta(con, "source_path:serato", sys.argv[1])
                assert registry.detect_one(con, "serato")["found"]
            first = registry.sync("serato", Mock())
            registry.sync("serato", Mock())
            print(json.dumps(first))
        """), str(self.home / LEGACY / "database V2")],
            env={**os.environ, "BATEA_HOME": str(app), "BATEA_SERATO_DIR": str(self.temp / "no-encontrar")},
            text=True,
        )
        stats = json.loads(run)
        self.assertEqual((stats["nuevos"], stats["sesiones"], stats["transiciones del historial"]), (4, 2, 2))
        with sqlite3.connect(app / "batea.db") as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM track_sources WHERE source='serato'").fetchone(), (4,))
            self.assertEqual(con.execute(
                "SELECT name, kind FROM crates WHERE source='serato' AND name IN ('Cajas','Noche antigua') ORDER BY name"
            ).fetchall(), [("Cajas", "playlist"), ("Noche antigua", "session")])
            rows = con.execute("""
                SELECT a.title, b.title, r.count FROM relations r
                JOIN tracks a ON a.id=r.a JOIN tracks b ON b.id=r.b
                WHERE r.source='history:serato' ORDER BY a.title
            """).fetchall()
            self.assertEqual(rows, [("Bajo (versión 3)", "Sol", 1), ("Sol", "Jardín 3", 1)])
            self.assertIsNone(con.execute("SELECT last_played FROM tracks WHERE title='Carga'").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
