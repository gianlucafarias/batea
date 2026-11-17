import { useEffect, useState } from 'react'
import { spring, usePresence } from '../lib/motion'
import { api, type AgentInfo, type AgentList } from '../api'
import { useApp } from '../store'

const STATUS: Record<AgentInfo['status'], { text: string; color: string }> = {
  on: { text: 'Conectado', color: 'var(--ok)' },
  off: { text: 'Sin conectar', color: 'var(--muted)' },
  stale: { text: 'Apunta a otra carpeta de Batea', color: 'var(--accent)' },
  missing: { text: 'No instalado', color: 'var(--faint)' },
}

/** Conectar el MCP de Batea con Claude Code, Codex, Cursor… sin tocar la terminal. */
export function AgentsDialog() {
  const { agentsOpen, setAgentsOpen, toast } = useApp()
  const [list, setList] = useState<AgentList | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [showManual, setShowManual] = useState(false)

  const [shown, closing] = usePresence(agentsOpen, spring.slow.exit)
  useEffect(() => {
    if (!agentsOpen) return
    setTest(null); setShowManual(false)
    api.agents().then(setList).catch((e) => toast((e as Error).message, 'error'))
  }, [agentsOpen, toast])

  if (!shown) return null

  const change = async (a: AgentInfo, connected: boolean) => {
    setBusy(a.id)
    try {
      setList(await api.setAgent(a.id, connected))
      toast(connected ? `Conectada a ${a.name}. Abrí una conversación nueva.` : `Desconectada de ${a.name}`)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }

  const installed = list?.agents.filter((a) => a.installed) ?? []
  const missing = list?.agents.filter((a) => !a.installed) ?? []
  const manual = list ? JSON.stringify(list.manual, null, 2) : ''

  return (
    <div className={`modal-bg${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && setAgentsOpen(false)}>
      <div className="modal">
        <div>
          <h2>Conectar con agentes de IA</h2>
          <p className="muted" style={{ margin: '6px 0 0', lineHeight: 1.5 }}>
            Tu agente puede leer la librería para responder preguntas o armar sets. Solo puede crear cajas y nunca toca rekordbox.
          </p>
        </div>

        {!list ? <div className="muted">Buscando agentes instalados…</div> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {installed.map((a) => {
              const st = STATUS[a.status]
              return (
                <div key={a.id} className="card" style={{ padding: '12px 14px', gap: 6, background: 'var(--bg-2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <b style={{ flex: 1 }}>{a.name}</b>
                    <span style={{ fontSize: 12, color: st.color, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <i style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, display: 'inline-block' }} />{st.text}
                    </span>
                    {a.status === 'on'
                      ? <button className="btn sm ghost" disabled={busy === a.id} onClick={() => change(a, false)}>{busy === a.id ? '…' : 'Desconectar'}</button>
                      : <button className="btn sm primary" disabled={busy === a.id || !list.ready} onClick={() => change(a, true)}>
                          {busy === a.id ? 'Conectando…' : a.status === 'stale' ? 'Actualizar' : 'Conectar'}
                        </button>}
                  </div>
                  <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
                    {a.note && <>{a.note} </>}Se guarda en <span className="mono">{a.file}</span>.
                  </div>
                </div>
              )
            })}
            {missing.length > 0 && (
              <div className="faint" style={{ fontSize: 12 }}>No encontré instalados: {missing.map((a) => a.name).join(', ')}.</div>
            )}
            <div className="faint" style={{ fontSize: 12, lineHeight: 1.45 }}>
              ChatGPT todavía no se puede conectar a programas de tu Mac.
            </div>
          </div>
        )}

        {test && <div style={{ fontSize: 13, color: test.ok ? 'var(--ok)' : 'var(--danger)' }}>{test.message}</div>}
        {showManual && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="muted" style={{ fontSize: 12.5 }}>Para otro agente con MCP, pegá esto en su configuración:</div>
            <pre className="mono" style={{ margin: 0, fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{manual}</pre>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost sm" disabled={busy === 'test'} onClick={async () => {
            setBusy('test')
            try { setTest(await api.testAgents()) } catch (e) { setTest({ ok: false, message: (e as Error).message }) } finally { setBusy(null) }
          }}>{busy === 'test' ? 'Probando…' : 'Probar el servidor'}</button>
          <button className="btn ghost sm" onClick={() => setShowManual(!showManual)}>{showManual ? 'Ocultar' : 'Otro agente…'}</button>
          {showManual && <button className="btn ghost sm" onClick={() => { void navigator.clipboard?.writeText(manual).then(() => toast('Copiado')) }}>Copiar</button>}
          <span style={{ flex: 1 }} />
          <button className="btn primary sm" onClick={() => setAgentsOpen(false)}>Listo</button>
        </div>
      </div>
    </div>
  )
}
