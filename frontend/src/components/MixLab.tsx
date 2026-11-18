import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { GlyphSwap } from '../lib/fluidHover'
import { useApp } from '../store'
import { cleanTitle, fmtBpm, parseKey } from '../util'
import { KeyBadge, Sleeve } from './bits'
import { IconPause, IconPlay, IconSwap, IconThumbDown, IconThumbUp, IconX } from './icons'
import { CenterMixer, DeckEQ, MixHelp, Stepper, type TransitionLength } from './mixlab/Controls'
import { Timeline, type TimelineHandle } from './mixlab/Timeline'
import { barAt, beatAt, clamp, defaultEntry, makeDeck, phaseOffset, playbackRate, signed, type Deck, type Placement, type Side, type Transition } from './mixlab/model'
import { DEFAULT_MANUAL, useMixAudio, type ManualMix } from './mixlab/useMixAudio'

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

const INITIAL_PLACEMENT: Placement = { mixBar: 0, startBar: 0, nudge: 0 }

export function MixLab() {
  const mix = useApp((s) => s.mix)
  if (!mix) return null
  return <MixInner key={`${mix.a}-${mix.b}`} a={mix.a} b={mix.b} />
}

function DeckCard({ deck: d, side, pitch = 0 }: { deck: Deck; side: Side; pitch?: number }) {
  return (
    <div className={`mx-deck ${side}`}>
      <div className="mx-sleeve">
        <Sleeve id={d.t.id} title={d.t.title} artist={d.t.artist} trackKey={d.t.key} bpm={d.t.bpm}
          hasArt={d.t.has_art} online={d.t.online} size="m" px={54} />
      </div>
      <div className="mx-deck-info">
        <div className="mx-deck-role"><b className="num">{side}</b>{side === 'A' ? 'Sale' : 'Entra'}</div>
        <div className="mx-deck-title ellipsis" title={cleanTitle(d.t.title)}>{cleanTitle(d.t.title)}</div>
        {d.t.artist && <div className="mx-artist muted ellipsis">{d.t.artist}</div>}
        <div className="mx-deck-meta">
          <span className="num">{fmtBpm(d.g.bpm)} BPM</span>
          <KeyBadge k={d.t.key} est={!!d.t.key_est} />
          {Math.abs(pitch) > 0.05 && <span className={`num mx-pitch${Math.abs(pitch) > 6 ? ' large' : ''}`}
            title="Varía la velocidad y el tono, como en un CDJ sin Master Tempo">{pitch > 0 ? '+' : ''}{pitch.toFixed(1)}% pitch</span>}
          {!d.t.online && <span className="muted">Sin conexión</span>}
        </div>
      </div>
    </div>
  )
}

function MixInner({ a, b }: { a: number; b: number }) {
  const closeMix = useApp((s) => s.closeMix)
  const openMix = useApp((s) => s.openMix)
  const toast = useApp((s) => s.toast)
  const bump = useApp((s) => s.bump)
  const [decks, setDecks] = useState<{ A: Deck; B: Deck } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [placement, setPlacement] = useState<Placement>(INITIAL_PLACEMENT)
  const [style, setStyle] = useState<Transition>('bass')
  const [length, setLength] = useState<TransitionLength>(16)
  const [mixer, setMixer] = useState({ auto: true, manual: DEFAULT_MANUAL })
  const [help, setHelp] = useState(false)
  const [time, setTime] = useState(0)
  const timeline = useRef<TimelineHandle>(null)
  const modal = useRef<HTMLDivElement>(null)
  const lastUi = useRef(0)
  const initialized = useRef(false)
  const { mixBar, startBar, nudge } = placement

  useEffect(() => {
    let alive = true
    Promise.all([api.track(a), api.track(b), api.grid(a), api.grid(b),
      api.waveform(a, 2400).catch(() => null), api.waveform(b, 2400).catch(() => null)])
      .then(([ta, tb, ga, gb, wa, wb]) => {
        if (!alive) return
        const A = makeDeck(ta, ga, wa), B = makeDeck(tb, gb, wb)
        setPlacement({ ...INITIAL_PLACEMENT, mixBar: defaultEntry(A) })
        setDecks({ A, B })
      })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [a, b])

  const rate = useMemo(() => decks ? playbackRate(decks.A, decks.B) : 1, [decks])
  const onFrame = useCallback((t: number, playing: boolean) => {
    timeline.current?.playhead(t, playing)
    const now = performance.now()
    if (!playing || now - lastUi.current >= 60) {
      lastUi.current = now
      setTime(t)
    }
  }, [])

  const { engine, media, timing, error: audioError, playing, virtualT, seek, toggle, snapshot, debug } = useMixAudio(decks, {
    ...mixer, style, rate, placement, length, onFrame,
  })

  useLayoutEffect(() => {
    if (!decks || initialized.current) return
    initialized.current = true
    modal.current?.focus({ preventScroll: true })
    seek(decks.A.db[Math.max(0, mixBar - 8)])
  }, [decks, mixBar, seek])

  const setPlacementPatch = useCallback((patch: Partial<Placement>) => {
    setPlacement((p) => {
      const mixBar = patch.mixBar ?? p.mixBar
      const startBar = patch.startBar ?? p.startBar
      const nudge = patch.nudge ?? p.nudge
      return mixBar === p.mixBar && startBar === p.startBar && nudge === p.nudge ? p : { mixBar, startBar, nudge }
    })
  }, [])

  const stepEntry = useCallback((bars: number) => {
    if (!decks) return
    setPlacement((p) => {
      const mixBar = clamp(p.mixBar + bars, 0, decks.A.db.length - 1)
      return mixBar === p.mixBar ? p : { ...p, mixBar }
    })
  }, [decks])

  const stepCue = (bars: number) => {
    if (!decks) return
    setPlacement((p) => {
      const startBar = clamp(p.startBar + bars, 0, decks.B.db.length - 1)
      return startBar === p.startBar ? p : { ...p, startBar }
    })
  }

  const stepPhase = useCallback((direction: number, beat: boolean, fine: boolean) => {
    if (!decks) return
    const { A } = decks
    setPlacement((p) => {
      const size = beat ? beatAt(A, p.mixBar) : fine ? 0.001 : 0.01
      const nudge = clamp(p.nudge + direction * size, -4 * A.bar, 4 * A.bar)
      return { ...p, nudge: Math.abs(nudge) < 1e-9 ? 0 : nudge }
    })
  }, [decks])

  const seekVisible = useCallback((t: number) => {
    const to = clamp(t, 0, timing?.end ?? 0)
    timeline.current?.reveal(to)
    seek(to)
  }, [seek, timing?.end])

  useEffect(() => {
    const w = window as Window & { __mix?: unknown }
    w.__mix = {
      state: () => {
        const { x, A: eqA, B: eqB, law } = snapshot()
        return {
          ...debug(), ...timing, ...placement, rate, fadeBars: length, style, auto: mixer.auto,
          durB: media.B.duration ?? decks?.B.dur, phaseMs: decks && timing ? Math.round(phaseOffset(decks.A, timing.cueT) * 1000) : 0,
          x, eqA, eqB, law, ...timeline.current?.state(),
          peaksA: !!media.A.peaks, peaksB: !!media.B.peaks,
        }
      },
      audio: engine,
    }
    return () => { delete w.__mix }
  }, [debug, timing, placement, rate, length, style, mixer.auto, decks, snapshot, media, engine])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (help) setHelp(false)
        else closeMix()
        return
      }
      if (e.metaKey || e.ctrlKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && target?.closest('[role="spinbutton"], [role="slider"]')) return
      if (e.code === 'Space') {
        if (target?.closest('button')) return
        toggle()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (decks) seekVisible(virtualT() + (e.key === 'ArrowLeft' ? -4 : 4) * decks.A.bar)
      } else if (e.key === ',' || e.key === '.') stepEntry(e.key === ',' ? -1 : 1)
      else if (e.key === '[' || e.key === ']') stepPhase(e.key === '[' ? -1 : 1, false, false)
      else if (e.key === '-' || e.key === '=' || e.key === '+') timeline.current?.zoomBy(e.key === '-' ? 1.5 : 1 / 1.5)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [closeMix, decks, help, seekVisible, stepEntry, stepPhase, toggle, virtualT])

  const editManual = (update: (m: ManualMix) => ManualMix) => {
    const current = snapshot()
    setMixer((m) => {
      const manual = update(m.auto ? current : m.manual)
      return m.auto || manual !== m.manual ? { auto: false, manual } : m
    })
    return current
  }

  if (!decks || !timing) return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && closeMix()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Probar mezcla">
        <h2>Probar mezcla</h2>
        <p className="muted">{error ?? 'Cargando los dos temas…'}</p>
        {error && <button className="btn" onClick={closeMix}>Cerrar</button>}
      </div>
    </div>
  )

  const { A, B } = decks
  const { mixT, cueT, durA } = timing
  const online = A.t.online && B.t.online
  const canPlay = online && media.A.duration !== null && media.B.duration !== null
  const kr = keyRelation(A.t.key, B.t.key)
  const phaseMs = Math.round(nudge * 1000)
  const relativePhase = Math.round(phaseOffset(A, cueT) * 1000)
  const phaseLimit = Math.round(4 * A.bar * 1000)
  const barNow = barAt(A.db, time)
  const count = time < mixT ? Math.max(1, mixBar - barNow) : A.db.length - barNow
  const countDown = `${count} ${count === 1 ? 'compás' : 'compases'}`
  const status = !online ? 'Audio sin conexión'
    : audioError ?? (!canPlay ? 'Preparando audio…'
      : time < mixT ? `B entra en ${countDown}` : time < durA ? `A termina en ${countDown}` : time < timing.end ? 'Solo B' : 'Fin de la mezcla')
  const intro = clamp(B.t.intro_bars ?? 0, 0, B.db.length - 1)
  const live = snapshot(time)
  const save = async (kind: 'mix' | 'mashup' | 'avoid') => {
    const millis = Math.round(nudge * 10000) / 10
    const phase = Math.abs(nudge) > 1e-9 ? `, fase de B ${signed(millis || Math.sign(nudge) * 0.1).replace('.', ',')} ms` : ''
    const note = kind === 'avoid' ? undefined
      : `B entra ${A.db.length - mixBar} compases antes del final de A${startBar ? `, desde su compás ${startBar + 1}` : ''}${phase}`
    try {
      await api.relate(a, b, kind, note)
      bump()
      toast({ mix: 'Guardé el punto de mezcla', mashup: 'Guardado como mashup', avoid: 'Guardado. No voy a sugerir esta mezcla.' }[kind])
    } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && closeMix()}>
      <div className="modal mixlab" ref={modal} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="mx-title"
        onPointerDown={(e) => { if (help && !(e.target as Element).closest('.mx-help')) setHelp(false) }}>
        <div className="mx-header">
          <h2 id="mx-title">Probar mezcla</h2>
          <div className="mx-header-controls">
            <button className="btn ghost sm icon" aria-label="Invertir A y B" title="Invertir A y B" onClick={() => openMix(b, a)}><IconSwap size={16} /></button>
            {/* slot: Cambiar B */}
            <MixHelp open={help} toggle={() => setHelp((v) => !v)} />
            <button className="btn ghost sm icon" onClick={closeMix} aria-label="Cerrar" title="Cerrar (Esc)"><IconX size={16} /></button>
          </div>
        </div>

        <div className="mx-decks">
          <DeckCard deck={A} side="A" />
          <div className={`mx-tone ${kr.tone}`}>
            <span>Armonía</span>
            <b>{kr.text.charAt(0).toUpperCase() + kr.text.slice(1)}</b>
          </div>
          <DeckCard deck={B} side="B" pitch={(rate - 1) * 100} />
        </div>

        <Timeline ref={timeline} A={A} B={B} timing={timing} placement={placement} rate={rate} style={style}
          peaksA={media.A.peaks} peaksB={media.B.peaks} onSeek={seek} onPlacement={setPlacementPatch} />

        <div className="mx-transport">
          <button className="playbtn" disabled={!canPlay} onClick={toggle} aria-label={playing ? 'Pausar mezcla' : 'Reproducir mezcla'}>
            <GlyphSwap on={playing} a={<IconPlay size={16} />} b={<IconPause size={16} />} />
          </button>
          <button className="btn sm" onClick={() => seekVisible(A.db[Math.max(0, mixBar - 8)])}>Ir 8 compases antes</button>
          <span className={`mx-status ellipsis${audioError ? ' error' : ''}`} title={status}>{status}</span>
          <div className="mx-transport-end">
            {(A.g.approx || B.g.approx) && <span className="mx-grid-source" title={`Batea calculó la grilla de ${A.g.approx && B.g.approx ? 'A y B' : A.g.approx ? 'A' : 'B'}`}>Grilla estimada</span>}
            <span className="mx-phase num" title="Fase de B en la entrada respecto al beat más cercano de A">B {signed(relativePhase)} ms</span>
          </div>
        </div>

        <div className="mx-mixer">
          <section className="mx-module A" aria-label="Controles de A">
            <div className="mx-module-head"><h3>EQ de A</h3></div>
            <DeckEQ side="A" eq={live.A} onTouch={() => editManual((m) => m).A}
              onChange={(_, band, db) => editManual((m) => updateBand(m, 'A', band, db))} />
            <div className="mx-steppers">
              <Stepper label="Entra B" value={A.db.length - mixBar} display={String(A.db.length - mixBar)}
                min={1} max={A.db.length} unit="compases antes del final de A" resetTitle="Restablecer entrada de B"
                onStep={(dir, e) => stepEntry(-dir * (e.shiftKey ? 8 : 1))}
                onReset={() => setPlacementPatch({ mixBar: defaultEntry(A) })} />
            </div>
          </section>

          <CenterMixer value={live.x} auto={mixer.auto} style={style} length={length} setStyle={setStyle} setLength={setLength}
            setAuto={(auto) => auto ? setMixer((m) => ({ ...m, auto })) : editManual((m) => m)}
            onTouch={() => editManual((m) => m).x}
            onChange={(x) => editManual((m) => m.x === x ? m : { ...m, x })} />

          <section className="mx-module B" aria-label="Controles de B">
            <div className="mx-module-head"><h3>EQ de B</h3></div>
            <DeckEQ side="B" eq={live.B} onTouch={() => editManual((m) => m).B}
              onChange={(_, band, db) => editManual((m) => updateBand(m, 'B', band, db))} />
            <div className="mx-steppers two">
              <Stepper label="B arranca en" value={startBar + 1} display={String(startBar + 1)}
                min={1} max={B.db.length} unit="compás" unitFirst resetTitle="Restablecer cue de B"
                onStep={(dir, e) => stepCue(dir * (e.shiftKey ? 8 : 1))} onReset={() => setPlacementPatch({ startBar: 0 })}
                quick={intro > 0 ? { label: 'Saltear la intro', run: () => setPlacementPatch({ startBar: intro }) } : undefined} />
              <Stepper label="Fase de B" value={phaseMs} display={signed(phaseMs)}
                min={-phaseLimit} max={phaseLimit} unit="ms" resetTitle="Restablecer fase de B"
                onStep={(dir, e) => stepPhase(dir, e.shiftKey, e.altKey)} onReset={() => setPlacementPatch({ nudge: 0 })} />
            </div>
          </section>
        </div>

        <div className="mx-verdict">
          <span className="muted">Guardar relación</span>
          <button className="btn" onClick={() => void save('avoid')}><IconThumbDown size={14} /> No van</button>
          <button className="btn" onClick={() => void save('mashup')}>Funciona como mashup</button>
          <button className="btn primary" onClick={() => void save('mix')}><IconThumbUp size={14} /> Mezclan bien</button>
        </div>
      </div>
    </div>
  )
}

function updateBand(mix: ManualMix, side: Side, band: number, db: number): ManualMix {
  if (mix[side][band] === db) return mix
  const eq: [number, number, number] = [...mix[side]]
  eq[band] = db
  return { ...mix, [side]: eq }
}
