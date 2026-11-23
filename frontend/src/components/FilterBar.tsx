import { useEffect, useMemo, useRef, useState } from 'react'
import { Seg } from '../lib/Seg'
import { spring, usePresence } from '../lib/motion'
import { CORE_SOURCES, sourceLabel } from '../sources'
import { useApp } from '../store'
import type { Filters, Tag } from '../types'
import { keyColor, ROLE_CATEGORIES } from '../util'
import { allNotations, formatKey, useKeyNotation } from '../lib/keyNotation'
import { IconFilter, IconSearch, IconX } from './icons'

export function groupTags(tags: Tag[]): [string, Tag[]][] {
  const m = new Map<string, Tag[]>()
  for (const t of tags) {
    if (!m.has(t.category)) m.set(t.category, [])
    m.get(t.category)!.push(t)
  }
  const order = (c: string) => {
    const i = ROLE_CATEGORIES.indexOf(c)
    return i >= 0 ? i : c.startsWith('rekordbox') ? 100 : 50
  }
  return [...m.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
}

function NumRange({ label, min, max, step, value, onChange, placeholder }: {
  label: string; min: number; max: number; step?: number; value: [number | undefined, number | undefined]
  onChange: (v: [number | undefined, number | undefined]) => void; placeholder: [string, string]
}) {
  const parse = (s: string) => (s === '' ? undefined : Math.max(min, Math.min(max, Number(s))))
  return (
    <div className="range-row">
      <span className="eyebrow">{label}</span>
      <input className="input num" type="number" step={step} placeholder={placeholder[0]} value={value[0] ?? ''} onChange={(e) => onChange([parse(e.target.value), value[1]])} />
      <input className="input num" type="number" step={step} placeholder={placeholder[1]} value={value[1] ?? ''} onChange={(e) => onChange([value[0], parse(e.target.value)])} />
    </div>
  )
}

export function KeyWheelPicker({ selected, onToggle }: { selected: string[]; onToggle: (k: string) => void }) {
  const notation = useKeyNotation((s) => s.notation)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 3 }}>
      {['B', 'A'].flatMap((l) => Array.from({ length: 12 }, (_, i) => `${i + 1}${l}`)).map((k) => {
        const on = selected.includes(k)
        return (
          <button key={k} onClick={() => onToggle(k)} className="keybadge" style={{
            background: on ? keyColor(k) : 'transparent', color: on ? '#111' : keyColor(k), border: `1px solid ${keyColor(k, on ? 1 : 0.45)}`, minWidth: 0, height: 22,
          }} title={allNotations(k)}>{formatKey(k, notation)}</button>
        )
      })}
    </div>
  )
}

interface Props {
  /** cuántos temas de lo que se está viendo tienen cada etiqueta (si no se pasa, el total de la librería) */
  counts?: Map<number, number>
  filters: Filters
  onChange: (f: Filters) => void
  onSaveSmart?: () => void
}

export function FilterBar({ filters, onChange, onSaveSmart, counts }: Props) {
  const tags = useApp((s) => s.tags)
  const sources = useApp((s) => s.status?.sources)
  const multiSource = (sources?.filter((source) => source.enabled).length ?? 0) > 1
  const sourceOptions = [...CORE_SOURCES, ...(sources ?? []).filter((source) => source.enabled && !CORE_SOURCES.some((kind) => kind === source.kind)).map((source) => source.kind)]
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState(filters.q ?? '')
  const popRef = useRef<HTMLDivElement>(null)
  const [popShown, popClosing] = usePresence(open, spring.moderate.exit)
  const grouped = useMemo(() => groupTags(tags), [tags])
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])

  useEffect(() => { setQ(filters.q ?? '') }, [filters.q])
  useEffect(() => {
    const t = setTimeout(() => { if ((filters.q ?? '') !== q) onChange({ ...filters, q }) }, 220)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false) }
    setTimeout(() => document.addEventListener('mousedown', h), 0)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })
  const toggleIn = (arr: (number | string)[] | undefined, v: number | string) =>
    arr?.includes(v as never) ? arr.filter((x) => x !== v) : [...(arr ?? []), v]

  const active: { label: string; clear: () => void; color?: string }[] = []
  if (filters.bpm_min || filters.bpm_max) active.push({ label: `BPM ${filters.bpm_min ?? '…'}–${filters.bpm_max ?? '…'}`, clear: () => set({ bpm_min: undefined, bpm_max: undefined }) })
  if (filters.energy_min || filters.energy_max) active.push({ label: `Energía ${filters.energy_min ?? 1}–${filters.energy_max ?? 10}`, clear: () => set({ energy_min: undefined, energy_max: undefined }) })
  if (filters.rating_min) active.push({ label: `★ ${filters.rating_min}+`, clear: () => set({ rating_min: undefined }) })
  if (filters.in_source) active.push({
    label: filters.in_source === 'none' ? 'Solo tu música' : `En ${sourceLabel(filters.in_source)}`,
    clear: () => set({ in_source: undefined }),
  })
  if (filters.key_compat) active.push({ label: `Compatible ${filters.key_compat}`, clear: () => set({ key_compat: undefined }), color: keyColor(filters.key_compat) })
  for (const k of filters.keys ?? []) active.push({ label: k, clear: () => set({ keys: filters.keys!.filter((x) => x !== k) }), color: keyColor(k) })
  for (const id of filters.tags ?? []) {
    const t = tagById.get(Number(id))
    if (t) active.push({ label: t.name, clear: () => set({ tags: filters.tags!.filter((x) => x !== id) }), color: t.color ?? undefined })
  }
  for (const id of filters.not_tags ?? []) {
    const t = tagById.get(Number(id))
    if (t) active.push({ label: `sin ${t.name}`, clear: () => set({ not_tags: filters.not_tags!.filter((x) => x !== id) }) })
  }
  const hasAny = active.length > 0 || !!filters.q

  return (
    <>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <IconSearch size={14} style={{ position: 'absolute', left: 9, color: 'var(--faint)' }} />
        <input className="input search" style={{ paddingLeft: 28 }} placeholder="Buscar tema, artista, sello…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div style={{ position: 'relative' }}>
        <button className={`btn sm${active.length ? ' primary' : ''}`} onClick={() => setOpen(!open)}>
          <IconFilter size={14} /> Filtros{active.length ? ` · ${active.length}` : ''}
        </button>
        {popShown && (
          <div className={`filter-pop${popClosing ? ' closing' : ''}`} ref={popRef}>
            <div style={{ display: 'grid', gap: 8 }}>
              <NumRange label="BPM" min={40} max={220} step={0.5} placeholder={['desde', 'hasta']} value={[filters.bpm_min, filters.bpm_max]} onChange={([a, b]) => set({ bpm_min: a, bpm_max: b })} />
              <NumRange label="Energía" min={1} max={10} placeholder={['1', '10']} value={[filters.energy_min, filters.energy_max]} onChange={([a, b]) => set({ energy_min: a, energy_max: b })} />
              <div className="range-row">
                <span className="eyebrow">Puntaje</span>
                <Seg style={{ gridColumn: 'span 2', width: 'fit-content' }}>
                  {[0, 1, 2, 3, 4, 5].map((r) => (
                    <button key={r} className={(filters.rating_min ?? 0) === r ? 'on' : ''} onClick={() => set({ rating_min: r || undefined })}>{r ? `${r}★+` : 'todos'}</button>
                  ))}
                </Seg>
              </div>
              {multiSource && (
                <label className="range-row">
                  <span className="eyebrow">Programa</span>
                  <select className="input" style={{ gridColumn: 'span 2' }} value={filters.in_source ?? ''} onChange={(e) => set({ in_source: e.target.value || undefined })}>
                    <option value="">Todos</option>
                    {sourceOptions.map((kind) => <option key={kind} value={kind}>{sourceLabel(kind)}</option>)}
                    <option value="none">Ninguno (tu música)</option>
                  </select>
                </label>
              )}
            </div>
            <div className="tag-group">
              <span className="eyebrow">Tonalidad</span>
              <KeyWheelPicker selected={filters.keys ?? []} onToggle={(k) => set({ keys: toggleIn(filters.keys, k) as string[] })} />
            </div>
            {grouped.map(([cat, list]) => (
              <div className="tag-group" key={cat}>
                <span className="eyebrow">{cat}</span>
                <div className="chips">
                  {list.map((t) => {
                    const inc = filters.tags?.map(Number).includes(t.id)
                    const exc = filters.not_tags?.map(Number).includes(t.id)
                    const n = counts ? counts.get(t.id) ?? 0 : t.count
                    return (
                      <button
                        key={t.id}
                        className={`chip${inc ? ' on' : ''}`}
                        style={{ ['--c' as string]: t.color ?? undefined, textDecoration: exc ? 'line-through' : undefined, opacity: exc ? 0.7 : !n && !inc ? 0.4 : 1 }}
                        title={`${n} ${n === 1 ? 'tema' : 'temas'} de los que estás viendo · click: incluir · Alt+click: excluir`}
                        onClick={(e) => {
                          if (e.altKey) set({ not_tags: toggleIn(filters.not_tags, t.id) as number[], tags: (filters.tags ?? []).filter((x) => Number(x) !== t.id) })
                          else set({ tags: toggleIn(filters.tags?.map(Number), t.id) as number[], not_tags: (filters.not_tags ?? []).filter((x) => Number(x) !== t.id) })
                        }}
                      >
                        <span className="dot" style={{ background: t.color ?? 'var(--muted)' }} />{t.name}
                        <span className="faint num" style={{ fontSize: 10 }}>{n}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <div className="faint" style={{ fontSize: 11 }}>Alt+click en una etiqueta para excluirla.</div>
          </div>
        )}
      </div>
      <div className="active-filters">
        {active.map((a, i) => (
          <button key={i} className="chip on" style={{ ['--c' as string]: a.color }} onClick={a.clear}>{a.label}<IconX size={11} /></button>
        ))}
      </div>
      {hasAny && (
        <>
          <button className="btn ghost sm" onClick={() => onChange({})}>Limpiar</button>
          {onSaveSmart && <button className="btn ghost sm" onClick={onSaveSmart}>Guardar como caja inteligente</button>}
        </>
      )}
    </>
  )
}
