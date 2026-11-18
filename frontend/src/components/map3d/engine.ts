import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// Estrellas: un punto redondo con brillo suave; más chicas y apagadas cuanto más lejos.
const POINT_VS = /* glsl */ `
attribute float asize;
attribute float aalpha;
attribute vec3 acolor;
uniform float uScale;
uniform float uSize;
uniform float uDot;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = acolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float far = clamp((-mv.z - 250.0) / 2200.0, 0.0, 0.7);
  vAlpha = aalpha * (1.0 - far);
  gl_PointSize = clamp(asize * uSize * uScale * uDot / -mv.z, 2.5 * uDot, 80.0 * uDot);
  gl_Position = projectionMatrix * mv;
}`
const POINT_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.6, 0.46, d);
  float glow = pow(1.0 - d, 2.2) * 0.5;
  float a = (core + glow * (1.0 - core)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(vColor * 1.1, vec3(1.0), core * 0.12), a);
}`
// Anillos (seleccionado, sugeridos)
const RING_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(0.66, 0.76, d) * smoothstep(1.0, 0.88, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`

export interface Highlight { a: number; b: number; rgb: [number, number, number] }
export interface Halo { i: number; rgb: [number, number, number]; size: number }

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  n = 0
  pos = new Float32Array(0)
  private pGeo = new THREE.BufferGeometry()
  private pMat: THREE.ShaderMaterial
  private points: THREE.Points
  private lGeo = new THREE.BufferGeometry()
  private lines: THREE.LineSegments
  private edges = new Int32Array(0)
  private hGeo = new THREE.BufferGeometry()
  private hiLines: THREE.LineSegments
  private rGeo = new THREE.BufferGeometry()
  private rings: THREE.Points
  private highlights: Highlight[] = []
  private halos: Halo[] = []
  private extra: THREE.Object3D[] = []
  private dirty = true
  private raf = 0
  private w = 1
  private h = 1
  private proj: Float32Array | null = null
  private morph: { from: Float32Array; to: Float32Array; t0: number; dur: number } | null = null
  private fly: { p0: THREE.Vector3; p1: THREE.Vector3; t0v: THREE.Vector3; t1v: THREE.Vector3; t0: number; dur: number } | null = null
  onFrame: (() => void) | null = null
  /** radio típico de la nube (lo calcula fit): escala estrellas, nombres y líneas */
  radius = 300
  private fitDist = 700

  constructor(el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(0x000000, 0)
    el.appendChild(this.renderer.domElement)
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 12000)
    this.camera.position.set(0, 120, 900)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.09, rotateSpeed: 0.55, zoomSpeed: 1.1, panSpeed: 0.8,
      screenSpacePanning: true, minDistance: 20, maxDistance: 6000, autoRotateSpeed: 0.35,
    })
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    this.controls.addEventListener('change', () => { this.dirty = true; this.proj = null })

    this.pMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uSize: { value: 4 }, uDot: { value: 1 } }, vertexShader: POINT_VS, fragmentShader: POINT_FS,
      transparent: true, depthWrite: false,
    })
    this.points = new THREE.Points(this.pGeo, this.pMat)
    this.points.frustumCulled = false
    this.lines = new THREE.LineSegments(this.lGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    this.lines.frustumCulled = false
    this.hiLines = new THREE.LineSegments(this.hGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false,
    }))
    this.hiLines.frustumCulled = false
    this.rings = new THREE.Points(this.rGeo, new THREE.ShaderMaterial({
      uniforms: this.pMat.uniforms, vertexShader: POINT_VS, fragmentShader: RING_FS, transparent: true, depthWrite: false, depthTest: false,
    }))
    this.rings.frustumCulled = false
    this.scene.add(this.lines, this.points, this.hiLines, this.rings)
    this.loop()
  }

  // ------------------------------------------------------------ datos
  setNodes(pos: Float32Array, colors: Float32Array, sizes: Float32Array, alpha: Float32Array) {
    this.n = pos.length / 3
    this.pos = pos.slice()
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.pGeo.setAttribute('acolor', new THREE.BufferAttribute(colors, 3))
    this.pGeo.setAttribute('asize', new THREE.BufferAttribute(sizes, 1))
    this.pGeo.setAttribute('aalpha', new THREE.BufferAttribute(alpha, 1))
    this.morph = null
    this.touch()
  }
  setColors(colors: Float32Array) { this.pGeo.setAttribute('acolor', new THREE.BufferAttribute(colors, 3)); this.touch() }
  setAlpha(alpha: Float32Array) { this.pGeo.setAttribute('aalpha', new THREE.BufferAttribute(alpha, 1)); this.touch() }

  /** pares de índices y color (intensidad) de cada conexión */
  setEdges(pairs: Int32Array, rgb: Float32Array) {
    this.edges = pairs
    const m = pairs.length / 2
    const col = new Float32Array(m * 6)
    for (let k = 0; k < m; k++) col.set([rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2], rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2]], k * 6)
    this.lGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * 6), 3))
    this.lGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    this.syncLines()
  }
  showEdges(on: boolean) { this.lines.visible = on; this.touch() }

  setHighlight(lines: Highlight[], halos: Halo[]) {
    this.highlights = lines
    this.halos = halos
    const col = new Float32Array(lines.length * 6)
    lines.forEach((l, k) => col.set([...l.rgb, ...l.rgb], k * 6))
    this.hGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines.length * 6), 3))
    this.hGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    this.rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(halos.length * 3), 3))
    this.rGeo.setAttribute('acolor', new THREE.BufferAttribute(new Float32Array(halos.flatMap((h) => h.rgb)), 3))
    this.rGeo.setAttribute('asize', new THREE.BufferAttribute(new Float32Array(halos.map((h) => h.size)), 1))
    this.rGeo.setAttribute('aalpha', new THREE.BufferAttribute(new Float32Array(halos.length).fill(1), 1))
    this.syncHighlight()
    this.touch()
  }

  /** objetos fijos extra (ejes del modo ordenado) */
  setExtra(objs: THREE.Object3D[]) {
    for (const o of this.extra) this.scene.remove(o)
    this.extra = objs
    for (const o of objs) this.scene.add(o)
    this.touch()
  }

  /** mueve las estrellas a nuevas posiciones (con animación o de una) */
  setPositions(to: Float32Array, animate: number) {
    if (to.length !== this.pos.length) return
    if (animate > 0) this.morph = { from: this.pos.slice(), to: to.slice(), t0: performance.now(), dur: animate }
    else { this.morph = null; this.pos.set(to); this.afterMove() }
    this.touch()
  }

  // ------------------------------------------------------------ cámara
  fit(animate = true) {
    if (!this.n) return
    const cx = median(this.pos, 0), cy = median(this.pos, 1), cz = median(this.pos, 2)
    const ds: number[] = []
    for (let i = 0; i < this.n; i++) ds.push(Math.hypot(this.pos[i * 3] - cx, this.pos[i * 3 + 1] - cy, this.pos[i * 3 + 2] - cz))
    ds.sort((a, b) => a - b)
    const r = Math.max(60, ds[Math.floor(ds.length * 0.92)] ?? 200)
    this.radius = r
    this.fitDist = r * 2.3
    this.pMat.uniforms.uSize.value = r / 55
    const target = new THREE.Vector3(cx, cy, cz)
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    if (dir.lengthSq() < 0.5) dir.set(0, 0.15, 1).normalize()
    this.flyTo(target, target.clone().add(dir.multiplyScalar(r * 2.3)), animate ? 900 : 0)
  }

  focus(i: number, dist = 170) {
    if (i < 0 || i >= this.n) return
    const p = new THREE.Vector3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2])
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    const cur = this.camera.position.distanceTo(this.controls.target)
    this.flyTo(p, p.clone().add(dir.multiplyScalar(Math.min(cur, dist))), 850)
  }

  private flyTo(target: THREE.Vector3, camPos: THREE.Vector3, dur: number) {
    if (dur <= 0) {
      this.controls.target.copy(target); this.camera.position.copy(camPos); this.controls.update(); this.touch(); return
    }
    this.fly = { p0: this.camera.position.clone(), p1: camPos, t0v: this.controls.target.clone(), t1v: target, t0: performance.now(), dur }
    this.touch()
  }

  // ------------------------------------------------------------ pantalla
  /** Multiplicador del tamaño de los puntos (control − / +). */
  setDotScale(k: number) { this.pMat.uniforms.uDot.value = k; this.touch() }

  resize(w: number, h: number) {
    this.w = Math.max(1, w); this.h = Math.max(1, h)
    this.renderer.setSize(this.w, this.h)
    this.camera.aspect = this.w / this.h
    this.camera.updateProjectionMatrix()
    this.pMat.uniforms.uScale.value = this.h * this.renderer.getPixelRatio() * 0.9
    this.touch()
  }

  /** posición en pantalla de cada estrella: x, y, profundidad (≤ 0 = detrás de la cámara) */
  project(): Float32Array {
    if (this.proj) return this.proj
    this.camera.updateMatrixWorld()
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements
    const out = new Float32Array(this.n * 3)
    const p = this.pos
    for (let i = 0; i < this.n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2]
      const w = m[3] * x + m[7] * y + m[11] * z + m[15]
      if (w <= 1) { out[i * 3 + 2] = -1; continue }
      out[i * 3] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * this.w
      out[i * 3 + 1] = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5 + 0.5)) * this.h
      out[i * 3 + 2] = w
    }
    this.proj = out
    return out
  }

  projectPoint(v: THREE.Vector3): [number, number, number] {
    const q = v.clone().project(this.camera)
    return [(q.x * 0.5 + 0.5) * this.w, (1 - (q.y * 0.5 + 0.5)) * this.h, q.z < 1 ? 1 : -1]
  }

  pick(x: number, y: number, alpha?: Float32Array): number {
    const s = this.project()
    let best = -1, bd = 14 * 14
    for (let i = 0; i < this.n; i++) {
      if (s[i * 3 + 2] <= 0 || (alpha && alpha[i] < 0.1)) continue
      const d = (s[i * 3] - x) ** 2 + (s[i * 3 + 1] - y) ** 2
      if (d < bd || (d < bd + 30 && best >= 0 && s[i * 3 + 2] < s[best * 3 + 2])) { bd = Math.min(bd, d); best = i }
    }
    return best
  }

  get size() { return { w: this.w, h: this.h } }
  touch() { this.dirty = true; this.proj = null }

  // ------------------------------------------------------------ bucle
  private afterMove() {
    const a = this.pGeo.attributes.position as THREE.BufferAttribute | undefined
    if (a) a.needsUpdate = true
    this.syncLines(); this.syncHighlight(); this.proj = null
  }

  private syncLines() {
    const a = this.lGeo.attributes.position as THREE.BufferAttribute | undefined
    if (!a) return
    const out = a.array as Float32Array, e = this.edges, p = this.pos
    for (let k = 0; k < e.length / 2; k++) {
      const i = e[k * 2] * 3, j = e[k * 2 + 1] * 3
      out[k * 6] = p[i]; out[k * 6 + 1] = p[i + 1]; out[k * 6 + 2] = p[i + 2]
      out[k * 6 + 3] = p[j]; out[k * 6 + 4] = p[j + 1]; out[k * 6 + 5] = p[j + 2]
    }
    a.needsUpdate = true
  }

  private syncHighlight() {
    const a = this.hGeo.attributes.position as THREE.BufferAttribute | undefined
    const p = this.pos
    if (a) {
      const out = a.array as Float32Array
      this.highlights.forEach((l, k) => {
        out.set([p[l.a * 3], p[l.a * 3 + 1], p[l.a * 3 + 2], p[l.b * 3], p[l.b * 3 + 1], p[l.b * 3 + 2]], k * 6)
      })
      a.needsUpdate = true
    }
    const r = this.rGeo.attributes.position as THREE.BufferAttribute | undefined
    if (r) {
      const out = r.array as Float32Array
      this.halos.forEach((h, k) => out.set([p[h.i * 3], p[h.i * 3 + 1], p[h.i * 3 + 2]], k * 3))
      r.needsUpdate = true
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    if (this.morph) {
      const t = Math.min(1, (now - this.morph.t0) / this.morph.dur), k = ease(t)
      const { from, to } = this.morph
      for (let i = 0; i < this.pos.length; i++) this.pos[i] = from[i] + (to[i] - from[i]) * k
      this.afterMove()
      if (t >= 1) this.morph = null
      this.dirty = true
    }
    if (this.fly) {
      const t = Math.min(1, (now - this.fly.t0) / this.fly.dur), k = ease(t)
      this.camera.position.lerpVectors(this.fly.p0, this.fly.p1, k)
      this.controls.target.lerpVectors(this.fly.t0v, this.fly.t1v, k)
      if (t >= 1) this.fly = null
      this.touch()
    }
    this.controls.update()       // amortiguación y giro automático (dispara "change" si se movió)
    if (!this.dirty) return
    this.dirty = false
    // de lejos las líneas se apagan (si no, miles encimadas forman una mancha blanca); de cerca se ven nítidas
    const dist = this.camera.position.distanceTo(this.controls.target)
    ;(this.lines.material as THREE.LineBasicMaterial).opacity = Math.min(1, Math.max(0.3, (this.fitDist / dist) * 0.55))
    this.renderer.render(this.scene, this.camera)
    this.onFrame?.()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.controls.dispose()
    for (const g of [this.pGeo, this.lGeo, this.hGeo, this.rGeo]) g.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

function median(p: Float32Array, axis: number): number {
  const v: number[] = []
  for (let i = axis; i < p.length; i += 3) v.push(p[i])
  v.sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)] ?? 0
}
