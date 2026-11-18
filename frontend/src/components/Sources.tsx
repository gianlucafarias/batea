import { useEffect, useRef, useState } from 'react'
import { api, isNotFound, type LibrarySource } from '../api'
import { spring, usePresence } from '../lib/motion'
import { crateSource, isActiveJob, isQueuedJob, legacyRekordbox, pickSourcePath, sourceName, syncJobSource, syncSource } from '../sources'
import { useApp } from '../store'
import type { Job } from '../types'
import { IconPlus, IconSync } from './icons'

const DISMISSED_KEY = 'batea.sources.dismissed'
const relativeTime = new Intl.RelativeTimeFormat('es-AR', { style: 'short' })

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((kind): kind is string => typeof kind === 'string') : []
  } catch { return [] }
}

function sourceStatus(source: LibrarySource): string {
  if (!source.found) return 'No encontrado'
  if (source.app_running) return `Datos del último guardado · ${source.label} está abierto`
  const time = source.last_sync ? new Date(source.last_sync).getTime() : NaN
  if (!Number.isFinite(time)) return source.detail || 'Todavía sin sincronizar'
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000))
  if (minutes === 0) return 'Sincronizado recién'
  const since = minutes < 60 ? relativeTime.format(-minutes, 'minute')
    : minutes < 1440 ? relativeTime.format(-Math.floor(minutes / 60), 'hour')
      : relativeTime.format(-Math.floor(minutes / 1440), 'day')
  return `Sincronizado ${since}`
}

export function Sources() {
  const { status, jobs, trackJob, loadMeta, refreshSources, updateSource, bump, toast, sourcesOpen, setSourcesOpen } = useApp()
  const legacy = !status?.sources
  const sources = status?.sources ?? [legacyRekordbox(status)]
  const enabled = sources.filter((source) => source.enabled)
  const foundInactive = sources.filter((source) => source.found && !source.enabled)
  const savedInactive = sources.filter((source) => !source.found && !source.enabled && (source.last_sync || source.locations.length))
  const syncing = new Map<string, Job>()
  for (const job of jobs) {
    const kind = syncJobSource(job)
    if (kind && isActiveJob(job)) syncing.set(kind, job)
  }
  const [pending, setPending] = useState(false)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [shown, closing] = usePresence(sourcesOpen, spring.moderate.exit)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const notice = foundInactive.find((source) => !dismissed.includes(source.kind))

  useEffect(() => {
    if (legacy) return
    const refresh = () => { void refreshSources().catch(() => undefined) }
    const interval = window.setInterval(refresh, 15000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [legacy, refreshSources])

  useEffect(() => {
    if (!sourcesOpen) return
    if (!root.current?.contains(document.activeElement)) trigger.current?.focus()
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setSourcesOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSourcesOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [sourcesOpen, setSourcesOpen])

  const run = async (action: () => Promise<void>) => {
    setPending(true)
    try { await action() } catch (error) { toast((error as Error).message, 'error') } finally { setPending(false) }
  }

  const dismiss = (kind: string) => {
    if (dismissed.includes(kind)) return
    const next = [...dismissed, kind]
    setDismissed(next)
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)) } catch { /* sin storage */ }
  }

  const toggleSource = (source: LibrarySource) => run(async () => {
    const result = await api.setSourceEnabled(source.kind, !source.enabled)
    if (!result.enabled) {
      dismiss(source.kind)
      const app = useApp.getState()
      if (app.view === 'crate' && app.crates.some((crate) => String(crate.id) === app.crateId && crateSource(crate) === source.kind)) app.go('home')
    }
    updateSource({ ...source, enabled: result.enabled })
    setMenu(null)
    try {
      if (result.enabled && source.found) trackJob(await syncSource(source.kind))
    } finally {
      await loadMeta().catch(() => undefined)
      bump()
    }
  })

  const locate = (source: LibrarySource) => run(async () => {
    const path = await pickSourcePath()
    if (!path) return
    const updated = await api.setSourceLocation(source.kind, path)
    updateSource(updated)
    if (updated.found) setMenu(null)
    else toast(`No encontré ${source.label} en esa ubicación`, 'error')
  })

  const syncAll = () => run(async () => {
    try {
      const result = await api.syncAllSources()
      for (const job of result.jobs) trackJob(job)
    } catch (error) {
      if (!isNotFound(error) || !enabled.some((source) => source.kind === 'rekordbox' && source.found)) throw error
      trackJob(await api.sync())
    }
  })

  const toggleAuto = () => run(async () => {
    const { autodiscover } = await api.setAutodiscover(!status?.autodiscover)
    useApp.setState((s) => ({ status: s.status && { ...s.status, autodiscover } }))
  })

  const renderRow = (source: LibrarySource) => {
    const name = sourceName(source)
    const expanded = menu === source.kind
    const syncJob = syncing.get(source.kind)
    return (
      <div className="source-row" key={source.kind}>
        <div className="source-line">
          <div className="source-info">
            <b>{name}</b>
            <span className="muted">{syncJob ? (isQueuedJob(syncJob) ? 'Sincronización en espera' : 'Sincronización en curso') : sourceStatus(source)}</span>
          </div>
          {source.enabled ? (
            <button className="btn sm" disabled={!source.found || !!syncJob || pending} onClick={() => void run(async () => {
              trackJob(await (legacy ? api.sync() : syncSource(source.kind)))
            })}>Sincronizar</button>
          ) : source.found && (
            <button className="btn sm" disabled={pending || !!syncJob} onClick={() => void toggleSource(source)}>Activar</button>
          )}
          {!legacy && <button className="btn ghost sm icon" aria-label={`Opciones de ${name}`} aria-expanded={expanded} onClick={() => setMenu(expanded ? null : source.kind)}>···</button>}
        </div>
        {expanded && (
          <div className="source-menu">
            {source.locations.length > 0 && (
              <details>
                <summary>{source.locations.length > 1 ? 'Ver rutas' : 'Ver ruta'}</summary>
                {source.locations.map(({ path, volume }) => <div className="muted" key={path}>{volume ? `${volume} · ` : ''}<code>{path}</code></div>)}
              </details>
            )}
            <button className="btn ghost sm" disabled={pending || !!syncJob} onClick={() => void locate(source)}>Cambiar carpeta…</button>
            <button className="btn ghost sm" disabled={pending || !!syncJob} onClick={() => void toggleSource(source)}>{source.enabled ? 'Desactivar' : 'Activar'}</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {notice && (
        <div className="source-notice">
          <span>Encontré {notice.label}. ¿Importarlo?</span>
          <div>
            <button className="btn sm" disabled={pending} onClick={() => void toggleSource(notice)}>Importar</button>
            <button className="btn ghost sm" disabled={pending} onClick={() => dismiss(notice.kind)}>No</button>
          </div>
        </div>
      )}
      <div className="sources-anchor" ref={root}>
        <button
          ref={trigger}
          className="btn sm sources-trigger"
          aria-expanded={sourcesOpen}
          aria-controls="library-sources"
          onClick={() => {
            setSourcesOpen(!sourcesOpen)
            if (!sourcesOpen && !legacy) void refreshSources().catch(() => undefined)
          }}
        >Fuentes</button>
        {shown && (
          <section id="library-sources" aria-label="Fuentes" className={`popover sources-pop${closing ? ' closing' : ''}`} inert={closing}>
            <div className="source-line">
              <span className="eyebrow">Fuentes</span>
              {!legacy && (
                <button className="btn sm" disabled={pending || Boolean(syncing.size) || !enabled.some((source) => source.found)} onClick={() => void syncAll()}>
                  <IconSync size={13} /> Sincronizar todo
                </button>
              )}
            </div>
            {enabled.map(renderRow)}
            {savedInactive.map(renderRow)}
            <div className="source-line source-row">
              <div className="source-info">
                <b>Música propia</b>
                <span className="muted">Búsqueda automática {status?.autodiscover ? 'activada' : 'desactivada'}</span>
              </div>
              <button className="btn sm ghost" aria-label={`${status?.autodiscover ? 'Desactivar' : 'Activar'} la búsqueda automática`} disabled={pending} onClick={() => void toggleAuto()}>
                {status?.autodiscover ? 'Desactivar' : 'Activar'}
              </button>
            </div>
            {!legacy && (
              <div className="sources-add">
                <button className="btn sm ghost" aria-expanded={adding} onClick={() => setAdding(!adding)}><IconPlus size={13} /> Agregar otra fuente…</button>
                {adding && (foundInactive.length ? foundInactive.map(renderRow) : <div className="muted">No encontré otras fuentes en esta Mac.</div>)}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  )
}
