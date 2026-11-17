import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { Job } from '../types'
import { hash, keyColor } from '../util'
import { Sleeve } from './bits'
import { BrandMark, IconCheck, IconFolder, IconLink } from './icons'

// ------------------------------------------------------------------ arranque
/** Lo que se ve mientras el motor contesta por primera vez (el mismo diseño ya está en index.html, así no hay salto). */
export function Splash({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-in">
        <div className="splash-mark"><BrandMark /></div>
        <div className="splash-name">batea</div>
        {error ? (
          <>
            <p className="splash-msg">No pude conectar con el motor de Batea.</p>
            <p className="splash-sub">Si vuelve a pasar, cerrala y abrila de nuevo. El detalle queda en ~/Library/Logs/Batea.log.</p>
            <button className="btn primary" onClick={onRetry}>Reintentar</button>
          </>
        ) : (
          <>
            <div className="splash-bar"><i /></div>
            <p className="splash-sub">Abriendo tu librería…</p>
          </>
        )}
      </div>
    </div>
  )
}

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

function ArtCrates() {
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

function ArtKeys() {
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

function ArtMap() {
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

function ArtMix() {
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

function ArtSuggest() {
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

function ArtUniverses() {
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

function ArtFolders() {
  const rows: [string, string, number, boolean][] = [
    ['Tu Mac', 'Música › Nuevos', 42, false],
    ['Tu Mac', 'Descargas › Promos', 18, false],
    ['PortableSSD', 'SETS › 2026', 318, false],
    ['PortableSSD', 'Samples', 0, true],
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

function ArtAI() {
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

// ------------------------------------------------------------------ diapositivas
interface Slide { id: string; eyebrow: string; title: string; body: string; art: ReactNode }

const SLIDES: Slide[] = [
  { id: 'bateas', eyebrow: 'Bateas', title: 'Tu librería, como una batea de discos.', body: 'Hojeás las cajas con sus carátulas, filtrás por tono, BPM y energía, y armás tus propias cajas. Todo lo de rekordbox entra tal cual y se lee sin modificarlo.', art: <ArtCrates /> },
  { id: 'tagger', eyebrow: 'Etiquetado rápido', title: 'Un tema en segundos, sin tocar el mouse.', body: 'Escuchás y etiquetás con el teclado: energía, puntaje, intro, outro, mashup, acapella. También en tanda, con varios temas juntos.', art: <ArtKeys /> },
  { id: 'map', eyebrow: 'Mapa', title: 'Tu música como una constelación.', body: 'Cada tema es una estrella. Los que mezclás juntos forman racimos; tocás una y se encienden sus conexiones y sugeridos. Además, la rueda Camelot de siempre.', art: <ArtMap /> },
  { id: 'mix', eyebrow: 'Probar la mezcla', title: 'Probá la mezcla antes de la noche.', body: 'Dos temas alineados por la grilla de compases: elegís en qué compás entra el segundo y escuchás el cruce. El veredicto queda anotado como relación.', art: <ArtMix /> },
  { id: 'suggest', eyebrow: 'Qué poner después', title: 'Sugerencias que aprenden de cómo mezclás.', body: 'Combinan tono, BPM y energía con tu historial real de rekordbox, y te explican el porqué de cada una. También desde el ícono de la barra de menú, mientras tocás.', art: <ArtSuggest /> },
  { id: 'universes', eyebrow: 'Universos', title: 'Un universo para cada tipo de noche.', body: 'Limitá todo Batea a las playlists y carpetas que elijas: techno, cumbia, casamientos. No borra nada; con «Toda la librería» volvés a ver todo.', art: <ArtUniverses /> },
  { id: 'found', eyebrow: 'Música nueva', title: 'También encuentra lo que todavía no pasó por rekordbox.', body: 'Busca sola en tu Mac y en cada disco que conectes. El análisis (BPM, tono, energía, intro y outro) se hace solo cuando lo pedís, de a un tema por vez, para no trabar la computadora.', art: <ArtFolders /> },
  { id: 'ai', eyebrow: 'Con tu IA', title: 'Hablá con tu librería.', body: 'Conectá Claude, Codex o Cursor y preguntales por tus sesiones, armá sets o pedí ideas. Cada tema que nombran es un link que abre Batea.', art: <ArtAI /> },
]

const SLIDE_MS = 8500

// ------------------------------------------------------------------ qué traer (se pregunta; nada arranca solo)
type Search = 'none' | 'all' | 'folder'
interface Plan { rekordbox: boolean; search: Search; path: string | null }

function Option({ on, onSelect, title, children, disabled, kind = 'radio' }: { on: boolean; onSelect: () => void; title: string; children?: ReactNode; disabled?: boolean; kind?: 'radio' | 'check' }) {
  return (
    <button type="button" role={kind} aria-checked={on} disabled={disabled} className={`wl-opt${on ? ' on' : ''}`} onClick={onSelect}>
      <span className={`wl-mark ${kind}`}>{on && (kind === 'check' ? <IconCheck size={11} /> : <i />)}</span>
      <span className="wl-opt-t"><b>{title}</b>{children && <span>{children}</span>}</span>
    </button>
  )
}

/** Primera pantalla: solo la pregunta. Las diapositivas aparecen después, mientras se importa. */
function SetupScreen({ rbFound, plan, setPlan, onStart, busy }: { rbFound: boolean; plan: Plan; setPlan: (p: Plan) => void; onStart: () => void; busy: boolean }) {
  const pickFolder = async () => {
    if (!window.pywebview?.api) { useApp.getState().toast('Elegir una carpeta funciona dentro de la app de Batea', 'error'); return }
    const p = await window.pywebview.api.pick_folder()
    if (p) setPlan({ ...plan, search: 'folder', path: p })
  }
  const nothing = !plan.rekordbox && plan.search === 'none'
  return (
    <div className="welcome setup" role="dialog" aria-label="Configuración inicial de Batea">
      <header className="wl-top"><div className="brand"><BrandMark /><span className="brand-name">batea</span></div></header>
      <main className="su-body">
        <div className="su-head">
          <h1>Bienvenido a Batea</h1>
          <p>Elegí qué querés traer. No se importa, no se busca y no se analiza nada hasta que lo confirmes.</p>
        </div>
        <section className="su-group">
          <span className="eyebrow">Tu librería de rekordbox</span>
          <Option kind="check" on={plan.rekordbox} disabled={!rbFound} onSelect={() => setPlan({ ...plan, rekordbox: !plan.rekordbox })} title="Importar mi librería">
            {rbFound ? 'Encontré rekordbox en esta Mac. Se lee una copia de su base: temas, playlists e historial. Nunca se modifica.' : 'No encontré rekordbox en esta Mac. Si lo instalás después, podés importarlo desde «Analizar e importar».'}
          </Option>
        </section>
        <section className="su-group">
          <span className="eyebrow">Música que todavía no pasó por rekordbox</span>
          <Option on={plan.search === 'none'} onSelect={() => setPlan({ ...plan, search: 'none' })} title="Más tarde">Lo busco yo cuando quiera, desde «Analizar e importar».</Option>
          <Option on={plan.search === 'all'} onSelect={() => setPlan({ ...plan, search: 'all' })} title="Buscar en mi Mac y mis discos">
            Recorre tu carpeta personal y los discos conectados, y vuelve a mirar al abrir y al enchufar un disco. Solo lee. macOS va a pedir permisos.
          </Option>
          <Option on={plan.search === 'folder'} onSelect={() => (plan.path ? setPlan({ ...plan, search: 'folder' }) : void pickFolder())} title="Solo una carpeta">
            {plan.path ? <><code>{plan.path}</code> <span role="link" tabIndex={0} className="wl-link" onClick={(e) => { e.stopPropagation(); void pickFolder() }}>cambiar</span></> : 'Elegís una carpeta y no busco en ningún otro lado.'}
          </Option>
        </section>
        <div className="su-foot">
          <span className="faint">El análisis (BPM, tono, energía) nunca es automático: lo pedís vos, de a un tema por vez.</span>
          <button className="btn primary wl-cta" onClick={onStart} disabled={busy || (plan.search === 'folder' && !plan.path)}>{nothing ? 'Entrar sin importar nada' : 'Empezar'}</button>
        </div>
      </main>
    </div>
  )
}

// ------------------------------------------------------------------ progreso de la carga
interface Load {
  phase: 'waiting' | 'sync' | 'discover' | 'done'
  job: Job | null
  tracks: number
  local: number
  syncSeen: boolean
  discoverSeen: boolean
}

const INITIAL: Load = { phase: 'waiting', job: null, tracks: 0, local: 0, syncSeen: false, discoverSeen: false }

/** Vista previa para diseño y pruebas: #demo=ask | waiting | sync | discover | done | empty */
function demoLoad(kind: string): Load {
  const job = (label: string, message: string, progress: number): Job => ({ id: 'demo', kind: 'demo', label, status: 'running', progress, message, result: {} })
  switch (kind) {
    case 'sync': return { ...INITIAL, phase: 'sync', job: job('Sincronizando con rekordbox', 'Temas 8.420/18.230', 0.2), tracks: 8420, syncSeen: true }
    case 'discover': return { ...INITIAL, phase: 'discover', job: job('Buscando música nueva', 'Recorriendo PortableSSD…', 0.55), tracks: 18230, local: 126, syncSeen: true, discoverSeen: true }
    case 'done': return { ...INITIAL, phase: 'done', tracks: 18356, local: 126, syncSeen: true, discoverSeen: true }
    case 'empty': return { ...INITIAL, phase: 'done', tracks: 0 }
    default: return INITIAL
  }
}

/** Sigue el avance de lo que la persona eligió. Termina cuando lo elegido ya corrió y no queda nada en marcha
 *  (la búsqueda automática arranca unos segundos después de la importación de rekordbox). */
function useLoading(active: boolean, plan: Plan, demo: string | null): Load {
  const [load, setLoad] = useState<Load>(() => (demo ? demoLoad(demo) : INITIAL))
  useEffect(() => {
    if (!active || demo) return
    let alive = true
    const t0 = Date.now()
    let idleSince: number | null = null
    const expectSync = plan.rekordbox
    const expectDisc = plan.search !== 'none'
    const tick = async () => {
      try {
        const [st, jobs] = await Promise.all([api.status(), api.jobs()])
        if (!alive) return
        const sync = jobs.find((j) => j.kind === 'sync' && j.status === 'running') ?? null
        const disc = jobs.find((j) => j.kind === 'discover' && j.status === 'running') ?? null
        const syncSeen = jobs.some((j) => j.kind === 'sync') || !!st.last_sync
        const discoverSeen = jobs.some((j) => j.kind === 'discover')
        const now = Date.now()
        if (sync || disc) idleSince = null
        else if (idleSince === null) idleSince = now
        const idle = idleSince === null ? 0 : now - idleSince
        const done = !sync && !disc && now - t0 > 1500 && (!expectSync || syncSeen) && (!expectDisc || discoverSeen || idle > 9000)
        setLoad({ phase: done ? 'done' : sync ? 'sync' : disc ? 'discover' : 'waiting', job: sync ?? disc, tracks: st.library_tracks, local: st.local, syncSeen, discoverSeen })
      } catch { /* el motor puede estar ocupado: se reintenta */ }
    }
    void tick()
    const iv = window.setInterval(tick, 1000)
    return () => { alive = false; window.clearInterval(iv) }
  }, [active, demo, plan.rekordbox, plan.search])
  return load
}

function Step({ state, children }: { state: 'todo' | 'now' | 'done'; children: ReactNode }) {
  return (
    <li className={`wl-step ${state}`}>
      <span className="ic">{state === 'done' ? <IconCheck size={11} /> : state === 'now' ? <i className="wl-spin" /> : ''}</span>
      {children}
    </li>
  )
}

function LoadingPanel({ load, plan, finish }: { load: Load; plan: Plan; finish: (to?: 'inbox') => void }) {
  const done = load.phase === 'done'
  const empty = done && load.tracks === 0
  const fmt = (n: number) => n.toLocaleString('es-AR')
  let title = 'Preparando todo…'
  let sub = 'Arrancando lo que elegiste.'
  if (load.phase === 'sync') { title = 'Importando tu librería de rekordbox'; sub = load.job?.message || 'Leyendo temas, playlists e historial…' }
  if (load.phase === 'discover') { title = 'Buscando música en tu Mac y tus discos'; sub = load.job?.message || 'Recorriendo carpetas…' }
  if (done) {
    title = empty ? 'Batea quedó vacía, por ahora' : 'Tu librería está lista'
    sub = empty
      ? 'No trajiste nada todavía. Cuando quieras: arrastrá una carpeta a la ventana o usá «Analizar e importar».'
      : `${fmt(load.tracks)} temas${load.local ? `, ${fmt(load.local)} de ellos fuera de rekordbox` : ''}.`
  }
  const progress = load.job && !done ? load.job.progress : done ? 1 : 0
  const stepState = (seen: boolean, phase: 'sync' | 'discover') => (load.phase === phase ? 'now' : seen || done ? 'done' : 'todo')
  return (
    <div className={`wl-load${done ? ' done' : ''}${empty ? ' nothing' : ''}`}>
      <div className="wl-load-main">
        <div className="wl-load-h">
          <span className="wl-load-ic">{empty ? <IconFolder size={15} /> : done ? <IconCheck size={15} /> : <i className="wl-spin big" />}</span>
          <div>
            <b>{title}</b>
            <span className="muted">{sub}</span>
          </div>
        </div>
        <div className={`wl-bar${!done && !load.job ? ' indet' : ''}`}><i style={{ width: `${Math.max(2, progress * 100)}%` }} /></div>
        <ul className="wl-steps">
          {plan.rekordbox && <Step state={stepState(load.syncSeen && load.phase !== 'sync', 'sync')}>Leer rekordbox (solo lectura)</Step>}
          {plan.search !== 'none' && <Step state={stepState(load.discoverSeen && load.phase !== 'discover', 'discover')}>{plan.search === 'folder' ? 'Revisar la carpeta que elegiste' : 'Buscar música en tu Mac y tus discos'}</Step>}
        </ul>
        {load.phase === 'discover' && plan.search === 'all' && <p className="wl-hint">Si macOS pide permiso para leer carpetas o discos, aceptá: Batea solo lee.</p>}
      </div>
      <div className="wl-load-side">
        <div className="wl-count"><b className="num">{fmt(load.tracks)}</b><span>temas</span></div>
        {done && !empty && <button className="btn primary wl-cta" onClick={() => finish()}>Entrar a Batea</button>}
        {empty && (
          <div className="wl-cta-row">
            <button className="btn primary wl-cta" onClick={() => finish('inbox')}>Traer música</button>
            <button className="btn ghost" onClick={() => finish()}>Entrar igual</button>
          </div>
        )}
      </div>
    </div>
  )
}

function hashParams(): { slide: number | null; demo: string | null } {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const s = p.get('slide')
  return { slide: s !== null && !Number.isNaN(Number(s)) ? Number(s) : null, demo: p.get('demo') }
}

// ------------------------------------------------------------------ presentación
export function Welcome({ mode }: { mode: 'first' | 'replay' }) {
  const { setWelcome, loadMeta, bump, go, trackJob, status, toast } = useApp()
  const params = useMemo(hashParams, [])
  const n = SLIDES.length
  const [index, setIndex] = useState(params.slide !== null ? ((params.slide % n) + n) % n : 0)
  const [elapsed, setElapsed] = useState(0)
  const [playing, setPlaying] = useState(params.slide === null)
  const rbFound = status?.rekordbox_found ?? false
  const [plan, setPlan] = useState<Plan>({ rekordbox: rbFound, search: 'none', path: null })
  const [stage, setStage] = useState<'ask' | 'run'>(params.demo && params.demo !== 'ask' ? 'run' : 'ask')
  const [busy, setBusy] = useState(false)
  const asking = mode === 'first' && stage === 'ask'
  const load = useLoading(mode === 'first' && stage === 'run', plan, params.demo)

  const show = useCallback((i: number) => { setIndex(((i % n) + n) % n); setElapsed(0) }, [n])

  // Avanza sola. Solo la frena el botón de pausa: no depende de dónde esté el mouse ni de otros ajustes.
  useEffect(() => {
    if (!playing || asking) return
    const iv = window.setInterval(() => setElapsed((e) => e + 100), 100)
    return () => window.clearInterval(iv)
  }, [playing, asking])
  useEffect(() => { if (elapsed >= SLIDE_MS) show(index + 1) }, [elapsed, index, show])

  const finish = useCallback(async (to?: 'inbox') => {
    if (mode === 'first') void api.welcomeDone().catch(() => undefined)
    setWelcome(null)
    await loadMeta().catch(() => undefined)
    bump()
    go(to ?? 'home')
  }, [mode, setWelcome, loadMeta, bump, go])

  const begin = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api.setup({ rekordbox: plan.rekordbox, search: plan.search, path: plan.path })
      if (!plan.rekordbox && plan.search === 'none') { await finish(); return }   // no eligió traer nada: directo a la app
      for (const j of [r.sync, r.discover]) if (j) trackJob(j)
      setElapsed(0)
      setStage('run')                                                          // recién ahora aparecen las diapositivas
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }, [plan, trackJob, toast, finish])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') show(index + 1)
      else if (e.key === 'ArrowLeft') show(index - 1)
      else if (e.key === 'Escape' && mode === 'replay') void finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, show, mode, finish])

  if (asking) return <SetupScreen rbFound={rbFound} plan={plan} setPlan={setPlan} onStart={() => void begin()} busy={busy} />

  const slide = SLIDES[index]
  return (
    <div className="welcome" role="dialog" aria-label="Bienvenida a Batea">
      <header className="wl-top">
        <div className="brand"><BrandMark /><span className="brand-name">batea</span></div>
        <button className="btn ghost" onClick={() => void finish()}>{mode === 'replay' ? 'Cerrar' : 'Saltar presentación'}</button>
      </header>

      <section className="wl-stage">
        <div className="wl-slide" key={slide.id} aria-live="polite">
          <div className="wl-copy">
            <span className="wl-eyebrow">{String(index + 1).padStart(2, '0')} / {String(n).padStart(2, '0')} · {slide.eyebrow}</span>
            <h1>{slide.title}</h1>
            <p>{slide.body}</p>
          </div>
          <div className="wl-art">{slide.art}</div>
        </div>
      </section>

      <nav className="wl-dots" aria-label="Diapositivas">
        <button className="btn ghost sm icon" aria-label="Anterior" onClick={() => show(index - 1)}>‹</button>
        {SLIDES.map((s, i) => (
          <button key={s.id} className={`wl-dot${i === index ? ' on' : ''}`} aria-label={s.eyebrow} aria-current={i === index} onClick={() => show(i)}>
            <span><i style={{ width: i === index ? `${playing ? Math.min(100, (elapsed / SLIDE_MS) * 100) : 100}%` : '0%' }} /></span>
          </button>
        ))}
        <button className="btn ghost sm icon" aria-label="Siguiente" onClick={() => show(index + 1)}>›</button>
        <button className="btn ghost sm icon wl-play" aria-label={playing ? 'Pausar' : 'Reanudar'} title={playing ? 'Pausar' : 'Reanudar'} onClick={() => setPlaying((v) => !v)}>{playing ? '❚❚' : '▶'}</button>
      </nav>

      <footer className="wl-foot">
        {mode === 'replay'
          ? <div className="wl-replay muted">Podés volver a ver esta presentación cuando quieras desde la barra lateral.</div>
          : <LoadingPanel load={load} plan={plan} finish={(to) => void finish(to)} />}
      </footer>
    </div>
  )
}
