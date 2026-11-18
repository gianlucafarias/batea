export interface PeakLevel {
  block: number
  min: Int16Array
  max: Int16Array
}

export interface Peaks {
  sampleRate: number
  levels: PeakLevel[]
}

const BLOCK = 64
const FACTOR = 4

/** Trabaja por tandas para dejar tiempo a los eventos de puntero y al canvas. */
export function buildPeaks(buffer: AudioBuffer, done: (peaks: Peaks) => void): () => void {
  const { sampleRate, length, numberOfChannels } = buffer
  const channels = Array.from({ length: numberOfChannels }, (_, i) => buffer.getChannelData(i))
  const levels: PeakLevel[] = []
  for (let block = BLOCK; block <= 16384; block *= FACTOR) {
    const count = Math.ceil(length / block)
    levels.push({ block, min: new Int16Array(count), max: new Int16Array(count) })
  }

  let level = 0, index = 0, timer = 0
  const step = () => {
    const { min, max } = levels[level]
    const prev = levels[level - 1]
    const until = Math.min(min.length, index + (prev ? 4096 : 1024))
    for (; index < until; index++) {
      let lo = 0, hi = 0
      if (prev) {
        const start = index * FACTOR
        const end = Math.min(prev.min.length, start + FACTOR)
        for (let i = start; i < end; i++) {
          lo = Math.min(lo, prev.min[i])
          hi = Math.max(hi, prev.max[i])
        }
        min[index] = lo
        max[index] = hi
      } else {
        const start = index * BLOCK
        const end = Math.min(length, start + BLOCK)
        for (const samples of channels) {
          for (let i = start; i < end; i++) {
            lo = Math.min(lo, samples[i])
            hi = Math.max(hi, samples[i])
          }
        }
        min[index] = Math.round(Math.max(-1, lo) * 32767)
        max[index] = Math.round(Math.min(1, hi) * 32767)
      }
    }
    if (index === min.length) {
      level++
      index = 0
      if (level === levels.length) {
        done({ sampleRate, levels })
        return
      }
    }
    timer = window.setTimeout(step, 0)
  }
  timer = window.setTimeout(step, 0)
  return () => window.clearTimeout(timer)
}
