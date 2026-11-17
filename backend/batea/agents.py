"""Conectar el MCP de Batea con los agentes instalados (Claude Code, Codex, Cursor, Claude Desktop).

Cada agente guarda su lista de servidores MCP en su propio archivo. Batea solo agrega o saca
su propia entrada ("batea"); el resto del archivo queda igual. Antes de escribir guarda una copia
(`<archivo>.batea-bak`) y después verifica que el archivo siga siendo válido; si no, lo restaura.
Para Claude Code usa su propio comando (`claude mcp`), que sabe escribir su configuración.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

from . import runtime

HOME = Path.home()
BACKEND = Path(__file__).resolve().parent.parent
PYTHON = BACKEND / ".venv" / "bin" / "python"
NAME = "batea"


def spec() -> dict:
    """Cómo arranca un agente el servidor de Batea (desde cualquier carpeta)."""
    if runtime.frozen():   # app empaquetada: el mismo ejecutable de Batea, sin Python ni carpetas aparte
        return {"command": sys.executable, "args": ["--run-module", "batea.mcp_server"], "env": {}}
    return {"command": str(PYTHON), "args": ["-m", "batea.mcp_server"], "env": {"PYTHONPATH": str(BACKEND)}}


def ready() -> bool:
    return runtime.frozen() or PYTHON.exists()


def _same(entry: dict | None) -> bool:
    if not isinstance(entry, dict):
        return False
    s = spec()
    return (entry.get("command") == s["command"] and list(entry.get("args") or []) == s["args"]
            and (entry.get("env") or {}).get("PYTHONPATH") == s["env"].get("PYTHONPATH"))


def _status(entry: dict | None) -> str:
    if entry is None:
        return "off"
    return "on" if _same(entry) else "stale"   # stale: apunta a otra carpeta de Batea


def _write_checked(path: Path, text: str, check) -> None:
    """Escribe con copia previa; si el resultado no pasa `check`, deja el archivo como estaba."""
    old = path.read_text() if path.exists() else None
    path.parent.mkdir(parents=True, exist_ok=True)
    if old is not None:
        (path.parent / (path.name + ".batea-bak")).write_text(old)
    tmp = path.with_name(path.name + ".batea-tmp")
    tmp.write_text(text)
    try:
        check(tmp.read_text())
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"No modifiqué {path}: el resultado no era válido ({e})") from e
    if old is not None and path.exists():
        os.chmod(tmp, path.stat().st_mode & 0o777)
    tmp.replace(path)


# ------------------------------------------------------------------ JSON (Cursor, Claude Desktop)
def _json_get(path: Path) -> dict | None:
    try:
        return (json.loads(path.read_text()).get("mcpServers") or {}).get(NAME)
    except (OSError, ValueError, AttributeError):
        return None


def _json_set(path: Path, entry: dict | None) -> None:
    data = json.loads(path.read_text()) if path.exists() and path.read_text().strip() else {}
    if not isinstance(data, dict):
        raise RuntimeError(f"{path} no tiene el formato esperado")
    servers = data.setdefault("mcpServers", {})
    if entry is None:
        servers.pop(NAME, None)
    else:
        servers[NAME] = entry

    def check(text: str) -> None:
        got = (json.loads(text).get("mcpServers") or {}).get(NAME)
        assert (got is None) if entry is None else _same(got)

    _write_checked(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n", check)


# ------------------------------------------------------------------ TOML (Codex)
CODEX = HOME / ".codex" / "config.toml"
_HEADER = re.compile(r"^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$")


def _is_ours(table: str) -> bool:
    t = table.replace('"', "").replace("'", "")
    return t == f"mcp_servers.{NAME}" or t.startswith(f"mcp_servers.{NAME}.")


def _toml_strip(text: str) -> str:
    out, skip = [], False
    for line in text.splitlines(keepends=True):
        m = _HEADER.match(line)
        if m:
            skip = _is_ours(m.group(1))
        if not skip:
            out.append(line)
    return "".join(out).rstrip("\n") + "\n" if out else ""


def _codex_get() -> dict | None:
    try:
        return tomllib.loads(CODEX.read_text()).get("mcp_servers", {}).get(NAME)
    except (OSError, tomllib.TOMLDecodeError):
        return None


def _codex_set(on: bool) -> None:
    text = CODEX.read_text() if CODEX.exists() else ""
    tomllib.loads(text)   # si ya estaba roto, no lo toco
    text = _toml_strip(text)
    if on:
        s = spec()
        q = lambda v: json.dumps(v, ensure_ascii=False)  # noqa: E731  (los strings JSON son strings TOML válidos)
        text += (f"\n[mcp_servers.{NAME}]\n"
                 f"command = {q(s['command'])}\n"
                 f"args = [{', '.join(q(a) for a in s['args'])}]\n"
                 + (f"env = {{ PYTHONPATH = {q(s['env']['PYTHONPATH'])} }}\n" if s["env"].get("PYTHONPATH") else ""))

    def check(t: str) -> None:
        got = tomllib.loads(t).get("mcp_servers", {}).get(NAME)
        assert _same(got) if on else got is None

    _write_checked(CODEX, text, check)


# ------------------------------------------------------------------ Claude Code
CLAUDE_JSON = HOME / ".claude.json"


def _claude_bin() -> str | None:
    for p in (HOME / ".local" / "bin" / "claude", Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude")):
        if p.exists():
            return str(p)
    return shutil.which("claude")


def _claude_get() -> dict | None:
    try:
        return (json.loads(CLAUDE_JSON.read_text()).get("mcpServers") or {}).get(NAME)
    except (OSError, ValueError, AttributeError):
        return None


def _claude_set(on: bool) -> None:
    b = _claude_bin()
    if not b:
        raise RuntimeError("No encuentro el comando claude")
    env = {**os.environ, "PATH": f"{Path(b).parent}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"}
    run = lambda *a: subprocess.run([b, "mcp", *a], capture_output=True, text=True, timeout=60, env=env, cwd=str(HOME))  # noqa: E731
    if _claude_get() is not None:
        run("remove", "--scope", "user", NAME)
    if on:
        r = run("add-json", "--scope", "user", NAME, json.dumps({"type": "stdio", **spec()}))
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip() or "claude mcp add-json falló")
    if _status(_claude_get()) != ("on" if on else "off"):
        raise RuntimeError("Claude Code no guardó el cambio")


# ------------------------------------------------------------------ catálogo
CURSOR = HOME / ".cursor" / "mcp.json"
DESKTOP = HOME / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"

AGENTS = [
    {"id": "claude_code", "name": "Claude Code", "file": str(CLAUDE_JSON),
     "note": "También lo usa T3 Code en las conversaciones con Claude.",
     "installed": lambda: _claude_bin() is not None, "get": _claude_get, "set": _claude_set},
    {"id": "codex", "name": "Codex", "file": str(CODEX),
     "note": "La app y la terminal de Codex comparten esta configuración; T3 Code también la usa con Codex.",
     "installed": lambda: CODEX.parent.exists() or shutil.which("codex") is not None, "get": _codex_get, "set": _codex_set},
    {"id": "cursor", "name": "Cursor", "file": str(CURSOR), "note": "",
     "installed": lambda: CURSOR.parent.exists() or Path("/Applications/Cursor.app").exists(),
     "get": lambda: _json_get(CURSOR), "set": lambda on: _json_set(CURSOR, spec() if on else None)},
    {"id": "claude_desktop", "name": "Claude (app de escritorio)", "file": str(DESKTOP),
     "note": "Después de conectar hay que cerrar y abrir la app de Claude.",
     "installed": lambda: Path("/Applications/Claude.app").exists() or DESKTOP.parent.exists(),
     "get": lambda: _json_get(DESKTOP), "set": lambda on: _json_set(DESKTOP, spec() if on else None)},
]


def listing() -> dict:
    out = []
    for a in AGENTS:
        installed = bool(a["installed"]())
        out.append({"id": a["id"], "name": a["name"], "note": a["note"], "file": a["file"].replace(str(HOME), "~"),
                    "installed": installed, "status": _status(a["get"]()) if installed else "missing"})
    return {"agents": out, "manual": {"mcpServers": {NAME: spec()}}, "ready": ready()}


def set_connected(agent_id: str, on: bool) -> dict:
    a = next((x for x in AGENTS if x["id"] == agent_id), None)
    if a is None:
        raise KeyError(agent_id)
    if on and runtime.translocated():
        raise RuntimeError("Mové Batea a la carpeta Aplicaciones, cerrala y volvé a abrirla; recién ahí se puede conectar")
    if on and not ready():
        raise RuntimeError("Falta el entorno de Python de Batea: corré scripts/make_app.sh")
    a["set"](on)
    return listing()


def test() -> dict:
    """Arranca el servidor como lo haría un agente (desde otra carpeta) y le pide la lista de herramientas.

    Como un agente de verdad: la conexión queda abierta hasta recibir la respuesta (cerrar la entrada de golpe
    puede cortar el servidor antes de que conteste)."""
    import selectors
    import time

    s = spec()
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "batea-test", "version": "1"}}}
    msgs = [init, {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    p = subprocess.Popen([s["command"], *s["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, cwd=str(HOME), env={**os.environ, **s["env"]})
    try:
        p.stdin.write("".join(json.dumps(m) + "\n" for m in msgs))
        p.stdin.flush()
        sel = selectors.DefaultSelector()
        sel.register(p.stdout, selectors.EVENT_READ)
        deadline, buf = time.time() + 60, ""
        while time.time() < deadline and p.poll() is None:
            if not sel.select(timeout=0.5):
                continue
            line = p.stdout.readline()
            if not line:
                break
            buf = line
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == 2 and "result" in m:
                n = len(m["result"].get("tools", []))
                return {"ok": True, "tools": n, "message": f"Funciona: {n} herramientas disponibles"}
        if p.poll() is None:
            return {"ok": False, "message": "El servidor no contestó a tiempo"}
        err = (p.stderr.read().strip().splitlines() or ["sin detalle"])[-1]
        return {"ok": False, "message": f"El servidor no arrancó: {err}"}
    finally:
        p.kill()
        p.wait()
