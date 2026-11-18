import { useEffect } from 'react'
import { spring, usePresence } from '../lib/motion'
import { useApp, type SettingsTab } from '../store'
import { AgentsPanel } from './Agents'
import { SourcesPanel } from './Sources'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'programs', label: 'Programas' },
  { id: 'agents', label: 'Agentes de IA' },
]

/** Popup de Ajustes: los programas de DJ que lee Batea y la conexión con agentes de IA. */
export function SettingsDialog() {
  const { settings, setSettings, refreshSources } = useApp()
  const [tab, closing] = usePresence(settings, spring.slow.exit)

  useEffect(() => {
    if (settings === 'programs') void refreshSources().catch(() => undefined)
  }, [settings, refreshSources])

  useEffect(() => {
    if (!settings) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettings(null) }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [settings, setSettings])

  if (!tab) return null
  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && setSettings(null)}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-t">
        <div className="settings-head">
          <h2 id="settings-t">Ajustes</h2>
          <div className="settings-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setSettings(t.id)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="settings-body" role="tabpanel">
          {tab === 'programs' ? <SourcesPanel /> : <AgentsPanel />}
        </div>
        <div className="settings-foot">
          <button className="btn primary sm" onClick={() => setSettings(null)}>Listo</button>
        </div>
      </div>
    </div>
  )
}
