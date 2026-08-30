'use client'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { heightToNormal, makeFbm } from '@/game/gfx/textures'

// First-person weapon view models — procedural geometry + seeded canvas maps in the
// shared visual family (worn dark metal / scuffed wood / oily cloth). Built once and
// cached at module scope; the Weapons component attaches `root` to the camera.

// ─── Seeded canvas texture kit ───────────────────────────────────────────────

type MapKind = 'albedo' | 'height' | 'rough'
type PaintFn = (x: number, y: number, kind: MapKind) => readonly [number, number, number]

interface TexSet { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }
const texCache = new Map<string, TexSet>()

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0)

function paintCanvas(size: number, kind: MapKind, fn: PaintFn): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const d = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn(x, y, kind)
      const i = (y * size + x) * 4
      d[i] = clamp255(r)
      d[i + 1] = clamp255(g)
      d[i + 2] = clamp255(b)
      d[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

function makeSet(key: string, size: number, fn: PaintFn, normalStrength = 2.0): TexSet {
  const hit = texCache.get(key)
  if (hit) return hit
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 8
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const set: TexSet = {
    map: tex(paintCanvas(size, 'albedo', fn), true),
    normalMap: heightToNormal(`wpn:${key}:normal`, paintCanvas(size, 'height', fn), normalStrength),
    roughnessMap: tex(paintCanvas(size, 'rough', fn), false),
  }
  texCache.set(key, set)
  return set
}

/** Brushed dark gunmetal with edge scratches — revolver frame/barrel/cylinder family. */
function gunmetalSet(): TexSet {
  const fbm = makeFbm(9001)
  return makeSet('gunmetal', 256, (x, y, kind) => {
    const streak = fbm(x / 90, y / 7, 4) // horizontal brush lines
    const spec = fbm(x / 3 + 7, y / 3 + 7, 2) // fine speckle
    const wear = fbm(x / 22 + 51, y / 22 + 51, 3)
    const scratch = wear > 0.74 ? (wear - 0.74) * 4 : 0
    if (kind === 'albedo') {
      const base = 46 + streak * 16 + spec * 7 + scratch * 72
      return [base - 2, base, base + 5]
    }
    if (kind === 'height') return return3(128 + streak * 14 + spec * 9 - scratch * 34)
    return return3(122 + streak * 48 + spec * 18 - scratch * 72)
  }, 1.6)
}

/** Ash bat wood: long grain, wavy rings, pale scuffs and dings. */
function woodSet(): TexSet {
  const fbm = makeFbm(9003)
  return makeSet('batwood', 256, (x, y, kind) => {
    const grain = fbm(x / 6, y / 110, 4) // fast across x, stretched along y (bat length)
    const ring = Math.sin(((x / 256) * 6 + grain * 2.6) * Math.PI * 2) * 0.5 + 0.5
    const sc = fbm(x / 7 + 123, y / 60 + 55, 2)
    const scuff = sc > 0.72 ? (sc - 0.72) * 5 : 0
    const ding = fbm(x / 40 + 300, y / 40 + 300, 2) > 0.78 ? 1 : 0
    if (kind === 'albedo') {
      const d = ding ? 0.72 : 1
      return [
        (166 + grain * 36 + ring * 18 + scuff * 46) * d,
        (117 + grain * 27 + ring * 12 + scuff * 40) * d,
        (64 + grain * 18 + ring * 8 + scuff * 34) * d,
      ]
    }
    if (kind === 'height') return3(128 + grain * 34 + ring * 10 - scuff * 28 - ding * 40)
    return return3(168 + grain * 34 - ring * 10 + scuff * 52)
  }, 1.8)
}

/** Wrapped grip tape: helical bands with overlap ridges. */
function tapeSet(): TexSet {
  const fbm = makeFbm(9004)
  return makeSet('griptape', 128, (x, y, kind) => {
    const band = (x + y * 0.55 + 128) % 30
    const edge = band < 3 ? 1 : 0
    const step = band < 15 ? 1 : 0
    const n = fbm(x / 16, y / 16, 3)
    const weave = (Math.sin(x * 1.15) + Math.sin(y * 1.15)) * 0.5
    if (kind === 'albedo') {
      const base = 50 + n * 15 - edge * 16 + weave * 4 + step * 6
      return [base + 5, base + 2, base]
    }
    if (kind === 'height') return3(116 + step * 24 - edge * 52 + n * 10 + weave * 5)
    return return3(228 + n * 16 - edge * 12)
  }, 2.2)
}

/** Dirty rag cloth, fuel-soaked toward v=0 (bottom of the canvas). */
function clothSet(): TexSet {
  const fbm = makeFbm(9005)
  return makeSet('ragcloth', 128, (x, y, kind) => {
    const w = Math.sin((x * Math.PI) / 3) * Math.sin((y * Math.PI) / 3)
    const n = fbm(x / 26, y / 26, 3)
    const soak = THREE.MathUtils.clamp((1 - y / 128 - 0.3) / 0.55, 0, 1)
    if (kind === 'albedo') {
      return [
        204 - soak * 66 + w * 13 + n * 22,
        193 - soak * 104 + w * 12 + n * 20,
        168 - soak * 122 + w * 10 + n * 16,
      ]
    }
    if (kind === 'height') return3(128 + w * 38 + n * 18)
    return return3(236 - soak * 44 + n * 12)
  }, 2.4)
}

// tuple helper (kept as function so the paint fns stay terse)
function return3(v: number): readonly [number, number, number] { return [v, v, v] }

/** Soft radial glow sprite for the muzzle flash petals. */
function flashTexture(): THREE.CanvasTexture {
  const cached = texCache.get('flash')
  if (cached) return cached.map as THREE.CanvasTexture
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,232,175,0.9)')
  g.addColorStop(0.6, 'rgba(255,165,60,0.32)')
  g.addColorStop(1, 'rgba(255,120,20,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  texCache.set('flash', { map: tex, normalMap: tex, roughnessMap: tex })
  return tex
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const hw = w / 2, hh = h / 2
  const rr = Math.min(r, hw - 1e-4, hh - 1e-4)
  s.moveTo(-hw + rr, -hh)
  s.lineTo(hw - rr, -hh)
  s.absarc(hw - rr, -hh + rr, rr, -Math.PI / 2, 0, false)
  s.lineTo(hw, hh - rr)
  s.absarc(hw - rr, hh - rr, rr, 0, Math.PI / 2, false)
  s.lineTo(-hw + rr, hh)
  s.absarc(-hw + rr, hh - rr, rr, Math.PI / 2, Math.PI, false)
  s.lineTo(-hw, -hh + rr)
  s.absarc(-hw + rr, -hh + rr, rr, Math.PI, Math.PI * 1.5, false)
  return s
}

function scaleUV(g: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (uv) {
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s)
    uv.needsUpdate = true
  }
  return g
}

/** Bevel-edged rounded box extruded along Z, centered at the origin. */
function extrudeRR(w: number, h: number, depth: number, r: number, bev = 0.0035): THREE.BufferGeometry {
  const shape = roundedRectShape(Math.max(0.002, w - bev * 2), Math.max(0.002, h - bev * 2), Math.max(0.0008, r - bev))
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - bev * 2),
    bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2,
    curveSegments: 8, steps: 1,
  })
  g.center()
  scaleUV(g, 8)
  return g
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0, rx = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  if (rx) g.rotateX(rx)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

function mergeParts(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g))
  return mergeGeometries(parts, false) ?? parts[0]
}

/**
 * Revolver cylinder body extruded along Z: a circle with 6 shallow flutes scalloped
 * BETWEEN the chambers (chambers sit at 30° + k·60°, so the top chamber lines up
 * with the bore). Real silhouette relief — the flutes read in profile as it spins.
 */
function flutedCylinderGeo(radius: number, fluteDepth: number, length: number): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const N = 96
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const c = Math.max(0, Math.cos(a * 6)) // peaks midway between chambers
    const r = radius - fluteDepth * c * c
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r)
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r)
  }
  shape.closePath()
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, length - 0.003),
    bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 2,
    curveSegments: 4, steps: 1,
  })
  g.center()
  scaleUV(g, 30)
  return g
}

// ─── Rig ─────────────────────────────────────────────────────────────────────

export interface WeaponRig {
  root: THREE.Group
  sway: THREE.Group
  pistol: {
    group: THREE.Group
    /** swing-out crane: rotate .z to 0..~2.05 to open (carries cylinder + ejector) */
    crane: THREE.Group
    /** 6-shot cylinder: rotate .z around the barrel axis to index/spin */
    cylinder: THREE.Group
    /** hammer pivot: rotate .x positive to cock the spur back */
    hammer: THREE.Group
    /** ejector rod + extractor star: push .position.z positive for the eject flick */
    ejector: THREE.Group
    muzzle: THREE.Object3D
    flash: THREE.Mesh
    flashMat: THREE.MeshBasicMaterial
    /** cylinder-gap side vents — share flashMat, flicker with the muzzle flash */
    ventFlash: THREE.Mesh
    /** local position of the red-dot sight axis; ADS centers this on the camera axis */
    adsOffset: THREE.Vector3
  }
  bat: {
    group: THREE.Group
    inner: THREE.Group
    mat: THREE.MeshStandardMaterial
    shell: THREE.Mesh
    shellMat: THREE.MeshBasicMaterial
  }
  molotov: {
    group: THREE.Group
    bottle: THREE.Group
    liquid: THREE.Mesh
    flame: THREE.Mesh
    flameMat: THREE.ShaderMaterial
    ember: THREE.Mesh
  }
}

let rigSingleton: WeaponRig | null = null

export function getWeaponRig(): WeaponRig {
  if (!rigSingleton) rigSingleton = buildRig()
  return rigSingleton
}

function buildRig(): WeaponRig {
  const gm = gunmetalSet()
  const wd = woodSet()
  const tp = tapeSet()
  const cl = clothSet()

  const steelMat = new THREE.MeshStandardMaterial({
    map: gm.map, normalMap: gm.normalMap, roughnessMap: gm.roughnessMap,
    color: 0xd9dde2, metalness: 0.82, roughness: 1.0, normalScale: new THREE.Vector2(0.85, 0.85),
  })
  const frameMat = new THREE.MeshStandardMaterial({
    map: gm.map, normalMap: gm.normalMap, roughnessMap: gm.roughnessMap,
    color: 0x84898f, metalness: 0.5, roughness: 1.0, normalScale: new THREE.Vector2(0.7, 0.7),
  })
  const accentMat = new THREE.MeshStandardMaterial({
    map: gm.map, normalMap: gm.normalMap, roughnessMap: gm.roughnessMap,
    color: 0x53565c, metalness: 0.9, roughness: 1.0, normalScale: new THREE.Vector2(0.6, 0.6),
  })
  const boreMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, metalness: 0.6, roughness: 0.5 })
  const gripWoodMat = new THREE.MeshStandardMaterial({
    map: wd.map, normalMap: wd.normalMap, roughnessMap: wd.roughnessMap,
    color: 0xb5814e, metalness: 0.05, roughness: 1.0, normalScale: new THREE.Vector2(1.1, 1.1),
  })
  const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 2.8, 1.1), toneMapped: false })

  // ── Revolver ── local axis: -Z forward, Y up; origin near the trigger.
  // Bore axis y=0.072 (lines up with the TOP chamber); cylinder axis y=0.0575.
  // Cylinder window z −0.054..−0.010; barrel z −0.062..−0.207 (~5.7").
  const pistolGroup = new THREE.Group()

  const staticFrame = new THREE.Mesh(mergeParts([
    (() => { const g = extrudeRR(0.030, 0.014, 0.078, 0.004); g.translate(0, 0.0885, -0.030); return g })(), // top strap over the cylinder
    (() => { const g = extrudeRR(0.034, 0.058, 0.036, 0.008); g.translate(0, 0.059, 0.020); return g })(), // rear frame / hammer channel
    (() => { const g = new THREE.CylinderGeometry(0.027, 0.027, 0.010, 20); g.rotateX(Math.PI / 2); g.translate(0, 0.0575, -0.002); return g })(), // recoil shield
    box(0.030, 0.052, 0.014, 0, 0.062, -0.061), // front post (barrel lug)
    box(0.020, 0.012, 0.050, 0, 0.027, -0.030), // bottom strap under the cylinder
    box(0.028, 0.034, 0.028, 0, 0.024, 0.040, -0.44), // backstrap bridge into the grip
    box(0.024, 0.026, 0.016, 0, 0.040, -0.060), // crane housing
    (() => { const g = new THREE.TorusGeometry(0.024, 0.0042, 8, 20, Math.PI * 1.3); g.rotateY(Math.PI / 2); g.rotateX(0.9); g.translate(0, 0.004, -0.014); return g })(), // trigger guard
    (() => { const g = new THREE.CylinderGeometry(0.0125, 0.0115, 0.008, 14); g.rotateX(Math.PI / 2); g.translate(0, 0.072, -0.062); return g })(), // forcing cone
    (() => { const g = new THREE.CylinderGeometry(0.0118, 0.0105, 0.145, 16); g.rotateX(Math.PI / 2); g.translate(0, 0.072, -0.1355); return g })(), // barrel
    (() => { const g = new THREE.CylinderGeometry(0.0122, 0.0122, 0.010, 16); g.rotateX(Math.PI / 2); g.translate(0, 0.072, -0.202); return g })(), // muzzle crown
    box(0.009, 0.005, 0.150, 0, 0.0855, -0.128), // top sight rib
    (() => { const g = extrudeRR(0.017, 0.026, 0.132, 0.006); g.translate(0, 0.0525, -0.130); return g })(), // full underlug (ejector-rod shroud)
  ]), frameMat)

  const staticAccent = new THREE.Mesh(mergeParts([
    box(0.005, 0.022, 0.0055, 0, 0.004, -0.017, 0.3), // curved trigger
    box(0.005, 0.010, 0.020, -0.019, 0.055, 0.010), // cylinder release latch (left side)
    box(0.007, 0.010, 0.007, 0, -0.086, 0.100), // lanyard mount
    (() => { const g = new THREE.TorusGeometry(0.0068, 0.0018, 6, 14); g.rotateY(Math.PI / 2); g.translate(0, -0.0955, 0.100); return g })(), // lanyard ring
    // red dot sight: mount riser + open circular housing on the rear of the rib
    box(0.016, 0.010, 0.030, 0, 0.1035, -0.010), // riser
    (() => { const g = new THREE.TorusGeometry(0.0135, 0.0032, 10, 24); g.translate(0, 0.118, -0.012); return g })(), // housing ring
    box(0.006, 0.006, 0.014, 0, 0.1315, -0.012), // top cap / adjustment turret
  ]), accentMat)

  // sight glass (faint blue) + the emissive red dot on the sight axis
  const sightGlassMat = new THREE.MeshBasicMaterial({
    color: 0x86bfff, transparent: true, opacity: 0.045, depthWrite: false, side: THREE.DoubleSide,
  })
  const sightGlass = new THREE.Mesh(new THREE.CircleGeometry(0.0115, 20), sightGlassMat)
  sightGlass.position.set(0, 0.118, -0.013)
  sightGlass.renderOrder = 4
  const redDotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5.0, 0.35, 0.3), toneMapped: false })
  const redDot = new THREE.Mesh(new THREE.CircleGeometry(0.0015, 12), redDotMat)
  redDot.position.set(0, 0.118, -0.0145)
  redDot.renderOrder = 5
  const dots = new THREE.Group()
  dots.add(sightGlass, redDot)
  // dotMat retained for the loading-gate glow dot only
  const gateDot = new THREE.Mesh(new THREE.SphereGeometry(0.0015, 6, 6), dotMat)
  gateDot.position.set(0.0175, 0.052, 0.028)
  dots.add(gateDot)
  // local position of the sight axis: ADS centers this on the camera axis
  const adsOffset = new THREE.Vector3(0, 0.118, -0.014)

  // contoured wood grip — raked back, palm swell, flared butt (never animates)
  const rake = (g: THREE.BufferGeometry) => { g.rotateX(-0.44); g.translate(0, 0.010, 0.046); return g }
  const gripWood = new THREE.Mesh(mergeParts([
    rake((() => { const g = extrudeRR(0.030, 0.046, 0.100, 0.012); g.rotateX(Math.PI / 2); g.translate(0, -0.052, 0.004); return g })()), // core
    rake((() => { const g = new THREE.SphereGeometry(0.021, 14, 10); g.scale(0.85, 1.6, 1.05); g.translate(0, -0.050, 0.004); return g })()), // palm swell
    rake((() => { const g = extrudeRR(0.034, 0.052, 0.020, 0.009); g.rotateX(Math.PI / 2); g.translate(0, -0.094, 0.006); return g })()), // butt flare
  ]), gripWoodMat)

  // hammer — pivot at the frame rear; rotation.x > 0 cocks the spur back
  const hammerGroup = new THREE.Group()
  hammerGroup.position.set(0, 0.06, 0.026)
  hammerGroup.add(new THREE.Mesh(mergeParts([
    box(0.009, 0.028, 0.013, 0, 0.008, 0.002), // body
    box(0.0075, 0.022, 0.0075, 0, 0.026, 0.010, 0.45), // spur shank
    box(0.014, 0.005, 0.017, 0, 0.0365, 0.0175, 0.30), // checkered spur pad
    box(0.005, 0.007, 0.012, 0, 0.004, -0.008), // firing nose
  ]), accentMat))

  // crane — pivot low-left of the cylinder window, parallel to the bore.
  // rotation.z 0..~2.05 swings the whole cylinder+ejector assembly out to the left.
  const craneGroup = new THREE.Group()
  craneGroup.position.set(-0.013, 0.040, -0.045)
  const craneArm = new THREE.Mesh(mergeParts([
    box(0.009, 0.028, 0.011, 0.004, 0.010, 0.002), // yoke arm up from the pivot
    (() => { const g = new THREE.CylinderGeometry(0.005, 0.005, 0.026, 10); g.rotateX(Math.PI / 2); g.translate(0.013, 0.0175, -0.004); return g })(), // cylinder axis pin
  ]), frameMat)

  // 6-shot fluted cylinder — spins around its own Z (crane-local (0.013, 0.0175) = bore-centered when shut)
  const cylinderGroup = new THREE.Group()
  cylinderGroup.position.set(0.013, 0.0175, 0.013)
  const boreGeos: THREE.BufferGeometry[] = []
  const rimGeos: THREE.BufferGeometry[] = []
  const detailGeos: THREE.BufferGeometry[] = []
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3 // chamber centers (top chamber at 90°)
    const cx = Math.cos(a) * 0.0145
    const cy = Math.sin(a) * 0.0145
    const bore = new THREE.CylinderGeometry(0.0062, 0.0062, 0.002, 12)
    bore.rotateX(Math.PI / 2)
    bore.translate(cx, cy, -0.0214) // dark disc barely proud of the front face
    boreGeos.push(bore)
    const rim = new THREE.TorusGeometry(0.0069, 0.0009, 6, 16) // chamber-mouth chamfer ring
    rim.translate(cx, cy, -0.0221)
    rimGeos.push(rim)
    const notch = new THREE.BoxGeometry(0.0045, 0.0016, 0.007) // cylinder stop notch
    notch.translate(0, 0.0231, 0.008)
    notch.rotateZ(a - Math.PI / 2)
    detailGeos.push(notch)
  }
  detailGeos.push((() => { const g = new THREE.CylinderGeometry(0.0085, 0.0085, 0.0035, 6); g.rotateX(Math.PI / 2); g.translate(0, 0, 0.0225); return g })()) // rear ratchet
  cylinderGroup.add(
    new THREE.Mesh(flutedCylinderGeo(0.0235, 0.0028, 0.044), steelMat),
    new THREE.Mesh(mergeParts(boreGeos), boreMat),
    new THREE.Mesh(mergeParts(rimGeos), frameMat),
    new THREE.Mesh(mergeParts(detailGeos), accentMat),
  )

  // ejector rod + extractor star — shrouded by the underlug when shut; slides +Z on the flick
  const ejectorGroup = new THREE.Group()
  ejectorGroup.add(new THREE.Mesh(mergeParts([
    (() => { const g = new THREE.CylinderGeometry(0.0032, 0.0032, 0.046, 10); g.rotateX(Math.PI / 2); g.translate(0.013, 0.0175, -0.030); return g })(), // rod
    (() => { const g = new THREE.CylinderGeometry(0.0048, 0.0048, 0.009, 10); g.rotateX(Math.PI / 2); g.translate(0.013, 0.0175, -0.0555); return g })(), // knurled head
    (() => { const g = new THREE.CylinderGeometry(0.0155, 0.0148, 0.0025, 6); g.rotateX(Math.PI / 2); g.translate(0.013, 0.0175, 0.0355); return g })(), // extractor star
  ]), accentMat))
  craneGroup.add(craneArm, cylinderGroup, ejectorGroup)

  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.072, -0.21)

  const flashMat = new THREE.MeshBasicMaterial({
    map: flashTexture(), color: new THREE.Color(2.9, 2.0, 1.0),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  })
  // magnum-scale star: big core + 4 radial petals + crossed forward spikes
  const flash = new THREE.Mesh(mergeParts([
    new THREE.PlaneGeometry(0.16, 0.16),
    new THREE.PlaneGeometry(0.34, 0.07),
    (() => { const g = new THREE.PlaneGeometry(0.30, 0.06); g.rotateZ(Math.PI / 3); return g })(),
    (() => { const g = new THREE.PlaneGeometry(0.30, 0.06); g.rotateZ(-Math.PI / 3); return g })(),
    (() => { const g = new THREE.PlaneGeometry(0.34, 0.075); g.rotateY(Math.PI / 2); g.translate(0, 0, -0.13); return g })(),
    (() => { const g = new THREE.PlaneGeometry(0.34, 0.075); g.rotateY(Math.PI / 2); g.rotateZ(Math.PI / 2); g.translate(0, 0, -0.13); return g })(),
  ]), flashMat)
  flash.position.set(0, 0.072, -0.216)
  flash.visible = false

  // side vents blasting out of the barrel/cylinder gap
  const ventFlash = new THREE.Mesh(mergeParts([
    new THREE.PlaneGeometry(0.085, 0.085),
    new THREE.PlaneGeometry(0.26, 0.034),
    (() => { const g = new THREE.PlaneGeometry(0.19, 0.028); g.rotateZ(0.5); return g })(),
    (() => { const g = new THREE.PlaneGeometry(0.19, 0.028); g.rotateZ(-0.5); return g })(),
  ]), flashMat)
  ventFlash.position.set(0, 0.072, -0.0575)
  ventFlash.visible = false

  pistolGroup.add(staticFrame, staticAccent, dots, gripWood, hammerGroup, craneGroup, muzzle, flash, ventFlash)

  // ── Baseball bat ── model built along +Y (knob at y=0), pivot lowered to the hands.
  const batMat = new THREE.MeshStandardMaterial({
    map: wd.map, normalMap: wd.normalMap, roughnessMap: wd.roughnessMap,
    metalness: 0.0, roughness: 1.0, normalScale: new THREE.Vector2(1.0, 1.0),
    emissive: new THREE.Color(0xff8a24), emissiveIntensity: 0,
  })
  const tapeMat = new THREE.MeshStandardMaterial({
    map: tp.map, normalMap: tp.normalMap, roughnessMap: tp.roughnessMap,
    metalness: 0.05, roughness: 1.0, normalScale: new THREE.Vector2(1.4, 1.4),
  })
  const shellMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.8, 1.5, 0.5), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  })

  const batProfile: THREE.Vector2[] = [
    [0.013, 0], [0.030, 0.006], [0.032, 0.018], [0.026, 0.032], [0.018, 0.05],
    [0.0165, 0.09], [0.0165, 0.24], [0.019, 0.34], [0.024, 0.44], [0.029, 0.52],
    [0.032, 0.60], [0.0335, 0.70], [0.0335, 0.79], [0.031, 0.822], [0.022, 0.840],
    [0.010, 0.848], [0.0001, 0.85],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  const batGeo = new THREE.LatheGeometry(batProfile, 26)
  const batGroup = new THREE.Group()
  const batInner = new THREE.Group()
  batInner.position.y = -0.10 // hands hold ~10cm up the handle
  const woodMesh = new THREE.Mesh(batGeo, batMat)
  const tapeMesh = new THREE.Mesh((() => {
    const g = new THREE.CylinderGeometry(0.0187, 0.0182, 0.205, 18, 1)
    g.translate(0, 0.16, 0)
    return g
  })(), tapeMat)
  const shellGeo = batGeo.clone()
  shellGeo.scale(1.06, 1.008, 1.06)
  const shell = new THREE.Mesh(shellGeo, shellMat)
  shell.visible = false
  batInner.add(woodMesh, tapeMesh, shell)
  batGroup.add(batInner)

  // ── Molotov ── glass bottle + liquid + rag + ember/flame. Origin at bottle base.
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xa8c2a0, metalness: 0, roughness: 0.06,
    transmission: 0.92, thickness: 0.012, ior: 1.5, clearcoat: 1, clearcoatRoughness: 0.15,
    transparent: true,
  })
  const liquidMat = new THREE.MeshPhysicalMaterial({
    color: 0xc47a17, metalness: 0, roughness: 0.18,
    transmission: 0.35, thickness: 0.05, transparent: true, opacity: 0.96,
    emissive: new THREE.Color(0x341603), emissiveIntensity: 0.5,
  })
  const ragMat = new THREE.MeshStandardMaterial({
    map: cl.map, normalMap: cl.normalMap, roughnessMap: cl.roughnessMap,
    metalness: 0, roughness: 1.0, normalScale: new THREE.Vector2(1.2, 1.2),
  })
  const emberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.05, 0.22), toneMapped: false })
  // proper wick flame: teardrop SDF with wobble + hot core on crossed quads
  // (reads volumetric from any angle — no billboarding). pow-free (Metal NaN rule).
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFlick: { value: 1 } },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
uniform float uTime, uFlick;
varying vec2 vUv;
void main(){
  float y = clamp(vUv.y, 0.0, 1.0);
  float wob = 0.07 * sin(uTime * 13.0 + y * 9.0) * y + 0.03 * sin(uTime * 29.0 + y * 17.0);
  float x = vUv.x - 0.5 + wob;
  float w = 0.30 * (1.0 - y) * (0.35 + 0.65 * smoothstep(0.0, 0.25, y));
  float body = smoothstep(w, w * 0.35, abs(x));
  float a = body * smoothstep(1.02, 0.72, y) * smoothstep(0.0, 0.06, y) * uFlick;
  if (a < 0.01) discard;
  float core = smoothstep(w * 0.8, 0.0, abs(x)) * smoothstep(0.9, 0.15, y);
  vec3 col = mix(vec3(1.0, 0.33, 0.05), vec3(1.0, 0.82, 0.32), core);
  col = mix(col, vec3(1.0, 0.97, 0.82), core * core * 0.8);
  gl_FragColor = vec4(col * 2.6, a);
}`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const glassProfile: THREE.Vector2[] = [
    [0.012, 0.0], [0.031, 0.002], [0.041, 0.010], [0.044, 0.028], [0.044, 0.105],
    [0.038, 0.128], [0.022, 0.152], [0.0155, 0.168], [0.0145, 0.198], [0.0165, 0.202],
    [0.0165, 0.208], [0.0145, 0.210],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  const liquidProfile: THREE.Vector2[] = [
    [0.0001, 0.006], [0.030, 0.007], [0.039, 0.015], [0.0405, 0.030], [0.0405, 0.088],
    [0.028, 0.098], [0.0001, 0.100],
  ].map(([x, y]) => new THREE.Vector2(x, y))

  // aged paper label with a scrawled XXX — wraps the bottle body
  const labelCanvas = document.createElement('canvas')
  labelCanvas.width = 128
  labelCanvas.height = 64
  const lctx = labelCanvas.getContext('2d')!
  lctx.fillStyle = '#c9b98f'
  lctx.fillRect(0, 0, 128, 64)
  for (let i = 0; i < 70; i++) {
    lctx.fillStyle = `rgba(120,100,60,${0.05 + Math.random() * 0.09})`
    lctx.fillRect(Math.random() * 128, Math.random() * 64, 2 + Math.random() * 7, 1.5)
  }
  lctx.strokeStyle = '#42301c'
  lctx.lineWidth = 5
  lctx.lineCap = 'round'
  lctx.beginPath()
  for (const cx of [24, 64, 104]) {
    lctx.moveTo(cx - 11, 19)
    lctx.lineTo(cx + 11, 45)
    lctx.moveTo(cx + 11, 19)
    lctx.lineTo(cx - 11, 45)
  }
  lctx.stroke()
  lctx.fillStyle = 'rgba(60,45,25,0.35)'
  lctx.fillRect(0, 0, 128, 3)
  lctx.fillRect(0, 61, 128, 3)
  const labelTex = new THREE.CanvasTexture(labelCanvas)
  labelTex.colorSpace = THREE.SRGBColorSpace
  const labelMat = new THREE.MeshStandardMaterial({
    map: labelTex, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide,
  })

  const molotovGroup = new THREE.Group()
  const bottle = new THREE.Group()
  const glass = new THREE.Mesh(new THREE.LatheGeometry(glassProfile, 22), glassMat)
  glass.renderOrder = 2
  const liquid = new THREE.Mesh(new THREE.LatheGeometry(liquidProfile, 18), liquidMat)
  liquid.renderOrder = 1
  const ragGeo = mergeParts([
    (() => { const g = new THREE.CylinderGeometry(0.0125, 0.0115, 0.05, 12); g.translate(0, 0.215, 0); return g })(),
    new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, 0.225, 0),
        new THREE.Vector3(-0.035, 0.205, 0.015),
        new THREE.Vector3(-0.05, 0.150, 0.028),
      ), 10, 0.009, 8, false),
  ])
  const rag = new THREE.Mesh(ragGeo, ragMat)
  const ember = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 10, 8), emberMat)
  ember.position.set(0, 0.243, 0)
  const flame = new THREE.Mesh(mergeParts([
    (() => { const g = new THREE.PlaneGeometry(0.06, 0.095); g.translate(0, 0.0475, 0); return g })(),
    (() => { const g = new THREE.PlaneGeometry(0.06, 0.095); g.rotateY(Math.PI / 2); g.translate(0, 0.0475, 0); return g })(),
  ]), flameMat)
  flame.position.set(0, 0.238, 0)
  flame.renderOrder = 3
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0455, 0.0455, 0.052, 22, 1, true), labelMat)
  label.position.set(0, 0.062, 0)
  bottle.add(glass, liquid, rag, ember, flame, label)
  bottle.position.set(0, -0.1, 0) // hand grips mid-bottle
  molotovGroup.add(bottle)

  // ── Assemble ──
  const root = new THREE.Group()
  root.name = 'weaponRig'
  const sway = new THREE.Group()
  root.add(sway)
  sway.add(pistolGroup, batGroup, molotovGroup)

  root.traverse((o) => {
    o.frustumCulled = false
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = false
      o.receiveShadow = false
    }
  })

  return {
    root,
    sway,
    pistol: {
      group: pistolGroup, crane: craneGroup, cylinder: cylinderGroup,
      hammer: hammerGroup, ejector: ejectorGroup, muzzle, flash, flashMat, ventFlash, adsOffset,
    },
    bat: { group: batGroup, inner: batInner, mat: batMat, shell, shellMat },
    molotov: { group: molotovGroup, bottle, liquid, flame, flameMat, ember },
  }
}

// ─── Molotov aim arc assets (scene-space, not camera-attached) ───────────────

export interface ArcAssets {
  group: THREE.Group
  dashes: THREE.InstancedMesh
  disc: THREE.Mesh
  discMat: THREE.ShaderMaterial
}

let arcSingleton: ArcAssets | null = null

export function getArcAssets(): ArcAssets {
  if (arcSingleton) return arcSingleton
  const group = new THREE.Group()
  group.visible = false

  const dashGeo = new THREE.BoxGeometry(0.05, 0.05, 0.26)
  const dashMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.0, 1.15, 0.35), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  })
  const dashes = new THREE.InstancedMesh(dashGeo, dashMat, 72)
  dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  dashes.frustumCulled = false
  dashes.count = 0
  dashes.renderOrder = 9

  const discMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(1.0, 0.55, 0.14) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec2 vP;
      void main() {
        float r = length(vP);
        if (r > 1.0) discard;
        float ring = smoothstep(0.885, 0.93, r) * (1.0 - smoothstep(0.955, 1.0, r));
        float fill = (1.0 - r) * 0.085;
        float ang = atan(vP.y, vP.x);
        float dash = step(0.15, sin(ang * 22.0 + uTime * 2.2));
        float mid = smoothstep(0.66, 0.70, r) * (1.0 - smoothstep(0.74, 0.78, r));
        float pulse = 0.82 + 0.24 * sin(uTime * 5.2);
        float a = (ring * 1.7 + fill + dash * mid * 0.8) * pulse;
        gl_FragColor = vec4(uColor * (a * 2.4), a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 56), discMat)
  disc.rotation.x = -Math.PI / 2
  disc.frustumCulled = false
  disc.renderOrder = 10

  group.add(dashes, disc)
  arcSingleton = { group, dashes, disc, discMat }
  return arcSingleton
}
