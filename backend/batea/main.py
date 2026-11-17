"""Arranque: servidor local + ventana nativa de macOS (WKWebView vía pywebview).

    uv run python -m batea.main            # app con ventana
    uv run python -m batea.main --server   # solo servidor en :8765 (desarrollo)
    Batea --version                        # versión, arquitectura y huella del código (JSON)
    Batea --selftest                       # (app empaquetada) prueba sin ventanas
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time

import uvicorn


def _free_port(preferred: int = 8765) -> int:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


class JsApi:
    """Funciones nativas expuestas al frontend como window.pywebview.api.*"""

    def __init__(self) -> None:
        self.window = None

    def pick_folder(self) -> str | None:
        import webview

        res = self.window.create_file_dialog(webview.FileDialog.FOLDER)
        return res[0] if res else None


def on_drop(e: dict) -> list[str]:
    """Archivos o carpetas soltados sobre la ventana: Batea los trae (aunque estén en una carpeta ignorada)."""
    from . import discover

    files = (e.get("dataTransfer") or {}).get("files") or []
    paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
    if paths:
        discover.start(paths)
    return paths


def bind_drop(window) -> None:
    from webview.dom import DOMEventHandler

    window.dom.document.events.dragover += DOMEventHandler(lambda e: None, True, False, debounce=500)
    window.dom.document.events.drop += DOMEventHandler(on_drop, True, False)


def _bring_to_front(window) -> None:
    try:
        window.restore()
        window.show()
    except Exception:  # noqa: BLE001
        pass
    try:
        from AppKit import NSApplication
        from PyObjCTools import AppHelper

        def act() -> None:
            app = NSApplication.sharedApplication()
            if hasattr(app, "activate"):
                app.activate()
            else:
                app.activateIgnoringOtherApps_(True)

        AppHelper.callAfter(act)
    except Exception:  # noqa: BLE001
        pass


def link_notifier(window):
    """Cuando llega un link batea://, la interfaz lo levanta enseguida y la ventana pasa al frente."""
    def notify(focus: bool) -> None:
        def run() -> None:
            try:
                window.evaluate_js("window.__bateaOpen && window.__bateaOpen()")
            except Exception:  # noqa: BLE001  (igual la interfaz revisa cada pocos segundos)
                pass
            if focus:
                _bring_to_front(window)
        threading.Thread(target=run, daemon=True).start()
    return notify


def _run_module_mode() -> bool:
    """`Batea --run-module batea.menubar --parent 123`: lo que en desarrollo es `python -m …`.

    La app empaquetada no trae un Python suelto: los procesos auxiliares (ícono de la barra,
    links batea://, servidor MCP de los agentes) arrancan con el mismo ejecutable.
    """
    if len(sys.argv) >= 3 and sys.argv[1] == "--run-module":
        import runpy

        module = sys.argv[2]
        sys.argv = [module, *sys.argv[3:]]
        runpy.run_module(module, run_name="__main__", alter_sys=True)
        return True
    if len(sys.argv) >= 2 and sys.argv[1] == "--version":
        import json

        from . import runtime

        print(json.dumps(runtime.build_info()))
        return True
    if len(sys.argv) >= 2 and sys.argv[1] == "--selftest":
        from . import selftest

        sys.exit(selftest.run())
    return False


def _log_to_file() -> None:
    """Empaquetada y abierta desde el Finder no hay terminal: los errores van a ~/Library/Logs/Batea.log
    (igual que con el lanzador de make_app.sh)."""
    from . import runtime

    if not runtime.frozen() or sys.stderr is not None and sys.stderr.isatty():
        return
    try:
        log = os.path.expanduser("~/Library/Logs")
        os.makedirs(log, exist_ok=True)
        fd = os.open(os.path.join(log, "Batea.log"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.dup2(fd, 1)
        os.dup2(fd, 2)
        sys.stdout = os.fdopen(1, "w", buffering=1)
        sys.stderr = os.fdopen(2, "w", buffering=1)
    except OSError:
        pass


def main() -> None:
    if _run_module_mode():
        return
    _log_to_file()
    server_only = "--server" in sys.argv
    port = int(os.environ.get("BATEA_PORT", 8765)) if server_only else _free_port()
    config = uvicorn.Config("batea.api:app", host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)

    from . import links

    if server_only:
        print(f"Batea en http://127.0.0.1:{port}")
        if links.running() is None:  # con la app abierta, los links siguen yendo a la app
            links.publish(port)
        try:
            server.run()
        finally:
            links.unpublish()
        return

    import webview

    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.05)

    api = JsApi()
    window = webview.create_window(
        "Batea", f"http://127.0.0.1:{port}/", js_api=api,
        width=1480, height=920, min_size=(1100, 700), background_color="#0e0d0c",
    )
    api.window = window
    links.set_notifier(link_notifier(window))
    links.publish(port)

    window.events.loaded += lambda: bind_drop(window)
    bar = start_menubar()
    try:
        webview.start(private_mode=False)
    finally:
        links.unpublish()
        server.should_exit = True
        if bar is not None:
            bar.terminate()


def start_menubar():
    """Ícono de la barra de arriba (proceso aparte; se cierra solo si Batea se cierra)."""
    if os.environ.get("BATEA_NO_MENUBAR"):
        return None
    import subprocess
    from pathlib import Path

    try:
        from . import runtime

        return subprocess.Popen(runtime.self_command("batea.menubar", "--parent", str(os.getpid())),
                                cwd=str(Path(__file__).resolve().parent.parent) if not runtime.frozen() else None)
    except OSError:
        return None


if __name__ == "__main__":
    main()
