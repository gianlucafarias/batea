import { useSyncExternalStore } from 'react'
import { Seg } from '../lib/Seg'

export type MapMode = 'graph' | 'wheel'

const MODES: [MapMode, string, string][] = [
  ['graph', 'Constelación 3D', 'Los temas que tocás juntos quedan juntos'],
  ['wheel', 'Rueda Camelot', 'Cada tono en su lugar de la rueda (A adentro, B afuera)'],
]

/** Los dos modos del mapa. */
export function MapModes({ mode, onMode }: { mode: MapMode; onMode: (m: MapMode) => void }) {
  return (
    <Seg>
      {MODES.map(([m, label, title]) => (
        <button key={m} className={mode === m ? 'on' : ''} title={title} onClick={() => onMode(m)}>{label}</button>
      ))}
    </Seg>
  )
}

// ------------------------------------------------------------------ tamaño de los puntos (Constelación y Rueda)
const DOT_STEPS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3]
const DOT_KEY = 'batea.map.dotScale'
const DOT_DEFAULT = 2
let dotScale = (() => {
  try { const v = Number(localStorage.getItem(DOT_KEY)); return DOT_STEPS.includes(v) ? v : DOT_DEFAULT } catch { return DOT_DEFAULT }
})()
const listeners = new Set<() => void>()

function setDotScale(v: number) {
  dotScale = v
  try { localStorage.setItem(DOT_KEY, String(v)) } catch { /* sin storage */ }
  listeners.forEach((l) => l())
}

/** Multiplicador del tamaño de los puntos del mapa; se recuerda entre aperturas. */
export function useDotScale(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => dotScale)
}

/** − / + para achicar o agrandar los puntos, con tope en los dos sentidos. */
export function DotSize() {
  const v = useDotScale()
  const i = DOT_STEPS.indexOf(v)
  return (
    <Seg>
      <button title="Puntos más chicos" aria-label="Puntos más chicos" disabled={i <= 0} onClick={() => setDotScale(DOT_STEPS[i - 1])}>−</button>
      <button title="Puntos más grandes" aria-label="Puntos más grandes" disabled={i >= DOT_STEPS.length - 1} onClick={() => setDotScale(DOT_STEPS[i + 1])}>+</button>
    </Seg>
  )
}
