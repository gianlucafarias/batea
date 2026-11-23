import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { formatKey, useKeyNotation } from '../lib/keyNotation'
import { fmtEnergy, readSet, type Harmony, type Issue, type PassInfo } from '../lib/setAnalysis'
import { useApp, usePlayer } from '../store'
import type { Suggestion, Track } from '../types'
import { cleanTitle, fmtBpm, keyColor, plural } from '../util'
import { IconAlert, IconMix, IconPlay } from './icons'

/** Más que esto ya no es un set: es una biblioteca, y el gráfico no dice nada. */
export const CHART_MAX = 150
const ISSUES_SHOWN = 20

const PAD_L = 36
const PAD_R = 14
const E_TOP = 44, E_H = 230, E_BOTTOM = 10
const B_H = 84
const K_H = 30
const X_H = 22
const GAP = 14

const HARMONY_COLOR: Record<Harmony, string> = {
  ok: 'var(--ok)', risky: 'var(--warn)', clash: 'var(--danger)', unknown: 'var(--faint)',
}
const HARMONY_LABEL: Record<Harmony, string> = { ok: 'compatible', risky: 'arriesgada', clash: 'choque', unknown: 'sin tono' }

function fmtMin(m: number | null): string {
  if (m == null) return '–'
  const r = Math.round(m)
  return r >= 60 ? `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, '0')}` : `${r} min`
}

interface Props {
  tracks: Track[]
  /** cómo está ordenada la lista si no es el orden de la caja */
  orderNote: string | null
  /** sesión del historial: todas sus pasadas ya se tocaron al menos una vez */
  session?: boolean
  /** se puede reordenar arrastrando en el gráfico (caja propia o playlist, en el orden de la caja) */
  onReorder?: (ids: number[]) => void
  /** por qué no se puede arrastrar, si es una caja que sí se reordena en otro orden */
  reorderHint?: string | null
  /** caja propia: agregar un tema en una posición o cambiar uno por otro */
  onInsert?: (index: number, trackId: number) => Promise<void>
  onReplace?: (index: number, trackId: number) => Promise<void>
  /** caja que no se puede editar (playlist importada, sesión): ofrecer una copia propia */
  onDuplicate?: () => void
  /** sesión: cuántas de las reproducciones fueron temas que volviste a poner */
  repeats?: number
}

type SuggestState = { issueId: string; mode: 'bridge' | 'replace'; at: number; items: Suggestion[] | null; error?: string }

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice()
  const [x] = out.splice(from, 1)
  out.splice(to, 0, x)
  return out
}

export function SetChart({ tracks: all, orderNote, session, onReorder, reorderHint, onInsert, onReplace, onDuplicate, repeats }: Props) {
  const { select, selectedId, openMix, analyzeTracks, analysisQueue } = useApp()
  const play = usePlayer((s) => s.play)
  const notation = useKeyNotation((s) => s.notation)
  const base = useMemo(() => all.slice(0, CHART_MAX), [all])
  const ids = useMemo(() => base.map((t) => t.id), [base])
  // arrastrar un tema en el gráfico: mientras se arrastra, todo se recalcula con el orden nuevo
  const [drag, setDrag] = useState<{ from: number; to: number; moved: boolean; x0: number } | null>(null)
  const tracks = useMemo(() => (drag?.moved ? moveItem(base, drag.from, drag.to) : base), [base, drag])
  const svgRef = useRef<SVGSVGElement>(null)
  const [info, setInfo] = useState<PassInfo[]>([])

  useEffect(() => {
    let alive = true
    setInfo([])
    if (ids.length > 1) api.setTransitions(ids).then((r) => alive && setInfo(r.transitions)).catch(() => { /* sin datos de pasadas: el gráfico igual sirve */ })
    return () => { alive = false }
  }, [ids])

  const fk = (k: string | null) => formatKey(k, notation) || 'sin tono'
  const reading = useMemo(() => readSet(tracks, info, fk), [tracks, info, notation]) // eslint-disable-line react-hooks/exhaustive-deps

  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [tracks.length >= 2]) // eslint-disable-line react-hooks/exhaustive-deps

  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<Issue | null>(null)
  const [allIssues, setAllIssues] = useState(false)
  const [sugg, setSugg] = useState<SuggestState | null>(null)
  useEffect(() => { setAllIssues(false); setSugg(null) }, [ids])
  const marked = useMemo(() => new Set(focus?.at ?? []), [focus])

  const n = tracks.length
  if (n < 2) return <div className="empty"><h3>Hacen falta al menos dos temas</h3><p>El gráfico muestra cómo se mueve el set de un tema al siguiente.</p></div>

  const plotW = width - PAD_L - PAD_R
  const step = plotW / n
  const x = (i: number) => PAD_L + step * (i + 0.5)
  // El eje de energía se acerca al rango del set (como el de BPM): un set de techno fuerte vive entre 8 y 10
  // y con la escala entera de 1 a 10 se vería una línea plana arriba de todo.
  const E = reading.energy
  const known = E.map((e, i) => [e, i] as const).filter((e): e is readonly [number, number] => e[0] != null)
  const eLo = known.length ? Math.min(...known.map(([e]) => e)) : 1
  const eHi = known.length ? Math.max(...known.map(([e]) => e)) : 10
  let yMin = Math.max(1, Math.floor(eLo - 0.3))
  const yMax = Math.min(10, Math.ceil(eHi + 0.2))
  if (yMax - yMin < 2) yMin = Math.max(1, yMax - 2)
  const zoomed = yMin > 1 || yMax < 10
  const eY = (e: number) => E_TOP + ((yMax - e) / (yMax - yMin)) * (E_H - E_TOP - E_BOTTOM)
  const eTicks = yMax - yMin <= 4 ? Array.from({ length: yMax - yMin + 1 }, (_, k) => yMin + k)
    : [yMin, Math.round(yMin + (yMax - yMin) / 3), Math.round(yMin + (2 * (yMax - yMin)) / 3), yMax]
  const bTop = E_H + GAP
  const kTop = bTop + B_H + GAP
  const xTop = kTop + K_H + 4
  const H = xTop + X_H

  // energía: línea continua donde hay datos, punteada donde falta un tema en el medio
  const solid: string[] = []
  const dashed: string[] = []
  let seg = ''
  let last: number | null = null
  E.forEach((e, i) => {
    if (e == null) { if (seg) solid.push(seg); seg = ''; return }
    const p = `${x(i).toFixed(1)},${eY(e).toFixed(1)}`
    if (last != null && last !== i - 1) dashed.push(`M${x(last).toFixed(1)},${eY(E[last]!).toFixed(1)}L${p}`)
    seg += seg ? `L${p}` : `M${p}`
    last = i
  })
  if (seg) solid.push(seg)
  // muchos temas: los puntos se vuelven ruido, así que se dibuja la tendencia (promedio de 5 temas)
  const dense = step < 9
  let trend = ''
  if (dense) {
    tracks.forEach((_, i) => {
      const w = E.slice(Math.max(0, i - 2), i + 3).filter((e): e is number => e != null)
      if (!w.length) return
      const p = `${x(i).toFixed(1)},${eY(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1)}`
      trend += trend ? `L${p}` : `M${p}`
    })
  }
  const area = known.length > 1
    ? `M${x(known[0][1])},${eY(yMin)}` + known.map(([e, i]) => `L${x(i).toFixed(1)},${eY(e).toFixed(1)}`).join('') + `L${x(known[known.length - 1][1])},${eY(yMin)}Z`
    : ''

  // BPM: escalones, un tramo por tema
  const bpms = tracks.map((t) => t.bpm).filter((b): b is number => !!b)
  const bMin = bpms.length ? Math.floor(Math.min(...bpms)) - 1 : 120
  const bMax = bpms.length ? Math.ceil(Math.max(...bpms)) + 1 : 130
  const bY = (b: number) => bTop + 8 + (1 - (b - bMin) / Math.max(bMax - bMin, 1)) * (B_H - 16)
  let bpmPath = ''
  tracks.forEach((t, i) => {
    if (!t.bpm) return
    const x0 = PAD_L + step * i, x1 = x0 + step, y = bY(t.bpm).toFixed(1)
    const prev = tracks[i - 1]
    bpmPath += prev?.bpm ? `L${x0.toFixed(1)},${y}L${x1.toFixed(1)},${y}` : `M${x0.toFixed(1)},${y}L${x1.toFixed(1)},${y}`
  })
  const bpmJumps = new Set(reading.issues.filter((i) => i.kind === 'bpm').map((i) => i.at[1]))

  const r = step < 9 ? 2.5 : 4
  const tickEvery = Math.max(1, Math.ceil(30 / step))
  const showKeyText = step >= 30
  const peak = reading.peak

  const playedPasses = reading.passes.filter((p) => (p.info?.played ?? 0) > (session ? 1 : 0)).length
  const harmonic = reading.passes.filter((p) => p.harmony === 'ok').length
  const withKey = reading.passes.filter((p) => p.harmony !== 'unknown').length
  const energies = known.map(([e]) => e)
  const avgE = energies.length ? energies.reduce((s, e) => s + e, 0) / energies.length : null

  const ht = hover != null ? tracks[hover] : null
  const hp = hover != null ? reading.passes[hover] : null
  const tipLeft = hover != null ? Math.min(Math.max(x(hover) + 14, 8), width - 250) : 0
  const flip = hover != null && x(hover) + 260 > width

  const openSuggest = (iss: Issue, mode: 'bridge' | 'replace') => {
    if (sugg?.issueId === iss.id && sugg.mode === mode) { setSugg(null); return }
    const [a, b] = iss.at
    const prev = tracks[a].id
    const next = mode === 'bridge' ? tracks[b].id : tracks[b + 1]?.id ?? null
    const st: SuggestState = { issueId: iss.id, mode, at: mode === 'bridge' ? b : b, items: null }
    setSugg(st)
    api.setSuggest(prev, next, all.map((t) => t.id))
      .then((r) => setSugg((cur) => (cur?.issueId === st.issueId && cur.mode === mode ? { ...cur, items: r.items } : cur)))
      .catch((e) => setSugg((cur) => (cur?.issueId === st.issueId ? { ...cur, items: [], error: (e as Error).message } : cur)))
  }

  const inQueue = new Set([analysisQueue.now, ...analysisQueue.ids])
  const analyzable = reading.missing.map((i) => tracks[i]).filter((t) => t.unanalyzed === 'pending' && t.online && !inQueue.has(t.id)).map((t) => t.id)

  return (
    <div className="setchart">
      <div className="setchart-stats stat-grid">
        <div title="Suma de los temas completos, sin contar cuánto se superponen al mezclar"><span className="eyebrow">Duración</span><span className="v">{fmtMin(reading.totalMin)} <small>temas enteros</small></span></div>
        <div>
          <span className="eyebrow">Peak</span>
          <span className="v">{peak != null ? <>Tema {peak + 1} <small>{reading.starts[peak] != null ? `min ${Math.round(reading.starts[peak]!)}` : ''}</small></> : '–'}</span>
        </div>
        <div><span className="eyebrow">Energía media</span><span className="v">{avgE != null ? avgE.toFixed(1).replace('.', ',') : '–'} <small>de 10</small></span></div>
        <div><span className="eyebrow">Pasadas compatibles</span><span className="v">{withKey ? `${harmonic}/${withKey}` : '–'} <small>por tono</small></span></div>
        <div title={session ? 'Pasadas de esta sesión que también tocaste otras noches' : 'Pasadas que ya tocaste alguna vez, según tu historial'}>
          <span className="eyebrow">{session ? 'Repetidas de otras noches' : 'Ya las tocaste'}</span>
          <span className="v">{info.length ? playedPasses : '–'}<small>/{reading.passes.length} pasadas</small></span>
        </div>
      </div>

      {(orderNote || all.length > CHART_MAX || zoomed || !!repeats) && (
        <p className="setchart-note muted">
          {repeats ? `En el orden en que sonaron: ${plural(all.length, 'reproducción', 'reproducciones')}, ${repeats} de temas que volviste a poner. ` : ''}
          {zoomed && known.length > 0 ? `La energía de este set va de ${fmtEnergy(Math.round(eLo * 10) / 10)} a ${fmtEnergy(Math.round(eHi * 10) / 10)}: el gráfico muestra de ${yMin} a ${yMax} para que se vea el recorrido. ` : ''}
          {all.length > CHART_MAX ? `Se muestran los primeros ${CHART_MAX} de ${all.length} temas. ` : ''}
          {orderNote ? `Sigue el orden de la lista: ${orderNote}.` : ''}
        </p>
      )}

      <div className="setchart-plot" ref={wrap} onMouseLeave={() => setHover(null)}>
        <svg ref={svgRef} width={width} height={H} role="img" aria-label="Energía, BPM y tono de cada tema en el orden de la lista"
          className={drag?.moved ? 'dragging' : undefined}
          onPointerMove={(e) => {
            if (!drag || !onReorder) return
            const left = svgRef.current!.getBoundingClientRect().left
            const to = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - left - PAD_L) / step)))
            const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 5
            if (moved !== drag.moved || to !== drag.to) setDrag({ ...drag, to, moved })
          }}
          onPointerUp={() => {
            if (!drag) return
            if (drag.moved && drag.to !== drag.from && onReorder) onReorder(moveItem(base, drag.from, drag.to).map((t) => t.id))
            else if (!drag.moved) select(base[drag.from].id)
            setDrag(null)
          }}
          onPointerCancel={() => setDrag(null)}>
          {/* fases */}
          {reading.phases.map((p, k) => {
            const x0 = PAD_L + step * p.from, x1 = PAD_L + step * (p.to + 1)
            return (
              <g key={p.name}>
                {k % 2 === 1 && <rect x={x0} y={0} width={x1 - x0} height={E_H} className="sc-phase" />}
                {p.name === 'Peak' && <rect x={x0} y={0} width={x1 - x0} height={E_H} className="sc-phase-peak" />}
                {x1 - x0 > 46 && <text x={x0 + 6} y={34} className="sc-phase-label">{p.name}</text>}
              </g>
            )
          })}
          {/* grilla de energía */}
          {eTicks.map((e) => (
            <g key={e}>
              <line x1={PAD_L} x2={width - PAD_R} y1={eY(e)} y2={eY(e)} className="sc-grid" />
              <text x={PAD_L - 8} y={eY(e) + 4} className="sc-axis" textAnchor="end">{e}</text>
            </g>
          ))}
          <text x={4} y={12} className="sc-axis">Energía</text>

          {/* temas marcados por el aviso elegido */}
          {[...marked].map((i) => <rect key={i} x={PAD_L + step * i} y={0} width={step} height={kTop + K_H} className="sc-mark" />)}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={kTop + K_H} className="sc-cross" />}

          {area && <path d={area} className="sc-area" />}
          {dashed.map((d, k) => <path key={k} d={d} className="sc-line dashed" />)}
          {solid.map((d, k) => <path key={k} d={d} className={`sc-line${dense ? ' raw' : ''}`} />)}
          {dense && <path d={trend} className="sc-line" />}
          {!dense && tracks.map((t, i) => E[i] == null
            ? <circle key={`${t.id}:${i}`} cx={x(i)} cy={eY(yMin)} r={r} className="sc-dot missing" />
            : <circle key={`${t.id}:${i}`} cx={x(i)} cy={eY(E[i]!)} r={i === hover || t.id === selectedId ? r + 2 : r}
                className={`sc-dot${marked.has(i) ? ' marked' : ''}${t.id === selectedId ? ' sel' : ''}`} />)}
          {peak != null && E[peak] != null && (
            <g>
              <circle cx={x(peak)} cy={eY(E[peak]!)} r={r + 5} className="sc-peak" />
            </g>
          )}

          {/* BPM */}
          <line x1={PAD_L} x2={width - PAD_R} y1={bTop + B_H} y2={bTop + B_H} className="sc-grid" />
          <text x={4} y={bTop + 4} className="sc-axis">BPM</text>
          <text x={PAD_L - 8} y={bY(bMax - 1) + 4} className="sc-axis" textAnchor="end">{bMax - 1}</text>
          <text x={PAD_L - 8} y={bY(bMin + 1) + 4} className="sc-axis" textAnchor="end">{bMin + 1}</text>
          <path d={bpmPath} className="sc-bpm" />
          {!dense && [...bpmJumps].map((i) => tracks[i].bpm && (
            <circle key={i} cx={PAD_L + step * i} cy={bY(tracks[i].bpm!)} r={4} className="sc-jump" />
          ))}

          {/* tono: un bloque por tema y una marca en cada pasada */}
          <text x={4} y={kTop + K_H / 2 + 4} className="sc-axis">Tono</text>
          {tracks.map((t, i) => {
            const w = Math.max(2, Math.min(step - 3, 44))
            return (
              <g key={`${t.id}:${i}`}>
                <rect x={x(i) - w / 2} y={kTop} width={w} height={K_H} rx={4} fill={keyColor(t.key, t.key ? 0.24 : 0.12)} />
                {showKeyText && <text x={x(i)} y={kTop + K_H / 2 + 4} textAnchor="middle" className="sc-key">{t.key ? formatKey(t.key, notation) : '–'}</text>}
              </g>
            )
          })}
          {reading.passes.map((p) => (
            <rect key={p.i} x={PAD_L + step * (p.i + 1) - 1.5} y={kTop + 4} width={3} height={K_H - 8} rx={1.5} fill={HARMONY_COLOR[p.harmony]} />
          ))}

          {/* eje: número de tema */}
          {tracks.map((_, i) => ((i % tickEvery === 0 && n - 1 - i >= tickEvery / 2) || i === n - 1) && (
            <text key={i} x={x(i)} y={xTop + 14} textAnchor="middle" className="sc-axis">{i + 1}</text>
          ))}

          {/* el tema que se está moviendo */}
          {drag?.moved && <rect x={PAD_L + step * drag.to} y={0} width={step} height={xTop} className="sc-drag" />}
          {/* zonas para el mouse, más grandes que las marcas */}
          {tracks.map((t, i) => (
            <rect key={`${t.id}:${i}`} x={PAD_L + step * i} y={0} width={step} height={xTop} fill="transparent"
              onMouseEnter={() => !drag && setHover(i)} onDoubleClick={() => t.online && play(t)}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                if (onReorder) svgRef.current?.setPointerCapture(e.pointerId)
                setHover(null)
                setDrag({ from: i, to: i, moved: false, x0: e.clientX })
              }}
              style={{ cursor: onReorder ? (drag?.moved ? 'grabbing' : 'grab') : 'pointer' }} />
          ))}
        </svg>

        {ht && hover != null && !drag && (
          <div className="sc-tip" style={flip ? { right: width - x(hover) + 14 } : { left: tipLeft }}>
            <div className="sc-tip-h"><span className="num faint">{hover + 1}</span> <b className="ellipsis">{cleanTitle(ht.title) || 'Sin título'}</b></div>
            {ht.artist && <div className="muted ellipsis">{ht.artist}</div>}
            <div className="sc-tip-kv num">
              <span>Energía <b>{fmtEnergy(E[hover])}</b>{ht.energy_user != null && <span className="faint"> (tuya)</span>}</span>
              <span><b>{fmtBpm(ht.bpm)}</b> BPM</span>
              <span>Tono <b>{ht.key ? formatKey(ht.key, notation) : '–'}</b></span>
              {reading.starts[hover] != null && <span>min <b>{Math.round(reading.starts[hover]!)}</b></span>}
            </div>
            {hp && hover < n - 1 && (
              <div className="sc-tip-pass">
                <span className="muted">Pasada al {hover + 2}:</span> <span style={{ color: HARMONY_COLOR[hp.harmony] }}>●</span> {hp.harmonyLabel}
                {hp.bpmPct != null && ` · ${hp.bpmPct >= 0 ? '+' : ''}${hp.bpmPct.toFixed(1).replace('.', ',')}% tempo`}
                {(hp.info?.played ?? 0) > 0 && ` · la tocaste ${plural(hp.info!.played, 'vez', 'veces')}`}
                {hp.info?.avoid && ' · marcada para evitar'}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sc-legend muted">
        <span>Pasadas por tono:</span>
        {(['ok', 'risky', 'clash'] as Harmony[]).map((h) => <span key={h}><i style={{ background: HARMONY_COLOR[h] }} /> {HARMONY_LABEL[h]}</span>)}
        <span className="grow" />
        <span>{onReorder ? 'Arrastrá un tema para moverlo · ' : reorderHint ? `${reorderHint} · ` : ''}Clic en un tema para verlo · doble clic para escucharlo</span>
      </div>

      <section className="sc-issues">
        <h3>Para revisar <span className="muted">{reading.issues.length || ''}</span></h3>
        {reading.issues.length === 0 ? <p className="muted">Nada para revisar: el tempo, el tono y la energía fluyen bien.</p> : (
          <ul>
            {(allIssues ? reading.issues : reading.issues.slice(0, ISSUES_SHOWN)).map((iss) => {
              const pair = iss.id.startsWith('pass-') ? [tracks[iss.at[0]], tracks[iss.at[1]]] : null
              return (
                <li key={iss.id} className={`${iss.severity}${focus?.id === iss.id ? ' on' : ''}`}
                  onMouseEnter={() => setFocus(iss)} onMouseLeave={() => setFocus(null)}>
                  <IconAlert size={15} className="sc-ic" aria-hidden />
                  <div className="sc-issue-body">
                    <div><span className="sc-sev">{iss.severity === 'serious' ? 'Importante' : 'Revisar'}</span> {iss.title}</div>
                    {iss.detail && <div className="sc-issue-detail">{iss.detail}</div>}
                    {iss.pair && <div className="muted ellipsis" title={iss.pair}>{iss.pair}</div>}
                  </div>
                  <div className="sc-issue-act">
                    {pair && (
                      <button className={`btn ghost sm${sugg?.issueId === iss.id && sugg.mode === 'bridge' ? ' on' : ''}`} onClick={() => openSuggest(iss, 'bridge')}
                        title={`Temas que entran entre el ${iss.at[0] + 1} y el ${iss.at[1] + 1}`}>Tema puente</button>
                    )}
                    {pair && (
                      <button className={`btn ghost sm${sugg?.issueId === iss.id && sugg.mode === 'replace' ? ' on' : ''}`} onClick={() => openSuggest(iss, 'replace')}
                        title={`Temas para poner en lugar del ${iss.at[1] + 1}`}>Reemplazar el {iss.at[1] + 1}</button>
                    )}
                    {pair && pair[0].online && pair[1].online && (
                      <button className="btn ghost sm" onClick={() => openMix(pair[0].id, pair[1].id)} title="Abrir esta pasada en Probar la mezcla"><IconMix size={13} /> Probar la mezcla</button>
                    )}
                    {iss.kind === 'missing' && analyzable.length > 0 && (
                      <button className="btn ghost sm" onClick={() => analyzeTracks(analyzable)}>Analizar {analyzable.length}</button>
                    )}
                    {iss.kind !== 'missing' && iss.kind !== 'plateau' && !pair && (
                      <button className="btn ghost sm" onClick={() => select(tracks[iss.at[iss.at.length - 1]].id)}>Ver tema</button>
                    )}
                  </div>
                  {sugg?.issueId === iss.id && <SuggestList state={sugg} tracks={tracks} notation={notation}
                    onClose={() => setSugg(null)} onInsert={onInsert} onReplace={onReplace} onDuplicate={onDuplicate} />}
                </li>
              )
            })}
          </ul>
        )}
        {!allIssues && reading.issues.length > ISSUES_SHOWN && (
          <button className="btn ghost sm sc-more" onClick={() => setAllIssues(true)}>Ver los {reading.issues.length - ISSUES_SHOWN} restantes</button>
        )}
      </section>
    </div>
  )
}

const pctTxt = (p: number | null | undefined) => (p == null ? '' : `${p >= 0 ? '+' : ''}${p.toFixed(1).replace('.', ',')}%`)

function SuggestList({ state, tracks, notation, onClose, onInsert, onReplace, onDuplicate }: {
  state: SuggestState
  tracks: Track[]
  notation: ReturnType<typeof useKeyNotation.getState>['notation']
  onClose: () => void
  onInsert?: Props['onInsert']
  onReplace?: Props['onReplace']
  onDuplicate?: Props['onDuplicate']
}) {
  const { openMix, select } = useApp()
  const play = usePlayer((s) => s.play)
  const [busy, setBusy] = useState<number | null>(null)
  const a = tracks[state.at - 1]
  const b = state.mode === 'bridge' ? tracks[state.at] : tracks[state.at + 1]
  const replaced = state.mode === 'replace' ? tracks[state.at] : null
  const editable = state.mode === 'bridge' ? !!onInsert : !!onReplace
  const label = state.mode === 'bridge'
    ? `Entre el ${state.at} y el ${state.at + 1}`
    : `En lugar del ${state.at + 1}${replaced ? ` (${cleanTitle(replaced.title)})` : ''}`
  const use = async (s: Suggestion) => {
    setBusy(s.id)
    try {
      if (state.mode === 'bridge') await onInsert?.(state.at, s.id)
      else await onReplace?.(state.at, s.id)
      onClose()
    } finally { setBusy(null) }
  }
  const fitTxt = (f: Suggestion['fit']['from_prev'], from: Track | undefined, to: string) => f && from
    ? <span title={f.key}><span style={{ color: f.key_ok ? 'var(--ok)' : 'var(--warn)' }}>●</span> {to}: {pctTxt(f.bpm_pct)} · {f.key}</span>
    : null
  return (
    <div className="sc-sugg" onMouseEnter={(e) => e.stopPropagation()}>
      <div className="sc-sugg-h">
        <b>{label}</b>
        <span className="muted">{state.items ? (state.items.length ? 'tempo y tono de los dos lados, y lo que ya mezclaste' : '') : 'Buscando…'}</span>
        <span className="grow" />
        {!editable && onDuplicate && <button className="btn ghost sm" onClick={onDuplicate} title="Esta lista no se puede editar en Batea: hacé una copia tuya para probar cambios">Hacer una copia editable</button>}
        <button className="btn ghost sm" onClick={onClose}>Cerrar</button>
      </div>
      {state.error && <p className="muted">{state.error}</p>}
      {state.items && !state.items.length && !state.error && <p className="muted">No encontré temas que entren bien de los dos lados. Probá con menos filtros o con otro universo.</p>}
      {state.items && state.items.length > 0 && (
        <ul>
          {state.items.map((s) => (
            <li key={s.id}>
              <button className="pbtn" onClick={() => s.track.online && play(s.track)} disabled={!s.track.online} aria-label="Escuchar"><IconPlay size={12} /></button>
              <div className="sc-sugg-t" onClick={() => select(s.id)}>
                <div className="ellipsis"><b>{cleanTitle(s.track.title)}</b> <span className="muted">{s.track.artist}</span></div>
                <div className="sc-sugg-fit num">
                  <span>{fmtBpm(s.track.bpm)} BPM · {formatKey(s.track.key, notation) || 'sin tono'} · energía {fmtEnergy(s.track.energy_user ?? s.track.energy_fine ?? s.track.energy)}</span>
                  {fitTxt(s.fit.from_prev, a, `desde el ${state.at}`)}
                  {fitTxt(s.fit.to_next, b, b ? `al ${state.mode === 'bridge' ? state.at + 1 : state.at + 2}` : '')}
                </div>
                {s.why.length > 0 && <div className="muted ellipsis">{s.why.join(' · ')}</div>}
              </div>
              {a && s.track.online && a.online && <button className="btn ghost sm" onClick={() => openMix(a.id, s.id)} title="Probar cómo entra después del anterior"><IconMix size={13} /> Probar</button>}
              {editable && <button className="btn sm" disabled={busy != null} onClick={() => use(s)}>{state.mode === 'bridge' ? 'Agregar acá' : 'Cambiar'}</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
