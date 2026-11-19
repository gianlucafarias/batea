import { ArtistLinks, artistCrate } from './Artist'
import { useEffect, useRef, useState } from 'react'
import { api, isNotFound, type ExportResult, type ExportTarget, type ExportTargetId } from '../api'
import { useApp, usePlayer } from '../store'
import { cleanTitle, fmtTime } from '../util'
import { Sleeve } from './bits'
import { folderCrate } from './FolderTree'
import { IconMix, IconPause, IconPlay, IconVolume } from './icons'
import { LiveWaveform, useWaveform } from './Waveform'
import { GlyphSwap, HoverList } from '../lib/fluidHover'
import { spring, usePresence } from '../lib/motion'

const LAST_TARGET = 'batea.export.target'
const FALLBACK_TARGET: ExportTarget = {
  id: 'rekordbox', label: 'rekordbox', available: true, reason: null, format: 'XML',
  carries: ['Las cajas, en orden', 'Rating, comentario y color', 'BPM y tono'],
  loses: ['Cues y grillas'],
  how_to_load: 'En rekordbox: Preferencias → Avanzado → Base de datos → rekordbox xml, y elegí el archivo. Las cajas aparecen en la barra lateral.',
}

function lastTarget(): string | null {
  try { return localStorage.getItem(LAST_TARGET) } catch { return null }
}

export function ExportDialog() {
  const { exportOpen, exportPreset, setExportOpen, crates, virtualCrates, folders, crateId, toast } = useApp()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [tagsInComment, setTagsInComment] = useState(false)
  const [keepPrevious, setKeepPrevious] = useState(true)
  const [withCues, setWithCues] = useState(false)
  const [cuesXml, setCuesXml] = useState<boolean | null>(null)
  const [targets, setTargets] = useState<ExportTarget[]>([FALLBACK_TARGET])
  const [target, setTarget] = useState<ExportTargetId>('rekordbox')
  const [oldApi, setOldApi] = useState(false)
  const [busy, setBusy] = useState(false)
  const [shown, closing] = usePresence(exportOpen, spring.slow.exit)

  useEffect(() => {
    if (!exportOpen) return
    const mine = crates.filter((c) => c.kind === 'user' || c.kind === 'smart').map((c) => String(c.id))
    // "Toda la colección" y "Eliminados" no figuran en la lista: preseleccionarlas exportaba algo que no se veía marcado
    setSel(new Set(exportPreset ?? (crateId && crateId !== 'all' && crateId !== 'hidden' ? [crateId] : mine)))
    let alive = true
    api.cuesStatus().then((c) => alive && setCuesXml(!!c.xml)).catch(() => alive && setCuesXml(null))
    api.exportTargets().then(({ targets: list }) => {
      if (!alive) return
      setOldApi(false)
      setTargets(list)
      const last = lastTarget()
      const pick = list.find((t) => t.id === last && t.available) ?? list.find((t) => t.available)
      if (pick) setTarget(pick.id)
    }).catch((e) => {
      if (!alive) return
      if (isNotFound(e)) { setOldApi(true); setTargets([FALLBACK_TARGET]); setTarget('rekordbox') } else toast((e as Error).message, 'error')
    })
    return () => { alive = false }
  }, [exportOpen, exportPreset, crateId, crates, toast])

  if (!shown) return null
  const here = folderCrate(crateId, folders) ?? artistCrate(crateId)
  const groups = [
    ...(here ? [{ label: here.kind === 'artist' ? 'Este artista (como playlist)' : 'Esta carpeta (como playlist)', list: [here] }] : []),
    { label: 'Tus carpetas', list: crates.filter((c) => c.kind === 'folder' && c.source === 'user') },
    { label: 'Tus cajas', list: crates.filter((c) => c.kind === 'user' || c.kind === 'smart') },
    { label: 'Atajos', list: virtualCrates.filter((c) => c.id !== 'all' && c.id !== 'hidden') },
    { label: 'Playlists de rekordbox', list: crates.filter((c) => c.kind === 'playlist' && !c.hidden && c.count) },
  ]
  const cur = targets.find((t) => t.id === target) ?? targets[0]
  const go = async () => {
    setBusy(true)
    try {
      const ids = [...sel]
      const res: ExportResult = oldApi
        ? await api.exportRb(ids, tagsInComment).then((r) => ({ ok: true, target: 'rekordbox' as const, path: r.path, files: [r.path], tracks: r.tracks, missing: 0, warnings: [] }))
        : await api.exportTo(cur.id, ids, tagsInComment, keepPrevious, withCues)
      try { localStorage.setItem(LAST_TARGET, cur.id) } catch { /* sin almacenamiento */ }
      setExportOpen(false)
      void useApp.getState().loadMeta()      // para que las cajas exportadas dejen de figurar como pendientes
      const missing = (res.missing ? ` · ${res.missing} sin archivo ahora` : '') + (res.kept ? ` · más ${res.kept} ${res.kept === 1 ? 'caja' : 'cajas'} de antes` : '') + (res.cue_tracks ? ` · cues de ${res.cue_tracks} ${res.cue_tracks === 1 ? 'tema' : 'temas'}` : '') + (res.grid_missing ? ` · ${res.grid_missing} sin grilla (falta el XML de rekordbox en Ajustes)` : '')
      toast(res.tracks ? `${cur.label}: ${res.tracks} ${res.tracks === 1 ? 'tema' : 'temas'}${missing} → ${res.path}` : (res.warnings[0] ?? 'No había temas para exportar'),
        res.tracks ? 'ok' : 'error',
        res.tracks ? { label: 'Mostrar en Finder', run: () => { api.revealExport(res.path).catch((e) => toast((e as Error).message, 'error')) } } : undefined)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && setExportOpen(false)}>
      <div className="modal">
        <div>
          <h2>Exportar</h2>
          <p className="muted" style={{ margin: '6px 0 0', lineHeight: 1.5 }}>
            Batea arma un archivo con las cajas que elegiste. Después lo cargás vos en el programa.
          </p>
        </div>
        {targets.length > 1 && (
          <div>
            <div className="eyebrow" style={{ padding: '0 0 4px' }}>¿A qué programa?</div>
            <HoverList className="check-list">
              {targets.map((t) => (
                <label key={t.id} className={t.available ? '' : 'off'} {...(t.available ? { 'data-fh': '' } : {})}>
                  <input type="radio" name="export-target" checked={t.id === target} disabled={!t.available} onChange={() => setTarget(t.id)} />
                  <span className="ellipsis">{t.label}</span>
                  <span className="count">{t.available ? t.format : t.reason}</span>
                </label>
              ))}
            </HoverList>
          </div>
        )}
        <div className="export-detail">
          <div><div className="eyebrow">Se lleva</div><ul>{cur.carries.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div><div className="eyebrow">No se lleva</div><ul>{cur.loses.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div><div className="eyebrow">Después, en el programa</div><div style={{ color: 'var(--text-2)', marginTop: 4 }}>{cur.how_to_load}</div></div>
        </div>
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
        {cur.id === 'rekordbox' && (
          <>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', lineHeight: 1.45 }}>
            <input type="checkbox" checked={withCues} onChange={(e) => setWithCues(e.target.checked)} style={{ marginTop: 2 }} />
            <span>Llevar cues y grilla <b style={{ color: 'var(--accent)' }}>(en prueba)</b><br />
              <span className="muted" style={{ fontSize: 12 }}>Para los temas que ya están en rekordbox, escribe en el archivo su grilla y todas sus cues, así no se pierde nada si rekordbox los pisa al importar. Probalo primero con una playlist chica y con un respaldo hecho.</span>
              {withCues && cuesXml === false && <span style={{ display: 'block', fontSize: 12, color: 'var(--accent)', marginTop: 4 }}>Todavía no trajiste el XML de rekordbox, así que los temas de rekordbox saldrían sin grilla. Traelo en Ajustes → Programas.</span>}</span>
          </label>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', lineHeight: 1.45 }}>
            <input type="checkbox" checked={keepPrevious} onChange={(e) => setKeepPrevious(e.target.checked)} style={{ marginTop: 2 }} />
            <span>Mantener las cajas que ya exporté antes<br />
              <span className="muted" style={{ fontSize: 12 }}>rekordbox lee un solo archivo y cada exportación lo reescribe. Con esto el archivo lleva también las anteriores; sin esto, solo las que elegiste ahora.</span></span>
          </label>
        </>
        )}
        {cur.id === 'rekordbox' && (
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', lineHeight: 1.45 }}>
            <input type="checkbox" checked={tagsInComment} onChange={(e) => setTagsInComment(e.target.checked)} style={{ marginTop: 2 }} />
            <span>Agregar mis etiquetas al comentario (<span className="mono">#intro-larga #acapella…</span>)<br />
              <span className="muted" style={{ fontSize: 12 }}>Sirve para verlas y buscarlas en el CDJ. Solo se aplica a temas que rekordbox importe desde el XML.</span></span>
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" onClick={() => setExportOpen(false)}>Cancelar</button>
          <button className="btn primary" disabled={!sel.size || busy || !cur.available} onClick={go}>
            {busy ? 'Exportando…' : `Exportar ${sel.size} ${sel.size === 1 ? 'caja' : 'cajas'}`}
          </button>
        </div>
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
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? ''}${t.action ? ' has-action' : ''}${t.leaving ? ' leaving' : ''}`}>
          <span className="toast-path">{t.text}</span>
          {t.action && <button onClick={t.action.run}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  )
}

export function Player() {
  const { track, playing, time, duration, toggle, volume, setVolume, error, preparing } = usePlayer()
  const select = useApp((s) => s.select)
  const openMixPicker = useApp((s) => s.openMixPicker)
  const wave = useWaveform(track?.id)
  const lastVol = useRef(0.8)
  return (
    <div className="player">
      <div className="now">
        {track ? (
          <>
            <button className="thumb" onClick={() => select(track.id)} aria-label="Ver la ficha del tema"><Sleeve id={track.id} title={track.title} trackKey={track.key} hasArt={track.has_art} size="s" px={42} /></button>
            <div style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600 }}>
                <button className="artist-link" title="Ver la ficha del tema" onClick={() => select(track.id)}>{cleanTitle(track.title)}</button>
              </div>
              <div className="ellipsis muted" style={{ fontSize: 11.5 }}>{error ?? <ArtistLinks artist={track.artist} />}</div>
            </div>
          </>
        ) : <span className="faint" style={{ fontSize: 12, paddingLeft: 6 }}>Doble click en un disco para escucharlo</span>}
      </div>
      <div className="ctrl">
        <button className="playbtn" disabled={!track} onClick={toggle} aria-label={playing ? 'Pausar' : 'Reproducir'} title={playing ? 'Pausar (espacio)' : 'Reproducir (espacio)'}>
          <GlyphSwap on={playing} a={<IconPlay size={15} />} b={<IconPause size={15} />} />
        </button>
        <span className="num muted" style={{ fontSize: 11, width: 36, textAlign: 'right' }} title={preparing ? 'Preparando el audio para saltar a la posición exacta…' : undefined}>{preparing ? '…' : fmtTime(time)}</span>
        <div className="pwave">
          <LiveWaveform track={track} data={track ? wave : null} introBars={track?.intro_bars} outroBars={track?.outro_bars} />
        </div>
        <span className="num muted" style={{ fontSize: 11, width: 36 }}>{fmtTime(duration || track?.duration)}</span>
        <button className="btn ghost sm" disabled={!track} title="Probar mezcla con otro tema (M)" onClick={() => track && openMixPicker(track.id)}><IconMix size={13} /> Mezclar con…</button>
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
