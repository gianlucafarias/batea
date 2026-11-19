import { useEffect, useRef, useState } from 'react'
import { api, type CueDto } from '../api'
import { audioClock, useApp, usePlayer } from '../store'
import { cueColor, cueLabel, rgba } from '../lib/cues'
import type { Track, Waveform as WF } from '../types'

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
  cues?: CueDto[]             // marcas: hot cues, memory cues y loops
}

/** Las cues de un tema (de rekordbox o editadas en Batea); se vuelven a pedir cuando se guardan cambios. */
export function useCues(id: number | null | undefined): CueDto[] {
  const version = useApp((s) => s.cueVersion)
  const [cues, setCues] = useState<CueDto[]>([])
  useEffect(() => {
    if (id == null) { setCues([]); return }
    let alive = true
    api.cues(id).then((c) => { if (alive) setCues(c.cues) }).catch(() => { if (alive) setCues([]) })
    return () => { alive = false }
  }, [id, version])
  return cues
}

/** Waveform de 3 bandas: graves en naranja, medios en papel, agudos en celeste. Marca frases de 16 compases. */
export function Waveform({ data, progress = 0, onSeek, introBars, outroBars, mirrored = true, cues }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = cv.clientWidth, h = cv.clientHeight
      if (!w || !h) return
      // reasignar el tamaño borra y reserva el canvas de nuevo: solo cuando cambió de verdad
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
      const ctx = cv.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
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
      if (cues?.length && data.duration) {
        const labels = h >= 56 && w >= 280                      // en la barra del reproductor (chica) van solo las líneas
        ctx.font = '700 10px ui-monospace, Menlo, monospace'
        for (const q of cues) {
          const c = cueColor(q)
          const x = (q.start_ms / 1000 / data.duration) * w
          if (x < 0 || x > w) continue
          if (q.end_ms != null) {
            ctx.fillStyle = rgba(c, 0.22)
            ctx.fillRect(x, 0, Math.max(2, (q.end_ms / 1000 / data.duration) * w - x), h)
          }
          ctx.fillStyle = rgba(c, 0.95)
          ctx.fillRect(Math.round(x), 0, 2, h)
          if (labels) {
            const text = cueLabel(q)
            const tw = ctx.measureText(text).width + 6
            ctx.fillRect(Math.min(Math.round(x), w - tw), 0, tw, 12)
            ctx.fillStyle = '#0e0d0c'
            ctx.fillText(text, Math.min(Math.round(x), w - tw) + 3, 9.5)
          } else {
            ctx.beginPath(); ctx.moveTo(x - 3, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x + 1, 5); ctx.closePath(); ctx.fill()
          }
        }
      }
      if (progress > 0) {
        // sin redondear: en pantallas retina el cabezal avanza de a medio píxel, no de a uno
        ctx.fillStyle = '#fff'
        ctx.fillRect(Math.min(px, w - 1.5), 0, 1.5, h)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [data, progress, introBars, outroBars, mirrored, cues])

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

/**
 * Waveform de un tema con cabezal de reproducción. El cabezal sale del reloj real del audio, cuadro a cuadro,
 * y la posición se mide contra la duración de la propia waveform (la exacta), no contra la que estima el reproductor.
 * Un click salta ahí mismo: si el tema no es el que suena, lo arranca desde ese punto.
 */
export function LiveWaveform({ track, data, introBars, outroBars, mirrored }: {
  track: Track | null
  data: WF | null
  introBars?: number | null
  outroBars?: number | null
  mirrored?: boolean
}) {
  const current = usePlayer((s) => s.track)
  const playing = usePlayer((s) => s.playing)
  const stored = usePlayer((s) => s.time)
  const reported = usePlayer((s) => s.duration)
  const isCur = !!track && current?.id === track.id
  const cues = useCues(track?.id)
  const total = data?.duration || reported || track?.duration || 0
  const [t, setT] = useState(0)

  useEffect(() => {
    if (!isCur) return
    setT(audioClock())
    if (!playing) return
    let raf = 0
    const tick = () => { setT(audioClock()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isCur, playing, stored])

  const progress = isCur && total ? Math.min(1, Math.max(0, t / total)) : 0
  return (
    <Waveform data={data} progress={progress} introBars={introBars} outroBars={outroBars} mirrored={mirrored} cues={cues}
      onSeek={(f) => {
        if (!track || !total) return
        const player = usePlayer.getState()
        if (isCur) player.seek(f * total)
        else if (track.online) player.playFrom(track, f * total)
      }} />
  )
}
