"""Cues y grilla: espejo de rekordbox, XML exportado por rekordbox, cues propias y XML de salida."""
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from batea import cues, export_rekordbox
from tests.test_export import add_crate, add_track, make_db


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.c = make_db()
        self.t = add_track(self.c, "/m/a.mp3", "A", "X", bpm=128)
        self.c.execute("UPDATE tracks SET rb_id='555' WHERE id=?", (self.t,))

    def test_equivalencias_verificadas_con_un_xml_de_rekordbox(self):
        # base `Kind` → pad, tal como lo escribió rekordbox 6.8.6 en su propio XML (el Kind 4 no existe como hot cue)
        slots = {k: (cues.normalize_rb(k, 1000, None, None) or {}).get("slot") for k in range(0, 11)}
        self.assertEqual(slots, {0: None, 1: 0, 2: 1, 3: 2, 4: None, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 10: None})
        self.assertEqual(cues.normalize_rb(0, 1000, None, None)["kind"], "memory")
        self.assertIsNone(cues.normalize_rb(4, 1000, None, None))
        loop = cues.normalize_rb(1, 4000, 8000, None)
        self.assertEqual((loop["kind"], loop["slot"], loop["end_ms"]), ("loop", 0, 8000.0))

    def test_espejo_y_lectura(self):
        stats = cues.refresh_rb(self.c, [("555", 0, 500, None, None), ("555", 2, 9000, None, "build"), ("999", 0, 1, None, None)])
        self.assertEqual(stats, {"cues": 2, "tracks": 1})           # la 999 no es de ningún tema de Batea
        source, mine = cues.effective(self.c, self.t)
        self.assertEqual(source, "rekordbox")
        self.assertEqual([(q["kind"], q["slot"]) for q in mine], [("memory", None), ("hot", 1)])
        cues.refresh_rb(self.c, [("555", 0, 700, None, None)])      # volver a leer reemplaza, no suma
        self.assertEqual(len(cues.effective(self.c, self.t)[1]), 1)

    def test_cues_propias_mandan_y_se_pueden_descartar(self):
        cues.refresh_rb(self.c, [("555", 1, 1000, None, None)])
        cues.save_user(self.c, self.t, [{"kind": "hot", "slot": 3, "start_ms": 5000, "name": "mi drop"}])
        source, mine = cues.effective(self.c, self.t)
        self.assertEqual((source, mine[0]["slot"], mine[0]["name"]), ("batea", 3, "mi drop"))
        cues.reset_user(self.c, self.t)
        self.assertEqual(cues.effective(self.c, self.t)[0], "rekordbox")

    def test_los_colores_propios_se_conservan(self):
        cues.save_user(self.c, self.t, [{"kind": "hot", "slot": 0, "start_ms": 1000, "rgb": [230, 40, 40]}, {"kind": "hot", "slot": 1, "start_ms": 2000}])
        mine = cues.effective(self.c, self.t)[1]
        self.assertEqual([q["rgb"] for q in mine], [(230, 40, 40), None])
        with self.assertRaises(ValueError):
            cues.save_user(self.c, self.t, [{"kind": "hot", "slot": 0, "start_ms": 1, "rgb": [300, 0, 0]}])

    def test_validaciones(self):
        bad = [
            [{"kind": "hot", "slot": 8, "start_ms": 1}],                                           # solo A..H
            [{"kind": "hot", "slot": 0, "start_ms": 1}, {"kind": "hot", "slot": 0, "start_ms": 2}],  # dos en el mismo pad
            [{"kind": "loop", "start_ms": 5000, "end_ms": 4000}],                                  # loop al revés
            [{"kind": "otra", "start_ms": 1}],
            [{"kind": "memory", "start_ms": -5}],
        ]
        for cs in bad:
            with self.assertRaises(ValueError, msg=str(cs)):
                cues.save_user(self.c, self.t, cs)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM cue_overrides").fetchone()[0], 0)   # nada a medias


RB_XML = """<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.8.6" Company="AlphaTheta"/>
  <COLLECTION Entries="3">
    <TRACK TrackID="1" Name="En rekordbox" Location="file://localhost/m/rb.mp3" AverageBpm="128.00">
      <TEMPO Inizio="0.250" Bpm="128.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="48.026" Bpm="128.00" Metro="4/4" Battito="3"/>
      <POSITION_MARK Name="" Type="0" Start="15.000" Num="-1"/>
      <POSITION_MARK Name="drop" Type="0" Start="30.000" Num="3" Red="40" Green="226" Blue="20"/>
      <POSITION_MARK Name="" Type="4" Start="60.000" End="68.000" Num="0" Red="255" Green="140" Blue="0"/>
    </TRACK>
    <TRACK TrackID="2" Name="Sin cues" Location="file://localhost/m/vacio.mp3"/>
    <TRACK TrackID="3" Name="No existe en Batea" Location="file://localhost/otra/cosa.mp3"/>
  </COLLECTION>
  <PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Name="p" Type="1" KeyType="0" Entries="1"><TRACK Key="1"/></NODE></NODE></PLAYLISTS>
</DJ_PLAYLISTS>
"""


class XmlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.c = make_db()
        self.rb = add_track(self.c, "/m/rb.mp3", "En rekordbox", "X", bpm=128, duration=300)
        self.empty = add_track(self.c, "/m/vacio.mp3", "Sin cues", "X", bpm=128, duration=300)
        self.local = add_track(self.c, "/m/local.mp3", "Suelto", "X", bpm=130, duration=300)
        self.c.execute("UPDATE tracks SET rb_id='1' WHERE id=?", (self.rb,))
        self.crate = add_crate(self.c, "Set", tracks=[self.rb, self.empty, self.local])
        self.xml = self.dir / "rekordbox-export.xml"
        self.xml.write_text(RB_XML, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def export(self, **kw):
        out = self.dir / "o.xml"
        res = export_rekordbox.export(self.c, [self.crate], False, out, **kw)
        return res, {t.attrib["Name"]: t for t in ET.parse(out).getroot().find("COLLECTION")}

    def test_importar_el_xml_de_rekordbox(self):
        stats = cues.import_rb_xml(self.c, self.xml)
        self.assertEqual((stats["tracks"], stats["with_grid"], stats["with_cues"], stats["not_found"], stats["cues"]), (2, 1, 1, 1, 3))
        self.assertEqual(stats["product"], "rekordbox 6.8.6")
        source, mine = cues.effective(self.c, self.rb)
        self.assertEqual(source, "rekordbox-xml")
        self.assertEqual([(q["kind"], q["slot"], q["start_ms"]) for q in mine], [("memory", None, 15000.0), ("hot", 3, 30000.0), ("loop", 0, 60000.0)])
        self.assertEqual(cues.xml_status(self.c)["xml"]["tracks"], 2)
        with self.assertRaises(ValueError):
            bad = self.dir / "otro.xml"
            bad.write_text("<foo/>")
            cues.import_rb_xml(self.c, bad)
        # volver a importar reemplaza
        cues.import_rb_xml(self.c, self.xml)
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM rb_xml_marks").fetchone()[0], 3)

    def test_la_equivalencia_se_verifica_contra_el_xml(self):
        cues.refresh_rb(self.c, [("1", 0, 15000, None, None), ("1", 5, 30000, None, "drop"), ("1", 1, 60000, 68000, None)])
        cues.import_rb_xml(self.c, self.xml)
        rep = cues.mapping_report(self.c)
        self.assertTrue(rep["ok"], rep)
        # si rekordbox numerara distinto, el informe lo dice
        self.c.execute("UPDATE rb_cues SET kind=4 WHERE in_ms=30000")
        self.assertEqual(list(cues.mapping_report(self.c)["unexpected"]), ["4->3"])

    def test_por_defecto_no_lleva_cues_ni_grilla(self):
        cues.import_rb_xml(self.c, self.xml)
        _, tracks = self.export()
        self.assertEqual([e.tag for t in tracks.values() for e in t], [])

    def test_con_xml_de_rekordbox_lleva_la_grilla_y_las_cues_tal_cual(self):
        cues.import_rb_xml(self.c, self.xml)
        res, tracks = self.export(with_cues=True)
        rb = tracks["En rekordbox"]
        self.assertEqual([(t.attrib["Inizio"], t.attrib["Battito"]) for t in rb.findall("TEMPO")], [("0.250", "1"), ("48.026", "3")])   # sus 2 tramos
        marks = [(m.attrib["Type"], m.attrib["Num"], m.attrib["Start"], m.attrib.get("End"), m.attrib["Name"], m.attrib.get("Red")) for m in rb.findall("POSITION_MARK")]
        self.assertEqual(marks, [("0", "-1", "15.000", None, "", None), ("0", "3", "30.000", None, "drop", "40"), ("4", "0", "60.000", "68.000", "", "255")])
        self.assertEqual((res["cue_tracks"], res["grid_missing"]), (1, 0))
        self.assertEqual(tracks["Suelto"].findall("TEMPO") + tracks["Suelto"].findall("POSITION_MARK"), [])   # no se inventa nada

    def test_sin_el_xml_lleva_las_cues_de_la_base_pero_no_inventa_grilla(self):
        cues.refresh_rb(self.c, [("1", 0, 15000, None, None), ("1", 6, 30000, None, None), ("1", 4, 31000, None, None)])
        res, tracks = self.export(with_cues=True)
        rb = tracks["En rekordbox"]
        self.assertEqual(rb.findall("TEMPO"), [])
        got = [(m.attrib["Num"], m.attrib["Start"], m.attrib.get("Red"), m.attrib.get("Green")) for m in rb.findall("POSITION_MARK")]
        self.assertEqual(got, [("-1", "15.000", None, None), ("4", "30.000", "40", "226")])   # Kind 6 = pad E; el 4 no existe y se omite
        self.assertEqual(res["grid_missing"], 1)                                              # avisa que falta la grilla exacta

    def test_las_cues_propias_reemplazan_a_las_de_rekordbox_y_conservan_su_grilla(self):
        cues.import_rb_xml(self.c, self.xml)
        cues.save_user(self.c, self.rb, [{"kind": "hot", "slot": 0, "start_ms": 31000}, {"kind": "memory", "start_ms": 16000},
                                         {"kind": "loop", "slot": 2, "start_ms": 40000, "end_ms": 44000}])
        _, tracks = self.export(with_cues=True)
        rb = tracks["En rekordbox"]
        self.assertEqual([(m.attrib["Num"], m.attrib["Start"], m.attrib.get("Red"), m.attrib["Type"]) for m in rb.findall("POSITION_MARK")],
                         [("-1", "16.000", None, "0"), ("0", "31.000", "40", "0"), ("2", "40.000", "255", "4")])   # pad verde, loop naranja
        self.assertEqual(len(rb.findall("TEMPO")), 2)


class GridTests(unittest.TestCase):
    def test_compases_de_una_grilla_fija(self):
        # 120 BPM: beat = 0.5 s, compás = 2 s. El beat 3 está en 5.0 s → el "1" del compás cae en 4.0 s
        down = cues.grid_downbeats({"inizio": 5.0, "bpm": 120.0, "battito": 3}, 12)
        self.assertEqual(down[:4], [0.0, 2.0, 4.0, 6.0])
        self.assertEqual(cues.grid_downbeats({"inizio": 0.25, "bpm": 120.0, "battito": 1}, 5)[:3], [0.25, 2.25, 4.25])

    def test_validacion(self):
        c = make_db()
        t = add_track(c, "/m/a.mp3", "A", "X")
        for bad in ((0, 20, 1), (0, 500, 1), (0, 120, 5)):
            with self.assertRaises(ValueError):
                cues.save_user_grid(c, t, *bad)
        cues.save_user_grid(c, t, 0.123, 127.5, 2)
        self.assertEqual(cues.user_grid(c, t), {"inizio": 0.123, "bpm": 127.5, "battito": 2})
        cues.reset_user_grid(c, t)
        self.assertIsNone(cues.user_grid(c, t))

    def test_la_grilla_corregida_va_al_xml_en_lugar_de_la_de_rekordbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = make_db()
            t = add_track(c, "/m/rb.mp3", "En rekordbox", "X", bpm=128, duration=300)
            c.execute("UPDATE tracks SET rb_id='1' WHERE id=?", (t,))
            crate = add_crate(c, "Set", tracks=[t])
            xml = Path(tmp) / "rb.xml"
            xml.write_text(RB_XML, encoding="utf-8")
            cues.import_rb_xml(c, xml)
            out = Path(tmp) / "o.xml"
            export_rekordbox.export(c, [crate], False, out, with_cues=True)
            node = ET.parse(out).getroot().find("COLLECTION")[0]
            self.assertEqual(len(node.findall("TEMPO")), 2)                           # la de rekordbox, sus 2 tramos
            cues.save_user_grid(c, t, 0.312, 127.0, 1)
            export_rekordbox.export(c, [crate], False, out, with_cues=True)
            node = ET.parse(out).getroot().find("COLLECTION")[0]
            self.assertEqual([(x.attrib["Inizio"], x.attrib["Bpm"], x.attrib["Battito"]) for x in node.findall("TEMPO")], [("0.312", "127.00", "1")])
            self.assertEqual(node.attrib["AverageBpm"], "127.00")
            self.assertEqual(len(node.findall("POSITION_MARK")), 3)                  # las cues siguen


if __name__ == "__main__":
    unittest.main()
