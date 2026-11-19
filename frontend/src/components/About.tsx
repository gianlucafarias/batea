import { useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { useUpdater } from '../lib/useUpdater'
import { BrandMark } from './icons'

const CHIP: Record<string, string> = { arm64: 'Apple Silicon', x86_64: 'Intel' }

function when(seconds: number | null | undefined): string | null {
  if (!seconds) return null
  return new Date(seconds * 1000).toLocaleString('es-AR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}

/** Pestaña de Ajustes: qué versión está corriendo y si hay otra más nueva. */
export function AboutPanel() {
  const { status, update, setWelcome, setSettings } = useApp()
  const up = useUpdater()
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [checked, setChecked] = useState(false)
  const build = status?.version

  // al abrir la pestaña se muestra lo último que se supo; no sale a internet hasta que se lo pidas
  useEffect(() => {
    if (!update) void api.update().then((u) => useApp.setState({ update: u })).catch(() => undefined)
  }, [update])

  const check = async () => {
    setBusy(true); setOffline(false)
    try {
      const u = await api.update(true)
      useApp.setState({ update: u })
      setChecked(true)
      setOffline(u.online === false)
    } catch { setOffline(true) }
    setBusy(false)
  }

  const last = when(update?.checked_at)
  const dev = build?.fingerprint === 'dev'

  return (
    <div className="settings-about">
      <div className="about-id">
        <div className="about-mark"><BrandMark /></div>
        <div>
          <div className="about-name">batea</div>
          <div className="muted num" style={{ fontSize: 13 }}>
            Versión {build?.version ?? '…'}{dev ? ' · de desarrollo' : ''}
          </div>
        </div>
      </div>

      <dl className="about-facts">
        {build && <div><dt>Compatible con</dt><dd>{CHIP[build.arch] ?? build.arch}</dd></div>}
        {build?.built_at && <div><dt>Compilada</dt><dd>{new Date(build.built_at).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })}</dd></div>}
      </dl>

      <div className="about-update">
        <div className="about-update-head">
          <b>Presentación</b>
          <button className="btn sm" onClick={() => { setSettings(null); setWelcome('replay') }}>Ver la presentación</button>
        </div>
        <p className="about-line muted">El recorrido de bienvenida por Batea, por si querés repasarlo.</p>
      </div>

      <div className="about-update">
        <div className="about-update-head">
          <b>Actualizaciones</b>
          <button className="btn sm" disabled={busy} onClick={() => void check()}>{busy ? 'Comprobando…' : 'Comprobar actualizaciones'}</button>
        </div>
        {update?.update_available ? (
          <>
            <p className="about-line">Hay una versión nueva: <b className="num">{update.latest}</b>. Tenés la {update.current}.</p>
            {update.notes && <p className="muted" style={{ margin: 0, whiteSpace: 'pre-line', fontSize: 12.5, lineHeight: 1.5 }}>{update.notes}</p>}
            <div className="about-install">
              {up.st.state === 'idle' && (update.can_install
                ? <button className="btn primary sm" onClick={() => void up.install()}>Actualizar ahora</button>
                : <button className="btn primary sm" onClick={up.manual}>Descargar la {update.latest}</button>)}
              {up.st.state === 'downloading' && <><div className="uc-bar" style={{ flex: 1 }}><i style={{ width: `${Math.round(up.st.progress * 100)}%` }} /></div><span className="muted num">{Math.round(up.st.progress * 100)} %</span></>}
              {(up.st.state === 'verifying' || up.st.state === 'staging') && <><div className="uc-bar indeterminate" style={{ flex: 1 }}><i /></div><span className="muted">Instalando…</span></>}
              {up.st.state === 'ready' && <><span className="about-line" style={{ flex: 1 }}><b>Actualización lista.</b> Reiniciá para instalarla.</span><button className="btn primary sm" disabled={up.restarting} onClick={() => void up.restart()}>{up.restarting ? 'Reiniciando…' : 'Reiniciar ahora'}</button></>}
              {up.st.state === 'error' && <><span className="about-line" style={{ flex: 1, color: 'var(--accent)' }}>{up.st.error}</span><button className="btn primary sm" onClick={up.manual}>Descargar a mano</button></>}
            </div>
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>Tu librería y tus datos no se tocan al actualizar.</p>
          </>
        ) : offline ? (
          <p className="about-line">No pude conectarme para comprobarlo. Probá de nuevo con internet.</p>
        ) : update?.latest ? (
          <p className="about-line">{checked || last ? 'Estás al día: tenés la última versión.' : 'Todavía no se comprobó.'}</p>
        ) : (
          <p className="about-line muted">{update ? 'Todavía no se comprobó.' : 'Cargando…'}</p>
        )}
        {last && !busy && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Última comprobación: {last}</p>}
        {dev && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Esta copia corre desde el código fuente: nunca se bloquea por una versión vieja.</p>}
      </div>
    </div>
  )
}
