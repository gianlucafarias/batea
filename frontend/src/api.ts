import type { Crate, DiscoverState, FolderNode, EditorCrate, Filters, Grid, Job, KeyStatus, Recommendation, StyleProfile, Tag, Track, TrackDetail, UniverseList, Waveform } from './types'

/** Pedido que llegó desde afuera: un link batea:// o un aviso del MCP */
export interface OpenTarget { kind: 'tema' | 'caja' | 'carpeta' | 'artista' | 'refresh'; value?: string; play?: boolean }

export interface AgentInfo {
  id: string; name: string; note: string; file: string; installed: boolean
  status: 'on' | 'off' | 'stale' | 'missing'
}
export interface AgentList { agents: AgentInfo[]; manual: unknown; ready: boolean }

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
    throw new Error(msg)
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
}

export const api = {
  status: () => get<Status>('/api/status'),
  jobs: () => get<Job[]>('/api/jobs'),
  welcomeDone: () => post('/api/welcome/done'),
  setup: (b: { rekordbox: boolean; search: 'none' | 'all' | 'folder'; path?: string | null }) => post<{ sync?: Job; discover?: Job }>('/api/setup', b),
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
  revealExport: () => post('/api/reveal-export'),
}

// id, bpm, energy, key, rating, title, artist, plays, online, tags
export type MapPoint = [number, number, number | null, string | null, number, string | null, string | null, number, number, number[]]

export const audioUrl = (id: number) => `/api/tracks/${id}/audio`
export const artUrl = (id: number, size: 's' | 'm' | 'l' = 'm') => `/api/tracks/${id}/artwork?size=${size}`

declare global {
  interface Window {
    pywebview?: { api: { pick_folder: () => Promise<string | null> } }
  }
}
