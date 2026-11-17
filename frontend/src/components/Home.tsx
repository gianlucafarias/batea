import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { Crate } from '../types'
import { hash } from '../util'
import { Sleeve } from './bits'
import { IconPlus, IconSync } from './icons'

type Previews = Awaited<ReturnType<typeof api.previews>>

function CrateCard({ crate, preview }: { crate: Crate; preview?: Previews[string] }) {
  const go = useApp((s) => s.go)
  const recs = (preview ?? []).slice(0, 5)
  const tilt = (hash(String(crate.id).length * 7919 + Number(String(crate.id).replace(/\D/g, '') || 3)) - 0.5) * 4
  return (
    <button className={`crate kind-${crate.kind}`} onClick={() => go('crate', String(crate.id))}>
      <div className="peek">
        {recs.map((r, i) => {
          const h = hash(r[0])
          const inset = 16 - i * 3 + (h - 0.5) * 6
          return (
            <div
              key={r[0]}
              className="rec"
              style={{
                left: inset, right: 16 - i * 3 - (h - 0.5) * 6,
                top: 10 + i * 10 + h * 4, zIndex: i,
                transform: `rotate(${(h - 0.5) * 2.4}deg)`, ['--lift' as string]: `${-3 - (recs.length - i) * 1.5}px`,
              }}
            >
              <Sleeve id={r[0]} title={r[1]} artist={r[2]} trackKey={r[3]} bpm={r[4]} hasArt={r[5]} size="m" px={170} />
            </div>
          )
        })}
      </div>
      <div className="box">
        <span className="tape" style={{ ['--tilt' as string]: `${tilt}deg` }}>{crate.name}</span>
        <div className="meta">
          <span>{crate.count.toLocaleString('es-AR')} discos</span>
          <span>{{ smart: 'inteligente', user: 'mía', virtual: '', playlist: 'rekordbox', smart_rb: 'rb smart', session: crate.date ?? 'sesión', folder: '', session_folder: '', dir: 'carpeta', artist: 'artista' }[crate.kind]}</span>
        </div>
      </div>
    </button>
  )
}

export function Home() {
  const { crates, virtualCrates, status, trackJob, libraryVersion, go, loadMeta } = useApp()
  const [previews, setPreviews] = useState<Previews>({})
  useEffect(() => { api.previews().then(setPreviews).catch(() => {}) }, [libraryVersion, crates.length])

  const visible = crates.filter((c) => !c.hidden)
  const mine = visible.filter((c) => c.kind === 'user' || c.kind === 'smart')
  const byId = useMemo(() => new Map(crates.map((c) => [c.id, c])), [crates])
  const groups = useMemo(() => {
    const out = new Map<string, Crate[]>()
    for (const c of visible) {
      if (c.kind !== 'playlist' || !c.count) continue
      const parent = c.parent_id ? byId.get(c.parent_id) : null
      const name = parent ? parent.name : 'Sueltas'
      if (!out.has(name)) out.set(name, [])
      out.get(name)!.push(c)
    }
    return [...out.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [visible, byId])
  const lastSessions = visible.filter((c) => c.kind === 'session' && c.count > 3).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 8)

  if (status && status.library_tracks === 0) {
    return (
      <div className="home">
        <div className="empty" style={{ marginTop: 80 }}>
          <h3>Batea está vacía</h3>
          <p>{status.rekordbox_found
            ? 'Traé tu librería de rekordbox o una carpeta con música.'
            : 'No encontré rekordbox. Traé una carpeta con música o arrastrala a la ventana.'}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {status.rekordbox_found && <button className="btn primary" onClick={async () => trackJob(await api.sync())}><IconSync size={14} /> Importar rekordbox</button>}
            <button className="btn" onClick={() => go('inbox')}>Analizar carpeta</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <header className="viewhead">
        <div>
          <h1>Bateas</h1>
          <div className="sub">{status?.tracks.toLocaleString('es-AR')} temas{status?.universe ? ` en ${status.universe.name}` : ''}</div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={async () => {
          const name = await useApp.getState().askText('Nombre de la caja nueva')
          if (!name) return
          const { id } = await api.createCrate(name); await loadMeta(); go('crate', String(id))
        }}><IconPlus size={14} /> Caja nueva</button>
      </header>
      <div className="home">
        <section className="shelf">
          <div className="shelf-h"><h2>Mostrador</h2><span className="faint">atajos y tus cajas</span></div>
          <div className="shelf-grid">
            {[...virtualCrates.filter((v) => v.count > 0), ...mine].map((c) => <CrateCard key={c.id} crate={c} preview={previews[String(c.id)]} />)}
          </div>
        </section>
        {groups.map(([name, list]) => (
          <section className="shelf" key={name}>
            <div className="shelf-h"><h2>{name}</h2><span className="faint num">{list.length}</span></div>
            <div className="shelf-grid">
              {list.map((c) => <CrateCard key={c.id} crate={c} preview={previews[String(c.id)]} />)}
            </div>
          </section>
        ))}
        {lastSessions.length > 0 && (
          <section className="shelf">
            <div className="shelf-h"><h2>Últimas sesiones</h2><span className="faint">del historial de rekordbox</span></div>
            <div className="shelf-grid">
              {lastSessions.map((c) => <CrateCard key={c.id} crate={c} preview={previews[String(c.id)]} />)}
            </div>
          </section>
        )}
      </div>
    </>
  )
}
