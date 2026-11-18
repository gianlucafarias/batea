import { ArtistLinks } from './Artist'
import { AnalysisNotice } from './Analysis'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, isNotFound, type TrackSource } from '../api'
import { sourceLabel } from '../sources'
import { useApp, usePlayer } from '../store'
import type { Recommendation, Relation, Track, TrackDetail } from '../types'
import { cleanTitle, compatibleKeys, fmtBpm, fmtDate, fmtTime, keyColor, ROLE_CATEGORIES } from '../util'
import { EnergyEditor, KeyBadge, Sleeve, Stars } from './bits'
import { groupTags } from './FilterBar'
import { IconFinder, IconLink, IconMix, IconPause, IconPlay, IconPlus, IconSearch, IconThumbDown, IconThumbUp, IconX } from './icons'
import { useWaveform, Waveform } from './Waveform'
import { GlyphSwap, HoverList } from '../lib/fluidHover'
import { Seg } from '../lib/Seg'

const REL_LABEL = { mix: 'Mezcla bien con', mashup: 'Mashup con', similar: 'Misma vibra que', history: 'Lo tocaste con', avoid: 'No va con' } as const

const REL_KINDS: { kind: Relation['kind']; label: string; hint: string }[] = [
  { kind: 'mix', label: 'Mezcla bien', hint: 'La transición funciona' },
  { kind: 'mashup', label: 'Mashup', hint: 'Se pueden tocar uno encima del otro' },
  { kind: 'similar', label: 'Misma vibra', hint: 'Intercambiables' },
  { kind: 'avoid', label: 'No van', hint: 'No sugerirlo más' },
]

function toTrack(d: TrackDetail): Track { return d }

function SourceAnalysis({ sources }: { sources: TrackSource[] | 'error' }) {
  if (sources === 'error') return <div className="section"><span className="eyebrow">En cada programa</span><span className="muted">No pude cargar los datos de los programas.</span></div>
  if (!sources.length) return null

  const tonalities = sources.flatMap((source) => {
    const camelot = source.key_camelot?.trim().toUpperCase()
    const tone = camelot || source.key_raw?.trim()
    return tone ? [{ label: source.label || sourceLabel(source.source), tone, camelot }] : []
  })
  const conflicts = tonalities.flatMap((a, index) => tonalities.slice(index + 1).filter((b) => {
    // Comparamos tonos en el mismo formato para no marcar C#m y 12A como distintos.
    return Boolean(a.camelot) === Boolean(b.camelot) && a.tone.toLowerCase() !== b.tone.toLowerCase()
  }).map((b) => [a, b] as const))
  const conflictingTones = tonalities.filter((tone) => conflicts.some((pair) => pair.includes(tone)))
  const distant = conflicts.some(([a, b]) => !compatibleKeys(a.camelot).includes(b.camelot ?? ''))

  return (
    <div className="section">
      <span className="eyebrow">En cada programa</span>
      <div className="track-sources">
        {sources.map((source) => (
          <div className="track-source" key={source.source}>
            <b>{source.label || sourceLabel(source.source)}</b>
            <span className="num muted">{source.bpm ? `${fmtBpm(source.bpm)} BPM` : '—'}</span>
            <span>{source.key_camelot ? <KeyBadge k={source.key_camelot} /> : source.key_raw || '—'}</span>
            <span title={source.rating == null ? 'Sin puntaje' : `${source.rating} de 5 estrellas`}>
              {source.rating == null ? '—' : <Stars value={source.rating} />}
            </span>
            <span className="num muted">{source.cues_count == null ? '—' : `${source.cues_count} ${source.cues_count === 1 ? 'cue' : 'cues'}`}</span>
          </div>
        ))}
      </div>
      {conflictingTones.length > 0 && (
        <p className={`track-source-conflict${distant ? ' strong' : ''}`}>
          Tono distinto: {conflictingTones.map(({ label, tone }) => `${label} dice ${tone}`).join(', ')}
        </p>
      )}
    </div>
  )
}

/** Una sola línea gris debajo del título: artista · 144 BPM · 4A (en su color) · algo más. */
function Meta({ artist, bpm, k, extra }: { artist?: string | null; bpm?: number | null; k?: string | null; extra?: string | null }) {
  const parts: React.ReactNode[] = []
  if (artist) parts.push(artist)
  if (bpm) parts.push(`${fmtBpm(bpm)} BPM`)
  if (k) parts.push(<b key="k" className="keytxt" style={{ color: keyColor(k) }}>{k}</b>)
  if (extra) parts.push(extra)
  return <div className="meta ellipsis">{parts.map((p, i) => <span key={i}>{i > 0 && ' · '}{p}</span>)}</div>
}

/** El motivo de una sugerencia en palabras simples (el motor lo manda pensado para la IA: "4B→4A relativa mayor/menor (tono estimado)"). */
function plainReason(reasons: string[]): string | null {
  const find = (re: RegExp) => reasons.find((x) => re.test(x))
  const h = find(/^lo mezclaste/)
  if (h) return h.replace(/^l/, 'L')
  if (find(/^marcaste que mezclan bien/)) return 'Marcaste que mezclan bien'
  if (find(/^funciona como mashup/)) return 'Sirve para mashup'
  if (find(/^misma vibra/)) return 'Misma vibra'
  const k = find(/→/)
  if (k) {
    if (k.includes('misma tonalidad')) return 'Mismo tono'
    if (k.includes('tonalidad vecina')) return 'Tono vecino'
    if (k.includes('relativa')) return 'Tono relativo'
    if (k.includes('salto de energía')) return 'Tono que levanta'
    if (k.includes('diagonal')) return 'Tono compatible'
  }
  const e = find(/^energía/)
  if (e) return e.includes('+') ? 'Más energía' : 'Menos energía'
  const c = find(/^comparten: /)
  if (c) return 'Comparten ' + c.slice('comparten: '.length)
  return null
}

function RelationPicker({ seed, onDone }: { seed: TrackDetail; onDone: () => void }) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Relation['kind']>('mix')
  const [results, setResults] = useState<Track[]>([])
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => api.tracks('all', { q }).then((r) => setResults(r.filter((x) => x.id !== seed.id).slice(0, 12))), 200)
    return () => clearTimeout(t)
  }, [q, seed.id])
  return (
    <div className="card" style={{ padding: 12, gap: 10 }}>
      <Seg style={{ width: 'fit-content' }}>
        {REL_KINDS.map((k) => <button key={k.kind} title={k.hint} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>{k.label}</button>)}
      </Seg>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <IconSearch size={14} style={{ position: 'absolute', left: 9, color: 'var(--faint)' }} />
        <input ref={ref} className="input" style={{ paddingLeft: 28, width: '100%' }} placeholder="Buscar el otro tema…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <HoverList className="rel-list">
        {results.map((t) => (
          <button key={t.id} data-fh className="rel" onClick={async () => { await api.relate(seed.id, t.id, kind); onDone() }}>
            <div className="thumb"><Sleeve id={t.id} title={t.title} trackKey={t.key} hasArt={t.has_art} size="s" px={34} /></div>
            <div style={{ minWidth: 0 }}>
              <div className="t ellipsis">{cleanTitle(t.title)}</div>
              <Meta artist={t.artist} bpm={t.bpm} k={t.key} />
            </div>
            <IconPlus size={14} />
          </button>
        ))}
        {q.length >= 2 && !results.length && <div className="faint" style={{ padding: 6 }}>Sin resultados</div>}
      </HoverList>
    </div>
  )
}

/** `id`: el tema que se muestra (al cerrarse la ficha sigue siendo el último mientras sale; ver App.tsx). */
export function TrackPanel({ id: selectedId }: { id: number | null }) {
  const { select, tags, crates, patchTrack, toast, askText, loadMeta, go, crateId, openMix, libraryVersion } = useApp()
  const { play, track: cur, playing, time, duration, seek } = usePlayer()
  const [d, setD] = useState<TrackDetail | null>(null)
  const [sourceAnalysis, setSourceAnalysis] = useState<{ id: number; sources: TrackSource[] | 'error' } | null>(null)
  const [recs, setRecs] = useState<Recommendation[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [recScope, setRecScope] = useState<'all' | 'crate'>('all')
  const [notes, setNotes] = useState('')
  const [editTags, setEditTags] = useState(false)
  const [allRecs, setAllRecs] = useState(false)
  const wave = useWaveform(selectedId)
  const grouped = useMemo(() => groupTags(tags), [tags])
  const crateIds = useMemo(() => new Set(crates.map((crate) => String(crate.id))), [crates])
  const userCrates = crates.filter((c) => c.kind === 'user')

  const load = useCallback(async () => {
    if (selectedId == null) return
    const det = await api.track(selectedId)
    setD(det); setNotes(det.notes ?? '')
  }, [selectedId])
  const loadRecs = useCallback(async () => {
    if (selectedId == null) return
    setRecs(null)
    const scope = recScope === 'crate' && crateId && crateId !== 'all' ? crateId : null
    const r = await api.recommendations(selectedId, scope)
    setRecs(r.items)
  }, [selectedId, recScope, crateId])

  useEffect(() => { setD(null); setPicking(false); setEditTags(false); setAllRecs(false); load().catch(() => select(null)) }, [load, select])
  useEffect(() => { if (libraryVersion) load().catch(() => {}) }, [libraryVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadRecs().catch(() => setRecs([])) }, [loadRecs])
  useEffect(() => {
    if (selectedId == null) return
    let alive = true
    api.trackSources(selectedId)
      .then(({ sources }) => { if (alive) setSourceAnalysis({ id: selectedId, sources }) })
      .catch((error) => { if (alive) setSourceAnalysis({ id: selectedId, sources: isNotFound(error) ? [] : 'error' }) })
    return () => { alive = false }
  }, [selectedId, libraryVersion])
  // cuando termina de analizarse este tema, recargar la ficha
  const lastPatch = useApp((s) => s.lastPatch)
  useEffect(() => { if (lastPatch && lastPatch.id === selectedId && 'unanalyzed' in lastPatch) load().catch(() => {}) }, [lastPatch]) // eslint-disable-line react-hooks/exhaustive-deps

  if (selectedId == null) return null
  if (!d) return <aside className="tpanel"><div className="empty">Cargando…</div></aside>

  const isCur = cur?.id === d.id
  const visibleSessions = d.sessions.filter((session) => crateIds.has(String(session.id)))
  const update = async (body: Record<string, unknown>) => {
    const nd = await api.patchTrack(d.id, body)
    setD(nd)
    patchTrack({ id: nd.id, rating: nd.rating, energy: nd.energy, energy_user: nd.energy_user, hidden: nd.hidden })
  }
  const toggleTag = async (tagId: number) => {
    const on = !d.tags.includes(tagId)
    await api.assignTag([d.id], tagId, on)
    const nt = on ? [...d.tags, tagId] : d.tags.filter((x) => x !== tagId)
    setD({ ...d, tags: nt, tag_sources: { ...d.tag_sources, [tagId]: 'user' } })
    patchTrack({ id: d.id, tags: nt })
  }
  const relGroups = (['mix', 'mashup', 'similar', 'history', 'avoid'] as const).map((k) => [k, d.relations.filter((r) => r.kind === k)] as const).filter(([, l]) => l.length)

  return (
    <aside className="tpanel" key={d.id}>
      <div className="tpanel-head">
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          {d.online && <button className="btn ghost sm icon" title="Mostrar en Finder" aria-label="Mostrar en Finder" onClick={() => api.reveal(d.id)}><IconFinder size={14} /></button>}
          <button className="btn ghost sm icon" title="Cerrar" aria-label="Cerrar" onClick={() => select(null)}><IconX size={15} /></button>
        </div>
      </div>
      <div className="tpanel-body">
        <div className={`hero${isCur ? ' out' : ''}${isCur && playing ? ' spin' : ''}`} style={{ ['--label' as string]: keyColor(d.key) }}>
          <div className="disc"><div className="vinyl"><span className="hole" /></div></div>
          <div className="hsleeve"><Sleeve id={d.id} title={d.title} artist={d.artist} trackKey={d.key} bpm={d.bpm} hasArt={d.has_art} online={d.online} size="l" px={200} /></div>
        </div>

        <div>
          <h2 className="t-title">{cleanTitle(d.title)}</h2>
          <div className="t-artist"><ArtistLinks artist={d.artist} fallback='Artista desconocido' />{d.remixer ? <> · rmx <ArtistLinks artist={d.remixer} /></> : null}</div>
          <div className="t-sub">
            {d.label && <span>{d.label}</span>}{d.year ? <span>{d.year}</span> : null}{d.genre && <span>{d.genre}</span>}
            <span className="num">{d.filetype?.toUpperCase()}</span>
          </div>
        </div>

        <div className="section">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="playbtn" disabled={!d.online} onClick={() => play(toTrack(d))} aria-label={isCur && playing ? 'Pausar' : 'Escuchar'}>
              <GlyphSwap on={isCur && playing} a={<IconPlay size={15} />} b={<IconPause size={15} />} />
            </button>
            <div className="wave" style={{ flex: 1 }}>
              <Waveform data={wave} progress={isCur && duration ? time / duration : 0} introBars={d.intro_bars} outroBars={d.outro_bars}
                onSeek={(f) => { if (isCur) seek(f * duration); else if (d.online) { play(toTrack(d)); setTimeout(() => usePlayer.getState().seek(f * (d.duration ?? 0)), 250) } }} />
            </div>
          </div>
          {!d.online && <div className="faint" style={{ fontSize: 11.5 }}>{d.source !== 'local' ? 'El disco con este tema está desconectado' : 'No encuentro el archivo'}</div>}
        </div>

        <AnalysisNotice t={d} online={!!d.online} />

        <div className="kv">
          <div><span className="eyebrow">BPM</span><span className="v">{fmtBpm(d.bpm)}</span></div>
          <div title={d.key_est ? 'Tono calculado por Batea' : undefined}><span className="eyebrow">Tono</span><span><KeyBadge k={d.key} est={!!d.key_est} /></span></div>
          <div><span className="eyebrow">Largo</span><span className="v">{fmtTime(d.duration)}</span></div>
          <div><span className="eyebrow">Intro</span><span className="v">{d.intro_bars ?? '–'}<small> compases</small></span></div>
          <div><span className="eyebrow">Outro</span><span className="v">{d.outro_bars ?? '–'}<small> compases</small></span></div>
          <div><span className="eyebrow">Tocado</span><span className="v">{d.play_count}<small> veces</small></span></div>
        </div>

        <div className="section">
          <div className="section-h"><span className="eyebrow">Puntaje</span><Stars big value={d.rating} onChange={(v) => update({ rating: v })} /></div>
          <EnergyEditor value={d.energy_user} auto={d.energy_auto} onChange={(v) => update(v == null ? { clear_energy: true } : { energy: v })} />
        </div>
        {sourceAnalysis?.id === d.id && <SourceAnalysis sources={sourceAnalysis.sources} />}

        <div className="section">
          <div className="section-h">
            <span className="eyebrow">Etiquetas</span>
            <button className="btn ghost sm" onClick={() => setEditTags(!editTags)}>{editTags ? 'Listo' : 'Editar'}</button>
          </div>
          {!editTags && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {tags.filter((t) => d.tags.includes(t.id)).map((t) => (
                <span key={t.id} className={`chip on${d.tag_sources[t.id] === 'auto' ? ' auto' : ''}`} style={{ ['--c' as string]: t.color ?? undefined }}
                  title={d.tag_sources[t.id] === 'auto' ? 'Puesta por Batea' : undefined}>{t.name}</span>
              ))}
              {!d.tags.length && <span className="faint" style={{ fontSize: 12 }}>Sin etiquetas</span>}
            </div>
          )}
          {editTags && grouped.map(([cat, list]) => {
            const isRb = cat.startsWith('rekordbox')
            if (isRb && !list.some((t) => d.tags.includes(t.id))) return null
            return (
              <div key={cat} style={{ display: 'grid', gridTemplateColumns: '74px 1fr', gap: 8, alignItems: 'start' }}>
                <span className="faint" style={{ fontSize: 11, paddingTop: 3 }}>{isRb ? cat.replace('rekordbox · ', 'rb · ') : cat}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {list.filter((t) => !isRb || d.tags.includes(t.id)).map((t) => {
                    const on = d.tags.includes(t.id)
                    const auto = on && d.tag_sources[t.id] === 'auto'
                    return (
                      <button key={t.id} disabled={isRb} title={isRb ? 'Se edita en rekordbox' : auto ? 'Puesta por Batea' : undefined}
                        className={`chip${on ? ' on' : ''}${auto ? ' auto' : ''}`} style={{ ['--c' as string]: t.color ?? undefined, opacity: 1 }} onClick={() => toggleTag(t.id)}>
                        {t.name}
                      </button>
                    )
                  })}
                  {!isRb && ROLE_CATEGORIES.includes(cat) && (
                    <button className="chip" style={{ borderStyle: 'dashed', color: 'var(--faint)' }} onClick={async () => {
                      const name = await askText(`Nueva etiqueta en “${cat}”`)
                      if (!name) return
                      const tg = await api.createTag(name, cat, list[0]?.color ?? undefined)
                      await loadMeta(); await api.assignTag([d.id], tg.id, true); load()
                    }} aria-label={`Nueva etiqueta en ${cat}`}><IconPlus size={11} /></button>
                  )}
                </div>
              </div>
            )
          })}
          {editTags && <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={async () => {
            const cat = await askText('Nombre de la categoría nueva')
            if (!cat) return
            const name = await askText(`Primera etiqueta de “${cat}”`)
            if (!name) return
            const tg = await api.createTag(name, cat)
            await loadMeta(); await api.assignTag([d.id], tg.id, true); load()
          }}><IconPlus size={12} /> Categoría</button>}
        </div>

        <div className="section">
          <span className="eyebrow">Notas</span>
          <textarea className="input" rows={2} placeholder="Para acordarte de algo al mezclarlo" value={notes}
            onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (d.notes ?? '') && update({ notes })} />
        </div>

        <div className="section">
          <div className="section-h">
            <span className="eyebrow">Relaciones</span>
            <button className="btn ghost sm" onClick={() => setPicking(!picking)}>{picking ? 'Cancelar' : <><IconLink size={13} /> Relacionar</>}</button>
          </div>
          {picking && <RelationPicker seed={d} onDone={() => { setPicking(false); load(); loadRecs(); toast('Relación guardada') }} />}
          {!relGroups.length && !picking && <div className="faint" style={{ fontSize: 12 }}>Ninguna todavía</div>}
          {relGroups.map(([kind, list]) => (
            <HoverList key={kind} className="rel-list">
              <span className="rel-kind">{REL_LABEL[kind]}</span>
              {list.slice(0, kind === 'history' ? 6 : 20).map((r) => (
                <div key={r.id} data-fh className="rel" role="button" tabIndex={0} onClick={() => select(r.other_id)}>
                  <div className="thumb"><Sleeve id={r.other_id} title={r.title} trackKey={r.key} hasArt={r.has_art} size="s" px={34} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div className="t ellipsis">{cleanTitle(r.title)}</div>
                    <Meta artist={r.artist} bpm={r.bpm} k={r.key}
                      extra={kind === 'history' ? `${r.direction === 'out' ? 'después' : 'antes'}, ${r.count} ${r.count === 1 ? 'vez' : 'veces'}` : null} />
                  </div>
                  <div className="acts">
                    <button className="btn ghost sm icon" title="Probar la mezcla" aria-label="Probar la mezcla" onClick={(e) => { e.stopPropagation(); r.direction === 'in' && kind === 'history' ? openMix(r.other_id, d.id) : openMix(d.id, r.other_id) }}><IconMix size={13} /></button>
                    {r.kind !== 'history' && !String(r.source ?? '').startsWith('history') && <button className="btn ghost sm icon" title="Quitar" aria-label="Quitar" onClick={async (e) => { e.stopPropagation(); await api.unrelate(r.id); load(); loadRecs() }}><IconX size={13} /></button>}
                  </div>
                </div>
              ))}
            </HoverList>
          ))}
        </div>

        <div className="section">
          <div className="section-h">
            <span className="eyebrow">Qué va después</span>
            {crateId && crateId !== 'all' && (
              <Seg>
                <button className={recScope === 'all' ? 'on' : ''} onClick={() => setRecScope('all')}>Todo</button>
                <button className={recScope === 'crate' ? 'on' : ''} onClick={() => setRecScope('crate')}>Esta caja</button>
              </Seg>
            )}
          </div>
          {recs === null && <div className="faint">Buscando…</div>}
          <HoverList className="rel-list">
            {recs?.slice(0, allRecs ? 30 : 6).map((r) => {
              const why = plainReason(r.reasons)
              return (
              <div key={r.id} data-fh className="rel" role="button" tabIndex={0} onClick={() => select(r.id)}>
                <div className="thumb"><Sleeve id={r.id} title={r.track.title} trackKey={r.track.key} hasArt={r.track.has_art} size="s" px={34} /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="t ellipsis">{cleanTitle(r.track.title)}</div>
                  <Meta bpm={r.track.bpm} k={r.track.key} extra={why} />
                </div>
                <div>
                  <div className="acts">
                    {r.track.online && <button className="btn ghost sm icon" title="Escuchar" aria-label="Escuchar" onClick={(e) => { e.stopPropagation(); play(r.track) }}><IconPlay size={11} /></button>}
                    <button className="btn ghost sm icon" title="Probar la mezcla" aria-label="Probar la mezcla" onClick={(e) => { e.stopPropagation(); openMix(d.id, r.id) }}><IconMix size={13} /></button>
                    <button className="btn ghost sm icon" title="Mezclan bien" aria-label="Mezclan bien" onClick={async (e) => { e.stopPropagation(); await api.feedback(d.id, r.id, true); toast('Anotado'); load(); loadRecs() }}><IconThumbUp size={13} /></button>
                    <button className="btn ghost sm icon" title="No van" aria-label="No van" onClick={async (e) => { e.stopPropagation(); await api.feedback(d.id, r.id, false); setRecs((x) => x?.filter((y) => y.id !== r.id) ?? null); load() }}><IconThumbDown size={13} /></button>
                  </div>
                </div>
              </div>
              )
            })}
          </HoverList>
          {recs && recs.length > 6 && !allRecs && <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setAllRecs(true)}>Ver más</button>}
        </div>

        <div className="section">
          <span className="eyebrow">Cajas</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {d.crates.filter((c) => crateIds.has(String(c.id))).map((c) => (
              <span key={c.id} className="chip" role="button" onClick={() => go('crate', String(c.id))} style={{ cursor: 'pointer' }}>
                {c.name}
                {c.kind === 'user' && <button aria-label={`Quitar de ${c.name}`} onClick={async (e) => { e.stopPropagation(); await api.removeFromCrate(c.id, d.id); load(); loadMeta() }}><IconX size={10} /></button>}
              </span>
            ))}
            <select className="input" style={{ height: 24, fontSize: 11.5, width: 'auto' }} value="" onChange={async (e) => {
              const v = e.target.value
              if (!v) return
              let id: number | string = v
              if (v === '__new') {
                const name = await askText('Nombre de la caja nueva')
                if (!name) return
                id = (await api.createCrate(name)).id
              }
              await api.addToCrate(id, [d.id]); await loadMeta(); load(); toast('Agregado a la caja')
            }}>
              <option value="">Agregar a una caja</option>
              {userCrates.filter((c) => !d.crates.some((x) => x.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new">Nueva caja…</option>
            </select>
          </div>
        </div>

        {visibleSessions.length > 0 && (
          <div className="section">
            <span className="eyebrow">Lo tocaste en</span>
            <div style={{ display: 'grid', gap: 2 }}>
              {visibleSessions.map((s) => (
                <button key={s.id} className="tree-row" onClick={() => go('crate', String(s.id))}>
                  <span className="num muted" style={{ width: 72 }}>{fmtDate(s.date)}</span><span className="ellipsis">{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => update({ hidden: !d.hidden })}>
          {d.hidden ? 'Volver a mostrar' : 'Ocultar de Batea'}
        </button>
      </div>
    </aside>
  )
}
