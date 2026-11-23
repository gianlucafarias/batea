import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'

/**
 * Recorrido del primer uso: resalta cada parte real de la pantalla y explica para qué sirve.
 * Cada paso apunta a un elemento con `data-tour="…"`; si no está a la vista (p. ej. la ficha de un
 * tema cerrada) el globo se muestra centrado. Se ve una vez; se vuelve a ver con Ayuda.
 */
interface Step { target?: string; title: string; body: string; openTrack?: boolean }

const STEPS: Step[] = [
  {
    title: 'Bienvenido a Batea',
    body: 'Batea se apoya en tu librería de rekordbox (o Traktor, Serato) para ayudarte a armar sets: ordenar tu música, saber qué tema va después y probar la mezcla antes de tocar. Nunca modifica tu librería. Son 9 pasos cortos.',
  },
  {
    target: 'nav-home',
    title: 'Bateas: tus cajas de discos',
    body: 'Tus playlists y carpetas de rekordbox, como cajas para revolver. Abrí una para ver sus temas en lista o en portadas. También podés crear cajas propias.',
  },
  {
    target: 'universe',
    title: 'Universo: tu estilo',
    body: 'Si tenés géneros que no mezclás entre sí (techno, cumbia, reggaetón…), elegí un universo con las cajas de un estilo. Así todo Batea, incluidas las sugerencias, solo mira esa música.',
  },
  {
    target: 'nav-map',
    title: 'Mapa',
    body: 'Cada punto es un tema. Los que tocaste seguidos o comparten playlists quedan cerca. Tocá uno para ver con qué se conecta. Con la rueda Camelot buscás por tonalidad.',
  },
  {
    target: 'nav-tagger',
    title: 'Etiquetar',
    body: 'Clasificá rápido con el teclado: momento del set (warm-up, peak), vibra (dark, hipnótico) o si tiene voces. Cuantas más etiquetas, mejores las sugerencias.',
  },
  {
    target: 'nav-inbox',
    title: 'Analizar e importar',
    body: 'Música que no está en tu programa de DJ: Batea la encuentra y calcula BPM, tonalidad, energía, intro y outro. Analiza de a un tema por vez para no trabar la Mac. Los temas de rekordbox usan el análisis de rekordbox.',
  },
  {
    target: 'recs',
    openTrack: true,
    title: 'Qué va después',
    body: 'Al elegir un tema se abre su ficha, como esta. Abajo está "Qué va después": temas que encajan por BPM y tonalidad y son de tu mismo estilo (lo que ya tocaste, tus playlists y carpetas). Cada uno dice por qué. Con 👍 y 👎 Batea aprende.',
  },
  {
    title: 'Probar la mezcla',
    body: 'En la ficha de un tema, "Probar mezcla" (o la tecla M) abre el laboratorio: elegís el tema que entra, lo ubicás en la grilla y escuchás la transición con EQ y crossfader antes del set.',
  },
  {
    target: 'settings',
    title: 'Ajustes',
    body: 'Qué programas lee Batea y cómo ver la tonalidad: Camelot (8A), clásica como rekordbox y los CDJ (Am) u Open Key como Traktor (1m). Es el mismo tono escrito distinto.',
  },
  {
    target: 'export',
    title: 'Exportar',
    body: 'Llevá tus cajas a rekordbox (por XML), Traktor o Serato. Si te perdés, el botón Ayuda vuelve a mostrar este recorrido.',
  },
]

const DONE_KEY = 'batea.tour.v1'

export function tourSeen(): boolean {
  try { return localStorage.getItem(DONE_KEY) === '1' } catch { return true }
}

function markSeen() {
  try { localStorage.setItem(DONE_KEY, '1') } catch { /* sin almacenamiento */ }
}

interface Box { x: number; y: number; w: number; h: number }

function findTarget(step: Step): Box | null {
  if (!step.target) return null
  const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  // solo la parte visible (una sección de la ficha puede seguir más abajo del reproductor)
  const player = document.querySelector('.player-slot')?.getBoundingClientRect()
  const bottomLimit = player && player.height ? player.top : window.innerHeight
  const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, bottomLimit)
  if (r.width < 4 || bottom - top < 24) return null
  const pad = 6
  return { x: r.left - pad, y: top - pad, w: r.width + pad * 2, h: bottom - top + pad * 2 }
}

const CARD_W = 340

function cardPos(box: Box | null, cardH: number): { left: number; top: number } {
  const vw = window.innerWidth, vh = window.innerHeight, m = 16
  if (!box) return { left: (vw - CARD_W) / 2, top: Math.max(m, (vh - cardH) / 2) }
  const clampTop = (t: number) => Math.min(Math.max(m, t), vh - cardH - m)
  const clampLeft = (l: number) => Math.min(Math.max(m, l), vw - CARD_W - m)
  if (box.x + box.w + 14 + CARD_W < vw - m) return { left: box.x + box.w + 14, top: clampTop(box.y) }      // a la derecha
  if (box.x - 14 - CARD_W > m) return { left: box.x - 14 - CARD_W, top: clampTop(box.y) }                  // a la izquierda
  if (box.y + box.h + 14 + cardH < vh - m) return { left: clampLeft(box.x), top: box.y + box.h + 14 }       // abajo
  return { left: clampLeft(box.x), top: clampTop(box.y - cardH - 14) }                                     // arriba
}

export function Tour() {
  const { tour, setTour } = useApp()
  const [i, setI] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [cardH, setCardH] = useState(220)
  const step = STEPS[i]

  const opened = useRef(false)          // el recorrido abrió una ficha: se cierra al terminar
  const close = useCallback(() => {
    markSeen(); setTour(false); setI(0)
    if (opened.current) { useApp.getState().select(null); opened.current = false }
  }, [setTour])

  // pasos que muestran la ficha de un tema: si no hay ninguno abierto, se abre uno
  useEffect(() => {
    if (!tour || !step.openTrack || useApp.getState().selectedId != null) return
    let alive = true
    void (async () => {
      for (const crate of ['top', 'recent', 'all']) {
        const list = await api.tracks(crate).catch(() => [])
        if (!alive) return
        if (list.length) { opened.current = true; useApp.getState().select(list[0].id); return }
      }
    })()
    return () => { alive = false }
  }, [tour, step])

  // si el elemento está fuera de la vista (p. ej. abajo en la ficha), se lo trae
  useEffect(() => {
    if (!tour || !step.target) return
    const t = window.setTimeout(() => {
      document.querySelector(`[data-tour="${step.target}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 350)
    return () => window.clearTimeout(t)
  }, [tour, step])

  useLayoutEffect(() => {
    if (!tour) return
    const place = () => setBox(findTarget(step))
    place()
    window.addEventListener('resize', place)
    const iv = window.setInterval(place, 400)        // la ficha o el mapa pueden aparecer/moverse
    return () => { window.removeEventListener('resize', place); window.clearInterval(iv) }
  }, [tour, step])

  useEffect(() => {
    if (!tour) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); if (i < STEPS.length - 1) setI(i + 1); else close() }
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [tour, i, close])

  if (!tour) return null
  const pos = cardPos(box, cardH)
  const last = i === STEPS.length - 1
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-t">
      {box
        ? <div className="tour-hole" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
        : <div className="tour-dim" />}
      <div className="tour-card" style={{ left: pos.left, top: pos.top, width: CARD_W }}
        ref={(el) => { if (el && Math.abs(el.offsetHeight - cardH) > 2) setCardH(el.offsetHeight) }}>
        <div className="tour-step num">{i + 1} de {STEPS.length}</div>
        <h3 id="tour-t">{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button className="btn ghost sm" onClick={close}>{last ? 'Cerrar' : 'Saltear'}</button>
          <span style={{ flex: 1 }} />
          {i > 0 && <button className="btn sm" onClick={() => setI(i - 1)}>Atrás</button>}
          <button className="btn primary sm" autoFocus onClick={() => (last ? close() : setI(i + 1))}>{last ? 'Empezar' : 'Siguiente'}</button>
        </div>
        <div className="tour-dots" aria-hidden>{STEPS.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
      </div>
    </div>
  )
}
