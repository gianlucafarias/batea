"""Recomendaciones de "qué va después".

Combina BPM, tonalidad, energía y etiquetas con lo que vos le enseñás a Batea:
las relaciones que marcás a mano, el 👍/👎 sobre las sugerencias y lo que
realmente tocaste seguido según el historial de rekordbox. Además aprende tu
"estilo de mezcla" (tolerancia de BPM, cuánto respetás la tonalidad) a partir
de esos mismos pares.
"""
from __future__ import annotations

import math
import sqlite3
from collections import defaultdict

import numpy as np

from . import keys, universe

SYMMETRIC = {"mix", "similar", "mashup", "avoid"}
STRUCTURE_CATS = {"estructura"}

KIND_BOOST = {"mix": 0.35, "mashup": 0.3, "similar": 0.2}


def _bpm_delta(a: float | None, b: float | None) -> float | None:
    if not a or not b:
        return None
    r = b / a
    return min(abs(r - 1), abs(r / 2 - 1), abs(r * 2 - 1))


def style_profile(c: sqlite3.Connection, around_bpm: float | None = None, within: set[int] | None = None) -> dict:
    """Estilo de mezcla aprendido de tus pares (historial + relaciones + 👍).

    Con `around_bpm` solo mira pares en ese rango (±12%): un set a 125 BPM
    no se mezcla igual que uno a 95.
    """
    sql = """SELECT r.a, r.b, ta.bpm AS ba, tb.bpm AS bb, ta.key AS ka, tb.key AS kb
             FROM relations r JOIN tracks ta ON ta.id=r.a JOIN tracks tb ON tb.id=r.b
             WHERE r.kind IN ('mix','history','mashup')"""
    params: list = []
    if around_bpm:
        sql += " AND ta.bpm BETWEEN ? AND ?"
        params = [around_bpm * 0.88, around_bpm * 1.12]
    rows = c.execute(sql, params).fetchall()
    if within is not None:  # con un universo activo, el estilo se aprende solo de esos temas
        rows = [r for r in rows if r["a"] in within and r["b"] in within]
    deltas = [d for d in (_bpm_delta(r["ba"], r["bb"]) for r in rows) if d is not None and d < 0.25]
    kpairs = [keys.compatibility(r["ka"], r["kb"])[0] for r in rows if r["ka"] and r["kb"]]
    n = len(deltas)
    tol = float(np.clip(np.percentile(deltas, 75), 0.015, 0.08)) if n >= 20 else 0.04
    harmonic = float(np.mean([k >= 0.85 for k in kpairs])) if len(kpairs) >= 20 else None
    # si mezclás armónico más que el azar (~0.3), la tonalidad pesa más
    key_weight = 0.22 if harmonic is None else float(np.clip(0.08 + 0.4 * (harmonic - 0.2), 0.06, 0.32))
    return {
        "around_bpm": around_bpm,
        "pairs": n,
        "bpm_tolerance": tol,
        "harmonic_ratio": harmonic,
        "key_weight": key_weight,
    }


ACTIVE = object()   # "el universo activo en la app"


def recommend(c: sqlite3.Connection, seed_id: int, limit: int = 30, scope_ids: set[int] | None = None,
              uni_ids: set[int] | None | object = ACTIVE) -> dict:
    """`uni_ids`: temas del universo donde buscar (None = toda la librería); por defecto, el universo activo."""
    seed = c.execute("SELECT * FROM tracks WHERE id=?", (seed_id,)).fetchone()
    if not seed:
        return {"items": [], "profile": {}}
    uni = universe.track_ids(c) if uni_ids is ACTIVE else uni_ids
    prof = style_profile(c, seed["bpm"], uni)
    tol = prof["bpm_tolerance"]
    kw = prof["key_weight"]

    tag_rows = c.execute(
        "SELECT tt.track_id, tt.tag_id, t.name, t.category FROM track_tags tt JOIN tags t ON t.id=tt.tag_id"
    ).fetchall()
    tags_of: dict[int, set[int]] = defaultdict(set)
    tag_name: dict[int, str] = {}
    for r in tag_rows:
        if r["category"] not in STRUCTURE_CATS:
            tags_of[r["track_id"]].add(r["tag_id"])
            tag_name[r["tag_id"]] = r["name"]

    # Relaciones directas y de segundo grado
    rels = c.execute(
        "SELECT a, b, kind, source, weight, count FROM relations WHERE a=? OR b=?", (seed_id, seed_id)
    ).fetchall()
    direct: dict[int, list[tuple[str, str, float, int]]] = defaultdict(list)
    for r in rels:
        other = r["b"] if r["a"] == seed_id else r["a"]
        direct[other].append((r["kind"], r["source"], r["weight"], r["count"]))
    neighbours = [o for o, lst in direct.items() if any(k != "avoid" for k, *_ in lst)]
    second: dict[int, float] = defaultdict(float)
    if neighbours:
        q = ",".join("?" * len(neighbours))
        for r in c.execute(
            f"SELECT a, b, kind FROM relations WHERE kind!='avoid' AND (a IN ({q}) OR b IN ({q}))",
            neighbours + neighbours,
        ):
            for o in (r["a"], r["b"]):
                if o != seed_id and o not in neighbours:
                    second[o] += 0.04

    seed_tags = tags_of.get(seed_id, set())
    seed_e = seed["energy"] or seed["energy_auto"]
    cands = c.execute(
        "SELECT id, title, artist, bpm, key, key_source, energy, energy_auto, genre, rating, rb_rating, path, artwork, source "
        "FROM tracks WHERE hidden=0 AND id!=?",
        (seed_id,),
    ).fetchall()

    out = []
    for t in cands:
        if scope_ids is not None and t["id"] not in scope_ids:
            continue
        if uni is not None and t["id"] not in uni:
            continue
        rel = direct.get(t["id"], [])
        if any(k == "avoid" for k, *_ in rel):
            continue
        reasons: list[str] = []
        d = _bpm_delta(seed["bpm"], t["bpm"])
        bpm_s = math.exp(-((d / tol) ** 2)) if d is not None else 0.3
        rel_boost = 0.0
        hist = sum(count for kind, _, _, count in rel if kind == "history")
        if hist:
            rel_boost += min(0.3, 0.12 * math.log1p(hist))
            reasons.append(f"lo mezclaste {hist} {'vez' if hist == 1 else 'veces'}")
        for kind, source, weight, count in rel:
            if kind == "history":
                continue
            else:
                rel_boost += KIND_BOOST.get(kind, 0.1) * min(weight, 3)
                reasons.append({"mix": "marcaste que mezclan bien", "mashup": "funciona como mashup",
                                "similar": "misma vibra (marcado)"}.get(kind, kind))
        rel_boost += min(second.get(t["id"], 0), 0.15)
        if second.get(t["id"]):
            reasons.append("conectado vía otro tema")
        if bpm_s < 0.05 and rel_boost < 0.2:
            continue

        k_s, k_txt = keys.compatibility(seed["key"], t["key"])
        # Un tono estimado por Batea coincide con rekordbox en ~6 de cada 10 temas: pesa la mitad.
        est = seed["key_source"] == "batea" or t["key_source"] == "batea"
        if est and k_txt:
            k_s = 0.5 + (k_s - 0.5) * 0.5
            k_txt += " (tono estimado)"
        e = t["energy"] or t["energy_auto"]
        if seed_e and e:
            de = e - seed_e
            e_s = math.exp(-((de / 2.5) ** 2)) + (0.05 if 0 <= de <= 2 else 0)
        else:
            de, e_s = None, 0.5
        tt = tags_of.get(t["id"], set())
        common = seed_tags & tt
        tag_s = len(common) / len(seed_tags | tt) if (seed_tags or tt) else 0
        genre_s = 1.0 if seed["genre"] and seed["genre"] == t["genre"] else 0.0

        score = 0.30 * bpm_s + kw * k_s + 0.15 * e_s + 0.15 * tag_s + 0.04 * genre_s + rel_boost
        if d is not None:
            reasons.insert(0, f"BPM {'=' if d < 0.005 else f'±{d * 100:.1f}%'}")
        if k_txt and k_s >= 0.5:
            reasons.append(f"{seed['key']}→{t['key']} {k_txt}")
        elif k_txt and k_s < 0.3:
            reasons.append(f"ojo: {k_txt}")
        if de is not None and de != 0:
            reasons.append(f"energía {'+' if de > 0 else ''}{de}")
        if common:
            reasons.append("comparten: " + ", ".join(sorted(tag_name[x] for x in common)[:3]))
        out.append((score, t, reasons, rel_boost > 0))

    out.sort(key=lambda x: -x[0])

    def norm(t) -> str:  # duplicados de la librería (mismo tema en dos carpetas)
        s = f"{t['title'] or ''}|{t['artist'] or ''}".lower()
        return "".join(ch for ch in s if ch.isalnum() or ch == "|")

    seen = {norm(seed)}
    items = []
    for s, t, r, learned in out:
        k = norm(t)
        if k in seen:
            continue
        seen.add(k)
        items.append({"id": t["id"], "score": round(s, 3), "reasons": r, "learned": learned})
        if len(items) >= limit:
            break
    return {"items": items, "profile": prof}
