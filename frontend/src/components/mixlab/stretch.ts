/**
 * Master tempo: cambia la velocidad sin tocar el tono (WSOLA, el mismo método que SoundTouch / el "atempo" de ffmpeg).
 * `rate` > 1 acelera: la salida dura `input / rate`. La muestra n de la salida corresponde a la n·rate de la entrada,
 * sin corrimiento sistemático (la búsqueda está centrada), así la grilla de B sigue cayendo donde el modelo la calcula.
 */
export function stretch(channels: Float32Array[], sampleRate: number, rate: number): Float32Array[] {
  const length = channels[0]?.length ?? 0
  const seq = Math.round(0.04 * sampleRate)
  const overlap = Math.round(0.008 * sampleRate)
  const seek = Math.round(0.01 * sampleRate) // ±5 ms: los golpes no se corren más que eso
  const outHop = seq - overlap
  const inHop = outHop * rate
  const outLength = Math.floor(length / rate)
  const out = channels.map(() => new Float32Array(outLength))
  if (!length || !outLength) return out

  // la correlación se mide sobre la suma de canales
  const mono = new Float32Array(length)
  for (const ch of channels) for (let i = 0; i < length; i++) mono[i] += ch[i]

  const fadeIn = new Float32Array(overlap)
  for (let i = 0; i < overlap; i++) fadeIn[i] = 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / overlap)
  const tail = new Float32Array(overlap)

  const score = (ref: Float32Array, at: number) => {
    let corr = 0, norm = 1e-9
    for (let i = 0; i < overlap; i += 2) {
      const v = mono[at + i]
      corr += v * ref[i]
      norm += v * v
    }
    return corr / Math.sqrt(norm)
  }

  let prev = 0 // inicio del último segmento copiado (en la entrada)
  let written = 0
  for (let j = 0; written < outLength; j++) {
    const nominal = Math.round(j * inHop)
    let start = nominal
    if (j > 0) {
      // lo que seguía al segmento anterior: el empalme ideal
      for (let i = 0; i < overlap; i++) tail[i] = mono[prev + seq - overlap + i] ?? 0
      const lo = Math.max(0, nominal - (seek >> 1)), hi = Math.min(length - seq, nominal + (seek >> 1))
      if (hi >= lo) {
        let best = lo, bestScore = -Infinity
        for (let k = lo; k <= hi; k += 4) {
          const s = score(tail, k)
          if (s > bestScore) { bestScore = s; best = k }
        }
        for (let k = Math.max(lo, best - 3); k <= Math.min(hi, best + 3); k++) {
          const s = score(tail, k)
          if (s > bestScore) { bestScore = s; best = k }
        }
        start = best
      }
    }
    if (start + seq > length) {
      // final del tema: copiar lo que queda sin estirar
      for (let c = 0; c < channels.length; c++) {
        const src = channels[c], dst = out[c]
        for (let n = written, i = Math.min(nominal, length - 1); n < outLength && i < length; n++, i++) dst[n] = src[i]
      }
      break
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c], dst = out[c]
      let n = written
      if (j === 0) {
        for (let i = 0; i < overlap && n < outLength; i++, n++) dst[n] = src[start + i]
      } else {
        const tailAt = prev + seq - overlap
        for (let i = 0; i < overlap && n < outLength; i++, n++) {
          const w = fadeIn[i]
          dst[n] = src[tailAt + i] * (1 - w) + src[start + i] * w
        }
      }
      for (let i = overlap; i < seq - overlap && n < outLength; i++, n++) dst[n] = src[start + i]
    }
    written += outHop
    prev = start
  }
  return out
}
