import os
import shutil
import subprocess
import tempfile
import unicodedata
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from batea.sources.traktor import TraktorSource, location_to_path, musical_key_to_camelot

FIXTURES = Path(__file__).parent / "fixtures" / "traktor"
V3 = "Traktor 3.11.1"
V4 = "Traktor 4.5.1"
BASS = "Macintosh HD/:Music/:Bajo// Marea.aiff"
GARDEN = "Disco DJ/:Sets/:Jardín.flac"
OLD_SESSION = "history_2019y10m18d_19h05m32s.nml"
DUPLICATE_SESSION = "history_2022y12m13d_04h59m06s.nml"
NEW_SESSION = "history_2026y11m10d_23h55m00s.nml"


class TraktorMappingTests(unittest.TestCase):
    def test_all_musical_keys(self):
        expected = (
            "8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B",
            "5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A",
        )
        for value, camelot in enumerate(expected):
            with self.subTest(value=value):
                self.assertEqual(musical_key_to_camelot(value), camelot)

    def test_boot_volume_prefers_root_with_mount_fallback(self):
        mount = "/Volumes/Macintosh HD"
        mounted_path = f"{mount}/Music/Set.aiff"
        root_path = "/Music/Set.aiff"
        existing = {root_path, mounted_path}
        with (
            patch("batea.sources.traktor.os.path.realpath", side_effect=lambda path: "/" if path == mount else path),
            patch("batea.sources.traktor.os.path.exists", side_effect=existing.__contains__),
        ):
            self.assertEqual(location_to_path("Macintosh HD", "/:Music/:", "Set.aiff"), root_path)
            existing.remove(root_path)
            self.assertEqual(location_to_path("Macintosh HD", "/:Music/:", "Set.aiff"), mounted_path)
            existing.clear()
            self.assertEqual(location_to_path("Macintosh HD", "/:Music/:", "Set.aiff"), mounted_path)

    def test_external_volume_preserves_mount_and_decodes_components(self):
        existing = {"/Music/Puente: 1.wav"}
        with (
            patch("batea.sources.traktor.os.path.realpath", side_effect=lambda path: path),
            patch("batea.sources.traktor.os.path.exists", side_effect=existing.__contains__),
        ):
            self.assertEqual(
                location_to_path("DJ\ufeff Disco", "/:Music/:Noche//Día/:\ufeff", "\ufeffPuente// 1.wav"),
                "/Volumes/DJ Disco/Music/Noche:Día/Puente: 1.wav",
            )
            self.assertEqual(
                location_to_path("DJ Disco", "/:Music/:", "Puente// 1.wav"),
                "/Volumes/DJ Disco/Music/Puente: 1.wav",
            )

    def test_normalizes_unicode_for_existing_and_offline_files(self):
        nfc = "/Volumes/Música/Colección/Jardín.flac"
        nfd = unicodedata.normalize("NFD", nfc)
        existing = {nfd}
        with (
            patch("batea.sources.traktor.os.path.realpath", side_effect=lambda path: path),
            patch("batea.sources.traktor.os.path.exists", side_effect=existing.__contains__),
        ):
            self.assertEqual(location_to_path("Música", "/:Colección/:", "Jardín.flac"), nfd)
            existing.add(nfc)
            self.assertEqual(location_to_path("Música", "/:Colección/:", "Jardín.flac"), nfc)
            existing.clear()
            self.assertEqual(
                location_to_path("Música", "/:Colección/:", unicodedata.normalize("NFD", "Jardín.flac")),
                nfc,
            )


class TraktorSourceTests(unittest.TestCase):
    def setUp(self):
        self.source = TraktorSource()
        self.temp = Path(self.enterContext(tempfile.TemporaryDirectory(prefix=".test-", dir=FIXTURES)))
        self.cache = self.temp / "cache"
        self.enterContext(patch.dict(os.environ, {"BATEA_TRAKTOR_DIR": str(FIXTURES)}))
        self.pgrep = self.enterContext(
            patch("batea.sources.traktor.subprocess.run", return_value=SimpleNamespace(returncode=1))
        )

    def copy_library(self):
        library = self.temp / "library"
        for version in (V3, V4):
            shutil.copytree(FIXTURES / version, library / version)
        self.enterContext(patch.dict(os.environ, {"BATEA_TRAKTOR_DIR": str(library)}))
        return library

    def read_snapshot(self, snap, loc):
        with (
            patch("batea.sources.traktor.os.path.realpath", side_effect=lambda path: path),
            patch("batea.sources.traktor.os.path.exists", return_value=False),
        ):
            return self.source.read(snap, loc)

    def test_discover_fixture_versions_and_saved_date_without_parsing(self):
        with patch("batea.sources.traktor.ET.parse", side_effect=AssertionError("discover leyó XML")):
            info = self.source.discover()
        self.assertEqual((info.kind, info.label, info.found), ("traktor", "Traktor", True))
        self.assertEqual([loc.path for loc in info.locations], [
            FIXTURES / V4 / "collection.nml",
            FIXTURES / V3 / "collection.nml",
        ])
        self.assertEqual([loc.version for loc in info.locations], ["4.5.1", "3.11.1"])
        self.assertEqual(info.version, "4.5.1")
        modified = (FIXTURES / V4 / "collection.nml").stat().st_mtime
        self.assertEqual(info.locations[0].modified, modified)
        saved = datetime.fromtimestamp(modified)
        self.assertEqual(info.detail, f"guardado el {saved.day}/{saved.month}")
        self.assertFalse(info.app_running)

    def test_discover_numeric_order_pro_suffix_and_truncated_xml(self):
        library = self.copy_library()
        higher = library / "Traktor Pro 4.10.0"
        higher.mkdir()
        (higher / "collection.nml").write_text("<NML VERSION=", encoding="utf-8")
        (library / "Traktor 6.0.0").mkdir()
        self.pgrep.return_value.returncode = 0
        info = self.source.discover()
        self.assertEqual([loc.version for loc in info.locations], ["4.10.0", "4.5.1", "3.11.1"])
        self.assertTrue(info.app_running)
        self.assertEqual(self.pgrep.call_args.args[0][:2], ["pgrep", "-f"])

    def test_discover_handles_missing_root_and_pgrep_errors(self):
        self.pgrep.side_effect = FileNotFoundError("pgrep")
        with patch.dict(os.environ, {"BATEA_TRAKTOR_DIR": str(self.temp / "missing")}):
            info = self.source.discover()
        self.assertEqual((info.found, info.locations, info.version, info.detail), (False, [], None, None))
        self.assertFalse(info.app_running)
        self.pgrep.side_effect = subprocess.TimeoutExpired("pgrep", 2)
        self.assertFalse(self.source.discover().app_running)

    def test_snapshot_preserves_versions_and_read_only_uses_the_copy(self):
        library = self.copy_library()
        loc = self.source.discover().locations[0]
        snap = self.source.snapshot(loc, self.cache)
        self.assertEqual(snap.parent, self.cache)
        expected = {
            f"{V3}/collection.nml",
            f"{V3}/History/{OLD_SESSION}",
            f"{V3}/History/{DUPLICATE_SESSION}",
            f"{V4}/collection.nml",
            f"{V4}/History/{DUPLICATE_SESSION}",
            f"{V4}/History/{NEW_SESSION}",
        }
        self.assertEqual({path.relative_to(snap).as_posix() for path in snap.rglob("*.nml")}, expected)
        for path in expected:
            self.assertEqual((snap / path).read_bytes(), (library / path).read_bytes())
        shutil.rmtree(library)
        dump = self.read_snapshot(snap, loc)
        self.assertEqual((dump.kind, dump.version, len(dump.tracks), len(dump.sessions)), ("traktor", "4.5.1", 5, 3))

    def test_read_traktor_4_metadata_cues_and_flexible_grid(self):
        loc = self.source.discover().locations[0]
        dump = self.read_snapshot(self.source.snapshot(loc, self.cache), loc)
        tracks = {track.ext_id: track for track in dump.tracks}
        self.assertEqual(len(tracks), 5)
        self.assertEqual(len(dump.warnings), 1)
        self.assertIn("2 muestras", dump.warnings[0])

        bass = tracks[BASS]
        self.assertEqual(bass.path_raw, BASS)
        self.assertEqual(bass.path, "/Volumes/Macintosh HD/Music/Bajo: Marea.aiff")
        self.assertEqual((bass.title, bass.artist, bass.album), (
            "Bajo de marea (edición)", "Faro de papel", "Costa de papel",
        ))
        self.assertEqual((bass.label, bass.genre, bass.remixer, bass.comment), (
            "Cometa Gris", "House", "Nube de tiza", "Instrumental",
        ))
        self.assertEqual((bass.bpm, bass.key_raw, bass.key_camelot), (123.5, "14", "7A"))
        self.assertEqual((bass.rating, bass.bitrate, bass.duration, bass.filesize), (5.0, 320, 360.5, 61500 * 1024))
        self.assertEqual(
            (bass.play_count, bass.date_added, bass.last_played, bass.year),
            (11, "2019-02-04", "2026-11-11", 2018),
        )
        self.assertRegex(bass.color, r"^#[0-9A-F]{6}$")
        self.assertEqual(
            [(cue.kind, cue.start_ms, cue.end_ms, cue.slot, cue.name, cue.color) for cue in bass.cues],
            [
                ("hot", 8300, None, 1, "Entrada", "#1122AA"),
                ("loop", 2080.5, 4000.75, 3, "Puente", None),
                ("loop", 6000, 6500, None, None, None),
            ],
        )

        garden = tracks[GARDEN]
        self.assertEqual([(marker.start_ms, marker.bpm) for marker in garden.grid], [(42.5, 116.25), (80000, 118.75)])
        self.assertEqual(
            [(cue.kind, cue.slot, cue.start_ms, cue.name) for cue in garden.cues],
            [("memory", None, 6200, None), ("hot", 0, 1800, "AutoGrid")],
        )
        glass = tracks["Disco DJ/:Sets/:Vidrio.flac"]
        self.assertEqual([cue.kind for cue in glass.cues], ["fade_in", "fade_out", "load"])
        self.assertAlmostEqual(glass.rating, 112 / 51)
        rada = tracks["Macintosh HD/:Music/:Rada.aiff"]
        self.assertEqual((rada.key_raw, rada.key_camelot, rada.rating), ("Am", None, None))
        door = tracks["Macintosh HD/:Music/:Puerta.aiff"]
        self.assertEqual((door.key_raw, door.key_camelot, door.rating), ("99", None, 0))
        self.assertEqual(len({track.color for track in dump.tracks if track.color}), 4)

    def test_read_nested_playlists_and_smartlist(self):
        loc = self.source.discover().locations[0]
        crates = self.read_snapshot(self.source.snapshot(loc, self.cache), loc).crates
        self.assertEqual(
            [(crate.ext_id, crate.name, crate.kind, crate.parent_ext_id, crate.position) for crate in crates],
            [
                ("fixture-20-bolsos", "Bolsos", "folder", None, 0),
                ("Bolsos/2026", "2026", "folder", "fixture-20-bolsos", 0),
                ("fixture-20-apertura", "Apertura", "playlist", "Bolsos/2026", 0),
                ("fixture-20-energia", "Energía", "smart", None, 1),
            ],
        )
        self.assertEqual(crates[2].track_ext_ids, [GARDEN, BASS, GARDEN])
        self.assertEqual(crates[3].track_ext_ids, [])
        self.assertEqual(crates[3].rules_raw, "BPM > 116 & RANKING > 100")

    def test_read_traktor_3_and_grid_hotcue(self):
        loc = self.source.discover().locations[1]
        dump = self.read_snapshot(self.source.snapshot(loc, self.cache), loc)
        tracks = {track.ext_id: track for track in dump.tracks}
        self.assertEqual(dump.version, "3.11.1")
        self.assertEqual(len(tracks), 5)
        self.assertIn("1 muestra", dump.warnings[0])
        bass = tracks[BASS]
        self.assertEqual((bass.title, bass.rating), ("Bajo de marea", 3.0))
        self.assertEqual([(marker.start_ms, marker.bpm) for marker in bass.grid], [(320.5, 123.5)])
        self.assertEqual([(cue.kind, cue.slot) for cue in bass.cues], [("hot", 0), ("hot", 1), ("loop", 3)])
        self.assertIsNone(bass.cues[0].name)
        self.assertEqual(tracks["Disco DJ/:Sets/:Taller.flac"].cues[0].name, "AutoGrid")
        self.assertEqual([session.ext_id for session in dump.sessions], [OLD_SESSION, DUPLICATE_SESSION, NEW_SESSION])
        self.assertIsNone(dump.sessions[-1].plays[0].track_ext_id)

    def test_read_sessions_deduplicates_and_uses_historical_track_metadata(self):
        loc = self.source.discover().locations[0]
        sessions = self.read_snapshot(self.source.snapshot(loc, self.cache), loc).sessions
        self.assertEqual([session.ext_id for session in sessions], [OLD_SESSION, DUPLICATE_SESSION, NEW_SESSION])
        old, duplicate, new = sessions
        self.assertEqual((old.name, old.start), ("Sesión 18/10/2019 19:05", "2019-10-18T19:05:32"))
        self.assertEqual([play.position for play in old.plays], [0, 1])
        deleted, current = old.plays
        self.assertEqual((deleted.track_ext_id, deleted.start, deleted.duration_s, deleted.deck, deleted.on_air), (
            None, "2019-10-18T19:07:19", 62.5, 1, False,
        ))
        self.assertEqual((deleted.title, deleted.artist, deleted.path, deleted.bpm, deleted.key_camelot), (
            "Faro apagado", "Humo de sal", "/Volumes/Disco DJ/Archivo/Faro.flac", 121.25, "12A",
        ))
        self.assertEqual((current.track_ext_id, current.title, current.bpm, current.on_air), (
            BASS, "Bajo de marea (en vivo)", 124.0, True,
        ))
        self.assertEqual(duplicate.plays[0].title, "Marea (copia reciente)")
        self.assertEqual([play.start for play in new.plays], ["2026-11-10T23:57:00", "2026-11-11T00:01:40"])

    def test_truncated_collection_uses_newest_valid_backup_and_warns(self):
        library = self.copy_library()
        collection = library / V4 / "collection.nml"
        valid_xml = collection.read_text(encoding="utf-8")
        collection.write_text('<NML VERSION="20"><COLLECTION>', encoding="utf-8")
        backups = collection.parent / "Backup" / "Collection"
        backups.mkdir(parents=True)
        old = backups / "z-anterior.nml"
        recent = backups / "a-reciente.nml"
        broken = backups / "truncado.nml"
        old.write_text(valid_xml, encoding="utf-8")
        recent.write_text(valid_xml.replace("Bajo de marea (edición)", "Bajo de marea (respaldo)"), encoding="utf-8")
        broken.write_text("<NML", encoding="utf-8")
        for mtime, path in enumerate([old, recent, broken], start=1):
            os.utime(path, (mtime, mtime))
        loc = self.source.discover().locations[0]
        snap = self.source.snapshot(loc, self.cache)
        dump = self.read_snapshot(snap, loc)
        self.assertEqual(len(dump.tracks), 5)
        self.assertEqual(dump.tracks[0].title, "Bajo de marea (respaldo)")
        self.assertTrue(any(V4 in warning and recent.name in warning for warning in dump.warnings))
        self.assertEqual(collection.read_text(encoding="utf-8"), '<NML VERSION="20"><COLLECTION>')
        self.assertEqual((snap / V4 / "collection.nml").read_bytes(), recent.read_bytes())

    def test_truncated_collection_without_backup_leaves_no_partial_snapshot(self):
        library = self.copy_library()
        (library / V4 / "collection.nml").write_text("<NML", encoding="utf-8")
        loc = self.source.discover().locations[0]
        with self.assertRaises(ET.ParseError):
            self.source.snapshot(loc, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_truncated_previous_collection_preserves_its_history(self):
        library = self.copy_library()
        (library / V3 / "collection.nml").write_text("<NML", encoding="utf-8")
        backup = library / V3 / "Backup" / "Collection" / "truncado.nml"
        backup.parent.mkdir(parents=True)
        backup.write_text("<NML VERSION=", encoding="utf-8")
        loc = self.source.discover().locations[0]
        snap = self.source.snapshot(loc, self.cache)
        dump = self.read_snapshot(snap, loc)
        self.assertEqual(len(dump.tracks), 5)
        self.assertEqual([session.ext_id for session in dump.sessions], [OLD_SESSION, DUPLICATE_SESSION, NEW_SESSION])
        self.assertEqual((snap / V3 / "collection.nml").read_text(encoding="utf-8"), "<NML")
        self.assertTrue(any(V3 in warning and "respaldo válido" in warning for warning in dump.warnings))

    def test_skips_corrupt_history_and_reads_older_duplicate(self):
        library = self.copy_library()
        invalid = library / V4 / "History" / DUPLICATE_SESSION
        invalid.write_bytes(b'<?xml version="1.0" encoding="imaginario"?><NML/>')
        (library / V3 / "History" / OLD_SESSION).write_text("<NML", encoding="utf-8")
        loc = self.source.discover().locations[0]
        dump = self.read_snapshot(self.source.snapshot(loc, self.cache), loc)
        self.assertEqual([session.ext_id for session in dump.sessions], [DUPLICATE_SESSION, NEW_SESSION])
        self.assertEqual(dump.sessions[0].plays[0].title, "Marea (copia anterior)")
        self.assertTrue(any(V4 in warning and DUPLICATE_SESSION in warning for warning in dump.warnings))
        self.assertTrue(any(V3 in warning and OLD_SESSION in warning for warning in dump.warnings))


if __name__ == "__main__":
    unittest.main()
