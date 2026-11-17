import { lazy, Suspense, useState } from 'react'
import { useApp } from '../store'
import { CamelotWheel } from './CamelotWheel'
import type { MapMode } from './MapModes'

// el 3D (three.js) pesa: se carga recién cuando se usa
const MapView = lazy(() => import('./MapView').then((m) => ({ default: m.MapView })))

const KEY = 'batea.mapMode'
function savedMode(): MapMode {
  try {
    const m = localStorage.getItem(KEY)
    if (m === 'wheel') return m
  } catch { /* sin almacenamiento */ }
  return 'graph'
}

export function MapScreen() {
  const crateId = useApp((s) => s.crateId)
  const [scope, setScope] = useState<string>(crateId && crateId !== 'inbox' ? crateId : 'all')
  const [mode, setModeState] = useState<MapMode>(savedMode)
  const setMode = (m: MapMode) => {
    setModeState(m)
    try { localStorage.setItem(KEY, m) } catch { /* sin almacenamiento */ }
  }
  if (mode === 'wheel') return <CamelotWheel scope={scope} setScope={setScope} onMode={setMode} />
  return (
    <Suspense fallback={<div className="empty">Cargando el mapa…</div>}>
      <MapView scope={scope} setScope={setScope} onMode={setMode} />
    </Suspense>
  )
}
