import { artistCrate } from './Artist'
import { Seg } from '../lib/Seg'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { Filters, Track } from '../types'
import { plural } from '../util'
import { BatchBar } from './BatchBar'
import { Digger } from './Digger'
import { FilterBar } from './FilterBar'
import { folderCrate } from './FolderTree'
import { IconCrate, IconExport, IconGrid, IconList, IconTag } from './icons'
import { ListView, sortTracks, type PickFn, type SortKey } from './ListView'
import { Wall } from './Wall'

type Mode = 'dig' | 'wall' | 'list'

function loadMode(): Mode {
  try { return (localStorage.getItem('batea.mode') as Mode) || 'dig' } catch { return 'dig' }
}

const KIND_LABEL: Record<string, string> = {
  playlist: 'Playlist de rekordbox', folder: 'Carpeta de rekordbox', smart_rb: 'Smart playlist de rekordbox',
  dir: 'Carpeta', artist: 'Artista', session: 'Sesión del historial', session_folder: 'Historial', user: 'Caja tuya', smart: 'Caja inteligente', virtual: 'Atajo',
}

export function CrateView() {
  const { crateId, crates, virtualCrates, folders, libraryVersion, loadMeta, go, toast, setExportOpen, askText, openTagger, analyzeTracks, analysisQueue } = useApp()
  const dir = useMemo(() => folderCrate(crateId, folders), [crateId, folders])
  const crate = useMemo(() => dir ?? artistCrate(crateId) ?? [...virtualCrates, ...crates].find((c) => String(c.id) === crateId), [dir, crateId, crates, virtualCrates])
  const [mode, setMode] = useState<Mode>(loadMode)
  const [filters, setFilters] = useState<Filters>({})
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(['position', 1])

  const [multi, setMulti] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)

  const filterPreset = useApp((s) => s.filterPreset)
  const backStack = useApp((s) => s.backStack)
  const goBack = useApp((s) => s.goBack)
  useEffect(() => { useApp.setState({ viewFilters: filters }) }, [filters])
  useEffect(() => {
    setFilters(filterPreset && filterPreset.crateId === crateId ? filterPreset.filters : {})
    setSort(['position', 1]); setMulti(new Set())
  }, [crateId, filterPreset?.seq]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem('batea.mode', mode) } catch { /* sin storage */ } }, [mode])
  useEffect(() => {
    let alive = true
    api.tracks(crateId, filters).then((t) => alive && setTracks(t)).catch((e) => toast(e.message, 'error'))
    return () => { alive = false }
  }, [crateId, filters, libraryVersion, toast])

  const lastPatch = useApp((s) => s.lastPatch)
  useEffect(() => {
    if (!lastPatch) return
    setTracks((ts) => ts && ts.map((t) => (t.id === lastPatch.id ? { ...t, ...lastPatch } : t)))
  }, [lastPatch])

  // etiquetas: cuántos de los temas que se están viendo (esta caja o carpeta, con los filtros puestos) tienen cada una
  const tagCounts = useMemo(() => {
    const m = new Map<number, number>()
    for (const t of tracks ?? []) for (const id of t.tags) m.set(id, (m.get(id) ?? 0) + 1)
    return m
  }, [tracks])
  const sorted = useMemo(() => (tracks ? sortTracks(tracks, sort[0], sort[1]) : []), [tracks, sort])
  const stats = useMemo(() => {
    if (!tracks?.length) return null
    const bpms = tracks.map((t) => t.bpm).filter(Boolean) as number[]
    bpms.sort((a, b) => a - b)
    const offline = tracks.filter((t) => !t.online).length
    return { min: bpms[0], max: bpms[bpms.length - 1], med: bpms[Math.floor(bpms.length / 2)], offline }
  }, [tracks])
  // temas fuera de rekordbox que faltan analizar (y no están ya en la fila)
  const pending = useMemo(() => {
    const inQueue = new Set([analysisQueue.now, ...analysisQueue.ids])
    return (tracks ?? []).filter((t) => t.unanalyzed === 'pending' && t.online && !inQueue.has(t.id)).map((t) => t.id)
  }, [tracks, analysisQueue])

  // selección múltiple: ⌘+click suma o quita, ⇧+click selecciona el rango, ⌘A todo
  const pick: PickFn = useCallback((t, index, e) => {
    if (e.metaKey || e.ctrlKey) {
      setMulti((m) => { const n = new Set(m); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n })
      anchor.current = index
      return true
    }
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)]
      setMulti((m) => { const n = new Set(m); for (const x of sorted.slice(a, b + 1)) n.add(x.id); return n })
      return true
    }
    anchor.current = index
    setMulti((m) => (m.size ? new Set() : m))
    return false
  }, [sorted])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && mode !== 'dig') {
        e.preventDefault()
        setMulti(new Set(sorted.map((t) => t.id)))
      }
      if (e.key === 'Escape') setMulti((m) => (m.size ? new Set() : m))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sorted, mode])

  const selected = useMemo(() => (multi.size ? sorted.filter((t) => multi.has(t.id)) : []), [sorted, multi])

  if (!crate) return <div className="empty"><h3>Caja no encontrada</h3></div>
  const editable = crate.kind === 'user' || crate.kind === 'smart'

  const saveSmart = async () => {
    const name = await askText('Nombre de la caja inteligente', crate.kind === 'virtual' ? '' : `${crate.name} · filtrada`)
    if (!name) return
    const base: Filters = crate.kind === 'smart' ? { ...(crate.query ?? {}) } : {}
    const { id } = await api.createCrate(name, { query: { ...base, ...filters } })
    await loadMeta()
    toast(`Caja inteligente “${name}” creada`)
    go('crate', String(id))
  }

  return (
    <div className="crateview">
      <header className="viewhead">
        {backStack.length > 0 && (
          <button className="btn ghost sm back-btn" onClick={goBack} title="Volver a donde estabas (⌘[)">← Volver</button>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow ellipsis" style={{ marginBottom: 6 }} title={dir?.path}>
            {KIND_LABEL[crate.kind] ?? ''}{crate.date ? ` · ${crate.date}` : ''}{dir?.trail.length ? ` · ${dir.trail.join(' › ')}` : ''}
          </div>
          <h1 className="ellipsis">{crate.name}</h1>
          {/* subtítulos de vista: cuántos temas y como mucho un dato más; nada de instrucciones */}
          <div className="sub">
            {tracks ? plural(tracks.length, 'tema', 'temas') : 'Cargando…'}
            {stats && stats.min ? ` · ${Math.round(stats.min)} a ${Math.round(stats.max)} BPM` : ''}
          </div>
        </div>
        <div className="spacer" />
        {pending.length > 0 && (
          <button className="btn sm" title="Calcula BPM, tono y energía" onClick={() => analyzeTracks(pending)}>Analizar {pending.length} pendientes</button>
        )}
        {editable && (
          <>
            <button className="btn ghost sm" onClick={async () => {
              const name = await askText('Nuevo nombre', crate.name)
              if (name) { await api.patchCrate(crate.id, { name }); loadMeta() }
            }}>Renombrar</button>
            <button className="btn ghost sm" onClick={async () => {
              if (!confirm(`¿Borrar la caja “${crate.name}”? Los temas no se borran.`)) return
              await api.deleteCrate(crate.id); await loadMeta(); go('home')
            }}>Borrar</button>
          </>
        )}
        {dir && (
          <button className="btn ghost sm" disabled={dir.off} title={dir.off ? 'El disco está desconectado' : dir.path}
            onClick={() => api.revealFolder(dir.path).catch((e) => toast((e as Error).message, 'error'))}>Mostrar en Finder</button>
        )}
        <button className="btn sm" onClick={() => setExportOpen(true)} title="Crea un archivo que rekordbox importa como playlist"><IconExport size={14} /> Exportar a rekordbox</button>
      </header>
      <div className="toolbar">
        <FilterBar filters={filters} onChange={setFilters} onSaveSmart={saveSmart} counts={tagCounts} />
        <div className="grow" />
        <button className="btn sm" disabled={!sorted.length} onClick={() => openTagger(sorted, crate.name)} title="Etiquetar estos temas con el teclado"><IconTag size={13} /> Etiquetar en tanda</button>
        <Seg role="tablist">
          <button className={mode === 'dig' ? 'on' : ''} onClick={() => setMode('dig')} title="Hojear como en una batea" aria-label="Hojear como en una batea"><IconCrate size={14} /></button>
          <button className={mode === 'wall' ? 'on' : ''} onClick={() => setMode('wall')} title="Pared de carátulas" aria-label="Pared de carátulas"><IconGrid size={14} /></button>
          <button className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')} title="Lista" aria-label="Lista"><IconList size={14} /></button>
        </Seg>
      </div>
      {tracks === null ? <div className="empty">Cargando discos…</div> :
        mode === 'dig' ? <Digger key={`${crateId}|${JSON.stringify(filters)}|${sort.join()}`} tracks={sorted} crateName={crate.name} /> :
        mode === 'wall' ? <Wall tracks={sorted} multi={multi} onPick={pick} /> :
        <ListView tracks={sorted} sort={sort} onSort={setSort} multi={multi} onPick={pick} />}
      {selected.length > 0 && mode !== 'dig' && <BatchBar tracks={selected} onClear={() => setMulti(new Set())} />}
    </div>
  )
}
