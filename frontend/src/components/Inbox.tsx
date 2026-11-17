import { useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { KeyStatus, Track } from '../types'
import { IconSync } from './icons'
import { FoundMusic } from './FoundMusic'
import { ListView, sortTracks, type SortKey } from './ListView'

export function Inbox() {
  const { status, jobs, trackJob, toast, libraryVersion, setExportOpen } = useApp()
  const [ks, setKs] = useState<KeyStatus | null>(null)
  const keyJob = jobs.find((j) => j.kind === 'keys' && j.status === 'running')
  const [local, setLocal] = useState<Track[]>([])
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(['date_added', -1])

  useEffect(() => { api.tracks('local').then(setLocal).catch(() => {}) }, [libraryVersion])
  useEffect(() => { api.keyStatus().then(setKs).catch(() => {}) }, [libraryVersion])

  return (
    <>
      <header className="viewhead">
        <div>
          <h1>Analizar e importar</h1>
        </div>
      </header>
      <div className="inbox">
        <div>
          <div className="card">
            <h3>rekordbox</h3>
            <p>
              Batea lee una copia de tu librería: temas, playlists, puntajes, My Tags e historial. Nunca escribe en rekordbox.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn primary" disabled={!status?.rekordbox_found || jobs.some((j) => j.kind === 'sync' && j.status === 'running')} onClick={async () => trackJob(await api.sync())}>
                <IconSync size={14} /> Sincronizar ahora
              </button>
              <span className="muted" style={{ fontSize: 12 }}>{status?.rekordbox_found ? `Última: ${status.last_sync ? new Date(status.last_sync).toLocaleString('es-AR') : 'nunca'}` : 'No encontré rekordbox en esta Mac'}</span>
            </div>
          </div>
        </div>

        <FoundMusic />

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h3>Completar tonalidades</h3>
            {ks && <span className="muted num">{ks.missing.toLocaleString('es-AR')} sin tono de {ks.total.toLocaleString('es-AR')}{status?.universe ? ` en ${status.universe.name}` : ''}</span>}
          </div>
          <p>
            Batea calcula el tono de los temas que rekordbox no analizó. Esos tonos se ven con borde punteado y nunca reemplazan uno de rekordbox.
          </p>
          {ks?.accuracy ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              En tu librería acierta el <b style={{ color: 'var(--text)' }} className="num">{Math.round(ks.accuracy.exact * 100)}%</b> de las veces
              {ks.accuracy.compatible > ks.accuracy.exact ? <> y da un tono compatible el <span className="num">{Math.round(ks.accuracy.compatible * 100)}%</span></> : null}
              {' '}(probado con {ks.accuracy.sample} temas). Tomalo como una pista.
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12.5 }}>Antes de completar, prueba cuánto acierta con temas que ya tienen tono.</div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn primary" disabled={!ks || !ks.missing_online || !!keyJob} onClick={async () => { try { trackJob(await api.keyFill()) } catch (e) { toast((e as Error).message, 'error') } }}>
              {ks?.missing_online ? `Completar ${ks.missing_online.toLocaleString('es-AR')} ${ks.missing_online === 1 ? 'tonalidad' : 'tonalidades'}` : 'Completar tonalidades'}
            </button>
            {keyJob && <button className="btn" onClick={() => api.cancelJob(keyJob.id)}>Detener</button>}
            <span className="muted" style={{ fontSize: 12 }}>
              {!ks ? '' : ks.missing === 0 ? 'No falta ninguna.' : ks.missing_online === 0 ? 'Los que faltan están en un disco desconectado.'
                : ks.missing_online < ks.missing ? `Otros ${(ks.missing - ks.missing_online).toLocaleString('es-AR')} están en un disco desconectado.` : ''}
              {ks?.estimated ? ` Ya completé ${ks.estimated.toLocaleString('es-AR')}.` : ''}
            </span>
          </div>
          {keyJob && (
            <div className="job" style={{ background: 'var(--bg-2)' }}>
              <div className="ellipsis">{keyJob.message}</div>
              <div className="bar"><i style={{ ['--p' as string]: keyJob.progress }} /></div>
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px 12px' }}>
            <h3>Fuera de rekordbox</h3>
            <span className="muted num">{local.length}</span>
            <div style={{ flex: 1 }} />
            {local.length > 0 && <button className="btn sm" onClick={() => setExportOpen(true)}>Llevar a rekordbox…</button>}
          </div>
          {local.length ? (
            <div style={{ height: Math.min(520, 34 + local.length * 40), display: 'flex' }}>
              <ListView tracks={sortTracks(local, sort[0], sort[1])} sort={sort} onSort={setSort} />
            </div>
          ) : (
            <div className="empty" style={{ padding: '24px 20px 32px' }}>Nada todavía</div>
          )}
        </div>
      </div>
    </>
  )
}
