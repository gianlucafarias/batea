import { useState } from 'react'
import { useUpdater } from '../lib/useUpdater'
import { IconX } from './icons'

const DISMISS_KEY = 'batea.update.dismissed'
const dismissed = (v: string) => { try { return sessionStorage.getItem(DISMISS_KEY) === v } catch { return false } }

/** Cuadro arriba a la derecha cuando hay una versión nueva: se baja, se comprueba y se instala sin salir de Batea. */
export function UpdateCard() {
  const { update, st, install, restart, manual, restarting, busy } = useUpdater()
  const [hidden, setHidden] = useState(false)
  const [notes, setNotes] = useState(false)
  const ready = st.state === 'ready'
  const latest = st.version ?? update?.latest
  if (!update || update.must_update) return null
  if (!ready && !busy && st.state !== 'error' && !update.update_available) return null
  if (hidden || (!busy && !ready && st.state === 'idle' && update.latest && dismissed(update.latest))) return null

  const later = () => {
    if (update.latest) { try { sessionStorage.setItem(DISMISS_KEY, update.latest) } catch { /* sin storage */ } }
    setHidden(true)
  }
  const pct = Math.round(st.progress * 100)
  return (
    <div className={`update-card${ready ? ' ready' : st.state === 'error' ? ' error' : ''}`} role="status" aria-live="polite">
      <div className="uc-body">
        {st.state === 'idle' && (
          <>
            <b>Hay una versión nueva</b>
            <span className="muted">Batea {update.latest} está disponible. Tenés la {update.current}.</span>
            {update.notes && (
              <>
                <button className="uc-link" onClick={() => setNotes(!notes)} aria-expanded={notes}>{notes ? 'Ocultar novedades' : 'Qué trae'}</button>
                {notes && <div className="uc-notes">{update.notes}</div>}
              </>
            )}
          </>
        )}
        {st.state === 'downloading' && (
          <>
            <b>Descargando Batea {latest}…</b>
            <div className="uc-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
            <span className="muted num">{pct} %</span>
          </>
        )}
        {(st.state === 'verifying' || st.state === 'staging') && (
          <>
            <b>Instalando Batea {latest}…</b>
            <div className="uc-bar indeterminate"><i /></div>
            <span className="muted">{st.message}</span>
          </>
        )}
        {ready && (
          <>
            <b>Actualización lista</b>
            <span className="muted">Reiniciá Batea para terminar de instalar la {latest}. Tu librería y tus datos no se tocan.</span>
          </>
        )}
        {st.state === 'error' && (
          <>
            <b>No se pudo actualizar</b>
            <span className="muted">{st.error ?? 'Probá de nuevo o bajala a mano.'}</span>
          </>
        )}
      </div>
      <div className="uc-actions">
        {st.state === 'idle' && (update.can_install
          ? <button className="btn primary sm" onClick={() => void install()}>Actualizar</button>
          : <button className="btn primary sm" onClick={manual}>Descargar</button>)}
        {ready && <button className="btn primary sm" disabled={restarting} onClick={() => void restart()}>{restarting ? 'Reiniciando…' : 'Reiniciar ahora'}</button>}
        {st.state === 'error' && (
          <>
            {update.can_install && <button className="btn sm" onClick={() => void install()}>Reintentar</button>}
            <button className="btn primary sm" onClick={manual}>Descargar a mano</button>
          </>
        )}
        {!busy && !restarting && <button className="btn ghost sm icon" aria-label="Más tarde" title="Más tarde" onClick={later}><IconX size={14} /></button>}
      </div>
    </div>
  )
}
