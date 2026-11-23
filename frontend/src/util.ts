export function parseKey(k: string | null | undefined): [number, 'A' | 'B'] | null {
  if (!k) return null
  const m = /^(\d{1,2})([AB])$/.exec(k)
  return m ? [Number(m[1]), m[2] as 'A' | 'B'] : null
}

/** Rueda Camelot: cada número tiene su tono; menores (A) más oscuras que mayores (B). */
export function keyHue(n: number): number {
  return ((n - 1) * 30 + 140) % 360
}

export function keyColor(k: string | null | undefined, alpha = 1): string {
  const p = parseKey(k)
  if (!p) return `hsla(30, 6%, 46%, ${alpha})`
  const [n, l] = p
  return l === 'A' ? `hsla(${keyHue(n)}, 62%, 56%, ${alpha})` : `hsla(${keyHue(n)}, 72%, 70%, ${alpha})`
}

export function compatibleKeys(k: string | null | undefined): string[] {
  const p = parseKey(k)
  if (!p) return []
  const [n, l] = p
  const o = l === 'A' ? 'B' : 'A'
  const up = (n % 12) + 1
  const down = ((n + 10) % 12) + 1
  return [`${n}${l}`, `${up}${l}`, `${down}${l}`, `${n}${o}`]
}

export function fmtTime(s: number | null | undefined): string {
  if (!s || !isFinite(s)) return '–:––'
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

export function fmtBpm(b: number | null | undefined): string {
  if (!b) return '–'
  return Math.abs(b - Math.round(b)) < 0.05 ? String(Math.round(b)) : b.toFixed(1)
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '–'
  const [y, m, day] = d.split('-').map(Number)
  if (!y || !m) return d
  return `${day} ${MONTHS[m - 1]} ${String(y).slice(2)}`
}

/** Hash estable para generar sobres y pequeñas variaciones visuales. */
export function hash(n: number): number {
  let x = n | 0
  x = ((x >>> 16) ^ x) * 0x45d9f3b
  x = ((x >>> 16) ^ x) * 0x45d9f3b
  x = (x >>> 16) ^ x
  return (x >>> 0) / 4294967295
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('es-AR')} ${n === 1 ? one : many}`
}

export function cleanTitle(t: string | null | undefined): string {
  if (!t) return 'Sin título'
  return t.replace(/\s*-\s*www\.[^\s]+/gi, '').replace(/^\s*(?:y2mate\.(?:com|is)|www\.\S+)\s*-\s*/i, '').replace(/^\d{1,3}[.\s-]+\s*/, '').trim() || t
}

export const ROLE_CATEGORIES = ['estructura', 'versión', 'voz', 'momento', 'vibra']
