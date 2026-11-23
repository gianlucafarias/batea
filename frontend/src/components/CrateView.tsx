import { artistCrate } from './Artist'
import { Seg } from '../lib/Seg'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { crateSource, sourceLabel } from '../sources'
import { useApp } from '../store'
import type { Filters, Track } from '../types'
import { plural } from '../util'
import { BatchBar } from './BatchBar'
import { Digger } from './Digger'
import { FilterBar } from './FilterBar'
import { folderCrate } from './FolderTree'
import { IconChart, IconCrate, IconExport, IconGrid, IconList, IconTag } from './icons'
import { SetChart } from './SetChart'
import { ListView, sortTracks, type PickFn, type SortKey } from './ListView'
import { Wall } from './Wall'

type Mode = 'dig' | 'wall' | 'list'

const SORT_KEYS: SortKey[] = ['position', 'title', 'artist', 'bpm', 'key', 'energy', 'rating', 'date_added', 'intro_bars', 'play_count', 'duration']

/** El orden elegido se recuerda entre cajas y entre sesiones. */
function loadSort(): [SortKey, 1 | -1] {
  try {
    const raw = JSON.parse(localStorage.getItem('batea.sort') ?? 'null')
    if (Array.isArray(raw) && SORT_KEYS.includes(raw[0]) && (raw[1] === 1 || raw[1] === -1)) return [raw[0], raw[1]]
  } catch { /* sin storage o valor roto */ }
  return ['position', 1]
}

function loadMode(): Mode {
  try { return (localStorage.getItem('batea.mode') as Mode) || 'dig' } catch { return 'dig' }
}

const KIND_LABEL: Record<string, string> = {
  playlist: 'Playlist', folder: 'Carpeta', smart_rb: 'Caja inteligente',
  dir: 'Carpeta', artist: 'Artista', session: 'Sesión del historial', session_folder: 'Historial', user: 'Caja tuya', smart: 'Caja inteligente', virtual: 'Atajo',
}

export function CrateView() {
  const { crateId, crates, virtualCrates, folders, libraryVersion, loadMeta, go, toast, setExportOpen, askText, openTagger, analyzeTracks, analysisQueue } = useApp()
  const dir = useMemo(() => folderCrate(crateId, folders), [crateId, folders])
  const crate = useMemo(() => dir ?? artistCrate(crateId) ?? [...virtualCrates, ...crates].find((c) => String(c.id) === crateId), [dir, crateId, crates, virtualCrates])
  const [mode, setModeState] = useState<Mode>(loadMode)
  // El gráfico se abre a pedido y no se recuerda: al elegir otra vista se cierra
  const [chart, setChart] = useState(false)
  const setMode = useCallback((m: Mode) => { setModeState(m); setChart(false) }, [])
  const [filters, setFilters] = useState<Filters>({})
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [sort, setSortState] = useState<[SortKey, 1 | -1]>(loadSort)
  const setSort = useCallback((s: [SortKey, 1 | -1]) => {
    setSortState(s)
    try { localStorage.setItem('batea.sort', JSON.stringify(s)) } catch { /* sin storage */ }
  }, [])

  const [multi, setMulti] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)

  const filterPreset = useApp((s) => s.filterPreset)
  const backStack = useApp((s) => s.backStack)
  const goBack = useApp((s) => s.goBack)
  useEffect(() => { useApp.setState({ viewFilters: filters }) }, [filters])
  useEffect(() => {
    setFilters(filterPreset && filterPreset.crateId === crateId ? filterPreset.filters : {})
    setMulti(new Set())
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
  // Temas propios que faltan analizar y no están en la fila.
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

  // Reordenar a mano: en tus cajas y en playlists importadas, con el orden de la caja y sin filtros que escondan temas
  const reorderable = (crate?.kind === 'user' || crate?.kind === 'playlist') && sort[0] === 'position' && sort[1] === 1
  const reorder = useCallback((ids: number[]) => {
    if (!crate) return
    const before = tracks
    const byId = new Map((tracks ?? []).map((t) => [t.id, t]))
    setTracks(ids.map((id) => byId.get(id)).filter((t): t is Track => !!t))
    api.reorderCrate(Number(crate.id), ids).catch((e) => { setTracks(before); toast((e as Error).message, 'error') })
  }, [crate, tracks, toast])

  // desde el gráfico: sumar un tema puente o cambiar uno, en tu caja y en el orden que se ve
  const insertAt = useCallback(async (index: number, tid: number) => {
    if (!crate) return
    const ids = (tracks ?? []).map((t) => t.id)
    ids.splice(index, 0, tid)
    try {
      await api.addToCrate(crate.id, [tid])
      await api.reorderCrate(Number(crate.id), ids)
      toast(`Agregado como tema ${index + 1}`)
    } catch (e) { toast((e as Error).message, 'error') }
    useApp.getState().bump(); void loadMeta()
  }, [crate, tracks, toast, loadMeta])
  const replaceAt = useCallback(async (index: number, tid: number) => {
    if (!crate) return
    const old = (tracks ?? [])[index]
    const ids = (tracks ?? []).map((t) => t.id)
    ids[index] = tid
    try {
      await api.addToCrate(crate.id, [tid])
      await api.removeFromCrate(crate.id, old.id)
      await api.reorderCrate(Number(crate.id), ids)
      toast(`Cambiado: sale ${old.title ?? 'el tema'}`)
    } catch (e) { toast((e as Error).message, 'error') }
    useApp.getState().bump(); void loadMeta()
  }, [crate, tracks, toast, loadMeta])
  const duplicate = useCallback(async () => {
    if (!crate) return
    try {
      const { id } = await api.duplicateCrate(crate.id)
      await loadMeta()
      go('crate', String(id))
      toast('Copia creada en tus cajas: acá podés agregar y cambiar temas')
    } catch (e) { toast((e as Error).message, 'error') }
  }, [crate, loadMeta, go, toast])

  // sesión del historial: el gráfico sigue lo que sonó, en orden y con los temas que volviste a poner
  const [plays, setPlays] = useState<number[] | null>(null)
  const isSession = crate?.kind === 'session'
  useEffect(() => {
    setPlays(null)
    if (!chart || !isSession) return
    let alive = true
    api.sessionPlays(crateId!).then((r) => alive && setPlays(r.ids)).catch(() => { /* sin secuencia: se usa la lista */ })
    return () => { alive = false }
  }, [chart, isSession, crateId, libraryVersion])
  // El gráfico sigue SIEMPRE el orden real (el de la caja, o en una sesión lo que sonó), no la columna por la que
  // esté ordenada la lista: ordenar la lista por fecha o BPM y ver eso como "el set" no tiene sentido.
  // La API ya devuelve los temas en el orden de la caja.
  const chartTracks = useMemo(() => {
    if (!isSession || !plays?.length) return tracks ?? []
    const byId = new Map((tracks ?? []).map((t) => [t.id, t]))
    return plays.map((id) => byId.get(id)).filter((t): t is Track => !!t)
  }, [isSession, plays, tracks])

  const selected = useMemo(() => (multi.size ? sorted.filter((t) => multi.has(t.id)) : []), [sorted, multi])

  if (!crate) return <div className="empty"><h3>Caja no encontrada</h3></div>
  const source = crateSource(crate)
  const program = source && source !== 'user' ? sourceLabel(source) : null
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
            {KIND_LABEL[crate.kind] ?? ''}{program ? ` · ${program}` : ''}{crate.date ? ` · ${crate.date}` : ''}{dir?.trail.length ? ` · ${dir.trail.join(' › ')}` : ''}
          </div>
          <h1 className="ellipsis">{crate.name}</h1>
          {/* subtítulos de vista: cuántos temas y como mucho un dato más; nada de instrucciones */}
          <div className="sub">
            {source === 'traktor' && crate.kind === 'smart_rb' && crate.count === 0 ? 'Las reglas de Traktor se evalúan en Traktor.' : tracks ? plural(tracks.length, 'tema', 'temas') : 'Cargando…'}
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
        <button className="btn sm" onClick={() => setExportOpen(true)} title="Elegí a qué programa exportar las cajas"><IconExport size={14} /> Exportar</button>
      </header>
      <div className="toolbar">
        <FilterBar filters={filters} onChange={setFilters} onSaveSmart={saveSmart} counts={tagCounts} />
        <div className="grow" />
        {(crate.kind === 'user' || crate.kind === 'playlist' || crate.kind === 'session') && mode === 'list' && !chart && (sort[0] !== 'position' || sort[1] !== 1) &&
          <button className="btn ghost sm" onClick={() => setSort(['position', 1])} title="Para arrastrar los temas y ordenarlos a mano">Orden de la caja</button>}
        <button className="btn sm" disabled={!sorted.length} onClick={() => openTagger(sorted, crate.name)} title="Etiquetar estos temas con el teclado"><IconTag size={13} /> Etiquetar en tanda</button>
        <button className={`btn sm${chart ? ' primary' : ''}`} disabled={!chart && sorted.length < 2} aria-pressed={chart}
          onClick={() => setChart((v) => !v)} title="Energía, BPM y tono de cada tema en el orden de la lista, y qué conviene revisar">
          <IconChart size={14} /> {chart ? 'Cerrar gráfico' : 'Ver gráfico'}
        </button>
        <Seg role="tablist">
          <button className={!chart && mode === 'dig' ? 'on' : ''} onClick={() => setMode('dig')} title="Hojear como en una batea" aria-label="Hojear como en una batea"><IconCrate size={14} /></button>
          <button className={!chart && mode === 'wall' ? 'on' : ''} onClick={() => setMode('wall')} title="Pared de carátulas" aria-label="Pared de carátulas"><IconGrid size={14} /></button>
          <button className={!chart && mode === 'list' ? 'on' : ''} onClick={() => setMode('list')} title="Lista" aria-label="Lista"><IconList size={14} /></button>
        </Seg>
      </div>
      {tracks === null ? <div className="empty">Cargando discos…</div> :
        chart ? <SetChart tracks={chartTracks} orderNote={null} session={isSession}
          repeats={isSession && plays?.length ? chartTracks.length - new Set(chartTracks.map((t) => t.id)).size : 0}
          onReorder={crate.kind === 'user' || crate.kind === 'playlist' ? reorder : undefined}
          onInsert={crate.kind === 'user' ? insertAt : undefined}
          onReplace={crate.kind === 'user' ? replaceAt : undefined}
          onDuplicate={crate.kind !== 'user' && crate.kind !== 'smart' && crate.kind !== 'virtual' && crate.kind !== 'dir' && crate.kind !== 'artist' ? duplicate : undefined} /> :
        mode === 'dig' ? <Digger key={`${crateId}|${JSON.stringify(filters)}|${sort.join()}`} tracks={sorted} crateName={crate.name} /> :
        mode === 'wall' ? <Wall tracks={sorted} multi={multi} onPick={pick} /> :
        <ListView tracks={sorted} sort={sort} onSort={setSort} multi={multi} onPick={pick} onReorder={reorderable ? reorder : undefined} />}
      {selected.length > 0 && mode !== 'dig' && !chart && <BatchBar tracks={selected} onClear={() => setMulti(new Set())} />}
    </div>
  )
}
