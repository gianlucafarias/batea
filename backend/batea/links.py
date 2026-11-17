"""Links batea:// — abrir un tema, una caja, una carpeta o un artista en Batea desde afuera.

    batea://tema/1234            ficha del tema   (?play=1 además lo reproduce)
    batea://caja/56              una caja, playlist o sesión del historial (también atajos: batea://caja/inbox)
    batea://carpeta/<ruta>       una carpeta real (ruta codificada para URL)
    batea://artista/<nombre>     todos los temas de un artista

macOS le pasa el link a "Batea Links.app" (un applet chiquito que crea scripts/make_app.sh), que
corre `python -m batea.links <url>`. Ese proceso busca la app abierta mediante el archivo
`app.json` (puerto + token) y le manda el pedido por HTTP; si Batea está cerrada, la abre y
espera a que arranque. La app nunca se abre dos veces: solo se lanza si no hay una viva.
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, quote, unquote, urlsplit

from . import config

APP_FILE = config.APP_DIR / "app.json"


def _app_bundle() -> Path:
    from . import runtime

    return runtime.bundle_root() or Path.home() / "Applications" / "Batea.app"


APP_BUNDLE = _app_bundle()
KINDS = {"tema", "caja", "carpeta", "artista"}


# ------------------------------------------------------------------ armar y leer links
def track_url(tid: int) -> str:
    return f"batea://tema/{int(tid)}"


def crate_url(crate: int | str) -> str:
    crate = str(crate)
    if crate.startswith("dir:"):
        return "batea://carpeta/" + quote(crate[4:], safe="/")
    if crate.startswith("artist:"):
        return "batea://artista/" + quote(crate[7:].strip(), safe="")
    return "batea://caja/" + quote(crate, safe="")


def parse(url: str) -> dict:
    """batea://tema/12?play=1 -> {"kind": "tema", "value": "12", "play": True}. ValueError si no es válido."""
    u = urlsplit(url.strip())
    if u.scheme != "batea":
        raise ValueError("No es un link de Batea")
    kind = u.netloc
    value = unquote(u.path[1:] if u.path.startswith("/") else u.path)
    if kind not in KINDS or not value:
        raise ValueError(f"Link de Batea desconocido: {url}")
    if kind == "tema" and not value.isdigit():
        raise ValueError("El id del tema tiene que ser un número")
    if kind == "carpeta" and not value.startswith("/"):
        value = "/" + value
    play = parse_qs(u.query).get("play", ["0"])[0] in ("1", "true", "si", "sí")
    return {"kind": kind, "value": value, "play": play and kind == "tema"}


# ------------------------------------------------------------------ lado de la app
_pending: list[dict] = []
_lock = threading.Lock()
_notify: Callable[[bool], None] | None = None
_token: str | None = None


def set_notifier(fn: Callable[[bool], None] | None) -> None:
    """La ventana nativa avisa a la interfaz (y se pone al frente si `focus`) cuando llega un pedido."""
    global _notify
    _notify = fn


def push(target: dict, focus: bool = True) -> None:
    with _lock:
        _pending.append(target)
        del _pending[:-20]
    if _notify:
        try:
            _notify(focus)
        except Exception:  # noqa: BLE001  (si la ventana no responde, la interfaz igual lo levanta sola)
            pass


def drain() -> list[dict]:
    with _lock:
        out = list(_pending)
        _pending.clear()
    return out


def token() -> str | None:
    return _token


def publish(port: int) -> None:
    """Anota dónde escucha esta instancia, para los links y el MCP."""
    global _token
    _token = secrets.token_urlsafe(24)
    config.APP_DIR.mkdir(parents=True, exist_ok=True)
    tmp = APP_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"port": port, "token": _token, "pid": os.getpid()}))
    os.chmod(tmp, 0o600)
    tmp.replace(APP_FILE)


def unpublish() -> None:
    try:
        if json.loads(APP_FILE.read_text()).get("pid") == os.getpid():
            APP_FILE.unlink()
    except (OSError, ValueError):
        pass


# ------------------------------------------------------------------ lado de afuera (abridor, MCP)
def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def running() -> dict | None:
    """{"port", "token", "pid"} de la Batea abierta, o None si no hay ninguna."""
    try:
        info = json.loads(APP_FILE.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict) or not info.get("port") or not _alive(int(info.get("pid", 0))):
        return None
    return info


def call(info: dict, method: str, path: str, body: dict | None = None, timeout: float = 5) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{info['port']}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "X-Batea-Token": str(info.get("token", ""))},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def send(url: str, launch: bool = True, wait: float = 45) -> str:
    """Manda el link a la Batea abierta; si no hay, la abre (con `launch`) y espera. Devuelve qué pasó."""
    parse(url)
    info = running()
    if info is None:
        if not launch:
            return "cerrada"
        if not APP_BUNDLE.exists():
            raise RuntimeError(f"No encuentro {APP_BUNDLE}")
        subprocess.Popen(["/usr/bin/open", str(APP_BUNDLE)])
        t0 = time.time()
        while time.time() - t0 < wait:
            time.sleep(0.5)
            info = running()
            if info:
                break
        if info is None:
            raise RuntimeError("Batea no terminó de abrir")
    last: Exception | None = None
    for _ in range(20):  # recién abierta, el servidor puede tardar un momento en contestar
        try:
            call(info, "POST", "/api/open", {"url": url})
            return "abierto"
        except urllib.error.HTTPError as e:
            raise RuntimeError(json.loads(e.read() or b"{}").get("detail") or str(e)) from e
        except OSError as e:
            last = e
            time.sleep(0.5)
    raise RuntimeError(f"Batea no contesta: {last}")


def _log(msg: str) -> None:
    try:
        log = Path.home() / "Library" / "Logs" / "Batea.log"
        with log.open("a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} links: {msg}\n")
    except OSError:
        pass


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("uso: python -m batea.links batea://tema/123", file=sys.stderr)
        return 2
    try:
        print(send(argv[1], launch="--no-launch" not in argv))
        return 0
    except (ValueError, RuntimeError) as e:
        _log(f"{argv[1]}: {e}")
        print(e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
