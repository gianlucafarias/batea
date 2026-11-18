import { artistCrate } from './Artist'
import { Seg } from '../lib/Seg'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type MapPoint } from '../api'
import { folderCrate } from './FolderTree'
import { useApp } from '../store'
import { cleanTitle, fmtBpm, hash, keyColor, parseKey, plural } from '../util'
import { energyColor, KeyBadge } from './bits'
import { MapModes, type MapMode } from './MapModes'

interface Props { scope: string; setScope: (s: string) => void; onMode: (m: MapMode) => void }
type ColorBy = 'key' | 'plays' | 'energy'

const PAD = { l: 52, r: 20, t: 64, b: 70 }

/** La rueda Camelot (plana, como siempre): cada tono en su gajo, A adentro y B afuera; más energía, más hacia el borde. */
export function CamelotWheel({ scope, setScope, onMode }: Props) {
  const { crates, virtualCrates, folders, selectedId, select, tags, toast, loadMeta, go, libraryVersion } = useApp()
  const [data, setData] = useState<{ points: MapPoint[]; edges: [number, number, string, number][] } | null>(null)
  const [colorBy, setColorBy] = useState<ColorBy>('key')
  const [showEdges, setShowEdges] = useState(false)
  const [hiTag, setHiTag] = useState<number | null>(null)
  const [recIds, setRecIds] = useState<number[]>([])
  const [hover, setHover] = useState<{ p: MapPoint; x: number; y: number } | null>(null)
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [boxSel, setBoxSel] = useState<number[] | null>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const drag = useRef<{ x: number; y: number; moved: boolean; box: boolean } | null>(null)

  useEffect(() => {
    setData(null)
    api.map(scope).then(setData).catch((e) => toast(e.message, 'error'))
  }, [scope, libraryVersion, toast])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // recomendaciones del seleccionado → anillos naranjas
  useEffect(() => {
    if (selectedId == null) { setRecIds([]); return }
    api.recommendations(selectedId, scope === 'all' ? null : scope).then((r) => setRecIds(r.items.slice(0, 10).map((i) => i.id))).catch(() => setRecIds([]))
  }, [selectedId, scope])

  const pts = useMemo(() => {
    if (!data) return []
    return data.points.filter((p) => p[3] != null).map((p) => {
      const h = hash(p[0]), h2 = hash(p[0] * 7 + 3)
      // sin energía (temas de Traktor/Serato sin analizar): al medio de su anillo, dibujados huecos
      const noEnergy = p[2] == null
      const e = noEnergy ? 5.5 : p[2] as number
      const jitterY = noEnergy ? (h2 - 0.5) * 3 : Number.isInteger(e) ? (h2 - 0.5) * 0.5 : 0
      return { p, x: p[1] + (h - 0.5) * 0.5, y: e + jitterY, h, h2, noEnergy }
    })
  }, [data])

  const noEnergyCount = useMemo(() => pts.filter((q) => q.noEnergy).length, [pts])
  const maxPlays = useMemo(() => Math.max(1, ...pts.map((q) => q.p[7])), [pts])
  const byId = useMemo(() => new Map(pts.map((q) => [q.p[0], q])), [pts])

  const toScreen = useCallback((q: { x: number; y: number; p: MapPoint; h: number; h2: number; noEnergy?: boolean }): [number, number] | null => {
    const W = size.w - PAD.l - PAD.r, H = size.h - PAD.t - PAD.b
    const k = parseKey(q.p[3])
    if (!k) return null
    const cx = size.w / 2, cy = PAD.t + H / 2 + 8
    const R = Math.min(W, H) / 2 - 10
    const ang = ((k[0] - 1) / 12) * Math.PI * 2 - Math.PI / 2 + (q.h - 0.5) * 0.42
    const ring = k[1] === 'A' ? [0.2, 0.58] : [0.62, 1]
    const e = Math.min(10, Math.max(1, q.y)) / 10
    const r = R * (ring[0] + (ring[1] - ring[0]) * e)
    return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]
  }, [size])

  const colorOf = useCallback((p: MapPoint, a = 1) => {
    if (colorBy === 'key') return keyColor(p[3], a)
    if (colorBy === 'energy') return energyColor(p[2] ?? 1)
    const t = Math.log1p(p[7]) / Math.log1p(maxPlays)
    return `hsla(${30 - t * 10}, ${30 + t * 70}%, ${30 + t * 35}%, ${a})`
  }, [colorBy, maxPlays])

  // ---------------------------------------------------------------- dibujo
  useEffect(() => {
    const c = cv.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr; c.height = size.h * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, size.w, size.h)
    const W = size.w - PAD.l - PAD.r, H = size.h - PAD.t - PAD.b
    ctx.font = '10px "JetBrains Mono Variable", monospace'

    const cx = size.w / 2, cy = PAD.t + H / 2 + 8, R = Math.min(W, H) / 2 - 10
    for (let n = 1; n <= 12; n++) {
      const a0 = ((n - 1.5) / 12) * Math.PI * 2 - Math.PI / 2, a1 = a0 + (Math.PI * 2) / 12
      for (const [l, r0, r1] of [['A', 0.2, 0.58], ['B', 0.62, 1]] as const) {
        ctx.beginPath(); ctx.arc(cx, cy, R * r1, a0, a1); ctx.arc(cx, cy, R * r0, a1, a0, true); ctx.closePath()
        ctx.fillStyle = keyColor(`${n}${l}`, 0.06); ctx.fill()
        ctx.strokeStyle = 'rgba(14,13,12,0.9)'; ctx.lineWidth = 2; ctx.stroke()
      }
      const am = ((n - 1) / 12) * Math.PI * 2 - Math.PI / 2
      ctx.fillStyle = keyColor(`${n}B`); ctx.textAlign = 'center'
      ctx.fillText(`${n}B`, cx + Math.cos(am) * (R + 14), cy + Math.sin(am) * (R + 14) + 3)
      ctx.fillStyle = keyColor(`${n}A`)
      ctx.fillText(`${n}A`, cx + Math.cos(am) * R * 0.12, cy + Math.sin(am) * R * 0.12 + 3)
    }

    ctx.save()

    if (showEdges && data) {
      ctx.lineWidth = 1
      for (const [a, b, kind, count] of data.edges) {
        if (kind === 'history' && count < 2) continue
        const qa = byId.get(a), qb = byId.get(b)
        if (!qa || !qb) continue
        const sa = toScreen(qa), sb = toScreen(qb)
        if (!sa || !sb) continue
        ctx.strokeStyle = kind === 'history' ? `rgba(234,203,134,${Math.min(0.35, 0.06 * count)})` : kind === 'avoid' ? 'rgba(239,91,76,0.25)' : 'rgba(155,227,169,0.4)'
        ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke()
      }
    }

    const sel = selectedId != null ? byId.get(selectedId) : undefined
    const dimOthers = hiTag != null || sel
    for (const q of pts) {
      const s = toScreen(q)
      if (!s) continue
      const hasTag = hiTag == null || q.p[9].includes(hiTag)
      const r = 1.8 + q.p[4] * 0.55
      const color = colorOf(q.p, !hasTag ? 0.08 : dimOthers ? 0.38 : 0.82)
      ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2)
      if (q.noEnergy) { ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke() } else { ctx.fillStyle = color; ctx.fill() }
      if (hiTag != null && hasTag) { ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.stroke() }
    }

    if (sel && data) {
      const ss = toScreen(sel)
      if (ss) {
        for (const [a, b, kind, count] of data.edges) {
          if (a !== sel.p[0] && b !== sel.p[0]) continue
          const o = byId.get(a === sel.p[0] ? b : a)
          const so = o && toScreen(o)
          if (!so) continue
          ctx.strokeStyle = kind === 'history' ? 'rgba(234,203,134,0.7)' : kind === 'avoid' ? 'rgba(239,91,76,0.8)' : 'rgba(155,227,169,0.95)'
          ctx.lineWidth = kind === 'history' ? Math.min(3, 0.8 + count * 0.4) : 2
          ctx.beginPath(); ctx.moveTo(ss[0], ss[1]); ctx.lineTo(so[0], so[1]); ctx.stroke()
          ctx.fillStyle = colorOf(o!.p); ctx.beginPath(); ctx.arc(so[0], so[1], 4, 0, Math.PI * 2); ctx.fill()
        }
        ctx.setLineDash([3, 4]); ctx.lineWidth = 1.2
        for (const id of recIds) {
          const o = byId.get(id); const so = o && toScreen(o)
          if (!so) continue
          ctx.strokeStyle = 'rgba(255,90,31,0.55)'
          ctx.beginPath(); ctx.moveTo(ss[0], ss[1]); ctx.lineTo(so[0], so[1]); ctx.stroke()
          ctx.beginPath(); ctx.arc(so[0], so[1], 7, 0, Math.PI * 2); ctx.stroke()
        }
        ctx.setLineDash([])
        ctx.fillStyle = colorOf(sel.p); ctx.beginPath(); ctx.arc(ss[0], ss[1], 7, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
      }
    }
    ctx.restore()

    if (box) {
      ctx.fillStyle = 'rgba(255,90,31,0.08)'; ctx.strokeStyle = 'rgba(255,90,31,0.8)'; ctx.lineWidth = 1
      const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1)
      ctx.fillRect(x, y, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
    }
  }, [pts, size, colorOf, showEdges, data, byId, toScreen, selectedId, recIds, hiTag, box])

  // ---------------------------------------------------------------- interacción
  const nearest = (mx: number, my: number) => {
    let best: (typeof pts)[number] | null = null, bd = 100
    for (const q of pts) {
      const s = toScreen(q)
      if (!s) continue
      const d = (s[0] - mx) ** 2 + (s[1] - my) ** 2
      if (d < bd) { bd = d; best = q }
    }
    return best
  }

  const selectBox = (b: NonNullable<typeof box>) => {
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1)
    const ids = pts.filter((q) => { const s = toScreen(q); return s && s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1 }).map((q) => q.p[0])
    setBoxSel(ids.length ? ids : null)
  }

  const here = folderCrate(scope, folders) ?? artistCrate(scope)
  const scopes = [...(here ? [here] : []), ...virtualCrates.filter((c) => c.id !== 'hidden'), ...crates.filter((c) => !c.hidden && ['playlist', 'user', 'smart'].includes(c.kind) && c.count > 0)]

  return (
    <>
      <header className="viewhead">
        <div>
          <h1>Mapa</h1>
          <div className="sub">{data ? plural(pts.length, 'tema', 'temas') : 'Cargando…'}</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm icon help-btn" aria-label="Cómo se usa" title="Click en un punto para ver la ficha · ⇧ + arrastrar para seleccionar">?</button>
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} style={{ maxWidth: 240 }}>
          {scopes.map((c) => <option key={c.id} value={String(c.id)}>{c.name} ({c.count})</option>)}
        </select>
      </header>
      <div className="mapview" ref={wrap}>
        <canvas
          ref={cv}
          onMouseDown={(e) => {
            const r = cv.current!.getBoundingClientRect()
            drag.current = { x: e.clientX, y: e.clientY, moved: false, box: e.shiftKey }
            if (e.shiftKey) setBox({ x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top })
          }}
          onMouseMove={(e) => {
            const r = cv.current!.getBoundingClientRect()
            const mx = e.clientX - r.left, my = e.clientY - r.top
            const dg = drag.current
            if (dg) {
              if (Math.abs(e.clientX - dg.x) + Math.abs(e.clientY - dg.y) > 3) dg.moved = true
              if (dg.box) { setBox((b) => b && { ...b, x1: mx, y1: my }); return }
            }
            const q = nearest(mx, my)
            setHover(q ? { p: q.p, x: mx, y: my } : null)
          }}
          onMouseUp={(e) => {
            const dg = drag.current
            drag.current = null
            if (dg?.box && box) { selectBox(box); setBox(null); return }
            if (dg && !dg.moved) {
              const r = cv.current!.getBoundingClientRect()
              const q = nearest(e.clientX - r.left, e.clientY - r.top)
              select(q ? q.p[0] : null)
            }
          }}
          onMouseLeave={() => { setHover(null); drag.current = null; setBox(null) }}
        />
        <div className="map-ui" style={{ top: 14 }}>
          <MapModes mode="wheel" onMode={onMode} />
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
        </div>
        <div className="map-legend">
          {colorBy === 'key' && <span>Menores (A) adentro, mayores (B) afuera. Más energía, más cerca del borde.</span>}
          {noEnergyCount > 0 && <span>{plural(noEnergyCount, 'tema hueco', 'temas huecos')}: sin energía todavía, van en el medio de su anillo. Analizalos para ubicarlos bien.</span>}
          {selectedId != null && <span><span style={{ color: '#9be3a9' }}>━</span> tus relaciones · <span style={{ color: '#eacb86' }}>━</span> historial · <span style={{ color: '#ff5a1f' }}>◌</span> sugeridos</span>}
        </div>
        {hover && (
          <div className="map-tip" style={{ left: Math.min(hover.x + 14, size.w - 290), top: hover.y + 14 }}>
            <b className="ellipsis">{cleanTitle(hover.p[5])}</b>
            <span className="muted ellipsis">{hover.p[6] || '—'}</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3 }}>
              <span className="num">{fmtBpm(hover.p[1])} BPM</span><KeyBadge k={hover.p[3]} /><span className="num muted">energía {Math.round(hover.p[2] ?? 0)}</span>
              {hover.p[7] > 0 && <span className="num muted">{hover.p[7]}× tocado</span>}
            </span>
          </div>
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
