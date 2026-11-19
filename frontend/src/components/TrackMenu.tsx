import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { spring, usePresence } from '../lib/motion'
import { Item, MenuShell, Sep } from './ContextMenu'
import { api } from '../api'
import { useApp, usePlayer } from '../store'
import type { Track } from '../types'
import { cleanTitle } from '../util'

// ------------------------------------------------------------------ estado del menú
interface MenuState {
  menu: { x: number; y: number; tracks: Track[] } | null
  open: (x: number, y: number, tracks: Track[]) => void
  close: () => void
}
const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, tracks) => set({ menu: { x, y, tracks } }),
  close: () => set({ menu: null }),
}))

/**
 * Click derecho sobre un tema. Si el tema forma parte de la selección múltiple, el menú actúa sobre
 * todos los seleccionados; si no, sobre ese tema solo (y lo selecciona).
 */
export function openTrackMenu(e: React.MouseEvent, t: Track, all: Track[], multi?: Set<number>) {
  e.preventDefault()
  e.stopPropagation()
  const many = multi && multi.size > 1 && multi.has(t.id) ? all.filter((x) => multi.has(x.id)) : [t]
  if (many.length === 1) useApp.getState().select(t.id)
  useMenu.getState().open(e.clientX, e.clientY, many)
}

const PARA_RB = 'Para rekordbox'

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return } catch { /* WebKit puede negarlo */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  try { document.execCommand('copy') } finally { ta.remove() }
}

export function TrackMenu() {
  const { menu: live, close } = useMenu()
  return <MenuShell live={live} close={close}>{(menu) => <TrackMenuItems menu={menu} close={close} />}</MenuShell>
}

function TrackMenuItems({ menu, close }: { menu: NonNullable<MenuState['menu']>; close: () => void }) {
  const app = useApp()
  const playing = usePlayer((s) => s.track)
  const ts = menu.tracks
  const one = ts.length === 1 ? ts[0] : null
  const ids = ts.map((t) => t.id)
  const n = ts.length
  const temas = n === 1 ? 'el tema' : `${n} temas`
  const local = ts.filter((t) => t.source === 'local' && t.online)
  const unanalyzed = local.filter((t) => t.unanalyzed === 'pending' || t.unanalyzed === 'error')
  const userCrates = app.crates.filter((c) => c.kind === 'user')
  const here = app.view === 'crate' ? app.crates.find((c) => String(c.id) === app.crateId && c.kind === 'user') : undefined
  const allHidden = ts.every((t) => t.hidden)

  const run = (fn: () => void | Promise<void>) => async () => {
    close()
    try { await fn() } catch (e) { app.toast((e as Error).message, 'error') }
  }
  const refresh = async () => { await app.loadMeta(); app.bump() }

  const addTo = async (id: number | string, name: string) => {
    await api.addToCrate(id, ids)
    await refresh()
    app.toast(`${n === 1 ? 'Agregado' : `${n} temas agregados`} a ${name}`)
  }
  const toRekordbox = async () => {
    const c = app.crates.find((x) => x.kind === 'user' && x.name === PARA_RB)
    const id = c ? c.id : (await api.createCrate(PARA_RB)).id
    await api.addToCrate(id, ids)
    await refresh()
    app.toast(`${n === 1 ? 'Agregado' : `${n} temas agregados`} a ${PARA_RB}. Pasalos con Exportar.`)
  }
  const rate = async (v: number) => {
    await api.batch(ids, { rating: v })
    for (const id of ids) app.patchTrack({ id, rating: v })
  }
  const compatibles = () => {
    if (!one) return
    const f: Record<string, unknown> = {}
    if (one.key) f.key_compat = one.key
    if (one.bpm) { f.bpm_min = Math.round(one.bpm * 0.97 * 10) / 10; f.bpm_max = Math.round(one.bpm * 1.03 * 10) / 10 }
    app.goFiltered('all', f)
    app.toast(`Compatibles con “${cleanTitle(one.title)}”: tono ${one.key ?? '—'} y vecinos, ${one.bpm ? `${Math.round(one.bpm)} BPM ±3%` : 'cualquier BPM'}`)
  }
  const mixWith = playing && one && playing.id !== one.id ? playing : null

  return (
    <>
      <div className="cm-head ellipsis">{one ? cleanTitle(one.title) : `${n} temas seleccionados`}</div>

      {one && <Item onClick={run(() => usePlayer.getState().play(one))} disabled={!one.online} hint={one.online ? undefined : 'El archivo no está disponible'}>Reproducir</Item>}
      {one && <Item onClick={run(() => app.select(one.id))}>Ver ficha</Item>}
      {one && <Item onClick={run(async () => { await api.reveal(one.id) })} disabled={!one.online}>Mostrar en Finder</Item>}
      <Sep />

      {(() => {
        if (!local.length) {
          return <Item disabled hint="Los temas de rekordbox se analizan en rekordbox">Analizar</Item>
        }
        if (unanalyzed.length) {
          return <Item onClick={run(() => app.analyzeTracks(unanalyzed.map((t) => t.id)))}>{n === 1 ? 'Analizar' : `Analizar ${unanalyzed.length} sin analizar`}</Item>
        }
        return <Item onClick={run(() => app.analyzeTracks(local.map((t) => t.id)))} hint="Recalcula BPM, tono, energía, intro, outro y la waveform">
          {local.length === 1 ? 'Volver a analizar' : `Volver a analizar ${local.length}`}
        </Item>
      })()}
      {one && (
        <Item onClick={run(() => app.setEditTrack(one.id))} disabled={one.source !== 'local'}
          hint={one.source !== 'local' ? 'Los datos se editan en el programa de origen' : 'Título, artista, sello, género…'}>
          Editar datos…
        </Item>
      )}
      <Item onClick={run(() => app.openTagger(ts, one ? cleanTitle(one.title) : `${n} seleccionados`))}>Etiquetar…</Item>
      <Item sub={
        <>
          {[5, 4, 3, 2, 1].map((v) => (
            <Item key={v} onClick={run(() => rate(v))}><span className="cm-stars">{'★'.repeat(v)}<i>{'★'.repeat(5 - v)}</i></span></Item>
          ))}
          <Sep />
          <Item onClick={run(() => rate(0))}>Sin puntaje</Item>
        </>
      }>Puntaje</Item>
      <Sep />

      <Item sub={
        <>
          {userCrates.length === 0 && <div className="cm-note">Todavía no tenés cajas</div>}
          {userCrates.map((c) => <Item key={c.id} onClick={run(() => addTo(c.id, c.name))}>{c.name}</Item>)}
          <Sep />
          <Item onClick={run(async () => {
            const name = await app.askText('Nombre de la caja nueva')
            if (!name) return
            const { id } = await api.createCrate(name)
            await addTo(id, name)
          })}>Nueva caja…</Item>
        </>
      }>Agregar a una caja</Item>
      <Item onClick={run(toRekordbox)} hint={`Los suma a la caja “${PARA_RB}”, que se pasa a rekordbox con Exportar`}>Llevar a rekordbox</Item>
      <Sep />

      {one && <Item onClick={run(compatibles)} disabled={!one.key && !one.bpm} hint="Temas de toda la colección con tono compatible y BPM parecido">Buscar compatibles para mezclar</Item>}
      {one && <Item onClick={run(() => app.setCueEditor(one.id))} hint="Hot cues, memory cues y loops">Editar cues…</Item>}
      {one && <Item onClick={run(() => app.openMixPicker(one.id))} hint="Elegí con qué tema">Probar mezcla con…</Item>}
      {n === 2 && <Item onClick={run(() => app.openMix(ids[0], ids[1]))}>Probar la mezcla</Item>}
      {mixWith && one && <Item onClick={run(() => app.openMix(mixWith.id, one.id))} hint={`Con “${cleanTitle(mixWith.title)}”`}>Probar mezcla con el que suena</Item>}
      <Item onClick={run(async () => { await api.batch(ids, { reviewed: true }); await refresh(); app.toast(n === 1 ? 'Marcado como revisado' : `${n} marcados como revisados`) })}
        hint="Sale de “Sin clasificar”">Marcar como revisado</Item>
      <Item onClick={run(async () => {
        await copy(ts.map((t) => [t.artist, cleanTitle(t.title)].filter(Boolean).join(' - ')).join('\n'))
        app.toast(n === 1 ? 'Copiado' : `${n} nombres copiados`)
      })}>Copiar “Artista - Título”</Item>
      <Sep />

      {here && (
        <Item onClick={run(async () => {
          for (const id of ids) await api.removeFromCrate(here.id, id)
          await refresh()
          app.toast(`${n === 1 ? 'Quitado' : `${n} quitados`} de “${here.name}”`)
        })}>Quitar de “{here.name}”</Item>
      )}
      {allHidden ? (
        <Item onClick={run(async () => { await api.batch(ids, { hidden: false }); await refresh(); app.toast(n === 1 ? 'Vuelve a estar en Batea' : `${n} temas vuelven a estar en Batea`) })}>
          Volver a mostrar en Batea
        </Item>
      ) : (
        <Item danger onClick={run(async () => {
          if (!window.confirm(`¿Eliminar ${temas} de Batea?\n\nNo se borra ningún archivo ni nada de rekordbox: solo deja de verse en Batea. Lo podés recuperar desde el atajo “Eliminados de Batea”.`)) return
          await api.batch(ids, { hidden: true })
          if (one && app.selectedId === one.id) app.select(null)
          await refresh()
          app.toast(n === 1 ? 'Eliminado de Batea (el archivo sigue en su lugar)' : `${n} temas eliminados de Batea (los archivos siguen en su lugar)`)
        })}>Eliminar de Batea…</Item>
      )}
    </>
  )
}

// ------------------------------------------------------------------ editar datos
const FIELDS: [key: string, label: string][] = [
  ['title', 'Título'], ['artist', 'Artista'], ['remixer', 'Remixer'], ['album', 'Álbum'], ['label', 'Sello'], ['genre', 'Género'], ['year', 'Año'],
]

export function EditTrackDialog() {
  const { editTrackId, setEditTrack, patchTrack, toast } = useApp()
  const [vals, setVals] = useState<Record<string, string> | null>(null)
  const [busy, setBusy] = useState(false)

  const [shownId, closing] = usePresence(editTrackId, spring.slow.exit)

  useEffect(() => {
    if (editTrackId == null) return   // al cerrar se mantienen los datos mientras sale; se pisan al abrir otro
    setVals(null)
    api.track(editTrackId).then((d) => {
      const r = d as unknown as Record<string, unknown>
      setVals(Object.fromEntries(FIELDS.map(([k]) => [k, r[k] == null ? '' : String(r[k])])))
    }).catch((e) => { toast((e as Error).message, 'error'); setEditTrack(null) })
  }, [editTrackId, setEditTrack, toast])

  if (shownId == null || !vals) return null
  const save = async () => {
    setBusy(true)
    try {
      const d = await api.patchTrack(shownId, { meta: vals })
      patchTrack({ id: d.id, title: d.title, artist: d.artist, remixer: d.remixer, album: d.album, label: d.label, genre: d.genre, year: d.year })
      toast('Datos guardados')
      setEditTrack(null)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && setEditTrack(null)}>
      <form className="modal" style={{ width: 480 }} onSubmit={(e) => { e.preventDefault(); void save() }}
        onKeyDown={(e) => e.key === 'Escape' && setEditTrack(null)}>
        <div>
          <h2 style={{ fontSize: 16 }}>Editar datos</h2>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.5 }}>
            Se guardan en Batea y viajan a rekordbox cuando exportás. El archivo no se modifica, y volver a analizar no pisa lo que escribas acá.
          </p>
        </div>
        <div className="edit-grid">
          {FIELDS.map(([k, label], i) => (
            <label key={k} className={k === 'title' || k === 'artist' ? 'wide' : ''}>
              <span className="eyebrow">{label}</span>
              <input className="input" autoFocus={i === 0} value={vals[k]} inputMode={k === 'year' ? 'numeric' : undefined}
                onChange={(e) => setVals({ ...vals, [k]: k === 'year' ? e.target.value.replace(/\D/g, '').slice(0, 4) : e.target.value })} />
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn ghost" onClick={() => setEditTrack(null)}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={busy || !vals.title.trim()}>Guardar</button>
        </div>
      </form>
    </div>
  )
}
