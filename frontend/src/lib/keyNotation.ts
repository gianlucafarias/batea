import { create } from 'zustand'

/**
 * Cómo se muestra una tonalidad. Batea guarda todo en Camelot (8A), pero rekordbox muestra por
 * defecto la notación clásica (Am) y Traktor la Open Key (1m): comparar 8A con Am parece "distinto"
 * aunque sea el mismo tono, así que cada uno elige la notación de su programa.
 */
export type KeyNotation = 'camelot' | 'classic' | 'open'

export const NOTATIONS: { id: KeyNotation; label: string; example: string; hint: string }[] = [
  { id: 'camelot', label: 'Camelot', example: '8A', hint: 'Mixed In Key, rueda armónica' },
  { id: 'classic', label: 'Clásica', example: 'Am', hint: 'Como rekordbox y los CDJ' },
  { id: 'open', label: 'Open Key', example: '1m', hint: 'Como Traktor' },
]

// mismos nombres que muestra rekordbox (bemoles salvo F#)
const MINOR = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'Dbm']
const MAJOR = ['B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E']

function parse(cam: string): [number, 'A' | 'B'] | null {
  const m = /^(\d{1,2})([AB])$/.exec(cam.trim().toUpperCase())
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 12 ? [n, m[2] as 'A' | 'B'] : null
}

/** Camelot → la notación elegida. Lo que no se entiende se devuelve tal cual. */
export function formatKey(cam: string | null | undefined, notation: KeyNotation): string {
  if (!cam) return ''
  const p = parse(cam)
  if (!p) return cam
  const [n, l] = p
  if (notation === 'classic') return (l === 'A' ? MINOR : MAJOR)[n - 1]
  if (notation === 'open') return `${((n + 4) % 12) + 1}${l === 'A' ? 'm' : 'd'}`
  return `${n}${l}`
}

/** Las tres notaciones juntas, para los tooltips: "8A · Am · 1m". */
export function allNotations(cam: string | null | undefined): string {
  if (!cam || !parse(cam)) return cam ?? ''
  return NOTATIONS.map((n) => formatKey(cam, n.id)).join(' · ')
}

const STORE = 'batea.keyNotation'

function initial(): KeyNotation {
  try {
    const v = localStorage.getItem(STORE)
    if (v === 'camelot' || v === 'classic' || v === 'open') return v
  } catch { /* sin almacenamiento */ }
  return 'camelot'
}

export const useKeyNotation = create<{ notation: KeyNotation; setNotation: (n: KeyNotation) => void }>((set) => ({
  notation: initial(),
  setNotation: (notation) => {
    try { localStorage.setItem(STORE, notation) } catch { /* sin almacenamiento */ }
    set({ notation })
  },
}))
