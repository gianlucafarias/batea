import { useEffect, useState } from 'react'
import { api, type CuesImport, type CuesStatus } from '../api'
import { useApp } from '../store'

const fmt = (n: number) => n.toLocaleString('es-AR')

/**
 * Ajustes → Programas: traer la grilla y las cues exactas de rekordbox desde el XML que exporta el propio rekordbox.
 * Con eso Batea puede llevar los temas de rekordbox en su XML sin perder nada de lo que ya tienen.
 */
export function CuesSection() {
  const toast = useApp((s) => s.toast)
  const [st, setSt] = useState<CuesStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CuesImport | null>(null)
  useEffect(() => { api.cuesStatus().then(setSt).catch(() => setSt(null)) }, [])

  const pick = async () => {
    setBusy(true)
    try {
      const picker = window.pywebview?.api
      const path = picker?.pick_file ? await picker.pick_file() : await useApp.getState().askText('Ruta del XML que exportó rekordbox')
      if (!path) return
      const r = await api.importCuesXml(path)
      setResult(r)
      setSt(await api.cuesStatus())
      toast(`Traídas las cues y la grilla de ${fmt(r.tracks)} temas`)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }

  const xml = st?.xml
  const unexpected = result ? Object.keys(result.mapping.unexpected) : []
  return (
    <div className="source-row cues-section">
      <div className="source-line">
        <div className="source-info">
          <b>Cues y grilla de rekordbox</b>
          <span className="muted">
            {xml ? `Traídas de ${xml.product ?? 'rekordbox'}: ${fmt(xml.tracks)} temas, ${fmt(xml.cues)} cues y la grilla.` : 'Todavía no las trajiste.'}
          </span>
        </div>
        <button className="btn sm" disabled={busy} onClick={() => void pick()}>{busy ? 'Leyendo…' : xml ? 'Traer de nuevo…' : 'Elegir el XML…'}</button>
      </div>
      {!xml && (
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Sirve para llevar tus temas de rekordbox en el XML sin perder sus cues ni su grilla. En rekordbox: <b>File → Export Collection in xml format</b>,
          y elegí ese archivo acá. Batea solo lo lee: no lo cambia ni toca rekordbox.
        </div>
      )}
      {result && result.mapping.compared > 0 && (
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: result.mapping.ok ? 'var(--ok)' : 'var(--accent)' }}>
          {result.mapping.ok
            ? `Comprobé ${fmt(result.mapping.compared)} cues contra tu base de rekordbox: coinciden, pad por pad.`
            : `Hay diferencias en cómo tu rekordbox numera los pads (${unexpected.join(', ')}). Se usan las cues del XML tal cual.`}
        </div>
      )}
      {result && result.not_found > 0 && (
        <div className="muted" style={{ fontSize: 12.5 }}>{fmt(result.not_found)} temas del XML no están en Batea (sincronizá rekordbox y volvé a traerlo).</div>
      )}
    </div>
  )
}
