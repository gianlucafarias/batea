import { useCallback, useEffect, useState } from 'react'
import { AgentsDialog } from './components/Agents'
import { CrateView } from './components/CrateView'
import { Home } from './components/Home'
import { Inbox } from './components/Inbox'
import { MapScreen } from './components/MapScreen'
import { MixLab } from './components/MixLab'
import { Tagger } from './components/Tagger'
import { UniverseEditor } from './components/Universe'
import { ExportDialog, Player, PromptModal, Toasts } from './components/Overlays'
import { EditTrackDialog, TrackMenu } from './components/TrackMenu'
import { Sidebar } from './components/Sidebar'
import { TrackPanel } from './components/TrackPanel'
import { Splash, Welcome } from './components/Welcome'
import { UpdateScreen } from './components/Update'
import { api } from './api'
import { drainLinks } from './links'
import { useApp, usePlayer } from './store'
import { spring, usePresence } from './lib/motion'

// el mapa 3D trae three.js (pesado): se carga recién cuando se abre

export default function App() {
  const { view, loadMeta, selectedId, trackJob, booted, bootError, welcome, update } = useApp()
  // la ficha entra deslizándose al abrirse y sale (más corto) al cerrarse; cambiar de tema no la vuelve a animar
  const [panelId, panelClosing] = usePresence(view !== 'tagger' ? selectedId : null, spring.slow.exit)

  // Arranque: hasta que el motor contesta se ve la pantalla de arranque (no la app vacía). Si es la primera vez
  // (la librería está vacía y la presentación nunca se vio) se muestra la bienvenida mientras se importa.
  const boot = useCallback(() => {
    useApp.setState({ bootError: false })
    // Antes de abrir nada se mira si esta versión todavía sirve (si no hay conexión, se sigue con lo último que se supo)
    api.update().catch(() => null)
      .then((u) => {
        useApp.setState({ update: u })
        if (u?.must_update) return null
        return loadMeta()
      })
      .then(async (skipped) => {
        if (skipped === null) return
        const st = useApp.getState().status
        // primera vez: se le pregunta qué traer (nada se importa ni se busca antes de que lo confirme)
        useApp.setState({ booted: true, welcome: st && !st.welcome_done && st.library_tracks === 0 ? 'first' : null })
        for (const j of st?.jobs ?? []) if (j.status === 'running') trackJob(j)
      })
      .catch(() => useApp.setState({ bootError: true }))
  }, [loadMeta, trackJob])
  useEffect(() => { boot() }, [boot])

  // Arrastrar archivos o carpetas a la ventana: la app nativa recibe las rutas y Batea los trae
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let depth = 0
    const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const enter = (e: DragEvent) => { if (isFiles(e)) { depth++; setDragging(true) } }
    const leave = (e: DragEvent) => { if (isFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) } }
    const over = (e: DragEvent) => { if (isFiles(e)) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return
      e.preventDefault(); depth = 0; setDragging(false)
      if (!window.pywebview) { useApp.getState().toast('Arrastrar archivos funciona dentro de la app de Batea', 'error'); return }
      // el motor ya empezó a traerlos: lo seguimos enseguida
      setTimeout(async () => { for (const j of await api.jobs()) if (j.status === 'running') useApp.getState().trackJob(j) }, 700)
      useApp.getState().go('inbox')
    }
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over); window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over); window.removeEventListener('drop', drop)
    }
  }, [])

  // Batea también arranca trabajos sola (buscar música al abrir o al conectar un disco): seguirlos acá
  useEffect(() => {
    const iv = window.setInterval(async () => {
      try {
        for (const j of await api.jobs()) if (j.status === 'running') useApp.getState().trackJob(j)
      } catch { /* el motor puede estar reiniciando */ }
      void drainLinks()
    }, 4000)
    return () => window.clearInterval(iv)
  }, [])

  // Links batea:// desde otras apps (Claude, Codex, T3…): la ventana nativa avisa al instante; si no, al volver a la ventana
  useEffect(() => {
    const w = window as unknown as { __bateaOpen?: () => void }
    w.__bateaOpen = () => { void drainLinks() }
    void drainLinks()
    window.addEventListener('focus', w.__bateaOpen)
    return () => { window.removeEventListener('focus', w.__bateaOpen!); delete w.__bateaOpen }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (useApp.getState().mix) return        // el laboratorio de mezcla maneja su propio teclado
      if (e.code === 'Space') { e.preventDefault(); usePlayer.getState().toggle() }
      if (e.key === 'Escape') useApp.getState().select(null)
      if (e.metaKey && e.key === '[') { e.preventDefault(); useApp.getState().goBack() }
    }
    // botón "atrás" del mouse
    const onMouseUp = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); useApp.getState().goBack() } }
    // Un botón clickeado con el mouse no se queda con el foco: si no, Espacio o Enter lo volverían a apretar
    const onClick = (e: MouseEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (e.detail > 0 && el?.tagName === 'BUTTON') el.blur()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    window.addEventListener('mouseup', onMouseUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', onClick); window.removeEventListener('mouseup', onMouseUp) }
  }, [])

  if (update?.must_update) return <UpdateScreen info={update} />
  if (!booted) return <Splash error={bootError} onRetry={boot} />
  if (welcome) return <Welcome mode={welcome} />

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view === 'home' && <Home />}
        {view === 'crate' && <CrateView />}
        {view === 'map' && <MapScreen />}
        {view === 'inbox' && <Inbox />}
        {view === 'tagger' && <Tagger />}
      </main>
      <div className="panel-slot">
        {panelId != null && <div className={`tpanel-anim${panelClosing ? ' closing' : ''}`}><TrackPanel id={panelId} /></div>}
      </div>
      <div className="player-slot"><Player /></div>
      <ExportDialog />
      <AgentsDialog />
      <UniverseEditor />
      <MixLab />
      <PromptModal />
      <TrackMenu />
      <EditTrackDialog />
      <Toasts />
      {dragging && <div className="drop-ov"><div><h2>Soltá para traer a Batea</h2><div className="muted">Temas sueltos o carpetas enteras. Lo que ya está en rekordbox no se duplica.</div></div></div>}
    </div>
  )
}
