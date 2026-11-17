"""Cómo corre Batea: desde el código fuente (desarrollo, ~/Applications/Batea.app de make_app.sh)
o empaquetada con PyInstaller (Batea.app autónoma, sin Python ni carpetas externas).

Todo lo que cambia entre los dos modos vive acá, para que el resto del código no lo tenga que saber.
"""
from __future__ import annotations

import json
import platform
import sys
from pathlib import Path


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_root() -> Path | None:
    """La Batea.app en la que estamos corriendo (solo empaquetada)."""
    if not frozen():
        return None
    for p in Path(sys.executable).resolve().parents:
        if p.suffix == ".app":
            return p
    return None


def resource_dir() -> Path:
    """Carpeta donde PyInstaller deja los archivos de datos (la interfaz compilada)."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def self_command(module: str, *args: str) -> list[str]:
    """Comando para correr otro módulo de Batea en un proceso aparte, en cualquiera de los dos modos."""
    if frozen():
        return [sys.executable, "--run-module", module, *args]
    return [sys.executable, "-m", module, *args]


def build_info() -> dict:
    """Qué versión es: {version, arch, fingerprint, built_at}. Empaquetada la trae `build_info.json` (lo escribe
    scripts/make_dist.sh); en desarrollo se lee VERSION y la huella es "dev"."""
    if frozen():
        try:
            return json.loads((resource_dir() / "build_info.json").read_text())
        except (OSError, ValueError):
            return {"version": "?", "arch": platform.machine(), "fingerprint": "?", "built_at": None}
    try:
        ver = (Path(__file__).resolve().parent.parent.parent / "VERSION").read_text().strip()
    except OSError:
        ver = "dev"
    return {"version": ver, "arch": platform.machine(), "fingerprint": "dev", "built_at": None}


def translocated() -> bool:
    """macOS corre las apps recién bajadas desde una carpeta temporal de solo lectura hasta que se las mueve."""
    return "AppTranslocation" in str(Path(sys.executable))
