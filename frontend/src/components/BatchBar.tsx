import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { Track } from '../types'
import { energyColor, Stars } from './bits'
import { groupTags } from './FilterBar'
import { IconCheck, IconMix, IconTag, IconX } from './icons'

/** Barra flotante para aplicar etiquetas, energía, puntaje o caja a varios temas a la vez. */
export function BatchBar({ tracks, onClear }: { tracks: Track[]; onClear: () => void }) {
  const { tags, crates, loadMeta, bump, toast, openTagger, openMix, askText, analyzeTracks } = useApp()
  const toAnalyze = useMemo(() => tracks.filter((t) => t.online && (t.unanalyzed === 'pending' || t.unanalyzed === 'error')).map((t) => t.id), [tracks])
  const [pop, setPop] = useState<'tags' | 'energy' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const ids = useMemo(() => tracks.map((t) => t.id), [tracks])
  const grouped = useMemo(() => groupTags(tags.filter((t) => t.source === 'user')), [tags])
  const userCrates = crates.filter((c) => c.kind === 'user')

  useEffect(() => {
    if (!pop) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setPop(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [pop])

  const after = async (msg: string) => { await loadMeta(); bump(); toast(msg) }
  const n = ids.length

  return (
    <div className="batchbar" ref={ref}>
      <b className="num">{n}</b><span className="muted">seleccionados</span>
      <span className="sep" />

      <div style={{ position: 'relative' }}>
        <button className={`btn sm${pop === 'tags' ? ' primary' : ''}`} onClick={() => setPop(pop === 'tags' ? null : 'tags')}><IconTag size={13} /> Etiquetas</button>
        {pop === 'tags' && (
          <div className="popover batch-pop" style={{ width: 460 }}>
            {grouped.map(([cat, list]) => (
              <div className="tag-group" key={cat}>
                <span className="eyebrow">{cat}</span>
                <div className="chips">
                  {list.map((t) => {
                    const have = tracks.filter((x) => x.tags.includes(t.id)).length
                    const all = have === n
                    return (
                      <button key={t.id} className={`chip${all ? ' on' : have ? ' auto on' : ''}`} style={{ ['--c' as string]: t.color ?? undefined }}
                        title={all ? 'Todos la tienen · click para quitarla' : have ? `${have} de ${n} la tienen · click para ponérsela a todos` : 'Click para ponérsela a todos'}
                        onClick={async () => { await api.assignTag(ids, t.id, !all); await after(all ? `“${t.name}” quitada de ${n} temas` : `“${t.name}” en ${n} temas`) }}>
                        <span className="dot" style={{ background: t.color ?? 'var(--muted)' }} />{t.name}{have && !all ? <span className="faint num" style={{ fontSize: 10 }}>{have}</span> : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <button className={`btn sm${pop === 'energy' ? ' primary' : ''}`} onClick={() => setPop(pop === 'energy' ? null : 'energy')}>Energía</button>
        {pop === 'energy' && (
          <div className="popover batch-pop" style={{ width: 300 }}>
            <div className="tg-energy" style={{ height: 54 }}>
              {Array.from({ length: 10 }, (_, k) => (
                <button key={k} className="on" onClick={async () => { await api.batch(ids, { energy: k + 1 }); setPop(null); await after(`Energía ${k + 1} en ${n} temas`) }}>
                  <i style={{ height: `${28 + k * 8}%`, background: energyColor(k + 1) }} /><span className="num">{k + 1}</span>
                </button>
              ))}
            </div>
            <button className="btn ghost sm" onClick={async () => { await api.batch(ids, { clear_energy: true }); setPop(null); await after('Energía vuelta a la estimada') }}>Volver a la estimada</button>
          </div>
        )}
      </div>

      <span title="Puntaje para todos"><Stars value={0} onChange={async (v) => { if (v) { await api.batch(ids, { rating: v }); await after(`${v}★ en ${n} temas`) } }} /></span>

      <select className="input" style={{ height: 26, fontSize: 12, width: 130 }} value="" onChange={async (e) => {
        const v = e.target.value
        if (!v) return
        let id: number | string = v
        let name = userCrates.find((c) => String(c.id) === v)?.name ?? ''
        if (v === '__new') {
          const nm = await askText('Nombre de la caja nueva')
          if (!nm) return
          id = (await api.createCrate(nm)).id; name = nm
        }
        await api.addToCrate(id, ids)
        await after(`${n} temas agregados a “${name}”`)
      }}>
        <option value="">A una caja…</option>
        {userCrates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="__new">Nueva caja…</option>
      </select>

      <span className="sep" />
      {toAnalyze.length > 0 && (
        <button className="btn sm" title="Calcula BPM, tono, energía, intro y outro, de a un tema por vez" onClick={() => analyzeTracks(toAnalyze)}>
          Analizar {toAnalyze.length}
        </button>
      )}
      <button className="btn sm" onClick={() => openTagger(tracks, `${n} seleccionados`)} title="Escuchar y etiquetar estos temas uno por uno">Etiquetar en tanda</button>
      {n === 2 && <button className="btn sm" onClick={() => openMix(ids[0], ids[1])}><IconMix size={13} /> Probar mezcla</button>}
      <button className="btn sm ghost" title="Marcar como revisados (salen de Sin clasificar)" onClick={async () => { await api.batch(ids, { reviewed: true }); await after(`${n} marcados como revisados`) }}><IconCheck size={13} /></button>
      <button className="btn sm ghost icon" onClick={onClear} title="Quitar selección (Esc)"><IconX size={13} /></button>
    </div>
  )
}
