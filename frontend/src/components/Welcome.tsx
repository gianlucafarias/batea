import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, isNotFound, type LibrarySource, type SetupPlan } from '../api'
import logoRekordbox from '../assets/logos/rekordbox.png'
import logoSerato from '../assets/logos/serato.png'
import logoTraktor from '../assets/logos/traktor.png'
import { CORE_SOURCES, isActiveJob, isQueuedJob, legacyRekordbox, missingSource, pickSourcePath, sourceLabel, syncJobSource } from '../sources'
import { spring, usePresence } from '../lib/motion'
import { useApp } from '../store'
import type { Job } from '../types'
import { BrandMark, IconCheck, IconFolder } from './icons'
import { ArtCrates, ArtKeys, ArtMap, ArtMix, ArtSuggest, ArtUniverses, ArtFolders, ArtAI } from './WelcomeArt'

// ------------------------------------------------------------------ arranque
/** Lo que se ve mientras el motor contesta por primera vez (el mismo diseño ya está en index.html, así no hay salto). */
export function Splash({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-in">
        <div className="splash-mark"><BrandMark /></div>
        <div className="splash-name">batea</div>
        {error ? (
          <>
            <p className="splash-msg">No pude conectar con el motor de Batea.</p>
            <p className="splash-sub">Si vuelve a pasar, cerrala y abrila de nuevo. El detalle queda en ~/Library/Logs/Batea.log.</p>
            <button className="btn primary" onClick={onRetry}>Reintentar</button>
          </>
        ) : (
          <>
            <div className="splash-bar"><i /></div>
            <p className="splash-sub">Abriendo tu librería…</p>
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ diapositivas
interface Slide { id: string; eyebrow: string; title: string; body: string; art: ReactNode }

const SLIDES: Slide[] = [
  { id: 'bateas', eyebrow: 'Bateas', title: 'Tu librería, como una batea de discos.', body: 'Hojeás las cajas con sus carátulas, filtrás por tono, BPM y energía, y armás tus propias cajas. Lee tu librería de rekordbox, Traktor o Serato sin cambiarle nada.', art: <ArtCrates /> },
  { id: 'tagger', eyebrow: 'Etiquetado rápido', title: 'Un tema en segundos, sin tocar el mouse.', body: 'Escuchás y etiquetás con el teclado: energía, puntaje, intro, outro, mashup, acapella. También en tanda, con varios temas juntos.', art: <ArtKeys /> },
  { id: 'map', eyebrow: 'Mapa', title: 'Tu música como una constelación.', body: 'Cada tema es una estrella. Los que mezclás juntos forman racimos; tocás una y se encienden sus conexiones y sugeridos. Además, la rueda Camelot de siempre.', art: <ArtMap /> },
  { id: 'mix', eyebrow: 'Probar la mezcla', title: 'Probá la mezcla antes de la noche.', body: 'Dos temas alineados por la grilla de compases: elegís en qué compás entra el segundo y escuchás el cruce. El veredicto queda anotado como relación. Lo encontrás en el botón «Probar mezcla» de cualquier tema, o con la tecla M.', art: <ArtMix /> },
  { id: 'suggest', eyebrow: 'Qué poner después', title: 'Sugerencias que aprenden de cómo mezclás.', body: 'Combinan tono, BPM y energía con tu historial de rekordbox, Traktor o Serato. Cada sugerencia te dice por qué aparece. También desde el ícono de la barra de menú, mientras tocás.', art: <ArtSuggest /> },
  { id: 'universes', eyebrow: 'Universos', title: 'Un universo para cada tipo de noche.', body: 'Limitá todo Batea a las playlists y carpetas que elijas: techno, cumbia, casamientos. No borra nada; con «Toda la librería» volvés a ver todo.', art: <ArtUniverses /> },
  { id: 'found', eyebrow: 'Música nueva', title: 'También encuentra la música que no está en ningún programa.', body: 'Busca sola en tu Mac y en cada disco que conectes. El análisis (BPM, tono, energía, intro y outro) se hace solo cuando lo pedís, de a un tema por vez, para no trabar la computadora.', art: <ArtFolders /> },
  { id: 'ai', eyebrow: 'Con tu IA', title: 'Hablá con tu librería.', body: 'Conectá Claude, Codex o Cursor y preguntales por tus sesiones, armá sets o pedí ideas. Cada tema que nombran es un link que abre Batea.', art: <ArtAI /> },
]

const SLIDE_MS = 8500

// ------------------------------------------------------------------ qué traer (se pregunta; nada arranca solo)
function Option({ on, onSelect, title, children, disabled, kind = 'radio' }: { on: boolean; onSelect: () => void; title: string; children?: ReactNode; disabled?: boolean; kind?: 'radio' | 'check' }) {
  return (
    <button type="button" role={kind === 'check' ? 'checkbox' : 'radio'} aria-checked={on} disabled={disabled} className={`wl-opt${on ? ' on' : ''}`} onClick={onSelect}>
      <span className={`wl-mark ${kind}`}>{on && (kind === 'check' ? <IconCheck size={11} /> : <i />)}</span>
      <span className="wl-opt-t"><b>{title}</b>{children && <span>{children}</span>}</span>
    </button>
  )
}

// ------------------------------------------------------------------ tarjetas de la primera pantalla
const SOURCE_CARDS: Record<string, { logo: string; ratio: string; h: number; brings: string[] }> = {
  rekordbox: { logo: logoRekordbox, ratio: '1916 / 325', h: 34, brings: ['Tus temas con BPM y tono', 'Playlists y My Tags', 'Historial de sets, para sugerirte qué poner después'] },
  traktor: { logo: logoTraktor, ratio: '999 / 147', h: 27, brings: ['Tus temas con BPM, tono y estrellas', 'Playlists', 'Historial de sets, para sugerirte qué poner después'] },
  serato: { logo: logoSerato, ratio: '2000 / 476', h: 34, brings: ['Tus temas con BPM, tono y estrellas', 'Crates', 'Historial de sets, para sugerirte qué poner después'] },
}

function cardStatus(source: LibrarySource): string {
  const parts: string[] = []
  if (source.version) parts.push(`Versión ${source.version}`)
  if (source.detail) parts.push(source.detail)
  else if (source.track_count) parts.push(`${source.track_count.toLocaleString('es-AR')} temas`)
  return parts.join(' · ') || 'Está en esta Mac'
}

/** Primera pantalla: solo la pregunta. Las diapositivas aparecen después, mientras se importa. */
function SetupScreen({ onStart, busy }: { onStart: (plan: SetupPlan) => void; busy: boolean }) {
  const { status, toast, updateSource } = useApp()
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState<SetupPlan['search']>('none')
  const [path, setPath] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmShown, confirmClosing] = usePresence(confirming || null, spring.slow.exit)
  const [picking, setPicking] = useState(false)
  const detected = status?.sources ?? [legacyRekordbox(status)]
  const sources = [
    ...CORE_SOURCES.map((kind) => detected.find((source) => source.kind === kind) ?? missingSource(kind)),
    ...detected.filter((source) => source.found && !CORE_SOURCES.some((kind) => kind === source.kind)),
  ]
  const selected = sources.filter((source) => source.found && (choices[source.kind] ?? true)).map((source) => source.kind)
  const plan = { sources: selected, search, path }
  const nothing = selected.length === 0 && search === 'none'
  const locked = busy || picking

  const pickFolder = async () => {
    setPicking(true)
    try {
      const picker = window.pywebview?.api
      if (!picker) throw new Error('Elegir una carpeta funciona dentro de la app de Batea')
      const folder = await picker.pick_folder()
      if (folder) { setPath(folder); setSearch('folder') }
    } catch (error) { toast((error as Error).message, 'error') } finally { setPicking(false) }
  }

  const locate = async (source: LibrarySource) => {
    setPicking(true)
    try {
      const location = await pickSourcePath()
      if (!location) return
      const updated = await api.setSourceLocation(source.kind, location)
      updateSource(updated)
      if (updated.found) setChoices((prev) => ({ ...prev, [source.kind]: true }))
      else toast(`No encontré ${source.label} en esa ubicación`, 'error')
    } catch (error) {
      toast(isNotFound(error) ? `No pude encontrar ${source.label} en esa ubicación` : (error as Error).message, 'error')
    } finally { setPicking(false) }
  }

  return (
    <div className="welcome setup" role="dialog" aria-label="Configuración inicial de Batea">
      <header className="wl-top"><div className="brand"><BrandMark /><span className="brand-name">batea</span></div></header>
      <main className="su-body">
          <div className="su-head">
            <h1>Bienvenido a Batea</h1>
            <p>Marcá de dónde traer tu música. Hasta que toques Empezar, Batea no lee nada.</p>
          </div>
          <section className="su-cards" aria-label="Qué traer">
            {sources.map((source) => {
              const on = selected.includes(source.kind)
              const info = SOURCE_CARDS[source.kind]
              return (
                <div key={source.kind} className={`su-card${on ? ' on' : ''}${source.found ? '' : ' missing'}`}>
                  <button type="button" role="checkbox" aria-checked={on} aria-label={source.label} className="su-card-main" disabled={!source.found || locked}
                    onClick={() => setChoices((prev) => ({ ...prev, [source.kind]: !on }))}>
                    <span className="wl-mark check su-card-mark">{on && <IconCheck size={11} />}</span>
                    <span className="su-logo-box">
                      {info?.logo ? <span className="su-logo" style={{ ['--logo' as string]: `url(${info.logo})`, aspectRatio: info.ratio, height: info.h }} /> : <b className="su-logo-text">{source.label}</b>}
                    </span>
                    <span className="su-card-status">
                      {source.found
                        ? <>{cardStatus(source)}{source.app_running && <em>Está abierto. Batea ve lo último que guardaste.</em>}</>
                        : 'No está en esta Mac'}
                    </span>
                    {info && <ul className="su-brings">{info.brings.map((b) => <li key={b}>{b}</li>)}</ul>}
                  </button>
                  {!source.found && <button className="wl-link su-card-extra" disabled={locked} onClick={() => void locate(source)}>Lo tengo en otra carpeta…</button>}
                </div>
              )
            })}
            <div className={`su-card${search !== 'none' ? ' on' : ''}`}>
              <button type="button" role="checkbox" aria-checked={search !== 'none'} aria-label="Tu música" className="su-card-main" disabled={locked}
                onClick={() => setSearch(search === 'none' ? (path ? 'folder' : 'all') : 'none')}>
                <span className="wl-mark check su-card-mark">{search !== 'none' && <IconCheck size={11} />}</span>
                <span className="su-logo-box"><span className="su-logo-own"><IconFolder size={22} /> Tu música</span></span>
                <span className="su-card-status">Temas que no cargaste en ningún programa</span>
                <ul className="su-brings">
                  <li>Busca en tu Mac, en tus discos o en una carpeta</li>
                  <li>Batea calcula BPM, tono y energía cuando se lo pedís</li>
                </ul>
              </button>
              {/* siempre visibles (la tarjeta no cambia de alto); apagadas hasta marcar la tarjeta */}
              <div className="su-card-choices" role="radiogroup" aria-label="Dónde buscar" aria-disabled={search === 'none'}>
                <Option on={search === 'all'} disabled={locked} onSelect={() => setSearch('all')} title="Toda la Mac y los discos">macOS te va a pedir permiso. Batea solo lee.</Option>
                <Option on={search === 'folder'} disabled={locked} onSelect={() => (path ? setSearch('folder') : void pickFolder())} title="Solo una carpeta">
                  {path ? <code title={path}>{path.split('/').filter(Boolean).pop()}</code> : 'Elegila vos.'}
                </Option>
                <button className="wl-link su-card-extra" disabled={locked || !path || search !== 'folder'} style={{ visibility: path && search === 'folder' ? 'visible' : 'hidden' }} onClick={() => void pickFolder()}>Cambiar carpeta</button>
              </div>
            </div>
          </section>
          <div className="su-foot">
            <span className="faint">Podés marcar más de uno. Batea lee una copia y nunca cambia nada en tus programas.</span>
            <button className="btn primary wl-cta" disabled={locked || (search === 'folder' && !path)} onClick={() => nothing ? setConfirming(true) : onStart(plan)}>
              {nothing ? 'Lo haré después' : 'Empezar'}
            </button>
          </div>
      </main>
      {confirmShown && (
        <div className={`modal-bg${confirmClosing ? ' closing' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setConfirming(false) }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setConfirming(false) }}>
          <div className="modal su-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="su-confirm-t" aria-describedby="su-confirm-d">
            <div>
              <h2 id="su-confirm-t">¿Lo dejás para después?</h2>
              <p id="su-confirm-d" className="muted">Sin música, Bateas, Mapa y Sugerencias quedan vacías. Podés traerla cuando quieras en Ajustes, abajo a la izquierda.</p>
            </div>
            <div className="wl-cta-row">
              <button className="btn ghost" autoFocus disabled={busy} onClick={() => setConfirming(false)}>Volver</button>
              <button className="btn primary" disabled={busy} onClick={() => onStart(plan)}>Sí, después</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ progreso de la carga
interface Run {
  plan: SetupPlan
  jobs: Job[]
  existingJobs: Set<string>
  startedAt: number
}

interface Load {
  jobs: Job[]
  tracks: number
  local: number
  done: boolean
}

const INITIAL: Load = { jobs: [], tracks: 0, local: 0, done: false }

const DEMO_PLAN: SetupPlan = { sources: ['rekordbox', 'traktor', 'serato'], search: 'all', path: null }

function demoLoad(kind: string): Load {
  const job = (kind: string, message: string, progress: number, status: Job['status'] = 'running'): Job => ({ id: kind, kind, label: kind, status, progress, message, result: {} })
  const synced = DEMO_PLAN.sources.map((source) => job(`sync:${source}`, '', 1, 'done'))
  switch (kind) {
    case 'sync': return { ...INITIAL, jobs: [synced[0], job('sync:traktor', 'Leyendo playlists…', 0.2)], tracks: 8420 }
    case 'discover': return { ...INITIAL, jobs: [...synced, job('discover', 'Recorriendo el disco…', 0.55)], tracks: 9240, local: 126 }
    case 'done': return { ...INITIAL, jobs: [...synced, job('discover', '', 1, 'done')], tracks: 9366, local: 126, done: true }
    case 'empty': return { ...INITIAL, done: true }
    default: return INITIAL
  }
}

/** Sigue los jobs que devolvió setup y la búsqueda automática si se inicia más tarde. */
function useLoading(run: Run | null, demo: string | null): Load {
  const [load, setLoad] = useState<Load>(() => demo ? demoLoad(demo) : INITIAL)
  useEffect(() => {
    if (!run || demo) return
    let alive = true
    let timer: number
    let idleSince: number | null = null
    const tracked = new Map(run.jobs.map((job) => [job.id, job]))
    const tick = async () => {
      try {
        const [status, jobs] = await Promise.all([api.status(), api.jobs()])
        if (!alive) return
        for (const job of jobs) {
          if (tracked.has(job.id) || (job.kind === 'discover' && run.plan.search === 'all' && !run.existingJobs.has(job.id))) {
            tracked.set(job.id, job)
          }
        }
        const current = [...tracked.values()]
        const now = Date.now()
        const active = current.some(isActiveJob)
        idleSince = active ? null : idleSince ?? now
        const waitForDiscovery = run.plan.search === 'all' && !current.some((job) => job.kind === 'discover')
          && (idleSince === null || now - idleSince < 9000)
        const done = !active && !waitForDiscovery && now - run.startedAt >= 1500
        setLoad({ jobs: current, tracks: status.library_tracks, local: status.local, done })
        if (done) return
      } catch { /* el motor puede estar ocupado: se reintenta */ }
      if (alive) timer = window.setTimeout(tick, 1000)
    }
    void tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [run, demo])
  return load
}

function Step({ job, done, children }: { job?: Job; done: boolean; children: ReactNode }) {
  const state = job?.status === 'error' || (!job && done) ? 'error'
    : job?.status === 'done' ? 'done'
      : job?.status === 'running' && !isQueuedJob(job) ? 'now' : 'todo'
  return (
    <li className={`wl-step ${state}`} title={state === 'error' ? job?.message : undefined}>
      <span className="ic" aria-hidden>{state === 'done' ? <IconCheck size={11} /> : state === 'now' ? <i className="wl-spin" /> : state === 'error' ? '!' : ''}</span>
      <span>{children}{state === 'error' && (job ? ' · falló' : ' · no se inició')}</span>
    </li>
  )
}

function LoadingPanel({ load, plan, finish }: { load: Load; plan: SetupPlan; finish: (to?: 'inbox') => void }) {
  const { done, jobs, tracks, local } = load
  const empty = done && tracks === 0
  const sourceSteps = plan.sources.map((kind) => ({ kind, job: jobs.find((job) => syncJobSource(job) === kind) }))
  const discover = jobs.find((job) => job.kind === 'discover')
  const active = jobs.find((job) => job.status === 'running' && !isQueuedJob(job))
  const activeSource = active && syncJobSource(active)
  const failed = done && (sourceSteps.some(({ job }) => job?.status !== 'done') || (plan.search !== 'none' && discover?.status !== 'done'))
  const fmt = (n: number) => n.toLocaleString('es-AR')
  let title = 'Preparando todo…'
  let sub = 'Arrancando lo que elegiste.'
  if (activeSource) { title = `Importando tu librería de ${sourceLabel(activeSource)}`; sub = active?.message || 'Leyendo la librería…' }
  if (active?.kind === 'discover') { title = 'Buscando tu música'; sub = active.message || 'Recorriendo carpetas…' }
  if (done) {
    title = failed ? 'Algo no se pudo leer' : empty ? 'Batea quedó vacía, por ahora' : 'Tu librería está lista'
    sub = failed
      ? 'Probá de nuevo en Ajustes, abajo a la izquierda, o desde «Analizar e importar».'
      : empty
        ? 'Traé música en Ajustes, abajo a la izquierda, o desde «Analizar e importar».'
        : `${fmt(tracks)} temas${local ? `, ${fmt(local)} fuera de tus programas` : ''}.`
  }
  const progress = done ? 1 : active?.progress ?? 0
  return (
    <div className={`wl-load${done ? ' done' : ''}${empty ? ' nothing' : ''}`}>
      <div className="wl-load-main">
        <div className="wl-load-h">
          <span className="wl-load-ic">{failed || empty ? <IconFolder size={15} /> : done ? <IconCheck size={15} /> : <i className="wl-spin big" />}</span>
          <div>
            <b>{title}</b>
            <span className="muted">{sub}</span>
          </div>
        </div>
        <div className={`wl-bar${!done && !active ? ' indet' : ''}`}><i style={{ width: `${Math.max(2, progress * 100)}%` }} /></div>
        <ul className="wl-steps">
          {sourceSteps.map(({ kind, job }) => <Step key={kind} job={job} done={done}>Leer {sourceLabel(kind)}</Step>)}
          {plan.search !== 'none' && <Step job={discover} done={done}>{plan.search === 'folder' ? 'Revisar la carpeta que elegiste' : 'Buscar tu música'}</Step>}
        </ul>
        {active?.kind === 'discover' && plan.search === 'all' && <p className="wl-hint">Si macOS pide permiso para leer carpetas o discos, aceptá. Batea solo lee.</p>}
      </div>
      <div className="wl-load-side">
        <div className="wl-count"><b className="num">{fmt(tracks)}</b><span>temas</span></div>
        {done && !empty && <button className="btn primary wl-cta" onClick={() => finish()}>Entrar a Batea</button>}
        {empty && (
          <div className="wl-cta-row">
            <button className="btn primary wl-cta" onClick={() => finish('inbox')}>Traer música</button>
            <button className="btn ghost" onClick={() => finish()}>Entrar igual</button>
          </div>
        )}
      </div>
    </div>
  )
}

function hashParams(): { slide: number | null; demo: string | null } {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const s = p.get('slide')
  return { slide: s !== null && !Number.isNaN(Number(s)) ? Number(s) : null, demo: p.get('demo') }
}

// ------------------------------------------------------------------ presentación
export function Welcome({ mode }: { mode: 'first' | 'replay' }) {
  const { setWelcome, loadMeta, bump, go, trackJob, status, toast } = useApp()
  const params = useMemo(hashParams, [])
  const n = SLIDES.length
  const [index, setIndex] = useState(params.slide !== null ? ((params.slide % n) + n) % n : 0)
  const [elapsed, setElapsed] = useState(0)
  const [playing, setPlaying] = useState(params.slide === null)
  const [run, setRun] = useState<Run | null>(null)
  const demo = params.demo && params.demo !== 'ask' ? params.demo : null
  const [busy, setBusy] = useState(false)
  const asking = mode === 'first' && !run && !demo
  const load = useLoading(run, demo)

  const show = useCallback((i: number) => { setIndex(((i % n) + n) % n); setElapsed(0) }, [n])

  // Avanza sola. Solo la frena el botón de pausa: no depende de dónde esté el mouse ni de otros ajustes.
  useEffect(() => {
    if (!playing || asking) return
    const iv = window.setInterval(() => setElapsed((e) => e + 100), 100)
    return () => window.clearInterval(iv)
  }, [playing, asking])
  useEffect(() => { if (elapsed >= SLIDE_MS) show(index + 1) }, [elapsed, index, show])

  const finish = useCallback(async (to?: 'inbox') => {
    if (mode === 'first') void api.welcomeDone().catch(() => undefined)
    setWelcome(null)
    await loadMeta().catch(() => undefined)
    bump()
    go(to ?? 'home')
  }, [mode, setWelcome, loadMeta, bump, go])

  const begin = async (plan: SetupPlan) => {
    setBusy(true)
    try {
      const startedAt = Date.now()
      const before = plan.search === 'all' ? await api.jobs().catch(() => status?.jobs ?? []) : []
      const result = await (status?.sources ? api.setup(plan) : api.setupLegacy(plan))
      if (plan.sources.length === 0 && plan.search === 'none') { await finish(); return }
      const jobsById = new Map<string, Job>()
      for (const job of [...(result.jobs ?? []), result.sync, result.discover]) {
        if (job) jobsById.set(job.id, job)
      }
      const jobs = [...jobsById.values()]
      for (const job of jobs) trackJob(job)
      setElapsed(0)
      setRun({ plan, jobs, existingJobs: new Set(before.map((job) => job.id)), startedAt })
    } catch (error) { toast((error as Error).message, 'error') } finally { setBusy(false) }
  }

  useEffect(() => {
    if (asking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') show(index + 1)
      else if (e.key === 'ArrowLeft') show(index - 1)
      else if (e.key === 'Escape' && mode === 'replay') void finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asking, index, show, mode, finish])

  if (asking) return <SetupScreen onStart={(plan) => void begin(plan)} busy={busy} />

  const slide = SLIDES[index]
  return (
    <div className="welcome" role="dialog" aria-label="Bienvenida a Batea">
      <header className="wl-top">
        <div className="brand"><BrandMark /><span className="brand-name">batea</span></div>
        <button className="btn ghost" onClick={() => void finish()}>{mode === 'replay' ? 'Cerrar' : 'Saltar presentación'}</button>
      </header>

      <section className="wl-stage">
        <div className="wl-slide" key={slide.id} aria-live="polite">
          <div className="wl-copy">
            <span className="wl-eyebrow">{String(index + 1).padStart(2, '0')} / {String(n).padStart(2, '0')} · {slide.eyebrow}</span>
            <h1>{slide.title}</h1>
            <p>{slide.body}</p>
          </div>
          <div className="wl-art">{slide.art}</div>
        </div>
      </section>

      <nav className="wl-dots" aria-label="Diapositivas">
        <button className="btn ghost sm icon" aria-label="Anterior" onClick={() => show(index - 1)}>‹</button>
        {SLIDES.map((s, i) => (
          <button key={s.id} className={`wl-dot${i === index ? ' on' : ''}`} aria-label={s.eyebrow} aria-current={i === index} onClick={() => show(i)}>
            <span><i style={{ width: i === index ? `${playing ? Math.min(100, (elapsed / SLIDE_MS) * 100) : 100}%` : '0%' }} /></span>
          </button>
        ))}
        <button className="btn ghost sm icon" aria-label="Siguiente" onClick={() => show(index + 1)}>›</button>
        <button className="btn ghost sm icon wl-play" aria-label={playing ? 'Pausar' : 'Reanudar'} title={playing ? 'Pausar' : 'Reanudar'} onClick={() => setPlaying((v) => !v)}>{playing ? '❚❚' : '▶'}</button>
      </nav>

      <footer className="wl-foot">
        {mode === 'replay'
          ? <div className="wl-replay muted">Podés volver a ver esta presentación cuando quieras desde la barra lateral.</div>
          : <LoadingPanel load={load} plan={run?.plan ?? (demo === 'empty' ? { sources: [], search: 'none', path: null } : DEMO_PLAN)} finish={(to) => void finish(to)} />}
      </footer>
    </div>
  )
}
