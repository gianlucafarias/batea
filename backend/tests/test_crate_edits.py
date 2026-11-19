"""Relaciones sin duplicados, mezclas guardadas y orden de cajas propias.

Cada caso corre en un proceso limpio con BATEA_HOME temporal: `batea.api` abre la base al importarse
y nunca tiene que tocar la real.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

PRELUDE = """
import json, sys
from batea import db
db.init()
from batea import api
with db.conn() as c:
    ids = []
    for i in range(5):
        ids.append(c.execute("INSERT INTO tracks(path, title, artist, bpm, filetype) VALUES (?,?,?,?,?)",
                             (f"/x/{i}.mp3", f"T{i}", "A", 128, "mp3")).lastrowid)
    crate = c.execute("INSERT INTO crates(name, kind, source) VALUES ('Mi caja','user','user')").lastrowid
    rb = c.execute("INSERT INTO crates(name, kind, source, rb_id) VALUES ('RB','playlist','rekordbox','pl:1')").lastrowid
    for pos, t in enumerate(ids):
        c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", (crate, t, pos + 1))
        c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", (rb, t, pos + 1))
a, b, c3, d, e = ids
"""


def run(body: str) -> dict:
    with tempfile.TemporaryDirectory() as home:
        env = {**os.environ, "BATEA_HOME": home, "BATEA_AUTODISCOVER": "0", "BATEA_NO_MENUBAR": "1", "BATEA_UPDATE_URL": "file:///nonexistent"}
        out = subprocess.run([sys.executable, "-c", PRELUDE + body], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120)
        if out.returncode:
            raise AssertionError(out.stderr[-2000:])
        return json.loads(out.stdout.strip().splitlines()[-1])


class RelationTests(unittest.TestCase):
    def test_marcar_dos_veces_no_duplica(self):
        r = run("""
body = api.RelationIn(a=a, b=b, kind='mix', note='primera')
api.create_relation(body)
api.create_relation(api.RelationIn(a=b, b=a, kind='mix', note='segunda'))        # al revés y de nuevo
api.feedback(api.Feedback(seed=a, other=b, good=True))                               # y un 👍 de las sugerencias
api.feedback(api.Feedback(seed=a, other=b, good=True))
with db.conn() as c:
    rels = api.relations_of(c, a)
    otro = api.relations_of(c, b)
print(json.dumps({'mix': [x for x in rels if x['kind'] == 'mix'], 'otro': otro}))
""")
        mixes = r["mix"]
        self.assertEqual(len(mixes), 1, mixes)
        self.assertEqual(mixes[0]["note"], "segunda")
        self.assertEqual(len([x for x in r["otro"] if x["kind"] == "mix"]), 1)

    def test_quitar_borra_la_pareja_entera_y_su_mezcla(self):
        r = run("""
api.create_relation(api.RelationIn(a=a, b=b, kind='mix'))
api.feedback(api.Feedback(seed=a, other=b, good=True))
api.put_mix_settings(a, b, api.MixSettingsIn(settings={'mixBar': 4}))
with db.conn() as c:
    rid = api.relations_of(c, a)[0]['id']
api.delete_relation(rid)
with db.conn() as c:
    left = c.execute("SELECT COUNT(*) FROM relations WHERE kind='mix'").fetchone()[0]
    mixes = c.execute("SELECT COUNT(*) FROM mix_settings").fetchone()[0]
print(json.dumps({'left': left, 'mixes': mixes}))
""")
        self.assertEqual(r, {"left": 0, "mixes": 0})


class MixSettingsTests(unittest.TestCase):
    def test_guardar_y_leer_mezcla(self):
        r = run("""
state = {'v': 1, 'mixBar': 24, 'startBar': 8, 'nudge': -0.012, 'style': 'blend', 'length': 32, 'custom': True,
         'automation': {'x': [{'at': 0, 'v': 0}, {'at': 32, 'v': 1}]}}
api.put_mix_settings(a, b, api.MixSettingsIn(settings=state))
api.create_relation(api.RelationIn(a=a, b=b, kind='mix'))
got = api.get_mix_settings(a, b)
rev = api.get_mix_settings(b, a)
state['mixBar'] = 30
api.put_mix_settings(a, b, api.MixSettingsIn(settings=state))   # guardar de nuevo reemplaza, no suma
with db.conn() as c:
    n = c.execute("SELECT COUNT(*) FROM mix_settings").fetchone()[0]
    rel = api.relations_of(c, b)[0]
print(json.dumps({'got': got['saved'], 'rev': rev, 'again': api.get_mix_settings(a, b)['saved']['mixBar'], 'n': n, 'mix': rel['mix'], 'ab': [a, b]}))
""")
        self.assertEqual(r["got"]["mixBar"], 24)
        self.assertEqual(r["got"]["style"], "blend")
        self.assertEqual(r["rev"], {"saved": None})
        self.assertEqual(r["again"], 30)
        self.assertEqual(r["n"], 1)
        self.assertEqual(r["mix"], r["ab"])   # A sale, B entra, tal como se armó


class ReorderTests(unittest.TestCase):
    def test_reordenar_caja_propia(self):
        r = run("""
api.reorder_crate(crate, api.TrackOrder(track_ids=[e, d, c3, b, a]))
with db.conn() as c:
    order = [x[0] for x in c.execute("SELECT track_id FROM crate_tracks WHERE crate_id=? ORDER BY position", (crate,))]
    shown = [t['id'] for t in api.query_tracks(c, str(crate), {})]
print(json.dumps({'order': order, 'shown': shown, 'ids': ids}))
""")
        ids = r["ids"]
        self.assertEqual(r["order"], ids[::-1])
        self.assertEqual(r["shown"], ids[::-1])

    def test_ver_solo_algunos_conserva_el_lugar_de_los_demas(self):
        r = run("""
api.reorder_crate(crate, api.TrackOrder(track_ids=[d, b]))      # solo se ven b y d: se intercambian
with db.conn() as c:
    order = [x[0] for x in c.execute("SELECT track_id FROM crate_tracks WHERE crate_id=? ORDER BY position", (crate,))]
print(json.dumps({'order': order, 'ids': ids}))
""")
        a, b, c3, d, e = r["ids"]
        self.assertEqual(r["order"], [a, d, c3, b, e])

    def test_playlist_importada_se_reordena_y_sobrevive_a_la_sincronizacion(self):
        r = run("""
api.reorder_crate(rb, api.TrackOrder(track_ids=[e, d, c3, b, a]))
def shown():
    with db.conn() as c:
        return [t['id'] for t in api.query_tracks(c, str(rb), {})]
before = shown()
with db.conn() as c:      # una sincronización borra y vuelve a escribir crate_tracks
    c.execute("DELETE FROM crate_tracks WHERE crate_id=?", (rb,))
    for pos, t in enumerate(ids + [c.execute("INSERT INTO tracks(path, title, filetype) VALUES ('/x/nuevo.mp3','N','mp3')").lastrowid]):
        c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", (rb, t, pos + 1))
after = shown()
api.reset_crate_order(rb)
print(json.dumps({'before': before, 'after': after, 'reset': shown(), 'ids': ids}))
""")
        ids = r["ids"]
        self.assertEqual(r["before"], ids[::-1])
        self.assertEqual(r["after"][:5], ids[::-1])        # el orden del DJ sigue
        self.assertEqual(len(r["after"]), 6)               # el tema nuevo va al final
        self.assertEqual(r["reset"][:5], ids)              # restaurar vuelve al original

    def test_sesiones_del_historial_no_se_reordenan(self):
        r = run("""
with db.conn() as c:
    ses = c.execute("INSERT INTO crates(name, kind, source) VALUES ('Sesión','session','rekordbox')").lastrowid
try:
    api.reorder_crate(ses, api.TrackOrder(track_ids=[e, d]))
    msg = 'sin error'
except Exception as ex:
    msg = str(getattr(ex, 'status_code', ex))
print(json.dumps({'msg': msg}))
""")
        self.assertEqual(r["msg"], "400")


class ShelfTests(unittest.TestCase):
    def test_carpetas_cajas_mover_y_borrar(self):
        r = run("""
from batea import export
f = api.create_crate(api.CrateIn(name='Sábados', kind='folder'))['id']
inner = api.create_crate(api.CrateIn(name='Peak', parent_id=f, track_ids=[a, b]))['id']
try:
    api.create_crate(api.CrateIn(name='X', parent_id=crate))      # no cuelga de una caja
    bad = 'sin error'
except Exception as ex:
    bad = str(ex.status_code)
api.patch_crate(inner, api.CratePatch(parent_id=None))             # a Mostrador
with db.conn() as c:
    after_move = c.execute("SELECT parent_id FROM crates WHERE id=?", (inner,)).fetchone()[0]
api.patch_crate(inner, api.CratePatch(parent_id=f))
api.patch_crate(rb, api.CratePatch(parent_id=f))                   # una playlist importada no se mueve
with db.conn() as c:
    rb_parent = c.execute("SELECT parent_id FROM crates WHERE id=?", (rb,)).fetchone()[0]
api.order_crates(api.CrateOrder(ids=[f, crate]))
api.delete_crate(f)                                                # la caja de adentro sobrevive
with db.conn() as c:
    left = c.execute("SELECT parent_id FROM crates WHERE id=?", (inner,)).fetchone()
    folder_gone = c.execute("SELECT COUNT(*) FROM crates WHERE id=?", (f,)).fetchone()[0]
    homes = {x['id']: x['home_position'] for x in api.crates()['crates'] if x['id'] in (crate,)}
try:
    api.delete_crate(rb); rbdel = 'sin error'
except Exception as ex:
    rbdel = str(ex.status_code)
print(json.dumps({'bad': bad, 'after_move': after_move, 'rb_parent': rb_parent, 'left': left[0] if left else 'borrada', 'folder_gone': folder_gone, 'homes': homes, 'rbdel': rbdel, 'crate': crate}))
""")
        self.assertEqual(r["bad"], "400")
        self.assertIsNone(r["after_move"])
        self.assertIsNone(r["rb_parent"])
        self.assertIsNone(r["left"])
        self.assertEqual(r["folder_gone"], 0)
        self.assertEqual(r["homes"], {str(r["crate"]): 2})
        self.assertEqual(r["rbdel"], "400")

    def test_duplicar_playlist_importada_con_su_orden(self):
        r = run("""
api.reorder_crate(rb, api.TrackOrder(track_ids=[e, d, c3, b, a]))
new = api.duplicate_crate(rb)['id']
with db.conn() as c:
    row = c.execute("SELECT name, kind FROM crates WHERE id=?", (new,)).fetchone()
    shown = [t['id'] for t in api.query_tracks(c, str(new), {})]
print(json.dumps({'name': row['name'], 'kind': row['kind'], 'shown': shown, 'ids': ids}))
""")
        self.assertEqual(r["name"], "RB (copia)")
        self.assertEqual(r["kind"], "user")
        self.assertEqual(r["shown"], r["ids"][::-1])

    def test_estado_de_exportacion(self):
        r = run("""
from batea import export
st0 = api.crates()['crates']
mine0 = [x['export_state'] for x in st0 if x['id'] == crate][0]
rb0 = [x.get('export_state') for x in st0 if x['id'] == rb][0]
with db.conn() as c:
    export.record(c, 'rekordbox', [crate])
mine1 = [x['export_state'] for x in api.crates()['crates'] if x['id'] == crate][0]
api.add_to_crate(crate, api.TrackIds(track_ids=[]))
api.reorder_crate(crate, api.TrackOrder(track_ids=[e, d, c3, b, a]))
mine2 = [x['export_state'] for x in api.crates()['crates'] if x['id'] == crate][0]
with db.conn() as c:
    export.record(c, 'rekordbox', [crate])
mine3 = [x['export_state'] for x in api.crates()['crates'] if x['id'] == crate][0]
print(json.dumps({'a': mine0, 'rb': rb0, 'b': mine1, 'c': mine2, 'd': mine3}))
""")
        self.assertEqual(r, {"a": "never", "rb": None, "b": "done", "c": "stale", "d": "done"})


class ExportSetTests(unittest.TestCase):
    def test_exportar_otra_caja_no_pierde_la_anterior(self):
        r = run("""
import xml.etree.ElementTree as ET, os
os.environ['BATEA_EXPORT_DIR'] = os.environ['BATEA_HOME']
from batea import config, export
config.EXPORT_DIR = type(config.EXPORT_DIR)(os.environ['BATEA_HOME'])
other = api.create_crate(api.CrateIn(name='Otra', track_ids=[d, e]))['id']
def names():
    root = ET.parse(config.EXPORT_DIR / 'batea.xml').getroot()
    return sorted(n.attrib['Name'] for n in root.iter('NODE') if n.attrib.get('Type') == '1')
with db.conn() as c:
    r1 = api.export_run(api.ExportRunIn(target='rekordbox', crate_ids=[crate]))
first = names()
with db.conn() as c:
    r2 = api.export_run(api.ExportRunIn(target='rekordbox', crate_ids=[other]))
both = names()
with db.conn() as c:
    r3 = api.export_run(api.ExportRunIn(target='rekordbox', crate_ids=[other], keep_previous=False))
only = names()
api.delete_crate(other)
with db.conn() as c:
    r4 = api.export_run(api.ExportRunIn(target='rekordbox', crate_ids=[crate], keep_previous=True))
after_delete = names()
print(json.dumps({'first': first, 'both': both, 'only': only, 'kept': [r1['kept'], r2['kept'], r3['kept'], r4['kept']], 'after_delete': after_delete}))
""")
        self.assertEqual(r["first"], ["Mi caja"])
        self.assertEqual(r["both"], ["Mi caja", "Otra"])
        self.assertEqual(r["only"], ["Otra"])
        self.assertEqual(r["kept"], [0, 1, 0, 0])
        self.assertEqual(r["after_delete"], ["Mi caja"])


if __name__ == "__main__":
    unittest.main()
