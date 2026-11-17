import { useState } from 'react'
import { useApp } from '../store'
import type { Crate, FolderNode } from '../types'
import { IconChevron } from './icons'

export const DIR = 'dir:'

function find(nodes: FolderNode[], path: string, trail: FolderNode[] = []): FolderNode[] | null {
  for (const n of nodes) {
    if (n.p === path) return [...trail, n]
    if (n.k && path.startsWith(n.p + '/')) {
      const r = find(n.k, path, [...trail, n])
      if (r) return r
    }
  }
  return null
}

/** La carpeta abierta como si fuera una caja, para reusar la vista de cajas. */
export function folderCrate(crateId: string | null, folders: FolderNode[]): (Crate & { trail: string[]; path: string; off: boolean }) | undefined {
  if (!crateId?.startsWith(DIR)) return undefined
  const path = crateId.slice(DIR.length)
  const trail = find(folders, path) ?? []
  const last = trail[trail.length - 1]
  return {
    id: crateId, kind: 'dir', path,
    name: last?.root ? last.n : path.split('/').pop() || path,
    count: last?.c ?? 0,
    trail: trail.slice(0, -1).map((n) => n.n),
    off: !!trail[0]?.off,
  }
}

function Node({ n, depth, open, toggle }: { n: FolderNode; depth: number; open: Set<string>; toggle: (p: string, v?: boolean) => void }) {
  const { view, crateId, go } = useApp()
  const isOpen = open.has(n.p)
  const on = view === 'crate' && crateId === DIR + n.p
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-fh
        className={`tree-row${on ? ' on' : ''}${n.off ? ' hidden-crate' : ''}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        title={n.off ? `${n.n}: disco desconectado` : n.p}
        onClick={() => { go('crate', DIR + n.p); if (n.k) toggle(n.p, true) }}
      >
        {n.k
          ? <IconChevron size={12} className={`caret${isOpen ? ' open' : ''}`} onClick={(e) => { e.stopPropagation(); toggle(n.p) }} />
          : <span style={{ width: 12, flex: 'none' }} />}
        <span className="ellipsis">{n.n}</span>
        <span className="count">{n.off ? 'desconectado' : n.c.toLocaleString('es-AR')}</span>
      </div>
      {isOpen && n.k?.map((k) => <Node key={k.p} n={k} depth={depth + 1} open={open} toggle={toggle} />)}
    </>
  )
}

export function FolderTree() {
  const folders = useApp((s) => s.folders)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (p: string, v?: boolean) => setOpen((o) => {
    const n = new Set(o)
    const want = v ?? !n.has(p)
    if (want) n.add(p); else n.delete(p)
    return n
  })
  if (!folders.length) return <div className="faint" style={{ padding: '2px 10px 6px 32px', fontSize: 11.5 }}>Todavía no encontré carpetas con música.</div>
  return <>{folders.map((n) => <Node key={n.p} n={n} depth={0} open={open} toggle={toggle} />)}</>
}
