import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp, usePlayer } from '../store'
import type { Tag, Track } from '../types'
import { cleanTitle, fmtBpm, fmtTime } from '../util'
import { energyColor, KeyBadge, KeyText, Sleeve, Stars } from './bits'
import { groupTags } from './FilterBar'
import { IconCheck, IconPause, IconPlay, IconX } from './icons'
import { GlyphSwap, useFluidHover } from '../lib/fluidHover'
import { LiveWaveform, loadWaveform, useWaveform } from './Waveform'

const CAT_ORDER = ['momento', 'vibra', 'voz', 'versión', 'estructura']

/** Punto donde entra el groove: el final de la intro según la grilla, para escuchar rápido. */
function grooveStart(t: Track, downbeats?: number[]): number {
  const dur = t.duration ?? 0
  if (downbeats && t.intro_bars && downbeats[t.intro_bars] != null && downbeats[t.intro_bars] < dur * 0.6) return downbeats[t.intro_bars]
  if (t.intro_bars && t.bpm) return Math.min(dur * 0.6, (t.intro_bars * 240) / t.bpm)
  return 0
}

export function Tagger() {
  const { tagger, closeTagger, tags, toast, patchTrack, loadMeta, ask, mix, universeEditor, exportOpen } = useApp()
  const { track: cur, playing, time, duration, seek, toggle, playFrom, stop } = usePlayer()
  const [list, setList] = useState<Track[]>(tagger?.tracks ?? [])
  const [onlyOnline, setOnlyOnline] = useState(() => (tagger?.tracks ?? []).some((t) => t.online))
  const [autoplay, setAutoplay] = useState(true)
  const [i, setI] = useState(0)
  const [done, setDone] = useState<Set<number>>(new Set())
  const [rebindMode, setRebindMode] = useState(false)
  const [rebinding, setRebinding] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const queueRef = useRef<HTMLElement | null>(null)
  const { ref: queueHoverRef, highlight: queueHighlight } = useFluidHover<HTMLElement>()
  const setQueueRef = useCallback((el: HTMLElement | null) => { queueRef.current = el; queueHoverRef(el) }, [queueHoverRef])
  const savedNotes = useRef('')

  const visible = useMemo(() => (onlyOnline ? list.filter((t) => t.online) : list), [list, onlyOnline])
  const t: Track | undefined = visible[Math.min(i, visible.length - 1)]
  const wave = useWaveform(t?.id)
  const anyOffline = list.some((x) => !x.online)
  const anyOnline = list.some((x) => x.online)

  const grouped = useMemo(() => {
    const g = groupTags(tags.filter((x) => x.source === 'user'))
    const ord = (c: string) => { const k = CAT_ORDER.indexOf(c); return k >= 0 ? k : 99 }
    return g.sort((a, b) => ord(a[0]) - ord(b[0]))
  }, [tags])
  const byKey = useMemo(() => new Map(tags.filter((x) => x.hotkey).map((x) => [x.hotkey as string, x])), [tags])

  // al cambiar de tema: sonar desde donde entra el groove
  const tid = t?.id
  useEffect(() => {
    if (!t) return
    let alive = true
    setNotes(''); savedNotes.current = ''
    void api.track(t.id).then((d) => { if (alive) { setNotes(d.notes ?? ''); savedNotes.current = d.notes ?? '' } }).catch(() => {})
    if (!t.online) stop()
    else if (autoplay) void loadWaveform(t.id).then((w) => { if (alive) playFrom(t, grooveStart(t, w?.downbeats)) })
    return () => { alive = false }
  }, [tid, autoplay]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    queueRef.current?.querySelector('.tg-q.on')?.scrollIntoView({ block: 'nearest' })
  }, [tid])

  const update = useCallback((id: number, patch: Partial<Track>) => {
    setList((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    patchTrack({ id, ...patch })
  }, [patchTrack])

  const go = useCallback((d: number) => setI((v) => Math.max(0, Math.min(visible.length - 1, v + d))), [visible.length])

  const setEnergy = useCallback(async (v: number) => {
    if (!t) return
    const clear = t.energy_user === v
    update(t.id, { energy: clear ? t.energy_auto : v, energy_user: clear ? null : v })
    try { await api.patchTrack(t.id, clear ? { clear_energy: true } : { energy: v }) } catch (e) { toast((e as Error).message, 'error') }
  }, [t, update, toast])

  const setRating = useCallback(async (v: number) => {
    if (!t) return
    const nv = t.rating === v ? 0 : v
    update(t.id, { rating: nv })
    try { await api.patchTrack(t.id, { rating: nv }) } catch (e) { toast((e as Error).message, 'error') }
  }, [t, update, toast])

  const toggleTag = useCallback(async (tag: Tag) => {
    if (!t) return
    const on = !t.tags.includes(tag.id)
    update(t.id, { tags: on ? [...t.tags, tag.id] : t.tags.filter((x) => x !== tag.id) })
    try { await api.assignTag([t.id], tag.id, on) } catch (e) { toast((e as Error).message, 'error') }
  }, [t, update, toast])

  const finish = useCallback(async () => {
    if (!t) return
    setDone((d) => new Set(d).add(t.id))
    update(t.id, { reviewed: 1 })
    void api.patchTrack(t.id, { reviewed: true })
    if (i >= visible.length - 1) toast('Llegaste al final de la tanda')
    else go(1)
  }, [t, i, visible.length, go, update, toast])

  const seekBars = useCallback((bars: number) => {
    if (!t || cur?.id !== t.id) return
    const bar = t.bpm ? 240 / t.bpm : 2
    seek(Math.max(0, Math.min((duration || t.duration || 0) - 1, time + bars * bar)))
  }, [t, cur, time, duration, seek])

  const blocked = !!ask || !!mix || !!universeEditor || exportOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (blocked) return
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        if (e.key === 'Escape') el.blur()
        return
      }
      if (e.metaKey || e.ctrlKey) return
      if (rebinding != null) {
        e.preventDefault()
        if (e.key === 'Escape') { setRebinding(null); return }
        if (/^[a-zñ]$/i.test(e.key) && e.key.toLowerCase() !== 'ñ') {
          void api.setHotkey(rebinding, e.key.toLowerCase()).then(loadMeta)
          setRebinding(null)
        }
        return
      }
      if (e.key === 'Escape') { closeTagger(); return }
      if (e.key === 'Enter') { e.preventDefault(); void finish(); return }
      if (e.key === 'ArrowDown' || e.key === 'Tab') { e.preventDefault(); go(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); seekBars(e.shiftKey ? 32 : 8); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); seekBars(e.shiftKey ? -32 : -8); return }
      const dm = /^Digit(\d)$/.exec(e.code)
      if (dm) {
        e.preventDefault()
        const n = Number(dm[1])
        if (e.shiftKey) { if (n <= 5) void setRating(n) } else void setEnergy(n === 0 ? 10 : n)
        return
      }
      if (!e.altKey && /^[a-z]$/i.test(e.key)) {
        const tag = byKey.get(e.key.toLowerCase())
        if (tag) { e.preventDefault(); void toggleTag(tag) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [blocked, rebinding, byKey, finish, go, seekBars, setEnergy, setRating, toggleTag, closeTagger, loadMeta])

  if (!tagger) return null
  if (!t) {
    return (
      <div className="empty" style={{ flex: 1 }}>
        <h3>No hay temas para escuchar</h3>
        <p>Todos los de esta tanda están en un disco desconectado.</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={() => setOnlyOnline(false)}>Etiquetar igual, sin audio</button>
          <button className="btn ghost" onClick={closeTagger}>Volver</button>
        </div>
      </div>
    )
  }

  const isCur = cur?.id === t.id
  const eShown = t.energy ?? 0
  const qStart = Math.max(0, i - 4)

  return (
    <div className="tagger">
      <header className="viewhead">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Etiquetado rápido</div>
          <h1 className="ellipsis">{tagger.title}</h1>
          <div className="sub">
            <span className="num">{i + 1}</span> de <span className="num">{visible.length.toLocaleString('es-AR')}</span> · <span className="num">{done.size}</span> listos
          </div>
        </div>
        <div className="spacer" />
        {anyOffline && anyOnline && (
          <label className="tg-opt"><input type="checkbox" checked={onlyOnline} onChange={(e) => { setOnlyOnline(e.target.checked); setI(0) }} /> Solo los que puedo escuchar</label>
        )}
        <label className="tg-opt"><input type="checkbox" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} /> Sonar al pasar</label>
        <button className="btn sm" onClick={closeTagger}><IconX size={13} /> Salir</button>
      </header>
      <div className="bar" style={{ borderRadius: 0, height: 2 }}><i style={{ ['--p' as string]: ((i + 1) / visible.length) }} /></div>

      <div className="tg-body">
        <div className="tg-main">
          <div className="tg-top">
            <div className="tg-sleeve"><Sleeve id={t.id} title={t.title} artist={t.artist} trackKey={t.key} bpm={t.bpm} hasArt={t.has_art} online={t.online} size="l" px={180} /></div>
            <div style={{ minWidth: 0, display: 'grid', gap: 10, alignContent: 'start' }}>
              <div>
                <h2 className="t-title" style={{ fontSize: 22 }}>{cleanTitle(t.title)}</h2>
                <div className="t-artist" style={{ fontSize: 14.5 }}>{t.artist || 'Artista desconocido'}{t.label ? <span className="faint"> · {t.label}</span> : null}</div>
              </div>
              <div className="tg-stats">
                <span><span className="eyebrow">BPM</span><b className="num">{fmtBpm(t.bpm)}</b></span>
                <span><span className="eyebrow">Tono</span><KeyBadge k={t.key} est={!!t.key_est} /></span>
                <span><span className="eyebrow">Largo</span><b className="num">{fmtTime(t.duration)}</b></span>
                <span><span className="eyebrow">Intro</span><b className="num">{t.intro_bars ?? '–'}<small className="faint"> comp.</small></b></span>
                <span><span className="eyebrow">Outro</span><b className="num">{t.outro_bars ?? '–'}<small className="faint"> comp.</small></b></span>
                <span><span className="eyebrow">Tocado</span><b className="num">{t.play_count}×</b></span>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button className="playbtn" disabled={!t.online} aria-label={isCur && playing ? 'Pausar' : 'Reproducir'}
                  onClick={() => (isCur ? toggle() : playFrom(t, grooveStart(t, wave?.downbeats)))}>
                  <GlyphSwap on={isCur && playing} a={<IconPlay size={15} />} b={<IconPause size={15} />} />
                </button>
                <div className="wave" style={{ flex: 1, height: 72 }}>
                  <LiveWaveform track={t} data={wave} introBars={t.intro_bars} outroBars={t.outro_bars} />
                </div>
              </div>
              {!t.online && <div className="faint" style={{ fontSize: 11.5 }}>Sin audio: el archivo está en un disco desconectado. Podés etiquetar igual mirando la waveform.</div>}
            </div>
          </div>

          <div className="tg-row">
            <div className="tg-label"><span className="eyebrow">Energía</span><kbd>1</kbd>–<kbd>0</kbd></div>
            <div className="tg-energy">
              {Array.from({ length: 10 }, (_, k) => (
                <button key={k} onClick={() => setEnergy(k + 1)} className={k < eShown ? 'on' : ''} title={`Energía ${k + 1}`}>
                  <i style={{ height: `${28 + k * 8}%`, background: k < eShown ? energyColor(eShown) : undefined, opacity: t.energy_user ? 1 : 0.5 }} />
                  <span className="num">{k === 9 ? 0 : k + 1}</span>
                </button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 11.5, width: 150 }}>
              {t.energy_user ? <>fijada en <b className="num" style={{ color: 'var(--text)' }}>{t.energy_user}</b></> : t.energy_auto ? <>estimada <b className="num">{t.energy_auto}</b> · sin confirmar</> : 'sin datos'}
            </span>
          </div>

          <div className="tg-row">
            <div className="tg-label"><span className="eyebrow">Puntaje</span><kbd>⇧</kbd><kbd>1</kbd>–<kbd>5</kbd></div>
            <Stars big value={t.rating} onChange={(v) => setRating(v || t.rating)} />
          </div>

          {grouped.map(([cat, listTags]) => (
            <div className="tg-row top" key={cat}>
              <div className="tg-label"><span className="eyebrow">{cat}</span></div>
              <div className="tg-tags">
                {listTags.map((tag) => {
                  const on = t.tags.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      className={`chip tg-chip${on ? ' on' : ''}${rebinding === tag.id ? ' rebinding' : ''}`}
                      style={{ ['--c' as string]: tag.color ?? undefined }}
                      onClick={() => (rebindMode ? setRebinding(tag.id) : toggleTag(tag))}
                    >
                      <kbd className={tag.hotkey ? '' : 'none'}>{rebinding === tag.id ? '?' : tag.hotkey ?? '·'}</kbd>{tag.name}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="tg-row">
            <div className="tg-label" />
            <button className="faint" style={{ fontSize: 11.5 }} onClick={() => { setRebindMode(!rebindMode); setRebinding(null) }}>
              {rebindMode ? (rebinding != null ? 'Presioná la letra nueva (Esc cancela)…' : 'Elegí una etiqueta para cambiarle la letra · listo') : 'Cambiar las letras de las etiquetas'}
            </button>
          </div>

          <div className="tg-row top">
            <div className="tg-label"><span className="eyebrow">Nota</span></div>
            <input className="input" style={{ flex: 1 }} placeholder="Opcional: algo para acordarte de este tema" value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              onBlur={() => { if (notes !== savedNotes.current) { savedNotes.current = notes; void api.patchTrack(t.id, { notes }) } }} />
          </div>
        </div>

        <aside className="tg-queue" ref={setQueueRef}>
          {queueHighlight}
          <div className="eyebrow" style={{ padding: '0 10px 8px' }}>En esta tanda</div>
          {visible.slice(qStart, qStart + 40).map((x, k) => {
            const idx = qStart + k
            return (
              <button key={x.id} data-fh className={`tg-q${idx === i ? ' on' : ''}`} onClick={() => setI(idx)}>
                <span className="tg-q-n num">{done.has(x.id) ? <IconCheck size={12} /> : idx + 1}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: 'block', fontWeight: 550 }}>{cleanTitle(x.title)}</span>
                  <span className="ellipsis muted" style={{ display: 'block', fontSize: 11 }}>{x.artist || '—'} · {fmtBpm(x.bpm)}{x.key ? <> · <KeyText k={x.key} /></> : ''}</span>
                </span>
              </button>
            )
          })}
        </aside>
      </div>

      <footer className="tg-foot">
        <span><kbd>espacio</kbd> play</span>
        <span><kbd>←</kbd><kbd>→</kbd> 8 compases</span>
        <span><kbd>letra</kbd> etiqueta</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm ghost" onClick={() => go(-1)} disabled={i === 0}><kbd>↑</kbd> Anterior</button>
        <button className="btn sm" onClick={() => go(1)} disabled={i >= visible.length - 1}><kbd>↓</kbd> Saltar</button>
        <button className="btn primary" onClick={finish}><kbd>⏎</kbd> Listo y siguiente</button>
      </footer>
    </div>
  )
}
