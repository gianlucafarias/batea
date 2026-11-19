import { dbToPos, evaluate, isEq, lanesOf, type Automation, type LaneGroup, type LaneId } from './automation'
import { barAt, beatAt, type Deck, type Timing, type Transition } from './model'
import type { Peaks } from './peaks'
import type { CueDto } from '../../api'
import { cueColor, cueLabel, rgba } from '../../lib/cues'

export const RULER = 24
const AUTOMATION_LANE = 66

export function lanes(height: number) {
  const middle = (height + RULER) / 2
  return { aBottom: middle - AUTOMATION_LANE / 2, bTop: middle + AUTOMATION_LANE / 2, middle }
}

/** Zona vertical de cada curva dentro de la franja del medio: el crossfader la ocupa entera; en el EQ, A arriba y B abajo. */
export function laneBox(height: number, lane: LaneId) {
  const { aBottom, bTop, middle } = lanes(height)
  if (!isEq(lane)) return { top: aBottom + 7, bottom: bTop - 7 }
  return lane[0] === 'A' ? { top: aBottom + 5, bottom: middle - 3 } : { top: middle + 3, bottom: bTop - 5 }
}

/** y de un valor: crossfader 0 (A) arriba → 1 (B) abajo; EQ +6 dB arriba, 0 dB al medio, kill abajo. */
export function valueY(height: number, lane: LaneId, v: number) {
  const { top, bottom } = laneBox(height, lane)
  return isEq(lane) ? top + (1 - dbToPos(v)) / 2 * (bottom - top) : top + v * (bottom - top)
}

export const LANE_COLOR: Record<'x' | 'A' | 'B', string> = { x: '#ff7a45', A: '#ece6dc', B: '#7dd3fc' }
const laneColor = (lane: LaneId) => LANE_COLOR[lane === 'x' ? 'x' : lane[0] as 'A' | 'B']
const BAND_NAMES = ['Graves', 'Medios', 'Agudos']

interface Drawing {
  A: Deck
  B: Deck
  rate: number
  timing: Timing
  style: Transition
  automation: Automation
  group: LaneGroup
  active: { lane: LaneId; index: number } | null
  peaksA: Peaks | null
  peaksB: Peaks | null
  cuesA: CueDto[]
  cuesB: CueDto[]
  showCues: boolean
}

function waveform(
  ctx: CanvasRenderingContext2D, deck: Deck, peaks: Peaks | null,
  width: number, left: number, dt: number, laneY: number, height: number, direction: number,
  from: number, until: number,
): boolean {
  const buckets = deck.w?.h
  const bucketWidth = buckets?.length ? deck.w!.duration / buckets.length : Infinity
  const samplesPerPixel = peaks ? dt * peaks.sampleRate : 0
  let detail = peaks && dt < bucketWidth ? peaks.levels[0] : undefined
  if (peaks && detail) {
    for (const level of peaks.levels) {
      if (level.block > samplesPerPixel) break
      detail = level
    }
  }
  if (!buckets && !detail) return false

  const first = Math.max(0, Math.floor((from - left) / dt))
  const last = Math.min(width, Math.ceil((until - left) / dt))
  const blocksPerPixel = detail ? samplesPerPixel / detail.block : 0
  const firstBlock = detail && peaks ? left * peaks.sampleRate / detail.block : 0
  let lastColor = -2
  for (let px = first; px < last; px++) {
    const time = Math.max(from, left + (px + 0.5) * dt)
    const colorIndex = buckets ? Math.min(buckets.length - 1, Math.floor(time / bucketWidth)) : -1
    if (colorIndex !== lastColor) {
      ctx.fillStyle = deck.colors[colorIndex] ?? (direction < 0 ? '#b8b0a4' : '#7dd3fc')
      lastColor = colorIndex
    }
    let peak = colorIndex >= 0 ? buckets![colorIndex] / 255 : 0
    if (detail) {
      const start = Math.max(0, Math.floor(firstBlock + px * blocksPerPixel))
      const end = Math.min(detail.max.length, Math.ceil(firstBlock + (px + 1) * blocksPerPixel))
      let amplitude = 0
      for (let i = start; i < end; i++) amplitude = Math.max(amplitude, detail.max[i], -detail.min[i])
      peak = amplitude / 32767
    }
    const amp = Math.max(1, Math.min(1, peak * (detail ? 1.15 : 1)) * (height - 5))
    ctx.fillRect(px, direction < 0 ? laneY - amp : laneY, 1, amp)
  }
  return Boolean(detail)
}

function grid(
  ctx: CanvasRenderingContext2D, deck: Deck, width: number, left: number, dt: number,
  start: number, top: number, bottom: number, isB: boolean, marker: number,
) {
  const pxBar = deck.bar / dt
  const everyLine = pxBar >= 8 ? 1 : pxBar >= 3 ? 4 : pxBar >= 1.2 ? 8 : 16
  const everyLabel = pxBar >= 46 ? 1 : pxBar >= 20 ? 4 : pxBar >= 7 ? 8 : pxBar >= 3 ? 16 : 32
  ctx.textAlign = 'center'
  for (let i = Math.max(start, barAt(deck.db, left - deck.bar)); i < deck.db.length; i++) {
    const offset = deck.db[i] - left
    const x = Math.round(offset / dt)
    if (x > width) break
    if (i % everyLine === 0 && x >= 0) {
      ctx.fillStyle = i % 32 === 0 ? (isB ? '#7dd3fc80' : '#ece6dc75')
        : i % 16 === 0 ? (isB ? '#7dd3fc66' : '#ece6dc55')
          : i % 8 === 0 ? (isB ? '#7dd3fc4f' : '#ece6dc40')
            : (isB ? '#7dd3fc36' : '#ece6dc2e')
      ctx.fillRect(x, top, 1, bottom - top)
    }
    if (pxBar >= 32) {
      const beat = beatAt(deck, i)
      ctx.fillStyle = isB ? '#7dd3fc2d' : '#ece6dc2a'
      for (let j = 1; j < 4; j++) {
        const bx = Math.round((offset + beat * j) / dt)
        if (bx >= 0 && bx <= width) ctx.fillRect(bx, top, 1, bottom - top)
      }
    }
    if (!isB && i % everyLabel === 0 && x > 46 && x < width - 20 && (x < marker - 30 || x > marker + 83)) {
      ctx.fillStyle = i % 8 === 0 ? '#b8b0a4' : '#8a8278'
      ctx.fillText(String(i + 1), x, 16)
      ctx.fillRect(x, RULER - 3, 1, 3)
    }
  }
}

/** Cues de un tema sobre su franja. `at` pasa el tiempo del tema al de la línea de tiempo; solo se dibujan las que suenan en la mezcla. */
function cues(
  ctx: CanvasRenderingContext2D, list: CueDto[], width: number, xAt: (t: number) => number, at: (s: number) => number,
  from: number, until: number, top: number, bottom: number, labelY: number,
) {
  ctx.font = '700 10px "JetBrains Mono Variable", monospace'
  ctx.textAlign = 'left'
  for (const q of list) {
    const t = at(q.start_ms / 1000)
    if (t < from - 1e-3 || t > until) continue
    const x = xAt(t)
    if (x < -40 || x > width + 40) continue
    const c = cueColor(q)
    if (q.end_ms != null) {
      const x2 = xAt(at(q.end_ms / 1000))
      ctx.fillStyle = rgba(c, 0.2)
      ctx.fillRect(x, top, Math.max(2, x2 - x), bottom - top)
    }
    ctx.fillStyle = rgba(c, 0.9)
    ctx.fillRect(Math.round(x), top, 2, bottom - top)
    const label = cueLabel(q)
    const w = ctx.measureText(label).width + 8
    ctx.fillRect(Math.round(x), labelY, w, 13)
    ctx.fillStyle = '#0e0d0c'
    ctx.fillText(label, Math.round(x) + 4, labelY + 10)
  }
}

export function drawTimeline(
  ctx: CanvasRenderingContext2D, width: number, height: number, left: number, span: number, d: Drawing,
): number {
  const { A, B, rate, timing, peaksA, peaksB, automation, group, active } = d
  const { mixT, cueT, bStart, bOrigin, durA, endB } = timing
  const { aBottom, bTop } = lanes(height)
  const dt = span / width
  const xAt = (t: number) => (t - left) / dt
  const tx = xAt(mixT)

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#141311'
  ctx.fillRect(0, 0, width, RULER)
  ctx.fillRect(0, aBottom, width, bTop - aBottom)
  ctx.fillStyle = '#2e2a26'
  ctx.fillRect(0, RULER - 1, width, 1)
  ctx.fillRect(0, Math.round(aBottom), width, 1)
  ctx.fillRect(0, Math.round(bTop), width, 1)

  const overlapStart = xAt(Math.max(mixT, cueT))
  const overlapEnd = xAt(Math.min(durA, endB))
  ctx.fillStyle = '#ece6dc09'
  if (overlapEnd > overlapStart) ctx.fillRect(overlapStart, RULER, overlapEnd - overlapStart, height - RULER)
  const detailA = waveform(ctx, A, peaksA, width, left, dt, aBottom, aBottom - RULER, -1, 0, durA)
  const detailB = waveform(ctx, B, peaksB, width, (left - bOrigin) * rate, dt * rate, bTop, height - bTop, 1, bStart, (endB - bOrigin) * rate)

  ctx.font = '10px "JetBrains Mono Variable", monospace'
  grid(ctx, A, width, left, dt, 0, RULER, aBottom, false, tx)
  grid(ctx, B, width, (left - bOrigin) * rate, dt * rate, barAt(B.db, bStart), bTop, height, true, tx)

  if (d.showCues) {
    cues(ctx, d.cuesA, width, xAt, (v) => v, 0, durA, RULER, aBottom, RULER + 2)
    cues(ctx, d.cuesB, width, xAt, (v) => bOrigin + v / rate, cueT, endB, bTop, height, height - 15)
  }

  ctx.fillStyle = '#ff7a458c'
  ctx.fillRect(Math.round(tx), RULER, 1, bTop - RULER)
  ctx.fillStyle = '#7dd3fcaa'
  ctx.fillRect(Math.round(xAt(cueT)), bTop, 1, height - bTop)
  ctx.fillStyle = '#b8b0a46e'
  const endA = xAt(durA)
  ctx.fillRect(Math.round(endA), RULER, 1, aBottom - RULER)
  if (endA > -3 && endA < width + 3) {
    ctx.textAlign = endA > width - 82 ? 'right' : 'left'
    ctx.fillStyle = '#b8b0a4'
    ctx.fillText('Termina A', endA + (endA > width - 82 ? -6 : 6), RULER + 18)
  }

  // curvas de la franja del medio
  const toAt = (t: number) => (t - mixT) / A.bar
  ctx.textAlign = 'left'
  // con el crossfader elegido, los graves se ven de fondo: también cambian solos
  if (group === 'x') {
    for (const lane of lanesOf(0)) {
      ctx.beginPath()
      for (let px = 0; px <= width; px += 3) {
        const y = valueY(height, lane, evaluate(automation[lane], toAt(left + px * dt)))
        if (px === 0) ctx.moveTo(px, y)
        else ctx.lineTo(px, y)
      }
      ctx.strokeStyle = laneColor(lane)
      ctx.globalAlpha = 0.28
      ctx.setLineDash([3, 3])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
  }
  for (const lane of lanesOf(group)) {
    const { top, bottom } = laneBox(height, lane)
    const color = laneColor(lane)
    if (isEq(lane)) {                                   // referencia de 0 dB
      ctx.fillStyle = '#ece6dc14'
      ctx.fillRect(0, Math.round(valueY(height, lane, 0)), width, 1)
    }
    const points = automation[lane]
    ctx.beginPath()
    for (let px = 0; px <= width; px += 2) {
      const y = valueY(height, lane, evaluate(points, toAt(left + px * dt)))
      if (px === 0) ctx.moveTo(px, y)
      else ctx.lineTo(px, y)
    }
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.9
    ctx.lineWidth = 1.3
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 1
    points.forEach((p, i) => {
      const x = xAt(mixT + p.at * A.bar)
      if (x < -6 || x > width + 6) return
      const y = valueY(height, lane, p.v)
      const on = active?.lane === lane && active.index === i
      ctx.beginPath()
      ctx.arc(x, y, on ? 4.5 : 3.5, 0, Math.PI * 2)
      ctx.fillStyle = on ? color : '#141311'
      ctx.fill()
      ctx.strokeStyle = color
      ctx.stroke()
    })
    ctx.fillStyle = '#8a8278'
    const name = lane === 'x' ? 'Crossfader' : `${BAND_NAMES[group as number]} ${lane[0]}`
    ctx.fillText(name, 8, lane === 'x' || lane[0] === 'A' ? top + 8 : bottom - 1)
  }
  return (detailA ? 1 : 0) | (detailB ? 2 : 0)
}
