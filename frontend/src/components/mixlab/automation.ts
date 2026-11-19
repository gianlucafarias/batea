import { KILL, type Side, type Transition } from './model'

/** Una curva por control: crossfader (x) y cada banda del EQ de A y de B (0 graves, 1 medios, 2 agudos). */
export type LaneId = 'x' | 'A0' | 'A1' | 'A2' | 'B0' | 'B1' | 'B2'
/** Lo que se ve y se edita en la franja del medio: el crossfader, o una banda (A arriba, B abajo). */
export type LaneGroup = 'x' | 0 | 1 | 2
/** `at`: compases desde la entrada de B (puede ser negativo o fraccionario). `v`: 0–1 en el crossfader, dB en el EQ. */
export interface Point { at: number; v: number }
export type Automation = Record<LaneId, Point[]>
/** Controles que se agarraron con la mezcla sonando: mandan sobre la curva hasta que se pausa o se salta. */
export type Held = Partial<Record<LaneId, number>>

export const LANE_IDS: readonly LaneId[] = ['x', 'A0', 'A1', 'A2', 'B0', 'B1', 'B2']
export const bandLane = (side: Side, band: number) => `${side}${band}` as LaneId
export const groupOf = (lane: LaneId): LaneGroup => lane === 'x' ? 'x' : Number(lane[1]) as 0 | 1 | 2
export const lanesOf = (group: LaneGroup): LaneId[] => group === 'x' ? ['x'] : [bandLane('A', group), bandLane('B', group)]
export const isEq = (lane: LaneId) => lane !== 'x'

const pt = (at: number, v: number): Point => ({ at, v })

/** Las curvas de cada tipo de transición, para `bars` compases. */
export function preset(style: Transition, bars: number): Automation {
  const empty: Automation = { x: [], A0: [], A1: [], A2: [], B0: [], B1: [], B2: [] }
  if (style === 'cut') return { ...empty, x: [pt(0, 0), pt(0, 1)] }
  // los graves se cruzan de a poco mientras suena el fade: B los sube y A los baja en el mismo tramo.
  // Pasa por −10 dB a mitad de camino para que no quede un hueco sin graves (en dB lineal quedarían los dos en −24).
  const swap = (from: number, to: number) => ({
    B0: [pt(from, KILL), pt((from + to) / 2, -10), pt(to, 0)],
    A0: [pt(from, 0), pt((from + to) / 2, -10), pt(to, KILL)],
  })
  if (style === 'blend') return { ...empty, x: [pt(0, 0), pt(bars, 1)], ...swap(bars / 4, bars * 3 / 4) }
  // cambio de graves: B entra sin graves, mientras los dos suenan al tope se pasan los graves, después se va A
  return { ...empty, x: [pt(0, 0), pt(bars / 4, 0.5), pt(bars * 3 / 4, 0.5), pt(bars, 1)], ...swap(bars / 4, bars / 2) }
}

/** Valor de una curva en `at`. Sin puntos vale `empty`; antes del primero y después del último, se queda quieta. */
export function evaluate(points: Point[], at: number, empty = 0): number {
  const n = points.length
  if (!n) return empty
  if (at < points[0].at) return points[0].v
  let i = 0
  while (i + 1 < n && points[i + 1].at <= at) i++
  if (i === n - 1) return points[i].v
  const a = points[i], b = points[i + 1]
  return b.at === a.at ? b.v : a.v + (b.v - a.v) * (at - a.at) / (b.at - a.at)
}

/** Pone un punto en `at`: si ya hay uno a menos de `near` compases, le cambia el valor. Devuelve la curva y su índice. */
export function upsert(points: Point[], at: number, v: number, near = 0.13): { points: Point[]; index: number } {
  const hit = points.findIndex((p) => Math.abs(p.at - at) <= near)
  if (hit >= 0) {
    if (points[hit].v === v) return { points, index: hit }
    const next = points.slice()
    next[hit] = { at: points[hit].at, v }
    return { points: next, index: hit }
  }
  let index = 0
  while (index < points.length && points[index].at <= at) index++
  const next = points.slice()
  next.splice(index, 0, { at, v })
  return { points: next, index }
}

export function scale(auto: Automation, factor: number): Automation {
  const out = {} as Automation
  for (const lane of LANE_IDS) out[lane] = auto[lane].map((p) => ({ at: p.at * factor, v: p.v }))
  return out
}

export const DB_MAX = 6

/** Posición de -1 (kill) a 1 (+6 dB), igual que la perilla. */
export const dbToPos = (db: number) => db >= 0 ? db / DB_MAX : db / -KILL
export function posToDb(pos: number): number {
  const db = pos >= 0 ? pos * DB_MAX : pos * -KILL
  if (db <= KILL + 1.5) return KILL
  return Math.round(db * 2) / 2 || 0
}

/** Lo que se guarda de una mezcla armada: dónde entra B, desde dónde arranca, la fase y las curvas. */
export interface SavedMix {
  v: 1
  mixBar: number
  startBar: number
  nudge: number
  style: Transition
  length: number
  custom: boolean
  automation: Automation
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** Lee una mezcla guardada; si algo no cuadra devuelve null y se arranca de cero. */
export function parseSaved(raw: unknown): SavedMix | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (!isNum(m.mixBar) || !isNum(m.startBar) || !isNum(m.nudge) || !isNum(m.length)) return null
  if (m.style !== 'bass' && m.style !== 'blend' && m.style !== 'cut') return null
  const auto = m.automation as Record<string, unknown> | undefined
  if (!auto || typeof auto !== 'object') return null
  const automation = {} as Automation
  for (const lane of LANE_IDS) {
    const pts = auto[lane]
    if (!Array.isArray(pts) || !pts.every((p) => p && isNum(p.at) && isNum(p.v))) return null
    automation[lane] = pts.map((p) => ({ at: p.at, v: p.v }))
  }
  return { v: 1, mixBar: m.mixBar, startBar: m.startBar, nudge: m.nudge, style: m.style, length: m.length, custom: !!m.custom, automation }
}
