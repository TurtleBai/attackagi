'use client'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { ARENA_RADIUS, FRAME_PRIO } from '@/game/constants'
import { darkMetalMaterial } from '@/game/gfx/materials'
import { panelTextures, seededRandom } from '@/game/gfx/textures'
import { dishGeometry, parapetGeometry, scaleUvs } from './Arena.geo'
import { dotTexture, hazardStripeTexture, skylineAtlasTexture, softTexture } from './Arena.textures'

// Environment shell, batched for draw calls:
// - parapet ring: 3 instanced draws (segments / stripe plates / light bars)
// - ALL static dark framework (under-platform columns, diagonals, greeble
//   blocks, radar base+mast, antenna poles+crossbars) merged into ONE mesh
// - radar head (dish+feed+counterweight) merged into one rotating mesh
// - the 3 blinking beacons: one instanced mesh, blink computed in-shader
// - skyline: ONE instanced draw for all 90 towers — both texture variants live
//   in a single atlas, picked per-instance via an aTexSel uv offset
// - fog cards: one instanced mesh, cylindrically billboarded per frame
// - void shell: gradient cylinder + bottom cap merged into one draw
// Shadow audit: only the parapet ring casts here (large rim structure);
// greebles, masts, dish and sprites never cast.

const SEG_N = 56
const PARAPET_R = ARENA_RADIUS + 0.65
const FOG_COLOR = 0x0b0e1a
const CLOUD_N = 9
const RADAR_A = 3.9

const _m = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _e = new THREE.Euler()

interface CloudSpec { angle: number; radius: number; speed: number; y: number }
interface FlickerLight { light: THREE.PointLight; base: number; phase: number }

function buildEnv() {
  const group = new THREE.Group()
  const dark = darkMetalMaterial()
  const clouds: CloudSpec[] = []
  const lights: FlickerLight[] = []

  // ── Parapet ring ───────────────────────────────────────────────────────────
  const segW = (Math.PI * 2 * PARAPET_R) / SEG_N - 0.16
  const segGeo = parapetGeometry(segW)
  const parapet = new THREE.InstancedMesh(segGeo, dark, SEG_N)
  parapet.castShadow = parapet.receiveShadow = true
  const stripeGeo = new THREE.BoxGeometry(segW * 0.92, 0.34, 0.05)
  const stripeMat = new THREE.MeshStandardMaterial({
    map: hazardStripeTexture(), roughness: 0.85, metalness: 0.25,
  })
  const stripes = new THREE.InstancedMesh(stripeGeo, stripeMat, SEG_N)
  stripes.receiveShadow = true
  const barGeo = new THREE.BoxGeometry(1.05, 0.08, 0.05)
  const barMat = new THREE.MeshBasicMaterial({ toneMapped: false })
  barMat.color.setRGB(0.35, 1.45, 2.05)
  const barN = Math.floor(SEG_N / 4)
  const bars = new THREE.InstancedMesh(barGeo, barMat, barN)
  let barI = 0
  for (let i = 0; i < SEG_N; i++) {
    const a = (i / SEG_N) * Math.PI * 2
    _p.set(Math.cos(a) * PARAPET_R, 0, Math.sin(a) * PARAPET_R)
    _q.setFromEuler(_e.set(0, Math.PI / 2 - a, 0))
    _m.compose(_p, _q, _s.set(1, 1, 1))
    parapet.setMatrixAt(i, _m)
    _m2.copy(_m).multiply(new THREE.Matrix4().makeTranslation(0, 0.48, -0.30))
    stripes.setMatrixAt(i, _m2)
    if (i % 4 === 0 && barI < barN) {
      _m2.copy(_m).multiply(new THREE.Matrix4().makeTranslation(0, 0.82, -0.295))
      bars.setMatrixAt(barI++, _m2)
    }
  }
  group.add(parapet, stripes, bars)

  // ── Hull skirt under the platform edge ─────────────────────────────────────
  const panelDark = panelTextures('dark')
  const skirtMat = new THREE.MeshStandardMaterial({
    map: panelDark.map, normalMap: panelDark.normalMap, roughnessMap: panelDark.roughnessMap,
    metalness: 0.7, roughness: 1.0,
  })
  const skirtGeo = scaleUvs(
    new THREE.CylinderGeometry(ARENA_RADIUS + 0.9, ARENA_RADIUS - 2.5, 2.6, 96, 1, true), 26, 1.1,
  )
  const skirt = new THREE.Mesh(skirtGeo, skirtMat)
  skirt.position.y = -1.28
  group.add(skirt)

  // ── ONE merged static mesh: under-structure + radar/antenna framework ──────
  // (columns, diagonal struts, greeble blocks, radar base+mast, antenna
  // poles+crossbars — all share the dark-metal material and never move)
  const statics: THREE.BufferGeometry[] = []
  const addStatic = (g: THREE.BufferGeometry, m: THREE.Matrix4) => { statics.push(g.applyMatrix4(m)) }
  const rndU = seededRandom(90210)
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2
    _q.setFromEuler(_e.set(0, Math.PI / 2 - a, 0))
    addStatic(new THREE.BoxGeometry(0.34, 5.6, 0.34),
      _m.compose(_p.set(Math.cos(a) * 40.6, -4.9, Math.sin(a) * 40.6), _q, _s.set(1, 1, 1)))
    const am = a + Math.PI / 28
    _e.set(0, Math.PI / 2 - am, i % 2 === 0 ? 0.74 : -0.74)
    _e.order = 'YZX'
    _q.setFromEuler(_e)
    _e.order = 'XYZ'
    addStatic(new THREE.BoxGeometry(0.18, 5.4, 0.18),
      _m.compose(_p.set(Math.cos(am) * 40.7, -4.4, Math.sin(am) * 40.7), _q, _s.set(1, 1, 1)))
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + 0.09
    _q.setFromEuler(_e.set(0, Math.PI / 2 - a, 0))
    addStatic(new THREE.BoxGeometry(1.5, 0.65, 0.85),
      _m.compose(
        _p.set(Math.cos(a) * 39.4, -3.1 - rndU() * 0.8, Math.sin(a) * 39.4),
        _q, _s.set(1, 1 + rndU() * 0.6, 1),
      ))
  }
  // radar base + mast on the parapet cap
  const radarPos = new THREE.Vector3(Math.cos(RADAR_A) * 42.7, 1.06, Math.sin(RADAR_A) * 42.7)
  addStatic(new THREE.CylinderGeometry(0.42, 0.5, 0.5, 10),
    _m.makeTranslation(radarPos.x, radarPos.y + 0.25, radarPos.z))
  addStatic(new THREE.BoxGeometry(0.16, 2.4, 0.16),
    _m.makeTranslation(radarPos.x, radarPos.y + 1.6, radarPos.z))
  // antenna masts
  for (const aA of [1.15, 5.55] as const) {
    const bx = Math.cos(aA) * 42.7, bz = Math.sin(aA) * 42.7
    addStatic(new THREE.CylinderGeometry(0.045, 0.07, 3.4, 8), _m.makeTranslation(bx, 1.06 + 1.7, bz))
    addStatic(new THREE.BoxGeometry(0.7, 0.05, 0.05), _m.makeTranslation(bx, 1.06 + 2.9, bz))
    _q.setFromEuler(_e.set(0, 0.8, 0))
    addStatic(new THREE.BoxGeometry(0.5, 0.05, 0.05),
      _m.compose(_p.set(bx, 1.06 + 2.5, bz), _q, _s.set(1, 1, 1)))
  }
  const staticDark = new THREE.Mesh(mergeGeometries(statics, false)!, dark)
  group.add(staticDark)

  // ── Rotating radar head: dish + feed + counterweight merged to one mesh ────
  const feedGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.9, 6)
  feedGeo.rotateX(-1.05)
  feedGeo.translate(0, Math.cos(1.05) * 0.45, Math.sin(1.05) * 0.45)
  const radarHead = new THREE.Mesh(mergeGeometries([
    dishGeometry().rotateX(-1.05),
    feedGeo,
    new THREE.BoxGeometry(0.3, 0.24, 0.5).translate(0, -0.1, -0.5),
  ], false)!, dark)
  radarHead.position.set(radarPos.x, radarPos.y + 2.86, radarPos.z)
  group.add(radarHead)

  // ── Blinking beacons: one instanced mesh, blink evaluated in-shader ────────
  const beaconGeo = new THREE.SphereGeometry(0.09, 10, 8)
  beaconGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array([0, 0.6, 1.2]), 1))
  beaconGeo.setAttribute('aPeriod', new THREE.InstancedBufferAttribute(new Float32Array([1.7, 2.3, 2.3]), 1))
  const beaconMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aPhase; attribute float aPeriod;
      uniform float uTime;
      varying float vK;
      void main() {
        // sin^6 pulse, multiplied out — no pow() (base can be exactly 0)
        float s = max(sin((uTime / aPeriod + aPhase) * 6.2831853), 0.0);
        float s2 = s * s;
        vK = s2 * s2 * s2;
        #ifdef USE_INSTANCING
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        #else
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #endif
      }`,
    fragmentShader: /* glsl */ `
      varying float vK;
      void main() {
        gl_FragColor = vec4(0.25 + vK * 2.4, 0.05 + vK * 0.35, 0.05 + vK * 0.3, 1.0);
      }`,
  })
  const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, 3)
  beacons.setMatrixAt(0, _m.makeTranslation(radarPos.x, 1.06 + 3.05, radarPos.z))
  beacons.setMatrixAt(1, _m.makeTranslation(Math.cos(1.15) * 42.7, 1.06 + 3.45, Math.sin(1.15) * 42.7))
  beacons.setMatrixAt(2, _m.makeTranslation(Math.cos(5.55) * 42.7, 1.06 + 3.45, Math.sin(5.55) * 42.7))
  group.add(beacons)

  // ── Void: soft vertical gradient cylinder + bottom cap, one draw ───────────
  const voidMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: true,
    uniforms: {
      uTop: { value: new THREE.Color(FOG_COLOR) },
      uBot: { value: new THREE.Color(0x04050c) },
    },
    vertexShader: /* glsl */ `
      varying float vY;
      void main() {
        vY = position.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop; uniform vec3 uBot;
      varying float vY;
      void main() {
        float h = clamp((vY + 85.0) / 100.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(uBot, uTop, pow(max(h, 1e-5), 1.5)), 1.0);
      }`,
  })
  // cap faces −Y so its BACK side shows from above; at vY=-84 the gradient
  // evaluates to uBot — identical to the old dedicated cap color
  const voidGeo = mergeGeometries([
    new THREE.CylinderGeometry(175, 175, 170, 48, 1, true),
    new THREE.CircleGeometry(176, 48).rotateX(Math.PI / 2).translate(0, -84, 0),
  ], false)!
  const voidShell = new THREE.Mesh(voidGeo, voidMat)
  voidShell.position.y = -72
  group.add(voidShell)

  // ── Distant city skyline: ONE instanced draw, atlas picks the variant ──────
  const towerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  const towerMat = new THREE.MeshBasicMaterial({ map: skylineAtlasTexture(6100, 6177) })
  towerMat.customProgramCacheKey = () => 'arenaSkylineAtlas'
  towerMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTexSel;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv.x = vMapUv.x * 0.5 + aTexSel * 0.5;
        #endif`,
      )
  }
  const towers = new THREE.InstancedMesh(towerGeo, towerMat, 90)
  const towerSel = new Float32Array(90)
  let ti = 0
  for (let v = 0; v < 2; v++) {
    const rnd = seededRandom(4400 + v * 13)
    for (let i = 0; i < 45; i++) {
      const a = rnd() * Math.PI * 2
      const r = 135 + rnd() * 95
      const h = 10 + Math.pow(rnd(), 1.4) * 40
      _p.set(Math.cos(a) * r, -48 + rnd() * 18, Math.sin(a) * r)
      _q.setFromEuler(_e.set(0, rnd() * Math.PI, 0))
      towerSel[ti] = v
      towers.setMatrixAt(ti++, _m.compose(_p, _q, _s.set(6 + rnd() * 9, h, 6 + rnd() * 9)))
    }
  }
  towerGeo.setAttribute('aTexSel', new THREE.InstancedBufferAttribute(towerSel, 1))
  group.add(towers)

  // ── Drifting fog/cloud cards: one instanced mesh, billboarded per frame ────
  const cloudMat = new THREE.MeshBasicMaterial({
    map: softTexture(), transparent: true, opacity: 0.13, depthWrite: false,
    color: 0x8a9cc8,
  })
  const cloudGeo = new THREE.PlaneGeometry(70, 20)
  const cloudsIM = new THREE.InstancedMesh(cloudGeo, cloudMat, CLOUD_N)
  cloudsIM.renderOrder = 2
  cloudsIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const rndC = seededRandom(777)
  for (let i = 0; i < CLOUD_N; i++) {
    clouds.push({
      angle: (i / CLOUD_N) * Math.PI * 2 + rndC(),
      radius: 75 + rndC() * 45,
      speed: (0.006 + rndC() * 0.01) * (i % 2 === 0 ? 1 : -1),
      y: -14 + rndC() * 11,
    })
  }
  group.add(cloudsIM)

  // ── Dim stars ──────────────────────────────────────────────────────────────
  const starN = 600
  const pos = new Float32Array(starN * 3)
  const col = new Float32Array(starN * 3)
  const rndS = seededRandom(31415)
  for (let i = 0; i < starN; i++) {
    const y = 0.04 + rndS() * 0.95
    const rxz = Math.sqrt(Math.max(0, 1 - y * y))
    const a = rndS() * Math.PI * 2
    pos[i * 3] = Math.cos(a) * rxz * 335
    pos[i * 3 + 1] = y * 335
    pos[i * 3 + 2] = Math.sin(a) * rxz * 335
    const b = 0.25 + Math.pow(rndS(), 2.2) * 0.7
    const warm = rndS() > 0.7
    col[i * 3] = b * (warm ? 1 : 0.82)
    col[i * 3 + 1] = b * 0.9
    col[i * 3 + 2] = b * (warm ? 0.75 : 1)
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    map: dotTexture(), size: 2.1, sizeAttenuation: false, transparent: true,
    vertexColors: true, depthWrite: false, fog: false, opacity: 0.85,
  }))
  group.add(stars)

  // ── Flickering rim lights ──────────────────────────────────────────────────
  for (const [aL, color, base, phase] of [
    [0.0, 0xffa251, 34, 0.0],
    [Math.PI * 0.86, 0x6fd2ff, 24, 2.1],
  ] as const) {
    const light = new THREE.PointLight(color, base, 18, 2)
    light.position.set(Math.cos(aL) * 41.2, 1.35, Math.sin(aL) * 41.2)
    lights.push({ light, base, phase })
    group.add(light)
  }

  for (const im of [parapet, stripes, bars, beacons, towers, cloudsIM]) {
    im.instanceMatrix.needsUpdate = true
    // instance transforms spread far from the geometry origin
    im.frustumCulled = false
  }

  return { group, clouds, cloudsIM, beaconMat, lights, radarHead }
}

export function ArenaEnviron() {
  const built = useMemo(buildEnv, [])
  const t = useRef(0)

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.05)
    t.current += step
    const time = t.current
    // slow radar sweep (pure visual idle animation — runs in every phase)
    built.radarHead.rotation.y += step * 0.45
    // beacon blinks resolve in the shader — just feed the clock
    built.beaconMat.uniforms.uTime.value = time
    // rim light flicker
    for (const f of built.lights) {
      const n = 0.5 + 0.5 * Math.sin(time * 11 + f.phase + Math.sin(time * 23 + f.phase * 3) * 1.6)
      f.light.intensity = f.base * (0.66 + 0.34 * n)
    }
    // cloud drift + cylindrical billboard toward camera (per-instance matrices)
    const cam = state.camera
    for (let i = 0; i < CLOUD_N; i++) {
      const c = built.clouds[i]
      c.angle += c.speed * step
      const x = Math.cos(c.angle) * c.radius
      const z = Math.sin(c.angle) * c.radius
      _q.setFromEuler(_e.set(0, Math.atan2(cam.position.x - x, cam.position.z - z), 0))
      built.cloudsIM.setMatrixAt(i, _m.compose(_p.set(x, c.y, z), _q, _s.set(1, 1, 1)))
    }
    built.cloudsIM.instanceMatrix.needsUpdate = true
  }, FRAME_PRIO.vfx)

  return <primitive object={built.group} />
}
