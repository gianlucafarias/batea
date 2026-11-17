import { artistCrate } from './Artist'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useApp, usePlayer } from '../store'
import { cleanTitle, fmtTime } from '../util'
import { Sleeve } from './bits'
import { folderCrate } from './FolderTree'
import { IconPause, IconPlay, IconVolume } from './icons'
import { useWaveform, Waveform } from './Waveform'
import { GlyphSwap, HoverList } from '../lib/fluidHover'
import { spring, usePresence } from '../lib/motion'

export function ExportDialog() {
  const { exportOpen, setExportOpen, crates, virtualCrates, folders, crateId, toast } = useApp()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [tagsInComment, setTagsInComment] = useState(false)
  const [res, setRes] = useState<{ path: string; tracks: number; playlists: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [shown, closing] = usePresence(exportOpen, spring.slow.exit)

  useEffect(() => {
    if (!exportOpen) return
    setRes(null)
    const mine = crates.filter((c) => c.kind === 'user' || c.kind === 'smart').map((c) => String(c.id))
    // "Toda la colección" y "Eliminados" no figuran en la lista: preseleccionarlas exportaba algo que no se veía marcado
    setSel(new Set(crateId && crateId !== 'all' && crateId !== 'hidden' ? [crateId] : mine))
  }, [exportOpen, crateId, crates])

  if (!shown) return null
  const here = folderCrate(crateId, folders) ?? artistCrate(crateId)
  const groups = [
    ...(here ? [{ label: here.kind === 'artist' ? 'Este artista (como playlist)' : 'Esta carpeta (como playlist)', list: [here] }] : []),
    { label: 'Tus cajas', list: crates.filter((c) => c.kind === 'user' || c.kind === 'smart') },
    { label: 'Atajos', list: virtualCrates.filter((c) => c.id !== 'all' && c.id !== 'hidden') },
    { label: 'Playlists de rekordbox', list: crates.filter((c) => c.kind === 'playlist' && !c.hidden && c.count) },
  ]
  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && setExportOpen(false)}>
      <div className="modal">
        <div>
          <h2>Exportar a rekordbox</h2>
          <p className="muted" style={{ margin: '6px 0 0', lineHeight: 1.5 }}>
            Genera un XML con las cajas elegidas como playlists. rekordbox lo importa por su camino oficial, sin tocar tu base. De ahí exportás al USB como siempre para los CDJ.
          </p>
        </div>
        {!res ? (
          <>
            <HoverList className="check-list">
              {groups.map((g) => g.list.length > 0 && (
                <div key={g.label}>
                  <div className="eyebrow" style={{ padding: '8px 8px 4px' }}>{g.label}</div>
                  {g.list.map((c) => (
                    <label key={c.id} data-fh>
                      <input type="checkbox" checked={sel.has(String(c.id))} onChange={(e) => {
                        const n = new Set(sel); e.target.checked ? n.add(String(c.id)) : n.delete(String(c.id)); setSel(n)
                      }} />
                      <span className="ellipsis">{c.name}</span><span className="count">{c.count}</span>
                    </label>
                  ))}
                </div>
              ))}
            </HoverList>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', lineHeight: 1.45 }}>
              <input type="checkbox" checked={tagsInComment} onChange={(e) => setTagsInComment(e.target.checked)} style={{ marginTop: 2 }} />
              <span>Agregar mis etiquetas al comentario (<span className="mono">#intro-larga #acapella…</span>)<br />
                <span className="muted" style={{ fontSize: 12 }}>Sirve para verlas y buscarlas en el CDJ. Solo se aplica a temas que rekordbox importe desde el XML.</span></span>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn ghost" onClick={() => setExportOpen(false)}>Cancelar</button>
              <button className="btn primary" disabled={!sel.size || busy} onClick={async () => {
                setBusy(true)
                try { setRes(await api.exportRb([...sel], tagsInComment)) } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
              }}>{busy ? 'Exportando…' : `Exportar ${sel.size} ${sel.size === 1 ? 'caja' : 'cajas'}`}</button>
            </div>
          </>
        ) : (
          <>
            <div className="card" style={{ background: 'var(--bg-2)' }}>
              <div><b className="num">{res.playlists}</b> playlists · <b className="num">{res.tracks}</b> temas → <span className="mono" style={{ fontSize: 11.5 }}>{res.path}</span></div>
            </div>
            <ol className="steps">
              <li>En rekordbox: <b>Preferencias → Avanzado → Base de datos → rekordbox xml</b>, elegí <code>{res.path}</code> (una sola vez).</li>
              <li>Activá <b>Vista → Mostrar “rekordbox xml”</b> en la barra lateral si no aparece.</li>
              <li>Abrí <b>rekordbox xml → Playlists → Batea · fecha</b>, click derecho en cada playlist → <b>Importar playlist</b>.</li>
              <li>Los temas nuevos se analizan en rekordbox y después los exportás al USB para los CDJ.</li>
            </ol>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => api.revealExport()}>Mostrar en Finder</button>
              <button className="btn primary" onClick={() => setExportOpen(false)}>Listo</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function PromptModal() {
  const live = useApp((s) => s.ask)
  const [ask, closing] = usePresence(live, spring.slow.exit)
  const [v, setV] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (live) { setV(live.value); setTimeout(() => ref.current?.select(), 20) } }, [live])
  if (!ask) return null
  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && ask.resolve(null)}>
      <form className="modal" style={{ width: 420 }} onSubmit={(e) => { e.preventDefault(); ask.resolve(v.trim() || null) }}>
        <h2 style={{ fontSize: 15 }}>{ask.title}</h2>
        <input ref={ref} className="input" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && ask.resolve(null)} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn ghost" onClick={() => ask.resolve(null)}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>Aceptar</button>
        </div>
      </form>
    </div>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone ?? ''}${t.leaving ? ' leaving' : ''}`}>{t.text}</div>)}</div>
}

export function Player() {
  const { track, playing, time, duration, toggle, seek, volume, setVolume, error } = usePlayer()
  const select = useApp((s) => s.select)
  const wave = useWaveform(track?.id)
  const lastVol = useRef(0.8)
  return (
    <div className="player">
      <div className="now">
        {track ? (
          <>
            <button className="thumb" onClick={() => select(track.id)} aria-label="Ver la ficha del tema"><Sleeve id={track.id} title={track.title} trackKey={track.key} hasArt={track.has_art} size="s" px={42} /></button>
            <div style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600 }}>{cleanTitle(track.title)}</div>
              <div className="ellipsis muted" style={{ fontSize: 11.5 }}>{error ?? track.artist}</div>
            </div>
          </>
        ) : <span className="faint" style={{ fontSize: 12, paddingLeft: 6 }}>Doble click en un disco para escucharlo</span>}
      </div>
      <div className="ctrl">
        <button className="playbtn" disabled={!track} onClick={toggle} aria-label={playing ? 'Pausar' : 'Reproducir'} title={playing ? 'Pausar (espacio)' : 'Reproducir (espacio)'}>
          <GlyphSwap on={playing} a={<IconPlay size={15} />} b={<IconPause size={15} />} />
        </button>
        <span className="num muted" style={{ fontSize: 11, width: 36, textAlign: 'right' }}>{fmtTime(time)}</span>
        <div className="pwave">
          <Waveform data={track ? wave : null} progress={duration ? time / duration : 0} onSeek={(f) => seek(f * duration)} introBars={track?.intro_bars} outroBars={track?.outro_bars} />
        </div>
        <span className="num muted" style={{ fontSize: 11, width: 36 }}>{fmtTime(duration || track?.duration)}</span>
      </div>
      <div className="vol">
        <button className="btn ghost sm icon" aria-label={volume ? 'Silenciar' : 'Volver a escuchar'} title={volume ? 'Silenciar' : 'Volver a escuchar'}
          onClick={() => { if (volume) { lastVol.current = volume; setVolume(0) } else setVolume(lastVol.current || 0.8) }}
          style={{ opacity: volume ? 1 : 0.5 }}><IconVolume size={15} /></button>
        <input aria-label="Volumen" type="range" min={0} max={1} step={0.01} value={volume} style={{ ['--v' as string]: volume }} onChange={(e) => setVolume(Number(e.target.value))} />
      </div>
    </div>
  )
}
