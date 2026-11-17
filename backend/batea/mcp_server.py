"""Servidor MCP de Batea: tu librería disponible para Claude, Codex, T3 o cualquier agente MCP.

    claude mcp add batea -- <batea>/backend/.venv/bin/python -m batea.mcp_server

Lee batea.db directo (funciona con la app cerrada). Lo único que escribe es `crear_caja`,
que agrega una caja nueva; `abrir_en_batea` y `reproducir` mueven la app si está abierta
(o la abren). Nunca toca rekordbox.
"""
from __future__ import annotations

import functools
import sys
import traceback
from typing import Annotated, Callable

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from . import ai_tools, links

INSTRUCTIONS = """\
Batea es el organizador de música de un DJ de techno (también tiene cumbia, reggaeton y otros géneros \
de gigs). Estas herramientas leen su librería real: temas con BPM, tono Camelot, energía 1-10, intro/outro \
en compases, etiquetas, playlists de rekordbox, cajas propias y el historial de sesiones que tocó.

Cómo responder:
- En español rioplatense, directo y concreto.
- Cada tema que nombres va como link markdown a Batea: [Artista – Título](batea://tema/ID), con el ID que \
devolvieron las herramientas (aparece como #ID). Las cajas: [Nombre](batea://caja/ID). Nunca inventes un ID: \
si un tema no salió de una herramienta, no es de la librería; si sugerís algo que no tiene, decilo claro y sin link.
- Las herramientas devuelven líneas como "#123 · Artista – Título · 128 BPM · 8A · E6~ · 6:45 · intro 32c / outro 16c".
  E6~ = energía estimada de la waveform (sin ~ la puso el DJ). "(estimado)" en el tono = calculado por Batea, \
acierta ~6 de cada 10: no lo tomes como seguro. "carpeta X" = carpeta donde está el archivo, suele indicar \
el género o el gig.
- Datos que faltan: el campo género está casi vacío y muchos temas tienen el artista dentro del título. \
Para géneros o vibras, deducí por artista, sello, título, BPM, energía y nombres de carpetas/playlists, \
y aclaralo cuando sea una deducción. No escuchás la música: no afirmes cómo suena algo como si lo supieras.
- Universos: subconjuntos de la librería (por ejemplo «Techno»). Sin el parámetro universo, cada \
herramienta usa el universo activo en la app EN ESE MOMENTO, y el DJ lo puede cambiar en medio de la charla. \
Por eso: si el usuario nombra un universo o pide "toda la librería", pasalo en universo= en TODAS las \
llamadas de esa pregunta (universo="todo" = toda la librería). Cada respuesta empieza con su "Alcance": \
fijate que sea el que corresponde y no mezcles resultados de alcances distintos sin decirlo. \
Si el usuario dice que cambió de universo, volvé a consultar en vez de reusar resultados anteriores.
- Para armar sets: usá el historial (ver_sesion, mi_estilo, compatibles) para respetar cómo mezcla \
este DJ; cuidá BPM (dentro de su tolerancia), tonos compatibles y una curva de energía con sentido. \
Presentá el set en orden, con el porqué de cada transición. Ofrecé guardarlo con crear_caja; \
creá la caja solo si te lo piden.
"""

server = MCPServer(
    name="batea", title="Batea", version="0.3.0", instructions=INSTRUCTIONS,
    description="Librería de DJ de Batea: cajas, historial de sesiones, búsquedas y armado de sets.",
)

READ = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)
UNI_HELP = 'Vacío = el universo activo en la app ahora; "todo" = toda la librería; o el nombre de un universo (ver estado)'



def _run(fn: Callable[..., str]) -> Callable[..., str]:
    """Errores esperables se muestran tal cual; los otros, con un mensaje corto (el detalle va a stderr)."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs) -> str:
        try:
            return fn(*args, **kwargs)
        except ai_tools.ToolError as e:
            raise ToolError(str(e)) from e
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            raise ToolError(f"Error interno de Batea: {type(e).__name__}: {e}") from e
    return wrapper


def _read(fn: Callable, *args, **kwargs) -> str:
    c = ai_tools.connect()
    try:
        return fn(c, *args, **kwargs)
    finally:
        c.close()


# ------------------------------------------------------------------ lectura
@server.tool(annotations=READ)
@_run
def estado() -> str:
    """Resumen de la librería: cantidad de temas, universos (y cuál está activo en la app ahora), qué datos hay y si la app está abierta. Llamala primero."""
    return _read(ai_tools.estado)


@server.tool(annotations=READ)
@_run
def listar_cajas(
    buscar: Annotated[str, Field(description="Parte del nombre de la caja o de su carpeta")] = "",
    tipo: Annotated[str, Field(description="playlist | mia | inteligente | carpeta (vacío = todas)")] = "",
    limite: int = 150,
    universo: Annotated[str, Field(description=UNI_HELP)] = "",
) -> str:
    """Playlists de rekordbox, cajas propias, inteligentes y carpetas de rekordbox, con id y cantidad de temas. No incluye sesiones del historial (usá listar_sesiones)."""
    return _read(ai_tools.listar_cajas, buscar, tipo, limite, universo)


@server.tool(annotations=READ)
@_run
def listar_carpetas(
    buscar: Annotated[str, Field(description="Parte del nombre de la carpeta")] = "",
    universo: Annotated[str, Field(description=UNI_HELP)] = "",
) -> str:
    """Carpetas reales de la Mac y los discos que tienen música, con su clave dir:/ruta para usar en ver_caja."""
    return _read(ai_tools.listar_carpetas, buscar, universo)


@server.tool(annotations=READ)
@_run
def listar_sesiones(
    desde: Annotated[str, Field(description="Fecha AAAA-MM-DD (opcional)")] = "",
    hasta: Annotated[str, Field(description="Fecha AAAA-MM-DD (opcional)")] = "",
    limite: int = 40,
    universo: Annotated[str, Field(description=UNI_HELP)] = "",
) -> str:
    """Noches del historial de rekordbox (de la más nueva a la más vieja), agrupadas por fecha, con temas, rango de BPM y energía media. Con un universo, solo las noches donde al menos la mitad de los temas son de ese universo."""
    return _read(ai_tools.listar_sesiones, desde, hasta, limite, universo)


@server.tool(annotations=READ)
@_run
def ver_caja(
    caja: Annotated[str, Field(description="id, nombre, atajo (inbox, local, recent, top, all), dir:/ruta, artist:Nombre o link batea://")],
    limite: Annotated[int, Field(description="Cuántos temas listar (máx. 400)")] = 150,
    desde: Annotated[int, Field(description="Para paginar: a partir de qué tema")] = 0,
    universo: Annotated[str, Field(description=UNI_HELP)] = "",
) -> str:
    """Una caja, playlist, carpeta o artista: estadísticas (BPM, tonos, energía, artistas, tocados) y sus temas en orden."""
    return _read(ai_tools.ver_caja, caja, limite, desde, universo)


@server.tool(annotations=READ)
@_run
def ver_sesion(
    sesion: Annotated[str, Field(description="id de la sesión o fecha AAAA-MM-DD (junta las partes de esa noche)")],
) -> str:
    """Una noche del historial en el orden en que se tocó: curva de energía y BPM, y cada transición (cambio de BPM, relación de tonos, salto de energía)."""
    return _read(ai_tools.ver_sesion, sesion)


@server.tool(annotations=READ)
@_run
def buscar_temas(
    texto: Annotated[str, Field(description="Palabras en título, artista, álbum, sello, remixer o género")] = "",
    bpm_min: float | None = None,
    bpm_max: float | None = None,
    energia_min: Annotated[int | None, Field(description="1-10")] = None,
    energia_max: Annotated[int | None, Field(description="1-10")] = None,
    tonos: Annotated[list[str] | None, Field(description="Tonos Camelot exactos, ej. ['8A','9A']")] = None,
    compatible_con_tono: Annotated[str, Field(description="Tono Camelot: trae ese y sus compatibles")] = "",
    etiquetas: Annotated[list[str] | None, Field(description="Nombres de etiquetas que tiene que tener, ej. ['Peak time','Dark']")] = None,
    sin_etiquetas: Annotated[list[str] | None, Field(description="Etiquetas que NO tiene que tener")] = None,
    caja: Annotated[str, Field(description="Limitar a una caja (mismo formato que ver_caja)")] = "",
    puntaje_min: Annotated[int | None, Field(description="1-5 estrellas")] = None,
    nunca_tocados: Annotated[bool, Field(description="Solo temas que no aparecen en el historial")] = False,
    orden: Annotated[str, Field(description="reciente | bpm | energia | mas_tocados | puntaje")] = "reciente",
    universo: Annotated[str, Field(description=UNI_HELP)] = "",
    limite: Annotated[int, Field(description="máx. 300")] = 60,
) -> str:
    """Busca temas combinando filtros. Devuelve cuántos hay en total y una línea por tema."""
    return _read(ai_tools.buscar_temas, texto, bpm_min, bpm_max, energia_min, energia_max, tonos,
                 compatible_con_tono, etiquetas, sin_etiquetas, caja, puntaje_min, nunca_tocados, orden,
                 universo, limite)


@server.tool(annotations=READ)
@_run
def ver_tema(id: Annotated[int, Field(description="id del tema (el número después de #)")]) -> str:  # noqa: A002
    """Ficha completa de un tema: datos, etiquetas, en qué cajas está, en qué sesiones lo tocaste y con qué temas lo mezclaste antes y después."""
    return _read(ai_tools.ver_tema, id)


@server.tool(annotations=READ)
@_run
def compatibles(
    id: Annotated[int, Field(description="id del tema de partida")],  # noqa: A002
    caja: Annotated[str, Field(description="Buscar solo dentro de esta caja (opcional)")] = "",
    limite: int = 20,
    universo: Annotated[str, Field(description=UNI_HELP)] = "",
) -> str:
    """Qué tema puede ir después de otro, según BPM, tono, energía, etiquetas y lo que este DJ mezcló de verdad (historial y relaciones marcadas), con el porqué."""
    return _read(ai_tools.compatibles, id, caja, limite, universo)


@server.tool(annotations=READ)
@_run
def mi_estilo(
    bpm: Annotated[float | None, Field(description="Mirar solo transiciones cerca de este BPM (±12%)")] = None,
    universo: Annotated[str, Field(description=UNI_HELP)] = "",
) -> str:
    """Cómo mezcla este DJ según su historial: tolerancia de BPM entre temas seguidos y cuánto respeta la tonalidad."""
    return _read(ai_tools.mi_estilo, bpm, universo)


# ------------------------------------------------------------------ acciones
@server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
@_run
def crear_caja(
    nombre: str,
    ids: Annotated[list[int], Field(description="ids de los temas, en el orden del set")],
) -> str:
    """Guarda una lista de temas como caja nueva en Batea (no modifica nada existente ni rekordbox). Usala solo cuando el usuario lo pida."""
    return ai_tools.crear_caja(nombre, ids)


@server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
@_run
def abrir_en_batea(
    link: Annotated[str, Field(description="batea://tema/ID, batea://caja/ID, batea://carpeta/<ruta> o batea://artista/<nombre>")],
) -> str:
    """Muestra un tema, caja, carpeta o artista en la ventana de Batea (si la app está cerrada, la abre)."""
    return ai_tools.abrir(link)


@server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
@_run
def reproducir(id: Annotated[int, Field(description="id del tema")]) -> str:  # noqa: A002
    """Abre la ficha del tema en Batea y lo reproduce."""
    return ai_tools.abrir(links.track_url(id) + "?play=1")


# ------------------------------------------------------------------ prompts (comandos / en los clientes que los muestran)
@server.prompt(title="Armar un set")
def armar_set(punto_de_partida: str, duracion: str = "1 hora", momento: str = "") -> str:
    """Ideas de set a partir de una caja, carpeta, sesión o género."""
    return (f"Armame un set de {duracion} a partir de: {punto_de_partida}."
            + (f" Momento de la noche: {momento}." if momento else "")
            + " Primero mirá mi estilo y los datos disponibles; después proponé el orden con BPM, tono y energía de cada tema,"
              " el porqué de cada transición y qué temas dudosos conviene escuchar antes. No crees la caja hasta que te lo diga.")


@server.prompt(title="Analizar una sesión")
def analizar_sesion(fecha_o_id: str) -> str:
    """Cómo fue una noche del historial."""
    return (f"Analizá la sesión {fecha_o_id} de mi historial: cómo arranqué y cerré, la curva de energía, las transiciones"
            " más arriesgadas y las que repito en otras noches. Sugerí qué cambiaría para la próxima.")


def main() -> None:
    server.run("stdio")


if __name__ == "__main__":
    main()
