"""Arma librerías de Traktor y Serato de PRUEBA con temas reales de una carpeta.

Sirve para probar el flujo multifuente sin tener Traktor ni Serato: genera un
collection.nml + historial de Traktor y un _Serato_ (formato 3.x) con playlists
y sesiones, apuntando a archivos que existen, así los temas suenan en Batea.

Solo escribe dentro de --out. Nunca toca los archivos de música ni las
librerías reales de ningún programa.

    python scripts/demo_fuentes.py --music ~/Music/Algo --out /tmp/batea-demo
"""
from __future__ import annotations

import argparse
import random
import struct
import sys
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from batea.export_traktor import _key_table, boot_volume_name, split_location  # noqa: E402

AUDIO = {".mp3", ".wav", ".aif", ".aiff", ".flac", ".m4a"}
CAMELOT = [f"{n}{l}" for n in range(1, 13) for l in "AB"]


def read_meta(p: Path) -> dict:
    meta = {"title": p.stem, "artist": None, "duration": None}
    if " - " in p.stem:
        meta["artist"], meta["title"] = p.stem.split(" - ", 1)
    try:
        import mutagen
        f = mutagen.File(p, easy=True)
        if f is not None:
            meta["duration"] = int(f.info.length) if getattr(f, "info", None) else None
            meta["title"] = (f.get("title") or [meta["title"]])[0]
            meta["artist"] = (f.get("artist") or [meta["artist"]])[0]
    except Exception:  # noqa: BLE001
        pass
    return meta


def pick_tracks(music: Path, n: int, rng: random.Random) -> list[dict]:
    files = sorted(p for p in music.rglob("*") if p.suffix.lower() in AUDIO and not p.name.startswith("._"))
    if not files:
        sys.exit(f"No encontré audio en {music}")
    files = rng.sample(files, min(n, len(files)))
    out = []
    for p in files:
        m = read_meta(p)
        if m["duration"] is not None and m["duration"] < 120:
            continue
        m.update(path=str(p), bpm=round(rng.uniform(122, 134), 2), key=rng.choice(CAMELOT),
                 rating=rng.choice([0, 3, 4, 5]))
        out.append(m)
    return out


# ------------------------------------------------------------------ Traktor
def write_traktor(root: Path, tracks: list[dict], sessions: list[list[dict]], start: datetime) -> Path:
    folder = root / "Traktor 4.5.1"
    (folder / "History").mkdir(parents=True, exist_ok=True)
    boot = boot_volume_name()
    keyval = _key_table()

    def entry(coll: ET.Element, t: dict) -> str:
        v, d, f = split_location(t["path"], boot)
        e = ET.SubElement(coll, "ENTRY", TITLE=t["title"] or "", ARTIST=t["artist"] or "")
        ET.SubElement(e, "LOCATION", DIR=d, FILE=f, VOLUME=v, VOLUMEID=v)
        info = {"PLAYCOUNT": "1", "IMPORT_DATE": start.strftime("%Y/%-m/%-d"), "RANKING": str(t["rating"] * 51)}
        if t["duration"]:
            info["PLAYTIME"] = str(t["duration"])
        ET.SubElement(e, "INFO", **info)
        ET.SubElement(e, "TEMPO", BPM=f"{t['bpm']:.6f}", BPM_QUALITY="100.000000")
        if t["key"] in keyval:
            ET.SubElement(e, "MUSICAL_KEY", VALUE=str(keyval[t["key"]]))
        ET.SubElement(e, "CUE_V2", NAME="AutoGrid", DISPL_ORDER="0", TYPE="4", START="120.0", LEN="0", REPEATS="-1", HOTCUE="-1")
        ET.SubElement(e, "CUE_V2", NAME="Drop", DISPL_ORDER="0", TYPE="0", START="64000.0", LEN="0", REPEATS="-1", HOTCUE="1", COLOR="#FF8000")
        return v + d + f

    def nml(build_playlists) -> ET.Element:
        root_el = ET.Element("NML", VERSION="20")
        ET.SubElement(root_el, "HEAD", COMPANY="www.native-instruments.com", PROGRAM="Traktor Pro 4")
        coll = ET.SubElement(root_el, "COLLECTION")
        keys = [entry(coll, t) for t in build_playlists["tracks"]]
        coll.set("ENTRIES", str(len(keys)))
        pls = ET.SubElement(root_el, "PLAYLISTS")
        top = ET.SubElement(pls, "NODE", TYPE="FOLDER", NAME="$ROOT")
        build_playlists["fill"](top, dict(zip((t["path"] for t in build_playlists["tracks"]), keys)))
        return root_el

    def playlist(parent: ET.Element, name: str, keys: list[str], typ: str = "LIST", extra=None):
        node = ET.SubElement(parent, "NODE", TYPE="PLAYLIST", NAME=name)
        pl = ET.SubElement(node, "PLAYLIST", ENTRIES=str(len(keys)), TYPE=typ, UUID=uuid.uuid4().hex)
        for i, k in enumerate(keys):
            en = ET.SubElement(pl, "ENTRY")
            ET.SubElement(en, "PRIMARYKEY", TYPE="TRACK", KEY=k)
            if extra:
                extra(en, i)
        return node

    half = len(tracks) // 2

    def fill_collection(top, key_of):
        subs = ET.SubElement(top, "SUBNODES", COUNT="2")
        folder_node = ET.SubElement(subs, "NODE", TYPE="FOLDER", NAME="Demo Traktor")
        inner = ET.SubElement(folder_node, "SUBNODES", COUNT="2")
        playlist(inner, "Warm-up", [key_of[t["path"]] for t in tracks[:half]])
        playlist(inner, "Peak", [key_of[t["path"]] for t in tracks[half:]])
        smart = ET.SubElement(subs, "NODE", TYPE="SMARTLIST", NAME="Más de 128 BPM")
        sl = ET.SubElement(smart, "SMARTLIST", UUID=uuid.uuid4().hex)
        ET.SubElement(sl, "SEARCH_EXPRESSION", VERSION="1", QUERY="$BPM > 128")

    ET.ElementTree(nml({"tracks": tracks, "fill": fill_collection})).write(
        folder / "collection.nml", encoding="UTF-8", xml_declaration=True)

    for s_i, plays in enumerate(sessions):
        t0 = start + timedelta(days=s_i, hours=23)
        clock = t0

        def fill_history(top, key_of, plays=plays, t0=t0):
            subs = ET.SubElement(top, "SUBNODES", COUNT="1")
            hist_times = []
            c = t0
            for t in plays:
                hist_times.append(c)
                c += timedelta(seconds=(t["duration"] or 360) - 45)

            def extra(en, i):
                when = hist_times[i]
                packed = (when.year << 16) | (when.month << 8) | when.day
                secs = when.hour * 3600 + when.minute * 60 + when.second
                ET.SubElement(en, "EXTENDEDDATA", DECK=str(1 + i % 2), DURATION=f"{(plays[i]['duration'] or 360) - 30:.1f}",
                              EXTENDEDTYPE="HistoryData", PLAYEDPUBLIC="1", STARTDATE=str(packed), STARTTIME=str(secs))

            playlist(subs, "HISTORY", [key_of[t["path"]] for t in plays], typ="PROTOCOL", extra=extra)

        name = clock.strftime("history_%Yy%mm%dd_%Hh%Mm%Ss.nml")
        ET.ElementTree(nml({"tracks": plays, "fill": fill_history})).write(
            folder / "History" / name, encoding="UTF-8", xml_declaration=True)
    return folder


# ------------------------------------------------------------------ Serato 3.x
def rec(tag: str, data) -> bytes:
    if isinstance(data, str):
        data = data.encode("utf-16-be")
    elif isinstance(data, bool):
        data = struct.pack(">B", data)
    elif isinstance(data, int):
        data = struct.pack(">I", data)
    return struct.pack(">4sI", tag.encode("ascii"), len(data)) + data


def adat(tag: str, fields: dict) -> bytes:
    payload = bytearray()
    for number, value in fields.items():
        data = value.encode("utf-16-be") if isinstance(value, str) else struct.pack(">I", value)
        payload += struct.pack(">II", number, len(data)) + data
    return rec(tag, rec("adat", bytes(payload)))


def write_serato(home: Path, tracks: list[dict], sessions: list[list[dict]], start: datetime) -> Path:
    serato = home / "Music" / "_Serato_"
    (serato / "Subcrates").mkdir(parents=True, exist_ok=True)
    (serato / "History" / "Sessions").mkdir(parents=True, exist_ok=True)
    rel = lambda t: t["path"].lstrip("/")  # noqa: E731  (relativo a la raíz "/" de ~/Music/_Serato_)
    added = int(start.timestamp())
    db = rec("vrsn", "2.0/Serato Scratch LIVE Database")
    for t in tracks:
        body = (rec("pfil", rel(t)) + rec("tsng", t["title"] or "") + rec("tart", t["artist"] or "")
                + rec("tbpm", f"{t['bpm']:.2f}") + rec("tkey", t["key"]) + rec("uadd", added) + rec("utpc", 1))
        db += rec("otrk", body)
    (serato / "database V2").write_bytes(db)

    half = len(tracks) // 2
    crates = {"Demo Serato": tracks[:half], "Demo Serato%%Cierre": tracks[half:]}
    for name, items in crates.items():
        (serato / "Subcrates" / f"{name}.crate").write_bytes(
            rec("vrsn", "1.0/Serato ScratchLive Crate") + b"".join(rec("otrk", rec("ptrk", rel(t))) for t in items))
    (serato / "neworder.pref").write_bytes(
        ("[begin record]\n" + "".join(f"[crate]{n}\n" for n in crates) + "[end record]").encode("utf-16-be"))

    for s_i, plays in enumerate(sessions):
        t0 = int((start + timedelta(days=s_i + 3, hours=22)).timestamp())
        data = rec("vrsn", "1.0/Serato ScratchLive History Session")
        clock = t0
        for i, t in enumerate(plays):
            dur = (t["duration"] or 360) - 45
            data += adat("oent", {2: t["path"], 6: t["title"] or "", 7: t["artist"] or "", 15: int(round(t['bpm'])),
                                  28: clock, 29: clock + dur, 31: 1 + i % 2, 45: dur, 50: 1, 51: t["key"]})
            clock += dur
        (serato / "History" / "Sessions" / f"{s_i + 1}.session").write_bytes(data)
    return serato


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--music", required=True, type=Path, help="carpeta con temas reales (solo se leen)")
    ap.add_argument("--out", required=True, type=Path, help="carpeta donde se arman las librerías de prueba")
    ap.add_argument("-n", type=int, default=30, help="cuántos temas usar (default 30)")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    tracks = pick_tracks(a.music.expanduser(), a.n, rng)
    if len(tracks) < 6:
        sys.exit("Necesito al menos 6 temas de más de 2 minutos")
    start = datetime.now().replace(microsecond=0) - timedelta(days=10)
    sess = [rng.sample(tracks, min(8, len(tracks))) for _ in range(2)]
    out = a.out.expanduser()
    tk = write_traktor(out / "traktor", tracks, sess, start)
    se = write_serato(out / "serato-home", tracks, [rng.sample(tracks, min(8, len(tracks))) for _ in range(2)], start)
    print(f"{len(tracks)} temas")
    print(f"Traktor: {tk}")
    print(f"Serato:  {se}")


if __name__ == "__main__":
    main()
