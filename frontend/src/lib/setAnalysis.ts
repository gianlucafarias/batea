/** Lectura de una lista en orden (caja o sesión del historial): arco de energía, saltos y cosas a revisar.
 *  Todo sale de datos que la lista ya trae; lo único que viene aparte es lo que Batea sabe de cada pasada. */
import type { Track } from '../types'
import { cleanTitle, parseKey } from '../util'

export interface PassInfo { a: number; b: number; played: number; avoid: boolean; mix: boolean; saved: boolean }

export type Harmony = 'ok' | 'risky' | 'clash' | 'unknown'

export interface Pass {
  /** índice del tema que sale (entra el siguiente) */
  i: number
  harmony: Harmony
  harmonyLabel: string
  /** cambio de tempo en %, ya contemplando medio/doble tempo; null si falta un BPM */
  bpmPct: number | null
  energyDelta: number | null
  info: PassInfo | null
}

export type Phase = { name: 'Warm-up' | 'Subida' | 'Peak' | 'Cierre'; from: number; to: number }

export type Severity = 'warning' | 'serious'

export interface Issue {
  id: string
  kind: 'bpm' | 'key' | 'drop' | 'avoid' | 'ends' | 'peak' | 'plateau' | 'missing'
  severity: Severity
  /** índices de los temas involucrados (para marcarlos en el gráfico) */
  at: number[]
  title: string
  detail: string
  /** "A → B" cuando el aviso es de una pasada */
  pair?: string
}

export interface SetReading {
  passes: Pass[]
  phases: Phase[]
  peak: number | null
  issues: Issue[]
  /** minuto en que arranca cada tema (si se conocen las duraciones) */
  starts: (number | null)[]
  totalMin: number | null
  missing: number[]
  /** energía de cada tema que usa el gráfico (ver energyLevel) */
  energy: (number | null)[]
}

export const BPM_JUMP = 3          // % a partir del cual avisa un salto de tempo
const BPM_SERIOUS = 6
const DROP = 4                      // puntos de energía de un tema al siguiente
const PLATEAU = 6                   // temas seguidos en la misma energía
const PLATEAU_SPAN = 0.5            // cuánto puede moverse la energía y seguir siendo "la misma"
const SHORT_ENDS = 4                // compases (en techno arrancar con el bombo en el compás 0 es lo normal)

export function harmony(k1: string | null, k2: string | null): [Harmony, string] {
  const p1 = parseKey(k1), p2 = parseKey(k2)
  if (!p1 || !p2) return ['unknown', 'sin tono']
  const d0 = Math.abs(p1[0] - p2[0]) % 12
  const d = Math.min(d0, 12 - d0)
  const same = p1[1] === p2[1]
  if (d === 0 && same) return ['ok', 'misma tonalidad']
  if (d === 1 && same) return ['ok', 'tonalidad vecina']
  if (d === 0) return ['ok', 'relativa mayor/menor']
  if (d === 2 && same) return ['risky', 'salto de +2']
  if (d === 1) return ['risky', 'diagonal']
  return ['clash', 'choque de tono']
}

/** % de cambio de tempo; 70 → 140 cuenta como el mismo tempo. */
export function bpmChange(a: number | null, b: number | null): number | null {
  if (!a || !b) return null
  let r = b / a
  if (Math.abs(r - 2) < 0.06) r /= 2
  else if (Math.abs(r - 0.5) < 0.03) r *= 2
  return (r - 1) * 100
}

/** Energía para el gráfico: la que pusiste a mano, si no la calculada con decimales, si no la entera. */
export function energyLevel(t: Track): number | null {
  return t.energy_user ?? t.energy_fine ?? t.energy ?? null
}

/** 9.4 → "9,4"; 7 → "7" */
export const fmtEnergy = (v: number | null | undefined) => (v == null ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','))

const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1).replace('.', ',')}%`
const name = (t: Track) => cleanTitle(t.title)

/** Energía suavizada (ventana de 3) para que un tema suelto no defina las fases. */
function smooth(e: (number | null)[]): (number | null)[] {
  return e.map((_, i) => {
    const w = [e[i - 1], e[i], e[i + 1]].filter((x): x is number => x != null)
    return w.length ? w.reduce((s, x) => s + x, 0) / w.length : null
  })
}

function phasesOf(energy: (number | null)[]): { phases: Phase[]; peak: number | null } {
  const s = smooth(energy)
  const known = s.map((v, i) => [v, i] as const).filter((x): x is readonly [number, number] => x[0] != null)
  if (!known.length) return { phases: [], peak: null }
  // el peak es el tema más alto dentro del tramo más alto (si empatan, el primero)
  const top = Math.max(...known.map(([v]) => v))
  const low = Math.min(...known.map(([v]) => v))
  // el tramo del peak se mide contra el rango del set: en un set que va de 8 a 10, "cerca del máximo" es 0,4, no 1 punto
  const tol = Math.max(0.25, (top - low) * 0.2)
  let from = known.find(([v]) => v >= top - 0.001)![1]
  let to = from
  while (to + 1 < s.length && (s[to + 1] ?? -1) >= top - tol) to++
  while (from - 1 >= 0 && (s[from - 1] ?? -1) >= top - tol) from--
  // el tema puntual más alto (un pico suelto también cuenta); si empata, el que cae dentro del tramo
  const maxE = Math.max(...energy.filter((e): e is number => e != null))
  const tops = energy.map((e, i) => (e === maxE ? i : -1)).filter((i) => i >= 0)
  const peak = tops.find((i) => i >= from && i <= to) ?? tops.reduce((b, i) => (Math.abs(i - from) < Math.abs(b - from) ? i : b))
  from = Math.min(from, peak)
  to = Math.max(to, peak)
  const n = energy.length
  if (n < 6) return { phases: [], peak }
  const mid = low + (top - low) / 2
  let warm = 0
  while (warm < from && (s[warm] ?? low) < mid) warm++
  const phases: Phase[] = []
  if (warm > 0) phases.push({ name: 'Warm-up', from: 0, to: warm - 1 })
  if (from > warm) phases.push({ name: 'Subida', from: warm, to: from - 1 })
  phases.push({ name: 'Peak', from, to })
  if (to < n - 1) phases.push({ name: 'Cierre', from: to + 1, to: n - 1 })
  return { phases, peak }
}

export function readSet(tracks: Track[], info: PassInfo[], fmtKey: (k: string | null) => string): SetReading {
  const n = tracks.length
  const energy = tracks.map(energyLevel)
  const byPair = new Map(info.map((p) => [`${p.a}>${p.b}`, p]))

  const passes: Pass[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = tracks[i], b = tracks[i + 1]
    const [h, label] = harmony(a.key, b.key)
    passes.push({
      i, harmony: h, harmonyLabel: label,
      bpmPct: bpmChange(a.bpm, b.bpm),
      energyDelta: energy[i] != null && energy[i + 1] != null ? energy[i + 1]! - energy[i]! : null,
      info: byPair.get(`${a.id}>${b.id}`) ?? null,
    })
  }

  let acc = 0, known = true
  const starts = tracks.map((t) => {
    const s = known ? acc / 60 : null
    if (t.duration) acc += t.duration; else known = false
    return s
  })

  const { phases, peak } = phasesOf(energy)
  const issues: Issue[] = []

  // una pasada puede tener varios problemas: van juntos en un solo aviso
  for (const p of passes) {
    const a = tracks[p.i], b = tracks[p.i + 1]
    const found: { kind: Issue['kind']; serious: boolean; title: string; detail: string }[] = []
    if (p.info?.avoid) found.push({ kind: 'avoid', serious: true, title: 'la marcaste para evitar', detail: '' })
    if (p.bpmPct != null && Math.abs(p.bpmPct) > BPM_JUMP) {
      found.push({ kind: 'bpm', serious: Math.abs(p.bpmPct) > BPM_SERIOUS, title: `salto de tempo ${pct(p.bpmPct)}`, detail: `${Math.round(a.bpm!)} → ${Math.round(b.bpm!)} BPM` })
    }
    if (p.harmony === 'clash') found.push({ kind: 'key', serious: false, title: 'choque de tono', detail: `${fmtKey(a.key)} → ${fmtKey(b.key)}` })
    // bajar fuerte en el cierre es normal; en el medio del set suele cortar la pista
    if (p.energyDelta != null && p.energyDelta <= -DROP && p.i + 1 < n * 0.8) {
      found.push({ kind: 'drop', serious: false, title: 'cae la energía', detail: `energía ${fmtEnergy(energy[p.i])} → ${fmtEnergy(energy[p.i + 1])}` })
    }
    if (a.outro_bars != null && b.intro_bars != null && a.outro_bars < SHORT_ENDS && b.intro_bars < SHORT_ENDS) {
      found.push({ kind: 'ends', serious: false, title: 'poco margen para mezclar', detail: `cierra en ${a.outro_bars} compases y el otro arranca lleno a los ${b.intro_bars}` })
    }
    if (!found.length) continue
    const title = found.map((f) => f.title).join(' y ').replace(/, y /, ' y ')
    issues.push({
      id: `pass-${p.i}`, kind: found[0].kind, severity: found.some((f) => f.serious) ? 'serious' : 'warning', at: [p.i, p.i + 1],
      title: `${p.i + 1} → ${p.i + 2}: ${title}`,
      detail: found.map((f) => f.detail).filter(Boolean).join(' · '),
      pair: `${name(a)} → ${name(b)}`,
    })
  }

  if (peak != null && n >= 8 && peak < n * 0.25) {
    issues.push({ id: 'peak', kind: 'peak', severity: 'warning', at: [peak], title: 'El peak llega muy temprano', detail: `Tema ${peak + 1} de ${n}: después queda poco para dónde subir` })
  }

  // tramo plano: 6 o más temas seguidos que no se mueven más de medio punto
  for (let i = 0; i < n;) {
    if (energy[i] == null) { i++; continue }
    let j = i, lo = energy[i]!, hi = energy[i]!
    while (j + 1 < n && energy[j + 1] != null && Math.max(hi, energy[j + 1]!) - Math.min(lo, energy[j + 1]!) <= PLATEAU_SPAN) {
      j++; lo = Math.min(lo, energy[j]!); hi = Math.max(hi, energy[j]!)
    }
    if (j - i + 1 >= PLATEAU) {
      issues.push({
        id: `plateau-${i}`, kind: 'plateau', severity: 'warning', at: Array.from({ length: j - i + 1 }, (_, k) => i + k),
        title: `${j - i + 1} temas seguidos en energía ${lo === hi ? fmtEnergy(lo) : `${fmtEnergy(lo)} a ${fmtEnergy(hi)}`}`,
        detail: `Del tema ${i + 1} al ${j + 1}: puede sentirse plano`,
      })
    }
    i = j + 1
  }

  const missing = tracks.map((t, i) => (energy[i] == null || !t.bpm || !t.key ? i : -1)).filter((i) => i >= 0)
  if (missing.length) {
    issues.push({
      id: 'missing', kind: 'missing', severity: 'warning', at: missing,
      title: `${missing.length} ${missing.length === 1 ? 'tema sin datos' : 'temas sin datos'}`,
      detail: 'Les falta energía, BPM o tono, así que el gráfico tiene huecos',
    })
  }

  const order: Record<Severity, number> = { serious: 0, warning: 1 }
  issues.sort((x, y) => order[x.severity] - order[y.severity] || x.at[0] - y.at[0])
  return { passes, phases, peak, issues, starts, totalMin: known ? acc / 60 : null, missing, energy }
}
