import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { audioUrl } from '../../api'
import { cleanTitle } from '../../util'
import { evaluate, type Automation, type Held } from './automation'
import { clamp, makeTiming, type Deck, type Placement, type Side, type Timing, type Transition } from './model'
import { buildPeaks, type Peaks } from './peaks'

export type EQ = readonly [number, number, number]
export interface ManualMix { x: number; A: EQ; B: EQ; law: Transition }

interface Settings {
  auto: boolean
  style: Transition
  manual: ManualMix
  automation: Automation
  held: Held
  bar: number
}

interface Config extends Settings {
  timing: Timing | null
  rate: number
  onFrame: (time: number, playing: boolean) => void
}

interface Options extends Omit<Config, 'timing'> {
  placement: Placement
  length: number
}

interface Voice { source: AudioBufferSourceNode; gain: GainNode }
interface Channel {
  bands: [BiquadFilterNode, BiquadFilterNode, BiquadFilterNode]
  level: GainNode
  applied: Float64Array
}

interface Engine { ctx: AudioContext; master: GainNode; A: Channel; B: Channel }
interface Media { duration: number | null; peaks: Peaks | null }

const FLAT: EQ = [0, 0, 0]
const EMPTY_MEDIA: Media = { duration: null, peaks: null }
export const DEFAULT_MANUAL: ManualMix = { x: 0, A: FLAT, B: FLAT, law: 'bass' }

function mixAt(out: ManualMix, c: Config, t: number) {
  if (c.auto && c.timing) {
    // cada control sigue su curva, salvo los que se agarraron a mano mientras suena
    const at = (t - c.timing.mixT) / c.bar
    const a = c.automation, h = c.held
    out.x = clamp(h.x ?? evaluate(a.x, at), 0, 1)
    out.A = [h.A0 ?? evaluate(a.A0, at), h.A1 ?? evaluate(a.A1, at), h.A2 ?? evaluate(a.A2, at)]
    out.B = [h.B0 ?? evaluate(a.B0, at), h.B1 ?? evaluate(a.B1, at), h.B2 ?? evaluate(a.B2, at)]
    out.law = c.style
  } else {
    out.x = c.manual.x
    out.A = c.manual.A
    out.B = c.manual.B
    out.law = c.manual.law
  }
}

function createChannel(ctx: AudioContext, master: GainNode): Channel {
  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = 120
  const mid = ctx.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = 1000
  mid.Q.value = 0.7
  const high = ctx.createBiquadFilter()
  high.type = 'highshelf'
  high.frequency.value = 4000
  const level = ctx.createGain()
  level.gain.value = 0
  low.connect(mid)
  mid.connect(high)
  high.connect(level)
  level.connect(master)
  return { bands: [low, mid, high], level, applied: new Float64Array(4).fill(NaN) }
}

function applyChannel(channel: Channel, gain: number, eq: EQ, when: number, smooth: number) {
  const { applied, bands, level } = channel
  if (applied[3] !== gain) {
    level.gain.setTargetAtTime(gain, when, smooth)
    applied[3] = gain
  }
  for (let band = 0; band < 3; band++) {
    if (applied[band] === eq[band]) continue
    bands[band].gain.setTargetAtTime(eq[band], when, 0.018)
    applied[band] = eq[band]
  }
}

export function useMixAudio(decks: { A: Deck; B: Deck } | null, options: Options) {
  const [media, setMedia] = useState({ A: EMPTY_MEDIA, B: EMPTY_MEDIA })
  const { placement, length, rate, auto, style, manual, automation, held, bar, onFrame } = options
  const durA = media.A.duration, durB = media.B.duration
  const timing = useMemo(() => {
    if (!decks) return null
    const { A, B } = decks
    return makeTiming(A, B, placement, rate, length, durA ?? A.dur, durB ?? B.dur)
  }, [decks, placement, rate, length, durA, durB])
  const config = useRef<Config>({ auto, style, manual, automation, held, bar, timing, rate, onFrame })
  config.current = { auto, style, manual, automation, held, bar, timing, rate, onFrame }
  const engine = useRef<Engine | null>(null)
  const buffers = useRef<{ A: AudioBuffer | null; B: AudioBuffer | null }>({ A: null, B: null })
  const transport = useRef<{ A: Voice | null; B: Voice | null; start: number; clock: number; playing: boolean }>({
    A: null, B: null, start: 0, clock: 0, playing: false,
  })
  const sample = useRef({ ...DEFAULT_MANUAL })
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const request = useRef(0)

  const virtualT = useCallback(() => {
    const e = transport.current, ctx = engine.current?.ctx
    return e.playing && ctx ? e.start + Math.max(0, ctx.currentTime - e.clock) : e.start
  }, [])

  const apply = useCallback((time: number, smooth = 0.018) => {
    const e = engine.current
    if (!e) return
    mixAt(sample.current, config.current, time)
    const { x, A, B, law } = sample.current
    const angle = x * Math.PI / 2
    const gainA = law === 'blend' ? (x === 1 ? 0 : Math.cos(angle)) : Math.min(1, 2 * (1 - x))
    const gainB = law === 'blend' ? Math.sin(angle) : Math.min(1, 2 * x)
    e.master.gain.value = (window as Window & { __BATEA_MUTE?: boolean }).__BATEA_MUTE ? 0 : 1
    const now = e.ctx.currentTime
    applyChannel(e.A, gainA, A, now, smooth)
    applyChannel(e.B, gainB, B, now, smooth)
  }, [])

  const stopVoice = useCallback((side: Side, at?: number) => {
    const v = transport.current[side], e = engine.current
    transport.current[side] = null
    if (!v || !e) return
    const t = at ?? e.ctx.currentTime
    try {
      if (v.gain.gain.cancelAndHoldAtTime) v.gain.gain.cancelAndHoldAtTime(t)
      else v.gain.gain.cancelScheduledValues(t)
      v.gain.gain.setTargetAtTime(0, t, 0.006)
      v.source.stop(t + 0.035)
    } catch { /* la fuente ya terminó */ }
  }, [])

  const startVoice = useCallback((side: Side, when: number, pos: number, speed: number) => {
    stopVoice(side, when)
    const e = engine.current, buffer = buffers.current[side]
    if (!e || !buffer || pos >= buffer.duration) return
    const start = Math.max(0, pos)
    const at = when + (start - pos) / speed
    const source = e.ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = speed
    const gain = e.ctx.createGain()
    gain.gain.value = 0
    source.connect(gain).connect(e[side].bands[0])
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(1, at + 0.012)
    source.onended = () => {
      if (transport.current[side]?.source === source) transport.current[side] = null
      source.disconnect()
      gain.disconnect()
    }
    source.start(at, start)
    transport.current[side] = { source, gain }
  }, [stopVoice])

  const startB = useCallback((time: number, when: number) => {
    const { rate, timing } = config.current
    if (!timing) return
    const actual = Math.max(time, timing.cueT)
    stopVoice('B', when)
    startVoice('B', when + actual - time, timing.bStart + (actual - timing.cueT) * rate, rate)
  }, [startVoice, stopVoice])

  const startAt = useCallback((time: number) => {
    const e = engine.current
    if (!e) return
    const when = e.ctx.currentTime + 0.06
    transport.current.start = time
    transport.current.clock = when
    startVoice('A', when, time, 1)
    startB(time, when)
  }, [startB, startVoice])

  const pause = useCallback((time = virtualT()) => {
    const t = transport.current
    t.start = time
    t.playing = false
    setPlaying(false)
    stopVoice('A')
    stopVoice('B')
    apply(time)
    config.current.onFrame(time, false)
  }, [apply, stopVoice, virtualT])

  const seek = useCallback((time: number) => {
    const { timing, onFrame } = config.current
    if (!timing) return
    const to = clamp(time, 0, timing.end)
    if (transport.current.playing && to >= timing.end) { pause(to); return }
    if (transport.current.playing) startAt(to)
    else transport.current.start = to
    apply(to)
    onFrame(to, transport.current.playing)
  }, [apply, pause, startAt])

  const toggle = useCallback(() => {
    const e = engine.current, { timing, onFrame } = config.current
    const t = transport.current
    if (!e || !timing || !buffers.current.A || !buffers.current.B) return
    if (t.playing) { pause(); return }
    void e.ctx.resume().catch(() => {
      if (engine.current !== e) return
      pause()
      setError('No pude iniciar la reproducción.')
    })
    if (t.start >= timing.end - 0.05) t.start = 0
    t.playing = true
    apply(t.start)
    startAt(t.start)
    setPlaying(true)
    onFrame(t.start, true)
  }, [apply, pause, startAt])

  useEffect(() => {
    if (!decks || (!decks.A.t.online && !decks.B.t.online)) return
    const abort = new AbortController()
    const stopPeaks: (() => void)[] = []
    let ctx: AudioContext | undefined
    try {
      const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      ctx = new Ctx({ latencyHint: 'playback' })
      const master = ctx.createGain()
      master.connect(ctx.destination)
      engine.current = { ctx, master, A: createChannel(ctx, master), B: createChannel(ctx, master) }
      apply(virtualT())
    } catch {
      void ctx?.close().catch(() => {})
      setError('Este sistema no tiene Web Audio.')
      return
    }
    const decode = async (side: Side) => {
      const track = decks[side].t
      if (!track.online) return
      try {
        const response = await fetch(audioUrl(track.id), { signal: abort.signal })
        if (!response.ok) throw new Error('Audio no disponible')
        const raw = await response.arrayBuffer()
        if (abort.signal.aborted) return
        const buffer = await new Promise<AudioBuffer>((ok, error) => { void ctx!.decodeAudioData(raw, ok, error)?.catch(error) })
        if (abort.signal.aborted) return
        buffers.current[side] = buffer
        setMedia((m) => ({ ...m, [side]: { duration: buffer.duration, peaks: null } }))
        stopPeaks.push(buildPeaks(buffer, (peaks) => {
          setMedia((m) => ({ ...m, [side]: { duration: buffer.duration, peaks } }))
        }))
      } catch {
        if (!abort.signal.aborted) setError(`No pude decodificar “${cleanTitle(track.title)}”.`)
      }
    }
    void decode('A')
    void decode('B')
    return () => {
      abort.abort()
      stopPeaks.forEach((stop) => stop())
      stopVoice('A')
      stopVoice('B')
      buffers.current.A = buffers.current.B = null
      transport.current.playing = false
      engine.current = null
      void ctx?.close().catch(() => {})
    }
  }, [apply, decks, stopVoice, virtualT])

  const mixT = timing?.mixT, cueT = timing?.cueT, bStart = timing?.bStart
  useLayoutEffect(() => {
    apply(virtualT())
  }, [apply, virtualT, timing, auto, style, manual, automation, held])

  useLayoutEffect(() => {
    const e = engine.current, t = transport.current
    if (!e || !t.playing) return
    const when = Math.max(e.ctx.currentTime + 0.025, t.clock)
    startB(t.start + when - t.clock, when)
  }, [mixT, cueT, bStart, rate, startB])

  useEffect(() => {
    if (!playing) return
    let lastFrame = performance.now()
    const tick = () => {
      lastFrame = performance.now()
      const c = config.current
      const time = virtualT()
      if (!c.timing || !transport.current.playing) return
      if (time >= c.timing.end) { pause(c.timing.end); return }
      apply(time)
      c.onFrame(time, true)
      request.current = requestAnimationFrame(tick)
    }
    request.current = requestAnimationFrame(tick)
    const timer = window.setInterval(() => {
      const { timing } = config.current
      if (!timing || !transport.current.playing || performance.now() - lastFrame < 250) return
      const time = virtualT()
      if (time >= timing.end) pause(timing.end)
      else apply(time, 0.04)
    }, 100)
    return () => {
      cancelAnimationFrame(request.current)
      window.clearInterval(timer)
    }
  }, [apply, pause, playing, virtualT])

  const snapshot = useCallback((time = virtualT()) => {
    const current = { ...DEFAULT_MANUAL }
    mixAt(current, config.current, time)
    return current
  }, [virtualT])

  const debug = useCallback(() => ({
    T: virtualT(), playing: transport.current.playing, ctx: engine.current?.ctx.state, ctxTime: engine.current?.ctx.currentTime,
    A: !!transport.current.A, B: !!transport.current.B,
    gA: engine.current?.A.level.gain.value, gB: engine.current?.B.level.gain.value,
  }), [virtualT])

  return { engine, media, timing, error, playing, virtualT, seek, toggle, snapshot, debug }
}
