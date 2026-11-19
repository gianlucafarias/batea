#!/bin/zsh
# Compila Batea y crea ~/Applications/Batea.app (un lanzador que abre la ventana nativa).
# Uso: ./scripts/make_app.sh
#
# Para PROBAR cambios sin armar un instalador:  APP_NAME="Batea Pruebas" ./scripts/make_app.sh
# Crea un lanzador aparte (no pisa la Batea instalada) que corre el código de esta carpeta. Se crea una sola vez:
# después, cada cambio en el código llega con `npm run build` (interfaz) o cerrando y abriendo la app (motor).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(cat "$ROOT/VERSION")"
APP_NAME="${APP_NAME:-Batea}"
APP="$HOME/Applications/$APP_NAME.app"
DEV=0; [[ "$APP_NAME" != "Batea" ]] && DEV=1
UV="$(command -v uv || echo /opt/homebrew/bin/uv)"

echo "→ Dependencias de Python"
(cd "$ROOT/backend" && "$UV" sync -q)

echo "→ Compilando la interfaz"
(cd "$ROOT/frontend" && npm install --silent && npm run build --silent)

echo "→ Creando $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Ícono
ICONSET="$(mktemp -d)/Batea.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ROOT/assets/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Batea.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>app.batea.$([[ $DEV == 1 ]] && echo dev || echo local)</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>Batea</string>
  <key>CFBundleIconFile</key><string>Batea</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Batea" <<LAUNCH
#!/bin/zsh
mkdir -p "\$HOME/Library/Logs"
cd "$ROOT/backend"
exec "$ROOT/backend/.venv/bin/python" -m batea.main >> "\$HOME/Library/Logs/Batea.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/Batea"

# Links batea:// (desde Claude, Codex, T3…): un applet chiquito, sin ícono en el Dock, recibe el link
# de macOS y se lo pasa a `python -m batea.links`, que lo manda a la Batea abierta (o la abre).
if [[ $DEV == 1 ]]; then
  echo "✓ Listo: abrí «$APP_NAME» desde ~/Applications, Launchpad o Spotlight (cerrá antes la Batea instalada)."
  echo "  Corre el código de $ROOT y usa tu misma librería. Registro: ~/Library/Logs/Batea.log"
  exit 0
fi
echo "→ Links batea://"
LINKS="$APP/Contents/Helpers/Batea Links.app"
mkdir -p "$APP/Contents/Helpers"
OSA="$(mktemp -d)/links.applescript"
cat > "$OSA" <<APPLESCRIPT
on open location theURL
	do shell script "cd " & quoted form of "$ROOT/backend" & " && " & quoted form of "$ROOT/backend/.venv/bin/python" & " -m batea.links " & quoted form of theURL & " >/dev/null 2>&1 &"
end open location
APPLESCRIPT
osacompile -o "$LINKS" "$OSA"
PLIST="$LINKS/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Delete :CFBundleIdentifier" "$PLIST" 2>/dev/null || true
$PB -c "Add :CFBundleIdentifier string app.batea.links" "$PLIST"
$PB -c "Delete :CFBundleName" "$PLIST" 2>/dev/null || true
$PB -c "Add :CFBundleName string Batea Links" "$PLIST"
$PB -c "Add :LSUIElement bool true" "$PLIST"
$PB -c "Add :CFBundleURLTypes array" \
    -c "Add :CFBundleURLTypes:0 dict" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLName string app.batea.link" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string batea" "$PLIST"
cp "$APP/Contents/Resources/Batea.icns" "$LINKS/Contents/Resources/applet.icns"
codesign --force --deep -s - "$LINKS" 2>/dev/null   # cambiamos el Info.plist: volver a firmar (Apple Silicon lo exige)
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -f "$LINKS"

touch "$APP"
echo "✓ Listo: abrí Batea desde ~/Applications, Launchpad o Spotlight."
echo "  Registro de errores: ~/Library/Logs/Batea.log"
echo "  Para usar tu librería desde Claude, Codex o Cursor: en Batea, «Conectar con agentes de IA»."
