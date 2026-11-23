import { NOTATIONS, useKeyNotation } from '../lib/keyNotation'

/** Pestaña de Ajustes con lo que cambia cómo se ve Batea. */
export function PrefsPanel() {
  const { notation, setNotation } = useKeyNotation()
  return (
    <div className="prefs">
      <section className="prefs-sec">
        <h3>Cómo mostrar la tonalidad</h3>
        <p className="muted">Es el mismo tono escrito de tres maneras. Elegí la del programa que usás, así coincide con lo que ves en la cabina.</p>
        <div className="prefs-opts" role="radiogroup" aria-label="Notación de tonalidad">
          {NOTATIONS.map((n) => (
            <button key={n.id} role="radio" aria-checked={notation === n.id} className={`prefs-opt${notation === n.id ? ' on' : ''}`} onClick={() => setNotation(n.id)}>
              <span className="prefs-ex mono">{n.example}</span>
              <span className="prefs-name">{n.label}</span>
              <span className="prefs-hint muted">{n.hint}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
