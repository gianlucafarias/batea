import { useState } from 'react'
import { api, type UpdateInfo } from '../api'
import { useUpdater } from '../lib/useUpdater'
import { BrandMark } from './icons'

/** Pantalla que reemplaza a la app cuando esta versión quedó por debajo de la mínima publicada en GitHub. */
export function UpdateScreen({ info }: { info: UpdateInfo }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const up = useUpdater()

  const recheck = async () => {
    setBusy(true); setMsg(null)
    try {
      const u = await api.update(true)
      if (!u.must_update) { window.location.reload(); return }
      setMsg(u.online === false ? 'No pude conectarme para comprobarlo.' : 'Todavía es la versión vieja. Instalá la nueva y abrila de nuevo.')
    } catch { setMsg('No pude conectarme para comprobarlo.') }
    setBusy(false)
  }

  return (
    <div className="splash" role="alert">
      <div className="splash-in" style={{ maxWidth: 440 }}>
        <div className="splash-mark"><BrandMark /></div>
        <div className="splash-name">batea</div>
        <p className="splash-msg">Hay que actualizar Batea para seguir.</p>
        <p className="splash-sub">
          Tenés la versión {info.current} y la mínima ahora es la {info.min_version}.
          {info.latest && info.latest !== info.min_version ? ` La última es la ${info.latest}.` : ''} Tu librería y tus datos no se tocan.
        </p>
        {info.notes && <p className="splash-sub" style={{ whiteSpace: 'pre-line' }}>{info.notes}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          {up.st.state === 'ready'
            ? <button className="btn primary" disabled={up.restarting} onClick={() => void up.restart()}>{up.restarting ? 'Reiniciando…' : 'Reiniciar ahora'}</button>
            : up.busy
              ? <button className="btn primary" disabled>{up.st.state === 'downloading' ? `Descargando… ${Math.round(up.st.progress * 100)} %` : 'Instalando…'}</button>
              : info.can_install && up.st.state !== 'error'
                ? <button className="btn primary" onClick={() => void up.install()}>Actualizar ahora</button>
                : <button className="btn primary" onClick={() => { void api.openUpdate().catch(() => setMsg('No pude abrir la descarga.')) }}>
                  Descargar la versión {info.latest ?? info.min_version}
                </button>}
          <button className="btn ghost" disabled={busy} onClick={recheck}>Ya la instalé</button>
        </div>
        {up.st.state === 'error' && <p className="splash-sub" style={{ marginTop: 12 }}>{up.st.error}</p>}
        {msg && <p className="splash-sub" style={{ marginTop: 12 }}>{msg}</p>}
      </div>
    </div>
  )
}
