import { ArtistLinks } from './Artist'
import { AnalysisNotice } from './Analysis'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePlayer, useApp } from '../store'
import type { Track } from '../types'
import { cleanTitle, fmtBpm, fmtDate, fmtTime, hash } from '../util'
import { EnergyMeter, KeyBadge, Sleeve, Stars } from './bits'
import { IconMix, IconPause, IconPlay } from './icons'
import { SourceBadges } from './SourceBadges'

const BEHIND = 14
const AHEAD = 3

/** Batea 3D: los discos parados uno detrás de otro; se hojean con la rueda, las flechas o el índice. */
export function Digger({ tracks, crateName }: { tracks: Track[]; crateName: string }) {
  const [focus, setFocus] = useState(0)
  const stage = useRef<HTMLDivElement>(null)
  const [dim, setDim] = useState({ w: 800, h: 600 })
  const select = useApp((s) => s.select)
  const openMixPicker = useApp((s) => s.openMixPicker)
  const panelOpen = useApp((s) => s.selectedId != null)
  const tagsAll = useApp((s) => s.tags)
  const tagById = useMemo(() => new Map(tagsAll.map((t) => [t.id, t])), [tagsAll])
  const { play, track: current, playing } = usePlayer()
  const wheelAcc = useRef(0)

  useEffect(() => { setFocus((f) => Math.min(f, Math.max(0, tracks.length - 1))) }, [tracks])
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setDim({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    el.focus()
    return () => ro.disconnect()
  }, [])

  const n = tracks.length
  const step = useCallback((d: number) => setFocus((f) => Math.max(0, Math.min(n - 1, f + d))), [n])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      wheelAcc.current += e.deltaY + e.deltaX
      const th = 46
      while (Math.abs(wheelAcc.current) >= th) {
        step(wheelAcc.current > 0 ? 1 : -1)
        wheelAcc.current -= Math.sign(wheelAcc.current) * th
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [step])

  const t = tracks[focus]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); step(e.shiftKey ? 10 : 1) }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); step(e.shiftKey ? -10 : -1) }
    else if (e.key === 'Enter' && t) { e.preventDefault(); play(t) }
    else if (e.key === 'i' && t) select(t.id)
    else if (e.key === 'm' && t && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openMixPicker(t.id) }
  }

  // geometría: el disco del frente apenas levantado; los de atrás asoman por arriba (como al mirar dentro de una batea)
  const BOTTOM = 132
  const STEP = 9
  const size = Math.max(180, Math.min((dim.h - BOTTOM - 70 - STEP * 10) / 1.18, dim.w * 0.62, 430))
  const lift = size * 0.18
  const boxH = BOTTOM + lift + size * 0.1
  const bins = Math.min(n, 240)

  if (!n) return <div className="empty"><h3>Caja vacía</h3><p>No hay discos con estos filtros.</p></div>

  return (
    <div className={`digger${panelOpen ? ' solo' : ''}`}>
      <div className="dig-stage" ref={stage} tabIndex={0} onKeyDown={onKey}>
        <div className="dig-hint"><span><kbd>↑</kbd><kbd>↓</kbd> o rueda para hojear</span><span><kbd>⏎</kbd> escuchar</span><span><kbd>i</kbd> ficha</span><span><kbd>m</kbd> mezclar</span></div>
        <div className="dig-counter">{focus + 1} / {n.toLocaleString('es-AR')}</div>
        <div className="dig-stack" style={{ ['--size' as string]: `${size}px`, bottom: BOTTOM }}>
          {tracks.slice(Math.max(0, focus - AHEAD), focus + BEHIND).map((tr, j) => {
            const i = Math.max(0, focus - AHEAD) + j
            const d = i - focus
            const h = hash(tr.id)
            let transform: string
            let opacity = 1
            if (d === 0) {
              transform = `translate3d(0, ${-lift}px, 30px) rotateX(-4deg)`
            } else if (d > 0) {
              transform = `translate3d(${(h - 0.5) * 8}px, ${-lift - d * STEP}px, ${-d * 26}px) rotateX(${-6 + (h - 0.5) * 3}deg) rotateZ(${(h - 0.5) * 1.4}deg)`
              opacity = d > BEHIND - 4 ? (BEHIND - d) / 4 : 1
            } else {
              transform = `translate3d(0, ${-lift + size * 0.1}px, ${70 - d * 18}px) rotateX(${-62 - (-d - 1) * 5}deg)`
              opacity = Math.max(0, 0.9 + d * 0.3)
            }
            return (
              <div
                key={tr.id}
                className={`dig-rec${d === 0 ? ' front' : ''}`}
                style={{ transform, opacity, zIndex: 300 - Math.abs(d) * 2 + (d < 0 ? 1 : 0), filter: [d > 0 ? `brightness(${1 - Math.min(d, 10) * 0.05})` : '', tr.unanalyzed ? 'grayscale(1) brightness(0.6)' : ''].join(' ').trim() || undefined }}
                onClick={() => (d === 0 ? select(tr.id) : setFocus(i))}
                onDoubleClick={() => d === 0 && play(tr)}
              >
                <Sleeve id={tr.id} title={tr.title} artist={tr.artist} trackKey={tr.key} bpm={tr.bpm} hasArt={tr.has_art} online={tr.online} size={d === 0 ? 'l' : 'm'} px={size} />
              </div>
            )
          })}
        </div>
        <div className="dig-box-front" style={{ ['--size' as string]: `${size}px`, height: boxH }}>
          <span className="tape">{crateName}</span>
        </div>
        <div
          className="dig-scrub"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setFocus(Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)))
            stage.current?.focus()
          }}
        >
          {Array.from({ length: bins }, (_, b) => {
            const idx = Math.floor((b / bins) * n)
            const tr = tracks[idx]
            const on = Math.floor((focus / n) * bins) === b
            return <i key={b} className={on ? 'on' : ''} style={{ height: `${25 + ((tr?.energy ?? 3) / 10) * 75}%` }} />
          })}
        </div>
      </div>
      {t && !panelOpen && (
        <aside className="dig-info">
          <div>
            {(t.label || t.genre) && <div className="eyebrow">{t.label || t.genre}</div>}
            <h2 style={{ marginTop: 6 }}>{cleanTitle(t.title)}</h2>
            <div className="artist"><ArtistLinks artist={t.artist} fallback='Artista desconocido' /></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={!t.online} onClick={() => play(t)}>
              {current?.id === t.id && playing ? <><IconPause size={13} /> Pausa</> : <><IconPlay size={13} /> Escuchar</>}
            </button>
            <button className="btn" onClick={() => select(t.id)}>Ficha</button>
            <button className="btn" title="Probar mezcla (M)" onClick={() => openMixPicker(t.id)}><IconMix size={13} /> Probar mezcla</button>
          </div>
          {!t.online && <div className="faint" style={{ fontSize: 11.5, marginTop: -6 }}>Disco desconectado</div>}
          <AnalysisNotice t={t} online={!!t.online} />
          <SourceBadges sources={t.sources} />
          <div className="stat-grid">
            <div><span className="eyebrow">BPM</span><span className="v">{fmtBpm(t.bpm)}</span></div>
            <div><span className="eyebrow">Tono</span><span><KeyBadge k={t.key} /></span></div>
            <div><span className="eyebrow">Largo</span><span className="v">{fmtTime(t.duration)}</span></div>
            <div><span className="eyebrow">Energía</span><span style={{ paddingTop: 3 }}><EnergyMeter value={t.energy} auto={!t.energy_user} /></span></div>
            <div><span className="eyebrow">Intro</span><span className="v">{t.intro_bars ?? '–'}<small> compases</small></span></div>
            <div><span className="eyebrow">Outro</span><span className="v">{t.outro_bars ?? '–'}<small> compases</small></span></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Stars value={t.rating} />
            <span className="muted" style={{ fontSize: 11.5 }}>agregado {fmtDate(t.date_added)}{t.play_count ? ` · ${t.play_count} veces` : ''}</span>
          </div>
          {t.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {t.tags.map((id) => tagById.get(id)).filter(Boolean).map((tg) => (
                <span key={tg!.id} className="chip on" style={{ ['--c' as string]: tg!.color ?? undefined }}>{tg!.name}</span>
              ))}
            </div>
          )}
        </aside>
      )}
    </div>
  )
}
