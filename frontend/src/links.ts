import { api, type OpenTarget } from './api'
import { useApp, usePlayer } from './store'

/** Lleva Batea a lo que pide un link batea:// (tema, caja, carpeta o artista) o recarga si el MCP cambió algo. */
async function handle(t: OpenTarget) {
  const app = useApp.getState()
  if (t.kind === 'refresh') {
    await app.loadMeta()
    app.bump()
    return
  }
  if (app.mix) app.closeMix()
  if (useApp.getState().view === 'tagger') useApp.getState().closeTagger()
  if (t.kind === 'tema') {
    const id = Number(t.value)
    useApp.getState().select(id)
    if (t.play) {
      try { usePlayer.getState().play(await api.track(id)) } catch (e) { useApp.getState().toast((e as Error).message, 'error') }
    }
    return
  }
  await useApp.getState().loadMeta()   // por si la caja es nueva (la creó el MCP)
  const crate = t.kind === 'carpeta' ? `dir:${t.value}` : t.kind === 'artista' ? `artist:${t.value}` : String(t.value)
  useApp.getState().go('crate', crate)
}

let busy = false

/** Levanta los pedidos pendientes. La app nativa lo llama apenas llega un link; además se revisa al volver a la ventana. */
export async function drainLinks() {
  if (busy) return
  busy = true
  try {
    for (const t of await api.openPending()) await handle(t)
  } catch { /* el motor puede estar reiniciando */ } finally {
    busy = false
  }
}
