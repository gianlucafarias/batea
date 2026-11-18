"""Consultas de Batea pensadas para una IA (MCP hoy, quizás un chat propio mañana).

Devuelven texto compacto: una línea por tema con su id, que la IA convierte en link
batea://tema/<id>. Nunca devuelven rutas completas (tienen el usuario de la Mac) ni los
comentarios de rekordbox (en esta librería son publicidad de packs con teléfonos).
Todo es de solo lectura salvo `crear_caja`, que solo agrega una caja nueva.
"""
from __future__ import annotations

import os
import re
import sqlite3
import statistics
from collections import Counter
from typing import Any

from . import db, keys, links, universe
from .api_helpers import EFFECTIVE_ENERGY, TRACK_COLUMNS, VIRTUAL_CRATES, _query_parts, mark_online

STRUCTURE = "estructura"
KIND_NAMES = {
    "playlist": "playlist", "folder": "carpeta de rekordbox", "smart_rb": "lista inteligente de rekordbox",
    "session": "sesión del historial", "session_folder": "carpeta del historial", "user": "caja tuya",
    "smart": "caja inteligente", "virtual": "atajo",
}
_URL = re.compile(r"\s*[-–|]?\s*(?:https?://\S+|www\.\S+|\b[\w-]+\.(?:com|net|org|com\.ar)\b\S*)", re.I)


class ToolError(Exception):
    """Error para mostrarle a la IA tal cual (dato faltante, id inexistente…)."""


def connect(readonly: bool = True) -> sqlite3.Connection:
    if not config_db_exists():
        raise ToolError("Batea todavía no tiene base de datos: abrí la app una vez.")
    c = db.connect()
    if readonly:
        c.execute("PRAGMA query_only = ON")
    return c


def config_db_exists() -> bool:
    from . import config
    return config.DB_PATH.exists()


# ------------------------------------------------------------------ formato
def clean_title(s: str | None) -> str:
    return _URL.sub("", s or "").strip(" -–|") or (s or "")


def _dur(sec: float | None) -> str:
    if not sec:
        return "?"
    m, s = divmod(int(sec), 60)
    return f"{m}:{s:02d}"


def _folder(path: str | None) -> str:
    if not path:
        return ""
    name = os.path.basename(os.path.dirname(path))
    return name[:40]


def _tag_names(c: sqlite3.Connection, ids: list[int]) -> dict[int, list[str]]:
    if not ids:
        return {}
    out: dict[int, list[str]] = {}
    q = ",".join("?" * len(ids)) if len(ids) <= 900 else None
    sql = ("SELECT tt.track_id, g.name FROM track_tags tt JOIN tags g ON g.id=tt.tag_id WHERE g.category != ?"
           + (f" AND tt.track_id IN ({q})" if q else "") + " ORDER BY g.position")
    for r in c.execute(sql, [STRUCTURE] + (ids if q else [])):
        out.setdefault(r[0], []).append(r[1])
    return out


def track_line(t: dict, tags: list[str] | None = None) -> str:
    """#123 · Artista – Título · 128 BPM · 8A · E6 · 6:45 · intro 32c / outro 16c · Remix · tocado 3 (2026-07-04) · carpeta BCN"""
    who = (t.get("artist") or "").strip()
    title = clean_title(t.get("title"))
    name = f"{who} – {title}" if who else title
    parts = [f"#{t['id']}", name]
    parts.append(f"{t['bpm']:.1f} BPM".replace(".0 ", " ") if t.get("bpm") else "sin BPM")
    if t.get("key"):
        parts.append(t["key"] + (" (estimado)" if t.get("key_est") else ""))
    if t.get("energy"):
        parts.append(f"E{t['energy']}" + ("" if t.get("energy_user") else "~"))
    parts.append(_dur(t.get("duration")))
    if t.get("intro_bars") or t.get("outro_bars"):
        parts.append(f"intro {t.get('intro_bars') or '?'}c / outro {t.get('outro_bars') or '?'}c")
    if tags:
        parts.append(", ".join(tags[:5]))
    if t.get("rating"):
        parts.append("★" * int(t["rating"]))
    if t.get("play_count"):
        parts.append(f"tocado {t['play_count']}" + (f" ({t['last_played'][:10]})" if t.get("last_played") else ""))
    if t.get("unanalyzed"):
        parts.append({"pending": "SIN ANALIZAR", "error": "no se pudo analizar", "rb": "rekordbox no lo analizó"}[t["unanalyzed"]])
    if t.get("hidden"):
        parts.append("eliminado de Batea")
    if t.get("_folder"):
        parts.append(f"carpeta {t['_folder']}")
    return " · ".join(parts)


def stats_block(rows: list[dict]) -> str:
    if not rows:
        return "Sin temas."
    out = []
    bpms = sorted(r["bpm"] for r in rows if r.get("bpm"))
    if bpms:
        q = statistics.quantiles(bpms, n=4) if len(bpms) >= 4 else [bpms[0], statistics.median(bpms), bpms[-1]]
        hist = Counter(int(b // 2 * 2) for b in bpms)
        top = ", ".join(f"{k}-{k + 2}: {n}" for k, n in sorted(hist.most_common(6)))
        out.append(f"BPM: {bpms[0]:.0f}–{bpms[-1]:.0f}, mediana {statistics.median(bpms):.1f}, "
                   f"mitad central {q[0]:.0f}–{q[-1]:.0f}. Más comunes: {top}")
    ks = Counter(r["key"] for r in rows if r.get("key"))
    if ks:
        out.append("Tonos más comunes: " + ", ".join(f"{k} ({n})" for k, n in ks.most_common(8))
                   + f". Sin tono: {sum(1 for r in rows if not r.get('key'))}")
    es = Counter(r["energy"] for r in rows if r.get("energy"))
    if es:
        out.append("Energía (1-10): " + ", ".join(f"E{k}: {es[k]}" for k in sorted(es)))
    arts: Counter = Counter()
    for r in rows:
        for a in re.split(r",|&| feat\.? | ft\.? | x |;", r.get("artist") or "", flags=re.I):
            if a.strip():
                arts[a.strip()] += 1
    if arts:
        out.append("Artistas que más aparecen: " + ", ".join(f"{a} ({n})" for a, n in arts.most_common(12)))
    played = sum(1 for r in rows if r.get("play_count"))
    out.append(f"Tocados alguna vez: {played} de {len(rows)}. "
               f"Sin analizar: {sum(1 for r in rows if r.get('unanalyzed'))}. "
               f"Con tono estimado por Batea: {sum(1 for r in rows if r.get('key_est'))}. "
               f"Archivo no disponible (disco desconectado): {sum(1 for r in rows if not r.get('online', True))}")
    total = sum(r.get("duration") or 0 for r in rows)
    out.append(f"Duración total: {total / 3600:.1f} h")
    return "\n".join(out)


# ------------------------------------------------------------------ universos
WHOLE = {"todo", "toda", "todos", "toda la libreria", "toda la librería", "libreria", "librería", "all", "ninguno"}


class Scope:
    """En qué parte de la librería busca una herramienta: un universo o toda la librería.

    Por defecto es el universo activo en la app *en el momento de la llamada*; la IA puede
    pedir otro por nombre (o "todo") sin cambiar nada en Batea.
    """

    def __init__(self, c: sqlite3.Connection, uid: int | None, active: int | None):
        self.uid, self.active = uid, active
        names = {r["id"]: r["name"] for r in c.execute("SELECT id, name FROM universes")}
        self.name = names.get(uid) if uid else None
        self.active_name = names.get(active) if active else None
        self.clause = universe.clause_for(c, universe.crate_ids_of(c, uid)) if uid else None
        self._c = c
        self._ids: set[int] | None = None

    @property
    def whole(self) -> bool:
        return self.clause is None

    def ids(self) -> set[int] | None:
        if self.whole:
            return None
        if self._ids is None:
            sql, params = self.clause
            self._ids = {r[0] for r in self._c.execute(f"SELECT t.id FROM tracks t WHERE {sql}", params)}
        return self._ids

    def note(self) -> str:
        if self.whole:
            extra = f" (en la app está activo el universo «{self.active_name}», acá no se aplica)" if self.active_name else ""
            return f"Alcance: toda la librería{extra}."
        if self.uid == self.active:
            return f"Alcance: universo «{self.name}», el activo en la app."
        return f"Alcance: universo «{self.name}» (en la app está activo {f'«{self.active_name}»' if self.active_name else 'toda la librería'})."


def resolve_scope(c: sqlite3.Connection, universo: str = "") -> Scope:
    active = universe.active_id(c)
    u = (universo or "").strip()
    if not u:
        return Scope(c, active, active)
    if u.casefold() in WHOLE:
        return Scope(c, None, active)
    rows = c.execute("SELECT id, name FROM universes").fetchall()
    for r in rows:
        if u == str(r["id"]) or u.casefold() == r["name"].strip().casefold():
            return Scope(c, r["id"], active)
    raise ToolError(f"No existe el universo '{u}'. Universos: " + ", ".join(f"«{r['name']}»" for r in rows)
                    + ' (o "todo" para toda la librería).')


# ------------------------------------------------------------------ consultas base
def _rows(c: sqlite3.Connection, crate: str | None, filters: dict, scope: Scope | None,
          order: str = "", limit: int | None = None, offset: int = 0, extra_where: str = "") -> tuple[list[dict], int]:
    where, params = _query_parts(c, crate, filters, False)
    if scope is not None and scope.clause:
        where.append(scope.clause[0])
        params.extend(scope.clause[1])
    if extra_where:
        where.append(extra_where)
    join = ""
    if not order:
        order = "t.date_added DESC, t.id DESC"
        if crate and crate.isdigit():
            kind = c.execute("SELECT kind FROM crates WHERE id=?", (int(crate),)).fetchone()
            if kind and kind["kind"] in ("playlist", "session", "user"):
                join = f"LEFT JOIN crate_tracks cp ON cp.track_id=t.id AND cp.crate_id={int(crate)}"
                order = "cp.position, t.id"
        elif crate and crate.startswith("dir:"):
            order = "t.path"
    w = (" WHERE " + " AND ".join(where)) if where else ""
    total = c.execute(f"SELECT COUNT(*) FROM tracks t{w}", params).fetchone()[0]
    sql = f"SELECT {TRACK_COLUMNS} FROM tracks t {join}{w} ORDER BY {order}"
    if limit:
        sql += f" LIMIT {int(limit)} OFFSET {int(offset)}"
    rows = [dict(r) for r in c.execute(sql, params)]
    for r in rows:
        r["_folder"] = _folder(r.get("path"))
    mark_online(c, rows)  # saca la ruta y tiene en cuenta las copias encontradas en otros discos
    return rows, total


def _lines(c: sqlite3.Connection, rows: list[dict]) -> str:
    tags = _tag_names(c, [r["id"] for r in rows])
    return "\n".join(track_line(r, tags.get(r["id"])) for r in rows)


def resolve_crate(c: sqlite3.Connection, ref: str) -> tuple[str, str, str]:
    """Acepta id, nombre, atajo, 'dir:/ruta', 'artist:Nombre' o un link batea://. Devuelve (clave, nombre, tipo)."""
    ref = (ref or "").strip()
    if not ref:
        raise ToolError("Falta la caja")
    if ref.startswith("batea://"):
        t = links.parse(ref)
        ref = {"caja": t["value"], "carpeta": "dir:" + t["value"], "artista": "artist:" + t["value"]}.get(t["kind"], "")
        if not ref:
            raise ToolError("Ese link es de un tema, no de una caja")
    if ref in VIRTUAL_CRATES:
        return ref, VIRTUAL_CRATES[ref], "atajo"
    if ref.startswith("dir:"):
        return ref, os.path.basename(ref[4:].rstrip("/")) or ref, "carpeta real"
    if ref.startswith("artist:"):
        return ref, ref[7:], "artista"
    if ref.isdigit():
        row = c.execute("SELECT id, name, kind FROM crates WHERE id=?", (int(ref),)).fetchone()
        if not row:
            raise ToolError(f"No existe la caja {ref}")
        return str(row["id"]), row["name"], KIND_NAMES.get(row["kind"], row["kind"])
    rows = c.execute("SELECT id, name, kind FROM crates WHERE name LIKE ? ORDER BY (trim(name) = ? COLLATE NOCASE) DESC, kind LIMIT 8",
                     (f"%{ref}%", ref)).fetchall()
    exact = [r for r in rows if r["name"].strip().casefold() == ref.casefold()]
    if len(exact) == 1 or len(rows) == 1:
        r = (exact or rows)[0]
        return str(r["id"]), r["name"], KIND_NAMES.get(r["kind"], r["kind"])
    if not rows:
        raise ToolError(f"No encontré ninguna caja que se llame '{ref}'. Usá listar_cajas para ver las que hay.")
    raise ToolError("Hay varias cajas con ese nombre, elegí por id:\n" + "\n".join(
        f"caja {r['id']}: {r['name']} ({KIND_NAMES.get(r['kind'], r['kind'])})" for r in rows))


# ------------------------------------------------------------------ herramientas
def estado(c: sqlite3.Connection) -> str:
    total = c.execute("SELECT COUNT(*) FROM tracks WHERE hidden=0").fetchone()[0]
    uid = universe.active_id(c)
    unis = [f"«{r['name']}» ({universe.count_for(c, universe.crate_ids_of(c, r['id']))} temas)" + (" ← activo en la app" if r["id"] == uid else "")
            for r in c.execute("SELECT id, name FROM universes ORDER BY id")]
    uni = ("Universos: " + ", ".join(unis) + "." + ("" if uid else " Ninguno activo: la app muestra toda la librería.")
           + ' Las herramientas usan el activo en la app, salvo que pases universo="<nombre>" o universo="todo".') if unis else ""
    kinds = dict(c.execute("SELECT kind, COUNT(*) FROM crates WHERE hidden=0 GROUP BY kind").fetchall())
    hist = c.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM crates WHERE kind='session'").fetchone()
    cov = c.execute(f"""SELECT SUM(bpm IS NOT NULL), SUM(key IS NOT NULL), SUM({EFFECTIVE_ENERGY.replace('t.', '')} IS NOT NULL),
                        SUM(COALESCE(genre,'')!=''), SUM(COALESCE(artist,'')!=''), SUM(COALESCE(play_count,0)>0)
                        FROM tracks WHERE hidden=0""").fetchone()
    pct = lambda n: f"{100 * (n or 0) / max(total, 1):.0f}%"  # noqa: E731
    app = "abierta" if links.running() else "cerrada"
    return "\n".join(filter(None, [
        f"Librería: {total} temas. {uni}",
        f"Cajas: {kinds.get('playlist', 0)} playlists de rekordbox, {kinds.get('user', 0)} cajas propias, "
        f"{kinds.get('smart', 0)} inteligentes. Historial: {hist[0]} sesiones ({hist[1]} a {hist[2]}).",
        f"Datos disponibles: BPM {pct(cov[0])}, tono {pct(cov[1])}, energía {pct(cov[2])}, "
        f"género {pct(cov[3])}, artista {pct(cov[4])}, tocados alguna vez {pct(cov[5])}.",
        f"La app de Batea está {app}.",
    ]))


def listar_cajas(c: sqlite3.Connection, buscar: str = "", tipo: str = "", limite: int = 150, universo: str = "") -> str:
    kinds = {"playlist": ("playlist",), "mia": ("user",), "inteligente": ("smart", "smart_rb"),
             "carpeta": ("folder",), "": ("playlist", "user", "smart", "smart_rb", "folder")}.get(tipo)
    if kinds is None:
        raise ToolError("tipo puede ser: playlist, mia, inteligente, carpeta (o vacío para todas)")
    q = ",".join("?" * len(kinds))
    sql = f"""SELECT c.id, c.name, c.kind, p.name AS parent,
                     (SELECT COUNT(DISTINCT ct.track_id) FROM crate_tracks ct WHERE ct.crate_id IN
                        (WITH RECURSIVE sub(id) AS (SELECT c.id UNION ALL SELECT x.id FROM crates x JOIN sub ON x.parent_id=sub.id)
                         SELECT id FROM sub)) AS n
              FROM crates c LEFT JOIN crates p ON p.id=c.parent_id
              WHERE c.hidden=0 AND c.kind IN ({q})"""
    params: list[Any] = list(kinds)
    if buscar:
        sql += " AND (c.name LIKE ? OR p.name LIKE ?)"
        params += [f"%{buscar}%"] * 2
    rows = c.execute(sql + " ORDER BY c.position, c.name", params).fetchall()
    scope = resolve_scope(c, universo)
    inside: dict[int, int] = {}
    if not scope.whole:   # cuántos temas de cada caja caen en el universo (las carpetas suman lo de adentro)
        ids = scope.ids() or set()
        members: dict[int, set[int]] = {}
        for cid, tid in c.execute("SELECT crate_id, track_id FROM crate_tracks"):
            if tid in ids:
                members.setdefault(cid, set()).add(tid)
        kids: dict[int, list[int]] = {}
        for cid, parent in c.execute("SELECT id, parent_id FROM crates WHERE parent_id IS NOT NULL"):
            kids.setdefault(parent, []).append(cid)

        def gather(cid: int) -> set[int]:
            out = set(members.get(cid, ()))
            for k in kids.get(cid, []):
                out |= gather(k)
            return out
        inside = {r["id"]: len(gather(r["id"])) for r in rows}
        rows = [r for r in rows if inside[r["id"]]]
    lines = [scope.note()] + [
        f"caja {r['id']}: {r['name']} — {KIND_NAMES.get(r['kind'], r['kind'])}"
        + (f", en «{r['parent']}»" if r["parent"] else "")
        + (f", {r['n']} temas" if scope.whole else f", {inside[r['id']]} temas en «{scope.name}» (de {r['n']})")
        for r in rows[:limite]]
    if len(rows) > limite:
        lines.append(f"…y {len(rows) - limite} más (usá buscar=).")
    if not buscar and not tipo:
        lines.append("Atajos: " + ", ".join(f"{k} ({v})" for k, v in VIRTUAL_CRATES.items()))
    return "\n".join(lines) if len(lines) > 1 else lines[0] + "\nNo hay cajas con ese criterio."


def listar_carpetas(c: sqlite3.Connection, buscar: str = "", universo: str = "") -> str:
    from . import folders
    scope = resolve_scope(c, universo)
    out: list[str] = [scope.note()]

    def walk(node: dict, depth: int) -> None:
        if not buscar or buscar.casefold() in node["n"].casefold():
            out.append(f"{'  ' * depth}{node['n']} — {node['c']} temas — caja dir:{node['p']}")
        if depth < 4:
            for k in node.get("k", []):
                walk(k, depth + 1)

    for root in folders.tree(c, scope.clause):
        walk(root, 0)
    return "\n".join(out[:300]) if len(out) > 1 else out[0] + "\nNo hay carpetas con ese nombre."


def _sessions(c: sqlite3.Connection, desde: str = "", hasta: str = "") -> dict[str, list[sqlite3.Row]]:
    sql = """SELECT c.id, c.name, c.date, (SELECT COUNT(*) FROM crate_tracks ct WHERE ct.crate_id=c.id) AS n
             FROM crates c WHERE c.kind='session'"""
    params: list[Any] = []
    if desde:
        sql += " AND c.date >= ?"; params.append(desde)
    if hasta:
        sql += " AND c.date <= ?"; params.append(hasta)
    by_day: dict[str, list[sqlite3.Row]] = {}
    for r in c.execute(sql + " ORDER BY c.date DESC, c.name", params):
        if r["n"]:
            by_day.setdefault(r["date"] or "sin fecha", []).append(r)
    return by_day


def listar_sesiones(c: sqlite3.Connection, desde: str = "", hasta: str = "", limite: int = 40, universo: str = "") -> str:
    scope = resolve_scope(c, universo)
    uni_ids = scope.ids()
    out = [scope.note() + ("" if scope.whole else " Solo noches con al menos la mitad de los temas en ese universo.")]
    for day, parts in _sessions(c, desde, hasta).items():
        if len(out) > limite:
            break
        ids = [r["id"] for r in parts]
        q = ",".join("?" * len(ids))
        share = ""
        if uni_ids is not None:
            tids = [r[0] for r in c.execute(f"SELECT track_id FROM crate_tracks WHERE crate_id IN ({q})", ids)]
            frac = sum(t in uni_ids for t in tids) / max(len(tids), 1)
            if frac < 0.5:
                continue
            share = f", {frac * 100:.0f}% en «{scope.name}»"
        s = c.execute(f"""SELECT COUNT(*), MIN(t.bpm), MAX(t.bpm), AVG({EFFECTIVE_ENERGY}), SUM(t.duration)
                          FROM crate_tracks ct JOIN tracks t ON t.id=ct.track_id WHERE ct.crate_id IN ({q})""", ids).fetchone()
        bpm = f"{s[1]:.0f}–{s[2]:.0f} BPM" if s[1] else "sin BPM"
        out.append(f"{day}: {s[0]} temas, {bpm}, energía media {s[3] or 0:.1f}, ~{(s[4] or 0) / 60:.0f} min{share}"
                   + (f" — sesión {ids[0]}" if len(ids) == 1 else f" — {len(ids)} partes: sesiones {', '.join(map(str, ids))}"))
    return "\n".join(out) if len(out) > 1 else out[0] + "\nNo hay sesiones en ese rango."


def ver_caja(c: sqlite3.Connection, caja: str, limite: int = 150, desde: int = 0, universo: str = "") -> str:
    key, name, kind = resolve_crate(c, caja)
    scope = resolve_scope(c, universo)
    all_rows, total = _rows(c, key, {}, scope)
    page = all_rows[desde:desde + max(1, min(limite, 400))]
    head = [f"{name} ({kind}) — {total} temas — link {links.crate_url(key)}", scope.note(), stats_block(all_rows)]
    if not scope.whole:
        full = _rows(c, key, {}, None, limit=1)[1]
        if full > total:
            head.insert(2, f"La caja tiene {full} temas en total; {full - total} quedan fuera de «{scope.name}» (universo=\"todo\" para verlos).")
    if desde + len(page) < total:
        head.append(f"Mostrando {desde + 1}–{desde + len(page)} de {total} (usá desde= para ver más).")
    return "\n".join(head) + "\n\n" + _lines(c, page)


def ver_sesion(c: sqlite3.Connection, sesion: str) -> str:
    sesion = (sesion or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", sesion):
        parts = _sessions(c, sesion, sesion).get(sesion)
        if not parts:
            raise ToolError(f"No hay sesiones el {sesion}")
        ids = [r["id"] for r in sorted(parts, key=lambda r: r["name"])]
        title = f"Noche del {sesion}" + (f" ({len(ids)} partes)" if len(ids) > 1 else "")
    elif sesion.isdigit():
        r = c.execute("SELECT id, name, date, kind FROM crates WHERE id=?", (int(sesion),)).fetchone()
        if not r or r["kind"] != "session":
            raise ToolError("Ese id no es una sesión del historial. Usá listar_sesiones.")
        ids, title = [r["id"]], f"{r['name']} ({r['date']})"
    else:
        raise ToolError("Pasá el id de la sesión o una fecha AAAA-MM-DD")
    rows: list[dict] = []
    for sid in ids:
        rows += _rows(c, str(sid), {}, None)[0]
    tags = _tag_names(c, [r["id"] for r in rows])
    lines = []
    for i, r in enumerate(rows):
        if i:
            p = rows[i - 1]
            bits = []
            if p.get("bpm") and r.get("bpm"):
                bits.append(f"BPM {100 * (r['bpm'] / p['bpm'] - 1):+.1f}%")
            _, ktxt = keys.compatibility(p.get("key"), r.get("key"))
            if ktxt:
                bits.append(ktxt)
            if p.get("energy") and r.get("energy"):
                bits.append(f"energía {r['energy'] - p['energy']:+d}")
            lines.append("    ↓ " + ", ".join(bits) if bits else "    ↓")
        lines.append(f"{i + 1}. " + track_line(r, tags.get(r["id"])))
    curve = " → ".join(str(r.get("energy") or "?") for r in rows)
    bpms = " → ".join(f"{r['bpm']:.0f}" if r.get("bpm") else "?" for r in rows)
    return "\n".join([
        f"{title} — {len(rows)} temas — " + ", ".join(links.crate_url(i) for i in ids),
        f"Curva de energía: {curve}", f"BPM: {bpms}", stats_block(rows), "", *lines,
    ])


def buscar_temas(c: sqlite3.Connection, texto: str = "", bpm_min: float | None = None, bpm_max: float | None = None,
                 energia_min: int | None = None, energia_max: int | None = None, tonos: list[str] | None = None,
                 compatible_con_tono: str = "", etiquetas: list[str] | None = None, sin_etiquetas: list[str] | None = None,
                 caja: str = "", puntaje_min: int | None = None, nunca_tocados: bool = False, orden: str = "reciente",
                 universo: str = "", limite: int = 60) -> str:
    def tag_ids(names: list[str] | None) -> list[int]:
        out = []
        for n in names or []:
            r = c.execute("SELECT id FROM tags WHERE name = ? COLLATE NOCASE ORDER BY source='user' DESC", (n,)).fetchone()
            if not r:
                raise ToolError(f"No existe la etiqueta '{n}'. Etiquetas: " + ", ".join(
                    x[0] for x in c.execute("SELECT name FROM tags WHERE category != ? ORDER BY position", (STRUCTURE,))))
            out.append(r[0])
        return out

    filters = {"q": texto, "bpm_min": bpm_min, "bpm_max": bpm_max, "energy_min": energia_min, "energy_max": energia_max,
               "keys": [k.upper() for k in tonos or []], "key_compat": compatible_con_tono.upper() or None,
               "tags": tag_ids(etiquetas), "not_tags": tag_ids(sin_etiquetas), "rating_min": puntaje_min}
    key = resolve_crate(c, caja)[0] if caja else None
    order = {"reciente": "", "bpm": "t.bpm, t.id", "energia": f"{EFFECTIVE_ENERGY} DESC, t.bpm",
             "mas_tocados": "COALESCE(t.play_count,0) DESC, t.id", "puntaje": "COALESCE(t.rating, t.rb_rating, 0) DESC"}.get(orden)
    if order is None:
        raise ToolError("orden puede ser: reciente, bpm, energia, mas_tocados, puntaje")
    extra = "COALESCE(t.play_count,0)=0 AND t.last_played IS NULL" if nunca_tocados else ""
    scope = resolve_scope(c, universo)
    rows, total = _rows(c, key, filters, scope, order=order, limit=max(1, min(limite, 300)), extra_where=extra)
    head = f"{total} temas encontrados" + (f", muestro {len(rows)}" if total > len(rows) else "") + ". " + scope.note()
    return head + "\n" + (_lines(c, rows) if rows else "")


def ver_tema(c: sqlite3.Connection, tid: int) -> str:
    rows, _ = _rows(c, None, {"show_hidden": True}, None, extra_where=f"t.id={int(tid)}")
    if not rows:
        raise ToolError(f"No existe el tema {tid}")
    t = rows[0]
    extra = c.execute("SELECT album, label, genre, remixer, year, notes, date_added FROM tracks WHERE id=?", (tid,)).fetchone()
    tags = c.execute("SELECT g.name, g.category FROM track_tags tt JOIN tags g ON g.id=tt.tag_id WHERE tt.track_id=?", (tid,)).fetchall()
    crates = c.execute("""SELECT c.id, c.name, c.kind, c.date FROM crate_tracks ct JOIN crates c ON c.id=ct.crate_id
                          WHERE ct.track_id=? AND c.kind IN ('playlist','user','session') ORDER BY c.kind, c.date DESC""", (tid,)).fetchall()
    rels = c.execute("""SELECT r.kind, r.source, r.count, r.note, r.a, t.id, t.title, t.artist, t.bpm, t.key
                        FROM relations r JOIN tracks t ON t.id = CASE WHEN r.a=? THEN r.b ELSE r.a END
                        WHERE r.a=? OR r.b=? ORDER BY (r.source='user') DESC, r.count DESC LIMIT 25""", (tid, tid, tid)).fetchall()
    out = [track_line(t), f"link {links.track_url(tid)}"]
    meta = {k: extra[k] for k in ("album", "label", "genre", "remixer", "year", "date_added") if extra[k]}
    if meta:
        out.append(", ".join(f"{k}: {v}" for k, v in meta.items()))
    if extra["notes"]:
        out.append(f"Tus notas: {extra['notes']}")
    if tags:
        out.append("Etiquetas: " + ", ".join(f"{r['name']} ({r['category']})" for r in tags))
    pl = [f"caja {r['id']} {r['name']}" for r in crates if r["kind"] != "session"]
    ss = [f"{r['date']} (sesión {r['id']})" for r in crates if r["kind"] == "session"]
    if pl:
        out.append("Está en: " + "; ".join(pl[:20]))
    if ss:
        out.append(f"Lo tocaste en {len(ss)} sesiones: " + ", ".join(ss[:15]))
    if rels:
        out.append("Relaciones:")
        for r in rels:
            what = {"history": ("lo tocaste después" if r["a"] == tid else "lo tocaste antes") + f" ({r['count']} {'vez' if r['count'] == 1 else 'veces'})",
                    "mix": "mezclan bien (marcado por vos)", "mashup": "funciona como mashup", "similar": "misma vibra",
                    "avoid": "NO van juntos"}.get(r["kind"], r["kind"])
            out.append(f"  {what}: #{r['id']} {r['artist'] or ''} – {clean_title(r['title'])} · {r['bpm'] or '?'} BPM · {r['key'] or '?'}"
                       + (f" · nota: {r['note']}" if r["note"] else ""))
    return "\n".join(out)


def compatibles(c: sqlite3.Connection, tid: int, caja: str = "", limite: int = 20, universo: str = "") -> str:
    from . import recommend
    scope = resolve_scope(c, universo)
    in_crate = None
    if caja:
        key = resolve_crate(c, caja)[0]
        in_crate = {r["id"] for r in _rows(c, key, {}, scope)[0]}
    res = recommend.recommend(c, int(tid), limit=max(1, min(limite, 60)), scope_ids=in_crate, uni_ids=scope.ids())
    if not res["items"]:
        return scope.note() + "\nNo encontré temas compatibles."
    ids = [i["id"] for i in res["items"]]
    rows, _ = _rows(c, None, {}, None, extra_where=f"t.id IN ({','.join(map(str, ids))})")
    by = {r["id"]: r for r in rows}
    tags = _tag_names(c, ids)
    lines = [scope.note(), f"Para seguir a #{tid} (de mejor a peor):"]
    for it in res["items"]:
        if it["id"] in by:
            lines.append(track_line(by[it["id"]], tags.get(it["id"])) + f" — por qué: {'; '.join(it['reasons'])}")
    return "\n".join(lines)


def mi_estilo(c: sqlite3.Connection, bpm: float | None = None, universo: str = "") -> str:
    from . import recommend
    scope = resolve_scope(c, universo)
    p = recommend.style_profile(c, bpm, scope.ids())
    h = p["harmonic_ratio"]
    return (scope.note() + f" Aprendido de {p['pairs']} transiciones tuyas" + (f" alrededor de {bpm:.0f} BPM" if bpm else "") + ". "
            f"Tolerancia de BPM entre temas seguidos: ±{p['bpm_tolerance'] * 100:.1f}%. "
            + (f"Transiciones armónicas (mismo tono, vecino o relativo): {h * 100:.0f}%." if h is not None
               else "Muy pocas transiciones con tono para saber si mezclás armónico."))


def crear_caja(nombre: str, ids: list[int]) -> str:
    nombre = (nombre or "").strip()
    if not nombre:
        raise ToolError("Falta el nombre de la caja")
    seen: list[int] = []
    for i in ids:
        if int(i) not in seen:
            seen.append(int(i))
    if not seen:
        raise ToolError("La caja necesita al menos un tema")
    with connect() as c:
        q = ",".join("?" * len(seen))
        found = {r[0] for r in c.execute(f"SELECT id FROM tracks WHERE id IN ({q})", seen)}
    missing = [i for i in seen if i not in found]
    if missing:
        raise ToolError(f"Estos ids no existen en Batea: {missing}. No creé la caja.")
    app = links.running()
    if app:  # con la app abierta, que la cree ella y se actualice la pantalla
        cid = links.call(app, "POST", "/api/crates", {"name": nombre, "track_ids": seen})["id"]
        try:
            links.call(app, "POST", "/api/open/refresh")
        except OSError:
            pass
    else:
        with db.conn() as c:
            cur = c.execute("INSERT INTO crates(name, kind, position, source) VALUES (?, 'user', (SELECT COALESCE(MAX(position),0)+1 FROM crates), 'user')",
                            (nombre,))
            cid = cur.lastrowid
            universe.add_crate_to_active(c, cid)
            c.executemany("INSERT OR IGNORE INTO crate_tracks(crate_id, track_id, position) VALUES (?,?,?)",
                          [(cid, t, i) for i, t in enumerate(seen)])
    with connect() as c:
        active = universe.active_id(c)
        uname = c.execute("SELECT name FROM universes WHERE id=?", (active,)).fetchone()["name"] if active else None
    where = f" Quedó dentro del universo «{uname}», el activo en la app." if uname else ""
    return f"Caja «{nombre}» creada con {len(seen)} temas: {links.crate_url(cid)}.{where}"


def abrir(url: str) -> str:
    try:
        links.parse(url)
    except ValueError as e:
        raise ToolError(str(e)) from e
    try:
        r = links.send(url, launch=True)
    except RuntimeError as e:
        raise ToolError(str(e)) from e
    return "Listo, abierto en Batea." if r == "abierto" else r

