import type { CueDto } from '../api'

export type RGB = [number, number, number]
export const PADS = 'ABCDEFGH'
export const GREEN: RGB = [40, 226, 20]       // hot cues (el color que rekordbox les pone por defecto)
export const ORANGE: RGB = [255, 140, 0]      // loops
export const MEMORY: RGB = [230, 70, 70]      // memory cues
export const cueColor = (c: CueDto): RGB => c.rgb ?? (c.kind === 'loop' ? ORANGE : c.kind === 'memory' ? MEMORY : GREEN)
export const rgba = (c: RGB, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`
export const cueLabel = (c: CueDto) => (c.kind === 'memory' ? 'M' : PADS[c.slot ?? 0] + (c.kind === 'loop' ? '↻' : ''))
