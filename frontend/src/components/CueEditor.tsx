import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type CueDto, type CuesInfo } from '../api'
import { spring, usePresence } from '../lib/motion'
import { useApp, usePlayer } from '../store'
import type { TrackDetail, Waveform } from '../types'
import { cleanTitle, fmtBpm } from '../util'
import { cueColor as colorOf, cueLabel, PADS, rgba as css } from '../lib/cues'
import { usePreciseAudio } from './cueeditor/engine'
import { paintPeaks, paintRuler, peakOf } from './cueeditor/paint'
import { IconPause, IconPlay, IconX } from './icons'

const ZOOMS = [0.25, 1, 3, 6, 12, 30, 90] as const
const MIN_WIN = 0.12, MAX_WIN = 150
const clampWin = (w: number) => Math.min(MAX_WIN, Math.max(MIN_WIN, w))
const LOOPS = [1, 2, 4, 8, 16, 32] as const

function fmtMs(ms: number): string {
  const t = Math.max(0, ms) / 1000
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

/** Tiempos (s) de cada beat a partir de los compases de la grilla (o del BPM si no hay grilla). */
function beatsOf(downbeats: number[], bpm: number | null, dur: number): number[] {
  const out: number[] = []
  if (downbeats.length >= 2) {
    const first = (downbeats[1] - downbeats[0]) / 4
    for (let t = downbeats[0] - first; t >= 0; t -= first) out.unshift(t)
    for (let i = 0; i < downbeats.length; i++) {
      const step = ((downbeats[i + 1] ?? downbeats[i] + (downbeats[i] - downbeats[i - 1])) - downbeats[i]) / 4
      for (let k = 0; k < 4; k++) out.push(downbeats[i] + k * step)
    }
    return out
  }
  if (bpm) for (let t = 0; t < dur; t += 60 / bpm) out.push(t)
  return out
}

interface Grid { inizio: number; bpm: number; battito: number }

/** Beats y compases de una grilla fija (tempo constante). */
function gridBeats(g: Grid, dur: number): { beats: number[]; bars: number[] } {
  const beat = 60 / g.bpm
  const beats: number[] = [], bars: number[] = []
  const k0 = -Math.floor(g.inizio / beat)                      // primer beat con tiempo >= 0
  for (let k = k0; ; k++) {
    const t = g.inizio + k * beat
    if (t > dur) break
    if (t < 0) continue
    beats.push(t)
    if ((((k + g.battito - 1) % 4) + 4) % 4 === 0) bars.push(t)
  }
  return { beats, bars }
}

function nearest(sorted: number[], t: number): number {
  if (!sorted.length) return t
  let lo = 0, hi = sorted.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < t) lo = mid + 1; else hi = mid }
  const a = sorted[Math.max(0, lo - 1)], b = sorted[lo]
  return Math.abs(a - t) <= Math.abs(b - t) ? a : b
}

/** Tiempo editable (m:ss.mmm o segundos): se aplica al salir del campo o con Enter. */
function TimeInput({ ms, onCommit }: { ms: number; onCommit: (ms: number) => void }) {
  const [text, setText] = useState(fmtMs(ms))
  useEffect(() => { setText(fmtMs(ms)) }, [ms])
  const commit = () => {
    const m = /^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/.exec(text.trim())
    if (!m) { setText(fmtMs(ms)); return }
    const v = ((m[1] ? Number(m[1]) * 60 : 0) + Number(m[2].replace(',', '.'))) * 1000
    onCommit(Math.max(0, Math.round(v)))
  }
  return <input className="input ce-timein num" value={text} aria-label="Posición de la cue" onChange={(e) => setText(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
}

/** BPM editable: se escribe libremente y se aplica al salir del campo o con Enter. */
function BpmInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(value.toFixed(2))
  useEffect(() => { setText(value.toFixed(2)) }, [value])
  const commit = () => { const v = Number(text.replace(',', '.')); if (Number.isFinite(v) && v >= 40 && v <= 300) onCommit(Math.round(v * 100) / 100); else setText(value.toFixed(2)) }
  return <input className="input ce-bpm num" inputMode="decimal" value={text} aria-label="BPM de la grilla"
    onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }} />
}

export function CueEditor() {
  const id = useApp((s) => s.cueEditorId)
  const [shown, closing] = usePresence(id, spring.slow.exit)
  if (shown == null) return null
  return <Editor key={shown} id={shown} closing={closing} />
}

function Editor({ id, closing }: { id: number; closing: boolean }) {
  const close = useApp((s) => s.setCueEditor)
  const toast = useApp((s) => s.toast)
  const [track, setTrack] = useState<TrackDetail | null>(null)
  const [wave, setWave] = useState<Waveform | null>(null)
  const [downbeats, setDownbeats] = useState<number[]>([])
  const [info, setInfo] = useState<CuesInfo | null>(null)
  const [cues, setCues] = useState<CueDto[]>([])
  const [saved, setSaved] = useState('[]')
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [win, setWin] = useState<number>(6)
  const [loopBeats, setLoopBeats] = useState<number>(4)
  const [loopMode, setLoopMode] = useState(false)
  const [quantize, setQuantize] = useState(true)
  const [time, setTime] = useState(0)
  const [busy, setBusy] = useState(false)
  const [gridDraft, setGridDraft] = useState<Grid | null>(null)      // grilla corregida (null = la original del tema)
  const [gridSaved, setGridSaved] = useState<string>('null')
  const [baseGrid, setBaseGrid] = useState<Grid | null>(null)        // la grilla original, de donde se parte al corregir
  const [loopSlot, setLoopSlot] = useState<number | null>(null)      // loop que se está repitiendo
  const appliedLoop = useRef('')
  const detail = useRef<HTMLCanvasElement>(null)
  const overview = useRef<HTMLCanvasElement>(null)

  const eng = usePreciseAudio(id)
  const { buffer, peaks, playing } = eng
  const dur = buffer?.duration ?? wave?.duration ?? track?.duration ?? 0
  const gain = useMemo(() => (peaks ? Math.min(20, 0.95 / peakOf(peaks)) : 1), [peaks])
  const grid = useMemo(() => (gridDraft ? gridBeats(gridDraft, dur) : null), [gridDraft, dur])
  const beats = useMemo(() => grid?.beats ?? beatsOf(downbeats, track?.bpm ?? null, dur), [grid, downbeats, track?.bpm, dur])
  const bars = grid?.bars ?? downbeats
  const online = !!track?.online && !eng.error
  const gridDirty = JSON.stringify(gridDraft) !== gridSaved
  const dirty = JSON.stringify(cues) !== saved || gridDirty

  // ---- carga
  const load = useCallback(async () => {
    try {
      const [t, w, g] = await Promise.all([api.track(id), api.waveform(id, 4000).catch(() => null), api.grid(id)])
      let c = await api.cues(id)
      if (c.source === 'none' && c.from_rekordbox && !c.has_rekordbox) {
        // todavía no se leyeron las cues de rekordbox: se leen ahora (de una copia de su base)
        try { await api.refreshCues(); c = await api.cues(id) } catch { /* sin rekordbox: se edita igual */ }
      }
      setTrack(t); setWave(w); setDownbeats(g.downbeats); setInfo(c)
      const list = c.cues.filter((q) => q.slot == null || q.slot < PADS.length)
      setCues(list); setSaved(JSON.stringify(list))
      // grilla original: la del primer tramo de rekordbox (o la que Batea calculó); si ya hay una corregida, esa
      const first = c.grid[0]
      const orig: Grid | null = first ? { inizio: Number(first.inizio), bpm: Number(first.bpm), battito: Number(first.battito) }
        : g.downbeats.length && (g.bpm ?? t.bpm) ? { inizio: g.downbeats[0], bpm: (g.bpm ?? t.bpm) as number, battito: 1 } : null
      setBaseGrid(orig)
      const mine = c.user_grid ? { inizio: c.user_grid.inizio, bpm: c.user_grid.bpm, battito: c.user_grid.battito } : null
      setGridDraft(mine); setGridSaved(JSON.stringify(mine))
    } catch (e) { setError((e as Error).message) }
  }, [id])
  useEffect(() => { void load() }, [load])

  // ---- reproducción
  useEffect(() => { usePlayer.getState().stop() }, [])
  useEffect(() => {
    let raf = 0
    const tick = () => { setTime(eng.position()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [eng])

  const releaseLoop = useCallback(() => { appliedLoop.current = ''; setLoopSlot(null); eng.setLoop(null) }, [eng])
  const seek = useCallback((t: number, keepLoop = false) => {
    if (!keepLoop) releaseLoop()
    const to = Math.min(Math.max(0, t), dur || t)
    eng.seek(to)
    setTime(to)
  }, [dur, eng, releaseLoop])
  const toggle = useCallback(() => {
    if (!online || !buffer) return
    if (playing) eng.pause(); else eng.play()
  }, [online, buffer, playing, eng])

  // el loop activo sigue a sus cambios (si se lo arrastra o se corrige la grilla, sigue sonando el tramo nuevo)
  const activeLoop = loopSlot != null ? cues.find((q) => q.kind === 'loop' && q.slot === loopSlot) : undefined
  const loopKey = activeLoop ? `${activeLoop.start_ms}-${activeLoop.end_ms}` : ''
  useEffect(() => {
    if (loopKey === appliedLoop.current) return
    appliedLoop.current = loopKey
    eng.setLoop(activeLoop && activeLoop.end_ms != null ? { start: activeLoop.start_ms / 1000, end: activeLoop.end_ms / 1000 } : null)
  }, [activeLoop, loopKey, eng])
  const engage = useCallback((q: CueDto) => {                       // empezar a repetir un loop
    if (q.end_ms == null || q.slot == null) return
    const lp = { start: q.start_ms / 1000, end: q.end_ms / 1000 }
    appliedLoop.current = `${q.start_ms}-${q.end_ms}`
    setLoopSlot(q.slot)
    eng.seek(lp.start); eng.setLoop(lp)
    if (online) eng.play(lp)
    setTime(lp.start)
  }, [eng, online])

  const snap = useCallback((t: number, free = false) => (quantize && !free ? nearest(beats, t) : t), [quantize, beats])
  const beatLen = useMemo(() => {
    const i = beats.findIndex((b) => b >= time)
    return i > 0 && i < beats.length ? beats[i] - beats[i - 1] : track?.bpm ? 60 / track.bpm : 0.5
  }, [beats, time, track?.bpm])

  // ---- cambios
  const sorted = (list: CueDto[]) => [...list].sort((a, b) => a.start_ms - b.start_ms)
  const addMemory = useCallback(() => {
    const ms = Math.round(snap(eng.position()) * 1000)
    if (cues.some((q) => q.kind === 'memory' && Math.abs(q.start_ms - ms) < 2)) return
    const cue: CueDto = { kind: 'memory', slot: null, start_ms: ms, end_ms: null, name: null, rgb: null }
    const next = sorted([...cues, cue])
    setCues(next); setSel(next.indexOf(cue))
  }, [snap, eng, cues])
  const pad = useCallback((slot: number) => {
    const at = cues.findIndex((q) => q.slot === slot)
    if (at >= 0) {                                                                   // pad ocupado: saltar ahí
      setSel(at)
      if (cues[at].kind === 'loop') {
        if (loopSlot === slot) releaseLoop(); else engage(cues[at])                  // segundo toque: soltar el loop
      } else seek(cues[at].start_ms / 1000)
      return
    }
    const start = Math.round(snap(eng.position()) * 1000)
    const cue: CueDto = loopMode
      ? { kind: 'loop', slot, start_ms: start, end_ms: Math.round(start + loopBeats * beatLen * 1000), name: null, rgb: null }
      : { kind: 'hot', slot, start_ms: start, end_ms: null, name: null, rgb: null }
    const next = sorted([...cues, cue])
    setCues(next); setSel(next.indexOf(cue))                                         // queda elegida, lista para afinar
    if (cue.kind === 'loop') engage(cue)                                             // un loop nuevo empieza a repetir
  }, [cues, seek, snap, eng, loopMode, loopBeats, beatLen, loopSlot, engage, releaseLoop])
  const remove = useCallback((i: number) => {
    setCues((l) => { if (l[i] && l[i].slot === loopSlot) releaseLoop(); return l.filter((_, k) => k !== i) })
    setSel(null)
  }, [loopSlot, releaseLoop])
  const patch = (i: number, p: Partial<CueDto>) => setCues((l) => l.map((q, k) => (k === i ? { ...q, ...p } : q)))
  /** Corre la cue elegida (y su final, si es un loop) a la posición dada. */
  const moveCue = useCallback((i: number, ms: number) => setCues((l) => l.map((q, k) => {
    if (k !== i) return q
    const to = Math.max(0, Math.round(ms))
    return { ...q, start_ms: to, end_ms: q.end_ms != null ? to + (q.end_ms - q.start_ms) : null }
  })), [])
  const selCue = sel != null ? cues[sel] ?? null : null

  const save = useCallback(async () => {
    setBusy(true)
    try {
      if (JSON.stringify(cues) !== saved) {
        await api.saveCues(id, cues)
        setSaved(JSON.stringify(cues))
        setInfo((i) => i && { ...i, source: 'batea' })
      }
      if (gridDirty) {
        if (gridDraft) await api.saveGrid(id, gridDraft); else await api.resetGrid(id)
        setGridSaved(JSON.stringify(gridDraft))
      }
      useApp.getState().bumpCues()
      toast(gridDirty ? 'Guardado. Cues y grilla se llevan a rekordbox al exportar con “Llevar cues y grilla”.' : 'Cues guardadas. Se llevan a rekordbox al exportar con “Llevar cues y grilla”.')
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }, [cues, saved, gridDirty, gridDraft, id, toast])
  const revert = async () => {
    if (!window.confirm('¿Volver a las cues de rekordbox? Las que editaste en Batea para este tema se descartan.')) return
    setBusy(true)
    try { await api.resetCues(id); await load(); useApp.getState().bumpCues(); toast('Vuelven a verse las cues de rekordbox') } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }

  // ---- grilla
  const gridNow = gridDraft ?? baseGrid
  const editGrid = (p: Partial<Grid>) => { if (gridNow) setGridDraft({ ...gridNow, ...p }) }
  const shiftGrid = (ms: number) => { if (gridNow) setGridDraft({ ...gridNow, inizio: Math.round((gridNow.inizio + ms / 1000) * 1000) / 1000 }) }
  const setOne = () => { if (gridNow) setGridDraft({ ...gridNow, inizio: Math.round(eng.position() * 1000) / 1000, battito: 1 }) }   // "acá cae el 1 de un compás"
  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Cerrar igual?')) return
    close(null)
  }, [dirty, close])

  // ---- teclado
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select')
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); requestClose(); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) void save(); return }
      if (typing || e.metaKey || e.ctrlKey) return
      if (e.code === 'Space') { e.preventDefault(); toggle() }
      else if (/^[1-8]$/.test(e.key)) { e.preventDefault(); pad(Number(e.key) - 1) }
      else if (e.key.toLowerCase() === 'm') { e.preventDefault(); addMemory() }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (sel != null) { e.preventDefault(); remove(sel) } }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setWin((w) => clampWin(w / 1.5)) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setWin((w) => clampWin(w * 1.5)) }
      else if ((e.key === '[' || e.key === ']') && selCue && sel != null) {              // ajuste fino de la cue elegida
        e.preventDefault()
        moveCue(sel, selCue.start_ms + (e.key === '[' ? -1 : 1) * (e.shiftKey ? 10 : 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        seek(eng.position() + dir * (e.altKey ? (e.shiftKey ? 0.001 : 0.01) : e.shiftKey ? beatLen * 4 : beatLen))
      } else return
      e.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [addMemory, beatLen, dirty, eng, moveCue, pad, remove, requestClose, save, seek, sel, selCue, toggle])

  // ---- dibujo
  const draw = useCallback((cv: HTMLCanvasElement | null, t0: number, t1: number, big: boolean) => {
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.clientWidth, h = cv.clientHeight
    if (!w || !h) return
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const x = (t: number) => ((t - t0) / (t1 - t0)) * w
    const mid = h / 2
    const sampleRes = big && buffer && (peaks || (t1 - t0) * buffer.sampleRate / w < 2000)
    if (sampleRes && buffer) {
      paintPeaks(ctx, w, h, t0, t1 - t0, buffer, peaks, gain, wave)             // a nivel de muestra
    } else if (wave && dur) {
      const n = wave.h.length
      for (let px = 0; px < w; px++) {
        const t = t0 + (px / w) * (t1 - t0)
        if (t < 0 || t > dur) continue
        const i = Math.min(n - 1, Math.floor((t / dur) * n))
        const amp = (wave.h[i] / 255) * (mid - 2)
        const lo = wave.low[i] / 255, mi = (wave.mid[i] / 255) * 1.35, hi = (wave.high[i] / 255) * 1.9
        const s = lo + mi + hi + 1e-6
        ctx.fillStyle = `rgb(${((255 * lo + 233 * mi + 125 * hi) / s) | 0}, ${((90 * lo + 223 * mi + 211 * hi) / s) | 0}, ${((31 * lo + 198 * mi + 252 * hi) / s) | 0})`
        ctx.fillRect(px, mid - amp, 1, Math.max(1, amp * 2))
      }
    }
    if (big) {                                                   // líneas de beat (y de compás, más marcadas)
      const bar = new Set(bars.map((d) => Math.round(d * 1000)))
      for (const b of beats) {
        if (b < t0 || b > t1) continue
        ctx.fillStyle = bar.has(Math.round(b * 1000)) ? 'rgba(236,230,220,0.5)' : 'rgba(236,230,220,0.25)'
        ctx.fillRect(Math.round(x(b)), 0, 1, h)
      }
      paintRuler(ctx, w, h, t0, t1 - t0)
    }
    cues.forEach((q, i) => {
      const c = colorOf(q), a = q.start_ms / 1000, b = q.end_ms != null ? q.end_ms / 1000 : null
      if (b != null && b > t0 && a < t1) { ctx.fillStyle = css(c, q.slot != null && q.slot === loopSlot ? 0.42 : 0.18); ctx.fillRect(x(a), 0, x(b) - x(a), h) }
      if (a < t0 - 1 || a > t1 + 1) return
      ctx.fillStyle = css(c, i === sel ? 1 : 0.9)
      ctx.fillRect(Math.round(x(a)) - (i === sel ? 1 : 0), 0, i === sel ? 3 : 2, h)
      if (big) {
        const label = cueLabel(q)
        ctx.font = '700 11px ui-monospace, Menlo, monospace'
        const tw = ctx.measureText(label).width + 10
        ctx.fillRect(Math.round(x(a)), 0, tw, 16)
        ctx.fillStyle = '#0e0d0c'
        ctx.fillText(label, Math.round(x(a)) + 5, 12)
      }
    })
    if (!big) {                                                  // en la vista general: qué tramo muestra el detalle
      const wa = x(time - win / 2), wb = x(time + win / 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1
      ctx.strokeRect(Math.round(wa) + 0.5, 0.5, Math.max(3, Math.round(wb - wa)), h - 1)
    }
    ctx.fillStyle = '#fff'
    ctx.fillRect(Math.round(x(time)), 0, big ? 2 : 1.5, h)
  }, [wave, buffer, peaks, gain, dur, beats, bars, cues, sel, time, win, loopSlot])

  useEffect(() => {
    draw(detail.current, time - win / 2, time + win / 2, true)
    draw(overview.current, 0, dur || 1, false)
  }, [draw, time, win, dur])

  // ---- zoom con la rueda (alrededor del cabezal)
  useEffect(() => {
    const cv = detail.current
    if (!cv) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      setWin((w) => clampWin(w * Math.pow(1.0022, d)))
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  })

  // ---- ratón: en el detalle, arrastrar una marca la mueve; arrastrar el fondo recorre el tema
  const onDetailDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget
    const r = cv.getBoundingClientRect()
    const px = e.clientX - r.left
    const t0 = time - win / 2
    const xOf = (ms: number) => ((ms / 1000 - t0) / win) * r.width
    const hit = e.shiftKey ? -1 : cues.findIndex((q) => Math.abs(xOf(q.start_ms) - px) <= 6)
    let lastX = e.clientX
    cv.setPointerCapture(e.pointerId)
    if (e.shiftKey && gridNow) {                                   // Mayús + arrastrar: corre la grilla
      const base = gridNow
      const move = (ev: PointerEvent) => setGridDraft({ ...base, inizio: Math.round((base.inizio + ((ev.clientX - e.clientX) / r.width) * win) * 1000) / 1000 })
      const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up) }
      cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up)
    } else if (hit >= 0) {
      setSel(hit)
      const move = (ev: PointerEvent) => {
        const t = t0 + ((ev.clientX - r.left) / r.width) * win
        moveCue(hit, snap(t, ev.altKey) * 1000)
      }
      const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); setCues((l) => sorted(l)) }
      cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up)
    } else {
      const move = (ev: PointerEvent) => { seek(eng.position() - ((ev.clientX - lastX) / r.width) * win); lastX = ev.clientX }
      const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up) }
      cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up)
    }
  }
  const onOverviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    seek(((e.clientX - r.left) / r.width) * dur)
  }

  if (error) return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <div className="modal" role="dialog"><h2>Cues</h2><p className="muted">{error}</p><button className="btn" onClick={() => close(null)}>Cerrar</button></div>
    </div>
  )

  const bySlot = new Map(cues.map((q, i) => [q.slot, i] as const).filter(([s]) => s != null))
  const sourceText = info?.source === 'batea' ? 'Cues editadas en Batea' : info?.source === 'rekordbox-xml' ? 'Cues de rekordbox (del XML)'
    : info?.source === 'rekordbox' ? 'Cues de rekordbox' : 'Este tema no tiene cues'
  const msPerPx = (win * 1000) / 1030
  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="modal cue-editor" role="dialog" aria-modal="true" aria-labelledby="cue-title">
        <div className="ce-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="cue-title">Cues</h2>
            <div className="muted ellipsis" style={{ fontSize: 12.5 }}>
              {track ? `${cleanTitle(track.title)}${track.artist ? ` · ${track.artist}` : ''} · ${fmtBpm(track.bpm)} BPM` : 'Cargando…'}
            </div>
          </div>
          <span className={`ce-source${info?.source === 'batea' ? ' mine' : ''}`}>{sourceText}{dirty ? ' · sin guardar' : ''}</span>
          <button className="btn ghost sm icon" aria-label="Cerrar" title="Cerrar (Esc)" onClick={requestClose}><IconX size={16} /></button>
        </div>

        <canvas ref={overview} className="ce-overview" onClick={onOverviewClick} aria-label="Todo el tema" />
        <canvas ref={detail} className="ce-detail" onPointerDown={onDetailDown} aria-label="Detalle: arrastrá para recorrer, la rueda hace zoom, o arrastrá una marca para moverla" />

        <div className="ce-transport">
          <button className="playbtn" disabled={!online || !buffer} onClick={toggle} aria-label={playing ? 'Pausar' : 'Reproducir'}>
            {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>
          <span className="num ce-time">{fmtMs(time * 1000)}</span>
          <div className="ce-zoom" role="group" aria-label="Zoom" title="También con la rueda del mouse sobre el detalle, o las teclas + y −">
            <span className="muted">Zoom</span>
            <button className="ce-chip" onClick={() => setWin((w) => clampWin(w * 1.5))} aria-label="Alejar">−</button>
            {ZOOMS.map((w) => <button key={w} className={`ce-chip${Math.abs(Math.log(win / w)) < 0.12 ? ' on' : ''}`} onClick={() => setWin(w)}>{w} s</button>)}
            <button className="ce-chip" onClick={() => setWin((w) => clampWin(w / 1.5))} aria-label="Acercar">+</button>
            <span className="muted num" title="Cuánto tiempo hay en cada píxel">1 px = {msPerPx < 10 ? msPerPx.toFixed(1) : Math.round(msPerPx)} ms</span>
          </div>
          <label className="ce-check" title="Las cues nuevas y las que movés caen en el beat más cercano. Con Alt al arrastrar, libres.">
            <input type="checkbox" checked={quantize} onChange={(e) => setQuantize(e.target.checked)} /> Pegar al beat
          </label>
          {loopSlot != null && <button className="ce-chip on" onClick={releaseLoop} title="Soltar el loop">↻ Loop {PADS[loopSlot]} activo · Soltar</button>}
          {eng.loading && <span className="muted">Preparando el audio…</span>}
          {buffer && !peaks && <span className="muted">Afinando la onda…</span>}
          {(eng.error || (track && !track.online)) && <span className="muted">{eng.error ?? 'El archivo no está disponible'}: no se puede escuchar.</span>}
        </div>

        <div className="ce-grid" role="group" aria-label="Grilla">
          <b>Grilla</b>
          {gridNow ? (
            <>
              <span className="muted num">
                {gridNow.bpm.toFixed(2)} BPM · el beat {gridNow.battito} cae en {gridNow.inizio.toFixed(3)} s
                {gridDraft ? ' · corregida' : info && info.grid.length > 1 ? ` · de rekordbox, ${info.grid.length} tramos` : ''}
              </span>
              <div className="ce-zoom" title="Corren toda la grilla; con Mayús podés arrastrarla en el detalle">
                {[-10, -1, 1, 10].map((ms) => <button key={ms} className="ce-chip" onClick={() => shiftGrid(ms)}>{ms < 0 ? '◀' : ''} {Math.abs(ms)} ms {ms > 0 ? '▶' : ''}</button>)}
              </div>
              <button className="btn sm" onClick={setOne} title="El compás empieza donde está el cabezal">Este es el 1</button>
              <div className="ce-zoom">
                <button className="ce-chip" onClick={() => editGrid({ bpm: Math.max(40, Math.round((gridNow.bpm - 0.01) * 100) / 100) })}>−</button>
                <BpmInput value={gridNow.bpm} onCommit={(bpm) => editGrid({ bpm })} />
                <button className="ce-chip" onClick={() => editGrid({ bpm: Math.min(300, Math.round((gridNow.bpm + 0.01) * 100) / 100) })}>+</button>
                <button className="ce-chip" onClick={() => editGrid({ bpm: Math.max(40, Math.round((gridNow.bpm / 2) * 100) / 100) })} title="Mitad de BPM">½</button>
                <button className="ce-chip" onClick={() => editGrid({ bpm: Math.min(300, Math.round(gridNow.bpm * 2 * 100) / 100) })} title="Doble de BPM">2×</button>
              </div>
              {gridDraft && <button className="btn ghost sm" onClick={() => setGridDraft(null)}>Volver a la original</button>}
            </>
          ) : <span className="muted">Este tema no tiene grilla. Analizalo primero.</span>}
          {!gridDraft && info && info.grid.length > 1 && <span className="faint ce-note">Si la corregís, la grilla que cambia de tempo se reemplaza por una fija.</span>}
        </div>

        <div className="ce-pads" role="group" aria-label="Pads">
          {PADS.split('').map((name, slot) => {
            const i = bySlot.get(slot)
            const q = i != null ? cues[i] : null
            const c = q ? colorOf(q) : null
            return (
              <button key={slot} className={`ce-pad${q ? ' set' : ''}${i === sel ? ' sel' : ''}${loopSlot === slot ? ' looping' : ''}`} style={c ? { ['--pad' as string]: css(c) } : undefined}
                title={q ? (q.kind === 'loop' ? 'Repetir este loop (otro toque lo suelta)' : 'Saltar a esta cue (la podés mover arrastrando, o borrarla con Supr)') : `Poner la cue ${name} acá (tecla ${slot + 1})`}
                onClick={() => pad(slot)} onContextMenu={(e) => { e.preventDefault(); if (i != null) remove(i) }}>
                <b>{name}</b>
                <span className="num">{q ? fmtMs(q.start_ms) : loopMode ? 'loop' : '—'}</span>
                {q?.kind === 'loop' && <i className="ce-loop">↻ {Math.max(1, Math.round(((q.end_ms ?? 0) - q.start_ms) / 1000 / beatLen))}</i>}
              </button>
            )
          })}
        </div>

        {selCue && sel != null && (
          <div className="ce-fine" role="group" aria-label="Ajuste fino de la cue elegida">
            <span className="ce-badge" style={{ background: css(colorOf(selCue)) }}>{cueLabel(selCue)}</span>
            <b>Ajuste fino</b>
            <TimeInput ms={selCue.start_ms} onCommit={(ms) => moveCue(sel, ms)} />
            <div className="ce-zoom" title="También con las teclas [ y ] (con Mayús, de a 10 ms)">
              {[-10, -1, 1, 10].map((ms) => <button key={ms} className="ce-chip" onClick={() => moveCue(sel, selCue.start_ms + ms)}>{ms < 0 ? '◀' : ''} {Math.abs(ms)} ms {ms > 0 ? '▶' : ''}</button>)}
            </div>
            <button className="btn sm" onClick={() => moveCue(sel, Math.round(nearest(beats, selCue.start_ms / 1000) * 1000))} title="Lleva la cue al beat más cercano">Al beat</button>
            <button className="btn sm" onClick={() => moveCue(sel, Math.round(eng.position() * 1000))} title="Pone la cue donde está el cabezal">Acá</button>
            <button className="btn ghost sm" onClick={() => seek(selCue.start_ms / 1000)}>Ir a la cue</button>
          </div>
        )}

        <div className="ce-tools">
          <button className="btn sm" onClick={addMemory} title="Memory cue en el cabezal (tecla M)">+ Memory cue</button>
          <label className="ce-check"><input type="checkbox" checked={loopMode} onChange={(e) => setLoopMode(e.target.checked)} /> Los pads vacíos crean un loop de</label>
          <div className="ce-zoom">{LOOPS.map((n) => <button key={n} className={`ce-chip${loopBeats === n ? ' on' : ''}`} onClick={() => setLoopBeats(n)}>{n}</button>)}<span className="muted">beats</span></div>
        </div>

        <div className="ce-list">
          {cues.length === 0 && <div className="muted" style={{ padding: '10px 2px' }}>Todavía no hay cues. Poné el cabezal donde quieras y tocá un pad (o las teclas 1 a 8), o M para una memory cue.</div>}
          {cues.map((q, i) => (
            <div key={`${q.kind}-${q.slot}-${i}`} className={`ce-row${i === sel ? ' sel' : ''}`} onClick={() => { setSel(i); seek(q.start_ms / 1000) }}>
              <span className="ce-badge" style={{ background: css(colorOf(q)) }}>{q.kind === 'memory' ? 'M' : PADS[q.slot ?? 0]}</span>
              <span className="num">{fmtMs(q.start_ms)}</span>
              {q.kind === 'loop' && q.slot != null
                ? <button className={`ce-chip${loopSlot === q.slot ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); pad(q.slot as number) }} title="Repetir este loop">↻ {loopSlot === q.slot ? 'repitiendo' : 'repetir'} · {fmtMs(q.end_ms ?? 0)}</button>
                : <span className="muted">{q.kind === 'memory' ? 'memory cue' : 'hot cue'}</span>}
              <input className="input" placeholder="Nombre (opcional)" value={q.name ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => patch(i, { name: e.target.value || null })} />
              <button className="btn ghost sm icon" aria-label="Borrar la cue" title="Borrar" onClick={(e) => { e.stopPropagation(); remove(i) }}><IconX size={13} /></button>
            </div>
          ))}
        </div>

        <div className="ce-foot">
          <span className="muted" style={{ fontSize: 12 }}>Espacio: play · 1–8: pads · M: memory cue · ←/→: un beat (Alt: 10 ms) · +/−: zoom · [ ]: ajuste fino · ⌘S: guardar</span>
          <div style={{ flex: 1 }} />
          {info?.source === 'batea' && (info.has_rekordbox || info.from_rekordbox) && <button className="btn ghost" disabled={busy} onClick={() => void revert()}>Volver a las de rekordbox</button>}
          <button className="btn ghost" onClick={requestClose}>Cerrar</button>
          <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Guardando…' : 'Guardar cues'}</button>
        </div>
      </div>
    </div>
  )
}
