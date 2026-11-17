# Historial de versiones

Cada vez que se arma un instalador nuevo se sube la versión (`./scripts/release.sh bump patch|minor|major`)
y se anota acá, en lenguaje de quien usa Batea, qué cambió. Lo más nuevo arriba.

## 0.2.0 — 2026-11-17 (pendiente de reempaquetar)

Cambios después del primer empaquetado (no están en los `.dmg` actuales hasta el próximo `release.sh build`):

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
