import type { Grid, TrackDetail, Waveform } from '../../types'

export type Side = 'A' | 'B'
export type Transition = 'bass' | 'blend' | 'cut'

export interface Deck {
  t: TrackDetail
  g: Grid
  w: Waveform | null
  colors: string[]
  db: number[]
  bar: number
  dur: number
}

export interface Placement {
  mixBar: number
  startBar: number
  nudge: number
}

export interface Timing {
  mixT: number
  cueT: number
  bStart: number
  bOrigin: number
  durA: number
  endB: number
  end: number
  fadeEnd: number
}

export const KILL = -48
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

export function makeDeck(t: TrackDetail, g: Grid, w: Waveform | null): Deck {
  const dur = g.duration ?? t.duration ?? w?.duration ?? 0
  const bar = g.bpm ? 240 / g.bpm : 2
  const db = g.downbeats.length ? g.downbeats : Array.from({ length: Math.max(1, Math.floor(dur / bar)) }, (_, i) => i * bar)
  const colors = w?.h.map((_, i) => {
    const lo = w.low[i], mi = w.mid[i] * 1.35, hi = w.high[i] * 1.9
    const sum = lo + mi + hi
    if (!sum) return '#70665b'
    return `rgb(${Math.round((255 * lo + 233 * mi + 125 * hi) / sum)}, ${Math.round((90 * lo + 223 * mi + 211 * hi) / sum)}, ${Math.round((31 * lo + 198 * mi + 252 * hi) / sum)})`
  }) ?? []
  return { t, g, w, colors, db, bar, dur }
}

export function defaultEntry(A: Deck): number {
  const count = A.db.length
  const lead = Math.min(Math.max(8, count - 8), Math.ceil(Math.max(A.t.outro_bars ?? 0, 16) / 8) * 8, 64)
  return Math.max(0, Math.floor((count - lead) / 8) * 8)
}

export function playbackRate(A: Deck, B: Deck): number {
  if (!A.g.bpm || !B.g.bpm) return 1
  let rate = A.g.bpm / B.g.bpm
  while (rate > 1.42) rate /= 2
  while (rate < 0.71) rate *= 2
  return rate
}

export function makeTiming(A: Deck, B: Deck, p: Placement, rate: number, bars: number, durA: number, durB: number): Timing {
  const mixT = A.db[p.mixBar]
  const cueT = mixT + p.nudge
  const bStart = B.db[p.startBar]
  const bOrigin = cueT - bStart / rate
  const endB = bOrigin + durB / rate
  const fadeEnd = Math.max(mixT, Math.min(durA, endB, A.db[p.mixBar + bars] ?? mixT + bars * A.bar))
  return { mixT, cueT, bStart, bOrigin, durA, endB, end: Math.max(durA, endB), fadeEnd }
}

export function barAt(db: number[], time: number): number {
  let lo = 0, hi = db.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (db[mid] <= time) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}

export function nearestBar(db: number[], time: number): number {
  const i = barAt(db, time)
  return i + 1 < db.length && time - db[i] > db[i + 1] - time ? i + 1 : i
}

export function beatAt(deck: Deck, i: number): number {
  return ((deck.db[i + 1] ?? deck.db[i] + deck.bar) - deck.db[i]) / 4
}

export function phaseOffset(A: Deck, time: number): number {
  const i = barAt(A.db, time)
  const beat = beatAt(A, i)
  const fromBar = time - A.db[i]
  return fromBar - Math.round(fromBar / beat) * beat
}

export function crossfade(style: Transition, t: number, mixT: number, end: number): number {
  if (t < mixT) return 0
  if (style === 'cut' || t >= end) return 1
  const p = (t - mixT) / (end - mixT)
  if (style === 'blend') return p
  return p < 0.25 ? 2 * p : p < 0.75 ? 0.5 : 0.5 + 2 * (p - 0.75)
}

export function signed(value: number): string {
  return value < 0 ? `−${-value}` : value > 0 ? `+${value}` : '0'
}
