#!/bin/zsh
# Flujo de versiones de Batea: los dos instaladores (Apple Silicon e Intel) salen SIEMPRE del mismo código.
# Guía completa: RELEASING.md
#
#   ./scripts/release.sh status          ¿los instaladores corresponden al código actual? (no arma nada)
#   ./scripts/release.sh build           arma Apple Silicon + Intel desde el mismo código y archiva versiones viejas
#   ./scripts/release.sh bump patch      sube la versión (patch | minor | major | 0.3.0) y abre una entrada en CHANGELOG.md
#   ./scripts/release.sh check           revisa que pyproject.toml y requirements-intel.in tengan las mismas dependencias
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fp() { python3 "$ROOT/scripts/fingerprint.py" "$@"; }

case "${1:-status}" in
  status)
    fp status ;;
  check)
    fp parity ;;
  bump)
    [[ -n "${2:-}" ]] || { echo "Uso: ./scripts/release.sh bump patch|minor|major|X.Y.Z"; exit 2; }
    fp bump "$2" ;;
  build)
    # Nunca armar con la app de desarrollo en uso por make_app.sh: no la toca, pero conviene avisar si hay un empaquetado en curso.
    pgrep -f "scripts/make_dist.sh" >/dev/null && { echo "Ya hay un empaquetado en curso."; exit 1; } || true
    fp parity
    echo "Versión $(cat "$ROOT/VERSION") — se arman los dos instaladores desde el mismo código."
    echo "(unos 10 minutos en total; el código no se puede modificar mientras tanto)"
    "$ROOT/scripts/make_dist.sh" arm64
    "$ROOT/scripts/make_dist.sh" x86_64
    fp archive
    echo
    fp status ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
