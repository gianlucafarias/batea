# Historial de versiones

Cada vez que se arma un instalador nuevo se sube la versión (`./scripts/release.sh bump patch|minor|major`)
y se anota acá, en lenguaje de quien usa Batea, qué cambió. Lo más nuevo arriba.

## 0.4.1 — 2026-11-19

**Actualizar sin salir de Batea**
- Cuando hay una versión nueva aparece un cuadro arriba a la derecha, con las novedades. «Actualizar» la baja, comprueba que sea la app original de Batea (firma de Apple, versión y autor) y la deja lista; «Reiniciar ahora» la instala y vuelve a abrir Batea. Tu librería y tus datos no se tocan.
- También se puede hacer desde Ajustes → Acerca de. Si Batea está en una carpeta donde no puede reemplazarse sola, ofrece la descarga a mano.
- Se quitó el aviso de la barra lateral.

## 0.4.0 — 2026-11-19

**Cues y grilla**
- Editor de cues: hot cues A–H, memory cues y loops, sobre una onda a nivel de muestra con zoom continuo (hasta menos de 1 ms por píxel), pegado al beat y ajuste fino de cada cue. Los loops repiten mientras están activos. Se abre desde la ficha del tema («Cues…») o con clic derecho.
- Grilla corregible: «Este es el 1», correr de a milisegundos (también arrastrando con Mayús), BPM, ½ y 2×. La grilla corregida se usa también al probar mezclas.
- Las cues se ven en la onda del reproductor, en el detalle del tema y en «Probar mezcla» (con un interruptor para ocultarlas).
- Llevar cues y grilla a rekordbox en el XML (opción «Llevar cues y grilla», en prueba). Para que los temas de rekordbox salgan con su grilla exacta, en Ajustes → Programas se trae el XML que exporta rekordbox (File → Export Collection in xml format).

**Bateas**
- Reordenar arrastrando (las tarjetas, y los temas de una lista, también en las playlists de rekordbox), estantes que se pliegan, carpetas y cajas nuevas desde cada estante, y clic derecho en cajas y carpetas (renombrar, mover, duplicar, ocultar, borrar, exportar).
- Las cajas tuyas muestran si todavía no se exportaron a rekordbox o si cambiaron después de exportarlas, con un botón para exportar las pendientes.
- Exportar a rekordbox ya no pierde las cajas exportadas antes: el archivo lleva todas.

**Reproducción**
- La posición del cabezal sigue al audio cuadro a cuadro y coincide con la onda; en los MP3, hacer clic en la onda salta a la posición exacta.
- Pistas similares: el play ya no cambia la ficha abierta. En el reproductor, el título y el artista abren su ficha y sus temas.

**Probar mezcla**
- «Mezclan bien» guarda la mezcla completa (entrada, cue, fase, curvas) y al reabrirla queda armada. Una pareja marcada dos veces ya no aparece repetida.

**Además**
- La versión se ve bajo el logo y hay una pestaña «Acerca de» en Ajustes, con «Comprobar actualizaciones» y la presentación («Ver la presentación» se mudó acá).

## 0.3.1 — 2026-11-18

- Arreglo: después de actualizar, Batea podía seguir mostrando la interfaz de la versión anterior (macOS la guardaba en caché). Ahora siempre carga la de la versión instalada.

## 0.3.0 — 2026-11-18

**Traktor y Serato, además de rekordbox**
- Batea ahora lee también Traktor Pro 3/4 y Serato DJ (4/5 y 3.x), siempre sin tocar sus bases. La bienvenida pregunta qué programas usás (los que encuentra aparecen marcados) y si querés sumar tu música suelta.
- La barra lateral tiene una sección por cada programa importado, y cada tema muestra en qué programas está (columna «Programa» en la lista y «En cada programa» en la ficha).
- Exportar te deja elegir a qué programa: rekordbox (XML), Traktor (playlist .nml) o Serato y cualquier otro (.m3u8).
- Nuevo botón **Ajustes**, con las pestañas Programas y Agentes de IA.

**Saber qué suena**
- El ícono de la barra de menú muestra el tema que está sonando en rekordbox, Serato o Traktor y qué poner después (en Traktor, por Broadcasting; Ajustes te dice cómo configurarlo). Se activa o se apaga en Ajustes → Programas, donde también podés elegir el programa o dejar que lo detecte solo.

**Probar mezcla, renovada**
- Más fácil de encontrar: botón «Probar mezcla con…» en el detalle de cualquier tema, «Mezclar con…» en el reproductor, en el clic derecho y con la tecla **M**. Un selector te propone los sugeridos y te deja buscar en toda la librería; adentro de la mezcla, «Cambiar B» prueba otro tema sin salir.
- Zoom en la grilla hasta ver 2 compases, con la onda dibujada desde el audio y las líneas de cada beat de los dos temas, para clavar la fase.
- Arrastrás B para mover la entrada (de a compás; Mayús de a beat; Opción libre) y la banderita del cue para elegir desde qué compás arranca.
- Mezclador nuevo: EQ de 3 bandas por tema con perillas y Kill, y crossfader de verdad.
- Transiciones Cambio de graves, Fundido o Corte, de 8 a 64 compases. En automático, el crossfader y los graves se mueven solos.
- Las curvas de la transición se editan: clic agrega un punto, arrastrar lo mueve, doble clic lo borra. Si agarrás una perilla mientras suena, la manejás vos hasta que pauses.

**Además**
- Mapa: botones − / + para el tamaño de los puntos; la rueda Camelot muestra también los temas sin energía.
- La búsqueda automática de tu música se prende o apaga desde Ajustes.
- Con el detalle abierto, al poner play a otro tema el detalle pasa a ese tema.

## 0.2.0 — 2026-11-17

Cambios después del primer empaquetado:

- Actualizaciones: al abrir, Batea mira en GitHub si hay una versión nueva (aviso en la barra lateral) y, si la tuya quedó por debajo de la mínima publicada, no abre hasta que actualices. Sin internet nunca te frena por primera vez. Tus datos no se tocan.
- Sin rekordbox (o con su carpeta vacía) la búsqueda automática de música ahora arranca; antes quedaba esperando para siempre y Batea aparecía vacía.
- Al analizar un tema sin etiquetas, Batea conserva el artista y el título sacados del nombre del archivo (antes los pisaba con el nombre completo).
- Pantalla de arranque con el logo en lugar de ver la app vacía un instante; si el motor no contesta, ofrece reintentar.
- La primera vez, Batea empieza con una pantalla limpia que pregunta qué traer (rekordbox y/o música de tu Mac, discos o una carpeta). **Nada se importa ni se busca hasta que lo confirmás.** Si elegís no traer nada, entra directo. Recién cuando confirmás aparecen las 8 diapositivas con las funciones principales, mientras se importa, con el progreso real. Se pueden saltar y volver a ver desde la barra lateral.
- La búsqueda automática de música se puede activar o desactivar en «Analizar e importar». Quien ya usaba Batea la conserva activada.
- Si no hay rekordbox, la pantalla vacía ya no le pide que lo importe.
- Movimiento más pulido y parejo en toda la app: un solo resaltado que se desliza bajo el mouse en la barra lateral, la lista de temas, la cola de Etiquetar, las relaciones de la ficha, el selector de universo y el menú de click derecho (que sigue naranja). La ficha, los menús, los diálogos y los avisos ahora también se van con una animación corta en vez de desaparecer de golpe, y la ficha ya no vuelve a entrar deslizándose cada vez que cambiás de tema. El fondo de la opción elegida en los controles de vista se desliza a la nueva. Play/pausa cambia de ícono con un fundido.
- Con «Reducir movimiento» activado en macOS se mantienen los fundidos y se sacan los desplazamientos (antes se apagaba todo).
- Ficha del tema más simple: seis datos en vez de ocho (intro y outro dicen "compases"), las etiquetas se ven solo las puestas y se editan con "Editar", 6 sugerencias con un solo motivo y "Ver más", sin la explicación del estilo ni la barra de puntaje.
- Textos más cortos en toda la app (Analizar e importar, agentes de IA, leyendas del mapa, avisos).
- Diseño más sobrio: los títulos de sección ya no van en mayúsculas espaciadas, las etiquetas de la lista no tienen barra de color al costado, sin pastillas de colores en las relaciones, sin brillos naranjas ni símbolos decorativos (✦ ▷ ■).
- Selector de universo con columnas alineadas: el elegido lleva un tilde y editar es un lápiz en su propia columna.
- Subtítulos de cada vista con un solo criterio: cuántos temas y como mucho un dato más (rango de BPM o universo), sin instrucciones. Las instrucciones del mapa y la rueda pasaron a un botón "?". "Analizar N pendientes" es un botón en vez de un link subrayado, y "A rekordbox" ahora dice "Exportar a rekordbox".
- Sugerencias y relaciones en dos líneas: el título completo y debajo «145 BPM · 7A · Tono que levanta» (el tono en su color, el motivo en palabras simples). Los botones aparecen solo al pasar el mouse.
- El sobre genérico muestra el tono con su color y "143 BPM" en vez de "4B · 143".
- El volumen tiene un deslizador visible (el de macOS se veía gris sobre gris) y el parlante silencia.
- Arreglo: con la ventana de altura normal, la grilla de BPM, tono y largo de la ficha quedaba aplastada y no se veía.
- Arreglos: la barra de selección múltiple ya no salta de costado al aparecer; en el submenú de Puntaje solo se ilumina la fila resaltada; Exportar abierto desde «Toda la colección» ya no preselecciona una caja invisible.

Primera versión que se puede instalar en otras Macs (antes solo corría desde la carpeta del proyecto).

- Instaladores `.dmg` autónomos para Apple Silicon (macOS 15+) e Intel (macOS 14+): no hace falta instalar Python ni nada más.
- Universos, etiquetado rápido con teclado y en tanda, «Probar la mezcla», completar tonalidades.
- Búsqueda automática de música fuera de rekordbox, análisis a pedido con una sola fila de trabajo.
- Mapa 3D (constelación) y rueda Camelot.
- Servidor MCP para Claude, Codex y Cursor, links `batea://` y el ícono de la barra de menú (qué suena y qué poner después).
- Intel: la tonalidad se calcula con librosa (≈56 % de aciertos exactos contra rekordbox, ≈73 % contando tonos compatibles);
  Apple Silicon usa Essentia (≈67 % y ≈83 %).
