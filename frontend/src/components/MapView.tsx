import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Seg } from '../lib/Seg'
import { HoverList } from '../lib/fluidHover'
import { api, type MapPoint } from '../api'
import { useApp, usePlayer } from '../store'
import type { Track } from '../types'
import { cleanTitle, fmtBpm, hash, keyColor, parseKey, plural } from '../util'
import { artistCrate } from './Artist'
import { energyColor, KeyBadge } from './bits'
import { folderCrate } from './FolderTree'
import { Engine, type Halo, type Highlight } from './map3d/engine'
import type { LayoutIn } from './map3d/layout.worker'
import { DotSize, MapModes, useDotScale, type MapMode } from './MapModes'

type ColorBy = 'key' | 'plays' | 'energy'
type Edge = [number, number, string, number]

// ------------------------------------------------------------------ colores
const rgbCache = new Map<string, [number, number, number]>()
let cssCtx: CanvasRenderingContext2D | null = null
function rgb(css: string): [number, number, number] {
  const hit = rgbCache.get(css)
  if (hit) return hit
  cssCtx ??= document.createElement('canvas').getContext('2d')
  let out: [number, number, number] = [0.6, 0.6, 0.6]
  if (cssCtx) {
    cssCtx.fillStyle = '#000'; cssCtx.fillStyle = css
    const s = String(cssCtx.fillStyle)
    const m = s.startsWith('#') ? [s.slice(1, 3), s.slice(3, 5), s.slice(5, 7)].map((h) => parseInt(h, 16)) : (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    if (m.length === 3) out = [m[0] / 255, m[1] / 255, m[2] / 255]
  }
  rgbCache.set(css, out)
  return out
}
const HISTORY: [number, number, number] = [0.92, 0.8, 0.53]
const USER: [number, number, number] = [0.61, 0.89, 0.66]
const AVOID: [number, number, number] = [0.94, 0.36, 0.3]
const ORANGE: [number, number, number] = [1, 0.35, 0.12]

// ------------------------------------------------------------------ posiciones
const energyOf = (p: MapPoint) => (p[2] ?? 5)

/** Punto de partida de la constelación: BPM, energía y tono, así lo parecido arranca cerca. */
function seedLayout(pts: MapPoint[], bpmMid: number, bpmLo: number, bpmHi: number): Float32Array {
  const out = new Float32Array(pts.length * 3)
  pts.forEach((p, i) => {
    const h1 = hash(p[0]) - 0.5, h2 = hash(p[0] * 7 + 3) - 0.5, h3 = hash(p[0] * 13 + 5) - 0.5
    const b = Math.min(bpmHi, Math.max(bpmLo, p[1]))
    const k = parseKey(p[3])
    out[i * 3] = (b - bpmMid) * 9 + h1 * 6
    out[i * 3 + 1] = (energyOf(p) - 5.5) * 32 + h2 * 10
    out[i * 3 + 2] = k ? ((k[0] - 6.5) * 26 + (k[1] === 'B' ? 9 : -9)) + h3 * 6 : -200 + h3 * 10
  })
  return out
}

function cacheKey(scope: string, pts: MapPoint[], edges: Edge[]) {
  let h = 0
  for (const p of pts) h = (h * 31 + p[0]) | 0
  for (const e of edges) h = (h * 17 + e[0] * 3 + e[1]) | 0
  return `batea.map3d:${scope}:${pts.length}:${edges.length}:${h}`
}
function loadCached(key: string, n: number): Float32Array | null {
  try {
    const s = localStorage.getItem(key)
    if (!s) return null
    const a = JSON.parse(s) as number[]
    return a.length === n * 3 ? Float32Array.from(a) : null
  } catch { return null }
}
function saveCached(key: string, pos: Float32Array) {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('batea.map3d:') && k !== key)
    for (const k of keys.slice(0, Math.max(0, keys.length - 3))) localStorage.removeItem(k)
    localStorage.setItem(key, JSON.stringify(Array.from(pos, (v) => Math.round(v * 10) / 10)))
  } catch { /* sin lugar: se vuelve a calcular la próxima vez */ }
}

// ------------------------------------------------------------------ vista
interface Label { el: HTMLDivElement }

interface Props { scope: string; setScope: (s: string) => void; onMode: (m: MapMode) => void }

export function MapView({ scope, setScope, onMode }: Props) {
  const { crates, virtualCrates, folders, selectedId, select, tags, toast, loadMeta, go, libraryVersion } = useApp()
  const [data, setData] = useState<{ points: MapPoint[]; edges: Edge[] } | null>(null)
  const [colorBy, setColorBy] = useState<ColorBy>('key')
  const [showEdges, setShowEdges] = useState(true)
  const [spin, setSpin] = useState(false)
  const [hiTag, setHiTag] = useState<number | null>(null)
  const [recIds, setRecIds] = useState<number[]>([])
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [boxSel, setBoxSel] = useState<number[] | null>(null)

  const wrap = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const labelsEl = useRef<HTMLDivElement>(null)
  const eng = useRef<Engine | null>(null)
  const dot = useDotScale()
  const graphPos = useRef<Float32Array | null>(null)
  const alphaRef = useRef<Float32Array | null>(null)
  const labelPool = useRef<Label[]>([])

  // ---------------------------------------------------------------- datos
  useEffect(() => {
    let alive = true
    api.map(scope).then((d) => alive && setData(d)).catch((e) => toast(e.message, 'error'))
    return () => { alive = false }
  }, [scope, libraryVersion, toast])

  const pts = useMemo(() => data?.points ?? [], [data])
  const idx = useMemo(() => new Map(pts.map((p, i) => [p[0], i])), [pts])
  const edges = useMemo(() => (data?.edges ?? []).filter((e) => idx.has(e[0]) && idx.has(e[1])), [data, idx])
  const neighbors = useMemo(() => {
    const m = new Map<number, Edge[]>()
    for (const e of edges) {
      for (const id of [e[0], e[1]]) { const l = m.get(id); if (l) l.push(e); else m.set(id, [e]) }
    }
    return m
  }, [edges])
  const bpmRange = useMemo(() => {
    const b = pts.map((p) => p[1]).sort((x, y) => x - y)
    if (!b.length) return { mid: 125, lo: 60, hi: 200 }
    return { mid: b[Math.floor(b.length / 2)], lo: b[Math.floor(b.length * 0.02)], hi: b[Math.floor(b.length * 0.98)] }
  }, [pts])
  const seedPos = useMemo(() => seedLayout(pts, bpmRange.mid, bpmRange.lo, bpmRange.hi), [pts, bpmRange])
  const maxPlays = useMemo(() => Math.max(1, ...pts.map((p) => p[7])), [pts])

  // ---------------------------------------------------------------- motor
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const e = new Engine(el)
    eng.current = e
    e.setDotScale(dot)
    const ro = new ResizeObserver(() => e.resize(el.clientWidth, el.clientHeight))
    ro.observe(el)
    e.resize(el.clientWidth, el.clientHeight)
    return () => { ro.disconnect(); e.dispose(); eng.current = null }
  }, [])

  useEffect(() => { eng.current?.setDotScale(dot) }, [dot])

  // estrellas + conexiones cuando cambian los datos; la constelación se calcula aparte (o sale de la memoria)
  useEffect(() => {
    const e = eng.current
    if (!e || !pts.length) return
    const n = pts.length
    const degree = new Map<number, number>()
    for (const ed of edges) for (const id of [ed[0], ed[1]]) degree.set(id, (degree.get(id) ?? 0) + 1)
    const sizes = new Float32Array(n)
    pts.forEach((p, i) => { sizes[i] = 1 + p[4] * 0.16 + Math.min(1.6, Math.sqrt(degree.get(p[0]) ?? 0) * 0.22) })
    const key = cacheKey(scope, pts, edges)
    const cached = loadCached(key, n)
    const start = cached ?? seedPos.map((v) => v * 0.55)
    graphPos.current = cached
    e.setNodes(start, new Float32Array(n * 3).fill(0.6), sizes, new Float32Array(n).fill(0.85))

    const pairs = new Int32Array(edges.length * 2), col = new Float32Array(edges.length * 3)
    // con pocas conexiones se ven más; con miles, cada una es tenue para que no se haga una mancha
    const boost = Math.min(5, Math.max(1, 3000 / Math.max(1, edges.length)))
    edges.forEach((ed, k) => {
      pairs[k * 2] = idx.get(ed[0])!; pairs[k * 2 + 1] = idx.get(ed[1])!
      const [base, f] = ed[2] === 'history' ? [HISTORY, Math.min(0.55, (0.016 + 0.026 * ed[3]) * boost)] : ed[2] === 'avoid' ? [AVOID, 0.4] : [USER, 0.6]
      col.set([base[0] * f, base[1] * f, base[2] * f], k * 3)
    })
    e.setEdges(pairs, col)
    e.fit(false)

    if (cached) { setProgress(null); return }
    // constelación nueva: en segundo plano, mostrando cómo se acomoda
    const links: number[] = [], weights: number[] = []
    for (const ed of edges) {
      if (ed[2] === 'avoid') continue
      links.push(idx.get(ed[0])!, idx.get(ed[1])!)
      weights.push(ed[2] === 'history' ? Math.min(1, 0.3 + Math.log1p(ed[3]) * 0.3) : 1)
    }
    const feats = new Float32Array(n * 4)
    pts.forEach((p, i) => { const k = parseKey(p[3]); feats.set([p[1], k ? k[0] : 0, k && k[1] === 'B' ? 1 : 0, energyOf(p)], i * 4) })
    const w = new Worker(new URL('./map3d/layout.worker.ts', import.meta.url), { type: 'module' })
    const msg: LayoutIn = {
      feats, links: Int32Array.from(links), weights: Float32Array.from(weights), init: start,
      ticks: n > 6000 ? 220 : n > 1500 ? 260 : 300,
    }
    setProgress(0)
    let fitted = false
    w.onmessage = (ev: MessageEvent<{ pos: Float32Array; progress: number; done: boolean }>) => {
      graphPos.current = ev.data.pos
      eng.current?.setPositions(ev.data.pos, 0)
      if (!fitted && ev.data.progress > 0.35) { eng.current?.fit(); fitted = true }
      setProgress(ev.data.done ? null : ev.data.progress)
      if (ev.data.done) {
        saveCached(key, ev.data.pos)
        eng.current?.fit()
        w.terminate()
      }
    }
    w.postMessage(msg)
    return () => w.terminate()
  }, [pts, edges, idx, scope, seedPos])

  // colores
  useEffect(() => {
    const e = eng.current
    if (!e || !pts.length) return
    const c = new Float32Array(pts.length * 3)
    pts.forEach((p, i) => {
      let css: string
      if (colorBy === 'key') css = keyColor(p[3])
      else if (colorBy === 'energy') css = energyColor(energyOf(p))
      else { const t = Math.log1p(p[7]) / Math.log1p(maxPlays); css = `hsl(${30 - t * 10}, ${25 + t * 75}%, ${28 + t * 38}%)` }
      c.set(rgb(css), i * 3)
    })
    e.setColors(c)
  }, [pts, colorBy, maxPlays])

  useEffect(() => { eng.current?.showEdges(showEdges) }, [showEdges])
  useEffect(() => { if (eng.current) eng.current.controls.autoRotate = spin }, [spin])

  // seleccionado: volar hasta él, encender sus conexiones y sugeridos
  useEffect(() => {
    if (selectedId == null) { setRecIds([]); return }
    api.recommendations(selectedId, scope === 'all' ? null : scope).then((r) => setRecIds(r.items.slice(0, 10).map((i) => i.id))).catch(() => setRecIds([]))
  }, [selectedId, scope])
  useEffect(() => {
    const i = selectedId != null ? idx.get(selectedId) : undefined
    if (i != null) eng.current?.focus(i)
  }, [selectedId, idx])

  useEffect(() => {
    const e = eng.current
    if (!e || !pts.length) return
    const sel = selectedId != null ? idx.get(selectedId) : undefined
    const lines: Highlight[] = [], halos: Halo[] = []
    const lit = new Set<number>()
    if (sel != null) {
      for (const ed of neighbors.get(selectedId!) ?? []) {
        const o = idx.get(ed[0] === selectedId ? ed[1] : ed[0])!
        lit.add(o)
        lines.push({ a: sel, b: o, rgb: ed[2] === 'history' ? HISTORY : ed[2] === 'avoid' ? AVOID : USER })
      }
      for (const id of recIds) {
        const o = idx.get(id)
        if (o == null) continue
        lit.add(o)
        lines.push({ a: sel, b: o, rgb: [ORANGE[0] * 0.7, ORANGE[1] * 0.7, ORANGE[2] * 0.7] })
        halos.push({ i: o, rgb: ORANGE, size: 3.4 })
      }
      halos.push({ i: sel, rgb: [1, 1, 1], size: 4.4 })
      lit.add(sel)
    }
    e.setHighlight(lines, halos)
    const a = new Float32Array(pts.length)
    pts.forEach((p, i) => {
      const tagOk = hiTag == null || p[9].includes(hiTag)
      a[i] = !tagOk ? 0.05 : sel != null ? (lit.has(i) ? 1 : 0.3) : hiTag != null ? 1 : 0.85
    })
    alphaRef.current = a
    e.setAlpha(a)
  }, [pts, idx, neighbors, selectedId, recIds, hiTag])

  // ---------------------------------------------------------------- nombres sobre las estrellas
  const sel = selectedId != null ? idx.get(selectedId) : undefined
  const labelState = useRef({ hover: -1, sel: -1 })
  labelState.current = { hover: hover?.i ?? -1, sel: sel ?? -1 }
  useEffect(() => {
    const e = eng.current
    const box = labelsEl.current
    if (!e || !box) return
    const draw = () => {
      if (!pts.length) { for (const l of labelPool.current) l.el.style.display = 'none'; return }
      const s = e.project()
      const { w, h } = e.size
      const want: [number, string, string][] = []    // índice, texto, clase
      const seen = new Set<number>()
      const add = (i: number, cls: string) => { if (i >= 0 && !seen.has(i) && s[i * 3 + 2] > 0) { seen.add(i); want.push([i, cleanTitle(pts[i][5]), cls]) } }
      add(labelState.current.sel, 'sel')
      add(labelState.current.hover, 'hov')
      if (labelState.current.sel >= 0) for (const ed of neighbors.get(pts[labelState.current.sel][0]) ?? []) if (want.length < 14) add(idx.get(ed[0] === pts[labelState.current.sel][0] ? ed[1] : ed[0])!, '')
      // las más cercanas a la cámara, si están bastante cerca
      const near: [number, number][] = []
      const a = alphaRef.current
      for (let i = 0; i < pts.length; i++) {
        const d = s[i * 3 + 2]
        if (d <= 0 || d > e.radius * 0.95 || (a && a[i] < 0.5)) continue
        const x = s[i * 3], y = s[i * 3 + 1]
        if (x < 0 || y < 0 || x > w || y > h) continue
        near.push([d, i])
      }
      near.sort((p, q) => p[0] - q[0])
      for (const [, i] of near) { if (want.length >= 34) break; add(i, 'far') }
      const pool = labelPool.current
      while (pool.length < want.length) { const el = document.createElement('div'); el.className = 'map3-label'; box.appendChild(el); pool.push({ el }) }
      pool.forEach((l, k) => {
        const it = want[k]
        if (!it) { l.el.style.display = 'none'; return }
        const [i, text, cls] = it
        l.el.style.display = ''
        l.el.className = `map3-label ${cls}`
        if (l.el.textContent !== text) l.el.textContent = text
        l.el.style.transform = `translate(${Math.round(s[i * 3] + 9)}px, ${Math.round(s[i * 3 + 1] - 8)}px)`
      })
    }
    e.onFrame = draw
    e.touch()
    return () => { if (eng.current) eng.current.onFrame = null }
  }, [pts, idx, neighbors])
  useEffect(() => { eng.current?.touch() }, [hover?.i, sel])

  // ---------------------------------------------------------------- mouse
  const down = useRef<{ x: number; y: number; moved: boolean; box: boolean } | null>(null)
  const local = (ev: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect()
    return [ev.clientX - r.left, ev.clientY - r.top] as const
  }
  const onPointerDownCapture = (ev: React.PointerEvent) => {
    const [x, y] = local(ev)
    const isBox = ev.shiftKey && ev.button === 0
    down.current = { x, y, moved: false, box: isBox }
    if (isBox && eng.current) { eng.current.controls.enabled = false; setBox({ x0: x, y0: y, x1: x, y1: y }) }
    setHover(null)
  }
  const onPointerMove = (ev: React.PointerEvent) => {
    const [x, y] = local(ev)
    const d = down.current
    if (d) {
      if (Math.abs(x - d.x) + Math.abs(y - d.y) > 4) d.moved = true
      if (d.box) setBox((b) => b && { ...b, x1: x, y1: y })
      return
    }
    const i = eng.current?.pick(x, y, alphaRef.current ?? undefined) ?? -1
    setHover((h) => (i < 0 ? null : h && h.i === i ? { ...h, x, y } : { i, x, y }))
  }
  const onPointerUp = (ev: React.PointerEvent) => {
    const d = down.current
    down.current = null
    if (eng.current) eng.current.controls.enabled = true
    if (!d) return
    if (d.box && box) {
      const s = eng.current!.project()
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1)
      const a = alphaRef.current
      const ids = pts.filter((_, i) => s[i * 3 + 2] > 0 && (!a || a[i] >= 0.1) && s[i * 3] >= x0 && s[i * 3] <= x1 && s[i * 3 + 1] >= y0 && s[i * 3 + 1] <= y1).map((p) => p[0])
      setBox(null)
      setBoxSel(ids.length ? ids : null)
      return
    }
    if (!d.moved && ev.button === 0) {
      const [x, y] = local(ev)
      const i = eng.current?.pick(x, y, alphaRef.current ?? undefined) ?? -1
      select(i >= 0 ? pts[i][0] : null)
    }
  }
  const onDoubleClick = (ev: React.MouseEvent) => {
    const [x, y] = local(ev)
    const i = eng.current?.pick(x, y, alphaRef.current ?? undefined) ?? -1
    if (i < 0) { eng.current?.fit(); return }
    api.track(pts[i][0]).then((t) => usePlayer.getState().play(t as unknown as Track)).catch((e) => toast((e as Error).message, 'error'))
  }

  // ---------------------------------------------------------------- buscador
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const out: MapPoint[] = []
    for (const p of pts) {
      if (`${p[5] ?? ''} ${p[6] ?? ''}`.toLowerCase().includes(q)) { out.push(p); if (out.length >= 8) break }
    }
    return out
  }, [query, pts])

  const here = folderCrate(scope, folders) ?? artistCrate(scope)
  const scopes = [...(here ? [here] : []), ...virtualCrates.filter((c) => c.id !== 'hidden'), ...crates.filter((c) => !c.hidden && ['playlist', 'user', 'smart'].includes(c.kind) && c.count > 0)]
  const hp = hover ? pts[hover.i] : null
  const size = eng.current?.size ?? { w: 800, h: 600 }
  const fit = useCallback(() => eng.current?.fit(), [])

  return (
    <>
      <header className="viewhead">
        <div>
          <h1>Mapa</h1>
          <div className="sub">{data ? plural(pts.length, 'tema', 'temas') : 'Cargando…'} · Los temas que tocás juntos quedan cerca. Tocá uno para ver con qué se conecta.</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm icon help-btn" aria-label="Cómo se usa" title="Arrastrá para girar · rueda para acercar · click derecho para mover · ⇧ + arrastrar para seleccionar">?</button>
        <select className="input" value={scope} onChange={(e) => { setScope(e.target.value); select(null) }} style={{ maxWidth: 240 }}>
          {scopes.map((c) => <option key={c.id} value={String(c.id)}>{c.name}{c.count ? ` (${c.count})` : ''}</option>)}
        </select>
      </header>
      <div className="mapview map3" ref={wrap}>
        <div ref={stage} className="map3-stage"
          onPointerDownCapture={onPointerDownCapture} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)} onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()} />
        <div ref={labelsEl} className="map3-labels" />

        <div className="map-dots" title="Tamaño de los puntos"><DotSize /></div>
        <div className="map-ui">
          <MapModes mode="graph" onMode={onMode} />
          <Seg>
            <button className={colorBy === 'key' ? 'on' : ''} onClick={() => setColorBy('key')}>Color: tono</button>
            <button className={colorBy === 'energy' ? 'on' : ''} onClick={() => setColorBy('energy')}>energía</button>
            <button className={colorBy === 'plays' ? 'on' : ''} onClick={() => setColorBy('plays')}>más tocados</button>
          </Seg>
          <button className={`btn sm${showEdges ? ' primary' : ''}`} onClick={() => setShowEdges(!showEdges)}>Conexiones</button>
          <select className="input" style={{ height: 26, fontSize: 12, width: 170 }} value={hiTag ?? ''} onChange={(e) => setHiTag(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Resaltar etiqueta…</option>
            {tags.filter((t) => t.count > 0).map((t) => <option key={t.id} value={t.id}>{t.category} · {t.name} ({t.count})</option>)}
          </select>
          <button className={`btn sm${spin ? ' primary' : ''}`} onClick={() => setSpin(!spin)} title="Que gire solo, despacio">Girar</button>
          <button className="btn ghost sm" onClick={fit} title="Ver todo (o doble click en el fondo)">Encuadrar</button>
          <div className="map3-search">
            <input className="input" placeholder="Buscar y volar a un tema…" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) { select(results[0][0]); setQuery('') } if (e.key === 'Escape') setQuery('') }} />
            {results.length > 0 && (
              <HoverList className="map3-results">
                {results.map((p) => (
                  <button key={p[0]} data-fh onClick={() => { select(p[0]); setQuery('') }}>
                    <b className="ellipsis">{cleanTitle(p[5])}</b><span className="muted ellipsis">{p[6] || '—'}</span>
                  </button>
                ))}
              </HoverList>
            )}
          </div>
        </div>

        {progress != null && (
          <div className="map3-progress">
            <span>Armando la constelación… {Math.round(progress * 100)}%</span>
            <div className="bar"><i style={{ ['--p' as string]: progress }} /></div>
            <span className="faint">Solo la primera vez.</span>
          </div>
        )}

        <div className="map-legend">
          <span>Las líneas unen temas que tocaste uno después del otro.</span>
          {selectedId != null && <span><span style={{ color: '#9be3a9' }}>━</span> tus relaciones · <span style={{ color: '#eacb86' }}>━</span> historial · <span style={{ color: '#ff5a1f' }}>◌</span> sugeridos</span>}
        </div>

        {hp && hover && (
          <div className="map-tip" style={{ left: Math.min(hover.x + 16, size.w - 290), top: Math.min(hover.y + 16, size.h - 90) }}>
            <b className="ellipsis">{cleanTitle(hp[5])}</b>
            <span className="muted ellipsis">{hp[6] || '—'}</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3 }}>
              <span className="num">{fmtBpm(hp[1])} BPM</span><KeyBadge k={hp[3]} /><span className="num muted">energía {Math.round(hp[2] ?? 0)}</span>
              {hp[7] > 0 && <span className="num muted">{hp[7]}× tocado</span>}
            </span>
            <span className="faint" style={{ fontSize: 10.5, marginTop: 2 }}>click: ficha y conexiones · doble click: escuchar</span>
          </div>
        )}
        {box && (
          <div className="map3-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />
        )}
        {boxSel && (
          <div className="map-sel">
            <span><b className="num">{boxSel.length}</b> temas seleccionados</span>
            <button className="btn primary sm" onClick={async () => {
              const name = await useApp.getState().askText('Nombre de la caja con esta selección')
              if (!name) return
              const { id } = await api.createCrate(name, { track_ids: boxSel })
              await loadMeta(); setBoxSel(null); toast(`Caja “${name}” creada`); go('crate', String(id))
            }}>Crear caja</button>
            <button className="btn ghost sm" onClick={() => setBoxSel(null)}>Cancelar</button>
          </div>
        )}
      </div>
    </>
  )
}
