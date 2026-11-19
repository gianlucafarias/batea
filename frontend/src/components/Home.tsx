import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { crateSource, sourceLabel } from '../sources'
import { useApp } from '../store'
import type { Crate } from '../types'
import { hash } from '../util'
import { Sleeve } from './bits'
import { Item, openContextMenu, Sep } from './ContextMenu'
import { IconChevron, IconPlus, IconSync } from './icons'

type Previews = Awaited<ReturnType<typeof api.previews>>

const EXPORT_LABEL = {
  never: { text: 'sin exportar', title: 'Todavía no está en rekordbox: exportala para pasarla' },
  stale: { text: 'con cambios', title: 'Cambió después de la última exportación: volvé a exportarla' },
  done: { text: 'exportada', title: 'Ya la exportaste a rekordbox tal como está' },
} as const

const isDb = (c: Crate): c is Crate & { id: number } => typeof c.id === 'number'
const isOwn = (c: Crate) => c.kind === 'user' || c.kind === 'smart'
const byHome = (list: Crate[]) => [...list].sort((a, b) => (a.home_position ?? Infinity) - (b.home_position ?? Infinity))

// ------------------------------------------------------------------ tarjeta
function CrateCard({ crate, preview, dragging, sortable, onPointerDown, onContextMenu }: {
  crate: Crate
  preview?: Previews[string]
  dragging?: boolean
  sortable?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const go = useApp((s) => s.go)
  const kind = crateSource(crate)
  const program = kind ? sourceLabel(kind) : ''
  const recs = (preview ?? []).slice(0, 5)
  const tilt = (hash(String(crate.id).length * 7919 + Number(String(crate.id).replace(/\D/g, '') || 3)) - 0.5) * 4
  const exp = crate.export_state ? EXPORT_LABEL[crate.export_state] : null
  const label = { smart: 'inteligente', user: 'mía', virtual: '', playlist: program, smart_rb: program, session: [program, crate.date ?? 'sesión'].filter(Boolean).join(' · '), folder: '', session_folder: '', dir: 'carpeta', artist: 'artista' }[crate.kind]
  return (
    <button className={`crate kind-${crate.kind}${sortable ? ' sortable' : ''}${dragging ? ' dragging' : ''}${crate.hidden ? ' is-hidden' : ''}${crate.export_state === 'never' || crate.export_state === 'stale' ? ' pending-export' : ''}`}
      data-crate={sortable ? String(crate.id) : undefined}
      onClick={() => go('crate', String(crate.id))} onPointerDown={onPointerDown} onContextMenu={onContextMenu}>
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
        {exp && crate.export_state !== 'done' && <i className="exp-dot" title={exp.title} />}
        <span className="tape" style={{ ['--tilt' as string]: `${tilt}deg` }}>{crate.name}</span>
        <div className="meta">
          <span>{crate.count.toLocaleString('es-AR')} discos</span>
          {exp ? <span className={`exp ${crate.export_state}`} title={exp.title}>{exp.text}</span> : <span>{label}</span>}
        </div>
      </div>
    </button>
  )
}

// ------------------------------------------------------------------ estante
interface ShelfProps {
  id: string                         // clave para recordar si está contraído
  title: string
  count?: number
  collapsed: boolean
  onToggle: () => void
  onHeaderMenu: (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => void
  onAdd?: (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => void
  hint?: string
  fixed?: Crate[]                    // atajos: no se reordenan
  crates: Crate[]
  previews: Previews
  empty?: ReactNode
  onReorder: (ids: number[]) => void
  menuFor: (c: Crate, e: React.MouseEvent) => void
}

function Shelf({ id, title, count, collapsed, onToggle, onHeaderMenu, onAdd, hint, fixed = [], crates, previews, empty, onReorder, menuFor }: ShelfProps) {
  const grid = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: number; mark: { left: number; top: number; height: number } } | null>(null)
  const swallow = useRef(false)
  const live = useRef({ crates, onReorder })
  live.current = { crates, onReorder }

  const startDrag = useCallback((e: React.PointerEvent, crate: Crate) => {
    if (e.button !== 0 || !isDb(crate)) return
    const x0 = e.clientX, y0 = e.clientY
    let started = false
    let slot = 0
    let x = x0, y = y0, raf = 0
    const scroller = grid.current?.closest('.home') as HTMLElement | null
    const measure = () => {
      const g = grid.current
      if (!g) return null
      const gr = g.getBoundingClientRect()
      const cards = [...g.querySelectorAll<HTMLElement>('[data-crate]')]
      if (!cards.length) return null
      let best = 0, bestD = Infinity
      cards.forEach((el, i) => {
        const r = el.getBoundingClientRect()
        const d = Math.hypot(x - (r.left + r.width / 2), (y - (r.top + r.height / 2)) * 1.4)
        if (d < bestD) { bestD = d; best = i }
      })
      const r = cards[best].getBoundingClientRect()
      const before = x < r.left + r.width / 2
      slot = best + (before ? 0 : 1)
      return { left: (before ? r.left - 11 : r.right + 11) - gr.left, top: r.top - gr.top, height: r.height }
    }
    const update = () => { const mark = measure(); if (mark) setDrag({ id: crate.id, mark }) }
    const autoscroll = () => {
      if (scroller) {
        const r = scroller.getBoundingClientRect()
        const edge = 70
        const dy = y < r.top + edge ? -Math.ceil((r.top + edge - y) / 4) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 4) : 0
        if (dy) { scroller.scrollTop += dy; update() }
      }
      raf = requestAnimationFrame(autoscroll)
    }
    const move = (ev: PointerEvent) => {
      x = ev.clientX; y = ev.clientY
      if (!started) {
        if (Math.hypot(x - x0, y - y0) < 6) return
        started = true
        document.body.classList.add('reordering')
        raf = requestAnimationFrame(autoscroll)
      }
      update()
    }
    const finish = (apply: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(raf)
      document.body.classList.remove('reordering')
      if (!started) return
      swallow.current = true
      setTimeout(() => { swallow.current = false }, 0)
      setDrag(null)
      if (!apply) return
      const all = live.current.crates.filter(isDb)
      const rest = all.filter((c) => c.id !== crate.id)
      const before = all.slice(0, slot).filter((c) => c.id !== crate.id).length
      const next = [...rest.slice(0, before), crate, ...rest.slice(before)].map((c) => c.id)
      if (next.some((cid, i) => cid !== all[i]?.id)) live.current.onReorder(next)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false) } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }, [])
  useEffect(() => () => document.body.classList.remove('reordering'), [])

  return (
    <section className={`shelf${collapsed ? ' collapsed' : ''}`} onContextMenu={(e) => { if (e.target === e.currentTarget) onHeaderMenu(e) }}>
      <div className="shelf-h" onContextMenu={onHeaderMenu}>
        <button className="shelf-toggle" aria-expanded={!collapsed} onClick={onToggle} title={collapsed ? 'Desplegar' : 'Encoger'}>
          <IconChevron size={13} className={`caret${collapsed ? '' : ' open'}`} />
          <h2>{title}</h2>
          {count != null && <span className="faint num">{count}</span>}
        </button>
        {hint && <span className="faint">{hint}</span>}
        <div className="spacer" style={{ flex: 1 }} />
        {onAdd && <button className="btn ghost sm icon shelf-add" title="Crear acá" aria-label={`Crear en ${title}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onAdd({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }) }}><IconPlus size={14} /></button>}
      </div>
      <div className="shelf-body" inert={collapsed || undefined}>
        <div className="shelf-inner">
          <div className="shelf-grid" ref={grid} id={`shelf-${id}`}>
            {fixed.map((c) => <CrateCard key={c.id} crate={c} preview={previews[String(c.id)]} onContextMenu={(e) => menuFor(c, e)} />)}
            {crates.map((c) => (
              <CrateCard key={c.id} crate={c} preview={previews[String(c.id)]} sortable={isDb(c)} dragging={drag?.id === c.id}
                onPointerDown={(e) => startDrag(e, c)} onContextMenu={(e) => menuFor(c, e)} />
            ))}
            {empty}
            {drag && <div className="drop-mark" style={drag.mark} />}
          </div>
        </div>
      </div>
      <SwallowClicks flag={swallow} root={grid} />
    </section>
  )
}

/** Después de arrastrar, el click que genera soltar no tiene que abrir la caja. */
function SwallowClicks({ flag, root }: { flag: React.RefObject<boolean>; root: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const stop = (e: MouseEvent) => { if (flag.current) { e.stopPropagation(); e.preventDefault() } }
    el.addEventListener('click', stop, true)
    return () => el.removeEventListener('click', stop, true)
  }, [flag, root])
  return null
}

// ------------------------------------------------------------------ pantalla
const COLLAPSED_KEY = 'batea.shelves.collapsed'
function loadCollapsed(): Set<string> {
  try { const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []) } catch { return new Set() }
}

export function Home() {
  const { crates, virtualCrates, status, trackJob, libraryVersion, go, loadMeta, setSourcesOpen, askText, toast, setExportOpen } = useApp()
  const [previews, setPreviews] = useState<Previews>({})
  const [showHidden, setShowHidden] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  useEffect(() => { api.previews().then(setPreviews).catch(() => {}) }, [libraryVersion, crates.length])

  const toggle = (key: string) => setCollapsed((s) => {
    const n = new Set(s)
    n.has(key) ? n.delete(key) : n.add(key)
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n])) } catch { /* sin storage */ }
    return n
  })

  const hiddenCount = crates.filter((c) => c.hidden && (c.kind === 'playlist' ? c.count > 0 : isOwn(c) || c.kind === 'folder' || c.kind === 'session')).length
  const visible = useMemo(() => crates.filter((c) => showHidden || !c.hidden), [crates, showHidden])
  const folders = useMemo(() => visible.filter((c) => c.kind === 'folder'), [visible])
  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders])

  const shelves = useMemo(() => {
    const inFolder = (c: Crate) => c.parent_id != null && folderIds.has(c.parent_id)
    const mostrador = byHome(visible.filter((c) => isOwn(c) && !inFolder(c)))
    const withKids = folders.map((f) => ({
      folder: f,
      list: byHome(visible.filter((c) => c.parent_id === f.id && ((c.kind === 'playlist' && c.count > 0) || isOwn(c)))),
    })).filter((s) => s.list.length || s.folder.source === 'user')
    const loose = visible.filter((c) => c.kind === 'playlist' && c.count > 0 && !inFolder(c))
    const ordered = withKids.filter((s) => s.folder.home_position != null).sort((a, b) => a.folder.home_position! - b.folder.home_position!)
    const rest = [
      ...withKids.filter((s) => s.folder.home_position == null).map((s) => ({ key: `f${s.folder.id}`, folder: s.folder as Crate | null, list: s.list })),
      ...(loose.length ? [{ key: 'loose', folder: null, list: byHome(loose) }] : []),
    ].sort((a, b) => b.list.length - a.list.length)
    return {
      mostrador,
      folders: [...ordered.map((s) => ({ key: `f${s.folder.id}`, folder: s.folder as Crate | null, list: s.list })), ...rest],
    }
  }, [visible, folders, folderIds])
  const lastSessions = visible.filter((c) => c.kind === 'session' && c.count > 3).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 8)
  const pendingExport = crates.filter((c) => isOwn(c) && c.export_state !== 'done' && c.count > 0)

  // ---- acciones
  const newCrate = async (parent?: number) => {
    const name = await askText('Nombre de la caja nueva')
    if (!name) return
    const { id } = await api.createCrate(name, parent ? { parent_id: parent } : {})
    await loadMeta(); go('crate', String(id))
  }
  const newFolder = async () => {
    const name = await askText('Nombre de la carpeta nueva')
    if (!name) return
    await api.createFolder(name)
    await loadMeta()
    toast(`Carpeta “${name}” creada. Creá cajas adentro con el +, o movelas con clic derecho.`)
    return name
  }
  const guard = (fn: () => Promise<unknown>) => async () => { try { await fn() } catch (e) { toast((e as Error).message, 'error') } }
  const saveOrder = (ids: number[]) => {
    useApp.setState((s) => ({ crates: s.crates.map((c) => { const i = ids.indexOf(c.id as number); return i < 0 ? c : { ...c, home_position: i + 1 } }) }))
    api.orderCrates(ids).catch((e) => { toast((e as Error).message, 'error'); void loadMeta() })
  }
  const hide = async (c: Crate, hidden: boolean) => {
    await api.patchCrate(c.id, { hidden })
    await loadMeta()
    toast(hidden ? `“${c.name}” ya no se ve acá` : `“${c.name}” vuelve a verse`, 'ok',
      hidden ? { label: 'Deshacer', run: () => { void api.patchCrate(c.id, { hidden: false }).then(loadMeta) } } : undefined)
  }
  const move = async (c: Crate, parent: number | null) => { await api.patchCrate(c.id, { parent_id: parent }); await loadMeta() }
  const edge = (list: Crate[], c: Crate, to: 'start' | 'end') => {
    const ids = list.filter(isDb).map((x) => x.id).filter((i) => i !== c.id)
    saveOrder(to === 'start' ? [c.id as number, ...ids] : [...ids, c.id as number])
  }

  const crateMenu = (list: Crate[]) => (c: Crate, e: React.MouseEvent) => {
    const db = isDb(c)
    const own = isOwn(c)
    const exportable = c.id !== 'all' && c.id !== 'hidden'
    const program = crateSource(c)
    openContextMenu(e, c.name, (close) => {
      const run = (fn: () => Promise<unknown> | void) => async () => { close(); try { await fn() } catch (err) { toast((err as Error).message, 'error') } }
      return (
        <>
          <Item onClick={run(() => go('crate', String(c.id)))}>Abrir</Item>
          {exportable && <Item onClick={run(() => setExportOpen(true, [String(c.id)]))} hint="Elegí a qué programa pasarla">Exportar…</Item>}
          {db && c.kind !== 'folder' && (
            <Item onClick={run(async () => { const { id } = await api.duplicateCrate(c.id); await loadMeta(); toast(`Copia creada: “${c.name} (copia)”`); go('crate', String(id)) })}
              hint="Sirve para armar tu versión sin tocar la original">Duplicar como caja mía</Item>
          )}
          {db && (
            <Item onClick={run(async () => {
              const name = await askText('Nuevo nombre', c.name)
              if (name && name !== c.name) { await api.patchCrate(c.id, { name }); await loadMeta() }
            })} disabled={!own} hint={own ? undefined : `Se renombra en ${program ? sourceLabel(program) : 'su programa'}; duplicala para tener una tuya`}>Renombrar…</Item>
          )}
          {db && own && (
            <Item sub={
              <>
                <Item onClick={run(() => move(c, null))}>{c.parent_id == null ? '✓ ' : ''}Mostrador</Item>
                {folders.map((f) => <Item key={f.id} onClick={run(() => move(c, f.id as number))}>{c.parent_id === f.id ? '✓ ' : ''}{f.name}</Item>)}
                <Sep />
                <Item onClick={run(async () => { const name = await newFolder(); if (!name) return
                  const made = useApp.getState().crates.find((x) => x.kind === 'folder' && x.name === name && x.source === 'user')
                  if (made) await move(c, made.id as number) })}>Carpeta nueva…</Item>
              </>
            }>Mover a</Item>
          )}
          {db && list.filter(isDb).length > 1 && (
            <>
              <Sep />
              <Item onClick={run(() => edge(list, c, 'start'))}>Mover al principio</Item>
              <Item onClick={run(() => edge(list, c, 'end'))}>Mover al final</Item>
            </>
          )}
          {db && (
            <>
              <Sep />
              <Item onClick={run(() => hide(c, !c.hidden))} hint="No se borra nada: solo deja de verse en Batea">{c.hidden ? 'Volver a mostrar' : 'Ocultar de Batea'}</Item>
              {own && <Item danger onClick={run(async () => {
                if (!window.confirm(`¿Borrar la caja “${c.name}”?\n\nLos temas no se borran, solo la caja.`)) return
                await api.deleteCrate(c.id); await loadMeta(); toast(`Caja “${c.name}” borrada`)
              })}>Borrar caja…</Item>}
            </>
          )}
        </>
      )
    })
  }

  const folderMenu = (f: Crate, key: string, list: Crate[]) => (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => {
    const mine = f.source === 'user'
    const order = shelves.folders.filter((s) => s.folder).map((s) => s.folder as Crate)
    const at = order.findIndex((x) => x.id === f.id)
    const shift = (d: number) => {
      const next = [...order]
      const [it] = next.splice(at, 1)
      next.splice(at + d, 0, it)
      saveOrder(next.map((x) => x.id as number))
    }
    openContextMenu(e, f.name, (close) => {
      const run = (fn: () => Promise<unknown> | void) => async () => { close(); try { await fn() } catch (err) { toast((err as Error).message, 'error') } }
      return (
        <>
          <Item onClick={run(() => newCrate(f.id as number))}>Caja nueva acá…</Item>
          <Item onClick={run(() => toggle(key))}>{collapsed.has(key) ? 'Desplegar' : 'Encoger'}</Item>
          <Item onClick={run(() => setExportOpen(true, [String(f.id)]))} hint="Se exporta con sus cajas adentro">Exportar la carpeta…</Item>
          <Sep />
          <Item onClick={run(() => shift(-1))} disabled={at <= 0}>Subir carpeta</Item>
          <Item onClick={run(() => shift(1))} disabled={at < 0 || at >= order.length - 1}>Bajar carpeta</Item>
          <Sep />
          <Item onClick={run(async () => {
            const name = await askText('Nuevo nombre de la carpeta', f.name)
            if (name && name !== f.name) { await api.patchCrate(f.id, { name }); await loadMeta() }
          })} disabled={!mine} hint={mine ? undefined : 'Esta carpeta viene de otro programa: se renombra ahí'}>Renombrar carpeta…</Item>
          <Item onClick={run(() => hide(f, !f.hidden))}>{f.hidden ? 'Volver a mostrar' : 'Ocultar la carpeta'}</Item>
          {mine && <Item danger onClick={run(async () => {
            const msg = list.length
              ? `¿Borrar la carpeta “${f.name}”?\n\nLas ${list.length} cajas de adentro no se borran: pasan a Mostrador.`
              : `¿Borrar la carpeta “${f.name}”?`
            if (!window.confirm(msg)) return
            await api.deleteCrate(f.id); await loadMeta(); toast(`Carpeta “${f.name}” borrada`)
          })}>Borrar carpeta…</Item>}
        </>
      )
    })
  }

  const addMenu = (parent: Crate | null) => (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => {
    openContextMenu(e, parent ? parent.name : 'Mostrador', (close) => (
      <>
        <Item onClick={() => { close(); void guard(() => newCrate(parent ? (parent.id as number) : undefined))() }}>Caja nueva…</Item>
        {!parent && <Item onClick={() => { close(); void guard(newFolder)() }}>Carpeta nueva…</Item>}
      </>
    ))
  }

  if (status && status.library_tracks === 0) {
    return (
      <div className="home">
        <div className="empty" style={{ marginTop: 80 }}>
          <h3>Batea está vacía</h3>
          <p>{status.sources ? 'Traé tu librería de rekordbox, Traktor o Serato, o elegí una carpeta con música.' : status.rekordbox_found
            ? 'Traé tu librería de rekordbox o una carpeta con música.'
            : 'No encontré rekordbox. Traé una carpeta con música o arrastrala a la ventana.'}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {status.sources ? <button className="btn primary" onClick={() => setSourcesOpen(true)}>Ver programas</button>
              : status.rekordbox_found && <button className="btn primary" onClick={async () => trackJob(await api.sync())}><IconSync size={14} /> Importar rekordbox</button>}
            <button className="btn" onClick={() => go('inbox')}>Analizar carpeta</button>
          </div>
        </div>
      </div>
    )
  }

  const shortcuts = virtualCrates.filter((v) => v.count > 0)
  return (
    <>
      <header className="viewhead">
        <div>
          <h1>Bateas</h1>
          <div className="sub">{status?.tracks.toLocaleString('es-AR')} temas{status?.universe ? ` en ${status.universe.name}` : ''}</div>
        </div>
        <div className="spacer" />
        {pendingExport.length > 0 && (
          <button className="btn" onClick={() => setExportOpen(true, pendingExport.map((c) => String(c.id)))}
            title="Cajas tuyas que todavía no están en rekordbox, o que cambiaron después de exportarlas">
            Exportar {pendingExport.length} {pendingExport.length === 1 ? 'pendiente' : 'pendientes'}
          </button>
        )}
        <button className="btn" onClick={() => void guard(newFolder)()}><IconPlus size={14} /> Carpeta nueva</button>
        <button className="btn" onClick={() => void guard(() => newCrate())()}><IconPlus size={14} /> Caja nueva</button>
      </header>
      <div className="home">
        <Shelf id="mostrador" title="Mostrador" hint="atajos y tus cajas" collapsed={collapsed.has('mostrador')} onToggle={() => toggle('mostrador')}
          onHeaderMenu={addMenu(null)} onAdd={addMenu(null)} fixed={shortcuts} crates={shelves.mostrador} previews={previews}
          onReorder={saveOrder} menuFor={crateMenu(shelves.mostrador)} />
        {shelves.folders.map(({ key, folder, list }) => (
          <Shelf key={key} id={key} title={folder ? folder.name : 'Sueltas'} count={list.length} collapsed={collapsed.has(key)} onToggle={() => toggle(key)}
            onHeaderMenu={folder ? folderMenu(folder, key, list) : addMenu(null)}
            onAdd={folder ? addMenu(folder) : undefined} crates={list} previews={previews} onReorder={saveOrder} menuFor={crateMenu(list)}
            empty={folder && !list.length ? (
              <button className="crate-new" onClick={() => void guard(() => newCrate(folder.id as number))()}><IconPlus size={16} /> Caja nueva acá</button>
            ) : undefined} />
        ))}
        {lastSessions.length > 0 && (
          <Shelf id="sessions" title="Últimas sesiones" collapsed={collapsed.has('sessions')} onToggle={() => toggle('sessions')}
            onHeaderMenu={addMenu(null)} crates={[]} fixed={lastSessions} previews={previews} onReorder={saveOrder} menuFor={crateMenu(lastSessions)} />
        )}
        {hiddenCount > 0 && (
          <button className="btn ghost sm hidden-toggle" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? 'Dejar de mostrar las ocultas' : `${hiddenCount} ${hiddenCount === 1 ? 'oculta' : 'ocultas'} · mostrar`}
          </button>
        )}
      </div>
    </>
  )
}
