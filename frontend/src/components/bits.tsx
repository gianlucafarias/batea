import { memo, useState } from 'react'
import { artUrl } from '../api'
import { allNotations, formatKey, useKeyNotation } from '../lib/keyNotation'
import { cleanTitle, hash, keyColor } from '../util'

const SLEEVES = ['#121110', '#161412', '#1d1a17', '#0f1214', '#17120f', '#131313']

interface SleeveProps {
  id: number
  title?: string | null
  artist?: string | null
  trackKey?: string | null
  bpm?: number | null
  hasArt?: number | boolean
  online?: boolean
  size?: 's' | 'm' | 'l'
  px?: number
}

/** Tapa del disco: la carátula real o un sobre genérico con el label del color de la tonalidad. */
export const Sleeve = memo(function Sleeve({ id, title, artist, trackKey, bpm, hasArt, online = true, size = 'm', px = 200 }: SleeveProps) {
  const [failed, setFailed] = useState(false)
  if (hasArt && !failed) {
    return (
      <div className="sleeve">
        <img src={artUrl(id, size)} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
        {!online && <span className="offline-dot" title="Archivo no disponible" />}
      </div>
    )
  }
  const h = hash(id)
  const white = h > 0.86
  const bg = SLEEVES[Math.floor(h * 997) % SLEEVES.length]
  const fs = Math.max(6, Math.min(13, px / 19))
  return (
    <div
      className={`sleeve gen${white ? ' white' : ''}`}
      style={{ ['--sleeve-bg' as string]: white ? undefined : bg, ['--label' as string]: keyColor(trackKey), ['--fs' as string]: `${fs}px`, ['--fs-s' as string]: `${Math.max(6, fs * 0.8)}px` }}
    >
      {px >= 60 && (trackKey || bpm) ? (
        <span className="stamp">
          {trackKey && <b style={{ color: keyColor(trackKey) }}><KeyText k={trackKey} /></b>}
          {trackKey && bpm ? ' · ' : ''}{bpm ? `${Math.round(bpm)} BPM` : ''}
        </span>
      ) : null}
      <div className="hole">
        {px >= 90 && (
          <div className="lbl">
            <span className="tt">{cleanTitle(title).slice(0, 60)}</span>
            {artist && <span className="a">{artist.slice(0, 40)}</span>}
          </div>
        )}
      </div>
      {!online && <span className="offline-dot" title="Archivo no disponible" />}
    </div>
  )
})

/** `est`: tonalidad calculada por Batea (rekordbox no la tenía); se marca con borde punteado. */
/** La tonalidad como texto, en la notación elegida en Ajustes. */
export function KeyText({ k }: { k: string | null | undefined }) {
  const notation = useKeyNotation((s) => s.notation)
  return <>{formatKey(k, notation)}</>
}

export function KeyBadge({ k, est }: { k: string | null | undefined; est?: boolean }) {
  const notation = useKeyNotation((s) => s.notation)
  if (!k) return <span className="keybadge none" title="Sin tonalidad">–</span>
  const label = formatKey(k, notation)
  const all = allNotations(k)
  if (est) {
    return <span className="keybadge est" title={`${all} · estimada por Batea (puede no coincidir con rekordbox)`} style={{ color: keyColor(k), borderColor: keyColor(k) }}>{label}</span>
  }
  return <span className="keybadge" title={all} style={{ background: keyColor(k) }}>{label}</span>
}

export function energyColor(e: number): string {
  // del azul frío al naranja/rojo de pico
  const hue = 210 - (Math.min(10, Math.max(1, e)) - 1) * 21
  return `hsl(${hue}, 72%, 58%)`
}

export function EnergyMeter({ value, auto }: { value: number | null; auto?: boolean }) {
  const v = value ?? 0
  return (
    <span className="energy" title={value ? `Energía ${value}/10${auto ? ' (estimada)' : ''}` : 'Sin energía'} style={{ ['--e-color' as string]: energyColor(v), opacity: auto ? 0.75 : 1 }}>
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} className={i < v ? 'on' : ''} style={{ height: `${30 + i * 7}%` }} />
      ))}
    </span>
  )
}

export function EnergyEditor({ value, auto, onChange }: { value: number | null; auto: number | null; onChange: (v: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover ?? value ?? auto ?? 0
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="section-h">
        <span className="eyebrow">Energía</span>
        <span className="muted" style={{ fontSize: 11.5, display: 'flex', gap: 8 }}>
          {value ? <><b className="num" style={{ color: 'var(--text)' }}>{value}</b>{auto ? <button className="link-quiet" onClick={() => onChange(null)}>usar la estimada ({auto})</button> : null}</> :
            auto ? <><span><b className="num" style={{ color: 'var(--text)' }}>{auto}</b> estimada</span></> : 'Sin datos'}
        </span>
      </div>
      <div className="energy big" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: 10 }, (_, i) => (
          <button key={i} onMouseEnter={() => setHover(i + 1)} onClick={() => onChange(i + 1)} aria-label={`Energía ${i + 1}`}>
            <i style={{ height: `${28 + i * 8}%`, background: i < shown ? energyColor(shown) : undefined, opacity: !hover && !value && i < shown ? 0.55 : 1 }} className={i < shown ? 'on' : ''} />
          </button>
        ))}
      </div>
    </div>
  )
}

export function Stars({ value, onChange, big }: { value: number; onChange?: (v: number) => void; big?: boolean }) {
  if (!onChange) {
    return <span className="stars">{Array.from({ length: 5 }, (_, i) => <span key={i} className={i < value ? 'on' : ''}>★</span>)}</span>
  }
  return (
    <span className={`stars${big ? ' big' : ''}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <button key={i} className={i < value ? 'on' : ''} onClick={() => onChange(i + 1 === value ? 0 : i + 1)} aria-label={`${i + 1} estrellas`}>★</button>
      ))}
    </span>
  )
}
