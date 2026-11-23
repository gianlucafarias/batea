"""Recomendaciones de "qué va después".

Combina BPM, tonalidad, energía y etiquetas con lo que vos le enseñás a Batea:
las relaciones que marcás a mano, el 👍/👎 sobre las sugerencias y lo que
realmente tocaste seguido según el historial de rekordbox. Además aprende tu
"estilo de mezcla" (tolerancia de BPM, cuánto respetás la tonalidad) a partir
de esos mismos pares, y el estilo de cada tema a partir de dónde lo tenés
(sesiones, playlists, carpetas, artista, sello).
"""
from __future__ import annotations

import math
import os
import sqlite3
import threading
from collections import defaultdict

import numpy as np

from . import db, keys, universe

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

# ---------------------------------------------------------------- estilo
# Casi nadie tiene género ni etiquetas cargadas, pero la librería ya dice qué temas son "del mismo palo":
# los que tocaste en la misma sesión, los que pusiste en la misma playlist o carpeta, el mismo artista o
# sello. Cada contexto compartido suma; los contextos chicos (una playlist de 20) dicen más que los
# enormes (una carpeta de 3.000). Medido con tu historial (sesiones nuevas fuera del cálculo): el tema
# que tocaste después aparece entre los 10 primeros 3 veces más seguido que sin esto.
CTX_W = {"session": 1.0, "playlist": 0.8, "user": 1.2, "folder": 0.9, "artist": 0.9, "label": 0.5}
W_BPM, W_ENERGY, W_STYLE, W_TAGS, W_POP, HIST_CAP = 0.30, 0.08, 0.45, 0.10, 0.12, 0.35
KEY_MULT = 0.5

_ix_lock = threading.Lock()
_ix: dict = {}


def _artists(s: str | None) -> set[str]:
    if not s:
        return set()
    for sep in (" & ", " feat. ", " ft. ", " x ", " vs ", " vs. ", ";", "/"):
        s = s.replace(sep, ",")
    return {a.strip().casefold() for a in s.split(",") if len(a.strip()) > 1}


def _signature(c: sqlite3.Connection) -> tuple:
    return (
        tuple(c.execute("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM crate_tracks").fetchone()),
        tuple(c.execute("SELECT COUNT(*), COALESCE(MAX(id), 0) FROM tracks").fetchone()),
        db.get_meta(c, "last_sync"),
    )


def _index(c: sqlite3.Connection) -> dict:
    """Contextos de cada tema (sesiones, playlists, cajas, carpeta, artista, sello). Se arma una vez y se
    rehace solo cuando cambia la librería."""
    sig = _signature(c)
    with _ix_lock:
        if _ix.get("sig") == sig:
            return _ix
    ctx_of: dict[int, list[str]] = defaultdict(list)
    members: dict[str, list[int]] = defaultdict(list)
    weight: dict[str, float] = {}
    label: dict[str, tuple[str, str]] = {}

    def add(t: int, k: str, w: float, what: tuple[str, str]) -> None:
        ctx_of[t].append(k)
        members[k].append(t)
        weight[k] = w
        label[k] = what

    pop: dict[int, int] = defaultdict(int)
    for r in c.execute("SELECT ct.crate_id, ct.track_id, cr.kind, cr.name FROM crate_tracks ct JOIN crates cr ON cr.id=ct.crate_id "
                       "WHERE cr.kind IN ('session','playlist','user') AND cr.hidden=0"):
        add(r[1], f"c{r[0]}", CTX_W[r[2]], (r[2], r[3]))
        if r[2] == "session":
            pop[r[1]] += 1
    for r in c.execute("SELECT id, path, artist, label FROM tracks WHERE hidden=0"):
        if r[1]:
            d = os.path.dirname(r[1])
            add(r[0], "d" + d.casefold(), CTX_W["folder"], ("folder", os.path.basename(d)))
        for a in _artists(r[2]):
            add(r[0], "a" + a, CTX_W["artist"], ("artist", a))
        if r[3] and r[3].strip():
            add(r[0], "l" + r[3].strip().casefold(), CTX_W["label"], ("label", r[3].strip()))
    idf = {k: weight[k] / math.log(2 + len(v)) for k, v in members.items() if len(v) >= 2}
    norm = {t: math.sqrt(sum(idf.get(k, 0.0) ** 2 for k in ks)) or 1.0 for t, ks in ctx_of.items()}
    built = {"sig": sig, "ctx_of": ctx_of, "members": members, "idf": idf, "norm": norm, "label": label,
             "pop": pop, "maxpop": max(pop.values(), default=1)}
    with _ix_lock:
        _ix.clear()
        _ix.update(built)
        return _ix


def _style(ix: dict, seed_id: int) -> dict[int, float]:
    """Parecido de estilo 0..1 (coseno de contextos compartidos, pesados por lo raro que es cada uno)."""
    acc: dict[int, float] = defaultdict(float)
    for k in ix["ctx_of"].get(seed_id, ()):
        w = ix["idf"].get(k)
        if not w:
            continue
        for t in ix["members"][k]:
            if t != seed_id:
                acc[t] += w * w
    ns = ix["norm"].get(seed_id, 1.0)
    return {t: min(1.0, v / (ns * ix["norm"].get(t, 1.0))) for t, v in acc.items()}


def _style_reasons(ix: dict, a: int, b: int) -> list[str]:
    shared = set(ix["ctx_of"].get(a, ())) & set(ix["ctx_of"].get(b, ()))
    # como motivo solo se nombran contextos chicos: "misma carpeta (Downloads)" no le dice nada a nadie
    shared = sorted((k for k in shared if k in ix["idf"] and (k[0] != "d" or len(ix["members"][k]) <= 150)),
                    key=lambda k: -ix["idf"][k])
    out: list[str] = []
    kinds = [ix["label"][k] for k in shared]
    sessions = sum(1 for kind, _ in kinds if kind == "session")
    if sessions:
        out.append(f"sonaron en {sessions} {'sesión' if sessions == 1 else 'sesiones'} tuyas")
    lists = [name for kind, name in kinds if kind in ("playlist", "user")]
    if lists:
        out.append(f"juntos en «{lists[0]}»" + (f" y {len(lists) - 1} más" if len(lists) > 1 else ""))
    for kind, name in kinds:
        if kind == "artist":
            out.append("mismo artista")
            break
    for kind, name in kinds:
        if kind == "label":
            out.append(f"mismo sello ({name})")
            break
    for kind, name in kinds:
        if kind == "folder":
            out.append(f"misma carpeta ({name})")
            break
    return out


def _bpm_fit(a: float | None, b: float | None, tol: float) -> tuple[float | None, float, bool]:
    """(diferencia relativa, puntaje 0..1, si es a mitad/doble)."""
    if not a or not b:
        return None, 0.3, False
    r = b / a
    d = abs(r - 1)
    dh = min(abs(r / 2 - 1), abs(r * 2 - 1))
    if d <= dh:
        return d, math.exp(-((d / tol) ** 2)), False
    return dh, 0.6 * math.exp(-((dh / tol) ** 2)), True     # mitad o doble: se puede, pero no es lo habitual


def recommend(c: sqlite3.Connection, seed_id: int, limit: int = 30, scope_ids: set[int] | None = None,
              uni_ids: set[int] | None | object = ACTIVE) -> dict:
    """`uni_ids`: temas del universo donde buscar (None = toda la librería); por defecto, el universo activo.

    Cada sugerencia trae `reasons` (texto técnico, para la IA y el menú) y `why` (frases cortas para la ficha)."""
    seed = c.execute("SELECT * FROM tracks WHERE id=?", (seed_id,)).fetchone()
    if not seed:
        return {"items": [], "profile": {}}
    uni = universe.track_ids(c) if uni_ids is ACTIVE else uni_ids
    prof = style_profile(c, seed["bpm"], uni)
    tol = prof["bpm_tolerance"]
    kw = prof["key_weight"]
    ix = _index(c)
    sty = _style(ix, seed_id)

    tag_rows = c.execute(
        "SELECT tt.track_id, tt.tag_id, t.name, t.category FROM track_tags tt JOIN tags t ON t.id=tt.tag_id"
    ).fetchall()
    tags_of: dict[int, set[int]] = defaultdict(set)
    tag_name: dict[int, str] = {}
    for r in tag_rows:
        if r["category"] not in STRUCTURE_CATS:
            tags_of[r["track_id"]].add(r["tag_id"])
            tag_name[r["tag_id"]] = r["name"]

    # Relaciones directas (con dirección: "lo tocaste DESPUÉS" vale más que "antes") y de segundo grado
    rels = c.execute(
        "SELECT a, b, kind, source, weight, count FROM relations WHERE a=? OR b=?", (seed_id, seed_id)
    ).fetchall()
    direct: dict[int, list[tuple[str, str, float, int, bool]]] = defaultdict(list)
    for r in rels:
        other = r["b"] if r["a"] == seed_id else r["a"]
        direct[other].append((r["kind"], r["source"], r["weight"], r["count"] or 1, r["a"] == seed_id))
    neighbours = [o for o, lst in direct.items() if any(x[0] != "avoid" for x in lst)]
    second: dict[int, float] = defaultdict(float)
    if neighbours:
        q = ",".join("?" * len(neighbours))
        for r in c.execute(
            f"SELECT a, b, count FROM relations WHERE kind!='avoid' AND (a IN ({q}) OR b IN ({q}))",
            neighbours + neighbours,
        ):
            for o in (r["a"], r["b"]):
                if o != seed_id and o not in neighbours:
                    second[o] += 0.03 * min(r["count"] or 1, 3)

    seed_tags = tags_of.get(seed_id, set())
    seed_e = seed["energy"] or seed["energy_auto"]
    cands = c.execute(
        "SELECT id, title, artist, bpm, key, key_source, energy, energy_auto, genre FROM tracks WHERE hidden=0 AND id!=?",
        (seed_id,),
    ).fetchall()
    lmax = math.log1p(ix["maxpop"])

    scored = []
    for t in cands:
        tid = t["id"]
        if scope_ids is not None and tid not in scope_ids:
            continue
        if uni is not None and tid not in uni:
            continue
        rel = direct.get(tid, [])
        if any(x[0] == "avoid" for x in rel):
            continue
        d, bpm_s, halved = _bpm_fit(seed["bpm"], t["bpm"], tol)
        hist_after = sum(x[3] for x in rel if x[0] == "history" and x[4])
        hist_before = sum(x[3] for x in rel if x[0] == "history" and not x[4])
        rel_boost = min(HIST_CAP, 0.15 * math.log1p(hist_after) + 0.07 * math.log1p(hist_before))
        for kind, _src, weight, _n, _fwd in rel:
            if kind != "history":
                rel_boost += KIND_BOOST.get(kind, 0.1) * min(weight or 1, 3)
        rel_boost += min(second.get(tid, 0.0), 0.12)
        if bpm_s < 0.05 and rel_boost < 0.2:
            continue
        st = sty.get(tid, 0.0)

        if seed["key"] and t["key"]:
            k_s, k_txt = keys.compatibility(seed["key"], t["key"])
            if seed["key_source"] == "batea" or t["key_source"] == "batea":
                # un tono estimado por Batea no siempre coincide con rekordbox: pesa la mitad
                k_s = 0.45 + (k_s - 0.45) * 0.5
                k_txt += " (tono estimado)"
        else:
            k_s, k_txt = 0.4, ""          # sin tonalidad: no se puede asegurar que no choque
        e = t["energy"] or t["energy_auto"]
        de = (e - seed_e) if (seed_e and e) else None
        e_s = math.exp(-((de / 2.5) ** 2)) if de is not None else 0.5
        tt = tags_of.get(tid, set())
        common = seed_tags & tt
        tag_s = len(common) / len(seed_tags | tt) if (seed_tags or tt) else 0.0
        genre_s = 1.0 if seed["genre"] and seed["genre"] == t["genre"] else 0.0
        pop = math.log1p(ix["pop"].get(tid, 0)) / lmax if lmax else 0.0

        score = (W_BPM * bpm_s + kw * k_s + W_ENERGY * e_s + W_STYLE * math.sqrt(st) + W_TAGS * tag_s
                 + 0.04 * genre_s + W_POP * pop + rel_boost)
        # entre temas del mismo estilo, el que no choca de tono va primero (cuanto más armónico mezclás, más pesa)
        km = KEY_MULT * (kw / 0.22)
        score *= (1 - km) + km * k_s
        scored.append((score, t, d, halved, k_s, k_txt, de, common, hist_after, hist_before, rel, st))

    scored.sort(key=lambda x: -x[0])

    def norm(t) -> str:  # duplicados de la librería (mismo tema en dos carpetas)
        s = f"{t['title'] or ''}|{t['artist'] or ''}".lower()
        return "".join(ch for ch in s if ch.isalnum() or ch == "|")

    seen = {norm(seed)}
    items = []
    for score, t, d, halved, k_s, k_txt, de, common, h_after, h_before, rel, st in scored:
        k = norm(t)
        if k in seen:
            continue
        seen.add(k)
        reasons: list[str] = []
        why: list[str] = []
        if h_after:
            reasons.append(f"lo mezclaste {h_after} {'vez' if h_after == 1 else 'veces'}")
            why.append(f"Lo pusiste después {h_after} {'vez' if h_after == 1 else 'veces'}")
        elif h_before:
            reasons.append(f"lo mezclaste {h_before} {'vez' if h_before == 1 else 'veces'} (al revés)")
            why.append("Los mezclaste juntos (al revés)")
        for kind, *_ in rel:
            if kind in ("mix", "mashup", "similar"):
                txt = {"mix": "marcaste que mezclan bien", "mashup": "funciona como mashup", "similar": "misma vibra (marcado)"}[kind]
                reasons.append(txt)
                why.append(txt[0].upper() + txt[1:])
        if d is not None:
            reasons.insert(0, f"BPM {'=' if d < 0.005 else f'±{d * 100:.1f}%'}" + (" (mitad/doble)" if halved else ""))
        if k_txt and k_s >= 0.5:
            reasons.append(f"{seed['key']}→{t['key']} {k_txt}")
        elif k_txt and k_s < 0.3:
            reasons.append(f"ojo: {k_txt}")
        elif not k_txt:
            reasons.append("sin tonalidad para comparar")
        sr = _style_reasons(ix, seed_id, t["id"]) if st > 0 else []
        reasons.extend(sr)
        why.extend(x[0].upper() + x[1:] for x in sr[:2])
        if de is not None and de != 0:
            reasons.append(f"energía {'+' if de > 0 else ''}{de}")
        if common:
            reasons.append("comparten: " + ", ".join(sorted(tag_name[x] for x in common)[:3]))
            why.append("Comparten " + ", ".join(sorted(tag_name[x] for x in common)[:2]))
        items.append({"id": t["id"], "score": round(score, 3), "reasons": reasons, "why": why[:2],
                      "learned": bool(h_after or h_before or any(x[0] != "history" for x in rel)), "style": round(st, 3)})
        if len(items) >= limit:
            break
    return {"items": items, "profile": prof}
