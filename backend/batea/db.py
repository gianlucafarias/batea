"""Base de datos propia de Batea (SQLite).

Los campos que vienen de rekordbox se pisan en cada sincronización; los campos
del usuario (rating, energía, notas, etiquetas, relaciones, cajas propias)
nunca se tocan al sincronizar.
"""
from __future__ import annotations

import sqlite3
import time
import unicodedata
from contextlib import contextmanager
from typing import Iterator

from . import config

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    rb_id TEXT UNIQUE,
    path TEXT,
    title TEXT, artist TEXT, album TEXT, label TEXT, genre TEXT, remixer TEXT,
    bpm REAL, key TEXT, key_raw TEXT, duration REAL,
    rb_rating INTEGER, rb_color TEXT, rb_comment TEXT,
    year INTEGER, bitrate INTEGER, filetype TEXT,
    artwork TEXT, anlz_dir TEXT,
    date_added TEXT, play_count INTEGER DEFAULT 0, last_played TEXT,
    source TEXT NOT NULL DEFAULT 'rekordbox',      -- rekordbox | traktor | serato… | local (= no está en ningún programa)
    -- análisis (rekordbox ANLZ o audio propio)
    energy_raw REAL, energy_auto INTEGER,
    intro_bars INTEGER, outro_bars INTEGER, breaks INTEGER,
    analyzed TEXT,                                   -- anlz | audio
    -- campos del usuario
    rating INTEGER, energy INTEGER, notes TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);
CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    color TEXT,
    source TEXT NOT NULL DEFAULT 'user',             -- user | rekordbox
    rb_id TEXT UNIQUE,
    position INTEGER DEFAULT 0,
    UNIQUE(name, category)
);

CREATE TABLE IF NOT EXISTS track_tags (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'user',             -- user | auto | rekordbox
    PRIMARY KEY (track_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_track_tags_tag ON track_tags(tag_id);

-- kind: mix | similar | mashup | avoid (simétricas, a<b) ; history (dirigida a->b)
CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY,
    a INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    b INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',             -- user | history | feedback
    weight REAL NOT NULL DEFAULT 1,
    count INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(a, b, kind, source)
);
CREATE INDEX IF NOT EXISTS idx_rel_a ON relations(a);
CREATE INDEX IF NOT EXISTS idx_rel_b ON relations(b);

-- kind: folder | playlist | smart_rb | session_folder | session | user | smart
CREATE TABLE IF NOT EXISTS crates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    parent_id INTEGER REFERENCES crates(id) ON DELETE CASCADE,
    rb_id TEXT UNIQUE,
    position INTEGER DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    query TEXT,
    date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crate_tracks (
    crate_id INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (crate_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_crate_tracks_track ON crate_tracks(track_id);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Un registro por programa de origen (rekordbox, traktor, serato…): no se pisa un BPM con otro
CREATE TABLE IF NOT EXISTS track_sources (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    ext_id TEXT, path_raw TEXT,
    bpm REAL, key_raw TEXT, key_camelot TEXT,
    rating REAL, color TEXT, play_count INTEGER,
    date_added TEXT, last_played TEXT, comment TEXT,
    cues_json TEXT, grid_json TEXT, synced_at TEXT,
    PRIMARY KEY (track_id, source)
);
CREATE INDEX IF NOT EXISTS idx_track_sources_ext ON track_sources(source, ext_id);

-- Universos: subconjuntos de trabajo (ej. "Techno") definidos por cajas/carpetas
CREATE TABLE IF NOT EXISTS universes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    crate_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""

# Columnas agregadas después de la v0.1 (tabla, columna, declaración)
MIGRATIONS = [
    ("tracks", "reviewed", "TEXT"),
    ("tracks", "key_source", "TEXT"),      # rekordbox | batea | tag
    ("tags", "hotkey", "TEXT"),
    ("tracks", "meta_user", "INTEGER"),    # 1 = título/artista/etc. editados a mano: el análisis no los pisa
    ("crates", "source", "TEXT"),          # user | rekordbox | traktor | serato…
]

DEFAULT_HOTKEYS = {
    "Opener": "o", "Warm-up": "w", "Build": "b", "Peak time": "p", "Closing": "c", "After": "f",
    "Dark": "d", "Hipnótico": "h", "Acid": "a", "Melódico": "m", "Industrial": "i", "Groovy": "g",
    "Raw": "r", "Deep": "e", "Eufórico": "u", "Percusivo": "k",
    "Vocal": "v", "Vocal chop": "j", "Spoken word": "s", "Sin voz": "n",
    "Mashup": "x", "Acapella": "q", "Tool / Loop": "t", "Instrumental": "l",
}

DEFAULT_TAGS: dict[str, list[tuple[str, str]]] = {
    "estructura": [
        ("Intro larga", "#7dd3fc"), ("Intro corta", "#38bdf8"),
        ("Outro larga", "#a5b4fc"), ("Outro corta", "#818cf8"),
        ("Break largo", "#c4b5fd"), ("Sin break", "#ddd6fe"),
        ("Intro DJ (beat solo)", "#67e8f9"),
    ],
    "versión": [
        ("Original", "#d4d4d8"), ("Extended", "#e4e4e7"), ("Remix", "#fda4af"),
        ("Edit", "#fdba74"), ("Mashup", "#f472b6"), ("Bootleg", "#fb7185"),
        ("Dub", "#94a3b8"), ("Acapella", "#fde047"), ("Instrumental", "#bef264"),
        ("Tool / Loop", "#86efac"),
    ],
    "voz": [
        ("Vocal", "#facc15"), ("Vocal chop", "#fcd34d"), ("Spoken word", "#fbbf24"),
        ("Sin voz", "#a8a29e"),
    ],
    "momento": [
        ("Opener", "#5eead4"), ("Warm-up", "#2dd4bf"), ("Build", "#f59e0b"),
        ("Peak time", "#ef4444"), ("Closing", "#a78bfa"), ("After", "#64748b"),
    ],
    "vibra": [
        ("Dark", "#71717a"), ("Hipnótico", "#22d3ee"), ("Acid", "#a3e635"),
        ("Melódico", "#f0abfc"), ("Industrial", "#78716c"), ("Groovy", "#fb923c"),
        ("Raw", "#dc2626"), ("Deep", "#3b82f6"), ("Eufórico", "#facc15"),
        ("Percusivo", "#f97316"),
    ],
}


def connect() -> sqlite3.Connection:
    c = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    return c


@contextmanager
def conn() -> Iterator[sqlite3.Connection]:
    c = connect()
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def backup(keep: int = 10, min_hours: float = 12) -> None:
    """Copia de seguridad de la base (etiquetas, relaciones, cajas) antes de tocar nada."""
    if not config.DB_PATH.exists():
        return
    d = config.APP_DIR / "backups"
    d.mkdir(parents=True, exist_ok=True)
    existing = sorted(d.glob("batea-*.db"))
    if existing and time.time() - existing[-1].stat().st_mtime < min_hours * 3600:
        return
    dst = d / f"batea-{time.strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(config.DB_PATH)
    out = sqlite3.connect(dst)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    for old in sorted(d.glob("batea-*.db"))[:-keep]:
        old.unlink(missing_ok=True)


def canon_path(p: str | None) -> str | None:
    """Ruta canónica para comparar archivos entre programas: NFC (macOS guarda NFD) y sin mayúsculas."""
    return unicodedata.normalize("NFC", p).casefold() if p else None


def free_hotkey(c: sqlite3.Connection, name: str) -> str | None:
    """Primera letra libre del nombre (sin acentos), para etiquetas nuevas."""
    used = {r[0] for r in c.execute("SELECT hotkey FROM tags WHERE hotkey IS NOT NULL")}
    plain = unicodedata.normalize("NFD", name.lower())
    for ch in plain:
        if "a" <= ch <= "z" and ch not in used:
            return ch
    return None


def init() -> None:
    config.ensure_dirs()
    try:
        backup()
    except Exception:  # noqa: BLE001  (un respaldo fallido no debe impedir abrir la app)
        pass
    with conn() as c:
        c.executescript(SCHEMA)
        for table, col, decl in MIGRATIONS:
            cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        c.execute("UPDATE tracks SET key_source='rekordbox' WHERE key IS NOT NULL AND key_source IS NULL AND source='rekordbox'")
        # cajas de programas: rekordbox usa pl:/h:, el resto <programa>:…; lo demás son cajas propias
        c.execute("UPDATE crates SET source='rekordbox' WHERE source IS NULL AND (rb_id LIKE 'pl:%' OR rb_id LIKE 'h:%')")
        c.execute("UPDATE crates SET source='user' WHERE source IS NULL")
        n = c.execute("SELECT COUNT(*) FROM tags WHERE source='user'").fetchone()[0]
        if n == 0:
            pos = 0
            for cat, tags in DEFAULT_TAGS.items():
                for name, color in tags:
                    c.execute(
                        "INSERT OR IGNORE INTO tags(name, category, color, source, position) VALUES (?,?,?,?,?)",
                        (name, cat, color, "user", pos),
                    )
                    pos += 1
        if get_meta(c, "hotkeys_seeded") is None:
            for name, key in DEFAULT_HOTKEYS.items():
                c.execute("UPDATE tags SET hotkey=? WHERE name=? AND source='user' AND hotkey IS NULL", (key, name))
            set_meta(c, "hotkeys_seeded", "1")


def get_meta(c: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r[0] if r else default


def set_meta(c: sqlite3.Connection, key: str, value: str) -> None:
    c.execute("INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
