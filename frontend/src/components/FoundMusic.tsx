import { useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { DiscoverState, FoundFolder } from '../types'
import { IconFolder, IconSync } from './icons'

const HOME = /^\/Users\/[^/]+/

/** "/Volumes/PortableSSD/COSO/TECHNO" → ["PortableSSD", "COSO", "TECHNO"]; "/Users/x/Downloads" → ["Tu Mac", "Downloads"] */
function parts(folder: string): string[] {
  if (folder.startsWith('/Volumes/')) return folder.slice(9).split('/')
  if (HOME.test(folder)) return ['Tu Mac', ...folder.replace(HOME, '').split('/').filter(Boolean)]
  return folder.split('/').filter(Boolean)
}

/** Carpeta principal: la primera carpeta dentro de tu usuario o del disco (Downloads, Music, COSO MUSICA NO TOCAR…). */
function topOf(folder: string): string {
  const m = folder.match(/^(\/Volumes\/[^/]+|\/Users\/[^/]+)(\/[^/]+)?/)
  return m ? m[0] : folder
}

interface Group { top: string; count: number; analyzed: number; offline: number; folders: FoundFolder[] }

function group(folders: FoundFolder[]): Group[] {
  const map = new Map<string, Group>()
  for (const f of folders) {
    const t = topOf(f.folder)
    const g = map.get(t) ?? { top: t, count: 0, analyzed: 0, offline: 0, folders: [] }
    g.count += f.count; g.analyzed += f.analyzed; g.offline += f.offline; g.folders.push(f)
    map.set(t, g)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

function Counts({ count, analyzed, offline }: { count: number; analyzed: number; offline: number }) {
  return (
    <span className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
      {count} {count === 1 ? 'tema' : 'temas'}
      {offline ? ' · disco desconectado' : analyzed < count ? ` · ${count - analyzed} sin analizar` : ' · analizados'}
    </span>
  )
}

function Actions({ folder, offline, pending, onIgnore }: { folder: string; offline: boolean; pending: number; onIgnore: () => void }) {
  const { jobs, trackJob, toast } = useApp()
  const busy = jobs.some((j) => j.kind === 'analyze' && j.status === 'running')
  return (
    <>
      {pending > 0 && !offline && (
        <button className="btn sm" disabled={busy} title={busy ? 'Ya hay un análisis en curso' : 'BPM, tono, energía, intro y outro'}
          onClick={async (e) => { e.stopPropagation(); try { trackJob(await api.analyzeFound(folder)) } catch (err) { toast((err as Error).message, 'error') } }}>
          Analizar {pending}
        </button>
      )}
      <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); api.revealFolder(folder).catch(() => {}) }} disabled={offline}>Mostrar</button>
      <button className="btn sm" onClick={(e) => { e.stopPropagation(); onIgnore() }} title="Saca la carpeta de Batea y no la vuelve a revisar">No es música</button>
    </>
  )
}

function GroupRow({ g, onIgnore }: { g: Group; onIgnore: (folder: string) => void }) {
  const [open, setOpen] = useState(false)
  const p = parts(g.top)
  const single = g.folders.length === 1 && g.folders[0].folder === g.top
  return (
    <>
      <div className={`fm-row${single ? '' : ' fm-top'}`} title={g.top} onClick={() => !single && setOpen(!open)}>
        {single ? <IconFolder size={15} /> : <span className={`fm-caret${open ? ' open' : ''}`}>›</span>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ellipsis" style={{ fontWeight: 650 }}>{p[p.length - 1]}</div>
          <div className="ellipsis faint" style={{ fontSize: 11.5 }}>
            {p.slice(0, -1).join(' › ')}{single ? '' : ` · ${g.folders.length} carpetas adentro`}
          </div>
        </div>
        <Counts count={g.count} analyzed={g.analyzed} offline={g.offline} />
        <Actions folder={g.top} offline={g.offline > 0} pending={g.count - g.analyzed} onIgnore={() => onIgnore(g.top)} />
      </div>
      {open && g.folders.map((f) => {
        const rel = f.folder === g.top ? '(sueltos en esta carpeta)' : f.folder.slice(g.top.length + 1).split('/').join(' › ')
        return (
          <div className="fm-row fm-sub" key={f.folder} title={f.folder}>
            <IconFolder size={14} />
            <div className="ellipsis" style={{ minWidth: 0, flex: 1 }}>{rel}</div>
            <Counts count={f.count} analyzed={f.analyzed} offline={f.offline} />
            <Actions folder={f.folder} offline={f.offline > 0} pending={f.count - f.analyzed} onIgnore={() => onIgnore(f.folder)} />
          </div>
        )
      })}
    </>
  )
}

export function FoundMusic() {
  const { jobs, trackJob, toast, libraryVersion, bump, loadMeta, go } = useApp()
  const auto = useApp((s) => s.status?.autodiscover ?? false)
  const [st, setSt] = useState<DiscoverState | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  const searching = jobs.find((j) => j.kind === 'discover' && j.status === 'running')
  const analyzing = jobs.find((j) => j.kind === 'analyze' && j.status === 'running')
  const refresh = () => api.discoverState().then(setSt).catch(() => {})

  useEffect(() => { void refresh() }, [libraryVersion, searching?.id])

  const search = async (paths?: string[]) => {
    try { trackJob(await api.discover(paths)) } catch (e) { toast((e as Error).message, 'error') }
  }
  const pick = async () => {
    if (!window.pywebview?.api) { toast('Elegir carpeta funciona dentro de la app de Batea', 'error'); return }
    const p = await window.pywebview.api.pick_folder()
    if (p) void search([p])
  }
  const ignore = async (folder: string) => {
    const name = parts(folder).slice(-1)[0]
    if (!window.confirm(`¿“${name}” no es música para pasar? Sus temas salen de Batea (los que ya etiquetaste quedan ocultos) y no vuelvo a revisar esa carpeta.`)) return
    try {
      const r = await api.ignoreFolder(folder)
      toast(`“${name}” ignorada${r.ocultos ? ` · ${r.ocultos} con datos tuyos quedaron ocultos` : ''}`)
      await loadMeta(); bump(); void refresh()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const unignore = async (folder: string) => {
    try { trackJob(await api.unignoreFolder(folder)); void refresh() } catch (e) { toast((e as Error).message, 'error') }
  }

  const last = st?.last
  const disks = (st?.roots ?? []).filter((r) => r.startsWith('/Volumes/')).map((r) => r.slice(9))
  const total = (st?.folders ?? []).reduce((a, f) => a + f.count, 0)

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h3>Tu música</h3>
        <span className="muted num">{total.toLocaleString('es-AR')} {total === 1 ? 'tema' : 'temas'}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={pick}><IconFolder size={14} /> Traer una carpeta…</button>
        <button className="btn primary" disabled={!!searching} onClick={() => search()}><IconSync size={14} /> Buscar ahora</button>
      </div>
      <p>
        Temas de 2 minutos o más en tu Mac{disks.length ? ` y en ${disks.join(', ')}` : ' y tus discos'}. Saltea samples, loops y temas que ya están en tus programas.
        También podés arrastrar archivos o carpetas a la ventana.
      </p>

      <label className="fm-auto">
        <input type="checkbox" checked={auto} onChange={async (e) => { try { await api.setAutodiscover(e.target.checked); await loadMeta() } catch (err) { toast((err as Error).message, 'error') } }} />
        Buscar sola al abrir Batea y al conectar un disco
      </label>

      {searching ? (
        <div className="job" style={{ background: 'var(--bg-2)' }}>
          <div className="ellipsis">{searching.message || 'Buscando…'}</div>
          {!last && <div className="faint" style={{ fontSize: 11.5 }}>La primera vez tarda unos minutos.</div>}
          <div className="bar"><i style={{ ['--p' as string]: searching.progress }} /></div>
        </div>
      ) : last ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Última búsqueda: {new Date(last.fecha).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
          {' · '}{last.nuevos ? <b style={{ color: 'var(--text)' }}>{last.nuevos} {last.nuevos === 1 ? 'tema nuevo' : 'temas nuevos'}</b> : 'nada nuevo'}
          {last.movidos ? ` · ${last.movidos} cambiaron de carpeta` : ''}
          {st?.copies ? ` · ${st.copies.toLocaleString('es-AR')} ya estaban en rekordbox` : ''}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>Todavía no busqué.</div>
      )}
      {analyzing && !searching && (
        <div className="job" style={{ background: 'var(--bg-2)' }}>
          <div className="ellipsis">{analyzing.message || 'Analizando BPM, tono y energía…'}</div>
          <div className="bar"><i style={{ ['--p' as string]: analyzing.progress }} /></div>
        </div>
      )}

      {st && st.folders.length > 0 && (
        <div className="fm-list">
          {group(st.folders).map((g) => <GroupRow key={g.top} g={g} onIgnore={ignore} />)}
        </div>
      )}
      {st && st.folders.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn sm" onClick={() => go('crate', 'local')}>Ver los temas</button>
        </div>
      )}

      {st && st.ignored.length > 0 && (
        <div>
          <button className="btn sm ghost" onClick={() => setShowIgnored(!showIgnored)}>
            {showIgnored ? 'Ocultar' : 'Ver'} carpetas que no son música ({st.ignored.length})
          </button>
          {showIgnored && (
            <div className="fm-list" style={{ marginTop: 8 }}>
              {st.ignored.map((f) => {
                const p = parts(f)
                return (
                  <div className="fm-row" key={f} title={f}>
                    <IconFolder size={15} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="ellipsis" style={{ fontWeight: 600 }}>{p[p.length - 1]}</div>
                      <div className="ellipsis faint" style={{ fontSize: 11.5 }}>{p.slice(0, -1).join(' › ')}</div>
                    </div>
                    <button className="btn sm" onClick={() => unignore(f)}>Volver a incluir</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
