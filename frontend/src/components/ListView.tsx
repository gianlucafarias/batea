import { ArtistLinks } from './Artist'
import { api } from '../api'
import { AnalysisBadge } from './Analysis'
import { openTrackMenu } from './TrackMenu'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'
import { useApp, usePlayer } from '../store'
import type { Track } from '../types'
import { cleanTitle, fmtBpm, fmtDate, fmtTime } from '../util'
import { EnergyMeter, KeyBadge, Sleeve, Stars } from './bits'
import { IconPause, IconPlay } from './icons'
import { useFluidHover } from '../lib/fluidHover'

export type SortKey = 'position' | 'title' | 'artist' | 'bpm' | 'key' | 'energy' | 'rating' | 'date_added' | 'intro_bars' | 'play_count' | 'duration'

const COLS: { key: SortKey | null; label: string }[] = [
  { key: 'position', label: '#' }, { key: null, label: '' }, { key: 'title', label: 'Tema' }, { key: 'artist', label: 'Artista' },
  { key: 'bpm', label: 'BPM' }, { key: 'key', label: 'Tono' }, { key: 'energy', label: 'Energía' }, { key: 'rating', label: 'Puntaje' },
  { key: null, label: 'Etiquetas' }, { key: 'intro_bars', label: 'In/Out' }, { key: 'date_added', label: 'Agregado' }, { key: 'duration', label: 'Largo' },
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

export function ListView({ tracks, sort, onSort, multi, onPick }: { tracks: Track[]; sort: [SortKey, 1 | -1]; onSort: (s: [SortKey, 1 | -1]) => void; multi?: Set<number>; onPick?: PickFn }) {
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
  const v = useVirtualizer({ count: tracks.length, getScrollElement: () => ref.current, estimateSize: () => 40, overscan: 12 })

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
      <div style={{ height: v.getTotalSize(), position: 'relative' }} ref={rowHover.ref}>
        {rowHover.highlight}
        {v.getVirtualItems().map((row) => {
          const t = tracks[row.index]
          const isCur = track?.id === t.id
          return (
            <div
              key={t.id}
              data-fh
              className={`lrow${selectedId === t.id ? ' sel' : ''}${multi?.has(t.id) ? ' msel' : ''}${t.online ? '' : ' offline'}${t.unanalyzed ? ' unan' : ''}`}
              style={{ position: 'absolute', top: row.start, left: 0, right: 0 }}
              onClick={(e) => { if (!onPick?.(t, row.index, e)) select(t.id) }}
              onDoubleClick={() => play(t)}
              onContextMenu={(e) => openTrackMenu(e, t, tracks, multi)}
            >
              <button className={`pbtn${isCur ? ' on' : ''}`} onClick={(e) => { e.stopPropagation(); play(t) }} disabled={!t.online} title={t.online ? 'Escuchar' : 'Offline'} aria-label={isCur && playing ? 'Pausar' : t.online ? 'Escuchar' : 'Archivo no disponible'}>
                {isCur && playing ? <IconPause size={12} /> : t.online ? <IconPlay size={12} /> : <span className="num faint" style={{ fontSize: 10 }}>{row.index + 1}</span>}
              </button>
              <div className="thumb"><Sleeve id={t.id} title={t.title} trackKey={t.key} hasArt={t.has_art} size="s" px={32} /></div>
              <div className="cell t tcell" title={t.unanalyzed ? 'Sin analizar' : undefined}><span className="ellipsis">{cleanTitle(t.title)}</span><AnalysisBadge t={t} /></div>
              <div className="cell muted"><ArtistLinks artist={t.artist} /></div>
              <div className="cell num">{fmtBpm(t.bpm)}</div>
              <div><KeyBadge k={t.key} est={!!t.key_est} /></div>
              <div><EnergyMeter value={t.energy} auto={!t.energy_user} /></div>
              <div onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}><Stars value={t.rating} onChange={(v) => rate(t.id, v)} /></div>
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
