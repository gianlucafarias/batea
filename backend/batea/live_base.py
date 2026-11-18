"""Contrato común para "qué está sonando ahora" en cada programa de DJ.

Cada lector en vivo (rekordbox, Serato, Traktor) expone:

    APP: str                                  # 'rekordbox' | 'serato' | 'traktor'
    LABEL: str                                # 'rekordbox' | 'Serato' | 'Traktor'
    def running() -> bool                     # el programa está abierto en esta Mac (pgrep, barato)
    def read(c: sqlite3.Connection) -> LiveReading | None

`read` nunca escribe en los archivos del programa: copia lo que necesite a
config.APP_DIR / f"{APP}-live" y lee la copia, con un límite de frecuencia propio
(no copiar una base en cada llamada; el ícono de la barra pregunta cada pocos segundos).

nowplaying.py elige qué programa leer (el que está abierto; si hay varios, el de
actividad más reciente), traduce rutas o título/artista a temas de Batea y arma
las recomendaciones. Los lectores no tocan batea.db salvo para leer.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class PlayRef:
    """Un tema que el programa cargó o tocó. Alcanza con la ruta; si no hay ruta
    (p. ej. Traktor por Broadcasting solo manda artista y título), se usa título/artista."""
    path: str | None = None
    title: str | None = None
    artist: str | None = None
    deck: int | None = None
    start: float | None = None        # epoch, si se sabe


@dataclass
class LiveReading:
    app: str
    now: PlayRef | None = None                              # lo que está sonando al aire, si el programa lo dice
    loaded: list[PlayRef] = field(default_factory=list)     # cargados en decks, el más reciente primero
    played: list[PlayRef] = field(default_factory=list)     # lo que ya sonó en esta sesión, en orden
    session: str | None = None                              # nombre/fecha de la sesión
    activity: float = 0.0                                   # epoch de la última novedad (para elegir entre varios programas)
    note: str | None = None                                 # aviso corto para la UI ("Activá Broadcasting en Traktor…")
