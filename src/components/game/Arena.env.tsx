'use client'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { ARENA_RADIUS, FRAME_PRIO } from '@/game/constants'
import { darkMetalMaterial } from '@/game/gfx/materials'
import { panelTextures, seededRandom } from '@/game/gfx/textures'
import { dishGeometry, parapetGeometry, scaleUvs } from './Arena.geo'
import { dotTexture, hazardStripeTexture, skylineTexture, softTexture } from './Arena.textures'

// Environment shell: beveled parapet ring with warning stripes + inset lights,
// support trusses + hull skirt under the platform edge, a soft void gradient,
// distant instanced city towers, drifting fog cards, dim stars, a rotating
// radar dish + blinking antennas, and two flickering rim lights.

const SEG_N = 56
const PARAPET_R = ARENA_RADIUS + 0.65
const FOG_COLOR = 0x0b0e1a

const _m = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _e = new THREE.Euler()

interface CloudSpec { mesh: THREE.Mesh; angle: number; radius: number; speed: number; y: number }
interface BeaconSpec { mat: THREE.MeshBasicMaterial; phase: number; period: number }
interface FlickerLight { light: THREE.PointLight; base: number; phase: number }

function buildEnv() {
  const group = new THREE.Group()
  const dark = darkMetalMaterial()
  const clouds: CloudSpec[] = []
  const beacons: BeaconSpec[] = []
  const lights: FlickerLight[] = []
  let radarHead: THREE.Group | null = null

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

  // ── Under-structure: skirt, columns, diagonal struts, greeble blocks ───────
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

  const colGeo = new THREE.BoxGeometry(0.34, 5.6, 0.34)
  const cols = new THREE.InstancedMesh(colGeo, dark, 28)
  const diagGeo = new THREE.BoxGeometry(0.18, 5.4, 0.18)
  const diags = new THREE.InstancedMesh(diagGeo, dark, 28)
  const grebGeo = new THREE.BoxGeometry(1.5, 0.65, 0.85)
  const grebs = new THREE.InstancedMesh(grebGeo, dark, 24)
  const rndU = seededRandom(90210)
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2
    _p.set(Math.cos(a) * 40.6, -4.9, Math.sin(a) * 40.6)
    _q.setFromEuler(_e.set(0, Math.PI / 2 - a, 0))
    cols.setMatrixAt(i, _m.compose(_p, _q, _s.set(1, 1, 1)))
    const am = a + Math.PI / 28
    _p.set(Math.cos(am) * 40.7, -4.4, Math.sin(am) * 40.7)
    _e.set(0, Math.PI / 2 - am, i % 2 === 0 ? 0.74 : -0.74)
    _e.order = 'YZX'
    _q.setFromEuler(_e)
    diags.setMatrixAt(i, _m.compose(_p, _q, _s.set(1, 1, 1)))
    _e.order = 'XYZ'
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + 0.09
    _p.set(Math.cos(a) * 39.4, -3.1 - rndU() * 0.8, Math.sin(a) * 39.4)
    _q.setFromEuler(_e.set(0, Math.PI / 2 - a, 0))
    grebs.setMatrixAt(i, _m.compose(_p, _q, _s.set(1, 1 + rndU() * 0.6, 1)))
  }
  group.add(cols, diags, grebs)

  // ── Void: soft vertical gradient, never pure black ─────────────────────────
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
  const voidCyl = new THREE.Mesh(new THREE.CylinderGeometry(175, 175, 170, 48, 1, true), voidMat)
  voidCyl.position.y = -72
  const voidCap = new THREE.Mesh(
    new THREE.CircleGeometry(176, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x04050c, fog: false }),
  )
  voidCap.position.y = -156
  group.add(voidCyl, voidCap)

  // ── Distant city skyline (instanced towers, sparse lit windows) ────────────
  for (let v = 0; v < 2; v++) {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
    const mat = new THREE.MeshBasicMaterial({ map: skylineTexture(6100 + v * 77) })
    const towers = new THREE.InstancedMesh(boxGeo, mat, 45)
    towers.frustumCulled = false
    const rnd = seededRandom(4400 + v * 13)
    for (let i = 0; i < 45; i++) {
      const a = rnd() * Math.PI * 2
      const r = 135 + rnd() * 95
      const h = 10 + Math.pow(rnd(), 1.4) * 40
      _p.set(Math.cos(a) * r, -48 + rnd() * 18, Math.sin(a) * r)
      _q.setFromEuler(_e.set(0, rnd() * Math.PI, 0))
      towers.setMatrixAt(i, _m.compose(_p, _q, _s.set(6 + rnd() * 9, h, 6 + rnd() * 9)))
    }
    towers.instanceMatrix.needsUpdate = true
    group.add(towers)
  }

  // ── Drifting fog/cloud cards ───────────────────────────────────────────────
  const cloudMat = new THREE.MeshBasicMaterial({
    map: softTexture(), transparent: true, opacity: 0.13, depthWrite: false,
    color: 0x8a9cc8,
  })
  const cloudGeo = new THREE.PlaneGeometry(70, 20)
  const rndC = seededRandom(777)
  for (let i = 0; i < 9; i++) {
    const mesh = new THREE.Mesh(cloudGeo, cloudMat)
    mesh.renderOrder = 2
    clouds.push({
      mesh,
      angle: (i / 9) * Math.PI * 2 + rndC(),
      radius: 75 + rndC() * 45,
      speed: (0.006 + rndC() * 0.01) * (i % 2 === 0 ? 1 : -1),
      y: -14 + rndC() * 11,
    })
    group.add(mesh)
  }

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

  // ── Radar dish + antenna masts on the parapet cap ──────────────────────────
  const makeBeacon = (phase: number, period: number) => {
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false })
    beacons.push({ mat, phase, period })
    return new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), mat)
  }
  {
    const aR = 3.9
    const radar = new THREE.Group()
    radar.position.set(Math.cos(aR) * 42.7, 1.06, Math.sin(aR) * 42.7)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.5, 10), dark)
    base.position.y = 0.25
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.4, 0.16), dark)
    mast.position.y = 1.6
    mast.castShadow = true
    radarHead = new THREE.Group()
    radarHead.position.y = 2.86
    const dish = new THREE.Mesh(dishGeometry(), dark)
    dish.rotation.x = -1.05
    dish.castShadow = true
    const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 6), dark)
    feed.rotation.x = -1.05
    feed.position.set(0, Math.cos(1.05) * 0.45, Math.sin(1.05) * 0.45)
    const counter = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.5), dark)
    counter.position.set(0, -0.1, -0.5)
    radarHead.add(dish, feed, counter)
    const beacon = makeBeacon(0, 1.7)
    beacon.position.y = 3.05
    radar.add(base, mast, radarHead, beacon)
    group.add(radar)
  }
  for (const [aA, phase] of [[1.15, 0.6], [5.55, 1.2]] as const) {
    const mastG = new THREE.Group()
    mastG.position.set(Math.cos(aA) * 42.7, 1.06, Math.sin(aA) * 42.7)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, 3.4, 8), dark)
    pole.position.y = 1.7
    pole.castShadow = true
    const cross1 = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.05), dark)
    cross1.position.y = 2.9
    const cross2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.05), dark)
    cross2.position.y = 2.5
    cross2.rotation.y = 0.8
    const beacon = makeBeacon(phase, 2.3)
    beacon.position.y = 3.45
    mastG.add(pole, cross1, cross2, beacon)
    group.add(mastG)
  }

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

  for (const im of [parapet, stripes, bars, cols, diags, grebs]) {
    im.instanceMatrix.needsUpdate = true
    // instance transforms spread far from the geometry origin
    im.frustumCulled = false
  }

  return { group, clouds, beacons, lights, radarHead: radarHead as THREE.Group | null }
}

export function ArenaEnviron() {
  const built = useMemo(buildEnv, [])
  const t = useRef(0)

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.05)
    t.current += step
    const time = t.current
    // slow radar sweep (pure visual idle animation — runs in every phase)
    if (built.radarHead) built.radarHead.rotation.y += step * 0.45
    // beacon blinks
    for (const b of built.beacons) {
      const k = Math.pow(Math.max(0, Math.sin((time / b.period + b.phase) * Math.PI * 2)), 6)
      b.mat.color.setRGB(0.25 + k * 2.4, 0.05 + k * 0.35, 0.05 + k * 0.3)
    }
    // rim light flicker
    for (const f of built.lights) {
      const n = 0.5 + 0.5 * Math.sin(time * 11 + f.phase + Math.sin(time * 23 + f.phase * 3) * 1.6)
      f.light.intensity = f.base * (0.66 + 0.34 * n)
    }
    // cloud drift + cylindrical billboard toward camera
    const cam = state.camera
    for (const c of built.clouds) {
      c.angle += c.speed * step
      const x = Math.cos(c.angle) * c.radius
      const z = Math.sin(c.angle) * c.radius
      c.mesh.position.set(x, c.y, z)
      c.mesh.rotation.y = Math.atan2(cam.position.x - x, cam.position.z - z)
    }
  }, FRAME_PRIO.vfx)

  return <primitive object={built.group} />
}
