/**
 * The hero's particle network: points in a loose sphere, a line between every
 * pair closer than LINK, slowly turning and leaning toward the cursor.
 *
 * Only ever reached through a dynamic import from ParticleNetwork.vue, so this
 * module and three.js share a chunk that the entry never waits for.
 *
 * The structure is rigid — the whole group rotates, points never move relative
 * to each other — so the O(n²) neighbour search runs once, not per frame.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Fog,
  Group,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  WebGLRenderer,
} from 'three'

const COUNT = 200
const RADIUS = 5.6
const LINK = 1.75
const ACCENT = new Color('#0A84FF')
const HIGHLIGHT = new Color('#9CCBFF')
const VOID = 0x0b0b0d

/** A soft round dot, so points are not drawn as squares. */
function dotTexture(): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

/** Mounts the scene into `canvas`, sized to `host`. Returns the teardown. */
export function mountParticleNetwork(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  onFirstFrame: () => void,
): () => void {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.setClearColor(0x000000, 0)

  const scene = new Scene()
  // Far points sink into the page colour, which reads as depth.
  scene.fog = new Fog(VOID, 11, 20)
  const camera = new PerspectiveCamera(50, 1, 0.1, 60)
  camera.position.set(0, 0, 14)

  // tilt follows the cursor; spin turns on its own. Nested so they compose.
  const tilt = new Group()
  const spin = new Group()
  tilt.position.x = 4.4
  tilt.add(spin)
  scene.add(tilt)

  // Points: denser toward the shell, a few brighter nodes.
  const positions: number[] = []
  const colors: number[] = []
  for (let i = 0; i < COUNT; i++) {
    const u = Math.random() * 2 - 1
    const theta = Math.random() * Math.PI * 2
    const r = RADIUS * Math.cbrt(0.25 + 0.75 * Math.random())
    const s = Math.sqrt(1 - u * u)
    positions.push(r * s * Math.cos(theta), r * u * 0.8, r * s * Math.sin(theta))
    const c = Math.random() < 0.12 ? HIGHLIGHT : ACCENT
    colors.push(c.r, c.g, c.b)
  }

  // Lines: with additive blending, a darker colour is a fainter line, so the
  // fade with distance is just the colour scaled toward black.
  const linePositions: number[] = []
  const lineColors: number[] = []
  for (let i = 0; i < COUNT; i++) {
    for (let j = i + 1; j < COUNT; j++) {
      const dx = positions[i * 3] - positions[j * 3]
      const dy = positions[i * 3 + 1] - positions[j * 3 + 1]
      const dz = positions[i * 3 + 2] - positions[j * 3 + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d > LINK) continue
      const k = (1 - d / LINK) * 0.45
      linePositions.push(...positions.slice(i * 3, i * 3 + 3), ...positions.slice(j * 3, j * 3 + 3))
      for (let n = 0; n < 2; n++) lineColors.push(ACCENT.r * k, ACCENT.g * k, ACCENT.b * k)
    }
  }

  const texture = dotTexture()
  const pointGeometry = new BufferGeometry()
  pointGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  pointGeometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  const pointMaterial = new PointsMaterial({
    size: 0.22,
    map: texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })

  const lineGeometry = new BufferGeometry()
  lineGeometry.setAttribute('position', new Float32BufferAttribute(linePositions, 3))
  lineGeometry.setAttribute('color', new Float32BufferAttribute(lineColors, 3))
  const lineMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })

  spin.add(new LineSegments(lineGeometry, lineMaterial), new Points(pointGeometry, pointMaterial))

  // Pointer parallax, only where there is a pointer that hovers.
  const target = { x: 0, y: 0 }
  const current = { x: 0, y: 0 }
  const parallax = window.matchMedia?.('(hover: hover)').matches ?? false
  const onPointer = (e: PointerEvent) => {
    target.x = (e.clientX / window.innerWidth) * 2 - 1
    target.y = (e.clientY / window.innerHeight) * 2 - 1
  }
  if (parallax) window.addEventListener('pointermove', onPointer, { passive: true })

  const resize = () => {
    const w = host.clientWidth
    const h = host.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const resizer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
  resizer?.observe(host)

  // Time only advances while drawing, so a resumed scene carries on where it
  // stopped instead of jumping ahead by however long it was hidden.
  let elapsed = 0
  let last = 0
  let drawn = false
  const frame = (now: number) => {
    elapsed += last ? Math.min(now - last, 50) : 0
    last = now
    current.x += (target.x - current.x) * 0.035
    current.y += (target.y - current.y) * 0.035
    spin.rotation.y = elapsed * 0.00005
    spin.rotation.x = Math.sin(elapsed * 0.00008) * 0.12
    tilt.rotation.y = current.x * 0.22
    tilt.rotation.x = current.y * 0.14
    renderer.render(scene, camera)
    if (!drawn) {
      drawn = true
      onFirstFrame()
    }
  }

  // Paused off-screen and in a background tab.
  let onScreen = true
  const update = () => {
    const run = onScreen && !document.hidden
    if (!run) last = 0
    renderer.setAnimationLoop(run ? frame : null)
  }
  const observer =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
          onScreen = entry.isIntersecting
          update()
        })
      : null
  observer?.observe(host)
  document.addEventListener('visibilitychange', update)
  update()

  return () => {
    renderer.setAnimationLoop(null)
    observer?.disconnect()
    resizer?.disconnect()
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('pointermove', onPointer)
    pointGeometry.dispose()
    lineGeometry.dispose()
    pointMaterial.dispose()
    lineMaterial.dispose()
    texture.dispose()
    renderer.dispose()
    // Browsers cap live GL contexts; give this one back now, not at GC.
    renderer.forceContextLoss()
  }
}
