"""Fixtures sintéticos basados en las columnas y tags de las notas de Serato."""
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import struct

MASTER = Path("Library/Application Support/Serato/Library/master.sqlite")
LEGACY = Path("Music/_Serato_")
SHARD = Path("_Serato_/Library/location.sqlite")
VOLUME = "Disco de sesión"
BASS = "Users/fixture/Music/Bajo Ámbar.aiff"
GARDEN = "Sets/Jardín.flac"
SUN = "Users/fixture/Music/Sol.mp3"
LOAD_ONLY = "Users/fixture/Music/Carga.mp3"
START = 1_700_000_000

LEGACY_VERSION = "2.0/Serato Scratch LIVE Database"


def record(tag, data):
    if isinstance(data, str):
        data = data.encode("utf-16-be")
    elif isinstance(data, bool):
        data = struct.pack(">B", data)
    elif isinstance(data, int):
        data = struct.pack(">H" if tag.startswith("s") else ">I", data)
    return struct.pack(">4sI", tag.encode("ascii"), len(data)) + data


def adat(tag, fields):
    payload = bytearray()
    for number, value in fields.items():
        data = value.encode("utf-16-be") if isinstance(value, str) else struct.pack(">I", value)
        payload += struct.pack(">II", number, len(data)) + data
    return record(tag, record("adat", bytes(payload)))


def play(path, start, *, played=1, **metadata):
    values = {2: path, 28: start, 50: played}
    fields = dict(title=6, artist=7, bpm=15, end=29, deck=31, seconds=45, key=51)
    values.update({fields[key]: value for key, value in metadata.items()})
    return adat("oent", values)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def legacy_library(home, volume):
    serato = home / LEGACY
    bass = b"".join(record(tag, value) for tag, value in {
        "pfil": BASS, "tsng": "Bajo (versión 3)", "tart": "Dúo", "talb": "Isla",
        "tgen": "House", "tbpm": "123.50", "tkey": "Abm", "tcom": "Entrada fría", "tlbl": "Río",
        "uadd": START, "utpc": 7, "ulbl": 0x123ABC, "tlen": "03:12.5", "tsiz": "2.5MB", "bmis": True,
        "tbit": "320.0kbps", "ttyr": "2020", "txyz": "campo adicional",
    }.items())
    sun = record("pfil", SUN) + record("tsng", "Sol") + record("ufsb", 12345)
    loaded = record("pfil", LOAD_ONLY) + record("tsng", "Carga")
    write(serato / "database V2", record("vrsn", LEGACY_VERSION) + record("otrk", bass)
          + record("otrk", sun) + record("otrk", loaded) + record("otrk", b"truncado")[:-2])
    write(volume / "_Serato_/database V2",
          record("vrsn", LEGACY_VERSION) + record("otrk", record("pfil", GARDEN) + record("tsng", "Jardín 3")))

    def crate(name, *paths):
        write(serato / f"Subcrates/{name}.crate",
              record("vrsn", "1.0/Serato ScratchLive Crate")
              + b"".join(record("otrk", record("ptrk", path)) for path in paths))

    crate("Cajas", BASS)
    crate("Cajas%%Tarde%%Apertura", SUN, BASS, SUN)
    crate("Archivo")
    write(volume / "_Serato_/Subcrates/Cajas%%Tarde%%Apertura.crate",
          record("otrk", record("ptrk", GARDEN)))
    write(serato / "neworder.pref", ("[begin record]\n[crate]Cajas%%Tarde%%Apertura\n"
                                  "[crate]Archivo.crate\n[crate]Cajas\n"
                                  "[crate]Cálidas\n[end record]").encode("utf-16-be"))
    write(serato / "SmartCrates/Cálidas.scrate",
          record("vrsn", "1.0/Serato ScratchLive Smart Crate")
          + record("rart", record("brut", True))
          + record("rlut", record("brut", False))
          + record("rurt", record("urkt", 9) + record("trft", "cond_con_str") + record("trpt", "Música"))
          + record("rurt", record("urkt", 15) + record("trft", "cond_greq_uint") + record("urpt", 110)))

    history = serato / "History"
    write(history / "history.database", adat("oses", {1: 42, 41: "Noche antigua", 43: START}))
    write(history / "Sessions/42.session",
          record("vrsn", "1.0/Serato ScratchLive History Session")
          + play("/" + SUN, START + 30, title="Sol de archivo", bpm=121, seconds=14, key="1d")
          + play("/" + LOAD_ONLY, START + 10, played=0, title="Solo cargado")
          + play("/" + BASS, START + 1, title="Bajo de archivo", artist="Dúo de archivo", bpm=124,
                 end=START + 29, seconds=20, deck=2, key="G#m")
          + play(str(volume / GARDEN), START + 60, title="Jardín de archivo", end=0xFFFFFFFF,
                 seconds=18, key="6m"))
    write(history / "Sessions/99.session",
          play("/Users/fixture/Music/Borrado.mp3", START - 600, title="Borrado", artist="Dúo"))
    return serato


@contextmanager
def database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    try:
        yield con
        con.commit()
    finally:
        con.close()


@contextmanager
def modern_library(home, volume):
    master = home / MASTER
    with database(master.with_name("root.sqlite")) as con:
        con.executescript("""
            CREATE TABLE asset(id INTEGER, portable_id TEXT, name TEXT, bpm REAL, key TEXT);
            INSERT INTO asset VALUES
                (1, 'Users/fixture/Music/Sol.mp3', 'Sol 4', 121, '1d'),
                (2, 'Users/fixture/Music/Carga.mp3', 'Carga', 119, 'C');
        """)
    with database(volume / SHARD) as con:
        con.executescript("""
            CREATE TABLE asset(id INTEGER, portable_id TEXT, name TEXT, length_sec REAL, key TEXT,
                               location_id INTEGER, surprise TEXT);
            INSERT INTO asset VALUES (1, 'Sets/Jardín.flac', 'Jardín 4', 211.5, 'D♭ minor', 2, 'omitir');
            CREATE TABLE container(id INTEGER, name TEXT, type INTEGER, list_order INTEGER);
            INSERT INTO container VALUES (10, 'SSD', 1, 0);
            CREATE TABLE container_asset(container_id INTEGER, asset_id INTEGER, list_order INTEGER);
            INSERT INTO container_asset VALUES (10, 1, 0);
        """)

    with database(master) as con:
        con.executescript("""
            CREATE TABLE location(id INTEGER, path TEXT);
            CREATE TABLE connection(location_id INTEGER, database_uri TEXT);
            CREATE TABLE asset(id INTEGER, location_id INTEGER, portable_id TEXT, file_name TEXT, name TEXT,
                               artist TEXT, comments TEXT, album TEXT, genre TEXT, key TEXT, key_value INTEGER,
                               bpm REAL, rating REAL, color INTEGER, time_added INTEGER, dj_play_count INTEGER,
                               length_ms INTEGER, file_size INTEGER, is_missing INTEGER, new_field TEXT);
            CREATE TABLE space(id INTEGER, name TEXT);
            INSERT INTO space VALUES (1, 'Serato Library'), (2, 'Serato Prepare');
            CREATE TABLE container(id INTEGER, parent_id INTEGER, name TEXT, type, list_order INTEGER, space_id INTEGER);
            INSERT INTO container VALUES
                (100, NULL, 'Library', 0, 0, 1),
                (10, 100, 'Cajas', 1, 2, 1),
                (11, 10, 'Cruces', 1, 0, 1),
                (12, 100, 'Cálidas', 2, 3, 1),
                (13, 100, 'Vacía', 'folder', 1, 1),
                (14, 100, 'Padre sin temas', 1, 4, 1),
                (15, 14, 'Hijo', 1, 0, 1),
                (16, 100, 'Prepare', 1, 0, 2);
            CREATE TABLE location_container(id INTEGER, location_id INTEGER, container_id INTEGER);
            INSERT INTO location_container VALUES (51, 1, 10), (52, 11, 11), (53, 1, 11);
            CREATE TABLE container_asset(location_container_id INTEGER, asset_id INTEGER, list_order INTEGER);
            INSERT INTO container_asset VALUES (51, 1, 0), (53, 1, 10), (52, 1, 2);
            CREATE TABLE smart_crate_rules(container_id INTEGER, rules TEXT);
            INSERT INTO smart_crate_rules VALUES (12, '{"rules":[{"field":"bpm","value":120}]}');
            CREATE TABLE history_session(id INTEGER, name TEXT, start_time INTEGER);
            CREATE TABLE history_entry(id INTEGER, session_id INTEGER, asset_id INTEGER, location_id INTEGER,
                                       portable_id TEXT, file_name TEXT, name TEXT, artist TEXT, bpm REAL, key TEXT,
                                       deck TEXT, start_time INTEGER, end_time INTEGER, played INTEGER);
        """)
        con.execute("INSERT INTO location VALUES (1, ''), (11, '')")
        con.executemany("INSERT INTO connection VALUES (?,?)", [
            (1, str(master.with_name("root.sqlite"))),
            (11, (volume / SHARD).as_uri()),
        ])
        con.commit()
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA wal_autocheckpoint=0")
        con.execute(
            "INSERT INTO asset VALUES (1, 1, ?, 'Bajo Ámbar.aiff', 'Bajo 4', 'Dúo', 'Remaster', 'Isla',"
            " 'House', 'Am', 14, 127.25, 0.7, 1122867, ?, 13, 192500, 20155, 0, 'nueva')", (BASS, START)
        )
        con.execute("INSERT INTO history_session VALUES (1, 'Sesión de club', ?)", (START,))
        con.executemany("INSERT INTO history_entry VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            (3, 1, 1, 11, GARDEN, None, "Jardín en vivo", "Dúo", 126, "8A", "C", START + 60, -1, 1),
            (1, 1, 1, 1, BASS, None, "Bajo en vivo", "Dúo", 128, "Am", "A", START + 1, START + 29, 1),
            (2, 1, None, 1, LOAD_ONLY, None, "Solo cargado", None, 120, None, "2", START + 10, 0, 0),
            (4, 1, 1, None, SUN, None, "Sol en vivo", None, 121, "1d", "4", START + 90, 0, 1),
            (5, 1, None, 11, "Sets/Borrado.wav", None, "Corte", None, 110, "Cm", "2", START + 120, None, 1),
        ])
        con.commit()
        yield master
