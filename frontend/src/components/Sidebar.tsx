import { useMemo, useState } from 'react'
import { api } from '../api'
import { CORE_SOURCES, crateSource, isQueuedJob, isSessionCrate, sourceLabel } from '../sources'
import { useApp } from '../store'
import type { Crate } from '../types'
import { fmtDate } from '../util'
import { BrandMark, IconChevron, IconCrate, IconExport, IconEye, IconEyeOff, IconInbox, IconMap, IconPlus, IconTag } from './icons'
import { FolderTree } from './FolderTree'
import { Sources } from './Sources'
import { UniverseSwitcher } from './Universe'
import { useFluidHover } from '../lib/fluidHover'

function Tree({ nodes, all, depth, showHidden, empty }: { nodes: Crate[]; all: Crate[]; depth: number; showHidden: boolean; empty: Set<number | string> }) {
  const { crateId, view, go, loadMeta } = useApp()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <>
      {nodes.filter((n) => (showHidden || !n.hidden) && !empty.has(n.id)).map((n) => {
        const kids = all.filter((c) => c.parent_id === n.id)
        const isFolder = n.kind === 'folder' || n.kind === 'session_folder'
        const isOpen = open[n.id] ?? false
        const activate = () => isFolder ? setOpen({ ...open, [n.id]: !isOpen }) : go('crate', String(n.id))
        return (
          <div key={n.id}>
            <div
              role="button"
              tabIndex={0}
              data-fh
              className={`tree-row${view === 'crate' && crateId === String(n.id) ? ' on' : ''}${n.hidden ? ' hidden-crate' : ''}`}
              style={{ paddingLeft: 10 + depth * 12 }}
              aria-expanded={isFolder ? isOpen : undefined}
              onClick={activate}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                activate()
              }}
              onDoubleClick={() => isFolder && go('crate', String(n.id))}
            >
              {isFolder ? <IconChevron size={12} className={`caret${isOpen ? ' open' : ''}`} /> : <span style={{ width: 12 }} />}
              <span className="ellipsis" title={n.kind === 'session' && n.date ? n.date : undefined}>{n.name}</span>
              {n.kind === 'session' && n.date && !n.name.includes(n.date) && <span className="tree-date num faint">{fmtDate(n.date)}</span>}
              {!isFolder && <span className="count">{n.count}</span>}
              <button
                className="eye"
                title={n.hidden ? 'Mostrar' : 'Ocultar de Batea'}
                aria-label={n.hidden ? `Mostrar ${n.name}` : `Ocultar ${n.name} de Batea`}
                onClick={async (e) => { e.stopPropagation(); await api.patchCrate(n.id, { hidden: !n.hidden }); loadMeta() }}
              >
                {n.hidden ? <IconEye size={13} /> : <IconEyeOff size={13} />}
              </button>
            </div>
            {isFolder && isOpen && <Tree nodes={kids} all={all} depth={depth + 1} showHidden={showHidden} empty={empty} />}
          </div>
        )
      })}
    </>
  )
}

function ProgramTree({ kind, crates, empty }: { kind: string; crates: Crate[]; empty: Set<number | string> }) {
  const [showHidden, setShowHidden] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const playlists = crates.filter((crate) => !isSessionCrate(crate))
  const sessions = crates.filter(isSessionCrate)
  const roots = playlists.filter((crate) => crate.parent_id == null)
  const sessionIds = new Set(sessions.map((crate) => crate.id))
  const sessionRoots = sessions
    .filter((crate) => crate.parent_id == null || !sessionIds.has(crate.parent_id))
    .sort((a, b) => b.name.localeCompare(a.name))
  const hiddenCount = crates.filter((crate) => crate.hidden).length

  return (
    <>
      <div className="side-h">
        <span className="eyebrow">{sourceLabel(kind)}</span>
        {hiddenCount > 0 && (
          <button className="faint" style={{ fontSize: 11 }} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? 'ocultar' : `+${hiddenCount} ocultas`}
          </button>
        )}
      </div>
      <Tree nodes={roots} all={playlists} depth={0} showHidden={showHidden} empty={empty} />
      {sessionRoots.length > 0 && (
        <>
          <div className="side-h side-history">
            <button className="eyebrow" aria-expanded={showSessions} onClick={() => setShowSessions(!showSessions)}>
              Historial de sesiones {showSessions ? '−' : '+'}
            </button>
          </div>
          {showSessions && <Tree nodes={sessionRoots} all={sessions} depth={0} showHidden={showHidden} empty={empty} />}
        </>
      )}
    </>
  )
}

export function Sidebar() {
  const { view, crateId, go, crates, virtualCrates, jobs, status, toast, setExportOpen, setAgentsOpen, loadMeta, openTagger, update } = useApp()
  const [showFolders, setShowFolders] = useState(true)
  const navHover = useFluidHover<HTMLElement>()
  const listHover = useFluidHover<HTMLDivElement>()

  const mine = crates.filter((c) => c.kind === 'user' || c.kind === 'smart')
  const programs = useMemo(() => {
    const bySource = new Map<string, Crate[]>()
    for (const crate of crates) {
      const kind = crateSource(crate)
      if (!kind || kind === 'user') continue
      const group = bySource.get(kind)
      if (group) group.push(crate)
      else bySource.set(kind, [crate])
    }
    return [...bySource].sort(([a], [b]) => {
      const index = (source: string) => {
        const i = CORE_SOURCES.findIndex((kind) => kind === source)
        return i === -1 ? CORE_SOURCES.length : i
      }
      return index(a) - index(b)
    })
  }, [crates])
  const running = jobs.filter((j) => j.status === 'running' && !isQueuedJob(j))

  // Con un universo activo, las cajas (y carpetas) que quedan vacías no se muestran
  const empty = useMemo(() => {
    const out = new Set<number | string>()
    if (!status?.universe) return out
    const kids = new Map<number | string, Crate[]>()
    for (const c of crates) if (c.parent_id != null) kids.set(c.parent_id, [...(kids.get(c.parent_id) ?? []), c])
    const has = (c: Crate): boolean => {
      const isFolder = c.kind === 'folder' || c.kind === 'session_folder'
      const any = isFolder ? (kids.get(c.id) ?? []).map(has).some(Boolean) : c.count > 0
      if (!any && c.kind !== 'user' && c.kind !== 'smart') out.add(c.id)
      return any
    }
    for (const c of crates) if (c.parent_id == null) has(c)
    return out
  }, [crates, status?.universe])

  const newCrate = async () => {
    const name = await useApp.getState().askText('Nombre de la caja nueva')
    if (!name) return
    const { id } = await api.createCrate(name)
    await loadMeta()
    go('crate', String(id))
  }

  const startTagging = async () => {
    try {
      const tracks = await api.tracks('inbox')
      openTagger(tracks, 'Sin clasificar')
    } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <aside className="sidebar">
      <div className="brand"><BrandMark /><span className="brand-name">batea</span></div>
      <UniverseSwitcher />
      <nav className="nav" ref={navHover.ref}>
        {navHover.highlight}
        <button data-fh className={view === 'home' ? 'on' : ''} onClick={() => go('home')}><IconCrate /> Bateas</button>
        <button data-fh className={view === 'map' ? 'on' : ''} onClick={() => go('map')}><IconMap /> Mapa</button>
        <button data-fh className={view === 'tagger' ? 'on' : ''} onClick={startTagging} title="Etiquetar con el teclado los temas sin clasificar">
          <IconTag /> Etiquetar
          {status?.inbox ? <span className="count">{status.inbox.toLocaleString('es-AR')}</span> : null}
        </button>
        <button data-fh className={view === 'inbox' ? 'on' : ''} onClick={() => go('inbox')}>
          <IconInbox /> Analizar e importar
          {status?.local ? <span className="count">{status.local}</span> : null}
        </button>
      </nav>

      <div className="side-scroll" ref={listHover.ref}>
        {listHover.highlight}
        <div className="side-h"><span className="eyebrow">Atajos</span></div>
        {virtualCrates.filter((c) => c.id !== 'hidden' || c.count > 0).map((c) => (
          <div key={c.id} role="button" tabIndex={0} data-fh className={`tree-row${view === 'crate' && crateId === c.id ? ' on' : ''}`} onClick={() => go('crate', String(c.id))}>
            <span style={{ width: 12 }} /><span className="ellipsis">{c.name}</span><span className="count">{c.count.toLocaleString('es-AR')}</span>
          </div>
        ))}

        <div className="side-h">
          <span className="eyebrow">Mis cajas</span>
          <button className="btn ghost sm icon" title="Nueva caja" aria-label="Nueva caja" onClick={newCrate}><IconPlus size={14} /></button>
        </div>
        {mine.length === 0 && <div className="faint" style={{ padding: '2px 10px 6px 32px', fontSize: 11.5 }}>Creá cajas propias o guardá un filtro como caja inteligente.</div>}
        {mine.map((c) => (
          <div key={c.id} role="button" tabIndex={0} data-fh className={`tree-row${view === 'crate' && crateId === String(c.id) ? ' on' : ''}`} onClick={() => go('crate', String(c.id))}>
            <span style={{ width: 12 }} />
            <span className="ellipsis">{c.name}</span><span className="count">{c.count}</span>
          </div>
        ))}

        <div className="side-h">
          <button className="eyebrow" onClick={() => setShowFolders(!showFolders)} title="Carpetas con música en tu Mac y tus discos">
            Carpetas {showFolders ? '−' : '+'}
          </button>
        </div>
        {showFolders && <FolderTree />}

        {programs.map(([kind, group]) => <ProgramTree key={kind} kind={kind} crates={group} empty={empty} />)}
      </div>

      <div className="side-foot">
        {running.length > 0 && (
          <div className="side-jobs">
            {running.map((j) => (
              <div className="job" key={j.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <b className="ellipsis">{j.label}</b>
                  {['keys', 'analyze', 'discover'].includes(j.kind) && <button className="faint" onClick={() => api.cancelJob(j.id)}>detener</button>}
                </div>
                <div className="muted ellipsis">{j.message}</div>
                <div className="bar"><i style={{ ['--p' as string]: j.progress }} /></div>
              </div>
            ))}
          </div>
        )}
        <div className="side-actions">
          <Sources />
          <button className="btn sm" onClick={() => setExportOpen(true)} title="Exportar cajas a rekordbox, Traktor, Serato o M3U"><IconExport size={14} /> Exportar</button>
        </div>
        <button className="btn sm ghost" onClick={() => setAgentsOpen(true)} title="Usar tu librería desde Claude, Codex, Cursor…">
          Conectar con agentes de IA
        </button>
        <button className="btn sm ghost" onClick={() => useApp.getState().setWelcome('replay')} title="Volver a ver la presentación">
          Ver la presentación
        </button>
        {update?.update_available && (
          <button className="btn sm ghost" onClick={() => { void api.openUpdate().catch(() => {}) }} title={update.notes || 'Abrir la descarga'}>
            Hay una versión nueva ({update.latest}) · Descargar
          </button>
        )}
      </div>
    </aside>
  )
}
