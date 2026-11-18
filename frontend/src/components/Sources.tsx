import { useEffect, useState } from 'react'
import { api, isNotFound, type LibrarySource, type LiveApp, type LiveSettings, type TraktorBroadcast } from '../api'
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
  if (!source.found) return 'No está en esta Mac'
  if (source.app_running) return `${source.label} está abierto. Batea ve lo último que guardaste.`
  const time = source.last_sync ? new Date(source.last_sync).getTime() : NaN
  if (!Number.isFinite(time)) return source.detail || 'Todavía no lo leí'
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000))
  if (minutes === 0) return 'Leído recién'
  const since = minutes < 60 ? relativeTime.format(-minutes, 'minute')
    : minutes < 1440 ? relativeTime.format(-Math.floor(minutes / 60), 'hour')
      : relativeTime.format(-Math.floor(minutes / 1440), 'day')
  return `Leído ${since}`
}

/** Estado y acciones compartidas entre el aviso de la barra lateral y el panel de Ajustes. */
function useSourceActions() {
  const { status, jobs, trackJob, loadMeta, updateSource, bump, toast } = useApp()
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
  const [dismissed, setDismissed] = useState(readDismissed)

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
    if (!updated.found) toast(`No encontré ${source.label} en esa ubicación`, 'error')
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

  return { status, legacy, enabled, foundInactive, savedInactive, syncing, pending, run, dismissed, dismiss, toggleSource, locate, syncAll, toggleAuto, trackJob }
}

/** Aviso en la barra lateral cuando aparece un programa nuevo; mantiene la detección al día. */
export function SourcesNotice() {
  const { refreshSources } = useApp()
  const { legacy, foundInactive, dismissed, dismiss, toggleSource, pending } = useSourceActions()
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

  if (!notice) return null
  return (
    <div className="source-notice">
      <span>Encontré {notice.label} en esta Mac. ¿Traigo tu librería?</span>
      <div>
        <button className="btn sm" disabled={pending} onClick={() => void toggleSource(notice)}>Traer</button>
        <button className="btn ghost sm" disabled={pending} onClick={() => dismiss(notice.kind)}>No</button>
      </div>
    </div>
  )
}

function TraktorLive() {
  const toast = useApp((state) => state.toast)
  const [broadcast, setBroadcast] = useState<TraktorBroadcast | null>(null)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    const refresh = async () => {
      try {
        const next = await api.traktorBroadcast()
        if (!active) return
        setBroadcast(next)
      } catch (error) {
        if (!active) return
        if (isNotFound(error)) {
          setBroadcast(null)
          return
        }
      }
      timer = window.setTimeout(refresh, 2000)
    }
    void refresh()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [])

  if (!broadcast) return null
  const { port, mount, password, connected, last, error } = broadcast
  const fields = [
    ['Address', 'localhost'],
    ['Port', String(port)],
    ['Mount Path', mount],
    ['Password', password],
    ['Format', 'Ogg Vorbis'],
  ]
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // WKWebView puede denegar el acceso a Clipboard API.
      const field = document.createElement('textarea')
      field.value = value
      field.className = 'traktor-copy-field'
      const previousFocus = document.activeElement
      document.body.appendChild(field)
      field.select()
      try {
        if (!document.execCommand('copy')) throw new Error()
      } catch {
        toast('No pude copiar el dato', 'error')
        return
      } finally {
        field.remove()
        if (previousFocus instanceof HTMLElement) previousFocus.focus()
      }
    }
    toast('Copiado')
  }

  return (
    <div className="traktor-live">
      <p>Traktor no avisa qué suena hasta que se cierra. Para saberlo en vivo, Traktor le transmite a Batea por <b>Broadcasting</b>: solo viaja el nombre de cada tema, dentro de tu Mac.</p>
      <ol className="traktor-live-steps">
        <li>En Traktor, abrí <b>Preferences → Broadcasting</b> y completá estos datos:</li>
      </ol>
      <dl className="traktor-live-fields">
        {fields.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <code>{value}</code>{name === 'Format' && <span className="muted">Cualquier calidad</span>}
              <button type="button" className="btn ghost sm" aria-label={`Copiar ${name}`} onClick={() => void copy(value)}>Copiar</button>
            </dd>
          </div>
        ))}
      </dl>
      <ol className="traktor-live-steps" start={2}>
        <li>Tocá el botón de Broadcasting (la antena) arriba a la derecha en Traktor. Hacelo en cada sesión.</li>
      </ol>
      <div role="status" className={error ? 'traktor-live-error' : 'muted'}>
        <div>{error || (connected ? 'Conectado con Traktor' : 'Esperando a Traktor…')}</div>
        {last && <div>Último tema: {[last.artist, last.title].filter(Boolean).join(' – ')}</div>}
      </div>
    </div>
  )
}

const LIVE_APPS: { id: LiveApp; label: string; hint: string }[] = [
  { id: 'auto', label: 'Detectar solo', hint: 'Lee el programa que esté abierto. Si hay más de uno, el que usaste último.' },
  { id: 'rekordbox', label: 'rekordbox', hint: 'Mira qué tema está cargado en cada deck y el historial de la sesión.' },
  { id: 'serato', label: 'Serato', hint: 'Lee el historial que Serato va anotando mientras tocás.' },
  { id: 'traktor', label: 'Traktor', hint: 'Necesita un paso en Traktor: abajo te explico cómo.' },
]

/** Ajuste general de "Saber qué suena" (ícono de la barra de menú): prendido/apagado y de qué programa leer. */
function LiveSection() {
  const toast = useApp((state) => state.toast)
  const [live, setLive] = useState<LiveSettings | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    api.liveSettings().then(setLive).catch(() => setLive(null))
  }, [])

  if (!live) return null
  const save = async (patch: Partial<LiveSettings>) => {
    setPending(true)
    try { setLive(await api.setLiveSettings(patch)) } catch (error) { toast((error as Error).message, 'error') } finally { setPending(false) }
  }
  const current = LIVE_APPS.find((a) => a.id === live.app) ?? LIVE_APPS[0]
  return (
    <div className="source-row live-section">
      <div className="source-line">
        <div className="source-info">
          <b>Saber qué suena</b>
          <span className="muted">Muestra en la barra de menú el tema que estás tocando y qué poner después.</span>
        </div>
        <button type="button" role="switch" className="switch" aria-label="Saber qué suena" aria-checked={live.enabled} disabled={pending} onClick={() => void save({ enabled: !live.enabled })}>
          <i />
        </button>
      </div>
      {live.enabled && (
        <div className="live-app">
          <label className="live-app-row">
            <span>Programa</span>
            <select className="input" value={live.app} disabled={pending} onChange={(e) => void save({ app: e.target.value as LiveApp })}>
              {LIVE_APPS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <span className="muted">{current.hint}</span>
          {live.app === 'traktor' && <TraktorLive />}
        </div>
      )}
    </div>
  )
}

/** Pestaña "Programas" de Ajustes: un renglón por programa, tu música y agregar otro. */
export function SourcesPanel() {
  const { status, legacy, enabled, foundInactive, savedInactive, syncing, pending, run, toggleSource, locate, syncAll, toggleAuto, trackJob } = useSourceActions()
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)

  const renderRow = (source: LibrarySource) => {
    const name = sourceName(source)
    const expanded = menu === source.kind
    const syncJob = syncing.get(source.kind)
    return (
      <div className="source-row" key={source.kind}>
        <div className="source-line">
          <div className="source-info">
            <b>{name}</b>
            <span className="muted">{syncJob ? (isQueuedJob(syncJob) ? 'En espera…' : 'Leyendo…') : sourceStatus(source)}</span>
          </div>
          {source.enabled ? (
            <button className="btn sm" disabled={!source.found || !!syncJob || pending} onClick={() => void run(async () => {
              trackJob(await (legacy ? api.sync() : syncSource(source.kind)))
            })}>Actualizar</button>
          ) : source.found && (
            <button className="btn sm" disabled={pending || !!syncJob} onClick={() => void toggleSource(source)}>Usar</button>
          )}
          {!legacy && <button className="btn ghost sm icon" aria-label={`Opciones de ${name}`} aria-expanded={expanded} onClick={() => setMenu(expanded ? null : source.kind)}>···</button>}
        </div>
        {expanded && (
          <div className="source-menu">
            {source.locations.length > 0 && (
              <details>
                <summary>{source.locations.length > 1 ? 'Dónde están' : 'Dónde está'}</summary>
                {source.locations.map(({ path, volume }) => <div className="muted" key={path}>{volume ? `${volume} · ` : ''}<code>{path}</code></div>)}
              </details>
            )}
            <button className="btn ghost sm" disabled={pending || !!syncJob} onClick={() => { setMenu(null); void locate(source) }}>Cambiar carpeta…</button>
            <button className="btn ghost sm" disabled={pending || !!syncJob} onClick={() => { setMenu(null); void toggleSource(source) }}>{source.enabled ? 'Dejar de usar' : 'Usar'}</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="settings-sources">
      {!legacy && (
        <div className="source-line">
          <span className="muted">Batea lee una copia de cada programa y nunca les cambia nada.</span>
          <button className="btn sm" disabled={pending || Boolean(syncing.size) || !enabled.some((source) => source.found)} onClick={() => void syncAll()}>
            <IconSync size={13} /> Actualizar todos
          </button>
        </div>
      )}
      {enabled.map(renderRow)}
      {savedInactive.map(renderRow)}
      <div className="source-line source-row">
        <div className="source-info">
          <b>Tu música</b>
          <span className="muted">Buscar sola al abrir Batea y al conectar un disco</span>
        </div>
        <button type="button" role="switch" className="switch" aria-checked={!!status?.autodiscover} aria-label="Búsqueda automática" disabled={pending} onClick={() => void toggleAuto()}>
          <i />
        </button>
      </div>
      <LiveSection />
      {!legacy && (
        <div className="sources-add source-row">
          <button className="btn sm ghost" aria-expanded={adding} onClick={() => setAdding(!adding)}><IconPlus size={13} /> Agregar otro programa…</button>
          {adding && (foundInactive.length ? foundInactive.map(renderRow) : <div className="muted">No hay otros programas de DJ en esta Mac.</div>)}
        </div>
      )}
    </div>
  )
}
