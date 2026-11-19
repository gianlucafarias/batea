"""Actualizador interno: descarga, verificación de la app, cambio al reiniciar."""
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from batea import runtime, updater, updates


def fake_app(root: Path, name: str, version: str, marker: str = "") -> Path:
    app = root / name
    (app / "Contents" / "MacOS").mkdir(parents=True)
    shutil.copy("/usr/bin/true", app / "Contents" / "MacOS" / "Batea")
    (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": "app.batea.test", "CFBundleExecutable": "Batea", "CFBundleShortVersionString": version, "CFBundlePackageType": "APPL"}))
    (app / "Contents" / "Resources").mkdir()
    (app / "Contents" / "Resources" / "marker.txt").write_text(marker or version)
    return app


def sign_adhoc(app: Path) -> None:
    subprocess.run(["/usr/bin/codesign", "--force", "--deep", "-s", "-", str(app)], check=True, capture_output=True)


class DownloadTests(unittest.TestCase):
    def test_descarga_con_progreso(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "origen.bin"
            src.write_bytes(os.urandom(3_500_000))
            seen = []
            updater._download(src.as_uri(), Path(tmp) / "sub" / "bajado.bin", seen.append)
            self.assertEqual((Path(tmp) / "sub" / "bajado.bin").read_bytes(), src.read_bytes())
            self.assertFalse((Path(tmp) / "sub" / "bajado.bin.part").exists())
            self.assertTrue(seen and seen[-1] == 1.0 and seen == sorted(seen))

    def test_en_desarrollo_no_se_instala_solo(self):
        ok, why = updater.can_install()
        self.assertFalse(ok)
        self.assertEqual(why, "dev")


class DemoTests(unittest.TestCase):
    def test_la_demostracion_recorre_todos_los_estados_sin_tocar_nada(self):
        info = {"update_available": True, "latest": "9.9.9", "current": "0.4.0", "download": None}
        real_sleep = time.sleep
        with mock.patch.dict(os.environ, {"BATEA_UPDATE_DEMO": "1"}), mock.patch.object(updates, "check", return_value=info), \
                mock.patch.object(updater.time, "sleep", lambda s: None):
            self.assertEqual(updater.can_install(), (True, None))
            updater._set(state="idle")
            first = updater.start_install()
            self.assertIn(first["state"], ("downloading", "ready"))              # el hilo simulado corre sin esperas
            for _ in range(200):
                if updater.snapshot()["state"] == "ready":
                    break
                real_sleep(0.02)
            self.assertEqual(updater.snapshot()["state"], "ready")
            self.assertEqual(updater.restart(), {"restarting": True, "demo": True})
            updater._set(state="idle", version=None, progress=0.0)


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_rechaza_una_app_sin_firma_integra(self):
        app = fake_app(self.dir, "Batea.app", "9.9.9")
        with self.assertRaisesRegex(ValueError, "firma"):
            updater.verify_app(app, "9.9.9", gatekeeper=False)

    def test_rechaza_otra_version_y_otro_firmante(self):
        app = fake_app(self.dir, "Batea.app", "9.9.9")
        sign_adhoc(app)
        with self.assertRaisesRegex(ValueError, "versión"):
            updater.verify_app(app, "1.0.0", gatekeeper=False)
        with self.assertRaisesRegex(ValueError, "autor"):                     # firmada, pero no por el equipo esperado
            updater.verify_app(app, "9.9.9", gatekeeper=False)
        updater.verify_app(app, "9.9.9", team="not set", gatekeeper=False)    # firma íntegra, versión y firmante coinciden: pasa

    def test_una_app_alterada_despues_de_firmar_no_pasa(self):
        app = fake_app(self.dir, "Batea.app", "9.9.9")
        sign_adhoc(app)
        (app / "Contents" / "Resources" / "marker.txt").write_text("alterado")
        with self.assertRaisesRegex(ValueError, "firma"):
            updater.verify_app(app, "9.9.9", team="not set", gatekeeper=False)

    def test_stage_desde_un_dmg(self):
        (self.dir / "origen").mkdir()
        app = fake_app(self.dir / "origen", "Batea.app", "9.9.9")
        sign_adhoc(app)
        dmg = self.dir / "Batea-9.9.9-arm64.dmg"
        subprocess.run(["/usr/bin/hdiutil", "create", "-quiet", "-volname", "Batea", "-srcfolder", str(self.dir / "origen"), "-format", "UDZO", str(dmg)], check=True)
        instalada = self.dir / "apps"
        instalada.mkdir()
        target = fake_app(instalada, "Batea.app", "9.9.8")
        staged = updater.stage(dmg, "9.9.9", target, team="not set", gatekeeper=False)
        self.assertEqual(staged.name, ".Batea-update-9.9.9.app")
        self.assertEqual(updater.app_version(staged), "9.9.9")
        self.assertEqual(updater.app_version(target), "9.9.8")                 # la instalada no se tocó
        mounted = subprocess.run(["/usr/bin/hdiutil", "info"], capture_output=True, text=True).stdout
        self.assertNotIn(str(dmg), mounted)                                    # el .dmg se desmontó


class SwapTests(unittest.TestCase):
    def run_script(self, app, staged, wait=0.6):
        proc = subprocess.Popen(["/bin/sleep", str(wait)])
        threading.Thread(target=proc.wait, daemon=True).start()          # como launchd: reaparece el proceso al terminar
        pid = proc.pid
        updater_script = Path(tempfile.mkdtemp()) / "swap.sh"
        updater_script.write_text(updater.SWAP_SCRIPT)
        t0 = time.time()
        r = subprocess.run(["/bin/bash", str(updater_script), str(pid), str(app), str(staged)], env={**os.environ, "BATEA_UPDATE_NO_LAUNCH": "1"},
                           capture_output=True, text=True, timeout=30)
        return r, time.time() - t0

    def test_cambia_la_app_cuando_batea_se_cierra(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = fake_app(root, "Batea.app", "1.0.0")
            staged = fake_app(root, ".Batea-update-2.0.0.app", "2.0.0")
            r, took = self.run_script(app, staged)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertGreaterEqual(took, 0.5)                                  # esperó a que el proceso terminara
            self.assertEqual((app / "Contents" / "Resources" / "marker.txt").read_text(), "2.0.0")
            self.assertFalse(staged.exists())
            self.assertEqual([p.name for p in root.iterdir()], ["Batea.app"])    # sin restos de la vieja

    def test_si_falta_la_nueva_la_app_queda_como_estaba(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = fake_app(root, "Batea.app", "1.0.0")
            self.run_script(app, root / ".Batea-update-2.0.0.app", wait=0.2)
            self.assertEqual((app / "Contents" / "Resources" / "marker.txt").read_text(), "1.0.0")


class ResumeTests(unittest.TestCase):
    def test_ofrece_reiniciar_si_quedo_una_actualizacion_y_limpia_lo_viejo(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = fake_app(root, "Batea.app", "1.0.0")
            nueva = fake_app(root, ".Batea-update-1.1.0.app", "1.1.0")
            vieja = fake_app(root, ".Batea-update-0.9.0.app", "0.9.0")
            resto = fake_app(root, "Batea.app.old-77", "0.8.0")
            with mock.patch.object(runtime, "frozen", return_value=True), mock.patch.object(runtime, "bundle_root", return_value=app), \
                    mock.patch.object(runtime, "build_info", return_value={"version": "1.0.0"}):
                self.assertEqual(updater.staged_app(), nueva)
                updater._set(state="idle")
                updater.resume()
            self.assertTrue(nueva.exists())
            self.assertFalse(vieja.exists())
            self.assertFalse(resto.exists())
            s = updater.snapshot()
            self.assertEqual((s["state"], s["version"]), ("ready", "1.1.0"))
            updater._set(state="idle", version=None)


if __name__ == "__main__":
    unittest.main()
