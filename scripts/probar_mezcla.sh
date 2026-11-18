#!/bin/zsh
# Abre una Batea de PRUEBA con la versión nueva de "Probar mezcla" y una COPIA de tu biblioteca.
#
#   scripts/probar_mezcla.sh            usa la copia que ya hay (o la crea la primera vez)
#   scripts/probar_mezcla.sh --reset    vuelve a copiar tu biblioteca de cero
#
# - Tu Batea real y sus datos no se tocan: la copia vive en ~/Batea-prueba-mezcla (borrala cuando termines).
# - Lo que marques en la prueba (mezclan bien, notas…) queda solo en la copia.
# - No busca música sola, no pone el ícono en la barra de menú y no sincroniza rekordbox.
# - Para escuchar las mezclas tiene que estar conectado el disco donde está la música.
set -euo pipefail

REPO="${0:A:h:h}"
PY="${BATEA_PY:-$REPO/../batea/backend/.venv/bin/python}"
REAL="$HOME/Library/Application Support/Batea"
DEMO="$HOME/Batea-prueba-mezcla"

[[ "${1:-}" == "--reset" ]] && rm -rf "$DEMO"
[[ -x "$PY" ]] || { echo "No encontré el Python de Batea en $PY"; exit 1; }
[[ -f "$REAL/batea.db" ]] || { echo "No encontré tu biblioteca en $REAL"; exit 1; }

if [[ ! -f "$DEMO/app/batea.db" ]]; then
  echo "→ Copiando tu biblioteca a $DEMO (la original no se toca)"
  mkdir -p "$DEMO"/{app,exportados,traktor-vacio,serato-vacio}
  # copia consistente aunque tu Batea esté abierta
  "$PY" -c "import sqlite3,sys; s=sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" \
    "$REAL/batea.db" "$DEMO/app/batea.db"
  [[ -d "$REAL/cache" ]] && cp -cR "$REAL/cache" "$DEMO/app/cache"
fi

if ! ls /Volumes | grep -qv "Macintosh HD"; then
  echo "⚠︎  No veo ningún disco externo conectado: vas a ver los temas pero no se van a poder escuchar."
fi

echo "→ Compilando la interfaz nueva"
(cd "$REPO/frontend" && npm run build >/dev/null)

export BATEA_HOME="$DEMO/app"
export BATEA_EXPORT_DIR="$DEMO/exportados"
export BATEA_TRAKTOR_DIR="$DEMO/traktor-vacio"
export BATEA_SERATO_DIR="$DEMO/serato-vacio"
export BATEA_AUTODISCOVER=0
export BATEA_NO_MENUBAR=1

echo "→ Abriendo Batea de prueba. Cerrá la ventana para terminar."
cd "$REPO/backend"
exec "$PY" -m batea.main
