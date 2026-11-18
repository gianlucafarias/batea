import type { Crate, DiscoverState, FolderNode, EditorCrate, Filters, Grid, Job, KeyStatus, Recommendation, StyleProfile, Tag, Track, TrackDetail, UniverseList, Waveform } from './types'

/** Pedido que llegó desde afuera: un link batea:// o un aviso del MCP */
export interface OpenTarget { kind: 'tema' | 'caja' | 'carpeta' | 'artista' | 'refresh'; value?: string; play?: boolean }

export interface AgentInfo {
  id: string; name: string; note: string; file: string; installed: boolean
  status: 'on' | 'off' | 'stale' | 'missing'
}
export interface AgentList { agents: AgentInfo[]; manual: unknown; ready: boolean }

class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export type ExportTargetId = 'rekordbox' | 'traktor' | 'serato' | 'm3u'
export interface ExportTarget {
  id: ExportTargetId; label: string; available: boolean; reason: string | null
  format: 'XML' | 'NML' | 'M3U8'; carries: string[]; loses: string[]; how_to_load: string
}
export interface ExportResult {
  ok: boolean; target: ExportTargetId; path: string; files: string[]; tracks: number; missing: number; warnings: string[]
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = await res.json()
      msg = j.detail || msg
    } catch { /* sin cuerpo */ }
    throw new ApiError(msg, res.status)
  }
  return res.json()
}

const get = <T,>(u: string) => req<T>('GET', u)
const post = <T,>(u: string, b?: unknown) => req<T>('POST', u, b ?? {})
const patch = <T,>(u: string, b: unknown) => req<T>('PATCH', u, b)
const del = <T,>(u: string) => req<T>('DELETE', u)

export function filtersToQuery(f: Filters): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue
    p.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  return p.toString()
}

export interface UpdateInfo {
  current: string
  latest: string | null
  min_version: string | null
  update_available: boolean
  must_update: boolean
  notes: string
  page: string
  download: string | null
  online: boolean | null
}

export interface Status {
  tracks: number
  library_tracks: number
  universe: { id: number; name: string } | null
  inbox: number
  local: number
  rekordbox_found: boolean
  rekordbox_dir: string
  last_sync: string | null
  welcome_done: boolean
  autodiscover: boolean
  export_path: string
  jobs: Job[]
  sources?: LibrarySource[]
}

export interface LibrarySource {
  kind: string
  label: string
  short: string
  found: boolean
  enabled: boolean
  version: string | null
  detail: string | null
  app_running: boolean
  last_sync: string | null
  track_count: number | null
  locations: { path: string; version: string | null; volume: string | null; modified: number | string | null }[]
}

export interface TraktorBroadcast {
  enabled: boolean
  port: number
  mount: string
  password: string
  connected: boolean
  last: { artist: string; title: string; at: number } | null
  error: string | null
}

export interface TrackSource {
  source: string
  label: string
  bpm: number | null
  key_camelot: string | null
  key_raw: string | null
  rating: number | null
  play_count: number | null
  cues_count: number | null
  date_added: string | null
  last_played: string | null
  synced_at: string | null
}

export interface SetupPlan {
  sources: string[]
  search: 'none' | 'all' | 'folder'
  path: string | null
}

interface SetupResult { jobs?: Job[]; sync?: Job; discover?: Job }

export const api = {
  status: () => get<Status>('/api/status'),
  update: (force = false) => get<UpdateInfo>(`/api/update${force ? '?force=true' : ''}`),
  openUpdate: () => post<{ opened: string }>('/api/update/open'),
  jobs: () => get<Job[]>('/api/jobs'),
  welcomeDone: () => post('/api/welcome/done'),
  setup: (plan: SetupPlan) => post<SetupResult>('/api/setup', plan),
  setupLegacy: ({ sources, search, path }: SetupPlan) =>
    post<SetupResult>('/api/setup', { rekordbox: sources.includes('rekordbox'), search, path }),
  sources: () => get<{ sources: LibrarySource[] }>('/api/sources'),
  traktorBroadcast: () => get<TraktorBroadcast>('/api/live/traktor-broadcast'),
  setTraktorBroadcast: (enabled: boolean, port?: number) =>
    post<TraktorBroadcast>('/api/live/traktor-broadcast', { enabled, port }),
  syncSource: (kind: string) => post<Job>(`/api/sources/${encodeURIComponent(kind)}/sync`),
  syncAllSources: () => post<{ jobs: Job[] }>('/api/sources/sync-all'),
  setSourceEnabled: (kind: string, enabled: boolean) =>
    post<{ ok: boolean; kind: string; enabled: boolean }>(`/api/sources/${encodeURIComponent(kind)}/enabled`, { enabled }),
  setSourceLocation: (kind: string, path: string) =>
    post<LibrarySource>(`/api/sources/${encodeURIComponent(kind)}/location`, { path }),
  setAutodiscover: (enabled: boolean) => post<{ autodiscover: boolean }>('/api/autodiscover', { enabled }),
  cancelJob: (id: string) => post(`/api/jobs/${id}/cancel`),
  sync: () => post<Job>('/api/sync/rekordbox'),
  analyzeFolder: (path: string, reanalyze = false) => post<Job>('/api/analyze/folder', { path, reanalyze }),

  crates: () => get<{ virtual: Crate[]; crates: Crate[] }>('/api/crates'),
  // [id, title, artist, key, bpm, has_art]
  previews: () => get<Record<string, [number, string | null, string | null, string | null, number | null, number][]>>('/api/crates/previews'),
  createCrate: (name: string, opts: { query?: Filters; track_ids?: number[]; parent_id?: number } = {}) =>
    post<{ id: number }>('/api/crates', { name, ...opts }),
  patchCrate: (id: number | string, b: { name?: string; hidden?: boolean; query?: Filters }) => patch(`/api/crates/${id}`, b),
  deleteCrate: (id: number | string) => del(`/api/crates/${id}`),
  addToCrate: (id: number | string, track_ids: number[]) => post(`/api/crates/${id}/tracks`, { track_ids }),
  removeFromCrate: (id: number | string, tid: number) => del(`/api/crates/${id}/tracks/${tid}`),

  tracks: (crate: string | number | null, f: Filters = {}) =>
    get<Track[]>(`/api/tracks?${filtersToQuery({ ...(crate != null ? { crate: String(crate) } : {}), ...f } as Filters)}`),
  track: (id: number) => get<TrackDetail>(`/api/tracks/${id}`),
  trackSources: (id: number) => get<{ sources: TrackSource[] }>(`/api/tracks/${id}/sources`),
  openPending: () => get<OpenTarget[]>('/api/open/pending'),
  agents: () => get<AgentList>('/api/agents'),
  setAgent: (id: string, connected: boolean) => post<AgentList>(`/api/agents/${id}`, { connected }),
  testAgents: () => post<{ ok: boolean; message: string }>('/api/agents-test'),
  patchTrack: (id: number, b: Record<string, unknown>) => patch<TrackDetail>(`/api/tracks/${id}`, b),
  waveform: (id: number, cols?: number) => get<Waveform>(`/api/tracks/${id}/waveform${cols ? `?cols=${cols}` : ''}`),
  grid: (id: number) => get<Grid>(`/api/tracks/${id}/grid`),
  batch: (track_ids: number[], b: Record<string, unknown>) => post('/api/tracks/batch', { track_ids, ...b }),
  recommendations: (id: number, crate?: string | number | null) =>
    get<{ items: Recommendation[]; profile: StyleProfile }>(`/api/tracks/${id}/recommendations?limit=16${crate ? `&crate=${crate}` : ''}`),
  reveal: (id: number) => post(`/api/tracks/${id}/reveal`),

  tags: () => get<Tag[]>('/api/tags'),
  createTag: (name: string, category: string, color?: string) => post<Tag>('/api/tags', { name, category, color }),
  deleteTag: (id: number) => del(`/api/tags/${id}`),
  setHotkey: (id: number, hotkey: string) => patch(`/api/tags/${id}`, { hotkey }),
  assignTag: (track_ids: number[], tag_id: number, on: boolean) => post('/api/tags/assign', { track_ids, tag_id, on }),

  relate: (a: number, b: number, kind: string, note?: string) => post('/api/relations', { a, b, kind, note }),
  unrelate: (id: number) => del(`/api/relations/${id}`),
  feedback: (seed: number, other: number, good: boolean) => post('/api/feedback', { seed, other, good }),

  map: (crate?: string | number | null) =>
    get<{ points: MapPoint[]; edges: [number, number, string, number][] }>(`/api/map${crate ? `?crate=${crate}` : ''}`),

  universes: () => get<UniverseList>('/api/universes'),
  universeEditor: () => get<EditorCrate[]>('/api/universes/editor'),
  universeCount: (crate_ids: number[]) => post<{ count: number }>('/api/universes/count', { crate_ids }),
  createUniverse: (name: string, crate_ids: number[]) => post<UniverseList>('/api/universes', { name, crate_ids }),
  patchUniverse: (id: number, b: { name?: string; crate_ids?: number[] }) => patch<UniverseList>(`/api/universes/${id}`, b),
  deleteUniverse: (id: number) => del<UniverseList>(`/api/universes/${id}`),
  activateUniverse: (id: number | null) => post<UniverseList>('/api/universes/activate', { id }),

  keyStatus: () => get<KeyStatus>('/api/keys/status'),
  keyFill: () => post<Job>('/api/keys/fill'),
  discover: (paths?: string[]) => post<Job>('/api/discover', paths ? { paths } : {}),
  discoverState: () => get<DiscoverState>('/api/discover'),
  ignoreFolder: (folder: string) => post<{ quitados: number; ocultos: number }>('/api/discover/ignore', { folder }),
  analyzeTracks: (track_ids: number[]) => post<Job>('/api/analyze/tracks', { track_ids }),
  analyzeQueue: () => get<{ now: number | null; ids: number[] }>('/api/analyze/queue'),
  analyzeFound: (folder: string) => post<Job>('/api/discover/analyze', { folder }),
  folders: () => get<FolderNode[]>('/api/folders'),
  revealFolder: (folder: string) => post<{ ok: boolean }>('/api/discover/reveal', { folder }),
  unignoreFolder: (folder: string) => post<Job>('/api/discover/unignore', { folder }),

  exportRb: (crate_ids: (number | string)[], tags_in_comment: boolean) =>
    post<{ path: string; tracks: number; playlists: number }>('/api/export/rekordbox', { crate_ids, tags_in_comment }),
  exportTargets: () => get<{ targets: ExportTarget[] }>('/api/export/targets'),
  exportTo: (target: ExportTargetId, crate_ids: (number | string)[], tags_in_comment: boolean) =>
    post<ExportResult>('/api/export', { target, crate_ids, tags_in_comment }),
  revealExport: (path?: string) => post('/api/reveal-export', path ? { path } : undefined),
}

// id, bpm, energy, key, rating, title, artist, plays, online, tags
export type MapPoint = [number, number, number | null, string | null, number, string | null, string | null, number, number, number[]]

export const audioUrl = (id: number) => `/api/tracks/${id}/audio`
export const artUrl = (id: number, size: 's' | 'm' | 'l' = 'm') => `/api/tracks/${id}/artwork?size=${size}`

declare global {
  interface Window {
    pywebview?: { api: { pick_folder: () => Promise<string | null>; pick_file?: () => Promise<string | null> } }
  }
}
