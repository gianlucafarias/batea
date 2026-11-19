import { ArtistLinks } from './Artist'
import { api } from '../api'
import { AnalysisBadge } from './Analysis'
import { SourceBadges } from './SourceBadges'
import { openTrackMenu } from './TrackMenu'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, usePlayer } from '../store'
import type { Track } from '../types'
import { cleanTitle, fmtBpm, fmtDate, fmtTime } from '../util'
import { EnergyMeter, KeyBadge, Sleeve, Stars } from './bits'
import { IconPause, IconPlay } from './icons'
import { useFluidHover } from '../lib/fluidHover'

export type SortKey = 'position' | 'title' | 'artist' | 'bpm' | 'key' | 'energy' | 'rating' | 'date_added' | 'intro_bars' | 'play_count' | 'duration'

const COLS: { key: SortKey | null; label: string }[] = [
  { key: 'position', label: '#' }, { key: null, label: '' }, { key: 'title', label: 'Tema' }, { key: 'artist', label: 'Artista' },
  { key: 'bpm', label: 'BPM' }, { key: 'key', label: 'Tono' }, { key: 'energy', label: 'Energía' }, { key: 'rating', label: 'Puntaje' }, { key: null, label: 'Programa' },
  { key: null, label: 'Etiquetas' }, { key: 'intro_bars', label: 'In/Out' }, { key: 'date_added', label: 'Agregado' }, { key: 'duration', label: 'Duración' },
]

export function sortTracks(tracks: Track[], key: SortKey, dir: 1 | -1): Track[] {
  if (key === 'position') return dir === 1 ? tracks : [...tracks].reverse()
  const keyNum = (k: string | null) => {
    const m = k ? /^(\d+)([AB])$/.exec(k) : null
    return m ? Number(m[1]) * 2 + (m[2] === 'B' ? 1 : 0) : 999
  }
  return [...tracks].sort((a, b) => {
    let va: string | number | null, vb: string | number | null
    if (key === 'key') { va = keyNum(a.key); vb = keyNum(b.key) }
    else { va = a[key] as string | number | null; vb = b[key] as string | number | null }
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    return (typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number)) * dir
  })
}

/** Devuelve true si el click fue de selección múltiple (⌘ / ⇧) y no debe abrir la ficha. */
export type PickFn = (t: Track, index: number, e: React.MouseEvent) => boolean

const ROW = 40

/** `onReorder` activa el arrastre para reordenar: recibe los ids de los temas en el orden nuevo. */
export function ListView({ tracks, sort, onSort, multi, onPick, onReorder }: { tracks: Track[]; sort: [SortKey, 1 | -1]; onSort: (s: [SortKey, 1 | -1]) => void; multi?: Set<number>; onPick?: PickFn; onReorder?: (ids: number[]) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const { selectedId, select, tags } = useApp()
  const { patchTrack, toast } = useApp()
  const rate = (id: number, rating: number) => {
    patchTrack({ id, rating })   // se ve al instante
    api.patchTrack(id, { rating }).catch((e) => toast((e as Error).message, 'error'))
  }
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const { play, track, playing } = usePlayer()
  const rowHover = useFluidHover<HTMLDivElement>()
  const v = useVirtualizer({ count: tracks.length, getScrollElement: () => ref.current, estimateSize: () => ROW, overscan: 12 })

  // ---- reordenar arrastrando (solo en cajas propias y con el orden de la caja)
  const body = useRef<HTMLDivElement | null>(null)
  const setHover = rowHover.ref
  const bodyRef = useCallback((el: HTMLDivElement | null) => { body.current = el; setHover(el) }, [setHover])
  const [drag, setDrag] = useState<{ ids: Set<number>; slot: number } | null>(null)
  const swallow = useRef(false)
  const live = useRef({ tracks, multi, onReorder })
  live.current = { tracks, multi, onReorder }

  const startDrag = useCallback((e: React.PointerEvent, t: Track) => {
    const { onReorder: reorder } = live.current
    if (!reorder || e.button !== 0 || (e.target as HTMLElement).closest('button:not(.artist-link), input, a, [role="slider"]')) return
    const x0 = e.clientX, y0 = e.clientY
    let started = false
    let y = y0
    let raf = 0
    const slotAt = (clientY: number) => {
      const top = body.current?.getBoundingClientRect().top ?? 0
      return Math.max(0, Math.min(live.current.tracks.length, Math.round((clientY - top) / ROW)))
    }
    const scroller = ref.current
    // junto a los bordes de la lista, se desplaza sola para llegar a filas lejanas
    const autoscroll = () => {
      if (!scroller) return
      const r = scroller.getBoundingClientRect()
      const edge = 56, headH = 32
      const dy = y < r.top + headH + edge ? -Math.ceil((r.top + headH + edge - y) / 4) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 4) : 0
      if (dy) { scroller.scrollTop += dy; setDrag((d) => d && { ...d, slot: slotAt(y) }) }
      raf = requestAnimationFrame(autoscroll)
    }
    const move = (ev: PointerEvent) => {
      y = ev.clientY
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
        started = true
        const sel = live.current.multi
        const ids = sel && sel.size > 1 && sel.has(t.id) ? new Set(sel) : new Set([t.id])
        setDrag({ ids, slot: slotAt(y) })
        raf = requestAnimationFrame(autoscroll)
        document.body.classList.add('reordering')
      }
      setDrag((d) => d && { ...d, slot: slotAt(y) })
    }
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(raf)
      document.body.classList.remove('reordering')
      if (!started) return
      swallow.current = true                     // el click que sigue al soltar no debe abrir la ficha
      setTimeout(() => { swallow.current = false }, 0)
      setDrag((d) => {
        if (d && ev) {
          const all = live.current.tracks
          const moving = all.filter((x) => d.ids.has(x.id))
          const rest = all.filter((x) => !d.ids.has(x.id))
          const before = all.slice(0, d.slot).filter((x) => !d.ids.has(x.id)).length
          const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)].map((x) => x.id)
          if (next.some((id, i) => id !== all[i].id)) live.current.onReorder?.(next)
        }
        return null
      })
    }
    const up = (ev: PointerEvent) => finish(ev)
    const cancel = () => finish(null)
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(null) } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }, [])
  useEffect(() => () => document.body.classList.remove('reordering'), [])

  return (
    <div className="list" ref={ref}>
      <div className="lrow head">
        {COLS.map((c, i) => (
          <button key={i} className={sort[0] === c.key ? 'on' : ''} disabled={!c.key} onClick={() => c.key && onSort([c.key, sort[0] === c.key ? (sort[1] === 1 ? -1 : 1) : (c.key === 'title' || c.key === 'artist' || c.key === 'position' ? 1 : -1)])}>
            {c.label}{sort[0] === c.key && c.key !== 'position' ? (sort[1] === 1 ? ' ↑' : ' ↓') : ''}
          </button>
        ))}
      </div>
      {!tracks.length && <div className="empty"><h3>Sin resultados</h3></div>}
      <div style={{ height: v.getTotalSize(), position: 'relative' }} ref={bodyRef}>
        {rowHover.highlight}
        {drag && <div className="drop-line" style={{ top: drag.slot * ROW - 1 }} />}
        {v.getVirtualItems().map((row) => {
          const t = tracks[row.index]
          const isCur = track?.id === t.id
          return (
            <div
              key={t.id}
              data-fh
              className={`lrow${onReorder ? ' sortable' : ''}${drag?.ids.has(t.id) ? ' dragging' : ''}${selectedId === t.id ? ' sel' : ''}${multi?.has(t.id) ? ' msel' : ''}${t.online ? '' : ' offline'}${t.unanalyzed ? ' unan' : ''}`}
              style={{ position: 'absolute', top: row.start, left: 0, right: 0 }}
              onPointerDown={(e) => startDrag(e, t)}
              onClickCapture={(e) => { if (swallow.current) { e.stopPropagation(); e.preventDefault() } }}
              onClick={(e) => { if (!onPick?.(t, row.index, e)) select(t.id) }}
              onDoubleClick={() => play(t)}
              onContextMenu={(e) => openTrackMenu(e, t, tracks, multi)}
            >
              <button className={`pbtn${isCur ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); play(t) }} disabled={!t.online} title={t.online ? 'Escuchar' : 'Offline'} aria-label={isCur && playing ? 'Pausar' : t.online ? 'Escuchar' : 'Archivo no disponible'}>
                {isCur && playing ? <IconPause size={12} /> : t.online ? <IconPlay size={12} /> : <span className="num faint" style={{ fontSize: 10 }}>{row.index + 1}</span>}
              </button>
              <div className="thumb"><Sleeve id={t.id} title={t.title} trackKey={t.key} hasArt={t.has_art} size="s" px={32} /></div>
              <div className="cell t tcell" title={t.unanalyzed ? 'Sin analizar' : undefined}>
                <span className="ellipsis">{cleanTitle(t.title)}</span><AnalysisBadge t={t} />
              </div>
              <div className="cell muted"><ArtistLinks artist={t.artist} /></div>
              <div className="cell num">{fmtBpm(t.bpm)}</div>
              <div><KeyBadge k={t.key} est={!!t.key_est} /></div>
              <div><EnergyMeter value={t.energy} auto={!t.energy_user} /></div>
              <div onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}><Stars value={t.rating} onChange={(v) => rate(t.id, v)} /></div>
              <div className="lsources"><SourceBadges sources={t.sources} /></div>
              <div className="mini-tags">
                {t.tags.slice(0, 4).map((id) => {
                  const tg = tagById.get(id)
                  return tg ? <span key={id}>{tg.name}</span> : null
                })}
              </div>
              <div className="cell num muted">{t.intro_bars ?? '–'}/{t.outro_bars ?? '–'}</div>
              <div className="cell num muted">{fmtDate(t.date_added)}</div>
              <div className="cell num muted">{fmtTime(t.duration)}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
