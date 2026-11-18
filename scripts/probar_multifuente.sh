#!/bin/zsh
# Abre una Batea de PRUEBA para probar el flujo multifuente de punta a punta.
#
#   scripts/probar_multifuente.sh <carpeta-con-música> [--con-rekordbox] [--reset]
#
# - Arma una librería de Traktor y una de Serato de prueba con temas reales de la
#   carpeta (solo los lee) y abre Batea apuntando a ellas.
# - Tus datos de Batea, tu Batea abierta y las librerías reales no se tocan:
#   todo vive en ~/Batea-prueba-multifuente (borralo cuando termines).
# - Sin --con-rekordbox, rekordbox aparece como "no encontrado".
#   Con --con-rekordbox lee una COPIA de tu rekordbox real (pesado: varios minutos).
# - --reset borra la prueba anterior y arranca desde la bienvenida.
set -euo pipefail

REPO="${0:A:h:h}"
PY="${BATEA_PY:-$REPO/../batea/backend/.venv/bin/python}"
DEMO="$HOME/Batea-prueba-multifuente"

MUSIC="" ; WITH_RB=0 ; RESET=0
for a in "$@"; do
  case "$a" in
    --con-rekordbox) WITH_RB=1 ;;
    --reset) RESET=1 ;;
    *) MUSIC="$a" ;;
  esac
done
[[ -n "$MUSIC" && -d "$MUSIC" ]] || { echo "Uso: $0 <carpeta-con-música> [--con-rekordbox] [--reset]"; exit 1; }
[[ -x "$PY" ]] || { echo "No encontré el Python de Batea en $PY (definí BATEA_PY)"; exit 1; }

if (( RESET )); then rm -rf "$DEMO"; fi
mkdir -p "$DEMO"/{app,rb-vacio,exportados}

if [[ ! -d "$DEMO/libs/traktor" ]]; then
  echo "→ Armando librerías de prueba de Traktor y Serato con temas de: $MUSIC"
  "$PY" "$REPO/scripts/demo_fuentes.py" --music "$MUSIC" --out "$DEMO/libs" -n 30
fi

echo "→ Compilando la interfaz de la rama"
(cd "$REPO/frontend" && npm run build >/dev/null)

export BATEA_HOME="$DEMO/app"
export BATEA_EXPORT_DIR="$DEMO/exportados"
export BATEA_TRAKTOR_DIR="$DEMO/libs/traktor"
export BATEA_SERATO_DIR="$DEMO/libs/serato-home"
export BATEA_AUTODISCOVER=0
export BATEA_NO_MENUBAR=1
(( WITH_RB )) || export BATEA_RB_DIR="$DEMO/rb-vacio"

echo "→ Abriendo Batea de prueba (datos en $DEMO)"
cd "$REPO/backend"
exec "$PY" -m batea.main
