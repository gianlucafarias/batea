import { sourceLabel, sourceShort } from '../sources'

export function SourceBadges({ sources }: { sources?: string[] }) {
  if (!sources?.length) return null
  return (
    <span className="source-badges">
      {sources.map((kind) => <span key={kind} className="chip mono" title={sourceLabel(kind)} aria-label={sourceLabel(kind)}>{sourceShort(kind)}</span>)}
    </span>
  )
}
