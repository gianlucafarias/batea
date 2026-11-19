# Cómo se publican versiones de Batea

Guía para que **los dos instaladores (Apple Silicon e Intel) salgan siempre del mismo código** y ninguno quede viejo
cuando se agregan funciones. Todo está pensado para que lo pueda hacer una persona sin acordarse de nada: los scripts
avisan cuando algo quedó desactualizado.

## Preparar una nueva versión

```sh
./scripts/release.sh status        # ¿los instaladores corresponden al código actual?  (no arma nada)
./scripts/release.sh bump patch    # nueva versión (patch = arreglos, minor = funciones nuevas, major = cambios grandes)
#   → completar la entrada nueva en CHANGELOG.md
# Hacer commit y push del código, VERSION y CHANGELOG.md a main; publicar update.json después del release.
SIGN_ID="Developer ID Application: Gianluca Palmier (J96S7CUHS9)" \
NOTARY_PROFILE="batea-notary" ./scripts/release.sh build
./scripts/release.sh status        # ambos instaladores deben aparecer al día
```

El certificado y el perfil del llavero se reutilizan entre versiones. El build genera Apple Silicon e Intel,
ejecuta las pruebas, firma, notariza y adjunta los tickets. Puede tardar varios minutos por las revisiones de Apple.
No modificar el código mientras se está empaquetando. Para subir los instaladores y anunciar la actualización,
seguir «Publicar una versión» más abajo.

**Reglas de oro**
1. Un instalador nunca se arma a mano: siempre `release.sh build` (arma los dos a la vez).
2. Si `status` dice **DESACTUALIZADO** o **FALTA**, ese instalador no tiene lo último: no lo mandes.
3. Entregá siempre **los dos** `.dmg` de la misma versión (están en `release/`).
4. Cada cambio visible para quien usa Batea sube la versión y se anota en `CHANGELOG.md`.

## Cómo sabe el sistema que algo quedó viejo

Además del historial de Git, cada instalador guarda una **huella** (sha256) de todo lo que entra en la app: el código de Python
(`backend/batea`), la interfaz (`frontend/src` …), las dependencias (`pyproject.toml`, `uv.lock`,
`requirements-intel.in`), los íconos y `make_dist.sh`. Los README y esta guía **no** cuentan.

- Al armar un instalador se escribe `release/Batea-<versión>-<arch>.build.json` con la huella, la fecha, el tamaño, el
  sha256 del `.dmg`, el macOS mínimo y qué detector de tonalidad lleva.
- `release.sh status` recalcula la huella actual y la compara con cada `.build.json`. Si difiere, lista **qué archivos
  cambiaron** desde que se armó. También detecta un `.dmg` dañado o incompleto (su sha256 no coincide).
- Si el código cambia **mientras** se está empaquetando, el script lo detecta y no genera el instalador.
- Dentro de cada app queda `build_info.json` (versión, arquitectura, huella, fecha).

**Cómo ver qué versión es una app o un instalador**

| Dónde | Cómo |
|---|---|
| Nombre del archivo | `Batea-0.2.0-arm64.dmg` |
| Finder | Batea.app → Obtener información → Versión |
| Terminal | `/Applications/Batea.app/Contents/MacOS/Batea --version` (JSON con versión, arquitectura y huella) |
| Dentro de la app | `GET /api/status` → campo `version` (todavía no se muestra en pantalla) |
| Lo que se entregó | `release/*.build.json` |

## Flujo de trabajo cuando se agrega una función

1. **Desarrollar y probar como siempre** (`./scripts/make_app.sh` para tu app de desarrollo, o `--server` con una copia
   de la base). Nada de esto cambia.
2. **Revisar la lista de verificación de abajo** si la función toca rutas, procesos, dependencias o permisos, y **actualizar la
   presentación de bienvenida** si es una función principal.
3. `./scripts/release.sh status` → va a decir DESACTUALIZADO y qué archivos cambiaron. Es lo esperado.
4. `./scripts/release.sh bump minor` (o `patch`) y completar `CHANGELOG.md`.
5. Hacer commit y push del código, `VERSION` y `CHANGELOG.md` a `main`, dejando el anuncio de `update.json` para
   después del release. Así el tag de GitHub apunta al código de esa versión.
6. Ejecutar el **comando firmado** del bloque inicial, con `SIGN_ID` y `NOTARY_PROFILE`. Arma arm64 e Intel,
   **corre `Batea --selftest` sobre cada app empaquetada**, firma y notariza. Si falla algo, se detiene.
   Al final vuelve a correr `status`: tienen que salir dos ✓.
7. Probar la instalación y publicar siguiendo la sección siguiente. Los dos `.dmg` quedan en `release/`;
   los de versiones anteriores se mueven solos a `release/archive/`.

## Pantalla de arranque y presentación de bienvenida

- **Arranque:** mientras el motor no contesta se ve el logo con una barra (está en `frontend/index.html`, así aparece antes de que
  cargue el resto, y `Splash` en `Welcome.tsx` es idéntico). Ya no se ve la app vacía un instante. Si el motor no contesta, la
  misma pantalla ofrece «Reintentar».
- **Primera vez:** si la biblioteca está vacía y la presentación nunca se vio (`welcome_done` en la base), se muestra la presentación de
  8 diapositivas, pero **la primera pantalla es solo una pregunta limpia: qué traer a Batea** (sin diapositivas). No se importa ni se busca nada hasta que la persona confirma:
  importar rekordbox (si lo encontró), y música fuera de rekordbox: «Más tarde» (por defecto), «Buscar en mi Mac y mis discos» o
  «Solo una carpeta». Recién entonces aparecen las diapositivas, con el progreso real abajo (lectura de rekordbox, búsqueda, contador de temas) y, al terminar,
  «Entrar a Batea». «Entrar sin importar nada» sale sin traer nada. Quien ya tiene temas no la ve nunca.
- **Búsqueda automática de música** (al abrir y al conectar un disco): la decide la persona (`autodiscover` en la base; endpoints
  `POST /api/setup` y `POST /api/autodiscover`; interruptor en «Analizar e importar»). Una instalación nueva que no contestó **no
  busca nada**; las que ya tenían temas antes de existir la pregunta siguen buscando (así no cambia nada para ellas).
- **Volver a verla:** botón «Ver la presentación» en Ajustes → Acerca de (modo repetición: sin panel de carga, Escape cierra).
- **Mantenerla al día:** las diapositivas son el arreglo `SLIDES` de `frontend/src/components/Welcome.tsx`; cada una tiene su
  ilustración, armada con los mismos componentes de la app (cajas, sobres, etiquetas) y datos inventados, sin imágenes. **Cuando se
  agrega o cambia una función principal, actualizar o sumar una diapositiva** (y ajustar `SLIDE_MS` si pasan de unas 8).
- **Ver cada diapositiva y estado sin esperar:** `#slide=N&demo=ask|waiting|sync|discover|done|empty` al final de la dirección.
- **Pruebas automáticas** (teclado, clics, indicador, que nunca parpadee la app vacía, que no arranque nada sin preguntar, importar una carpeta, interruptor, repetir, usuario existente):
  `scripts/ui-tests/` (ver su README).
- Cambiar la interfaz deja los instaladores **DESACTUALIZADOS** (`release.sh status`): es lo esperado, hay que reconstruir.

## Reglas para que la función ande también empaquetada

Empaquetada no hay Python suelto, ni carpeta del proyecto, ni `.venv`. Por eso:

- **Rutas:** nunca `Path(__file__).parent.parent…` ni rutas absolutas. Usar `config.py` (datos en
  `~/Library/Application Support/Batea`) y `runtime.resource_dir()` para archivos que viajan dentro de la app.
- **Procesos aparte:** nunca `[sys.executable, "-m", …]`. Usar `runtime.self_command("batea.modulo", args…)`; empaquetada
  se convierte en `Batea --run-module batea.modulo`. Esto sirve para el ícono de la barra, los links y el servidor MCP.
- **Módulos nuevos:** `make_dist.sh` incluye todo `batea.*` (`--collect-submodules batea`); si un módulo se importa de
  forma dinámica o desde otro proceso, probarlo con `--selftest`.
- **Dependencias nuevas de Python:** agregarlas en **`backend/pyproject.toml` y en `backend/requirements-intel.in`**
  (`release.sh check` falla si no coinciden). Comprobar que existe binario para Intel (`uv pip compile
  backend/requirements-intel.in --python-platform x86_64-apple-darwin --python-version 3.12 --only-binary :all:`); si no
  existe, hay que elegir otra librería o una versión anterior (como pasó con numba, que obligó a `numpy<2.3`).
- **Herramientas del sistema:** no depender de Homebrew, ffmpeg ni nada instalado aparte. Solo lo que trae macOS
  (`open`, `lsof`, `pgrep`…).
- **Archivos dentro de la app:** la app es de solo lectura. Todo lo que se escribe va a `Application Support`, `Logs` o
  `~/Music/Batea`.
- **Permisos de macOS:** si la función lee una carpeta nueva (Música, Fotos…) agregar su `NS…UsageDescription` en el
  paso 5 de `make_dist.sh`.
- **Probar sin ventanas:** si la función agrega una librería nativa o un proceso, sumar una comprobación en
  `backend/batea/selftest.py`. `Batea --selftest` corre solo con carpetas vacías (`BATEA_HOME` y `BATEA_RB_DIR` obligatorias,
  para no tocar tu biblioteca) y no abre ventanas.
- **Diferencias Apple Silicon / Intel:** cualquier cosa que dependa de Essentia tiene que tener respaldo (ver
  `keyfill._detect_key_librosa`), porque en Intel no está.

## Actualizaciones obligatorias (GitHub)

Cada app instalada lee `update.json` del repositorio (`raw.githubusercontent.com/gianlucafarias/batea/main/update.json`) al abrir,
como mucho una vez por hora, y guarda la última lectura.

- `version`: la más nueva publicada. Si es mayor que la instalada, la barra lateral muestra «Hay una versión nueva · Descargar».
- `min_version`: **por debajo de esta, la app no abre**: ve una pantalla «Hay que actualizar Batea para seguir» con el botón de descarga, y
  la API contesta 426 a todo salvo `/api/update` y `/api/status`. La librería y los datos no se tocan.
- **Sin internet no se bloquea nadie por primera vez** (un DJ en un club sin señal sigue tocando). Si ya se había leído una mínima mayor, el
  bloqueo se mantiene aunque no haya conexión: la última lectura queda guardada.
- Una app corriendo desde el código fuente (desarrollo) nunca se bloquea. Para probarlo: `BATEA_UPDATE_FORCE=1` y `BATEA_UPDATE_URL=file:///ruta/update.json`
  (`BATEA_NO_UPDATE_CHECK=1` lo apaga).
- Los links de descarga solo se aceptan si apuntan a `github.com/gianlucafarias/batea/`.

**Publicar una versión**

```sh
./scripts/release.sh bump minor     # y completar CHANGELOG.md
# Hacer commit y push del código, VERSION y CHANGELOG.md a main; todavía no anunciar update.json.
SIGN_ID="Developer ID Application: Gianluca Palmier (J96S7CUHS9)" \
NOTARY_PROFILE="batea-notary" ./scripts/release.sh build
./scripts/release.sh status         # ambos al día; probar también la instalación
./scripts/release.sh publish        # crea el release v<versión> en GitHub con los dos .dmg y genera update.json (pregunta antes)
git add update.json MIN_VERSION
git commit -m "Anunciar nueva versión de Batea"
git push origin main
```

Si ya se hizo el bump y el build al seguir el bloque inicial, continuar desde `status`; no subir la versión otra vez.
`publish` requiere GitHub CLI autenticado con acceso al repositorio y muestra los datos antes de pedir confirmación.

El orden completo es **código y versión en main → build firmado → release con los .dmg → push de `update.json`**.
Si se publica `update.json` antes de subir los instaladores, las apps mostrarían un link que todavía no existe.
Los instaladores de `release/` ya incluyen la firma y los tickets; no hace falta volver a firmarlos al publicarlos.

Para que una actualización sea **obligatoria**, ejecutar `./scripts/release.sh require` antes de `publish`.
Eso establece `MIN_VERSION = VERSION`: las versiones anteriores con este chequeo quedan bloqueadas hasta actualizar.
Sin `require`, `MIN_VERSION` queda como estaba y nadie es obligado: solo ven el aviso. Para dejar de exigir una versión, bajá `MIN_VERSION` y volvé a subir `update.json`.
Un cambio en `update.json` llega a las apps en hasta una hora (más unos minutos de caché de GitHub).

**Importante:** una app ya repartida solo se puede obligar a actualizar si **ya trae este chequeo**. La primera versión con este código (0.2.x en adelante) tiene
que salir antes de repartir la beta; las que no lo traen no se enteran de nada.

## Datos y actualizaciones

- Los datos de cada persona (etiquetas, relaciones, cajas, base) viven en `~/Library/Application Support/Batea`, **fuera
  de la app**. Reemplazar la app no los toca.
- **Cambios de la base:** solo se agregan columnas o tablas (`db.py`: `CREATE TABLE IF NOT EXISTS` y `MIGRATIONS` con
  `ALTER TABLE … ADD COLUMN`). Nunca renombrar ni borrar columnas ni cambiar su significado: una versión vieja tiene que
  poder abrir lo que dejó una nueva sin romperse, y una nueva tiene que poder abrir lo de una vieja.
- Antes de abrir, Batea hace una **copia automática** de la base (cada 12 h, guarda las últimas 10) en `…/Batea/backups`.
- **No se vuelve a una versión anterior** encima de una más nueva (aunque casi siempre andaría, no está garantizado).
  Para volver atrás: restaurar una copia de `backups/` junto con la versión vieja.
- **Cómo actualiza una persona:** abre la descarga desde el aviso de actualización, cierra Batea (y el ícono de la barra),
  abre el `.dmg` nuevo, arrastra Batea a Aplicaciones y elige «Reemplazar». La app avisa y abre la descarga;
  la instalación se hace manualmente. Los datos de la biblioteca se conservan.
- **Agentes de IA:** «Conectar con agentes de IA» guarda la ruta de la app. Si la app se mueve o se reinstala en otro
  lugar, aparece «desactualizado» y hay que volver a conectar.

## Firma y entrega

Sin `SIGN_ID`, el empaquetado usa firma **local** (ad-hoc) y el `LEEME.txt` explica cómo abrirla.
Para distribuir con identidad de desarrollador verificada, se usan `SIGN_ID` y `NOTARY_PROFILE`.

Para que se abra con doble click y sin avisos hace falta, una sola vez:
1. Cuenta del programa de desarrolladores de Apple (99 USD al año) y el certificado **Developer ID Application**.
2. Credenciales de notarización guardadas: `xcrun notarytool store-credentials "batea-notary"`.

En esta Mac, el certificado instalado es `Developer ID Application: Gianluca Palmier (J96S7CUHS9)` y las
credenciales están guardadas en el llavero bajo el perfil `batea-notary`. Para generar los dos instaladores:

```sh
SIGN_ID="Developer ID Application: Gianluca Palmier (J96S7CUHS9)" \
NOTARY_PROFILE="batea-notary" ./scripts/release.sh build
```

`make_dist.sh` firma con hardened runtime, ejecuta el selftest, envía la app a Apple, le adjunta su ticket y
exige que pase `syspolicy_check distribution`. Después crea el `.dmg` con esa app, firma y notariza el `.dmg`,
adjunta su ticket y lo valida. El ticket del contenedor por sí solo dejaba fallando la comprobación de
distribución de la app por `Notary Ticket Missing`; por eso se adjuntan ambos. Un error de PyInstaller
detiene el proceso y deja el diagnóstico completo en `build/<arquitectura>/pyinstaller.log`.

El selftest Intel se ejecuta bajo Rosetta en esta Mac; no reemplaza una prueba en hardware Intel real.

Validado el 17 de noviembre de 2026 con Batea 0.2.0 para Apple Silicon e Intel: selftests correctos,
apps y `.dmg` aceptados por Apple, tickets adjuntos y comprobación de distribución de ambas apps correcta.

## Probar cómo se comporta sin rekordbox

Quien no tiene rekordbox (o lo instaló pero nunca lo abrió) ve: «Batea está vacía» con un único botón, **Analizar carpeta**;
el botón «Sincronizar» queda deshabilitado, la barra lateral dice «rekordbox: no encontrado» y «Importar rekordbox» no aparece.
Batea igual encuentra música sola (carpeta personal y discos conectados), se analiza a pedido, se etiqueta, se mezcla, el mapa
funciona y «Exportar» genera el XML (por si instala rekordbox más adelante). No hay historial de sesiones, así que las
sugerencias se basan solo en BPM, tonalidad y energía; el ícono de la barra dice que rekordbox no está abierto.

**Nunca renombres ni muevas `~/Library/Pioneer/rekordbox` para probar esto.** Se simula con variables de entorno:

| Cómo | Qué cubre | Comando |
|---|---|---|
| Automático (en cada `build`) | Arranque sin rekordbox, traer una carpeta a mano, búsqueda automática | `Batea --selftest` (ya está en el flujo) |
| Servidor + navegador sin ventana | La API y la pantalla (se puede sacar una captura con Chrome headless) | ver abajo |
| Ventana real de tu Mac, con datos aparte | Todo lo visible, sin tocar tu biblioteca | ver abajo |
| Otro usuario de macOS (Ajustes → Usuarios y grupos) o una Mac prestada | Lo más parecido a otra persona: permisos, firma local, sin rekordbox, sin tu música | instalar el `.dmg` |

Servidor de prueba (no toca tus datos ni escanea tu disco):

```sh
cd backend
HOME=/ruta/a/casa-falsa BATEA_HOME=/ruta/a/datos BATEA_RB_DIR=/ruta/inexistente \
BATEA_AUTODISCOVER=0 BATEA_PORT=8766 .venv/bin/python -m batea.main --server
# en otra terminal: curl localhost:8766/api/status  → "rekordbox_found": false
```

La ventana real con datos aparte (la app empaquetada, sin tu rekordbox y sin tu base; `BATEA_AUTODISCOVER=0` evita que
escanee tu disco, la música se trae con «Analizar carpeta»):

```sh
BATEA_HOME=/tmp/batea-prueba BATEA_RB_DIR=/tmp/sin-rekordbox BATEA_AUTODISCOVER=0 \
  /Applications/Batea.app/Contents/MacOS/Batea
```

Variables útiles: `BATEA_HOME` (dónde guarda sus datos), `BATEA_RB_DIR` (dónde busca rekordbox), `BATEA_AUTODISCOVER=0`
(no busca música sola), `BATEA_PORT` (con `--server`), `BATEA_NO_MENUBAR=1` (sin ícono de la barra).

## Qué se probó y qué no (a 2026-11-17)

- ✓ Apple Silicon: `--selftest` empaquetado completo (análisis, tonalidad con Essentia, arranque sin rekordbox, MCP, links).
- ✓ Intel: el mismo `--selftest`, pero **bajo Rosetta** (no en una Mac Intel real) y sin Essentia (se cuelga bajo Rosetta).
- ✗ No probado: abrir la ventana desde el `.dmg` en otra Mac, el ícono de la barra empaquetado, un click real en un link
  `batea://`, arrastrar temas a rekordbox, la notarización.
- Antes de entregar una versión a alguien, probarla una vez en una Mac que no sea la de desarrollo.

## Instalar el instalador en tu propia Mac (reemplazar la app de desarrollo)

Sirve para probar exactamente lo que recibe otra persona.

1. Cerrar Batea y el ícono de la barra de menú.
2. (Opcional, ya hecho una vez) copia de seguridad: `backup-pre-instalador/` tiene la app de desarrollo, la base y la
   configuración de Codex.
3. Mover `~/Applications/Batea.app` a la papelera.
4. Abrir `release/Batea-<versión>-arm64.dmg`, arrastrar Batea a **Aplicaciones**, expulsar el disco y abrirla.
5. Permitir los permisos que pida macOS (Escritorio, Documentos, discos externos…).
6. Dentro de Batea: «Conectar con agentes de IA» → los que estaban conectados figuran «desactualizados» (apuntan a la
   instalación de desarrollo); reconectarlos.
7. **Volver a la app de desarrollo** cuando quieras: `./scripts/make_app.sh` (recrea `~/Applications/Batea.app`).
   No dejar las dos instaladas a la vez: la de desarrollo vive en `~/Applications`, la del `.dmg` en `/Applications`.
   Y no borrar la carpeta del proyecto ni `backend/.venv`: la app de desarrollo y los agentes aún conectados la usan.

## Qué hay en cada carpeta

| Carpeta | Qué es | ¿Se puede borrar? |
|---|---|---|
| `release/` | Instaladores de la versión actual (`.dmg` + `.build.json`) | No: es lo que se entrega |
| `release/archive/` | Versiones anteriores | Sí, si no hace falta volver atrás |
| `build/<arch>/` | Entornos y archivos temporales del empaquetado (≈1,3 GB cada uno) | Sí; el próximo `build` los recrea (más lento) |
| `backup-pre-instalador/` | Copia de la app de desarrollo, la base y config de Codex antes de la primera instalación | Cuando ya no la necesites |
| `backend/.venv`, `frontend/dist` | Tu app de desarrollo (`make_app.sh`) | **No** |

## Problemas frecuentes

- **`status` dice DESACTUALIZADO justo después de armar:** el código se tocó después (la lista muestra qué archivo). Volver a `build`.
- **`parity` falla:** una dependencia está en `pyproject.toml` pero no en `requirements-intel.in` (o al revés).
- **Falla la prueba del paso 7 y no se genera el `.dmg`:** el detalle queda en `build/<arch>/selftest.log`.
- **Intel no resuelve dependencias:** probablemente una librería nueva sin binario para x86_64 (ver reglas de dependencias).
- **El disco se llena:** borrar `build/` y `release/archive/`.
