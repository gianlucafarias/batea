import os
import sqlite3
import tempfile
import unittest
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

from batea import config, db, export, export_m3u, export_rekordbox, export_traktor
from batea.sources.traktor import TraktorSource, _read_crates, location_to_path


def make_db() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript(db.SCHEMA)
    for table, col, decl in db.MIGRATIONS:
        cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    return c


def add_track(c, path, title, artist, bpm=None, key=None, duration=None, rating=None, genre=None, comment=None) -> int:
    cur = c.execute(
        "INSERT INTO tracks(path, title, artist, bpm, key, duration, rating, genre, rb_comment, filetype) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (path, title, artist, bpm, key, duration, rating, genre, comment, "mp3"),
    )
    return cur.lastrowid


def add_crate(c, name, kind="user", parent=None, tracks=()) -> int:
    cur = c.execute("INSERT INTO crates(name, kind, parent_id, source) VALUES (?,?,?,'user')", (name, kind, parent))
    for pos, t in enumerate(tracks):
        c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", (cur.lastrowid, t, pos))
    return cur.lastrowid


class M3uTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.c = make_db()
        self.real = self.dir / "Música" / "Ñandú – Sol.mp3"
        self.real.parent.mkdir()
        self.real.write_bytes(b"x")
        self.a = add_track(self.c, str(self.real), "Sol", "Ñandú", duration=360.4)
        self.b = add_track(self.c, "/Volumes/Disco DJ/Sets/Luna.flac", "Luna", None)

    def tearDown(self):
        self.tmp.cleanup()

    def test_single_crate_unicode_and_missing(self):
        cid = add_crate(self.c, "Apertura / noche: 1", tracks=[self.b, self.a])
        res = export_m3u.export(self.c, [cid], out_dir=self.dir / "out")
        self.assertEqual(res["tracks"], 2)
        self.assertEqual(res["missing"], 1)
        p = Path(res["files"][0])
        self.assertEqual(p.name, "Apertura noche 1.m3u8")
        lines = p.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines, [
            "#EXTM3U",
            "#EXTINF:-1,Luna", "/Volumes/Disco DJ/Sets/Luna.flac",
            "#EXTINF:360,Ñandú - Sol", str(self.real),
        ])

    def test_several_crates_go_in_a_folder(self):
        c1 = add_crate(self.c, "Uno", tracks=[self.a])
        c2 = add_crate(self.c, "Uno", tracks=[self.b])
        res = export_m3u.export(self.c, [c1, c2], out_dir=self.dir / "out")
        names = sorted(Path(f).name for f in res["files"])
        self.assertEqual(names, ["Uno (2).m3u8", "Uno.m3u8"])
        self.assertEqual(Path(res["files"][0]).parent, Path(res["path"]))

    def test_folder_keeps_hierarchy(self):
        root = add_crate(self.c, "Gigs", "folder")
        sub = add_crate(self.c, "2026", "folder", root)
        add_crate(self.c, "Apertura", "playlist", sub, [self.a])
        add_crate(self.c, "Cierre", "playlist", root, [self.b])
        add_crate(self.c, "Vacía", "playlist", root, [])
        res = export_m3u.export(self.c, [root], subdir="serato", out_dir=self.dir / "out")
        rel = sorted(str(Path(f).relative_to(self.dir / "out")) for f in res["files"])
        self.assertEqual(rel, ["Gigs/2026/Apertura.m3u8", "Gigs/Cierre.m3u8"])
        self.assertEqual(res["tracks"], 2)

    def test_empty(self):
        cid = add_crate(self.c, "Nada")
        res = export_m3u.export(self.c, [cid], out_dir=self.dir / "out")
        self.assertEqual((res["tracks"], res["files"]), (0, []))


class NmlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.c = make_db()

    def tearDown(self):
        self.tmp.cleanup()

    def roundtrip(self, res):
        snap = self.dir / "snap"
        (snap / "Traktor 3.11.1").mkdir(parents=True)
        (snap / "Traktor 3.11.1" / "collection.nml").write_bytes(Path(res["files"][0]).read_bytes())
        (snap / "warnings.json").write_text("[]")
        from batea.sources.base import SourceLocation
        loc = SourceLocation(snap / "Traktor 3.11.1" / "collection.nml", version="3.11.1")
        return TraktorSource().read(snap, loc)

    def test_split_location(self):
        self.assertEqual(export_traktor.split_location("/Volumes/Disco DJ/Sets/Vol: 2/Jardín.flac"),
                         ("Disco DJ", "/:Sets/:Vol// 2/:", "Jardín.flac"))
        self.assertEqual(export_traktor.split_location("/Users/x/Bajo: Marea.aiff", boot="Macintosh HD"),
                         ("Macintosh HD", "/:Users/:x/:", "Bajo// Marea.aiff"))
        self.assertEqual(export_traktor.split_location("/a.mp3", boot="HD"), ("HD", "/:", "a.mp3"))

    def test_roundtrip_with_traktor_reader(self):
        t1 = add_track(self.c, "/Volumes/Disco DJ/Sets: 1/Jardín: ecos.flac", "Jardín", "Prisma", 115.5, "8A", 400.7, 4, "House", "nota")
        t2 = add_track(self.c, "/Volumes/Disco DJ/Sets: 1/Dos.mp3", "Dos", "Otro", 128, "1B", 300)
        t3 = add_track(self.c, "/Volumes/Disco DJ/Sets: 1/Dos.mp3", "Dos (copia)", "Otro")  # misma ruta: una sola ENTRY
        root = add_crate(self.c, "Gigs", "folder")
        add_crate(self.c, "Noche: 1", "playlist", root, [t2, t1])
        solo = add_crate(self.c, "Suelta", "user", None, [t3, t1])
        res = export_traktor.export(self.c, [root, solo], out_dir=self.dir / "out")
        self.assertEqual(res["tracks"], 3)
        self.assertEqual(res["playlists"], 2)
        self.assertEqual(res["missing"], 3)  # no existen en este equipo
        self.assertTrue(Path(res["files"][0]).name.startswith("Batea "))
        dump = self.roundtrip(res)
        by_title = {t.title: t for t in dump.tracks}
        self.assertEqual(len(dump.tracks), 2)
        j = by_title["Jardín"]
        self.assertEqual(j.path, "/Volumes/Disco DJ/Sets: 1/Jardín: ecos.flac")
        self.assertEqual((j.artist, j.genre, j.comment, j.duration, j.rating, j.bpm, j.key_camelot),
                         ("Prisma", "House", "nota", 400.0, 4.0, 115.5, "8A"))
        self.assertEqual(by_title["Dos"].key_camelot, "1B")
        folders = [c for c in dump.crates if c.kind == "folder"]
        lists = {c.name: c for c in dump.crates if c.kind == "playlist"}
        self.assertEqual([f.name for f in folders], ["Gigs"])
        self.assertEqual(lists["Noche: 1"].parent_ext_id, folders[0].ext_id)
        paths = {t.ext_id: t.path for t in dump.tracks}
        self.assertEqual([paths[k] for k in lists["Noche: 1"].track_ext_ids],
                         ["/Volumes/Disco DJ/Sets: 1/Dos.mp3", "/Volumes/Disco DJ/Sets: 1/Jardín: ecos.flac"])
        self.assertEqual(len(lists["Suelta"].track_ext_ids), 2)

    def test_all_keys_invert(self):
        table = export_traktor._key_table()
        self.assertEqual(len(table), 24)
        for cam, v in table.items():
            from batea.sources.traktor import musical_key_to_camelot
            self.assertEqual(musical_key_to_camelot(v), cam)

    def test_boot_volume_file_comes_back_identical(self):
        real = self.dir / "Música" / "Tema: uno.mp3"
        real.parent.mkdir()
        real.write_bytes(b"x")
        t = add_track(self.c, str(real), "Uno", "A")
        cid = add_crate(self.c, "Caja", tracks=[t])
        res = export_traktor.export(self.c, [cid], out_dir=self.dir / "out")
        self.assertEqual(res["missing"], 0)
        dump = self.roundtrip(res)
        got = dump.tracks[0].path
        self.assertEqual(unicodedata.normalize("NFC", os.path.realpath(got)), unicodedata.normalize("NFC", os.path.realpath(real)))
        xml = Path(res["files"][0]).read_text(encoding="utf-8")
        self.assertIn(f'VOLUME="{export_traktor.boot_volume_name()}"', xml)
        self.assertIn("Tema// uno.mp3", xml)

    def test_never_touches_collection(self):
        t = add_track(self.c, "/Volumes/X/a.mp3", "A", "B")
        cid = add_crate(self.c, "Caja", tracks=[t])
        res = export_traktor.export(self.c, [cid], out_dir=self.dir / "out")
        self.assertEqual(Path(res["files"][0]).name, "Caja.nml")
        root = ET.parse(res["files"][0]).getroot()
        self.assertEqual(root.get("VERSION"), "19")
        self.assertIsNone(root.find(".//CUE_V2"))


class TargetsTests(unittest.TestCase):
    def src(self, kind, enabled=False, found=False):
        return {"kind": kind, "enabled": enabled, "found": found}

    def test_availability(self):
        ts = {t["id"]: t for t in export.targets([self.src("rekordbox", found=True), self.src("traktor", enabled=True), self.src("serato")])}
        self.assertTrue(ts["rekordbox"]["available"])
        self.assertTrue(ts["traktor"]["available"])
        self.assertFalse(ts["serato"]["available"])
        self.assertEqual(ts["serato"]["reason"], "No usás Serato")
        self.assertTrue(ts["m3u"]["available"])
        self.assertIsNone(ts["m3u"]["reason"])
        self.assertEqual([t["format"] for t in ts.values()], ["XML", "NML", "M3U8", "M3U8"])

    def test_nothing_known(self):
        ts = {t["id"]: t for t in export.targets([])}
        self.assertFalse(ts["rekordbox"]["available"])
        self.assertTrue(ts["m3u"]["available"])


class RunTests(unittest.TestCase):
    def test_unknown_and_warnings(self):
        c = make_db()
        with self.assertRaises(ValueError):
            export.run(c, "otro", [])
        t = add_track(c, "/Volumes/Nada/a.mp3", "A", "B")
        cid = add_crate(c, "Caja", tracks=[t])
        with tempfile.TemporaryDirectory() as d:
            old = config.EXPORT_DIR
            config.EXPORT_DIR = Path(d)
            try:
                res = export.run(c, "serato", [cid])
            finally:
                config.EXPORT_DIR = old
        self.assertTrue(res["ok"])
        self.assertEqual(res["missing"], 1)
        self.assertEqual(len(res["warnings"]), 1)
        self.assertTrue(res["path"].startswith(d) or res["path"].startswith(os.path.realpath(d)))


class RekordboxStillSameTests(unittest.TestCase):
    def test_fixed_case(self):
        c = make_db()
        t = add_track(c, "/Volumes/Disco/Música/Sol ñ.mp3", "Sol", "Ñandú", 128.0, "8A", 360.9, 4, "Techno", "hola")
        cid = add_crate(c, "Caja", tracks=[t])
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "batea.xml"
            res = export_rekordbox.export(c, [cid], False, out, "Batea")
            xml = out.read_text(encoding="utf-8")
            self.assertEqual(res, {"path": str(out), "tracks": 1, "playlists": 1})
        root = ET.fromstring(xml)
        tr = root.find("COLLECTION/TRACK")
        self.assertEqual(dict(tr.attrib), {
            "TrackID": str(t), "Name": "Sol", "Artist": "Ñandú", "Album": "", "Genre": "Techno", "Label": "", "Kind": "MP3 File",
            "TotalTime": "360", "AverageBpm": "128.00", "Tonality": "Am", "Rating": "204", "Comments": "hola",
            "Location": "file://localhost/Volumes/Disco/M%C3%BAsica/Sol%20%C3%B1.mp3",
        })
        self.assertEqual(root.find("PLAYLISTS/NODE/NODE/NODE").get("Name"), "Caja")
        self.assertEqual(export.export is export_rekordbox.export, True)


if __name__ == "__main__":
    unittest.main()
