import { ArtistLinks } from './Artist'
import { openTrackMenu } from './TrackMenu'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState } from 'react'
import { useApp, usePlayer } from '../store'
import type { Track } from '../types'
import { cleanTitle, fmtBpm } from '../util'
import { EnergyMeter, KeyBadge, Sleeve } from './bits'
import { IconPause, IconPlay } from './icons'
import type { PickFn } from './ListView'

export function Wall({ tracks, multi, onPick }: { tracks: Track[]; multi?: Set<number>; onPick?: PickFn }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  const { selectedId, select } = useApp()
  const { play, track, playing } = usePlayer()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 56))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const gap = 20
  const cols = Math.max(2, Math.floor((width + gap) / (168 + gap)))
  const cell = (width - gap * (cols - 1)) / cols
  const rows = Math.ceil(tracks.length / cols)
  const rowH = cell + 84
  const v = useVirtualizer({ count: rows, getScrollElement: () => ref.current, estimateSize: () => rowH, overscan: 3 })
  useEffect(() => { v.measure() }, [rowH]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!tracks.length) return <div className="empty"><h3>Nada por acá</h3><p>Probá con otros filtros.</p></div>

  return (
    <div className="wall" ref={ref}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((row) => (
          <div key={row.key} style={{ position: 'absolute', top: row.start, left: 0, right: 0, display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap }}>
            {tracks.slice(row.index * cols, row.index * cols + cols).map((t, j) => (
              <button key={t.id} className={`wall-card${selectedId === t.id ? ' sel' : ''}${multi?.has(t.id) ? ' msel' : ''}${t.unanalyzed ? ' unan' : ''}`} title={t.unanalyzed ? 'Sin analizar' : undefined}
                onClick={(e) => { if (!onPick?.(t, row.index * cols + j, e)) select(t.id) }} onDoubleClick={() => play(t)}
                onContextMenu={(e) => openTrackMenu(e, t, tracks, multi)}>
                <div className="cover">
                  <Sleeve id={t.id} title={t.title} artist={t.artist} trackKey={t.key} bpm={t.bpm} hasArt={t.has_art} online={t.online} px={cell} />
                  {t.online && (
                    <span className="play-ov" onClick={(e) => { e.stopPropagation(); play(t) }}>
                      {track?.id === t.id && playing ? <IconPause size={14} /> : <IconPlay size={14} />}
                    </span>
                  )}
                </div>
                <div>
                  <div className="t ellipsis">{cleanTitle(t.title)}</div>
                  <div className="ellipsis muted" style={{ fontSize: 11.5 }}><ArtistLinks artist={t.artist} fallback='—' /></div>
                </div>
                <div className="m"><KeyBadge k={t.key} est={!!t.key_est} /><span className="num">{fmtBpm(t.bpm)}</span><span style={{ marginLeft: 'auto' }}><EnergyMeter value={t.energy} auto={!t.energy_user} /></span></div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
