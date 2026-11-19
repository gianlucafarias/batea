import type { Waveform } from '../../types'
import type { Peaks } from '../mixlab/peaks'

/** Mayor valor absoluto del tema (para llevar la onda al alto disponible). */
export function peakOf(peaks: Peaks): number {
  const top = peaks.levels[peaks.levels.length - 1]
  let m = 0
  for (let i = 0; i < top.max.length; i++) m = Math.max(m, top.max[i], -top.min[i])
  return Math.max(0.05, m / 32767)
}

/** Color de la onda en el instante `t` (graves naranja, medios papel, agudos celeste), de la versión resumida. */
function colorAt(wave: Waveform | null, t: number, dur: number): string {
  if (!wave || !dur) return 'rgb(236, 230, 220)'
  const i = Math.max(0, Math.min(wave.h.length - 1, Math.floor((t / dur) * wave.h.length)))
  const lo = wave.low[i] / 255, mi = (wave.mid[i] / 255) * 1.35, hi = (wave.high[i] / 255) * 1.9
  const s = lo + mi + hi + 1e-6
  return `rgb(${((255 * lo + 233 * mi + 125 * hi) / s) | 0}, ${((90 * lo + 223 * mi + 211 * hi) / s) | 0}, ${((31 * lo + 198 * mi + 252 * hi) / s) | 0})`
}

/**
 * Dibuja la onda a nivel de muestra: por cada columna de píxeles, el mínimo y el máximo de las muestras que le tocan.
 * Con mucho zoom (menos de 64 muestras por píxel) lee las muestras tal cual; si no, la pirámide de picos.
 */
export function paintPeaks(ctx: CanvasRenderingContext2D, w: number, h: number, t0: number, win: number,
  buffer: AudioBuffer, peaks: Peaks | null, gain: number, wave: Waveform | null): void {
  const sr = buffer.sampleRate
  const mid = h / 2
  const spp = (win * sr) / w
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  let level = -1
  if (peaks && spp >= 64) for (let k = 0; k < peaks.levels.length; k++) if (peaks.levels[k].block <= spp) level = k
  for (let px = 0; px < w; px++) {
    const s0 = Math.floor((t0 + (px / w) * win) * sr)
    const s1 = Math.max(s0 + 1, Math.floor((t0 + ((px + 1) / w) * win) * sr))
    if (s1 < 0 || s0 >= buffer.length) continue
    let lo = 0, hi = 0
    if (level >= 0 && peaks) {
      const L = peaks.levels[level]
      const i0 = Math.max(0, Math.floor(s0 / L.block)), i1 = Math.min(L.min.length, Math.max(i0 + 1, Math.ceil(s1 / L.block)))
      for (let i = i0; i < i1; i++) { if (L.min[i] < lo) lo = L.min[i]; if (L.max[i] > hi) hi = L.max[i] }
      lo /= 32767; hi /= 32767
    } else {
      const a = Math.max(0, s0), b = Math.min(buffer.length, s1)
      for (const ch of chans) for (let i = a; i < b; i++) { const v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v }
    }
    const y1 = mid - Math.min(1, hi * gain) * (mid - 3), y2 = mid - Math.max(-1, lo * gain) * (mid - 3)
    ctx.fillStyle = colorAt(wave, t0 + (px / w) * win, buffer.duration)
    ctx.fillRect(px, y1, 1, Math.max(1, y2 - y1))
  }
}

/** Escala de tiempo: marcas con su etiqueta, con un paso "redondo" según el zoom. */
export function paintRuler(ctx: CanvasRenderingContext2D, w: number, h: number, t0: number, win: number): void {
  const want = win / 8
  const steps = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120]
  const step = steps.find((s) => s >= want) ?? 120
  ctx.font = '10px ui-monospace, Menlo, monospace'
  ctx.textBaseline = 'alphabetic'
  for (let t = Math.ceil(t0 / step) * step; t <= t0 + win; t += step) {
    const x = Math.round(((t - t0) / win) * w)
    ctx.fillStyle = 'rgba(236,230,220,0.5)'
    ctx.fillRect(x, h - 7, 1, 7)
    const m = Math.floor(t / 60), s = t - m * 60
    const label = `${m}:${s.toFixed(step < 0.1 ? 3 : step < 1 ? 2 : 0).padStart(step < 0.1 ? 6 : step < 1 ? 5 : 2, '0')}`
    ctx.fillStyle = 'rgba(236,230,220,0.55)'
    ctx.fillText(label, x + 3, h - 9)
  }
}
