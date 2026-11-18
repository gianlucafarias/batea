"""Prueba de humo sin ventanas: `Batea --selftest` (o `python -m batea.main --selftest`).

Comprueba que la app empaquetada trae todo lo que necesita: interfaz, librerías nativas, análisis de
audio en un proceso aparte, el servidor MCP de los agentes y que arranca sin rekordbox. No abre ventanas,
no busca música en el disco ni toca tu biblioteca: pensado para correr con BATEA_HOME y BATEA_RB_DIR
apuntando a carpetas vacías (lo hace scripts/make_dist.sh).
"""
from __future__ import annotations

import os
import sys
import tempfile
import traceback
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path


def _tone_wav(path: Path) -> None:
    """20 s de un acorde de Do mayor con pulso de 124 BPM: Camelot esperado 8B (Do mayor)."""
    import numpy as np
    import soundfile as sf

    sr = 44100
    t = np.arange(sr * 20) / sr
    chord = sum(np.sin(2 * np.pi * f * t) for f in (130.81, 164.81, 196.0, 261.63, 329.63, 392.0))
    pulse = (np.sin(2 * np.pi * (124 / 60) * t) > 0.6).astype(float) * 0.6 + 0.4
    sf.write(str(path), (chord * pulse / 8).astype("float32"), sr)


def run() -> int:
    from . import config, runtime

    fails: list[str] = []

    def check(name: str, fn) -> None:
        try:
            detail = fn()
            print(f"  ok     {name}" + (f"  ({detail})" if detail else ""), flush=True)
        except Exception as e:  # noqa: BLE001
            fails.append(name)
            print(f"  FALLA  {name}: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()

    info = runtime.build_info()
    print(f"Batea selftest · versión {info['version']} (huella {str(info['fingerprint'])[:12]}) · empaquetada={runtime.frozen()}"
          f" · python {sys.version.split()[0]} · {os.uname().machine}")
    for var in ("BATEA_HOME", "BATEA_RB_DIR"):
        if not os.environ.get(var):
            print(f"  ATENCIÓN: {var} no está definida: se usaría tu carpeta real. Abortando.")
            return 2

    def interface() -> str:
        idx = config.FRONTEND_DIST / "index.html"
        assert idx.exists(), f"falta {idx}"
        assert any((config.FRONTEND_DIST / "assets").iterdir()), "assets vacío"
        return str(config.FRONTEND_DIST)

    check("interfaz compilada", interface)

    def imports() -> str:
        import importlib

        mods = ["numpy", "scipy", "sklearn", "numba", "librosa", "soundfile", "mutagen", "sqlcipher3", "pyrekordbox", "fastapi", "uvicorn", "mcp", "webview",
                "objc", "AppKit", "Foundation", "batea.api", "batea.menubar", "batea.links", "batea.mcp_server",
                "batea.keyfill", "batea.discover", "batea.nowplaying", "batea.export"]
        for m in mods:
            importlib.import_module(m)
        try:                       # Essentia es opcional: la versión para Intel no la trae
            importlib.import_module("essentia.standard")
            extra = " + essentia"
        except ImportError:
            extra = ", sin essentia (tonalidad con librosa)"
        return f"{len(mods)} módulos{extra}"

    check("librerías y módulos", imports)

    tmp = Path(tempfile.mkdtemp(prefix="batea-selftest-"))
    wav = tmp / "acorde.wav"
    _tone_wav(wav)

    def analysis() -> str:
        from . import analysis as an

        with ProcessPoolExecutor(max_workers=1, initializer=an.low_priority) as pool:
            res = pool.submit(an.analyze_file, str(wav)).result(timeout=180)
        assert res["duration"] > 19, res["duration"]
        assert res["waveform"], "sin waveform"
        return f"bpm {res['bpm']}, tono {res['key']}, {res['duration']:.0f} s"

    check("análisis de audio en proceso aparte (librosa/numba)", analysis)

    def keyfill() -> str:
        from . import keyfill as kf

        with ProcessPoolExecutor(max_workers=1) as pool:
            key, strength, err = pool.submit(kf._safe, str(wav)).result(timeout=120)
        assert err is None, err
        assert key, "sin tonalidad"
        return f"{key} · {strength:.2f}"

    check("detector de tonalidad", keyfill)

    def rekordbox_missing() -> str:
        from . import api

        st = api.status()
        assert st["rekordbox_found"] is False, "debería no encontrar rekordbox en la carpeta vacía"
        return "arranca y avisa que no hay rekordbox"

    check("base propia y arranque sin rekordbox", rekordbox_missing)

    def mcp() -> str:
        from . import agents

        r = agents.test()
        assert r["ok"], r["message"]
        return r["message"]

    check("servidor MCP para agentes (proceso aparte)", mcp)

    def links() -> str:
        from . import links as lk

        assert lk.parse("batea://tema/123"), "no entiende batea://"
        return str(lk.APP_BUNDLE)

    check("links batea://", links)

    def updates_rules() -> str:
        """Bloquea solo si se sabe que la versión es menor que la mínima; sin datos, o con versiones raras, abre."""
        from . import updates

        data = {"version": "9.0.0", "min_version": "0.5.0"}
        assert updates.evaluate(data, "0.4.9")["must_update"] == updates.enforced(), "0.4.9 debería quedar por debajo de 0.5.0"
        assert not updates.evaluate(data, "0.5.0")["must_update"] and not updates.evaluate(data, "0.10.0")["must_update"]
        assert updates.evaluate(data, "0.5.0")["update_available"]
        assert not updates.evaluate(None, "0.1.0")["must_update"], "sin datos no se bloquea"
        assert not updates.evaluate(data, "dev")["must_update"] and not updates.evaluate(data, "?")["must_update"]
        assert updates.open_target().startswith(updates.ALLOWED_PREFIX)
        return f"bloqueo {'activo' if updates.enforced() else 'apagado (desarrollo)'}"

    check("actualización obligatoria (reglas)", updates_rules)

    def ask_first() -> str:
        """Una instalación nueva no busca música ni importa nada sola: espera a que la persona lo permita."""
        import time

        from . import db, discover

        db.init()
        with db.conn() as c:
            assert discover.auto_enabled(c) is False, "una instalación nueva no debería buscar sola"
        calls: list[int] = []
        real_start, real_volumes = discover.start, discover.volumes
        discover.start = lambda *a, **k: calls.append(1)     # simulada: no recorre tu disco
        discover.volumes = lambda: set()
        try:
            discover._watch_started = False
            discover.watch(delay=0.05, every=3600)
            time.sleep(4)
            assert not calls, "buscó música sin que nadie lo pidiera"
            discover.set_auto(True)                          # la persona lo permitió
            deadline = time.time() + 10
            while not calls and time.time() < deadline:
                time.sleep(0.1)
            assert calls, "permitida la búsqueda automática, no arrancó"
        finally:
            discover.start, discover.volumes = real_start, real_volumes
            discover.set_auto(False)
        return "no busca nada hasta que se le permite; después sí"

    check("primera vez: no arranca nada sin preguntar", ask_first)

    def local_import() -> str:
        """Una Mac sin rekordbox: traer una carpeta a mano. El artista y el título salen del nombre del archivo."""
        import time

        import numpy as np
        import soundfile as sf

        from . import db, discover, jobs

        db.init()
        folder = tmp / "Mi Musica"
        folder.mkdir()
        sr = 8000
        t = np.arange(sr * 130) / sr
        sf.write(str(folder / "Artista Uno - Tema Dos.wav"), (0.2 * np.sin(2 * np.pi * 220 * t)).astype("float32"), sr)
        job = discover.start([str(folder)])
        deadline = time.time() + 90
        while time.time() < deadline:
            j = next((x for x in jobs.list_jobs() if x["id"] == job.id), None)
            if j and j["status"] != "running":
                break
            time.sleep(0.5)
        with db.conn() as c:
            row = c.execute("SELECT title, artist, source FROM tracks WHERE source='local'").fetchone()
        assert row is not None, "no trajo el tema"
        assert (row["artist"], row["title"]) == ("Artista Uno", "Tema Dos"), dict(row)
        return "trae la carpeta y separa artista y título del nombre"

    check("sin rekordbox: traer una carpeta a mano", local_import)

    print("\nRESULTADO:", "todo bien" if not fails else f"fallaron {len(fails)}: {', '.join(fails)}")
    return 0 if not fails else 1
