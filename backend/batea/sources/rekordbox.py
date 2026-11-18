"""rekordbox como fuente: la detección y la sincronización de siempre (rbsync), sin cambiar su comportamiento."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .. import config, rbsync
from ..jobs import Job
from .base import LABELS, SourceDump, SourceInfo, SourceLocation


def _version() -> str | None:
    """"rekordbox 7" se deduce del nombre de la carpeta en /Applications (solo listar, no abre nada)."""
    try:
        for p in sorted(Path("/Applications").glob("rekordbox*"), reverse=True):
            m = re.search(r"(\d+(?:\.\d+)*)", p.name)
            if m:
                return m.group(1)
    except OSError:
        pass
    return None


def _running() -> bool:
    try:
        out = subprocess.run(["/usr/bin/pgrep", "-x", "rekordbox"], capture_output=True, text=True, timeout=3).stdout
        return bool(out.strip())
    except (OSError, subprocess.SubprocessError):
        return False


class RekordboxSource:
    kind = "rekordbox"

    def discover(self) -> SourceInfo:
        path = config.RB_DIR / "master.db"
        if not path.exists():
            return SourceInfo(kind=self.kind, label=LABELS[self.kind], found=False)
        try:
            modified = path.stat().st_mtime
        except OSError:
            modified = None
        version = _version()
        return SourceInfo(kind=self.kind, label=LABELS[self.kind], found=True, version=version,
                          locations=[SourceLocation(path=path, version=version, modified=modified)],
                          app_running=_running())

    def snapshot(self, loc: SourceLocation, cache_dir: Path) -> Path:
        return rbsync.snapshot()

    def read(self, snap: Path, loc: SourceLocation) -> SourceDump:
        # rekordbox no pasa por el importador genérico: rbsync lee y escribe en un solo paso
        raise NotImplementedError("rekordbox se sincroniza con sync()")

    def sync(self, job: Job) -> dict:
        return rbsync.sync(job)
