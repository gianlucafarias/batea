#!/bin/zsh
# Empaqueta Batea como una app autónoma (Batea.app dentro de un .dmg) para instalarla en otras Macs.
# No toca tu instalación de desarrollo: usa carpetas propias en build/ y deja el resultado en release/.
#
#   ./scripts/make_dist.sh            # para esta Mac (arm64 = Apple Silicon)
#   ./scripts/make_dist.sh arm64      # Apple Silicon (M1 o posterior)
#   ./scripts/make_dist.sh x86_64     # Intel (se arma y prueba con Rosetta)
#
# Opcional, para que otras Macs la abran sin avisos de seguridad (requiere cuenta de desarrollador de Apple):
#   SIGN_ID="Developer ID Application: Tu Nombre (TEAMID)" NOTARY_PROFILE="nombre-del-perfil-notarytool" ./scripts/make_dist.sh
set -euo pipefail

ARCH="${1:-$(uname -m)}"
[[ "$ARCH" == "arm64" || "$ARCH" == "x86_64" ]] || { echo "Arquitectura no válida: $ARCH (arm64 o x86_64)"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(cat "$ROOT/VERSION")"     # única fuente de la versión (se cambia con ./scripts/release.sh bump)
BUILD="$ROOT/build/$ARCH"
OUT="${RELEASE_DIR:-$ROOT/release}"
export RELEASE_DIR="$OUT"
FP="$(python3 "$ROOT/scripts/fingerprint.py" show | sed -E 's/.*huella ([0-9a-f]+).*/\1/')"   # huella corta (solo para mostrar)
FPFULL="$(python3 - <<PY
import sys; sys.path.insert(0, "$ROOT/scripts")
import fingerprint as f; print(f.digest(f.file_hashes()))
PY
)"
VENV="$BUILD/venv"
UV="$(command -v uv || echo /opt/homebrew/bin/uv)"
RUN=()
[[ "$ARCH" == "x86_64" && "$(uname -m)" == "arm64" ]] && RUN=(arch -x86_64)
APP="$BUILD/dist/Batea.app"

mkdir -p "$BUILD" "$OUT"

echo "Batea $VERSION · $ARCH · huella $FP"
python3 "$ROOT/scripts/fingerprint.py" parity || exit 1
echo "→ [1/7] Entorno de Python para $ARCH (aparte de tu .venv)"
if [[ "$ARCH" == "arm64" ]]; then
  UV_PROJECT_ENVIRONMENT="$VENV" "$UV" sync --frozen --no-dev --project "$ROOT/backend" -q
else
  [[ -x "$VENV/bin/python" ]] || "$UV" venv --python cpython-3.12-macos-x86_64 "$VENV" -q
  "$UV" pip compile "$ROOT/backend/requirements-intel.in" --python-platform x86_64-apple-darwin --python-version 3.12 \
    --only-binary :all: --no-binary pywebview --no-binary proxy-tools --no-binary pyrekordbox -q -o "$BUILD/requirements.txt"
  "$UV" pip install --python "$VENV/bin/python" -q -r "$BUILD/requirements.txt"
fi
"$UV" pip install --python "$VENV/bin/python" -q pyinstaller typer
PY=("${RUN[@]}" "$VENV/bin/python")
"${PY[@]}" -c "import platform,sys; print('   Python', sys.version.split()[0], platform.machine())"

echo "→ [2/7] Interfaz (compilada aparte: no cambia frontend/dist)"
(cd "$ROOT/frontend" && { [[ -d node_modules ]] || npm install --silent; } && npx tsc -b && npx vite build --outDir "$BUILD/ui" --emptyOutDir --logLevel warn)

echo "→ [3/7] Ícono"
ICONSET="$BUILD/Batea.iconset"; rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ROOT/assets/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/Batea.icns"

echo "→ [4/7] Empaquetando con PyInstaller (tarda unos minutos)"
printf '{"version": "%s", "arch": "%s", "fingerprint": "%s", "built_at": "%s"}\n' "$VERSION" "$ARCH" "$FPFULL" "$(date '+%Y-%m-%d %H:%M:%S')" > "$BUILD/build_info.json"
ENT="$BUILD/entitlements.plist"
cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST
ESSENTIA_ARGS=()
"${PY[@]}" -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('essentia') else 1)" && ESSENTIA_ARGS=(--collect-all essentia) \
  || echo "   (sin Essentia en este entorno: la tonalidad usa librosa)"
SIGN_ARGS=()
[[ -n "${SIGN_ID:-}" ]] && SIGN_ARGS=(--codesign-identity "$SIGN_ID" --osx-entitlements-file "$ENT")
rm -rf "$BUILD/dist" "$BUILD/work"
"${PY[@]}" -m PyInstaller --noconfirm --clean --windowed --name Batea \
  --icon "$BUILD/Batea.icns" --osx-bundle-identifier app.batea.mac \
  --distpath "$BUILD/dist" --workpath "$BUILD/work" --specpath "$BUILD" \
  --paths "$ROOT/backend" --add-data "$BUILD/ui:frontend_dist" --add-data "$BUILD/build_info.json:." \
  --collect-submodules batea --collect-submodules uvicorn \
  "${ESSENTIA_ARGS[@]}" --collect-all librosa --collect-all numba --collect-all sqlcipher3 \
  --collect-all pyrekordbox --collect-all webview --collect-all soundfile --collect-all mutagen \
  --copy-metadata mcp --copy-metadata fastapi --copy-metadata uvicorn --copy-metadata pydantic \
  --hidden-import batea.menubar --hidden-import batea.links --hidden-import batea.mcp_server \
  "${SIGN_ARGS[@]}" "$ROOT/backend/run_batea.py" 2>&1 | grep -vE "^[0-9]+ (INFO|WARNING)" | tail -25 || true
[[ -d "$APP" ]] || { echo "PyInstaller no generó la app"; exit 1; }

echo "→ [5/7] Ajustes de la app (versión, permisos, links batea://)"
PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
# versión mínima de macOS: la más alta que pida cualquiera de los binarios incluidos
MINOS="$(find "$APP" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -exec otool -l {} + 2>/dev/null \
  | awk '/LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; b=0}' | sort -t. -k1,1n -k2,2n | tail -1)"
[[ -n "$MINOS" ]] || MINOS="12.0"
echo "   macOS mínimo según los binarios incluidos: $MINOS"
setkey() { $PB -c "Delete :$1" "$PLIST" 2>/dev/null || true; $PB -c "Add :$1 $2 $3" "$PLIST"; }
setkey CFBundleDisplayName string "Batea"
setkey CFBundleShortVersionString string "$VERSION"
setkey CFBundleVersion string "$VERSION"
setkey LSMinimumSystemVersion string "$MINOS"
setkey NSHighResolutionCapable bool true
setkey LSApplicationCategoryType string "public.app-category.music"
setkey NSDesktopFolderUsageDescription string "Batea busca música en tu Escritorio para sumarla a tu librería. Solo lee, nunca mueve ni borra archivos."
setkey NSDocumentsFolderUsageDescription string "Batea busca música en Documentos para sumarla a tu librería. Solo lee, nunca mueve ni borra archivos."
setkey NSDownloadsFolderUsageDescription string "Batea busca música en Descargas para sumarla a tu librería. Solo lee, nunca mueve ni borra archivos."
setkey NSRemovableVolumesUsageDescription string "Batea lee la música de tus discos externos. Solo lee, nunca mueve ni borra archivos."
setkey NSAppTransportSecurity dict ""
$PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST"

# Links batea:// (desde Claude, Codex, T3…): un applet sin ícono en el Dock que le pasa el link a Batea.
# Calcula dónde está Batea a partir de su propia ubicación, así sirve esté donde esté instalada.
LINKS="$APP/Contents/Helpers/Batea Links.app"
mkdir -p "$APP/Contents/Helpers"
OSA="$BUILD/links.applescript"
cat > "$OSA" <<'APPLESCRIPT'
on open location theURL
	set here to POSIX path of (path to me)
	do shell script quoted form of (here & "../../MacOS/Batea") & " --run-module batea.links " & quoted form of theURL & " >/dev/null 2>&1 &"
end open location
APPLESCRIPT
rm -rf "$LINKS"
osacompile -o "$LINKS" "$OSA"
LP="$LINKS/Contents/Info.plist"
$PB -c "Delete :CFBundleIdentifier" "$LP" 2>/dev/null || true
$PB -c "Add :CFBundleIdentifier string app.batea.links" "$LP"
$PB -c "Delete :CFBundleName" "$LP" 2>/dev/null || true
$PB -c "Add :CFBundleName string Batea Links" "$LP"
$PB -c "Add :LSUIElement bool true" "$LP"
$PB -c "Add :CFBundleURLTypes array" \
    -c "Add :CFBundleURLTypes:0 dict" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLName string app.batea.link" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string batea" "$LP"
cp "$BUILD/Batea.icns" "$LINKS/Contents/Resources/applet.icns"

echo "→ [6/7] Firmando"
if [[ -n "${SIGN_ID:-}" ]]; then
  codesign --force --options runtime --timestamp -s "$SIGN_ID" "$LINKS"
  codesign --force --options runtime --timestamp --entitlements "$ENT" -s "$SIGN_ID" "$APP"
else
  codesign --force -s - "$LINKS"
  codesign --force --deep -s - "$APP"
  echo "   (firma local: en otras Macs la primera vez hay que abrirla con click derecho → Abrir)"
fi
codesign --verify --deep --strict "$APP" && echo "   firma íntegra"

echo "→ [7/7] Prueba sin ventanas de la app empaquetada"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/rb"
ST=0
BATEA_NO_MENUBAR=1 BATEA_HOME="$T/home" BATEA_RB_DIR="$T/rb" "${RUN[@]}" nice -n 10 "$APP/Contents/MacOS/Batea" --selftest >"$BUILD/selftest.log" 2>&1 || ST=$?
grep -vE "Deprecat|on_event|lifespan|FastAPI docs|^\s*$|Read more|return self.router" "$BUILD/selftest.log" || true
rm -rf "$T"
[[ $ST -eq 0 ]] || { echo "✗ La prueba falló (código $ST): no genero el instalador. Detalle en $BUILD/selftest.log"; exit 1; }

# Si el código cambió mientras se empaquetaba, este instalador no corresponde a ninguna versión: no se genera.
[[ "$(python3 - <<PY
import sys; sys.path.insert(0, "$ROOT/scripts")
import fingerprint as f; print(f.digest(f.file_hashes()))
PY
)" == "$FPFULL" ]] || { echo "✗ El código cambió durante el empaquetado: no genero el instalador. Volvé a correr el script."; exit 1; }

STAGE="$BUILD/dmg"; rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Batea.app"
ln -s /Applications "$STAGE/Aplicaciones"
cat > "$STAGE/LEEME.txt" <<'TXT'
BATEA — cómo instalarla

1. Arrastrá Batea a la carpeta Aplicaciones (de este mismo disco).
2. Abrila desde Aplicaciones. Si macOS dice que no puede verificarla:
   click derecho sobre Batea → Abrir → Abrir.
   (Pasa solo la primera vez; es porque la app no está firmada con una cuenta de desarrollador de Apple.)
   Si aun así no abre: Terminal →  xattr -cr /Applications/Batea.app
3. Necesita rekordbox instalado en esta Mac. Batea solo lee su base de datos, nunca la modifica.
4. La primera vez macOS pide permiso para leer Escritorio, Documentos, Descargas y discos externos:
   Batea los usa para encontrar tu música. Solo lee.

Para ACTUALIZAR: cerrá Batea, arrastrá la Batea nueva a Aplicaciones y elegí "Reemplazar".
Tus datos (etiquetas, relaciones, cajas) no se tocan: quedan en ~/Library/Application Support/Batea,
no dentro de la app. No instales una versión más vieja encima de una más nueva.
Registro de errores: ~/Library/Logs/Batea.log
TXT
echo "Batea $VERSION ($ARCH)" > "$STAGE/VERSION.txt"
DMG="$OUT/Batea-$VERSION-$ARCH.dmg"
rm -f "$DMG"
hdiutil create -volname "Batea" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

if [[ -n "${SIGN_ID:-}" && -n "${NOTARY_PROFILE:-}" ]]; then
  echo "→ Notarizando (puede tardar unos minutos)"
  codesign --force --timestamp -s "$SIGN_ID" "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

KEYDET="librosa"; [[ ${#ESSENTIA_ARGS[@]} -gt 0 ]] && KEYDET="essentia"
python3 "$ROOT/scripts/fingerprint.py" record --arch "$ARCH" --dmg "$DMG" --min-macos "$MINOS" --detector "$KEYDET" --fingerprint "$FPFULL"
echo "✓ Listo: $DMG ($(du -h "$DMG" | cut -f1))"
