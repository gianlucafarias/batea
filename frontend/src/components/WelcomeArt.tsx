import { useMemo, type ReactNode } from 'react'
import { hash, keyColor } from '../util'
import { Sleeve } from './bits'
import { IconCheck, IconFolder, IconLink } from './icons'

// ------------------------------------------------------------------ datos de las ilustraciones
// Temas inventados: los sobres se generan solos con el color de la tonalidad, igual que en la app.
const DEMO = [
  { id: 101, title: 'Medianoche', artist: 'Ciclo 9', key: '8A', bpm: 126 },
  { id: 102, title: 'Sub Tierra', artist: 'Lunar', key: '9A', bpm: 127 },
  { id: 103, title: 'Humo y Neón', artist: 'Ciclo 9', key: '8B', bpm: 125 },
  { id: 104, title: 'Pista Cero', artist: 'Aurora Sur', key: '7A', bpm: 128 },
  { id: 105, title: 'Vuelta al Sol', artist: 'Lunar', key: '10A', bpm: 124 },
  { id: 106, title: 'Cobre', artist: 'Aurora Sur', key: '8A', bpm: 126 },
]

function DemoSleeve({ i, px }: { i: number; px: number }) {
  const d = DEMO[i % DEMO.length]
  return <Sleeve id={d.id} title={d.title} artist={d.artist} trackKey={d.key} bpm={d.bpm} hasArt={false} px={px} />
}

function Chip({ children, on, tone }: { children: ReactNode; on?: boolean; tone?: string }) {
  return <span className={`wl-chip${on ? ' on' : ''}`} style={tone ? { ['--c' as string]: tone } : undefined}>{children}</span>
}

// ------------------------------------------------------------------ ilustraciones
function MiniCrate({ name, kind, label, ids, tilt }: { name: string; kind: string; label: string; ids: number[]; tilt: string }) {
  return (
    <div className={`crate kind-${kind}`} style={{ width: 214 }}>
      <div className="peek">
        {ids.map((id, i) => {
          const h = hash(id)
          return (
            <div key={id} className="rec" style={{ left: 16 - i * 3, right: 16 - i * 3, top: 10 + i * 10 + h * 4, zIndex: i, transform: `rotate(${(h - 0.5) * 2.4}deg)` }}>
              <DemoSleeve i={id - 101} px={170} />
            </div>
          )
        })}
      </div>
      <div className="box">
        <span className="tape" style={{ ['--tilt' as string]: tilt }}>{name}</span>
        <div className="meta"><span>{label}</span><span>{kind === 'user' ? 'mía' : 'rekordbox'}</span></div>
      </div>
    </div>
  )
}

export function ArtCrates() {
  return (
    <div className="wl-crates">
      <div style={{ transform: 'translateY(10px)' }}><MiniCrate name="Peak time" kind="playlist" label="148 discos" ids={[101, 102, 104]} tilt="-1.6deg" /></div>
      <div style={{ transform: 'translateY(-8px)' }}><MiniCrate name="Para el sábado" kind="user" label="32 discos" ids={[103, 105, 106]} tilt="1.2deg" /></div>
      <div className="wl-filters">
        <Chip on tone={keyColor('8A')}>8A</Chip><Chip>120 – 128 BPM</Chip><Chip>Energía 7+</Chip><Chip>sin mashup</Chip>
      </div>
    </div>
  )
}

export function ArtKeys() {
  const rows: [string[], string][] = [
    [['1', '–', '0'], 'Energía'],
    [['⇧', '1', '–', '5'], 'Puntaje'],
    [['A', '–', 'Z'], 'Una letra por etiqueta'],
    [['←', '→'], 'Salta 8 compases'],
    [['↵'], 'Listo, siguiente tema'],
  ]
  return (
    <div className="wl-keys">
      <ul>
        {rows.map(([keys, label]) => (
          <li key={label}>
            <span className="caps">{keys.map((k, i) => (k === '–' ? <b key={i} className="dash">–</b> : <kbd key={i}>{k}</kbd>))}</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>
      <div className="wl-tagrow">
        {['intro', 'outro', 'peak', 'mashup', 'acapella', 'vocal'].map((t) => <Chip key={t} on={t === 'mashup' || t === 'peak'}>{t}</Chip>)}
      </div>
    </div>
  )
}

export function ArtMap() {
  const { nodes, edges } = useMemo(() => {
    const centers = [[150, 120], [370, 100], [250, 250], [420, 250], [110, 270]]
    const ns = Array.from({ length: 58 }, (_, i) => {
      const c = i % centers.length
      const a = hash(i * 7 + 3) * Math.PI * 2
      const r = 14 + hash(i * 13 + 5) * 62
      const n = ((c * 5 + Math.floor(hash(i + 90) * 2)) % 12) + 1
      return { x: centers[c][0] + Math.cos(a) * r * 1.25, y: centers[c][1] + Math.sin(a) * r * 0.9, c, key: `${n}${hash(i + 4) > 0.5 ? 'A' : 'B'}`, s: 1.6 + hash(i * 3) * 2.4 }
    })
    const es: [number, number][] = []
    ns.forEach((p, i) => {
      const near = ns.map((q, j) => ({ j, d: (p.x - q.x) ** 2 + (p.y - q.y) ** 2 })).filter((o) => o.j > i && o.d < 4200).sort((a, b) => a.d - b.d).slice(0, 2)
      near.forEach((o) => es.push([i, o.j]))
    })
    ;[[3, 11], [8, 21], [14, 33], [27, 40]].forEach(([a, b]) => es.push([a, b]))
    return { nodes: ns, edges: es }
  }, [])
  const focus = 12
  const lit = new Set<number>([focus])
  edges.forEach(([a, b]) => { if (a === focus) lit.add(b); if (b === focus) lit.add(a) })
  return (
    <svg className="wl-map" viewBox="0 0 520 340" role="img" aria-label="Mapa de estrellas">
      <defs>
        <radialGradient id="wl-glow"><stop offset="0" stopColor="#ff5a1f" stopOpacity="0.55" /><stop offset="1" stopColor="#ff5a1f" stopOpacity="0" /></radialGradient>
      </defs>
      {edges.map(([a, b], i) => {
        const on = a === focus || b === focus
        return <line key={i} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y} stroke={on ? '#ff7a45' : '#8a8278'} strokeOpacity={on ? 0.9 : 0.2} strokeWidth={on ? 1.3 : 0.7} />
      })}
      <circle cx={nodes[focus].x} cy={nodes[focus].y} r="34" fill="url(#wl-glow)" />
      {nodes.map((p, i) => (
        <circle key={i} className="wl-star" style={{ animationDelay: `${(hash(i + 50) * 3).toFixed(2)}s` }} cx={p.x} cy={p.y} r={i === focus ? 5.2 : lit.has(i) ? p.s + 1 : p.s} fill={keyColor(p.key)} opacity={lit.has(i) || i % 3 === 0 ? 1 : 0.7} />
      ))}
      <circle cx={nodes[focus].x} cy={nodes[focus].y} r="9" fill="none" stroke="#ff7a45" strokeWidth="1.2" />
      <g transform={`translate(${nodes[focus].x + 14} ${nodes[focus].y - 22})`}>
        <rect width="104" height="20" rx="3" fill="#e9dfc6" transform="rotate(-2)" />
        <text x="9" y="14" fontFamily="Permanent Marker, cursive" fontSize="12" fill="#24201b" transform="rotate(-2)">Medianoche</text>
      </g>
    </svg>
  )
}

function bars(seed: number, n: number, shape: (t: number) => number): number[] {
  return Array.from({ length: n }, (_, i) => Math.max(0.08, Math.min(1, shape(i / (n - 1)) * (0.55 + 0.45 * hash(i * 17 + seed)))))
}

export function ArtMix() {
  const N = 92
  const a = useMemo(() => bars(1, N, (t) => (t < 0.12 ? 0.4 : t < 0.55 ? 0.95 : t < 0.68 ? 0.45 : 0.9)), [])
  const b = useMemo(() => bars(9, N, (t) => (t < 0.18 ? 0.35 : t < 0.5 ? 0.95 : 0.85)), [])
  const W = 520, x0 = 14, step = (W - 28) / N, bOff = 38   // B entra 38 barritas después
  return (
    <div className="wl-mix">
      <svg viewBox="0 0 520 250" role="img" aria-label="Dos temas alineados por la grilla de compases">
        {Array.from({ length: 12 }, (_, i) => <line key={i} x1={x0 + i * 8 * step} x2={x0 + i * 8 * step} y1="14" y2="236" stroke="#8a8278" strokeOpacity="0.16" strokeDasharray="2 4" />)}
        {a.map((h, i) => <rect key={i} x={x0 + i * step} y={78 - h * 46} width={step * 0.7} height={h * 92} rx="1" fill="#8a8278" opacity={i > bOff + 4 ? Math.max(0.25, 1 - (i - bOff) / 26) : 0.95} />)}
        {b.slice(0, N - bOff).map((h, i) => <rect key={i} x={x0 + (i + bOff) * step} y={176 - h * 46} width={step * 0.7} height={h * 92} rx="1" fill="#ff5a1f" opacity={i < 8 ? 0.4 + i * 0.07 : 1} />)}
        <line x1={x0 + bOff * step} x2={x0 + bOff * step} y1="8" y2="242" stroke="#ff7a45" strokeWidth="1.6" />
        <path d={`M${x0 + bOff * step} 60 C ${x0 + bOff * step + 40} 60, ${x0 + bOff * step + 60} 150, ${x0 + bOff * step + 110} 150`} fill="none" stroke="#e9dfc6" strokeOpacity="0.55" strokeWidth="1.2" />
        <g transform={`translate(${x0 + bOff * step + 8} 10)`}>
          <rect width="150" height="21" rx="3" fill="#e9dfc6" transform="rotate(-1.5)" />
          <text x="9" y="15" fontFamily="Permanent Marker, cursive" fontSize="12.5" fill="#24201b" transform="rotate(-1.5)">B entra: compás 33</text>
        </g>
        <text x="16" y="14" fontFamily="JetBrains Mono, monospace" fontSize="10" fill="#8a8278">A · 8A · 126</text>
        <text x="16" y="248" fontFamily="JetBrains Mono, monospace" fontSize="10" fill="#8a8278">B · 9A · 127 → suena a la velocidad de A</text>
      </svg>
      <div className="wl-verdict"><Chip on tone="#7ccf8a">Mezclan bien</Chip><Chip>Mashup</Chip><Chip>No van</Chip></div>
    </div>
  )
}

export function ArtSuggest() {
  const rows = [
    { i: 1, why: ['tono compatible', 'BPM +1', 'lo mezclaste 4 veces'] },
    { i: 2, why: ['mismo tono', 'energía parecida'] },
    { i: 3, why: ['sube un tono', 'BPM +2', 'lo tocaste después de este'] },
  ]
  return (
    <div className="wl-sug">
      <div className="wl-seed">
        <div className="wl-seed-art"><DemoSleeve i={0} px={150} /></div>
        <b>Medianoche</b><span className="mono">8A · 126 BPM</span>
      </div>
      <div className="wl-arrow" aria-hidden>→</div>
      <ul>
        {rows.map(({ i, why }) => {
          const d = DEMO[i]
          return (
            <li key={d.id}>
              <div className="wl-mini"><DemoSleeve i={i} px={44} /></div>
              <div className="wl-sug-t"><b>{d.title}</b><span>{d.artist}</span><em>{why.join(' · ')}</em></div>
              <span className="wl-key mono" style={{ ['--c' as string]: keyColor(d.key) }}>{d.key}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function ArtUniverses() {
  return (
    <div className="wl-uni">
      <div className="wl-pills">
        <Chip>Toda la librería</Chip>
        <Chip on>Techno <small>3.140</small></Chip>
        <Chip>Cumbia y reggaetón <small>2.870</small></Chip>
        <Chip>Casamientos <small>910</small></Chip>
      </div>
      <div className="wl-uni-card">
        <span className="eyebrow">Universo activo · Techno</span>
        <div className="wl-uni-row">
          {['Bateas', 'Mapa', 'Sugerencias', 'Etiquetar', 'Tonalidades'].map((t) => <Chip key={t} on>{t}</Chip>)}
        </div>
        <p>todo se limita a las playlists y carpetas que elegiste</p>
      </div>
    </div>
  )
}

export function ArtFolders() {
  const rows: [string, string, number, boolean][] = [
    ['Tu Mac', 'Música › Nuevos', 42, false],
    ['Tu Mac', 'Descargas › Promos', 18, false],
    ['MUSICA', 'SETS › 2026', 318, false],
    ['MUSICA', 'Samples', 0, true],
  ]
  return (
    <div className="wl-fold">
      {rows.map(([disk, path, n, skip]) => (
        <div key={path} className={`wl-fold-row${skip ? ' skip' : ''}`}>
          <IconFolder size={16} />
          <span className="p"><i>{disk}</i> › {path}</span>
          {skip ? <span className="tapeish">no es música</span> : <span className="n mono">{n} temas</span>}
        </div>
      ))}
      <div className="wl-lock"><IconCheck size={14} /> Solo lee. Nunca mueve, renombra ni borra tus archivos.</div>
    </div>
  )
}

export function ArtAI() {
  return (
    <div className="wl-chat">
      <div className="b me">Armame un set de una hora para el sábado, que arranque suave y suba.</div>
      <div className="b ai">
        <p>Listo, 14 temas. Arranca en 118 BPM y cierra en 128:</p>
        <ol>
          <li><span className="mono">8A·124</span> <a><IconLink size={11} /> Medianoche</a></li>
          <li><span className="mono">9A·125</span> <a><IconLink size={11} /> Sub Tierra</a></li>
          <li><span className="mono">9B·126</span> <a><IconLink size={11} /> Humo y Neón</a></li>
        </ol>
        <p className="faint">Cada tema es un link que abre Batea.</p>
      </div>
      <div className="wl-agents"><Chip on>Claude</Chip><Chip on>Codex</Chip><Chip on>Cursor</Chip></div>
    </div>
  )
}
