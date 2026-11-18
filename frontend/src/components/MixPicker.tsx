import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp, usePlayer } from '../store'
import type { Track } from '../types'
import { cleanTitle, fmtBpm } from '../util'
import { KeyBadge, Sleeve } from './bits'
import { IconSearch } from './icons'
import { HoverList } from '../lib/fluidHover'
import { spring, usePresence } from '../lib/motion'
import { plainReason } from './TrackPanel'
import '../mixpicker.css'

interface Row { track: Track; why: string | null }

/**
 * "Probar mezcla con…": elegir el otro tema para el tema `a`.
 * Primero lo que Batea sugiere después de `a`, después el que suena; la búsqueda recorre toda la colección.
 * Puro: no toca el store. `exclude` saca temas de la lista (el B actual, si se usa para cambiarlo).
 */
export function MixPicker({ a, exclude, onPick, onClose, closing }: {
  a: number; exclude?: number[]; onPick: (b: number) => void; onClose: () => void; closing?: boolean
}) {
  const playing = usePlayer((s) => s.track)
  const [source, setSource] = useState<Track | null>(null)
  const [recs, setRecs] = useState<Row[] | null>(null)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Track[] | null>(null)
  const [cur, setCur] = useState(0)
  const [kbd, setKbd] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const skip = useMemo(() => new Set([a, ...(exclude ?? [])]), [a, exclude])

  useEffect(() => {
    let alive = true
    api.track(a).then((t) => { if (alive) setSource(t) }).catch(() => {})
    api.recommendations(a)
      .then((r) => { if (alive) setRecs(r.items.map((x) => ({ track: x.track, why: plainReason(x.reasons) }))) })
      .catch(() => { if (alive) setRecs([]) })
    return () => { alive = false }
  }, [a])

  const term = q.trim()
  useEffect(() => {
    if (term.length < 2) { setFound(null); return }
    let alive = true
    const t = setTimeout(() => {
      api.tracks('all', { q: term }).then((r) => { if (alive) setFound(r) }).catch(() => { if (alive) setFound([]) })
    }, 180)
    return () => { alive = false; clearTimeout(t) }
  }, [term])

  const searching = term.length >= 2
  const sections = useMemo(() => {
    if (searching) {
      return [{ label: null as string | null, rows: (found ?? []).filter((t) => !skip.has(t.id)).slice(0, 30).map((t) => ({ track: t, why: null })) }]
    }
    const sug = (recs ?? []).filter((r) => !skip.has(r.track.id))
    const now = playing && !skip.has(playing.id) && !sug.some((r) => r.track.id === playing.id) ? [{ track: playing, why: null }] : []
    return [
      { label: 'Sugeridos para después', rows: sug.slice(0, 8) as Row[] },
      { label: 'Suena ahora', rows: now as Row[] },
    ].filter((s) => s.rows.length)
  }, [searching, found, recs, playing, skip])
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  useEffect(() => { setCur(0) }, [term])
  const active = Math.min(cur, Math.max(0, flat.length - 1))

  useEffect(() => {
    if (!kbd) return
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active, kbd])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setKbd(true); setCur(Math.min(active + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setKbd(true); setCur(Math.max(active - 1, 0)) }
    else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); onPick(flat[active].track.id) }
  }

  const loading = searching ? found === null : recs === null
  let n = 0
  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mixpicker" role="dialog" aria-label="Probar mezcla con…" onKeyDown={onKey}>
        <div className="mp-head">
          <h2>Probar mezcla con…</h2>
          {source && <div className="muted ellipsis">{cleanTitle(source.title)}{source.artist ? ` · ${source.artist}` : ''}</div>}
        </div>
        <div className="mp-search">
          <IconSearch size={14} />
          <input className="input" autoFocus placeholder="Buscar un tema" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="mp-list" ref={listRef} data-kbd={kbd || undefined} onMouseMove={() => kbd && setKbd(false)}>
          {sections.map((s, si) => (
            <div key={s.label ?? si} className="mp-sec">
              {s.label && <div className="eyebrow mp-eb">{s.label}</div>}
              <HoverList>
                {s.rows.map((r) => {
                  const i = n++
                  const t = r.track
                  return (
                    <button key={t.id} data-fh className="mp-row" data-active={i === active && kbd ? '' : undefined} onClick={() => onPick(t.id)}>
                      <div className="thumb"><Sleeve id={t.id} title={t.title} trackKey={t.key} hasArt={t.has_art} size="s" px={36} /></div>
                      <div className="mp-main">
                        <div className="t ellipsis">{cleanTitle(t.title)}</div>
                        <div className="meta ellipsis">{[t.artist, r.why].filter(Boolean).join(' · ') || ' '}</div>
                      </div>
                      <span className="num muted mp-bpm">{t.bpm ? fmtBpm(t.bpm) : ''}</span>
                      <KeyBadge k={t.key} est={!!t.key_est} />
                    </button>
                  )
                })}
              </HoverList>
            </div>
          ))}
          {!flat.length && <div className="faint mp-empty">{loading ? 'Buscando…' : searching ? 'Sin resultados' : 'Todavía no hay sugerencias. Buscá un tema.'}</div>}
        </div>
      </div>
    </div>
  )
}

/** Montado una sola vez en App: abre el chooser para `mixPicker` y, al elegir, el laboratorio. */
export function MixPickerHost() {
  const id = useApp((s) => s.mixPicker)
  const [shown, closing] = usePresence(id, spring.slow.exit)
  if (shown == null) return null
  const { closeMixPicker, openMix } = useApp.getState()
  return <MixPicker a={shown} closing={closing} onClose={closeMixPicker} onPick={(b) => openMix(shown, b)} />
}
