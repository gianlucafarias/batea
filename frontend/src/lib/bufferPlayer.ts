import { audioUrl } from '../api'

/**
 * Reproducción con la posición exacta, para los MP3.
 *
 * Un <audio> busca posiciones en un MP3 sin cabecera de duración (Xing/Info) por proporción de bytes, y la estima por
 * bytes/bitrate: con carátulas grandes o sin cabecera se equivoca por segundos, y el audio cae lejos de donde marca el cabezal.
 * Acá el tema se decodifica entero (Web Audio) y se reproduce desde el buffer: buscar es exacto, y la posición sale del
 * reloj del audio (con la latencia de salida descontada), no de un `currentTime` que avanza a saltos.
 *
 * Es de a un tema: al cambiar de tema se libera el buffer (un tema de 7 minutos ocupa unos 150 MB).
 */
let ctx: AudioContext | null = null
let gain: GainNode | null = null
let buf: AudioBuffer | null = null
let bufId: number | null = null
let src: AudioBufferSourceNode | null = null
let token = 0
let loading: { id: number; promise: Promise<boolean> } | null = null
let endedCb: (() => void) | null = null
const st = { playing: false, startCtx: 0, startPos: 0, pos: 0 }

function context(): AudioContext {
  if (!ctx) {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new Ctx()
    gain = ctx.createGain()
    gain.connect(ctx.destination)
  }
  return ctx
}

const latency = () => {
  const c = ctx as (AudioContext & { outputLatency?: number }) | null
  return c ? (c.outputLatency || c.baseLatency || 0) : 0
}

function halt() {
  const s = src
  src = null
  if (s) { s.onended = null; try { s.stop() } catch { /* ya parado */ } }
}

let unlocked = false

export const bp = {
  /** Hay que llamarla dentro de un click o una tecla: WebKit solo deja arrancar el audio desde un gesto del usuario, y el buffer arranca después de decodificar. */
  unlock() {
    const c = context()
    void c.resume()
    if (unlocked) return
    unlocked = true
    try { const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0) } catch { /* sin audio */ }
  },
  ready: (id: number) => bufId === id && buf !== null,
  duration: () => buf?.duration ?? 0,
  isPlaying: () => st.playing,
  onEnded: (cb: () => void) => { endedCb = cb },

  /** Decodifica el tema (una sola vez por tema). Resuelve true cuando está listo, false si no se pudo. */
  load(id: number): Promise<boolean> {
    if (bufId === id && buf) return Promise.resolve(true)
    if (loading && loading.id === id) return loading.promise
    const mine = ++token
    buf = null; bufId = null
    const c = context()
    const promise = (async () => {
      try {
        const res = await fetch(audioUrl(id))
        if (!res.ok) return false
        const raw = await res.arrayBuffer()
        const decoded = await new Promise<AudioBuffer>((ok, bad) => { void c.decodeAudioData(raw, ok, bad)?.catch(bad) })
        if (mine !== token) return false                       // mientras tanto se pidió otro tema
        buf = decoded; bufId = id
        return true
      } catch { return false } finally { if (loading && loading.id === id && mine === token) loading = null }
    })()
    loading = { id, promise }
    return promise
  },

  /** Arranca desde `at` segundos. */
  start(at: number, volume: number) {
    const c = context(), b = buf
    if (!b || !gain) return
    halt()
    void c.resume()
    gain.gain.value = volume
    const s = c.createBufferSource()
    s.buffer = b
    s.connect(gain)
    const from = Math.min(Math.max(0, at), Math.max(0, b.duration - 0.001))
    s.onended = () => {
      if (src !== s) return
      src = null
      st.playing = false; st.pos = b.duration
      endedCb?.()
    }
    s.start(0, from)
    st.playing = true; st.startCtx = c.currentTime; st.startPos = from; st.pos = from
    src = s
  },

  position(): number {
    if (!st.playing || !ctx || !buf) return st.pos
    return Math.min(buf.duration, st.startPos + Math.max(0, ctx.currentTime - st.startCtx - latency()))
  },

  pause(): number {
    const p = bp.position()
    halt()
    st.playing = false; st.pos = p
    return p
  },

  setPos(t: number) { st.pos = Math.max(0, t) },
  setVolume(v: number) { if (gain) gain.gain.value = v },

  /** Corta el audio y libera el buffer. */
  release() {
    token++
    halt()
    st.playing = false; st.pos = 0
    buf = null; bufId = null; loading = null
  },
}
