'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { FRAME_PRIO } from '@/game/constants'
import { crateMaterial, darkMetalMaterial } from '@/game/gfx/materials'
import { seededRandom } from '@/game/gfx/textures'
import { useGame } from '@/game/store'
import type { Obstacle } from '@/game/types'
import { world } from '@/game/world'
import {
  bevelBox, jerseyGeometry, pillarBandGeometry, pillarGeometry, pillarGlowGeometry, rackGeometry,
} from './Arena.geo'
import { concreteMaps, hazardStripeTexture, puffTexture } from './Arena.textures'

// Obstacle cover: jersey barriers, stacked crates, dead server racks, wide low
// pillars. Registers AABBs on world (yaw 0 — collision honesty), renders with
// modeled relief via shared instanced meshes, plays a sink+tilt collapse with
// dust puffs when an obstacle's alive flag drops (boss floor smash).

const BARRIER_LEN = 3.4
const CRATE = 1.05
const COLLAPSE_TIME = 0.85

type ClusterId = 'c2' | 'c3' | 'c4'

// per-crate offsets within a cluster: [x, y, z, yaw]
const CLUSTERS: Record<ClusterId, ReadonlyArray<readonly [number, number, number, number]>> = {
  c2: [[0, 0.525, 0, 0.10], [0.03, 1.575, -0.02, 0.52]],
  c3: [[-0.56, 0.525, 0.02, 0.06], [0.56, 0.525, -0.04, -0.08], [0.02, 1.575, 0, 0.42]],
  c4: [
    [-0.56, 0.525, 0.63, 0.05], [0.58, 0.525, 0.60, -0.10],
    [0.02, 1.575, 0.63, 0.30], [0.05, 0.525, -0.47, 0.66],
  ],
}
const CLUSTER_HALF: Record<ClusterId, readonly [number, number, number]> = {
  c2: [0.72, 1.06, 0.72],
  c3: [1.09, 1.06, 0.70],
  c4: [1.11, 1.06, 1.18],
}

interface Spec {
  kind: Obstacle['kind']
  x: number
  z: number
  /** visual quarter-turn (0 or ±π/2); AABB half extents are swapped to match */
  quarter?: boolean
  cluster?: ClusterId
}

// Ring of cover at mid-radius + a few near center; spawn (0,0,10) kept clear.
const SPECS: Spec[] = [
  { kind: 'pillar', x: 0, z: -20 },
  { kind: 'pillar', x: -19, z: 8 },
  { kind: 'pillar', x: 20, z: 6 },
  { kind: 'pillar', x: 10, z: 24 },
  { kind: 'barrier', x: -6, z: 2, quarter: true },
  { kind: 'barrier', x: 7, z: -3 },
  { kind: 'barrier', x: -14, z: -14 },
  { kind: 'barrier', x: 16, z: -16, quarter: true },
  { kind: 'barrier', x: -24, z: -4, quarter: true },
  { kind: 'crate', x: 4, z: 6, cluster: 'c3' },
  { kind: 'crate', x: -10, z: 14, cluster: 'c2' },
  { kind: 'crate', x: 13, z: 13, cluster: 'c4' },
  { kind: 'crate', x: -3, z: -10, cluster: 'c2' },
  { kind: 'rack', x: 22, z: -6, quarter: true },
  { kind: 'rack', x: -17, z: -20, quarter: true },
  { kind: 'rack', x: -25, z: 12, quarter: true },
]

function halfFor(spec: Spec): [number, number, number] {
  let h: [number, number, number]
  if (spec.kind === 'barrier') h = [BARRIER_LEN / 2 + 0.03, 0.55, 0.43]
  else if (spec.kind === 'crate') h = [...CLUSTER_HALF[spec.cluster ?? 'c2']] as [number, number, number]
  else if (spec.kind === 'rack') h = [0.62, 1.08, 0.48]
  else h = [1.42, 0.84, 1.42]
  if (spec.quarter) h = [h[2], h[1], h[0]]
  return h
}

interface Part { im: THREE.InstancedMesh; idx: number; base: THREE.Matrix4 }

interface Rec {
  spec: Spec
  half: [number, number, number]
  ob: Obstacle | null
  parts: Part[]
  axis: THREE.Vector3
  delay: number
  t: number
  dying: boolean
  puffed: boolean
  gone: boolean
}

const PUFF_N = 80

const _m = new THREE.Matrix4()
const _mA = new THREE.Matrix4()
const _mB = new THREE.Matrix4()
const _mR = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _h = new THREE.Vector3()
const _s = new THREE.Vector3()
const _e = new THREE.Euler()
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0)

function buildObstacles() {
  const group = new THREE.Group()
  const rnd = seededRandom(20260830)

  const concrete = concreteMaps()
  const concreteMat = new THREE.MeshStandardMaterial({
    map: concrete.map, normalMap: concrete.normalMap, roughnessMap: concrete.roughnessMap,
    roughness: 1.0, metalness: 0.03, normalScale: new THREE.Vector2(1, 1),
    color: 0x9aa1ac, // night tint — keep concrete dusty, not bone-white
  })
  const stripeMat = new THREE.MeshStandardMaterial({
    map: hazardStripeTexture(), roughness: 0.85, metalness: 0.25,
  })
  const glowMat = new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide })
  glowMat.color.setRGB(1.7, 0.55, 0.12)

  const counts = { barrier: 0, crate: 0, rack: 0, pillar: 0 }
  for (const s of SPECS) {
    if (s.kind === 'crate') counts.crate += CLUSTERS[s.cluster ?? 'c2'].length
    else counts[s.kind]++
  }

  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, shadows = true) => {
    const im = new THREE.InstancedMesh(geo, mat, n)
    im.frustumCulled = false
    im.castShadow = shadows
    im.receiveShadow = shadows
    group.add(im)
    return im
  }
  const barrierIM = mk(jerseyGeometry(BARRIER_LEN), concreteMat, counts.barrier)
  const crateIM = mk(bevelBox(CRATE, CRATE, CRATE, 0.045, 1 / CRATE), crateMaterial(), counts.crate)
  const rackIM = mk(rackGeometry(), darkMetalMaterial(), counts.rack)
  const pillarIM = mk(pillarGeometry(), concreteMat, counts.pillar)
  const bandIM = mk(pillarBandGeometry(), stripeMat, counts.pillar, false)
  bandIM.receiveShadow = true
  const glowIM = mk(pillarGlowGeometry(), glowMat, counts.pillar, false)

  // dead-rack LED strip: instanced shader plane, per-instance seed blink
  const ledGeo = new THREE.PlaneGeometry(0.34, 1.05)
  const ledSeeds = new Float32Array(counts.rack)
  for (let i = 0; i < counts.rack; i++) ledSeeds[i] = i * 17.13 + 3.7
  ledGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(ledSeeds, 1))
  const ledMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec2 vUv; varying float vSeed;
      void main() {
        vUv = uv; vSeed = aSeed;
        #ifdef USE_INSTANCING
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        #else
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #endif
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv; varying float vSeed;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 grid = vec2(3.0, 12.0);
        vec2 cell = floor(vUv * grid);
        vec2 f = fract(vUv * grid) - 0.5;
        float d = length(f * vec2(1.4, 1.0));
        float dotM = 1.0 - smoothstep(0.14, 0.30, d);
        float h = hash(cell + vSeed);
        float on = step(0.78, h);
        float blink = 0.25 + 0.75 * step(0.45, hash(cell + vSeed + floor(uTime * (0.6 + h * 2.2))));
        vec3 led = mix(vec3(1.5, 0.6, 0.12), vec3(0.25, 1.6, 0.55), step(0.92, h));
        vec3 base = vec3(0.015, 0.018, 0.024);
        gl_FragColor = vec4(base + led * dotM * on * blink, 1.0);
      }`,
  })
  const ledIM = mk(ledGeo, ledMat, counts.rack, false)

  // collapse dust puffs: pooled instanced billboards
  const puffGeo = new THREE.PlaneGeometry(1, 1)
  const puffBirth = new Float32Array(PUFF_N).fill(-100)
  const puffSeed = new Float32Array(PUFF_N)
  for (let i = 0; i < PUFF_N; i++) puffSeed[i] = rnd()
  const aBirth = new THREE.InstancedBufferAttribute(puffBirth, 1)
  aBirth.setUsage(THREE.DynamicDrawUsage)
  puffGeo.setAttribute('aBirth', aBirth)
  puffGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(puffSeed, 1))
  const puffMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: puffTexture() },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */ `
      attribute float aBirth;
      attribute float aSeed;
      uniform float uTime; uniform vec3 uCamRight; uniform vec3 uCamUp;
      varying vec2 vUv; varying float vFade;
      void main() {
        vUv = uv;
        float life = 1.2 + aSeed * 0.6;
        float age = uTime - aBirth;
        float t = clamp(age / life, 0.0, 1.0);
        vFade = (1.0 - t) * (1.0 - t) * step(0.0, age) * (1.0 - step(0.999, t));
        float scale = mix(0.55, 2.1, sqrt(max(t, 0.0)));
        #ifdef USE_INSTANCING
          vec3 origin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float baseS = length(instanceMatrix[0].xyz);
        #else
          vec3 origin = vec3(0.0);
          float baseS = 1.0;
        #endif
        vec3 wp = origin + (uCamRight * position.x + uCamUp * position.y) * baseS * scale;
        wp.y += t * (0.7 + aSeed * 0.9);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv; varying float vFade;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        vec3 col = vec3(0.40, 0.38, 0.34) * (0.65 + 0.35 * vUv.y);
        gl_FragColor = vec4(col, t.a * vFade * 0.8);
      }`,
  })
  const puffIM = new THREE.InstancedMesh(puffGeo, puffMat, PUFF_N)
  puffIM.frustumCulled = false
  puffIM.renderOrder = 3
  puffIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  group.add(puffIM)

  // ── Records + base matrices ────────────────────────────────────────────────
  const records: Rec[] = []
  const cursors = { barrier: 0, crate: 0, rack: 0, pillar: 0 }
  const baseAt = (x: number, z: number, yaw: number, ox = 0, oy = 0, oz = 0, oyaw = 0) => {
    _q.setFromEuler(_e.set(0, yaw, 0))
    _m.compose(_p.set(x, 0, z), _q, _s.set(1, 1, 1))
    if (ox || oy || oz || oyaw) {
      _q.setFromEuler(_e.set(0, oyaw, 0))
      _mA.compose(_p.set(ox, oy, oz), _q, _s.set(1, 1, 1))
      _m.multiply(_mA)
    }
    return _m.clone()
  }
  for (const spec of SPECS) {
    const yaw = spec.quarter ? Math.PI / 2 : 0
    const parts: Part[] = []
    if (spec.kind === 'barrier') {
      parts.push({ im: barrierIM, idx: cursors.barrier++, base: baseAt(spec.x, spec.z, yaw) })
    } else if (spec.kind === 'crate') {
      for (const [ox, oy, oz, oyaw] of CLUSTERS[spec.cluster ?? 'c2']) {
        parts.push({
          im: crateIM, idx: cursors.crate++,
          base: baseAt(spec.x, spec.z, 0, ox, oy - CRATE / 2, oz, oyaw),
        })
      }
    } else if (spec.kind === 'rack') {
      const idx = cursors.rack++
      parts.push({ im: rackIM, idx, base: baseAt(spec.x, spec.z, yaw) })
      parts.push({ im: ledIM, idx, base: baseAt(spec.x, spec.z, yaw, -0.03, 1.62, 0.468) })
    } else {
      const idx = cursors.pillar++
      const base = baseAt(spec.x, spec.z, 0)
      parts.push({ im: pillarIM, idx, base })
      parts.push({ im: bandIM, idx, base: base.clone() })
      parts.push({ im: glowIM, idx, base: base.clone() })
    }
    const a = rnd() * Math.PI * 2
    records.push({
      spec, half: halfFor(spec), ob: null, parts,
      axis: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
      delay: rnd() * 0.35, t: 0, dying: false, puffed: false, gone: false,
    })
  }

  const allIMs = [barrierIM, crateIM, rackIM, pillarIM, bandIM, glowIM, ledIM]
  return { group, records, allIMs, puffIM, puffMat, ledMat, aBirth, puffSeed }
}

type Built = ReturnType<typeof buildObstacles>

function register(b: Built) {
  for (const rec of b.records) {
    const [hx, hy, hz] = rec.half
    rec.ob = world.addObstacle({
      pos: _p.set(rec.spec.x, hy, rec.spec.z),
      half: _h.set(hx, hy, hz),
      yaw: 0,
      kind: rec.spec.kind,
      alive: true,
    })
    rec.dying = false
    rec.puffed = false
    rec.gone = false
    rec.t = 0
    for (const part of rec.parts) part.im.setMatrixAt(part.idx, part.base)
  }
  for (const im of b.allIMs) im.instanceMatrix.needsUpdate = true
}

function resetPuffs(b: Built) {
  for (let i = 0; i < PUFF_N; i++) b.aBirth.setX(i, -100)
  b.aBirth.needsUpdate = true
}

export function ArenaObstacles() {
  const built = useMemo(buildObstacles, [])
  const runId = useGame((s) => s.runId)
  const t = useRef(0)
  const puffCursor = useRef(0)

  const spawnPuff = (x: number, y: number, z: number, scale: number) => {
    const b = built
    const i = puffCursor.current
    puffCursor.current = (i + 1) % PUFF_N
    _q.identity()
    b.puffIM.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(scale, scale, scale)))
    b.aBirth.setX(i, t.current)
    b.puffIM.instanceMatrix.needsUpdate = true
    b.aBirth.needsUpdate = true
  }

  // one-frame-delayed (re)registration on mount + restart, after Director's world.reset
  useEffect(() => {
    const id = setTimeout(() => {
      const r0 = built.records[0]
      if (!r0.ob || !world.obstacles.includes(r0.ob)) register(built)
      resetPuffs(built)
    }, 0)
    return () => clearTimeout(id)
  }, [runId, built])

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.05)
    t.current += step
    const b = built
    b.ledMat.uniforms.uTime.value = t.current
    b.puffMat.uniforms.uTime.value = t.current
    const cam = state.camera
    ;(b.puffMat.uniforms.uCamRight.value as THREE.Vector3)
      .setFromMatrixColumn(cam.matrixWorld, 0).normalize()
    ;(b.puffMat.uniforms.uCamUp.value as THREE.Vector3)
      .setFromMatrixColumn(cam.matrixWorld, 1).normalize()

    // self-heal registration: Director's world.reset empties world.obstacles;
    // re-register while the run is in a pre-smash phase (never during boss).
    const phase = useGame.getState().phase
    const r0 = b.records[0]
    if (
      (phase === 'menu' || phase === 'wave' || phase === 'buffSelect') &&
      (!r0.ob || !world.obstacles.includes(r0.ob))
    ) {
      register(b)
      resetPuffs(b)
    }

    // destruction: collapse (sink + tilt) then hide, with dust puffs
    let touched = false
    for (const rec of b.records) {
      if (rec.gone || !rec.ob) continue
      if (!rec.ob.alive && !rec.dying) {
        rec.dying = true
        rec.t = -rec.delay
      }
      if (!rec.dying) continue
      rec.t += step
      if (rec.t < 0) continue
      if (!rec.puffed) {
        rec.puffed = true
        const [hx, , hz] = rec.half
        const s = Math.min(2.2, Math.max(0.8, Math.max(hx, hz) * 1.1))
        spawnPuff(rec.spec.x, 0.5, rec.spec.z, s * 1.25)
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          spawnPuff(rec.spec.x + sx * hx * 0.8, 0.35, rec.spec.z + sz * hz * 0.8, s)
        }
      }
      const p = Math.min(1, rec.t / COLLAPSE_TIME)
      const ease = p * p
      const sink = (rec.half[1] * 2 + 0.5) * ease
      const cx = rec.spec.x, cz = rec.spec.z
      _q.setFromAxisAngle(rec.axis, 0.32 * ease)
      _mR.makeRotationFromQuaternion(_q)
      _mA.makeTranslation(-cx, 0, -cz)
      _mB.makeTranslation(cx, -sink, cz)
      for (const part of rec.parts) {
        if (p >= 1) {
          part.im.setMatrixAt(part.idx, ZERO_M)
        } else {
          _m.copy(part.base).premultiply(_mA).premultiply(_mR).premultiply(_mB)
          part.im.setMatrixAt(part.idx, _m)
        }
      }
      if (p >= 1) rec.gone = true
      touched = true
    }
    if (touched) {
      for (const im of b.allIMs) im.instanceMatrix.needsUpdate = true
    }
  }, FRAME_PRIO.vfx)

  return <primitive object={built.group} />
}
