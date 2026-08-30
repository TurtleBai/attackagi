'use client'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { bossHullMaterial, darkMetalMaterial, emissiveMaterial, glowMetal } from '@/game/gfx/materials'
import { seededRandom } from '@/game/gfx/textures'

// ─── AGI model construction ──────────────────────────────────────────────────
// Builds the whole boss once: chamfered monitor head + CRT screen, greebled
// torso with reactor core, two telescoping arms with articulated 4-finger
// hands that can morph into miniguns / a death-beam cannon, death debris.
// Everything animatable is returned as a rig of refs; Agi.tsx drives it.
//
// Draw-call budget: static sub-parts are pre-merged into one mesh per material
// family (head greebles, torso hull, torso machinery), and articulated-but-
// identical parts are instanced (arm segments L/R with pistons baked in,
// collars, cable loops, shoulders, finger phalanges, cargo bots, LEDs,
// sparks). Per-frame instanceMatrix/instanceColor attributes use
// DynamicDrawUsage; counts are sized once and limited via .count.
// Shadow casters are limited to: head casing, torso block, arm segments,
// hands (cuff/palm/fingers) — never greebles or glow.

export const HEAD_CENTER = new THREE.Vector3(0, 27, -64)
export const HEAD_RADIUS = 8.2
export const ARM_SEGMENTS = 7
export const SHOULDER_LOCAL: readonly [THREE.Vector3, THREE.Vector3] = [
  new THREE.Vector3(-13.5, 19.2, -69.5),
  new THREE.Vector3(13.5, 19.2, -69.5),
]
/** radius of arm segment i (root → wrist) */
export const SEG_RADIUS: number[] = []
for (let i = 0; i < ARM_SEGMENTS; i++) SEG_RADIUS.push(1.5 - 0.145 * i)

// ─── small geometry helpers ──────────────────────────────────────────────────

function scaleUVs(geo: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s)
  return geo
}

/** Chamfered box (w×h×d) with bevel radius r — real modeled edge relief. */
function chamferBoxGeo(w: number, h: number, d: number, r: number, uvScale = 0.14): THREE.BufferGeometry {
  const hw = Math.max(0.01, w / 2 - r)
  const hh = Math.max(0.01, h / 2 - r)
  const shape = new THREE.Shape()
  shape.moveTo(-hw, -hh)
  shape.lineTo(hw, -hh)
  shape.lineTo(hw, hh)
  shape.lineTo(-hw, hh)
  shape.closePath()
  const depth = Math.max(0.01, d - 2 * r)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: r,
    bevelSize: r,
    bevelSegments: 2,
    curveSegments: 4,
  })
  geo.translate(0, 0, -depth / 2)
  geo.computeVertexNormals()
  return scaleUVs(geo, uvScale)
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.castShadow = shadow
  m.receiveShadow = shadow
  return m
}

// build-time scratch for baking transforms into geometry
const _bakeM = new THREE.Matrix4()
const _bakeQ = new THREE.Quaternion()
const _bakeE = new THREE.Euler()
const _bakeP = new THREE.Vector3()
const _bakeS = new THREE.Vector3()

/**
 * Bake a T·R(EulerXYZ)·S transform into a geometry (build-time only; mutates
 * and returns it). Matches Object3D position/rotation/scale composition, so
 * merged parts land exactly where their old child meshes sat.
 */
function placed(
  geo: THREE.BufferGeometry, x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx,
): THREE.BufferGeometry {
  _bakeQ.setFromEuler(_bakeE.set(rx, ry, rz))
  _bakeM.compose(_bakeP.set(x, y, z), _bakeQ, _bakeS.set(sx, sy, sz))
  geo.applyMatrix4(_bakeM)
  return geo
}

/** Merge geometries into one draw (build-time; normalizes index-ness). */
function merged(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g))
  return mergeGeometries(parts, false) ?? parts[0]
}

/** Diagonal hazard chevron strip texture (own seeded canvas, same worn family). */
function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 32
  const ctx = c.getContext('2d')!
  const rnd = seededRandom(6021)
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 128; x++) {
      const stripe = Math.floor((x + y) / 12) % 2 === 0
      const wear = rnd()
      if (stripe) {
        const v = 175 + wear * 45
        ctx.fillStyle = `rgb(${v | 0},${(v * 0.72) | 0},${(v * 0.1) | 0})`
      } else {
        const v = 22 + wear * 16
        ctx.fillStyle = `rgb(${v | 0},${v | 0},${(v + 3) | 0})`
      }
      ctx.fillRect(x, y, 1, 1)
    }
  }
  // scratches down to grey metal
  ctx.fillStyle = 'rgb(120,122,128)'
  for (let i = 0; i < 60; i++) ctx.fillRect((rnd() * 128) | 0, (rnd() * 32) | 0, 1 + ((rnd() * 3) | 0), 1)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(3, 1)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

// ─── reactor core shader ─────────────────────────────────────────────────────

const REACTOR_FRAG = /* glsl */ `
uniform float uTime;
uniform float uHeat;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float spokes = 0.72 + 0.28 * sin(a * 6.0 - uTime * 1.35);
  float core = smoothstep(0.6, 0.0, r);
  float ring = smoothstep(0.07, 0.0, abs(r - 0.78));
  float pulse = 0.8 + 0.25 * sin(uTime * 2.2) + 0.06 * sin(uTime * 9.1);
  vec3 col = vec3(1.0, 0.42, 0.14) * (core * 1.7 * spokes + ring * 1.5) * pulse * uHeat;
  col += vec3(1.0, 0.82, 0.5) * smoothstep(0.24, 0.0, r) * 2.4 * pulse * uHeat;
  float alpha = clamp(core * 1.5 + ring, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`

const BEAM_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  float stripes = 0.72 + 0.28 * sin(vUv.y * 46.0 - uTime * 34.0);
  float endFade = smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);
  vec3 col = uColor * uIntensity * stripes;
  gl_FragColor = vec4(col, 0.85 * endFade);
}
`

const PLAIN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// ─── rig interfaces ──────────────────────────────────────────────────────────

export interface FingerRig {
  /** transform-only groups; the phalanx meshes live in AgiRig.fingerLevels instances */
  root: THREE.Group
  mid: THREE.Group
  tip: THREE.Group
}

export interface HandRig {
  group: THREE.Group
  fingers: FingerRig[]
  minigun: { group: THREE.Group; spinner: THREE.Group; flashMat: THREE.MeshBasicMaterial }
  cannon: { group: THREE.Group; charge: THREE.Mesh; chargeMat: THREE.MeshBasicMaterial }
  cargo: THREE.Group
  /** dummy-robot bodies/eyes; show n bots by setting .count on both */
  cargoBodies: THREE.InstancedMesh
  cargoEyes: THREE.InstancedMesh
}

export interface ArmRig {
  group: THREE.Group
  hand: HandRig
}

export interface AgiRig {
  root: THREE.Group
  model: THREE.Group
  bob: THREE.Group
  head: THREE.Group
  arms: [ArmRig, ArmRig]
  /** per-segment-index instanced meshes (2 instances: arm L/R); piston rod baked in */
  segs: THREE.InstancedMesh[]
  /** joint collars, 2×(ARM_SEGMENTS−1) instances (unit radius; xz-scaled per joint) */
  collars: THREE.InstancedMesh
  /** cable loop rings on every other collar, 2×3 instances */
  loops: THREE.InstancedMesh
  /** shoulder spheres, 2 instances */
  shoulders: THREE.InstancedMesh
  /** finger phalanx levels (root/mid/tip), 8 instances each (2 hands × 4 fingers) */
  fingerLevels: [THREE.InstancedMesh, THREE.InstancedMesh, THREE.InstancedMesh]
  reactorMat: THREE.ShaderMaterial
  fan: THREE.Group
  /** blinking LEDs, driven via instanceColor on their shared instanced meshes */
  leds: { mesh: THREE.InstancedMesh; index: number; base: THREE.Color; phase: number }[]
  ledMeshes: THREE.InstancedMesh[]
  sparks: { group: THREE.Group; inst: THREE.InstancedMesh }[]
  beam: { group: THREE.Group; core: THREE.Mesh; sheath: THREE.Mesh; sheathMat: THREE.ShaderMaterial; impact: THREE.Mesh; impactMat: THREE.MeshBasicMaterial }
  debris: { group: THREE.Group; chunks: THREE.Mesh[] }
}

// ─── build ───────────────────────────────────────────────────────────────────

export function buildAgiRig(screenMaterial: THREE.ShaderMaterial): AgiRig {
  const hull = bossHullMaterial()
  const dark = darkMetalMaterial()

  const root = new THREE.Group()
  const model = new THREE.Group()
  root.add(model)
  const bob = new THREE.Group()
  model.add(bob)

  // Generous fixed bounds for world-space-instanced arm parts: the arms sweep
  // the whole arena, so a static sphere avoids stale per-instance recomputes
  // while still letting the renderer cull the boss when the player faces away.
  const armBounds = () => new THREE.Sphere(new THREE.Vector3(0, 15, -20), 100)

  // ── HEAD: giant retro monitor ─────────────────────────────────────────────
  const head = new THREE.Group()
  head.position.copy(HEAD_CENTER)
  bob.add(head)

  const casing = mesh(chamferBoxGeo(16, 11, 8, 0.55), hull) // shadow caster
  casing.position.z = -0.35
  head.add(casing)

  // every static dark greeble of the head → ONE mesh:
  // bezel frame ×4, antennas ×2, brand plate, handle, 20 vent fins
  {
    const parts: THREE.BufferGeometry[] = []
    parts.push(placed(chamferBoxGeo(13.8, 1.0, 1.1, 0.2), 0, 4.35, 3.9))
    parts.push(placed(chamferBoxGeo(13.8, 1.0, 1.1, 0.2), 0, -4.35, 3.9))
    parts.push(placed(chamferBoxGeo(1.0, 7.9, 1.1, 0.2), -6.4, 0, 3.9))
    parts.push(placed(chamferBoxGeo(1.0, 7.9, 1.1, 0.2), 6.4, 0, 3.9))
    for (const sx of [-1, 1]) {
      parts.push(placed(new THREE.CylinderGeometry(0.06, 0.11, 3.6, 6), sx * 5.4, 7.2, -1.5, 0, 0, -sx * 0.14))
    }
    parts.push(placed(chamferBoxGeo(4.2, 0.8, 0.3, 0.1), 0, -4.6, 4.05))
    parts.push(placed(chamferBoxGeo(6, 0.7, 1.4, 0.25), 0, 5.85, -1.5))
    for (const sx of [-1, 1]) {
      for (let f = 0; f < 10; f++) {
        parts.push(placed(new THREE.BoxGeometry(0.5, 0.28, 5.4), sx * 8.05, -3.4 + f * 0.76, -0.6, 0, 0, sx * 0.12))
      }
    }
    const headGreebles = mesh(merged(parts), dark, false)
    headGreebles.receiveShadow = true
    head.add(headGreebles)
  }

  // recessed CRT screen
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(12.4, 7.9), screenMaterial)
  screen.position.set(0, 0, 3.72)
  head.add(screen)

  // ── blinking LEDs: instanced, colors animated via instanceColor ──────────
  const ledMat = new THREE.MeshBasicMaterial({ toneMapped: false })
  const leds: AgiRig['leds'] = []
  const ledMeshes: THREE.InstancedMesh[] = []
  const ledInstanced = (
    geo: THREE.BufferGeometry, parent: THREE.Object3D,
    entries: { x: number; y: number; z: number; color: THREE.ColorRepresentation; phase: number }[],
  ): void => {
    const im = new THREE.InstancedMesh(geo, ledMat, entries.length)
    entries.forEach((e, i) => {
      _bakeM.makeTranslation(e.x, e.y, e.z)
      im.setMatrixAt(i, _bakeM)
      const base = new THREE.Color(e.color).multiplyScalar(2.2)
      im.setColorAt(i, base)
      leds.push({ mesh: im, index: i, base, phase: e.phase })
    })
    im.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    parent.add(im)
    ledMeshes.push(im)
  }
  // antenna tips (children of the head so they turn with it)
  ledInstanced(new THREE.SphereGeometry(0.24, 8, 8), head, [
    { x: -5.65, y: 9.0, z: -1.5, color: 0xff4444, phase: 0 },
    { x: 5.65, y: 9.0, z: -1.5, color: 0x44ff88, phase: 1.4 },
  ])

  // ── BODY hull: torso block + shoulder blocks → ONE mesh (shadow caster) ──
  const torsoHull = mesh(merged([
    placed(chamferBoxGeo(24, 13, 12, 0.8, 0.1), 0, 14.6, -70.5),
    placed(chamferBoxGeo(7.5, 7, 8.5, 0.7), -13.2, 18.6, -70),
    placed(chamferBoxGeo(7.5, 7, 8.5, 0.7), 13.2, 18.6, -70),
  ]), hull)
  bob.add(torsoHull)

  // every static dark part of the body → ONE mesh: neck, head/body cables,
  // shoulder caps, reactor ring+back, under-hull cone, fan rim, 56 greebles
  {
    const parts: THREE.BufferGeometry[] = []
    parts.push(placed(new THREE.CylinderGeometry(2.4, 3.4, 3.6, 12), 0, 21.2, -66.4))
    for (let i = 0; i < 4; i++) {
      const sx = i < 2 ? -1 : 1
      const k = i % 2
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(sx * (1.6 + k * 1.2), 22.0, -65.2),
        new THREE.Vector3(sx * (3.0 + k * 1.6), 20.4, -67.2 - k * 0.8),
        new THREE.Vector3(sx * (3.6 + k * 1.4), 18.6, -69.0),
      ])
      parts.push(new THREE.TubeGeometry(curve, 10, 0.24 + k * 0.08, 7))
    }
    for (const sx of [-1, 1]) {
      parts.push(placed(new THREE.CylinderGeometry(2.9, 2.9, 1.1, 14), sx * 16.6, 19.2, -69.5, 0, 0, Math.PI / 2))
    }
    parts.push(placed(new THREE.TorusGeometry(2.7, 0.55, 10, 24), 0, 14.6, -64.25))
    parts.push(placed(new THREE.CircleGeometry(2.7, 24), 0, 14.6, -64.35))
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(sx * (11.0 - k * 1.6), 12.5, -66.5 - k * 2.2),
          new THREE.Vector3(sx * (13.4 - k * 1.2), 8.6, -68.5 - k * 1.6),
          new THREE.Vector3(sx * (9.5 - k * 1.0), 6.2, -71.0),
        ])
        parts.push(new THREE.TubeGeometry(curve, 12, 0.42 - k * 0.1, 8))
      }
    }
    parts.push(placed(new THREE.ConeGeometry(8.2, 6.5, 14), 0, 5.4, -70.5, Math.PI))
    // fan rim: rotationally symmetric around the fan axis, so it can live here
    parts.push(placed(new THREE.TorusGeometry(1.7, 0.22, 8, 18), 12.15, 15.5, -73, 0, Math.PI / 2, 0))
    // greebled machinery boxes over torso top/back/shoulders (same seeded layout)
    const grnd = seededRandom(9182)
    for (let i = 0; i < 56; i++) {
      const zone = grnd()
      let x: number, y: number, z: number
      if (zone < 0.5) {
        x = (grnd() - 0.5) * 20; y = 21.2 + grnd() * 0.9; z = -70.5 + (grnd() - 0.5) * 9
      } else if (zone < 0.8) {
        x = (grnd() - 0.5) * 21; y = 11 + grnd() * 7; z = -76.6 - grnd() * 0.8
      } else {
        const sx = grnd() < 0.5 ? -1 : 1
        x = sx * (11 + grnd() * 4.5); y = 22.2 + grnd() * 0.6; z = -70 + (grnd() - 0.5) * 6
      }
      const ry = grnd() * Math.PI
      parts.push(placed(new THREE.BoxGeometry(1, 1, 1), x, y, z, 0, ry, 0,
        0.7 + grnd() * 2.4, 0.5 + grnd() * 1.7, 0.7 + grnd() * 2.2))
    }
    const bodyGreebles = mesh(merged(parts), dark, false)
    bodyGreebles.receiveShadow = true
    bob.add(bodyGreebles)
  }

  // reactor core: additive shader disc (housing merged into the body mesh above)
  const reactorMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeat: { value: 1 } },
    vertexShader: PLAIN_VERT,
    fragmentShader: REACTOR_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const reactorCore = new THREE.Mesh(new THREE.CircleGeometry(2.45, 24), reactorMat)
  reactorCore.position.set(0, 14.6, -64.1)
  bob.add(reactorCore)

  // warning chevron band under the reactor
  const chevMat = new THREE.MeshStandardMaterial({
    map: chevronTexture(),
    roughness: 0.85,
    metalness: 0.2,
  })
  const chev = mesh(new THREE.BoxGeometry(18, 1.3, 0.35), chevMat, false)
  chev.position.set(0, 9.4, -64.35)
  bob.add(chev)

  // engine glow under the hull cone
  const engineGlowMat = emissiveMaterial(0x3a6bff, 0.85)
  engineGlowMat.color.multiplyScalar(1.6)
  const engineGlow = new THREE.Mesh(new THREE.CircleGeometry(3.2, 18), engineGlowMat)
  engineGlow.rotation.x = Math.PI / 2
  engineGlow.position.set(0, 3.1, -70.5)
  bob.add(engineGlow)

  // cooling fan blades (spin as a unit → one merged mesh in the rotating group)
  const fan = new THREE.Group()
  fan.position.set(12.15, 15.5, -73)
  {
    const parts: THREE.BufferGeometry[] = []
    for (let b = 0; b < 5; b++) {
      const a = (b / 5) * Math.PI * 2
      parts.push(placed(new THREE.BoxGeometry(0.08, 0.55, 1.5), 0, Math.sin(a) * 0.8, Math.cos(a) * 0.8, a, 0, 0.5))
    }
    fan.add(mesh(merged(parts), dark, false))
  }
  bob.add(fan)

  // status LEDs across the torso front (instanced, same blink contract)
  const ledColors: THREE.ColorRepresentation[] = [0xff5533, 0x44ff88, 0x33aaff, 0xffcc44, 0x44ff88]
  ledInstanced(new THREE.BoxGeometry(0.35, 0.35, 0.2), bob,
    ledColors.map((color, i) => ({ x: -9 + i * 1.1, y: 20.2, z: -64.4, color, phase: i * 0.9 })))

  // ── ARMS: instanced articulation ──────────────────────────────────────────
  // Segment i (unit height, scaled y=len per frame) with its piston rod baked
  // in at a fixed local azimuth (rod height 0.8 → world 0.8·len, as before).
  const segs: THREE.InstancedMesh[] = []
  for (let i = 0; i < ARM_SEGMENTS; i++) {
    const segCyl = new THREE.CylinderGeometry(Math.max(0.4, SEG_RADIUS[i] - 0.05), SEG_RADIUS[i], 1, 12, 1)
    const rod = new THREE.CylinderGeometry(0.13, 0.13, 0.8, 6)
    rod.translate(SEG_RADIUS[i] * 0.85, 0, 0)
    const im = new THREE.InstancedMesh(merged([segCyl, rod]), dark, 2)
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    im.castShadow = true // arm segments cast
    im.receiveShadow = true
    im.boundingSphere = armBounds()
    model.add(im)
    segs.push(im)
  }

  const mkArmInstanced = (geo: THREE.BufferGeometry, count: number): THREE.InstancedMesh => {
    const im = new THREE.InstancedMesh(geo, dark, count)
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    im.receiveShadow = true
    im.boundingSphere = armBounds()
    model.add(im)
    return im
  }
  // joint collars: unit radius, height baked; xz-scaled to SEG_RADIUS[i]+0.24
  const collars = mkArmInstanced(new THREE.CylinderGeometry(1, 1, 0.62, 12), 2 * (ARM_SEGMENTS - 1))
  // cable loop rings hugging every other collar (uniform scale SEG_RADIUS[i]+0.3)
  const loopGeo = new THREE.TorusGeometry(1, 0.07, 6, 14)
  loopGeo.rotateX(Math.PI / 2)
  const loops = mkArmInstanced(loopGeo, 2 * 3)
  const shoulders = mkArmInstanced(new THREE.SphereGeometry(2.15, 16, 12), 2)

  // finger phalanx levels: identical geometry across 2 hands × 4 fingers →
  // 3 instanced meshes (root/mid/tip), matrices synced from the finger groups
  const mkFingerLevel = (ph: THREE.BufferGeometry, py: number, knuckleScale: number): THREE.InstancedMesh => {
    const knuckle = new THREE.SphereGeometry(0.32, 8, 8)
    const geo = merged([placed(ph, 0, py, 0), placed(knuckle, 0, 0, 0, 0, 0, 0, knuckleScale)])
    const im = new THREE.InstancedMesh(geo, dark, 8)
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    im.castShadow = true // part of the hands
    im.receiveShadow = true
    im.boundingSphere = armBounds()
    model.add(im)
    return im
  }
  const fingerLevels: AgiRig['fingerLevels'] = [
    mkFingerLevel(chamferBoxGeo(0.52, 1.1, 0.56, 0.1, 0.8), 0.55, 1),
    mkFingerLevel(chamferBoxGeo(0.46, 0.95, 0.5, 0.09, 0.8), 0.48, 0.85),
    mkFingerLevel(chamferBoxGeo(0.4, 0.85, 0.44, 0.09, 0.8), 0.42, 0.7),
  ]

  // ── hand shared geometry/materials (built once, used by both hands) ──────
  const cuffGeo = new THREE.CylinderGeometry(0.8, 1.0, 0.95, 10)
  const palmGeo = merged([
    placed(chamferBoxGeo(3.0, 2.4, 1.2, 0.3, 0.3), 0, 1.55, 0.05),
    placed(chamferBoxGeo(2.3, 1.6, 0.45, 0.16, 0.4), 0, 1.55, 0.75),
  ])
  const palmDotGeo = new THREE.CircleGeometry(0.34, 12)
  const palmDotMat = glowMetal(0x66ddff, 1.6)

  // minigun morph: mount + one merged spinner mesh + one merged flash mesh
  const mountGeo = chamferBoxGeo(1.7, 1.3, 1.7, 0.2, 0.5)
  const spinnerGeo = (() => {
    const parts: THREE.BufferGeometry[] = []
    parts.push(placed(new THREE.CylinderGeometry(0.32, 0.32, 3.4, 8), 0, 1.6, 0))
    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * Math.PI * 2
      parts.push(placed(new THREE.CylinderGeometry(0.15, 0.17, 3.3, 7), Math.cos(a) * 0.56, 1.62, Math.sin(a) * 0.56))
    }
    parts.push(placed(new THREE.TorusGeometry(0.62, 0.11, 6, 14), 0, 3.15, 0, Math.PI / 2))
    return merged(parts)
  })()
  const flashGeo = merged([
    placed(new THREE.PlaneGeometry(1.9, 1.9), 0, 3.35, 0, Math.PI / 2),
    placed(new THREE.PlaneGeometry(1.9, 1.9), 0, 3.35, 0, Math.PI / 2, 0, Math.PI / 4),
  ])

  // death-beam cannon morph: one merged static mesh + charge sphere
  const cannonStaticGeo = (() => {
    const parts: THREE.BufferGeometry[] = []
    parts.push(placed(chamferBoxGeo(2.1, 1.7, 1.9, 0.25, 0.4), 0, 0.5, 0))
    parts.push(placed(new THREE.CylinderGeometry(0.58, 0.82, 4.8, 12), 0, 3.3, 0))
    parts.push(placed(new THREE.TorusGeometry(0.72, 0.14, 8, 16), 0, 5.65, 0, Math.PI / 2))
    for (let b = 0; b < 3; b++) {
      const a = (b / 3) * Math.PI * 2
      parts.push(placed(new THREE.BoxGeometry(0.16, 3.6, 0.7), Math.cos(a) * 0.85, 3.1, Math.sin(a) * 0.85, 0, -a, 0))
    }
    return merged(parts)
  })()
  const chargeGeo = new THREE.SphereGeometry(1, 14, 12)

  // cargo dummy robots: body+head merged (dark) + eye strip (emissive) →
  // 2 instanced draws per hand; static seeded matrices, .count shows n bots
  const botGeo = merged([
    chamferBoxGeo(0.56, 0.78, 0.4, 0.08, 1),
    placed(new THREE.BoxGeometry(0.34, 0.3, 0.32), 0, 0.56, 0),
  ])
  const eyeGeo = new THREE.BoxGeometry(0.26, 0.06, 0.05)
  const eyeMat = emissiveMaterial(0xff3344)
  eyeMat.color.multiplyScalar(2)
  const botMatrices: THREE.Matrix4[] = []
  const eyeMatrices: THREE.Matrix4[] = []
  {
    const brnd = seededRandom(311)
    const eyeLocal = new THREE.Matrix4().makeTranslation(0, 0.56, -0.18)
    for (let b = 0; b < 5; b++) {
      const px = (b - 2) * 0.62 + (brnd() - 0.5) * 0.2
      const py = -0.5 - brnd() * 0.5
      const pz = (brnd() - 0.5) * 0.4
      _bakeQ.setFromEuler(_bakeE.set((brnd() - 0.5) * 0.5, brnd() * Math.PI, (brnd() - 0.5) * 0.6))
      const m = new THREE.Matrix4().compose(_bakeP.set(px, py, pz), _bakeQ, _bakeS.set(1, 1, 1))
      botMatrices.push(m)
      eyeMatrices.push(new THREE.Matrix4().multiplyMatrices(m, eyeLocal))
    }
  }

  function buildHand(): HandRig {
    const group = new THREE.Group()
    // wrist cuff
    const cuff = mesh(cuffGeo, dark) // hands cast
    cuff.position.y = 0.25
    group.add(cuff)
    // palm + back plate (local frame: +Y fingers, -Z palm side) — one hull mesh
    const palm = mesh(palmGeo, hull) // hands cast
    group.add(palm)
    // repulsor dot in the palm
    const palmDot = new THREE.Mesh(palmDotGeo, palmDotMat)
    palmDot.rotation.x = Math.PI
    palmDot.position.set(0, 1.55, -0.62)
    group.add(palmDot)

    // fingers ×4: transform-only groups (meshes are the shared instanced levels)
    const fingers: FingerRig[] = []
    for (const fx of [-1.14, -0.38, 0.38, 1.14]) {
      const fRoot = new THREE.Group()
      fRoot.position.set(fx, 2.65, -0.05)
      const fMid = new THREE.Group()
      fMid.position.y = 1.08
      const fTip = new THREE.Group()
      fTip.position.y = 0.94
      fMid.add(fTip)
      fRoot.add(fMid)
      group.add(fRoot)
      fingers.push({ root: fRoot, mid: fMid, tip: fTip })
    }

    // ── minigun morph assembly (hidden until laser-bullets pattern) ─────────
    const minigunGroup = new THREE.Group()
    minigunGroup.position.set(0, 1.35, -0.1)
    minigunGroup.visible = false
    const mount = mesh(mountGeo, dark, false)
    mount.position.y = 0.4
    minigunGroup.add(mount)
    const spinner = new THREE.Group()
    spinner.position.y = 1.1
    spinner.add(mesh(spinnerGeo, dark, false))
    minigunGroup.add(spinner)
    const flashMat = emissiveMaterial(0xffcc66, 0)
    flashMat.color.multiplyScalar(3)
    flashMat.blending = THREE.AdditiveBlending
    flashMat.depthWrite = false
    const flash = new THREE.Mesh(flashGeo, flashMat)
    minigunGroup.add(flash)
    group.add(minigunGroup)

    // ── death-beam cannon morph assembly ────────────────────────────────────
    const cannonGroup = new THREE.Group()
    cannonGroup.position.set(0, 1.25, 0)
    cannonGroup.visible = false
    cannonGroup.add(mesh(cannonStaticGeo, dark, false))
    const chargeMat = emissiveMaterial(0xff5533, 0)
    chargeMat.color.multiplyScalar(3.4)
    chargeMat.blending = THREE.AdditiveBlending
    chargeMat.depthWrite = false
    const charge = new THREE.Mesh(chargeGeo, chargeMat)
    charge.position.y = 5.75
    charge.scale.setScalar(0.01)
    cannonGroup.add(charge)
    group.add(cannonGroup)

    // ── cargo: dummy robot silhouettes gripped in the fingers ───────────────
    const cargo = new THREE.Group()
    cargo.position.set(0, 1.9, -1.0)
    cargo.visible = false
    const cargoBodies = new THREE.InstancedMesh(botGeo, dark, 5)
    const cargoEyes = new THREE.InstancedMesh(eyeGeo, eyeMat, 5)
    for (let b = 0; b < 5; b++) {
      cargoBodies.setMatrixAt(b, botMatrices[b])
      cargoEyes.setMatrixAt(b, eyeMatrices[b])
    }
    cargoBodies.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.6, 0), 3.2)
    cargoEyes.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.6, 0), 3.2)
    cargo.add(cargoBodies, cargoEyes)
    group.add(cargo)

    return {
      group,
      fingers,
      minigun: { group: minigunGroup, spinner, flashMat },
      cannon: { group: cannonGroup, charge, chargeMat },
      cargo,
      cargoBodies,
      cargoEyes,
    }
  }

  function buildArm(): ArmRig {
    const group = new THREE.Group()
    const hand = buildHand()
    group.add(hand.group)
    return { group, hand }
  }

  const armL = buildArm()
  const armR = buildArm()
  model.add(armL.group, armR.group)

  // ── spark clusters (punch linger / tired hands): one instanced draw each ──
  const sparkGeo = new THREE.TetrahedronGeometry(0.17)
  const sparkMat = emissiveMaterial(0xffd166)
  sparkMat.color.multiplyScalar(2.6)
  const sparks: AgiRig['sparks'] = []
  for (let sI = 0; sI < 2; sI++) {
    const group = new THREE.Group()
    group.visible = false
    const inst = new THREE.InstancedMesh(sparkGeo, sparkMat, 7)
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    inst.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 6)
    group.add(inst)
    model.add(group)
    sparks.push({ group, inst })
  }

  // ── death-beam visual ─────────────────────────────────────────────────────
  const beamGroup = new THREE.Group()
  beamGroup.visible = false
  const coreMat = emissiveMaterial(0xffffff)
  coreMat.color.multiplyScalar(2.5)
  coreMat.blending = THREE.AdditiveBlending
  coreMat.depthWrite = false
  const beamCore = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1, 10, 1, true), coreMat)
  beamGroup.add(beamCore)
  const sheathMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(1.0, 0.16, 0.1) }, uIntensity: { value: 2.2 } },
    vertexShader: PLAIN_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const beamSheath = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 1, 12, 1, true), sheathMat)
  beamGroup.add(beamSheath)
  const impactMat = emissiveMaterial(0xff5533, 0.85)
  impactMat.color.multiplyScalar(2.2)
  impactMat.blending = THREE.AdditiveBlending
  impactMat.depthWrite = false
  const beamImpact = new THREE.Mesh(new THREE.CircleGeometry(3.2, 20), impactMat)
  beamImpact.rotation.x = -Math.PI / 2
  model.add(beamGroup)
  model.add(beamImpact)
  beamImpact.visible = false

  // ── death debris chunks (pooled; visible for ~3s on death only) ───────────
  const debrisGroup = new THREE.Group()
  debrisGroup.visible = false
  const chunks: THREE.Mesh[] = []
  const drnd = seededRandom(777)
  for (let i = 0; i < 8; i++) {
    const chunk = mesh(chamferBoxGeo(1.4 + drnd() * 2.6, 1.0 + drnd() * 2.0, 0.8 + drnd() * 1.8, 0.25), hull, false)
    debrisGroup.add(chunk)
    chunks.push(chunk)
  }
  root.add(debrisGroup)

  return {
    root,
    model,
    bob,
    head,
    arms: [armL, armR],
    segs,
    collars,
    loops,
    shoulders,
    fingerLevels,
    reactorMat,
    fan,
    leds,
    ledMeshes,
    sparks,
    beam: { group: beamGroup, core: beamCore, sheath: beamSheath, sheathMat, impact: beamImpact, impactMat },
    debris: { group: debrisGroup, chunks },
  }
}
