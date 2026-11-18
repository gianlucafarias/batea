import { create } from 'zustand'
import { api, audioUrl, isNotFound, type LibrarySource, type Status, type UpdateInfo } from './api'
import { crateSource, isActiveJob } from './sources'
import type { Crate, Filters, FolderNode, Job, Tag, Track, UniverseList } from './types'

export type View = 'home' | 'crate' | 'map' | 'inbox' | 'tagger'

interface Toast { id: number; text: string; tone?: 'ok' | 'error'; leaving?: boolean; action?: { label: string; run: () => void } }

interface State {
  /** false hasta que el motor contestó por primera vez: mientras tanto se muestra la pantalla de arranque */
  booted: boolean
  bootError: boolean
  /** presentación de bienvenida: 'first' = primera vez (con el progreso de la importación), 'replay' = verla de nuevo */
  welcome: null | 'first' | 'replay'
  setWelcome: (w: null | 'first' | 'replay') => void
  view: View
  crateId: string | null
  selectedId: number | null
  status: Status | null
  update: UpdateInfo | null
  tags: Tag[]
  crates: Crate[]
  virtualCrates: Crate[]
  folders: FolderNode[]
  jobs: Job[]
  toasts: Toast[]
  libraryVersion: number
  exportOpen: boolean
  sourcesOpen: boolean
  setSourcesOpen: (v: boolean) => void
  agentsOpen: boolean
  setAgentsOpen: (v: boolean) => void
  ask: { title: string; value: string; resolve: (v: string | null) => void } | null
  lastPatch: (Partial<Track> & { id: number }) | null
  universes: UniverseList | null
  universeEditor: { id: number | null } | null     // null = cerrado; id null = universo nuevo
  tagger: { tracks: Track[]; title: string; back: { view: View; crateId: string | null } } | null
  mix: { a: number; b: number } | null
  analysisQueue: { now: number | null; ids: number[] }
  editTrackId: number | null
  setEditTrack: (id: number | null) => void
  filterPreset: { crateId: string; filters: Filters; seq: number } | null
  goFiltered: (crateId: string, filters: Filters) => void
  /** lugares anteriores a los que se llegó con un atajo (artista, compatibles): para "Volver" */
  backStack: { view: View; crateId: string | null; filters: Filters }[]
  viewFilters: Filters
  goBack: () => void
  analyzeTracks: (ids: number[]) => Promise<void>
  setUniverseEditor: (v: { id: number | null } | null) => void
  activateUniverse: (id: number | null) => Promise<void>
  openTagger: (tracks: Track[], title: string) => void
  closeTagger: () => void
  openMix: (a: number, b: number) => void
  closeMix: () => void
  patchTrack: (p: Partial<Track> & { id: number }) => void

  askText: (title: string, value?: string) => Promise<string | null>
  go: (v: View, crateId?: string | null) => void
  select: (id: number | null) => void
  loadMeta: () => Promise<void>
  refreshSources: () => Promise<void>
  updateSource: (source: LibrarySource) => void
  bump: () => void
  toast: (text: string, tone?: 'ok' | 'error', action?: { label: string; run: () => void }) => void
  setExportOpen: (v: boolean) => void
  trackJob: (job: Job) => void
}

const tracked = new Set<string>()
let sourceRevision = 0

async function fetchSources() {
  try { return (await api.sources()).sources } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** Sigue la fila de análisis: cada tema que termina se actualiza en la lista y en el detalle sin recargar todo. */
async function syncQueue(running: boolean) {
  const { analysisQueue: prev } = useApp.getState()
  const next = running ? await api.analyzeQueue().catch(() => prev) : { now: null, ids: [] }
  const still = new Set([next.now, ...next.ids])
  const finished = [prev.now, ...prev.ids].filter((id): id is number => id != null && !still.has(id))
  useApp.setState({ analysisQueue: next })
  for (const id of finished) {
    const t = await api.track(id).catch(() => null)
    if (!t) continue
    const { title, artist, bpm, key, key_est, energy, energy_auto, intro_bars, outro_bars, breaks, duration, has_art, unanalyzed } = t
    useApp.getState().patchTrack({ id, title, artist, bpm, key, key_est, energy, energy_auto, intro_bars, outro_bars, breaks, duration, has_art, unanalyzed })
  }
}

export const useApp = create<State>((set, get) => ({
  booted: false,
  bootError: false,
  welcome: null,
  setWelcome: (welcome) => set({ welcome }),
  view: 'home',
  crateId: null,
  selectedId: null,
  status: null,
  update: null,
  tags: [],
  crates: [],
  virtualCrates: [],
  folders: [],
  jobs: [],
  toasts: [],
  libraryVersion: 0,
  exportOpen: false,
  sourcesOpen: false,
  setSourcesOpen: (sourcesOpen) => set({ sourcesOpen }),
  agentsOpen: false,
  setAgentsOpen: (agentsOpen) => set({ agentsOpen }),
  ask: null,
  lastPatch: null,
  universes: null,
  universeEditor: null,
  tagger: null,
  mix: null,
  analysisQueue: { now: null, ids: [] },
  editTrackId: null,
  setEditTrack: (editTrackId) => set({ editTrackId }),
  filterPreset: null,
  goFiltered: (crateId, filters) => set((s) => ({
    view: 'crate', tagger: null, crateId,
    filterPreset: { crateId, filters, seq: (s.filterPreset?.seq ?? 0) + 1 },
    backStack: [...s.backStack, { view: s.view === 'tagger' ? 'home' : s.view, crateId: s.crateId, filters: s.view === 'crate' ? s.viewFilters : {} }].slice(-30),
  })),
  backStack: [],
  viewFilters: {},
  goBack: () => set((s) => {
    const prev = s.backStack[s.backStack.length - 1]
    if (!prev) return {}
    return {
      view: prev.view, crateId: prev.crateId, tagger: null, backStack: s.backStack.slice(0, -1),
      filterPreset: prev.view === 'crate' && prev.crateId ? { crateId: prev.crateId, filters: prev.filters, seq: (s.filterPreset?.seq ?? 0) + 1 } : null,
    }
  }),
  analyzeTracks: async (ids) => {
    try {
      const job = await api.analyzeTracks(ids)
      set({ analysisQueue: await api.analyzeQueue() })
      get().trackJob(job)
    } catch (e) { get().toast((e as Error).message, 'error') }
  },
  setUniverseEditor: (universeEditor) => set({ universeEditor }),
  activateUniverse: async (id) => {
    await api.activateUniverse(id)
    await get().loadMeta()
    set({ selectedId: null })
    if (get().view === 'crate' || get().view === 'tagger') set({ view: 'home', crateId: null, tagger: null })
    get().bump()
  },
  openTagger: (tracks, title) => {
    if (!tracks.length) { get().toast('No hay temas para etiquetar acá', 'error'); return }
    const s = get()
    set({ tagger: { tracks, title, back: { view: s.view === 'tagger' ? 'home' : s.view, crateId: s.crateId } }, view: 'tagger', selectedId: null })
  },
  closeTagger: () => {
    const t = get().tagger
    set({ tagger: null, view: t?.back.view ?? 'home', crateId: t?.back.crateId ?? null })
    void get().loadMeta()
    get().bump()
  },
  openMix: (a, b) => { usePlayer.getState().stop(); set({ mix: { a, b } }) },
  closeMix: () => set({ mix: null }),
  patchTrack: (p) => set({ lastPatch: { ...p } }),

  askText: (title, value = '') =>
    new Promise((resolve) => set({ ask: { title, value, resolve: (v) => { set({ ask: null }); resolve(v) } } })),
  go: (view, crateId = null) => set({ view, tagger: null, filterPreset: null, backStack: [], crateId: crateId ?? (view === 'crate' ? get().crateId : null) }),
  select: (selectedId) => set({ selectedId }),
  loadMeta: async () => {
    const revision = sourceRevision
    const [status, tags, crates, universes, folders, sources] = await Promise.all([
      api.status(), api.tags(), api.crates(), api.universes(), api.folders().catch(() => get().folders),
      get().status ? undefined : fetchSources().catch(() => undefined),
    ])
    const latestSources = revision === sourceRevision ? sources ?? status.sources ?? get().status?.sources : get().status?.sources
    const disabled = new Set(latestSources?.filter((source) => !source.enabled).map((source) => source.kind))
    const visibleCrates = disabled.size ? crates.crates.filter((crate) => !disabled.has(crateSource(crate) ?? '')) : crates.crates
    set({ status: { ...status, sources: latestSources }, tags, crates: visibleCrates, virtualCrates: crates.virtual, universes, folders })
  },
  refreshSources: async () => {
    const revision = sourceRevision
    const sources = await fetchSources()
    if (revision !== sourceRevision || !sources) return
    set((s) => ({ status: s.status && { ...s.status, sources } }))
  },
  updateSource: (source) => {
    sourceRevision++
    set((s) => {
      if (!s.status) return s
      const sources = s.status.sources ?? []
      return {
        status: {
          ...s.status,
          sources: sources.some((item) => item.kind === source.kind)
            ? sources.map((item) => item.kind === source.kind ? source : item)
            : [...sources, source],
        },
      }
    })
  },
  bump: () => set((s) => ({ libraryVersion: s.libraryVersion + 1 })),
  toast: (text, tone = 'ok', action) => {
    const id = Date.now() + Math.random()
    set((s) => ({ toasts: [...s.toasts, { id, text, tone, action }] }))
    // sale con su animación (120 ms, ver .toast.leaving) y después se quita; con botón, se queda más
    const stay = action ? 9000 : 4080
    setTimeout(() => set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) })), stay)
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), stay + 120)
  },
  setExportOpen: (exportOpen) => set({ exportOpen }),
  trackJob: (job) => {
    if (tracked.has(job.id)) return
    tracked.add(job.id)
    set((s) => ({ jobs: [job, ...s.jobs.filter((j) => j.id !== job.id)] }))
    const poll = async () => {
      const all = await api.jobs().catch(() => null)
      if (!all) { setTimeout(poll, 700); return }
      const j = all.find((x) => x.id === job.id)
      set({ jobs: all })
      if (job.kind === 'analyze') await syncQueue(j?.status === 'running')
      if (j && isActiveJob(j)) {
        setTimeout(poll, 700)
      } else if (j) {
        const quiet = j.kind === 'discover' && !Number(j.result?.nuevos) && !Number(j.result?.movidos)   // búsqueda sin novedades: no molestar
        if (j.status === 'done') { if (!quiet) get().toast(typeof j.result?.mensaje === 'string' ? j.result.mensaje : `${j.label}: listo`) }
        else get().toast(`${j.label}: ${j.message}`, 'error')
        await get().loadMeta().catch(() => undefined)
        get().bump()
      }
    }
    setTimeout(poll, 500)
  },
}))

// ------------------------------------------------------------------ reproductor
interface PlayerState {
  track: Track | null
  playing: boolean
  time: number
  duration: number
  volume: number
  error: string | null
  play: (t: Track) => void
  playFrom: (t: Track, seconds: number) => void
  stop: () => void
  toggle: () => void
  seek: (seconds: number) => void
  setVolume: (v: number) => void
}

const audio = typeof Audio !== 'undefined' ? new Audio() : (null as unknown as HTMLAudioElement)
if (audio) audio.preload = 'auto'

export const usePlayer = create<PlayerState>((set, get) => {
  if (audio) {
    audio.addEventListener('timeupdate', () => set({ time: audio.currentTime }))
    audio.addEventListener('durationchange', () => set({ duration: audio.duration || 0 }))
    audio.addEventListener('play', () => set({ playing: true, error: null }))
    audio.addEventListener('pause', () => set({ playing: false }))
    audio.addEventListener('ended', () => set({ playing: false }))
    audio.addEventListener('error', () => set({ playing: false, error: 'No se pudo reproducir este archivo' }))
  }
  return {
    track: null,
    playing: false,
    time: 0,
    duration: 0,
    volume: 0.9,
    error: null,
    play: (t) => {
      if (!t.online) {
        useApp.getState().toast('El archivo no está disponible: ¿está conectado el disco?', 'error')
        return
      }
      if (get().track?.id === t.id) {
        audio.paused ? audio.play() : audio.pause()
        return
      }
      set({ track: t, time: 0, duration: t.duration || 0, error: null })
      audio.src = audioUrl(t.id)
      audio.volume = get().volume
      // en techno, arrancar donde entra el groove ayuda a escuchar rápido
      void audio.play().catch(() => set({ error: 'No se pudo reproducir este archivo' }))
    },
    playFrom: (t, seconds) => {
      if (!t.online) return
      set({ track: t, time: seconds, duration: t.duration || 0, error: null })
      audio.src = audioUrl(t.id)
      audio.volume = get().volume
      const start = () => {
        audio.removeEventListener('loadedmetadata', start)
        try { audio.currentTime = Math.max(0, seconds) } catch { /* sin seek */ }
        void audio.play().catch(() => set({ error: 'No se pudo reproducir este archivo' }))
      }
      audio.addEventListener('loadedmetadata', start)
      audio.load()
    },
    stop: () => { if (audio && !audio.paused) audio.pause() },
    toggle: () => {
      if (!get().track) return
      audio.paused ? audio.play() : audio.pause()
    },
    seek: (s) => {
      if (!get().track) return
      audio.currentTime = Math.max(0, s)
    },
    setVolume: (v) => {
      audio.volume = v
      set({ volume: v })
    },
  }
})

// Acceso desde la consola y las pruebas automáticas (window.__batea.useApp.getState()…)
;(window as unknown as Record<string, unknown>).__batea = { useApp, usePlayer, audio }
