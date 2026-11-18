#!/usr/bin/env python3
"""Genera `update.json` (lo que las apps instaladas leen de GitHub) desde VERSION, MIN_VERSION y CHANGELOG.md.

    python3 scripts/update_manifest.py            # escribe update.json en la raíz del proyecto
    python3 scripts/update_manifest.py --print    # lo muestra sin escribir

Las direcciones de descarga son las de GitHub Releases (tag v<versión>); el instalador tiene que estar subido ahí
antes de publicar el update.json (lo hace `release.sh publish`). Solo biblioteca estándar.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "gianlucafarias/batea"


def _notes(version: str) -> str:
    """Las primeras viñetas de la entrada de esta versión en CHANGELOG.md (para la pantalla de actualizar)."""
    text = (ROOT / "CHANGELOG.md").read_text()
    m = re.search(rf"^## {re.escape(version)}\b.*?\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    if not m:
        return ""
    bullets = [re.sub(r"\*\*|`", "", b).strip() for b in re.findall(r"^- (.+)$", m.group(1), re.M)]
    def short(b: str) -> str:
        b = b.split(". ")[0].rstrip(".")
        return b if len(b) <= 110 else b[:110].rsplit(" ", 1)[0] + "…"

    return "\n".join("· " + short(b) for b in bullets[:4])


def build() -> dict:
    version = (ROOT / "VERSION").read_text().strip()
    min_file = ROOT / "MIN_VERSION"
    minimum = min_file.read_text().strip() if min_file.exists() else version
    base = f"https://github.com/{REPO}/releases/download/v{version}"
    return {
        "version": version,
        "min_version": minimum,
        "notes": _notes(version),
        "page": f"https://github.com/{REPO}/releases/tag/v{version}",
        "downloads": {a: f"{base}/Batea-{version}-{a}.dmg" for a in ("arm64", "x86_64")},
    }


if __name__ == "__main__":
    data = build()
    out = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if "--print" in sys.argv:
        print(out, end="")
    else:
        (ROOT / "update.json").write_text(out)
        print(f"update.json → versión {data['version']}, mínima {data['min_version']}")
