#!/bin/zsh
# Abre una Batea de PRUEBA que cree que hay una versión nueva, para ver (y tocar) el cuadro de actualización.
#
#   scripts/probar_actualizacion.sh            la primera vez copia tu biblioteca; después reutiliza la copia
#   scripts/probar_actualizacion.sh --reset    vuelve a copiarla de cero
#
# - Es una DEMOSTRACIÓN: el avance (descarga, comprobación, instalación) es simulado y «Reiniciar ahora» no cierra nada.
#   Sirve para ver el aspecto y los botones. La actualización de verdad se prueba con una versión publicada más nueva.
# - Tu Batea real y sus datos no se tocan: la copia vive en ~/Batea-prueba-actualizacion (borrala cuando termines).
# - Usa un archivo de actualización falso que anuncia la versión 9.9.9.
set -euo pipefail

REPO="${0:A:h:h}"
PY="${BATEA_PY:-$REPO/backend/.venv/bin/python}"
REAL="$HOME/Library/Application Support/Batea"
DEMO="$HOME/Batea-prueba-actualizacion"

[[ "${1:-}" == "--reset" ]] && rm -rf "$DEMO"
[[ -x "$PY" ]] || { echo "No encontré el Python de Batea en $PY"; exit 1; }
[[ -f "$REAL/batea.db" ]] || { echo "No encontré tu biblioteca en $REAL"; exit 1; }

mkdir -p "$DEMO"/{app,exportados,traktor-vacio,serato-vacio}
if [[ ! -f "$DEMO/app/batea.db" ]]; then
  echo "→ Copiando tu biblioteca a $DEMO (la original no se toca)"
  "$PY" -c "import sqlite3,sys; s=sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" \
    "$REAL/batea.db" "$DEMO/app/batea.db"
fi

cat > "$DEMO/update.json" <<'JSON'
{"version": "9.9.9", "min_version": "0.3.1",
 "notes": "· Actualización dentro del programa\n· Cues y grilla más precisas\n· Arreglos varios",
 "page": "https://github.com/gianlucafarias/batea/releases/latest", "downloads": {}}
JSON

echo "→ Compilando la interfaz"
(cd "$REPO/frontend" && npm run build >/dev/null)

export BATEA_HOME="$DEMO/app"
export BATEA_EXPORT_DIR="$DEMO/exportados"
export BATEA_TRAKTOR_DIR="$DEMO/traktor-vacio"
export BATEA_SERATO_DIR="$DEMO/serato-vacio"
export BATEA_AUTODISCOVER=0
export BATEA_NO_MENUBAR=1
export BATEA_UPDATE_URL="file://$DEMO/update.json"
export BATEA_UPDATE_DEMO=1

echo "→ Abriendo Batea de prueba. El cuadro aparece arriba a la derecha unos segundos después. Cerrá la ventana para terminar."
cd "$REPO/backend"
exec "$PY" -m batea.main
