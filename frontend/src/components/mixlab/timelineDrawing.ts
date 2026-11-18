import { barAt, beatAt, crossfade, type Deck, type Timing, type Transition } from './model'
import type { Peaks } from './peaks'

export const RULER = 24
const CROSSFADE_LANE = 30

export function lanes(height: number) {
  const middle = (height + RULER) / 2
  return { aBottom: middle - CROSSFADE_LANE / 2, bTop: middle + CROSSFADE_LANE / 2 }
}

interface Drawing {
  A: Deck
  B: Deck
  rate: number
  timing: Timing
  style: Transition
  peaksA: Peaks | null
  peaksB: Peaks | null
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

export function drawTimeline(
  ctx: CanvasRenderingContext2D, width: number, height: number, left: number, span: number, d: Drawing,
): number {
  const { A, B, rate, timing, style, peaksA, peaksB } = d
  const { mixT, cueT, bStart, bOrigin, durA, endB, fadeEnd } = timing
  const { aBottom, bTop } = lanes(height)
  const dt = span / width
  const xAt = (t: number) => (t - left) / dt
  const tx = xAt(mixT)
  const swap = mixT + (fadeEnd - mixT) / 2

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

  const leftCurve = Math.max(0, Math.floor(xAt(mixT)) - 1)
  const rightCurve = Math.min(width, Math.ceil(xAt(fadeEnd)) + 1)
  if (rightCurve > leftCurve) {
    const top = aBottom + 5, bottom = bTop - 5
    ctx.beginPath()
    if (style === 'cut' || fadeEnd === mixT) {
      ctx.moveTo(tx, bottom)
      ctx.lineTo(tx, top)
      ctx.lineTo(rightCurve, top)
    } else {
      for (let px = leftCurve; px <= rightCurve; px += 2) {
        const y = bottom - (bottom - top) * crossfade(style, left + px * dt, mixT, fadeEnd)
        if (px === leftCurve) ctx.moveTo(px, y)
        else ctx.lineTo(px, y)
      }
    }
    ctx.strokeStyle = '#ff7a45'
    ctx.lineWidth = 1.2
    ctx.stroke()
    if (style === 'bass' && fadeEnd > mixT && xAt(swap) >= 0 && xAt(swap) <= width) {
      const x = xAt(swap), y = (top + bottom) / 2
      ctx.beginPath()
      ctx.moveTo(x, y - 4)
      ctx.lineTo(x + 4, y)
      ctx.lineTo(x, y + 4)
      ctx.lineTo(x - 4, y)
      ctx.closePath()
      ctx.fillStyle = '#ff7a45'
      ctx.fill()
      ctx.textAlign = x > width - 134 ? 'right' : 'left'
      ctx.fillStyle = '#b8b0a4'
      ctx.fillText('Cambio de graves', x + (x > width - 134 ? -8 : 8), bottom)
    }
  }
  return (detailA ? 1 : 0) | (detailB ? 2 : 0)
}
