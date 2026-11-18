import { api, isNotFound, type LibrarySource, type Status } from './api'
import type { Crate, Job } from './types'

export const CORE_SOURCES = ['rekordbox', 'traktor', 'serato'] as const

const PROGRAMS: Record<string, [label: string, short: string]> = {
  rekordbox: ['rekordbox', 'RB'],
  traktor: ['Traktor', 'TK'],
  serato: ['Serato', 'SE'],
  engine: ['Engine DJ', 'EN'],
  vdj: ['VirtualDJ', 'VD'],
}

export const sourceLabel = (kind: string) => PROGRAMS[kind]?.[0] ?? kind
export const sourceShort = (kind: string) => PROGRAMS[kind]?.[1] ?? kind.slice(0, 2).toUpperCase()
export const sourceName = ({ label, version }: LibrarySource) => version ? `${label} ${version}` : label

const EMPTY_SOURCE = {
  found: false, enabled: false, version: null, detail: null, app_running: false,
  last_sync: null, track_count: null, locations: [],
}

export function missingSource(kind: string): LibrarySource {
  return { ...EMPTY_SOURCE, kind, label: sourceLabel(kind), short: sourceShort(kind) }
}

export function legacyRekordbox(status: Status | null): LibrarySource {
  return {
    ...missingSource('rekordbox'),
    found: status?.rekordbox_found ?? false,
    enabled: true,
    last_sync: status?.last_sync ?? null,
  }
}

export function crateSource(crate: Crate): string | undefined {
  if (crate.source) return crate.source
  return ['folder', 'playlist', 'smart_rb', 'session_folder', 'session'].includes(crate.kind) ? 'rekordbox' : undefined
}

export const isSessionCrate = (crate: Crate) => crate.kind === 'session_folder' || crate.kind === 'session'

export function syncJobSource(job: Job): string | undefined {
  if (job.kind === 'sync') return 'rekordbox'
  if (job.kind.startsWith('sync:')) return job.kind.slice('sync:'.length)
}

export const isActiveJob = (job: Job) => job.status === 'queued' || job.status === 'running'
export const isQueuedJob = (job: Job) => job.status === 'queued' || (job.status === 'running' && job.message === 'En espera')

export async function syncSource(kind: string): Promise<Job> {
  try {
    return await api.syncSource(kind)
  } catch (error) {
    if (kind === 'rekordbox' && isNotFound(error)) return api.sync()
    throw error
  }
}

export async function pickSourcePath(): Promise<string | null> {
  const picker = window.pywebview?.api
  if (!picker) throw new Error('Elegir un archivo o carpeta funciona dentro de la app de Batea')
  return picker.pick_file ? picker.pick_file() : picker.pick_folder()
}
