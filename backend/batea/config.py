"""Rutas y configuración de Batea."""
from __future__ import annotations

import os
import sys
from pathlib import Path

HOME = Path.home()

# Datos propios de Batea (nunca dentro de la carpeta de rekordbox)
APP_DIR = Path(os.environ.get("BATEA_HOME", HOME / "Library" / "Application Support" / "Batea"))
DB_PATH = APP_DIR / "batea.db"
CACHE_DIR = APP_DIR / "cache"
ARTWORK_CACHE = CACHE_DIR / "artwork"
RB_SNAPSHOT_DIR = APP_DIR / "rekordbox-snapshot"
SOURCES_DIR = APP_DIR / "sources"           # copias de las librerías de otros programas (una carpeta por programa)
EXPORT_DIR = Path(os.environ.get("BATEA_EXPORT_DIR", HOME / "Music" / "Batea"))

# rekordbox 6/7 (solo lectura: siempre se trabaja sobre una copia)
RB_DIR = Path(os.environ.get("BATEA_RB_DIR", HOME / "Library" / "Pioneer" / "rekordbox"))
RB_SHARE = RB_DIR / "share"

AUDIO_EXTS = {".mp3", ".wav", ".aif", ".aiff", ".flac", ".m4a", ".mp4", ".ogg"}

if getattr(sys, "frozen", False):          # app empaquetada: la interfaz viaja dentro del .app
    FRONTEND_DIST = Path(getattr(sys, "_MEIPASS", ".")) / "frontend_dist"
else:
    FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


def ensure_dirs() -> None:
    for d in (APP_DIR, CACHE_DIR, ARTWORK_CACHE, RB_SNAPSHOT_DIR, SOURCES_DIR, EXPORT_DIR):
        d.mkdir(parents=True, exist_ok=True)
