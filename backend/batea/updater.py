"""Actualizar Batea desde adentro del programa.

Flujo (solo la app empaquetada, instalada en una carpeta donde se pueda escribir, p. ej. /Applications):
  1. Descarga el .dmg de esta arquitectura del release de GitHub (solo direcciones de este repositorio).
  2. Lo abre sin mostrarlo (hdiutil) y VERIFICA la app que trae: firma íntegra, firmada por el equipo de Apple del autor,
     aceptada por Gatekeeper (notarizada) y con la versión anunciada. Si algo no cuadra, no se instala nada.
  3. La copia junto a la instalada (`.Batea-update-<versión>.app`) y deja todo listo.
  4. «Reiniciar»: un script aparte espera a que Batea se cierre, cambia la app vieja por la nueva y la vuelve a abrir.
     Se cambia al reiniciar (no antes) porque reemplazar una app mientras corre puede dejarla a medias.

Si algo falla, la app sigue como estaba y se ofrece la descarga a mano.
"""
from __future__ import annotations

import os
import plistlib
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from . import config, runtime, updates

EXPECTED_TEAM = "J96S7CUHS9"             # equipo de Apple que firma las versiones de Batea
MIN_DMG_BYTES = 20_000_000
STAGED_PREFIX = ".Batea-update-"

_lock = threading.Lock()
_state: dict = {"state": "idle", "progress": 0.0, "message": "", "version": None, "error": None, "manual": False}


def snapshot() -> dict:
    with _lock:
        return dict(_state)


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def parse_version(v: str) -> tuple[int, ...] | None:
    return updates.parse(v)


# ------------------------------------------------------------------ ¿se puede instalar acá?
def demo() -> bool:
    """BATEA_UPDATE_DEMO=1: recorre todo el aviso con un avance simulado (para ver cómo se ve), sin descargar ni instalar nada."""
    return os.environ.get("BATEA_UPDATE_DEMO") == "1"


def can_install() -> tuple[bool, str | None]:
    """(sí/no, motivo). Desarrollo, app abierta desde el .dmg o carpeta sin permiso: se descarga a mano."""
    if demo():
        return True, None
    if not runtime.frozen():
        return False, "dev"
    if runtime.translocated():
        return False, "translocated"
    app = runtime.bundle_root()
    if app is None:
        return False, "no-bundle"
    if not os.access(app.parent, os.W_OK):
        return False, "no-write"
    return True, None


# ------------------------------------------------------------------ descarga
def _download(url: str, dest: Path, progress, opener=urllib.request.urlopen) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "Batea-updater"})
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    with opener(req, timeout=30) as r, open(part, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                progress(got / total)
    part.replace(dest)


# ------------------------------------------------------------------ verificación de la app
def _run(cmd: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def app_version(app: Path) -> str | None:
    try:
        with open(app / "Contents" / "Info.plist", "rb") as f:
            return str(plistlib.load(f).get("CFBundleShortVersionString") or "") or None
    except (OSError, plistlib.InvalidFileException):
        return None


def verify_app(app: Path, version: str, team: str = EXPECTED_TEAM, gatekeeper: bool = True) -> None:
    """Lanza ValueError si la app no es una Batea legítima de esa versión."""
    if app_version(app) != version:
        raise ValueError("La app descargada no es la versión anunciada")
    r = _run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])
    if r.returncode:
        raise ValueError("La firma de la app descargada no es íntegra")
    r = _run(["/usr/bin/codesign", "-dv", "--verbose=4", str(app)])
    if not re.search(rf"^TeamIdentifier={re.escape(team)}$", r.stderr + r.stdout, re.M):
        raise ValueError("La app descargada no está firmada por el autor de Batea")
    if gatekeeper:
        r = _run(["/usr/sbin/spctl", "--assess", "--type", "execute", str(app)])
        if r.returncode:
            raise ValueError("macOS no acepta la app descargada (no está notarizada)")


def _mount(dmg: Path) -> tuple[Path, Path]:
    """Abre el .dmg sin mostrarlo en el Finder. Devuelve (punto de montaje, Batea.app que trae)."""
    r = _run(["/usr/bin/hdiutil", "attach", "-nobrowse", "-readonly", "-noverify", "-plist", str(dmg)])
    if r.returncode:
        raise ValueError("No pude abrir el archivo descargado")
    info = plistlib.loads(r.stdout.encode())
    points = [Path(e["mount-point"]) for e in info.get("system-entities", []) if e.get("mount-point")]
    for p in points:
        apps = sorted(p.glob("*.app"))
        if apps:
            return p, apps[0]
    for p in points:
        _run(["/usr/bin/hdiutil", "detach", "-force", str(p)])
    raise ValueError("El archivo descargado no trae la app")


def _detach(mount: Path) -> None:
    _run(["/usr/bin/hdiutil", "detach", "-force", str(mount)], timeout=60)


# ------------------------------------------------------------------ preparar la instalación
def stage(dmg: Path, version: str, target: Path, team: str = EXPECTED_TEAM, gatekeeper: bool = True) -> Path:
    """Verifica la app del .dmg y la copia al lado de la instalada. Devuelve la ruta de la copia."""
    mount, src = _mount(dmg)
    try:
        verify_app(src, version, team, gatekeeper)
        dst = target.parent / f"{STAGED_PREFIX}{version}.app"
        if dst.exists():
            shutil.rmtree(dst)
        r = _run(["/usr/bin/ditto", str(src), str(dst)], timeout=600)
        if r.returncode:
            raise ValueError("No pude copiar la app nueva (¿hay lugar en el disco?)")
        verify_app(dst, version, team, gatekeeper=False)          # la copia también tiene que quedar íntegra
        return dst
    finally:
        _detach(mount)


def _worker(version: str, url: str) -> None:
    app = runtime.bundle_root()
    assert app is not None
    cache = config.APP_DIR / "updates"
    dmg = cache / Path(url).name
    try:
        _set(state="downloading", progress=0.0, message="Descargando…", error=None, manual=False)
        _download(url, dmg, lambda f: _set(progress=round(f, 4)))
        if dmg.stat().st_size < MIN_DMG_BYTES:
            raise ValueError("La descarga quedó incompleta")
        _set(state="verifying", progress=1.0, message="Comprobando que sea la app original…")
        _set(state="staging", message="Preparando la actualización…")
        stage(dmg, version, app)
        _set(state="ready", message="Actualización lista", progress=1.0)
    except Exception as e:  # noqa: BLE001
        _set(state="error", error=str(e) or "No se pudo actualizar", message="", manual=True)
    finally:
        shutil.rmtree(cache, ignore_errors=True)


def _demo_worker(version: str) -> None:
    for state, message, seconds in (("downloading", "Descargando…", 4.0), ("verifying", "Comprobando que sea la app original…", 1.3), ("staging", "Preparando la actualización…", 1.3)):
        steps = 20 if state == "downloading" else 1
        for i in range(steps):
            _set(state=state, progress=(i + 1) / steps if state == "downloading" else 1.0, message=message)
            time.sleep(seconds / steps)
    _set(state="ready", message="Actualización lista", progress=1.0)


def start_install() -> dict:
    """Empieza a bajar e instalar la versión que anuncia GitHub. Un solo intento a la vez."""
    info = updates.check()
    if not info.get("update_available"):
        raise ValueError("Ya tenés la última versión")
    if demo():
        with _lock:
            if _state["state"] in ("downloading", "verifying", "staging"):
                return dict(_state)
            _state.update(state="downloading", progress=0.0, message="Descargando…", version=info["latest"], error=None, manual=False)
        threading.Thread(target=_demo_worker, args=(info["latest"],), daemon=True, name="updater-demo").start()
        return snapshot()
    ok, why = can_install()
    url = info.get("download")
    if not ok or not url or not str(url).startswith(updates.ALLOWED_PREFIX):
        _set(state="error", manual=True, error="Esta copia de Batea no se puede actualizar sola: bajá la versión nueva a mano.")
        return snapshot()
    with _lock:
        if _state["state"] in ("downloading", "verifying", "staging"):
            return dict(_state)
        _state.update(state="downloading", progress=0.0, message="Descargando…", version=info["latest"], error=None, manual=False)
    threading.Thread(target=_worker, args=(info["latest"], url), daemon=True, name="updater").start()
    return snapshot()


# ------------------------------------------------------------------ reiniciar con la versión nueva
SWAP_SCRIPT = """#!/bin/bash
# Batea: espera a que se cierre, cambia la app vieja por la nueva y la vuelve a abrir.
PID="$1"; APP="$2"; NEW="$3"
OLD="$APP.old-$$"
for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
if [ -d "$NEW" ] && mv "$APP" "$OLD" 2>/dev/null; then
  if mv "$NEW" "$APP"; then rm -rf "$OLD"; else mv "$OLD" "$APP"; fi
fi
[ -n "$BATEA_UPDATE_NO_LAUNCH" ] || open -n "$APP"
"""


def staged_app() -> Path | None:
    """La actualización ya preparada junto a la app instalada (si la hay y es más nueva que la que corre)."""
    app = runtime.bundle_root()
    if app is None:
        return None
    cur = parse_version(str(runtime.build_info().get("version")))
    best: tuple[tuple[int, ...], Path] | None = None
    for p in app.parent.glob(f"{STAGED_PREFIX}*.app"):
        v = app_version(p)
        pv = parse_version(v) if v else None
        if pv and cur and pv > cur and (best is None or pv > best[0]):
            best = (pv, p)
    return best[1] if best else None


def restart(pid: int | None = None, app: Path | None = None, staged: Path | None = None, kill_self: bool = True) -> dict:
    """Cierra Batea y la reabre ya actualizada. El cambio lo hace un script aparte, cuando Batea ya no corre."""
    if demo():
        return {"restarting": True, "demo": True}               # en la demostración no se cierra nada
    app = app or runtime.bundle_root()
    staged = staged or staged_app()
    if app is None or staged is None or not staged.exists():
        raise ValueError("No hay una actualización lista")
    script = Path(tempfile.mkdtemp(prefix="batea-update-")) / "swap.sh"
    script.write_text(SWAP_SCRIPT)
    script.chmod(0o755)
    subprocess.Popen(["/bin/bash", str(script), str(pid or os.getpid()), str(app), str(staged)],
                     start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if kill_self:
        threading.Timer(0.7, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    return {"restarting": True}


# ------------------------------------------------------------------ al arrancar
def resume() -> None:
    """Si quedó una actualización preparada (se cerró Batea sin reiniciar), se vuelve a ofrecer reiniciar.
    Las copias que ya no sirven (de una versión igual o más vieja) se borran."""
    app = runtime.bundle_root()
    if app is None:
        return
    keep = staged_app()
    for p in list(app.parent.glob(f"{STAGED_PREFIX}*.app")) + list(app.parent.glob(f"{app.name}.old-*")):
        if p != keep:
            shutil.rmtree(p, ignore_errors=True)
    if keep:
        _set(state="ready", message="Actualización lista", version=app_version(keep), progress=1.0)
