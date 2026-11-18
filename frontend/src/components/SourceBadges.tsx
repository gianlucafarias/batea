import iconRekordbox from '../assets/logos/icon-rekordbox.png'
import iconSerato from '../assets/logos/icon-serato.png'
import iconTraktor from '../assets/logos/icon-traktor.png'
import { sourceLabel, sourceShort } from '../sources'

const ICONS: Record<string, string> = { rekordbox: iconRekordbox, traktor: iconTraktor, serato: iconSerato }

/** Íconos de los programas donde está el tema (rekordbox, Traktor, Serato); texto corto para el resto. */
export function SourceBadges({ sources }: { sources?: string[] }) {
  if (!sources?.length) return null
  return (
    <span className="source-badges">
      {sources.map((kind) => ICONS[kind]
        ? <span key={kind} className="source-icon" style={{ ['--icon' as string]: `url(${ICONS[kind]})` }} title={sourceLabel(kind)} role="img" aria-label={sourceLabel(kind)} />
        : <span key={kind} className="chip mono" title={sourceLabel(kind)} aria-label={sourceLabel(kind)}>{sourceShort(kind)}</span>)}
    </span>
  )
}
