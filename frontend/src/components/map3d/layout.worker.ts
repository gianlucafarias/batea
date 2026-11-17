// Acomoda la constelación en 3D (fuerzas tipo Obsidian) fuera del hilo de la pantalla.
// Entrada: rasgos de cada tema + conexiones. Salida: posiciones x,y,z, mandadas de a tandas.
import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from 'd3-force-3d'

export interface LayoutIn {
  feats: Float32Array      // por tema: bpm, número camelot (1-12, 0 = sin tono), letra (0 = A, 1 = B), energía
  links: Int32Array        // pares de índices
  weights: Float32Array    // fuerza de cada conexión (0..1)
  init: Float32Array       // posición inicial
  ticks: number
}

interface N { index: number; x: number; y: number; z: number }
interface L { source: number; target: number; w: number; sim: boolean }

function keyDist(n1: number, l1: number, n2: number, l2: number): number {
  if (!n1 || !n2) return 1.5
  const d = Math.abs(n1 - n2)
  return Math.min(d, 12 - d) + (l1 === l2 ? 0 : 1)
}

/** Para los temas con pocas conexiones: los 2 más parecidos por BPM, tono y energía (así no quedan sueltos). */
function similarityLinks(f: Float32Array, n: number, degree: Int32Array): L[] {
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => f[a * 4] - f[b * 4])
  const pos = new Int32Array(n)
  order.forEach((idx, k) => { pos[idx] = k })
  const out: L[] = []
  const W = 160
  for (let i = 0; i < n; i++) {
    if (degree[i] >= 3) continue
    const k = pos[i]
    let b1 = -1, d1 = 1e9, b2 = -1, d2 = 1e9
    for (let s = Math.max(0, k - W); s < Math.min(n, k + W); s++) {
      const j = order[s]
      if (j === i) continue
      const db = Math.abs(f[i * 4] - f[j * 4]) / 3
      if (db > 3) continue
      // preferir temas con historial: así los sueltos rodean al grupo que suena parecido en vez de quedar como polvo
      const d = db + keyDist(f[i * 4 + 1], f[i * 4 + 2], f[j * 4 + 1], f[j * 4 + 2]) * 0.9 + Math.abs(f[i * 4 + 3] - f[j * 4 + 3]) / 2.5 + (degree[j] ? 0 : 0.6)
      if (d < d1) { b2 = b1; d2 = d1; b1 = j; d1 = d } else if (d < d2) { b2 = j; d2 = d }
    }
    if (b1 >= 0) out.push({ source: i, target: b1, w: 0.5, sim: true })
    if (b2 >= 0) out.push({ source: i, target: b2, w: 0.35, sim: true })
  }
  return out
}

self.onmessage = (ev: MessageEvent<LayoutIn>) => {
  const { feats, links, weights, init, ticks } = ev.data
  const n = init.length / 3
  const nodes: N[] = Array.from({ length: n }, (_, i) => ({ index: i, x: init[i * 3], y: init[i * 3 + 1], z: init[i * 3 + 2] }))
  const degree = new Int32Array(n)
  const ls: L[] = []
  for (let k = 0; k < weights.length; k++) {
    const a = links[k * 2], b = links[k * 2 + 1]
    degree[a]++; degree[b]++
    ls.push({ source: a, target: b, w: weights[k], sim: false })
  }
  ls.push(...similarityLinks(feats, n, degree))

  const sim = forceSimulation(nodes, 3)
    .force('link', forceLink(ls).distance((l: L) => (l.sim ? 18 : 30)).strength((l: L) => l.w * (l.sim ? 0.55 : 0.4)))
    .force('charge', forceManyBody().strength(n > 6000 ? -34 : -48).theta(0.92).distanceMax(900))
    .force('center', forceCenter(0, 0, 0))
    .force('x', forceX(0).strength(0.012)).force('y', forceY(0).strength(0.012)).force('z', forceZ(0).strength(0.012))
    .alphaDecay(1 - Math.pow(0.002, 1 / ticks))
    .stop()

  const out = new Float32Array(n * 3)
  const send = (done: boolean, t: number) => {
    for (let i = 0; i < n; i++) { out[i * 3] = nodes[i].x; out[i * 3 + 1] = nodes[i].y; out[i * 3 + 2] = nodes[i].z }
    const copy = out.slice()
    ;(self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage({ pos: copy, progress: t / ticks, done }, [copy.buffer])
  }
  const every = n > 6000 ? 12 : 6
  for (let t = 1; t <= ticks; t++) {
    sim.tick()
    if (t % every === 0 && t < ticks) send(false, t)
  }
  send(true, ticks)
}
