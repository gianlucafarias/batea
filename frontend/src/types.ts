export interface Track {
  id: number
  title: string | null
  artist: string | null
  album: string | null
  label: string | null
  genre: string | null
  remixer: string | null
  bpm: number | null
  key: string | null
  duration: number | null
  rating: number
  energy: number | null
  energy_user: number | null
  energy_auto: number | null
  intro_bars: number | null
  outro_bars: number | null
  breaks: number | null
  date_added: string | null
  play_count: number
  last_played: string | null
  source: 'rekordbox' | 'local'
  color: string | null
  has_art: number
  year: number | null
  filetype: string | null
  bitrate: number | null
  hidden: number
  key_est?: number | null
  reviewed?: number
  /** pending = fuera de rekordbox sin analizar · error = no se pudo leer · rb = rekordbox no lo analizó */
  unanalyzed?: 'pending' | 'error' | 'rb' | null
  tags: number[]
  online: boolean
}

export interface Relation {
  id: number
  a: number
  b: number
  kind: 'mix' | 'similar' | 'mashup' | 'avoid' | 'history'
  source: 'user' | 'history' | 'feedback'
  count: number
  note: string | null
  other_id: number
  title: string | null
  artist: string | null
  bpm: number | null
  key: string | null
  energy: number | null
  has_art: number
  direction: 'in' | 'out'
}

export interface TrackDetail extends Track {
  notes: string | null
  rb_comment: string | null
  key_raw: string | null
  analyzed: string | null
  rb_id: string | null
  tag_sources: Record<number, 'user' | 'auto' | 'rekordbox'>
  crates: { id: number; name: string; kind: string }[]
  sessions: { id: number; name: string; date: string | null }[]
  relations: Relation[]
}

export interface Tag {
  id: number
  name: string
  category: string
  color: string | null
  source: 'user' | 'rekordbox'
  count: number
  position: number
  hotkey: string | null
}

export interface Crate {
  id: number | string
  name: string
  kind: 'virtual' | 'dir' | 'artist' | 'folder' | 'playlist' | 'smart_rb' | 'session_folder' | 'session' | 'user' | 'smart'
  parent_id?: number | null
  hidden?: number
  date?: string | null
  count: number
  query?: Filters
}

export interface Filters {
  q?: string
  tags?: number[]
  not_tags?: number[]
  bpm_min?: number
  bpm_max?: number
  energy_min?: number
  energy_max?: number
  keys?: string[]
  key_compat?: string
  rating_min?: number
  source?: string
}

export interface Job {
  id: string
  kind: string
  label: string
  status: 'running' | 'done' | 'error'
  progress: number
  message: string
  result: Record<string, unknown>
}

export interface Recommendation {
  id: number
  score: number
  reasons: string[]
  learned: boolean
  track: Track
}

export interface StyleProfile {
  around_bpm: number | null
  pairs: number
  bpm_tolerance: number
  harmonic_ratio: number | null
  key_weight: number
}

export interface Universe {
  id: number
  name: string
  crate_ids: number[]
  count: number
}

export interface UniverseList {
  active: number | null
  items: Universe[]
  total: number
}

export interface EditorCrate {
  id: number
  name: string
  kind: 'folder' | 'playlist' | 'user'
  parent_id: number | null
  count: number
  bpm: number | null
}

export interface Grid {
  bpm: number | null
  duration: number | null
  downbeats: number[]
  approx: boolean
  intro_bars: number | null
  outro_bars: number | null
}

export interface KeyStatus {
  total: number
  missing: number
  missing_online: number
  estimated: number
  accuracy: { sample: number; exact: number; compatible: number; date: string } | null
}

export interface FoundFolder { folder: string; count: number; analyzed: number; offline: number }
export interface DiscoverState {
  folders: FoundFolder[]
  ignored: string[]
  roots: string[]
  copies: number
  samples: number
  last: { fecha: string; nuevos: number; movidos: number; copias: number; samples: number; archivos: number } | null
}

export interface Waveform {
  duration: number
  h: number[]
  low: number[]
  mid: number[]
  high: number[]
  downbeats?: number[]
}

/** Carpeta real del disco con música (p = ruta, n = nombre a mostrar, c = temas adentro). */
export interface FolderNode {
  p: string
  n: string
  c: number
  k?: FolderNode[]
  root?: boolean
  off?: boolean
}
