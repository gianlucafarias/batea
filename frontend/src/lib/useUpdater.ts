import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type UpdateState } from '../api'
import { useApp } from '../store'

const IDLE: UpdateState = { state: 'idle', progress: 0, message: '', version: null, error: null, manual: false }
const ACTIVE = new Set(['downloading', 'verifying', 'staging'])

/**
 * La actualización interna: baja la versión nueva, la comprueba y la deja lista; «reiniciar» la instala.
 * Mientras trabaja, pregunta el avance cada tanto.
 */
export function useUpdater() {
  const update = useApp((s) => s.update)
  const [st, setSt] = useState<UpdateState>(IDLE)
  const [restarting, setRestarting] = useState(false)
  const timer = useRef(0)

  const refresh = useCallback(async () => {
    try { setSt(await api.updateState()) } catch { /* el motor puede estar reiniciándose */ }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    window.clearInterval(timer.current)
    if (ACTIVE.has(st.state)) timer.current = window.setInterval(() => void refresh(), 600)
    return () => window.clearInterval(timer.current)
  }, [st.state, refresh])

  const install = useCallback(async () => {
    try { setSt(await api.updateInstall()) } catch (e) { setSt({ ...IDLE, state: 'error', error: (e as Error).message, manual: true }) }
  }, [])
  const restart = useCallback(async () => {
    setRestarting(true)
    try { await api.updateRestart() } catch (e) { setRestarting(false); setSt({ ...IDLE, state: 'error', error: (e as Error).message, manual: true }) }
  }, [])
  const manual = useCallback(() => { void api.openUpdate().catch(() => undefined) }, [])

  return { update, st, install, restart, manual, restarting, busy: ACTIVE.has(st.state) }
}
