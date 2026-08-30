'use client'
import * as THREE from 'three'
import { bossHullMaterial, darkMetalMaterial, emissiveMaterial, glowMetal } from '@/game/gfx/materials'
import { seededRandom } from '@/game/gfx/textures'

// ─── AGI model construction ──────────────────────────────────────────────────
// Builds the whole boss once: chamfered monitor head + CRT screen, greebled
// torso with reactor core, two telescoping arms with articulated 4-finger
// hands that can morph into miniguns / a death-beam cannon, death debris.
// Everything animatable is returned as a rig of refs; Agi.tsx drives it.

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
  cargoBots: THREE.Group[]
}

export interface ArmRig {
  group: THREE.Group
  segs: THREE.Mesh[]
  collars: THREE.Mesh[]
  pistons: THREE.Mesh[]
  shoulder: THREE.Mesh
  hand: HandRig
}

export interface AgiRig {
  root: THREE.Group
  model: THREE.Group
  bob: THREE.Group
  head: THREE.Group
  arms: [ArmRig, ArmRig]
  reactorMat: THREE.ShaderMaterial
  fan: THREE.Group
  ledMats: { mat: THREE.MeshBasicMaterial; base: THREE.Color; phase: number }[]
  sparks: { group: THREE.Group; bits: THREE.Mesh[] }[]
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

  // ── HEAD: giant retro monitor ─────────────────────────────────────────────
  const head = new THREE.Group()
  head.position.copy(HEAD_CENTER)
  bob.add(head)

  const casing = mesh(chamferBoxGeo(16, 11, 8, 0.55), hull)
  casing.position.z = -0.35
  head.add(casing)

  // protruding bezel frame around the screen opening
  const bezelH = mesh(chamferBoxGeo(13.8, 1.0, 1.1, 0.2), dark)
  bezelH.position.set(0, 4.35, 3.9)
  head.add(bezelH)
  const bezelB = bezelH.clone()
  bezelB.position.set(0, -4.35, 3.9)
  head.add(bezelB)
  const bezelSide = mesh(chamferBoxGeo(1.0, 7.9, 1.1, 0.2), dark)
  bezelSide.position.set(-6.4, 0, 3.9)
  head.add(bezelSide)
  const bezelSide2 = bezelSide.clone()
  bezelSide2.position.set(6.4, 0, 3.9)
  head.add(bezelSide2)

  // recessed CRT screen
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(12.4, 7.9), screenMaterial)
  screen.position.set(0, 0, 3.72)
  head.add(screen)

  // side vents: instanced fins, real silhouette change
  const finGeo = new THREE.BoxGeometry(0.5, 0.28, 5.4)
  const vents = new THREE.InstancedMesh(finGeo, dark, 20)
  vents.castShadow = true
  const dummy = new THREE.Object3D()
  let vi = 0
  for (const sx of [-1, 1]) {
    for (let f = 0; f < 10; f++) {
      dummy.position.set(sx * 8.05, -3.4 + f * 0.76, -0.6)
      dummy.rotation.set(0, 0, sx * 0.12)
      dummy.updateMatrix()
      vents.setMatrixAt(vi++, dummy.matrix)
    }
  }
  vents.instanceMatrix.needsUpdate = true
  head.add(vents)

  // antennas with LED tips
  const ledMats: AgiRig['ledMats'] = []
  const makeLed = (color: THREE.ColorRepresentation, phase: number) => {
    const m = emissiveMaterial(color)
    m.color.multiplyScalar(2.2)
    ledMats.push({ mat: m, base: m.color.clone(), phase })
    return m
  }
  const antGeo = new THREE.CylinderGeometry(0.06, 0.11, 3.6, 6)
  const tipGeo = new THREE.SphereGeometry(0.24, 8, 8)
  for (const sx of [-1, 1]) {
    const ant = mesh(antGeo, dark, false)
    ant.position.set(sx * 5.4, 7.2, -1.5)
    ant.rotation.z = -sx * 0.14
    head.add(ant)
    const tip = new THREE.Mesh(tipGeo, makeLed(sx < 0 ? 0xff4444 : 0x44ff88, sx < 0 ? 0 : 1.4))
    tip.position.set(sx * 5.65, 9.0, -1.5)
    head.add(tip)
  }

  // brand plate + a small top handle greeble
  const plate = mesh(chamferBoxGeo(4.2, 0.8, 0.3, 0.1), dark, false)
  plate.position.set(0, -4.6, 4.05)
  head.add(plate)
  const handle = mesh(chamferBoxGeo(6, 0.7, 1.4, 0.25), dark)
  handle.position.set(0, 5.85, -1.5)
  head.add(handle)

  // ── neck + cables into the body ───────────────────────────────────────────
  const neck = mesh(new THREE.CylinderGeometry(2.4, 3.4, 3.6, 12), dark)
  neck.position.set(0, 21.2, -66.4)
  bob.add(neck)

  const cableMat = dark
  for (let i = 0; i < 4; i++) {
    const sx = i < 2 ? -1 : 1
    const k = i % 2
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sx * (1.6 + k * 1.2), 22.0, -65.2),
      new THREE.Vector3(sx * (3.0 + k * 1.6), 20.4, -67.2 - k * 0.8),
      new THREE.Vector3(sx * (3.6 + k * 1.4), 18.6, -69.0),
    ])
    const tube = mesh(new THREE.TubeGeometry(curve, 10, 0.24 + k * 0.08, 7), cableMat)
    bob.add(tube)
  }

  // ── BODY: torso block, shoulders, reactor, chevrons, greebles ────────────
  const torso = mesh(chamferBoxGeo(24, 13, 12, 0.8, 0.1), hull)
  torso.position.set(0, 14.6, -70.5)
  bob.add(torso)

  for (const sx of [-1, 1]) {
    const shoulderBlock = mesh(chamferBoxGeo(7.5, 7, 8.5, 0.7), hull)
    shoulderBlock.position.set(sx * 13.2, 18.6, -70)
    bob.add(shoulderBlock)
    // shoulder cap ring
    const cap = mesh(new THREE.CylinderGeometry(2.9, 2.9, 1.1, 14), dark)
    cap.rotation.z = Math.PI / 2
    cap.position.set(sx * 16.6, 19.2, -69.5)
    bob.add(cap)
  }

  // reactor: dark housing ring + additive shader core
  const reactorRing = mesh(new THREE.TorusGeometry(2.7, 0.55, 10, 24), dark)
  reactorRing.position.set(0, 14.6, -64.25)
  bob.add(reactorRing)
  const reactorBack = mesh(new THREE.CircleGeometry(2.7, 24), dark, false)
  reactorBack.position.set(0, 14.6, -64.35)
  bob.add(reactorBack)
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

  // thick body cables looping from the torso sides down under it
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 2; k++) {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(sx * (11.0 - k * 1.6), 12.5, -66.5 - k * 2.2),
        new THREE.Vector3(sx * (13.4 - k * 1.2), 8.6, -68.5 - k * 1.6),
        new THREE.Vector3(sx * (9.5 - k * 1.0), 6.2, -71.0),
      ])
      bob.add(mesh(new THREE.TubeGeometry(curve, 12, 0.42 - k * 0.1, 8), dark))
    }
  }

  // under-hull cone + engine glow
  const under = mesh(new THREE.ConeGeometry(8.2, 6.5, 14), dark)
  under.rotation.x = Math.PI
  under.position.set(0, 5.4, -70.5)
  bob.add(under)
  const engineGlowMat = emissiveMaterial(0x3a6bff, 0.85)
  engineGlowMat.color.multiplyScalar(1.6)
  const engineGlow = new THREE.Mesh(new THREE.CircleGeometry(3.2, 18), engineGlowMat)
  engineGlow.rotation.x = Math.PI / 2
  engineGlow.position.set(0, 3.1, -70.5)
  bob.add(engineGlow)

  // greebled machinery: instanced boxes over torso top/back/shoulders
  const greebleGeo = new THREE.BoxGeometry(1, 1, 1)
  const greebles = new THREE.InstancedMesh(greebleGeo, dark, 56)
  greebles.castShadow = true
  const grnd = seededRandom(9182)
  for (let i = 0; i < 56; i++) {
    const zone = grnd()
    if (zone < 0.5) {
      // torso top
      dummy.position.set((grnd() - 0.5) * 20, 21.2 + grnd() * 0.9, -70.5 + (grnd() - 0.5) * 9)
    } else if (zone < 0.8) {
      // torso back
      dummy.position.set((grnd() - 0.5) * 21, 11 + grnd() * 7, -76.6 - grnd() * 0.8)
    } else {
      // shoulder tops
      const sx = grnd() < 0.5 ? -1 : 1
      dummy.position.set(sx * (11 + grnd() * 4.5), 22.2 + grnd() * 0.6, -70 + (grnd() - 0.5) * 6)
    }
    dummy.rotation.set(0, grnd() * Math.PI, 0)
    dummy.scale.set(0.7 + grnd() * 2.4, 0.5 + grnd() * 1.7, 0.7 + grnd() * 2.2)
    dummy.updateMatrix()
    greebles.setMatrixAt(i, dummy.matrix)
  }
  greebles.instanceMatrix.needsUpdate = true
  bob.add(greebles)

  // cooling fan on the torso's right flank
  const fan = new THREE.Group()
  fan.position.set(12.15, 15.5, -73)
  const fanRim = mesh(new THREE.TorusGeometry(1.7, 0.22, 8, 18), dark, false)
  fanRim.rotation.y = Math.PI / 2
  fan.add(fanRim)
  const bladeGeo = new THREE.BoxGeometry(0.08, 0.55, 1.5)
  for (let b = 0; b < 5; b++) {
    const blade = mesh(bladeGeo, dark, false)
    blade.rotation.x = (b / 5) * Math.PI * 2
    blade.position.set(0, Math.sin((b / 5) * Math.PI * 2) * 0.8, Math.cos((b / 5) * Math.PI * 2) * 0.8)
    blade.rotation.z = 0.5
    fan.add(blade)
  }
  bob.add(fan)

  // status LEDs across the torso front
  const ledGeo = new THREE.BoxGeometry(0.35, 0.35, 0.2)
  const ledColors: THREE.ColorRepresentation[] = [0xff5533, 0x44ff88, 0x33aaff, 0xffcc44, 0x44ff88]
  for (let i = 0; i < 5; i++) {
    const led = new THREE.Mesh(ledGeo, makeLed(ledColors[i], i * 0.9))
    led.position.set(-9 + i * 1.1, 20.2, -64.4)
    bob.add(led)
  }

  // ── ARMS ──────────────────────────────────────────────────────────────────
  const segGeos: THREE.CylinderGeometry[] = []
  const collarGeos: THREE.CylinderGeometry[] = []
  for (let i = 0; i < ARM_SEGMENTS; i++) {
    segGeos.push(new THREE.CylinderGeometry(Math.max(0.4, SEG_RADIUS[i] - 0.05), SEG_RADIUS[i], 1, 12, 1))
    if (i > 0) collarGeos.push(new THREE.CylinderGeometry(SEG_RADIUS[i] + 0.24, SEG_RADIUS[i] + 0.24, 0.62, 12))
  }
  const pistonGeo = new THREE.CylinderGeometry(0.13, 0.13, 1, 6)
  const shoulderGeo = new THREE.SphereGeometry(2.15, 16, 12)
  const loopGeo = new THREE.TorusGeometry(1, 0.07, 6, 14)

  function buildHand(): HandRig {
    const group = new THREE.Group()
    // wrist cuff
    const cuff = mesh(new THREE.CylinderGeometry(0.8, 1.0, 0.95, 10), dark)
    cuff.position.y = 0.25
    group.add(cuff)
    // palm (local frame: +Y fingers, -Z palm side)
    const palm = mesh(chamferBoxGeo(3.0, 2.4, 1.2, 0.3, 0.3), hull)
    palm.position.set(0, 1.55, 0.05)
    group.add(palm)
    const backPlate = mesh(chamferBoxGeo(2.3, 1.6, 0.45, 0.16, 0.4), hull)
    backPlate.position.set(0, 1.55, 0.75)
    group.add(backPlate)
    // repulsor dot in the palm
    const palmDot = new THREE.Mesh(new THREE.CircleGeometry(0.34, 12), glowMetal(0x66ddff, 1.6))
    palmDot.rotation.x = Math.PI
    palmDot.position.set(0, 1.55, -0.62)
    group.add(palmDot)

    // fingers ×4
    const fingers: FingerRig[] = []
    const xs = [-1.14, -0.38, 0.38, 1.14]
    const p1Geo = chamferBoxGeo(0.52, 1.1, 0.56, 0.1, 0.8)
    const p2Geo = chamferBoxGeo(0.46, 0.95, 0.5, 0.09, 0.8)
    const p3Geo = chamferBoxGeo(0.4, 0.85, 0.44, 0.09, 0.8)
    const knuckleGeo = new THREE.SphereGeometry(0.32, 8, 8)
    for (const fx of xs) {
      const fRoot = new THREE.Group()
      fRoot.position.set(fx, 2.65, -0.05)
      const ph1 = mesh(p1Geo, dark)
      ph1.position.y = 0.55
      fRoot.add(ph1)
      fRoot.add(mesh(knuckleGeo, dark))
      const fMid = new THREE.Group()
      fMid.position.y = 1.08
      const ph2 = mesh(p2Geo, dark)
      ph2.position.y = 0.48
      fMid.add(ph2)
      const k2 = mesh(knuckleGeo, dark)
      k2.scale.setScalar(0.85)
      fMid.add(k2)
      const fTip = new THREE.Group()
      fTip.position.y = 0.94
      const ph3 = mesh(p3Geo, dark)
      ph3.position.y = 0.42
      fTip.add(ph3)
      const k3 = mesh(knuckleGeo, dark)
      k3.scale.setScalar(0.7)
      fTip.add(k3)
      fMid.add(fTip)
      fRoot.add(fMid)
      group.add(fRoot)
      fingers.push({ root: fRoot, mid: fMid, tip: fTip })
    }

    // ── minigun morph assembly (hidden until laser-bullets pattern) ─────────
    const minigunGroup = new THREE.Group()
    minigunGroup.position.set(0, 1.35, -0.1)
    minigunGroup.visible = false
    const mount = mesh(chamferBoxGeo(1.7, 1.3, 1.7, 0.2, 0.5), dark)
    mount.position.y = 0.4
    minigunGroup.add(mount)
    const spinner = new THREE.Group()
    spinner.position.y = 1.1
    const shaft = mesh(new THREE.CylinderGeometry(0.32, 0.32, 3.4, 8), dark)
    shaft.position.y = 1.6
    spinner.add(shaft)
    const barrelGeo = new THREE.CylinderGeometry(0.15, 0.17, 3.3, 7)
    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * Math.PI * 2
      const barrel = mesh(barrelGeo, dark)
      barrel.position.set(Math.cos(a) * 0.56, 1.62, Math.sin(a) * 0.56)
      spinner.add(barrel)
    }
    const muzzleRing = mesh(new THREE.TorusGeometry(0.62, 0.11, 6, 14), dark, false)
    muzzleRing.rotation.x = Math.PI / 2
    muzzleRing.position.y = 3.15
    spinner.add(muzzleRing)
    minigunGroup.add(spinner)
    const flashMat = emissiveMaterial(0xffcc66, 0)
    flashMat.color.multiplyScalar(3)
    flashMat.blending = THREE.AdditiveBlending
    flashMat.depthWrite = false
    const flashGeo = new THREE.PlaneGeometry(1.9, 1.9)
    const flashA = new THREE.Mesh(flashGeo, flashMat)
    flashA.position.y = 3.35
    flashA.rotation.x = Math.PI / 2
    minigunGroup.add(flashA)
    const flashB = new THREE.Mesh(flashGeo, flashMat)
    flashB.position.y = 3.35
    flashB.rotation.set(Math.PI / 2, 0, Math.PI / 4)
    minigunGroup.add(flashB)
    group.add(minigunGroup)

    // ── death-beam cannon morph assembly ────────────────────────────────────
    const cannonGroup = new THREE.Group()
    cannonGroup.position.set(0, 1.25, 0)
    cannonGroup.visible = false
    const breach = mesh(chamferBoxGeo(2.1, 1.7, 1.9, 0.25, 0.4), dark)
    breach.position.y = 0.5
    cannonGroup.add(breach)
    const barrel = mesh(new THREE.CylinderGeometry(0.58, 0.82, 4.8, 12), dark)
    barrel.position.y = 3.3
    cannonGroup.add(barrel)
    const cMuzzle = mesh(new THREE.TorusGeometry(0.72, 0.14, 8, 16), dark, false)
    cMuzzle.rotation.x = Math.PI / 2
    cMuzzle.position.y = 5.65
    cannonGroup.add(cMuzzle)
    const finGeo2 = new THREE.BoxGeometry(0.16, 3.6, 0.7)
    for (let b = 0; b < 3; b++) {
      const a = (b / 3) * Math.PI * 2
      const fin = mesh(finGeo2, dark)
      fin.position.set(Math.cos(a) * 0.85, 3.1, Math.sin(a) * 0.85)
      fin.rotation.y = -a
      cannonGroup.add(fin)
    }
    const chargeMat = emissiveMaterial(0xff5533, 0)
    chargeMat.color.multiplyScalar(3.4)
    chargeMat.blending = THREE.AdditiveBlending
    chargeMat.depthWrite = false
    const charge = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 12), chargeMat)
    charge.position.y = 5.75
    charge.scale.setScalar(0.01)
    cannonGroup.add(charge)
    group.add(cannonGroup)

    // ── cargo: dummy robot silhouettes gripped in the fingers ───────────────
    const cargo = new THREE.Group()
    cargo.position.set(0, 1.9, -1.0)
    cargo.visible = false
    const cargoBots: THREE.Group[] = []
    const botBody = chamferBoxGeo(0.56, 0.78, 0.4, 0.08, 1)
    const botHead = new THREE.BoxGeometry(0.34, 0.3, 0.32)
    const eyeMat = emissiveMaterial(0xff3344)
    eyeMat.color.multiplyScalar(2)
    const eyeGeo = new THREE.BoxGeometry(0.26, 0.06, 0.05)
    const brnd = seededRandom(311)
    for (let b = 0; b < 5; b++) {
      const bot = new THREE.Group()
      const body = mesh(botBody, dark)
      bot.add(body)
      const h = mesh(botHead, dark)
      h.position.y = 0.56
      bot.add(h)
      const eye = new THREE.Mesh(eyeGeo, eyeMat)
      eye.position.set(0, 0.56, -0.18)
      bot.add(eye)
      bot.position.set((b - 2) * 0.62 + (brnd() - 0.5) * 0.2, -0.5 - brnd() * 0.5, (brnd() - 0.5) * 0.4)
      bot.rotation.set((brnd() - 0.5) * 0.5, brnd() * Math.PI, (brnd() - 0.5) * 0.6)
      cargo.add(bot)
      cargoBots.push(bot)
    }
    group.add(cargo)

    return {
      group,
      fingers,
      minigun: { group: minigunGroup, spinner, flashMat },
      cannon: { group: cannonGroup, charge, chargeMat },
      cargo,
      cargoBots,
    }
  }

  function buildArm(): ArmRig {
    const group = new THREE.Group()
    const segs: THREE.Mesh[] = []
    const collars: THREE.Mesh[] = []
    const pistons: THREE.Mesh[] = []
    for (let i = 0; i < ARM_SEGMENTS; i++) {
      const seg = mesh(segGeos[i], dark)
      group.add(seg)
      segs.push(seg)
      const rod = mesh(pistonGeo, dark, false)
      group.add(rod)
      pistons.push(rod)
      if (i > 0) {
        const collar = mesh(collarGeos[i - 1], dark)
        // cable loop ring hugs every other collar
        if (i % 2 === 1) {
          const loop = mesh(loopGeo, dark, false)
          loop.rotation.x = Math.PI / 2
          loop.scale.setScalar(SEG_RADIUS[i] + 0.3)
          collar.add(loop)
        }
        group.add(collar)
        collars.push(collar)
      }
    }
    const shoulder = mesh(shoulderGeo, dark)
    group.add(shoulder)
    const hand = buildHand()
    group.add(hand.group)
    return { group, segs, collars, pistons, shoulder, hand }
  }

  const armL = buildArm()
  const armR = buildArm()
  model.add(armL.group, armR.group)

  // ── spark clusters (punch linger / tired hands) ───────────────────────────
  const sparkGeo = new THREE.TetrahedronGeometry(0.17)
  const sparkMat = emissiveMaterial(0xffd166)
  sparkMat.color.multiplyScalar(2.6)
  const sparks: AgiRig['sparks'] = []
  for (let sI = 0; sI < 2; sI++) {
    const group = new THREE.Group()
    group.visible = false
    const bits: THREE.Mesh[] = []
    for (let b = 0; b < 7; b++) {
      const bit = new THREE.Mesh(sparkGeo, sparkMat)
      group.add(bit)
      bits.push(bit)
    }
    model.add(group)
    sparks.push({ group, bits })
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

  // ── death debris chunks ───────────────────────────────────────────────────
  const debrisGroup = new THREE.Group()
  debrisGroup.visible = false
  const chunks: THREE.Mesh[] = []
  const drnd = seededRandom(777)
  for (let i = 0; i < 8; i++) {
    const chunk = mesh(chamferBoxGeo(1.4 + drnd() * 2.6, 1.0 + drnd() * 2.0, 0.8 + drnd() * 1.8, 0.25), hull)
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
    reactorMat,
    fan,
    ledMats,
    sparks,
    beam: { group: beamGroup, core: beamCore, sheath: beamSheath, sheathMat, impact: beamImpact, impactMat },
    debris: { group: debrisGroup, chunks },
  }
}
