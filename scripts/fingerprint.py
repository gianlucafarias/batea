#!/usr/bin/env python3
"""Huella del código de Batea y control de que los instaladores no queden viejos.

Además del historial de git, la "versión exacta" de un instalador se identifica con una huella
(sha256) de todo lo que termina dentro de la app: código de Python, interfaz, dependencias, íconos y el script
de empaquetado. Cada instalador guarda la huella con la que se armó; si el código cambia después, la huella
actual deja de coincidir y `release.sh status` avisa cuáles instaladores quedaron viejos y por qué archivos.

    python3 scripts/fingerprint.py show                 # huella actual
    python3 scripts/fingerprint.py status               # ¿los instaladores de VERSION están al día?
    python3 scripts/fingerprint.py parity               # ¿pyproject.toml y requirements-intel.in coinciden?
    python3 scripts/fingerprint.py record …             # (lo usa make_dist.sh) anota cómo se armó un instalador
    python3 scripts/fingerprint.py archive              # mueve a release/archive los instaladores de otras versiones
    python3 scripts/fingerprint.py bump patch|minor|major|X.Y.Z

Solo usa la biblioteca estándar (anda con el python3 del sistema).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = Path(os.environ.get("RELEASE_DIR", ROOT / "release"))
ARCHS = ("arm64", "x86_64")

# Todo lo que cambia lo que hace la app empaquetada. (Documentos, README y release.sh no cuentan.)
INCLUDE = [
    "VERSION", "assets", "backend/batea", "backend/run_batea.py", "backend/pyproject.toml", "backend/uv.lock",
    "backend/requirements-intel.in", "frontend/src", "frontend/public", "frontend/index.html",
    "frontend/package.json", "frontend/package-lock.json", "frontend/vite.config.ts", "scripts/make_dist.sh",
    "scripts/fingerprint.py",
]
SKIP_PARTS = {"__pycache__", ".DS_Store"}


def version() -> str:
    return (ROOT / "VERSION").read_text().strip()


def file_hashes() -> dict[str, str]:
    out: dict[str, str] = {}
    for item in INCLUDE:
        p = ROOT / item
        paths = [p] if p.is_file() else sorted(q for q in p.rglob("*") if q.is_file()) if p.is_dir() else []
        for q in paths:
            if SKIP_PARTS & set(q.parts) or q.suffix == ".pyc":
                continue
            out[str(q.relative_to(ROOT))] = hashlib.sha256(q.read_bytes()).hexdigest()
    return out


def digest(files: dict[str, str]) -> str:
    h = hashlib.sha256()
    for k in sorted(files):
        h.update(k.encode() + b"\0" + files[k].encode() + b"\n")
    return h.hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def record_path(ver: str, arch: str) -> Path:
    return RELEASE / f"Batea-{ver}-{arch}.build.json"


# ------------------------------------------------------------------ comandos
def cmd_show(_: argparse.Namespace) -> int:
    f = file_hashes()
    print(f"versión {version()} · huella {digest(f)[:16]} · {len(f)} archivos")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    ver, files = version(), file_hashes()
    cur = digest(files)
    print(f"Código actual: versión {ver} · huella {cur[:16]}")
    bad = 0
    for arch in ARCHS:
        rec_file = record_path(ver, arch)
        dmg = RELEASE / f"Batea-{ver}-{arch}.dmg"
        if not rec_file.exists() or not dmg.exists():
            print(f"  ✗ {arch:7s} FALTA: no hay instalador {ver} para {arch}")
            bad += 1
            continue
        rec = json.loads(rec_file.read_text())
        if sha256_file(dmg) != rec.get("sha256"):
            print(f"  ✗ {arch:7s} CORRUPTO: el .dmg no coincide con lo que se armó (¿se modificó o se cortó la copia?)")
            bad += 1
            continue
        if rec["fingerprint"] != cur:
            old = rec.get("files", {})
            changed = sorted(k for k in set(old) | set(files) if old.get(k) != files.get(k))
            print(f"  ✗ {arch:7s} DESACTUALIZADO: armado el {rec['built_at']}; cambiaron {len(changed)} archivos")
            for k in changed[:12]:
                print(f"       · {k}" + ("" if k in files else " (borrado)") + (" (nuevo)" if k not in old else ""))
            if len(changed) > 12:
                print(f"       · … y {len(changed) - 12} más")
            bad += 1
            continue
        print(f"  ✓ {arch:7s} al día · {dmg.name} · {dmg.stat().st_size / 1e6:.0f} MB · macOS {rec['min_macos']}+ · tonalidad: {rec['key_detector']}")
    if bad:
        print("\nHay instaladores que no reflejan el código actual. Corré:  ./scripts/release.sh build")
        return 1
    print("\nLos dos instaladores corresponden exactamente al código actual.")
    return 0


def _dep_names(lines: list[str]) -> set[str]:
    names = set()
    for ln in lines:
        ln = ln.split("#")[0].strip().strip(",").strip('"').strip("'")
        m = re.match(r"([A-Za-z0-9_.\-]+)", ln)
        if m:
            names.add(m.group(1).lower().replace("_", "-"))
    return names


def cmd_parity(_: argparse.Namespace) -> int:
    py = (ROOT / "backend" / "pyproject.toml").read_text()
    block = re.search(r"dependencies\s*=\s*\[(.*?)\]", py, re.S)
    main = _dep_names(block.group(1).splitlines()) if block else set()
    intel = _dep_names((ROOT / "backend" / "requirements-intel.in").read_text().splitlines())
    # Essentia no va en Intel a propósito (ver RELEASING.md); numpy se repite con otro límite.
    missing_intel = sorted(main - intel - {"essentia"})
    extra_intel = sorted(intel - main)
    if missing_intel or extra_intel:
        if missing_intel:
            print("✗ Está en pyproject.toml pero falta en requirements-intel.in (la versión Intel no lo tendría):", ", ".join(missing_intel))
        if extra_intel:
            print("✗ Está en requirements-intel.in pero no en pyproject.toml:", ", ".join(extra_intel))
        return 1
    print(f"✓ Dependencias en paridad ({len(main)} en Apple Silicon, {len(intel)} en Intel; Essentia solo en Apple Silicon)")
    return 0


def cmd_record(a: argparse.Namespace) -> int:
    files = file_hashes()
    cur = digest(files)
    if cur != a.fingerprint:
        print("✗ El código cambió mientras se armaba el instalador: no registro este build. Volvé a correr el empaquetado.", file=sys.stderr)
        return 1
    dmg = Path(a.dmg)
    rec = {
        "version": version(), "arch": a.arch, "fingerprint": cur, "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "dmg": dmg.name, "sha256": sha256_file(dmg), "size": dmg.stat().st_size,
        "min_macos": a.min_macos, "key_detector": a.detector, "files": files,
    }
    record_path(version(), a.arch).write_text(json.dumps(rec, indent=1, sort_keys=True) + "\n")
    return 0


def cmd_archive(_: argparse.Namespace) -> int:
    ver, moved = version(), 0
    (RELEASE / "archive").mkdir(parents=True, exist_ok=True)
    for p in sorted(RELEASE.glob("Batea-*")):
        m = re.match(r"Batea-(\d+\.\d+\.\d+)-", p.name)
        if m and m.group(1) != ver:
            shutil.move(str(p), str(RELEASE / "archive" / p.name))
            moved += 1
    if moved:
        print(f"   {moved} archivos de versiones anteriores movidos a {RELEASE / 'archive'}")
    return 0


def cmd_bump(a: argparse.Namespace) -> int:
    cur = version()
    x, y, z = (int(n) for n in cur.split("."))
    if a.to in ("patch", "minor", "major"):
        new = {"patch": f"{x}.{y}.{z + 1}", "minor": f"{x}.{y + 1}.0", "major": f"{x + 1}.0.0"}[a.to]
    elif re.fullmatch(r"\d+\.\d+\.\d+", a.to):
        new = a.to
    else:
        print("Usá patch, minor, major o un número como 0.3.0", file=sys.stderr)
        return 2
    (ROOT / "VERSION").write_text(new + "\n")
    log = ROOT / "CHANGELOG.md"
    text = log.read_text() if log.exists() else "# Historial de versiones\n"
    head, _, rest = text.partition("\n## ")
    entry = f"\n## {new} — {time.strftime('%Y-%m-%d')}\n\n- (completar: qué cambió para quien usa Batea)\n"
    log.write_text(head.rstrip("\n") + "\n" + entry + ("\n## " + rest if rest else ""))
    print(f"Versión {cur} → {new}. Completá la entrada nueva de CHANGELOG.md y después:  ./scripts/release.sh build")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("show", cmd_show), ("status", cmd_status), ("parity", cmd_parity), ("archive", cmd_archive)):
        sub.add_parser(name).set_defaults(fn=fn)
    r = sub.add_parser("record")
    for opt in ("arch", "dmg", "min-macos", "detector", "fingerprint"):
        r.add_argument(f"--{opt}", required=True)
    r.set_defaults(fn=cmd_record)
    b = sub.add_parser("bump")
    b.add_argument("to")
    b.set_defaults(fn=cmd_bump)
    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
