import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Seg } from '../lib/Seg'
import { formatKey, useKeyNotation } from '../lib/keyNotation'
import { fmtEnergy } from '../lib/setAnalysis'
import { useApp } from '../store'
import type { SessionStats, StatTrack } from '../types'
import { cleanTitle, fmtBpm, fmtDate, plural } from '../util'
import { IconMix } from './icons'

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`

function fmtMin(m: number | null): string {
  if (m == null) return '–'
  const r = Math.round(m)
  return r >= 60 ? `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, '0')}` : `${r} min`
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(700)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  })
  return [ref, w]
}

/** Energía mediana a lo largo del set (de 0% a 100%) y la franja donde cae la mitad de tus sesiones. */
function TypicalCurve({ data, peakAt }: { data: SessionStats['typical']; peakAt: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pts = data.filter((d) => d.mid != null)
  if (pts.length < 2) return <p className="muted">Faltan sesiones con energía para dibujar tu curva típica.</p>
  const H = 220, L = 34, R = 12, T = 14, B = 26
  const vals = data.flatMap((d) => [d.lo, d.hi, d.mid]).filter((v): v is number => v != null)
  const yMin = Math.max(1, Math.floor(Math.min(...vals) - 0.3))
  let yMax = Math.min(10, Math.ceil(Math.max(...vals) + 0.2))
  if (yMax - yMin < 2) yMax = Math.min(10, yMin + 2)
  const x = (f: number) => L + f * (width - L - R)
  const y = (v: number) => T + ((yMax - v) / (yMax - yMin)) * (H - T - B)
  const band = pts.map((d) => `${x(d.x)},${y(d.hi!)}`).join('L') + 'L' + [...pts].reverse().map((d) => `${x(d.x)},${y(d.lo!)}`).join('L')
  const line = pts.map((d, i) => `${i ? 'L' : 'M'}${x(d.x)},${y(d.mid!)}`).join('')
  const ticks = Array.from({ length: yMax - yMin + 1 }, (_, k) => yMin + k).filter((v, _, a) => a.length <= 6 || (v - yMin) % 2 === 0)
  const h = hover != null ? data[hover] : null
  return (
    <div className="ss-plot" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label="Energía típica a lo largo de tus sesiones">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={width - R} y1={y(v)} y2={y(v)} className="sc-grid" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="sc-axis">{v}</text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={x(f)} y={H - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="sc-axis">
            {f === 0 ? 'Arranque' : f === 1 ? 'Final' : `${f * 100}%`}
          </text>
        ))}
        <path d={`M${band}Z`} className="ss-band" />
        {peakAt != null && (
          <g>
            <line x1={x(peakAt)} x2={x(peakAt)} y1={T} y2={H - B} className="ss-peakline" />
            <text x={x(peakAt) + 5} y={T + 10} className="sc-phase-label">Peak promedio</text>
          </g>
        )}
        <path d={line} className="sc-line" />
        {pts.map((d) => <circle key={d.x} cx={x(d.x)} cy={y(d.mid!)} r={hover != null && data[hover] === d ? 5 : 3.5} className="sc-dot" />)}
        {data.map((_, i) => (
          <rect key={i} x={x(i / data.length)} y={0} width={(width - L - R) / data.length} height={H - B} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {h && h.mid != null && (
        <div className="sc-tip" style={{ left: Math.min(x(h.x) + 12, width - 250), top: 16 }}>
          <div><b>Al {Math.round(h.x * 100)}% del set</b></div>
          <div className="sc-tip-kv num"><span>Energía mediana <b>{fmtEnergy(Math.round(h.mid * 10) / 10)}</b></span></div>
          {h.lo != null && h.hi != null && <div className="muted">La mitad de tus sesiones está entre {fmtEnergy(Math.round(h.lo * 10) / 10)} y {fmtEnergy(Math.round(h.hi * 10) / 10)}</div>}
        </div>
      )}
    </div>
  )
}

/** Sesiones por mes (barras) y, aparte, el BPM medio de cada mes: dos gráficos, un eje cada uno. */
function Months({ data }: { data: SessionStats['months'] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  if (!data.length) return null
  const H = 134, BH = 84, L = 34, R = 12, GAP = 12
  const step = (width - L - R) / data.length
  const maxS = Math.max(...data.map((d) => d.sessions), 1)
  const bw = Math.max(2, Math.min(step - 3, 28))
  const sy = (v: number) => 24 + (1 - v / maxS) * (H - 32)
  const bpms = data.map((d) => d.bpm).filter((b): b is number => b != null)
  const bLo = bpms.length ? Math.floor(Math.min(...bpms)) - 1 : 120
  const bHi = bpms.length ? Math.ceil(Math.max(...bpms)) + 1 : 130
  const top2 = H + GAP
  const by = (v: number) => top2 + 22 + (1 - (v - bLo) / Math.max(bHi - bLo, 1)) * (BH - 28)
  const cx = (i: number) => L + step * (i + 0.5)
  const line = data.map((d, i) => (d.bpm != null ? `${cx(i)},${by(d.bpm)}` : null)).filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p}`).join('')
  const every = Math.max(1, Math.ceil(44 / step))
  const h = hover != null ? data[hover] : null
  return (
    <div className="ss-plot" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={top2 + BH + 22} role="img" aria-label="Sesiones por mes y BPM medio de cada mes">
        <text x={4} y={10} className="sc-axis">Sesiones</text>
        <text x={L - 8} y={sy(maxS) + 4} textAnchor="end" className="sc-axis">{maxS}</text>
        <line x1={L} x2={width - R} y1={sy(0)} y2={sy(0)} className="sc-grid" />
        {data.map((d, i) => (
          <rect key={d.month} x={cx(i) - bw / 2} y={sy(d.sessions)} width={bw} height={Math.max(sy(0) - sy(d.sessions), 1)} rx={Math.min(4, bw / 2)}
            className={`ss-bar${hover === i ? ' on' : ''}`} />
        ))}
        <text x={4} y={top2 + 8} className="sc-axis">BPM</text>
        <text x={L - 8} y={by(bHi - 1) + 4} textAnchor="end" className="sc-axis">{bHi - 1}</text>
        <text x={L - 8} y={by(bLo + 1) + 4} textAnchor="end" className="sc-axis">{bLo + 1}</text>
        <line x1={L} x2={width - R} y1={top2 + BH} y2={top2 + BH} className="sc-grid" />
        <path d={line} className="sc-bpm" />
        {data.map((d, i) => d.bpm != null && <circle key={d.month} cx={cx(i)} cy={by(d.bpm)} r={hover === i ? 4.5 : 3} className="ss-bpmdot" />)}
        {data.map((d, i) => (i % every === 0 || i === data.length - 1) && (
          <text key={d.month} x={cx(i)} y={top2 + BH + 16} textAnchor="middle" className="sc-axis">{monthLabel(d.month)}</text>
        ))}
        {data.map((d, i) => <rect key={d.month} x={L + step * i} y={0} width={step} height={top2 + BH} fill="transparent" onMouseEnter={() => setHover(i)} />)}
      </svg>
      {h && hover != null && (
        <div className="sc-tip" style={{ left: Math.min(cx(hover) + 12, width - 250), top: 12 }}>
          <div><b>{monthLabel(h.month)}</b></div>
          <div className="sc-tip-kv num"><span><b>{h.sessions}</b> {h.sessions === 1 ? 'sesión' : 'sesiones'}</span>{h.bpm != null && <span><b>{fmtBpm(h.bpm)}</b> BPM medio</span>}</div>
        </div>
      )}
    </div>
  )
}

function TrackList({ title, hint, items, suffix }: { title: string; hint: string; items: StatTrack[]; suffix: (t: StatTrack) => string }) {
  const { select } = useApp()
  const notation = useKeyNotation((s) => s.notation)
  return (
    <section className="card ss-list">
      <h3>{title}</h3>
      <p className="muted">{hint}</p>
      {items.length === 0 ? <p className="faint">Todavía nada se repite lo suficiente.</p> : (
        <ol>
          {items.map((t) => (
            <li key={t.id} onClick={() => select(t.id)}>
              <div className="ellipsis"><b>{cleanTitle(t.title)}</b> <span className="muted">{t.artist}</span></div>
              <span className="num faint">{fmtBpm(t.bpm)} · {formatKey(t.key, notation) || '–'}</span>
              <span className="num ss-count">{suffix(t)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function SessionsStats() {
  const { toast, go, openMix, libraryVersion } = useApp()
  const [year, setYear] = useState<number | null>(null)
  // el historial es tuyo entero: el universo activo (armado con algunas playlists) dejaba afuera años de sesiones
  const [allMusic, setAllMusic] = useState(true)
  const [st, setSt] = useState<SessionStats | null>(null)

  useEffect(() => {
    let alive = true
    api.sessionStats(year, allMusic).then((r) => alive && setSt(r)).catch((e) => toast((e as Error).message, 'error'))
    return () => { alive = false }
  }, [year, allMusic, libraryVersion, toast])

  const s = st?.summary
  return (
    <div className="crateview">
      <header className="viewhead">
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Historial</div>
          <h1>Tus sesiones</h1>
          <div className="sub">
            {s ? `${plural(s.sessions, 'sesión', 'sesiones')}${s.first ? ` · ${fmtDate(s.first)} a ${fmtDate(s.last)}` : ''}` : 'Cargando…'}
          </div>
        </div>
      </header>
      <div className="toolbar">
        <Seg role="tablist">
          <button className={year == null ? 'on' : ''} onClick={() => setYear(null)}>Todo</button>
          {(st?.years ?? []).slice(0, 6).map((y) => <button key={y} className={year === y ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}
        </Seg>
        <div className="grow" />
        <Seg role="tablist">
          <button className={allMusic ? 'on' : ''} onClick={() => setAllMusic(true)}>Todo el historial</button>
          <button className={!allMusic ? 'on' : ''} onClick={() => setAllMusic(false)} title="Solo las sesiones donde la mayoría de los temas son del universo activo">Solo tu universo</button>
        </Seg>
      </div>
      {!st ? <div className="empty">Leyendo tu historial…</div> : !s || s.sessions === 0 ? (
        <div className="empty">
          <h3>No hay sesiones para mostrar</h3>
          <p>{!allMusic && st.universe ? 'Ninguna sesión tiene mayoría de temas de tu universo. Probá con «Todo el historial».' : 'Cuando toques con rekordbox, tus sesiones del historial aparecen acá.'}</p>
        </div>
      ) : (
        <div className="setchart ss">
          <div className="setchart-stats stat-grid">
            <div><span className="eyebrow">Sesiones</span><span className="v">{s.sessions}</span></div>
            <div><span className="eyebrow">Duración media</span><span className="v">{fmtMin(s.minutes)} <small>temas enteros</small></span></div>
            <div><span className="eyebrow">BPM medio</span><span className="v">{fmtBpm(s.bpm)}</span></div>
            <div title="En qué parte del set llega tu peak, en promedio"><span className="eyebrow">Tu peak llega</span><span className="v">{s.peak_at != null ? `al ${Math.round(s.peak_at * 100)}%` : '–'} <small>{s.peak_minute != null ? `min ${Math.round(s.peak_minute)}` : ''}</small></span></div>
            <div><span className="eyebrow">Temas distintos</span><span className="v">{s.tracks} <small>{s.plays} reproducciones</small></span></div>
          </div>

          <section>
            <h3 className="ss-h">Tu curva típica</h3>
            <p className="muted ss-p">Cómo suele moverse la energía de tus sesiones, del arranque al final ({plural(st.curves, 'sesión', 'sesiones')} con datos). La franja es donde cae la mitad de ellas.</p>
            <TypicalCurve data={st.typical} peakAt={s.peak_at} />
          </section>

          {st.months.length > 1 && (
            <section>
              <h3 className="ss-h">Mes a mes</h3>
              <Months data={st.months} />
            </section>
          )}

          <div className="ss-grid">
            <TrackList title="Tus temas de peak" hint="Los que más veces quedaron en el punto más alto de la sesión." items={st.peak_tracks} suffix={(t) => `${t.count}×`} />
            <TrackList title="Con qué abrís" hint="El primer tema de tus sesiones." items={st.openers} suffix={(t) => `${t.count}×`} />
            <TrackList title="Con qué cerrás" hint="El último tema de tus sesiones." items={st.closers} suffix={(t) => `${t.count}×`} />
            <TrackList title="Los tocabas seguido y ya no" hint="En 3 o más sesiones, y la última hace más de 6 meses." items={st.forgotten} suffix={(t) => (t.last ? fmtDate(t.last) : '')} />
            <section className="card ss-list ss-wide">
              <h3>Pasadas que más repetís</h3>
              <p className="muted">El mismo tema seguido del mismo tema, en varias sesiones.</p>
              {st.pairs.length === 0 ? <p className="faint">Todavía ninguna pasada se repite.</p> : (
                <ol>
                  {st.pairs.map((p) => (
                    <li key={`${p.a.id}-${p.b.id}`}>
                      <div className="ellipsis"><b>{cleanTitle(p.a.title)}</b> <span className="muted">→</span> <b>{cleanTitle(p.b.title)}</b></div>
                      <span className="num ss-count">{p.count}×</span>
                      <button className="btn ghost sm" onClick={() => openMix(p.a.id, p.b.id)}><IconMix size={13} /> Probar</button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section>
            <h3 className="ss-h">Sesiones</h3>
            <table className="ss-table">
              <thead><tr><th>Fecha</th><th>Sesión</th><th className="r">Temas</th><th className="r">Duración</th><th className="r">BPM</th><th className="r">Energía</th><th className="r">Peak</th></tr></thead>
              <tbody>
                {st.sessions.map((x) => (
                  <tr key={x.id} onClick={() => go('crate', String(x.id))}>
                    <td className="num">{x.date ? fmtDate(x.date) : '–'}</td>
                    <td className="ellipsis">{x.name}</td>
                    <td className="num r">{x.tracks}</td>
                    <td className="num r">{fmtMin(x.minutes)}</td>
                    <td className="num r">{fmtBpm(x.bpm)}</td>
                    <td className="num r">{fmtEnergy(x.energy)}</td>
                    <td className="num r">{x.peak ? `tema ${x.peak}` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  )
}
