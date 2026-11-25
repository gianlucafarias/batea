"""Comprueba que una Batea.app empaquetada trae TODOS los módulos de backend/batea.

PyInstaller solo incluye lo que encuentra siguiendo los imports. Lo que se carga con importlib (los lectores de cada
programa, "sonando ahora" de Traktor) se pierde sin aviso: de 0.3.0 a 0.5.0 la app salió sin el lector de rekordbox.
make_dist.sh corre esto después de PyInstaller y no genera el instalador si falta algo.

    python scripts/check_bundle.py build/arm64/dist/Batea.app        # con el Python del entorno de build (trae PyInstaller)
    python scripts/check_bundle.py /Volumes/Batea/Batea.app          # también sirve para revisar un .dmg ya publicado
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "backend" / "batea"


def source_modules() -> set[str]:
    mods = set()
    for f in SRC.rglob("*.py"):
        rel = f.relative_to(SRC.parent).with_suffix("")
        parts = rel.parts[:-1] if rel.name == "__init__" else rel.parts
        if "__pycache__" not in parts:
            mods.add(".".join(parts))
    return mods


def bundled_modules(app: Path) -> set[str]:
    from PyInstaller.archive.readers import CArchiveReader

    exe = app / "Contents" / "MacOS" / "Batea"
    arch = CArchiveReader(str(exe))
    pyz = [n for n in arch.toc if n.endswith(".pyz")]
    if not pyz:
        raise SystemExit(f"✗ {exe} no tiene archivo PYZ: ¿es una app de PyInstaller?")
    out: set[str] = set()
    for name in pyz:
        out |= {m for m in arch.open_embedded_archive(name).toc if m == "batea" or m.startswith("batea.")}
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    app = Path(sys.argv[1])
    want, have = source_modules(), bundled_modules(app)
    missing = sorted(want - have)
    if missing:
        print(f"✗ A la app le faltan {len(missing)} módulo(s) de backend/batea:")
        for m in missing:
            print(f"   - {m}")
        print("  Suelen ser módulos que se cargan con importlib. Revisá --collect-submodules / --hidden-import en make_dist.sh.")
        return 1
    print(f"   los {len(want)} módulos de backend/batea están dentro de la app")
    return 0


if __name__ == "__main__":
    sys.exit(main())
