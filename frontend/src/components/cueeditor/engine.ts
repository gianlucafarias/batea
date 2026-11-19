import { useCallback, useEffect, useRef, useState } from 'react'
import { audioUrl } from '../../api'
import { buildPeaks, type Peaks } from '../mixlab/peaks'

export interface Loop { start: number; end: number }          // segundos

/**
 * Audio del editor de cues, con la posición exacta.
 *
 * El tema se decodifica entero (Web Audio) y se reproduce con un `AudioBufferSourceNode`: la posición sale del reloj del
 * audio, no de `currentTime` de un <audio> (que avanza a saltos de decenas de milisegundos), y se descuenta la latencia de
 * salida para que el cabezal marque lo que se está escuchando. Los loops son del propio nodo, sin cortes.
 * También arma los picos de la onda a nivel de muestra para dibujar el detalle con precisión.
 */
export function usePreciseAudio(id: number) {
  const ctxRef = useRef<AudioContext | null>(null)
  const bufRef = useRef<AudioBuffer | null>(null)
  const srcRef = useRef<AudioBufferSourceNode | null>(null)
  const st = useRef<{ playing: boolean; startCtx: number; startPos: number; pos: number; loop: Loop | null }>({ playing: false, startCtx: 0, startPos: 0, pos: 0, loop: null })
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [peaks, setPeaks] = useState<Peaks | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    ctxRef.current = ctx
    const abort = new AbortController()
    let stopPeaks = () => undefined as void
    ;(async () => {
      try {
        const res = await fetch(audioUrl(id), { signal: abort.signal })
        if (!res.ok) throw new Error('El archivo no está disponible')
        const raw = await res.arrayBuffer()
        const buf = await new Promise<AudioBuffer>((ok, bad) => { void ctx.decodeAudioData(raw, ok, bad)?.catch(bad) })
        bufRef.current = buf
        setBuffer(buf)
        setLoading(false)
        stopPeaks = buildPeaks(buf, setPeaks)
      } catch (e) {
        if (!abort.signal.aborted) { setError((e as Error).message || 'No pude preparar el audio'); setLoading(false) }
      }
    })()
    return () => {
      abort.abort(); stopPeaks()
      try { srcRef.current?.stop() } catch { /* ya parado */ }
      srcRef.current = null
      void ctx.close()
      ctxRef.current = null; bufRef.current = null
    }
  }, [id])

  const latency = () => {
    const c = ctxRef.current as (AudioContext & { outputLatency?: number }) | null
    return c ? (c.outputLatency || c.baseLatency || 0) : 0
  }

  /** Posición (s) de lo que se está escuchando. */
  const position = useCallback((): number => {
    const s = st.current, c = ctxRef.current, b = bufRef.current
    if (!s.playing || !c) return s.pos
    let t = s.startPos + Math.max(0, c.currentTime - s.startCtx - latency())
    if (s.loop && s.loop.end > s.loop.start && t >= s.loop.end && s.startPos < s.loop.end) t = s.loop.start + ((t - s.loop.start) % (s.loop.end - s.loop.start))
    return b ? Math.min(t, b.duration) : t
  }, [])

  const halt = () => {
    const src = srcRef.current
    srcRef.current = null
    if (src) { src.onended = null; try { src.stop() } catch { /* ya parado */ } }
  }

  const start = useCallback((from: number, loop: Loop | null) => {
    const c = ctxRef.current, b = bufRef.current
    if (!c || !b) { st.current.pos = from; st.current.loop = loop; return }
    halt()
    void c.resume()
    const src = c.createBufferSource()
    src.buffer = b
    src.connect(c.destination)
    if (loop && loop.end > loop.start) { src.loop = true; src.loopStart = loop.start; src.loopEnd = loop.end }
    const at = Math.min(Math.max(0, from), Math.max(0, b.duration - 0.001))
    src.onended = () => {
      if (srcRef.current !== src) return
      srcRef.current = null
      st.current.playing = false; st.current.pos = b.duration
      setPlaying(false)
    }
    src.start(0, at)
    st.current = { playing: true, startCtx: c.currentTime, startPos: at, pos: at, loop }
    srcRef.current = src
    setPlaying(true)
  }, [])

  const pause = useCallback(() => {
    if (!st.current.playing) return
    const t = position()
    halt()
    st.current = { ...st.current, playing: false, pos: t }
    setPlaying(false)
  }, [position])

  const seek = useCallback((t: number) => {
    const s = st.current
    const to = Math.max(0, bufRef.current ? Math.min(t, bufRef.current.duration) : t)
    if (s.playing) start(to, s.loop); else s.pos = to
  }, [start])

  const play = useCallback((loop?: Loop | null) => {
    const s = st.current
    start(s.pos, loop === undefined ? s.loop : loop)
  }, [start])

  /** Cambia (o quita) el loop activo; si está sonando, sigue desde donde estaba. */
  const setLoop = useCallback((loop: Loop | null) => {
    const s = st.current
    if (s.playing) start(position(), loop); else s.loop = loop
  }, [position, start])

  return { buffer, peaks, loading, error, playing, position, play, pause, seek, setLoop }
}
