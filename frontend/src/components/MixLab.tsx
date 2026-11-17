import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Seg } from '../lib/Seg'
import { api, audioUrl } from '../api'
import { useApp } from '../store'
import type { Grid, TrackDetail, Waveform } from '../types'
import { cleanTitle, fmtBpm, parseKey } from '../util'
import { KeyBadge, Sleeve } from './bits'
import { IconPause, IconPlay, IconSwap, IconThumbDown, IconThumbUp, IconX } from './icons'

interface Deck { t: TrackDetail; g: Grid; w: Waveform | null; db: number[]; bar: number; dur: number }
interface Voice { s: AudioBufferSourceNode; f: GainNode }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const isMuted = () => (window as unknown as { __BATEA_MUTE?: boolean }).__BATEA_MUTE === true

function keyRelation(a: string | null, b: string | null): { text: string; tone: 'ok' | 'mid' | 'bad' | 'none' } {
  const pa = parseKey(a), pb = parseKey(b)
  if (!pa || !pb) return { text: 'falta el tono de alguno', tone: 'none' }
  const d = Math.min(Math.abs(pa[0] - pb[0]) % 12, 12 - (Math.abs(pa[0] - pb[0]) % 12))
  if (d === 0 && pa[1] === pb[1]) return { text: 'misma tonalidad', tone: 'ok' }
  if (d === 1 && pa[1] === pb[1]) return { text: 'tonalidad vecina', tone: 'ok' }
  if (d === 0) return { text: 'relativa mayor/menor', tone: 'ok' }
  if (d === 2 && pa[1] === pb[1]) return { text: 'salto de energía (+2)', tone: 'mid' }
  if (d === 1) return { text: 'diagonal', tone: 'mid' }
  return { text: 'choque armónico', tone: 'bad' }
}

function makeDeck(t: TrackDetail, g: Grid, w: Waveform | null): Deck {
  const dur = g.duration ?? t.duration ?? w?.duration ?? 0
  const bar = g.bpm ? 240 / g.bpm : 2
  let db = g.downbeats
  if (!db.length) db = Array.from({ length: Math.max(1, Math.floor(dur / bar)) }, (_, i) => i * bar)
  return { t, g, w, db, bar, dur }
}

/** Curva automática: B entra sin graves, a mitad del solape se cambian los graves, A se va. */
function autoMix(p: number): { x: number; cutA: boolean; cutB: boolean } {
  if (p <= 0) return { x: 0, cutA: false, cutB: false }
  if (p >= 1) return { x: 1, cutA: false, cutB: false }
  const x = p < 0.25 ? 2 * p : p < 0.75 ? 0.5 : 0.5 + 2 * (p - 0.75)
  return { x, cutA: p >= 0.5, cutB: p < 0.5 }
}

export function MixLab() {
  const mix = useApp((s) => s.mix)
  if (!mix) return null
  return <MixInner key={`${mix.a}-${mix.b}`} a={mix.a} b={mix.b} />
}

function MixInner({ a, b }: { a: number; b: number }) {
  const { closeMix, openMix, toast, bump } = useApp()
  const [decks, setDecks] = useState<{ A: Deck; B: Deck } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mixBar, setMixBar] = useState(0)
  const [startBar, setStartBar] = useState(0)
  const [nudge, setNudge] = useState(0)
  const [auto, setAuto] = useState(true)
  const [x, setX] = useState(0)
  const [cutA, setCutA] = useState(false)
  const [cutB, setCutB] = useState(false)
  const [zoom, setZoom] = useState<'mix' | 'all'>('mix')
  const [playing, setPlaying] = useState(false)
  const [ui, setUi] = useState({ T: 0, x: 0, cutA: false, cutB: false })
  const [size, setSize] = useState({ w: 900, h: 190 })
  const [loaded, setLoaded] = useState({ A: false, B: false })

  // Motor: los dos temas se decodifican a memoria y suenan con Web Audio. Así la sincronía es exacta
  // por construcción (los dos corren sobre el mismo reloj de audio) y no depende de los saltos de <audio>.
  const audio = useRef<{ ctx: AudioContext; gA: GainNode; gB: GainNode; hpA: BiquadFilterNode; hpB: BiquadFilterNode } | null>(null)
  const bufs = useRef<{ A: AudioBuffer | null; B: AudioBuffer | null }>({ A: null, B: null })
  const eng = useRef<{ A: Voice | null; B: Voice | null; T0: number; t0: number }>({ A: null, B: null, T0: 0, t0: 0 })
  const raf = useRef(0)
  const isPlaying = useRef(false)
  const win = useRef({ w0: 0, w1: 1 })
  const cv = useRef<HTMLCanvasElement>(null)
  const ph = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const lastUi = useRef(0)
  const lastFrame = useRef(0)

  // ------------------------------------------------------------ carga
  useEffect(() => {
    let alive = true
    let ctx: AudioContext | null = null
    Promise.all([api.track(a), api.track(b), api.grid(a), api.grid(b), api.waveform(a, 2400).catch(() => null), api.waveform(b, 2400).catch(() => null)])
      .then(([ta, tb, ga, gb, wa, wb]) => {
        if (!alive) return
        const A = makeDeck(ta, ga, wa), B = makeDeck(tb, gb, wb)
        const nA = A.db.length
        const lead = Math.min(Math.max(8, nA - 8), Math.ceil(Math.max(ta.outro_bars ?? 0, 16) / 8) * 8, 64)
        const mb = Math.max(0, Math.floor((nA - lead) / 8) * 8)
        setMixBar(mb)
        eng.current.T0 = Math.max(0, (A.db[mb] ?? 0) - 8 * A.bar)      // arranca 8 compases antes de la mezcla
        setDecks({ A, B })
        if (!ta.online || !tb.online) return
        try {
          const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
          ctx = new Ctx({ latencyHint: 'playback' })
          const master = ctx.createGain()
          master.gain.value = isMuted() ? 0 : 1
          master.connect(ctx.destination)
          const chain = () => {
            const hp = ctx!.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10; hp.Q.value = 0.7
            const g = ctx!.createGain(); g.gain.value = 0
            hp.connect(g); g.connect(master)
            return { hp, g }
          }
          const ca = chain(), cb = chain()
          audio.current = { ctx, gA: ca.g, gB: cb.g, hpA: ca.hp, hpB: cb.hp }
        } catch { setError('Este sistema no tiene Web Audio: no puedo reproducir la mezcla.'); return }
        const load = async (id: number, k: 'A' | 'B') => {
          const res = await fetch(audioUrl(id))
          if (!res.ok) throw new Error('no pude leer el archivo')
          const raw = await res.arrayBuffer()
          const buf = await new Promise<AudioBuffer>((ok, ko) => { void ctx!.decodeAudioData(raw, ok, ko)?.catch?.(() => {}) })
          if (!alive) return
          bufs.current[k] = buf
          setLoaded((l) => ({ ...l, [k]: true }))
        }
        load(a, 'A').catch(() => alive && setError(`No pude decodificar el audio de “${cleanTitle(ta.title)}”.`))
        load(b, 'B').catch(() => alive && setError(`No pude decodificar el audio de “${cleanTitle(tb.title)}”.`))
      })
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
      cancelAnimationFrame(raf.current)
      isPlaying.current = false
      for (const k of ['A', 'B'] as const) { try { eng.current[k]?.s.stop() } catch { /* ya estaba parado */ } eng.current[k] = null }
      bufs.current = { A: null, B: null }
      audio.current = null
      void ctx?.close().catch(() => {})
    }
  }, [a, b])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [decks])

  const rate = useMemo(() => {
    if (!decks?.A.g.bpm || !decks.B.g.bpm) return 1
    let r = decks.A.g.bpm / decks.B.g.bpm
    while (r > 1.42) r /= 2
    while (r < 0.71) r *= 2
    return r
  }, [decks])

  const fadeBars = decks ? Math.max(4, Math.min(64, decks.A.db.length - mixBar)) : 32
  const cfg = useRef({ decks, mixBar, startBar, nudge, auto, x, cutA, cutB, rate, fadeBars })
  cfg.current = { decks, mixBar, startBar, nudge, auto, x, cutA, cutB, rate, fadeBars }

  const times = useCallback(() => {
    const c = cfg.current
    const dA = c.decks!.A, dB = c.decks!.B
    const durA = bufs.current.A?.duration ?? dA.dur
    const durB = bufs.current.B?.duration ?? dB.dur
    const mixT = dA.db[c.mixBar] ?? 0
    const bStart = (dB.db[c.startBar] ?? 0) + c.nudge
    const end = Math.max(durA, mixT + (durB - bStart) / c.rate)
    return { c, dA, dB, durA, durB, mixT, bStart, end }
  }, [])

  /** Tiempo "virtual" de la mezcla: segundos sobre la línea de tiempo de A. */
  const virtualT = useCallback(() => {
    const e = eng.current, au = audio.current
    return isPlaying.current && au ? e.T0 + (au.ctx.currentTime - e.t0) : e.T0
  }, [])

  const stopVoice = useCallback((k: 'A' | 'B') => {
    const v = eng.current[k], au = audio.current
    eng.current[k] = null
    if (!v || !au) return
    const now = au.ctx.currentTime
    try {                                   // fundido de 20 ms para que el corte no haga "click"
      v.f.gain.cancelScheduledValues(now)
      v.f.gain.setTargetAtTime(0, now, 0.006)
      v.s.stop(now + 0.04)
    } catch { /* ya terminó */ }
    setTimeout(() => { try { v.s.disconnect(); v.f.disconnect() } catch { /* nada */ } }, 200)
  }, [])

  /** Programa un tema para que en el instante `when` del reloj de audio esté en la posición `pos`. */
  const startVoice = useCallback((k: 'A' | 'B', when: number, pos: number, speed: number) => {
    stopVoice(k)
    const au = audio.current, buf = bufs.current[k]
    if (!au || !buf || pos >= buf.duration - 0.03) return
    const s = au.ctx.createBufferSource()
    s.buffer = buf
    s.playbackRate.value = speed
    const f = au.ctx.createGain()
    s.connect(f); f.connect(k === 'A' ? au.hpA : au.hpB)
    const at = pos >= 0 ? when : when + -pos / speed        // si todavía no le toca, espera su momento
    f.gain.setValueAtTime(0, at)
    f.gain.linearRampToValueAtTime(1, at + 0.012)
    s.start(at, Math.max(0, pos))
    eng.current[k] = { s, f }
  }, [stopVoice])

  const startB = useCallback((T: number, when: number) => {
    const { c, mixT, bStart } = times()
    startVoice('B', when, bStart + (T - mixT) * c.rate, c.rate)
  }, [times, startVoice])

  const startAt = useCallback((T: number) => {
    const au = audio.current
    if (!au) return
    const when = au.ctx.currentTime + 0.08
    eng.current.T0 = T; eng.current.t0 = when
    startVoice('A', when, T, 1)
    startB(T, when)
  }, [startVoice, startB])

  const pause = useCallback(() => {
    eng.current.T0 = virtualT()
    isPlaying.current = false; setPlaying(false)
    stopVoice('A'); stopVoice('B')
  }, [virtualT, stopVoice])

  const seekTo = useCallback((T: number) => {
    if (!cfg.current.decks) return
    const { end } = times()
    const to = clamp(T, 0, Math.max(0, end - 0.5))
    if (isPlaying.current) startAt(to)
    else eng.current.T0 = to
  }, [times, startAt])

  const togglePlay = useCallback(() => {
    const au = audio.current
    if (!au || !bufs.current.A || !bufs.current.B || !cfg.current.decks) return
    if (isPlaying.current) { pause(); return }
    void au.ctx.resume()
    const { end } = times()
    if (eng.current.T0 >= end - 0.6) eng.current.T0 = 0
    isPlaying.current = true; setPlaying(true)
    startAt(eng.current.T0)
  }, [pause, times, startAt])

  // ------------------------------------------------------------ mezcla y cabezal
  useEffect(() => {
    if (!decks) return
    const step = (visual: boolean) => {
      const { c, dA, durA, mixT, end } = times()
      const now = performance.now()
      if (visual) lastFrame.current = now
      else if (now - lastFrame.current < 300) return        // hay cuadros: la mezcla ya la lleva el otro reloj
      // ventana tapada: este reloj corre ~1 vez por segundo, así que apunta medio segundo adelante y suaviza más
      const ahead = visual || !isPlaying.current ? 0 : 0.5
      const tc = visual ? 0.03 : 0.3
      const T = virtualT() + ahead
      if (isPlaying.current && T - ahead >= end - 0.05) { pause(); eng.current.T0 = end }

      let xv = c.x, ca = c.cutA, cb = c.cutB
      if (c.auto) {
        const T1 = Math.min(durA, mixT + c.fadeBars * dA.bar)
        const m = autoMix((T - mixT) / Math.max(1, T1 - mixT))
        xv = m.x; ca = m.cutA; cb = m.cutB
      }
      const au = audio.current
      if (au) {
        const t0 = au.ctx.currentTime
        au.gA.gain.setTargetAtTime(Math.min(1, 2 * (1 - xv)), t0, tc); au.gB.gain.setTargetAtTime(Math.min(1, 2 * xv), t0, tc)
        au.hpA.frequency.setTargetAtTime(ca ? 240 : 10, t0, 0.06); au.hpB.frequency.setTargetAtTime(cb ? 240 : 10, t0, 0.06)
      }
      if (!visual) return
      const { w0, w1 } = win.current
      if (ph.current) ph.current.style.transform = `translateX(${clamp(((T - w0) / (w1 - w0)) * size.w, -4, size.w + 4)}px)`
      if (now - lastUi.current > 110) {
        lastUi.current = now
        setUi({ T, x: xv, cutA: ca, cutB: cb })
      }
    }
    const tick = () => { raf.current = requestAnimationFrame(tick); step(true) }
    raf.current = requestAnimationFrame(tick)
    // con la ventana tapada el navegador frena los cuadros: este reloj mantiene viva la mezcla automática
    const iv = window.setInterval(() => step(false), 120)
    return () => { cancelAnimationFrame(raf.current); window.clearInterval(iv) }
  }, [decks, times, virtualT, pause, size.w])

  // cambios de punto de mezcla mientras suena: solo se recoloca B, A sigue sin cortes
  useEffect(() => {
    const au = audio.current
    if (!decks || !au || !isPlaying.current) return
    const when = au.ctx.currentTime + 0.05
    startB(eng.current.T0 + (when - eng.current.t0), when)
  }, [mixBar, startBar, nudge]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__mix = {
      state: () => ({ T: virtualT(), playing: isPlaying.current, ctx: audio.current?.ctx.state, ctxTime: audio.current?.ctx.currentTime, A: !!eng.current.A, B: !!eng.current.B, gA: audio.current?.gA.gain.value, gB: audio.current?.gB.gain.value, ...(cfg.current.decks ? times() : {}), c: undefined, dA: undefined, dB: undefined }),
      audio,
    }
  }, [virtualT, times])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range' && (e.target as HTMLInputElement).type !== 'checkbox') return
      if (e.key === 'Escape') { e.stopPropagation(); closeMix() }
      else if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); togglePlay() }
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cfg.current.decks) {
        e.preventDefault(); e.stopPropagation()
        seekTo(Math.max(0, virtualT() + (e.key === 'ArrowLeft' ? -4 : 4) * cfg.current.decks.A.bar))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeMix, togglePlay, seekTo, virtualT])

  // ------------------------------------------------------------ línea de tiempo
  useEffect(() => {
    const c = cv.current
    if (!c || !decks) return
    const { A, B } = decks
    const mixT = A.db[mixBar] ?? 0
    const bStart = (B.db[startBar] ?? 0) + nudge
    const total = Math.max(A.dur, mixT + (B.dur - bStart) / rate)
    const w0 = zoom === 'all' ? 0 : Math.max(0, mixT - 16 * A.bar)
    const w1 = zoom === 'all' ? total : Math.min(total, A.dur + 16 * A.bar)
    win.current = { w0, w1 }
    const dpr = window.devicePixelRatio || 1
    const W = size.w, H = size.h
    c.width = W * dpr; c.height = H * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    const tx = (t: number) => ((t - w0) / (w1 - w0)) * W
    const laneH = (H - 22) / 2
    const yA = 18 + laneH, yB = 18 + laneH + 2      // A crece hacia arriba, B hacia abajo

    // solape
    ctx.fillStyle = 'rgba(255, 90, 31, 0.07)'
    ctx.fillRect(tx(mixT), 18, Math.max(0, tx(Math.min(A.dur, total)) - tx(mixT)), H - 18)

    // compases de A (cada 8 más marcado) con la cuenta hacia el final
    ctx.font = '9.5px "JetBrains Mono Variable", monospace'
    ctx.textAlign = 'center'
    const nA = A.db.length
    const every = (w1 - w0) / A.bar > 140 ? 16 : 8
    for (let i = 0; i < nA; i++) {
      const xx = tx(A.db[i])
      if (xx < -2 || xx > W + 2) continue
      if (i % every === 0) {
        ctx.fillStyle = 'rgba(236,230,220,0.16)'; ctx.fillRect(Math.round(xx), 18, 1, laneH)
        ctx.fillStyle = '#8a8278'; ctx.fillText(i === mixBar ? '' : `−${nA - i}`, xx, 11)
      } else if ((w1 - w0) / A.bar < 110 && i % 4 === 0) {
        ctx.fillStyle = 'rgba(236,230,220,0.05)'; ctx.fillRect(Math.round(xx), 18, 1, laneH)
      }
    }
    // compases de B, contados desde donde arranca
    for (let i = startBar; i < B.db.length; i++) {
      const xx = tx(mixT + (B.db[i] + nudge - bStart) / rate)
      if (xx > W + 2) break
      if (xx < -2) continue
      const k = i - startBar
      if (k % every === 0) { ctx.fillStyle = 'rgba(125,211,252,0.22)'; ctx.fillRect(Math.round(xx), yB, 1, laneH) }
      else if ((w1 - w0) / A.bar < 110 && k % 4 === 0) { ctx.fillStyle = 'rgba(125,211,252,0.07)'; ctx.fillRect(Math.round(xx), yB, 1, laneH) }
    }

    const drawLane = (d: Deck, up: boolean, tOf: (xPx: number) => number) => {
      const w = d.w
      if (!w) return
      const n = w.h.length
      for (let px = 0; px < W; px += 1.5) {
        const t = tOf(px)
        if (t < 0 || t >= d.dur) continue
        const i = Math.min(n - 1, Math.floor((t / d.dur) * n))
        const amp = (w.h[i] / 255) * (laneH - 2)
        const lo = w.low[i] / 255, mi = (w.mid[i] / 255) * 1.35, hi = (w.high[i] / 255) * 1.9
        const s = lo + mi + hi + 1e-6
        ctx.fillStyle = `rgb(${((255 * lo + 233 * mi + 125 * hi) / s) | 0}, ${((90 * lo + 223 * mi + 211 * hi) / s) | 0}, ${((31 * lo + 198 * mi + 252 * hi) / s) | 0})`
        if (up) ctx.fillRect(px, yA - amp, 1.1, amp || 1)
        else ctx.fillRect(px, yB, 1.1, amp || 1)
      }
    }
    ctx.globalAlpha = 0.92
    drawLane(A, true, (px) => w0 + (px / W) * (w1 - w0))
    drawLane(B, false, (px) => {
      const T = w0 + (px / W) * (w1 - w0)
      return T < mixT ? -1 : bStart + (T - mixT) * rate
    })
    ctx.globalAlpha = 1

    // marcas
    const mark = (t: number, label: string, color: string, y: number) => {
      const xx = tx(t)
      if (xx < -40 || xx > W + 40) return
      ctx.fillStyle = color; ctx.fillRect(Math.round(xx), 14, 1.5, H - 14)
      ctx.textAlign = xx > W - 80 ? 'right' : 'left'
      ctx.fillText(label, xx + (xx > W - 80 ? -5 : 5), y)
    }
    mark(mixT, 'ENTRA B', '#ff7a45', 11)
    mark(A.dur, 'TERMINA A', '#b8b0a4', H - 4)
    ctx.textAlign = 'left'
    ctx.fillStyle = '#ece6dc'; ctx.fillText('A', 4, 30)
    ctx.fillStyle = '#7dd3fc'; ctx.fillText('B', 4, H - 6)
  }, [decks, mixBar, startBar, nudge, rate, zoom, size])

  // ------------------------------------------------------------ UI
  if (error) {
    return (
      <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && closeMix()}>
        <div className="modal"><h2>Probar mezcla</h2><p className="muted">{error}</p><button className="btn" onClick={closeMix}>Cerrar</button></div>
      </div>
    )
  }
  if (!decks) return <div className="modal-bg"><div className="modal" style={{ width: 300 }}>Cargando los dos temas…</div></div>

  const { A, B } = decks
  const nA = A.db.length
  const online = A.t.online && B.t.online
  const canPlay = online && loaded.A && loaded.B
  const pitch = (rate - 1) * 100
  const kr = keyRelation(A.t.key, B.t.key)
  const nextBar = A.db.findIndex((d) => d > ui.T)
  const barNow = nextBar < 0 ? nA : Math.max(0, nextBar - 1)
  const toMix = mixBar - barNow
  const save = async (kind: 'mix' | 'mashup' | 'avoid') => {
    const note = kind === 'avoid' ? undefined : `B entra ${nA - mixBar} compases antes del final de A${startBar ? `, desde su compás ${startBar + 1}` : ''}`
    try {
      await api.relate(a, b, kind, note)
      bump()
      toast({ mix: 'Guardado: mezclan bien (con el punto de mezcla anotado)', mashup: 'Guardado como mashup', avoid: 'Guardado: no van. No lo voy a sugerir más' }[kind])
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const deckCard = (d: Deck, role: 'A' | 'B') => (
    <div className={`mx-deck ${role}`}>
      <div className="mx-sleeve"><Sleeve id={d.t.id} title={d.t.title} artist={d.t.artist} trackKey={d.t.key} bpm={d.t.bpm} hasArt={d.t.has_art} online={d.t.online} size="m" px={64} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">{role === 'A' ? 'A · el que sale' : 'B · el que entra'}</div>
        <div className="ellipsis" style={{ fontWeight: 650, fontSize: 14 }}>{cleanTitle(d.t.title)}</div>
        <div className="ellipsis muted" style={{ fontSize: 12 }}>{d.t.artist || '—'}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <span className="num">{fmtBpm(d.g.bpm)} BPM</span><KeyBadge k={d.t.key} est={!!d.t.key_est} />
          {role === 'B' && Math.abs(pitch) > 0.05 && <span className="num" style={{ color: Math.abs(pitch) > 6 ? 'var(--danger)' : 'var(--accent-2)' }}>{pitch > 0 ? '+' : ''}{pitch.toFixed(1)}% pitch</span>}
          {!d.t.online && <span className="faint">offline</span>}
        </div>
      </div>
    </div>
  )

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && closeMix()}>
      <div className="modal mixlab">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ flex: 1 }}>Probar mezcla</h2>
          <span className={`mx-tone ${kr.tone}`}>{A.t.key && B.t.key ? `${A.t.key} → ${B.t.key} · ` : ''}{kr.text}</span>
          <button className="btn ghost sm icon" onClick={closeMix} title="Cerrar (Esc)"><IconX size={15} /></button>
        </div>

        <div className="mx-decks">
          {deckCard(A, 'A')}
          <button className="btn ghost icon" title="Invertir: que B sea el que sale" onClick={() => openMix(b, a)}><IconSwap size={16} /></button>
          {deckCard(B, 'B')}
        </div>

        <div className="mx-timeline" ref={wrap} onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const { w0, w1 } = win.current
          seekTo(w0 + ((e.clientX - r.left) / r.width) * (w1 - w0))
        }}>
          <canvas ref={cv} />
          <div className="mx-playhead" ref={ph} />
        </div>

        {!online && <div className="mx-warn">No puedo reproducir: {!A.t.online && !B.t.online ? 'los dos archivos están' : 'uno de los archivos está'} en un disco desconectado. Igual podés ver cómo caen los compases.</div>}
        {(A.g.approx || B.g.approx) && <div className="mx-warn soft">La grilla de {A.g.approx && B.g.approx ? 'los dos temas' : A.g.approx ? 'A' : 'B'} la calculó Batea (no viene de rekordbox). Si los bombos no caen juntos, corregí con “Fase de B”.</div>}

        <div className="mx-transport">
          <button className="playbtn" style={{ width: 44, height: 44 }} disabled={!canPlay} onClick={togglePlay}>{playing ? <IconPause size={17} /> : <IconPlay size={17} />}</button>
          <button className="btn sm" disabled={!canPlay} onClick={() => seekTo(Math.max(0, (A.db[mixBar] ?? 0) - 8 * A.bar))}>Ir 8 compases antes de la mezcla</button>
          <span className="muted num" style={{ fontSize: 12 }}>
            {online && !canPlay ? `preparando el audio… ${loaded.A ? 'A listo' : 'A'} · ${loaded.B ? 'B listo' : 'B'} · ` : ''}
            {ui.T < (A.db[mixBar] ?? 0) ? `B entra en ${Math.max(0, toMix)} compases` : ui.T < A.dur ? `mezclando · a A le quedan ${Math.max(0, nA - barNow)} compases` : 'solo B'}
          </span>
          <div style={{ flex: 1 }} />
          <Seg>
            <button className={zoom === 'mix' ? 'on' : ''} onClick={() => setZoom('mix')}>Zoom a la mezcla</button>
            <button className={zoom === 'all' ? 'on' : ''} onClick={() => setZoom('all')}>Temas enteros</button>
          </Seg>
        </div>

        <div className="mx-grid">
          <div className="mx-ctl">
            <span className="eyebrow">Dónde entra B</span>
            <div className="mx-step">
              <button className="btn sm" onClick={() => setMixBar((v) => clamp(v - 16, 0, nA - 4))} title="16 compases antes">◀ 16</button>
              <button className="btn sm" onClick={() => setMixBar((v) => clamp(v - 8, 0, nA - 4))} title="8 compases antes">◀ 8</button>
              <b className="num">{nA - mixBar} compases antes del final de A</b>
              <button className="btn sm" onClick={() => setMixBar((v) => clamp(v + 8, 0, nA - 4))} title="8 compases después">8 ▶</button>
              <button className="btn sm" onClick={() => setMixBar((v) => clamp(v + 16, 0, nA - 4))} title="16 compases después">16 ▶</button>
            </div>
            <div className="faint" style={{ fontSize: 11 }}>Outro de A: {A.t.outro_bars ?? '–'} c · intro de B: {B.t.intro_bars ?? '–'} c</div>
          </div>
          <div className="mx-ctl">
            <span className="eyebrow">Desde qué compás arranca B</span>
            <div className="mx-step">
              <button className="btn sm" onClick={() => setStartBar((v) => clamp(v - 8, 0, B.db.length - 8))}>−8</button>
              <b className="num">compás {startBar + 1}</b>
              <button className="btn sm" onClick={() => setStartBar((v) => clamp(v + 8, 0, B.db.length - 8))}>+8</button>
              {(B.t.intro_bars ?? 0) > 0 && <button className="btn sm ghost" onClick={() => setStartBar(startBar ? 0 : clamp(B.t.intro_bars ?? 0, 0, B.db.length - 8))}>{startBar ? 'desde el inicio' : 'saltear la intro'}</button>}
            </div>
          </div>
          <div className="mx-ctl">
            <span className="eyebrow">Fase de B</span>
            <div className="mx-step">
              <button className="btn sm" onClick={() => setNudge((v) => v - 60 / (B.g.bpm ?? 120))}>−1 beat</button>
              <button className="btn sm" onClick={() => setNudge((v) => v - 0.01)}>−10 ms</button>
              <b className="num">{Math.round(nudge * 1000)} ms</b>
              <button className="btn sm" onClick={() => setNudge((v) => v + 0.01)}>+10 ms</button>
              <button className="btn sm" onClick={() => setNudge((v) => v + 60 / (B.g.bpm ?? 120))}>+1 beat</button>
            </div>
          </div>
          <div className="mx-ctl">
            <span className="eyebrow">Mezcla</span>
            <div className="mx-step">
              <label className="tg-opt"><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setX(ui.x); setCutA(ui.cutA); setCutB(ui.cutB) }} /> Automática</label>
              <span className="num">A</span>
              <input type="range" min={0} max={1} step={0.01} style={{ flex: 1, ['--v' as string]: auto ? ui.x : x }} value={auto ? ui.x : x} disabled={auto} onChange={(e) => setX(Number(e.target.value))} />
              <span className="num" style={{ color: '#7dd3fc' }}>B</span>
            </div>
            <div className="mx-step">
              <button className={`btn sm${(auto ? ui.cutA : cutA) ? ' primary' : ''}`} disabled={auto} onClick={() => setCutA(!cutA)}>Sin graves A</button>
              <button className={`btn sm${(auto ? ui.cutB : cutB) ? ' primary' : ''}`} disabled={auto} onClick={() => setCutB(!cutB)}>Sin graves B</button>
              {Math.abs(pitch) > 0.05 && <span className="faint" style={{ fontSize: 11 }} title="B suena a la velocidad de A, y su tono se mueve con el pitch">B con pitch, como en el CDJ sin Master Tempo</span>}
            </div>
          </div>
        </div>

        <div className="mx-verdict">
          <span className="muted">¿Y? Batea aprende de lo que decidas:</span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => save('avoid')}><IconThumbDown size={14} /> No van</button>
          <button className="btn" onClick={() => save('mashup')}>Funciona como mashup</button>
          <button className="btn primary" onClick={() => save('mix')}><IconThumbUp size={14} /> Mezclan bien</button>
        </div>
      </div>
    </div>
  )
}
