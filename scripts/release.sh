#!/bin/zsh
# Flujo de versiones de Batea: los dos instaladores (Apple Silicon e Intel) salen SIEMPRE del mismo código.
# Guía completa: RELEASING.md
#
#   ./scripts/release.sh status          ¿los instaladores corresponden al código actual? (no arma nada)
#   ./scripts/release.sh build           arma Apple Silicon + Intel desde el mismo código y archiva versiones viejas
#   ./scripts/release.sh bump patch      sube la versión (patch | minor | major | 0.3.0) y abre una entrada en CHANGELOG.md
#   ./scripts/release.sh require         desde ya, las versiones anteriores a esta NO abren (sube MIN_VERSION a VERSION)
#   ./scripts/release.sh publish         sube los dos .dmg a GitHub Releases y deja update.json listo (pregunta antes)
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
  require)
    cp "$ROOT/VERSION" "$ROOT/MIN_VERSION"
    echo "MIN_VERSION = $(cat "$ROOT/VERSION"): al publicar, las versiones anteriores dejan de abrir hasta actualizar."
    python3 "$ROOT/scripts/update_manifest.py" ;;
  publish)
    V="$(cat "$ROOT/VERSION")"
    fp status || { echo "Los instaladores no corresponden al código actual: primero ./scripts/release.sh build"; exit 1; }
    for a in arm64 x86_64; do [[ -f "$ROOT/release/Batea-$V-$a.dmg" ]] || { echo "Falta release/Batea-$V-$a.dmg"; exit 1; }; done
    python3 "$ROOT/scripts/update_manifest.py"
    echo; cat "$ROOT/update.json"; echo
    echo "Esto crea el release v$V en GitHub con los dos .dmg (público) y después hay que subir update.json."
    read "ok?¿Publicar? (s/N) "; [[ "$ok" == [sS] ]] || { echo "Cancelado."; exit 1; }
    gh release create "v$V" "$ROOT/release/Batea-$V-arm64.dmg" "$ROOT/release/Batea-$V-x86_64.dmg" \
      --repo gianlucafarias/batea --title "Batea $V" --notes-file <(python3 -c "import json;print(json.load(open('$ROOT/update.json'))['notes'])")
    echo
    echo "Release creado. Último paso: subir update.json (es lo que las apps instaladas leen):"
    echo "  git add update.json MIN_VERSION VERSION CHANGELOG.md && git commit -m 'Batea $V' && git push" ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
