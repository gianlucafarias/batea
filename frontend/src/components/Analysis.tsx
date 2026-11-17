import { useApp } from '../store'
import type { Track } from '../types'

export type AState = 'now' | 'queued' | 'pending' | 'error' | 'rb' | null

/** En qué está el análisis de un tema: analizándose, en espera, sin analizar, con error o hecho (null). */
export function useAnalysisState(t: Pick<Track, 'id' | 'unanalyzed'> | null | undefined): AState {
  const q = useApp((s) => s.analysisQueue)
  if (!t) return null
  if (q.now === t.id) return 'now'
  if (q.ids.includes(t.id)) return 'queued'
  return t.unanalyzed ?? null
}

const LABEL: Record<Exclude<AState, null>, string> = {
  now: 'analizando…', queued: 'en espera', pending: 'sin analizar', error: 'no se pudo analizar', rb: 'sin analizar en rekordbox',
}
const HINT: Record<Exclude<AState, null>, string> = {
  now: 'Calculando BPM, tono, energía, intro y outro',
  queued: 'Se analiza cuando termine el que está en curso',
  pending: 'Sin BPM, tono ni energía',
  error: 'No se pudo leer el archivo',
  rb: 'Analizalo en rekordbox y sincronizá',
}

export function AnalysisBadge({ t }: { t: Pick<Track, 'id' | 'unanalyzed'> }) {
  const st = useAnalysisState(t)
  // sin analizar se ve en gris (clase "unan" en la fila); la marca solo aparece mientras se analiza
  if (st !== 'now' && st !== 'queued') return null
  return <span className={`abadge ${st}`} title={HINT[st]}>{LABEL[st]}</span>
}

/** Aviso en la ficha del tema, con el botón para analizarlo. */
export function AnalysisNotice({ t, online }: { t: Pick<Track, 'id' | 'unanalyzed'>; online: boolean }) {
  const st = useAnalysisState(t)
  const analyze = useApp((s) => s.analyzeTracks)
  if (!st) return null   // analizado: no se muestra nada
  const text = {
    now: ['Analizando…', ''],
    queued: ['En espera', ''],
    pending: ['Sin analizar', ''],
    error: ['No se pudo analizar', 'Puede que el archivo esté dañado.'],
    rb: ['Sin analizar en rekordbox', 'Analizalo ahí y sincronizá.'],
  }[st]
  return (
    <div className={`anotice ${st}`}>
      <span><b>{text[0]}</b>{text[1] && <><br /><span className="muted" style={{ fontSize: 11.5 }}>{text[1]}</span></>}</span>
      {(st === 'pending' || st === 'error') && (
        <button className="btn sm primary" disabled={!online} title={online ? undefined : 'El archivo no está disponible'}
          onClick={() => analyze([t.id])}>
          {st === 'error' ? 'Reintentar' : 'Analizar'}
        </button>
      )}
    </div>
  )
}
