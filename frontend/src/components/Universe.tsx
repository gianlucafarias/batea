import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { EditorCrate } from '../types'
import { IconCheck, IconChevron, IconPencil, IconPlus } from './icons'
import { HoverList } from '../lib/fluidHover'
import { spring, usePresence } from '../lib/motion'

/** Selector del universo de trabajo, arriba en la barra lateral. */
export function UniverseSwitcher() {
  const { universes, activateUniverse, setUniverseEditor } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [shown, closing] = usePresence(open, spring.moderate.exit)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  if (!universes) return null
  const active = universes.items.find((u) => u.id === universes.active)
  return (
    <div className="uni" data-tour="universe" ref={ref}>
      <button className="uni-btn" onClick={() => setOpen(!open)} title="Qué parte de la librería ves" aria-expanded={open}>
        <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
          <span className="uni-label">Universo</span>
          <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{active ? active.name : 'Toda la librería'}</span>
        </span>
        <span className="num faint" style={{ fontSize: 11 }}>{(active ? active.count : universes.total).toLocaleString('es-AR')}</span>
        <IconChevron size={12} style={{ transform: 'rotate(90deg)', color: 'var(--faint)' }} />
      </button>
      {shown && (
        <HoverList className={`popover uni-pop${closing ? ' closing' : ''}`}>
          <button data-fh className="uni-row" onClick={() => { setOpen(false); void activateUniverse(null) }}>
            <span className="uni-mark">{!active && <IconCheck size={13} />}</span>
            <span className="ellipsis">Toda la librería</span>
            <span className="num uni-n">{universes.total.toLocaleString('es-AR')}</span>
            <span />
          </button>
          {universes.items.map((u) => (
            <div key={u.id} data-fh className="uni-row" role="button" tabIndex={0} onClick={() => { setOpen(false); void activateUniverse(u.id) }}>
              <span className="uni-mark">{u.id === universes.active && <IconCheck size={13} />}</span>
              <span className="ellipsis">{u.name}</span>
              <span className="num uni-n">{u.count.toLocaleString('es-AR')}</span>
              <button className="uni-edit" title={`Editar ${u.name}`} aria-label={`Editar ${u.name}`}
                onClick={(e) => { e.stopPropagation(); setOpen(false); setUniverseEditor({ id: u.id }) }}><IconPencil size={13} /></button>
            </div>
          ))}
          <div className="uni-sep" />
          <button data-fh className="uni-row" onClick={() => { setOpen(false); setUniverseEditor({ id: null }) }}>
            <span className="uni-mark"><IconPlus size={13} /></span>
            <span>Nuevo universo</span>
            <span /><span />
          </button>
        </HoverList>
      )}
    </div>
  )
}

function bpmHint(bpm: number | null) {
  if (!bpm) return ''
  return `~${bpm}`
}

/** Editor: elegir qué playlists y carpetas forman el universo. */
export function UniverseEditor() {
  const { universeEditor, setUniverseEditor, universes, loadMeta, bump, toast, activateUniverse } = useApp()
  const [crates, setCrates] = useState<EditorCrate[]>([])
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [name, setName] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [count, setCount] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [ue, closing] = usePresence(universeEditor, spring.slow.exit)
  const editing = ue?.id != null ? universes?.items.find((u) => u.id === ue.id) : undefined

  useEffect(() => {
    if (!universeEditor) return
    api.universeEditor().then(setCrates).catch(() => {})
    setSel(new Set(editing?.crate_ids ?? []))
    setName(editing?.name ?? '')
    setQ('')
    setOpen(new Set())
  }, [universeEditor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!universeEditor) return
    const ids = [...sel]
    const t = setTimeout(() => { api.universeCount(ids).then((r) => setCount(r.count)).catch(() => {}) }, 150)
    return () => clearTimeout(t)
  }, [sel, universeEditor])

  const kids = useMemo(() => {
    const m = new Map<number | null, EditorCrate[]>()
    for (const c of crates) {
      const k = c.parent_id ?? null
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(c)
    }
    return m
  }, [crates])
  const totals = useMemo(() => {
    const memo = new Map<number, number>()
    const walk = (c: EditorCrate): number => {
      const v = c.count + (kids.get(c.id) ?? []).reduce((a, k) => a + walk(k), 0)
      memo.set(c.id, v)
      return v
    }
    for (const c of kids.get(null) ?? []) walk(c)
    return memo
  }, [kids])

  if (!ue) return null

  const toggle = (c: EditorCrate) => {
    const n = new Set(sel)
    if (n.has(c.id)) n.delete(c.id)
    else {
      n.add(c.id)
      // elegir una carpeta incluye todo lo de adentro: se limpian las marcas sueltas de sus hijos
      const drop = (id: number) => { for (const k of kids.get(id) ?? []) { n.delete(k.id); drop(k.id) } }
      drop(c.id)
    }
    setSel(n)
  }

  const row = (c: EditorCrate, depth: number, inherited: boolean) => {
    const children = kids.get(c.id) ?? []
    const isFolder = c.kind === 'folder'
    const total = totals.get(c.id) ?? 0
    if (!total && !sel.has(c.id)) return null
    const checked = inherited || sel.has(c.id)
    const isOpen = open.has(c.id) || !!q
    if (q && !isFolder && !c.name.toLowerCase().includes(q.toLowerCase())) return null
    return (
      <div key={c.id}>
        <label data-fh={inherited ? undefined : ''} style={{ paddingLeft: 8 + depth * 18, opacity: inherited ? 0.6 : 1 }}>
          {isFolder ? (
            <button type="button" onClick={(e) => { e.preventDefault(); const n = new Set(open); n.has(c.id) ? n.delete(c.id) : n.add(c.id); setOpen(n) }}>
              <IconChevron size={12} className={`caret${isOpen ? ' open' : ''}`} style={{ transition: 'transform var(--moderate) var(--spring)', transform: isOpen ? 'rotate(90deg)' : undefined, color: 'var(--faint)' }} />
            </button>
          ) : <span style={{ width: 12 }} />}
          <input type="checkbox" checked={checked} disabled={inherited} onChange={() => toggle(c)} />
          <span className="ellipsis" style={{ fontWeight: isFolder ? 650 : 450 }}>{c.name}{c.kind === 'user' ? ' · caja tuya' : ''}</span>
          <span className="count" style={{ display: 'flex', gap: 10 }}>
            {!isFolder && c.bpm ? <span title="BPM mediano">{bpmHint(c.bpm)} bpm</span> : null}
            <span style={{ minWidth: 34, textAlign: 'right' }}>{total.toLocaleString('es-AR')}</span>
          </span>
        </label>
        {isFolder && isOpen && children.map((k) => row(k, depth + 1, checked))}
      </div>
    )
  }

  const save = async () => {
    const ids = [...sel]
    try {
      if (editing) {
        await api.patchUniverse(editing.id, { name: name.trim() || editing.name, crate_ids: ids })
        await loadMeta(); bump()
        toast(`Universo “${name.trim() || editing.name}” actualizado`)
      } else {
        const r = await api.createUniverse(name.trim() || 'Mi universo', ids)
        await activateUniverse(r.active)
        toast(`Universo “${name.trim() || 'Mi universo'}” activo: Batea ahora solo ve esos temas`)
      }
      setUniverseEditor(null)
    } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && setUniverseEditor(null)}>
      <div className="modal" style={{ width: 640 }}>
        <div>
          <h2>{editing ? 'Editar universo' : 'Nuevo universo'}</h2>
          <p className="muted" style={{ margin: '6px 0 0', lineHeight: 1.5 }}>
            Elegí las playlists y carpetas con las que querés trabajar. Mientras el universo esté activo, las bateas, el mapa,
            las sugerencias y la bandeja de sin clasificar solo muestran esos temas. El resto queda guardado y vuelve al elegir “Toda la librería”.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ flex: 1 }} placeholder="Nombre (ej: Techno)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input className="input" style={{ width: 190 }} placeholder="Buscar playlist…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <HoverList className="check-list" style={{ maxHeight: 380 }}>
          {(kids.get(null) ?? []).map((c) => row(c, 0, false))}
        </HoverList>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="muted">
            {sel.size ? <><b className="num" style={{ color: 'var(--text)' }}>{count?.toLocaleString('es-AR') ?? '…'}</b> temas distintos en {sel.size} {sel.size === 1 ? 'selección' : 'selecciones'}</> : 'Marcá al menos una caja'}
          </span>
          <div style={{ flex: 1 }} />
          {editing && (
            <button className="btn ghost" onClick={async () => {
              if (!confirm(`¿Borrar el universo “${editing.name}”? Los temas y las cajas no se tocan.`)) return
              await api.deleteUniverse(editing.id); await loadMeta(); bump(); setUniverseEditor(null)
            }}>Borrar</button>
          )}
          <button className="btn ghost" onClick={() => setUniverseEditor(null)}>Cancelar</button>
          <button className="btn primary" disabled={!sel.size} onClick={save}>{editing ? 'Guardar' : 'Crear y activar'}</button>
        </div>
      </div>
    </div>
  )
}
