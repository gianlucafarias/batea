import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from batea import config, db, nowplaying, nowplaying_serato
from batea.live_base import LiveReading, PlayRef
from tests.fixtures.serato.build import BASS, GARDEN, LOAD_ONLY, SUN, VOLUME, legacy_library, modern_library

OLD_KEYS = {"rekordbox", "source", "now", "loaded", "recs", "session", "played", "open_files"}
NEW_KEYS = {"app", "app_label", "running", "note", "enabled", "mode"}


def abs_(p):
    return p if p.startswith("/") else "/" + p


class FakeTraktor:
    APP = "traktor"
    LABEL = "Traktor"

    def __init__(self, reading, up=True):
        self.reading, self.up = reading, up

    def running(self):
        return self.up

    def read(self, c):
        return self.reading


class NowPlayingTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(self.enterContext(tempfile.TemporaryDirectory())).absolute()
        self.home = self.temp / "home"
        self.volume = self.home / "Volumes" / VOLUME
        app = self.temp / "app"
        app.mkdir()
        self.enterContext(patch.object(config, "APP_DIR", app))
        self.enterContext(patch.dict(os.environ, {"BATEA_SERATO_DIR": str(self.home)}))
        self.c = sqlite3.connect(app / "batea.db")
        self.c.row_factory = sqlite3.Row
        self.addCleanup(self.c.close)
        self.c.executescript(db.SCHEMA)
        for table, col, decl in db.MIGRATIONS:
            if col not in {r["name"] for r in self.c.execute(f"PRAGMA table_info({table})")}:
                self.c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        self.ids = {}
        rows = [
            ("bass", abs_(BASS), "Bajo en vivo", "Dúo", 126, "8A"),
            ("sun", abs_(SUN), "Sol en vivo", "Sol", 121, "8A"),
            ("load", abs_(LOAD_ONLY), "Solo cargado", "Carga", 120, "9A"),
            ("garden", str(self.volume / GARDEN), "Jardín en vivo", "Jardín", 122, "8B"),
            ("n1", "/x/n1.mp3", "Vecino uno", "A", 121, "8A"),
            ("n2", "/x/n2.mp3", "Vecino dos", "B", 122, "9A"),
            ("n3", "/x/n3.mp3", "Vecino tres", "C", 120, "7A"),
        ]
        for name, path, title, artist, bpm, key in rows:
            cur = self.c.execute("INSERT INTO tracks(path, title, artist, bpm, key, source) VALUES (?,?,?,?,?,?)",
                                 (path, title, artist, bpm, key, "serato"))
            self.ids[name] = cur.lastrowid
        self.c.commit()
        nowplaying._seen.clear()
        nowplaying._recs_cache.clear()
        nowplaying._titles.update(t=0.0, map={})
        nowplaying_serato.reset()
        self.enterContext(patch.object(nowplaying_serato, "STALE_AFTER", 10 ** 10))
        self.enterContext(patch.object(nowplaying, "_traktor", lambda: None))
        self.enterContext(patch.object(nowplaying, "rekordbox_pid", lambda: None))
        self.enterContext(patch.object(nowplaying_serato, "running", lambda: True))

    # ------------------------------------------------------------------ Serato 4/5
    def test_serato4_session_in_progress(self):
        with modern_library(self.home, self.volume) as master:
            with sqlite3.connect(master) as con:
                con.execute("DELETE FROM history_entry WHERE id IN (3, 5)")
            r = nowplaying_serato.read(self.c)
            self.assertEqual([p.path for p in r.played], [abs_(BASS), abs_(SUN)])
            self.assertEqual(r.now.path, abs_(SUN))
            self.assertEqual([p.path for p in r.loaded], [abs_(SUN), abs_(LOAD_ONLY)])
            self.assertEqual(r.session, "Sesión de club")

            nowplaying_serato.reset()
            res = nowplaying.state(self.c, 5)
        i = self.ids
        self.assertEqual((res["app"], res["app_label"], res["running"], res["rekordbox"]), ("serato", "Serato", ["serato"], False))
        self.assertEqual((res["source"], res["now"]["id"], res["played"]), ("aire", i["sun"], 2))
        self.assertEqual([t["id"] for t in res["loaded"]], [i["load"]])
        rec_ids = {t["id"] for t in res["recs"]}
        self.assertTrue(rec_ids and not rec_ids & {i["bass"], i["sun"], i["load"]})
        self.assertTrue(OLD_KEYS | NEW_KEYS <= set(res))

    def test_serato4_nothing_open_uses_last_played(self):
        with modern_library(self.home, self.volume) as master:
            with sqlite3.connect(master) as con:
                con.execute("DELETE FROM history_entry WHERE id IN (3, 4, 5)")
            res = nowplaying.state(self.c, 5)
        # ya no suena nada al aire: como en rekordbox, manda lo que está cargado en un deck
        self.assertEqual(res["source"], "deck")
        self.assertEqual(res["now"]["id"], self.ids["load"])

    def test_serato4_nothing_loaded_uses_history(self):
        with modern_library(self.home, self.volume) as master:
            with sqlite3.connect(master) as con:
                con.execute("DELETE FROM history_entry WHERE id IN (2, 3, 4, 5)")
            res = nowplaying.state(self.c, 5)
        # nada al aire ni en los decks: el último que sonó, marcado como historial (no "aire")
        self.assertEqual(res["source"], "historial")
        self.assertEqual(res["now"]["id"], self.ids["bass"])

    def test_serato3_session_file(self):
        legacy_library(self.home, self.volume)
        sessions = self.home / "Music/_Serato_/History/Sessions"
        os.utime(sessions / "99.session", (1, 1))
        r = nowplaying_serato.read(self.c)
        self.assertEqual(r.now.path, str(self.volume / GARDEN))
        self.assertEqual([p.title for p in r.played], ["Bajo de archivo", "Sol de archivo", "Jardín de archivo"])
        self.assertEqual(len(r.loaded), 3)
        nowplaying_serato.reset()
        res = nowplaying.state(self.c, 5)
        self.assertEqual((res["app"], res["source"], res["now"]["id"]), ("serato", "aire", self.ids["garden"]))
        self.assertEqual({t["id"] for t in res["loaded"]}, {self.ids["sun"], self.ids["load"]})
        self.assertEqual(res["played"], 2 + 1)

    def test_serato_truncated_session_tolerated(self):
        legacy_library(self.home, self.volume)
        f = self.home / "Music/_Serato_/History/Sessions/42.session"
        f.write_bytes(f.read_bytes() + b"oent\x00\x00\x10")
        os.utime(self.home / "Music/_Serato_/History/Sessions/99.session", (1, 1))
        self.assertEqual(nowplaying_serato.read(self.c).now.path, str(self.volume / GARDEN))

    def test_serato_copy_is_rate_limited_and_stale_ignored(self):
        legacy_library(self.home, self.volume)
        os.utime(self.home / "Music/_Serato_/History/Sessions/99.session", (1, 1))
        with patch.object(nowplaying_serato, "_compute", wraps=nowplaying_serato._compute) as comp:
            nowplaying_serato.read(self.c)
            nowplaying_serato.read(self.c)
            self.assertEqual(comp.call_count, 1)
        os.utime(self.home / "Music/_Serato_/History/Sessions/42.session", (1, 1))
        nowplaying_serato.reset()
        with patch.object(nowplaying_serato, "STALE_AFTER", 1):
            self.assertIsNone(nowplaying_serato.read(self.c).now)

    def test_no_serato_files_gives_empty_reading_state(self):
        res = nowplaying.state(self.c, 5)
        self.assertEqual((res["app"], res["now"], res["recs"], res["running"]), ("serato", None, [], ["serato"]))

    # ------------------------------------------------------------------ dispatcher
    def test_title_artist_match_prefers_program_source(self):
        self.c.execute("INSERT INTO tracks(path, title, artist, source) VALUES ('/y/dup.mp3','Vecino uno','A','rekordbox')")
        self.c.execute("UPDATE tracks SET title='Vecino uno' WHERE id=?", (self.ids["n1"],))
        self.c.commit()
        ref = PlayRef(title="VECINO  uno", artist="a")
        self.assertEqual(nowplaying._track_for_ref(self.c, ref, "serato"), self.ids["n1"])
        self.assertIsNone(nowplaying._track_for_ref(self.c, PlayRef(title="Vecino uno", artist="Otro"), "serato"))

    def test_several_programs_pick_most_recent_activity(self):
        now = time.time()
        sera = LiveReading("serato", now=PlayRef(path=abs_(SUN)), activity=now - 100)
        trak = LiveReading("traktor", now=PlayRef(title="Vecino dos", artist="B"), activity=now - 5, note="Activá Broadcasting")
        with patch.object(nowplaying_serato, "read", lambda c: sera), \
                patch.object(nowplaying, "_traktor", lambda: FakeTraktor(trak)):
            res = nowplaying.state(self.c, 5)
            self.assertEqual((res["app"], res["app_label"], res["running"], res["note"]),
                             ("traktor", "Traktor", ["serato", "traktor"], "Activá Broadcasting"))
            self.assertEqual(res["now"]["id"], self.ids["n2"])
            trak.activity = now - 500
            self.assertEqual(nowplaying.state(self.c, 5)["app"], "serato")

    def test_rekordbox_wins_when_its_deck_is_newer(self):
        sera = LiveReading("serato", now=PlayRef(path=abs_(SUN)), activity=time.time() - 3600)
        with patch.object(nowplaying, "rekordbox_pid", lambda: 1), \
                patch.object(nowplaying, "open_audio_files", lambda pid: [abs_(BASS)]), \
                patch.object(nowplaying, "_history", lambda: ([], None)), \
                patch.object(nowplaying_serato, "read", lambda c: sera):
            res = nowplaying.state(self.c, 5)
        self.assertEqual((res["app"], res["rekordbox"], res["running"]), ("rekordbox", True, ["rekordbox", "serato"]))

    def test_traktor_failing_import_or_running_is_ignored(self):
        with patch.object(nowplaying, "_traktor", lambda: FakeTraktor(None, up=False)):
            self.assertEqual(nowplaying.state(self.c, 5)["running"], ["serato"])
        self.assertIsNone(nowplaying.__dict__["_traktor"]() if False else None)

    def test_nothing_open(self):
        with patch.object(nowplaying_serato, "running", lambda: False):
            res = nowplaying.state(self.c, 5)
        self.assertEqual((res["app"], res["app_label"], res["running"], res["now"], res["loaded"], res["recs"],
                          res["source"], res["rekordbox"]), (None, None, [], None, [], [], None, False))

    def test_rekordbox_keeps_its_old_shape(self):
        with patch.object(nowplaying, "rekordbox_pid", lambda: 1), \
                patch.object(nowplaying, "open_audio_files", lambda pid: [abs_(BASS), abs_(SUN)]), \
                patch.object(nowplaying, "_history", lambda: ([], "Hoy")), \
                patch.object(nowplaying_serato, "running", lambda: False):
            res = nowplaying.state(self.c, 5)
        self.assertEqual(set(res), OLD_KEYS | NEW_KEYS)
        self.assertEqual((res["rekordbox"], res["app"], res["source"], res["session"], res["open_files"]),
                         (True, "rekordbox", "deck", "Hoy", 2))
        self.assertIn(res["now"]["id"], {self.ids["bass"], self.ids["sun"]})
        self.assertEqual(len(res["loaded"]), 1)

        with patch.object(nowplaying, "rekordbox_pid", lambda: None), \
                patch.object(nowplaying_serato, "running", lambda: False):
            self.assertEqual({k: v for k, v in nowplaying.state(self.c, 5).items() if k in OLD_KEYS},
                             {"rekordbox": False, "now": None, "loaded": [], "recs": [], "source": None})


if __name__ == "__main__":
    unittest.main()


class LiveSettingsTests(unittest.TestCase):
    """Ajuste general: apagado no lee nada; con un programa elegido, solo ese."""

    def setUp(self):
        from batea import live_settings
        self.c = sqlite3.connect(":memory:")
        self.c.row_factory = sqlite3.Row
        self.addCleanup(self.c.close)
        self.c.executescript(db.SCHEMA)
        self.ls = live_settings
        self.enterContext(patch.object(live_settings, "apply", lambda s=None: None))

    def test_default_on_auto(self):
        self.assertEqual(self.ls.get(self.c), {"enabled": True, "app": "auto"})

    def test_off_returns_nothing(self):
        from unittest import mock
        self.ls.set(self.c, enabled=False)
        with mock.patch.object(nowplaying, "_rb_scan", side_effect=AssertionError("no debería mirar procesos")):
            res = nowplaying.state(self.c, 5)
        self.assertIs(res["enabled"], False)
        self.assertIsNone(res["now"])

    def test_forced_app_not_running(self):
        from unittest import mock
        self.ls.set(self.c, app="serato")
        with mock.patch.object(nowplaying, "_rb_scan", return_value=(123, [], 0.0)), \
             mock.patch.object(nowplaying, "_readers", return_value={}):
            res = nowplaying.state(self.c, 5)
        self.assertIsNone(res["app"])
        self.assertEqual(res["note"], "Serato no está abierto")

    def test_unknown_app(self):
        with self.assertRaises(ValueError):
            self.ls.set(self.c, app="virtualdj")
