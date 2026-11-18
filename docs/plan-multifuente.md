# Plan: Batea multifuente (rekordbox + Traktor + Serato + música propia)

Estado: plan, nada implementado. Research de formatos en
`../reports/Librerías Traktor y Serato.md` (fuera del repo).

Reglas que no cambian:
- Solo lectura sobre las bases de cada programa: se copia y se lee la copia.
- Nada se importa, busca ni analiza sin que la persona lo confirme.
- El análisis propio de Batea (energía, intro/outro) sigue siendo a pedido, de a un tema.
- Migraciones de `batea.db` solo aditivas.

---

## 1. Onboarding: "¿Qué programas usás?"

Reemplaza la sección rekordbox de `SetupScreen` (`frontend/src/components/Welcome.tsx`).
Sigue siendo la primera y única pantalla antes de confirmar; las diapositivas
aparecen después, mientras importa (no mezclar pregunta y diapositivas).

```
Bienvenido a Batea
Elegí qué querés traer. No se importa ni se analiza nada hasta que confirmes.

¿Qué programas usás?                         (se pueden marcar varios)
 [x] rekordbox 7        Encontrado · 12.400 temas · 210 sesiones
 [x] Traktor Pro 4.5    Encontrado · guardado el 12/11
 [ ] Serato DJ Pro 5    Encontrado · también en el disco MUSICA
 [ ] Engine DJ          No encontrado · Está en otra carpeta…

Tu propia música (archivos que no están en ningún programa)
 ( ) Más tarde
 ( ) Buscar en mi Mac y mis discos
 ( ) Solo una carpeta  [elegir]

                                   [ Empezar ]  /  [ Entrar sin importar nada ]
```

- Los detectados aparecen **marcados por defecto**, con versión y un dato concreto
  (temas, último guardado, disco). Los no detectados quedan apagados con
  "Está en otra carpeta…" (selector de archivo: `collection.nml`, `master.sqlite`,
  carpeta `_Serato_`).
- La detección es solo `exists()` sobre rutas conocidas; contar temas para la
  etiqueta se hace sobre la copia, en segundo plano, y si tarda se muestra solo
  "Encontrado".
- Si no marca nada y elige "Más tarde", al tocar el botón aparece una confirmación:

  > **¿Entrar sin importar nada?**
  > Bateas, Mapa y Sugerencias van a estar vacías hasta que traigas tu música.
  > Podés hacerlo cuando quieras desde **Fuentes** en la barra lateral.
  > [Volver]  [Entrar igual]

- La pantalla de progreso (`stage` run) muestra un paso por fuente elegida:
  "Leer rekordbox (solo lectura)", "Leer Traktor (solo lectura)", "Leer Serato…",
  "Buscar música propia".

Backend:
- `GET /api/sources` → lista de fuentes detectadas:
  `{kind, label, version, found, locations[], detail, enabled, last_sync, app_running}`.
- `POST /api/setup` pasa de `{rekordbox: bool, search, path}` a
  `{sources: ["rekordbox","traktor",...], search, path}`. Se mantiene compatibilidad
  con el campo viejo `rekordbox` por si hay un frontend viejo.
- Meta nueva `sources_enabled` (JSON). DB existente con temas de rekordbox ⇒
  `["rekordbox"]` (los usuarios actuales no ven cambios).

Después del onboarding: si aparece una fuente nueva (instaló Serato, enchufó un
disco con `_Serato_`), un aviso en la barra lateral pregunta "Encontré Serato,
¿importarlo?" — nunca se importa solo.

## 2. Panel "Fuentes"

Reemplaza el botón "Sincronizar" y la línea "rekordbox: sincronizado…" del pie
de `Sidebar.tsx`. Una fila por programa:

```
rekordbox 7      sincronizado hace 2 h          [Sincronizar] [•••]
Traktor Pro 4.5  datos del último guardado 12/11 (Traktor está abierto)
Serato DJ Pro 5  2 bases: esta Mac, MUSICA [Sincronizar] [•••]
Música propia    búsqueda automática: activada
+ Agregar otra fuente…
```

`•••`: ver ruta, cambiar carpeta, desactivar (oculta sus datos, no los borra).
"Sincronizar todo" corre las fuentes activas en el mismo job queue, una a la vez.

## 3. Barra lateral: una sección por programa

Hoy hay una sección "rekordbox" con su árbol de playlists. Pasa a haber una por
cada fuente importada, con el mismo componente `Tree`:

```
rekordbox            Traktor               Serato
  ▸ Techno             ▸ $ROOT / Sets        ▸ Gigs
  ▸ Historial          ▸ Historial           ▸ Historial
```

- `crates.source` hoy es `user | rekordbox`; se suma `traktor | serato | engine | vdj`.
  `rb_id` se generaliza a `ext_id` (columna nueva, `rb_id` queda por compatibilidad).
- Smartlists/smart crates: se muestran como caja con su nombre; si Batea no sabe
  evaluar las reglas, se muestran los temas que el programa ya resolvió
  (Serato 4 guarda la membresía) o la caja aparece con "reglas de Traktor, no se
  evalúan acá".
- "Historial" de cada programa lista sus sesiones (fecha, cantidad de temas),
  igual que hoy con rekordbox.
- El filtro de universos sigue aplicando a todas las secciones.

## 4. Cada tema dice de dónde viene

Modelo: un tema de Batea + un registro por fuente (no se pisa un BPM con otro).

- Tabla nueva `track_sources(track_id, source, ext_id, path_raw, bpm, key_raw,
  key_camelot, rating, color, play_count, date_added, comment, cues_json,
  grid_json, synced_at)`.
- `tracks` conserva los valores "elegidos" según precedencia: rekordbox > Traktor >
  Serato > análisis de Batea. La precedencia se puede cambiar en Fuentes.
- `tracks.source` (`rekordbox | local`) sigue existiendo; "local" pasa a significar
  "no está en ningún programa".

UI:
- En la lista/batea: chips chicos `RB` `TK` `SE` en cada tema.
- En `TrackPanel`: bloque "Analizado en" con una fila por programa
  (BPM, tono, rating, cues) y marca de conflicto si el tono no coincide
  (suave si es vecino en la rueda Camelot, fuerte si no).
- Filtro nuevo en `FilterBar`: "Está en: rekordbox / Traktor / Serato / ninguno".

Deduplicación (etapa 5 del research): ruta canónica (NFC + casefold), volumen por
UUID + ruta relativa, tamaño + duración + nombre, hash solo del audio, y como
último recurso huella acústica (solo vincula versiones, no fusiona cues).

## 5. Exportar: elegir a qué programa y cómo

El diálogo de exportar (hoy "Exportar a rekordbox (XML)") pasa a pedir destino
primero, y muestra qué viaja y qué no según el programa:

| Destino | Cómo | Qué viaja | Cómo se carga en el programa |
|---|---|---|---|
| rekordbox | XML (lo que ya existe) | playlists, rating, color, comentario, cues de Batea | Preferencias → Avanzado → rekordbox xml |
| Traktor | archivo `.nml` de playlist aparte (nunca se toca `collection.nml`) | playlists, orden; metadatos básicos | Explorador → Playlists → clic derecho → Import Playlist |
| Serato | `.m3u` por caja | solo la lista de temas en orden | arrastrar el `.m3u` al panel de crates |
| Cualquier programa | `.m3u8` | lista de temas | importar o arrastrar |

- Solo se ofrecen destinos de fuentes activas + M3U genérico; los demás aparecen
  apagados con el motivo.
- Escribir `.crate` de Serato queda descartado: Serato 4/5 borra las cajas que su
  base no conoce y rechaza la librería si su SQLite falla el chequeo de integridad.
- Avisos fijos en el diálogo: Traktor tiene que estar cerrado al importar si se
  quiere que lo guarde; en Serato no viajan cues ni etiquetas.
- Por verificar con datos reales antes de prometerlo en la UI: qué metadatos del
  `.nml` de playlist toma Traktor al importar (si pisa o respeta los de la
  colección), y que Serato 4/5 acepte `.m3u` arrastrado.

Backend: `POST /api/export` con `{target: "rekordbox"|"traktor"|"serato"|"m3u",
crate_ids, options}`; `export.py` se divide en `export_rekordbox.py` (lo actual),
`export_traktor.py`, `export_m3u.py`. `/api/export/rekordbox` queda como alias.

## 6. Arquitectura de fuentes (backend)

`batea/sources/` con un adaptador por programa y la misma interfaz:

```python
class LibrarySource(Protocol):
    kind: str
    def discover(self) -> list[SourceLocation]   # rutas encontradas, versión, disco
    def fingerprint(self, loc) -> str             # mtime+tamaño (+WAL) para saber si cambió
    def snapshot(self, loc, cache_dir) -> Path    # copia consistente
    def read(self, snap) -> SourceDump            # temas, cajas, sesiones, reproducciones
    def app_running(self) -> bool
```

- `sources/rekordbox.py`: lo que hoy hace `rbsync.py`, sin cambiar comportamiento.
- `sources/traktor.py`: todas las carpetas `Traktor */`, NML v19/v20, todos los
  `History/*.nml`, fallback al backup si el XML viene cortado.
- `sources/serato4.py`: copia de `master.sqlite`/`root.sqlite`/`location.sqlite`
  con `-wal`/`-shm`, columnas leídas con `PRAGMA table_info`, historial con `played = 1`.
- `sources/serato3.py`: parser TLV (`database V2`, `.crate`, `.session`).
- `sources/serato_tags.py` (opcional al principio): cues/grilla desde los tags del audio.
- `merge.py`: deduplicación y precedencia; `recommend.py` suma las transiciones de
  todas las fuentes (Traktor y Serato aportan además duración de cada mezcla).
- `nowplaying.py`: con Serato 4/5 se puede leer el historial en vivo; con Traktor no
  (solo escribe al cerrar).

Código: lectores propios. traktor-nml-utils y Mixxx son GPL, solo de referencia;
se puede portar de serato-tags / serato-tools / dj-data-converter (MIT).

## 7. Orden y esfuerzo

| Etapa | Qué | Días |
|---|---|---|
| 0 | `sources/` + `track_sources` + rekordbox como adaptador (sin cambios visibles) | 2-3 |
| 1 | Onboarding multifuente + `/api/sources` + panel Fuentes | 2-3 |
| 2 | Traktor (lectura completa + historial) | 3-4 |
| 3 | Barra lateral por programa + chips "de dónde viene" + filtro | 2-3 |
| 4 | Export con destino (rekordbox, Traktor `.nml`, M3U) | 2 |
| 5 | Serato 4/5 | 3-5 |
| 6 | Serato 3.x | 2-3 |
| 7 | Deduplicación completa + conflictos de tono | 3-4 |
| 8 | Tags de Serato (cues/grilla), opcional | 2-3 |

Total ≈ 21-30 días. Etapas 0-4 dejan Traktor funcionando de punta a punta con los
fixtures públicos, sin esperar datos de nadie. Al cerrar cada feature: actualizar
`SLIDES` del Welcome (aparecen Traktor y Serato), `release.sh status`, avisar que
los instaladores quedan desactualizados.

## 8. Datos de prueba

Sin datos reales no se puede cerrar Serato ni validar el export a Traktor.
Pedir, con el programa cerrado: carpeta `~/Documents/Native Instruments/` (Traktor 3
y 4), `~/Library/Application Support/Serato/Library/` + `_Serato_` del disco
(Serato 4/5), `~/Music/_Serato_/` (Serato 3), y 10-20 temas que estén a la vez en
rekordbox y en el otro programa. Alternativas mientras tanto: fixtures de
traktor-nml-utils (solo en local, no al repo público) y Serato DJ Lite instalado en
una carpeta chica de prueba.
