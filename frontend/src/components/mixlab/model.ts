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
export const TEMPO_LIMIT = { A: 16, B: 50 } as const
export const KEY_LIMIT = 6

/** Tempo (%) y tono (semitonos) de cada deck. Con sync, B sigue el tempo de A y su `tempo` propio no se usa. */
export interface DeckTune { tempoA: number; tempoB: number; keyA: number; keyB: number; sync: boolean }
export const FLAT_TUNE: DeckTune = { tempoA: 0, tempoB: 0, keyA: 0, keyB: 0, sync: true }

/** Mueve una tonalidad Camelot `semis` semitonos (un semitono son 7 pasos en la rueda). */
export function shiftKey(k: string | null | undefined, semis: number): string | null {
  const m = k ? /^(\d{1,2})([AB])$/.exec(k) : null
  if (!m) return k ?? null
  const s = Math.round(semis)
  return `${(((Number(m[1]) - 1 + 7 * s) % 12) + 12) % 12 + 1}${m[2]}`
}

/** El corrimiento más chico que deja la tonalidad `from` compatible con `to` (misma, vecina o relativa), sin pasar `limit` en total. */
export function keyMatch(from: string | null | undefined, to: string | null | undefined, current = 0, limit = KEY_LIMIT): number | null {
  const a = from ? /^(\d{1,2})([AB])$/.exec(from) : null, b = to ? /^(\d{1,2})([AB])$/.exec(to) : null
  if (!a || !b) return null
  // a igual distancia, el que vuelve más cerca del tono original
  const steps = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6].sort((x, y) => Math.abs(x) - Math.abs(y) || Math.abs(current + x) - Math.abs(current + y))
  for (const s of steps) {
    if (Math.abs(current + s) > limit) continue
    const n = (((Number(a[1]) - 1 + 7 * s) % 12) + 12) % 12, m = Number(b[1]) - 1
    const d = Math.min(Math.abs(n - m), 12 - Math.abs(n - m))
    if (d === 0 || (d === 1 && a[2] === b[2])) return s
  }
  return null
}
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
