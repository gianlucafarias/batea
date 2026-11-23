import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type CueDto } from '../api'
import { GlyphSwap } from '../lib/fluidHover'
import { useApp } from '../store'
import { cleanTitle, fmtBpm, parseKey } from '../util'
import { KeyBadge, Sleeve } from './bits'
import { formatKey, useKeyNotation } from '../lib/keyNotation'
import { IconMix, IconPause, IconPlay, IconSwap, IconThumbDown, IconThumbUp, IconX } from './icons'
import { MixPicker } from './MixPicker'
import { bandLane, groupOf, parseSaved, preset, scale, upsert, type Automation, type Held, type LaneGroup, type LaneId, type Point, type SavedMix } from './mixlab/automation'
import { CenterMixer, DeckEQ, MixHelp, Stepper, type TransitionLength } from './mixlab/Controls'
import { Timeline, type TimelineHandle } from './mixlab/Timeline'
import { barAt, beatAt, clamp, defaultEntry, FLAT_TUNE, KEY_LIMIT, keyMatch, makeDeck, phaseOffset, playbackRate, shiftKey, signed, TEMPO_LIMIT, type Deck, type DeckTune, type Placement, type Side, type Transition } from './mixlab/model'
import { DEFAULT_MANUAL, useMixAudio, type DeckSound, type ManualMix } from './mixlab/useMixAudio'

function keyRelation(a: string | null, b: string | null, detune = 0): { text: string; tone: 'ok' | 'mid' | 'bad' | 'none' } {
  const pa = parseKey(a), pb = parseKey(b)
  if (!pa || !pb) return { text: 'falta el tono de alguno', tone: 'none' }
  // sin master tempo la velocidad corre el tono una fracción de semitono: entre los dos quedan desafinados
  if (Math.abs(detune) >= 0.3) return { text: `desafinados ${Math.abs(detune).toFixed(1).replace('.', ',')} semitono`, tone: 'bad' }
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

const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')}`
const semi = (v: number) => {
  const r = Math.round(v * 10) / 10
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Number.isInteger(r) ? Math.abs(r) : Math.abs(r).toFixed(1).replace('.', ',')}`
}

function DeckCard({ deck: d, side, tempo, semis, keylock }: { deck: Deck; side: Side; tempo: number; semis: number; keylock: boolean }) {
  const speed = 1 + tempo / 100
  const key = shiftKey(d.t.key, semis)
  const shifted = Math.abs(semis) >= 0.05
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
          <span className="num" title={Math.abs(tempo) >= 0.05 ? `Original: ${fmtBpm(d.g.bpm)} BPM` : undefined}>{fmtBpm(d.g.bpm ? d.g.bpm * speed : d.g.bpm)} BPM</span>
          <span title={shifted ? `Original: ${formatKey(d.t.key, useKeyNotation.getState().notation) || '–'}` : undefined}><KeyBadge k={key} est={!!d.t.key_est} /></span>
          {Math.abs(tempo) >= 0.05 && <span className={`num mx-pitch${Math.abs(tempo) > 6 ? ' large' : ''}`}
            title={keylock ? 'Velocidad cambiada, tono intacto (master tempo)' : 'Velocidad y tono cambian juntos, como un vinilo'}>{pct(tempo)}%</span>}
          {shifted && <span className="num mx-pitch" title="Corrimiento de tono">{semi(semis)} st</span>}
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
  const [automation, setAutomation] = useState<Automation>(() => preset('bass', 16))
  const [custom, setCustom] = useState(false)
  const [group, setGroup] = useState<LaneGroup>('x')
  const [held, setHeld] = useState<Held>({})
  const [help, setHelp] = useState(false)
  const [savedMix, setSavedMix] = useState<SavedMix | null>(null)
  const [cuesA, setCuesA] = useState<CueDto[]>([])
  const [cuesB, setCuesB] = useState<CueDto[]>([])
  const [showCues, setShowCues] = useState(() => { try { return localStorage.getItem('batea.mixlab.cues') !== '0' } catch { return true } })
  const toggleCues = (v: boolean) => { setShowCues(v); try { localStorage.setItem('batea.mixlab.cues', v ? '1' : '0') } catch { /* sin storage */ } }
  const [pickB, setPickB] = useState(false)
  const [tune, setTune] = useState<DeckTune>(FLAT_TUNE)
  const [keylock, setKeylock] = useState(() => { try { return localStorage.getItem('batea.mixlab.keylock') !== '0' } catch { return true } })
  const toggleKeylock = (v: boolean) => { setKeylock(v); try { localStorage.setItem('batea.mixlab.keylock', v ? '1' : '0') } catch { /* sin storage */ } }
  const [time, setTime] = useState(0)
  const timeline = useRef<TimelineHandle>(null)
  const modal = useRef<HTMLDivElement>(null)
  const lastUi = useRef(0)
  const initialized = useRef(false)
  const { mixBar, startBar, nudge } = placement

  useEffect(() => {
    let alive = true
    Promise.all([api.track(a), api.track(b), api.grid(a), api.grid(b),
      api.waveform(a, 2400).catch(() => null), api.waveform(b, 2400).catch(() => null),
      api.mixSettings(a, b).then((r) => parseSaved(r.saved)).catch(() => null),
      api.cues(a).then((r) => r.cues).catch(() => [] as CueDto[]), api.cues(b).then((r) => r.cues).catch(() => [] as CueDto[])])
      .then(([ta, tb, ga, gb, wa, wb, saved, ca, cb]) => {
        if (!alive) return
        setCuesA(ca); setCuesB(cb)
        const A = makeDeck(ta, ga, wa), B = makeDeck(tb, gb, wb)
        if (saved) {
          // la mezcla que dejaste armada: mismas posiciones y curvas (acotadas por si la grilla cambió)
          setPlacement({
            mixBar: clamp(Math.round(saved.mixBar), 0, A.db.length - 1),
            startBar: clamp(Math.round(saved.startBar), 0, B.db.length - 1),
            nudge: clamp(saved.nudge, -4 * A.bar, 4 * A.bar),
          })
          setStyle(saved.style)
          setLength(([8, 16, 32, 64].includes(saved.length) ? saved.length : 16) as TransitionLength)
          setAutomation(saved.automation)
          setCustom(saved.custom)
          if (saved.tune) setTune({
            tempoA: clamp(saved.tune.tempoA, -TEMPO_LIMIT.A, TEMPO_LIMIT.A), tempoB: clamp(saved.tune.tempoB, -TEMPO_LIMIT.B, TEMPO_LIMIT.B),
            keyA: clamp(Math.round(saved.tune.keyA), -KEY_LIMIT, KEY_LIMIT), keyB: clamp(Math.round(saved.tune.keyB), -KEY_LIMIT, KEY_LIMIT), sync: saved.tune.sync,
          })
          setSavedMix(saved)
        } else setPlacement({ ...INITIAL_PLACEMENT, mixBar: defaultEntry(A) })
        setDecks({ A, B })
      })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [a, b])

  const syncRatio = useMemo(() => decks ? playbackRate(decks.A, decks.B) : 1, [decks])
  // velocidad real de cada deck; `rate` es cuánto avanza B por segundo de A (lo que usa la grilla)
  const speedA = 1 + tune.tempoA / 100
  const speedB = tune.sync ? speedA * syncRatio : 1 + tune.tempoB / 100
  const rate = speedB / speedA
  const tempoB = (speedB - 1) * 100
  const semisA = tune.keyA + (keylock ? 0 : 12 * Math.log2(speedA))
  const semisB = tune.keyB + (keylock ? 0 : 12 * Math.log2(speedB))
  const sound = useMemo<Record<Side, DeckSound>>(() => ({
    A: { speed: speedA, pitch: 2 ** (semisA / 12) },
    B: { speed: speedB, pitch: 2 ** (semisB / 12) },
  }), [speedA, speedB, semisA, semisB])
  const onFrame = useCallback((t: number, playing: boolean) => {
    timeline.current?.playhead(t, playing)
    const now = performance.now()
    if (!playing || now - lastUi.current >= 60) {
      lastUi.current = now
      setTime(t)
    }
  }, [])

  const { engine, media, timing, error: audioError, playing, primed, adjusting, virtualT, seek: seekEngine, toggle, snapshot, debug } = useMixAudio(decks, {
    ...mixer, style, rate, sound, placement, length, onFrame, automation, held, bar: decks?.A.bar ?? 2,
  })

  const round1 = (v: number) => Math.round(v * 10) / 10
  const stepTempo = (side: Side, dir: number, big: boolean) => setTune((t) => {
    const step = dir * (big ? 1 : 0.1)
    if (side === 'A') return { ...t, tempoA: round1(clamp(t.tempoA + step, -TEMPO_LIMIT.A, TEMPO_LIMIT.A)) }
    // mover el tempo de B lo suelta de A (como el pitch de un CDJ con sync)
    return { ...t, sync: false, tempoB: round1(clamp((t.sync ? tempoB : t.tempoB) + step, -TEMPO_LIMIT.B, TEMPO_LIMIT.B)) }
  })
  const stepKey = (side: Side, dir: number) => setTune((t) => {
    const k = side === 'A' ? 'keyA' : 'keyB'
    return { ...t, [k]: clamp(t[k] + dir, -KEY_LIMIT, KEY_LIMIT) }
  })
  const setSync = (on: boolean) => setTune((t) => on ? { ...t, sync: true } : { ...t, sync: false, tempoB: round1(tempoB) })
  // al pausar o saltar, los controles agarrados a mano vuelven a seguir su curva
  useEffect(() => { if (!playing) setHeld((h) => Object.keys(h).length ? {} : h) }, [playing])
  const seek = useCallback((t: number) => {
    setHeld((h) => Object.keys(h).length ? {} : h)
    seekEngine(t)
  }, [seekEngine])

  const chooseStyle = (next: Transition) => {
    setStyle(next)
    setAutomation(preset(next, length))
    setCustom(false)
  }
  const chooseLength = (next: TransitionLength) => {
    setAutomation((a) => custom ? scale(a, next / length) : preset(style, next))
    setLength(next)
  }
  const editCurve = useCallback((lane: LaneId, points: Point[]) => {
    setAutomation((a) => a[lane] === points ? a : { ...a, [lane]: points })
    setCustom(true)
  }, [])

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
          ...debug(), ...timing, ...placement, rate, sound, tune, keylock, adjusting, fadeBars: length, style, auto: mixer.auto,
          durB: media.B.duration ?? decks?.B.dur, phaseMs: decks && timing ? Math.round(phaseOffset(decks.A, timing.cueT) * 1000) : 0,
          x, eqA, eqB, law, ...timeline.current?.state(),
          peaksA: !!media.A.peaks, peaksB: !!media.B.peaks,
        }
      },
      audio: engine,
    }
    return () => { delete w.__mix }
  }, [debug, timing, placement, rate, sound, tune, keylock, adjusting, length, style, mixer.auto, decks, snapshot, media, engine])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (pickB) {                                  // el selector de B maneja su teclado; Esc solo lo cierra a él
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPickB(false) }
        return
      }
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
  }, [closeMix, decks, help, pickB, seekVisible, stepEntry, stepPhase, toggle, virtualT])

  /** Mover una perilla o el crossfader en automática: sonando, toma el control hasta pausar; en pausa, deja un punto en la curva donde está el cabezal. */
  const editLane = (lane: LaneId, v: number) => {
    if (!mixer.auto) {
      editManual((m) => lane === 'x' ? (m.x === v ? m : { ...m, x: v }) : updateBand(m, lane[0] as Side, Number(lane[1]), v))
      return
    }
    if (playing) { setHeld((h) => h[lane] === v ? h : { ...h, [lane]: v }); return }
    if (!decks || !timing) return
    const at = Math.round((virtualT() - timing.mixT) / decks.A.bar * 4) / 4
    setAutomation((a) => {
      const { points } = upsert(a[lane], at, v)
      return points === a[lane] ? a : { ...a, [lane]: points }
    })
    setCustom(true)
    setGroup(groupOf(lane))
  }

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
  const canPlay = online && media.A.duration !== null && media.B.duration !== null && primed
  const keyA = shiftKey(A.t.key, semisA), keyB = shiftKey(B.t.key, semisB)
  const fraction = (v: number) => v - Math.round(v)
  const kr = keyRelation(keyA, keyB, fraction(semisB - semisA))
  const matchB = kr.tone === 'none' ? null : keyMatch(keyB, keyA, tune.keyB)
  const adjustText = adjusting.length ? `Ajustando ${adjusting.join(' y ')}${keylock ? ' sin cambiar el tono' : ''}…` : null
  const phaseMs = Math.round(nudge * 1000)
  const relativePhase = Math.round(phaseOffset(A, cueT) * 1000)
  const phaseLimit = Math.round(4 * A.bar * 1000)
  const barNow = barAt(A.db, time)
  const count = time < mixT ? Math.max(1, mixBar - barNow) : A.db.length - barNow
  const countDown = `${count} ${count === 1 ? 'compás' : 'compases'}`
  const status = !online ? 'Audio sin conexión'
    : audioError ?? (!canPlay ? (adjustText ?? 'Preparando audio…') : adjustText
      ?? (time < mixT ? `B entra en ${countDown}` : time < durA ? `A termina en ${countDown}` : time < timing.end ? 'Solo B' : 'Fin de la mezcla'))
  const intro = clamp(B.t.intro_bars ?? 0, 0, B.db.length - 1)
  const live = snapshot(time)
  const save = async (kind: 'mix' | 'mashup' | 'avoid') => {
    const millis = Math.round(nudge * 10000) / 10
    const phase = Math.abs(nudge) > 1e-9 ? `, fase de B ${signed(millis || Math.sign(nudge) * 0.1).replace('.', ',')} ms` : ''
    const note = kind === 'avoid' ? undefined
      : `B entra ${A.db.length - mixBar} compases antes del final de A${startBar ? `, desde su compás ${startBar + 1}` : ''}${phase}`
    try {
      await api.relate(a, b, kind, note)
      if (kind !== 'avoid') {
        // también la mezcla en sí, para encontrarla armada al volver a abrirla
        const mixState: SavedMix = { v: 1, mixBar, startBar, nudge, style, length, custom, automation, tune }
        await api.saveMixSettings(a, b, mixState as unknown as Record<string, unknown>)
        setSavedMix(mixState)
      }
      bump()
      toast({ mix: 'Guardé la mezcla', mashup: 'Guardada como mashup, con la mezcla', avoid: 'Guardado. No voy a sugerir esta mezcla.' }[kind])
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
            <button className="btn ghost sm" title="Probar A con otro tema" onClick={() => setPickB(true)}><IconMix size={14} /> Cambiar B</button>
            <MixHelp open={help} toggle={() => setHelp((v) => !v)} />
            <button className="btn ghost sm icon" onClick={closeMix} aria-label="Cerrar" title="Cerrar (Esc)"><IconX size={16} /></button>
          </div>
        </div>

        <div className="mx-decks">
          <DeckCard deck={A} side="A" tempo={tune.tempoA} semis={semisA} keylock={keylock} />
          <div className={`mx-tone ${kr.tone}`}>
            <span>Armonía</span>
            <b>{kr.text.charAt(0).toUpperCase() + kr.text.slice(1)}</b>
          </div>
          <DeckCard deck={B} side="B" tempo={tempoB} semis={semisB} keylock={keylock} />
        </div>

        <Timeline ref={timeline} A={A} B={B} timing={timing} placement={placement} rate={rate} style={style}
          automation={automation} group={group} setGroup={setGroup} onAutomation={editCurve}
          peaksA={media.A.peaks} peaksB={media.B.peaks} cuesA={cuesA} cuesB={cuesB} showCues={showCues} onSeek={seek} onPlacement={setPlacementPatch} />

        <div className="mx-transport">
          <button className="playbtn" disabled={!canPlay} onClick={toggle} aria-label={playing ? 'Pausar mezcla' : 'Reproducir mezcla'}>
            <GlyphSwap on={playing} a={<IconPlay size={16} />} b={<IconPause size={16} />} />
          </button>
          <button className="btn sm" onClick={() => seekVisible(A.db[Math.max(0, mixBar - 8)])}>Ir 8 compases antes</button>
          {(cuesA.length > 0 || cuesB.length > 0) && (
            <label className="ce-check" title="Muestra las hot cues, memory cues y loops de A y de B en la línea de tiempo">
              <input type="checkbox" checked={showCues} onChange={(e) => toggleCues(e.target.checked)} /> Mostrar cues
            </label>
          )}
          <label className="ce-check" title="B sigue el tempo de A: el tempo de A acelera o frena toda la mezcla">
            <input type="checkbox" checked={tune.sync} onChange={(e) => setSync(e.target.checked)} /> Sync
          </label>
          <label className="ce-check" title="Cambia la velocidad sin cambiar el tono. Apagado, el tono sube y baja con la velocidad, como un vinilo.">
            <input type="checkbox" checked={keylock} onChange={(e) => toggleKeylock(e.target.checked)} /> Master tempo
          </label>
          <span className={`mx-status ellipsis${audioError ? ' error' : ''}`} title={status}>{status}</span>
          <div className="mx-transport-end">
            {(A.g.approx || B.g.approx) && <span className="mx-grid-source" title={`Batea calculó la grilla de ${A.g.approx && B.g.approx ? 'A y B' : A.g.approx ? 'A' : 'B'}`}>Grilla estimada</span>}
            <span className="mx-phase num" title="Fase de B en la entrada respecto al beat más cercano de A">B {signed(relativePhase)} ms</span>
          </div>
        </div>

        <div className="mx-mixer">
          <section className="mx-module A" aria-label="Controles de A">
            <div className="mx-module-head"><h3>EQ de A</h3></div>
            <DeckEQ side="A" eq={live.A} held={[held.A0 !== undefined, held.A1 !== undefined, held.A2 !== undefined]}
              onTouch={() => live.A} onChange={(_, band, db) => editLane(bandLane('A', band), db)} />
            <div className="mx-steppers">
              <Stepper label="Entra B" value={A.db.length - mixBar} display={String(A.db.length - mixBar)}
                min={1} max={A.db.length} unit="compases antes del final de A" resetTitle="Restablecer entrada de B"
                onStep={(dir, e) => stepEntry(-dir * (e.shiftKey ? 8 : 1))}
                onReset={() => setPlacementPatch({ mixBar: defaultEntry(A) })} />
            </div>
            <div className="mx-steppers two">
              <Stepper label={tune.sync ? 'Tempo de la mezcla' : 'Tempo de A'} value={tune.tempoA} display={pct(tune.tempoA)}
                min={-TEMPO_LIMIT.A} max={TEMPO_LIMIT.A} unit="%" resetTitle="Tempo original de A"
                onStep={(dir, e) => stepTempo('A', dir, e.shiftKey)} onReset={() => setTune((t) => ({ ...t, tempoA: 0 }))} />
              <Stepper label="Tono de A" value={tune.keyA} display={semi(tune.keyA)}
                min={-KEY_LIMIT} max={KEY_LIMIT} unit="st" resetTitle="Tono original de A"
                onStep={(dir) => stepKey('A', dir)} onReset={() => setTune((t) => ({ ...t, keyA: 0 }))} />
            </div>
          </section>

          <CenterMixer value={live.x} auto={mixer.auto} held={held.x !== undefined} custom={custom} style={style} length={length}
            setStyle={chooseStyle} setLength={chooseLength}
            setAuto={(auto) => auto ? setMixer((m) => ({ ...m, auto })) : editManual((m) => m)}
            onTouch={() => live.x}
            onChange={(x) => editLane('x', x)} />

          <section className="mx-module B" aria-label="Controles de B">
            <div className="mx-module-head"><h3>EQ de B</h3></div>
            <DeckEQ side="B" eq={live.B} held={[held.B0 !== undefined, held.B1 !== undefined, held.B2 !== undefined]}
              onTouch={() => live.B} onChange={(_, band, db) => editLane(bandLane('B', band), db)} />
            <div className="mx-steppers two">
              <Stepper label="B arranca en" value={startBar + 1} display={String(startBar + 1)}
                min={1} max={B.db.length} unit="compás" unitFirst resetTitle="Restablecer cue de B"
                onStep={(dir, e) => stepCue(dir * (e.shiftKey ? 8 : 1))} onReset={() => setPlacementPatch({ startBar: 0 })}
                quick={intro > 0 ? { label: 'Saltear la intro', run: () => setPlacementPatch({ startBar: intro }) } : undefined} />
              <Stepper label="Fase de B" value={phaseMs} display={signed(phaseMs)}
                min={-phaseLimit} max={phaseLimit} unit="ms" resetTitle="Restablecer fase de B"
                onStep={(dir, e) => stepPhase(dir, e.shiftKey, e.altKey)} onReset={() => setPlacementPatch({ nudge: 0 })} />
            </div>
            <div className="mx-steppers two">
              <Stepper label={tune.sync ? 'Tempo de B · sync' : 'Tempo de B'} value={round1(tempoB)} display={pct(tempoB)}
                min={-TEMPO_LIMIT.B} max={TEMPO_LIMIT.B} unit="%" resetTitle="Volver a sync con A"
                onStep={(dir, e) => stepTempo('B', dir, e.shiftKey)} onReset={() => setSync(true)} />
              <Stepper label="Tono de B" value={tune.keyB} display={semi(tune.keyB)}
                min={-KEY_LIMIT} max={KEY_LIMIT} unit="st" resetTitle="Tono original de B"
                onStep={(dir) => stepKey('B', dir)} onReset={() => setTune((t) => ({ ...t, keyB: 0 }))}
                quick={matchB ? { label: `Llevar a ${formatKey(shiftKey(keyB, matchB), useKeyNotation.getState().notation)} (${semi(matchB)} st)`, run: () => setTune((t) => ({ ...t, keyB: clamp(t.keyB + matchB, -KEY_LIMIT, KEY_LIMIT) })) } : undefined} />
            </div>
          </section>
        </div>

        <div className="mx-verdict">
          <span className="muted">{savedMix ? 'Mezcla guardada' : 'Guardar relación'}</span>
          <button className="btn" onClick={() => void save('avoid')}><IconThumbDown size={14} /> No van</button>
          <button className="btn" onClick={() => void save('mashup')}>Funciona como mashup</button>
          <button className="btn primary" onClick={() => void save('mix')}><IconThumbUp size={14} /> Mezclan bien</button>
        </div>
      </div>
      {pickB && <MixPicker a={a} exclude={[b]} onClose={() => setPickB(false)} onPick={(nb) => openMix(a, nb)} />}
    </div>
  )
}

function updateBand(mix: ManualMix, side: Side, band: number, db: number): ManualMix {
  if (mix[side][band] === db) return mix
  const eq: [number, number, number] = [...mix[side]]
  eq[band] = db
  return { ...mix, [side]: eq }
}
