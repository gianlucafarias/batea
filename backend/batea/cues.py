"""Cues y grilla: traer las de rekordbox, guardar las propias y llevarlas al XML.

De dónde sale cada cosa (en orden de confianza):
  1. XML exportado por rekordbox (File → Export Collection in xml format) y traído en Ajustes: es la grilla y las
     cues EXACTAS, tal como rekordbox las escribe. Se guardan crudas (`rb_xml_*`) y se devuelven tal cual.
  2. La base de rekordbox (copia de master.db, espejo `rb_cues`): las posiciones de las cues son exactas, pero la
     grilla no se puede reconstruir igual, así que en ese caso NO se escribe grilla.
  3. Las cues que el DJ edita en Batea (`user_cues`): si un tema tiene `cue_overrides`, mandan estas.

Nada escribe en rekordbox: todo llega por el XML, que rekordbox importa cuando el DJ quiere.

Equivalencias verificadas contra un XML real de rekordbox 6.8.6 (17.843 temas, 6.946 cues, 0 diferencias de posición):
  base `Kind` 0 → `Num` -1 (memory cue) · `Kind` 1,2,3 → `Num` 0,1,2 (pads A,B,C) · `Kind` 5..9 → `Num` 3..7 (pads D..H).
  El `Kind` 4 no aparece como hot cue. Con `OutMsec` > 0 es un loop (`Type` 4). Los hot cues llevan color
  (verde 40,226,20; los loops, naranja 255,140,0); las memory cues no.
"""
from __future__ import annotations

import sqlite3
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

import numpy as np

from . import anlz

HOT_SLOTS = 8                       # pads A..H
KIND_TO_NUM = {0: -1, 1: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7}
NUM_TO_KIND = {v: k for k, v in KIND_TO_NUM.items()}
GREEN = (40, 226, 20)               # color de los hot cues sin color propio
ORANGE = (255, 140, 0)              # color de los loops guardados en un pad


# ------------------------------------------------------------------ rekordbox (base) → espejo
def normalize_rb(kind: int, in_ms: float, out_ms: float | None, comment: str | None) -> dict | None:
    """Una fila de djmdCue → la forma de Batea. None si es un tipo que rekordbox no lleva por XML."""
    num = KIND_TO_NUM.get(kind)
    if num is None:
        return None
    is_loop = out_ms is not None and out_ms > 0
    slot = None if num < 0 else num
    return {"kind": "loop" if is_loop else ("memory" if slot is None else "hot"), "slot": slot,
            "start_ms": float(in_ms), "end_ms": float(out_ms) if is_loop else None, "name": comment or None, "rgb": None}


def read_rb_cues(db_path: Path) -> list[tuple[str, int, float, float | None, str | None]]:
    """(ContentID, Kind, InMsec, OutMsec, Comment) de todas las cues, leyendo una COPIA de master.db."""
    from pyrekordbox import MasterDatabase

    rb = MasterDatabase(path=str(db_path))
    return [(str(q.ContentID), int(q.Kind or 0), float(q.InMsec or 0), None if q.OutMsec in (None, -1) else float(q.OutMsec), q.Comment)
            for q in rb.get_cue()]


def refresh_rb(c: sqlite3.Connection, rows: list[tuple[str, int, float, float | None, str | None]]) -> dict:
    """Rearma el espejo con las cues leídas. Devuelve cuántos temas y cuántas cues."""
    ids = {r["rb_id"]: r["id"] for r in c.execute("SELECT id, rb_id FROM tracks WHERE rb_id IS NOT NULL")}
    c.execute("DELETE FROM rb_cues")
    out = []
    for cid, kind, in_ms, out_ms, comment in rows:
        tid = ids.get(cid)
        if tid is not None:
            out.append((tid, kind, in_ms, out_ms, comment))
    c.executemany("INSERT INTO rb_cues(track_id, kind, in_ms, out_ms, comment) VALUES (?,?,?,?,?)", out)
    return {"cues": len(out), "tracks": len({r[0] for r in out})}


# ------------------------------------------------------------------ XML de rekordbox → exacto
def import_rb_xml(c: sqlite3.Connection, path: Path) -> dict:
    """Guarda la grilla y las cues de cada tema tal como las escribió rekordbox. Lo anterior se reemplaza."""
    from .db import canon_path

    head = path.read_bytes()[:2000].decode("utf-8", "replace")
    if "DJ_PLAYLISTS" not in head:
        raise ValueError("Ese archivo no es un XML de rekordbox")
    by_path = {canon_path(r["path"]): r["id"] for r in c.execute("SELECT id, path FROM tracks WHERE path IS NOT NULL")}
    c.execute("DELETE FROM rb_xml_tempo")
    c.execute("DELETE FROM rb_xml_marks")
    c.execute("DELETE FROM rb_xml_tracks")
    product = None
    seen = matched = with_tempo = with_marks = 0
    tempos: list[tuple] = []
    marks: list[tuple] = []
    covered: list[tuple] = []
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag == "PRODUCT":
            product = f"{el.attrib.get('Name', '')} {el.attrib.get('Version', '')}".strip()
        elif el.tag == "TRACK":
            if "Location" in el.attrib:                      # los TRACK de COLLECTION (los de las playlists solo traen Key)
                seen += 1
                tid = by_path.get(canon_path(unquote(el.attrib["Location"].replace("file://localhost", ""))))
                if tid is not None:
                    matched += 1
                    covered.append((tid,))
                    t_rows = el.findall("TEMPO")
                    m_rows = el.findall("POSITION_MARK")
                    with_tempo += bool(t_rows)
                    with_marks += bool(m_rows)
                    for i, t in enumerate(t_rows):
                        tempos.append((tid, i, t.get("Inizio"), t.get("Bpm"), t.get("Metro"), t.get("Battito")))
                    for i, m in enumerate(m_rows):
                        marks.append((tid, i, m.get("Name", ""), m.get("Type"), m.get("Start"), m.get("End"), m.get("Num"),
                                      m.get("Red"), m.get("Green"), m.get("Blue")))
            el.clear()
    c.executemany("INSERT OR IGNORE INTO rb_xml_tracks(track_id) VALUES (?)", covered)
    c.executemany("INSERT INTO rb_xml_tempo(track_id, idx, inizio, bpm, metro, battito) VALUES (?,?,?,?,?,?)", tempos)
    c.executemany("INSERT INTO rb_xml_marks(track_id, idx, name, type, start, end, num, red, green, blue) VALUES (?,?,?,?,?,?,?,?,?,?)", marks)
    stats = {"product": product, "tracks": matched, "with_grid": with_tempo, "with_cues": with_marks, "not_found": seen - matched,
             "cues": len(marks), "path": str(path)}
    c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('cues_xml', ?)", (_json(stats),))
    return stats


def _json(d: dict) -> str:
    import json
    return json.dumps(d)


def xml_status(c: sqlite3.Connection) -> dict:
    import json
    row = c.execute("SELECT value FROM meta WHERE key='cues_xml'").fetchone()
    mirror = c.execute("SELECT COUNT(*), COUNT(DISTINCT track_id) FROM rb_cues").fetchone()
    return {"xml": json.loads(row[0]) if row else None, "mirror": {"cues": mirror[0], "tracks": mirror[1]}}


def mapping_report(c: sqlite3.Connection) -> dict:
    """¿La equivalencia Kind→Num coincide con el XML importado? Compara posición por posición (si hay espejo)."""
    pairs: Counter = Counter()
    for tid in [r[0] for r in c.execute("SELECT DISTINCT track_id FROM rb_cues")]:
        xm = c.execute("SELECT num, start FROM rb_xml_marks WHERE track_id=?", (tid,)).fetchall()
        if not xm:
            continue
        for q in c.execute("SELECT kind, in_ms FROM rb_cues WHERE track_id=?", (tid,)):
            hits = {m["num"] for m in xm if abs(float(m["start"]) * 1000 - q["in_ms"]) <= 2}
            if len(hits) == 1:
                pairs[(q["kind"], int(next(iter(hits))))] += 1
    unexpected = {f"{k}->{n}": v for (k, n), v in pairs.items() if KIND_TO_NUM.get(k) != n}
    return {"compared": sum(pairs.values()), "unexpected": unexpected, "ok": not unexpected and bool(pairs)}


# ------------------------------------------------------------------ lectura unificada
def _from_xml_row(r: sqlite3.Row) -> dict:
    num = int(r["num"])
    loop = r["type"] == "4"
    slot = None if num < 0 else num
    rgb = (int(r["red"]), int(r["green"]), int(r["blue"])) if r["red"] is not None else None
    return {"kind": "loop" if loop else ("memory" if slot is None else "hot"), "slot": slot,
            "start_ms": round(float(r["start"]) * 1000, 3), "end_ms": round(float(r["end"]) * 1000, 3) if r["end"] else None,
            "name": r["name"] or None, "rgb": rgb}


def effective(c: sqlite3.Connection, tid: int) -> tuple[str, list[dict]]:
    """('batea' | 'rekordbox-xml' | 'rekordbox' | 'none', cues ordenadas por posición)."""
    if c.execute("SELECT 1 FROM cue_overrides WHERE track_id=?", (tid,)).fetchone():
        rows = c.execute("SELECT kind, slot, start_ms, end_ms, name, color FROM user_cues WHERE track_id=? ORDER BY start_ms, id", (tid,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            col = d.pop("color")
            d["rgb"] = tuple(int(x) for x in col.split(",")) if col else None
            out.append(d)
        return "batea", out
    xm = c.execute("SELECT * FROM rb_xml_marks WHERE track_id=? ORDER BY idx", (tid,)).fetchall()
    if xm:
        return "rekordbox-xml", sorted((_from_xml_row(r) for r in xm), key=lambda q: q["start_ms"])
    rows = c.execute("SELECT kind, in_ms, out_ms, comment FROM rb_cues WHERE track_id=? ORDER BY in_ms, id", (tid,)).fetchall()
    cues = [q for q in (normalize_rb(r["kind"], r["in_ms"], r["out_ms"], r["comment"]) for r in rows) if q]
    return ("rekordbox" if cues else "none"), cues


def save_user(c: sqlite3.Connection, tid: int, cues: list[dict]) -> None:
    """Reemplaza las cues propias del tema; desde ahí mandan por sobre las de rekordbox."""
    clean = []
    for q in cues:
        kind = q.get("kind")
        if kind not in ("memory", "hot", "loop"):
            raise ValueError("Tipo de cue inválido")
        start = float(q["start_ms"])
        end = float(q["end_ms"]) if q.get("end_ms") is not None else None
        if start < 0 or (kind == "loop" and (end is None or end <= start)):
            raise ValueError("Posición inválida")
        slot = q.get("slot")
        if kind == "hot" or (kind == "loop" and slot is not None):
            if slot is None or not 0 <= int(slot) < HOT_SLOTS:
                raise ValueError("El pad tiene que ser de A a H")
            slot = int(slot)
        else:
            slot = None
        rgb = q.get("rgb")
        if rgb is not None and (len(rgb) != 3 or any(not 0 <= int(x) <= 255 for x in rgb)):
            raise ValueError("Color inválido")
        clean.append((tid, kind, slot, start, end, (q.get("name") or None), ",".join(str(int(x)) for x in rgb) if rgb else None))
    slots = [q[2] for q in clean if q[2] is not None]
    if len(slots) != len(set(slots)):
        raise ValueError("Hay dos cues en el mismo pad")
    c.execute("DELETE FROM user_cues WHERE track_id=?", (tid,))
    c.executemany("INSERT INTO user_cues(track_id, kind, slot, start_ms, end_ms, name, color) VALUES (?,?,?,?,?,?,?)", clean)
    c.execute("INSERT OR REPLACE INTO cue_overrides(track_id) VALUES (?)", (tid,))


def reset_user(c: sqlite3.Connection, tid: int) -> None:
    """Vuelve a las cues de rekordbox (las propias se descartan)."""
    c.execute("DELETE FROM user_cues WHERE track_id=?", (tid,))
    c.execute("DELETE FROM cue_overrides WHERE track_id=?", (tid,))


# ------------------------------------------------------------------ grilla
def xml_tempo(c: sqlite3.Connection, tid: int) -> list[dict]:
    """La grilla tal como la escribió rekordbox (vacía si no se trajo el XML)."""
    return [dict(r) for r in c.execute("SELECT inizio, bpm, metro, battito FROM rb_xml_tempo WHERE track_id=? ORDER BY idx", (tid,))]


def user_grid(c: sqlite3.Connection, tid: int) -> dict | None:
    r = c.execute("SELECT inizio, bpm, battito FROM user_grids WHERE track_id=?", (tid,)).fetchone()
    return dict(r) if r else None


def save_user_grid(c: sqlite3.Connection, tid: int, inizio: float, bpm: float, battito: int) -> None:
    """Grilla fija corregida a mano. Reemplaza a la de rekordbox en el XML y en la mezcla."""
    if not 40 <= bpm <= 300:
        raise ValueError("El BPM tiene que estar entre 40 y 300")
    if battito not in (1, 2, 3, 4):
        raise ValueError("El beat del compás va de 1 a 4")
    c.execute("INSERT OR REPLACE INTO user_grids(track_id, inizio, bpm, battito) VALUES (?,?,?,?)", (tid, float(inizio), float(bpm), int(battito)))


def reset_user_grid(c: sqlite3.Connection, tid: int) -> None:
    c.execute("DELETE FROM user_grids WHERE track_id=?", (tid,))


def grid_downbeats(g: dict, duration: float) -> list[float]:
    """Tiempos (s) del primer beat de cada compás de una grilla fija."""
    beat = 60.0 / g["bpm"]
    first = g["inizio"] - (g["battito"] - 1) * beat            # donde cae el "1" del compás de referencia
    bar = 4 * beat
    t = first - (first // bar) * bar                           # el primer compás que empieza en >= 0
    out = []
    while t <= duration:
        out.append(round(t, 4))
        t += bar
    return out


def pqtz_segments(anlz_dir: str | None) -> list[dict]:
    """Grilla del archivo de análisis (PQTZ), partida donde cambia el tempo. SOLO para mostrar: rekordbox parte la
    grilla con otro criterio (con su XML coincide en ~59 % de los temas), así que no se escribe en el XML."""
    if not anlz_dir:
        return []
    dat = anlz._read(Path(anlz_dir) / "ANLZ0000.DAT")
    if not dat:
        return []
    tags = anlz._tags(dat)
    if "PQTZ" not in tags:
        return []
    off, lh, lt = tags["PQTZ"]
    count = (lt - lh) // 8
    if count <= 0:
        return []
    raw = np.frombuffer(dat, dtype=np.dtype([("beat", ">u2"), ("tempo", ">u2"), ("time", ">u4")]), count=count, offset=off + lh)
    out: list[dict] = []
    last = None
    for r in raw:
        if int(r["tempo"]) != last:
            out.append({"inizio": f"{int(r['time']) / 1000.0:.3f}", "bpm": f"{int(r['tempo']) / 100.0:.2f}", "metro": "4/4", "battito": str(int(r["beat"]))})
            last = int(r["tempo"])
    return out


# ------------------------------------------------------------------ al XML
def _attrs(q: dict) -> dict:
    slot = q.get("slot")
    m = {"Name": q.get("name") or "", "Type": "4" if q["kind"] == "loop" else "0",
         "Start": f"{q['start_ms'] / 1000:.3f}", "Num": str(-1 if slot is None else slot)}
    if q["kind"] == "loop":
        m["End"] = f"{q['end_ms'] / 1000:.3f}"
    if slot is not None:                                   # los pads llevan color; las memory cues no
        r, g, b = q.get("rgb") or (ORANGE if q["kind"] == "loop" else GREEN)
        m.update(Red=str(r), Green=str(g), Blue=str(b))
    return m


def track_payload(c: sqlite3.Connection, tid: int) -> dict:
    """Lo que se escribe para un tema. `exact`: el tema está cubierto por el XML de rekordbox (grilla y cues exactas)."""
    source, cues = effective(c, tid)
    mine = user_grid(c, tid)
    tempo = ([{"inizio": f"{mine['inizio']:.3f}", "bpm": f"{mine['bpm']:.2f}", "metro": "4/4", "battito": str(mine["battito"])}]
             if mine else xml_tempo(c, tid))
    return {"source": source, "tempo": tempo, "marks": [_attrs(q) for q in cues], "grid_bpm": mine["bpm"] if mine else None,
            "exact": bool(mine) or c.execute("SELECT 1 FROM rb_xml_tracks WHERE track_id=?", (tid,)).fetchone() is not None}
