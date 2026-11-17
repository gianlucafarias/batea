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
