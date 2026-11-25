"""Empaquetado: que la app instalada traiga TODOS los módulos de Batea.

De 0.3.0 a 0.5.0 la app salió sin el lector de rekordbox (`batea.sources.rekordbox`) ni `batea.nowplaying_traktor`:
se cargan con importlib, PyInstaller no los ve siguiendo los imports, y `--collect-submodules batea` corría antes de
que se aplicara `--paths backend`, así que no agregaba nada. En la app se veía «rekordbox no está en esta Mac».

    cd backend && .venv/bin/python -m unittest tests.test_packaging

Las pruebas que necesitan PyInstaller se saltean si no está instalado; en GitHub Actions corren siempre
(BATEA_REQUIRE_PYINSTALLER=1 hace fallar en vez de saltear).
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
SRC = BACKEND / "batea"
MAKE_DIST = ROOT / "scripts" / "make_dist.sh"
HAS_PYINSTALLER = importlib.util.find_spec("PyInstaller") is not None
if os.environ.get("BATEA_REQUIRE_PYINSTALLER") and not HAS_PYINSTALLER:   # en GitHub Actions: no saltearlas en silencio
    raise RuntimeError("BATEA_REQUIRE_PYINSTALLER=1 pero PyInstaller no está instalado")

# Textos con forma de módulo que en realidad son nombres de archivo (batea.db = la base, batea.xml = la exportación).
NOT_MODULES = {"batea.db", "batea.xml"}


def load_check_bundle():
    spec = importlib.util.spec_from_file_location("check_bundle", ROOT / "scripts" / "check_bundle.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hidden_imports() -> set[str]:
    return set(re.findall(r"--hidden-import\s+(\S+)", MAKE_DIST.read_text()))


def pyinstaller_command() -> str:
    """El comando de PyInstaller de make_dist.sh, con sus líneas continuadas unidas."""
    text = MAKE_DIST.read_text().replace("\\\n", " ")
    lines = [ln for ln in text.splitlines() if "-m PyInstaller" in ln]
    assert len(lines) == 1, f"esperaba un solo llamado a PyInstaller, hay {len(lines)}"
    return lines[0]


def modules_named_in_code() -> dict[str, str]:
    """Módulos de batea que el código nombra como texto (importlib, procesos aparte, ADAPTERS) → archivo donde aparece."""
    out: dict[str, str] = {}
    for f in SRC.rglob("*.py"):
        if f.name == "selftest.py":           # la prueba de humo nombra módulos para importarlos ella misma
            continue
        for name in re.findall(r"[\"'](batea(?:\.\w+)+)[\"']", f.read_text()):
            if name in NOT_MODULES:
                continue
            rel = Path(*name.split("."))
            if (BACKEND / rel).with_suffix(".py").exists() or (BACKEND / rel / "__init__.py").exists():
                out[name] = str(f.relative_to(ROOT))
    return out


class MakeDistRules(unittest.TestCase):
    """Reglas sobre make_dist.sh: rápidas y sin PyInstaller."""

    def test_pyinstaller_corre_con_pythonpath(self):
        cmd = pyinstaller_command()
        self.assertRegex(cmd, r'PYTHONPATH="\$ROOT/backend"\s+"\$\{PY\[@\]\}"\s+-m PyInstaller',
                         "sin PYTHONPATH, --collect-submodules batea no encuentra el paquete y no agrega nada")
        self.assertIn("--collect-submodules batea", cmd)

    def test_check_bundle_corta_el_build(self):
        text = MAKE_DIST.read_text()
        self.assertRegex(text, r'check_bundle\.py" "\$APP" \|\| \{[^}]*exit 1',
                         "make_dist.sh tiene que correr check_bundle.py y cortar si falta algo")
        self.assertLess(text.index("-m PyInstaller"), text.index("check_bundle.py"))
        self.assertLess(text.index("check_bundle.py"), text.index("--selftest"))

    def test_modulos_cargados_por_nombre_son_hidden_imports(self):
        """Todo módulo que el código carga por nombre tiene que estar como --hidden-import (no depender solo de collect)."""
        named = modules_named_in_code()
        self.assertIn("batea.sources.rekordbox", named)          # el que se perdió: si deja de detectarlo, la prueba no sirve
        self.assertIn("batea.nowplaying_traktor", named)
        missing = {m: where for m, where in named.items() if m not in hidden_imports()}
        self.assertEqual(missing, {}, "agregalos como --hidden-import en scripts/make_dist.sh")

    def test_adaptadores_del_registro_son_hidden_imports(self):
        sys.path.insert(0, str(BACKEND))
        try:
            from batea.sources import registry
        finally:
            sys.path.remove(str(BACKEND))
        for kind, (module, _cls) in registry.ADAPTERS.items():
            self.assertIn(module, hidden_imports(), f"el lector de {kind} no está como --hidden-import")

    def test_hidden_imports_existen(self):
        """Un --hidden-import con un nombre viejo o mal escrito no protege nada."""
        for name in hidden_imports():
            if not name.startswith("batea."):
                continue
            rel = Path(*name.split("."))
            self.assertTrue((BACKEND / rel).with_suffix(".py").exists() or (BACKEND / rel / "__init__.py").exists(),
                            f"{name} no existe en backend/")

    def test_selftest_prueba_los_modulos_dinamicos(self):
        text = (SRC / "selftest.py").read_text()
        self.assertIn("def dynamic_modules", text)
        self.assertIn("registry.ADAPTERS", text)
        self.assertIn('"batea.nowplaying_traktor"', text)


class CheckBundle(unittest.TestCase):
    def setUp(self):
        self.cb = load_check_bundle()

    def test_lista_todos_los_modulos_del_codigo(self):
        mods = self.cb.source_modules()
        files = [f for f in SRC.rglob("*.py") if "__pycache__" not in f.parts]
        self.assertEqual(len(mods), len(files))
        for m in ("batea", "batea.sources", "batea.sources.rekordbox", "batea.nowplaying_traktor", "batea.api"):
            self.assertIn(m, mods)
        self.assertFalse(any("__init__" in m for m in mods))

    def run_main(self, have: set[str]) -> tuple[int, str]:
        out = io.StringIO()
        with mock.patch.object(self.cb, "bundled_modules", return_value=have), \
                mock.patch.object(sys, "argv", ["check_bundle.py", "/x/Batea.app"]), contextlib.redirect_stdout(out):
            code = self.cb.main()
        return code, out.getvalue()

    def test_falla_si_falta_el_lector_de_rekordbox(self):
        """El caso real de 0.3.0–0.5.0."""
        have = self.cb.source_modules() - {"batea.sources.rekordbox", "batea.nowplaying_traktor"}
        code, out = self.run_main(have)
        self.assertEqual(code, 1)
        self.assertIn("batea.sources.rekordbox", out)
        self.assertIn("batea.nowplaying_traktor", out)

    def test_pasa_con_todos(self):
        code, out = self.run_main(self.cb.source_modules() | {"batea.algo_extra"})
        self.assertEqual(code, 0, out)

    @unittest.skipUnless(HAS_PYINSTALLER, "necesita PyInstaller")
    def test_lee_una_app_de_pyinstaller_de_verdad(self):
        """Arma un ejecutable con el formato de PyInstaller (CArchive con un PYZ adentro) y lo lee como lo hace el build."""
        from PyInstaller.archive.writers import CArchiveWriter, ZlibArchiveWriter

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            stub = tmp / "m.py"
            stub.write_text("x = 1\n")
            want = sorted(self.cb.source_modules() - {"batea.sources.rekordbox"})
            pyz = tmp / "PYZ.pyz"
            names = want + ["numpy"]
            code = compile(stub.read_text(), str(stub), "exec")
            ZlibArchiveWriter(str(pyz), [(m, str(stub), "PYMODULE") for m in names], code_dict={m: code for m in names})
            exe = tmp / "Batea.app" / "Contents" / "MacOS" / "Batea"
            exe.parent.mkdir(parents=True)
            CArchiveWriter(str(exe), [("PYZ.pyz", str(pyz), False, "z")], "Python")
            have = self.cb.bundled_modules(tmp / "Batea.app")
            self.assertEqual(have, set(want), "solo los módulos de batea, sin numpy")
            r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_bundle.py"), str(tmp / "Batea.app")],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn("batea.sources.rekordbox", r.stdout)


@unittest.skipUnless(HAS_PYINSTALLER, "necesita PyInstaller")
class CollectSubmodules(unittest.TestCase):
    """Lo mismo que hace el spec de make_dist.sh, en un proceso aparte con el mismo entorno."""

    def collect(self, env: dict) -> list[str]:
        code = "import json; from PyInstaller.utils.hooks import collect_submodules; print(json.dumps(collect_submodules('batea')))"
        r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def base_env(self) -> dict:
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        return env

    def test_con_pythonpath_encuentra_todos(self):
        found = set(self.collect({**self.base_env(), "PYTHONPATH": str(BACKEND)}))
        self.assertEqual(load_check_bundle().source_modules() - found, set())

    def test_sin_pythonpath_no_encuentra_nada(self):
        """Documenta la causa del fallo: si esto cambia, PyInstaller arregló su orden y la regla sigue sin molestar."""
        self.assertEqual(self.collect(self.base_env()), [])


class RegistryAndNowPlaying(unittest.TestCase):
    """Un lector que no carga se anota en el registro (stderr) en vez de pasar como «no encontrado»."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ.setdefault("BATEA_HOME", cls.tmp.name)
        os.environ.setdefault("BATEA_RB_DIR", str(Path(cls.tmp.name) / "rb"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_todos_los_lectores_cargan(self):
        from batea.sources import registry

        for kind in registry.ADAPTERS:
            with registry.adapter(kind) as a:
                self.assertIsNotNone(a, f"el lector de {kind} no carga desde el código")

    def test_lector_que_no_carga_queda_anotado(self):
        from batea.sources import registry

        err = io.StringIO()
        fake = {**registry.ADAPTERS, "rekordbox": ("batea.sources.no_existe", "RekordboxSource")}
        with mock.patch.object(registry, "ADAPTERS", fake), contextlib.redirect_stderr(err):
            with registry.adapter("rekordbox") as a:
                self.assertIsNone(a)
        self.assertIn("no se pudo cargar el lector de rekordbox", err.getvalue())
        self.assertIn("batea.sources.no_existe", err.getvalue())

    def test_traktor_en_vivo_carga(self):
        from batea import nowplaying

        self.assertIsNotNone(nowplaying._traktor())
        self.assertIn("traktor", nowplaying._readers())

    def test_traktor_en_vivo_que_no_carga_avisa_una_vez(self):
        from batea import nowplaying

        err = io.StringIO()
        with mock.patch.object(nowplaying.importlib, "import_module", side_effect=ImportError("falta")), \
                mock.patch.object(nowplaying, "_traktor_warned", False), contextlib.redirect_stderr(err):
            self.assertIsNone(nowplaying._traktor())
            self.assertIsNone(nowplaying._traktor())
            self.assertNotIn("traktor", nowplaying._readers())
        self.assertEqual(err.getvalue().count("no se pudo cargar batea.nowplaying_traktor"), 1)


if __name__ == "__main__":
    unittest.main()
