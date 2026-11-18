import { memo, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type Ref } from 'react'
import { Seg } from '../../lib/Seg'
import { IconMinus, IconPlus } from '../icons'
import { lanesOf, posToDb, upsert, type Automation, type LaneGroup, type LaneId, type Point } from './automation'
import { beatAt, clamp, KILL, nearestBar, signed, type Deck, type Placement, type Timing, type Transition } from './model'
import type { Peaks } from './peaks'
import { drawTimeline, laneBox, lanes, valueY } from './timelineDrawing'

interface View { left: number; span: number }
type Preset = 'mix' | 'all'
type DragMode = 'pan' | 'entry' | 'cue' | 'beat' | 'free' | 'point'

interface Drag {
  id: number
  x: number
  y: number
  left: number
  span: number
  placement: Placement
  mode: DragMode
  marker: boolean
  active: boolean
  time: number
  readout: string
  point?: { lane: LaneId; index: number; points: Point[] }
}

export interface TimelineHandle {
  zoomBy: (factor: number) => void
  playhead: (time: number, playing: boolean) => void
  reveal: (time: number) => void
  state: () => { w0: number; w1: number; bars: number; detailA: boolean; detailB: boolean; followAfter: number }
}

interface Props {
  ref: Ref<TimelineHandle>
  A: Deck
  B: Deck
  rate: number
  timing: Timing
  placement: Placement
  style: Transition
  automation: Automation
  group: LaneGroup
  setGroup: (group: LaneGroup) => void
  onAutomation: (lane: LaneId, points: Point[]) => void
  peaksA: Peaks | null
  peaksB: Peaks | null
  onSeek: (time: number) => void
  onPlacement: (patch: Partial<Placement>) => void
}

const GROUPS: ReadonlyArray<{ id: LaneGroup; label: string }> = [
  { id: 'x', label: 'Crossfader' }, { id: 0, label: 'Graves' }, { id: 1, label: 'Medios' }, { id: 2, label: 'Agudos' },
]
const dbText = (db: number) => db <= KILL ? 'kill' : `${signed(Math.round(db * 2) / 2).replace('.', ',')} dB`
const valueText = (lane: LaneId, v: number) => lane === 'x'
  ? (Math.abs(v - 0.5) < 0.005 ? 'centro' : `${Math.round((1 - v) * 100)}% A · ${Math.round(v * 100)}% B`)
  : `${lane[0]} ${dbText(v)}`

function fitMix({ A, timing, placement }: Props): View {
  const left = placement.mixBar >= 10 ? A.db[placement.mixBar - 10] : 0
  const overlapEnd = Math.max(timing.mixT, Math.min(timing.durA, timing.endB))
  return { left, span: Math.min(timing.end, overlapEnd + 8 * A.bar) - left }
}

export const Timeline = memo(function Timeline(props: Props) {
  const data = useRef(props)
  data.current = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const entry = useRef<HTMLButtonElement>(null)
  const cue = useRef<HTMLButtonElement>(null)
  const count = useRef<HTMLSpanElement>(null)
  const readout = useRef<HTMLDivElement>(null)
  const context = useRef<CanvasRenderingContext2D | null>(null)
  const view = useRef(fitMix(props))
  const size = useRef({ w: 0, h: 0 })
  const frame = useRef(0)
  const detail = useRef(0)
  const dirty = useRef(true)
  const currentTime = useRef<number | null>(null)
  const headX = useRef(NaN)
  const holdUntil = useRef(0)
  const drag = useRef<Drag | null>(null)
  const pending = useRef<PointerEvent<HTMLDivElement> | null>(null)
  const [preset, setPreset] = useState<Preset | null>('mix')
  const active = useRef<{ lane: LaneId; index: number } | null>(null)

  /** Qué curva y qué valor hay en la altura `y` de la franja del medio (null si está fuera). */
  const laneAt = (y: number): { lane: LaneId; v: number } | null => {
    const h = size.current.h
    const { aBottom, bTop, middle } = lanes(h)
    if (y < aBottom || y > bTop) return null
    const ids = lanesOf(data.current.group)
    const lane = ids.length === 1 || y < middle ? ids[0] : ids[1]
    const { top, bottom } = laneBox(h, lane)
    const r = clamp((y - top) / (bottom - top), 0, 1)
    return { lane, v: lane === 'x' ? Math.round(r * 100) / 100 : posToDb(1 - 2 * r) }
  }
  /** Punto de la curva bajo (x, y), si hay uno a menos de 7 px. */
  const pointAt = (x: number, y: number): { lane: LaneId; index: number } | null => {
    const { left, span } = view.current
    const { automation, timing, A, group } = data.current
    let best: { lane: LaneId; index: number } | null = null, dist = 7
    for (const lane of lanesOf(group)) {
      automation[lane].forEach((p, index) => {
        const px = (timing.mixT + p.at * A.bar - left) * size.current.w / span
        const d = Math.hypot(px - x, valueY(size.current.h, lane, p.v) - y)
        if (d <= dist) { dist = d; best = { lane, index } }
      })
    }
    return best
  }

  const placeHead = useCallback(() => {
    const time = currentTime.current
    const { left, span } = view.current
    if (time === null || !playhead.current) return
    const fraction = (time - left) / span
    const hidden = fraction < 0 || fraction > 1
    if (playhead.current.hidden !== hidden) playhead.current.hidden = hidden
    if (hidden) return
    const x = fraction * size.current.w
    if (headX.current === x) return
    headX.current = x
    playhead.current.style.transform = `translate3d(${x}px, 0, 0)`
  }, [])

  const updateDrag = useCallback(() => {
    const d = drag.current, e = pending.current
    pending.current = null
    if (!d || !e || !d.active) return
    const { A, B, rate, onPlacement } = data.current
    const dt = (e.clientX - d.x) * d.span / size.current.w
    const p = d.placement
    if (d.mode === 'point' && d.point) {
      const box = surface.current!.getBoundingClientRect()
      const x = e.clientX - box.left - surface.current!.clientLeft
      const y = e.clientY - box.top - surface.current!.clientTop
      const { lane, index, points } = d.point
      const step = e.altKey ? 0 : e.shiftKey ? 1 : 0.25          // beat; Mayús: compás; Opción: libre
      const raw = (view.current.left + x * view.current.span / size.current.w - data.current.timing.mixT) / A.bar
      const lo = points[index - 1]?.at ?? -Infinity, hi = points[index + 1]?.at ?? Infinity
      const at = clamp(step ? Math.round(raw / step) * step : Math.round(raw * 1000) / 1000, lo, hi)
      const { top, bottom } = laneBox(size.current.h, lane)
      const r = clamp((y - top) / (bottom - top), 0, 1)
      const v = lane === 'x' ? Math.round(r * 100) / 100 : posToDb(1 - 2 * r)
      const next = points.slice()
      next[index] = { at, v }
      d.point.points = next
      data.current.onAutomation(lane, next)
      d.readout = `${valueText(lane, v)} · compás ${(p.mixBar + 1 + at).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`
      if (readout.current) { readout.current.hidden = false; readout.current.textContent = d.readout }
      return
    }
    if (d.mode === 'pan') {
      view.current.left = clamp(d.left - dt, 0, data.current.timing.end - view.current.span)
      dirty.current = true
      return
    }
    const origin = A.db[p.mixBar]
    if (d.mode === 'entry') {
      const mixBar = nearestBar(A.db, origin + dt)
      onPlacement({ mixBar })
      d.readout = `Entra ${A.db.length - mixBar} compases antes del final`
    } else if (d.mode === 'cue') {
      const startBar = nearestBar(B.db, B.db[p.startBar] - dt * rate)
      onPlacement({ startBar })
      d.readout = `B arranca en el compás ${startBar + 1}`
    } else {
      const beat = beatAt(A, p.mixBar)
      const steps = Math.round(d.mode === 'beat' ? dt / beat : dt * 1000)
      const nudge = clamp(p.nudge + steps * (d.mode === 'beat' ? beat : 0.001), -A.bar * 4, A.bar * 4)
      onPlacement({ nudge })
      d.readout = d.mode === 'beat'
        ? `${signed(Math.round((nudge - p.nudge) / beat))} beat${Math.abs(steps) === 1 ? '' : 's'}`
        : `${signed(Math.round(nudge * 1000))} ms`
    }
    if (readout.current) {
      readout.current.hidden = false
      readout.current.textContent = d.readout
    }
  }, [])

  const requestDraw = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      updateDrag()
      const ctx = context.current
      const { w, h } = size.current
      if (!dirty.current || !ctx || !w || !h) return
      dirty.current = false
      const { left, span } = view.current
      const { timing, A } = data.current
      detail.current = drawTimeline(ctx, w, h, left, span, { ...data.current, active: active.current })
      const { bTop } = lanes(h)
      const entryX = (timing.mixT - left) * w / span
      const cueX = (timing.cueT - left) * w / span
      if (entry.current) {
        entry.current.hidden = entryX < 0 || entryX > w
        entry.current.style.left = `${entryX}px`
        if (entryX > w - 78) entry.current.dataset.flip = ''
        else delete entry.current.dataset.flip
      }
      if (cue.current) {
        cue.current.hidden = cueX < 0 || cueX > w
        cue.current.style.left = `${cueX}px`
        cue.current.style.top = `${bTop + 8}px`
        if (cueX > w - 96) cue.current.dataset.flip = ''
        else delete cue.current.dataset.flip
      }
      if (count.current) {
        const bars = span / A.bar
        count.current.textContent = `${Number(bars.toFixed(bars < 10 ? 1 : 0)).toLocaleString('es-AR')} compases`
      }
      if (surface.current) surface.current.classList.toggle('is-zoomed', span < timing.end - 0.01)
      placeHead()
    })
  }, [placeHead, updateDrag])

  const setView = useCallback((left: number, span: number) => {
    const { timing, A } = data.current
    const end = Math.max(0.01, timing.end)
    const width = clamp(span, Math.min(2 * A.bar, end), end)
    const start = clamp(left, 0, end - width)
    if (width === view.current.span && start === view.current.left) return
    view.current.left = start
    view.current.span = width
    dirty.current = true
    requestDraw()
  }, [requestDraw])

  const zoomBy = useCallback((factor: number, anchor = 0.5) => {
    const { timing, A } = data.current
    const end = Math.max(0.01, timing.end)
    const { left, span } = view.current
    const next = clamp(span * factor, Math.min(2 * A.bar, end), end)
    if (next === span) return
    holdUntil.current = performance.now() + 2000
    setPreset(null)
    setView(left + (span - next) * anchor, next)
  }, [setView])

  const selectPreset = (name: Preset) => {
    setPreset(name)
    holdUntil.current = performance.now() + 2000
    if (name === 'all') setView(0, props.timing.end)
    else {
      const { left, span } = fitMix(props)
      setView(left, span)
    }
  }

  useImperativeHandle(props.ref, () => ({
    zoomBy,
    playhead(time, playing) {
      currentTime.current = time
      const { left, span } = view.current
      if (playing && !drag.current && performance.now() >= holdUntil.current && (time < left || time > left + span)) {
        setPreset(null)
        setView(time - span * 0.18, span)
      }
      placeHead()
    },
    reveal(time) {
      const { left, span } = view.current
      if (time < left || time > left + span) {
        setPreset(null)
        setView(time - span * 0.2, span)
      }
    },
    state: () => ({
      w0: view.current.left, w1: view.current.left + view.current.span,
      bars: view.current.span / data.current.A.bar,
      detailA: Boolean(detail.current & 1), detailB: Boolean(detail.current & 2), followAfter: holdUntil.current,
    }),
  }), [placeHead, setView, zoomBy])

  useLayoutEffect(() => {
    const el = surface.current, cv = canvas.current
    if (!el || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    context.current = ctx
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight
      const dpr = window.devicePixelRatio || 1
      const pxW = Math.round(w * dpr), pxH = Math.round(h * dpr)
      if (cv.width !== pxW || cv.height !== pxH || !size.current.w) {
        cv.width = pxW
        cv.height = pxH
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      size.current = { w, h }
      dirty.current = true
      requestDraw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    window.addEventListener('resize', resize)

    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      if (drag.current || !size.current.w) return
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.current.w : 1
      if (e.ctrlKey || (!e.shiftKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX))) {
        const x = e.clientX - el.getBoundingClientRect().left - el.clientLeft
        zoomBy(Math.exp(clamp(e.deltaY * scale * (e.ctrlKey ? 0.013 : 0.005), -1.5, 1.5)), clamp(x / size.current.w, 0, 1))
      } else {
        holdUntil.current = performance.now() + 2000
        setPreset(null)
        const { left, span } = view.current
        const delta = e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        setView(left + delta * scale * span / size.current.w, span)
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      observer.disconnect()
      window.removeEventListener('resize', resize)
      el.removeEventListener('wheel', wheel)
    }
  }, [requestDraw, setView, zoomBy])

  useLayoutEffect(() => {
    const { left, span } = view.current
    setView(left, preset === 'all' ? props.timing.end : span)
    dirty.current = true
    requestDraw()
  }, [props.timing, props.placement, props.style, props.automation, props.group, props.peaksA, props.peaksB, preset, requestDraw, setView])

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return
    const el = e.currentTarget
    const box = el.getBoundingClientRect()
    const { left, span } = view.current
    const marker = (e.target as Element).closest<HTMLElement>('[data-marker]')?.dataset.marker
    const { bTop } = lanes(size.current.h)
    const x = e.clientX - box.left - el.clientLeft, y = e.clientY - box.top - el.clientTop
    const onMarker = marker === 'entry' || marker === 'cue'
    const target = !onMarker ? laneAt(y) : null
    if (target) {
      // franja del medio: agarrar un punto de la curva, o crear uno donde se hizo clic
      const { automation, timing, A, onAutomation } = data.current
      let hit = pointAt(x, y)
      if (!hit) {
        const raw = (left + x * span / size.current.w - timing.mixT) / A.bar
        const at = e.altKey ? Math.round(raw * 1000) / 1000 : Math.round(raw / (e.shiftKey ? 1 : 0.25)) * (e.shiftKey ? 1 : 0.25)
        const made = upsert(automation[target.lane], at, target.v, 0)
        onAutomation(target.lane, made.points)
        hit = { lane: target.lane, index: made.index }
        data.current = { ...data.current, automation: { ...automation, [target.lane]: made.points } }
      }
      active.current = hit
      dirty.current = true
      requestDraw()
      drag.current = {
        id: e.pointerId, x: e.clientX, y: e.clientY, left, span, placement: props.placement, mode: 'point', marker: false,
        active: false, time: 0, readout: '', point: { ...hit, points: data.current.automation[hit.lane] },
      }
      el.setPointerCapture(e.pointerId)
      return
    }
    const bLane = y >= bTop
    const mode = onMarker ? marker
      : !bLane ? 'pan' : e.altKey ? 'free' : e.shiftKey ? 'beat' : 'entry'
    drag.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY, left, span, placement: props.placement, mode, marker: onMarker,
      active: false, time: left + (e.clientX - box.left - el.clientLeft) * span / size.current.w, readout: '',
    }
    el.setPointerCapture(e.pointerId)
  }

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) {
      const onCanvas = e.target === canvas.current
      const y = e.nativeEvent.offsetY
      const overB = onCanvas && y >= lanes(size.current.h).bTop
      const overLane = onCanvas && !!laneAt(y)
      e.currentTarget.classList.toggle('over-b', overB)
      e.currentTarget.classList.toggle('over-lane', overLane)
      e.currentTarget.classList.toggle('over-point', overLane && !!pointAt(e.nativeEvent.offsetX, y))
      return
    }
    if (d.id !== e.pointerId) return
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return
      d.active = true
      e.currentTarget.dataset.dragging = d.marker ? 'marker' : d.mode
      if (d.mode === 'pan') setPreset(null)
    }
    if (d.mode === 'pan') holdUntil.current = performance.now() + 2000
    pending.current = e
    requestDraw()
  }

  const finish = (e: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (!cancelled) {
      if (d.active) {
        pending.current = e
        updateDrag()
        requestDraw()
      } else if (d.mode !== 'point') props.onSeek(d.time)
    }
    drag.current = null
    pending.current = null
    if (readout.current) readout.current.hidden = true
    delete e.currentTarget.dataset.dragging
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <section className="mx-arrangement" aria-label="Grilla de mezcla">
      <div className="mx-timeline-bar">
        <h3>Grilla de mezcla</h3>
        <span className="mx-span num" ref={count} />
        <div className="mx-curve-pick">
          <span>Curva</span>
          <Seg role="group">
            {GROUPS.map(({ id, label }) => <button key={id} className={props.group === id ? 'on' : ''} aria-pressed={props.group === id}
              onClick={() => props.setGroup(id)}>{label}</button>)}
          </Seg>
        </div>
        <div className="mx-zoom">
          <div className="mx-zoom-buttons">
            <button className="btn ghost sm icon" aria-label="Alejar grilla" onClick={() => zoomBy(1.5)}><IconMinus size={14} /></button>
            <button className="btn ghost sm icon" aria-label="Acercar grilla" onClick={() => zoomBy(1 / 1.5)}><IconPlus size={14} /></button>
          </div>
          <Seg role="group">
            <button className={preset === 'mix' ? 'on' : ''} aria-pressed={preset === 'mix'} onClick={() => selectPreset('mix')}>Mezcla</button>
            <button className={preset === 'all' ? 'on' : ''} aria-pressed={preset === 'all'} onClick={() => selectPreset('all')}>Temas enteros</button>
          </Seg>
        </div>
      </div>
      <div className="mx-timeline" ref={surface} onPointerDown={down} onPointerMove={move} onDoubleClick={removePoint}
        onPointerUp={finishClick} onPointerCancel={cancel} onLostPointerCapture={cancel}>
        <canvas ref={canvas} aria-hidden />
        <span className="mx-ruler-name" aria-hidden>Compás</span>
        <span className="mx-lane-name A" aria-hidden>A</span>
        <span className="mx-lane-name B" aria-hidden>B</span>
        <button className="mx-marker entry" data-marker="entry" ref={entry} title="Arrastrá para mover la entrada de B"
          onClick={(e) => { if (!e.detail) props.onSeek(props.timing.mixT) }}>
          Entra B <span className="num">{props.placement.mixBar + 1}</span>
        </button>
        <button className="mx-marker cue" data-marker="cue" ref={cue} title="Arrastrá para cambiar el primer compás de B"
          onClick={(e) => { if (!e.detail) props.onSeek(props.timing.cueT) }}>
          <span className="mx-flag" aria-hidden /> Cue B <span className="num">{props.placement.startBar + 1}</span>
        </button>
        <div className="mx-playhead" ref={playhead} aria-hidden />
        <div className="mx-drag-readout num" ref={readout} hidden />
      </div>
    </section>
  )

  function finishClick(e: PointerEvent<HTMLDivElement>) { finish(e) }
  function removePoint(e: MouseEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const hit = pointAt(e.clientX - box.left - e.currentTarget.clientLeft, e.clientY - box.top - e.currentTarget.clientTop)
    if (!hit) return
    const points = data.current.automation[hit.lane].filter((_, i) => i !== hit.index)
    active.current = null
    data.current.onAutomation(hit.lane, points)
  }
  function cancel(e: PointerEvent<HTMLDivElement>) { finish(e, true) }
})
