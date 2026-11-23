"""Lecturas de sets: temas puente/de reemplazo para una pasada y estadísticas de tus sesiones del historial."""
from __future__ import annotations

import math
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import date

from . import keys, recommend, universe

# ---------------------------------------------------------------- sugerencias para una pasada


BRIDGE_BPM = 0.06      # cada lado del puente puede mover el tempo hasta 6%


def _bpm_pct(a: float | None, b: float | None) -> float | None:
    if not a or not b:
        return None
    r = b / a
    r = r / 2 if abs(r - 2) < 0.06 else r * 2 if abs(r - 0.5) < 0.03 else r
    return (r - 1) * 100


def _dedupe_key(title: str | None, artist: str | None) -> str:
    t = re.sub(r"\((?:\d+|\d+\s*kbps)\)|\[[^\]]*\]|\(\d+kbps\)|www\.\S+", "", (title or "").lower())
    return "".join(ch for ch in f"{t}|{artist or ''}".lower() if ch.isalnum() or ch == "|")


def suggest_between(c: sqlite3.Connection, prev: int | None, nxt: int | None, exclude: set[int], limit: int = 8) -> list[dict]:
    """Temas que entran bien después de `prev` Y antes de `nxt`.

    Sirve para las dos cosas: un puente entre A y B (prev=A, nxt=B) y un reemplazo de B (prev=A, nxt=el que sigue a B).
    Los candidatos salen del mismo motor que las sugerencias de la ficha (historial, estilo, etiquetas), pero
    para un puente mandan el tempo y el tono de los DOS lados: cada lado se puntúa y el total es la media armónica,
    así que un tema que encaja de un solo lado queda abajo."""
    sides = [s for s in (prev, nxt) if s]
    if not sides:
        return []
    reco: dict[int, list[float]] = defaultdict(list)
    why: dict[int, list[str]] = defaultdict(list)
    for seed in sides:
        items = recommend.recommend(c, seed, limit=500)["items"]
        top = max((i["score"] for i in items), default=0) or 1
        for i in items:
            reco[i["id"]].append(i["score"] / top)
            why[i["id"]] += [w for w in i.get("why", []) if w not in why[i["id"]]]
    pool = [t for t in reco if t not in exclude and t not in sides]
    if not pool:
        return []
    q = ",".join("?" * (len(pool) + len(sides)))
    rows = {r["id"]: r for r in c.execute(f"SELECT id, title, artist, bpm, key FROM tracks WHERE id IN ({q})", pool + sides)}
    seen = {_dedupe_key(rows[s]["title"], rows[s]["artist"]) for s in sides}
    scored = []
    for tid in pool:
        t = rows[tid]
        if not t["bpm"]:
            continue                                  # sin BPM no se puede prometer que mezcle
        fits, fit = [], {}
        for name, seed in (("from_prev", prev), ("to_next", nxt)):
            if not seed:
                continue
            a, b = (rows[seed], t) if name == "from_prev" else (t, rows[seed])
            pct = _bpm_pct(a["bpm"], b["bpm"])
            if pct is None or abs(pct) > BRIDGE_BPM * 100:
                break
            k_s, k_txt = keys.compatibility(a["key"], b["key"])
            fits.append(math.exp(-((pct / 3) ** 2)) * (0.35 + 0.65 * k_s))
            fit[name] = {"key": k_txt, "key_ok": k_s >= 0.85, "bpm_pct": round(pct, 1)}
        else:
            hm = len(fits) / sum(1 / max(f, 1e-6) for f in fits)
            r = sum(reco[tid]) / len(sides)             # si un lado no lo sugirió, cuenta 0
            scored.append((hm * (0.75 + 0.25 * r), tid, fit))
    scored.sort(key=lambda x: -x[0])
    out = []
    for score, tid, fit in scored:
        k = _dedupe_key(rows[tid]["title"], rows[tid]["artist"])
        if k in seen:
            continue
        seen.add(k)
        out.append({"id": tid, "score": round(score, 3), "why": why[tid][:2], "fit": fit})
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- estadísticas del historial

BINS = 10


def _level(r: sqlite3.Row) -> float | None:
    for k in ("energy", "energy_fine", "energy_auto"):
        if r[k] is not None:
            return float(r[k])
    return None


def _smooth(e: list[float | None]) -> list[float | None]:
    out = []
    for i in range(len(e)):
        w = [x for x in e[max(0, i - 1):i + 2] if x is not None]
        out.append(sum(w) / len(w) if w else None)
    return out


def _peak(e: list[float | None]) -> int | None:
    """El mismo criterio que el gráfico: el tema más alto dentro del tramo más alto del set."""
    s = _smooth(e)
    known = [(v, i) for i, v in enumerate(s) if v is not None]
    if not known:
        return None
    top = max(v for v, _ in known)
    low = min(v for v, _ in known)
    tol = max(0.25, (top - low) * 0.2)
    start = next(i for v, i in known if v >= top - 0.001)
    lo = hi = start
    while hi + 1 < len(s) and (s[hi + 1] or -1) >= top - tol:
        hi += 1
    while lo - 1 >= 0 and (s[lo - 1] or -1) >= top - tol:
        lo -= 1
    zone = [i for i in range(lo, hi + 1) if e[i] is not None]
    return max(zone, key=lambda i: e[i]) if zone else start


def session_sequence(c: sqlite3.Connection, cid: int) -> list[int]:
    ids = [r[0] for r in c.execute("SELECT track_id FROM session_plays WHERE crate_id=? ORDER BY position", (cid,))]
    return ids or [r[0] for r in c.execute("SELECT track_id FROM crate_tracks WHERE crate_id=? ORDER BY position", (cid,))]


def session_stats(c: sqlite3.Connection, year: int | None = None, only_universe: bool = True) -> dict:
    sessions = c.execute("SELECT id, name, date FROM crates WHERE kind='session' AND hidden=0 ORDER BY date, id").fetchall()
    uni = universe.track_ids(c) if only_universe else None

    cols = "t.id, t.title, t.artist, t.bpm, t.key, t.duration, t.energy, t.energy_fine, t.energy_auto"
    by_session: dict[int, list[sqlite3.Row]] = defaultdict(list)
    # la secuencia completa (con repeticiones) donde está; si no, la lista de temas de la sesión
    for r in c.execute(f"SELECT sp.crate_id, {cols} FROM session_plays sp JOIN tracks t ON t.id=sp.track_id "
                       "ORDER BY sp.crate_id, sp.position"):
        by_session[r["crate_id"]].append(r)
    for r in c.execute(f"SELECT ct.crate_id, {cols} FROM crate_tracks ct JOIN tracks t ON t.id=ct.track_id "
                       "JOIN crates c ON c.id=ct.crate_id WHERE c.kind='session' "
                       "AND ct.crate_id NOT IN (SELECT DISTINCT crate_id FROM session_plays) ORDER BY ct.crate_id, ct.position"):
        by_session[r["crate_id"]].append(r)

    chosen = []
    years_set: set[int] = set()
    for s in sessions:
        ts = by_session.get(s["id"], [])
        if len(ts) < 3:
            continue        # una sesión de 1 o 2 temas es una prueba, no un set
        # con un universo activo, cuentan las sesiones donde la mayoría de los temas son de ese universo
        if uni is not None and sum(1 for t in ts if t["id"] in uni) < len(ts) / 2:
            continue
        if s["date"]:
            years_set.add(int(s["date"][:4]))
        if year and (not s["date"] or int(s["date"][:4]) != year):
            continue
        chosen.append((s, ts))
    years = sorted(years_set, reverse=True)

    curves: list[list[float]] = []
    peak_pos: list[float] = []
    peak_min: list[float] = []
    durations: list[float] = []
    bpms: list[float] = []
    peak_tracks: Counter = Counter()
    openers: Counter = Counter()
    closers: Counter = Counter()
    plays: Counter = Counter()
    last_seen: dict[int, str] = {}
    by_month: dict[str, dict] = defaultdict(lambda: {"sessions": 0, "bpm": []})
    info: dict[int, sqlite3.Row] = {}
    listing = []

    for s, ts in chosen:
        e = [_level(t) for t in ts]
        n = len(ts)
        for t in ts:
            info[t["id"]] = t
            plays[t["id"]] += 1
            if s["date"]:
                last_seen[t["id"]] = max(last_seen.get(t["id"], ""), s["date"])
        openers[ts[0]["id"]] += 1
        closers[ts[-1]["id"]] += 1
        dur = sum(t["duration"] or 0 for t in ts) / 60
        durations.append(dur)
        sb = [t["bpm"] for t in ts if t["bpm"]]
        avg_bpm = sum(sb) / len(sb) if sb else None
        if avg_bpm:
            bpms.append(avg_bpm)
        p = _peak(e)
        if p is not None:
            peak_tracks[ts[p]["id"]] += 1
            peak_pos.append(p / max(n - 1, 1))
            peak_min.append(sum(t["duration"] or 0 for t in ts[:p]) / 60)
        # curva normalizada: posición 0..1 del set repartida en BINS tramos
        acc = [[] for _ in range(BINS)]
        for i, v in enumerate(e):
            if v is not None:
                acc[min(BINS - 1, int(i / n * BINS))].append(v)
        if sum(1 for a in acc if a) >= BINS * 0.7:
            curves.append([sum(a) / len(a) if a else math.nan for a in acc])
        month = (s["date"] or "")[:7]
        if month:
            by_month[month]["sessions"] += 1
            if avg_bpm:
                by_month[month]["bpm"].append(avg_bpm)
        known = [v for v in e if v is not None]
        listing.append({"id": s["id"], "name": s["name"], "date": s["date"], "tracks": n, "minutes": round(dur),
                        "bpm": round(avg_bpm, 1) if avg_bpm else None,
                        "energy": round(sum(known) / len(known), 1) if known else None,
                        "peak": p + 1 if p is not None else None})

    def pct(vals: list[float], q: float) -> float | None:
        v = sorted(x for x in vals if not math.isnan(x))
        if not v:
            return None
        k = (len(v) - 1) * q
        f = math.floor(k)
        return v[f] + (v[min(f + 1, len(v) - 1)] - v[f]) * (k - f)

    typical = [{"x": (b + 0.5) / BINS, "mid": pct([cv[b] for cv in curves], 0.5),
                "lo": pct([cv[b] for cv in curves], 0.25), "hi": pct([cv[b] for cv in curves], 0.75)} for b in range(BINS)]

    def track(tid: int, **extra) -> dict:
        t = info[tid]
        return {"id": tid, "title": t["title"], "artist": t["artist"], "bpm": t["bpm"], "key": t["key"], **extra}

    def top(counter: Counter, k: int = 8, min_n: int = 2) -> list[dict]:
        return [track(tid, count=n) for tid, n in counter.most_common(k) if n >= min_n]

    # pasadas que más repetís, dentro de las sesiones elegidas
    pairs: Counter = Counter()
    for _s, ts in chosen:
        for a, b in zip(ts, ts[1:]):
            if a["id"] != b["id"]:
                pairs[(a["id"], b["id"])] += 1
    top_pairs = [{"a": track(a), "b": track(b), "count": n} for (a, b), n in pairs.most_common(10) if n >= 2]

    # los tocabas seguido y hace rato que no: 3+ sesiones y la última hace más de 6 meses (contra la sesión más nueva)
    newest = max((s["date"] for s, _ in chosen if s["date"]), default=None)
    forgotten = []
    if newest:
        ref = date.fromisoformat(newest[:10])
        for tid, n in plays.most_common():
            if n < 3:
                break
            last = last_seen.get(tid)
            if last and (ref - date.fromisoformat(last[:10])).days > 182:
                forgotten.append(track(tid, count=n, last=last[:10]))
            if len(forgotten) >= 8:
                break

    months = [{"month": m, "sessions": v["sessions"], "bpm": round(sum(v["bpm"]) / len(v["bpm"]), 1) if v["bpm"] else None}
              for m, v in sorted(by_month.items())]

    def avg(v: list[float]) -> float | None:
        return round(sum(v) / len(v), 2) if v else None

    return {
        "years": years,
        "year": year,
        "universe": uni is not None,
        "summary": {
            "sessions": len(chosen), "tracks": len(plays), "plays": sum(plays.values()),
            "minutes": avg(durations), "bpm": avg(bpms),
            "peak_at": avg(peak_pos), "peak_minute": avg(peak_min),
            "first": chosen[0][0]["date"] if chosen else None, "last": newest,
        },
        "typical": typical,
        "curves": len(curves),
        "months": months,
        "peak_tracks": top(peak_tracks),
        "openers": top(openers),
        "closers": top(closers),
        "pairs": top_pairs,
        "forgotten": forgotten,
        "sessions": listing[::-1][:60],
    }
