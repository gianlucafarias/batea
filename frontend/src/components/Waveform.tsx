import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { Waveform as WF } from '../types'

// Solo se guardan las waveforms que existen: un tema sin analizar no tiene, pero puede tenerla
// unos segundos después, así que "no hay" nunca se recuerda.
const cache = new Map<number, WF>()

/** Igual que useWaveform pero fuera de React (comparte la caché). */
export async function loadWaveform(id: number): Promise<WF | null> {
  const hit = cache.get(id)
  if (hit) return hit
  try {
    const w = await api.waveform(id)
    cache.set(id, w)
    return w
  } catch {
    return null
  }
}

export function useWaveform(id: number | null | undefined): WF | null {
  const [data, setData] = useState<WF | null>(id != null ? cache.get(id) ?? null : null)
  // cuando este tema termina de analizarse, volver a pedirla
  const patch = useApp((s) => s.lastPatch)
  const analyzedNow = patch && patch.id === id && 'unanalyzed' in patch ? patch : null
  useEffect(() => {
    if (id == null) { setData(null); return }
    if (analyzedNow) cache.delete(id)
    const hit = cache.get(id)
    if (hit) { setData(hit); return }
    let alive = true
    setData(null)
    loadWaveform(id).then((w) => { if (alive) setData(w) })
    return () => { alive = false }
  }, [id, analyzedNow])
  return data
}

interface Props {
  data: WF | null
  progress?: number           // 0..1
  onSeek?: (fraction: number) => void
  introBars?: number | null
  outroBars?: number | null
  mirrored?: boolean
}

/** Waveform de 3 bandas: graves en naranja, medios en papel, agudos en celeste. Marca frases de 16 compases. */
export function Waveform({ data, progress = 0, onSeek, introBars, outroBars, mirrored = true }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = cv.clientWidth, h = cv.clientHeight
      if (!w || !h) return
      cv.width = w * dpr; cv.height = h * dpr
      const ctx = cv.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      if (!data) {
        ctx.fillStyle = '#2b2724'
        for (let x = 0; x < w; x += 3) ctx.fillRect(x, h / 2 - 0.5, 2, 1)
        return
      }
      const n = data.h.length
      const db = data.downbeats
      // intro / outro sombreados
      if (db && db.length > 8 && data.duration) {
        const tx = (t: number) => (t / data.duration) * w
        if (introBars && introBars > 0 && db[introBars]) {
          ctx.fillStyle = 'rgba(125, 211, 252, 0.07)'
          ctx.fillRect(0, 0, tx(db[introBars]), h)
        }
        if (outroBars && outroBars > 0 && db[db.length - outroBars]) {
          ctx.fillStyle = 'rgba(165, 180, 252, 0.07)'
          const x0 = tx(db[db.length - outroBars])
          ctx.fillRect(x0, 0, w - x0, h)
        }
        ctx.fillStyle = 'rgba(236, 230, 220, 0.09)'
        for (let i = 0; i < db.length; i += 16) ctx.fillRect(Math.round(tx(db[i])), 0, 1, h)
      }
      const colW = w / n
      const mid = mirrored ? h / 2 : h
      const px = progress * w
      for (let i = 0; i < n; i++) {
        const amp = (data.h[i] / 255) * (mirrored ? h / 2 - 1 : h - 1)
        const lo = data.low[i] / 255, mi = (data.mid[i] / 255) * 1.35, hi = (data.high[i] / 255) * 1.9
        const s = lo + mi + hi + 1e-6
        const r = (255 * lo + 233 * mi + 125 * hi) / s
        const g = (90 * lo + 223 * mi + 211 * hi) / s
        const b = (31 * lo + 198 * mi + 252 * hi) / s
        const x = i * colW
        const played = x < px
        ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${played ? 1 : progress > 0 ? 0.5 : 0.85})`
        const cw = Math.max(1, colW - (colW > 2 ? 0.6 : 0))
        if (mirrored) ctx.fillRect(x, mid - amp, cw, amp * 2 || 1)
        else ctx.fillRect(x, h - amp, cw, amp || 1)
      }
      if (progress > 0) {
        ctx.fillStyle = '#fff'
        ctx.fillRect(Math.round(px), 0, 1.5, h)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [data, progress, introBars, outroBars, mirrored])

  return (
    <canvas
      ref={ref}
      onClick={(e) => {
        if (!onSeek) return
        const r = e.currentTarget.getBoundingClientRect()
        onSeek((e.clientX - r.left) / r.width)
      }}
    />
  )
}
