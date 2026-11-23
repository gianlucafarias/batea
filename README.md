# Batea

Organizador visual de música para DJs, conectado a rekordbox. Las cajas se hojean como una batea de discos, con etiquetas, puntaje, energía, relaciones entre temas, recomendaciones que aprenden de cómo mezclás y un mapa sonoro de la librería.

## Instalar como app de Mac

```sh
./scripts/make_app.sh
```

Crea `~/Applications/Batea.app`. Requiere `uv` (Homebrew) y Node 18+.

## Cómo se conecta con rekordbox

- **Lee** una copia de `~/Library/Pioneer/rekordbox/master.db`: temas, BPM, tonalidad, puntajes, colores, My Tags, playlists e historial de sesiones. **Nunca escribe** en la base de rekordbox.
- **Lee las waveforms** de `rekordbox/share/PIONEER/USBANLZ` (están en la Mac, no en el disco de música). De ahí salen la energía estimada, el largo de intro y outro en compases y los breaks, aunque el disco con los archivos esté desconectado. La energía de los temas que analiza Batea (fuera de rekordbox) se traduce a la misma escala (`features.AUDIO_TO_ANLZ`, medido en 80 temas analizados de las dos formas), así se comparan entre sí.
- **Exporta** a rekordbox con un XML (`~/Music/Batea/batea.xml`), el camino oficial: Preferencias → Avanzado → Base de datos → rekordbox xml.
- El **historial** de sesiones se convierte en relaciones “lo tocaste seguido de…”, que alimentan las recomendaciones. Cada sesión guarda además lo que sonó en orden y con los temas que volviste a poner (`session_plays`), que es lo que usan el gráfico y las estadísticas.

## Música que todavía no pasó por rekordbox

Batea la busca sola, sin carpetas fijas: recorre la carpeta del usuario y cada disco conectado, al abrir la app y cada vez que se conecta un disco. Solo lee, nunca mueve ni borra archivos.

- **Solo temas**: archivos de 2 minutos o más. Las carpetas de samples, loops, one-shots, presets, previews, proyectos de Ableton y cachés de programas se saltean sin abrirlas; los archivos que por tamaño no pueden durar 2 minutos tampoco se abren. Los `.mp4` no cuentan (casi siempre son video).
- **Sin duplicados**: lo que ya está en rekordbox se reconoce por ruta y, si se movió o copió, por nombre de archivo y duración. Si un tema que ya estaba en Batea cambia de carpeta, se actualiza la ruta y conserva etiquetas, notas y relaciones.
- **Carpetas**: en *Analizar e importar → Música fuera de rekordbox* se ve todo agrupado por carpeta principal. "No es música" saca esos temas de Batea (los que ya tienen datos tuyos quedan ocultos) y no vuelve a revisar la carpeta; "Volver a incluir" la recupera.
- **A mano**: "Traer una carpeta…" o arrastrar archivos y carpetas a la ventana. Lo que se trae así entra aunque dure menos de 2 minutos y no lo saca ninguna búsqueda automática.
- **Velocidad**: la primera búsqueda tarda unos minutos (mide la duración de cada archivo nuevo); las siguientes, segundos, porque Batea recuerda lo que ya midió.

Los temas aparecen enseguida en el atajo *Fuera de rekordbox* con el nombre del archivo; como fecha de agregado usan la de creación del archivo (cuándo llegó a la Mac o al disco). Buscar **no analiza nada**: título, artista, carátula, BPM, tonalidad Camelot, energía, intro, outro y breaks se calculan solo cuando lo pedís: **Analizar** en una carpeta, *Analizar este tema* en la ficha, *Analizar N* con varios seleccionados o *analizar N sin analizar* en el encabezado de una caja. Todo entra en una sola fila que se procesa de a un tema por vez y con prioridad baja para no trabar la computadora (se puede detener desde la barra lateral). En las listas, la batea y la ficha, los temas sin analizar llevan una marca (*sin analizar*, *en espera*, *analizando…*, *no se pudo analizar*; *rb sin analizar* si es rekordbox el que no lo analizó). Después se agrupan en cajas y se llevan a rekordbox con la exportación XML.

## Carpetas

En el menú de la izquierda, *Carpetas* muestra las carpetas de tu Mac y de cada disco que tienen temas, con dónde están los archivos **hoy**: si rekordbox guarda una ruta vieja (por ejemplo del Escritorio) y el archivo ahora está en el SSD, el tema aparece en la carpeta del SSD. Las rutas que ya no existen no se muestran; un disco desconectado aparece apagado. Abrir una carpeta la muestra como una caja (hojear, etiquetar, filtrar, mapa, exportar como playlist, *Mostrar en Finder*). Esos temas con ruta vieja también se pueden escuchar: Batea usa la copia que encontró.

## Click derecho en un tema

En la lista y en la pared de carátulas (con varios seleccionados actúa sobre todos): reproducir, ver ficha, mostrar en Finder, analizar / volver a analizar (solo temas fuera de rekordbox), editar datos (título, artista, remixer, álbum, sello, género, año; solo temas fuera de rekordbox, se guardan en Batea y viajan con la exportación, el archivo no se toca y un nuevo análisis no los pisa), etiquetar, puntaje, agregar a una caja, llevar a rekordbox (suma a la caja *Para rekordbox*), buscar compatibles para mezclar (tono compatible y BPM ±3% en toda la colección), probar la mezcla, marcar como revisado, copiar "Artista - Título", quitar de la caja y eliminar de Batea (no borra archivos; se recupera desde el atajo *Eliminados de Batea*). Las estrellas de la lista se pueden tocar para puntuar.

## Mapa 3D

Cada tema es una estrella. En *Constelación* las líneas son lo que tocaste uno después del otro (historial de rekordbox) y tus relaciones; los temas que se mezclan juntos forman racimos y los que no tienen historial se acercan a los que suenan parecido (BPM, tono, energía). El acomodo se calcula en segundo plano (un Web Worker, sin trabar la pantalla) la primera vez y queda guardado; con toda la librería tarda unos 30–40 s, con un universo, segundos. Arrastrar gira, la rueda acerca, click derecho mueve, click en una estrella vuela hasta ella y enciende sus conexiones y sugeridos, doble click la reproduce, ⇧+arrastrar selecciona para crear una caja. Los nombres aparecen al acercarse. Motor: three.js (`components/map3d/engine.ts`), acomodo con d3-force-3d (`components/map3d/layout.worker.ts`).

Al lado está la *Rueda Camelot* plana de siempre (`components/CamelotWheel.tsx`): cada tono en su gajo, A adentro y B afuera. Batea recuerda cuál de los dos usaste último (`MapScreen.tsx`).

## Universos

Un universo limita todo Batea (bateas, mapa, sugerencias, sin clasificar, completar tonalidades) a las playlists y carpetas que elijas. Las sesiones del historial son la excepción: al abrir una se ve completa, porque es lo que tocaste esa noche. Se crea desde el selector de arriba a la izquierda. No borra nada: “Toda la librería” vuelve a mostrar todo. El estilo de mezcla que aprende Batea se calcula dentro del universo activo.

## Etiquetado rápido

*Etiquetar* (o “Etiquetar en tanda” dentro de una caja) abre una cola que se maneja con el teclado: `1`–`0` energía, `⇧1`–`⇧5` puntaje, una letra por etiqueta (se pueden cambiar), `←` `→` saltan 8 compases, `Enter` marca el tema como listo y pasa al siguiente. En las listas, `⌘`/`⇧`-click selecciona varios temas para etiquetarlos juntos.

## Probar la mezcla

Desde la ficha de un tema (sugerencias y relaciones) o con dos temas seleccionados. Los dos temas se decodifican a memoria y suenan con Web Audio sobre el mismo reloj, alineados por la grilla de compases. Cada bandeja tiene tempo y tono; con «Sync» B sigue el tempo de A, y con «Master tempo» (por defecto) cambiar el tempo no cambia el tono (`mixlab/stretch.ts`, en un worker). Sin master tempo suena como un vinilo. Se elige en qué compás entra B, desde qué compás arranca y la fase; la mezcla automática cruza los volúmenes y cambia los graves a mitad del solape. El veredicto (mezclan bien / mashup / no van) se guarda como relación con el punto de mezcla anotado. La sincronía es tan buena como las grillas: si un bombo cae corrido, se corrige con “Fase de B”.

## Gráfico de la caja

«Ver gráfico» en cualquier caja o sesión: la energía de cada tema (con decimales y el eje acercado al rango del set), las fases warm-up / subida / peak / cierre, el BPM en escalones y el tono de cada pasada (compatible, arriesgada o choque). Sigue siempre el orden real: el de la caja o, en una sesión, lo que sonó; nunca la columna por la que esté ordenada la lista. Debajo, «Para revisar» lista saltos de tempo, choques de tono, caídas de energía, pasadas con poco margen, pasadas marcadas para evitar, peak muy temprano y tramos planos. Cada pasada ofrece «Tema puente» y «Reemplazar»: temas que entran bien de los dos lados por tempo (hasta 6% por lado) y tono, sacados del mismo motor que las sugerencias (`setinsights.suggest_between`); en tus cajas se agregan con un clic. En tus cajas y playlists se puede arrastrar un tema dentro del gráfico y todo se recalcula mientras se mueve. Hasta 150 temas.

## Tus sesiones

Ícono al lado de «Historial de sesiones»: curva de energía típica de tus sesiones (mediana y la franja de la mitad), en qué momento llega tu peak, sesiones y BPM mes a mes, temas de peak, con qué abrís y cerrás, pasadas que más repetís y temas que tocabas seguido y ya no. Por año, con todo el historial o solo con las sesiones de tu universo (`setinsights.session_stats`, `GET /api/sessions/stats`).

## Completar tonalidades

En *Analizar e importar*. Calcula el tono de los temas que rekordbox dejó sin analizar (Essentia, perfil `bgate`), los marca como estimados y nunca pisa un tono de rekordbox. Antes de completar mide su acierto contra temas que ya tienen tono. Medido sobre 180 temas reales: coincide exacto con rekordbox en ~61% y en ~74% contando tonos compatibles, por eso un tono estimado pesa la mitad en las sugerencias.

## Hablar con Batea desde Claude, Codex o T3 (MCP)

Batea trae un servidor MCP: cualquier agente compatible puede consultar tu librería (cajas, carpetas, historial, búsquedas, compatibles, tu estilo de mezcla) y armar ideas de set.

**Conectar:** en la barra lateral, *Conectar con agentes de IA*. Batea detecta Claude Code, Codex, Cursor y la app de escritorio de Claude, y agrega o saca solo su propia entrada en la configuración de cada uno (guarda una copia `.batea-bak` antes de escribir). T3 Code usa la configuración de Claude Code y de Codex. *Probar el servidor* lo arranca como lo haría un agente. Para otro agente, *Otro agente…* muestra la configuración para pegar: el comando es `backend/.venv/bin/python -m batea.mcp_server` con `PYTHONPATH=backend`. Si movés la carpeta de Batea, aparece "Apunta a otra carpeta" y se arregla con *Actualizar*.

Lee la base de Batea directo, así que responde aunque la app esté cerrada. Solo lee: lo único que escribe es *crear_caja* (agrega una caja nueva, nunca toca las existentes ni rekordbox). No manda rutas completas ni los comentarios de rekordbox. Por defecto usa el universo activo en la app en el momento de cada consulta, pero el agente puede pedir cualquier universo por nombre o toda la librería sin cambiar nada en la app ("en Techno…", "en toda la librería…"). Cada respuesta indica su alcance.

Cada tema que nombra el agente es un link **batea://**: al hacer click, Batea pasa al frente con la ficha abierta (si estaba cerrada, se abre). También: `batea://caja/ID`, `batea://carpeta/<ruta>`, `batea://artista/<nombre>` y `batea://tema/ID?play=1` para reproducir. Los links los recibe *Batea Links* (un applet sin ícono que crea `make_app.sh` dentro de Batea.app) y se los pasa a la app abierta por la API local, con un token que vive en `app.json`.

| Parte | Archivo |
|---|---|
| Herramientas para la IA | `backend/batea/ai_tools.py` |
| Servidor MCP | `backend/batea/mcp_server.py` |
| Conectar con agentes | `backend/batea/agents.py`, `frontend/src/components/Agents.tsx` |
| Links batea:// | `backend/batea/links.py`, `frontend/src/links.ts` |

## Datos

Todo lo tuyo (etiquetas, relaciones, cajas, universos, notas, energía) vive en `~/Library/Application Support/Batea/batea.db`. Sincronizar con rekordbox actualiza los datos de rekordbox sin tocar los tuyos. Al abrir la app se guarda una copia en `backups/` (hasta 10, una cada 12 horas como mucho).

## Desarrollo

```sh
cd backend && uv run python -m batea.main --server   # API en :8765
cd frontend && npm run dev                            # interfaz en :5273 con proxy a la API
cd backend && uv run python -m batea.main            # ventana nativa (usa frontend/dist)
```

| Parte | Archivo |
|---|---|
| Importación rekordbox | `backend/batea/rbsync.py` |
| Lectura rápida de waveforms ANLZ | `backend/batea/anlz.py` |
| Energía / intro / outro / breaks | `backend/batea/features.py` |
| Análisis de audio propio | `backend/batea/analysis.py` |
| Recomendaciones y estilo aprendido | `backend/batea/recommend.py` |
| Tema puente / reemplazo, estadísticas del historial | `backend/batea/setinsights.py` |
| Gráfico de la caja | `frontend/src/components/SetChart.tsx`, `frontend/src/lib/setAnalysis.ts` |
| Tus sesiones | `frontend/src/components/SessionsStats.tsx` |
| Exportación XML | `backend/batea/export.py` |
| Batea 3D | `frontend/src/components/Digger.tsx` |
| Mapa | `frontend/src/components/MapView.tsx` |
| Carpetas reales | `backend/batea/folders.py`, `frontend/src/components/FolderTree.tsx` |

## Instalarla en otras Macs

> Flujo completo de versiones, qué revisar al agregar funciones y cómo no dejar instaladores viejos: **[RELEASING.md](RELEASING.md)**. Historial: [CHANGELOG.md](CHANGELOG.md).

**En GitHub (lo habitual desde la 0.5.0):** Actions → «Armar instaladores» → Run workflow (con «publicar» marcado). Arma Apple Silicon e Intel en Macs de GitHub, cada uno en su arquitectura, firmados y notarizados, y los deja en un release borrador. No usa tu Mac. Ver «Armar en GitHub» en `RELEASING.md`.

**En tu Mac (respaldo):**

```sh
./scripts/release.sh status      # ¿los instaladores corresponden al código actual?
SIGN_ID="Developer ID Application: Gianluca Palmier (J96S7CUHS9)" \
NOTARY_PROFILE="batea-notary" ./scripts/release.sh build
```

El comando genera los dos `.dmg` firmados y notarizados en `release/`. El certificado y el perfil del llavero
se reutilizan para nuevas versiones. Para subir la versión, publicar en GitHub y anunciarla a las apps instaladas,
seguir el orden completo de `RELEASING.md`.

(`./scripts/make_dist.sh arm64|x86_64` arma uno solo; usá `release.sh build` para que ninguno quede viejo.)

Genera una `Batea.app` autónoma dentro de un `.dmg` (Python y librerías incluidos: no hace falta instalar nada). No toca tu instalación de desarrollo ni `~/Applications/Batea.app`: trabaja en `build/` y deja el resultado en `release/`. Al final corre `Batea --selftest` sobre la app ya empaquetada (análisis de audio, tonalidad, arranque sin rekordbox, servidor MCP) y, si algo falla, no crea el `.dmg`.

- **macOS mínimo:** Apple Silicon 15 (lo exige Essentia); Intel 14.
- **Tonalidad:** en Apple Silicon usa Essentia (medido: ~67% exacto, ~83% compatible contra rekordbox). La versión Intel no lleva Essentia (se cuelga bajo Rosetta y no se pudo verificar en una Intel real) y usa librosa (~56% / ~73%). `keyfill._detect_key_librosa` se usa también en Apple Silicon si Essentia faltara.
- **Firma:** sin cuenta de desarrollador de Apple la app lleva firma local; en otra Mac se abre la primera vez con click derecho → Abrir (el `.dmg` trae un LEEME). Para distribuirla con Developer ID: `SIGN_ID="Developer ID Application: …" NOTARY_PROFILE="batea-notary" ./scripts/release.sh build` firma y notariza la app y el `.dmg`, adjunta sus tickets y valida la distribución. Ver `RELEASING.md` para configurar las credenciales.
- **Qué cambia empaquetada:** el ícono de la barra, los links `batea://` y el servidor MCP se lanzan con el mismo ejecutable (`Batea --run-module batea.menubar`, etc.; ver `runtime.py` y `main._run_module_mode`). «Conectar con agentes de IA» registra la ruta de esa app, así que hay que conectarlos desde `/Applications` (no desde el `.dmg`) y reconectarlos si se mueve.
- **Dependencias Intel:** `backend/requirements-intel.in` (numpy < 2.3, porque numba ya no publica binarios Intel nuevos).
