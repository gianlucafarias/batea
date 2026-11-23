"""Gráfico de una caja: lo que Batea sabe de cada pasada A → B en el orden de la lista."""
import unittest

from tests.test_crate_edits import run


class SetTransitionsTests(unittest.TestCase):
    def test_historial_evitar_y_mezcla_guardada(self):
        r = run("""
with db.conn() as c:
    c.execute("INSERT INTO relations(a, b, kind, source, count) VALUES (?,?,'history','history',3)", (a, b))
    c.execute("INSERT INTO relations(a, b, kind, source, count) VALUES (?,?,'history','history',9)", (b, a))  # al revés no cuenta
    lo, hi = min(b, c3), max(b, c3)
    c.execute("INSERT INTO relations(a, b, kind, source) VALUES (?,?,'avoid','user')", (lo, hi))
    c.execute("INSERT INTO mix_settings(a, b, data) VALUES (?,?,'{}')", (c3, d))
res = api.set_transitions(api.SetIds(ids=[a, b, c3, d, d]))
print(json.dumps(res))
""")
        t = r["transitions"]
        self.assertEqual(len(t), 3)          # d → d no es una pasada
        self.assertEqual(t[0]["played"], 3)
        self.assertFalse(t[0]["avoid"])
        self.assertTrue(t[1]["avoid"])       # la marca es simétrica
        self.assertEqual(t[1]["played"], 0)
        self.assertTrue(t[2]["saved"])
        self.assertFalse(t[2]["mix"])


if __name__ == "__main__":
    unittest.main()


class EnergyScaleTests(unittest.TestCase):
    def test_analisis_propio_se_compara_en_la_escala_de_rekordbox(self):
        # antes: un tema analizado por Batea con energía cruda 0,6 quedaba arriba de todos los de rekordbox (0,05–0,5)
        r = run("""
from batea import features
with db.conn() as c:
    for i, (raw, how) in enumerate([(0.10, 'anlz'), (0.33, 'anlz'), (0.45, 'anlz'), (0.50, 'audio'), (0.66, 'audio')]):
        c.execute("UPDATE tracks SET energy_raw=?, analyzed=? WHERE id=?", (raw, how, ids[i]))
    features.rank_energy(c)
    rows = c.execute("SELECT id, energy_auto, energy_fine FROM tracks ORDER BY id").fetchall()
print(json.dumps([[r[1], r[2]] for r in rows]))
""")
        order = sorted(range(5), key=lambda i: (r[i][0], r[i][1]))
        # 0,50 de Batea ≈ 0,303 de rekordbox y 0,66 ≈ 0,49: quedan intercalados, no arriba de todo
        self.assertEqual(order, [0, 3, 1, 2, 4])
        fine = [x[1] for x in r]
        self.assertEqual(sorted(range(5), key=lambda i: fine[i]), [0, 3, 1, 2, 4])
        self.assertEqual(fine[0], 1.0)
        self.assertEqual(fine[4], 10.0)
        # lineal: 0,33 y 0,45 de rekordbox quedan separados según su diferencia real, no por puesto
        self.assertGreater(fine[2] - fine[1], 2)


class SuggestAndStatsTests(unittest.TestCase):
    def test_puente_respeta_tempo_y_tono_de_los_dos_lados(self):
        r = run("""
from batea import setinsights
with db.conn() as c:
    c.execute("UPDATE tracks SET bpm=135, key='3A' WHERE id=?", (a,))
    c.execute("UPDATE tracks SET bpm=146, key='6A' WHERE id=?", (b,))
    c.execute("UPDATE tracks SET bpm=140, key='4A', title='Puente' WHERE id=?", (c3,))   # +3,7% y -4,1%: entra
    c.execute("UPDATE tracks SET bpm=128, key='3A', title='Lento' WHERE id=?", (d,))     # muy lejos de 146
    c.execute("UPDATE tracks SET bpm=NULL, title='SinBPM' WHERE id=?", (e,))
    res = setinsights.suggest_between(c, a, b, {a, b})
print(json.dumps(res))
""")
        self.assertEqual([x["id"] for x in r], [r[0]["id"]])
        self.assertEqual(r[0]["fit"]["from_prev"]["bpm_pct"], 3.7)
        self.assertTrue(r[0]["fit"]["to_next"]["key_ok"] is False or r[0]["fit"]["to_next"]["key"])

    def test_estadisticas_de_sesiones(self):
        r = run("""
from batea import setinsights
with db.conn() as c:
    for n, day in enumerate(['2026-01-10', '2026-02-10', '2026-03-10']):
        s = c.execute("INSERT INTO crates(name, kind, source, date) VALUES (?, 'session', 'rekordbox', ?)", (f'S{n}', day)).lastrowid
        for pos, t in enumerate([a, b, c3, d, e]):
            c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", (s, t, pos + 1))
    for t, en in zip([a, b, c3, d, e], [3, 5, 9, 6, 4]):
        c.execute("UPDATE tracks SET energy_fine=?, duration=300 WHERE id=?", (en, t))
    st = setinsights.session_stats(c, only_universe=False)
print(json.dumps(st))
""")
        self.assertEqual(r["summary"]["sessions"], 3)
        self.assertEqual(r["peak_tracks"][0]["count"], 3)          # el tema 3 es el peak de las tres
        self.assertEqual(r["openers"][0]["count"], 3)
        self.assertEqual(r["pairs"][0]["count"], 3)
        self.assertAlmostEqual(r["summary"]["minutes"], 25.0)
        self.assertEqual(r["summary"]["peak_minute"], 10.0)


class SessionUniverseTests(unittest.TestCase):
    def test_sesion_se_ve_entera_con_universo_activo(self):
        r = run("""
from batea import api_helpers, universe
with db.conn() as c:
    s = c.execute("INSERT INTO crates(name, kind, source, date) VALUES ('S', 'session', 'rekordbox', '2023-01-01')").lastrowid
    for pos, t in enumerate([a, b, c3]):
        c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", (s, t, pos + 1))
    c.execute("UPDATE tracks SET source='rekordbox'")
    # universo con una caja que solo tiene el tema d: la sesión no tiene nada de ese universo
    u = c.execute("INSERT INTO crates(name, kind, source) VALUES ('U','user','user')").lastrowid
    c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,1)", (u, d))
    uid = c.execute("INSERT INTO universes(name, crate_ids) VALUES ('Techno', ?)", (json.dumps([u]),)).lastrowid
    universe.set_active(c, uid)
    sess = [t['id'] for t in api_helpers.query_tracks(c, str(s), {})]
    pl = [t['id'] for t in api_helpers.query_tracks(c, str(rb), {})]
print(json.dumps({'sess': sess, 'want': [a, b, c3], 'pl': pl, 'd': d}))
""")
        self.assertEqual(r["sess"], r["want"])          # la sesión, completa y en orden
        self.assertEqual(r["pl"], [r["d"]])             # una playlist sigue filtrada por el universo


class SessionPlaysTests(unittest.TestCase):
    def test_sesion_con_temas_repetidos_conserva_el_orden(self):
        r = run("""
from batea import rbsync, setinsights
with db.conn() as c:
    s = c.execute("INSERT INTO crates(name, kind, source, rb_id, date) VALUES ('S', 'session', 'rekordbox', 'h:9', '2026-07-04')").lastrowid
    # sonó a, b, a, c3, b (a y b volvieron a sonar); crate_tracks solo guarda cada tema una vez
    for pos, t in [(1, a), (2, b), (4, c3)]:
        c.execute("INSERT INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)", (s, t, pos))
    rbsync.write_session_plays(c, {'9': [(5, b), (1, a), (3, a), (2, b), (4, c3)]}, {'h:9': s})
    seq = setinsights.session_sequence(c, s)
    st = setinsights.session_stats(c, only_universe=False)
print(json.dumps({'seq': seq, 'want': [a, b, a, c3, b], 'n': st['sessions'][0]['tracks'], 'closer': st['closers'], 'last': b}))
""")
        self.assertEqual(r["seq"], r["want"])
        self.assertEqual(r["n"], 5)
