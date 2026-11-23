import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { Seg } from '../../lib/Seg'
import { IconMinus, IconPlus, IconSync } from '../icons'
import { clamp, KILL, signed, type Side, type Transition } from './model'
import type { EQ } from './useMixAudio'

interface Modifiers { altKey: boolean; shiftKey: boolean }
interface StepperProps {
  label: string
  value: number
  min: number
  max: number
  display: string
  unit: string
  unitFirst?: boolean
  resetTitle: string
  onStep: (direction: number, keys: Modifiers) => void
  onReset: () => void
  quick?: { label: string; run: () => void }
}

export function Stepper(props: StepperProps) {
  const { label, value, min, max, display, unit, unitFirst, resetTitle, onStep, onReset, quick } = props
  const box = useRef<HTMLDivElement>(null)
  const step = useRef(onStep)
  step.current = onStep
  useEffect(() => {
    const el = box.current
    if (!el) return
    let delta = 0, last = 0
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || !e.deltaY) return
      e.preventDefault()
      if (e.timeStamp - last > 130 || Math.sign(e.deltaY) !== Math.sign(delta)) delta = 0
      last = e.timeStamp
      delta += e.deltaY * (e.deltaMode === 0 ? 1 : 32)
      if (Math.abs(delta) < 24) return
      step.current(-Math.sign(delta), e)
      delta = 0
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    e.stopPropagation()
    onStep(e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1, e)
  }

  return (
    <div className="mx-stepper" ref={box}>
      <div className="mx-stepper-head">
        <span>{label}</span>
        <button className="mx-reset" aria-label={resetTitle} title={resetTitle} onClick={onReset}><IconSync size={12} /></button>
      </div>
      <div className="mx-stepper-body">
        <button aria-label={`Bajar: ${label}`} disabled={value <= min} onClick={(e) => onStep(-1, e)}><IconMinus size={14} /></button>
        <div className="mx-stepper-value" tabIndex={0} role="spinbutton" aria-label={label} aria-valuenow={value}
          aria-valuemin={min} aria-valuemax={max} aria-valuetext={unitFirst ? `${unit} ${display}` : `${display} ${unit}`} onKeyDown={key}>
          {unitFirst && <span>{unit}</span>}
          <b className="num">{display}</b>
          {!unitFirst && <span>{unit}</span>}
        </div>
        <button aria-label={`Subir: ${label}`} disabled={value >= max} onClick={(e) => onStep(1, e)}><IconPlus size={14} /></button>
      </div>
      {quick && <button className="mx-stepper-quick" onClick={quick.run}>{quick.label}</button>}
    </div>
  )
}

const bandLabels = ['Graves', 'Medios', 'Agudos'] as const
const bandFrequencies = ['120 Hz', '1 kHz', '4 kHz']
const dbText = (db: number) => db === KILL ? 'Kill' : `${signed(Math.round(db))} dB`

function Knob({ db, band, side, held, touch, change }: {
  db: number; band: number; side: Side; held?: boolean; touch: () => number; change: (db: number) => void
}) {
  const drag = useRef<{ pointer: number; y: number; db: number } | null>(null)
  const beforeKill = useRef(0)
  const update = (next: number) => change(clamp(next, KILL, 6))
  const release = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== e.pointerId) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight': update(db + 1); break
      case 'ArrowDown':
      case 'ArrowLeft': update(db - 1); break
      case 'Home': update(KILL); break
      case 'End': update(6); break
      case 'Enter': update(0); break
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  const angle = db < 0 ? db / -KILL * 124 : db / 6 * 124
  const label = `${bandLabels[band]} de ${side}`
  return (
    <div className="mx-eq-band">
      <span className="mx-eq-label">{bandLabels[band]}</span>
      <div className={`mx-knob${db === KILL ? ' is-killed' : ''}${held ? ' is-held' : ''}`} title={`${label} · ${bandFrequencies[band]}${held ? ' · a mano hasta que pauses' : ''}`}
        tabIndex={0} role="slider" aria-label={label} aria-valuemin={KILL} aria-valuemax={6}
        aria-orientation="vertical" aria-valuenow={db} aria-valuetext={dbText(db)} style={{ '--angle': `${angle}deg` } as CSSProperties}
        onPointerDown={(e) => {
          if (e.button !== 0 || drag.current) return
          const initial = touch()
          drag.current = { pointer: e.pointerId, y: e.clientY, db: initial }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.pointer !== e.pointerId) return
          const dy = d.y - e.clientY
          if (Math.abs(dy) >= 2 || db !== d.db) update(d.db + Math.round(dy / 2))
        }}
        onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
        onDoubleClick={() => update(0)} onKeyDown={key}>
        <span className="mx-knob-dial" aria-hidden />
      </div>
      <div className="mx-band-value">
        <span className="num">{signed(Math.round(db))} dB</span>
        <button aria-label={`Kill: ${label}`} title={`Kill: ${label}`} aria-pressed={db === KILL}
          onClick={() => {
            if (db !== KILL) beforeKill.current = db
            update(db === KILL ? beforeKill.current : KILL)
          }}>Kill</button>
      </div>
    </div>
  )
}

export function DeckEQ({ side, eq, held, onTouch, onChange }: {
  side: Side; eq: EQ; held?: readonly boolean[]; onTouch: () => EQ; onChange: (side: Side, band: number, db: number) => void
}) {
  return (
    <div className="mx-eq">
      {eq.map((db, band) => <Knob key={band} side={side} band={band} db={db} held={held?.[band]}
        touch={() => onTouch()[band]} change={(v) => onChange(side, band, v)} />)}
    </div>
  )
}

interface FaderProps { value: number; auto: boolean; held?: boolean; onTouch: () => number; onChange: (v: number) => void }

function Crossfader({ value, auto, held, onTouch, onChange }: FaderProps) {
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; left: number; width: number; offset: number } | null>(null)
  const getValue = (ratio: number, width: number) => Math.abs(ratio - 0.5) * width <= 6 ? 0.5 : clamp(ratio, 0, 1)
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== e.pointerId) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02
    let next: number
    switch (e.key) {
      case 'ArrowRight': next = value + step; break
      case 'ArrowLeft': next = value - step; break
      case 'Home': next = 0; break
      case 'End': next = 1; break
      case 'Enter': next = 0.5; break
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
    const rounded = Math.round(next * 100) / 100
    onChange((value < 0.5 && rounded > 0.5) || (value > 0.5 && rounded < 0.5) ? 0.5 : clamp(rounded, 0, 1))
  }

  return (
    <div className="mx-crossfader">
      <span className="num mx-a">A</span>
      <div className={`mx-fader${auto && !held ? ' is-auto' : ''}${held ? ' is-held' : ''}`} role="slider" tabIndex={0} aria-label="Crossfader"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}
        aria-valuetext={value === 0.5 ? 'Centro' : `${Math.round((1 - value) * 100)}% A, ${Math.round(value * 100)}% B`}
        onPointerDown={(e) => {
          if (e.button !== 0 || drag.current || !track.current) return
          const rect = track.current.getBoundingClientRect()
          const x = onTouch()
          const grabbedCap = (e.target as Element).closest('.mx-fader-cap')
          const offset = grabbedCap ? e.clientX - (rect.left + value * rect.width) : 0
          drag.current = { pointer: e.pointerId, left: rect.left, width: rect.width, offset }
          e.currentTarget.setPointerCapture(e.pointerId)
          if (!grabbedCap) onChange(getValue((e.clientX - rect.left) / rect.width, rect.width))
          else e.currentTarget.style.setProperty('--position', `${x * 100}%`)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.pointer !== e.pointerId) return
          onChange(getValue((e.clientX - d.left - d.offset) / d.width, d.width))
        }}
        onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onDoubleClick={() => onChange(0.5)} onKeyDown={onKey}
        style={{ '--position': `${value * 100}%` } as CSSProperties}>
        <div className="mx-fader-track" ref={track} aria-hidden>
          <div className="mx-fader-slot" />
          <div className="mx-fader-ticks"><i /><i /><i /><i /><i /></div>
          <div className="mx-fader-cap" />
        </div>
      </div>
      <span className="num mx-b">B</span>
    </div>
  )
}

const transitionOptions: ReadonlyArray<{ id: Transition; label: string }> = [
  { id: 'bass', label: 'Cambio de graves' },
  { id: 'blend', label: 'Fundido' },
  { id: 'cut', label: 'Corte' },
]
export const transitionLengths = [8, 16, 32, 64] as const
export type TransitionLength = typeof transitionLengths[number]

export function CenterMixer({ style, length, custom, setStyle, setLength, setAuto, ...fader }: FaderProps & {
  custom: boolean
  style: Transition
  length: TransitionLength
  setStyle: (style: Transition) => void
  setLength: (length: TransitionLength) => void
  setAuto: (auto: boolean) => void
}) {
  return (
    <section className="mx-module mx-center" aria-label="Mezclador">
      <div className="mx-module-head">
        <h3>Crossfader</h3>
        <Seg role="group">
          <button className={fader.auto ? 'on' : ''} aria-pressed={fader.auto} onClick={() => setAuto(true)}>Automática</button>
          <button className={!fader.auto ? 'on' : ''} aria-pressed={!fader.auto} onClick={() => setAuto(false)}>Manual</button>
        </Seg>
      </div>
      <Crossfader {...fader} />
      <div className="mx-transition">
        <span>{custom ? 'Curva editada' : 'Transición'}</span>
        <Seg role="group">
          {transitionOptions.map(({ id, label }) => <button className={id === style && !custom ? 'on' : ''} title={custom ? 'Volver a esta curva' : undefined}
            key={id} aria-pressed={id === style && !custom} onClick={() => setStyle(id)}>{label}</button>)}
        </Seg>
      </div>
      <div className="mx-transition">
        <span>Compases</span>
        <Seg role="group">
          {transitionLengths.map((n) => <button className={n === length ? 'on num' : 'num'}
            key={n} aria-pressed={n === length} onClick={() => setLength(n)}>{n}</button>)}
        </Seg>
      </div>
    </section>
  )
}

const shortcuts = [
  ['Espacio', 'Reproducir o pausar'],
  ['← / →', 'Saltar 4 compases'],
  [',  /  .', 'Mover la entrada de B un compás'],
  ['[  /  ]', 'Mover la fase de B 10 ms'],
  ['− / +', 'Alejar o acercar la grilla'],
  ['Esc', 'Cerrar'],
  ['Rueda', 'Zoom bajo el puntero'],
  ['Scroll lateral / Mayús + rueda', 'Desplazar la grilla'],
  ['Arrastrar B', 'Mover la entrada por compases'],
  ['Mayús / Opción + arrastrar B', 'Mover la fase por beats o por ms'],
  ['Clic en la franja del medio', 'Agregar un punto a la curva elegida'],
  ['Arrastrar un punto', 'Moverlo de a beat (Mayús: de a compás, Opción: libre)'],
  ['Doble clic en un punto', 'Borrarlo'],
  ['Perilla o crossfader en pausa', 'Deja un punto en la curva donde está el cabezal'],
  ['Perilla o crossfader sonando', 'Lo manejás vos hasta que pauses'],
  ['Tempo', 'De a 0,1 %; Mayús de a 1 %. Mover el de B apaga Sync.'],
  ['Sync', 'B sigue el tempo de A: el tempo de A acelera o frena toda la mezcla'],
  ['Master tempo', 'Cambia la velocidad sin cambiar el tono. Apagado, el tono sube y baja con la velocidad, como un vinilo.'],
  ['Paso', 'Mayús para pasos grandes. Opción para ajustar la fase de a 1 ms.'],
] as const

export function MixHelp({ open, toggle }: { open: boolean; toggle: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <div className="mx-help">
      <button className="btn ghost sm icon help-btn" aria-label="Atajos y gestos" aria-expanded={open}
        aria-controls="mx-shortcuts" onClick={toggle}>?</button>
      {open && <div className="mx-help-menu" id="mx-shortcuts">
        <h3>Atajos y gestos</h3>
        <dl>{shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
      </div>}
    </div>
  )
}
