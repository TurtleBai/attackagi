'use client'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { chassisMaterial, darkMetalMaterial, glowMetal } from '@/game/gfx/materials'
import type { EnemyKind } from '@/game/types'

// chest-plate emblem placement per kind (torso-local; z sits just proud of the plate)
export const DECAL_PLACEMENT: Record<EnemyKind, { y: number; z: number; s: number }> = {
  melee: { y: 0.16, z: 0.245, s: 0.2 },
  ranger: { y: 0.16, z: 0.2, s: 0.17 },
  tank: { y: 0.02, z: 0.38, s: 0.27 },
  sniper: { y: 0.2, z: 0.175, s: 0.14 },
}

// Procedural articulated robot bodies for the 4 enemy kinds. ONE template rig is
// built per kind (all compound parts pre-merged into few geometries) and never added
// to the scene: Enemies.tsx poses the shared rig per enemy per frame, and
// Enemies.instanced.ts copies each posed part's world matrix into that part's
// InstancedMesh slot — so the whole crowd renders in a fixed handful of draw calls.

// ─── Geometry toolkit (cached, shared across every instance) ─────────────────

const geoCache = new Map<string, THREE.BufferGeometry>()
function cachedGeo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key)
  if (!g) {
    g = make()
    geoCache.set(key, g)
  }
  return g
}

/** Box with real beveled edges (extruded rounded rect) — silhouette-changing relief. */
function bevelBox(w: number, h: number, d: number, bevel = 0.03): THREE.BufferGeometry {
  return cachedGeo(`bb:${w}:${h}:${d}:${bevel}`, () => {
    const b = Math.min(bevel, w * 0.24, h * 0.24, d * 0.24)
    const sw = w - b * 2, sh = h - b * 2
    const r = Math.min(b, sw / 3, sh / 3)
    const x = -sw / 2, y = -sh / 2
    const s = new THREE.Shape()
    s.moveTo(x + r, y)
    s.lineTo(x + sw - r, y)
    s.quadraticCurveTo(x + sw, y, x + sw, y + r)
    s.lineTo(x + sw, y + sh - r)
    s.quadraticCurveTo(x + sw, y + sh, x + sw - r, y + sh)
    s.lineTo(x + r, y + sh)
    s.quadraticCurveTo(x, y + sh, x, y + sh - r)
    s.lineTo(x, y + r)
    s.quadraticCurveTo(x, y, x + r, y)
    const depth = Math.max(0.01, d - b * 2)
    const g = new THREE.ExtrudeGeometry(s, {
      depth, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 2,
    })
    g.translate(0, 0, -depth / 2)
    return g
  })
}

const cyl = (rt: number, rb: number, h: number, seg = 10) =>
  cachedGeo(`cyl:${rt}:${rb}:${h}:${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg))
const boxG = (w: number, h: number, d: number) =>
  cachedGeo(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d))
const sph = (r: number, seg = 10) =>
  cachedGeo(`sph:${r}:${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 3)))

interface Part {
  g: THREE.BufferGeometry
  p?: [number, number, number]
  r?: [number, number, number]
  s?: [number, number, number]
}

const _m4 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _vp = new THREE.Vector3()
const _vs = new THREE.Vector3()

/** Bake a list of transformed sub-geometries into one draw call. */
function mergeParts(key: string, parts: Part[]): THREE.BufferGeometry {
  return cachedGeo(`merge:${key}`, () => {
    const list = parts.map(({ g, p, r, s }) => {
      const gg = g.index ? g.toNonIndexed() : g.clone()
      _e.set(...(r ?? [0, 0, 0]))
      _q.setFromEuler(_e)
      _vp.set(...(p ?? [0, 0, 0]))
      _vs.set(...(s ?? [1, 1, 1]))
      _m4.compose(_vp, _q, _vs)
      gg.applyMatrix4(_m4)
      return gg
    })
    const merged = mergeGeometries(list, false)
    list.forEach((g) => g.dispose())
    return merged ?? list[0] ?? new THREE.BufferGeometry()
  })
}

/** Full leg hanging from a hip pivot: hydraulic thigh + knee ball + shin + piston + foot. */
function legGeo(key: string, L: number, t: number, side: number): THREE.BufferGeometry {
  const th = L * 0.47, sh = L * 0.47
  return mergeParts(`leg:${key}:${L}:${t}:${side}`, [
    { g: sph(0.17 * t, 10), p: [0, 0, 0] }, // hip ball
    { g: cyl(0.115 * t, 0.14 * t, th, 10), p: [0, -th / 2 - 0.02, 0] },
    { g: cyl(0.05 * t, 0.05 * t, th * 0.7, 6), p: [side * 0.13 * t, -th * 0.55, 0.05 * t], r: [0.16, 0, 0] }, // piston
    { g: sph(0.15 * t, 10), p: [0, -th - 0.03, 0.01] }, // knee
    { g: cyl(0.09 * t, 0.115 * t, sh, 10), p: [0, -th - sh / 2 - 0.04, -0.01] },
    { g: bevelBox(0.32 * t, 0.1, 0.52 * t, 0.02), p: [0, -L + 0.05, 0.07 * t] }, // foot
    { g: boxG(0.1 * t, 0.06, 0.2 * t), p: [0, -L + 0.11, -0.14 * t] }, // heel greeble
  ])
}

/** Arm hanging from a shoulder pivot: shoulder ball + upper + elbow + forearm + hand. */
function armGeo(key: string, L: number, t: number): THREE.BufferGeometry {
  return mergeParts(`arm:${key}:${L}:${t}`, [
    { g: sph(0.15 * t, 10), p: [0, 0, 0] },
    { g: cyl(0.09 * t, 0.11 * t, L * 0.45, 8), p: [0, -L * 0.225, 0] },
    { g: sph(0.115 * t, 8), p: [0, -L * 0.47, 0.01] },
    { g: cyl(0.075 * t, 0.09 * t, L * 0.42, 8), p: [0, -L * 0.68, 0] },
    { g: bevelBox(0.15 * t, 0.2 * t, 0.16 * t, 0.02), p: [0, -L * 0.95, 0.01] },
  ])
}

// ─── Materials ───────────────────────────────────────────────────────────────

export const KIND_TINT: Record<EnemyKind, number> = {
  melee: 0xd8b9a8, // rust-warm plating
  ranger: 0xaec6dd, // cold blue-grey
  tank: 0xbfc4a6, // olive drab
  sniper: 0xc9b6d8, // faded violet
}

// ─── Template construction ───────────────────────────────────────────────────

const templates = new Map<EnemyKind, THREE.Group>()

function meshOf(geo: THREE.BufferGeometry, mat: THREE.Material, matKey: 'chassis' | 'dark', cast = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.userData.matKey = matKey
  m.castShadow = cast
  m.receiveShadow = cast
  return m
}

function glowMesh(geo: THREE.BufferGeometry, color: number, intensity: number, glowKey: string): THREE.Mesh {
  const m = new THREE.Mesh(geo, glowMetal(color, intensity))
  m.userData.matKey = `glow:${glowKey}`
  return m
}

function grp(name: string, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Group {
  const g = new THREE.Group()
  g.name = name
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

function buildTemplate(kind: EnemyKind): THREE.Group {
  const chassis = chassisMaterial(KIND_TINT[kind])
  const dark = darkMetalMaterial()
  const g = new THREE.Group()
  const root = grp('root', 0, 0, 0, g)

  if (kind === 'melee') {
    // lean chassis, one big glowing eye, power sword in the right hand
    const hipY = 1.06
    const legL = grp('legL', 0.17, hipY, 0, root)
    const legR = grp('legR', -0.17, hipY, 0, root)
    legL.add(meshOf(legGeo('lean', hipY, 0.55, 1), dark, 'dark'))
    legR.add(meshOf(legGeo('lean', hipY, 0.55, -1), dark, 'dark'))
    const pelvis = meshOf(bevelBox(0.42, 0.24, 0.3, 0.04), chassis, 'chassis')
    pelvis.position.set(0, 1.14, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.44, 0, root)
    torso.rotation.x = 0.1
    torso.add(meshOf(mergeParts('meleeTorso:c', [
      { g: bevelBox(0.58, 0.6, 0.34, 0.05), p: [0, 0.1, 0] },
      { g: bevelBox(0.22, 0.13, 0.28, 0.03), p: [0.34, 0.32, 0] },
      { g: bevelBox(0.22, 0.13, 0.28, 0.03), p: [-0.34, 0.32, 0] },
      { g: bevelBox(0.4, 0.28, 0.08, 0.025), p: [0, 0.16, 0.19] }, // chest plate
      { g: bevelBox(0.34, 0.22, 0.26, 0.03), p: [0, -0.26, 0] }, // abdomen
    ]), chassis, 'chassis'))
    torso.add(meshOf(mergeParts('meleeTorso:d', [
      { g: cyl(0.11, 0.13, 0.1, 10), p: [0, 0.42, 0] }, // collar
      { g: cyl(0.13, 0.15, 0.12, 10), p: [0, -0.4, 0] }, // waist joint
      { g: boxG(0.22, 0.028, 0.05), p: [0, -0.04, 0.21] }, // vents
      { g: boxG(0.22, 0.028, 0.05), p: [0, -0.1, 0.21] },
      { g: boxG(0.22, 0.028, 0.05), p: [0, -0.16, 0.21] },
      { g: bevelBox(0.3, 0.34, 0.12, 0.03), p: [0, 0.1, -0.22] }, // backpack
      { g: cyl(0.008, 0.008, 0.32, 5), p: [-0.12, 0.42, -0.2] }, // antenna
    ]), dark, 'dark'))
    const head = grp('head', 0, 0.55, 0.04, torso)
    head.add(meshOf(bevelBox(0.28, 0.26, 0.3, 0.04), chassis, 'chassis'))
    head.add(meshOf(mergeParts('meleeHead:d', [
      { g: cyl(0.115, 0.125, 0.08, 14), p: [0, 0, 0.14], r: [Math.PI / 2, 0, 0] }, // eye ring
      { g: bevelBox(0.3, 0.06, 0.1, 0.02), p: [0, 0.14, 0.1] }, // brow
    ]), dark, 'dark', false))
    const eye = glowMesh(cyl(0.085, 0.085, 0.03, 14), 0xff2d1a, 2.4, 'eye')
    eye.position.set(0, 0, 0.175)
    eye.rotation.x = Math.PI / 2
    head.add(eye)
    const armL = grp('armL', 0.4, 0.3, 0, torso)
    armL.add(meshOf(armGeo('lean', 0.9, 0.6), dark, 'dark'))
    const armR = grp('armR', -0.4, 0.3, 0, torso)
    armR.add(meshOf(armGeo('lean', 0.9, 0.6), dark, 'dark'))
    // power sword held in the right hand, blade continuing down past the fist
    const weapon = grp('weapon', 0, -0.86, 0.03, armR)
    weapon.rotation.x = -0.45
    weapon.add(meshOf(mergeParts('sword:d', [
      { g: cyl(0.028, 0.032, 0.26, 8), p: [0, 0.1, 0] }, // grip up through the hand
      { g: bevelBox(0.16, 0.05, 0.08, 0.015), p: [0, -0.03, 0] }, // guard
      { g: bevelBox(0.035, 0.86, 0.13, 0.014), p: [0, -0.5, 0] }, // blade core
      { g: bevelBox(0.05, 0.1, 0.16, 0.015), p: [0, -0.95, -0.01] }, // tip mass
    ]), dark, 'dark'))
    const edge = glowMesh(boxG(0.045, 0.82, 0.024), 0xff5a2a, 2.8, 'blade')
    edge.position.set(0, -0.5, 0.07)
    weapon.add(edge)
  }

  if (kind === 'ranger') {
    // twin-lens head, rifle braced two-handed, planted stance
    const hipY = 1.02
    const legL = grp('legL', 0.16, hipY, 0, root)
    const legR = grp('legR', -0.16, hipY, 0, root)
    legL.add(meshOf(legGeo('slim', hipY, 0.5, 1), dark, 'dark'))
    legR.add(meshOf(legGeo('slim', hipY, 0.5, -1), dark, 'dark'))
    legL.rotation.x = 0.3 // braced: one foot forward…
    legR.rotation.x = -0.24 // …one back
    root.position.y = -0.045
    const pelvis = meshOf(bevelBox(0.38, 0.2, 0.28, 0.035), chassis, 'chassis')
    pelvis.position.set(0, 1.08, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.36, 0, root)
    torso.rotation.y = 0.28 // bladed stance toward target
    torso.add(meshOf(mergeParts('rangerTorso:c', [
      { g: bevelBox(0.5, 0.55, 0.3, 0.045), p: [0, 0.08, 0] },
      { g: bevelBox(0.36, 0.2, 0.06, 0.02), p: [0, 0.16, 0.16] },
      { g: bevelBox(0.3, 0.18, 0.24, 0.03), p: [0, -0.24, 0] },
    ]), chassis, 'chassis'))
    torso.add(meshOf(mergeParts('rangerTorso:d', [
      { g: cyl(0.095, 0.11, 0.09, 10), p: [0, 0.4, 0] },
      { g: cyl(0.11, 0.13, 0.1, 10), p: [0, -0.36, 0] },
      { g: bevelBox(0.3, 0.4, 0.14, 0.03), p: [0, 0.06, -0.2] }, // power pack
      { g: cyl(0.008, 0.008, 0.36, 5), p: [0.1, 0.44, -0.18] },
      { g: cyl(0.008, 0.008, 0.28, 5), p: [-0.08, 0.4, -0.18] },
      { g: boxG(0.18, 0.026, 0.05), p: [0, -0.06, 0.19] },
      { g: boxG(0.18, 0.026, 0.05), p: [0, -0.12, 0.19] },
    ]), dark, 'dark'))
    const head = grp('head', 0, 0.48, 0.02, torso)
    head.add(meshOf(bevelBox(0.26, 0.22, 0.26, 0.035), chassis, 'chassis'))
    const visor = meshOf(bevelBox(0.24, 0.1, 0.07, 0.02), dark, 'dark', false)
    visor.position.set(0, 0.01, 0.13)
    head.add(visor)
    for (const sx of [0.06, -0.06]) {
      const lens = glowMesh(cyl(0.042, 0.042, 0.03, 10), 0x35d4ff, 2.2, 'eye')
      lens.position.set(sx, 0.01, 0.17)
      lens.rotation.x = Math.PI / 2
      head.add(lens)
    }
    const armL = grp('armL', 0.36, 0.26, 0, torso)
    armL.add(meshOf(armGeo('slim', 0.85, 0.55), dark, 'dark'))
    armL.rotation.set(-1.3, 0.55, 0)
    const armR = grp('armR', -0.36, 0.26, 0, torso)
    armR.add(meshOf(armGeo('slim', 0.85, 0.55), dark, 'dark'))
    armR.rotation.set(-1.15, -0.2, 0)
    // rifle held across the chest; counter-rotated so the barrel faces the target
    const weapon = grp('weapon', 0.04, 0.02, 0.3, torso)
    weapon.rotation.y = -0.28
    weapon.add(meshOf(mergeParts('rangerRifle:d', [
      { g: bevelBox(0.07, 0.12, 0.52, 0.02), p: [0, 0, 0.05] }, // receiver
      { g: cyl(0.024, 0.026, 0.5, 8), p: [0, 0.025, 0.52], r: [Math.PI / 2, 0, 0] }, // barrel
      { g: boxG(0.05, 0.09, 0.2), p: [0, -0.01, -0.28] }, // stock
      { g: boxG(0.05, 0.13, 0.07), p: [0, -0.12, 0.02] }, // mag
      { g: boxG(0.04, 0.06, 0.04), p: [0, 0.09, 0.1] }, // sight
    ]), dark, 'dark'))
    const muzzleGlow = glowMesh(cyl(0.032, 0.032, 0.05, 8), 0x66d8ff, 1.4, 'muzzle')
    muzzleGlow.position.set(0, 0.025, 0.74)
    muzzleGlow.rotation.x = Math.PI / 2
    weapon.add(muzzleGlow)
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.025, 0.78)
    weapon.add(muzzle)
  }

  if (kind === 'tank') {
    // heavy squat frame behind a massive riveted riot shield
    const hipY = 0.88
    const legL = grp('legL', 0.26, hipY, 0, root)
    const legR = grp('legR', -0.26, hipY, 0, root)
    legL.add(meshOf(legGeo('heavy', hipY, 1.0, 1), dark, 'dark'))
    legR.add(meshOf(legGeo('heavy', hipY, 1.0, -1), dark, 'dark'))
    for (const [lg, sx] of [[legL, 1], [legR, -1]] as const) {
      const plate = meshOf(bevelBox(0.2, 0.32, 0.2, 0.03), chassis, 'chassis')
      plate.position.set(sx * 0.02, -0.22, 0.1)
      lg.add(plate)
    }
    const pelvis = meshOf(bevelBox(0.62, 0.26, 0.44, 0.05), chassis, 'chassis')
    pelvis.position.set(0, 0.97, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.42, 0, root)
    torso.add(meshOf(mergeParts('tankTorso:c', [
      { g: bevelBox(0.95, 0.7, 0.6, 0.07), p: [0, 0.05, 0] },
      { g: bevelBox(0.3, 0.24, 0.42, 0.04), p: [0.55, 0.16, 0] },
      { g: bevelBox(0.3, 0.24, 0.42, 0.04), p: [-0.55, 0.16, 0] },
      { g: bevelBox(0.6, 0.4, 0.1, 0.03), p: [0, 0.02, 0.32] },
    ]), chassis, 'chassis'))
    torso.add(meshOf(mergeParts('tankTorso:d', [
      { g: cyl(0.05, 0.06, 0.32, 8), p: [0.3, 0.52, -0.18] }, // exhaust stacks
      { g: cyl(0.05, 0.06, 0.26, 8), p: [-0.3, 0.49, -0.18] },
      { g: boxG(0.5, 0.03, 0.06), p: [0, -0.2, 0.34] },
      { g: boxG(0.5, 0.03, 0.06), p: [0, -0.27, 0.34] },
      { g: cyl(0.16, 0.19, 0.14, 12), p: [0, -0.42, 0] },
      { g: bevelBox(0.5, 0.42, 0.16, 0.04), p: [0, 0.05, -0.36] }, // engine block
    ]), dark, 'dark'))
    const head = grp('head', 0, 0.5, 0.12, torso)
    head.add(meshOf(bevelBox(0.32, 0.2, 0.3, 0.04), chassis, 'chassis'))
    const visor = glowMesh(boxG(0.2, 0.035, 0.03), 0xffa728, 2.0, 'eye')
    visor.position.set(0, 0, 0.16)
    head.add(visor)
    const armL = grp('armL', 0.66, 0.26, 0.1, torso)
    armL.add(meshOf(armGeo('heavy', 0.85, 1.05), dark, 'dark'))
    armL.rotation.set(-1.15, 0.35, 0)
    const armR = grp('armR', -0.66, 0.26, 0.1, torso)
    armR.add(meshOf(armGeo('heavy', 0.85, 1.05), dark, 'dark'))
    armR.rotation.set(-1.15, -0.35, 0)
    // the shield: thick beveled plate, edge frame, rivet studs, glowing view slit
    const shield = grp('shield', 0, 1.08, 0.58, root)
    const rivets: Part[] = []
    for (let i = 0; i < 5; i++) {
      rivets.push({ g: cyl(0.028, 0.032, 0.05, 8), p: [0.62, -0.72 + i * 0.36, 0.07], r: [Math.PI / 2, 0, 0] })
      rivets.push({ g: cyl(0.028, 0.032, 0.05, 8), p: [-0.62, -0.72 + i * 0.36, 0.07], r: [Math.PI / 2, 0, 0] })
    }
    for (let i = 0; i < 3; i++) {
      rivets.push({ g: cyl(0.028, 0.032, 0.05, 8), p: [-0.36 + i * 0.36, 0.82, 0.07], r: [Math.PI / 2, 0, 0] })
      rivets.push({ g: cyl(0.028, 0.032, 0.05, 8), p: [-0.36 + i * 0.36, -0.82, 0.07], r: [Math.PI / 2, 0, 0] })
    }
    shield.add(meshOf(mergeParts('shield:d', [
      { g: bevelBox(1.45, 1.8, 0.1, 0.045), p: [0, 0, 0] },
      { g: bevelBox(0.1, 1.86, 0.16, 0.025), p: [0.72, 0, 0] },
      { g: bevelBox(0.1, 1.86, 0.16, 0.025), p: [-0.72, 0, 0] },
      { g: bevelBox(1.52, 0.1, 0.16, 0.025), p: [0, 0.92, 0] },
      { g: bevelBox(1.52, 0.12, 0.18, 0.025), p: [0, -0.92, 0.02], r: [0.18, 0, 0] }, // skid
      { g: cyl(0.12, 0.15, 0.09, 14), p: [0, 0.12, 0.07], r: [Math.PI / 2, 0, 0] }, // boss hub
      ...rivets,
    ]), dark, 'dark'))
    const inset = meshOf(bevelBox(0.95, 1.15, 0.05, 0.025), chassis, 'chassis', false)
    inset.position.set(0, -0.12, 0.06)
    shield.add(inset)
    const slit = glowMesh(boxG(0.5, 0.045, 0.03), 0xffa728, 1.8, 'slit')
    slit.position.set(0, 0.52, 0.1)
    shield.add(slit)
  }

  if (kind === 'sniper') {
    // slim frame, oversized scope-lens over one eye, very long rifle
    const hipY = 1.04
    const legL = grp('legL', 0.15, hipY, 0, root)
    const legR = grp('legR', -0.15, hipY, 0, root)
    legL.add(meshOf(legGeo('slim', hipY, 0.48, 1), dark, 'dark'))
    legR.add(meshOf(legGeo('slim', hipY, 0.48, -1), dark, 'dark'))
    legL.rotation.x = 0.24
    legR.rotation.x = -0.2
    root.position.y = -0.03
    const pelvis = meshOf(bevelBox(0.36, 0.18, 0.26, 0.03), chassis, 'chassis')
    pelvis.position.set(0, 1.1, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.4, 0, root)
    torso.rotation.y = 0.35
    torso.add(meshOf(mergeParts('sniperTorso:c', [
      { g: bevelBox(0.44, 0.58, 0.26, 0.04), p: [0, 0.08, 0] },
      { g: bevelBox(0.3, 0.16, 0.05, 0.02), p: [0, 0.2, 0.14] },
      { g: bevelBox(0.28, 0.16, 0.22, 0.03), p: [0, -0.26, 0] },
    ]), chassis, 'chassis'))
    torso.add(meshOf(mergeParts('sniperTorso:d', [
      { g: cyl(0.085, 0.1, 0.09, 10), p: [0, 0.42, 0] },
      { g: cyl(0.1, 0.12, 0.1, 10), p: [0, -0.36, 0] },
      { g: bevelBox(0.26, 0.36, 0.12, 0.025), p: [0, 0.04, -0.17] },
      { g: cyl(0.007, 0.007, 0.44, 5), p: [-0.09, 0.5, -0.15] }, // tall antenna
      { g: sph(0.02, 6), p: [-0.09, 0.72, -0.15] },
      { g: boxG(0.16, 0.024, 0.05), p: [0, -0.08, 0.17] },
    ]), dark, 'dark'))
    const head = grp('head', 0, 0.48, 0.02, torso)
    head.add(meshOf(bevelBox(0.26, 0.24, 0.26, 0.035), chassis, 'chassis'))
    head.add(meshOf(mergeParts('sniperHead:d', [
      { g: cyl(0.105, 0.12, 0.16, 14), p: [0.07, 0.01, 0.12], r: [Math.PI / 2, 0, 0] }, // scope housing
      { g: bevelBox(0.08, 0.05, 0.1, 0.015), p: [0.16, 0.1, 0.06] }, // housing bracket
    ]), dark, 'dark', false))
    const lens = glowMesh(cyl(0.08, 0.08, 0.03, 14), 0xff3050, 1.6, 'lens')
    lens.position.set(0.07, 0.01, 0.21)
    lens.rotation.x = Math.PI / 2
    head.add(lens)
    const eyeS = glowMesh(cyl(0.026, 0.026, 0.025, 8), 0xff3050, 1.4, 'eye')
    eyeS.position.set(-0.07, 0.01, 0.14)
    eyeS.rotation.x = Math.PI / 2
    head.add(eyeS)
    const armL = grp('armL', 0.32, 0.26, 0, torso)
    armL.add(meshOf(armGeo('sniper', 0.85, 0.5), dark, 'dark'))
    armL.rotation.set(-1.45, 0.5, 0)
    const armR = grp('armR', -0.32, 0.26, 0, torso)
    armR.add(meshOf(armGeo('sniper', 0.85, 0.5), dark, 'dark'))
    armR.rotation.set(-1.05, -0.25, 0)
    const weapon = grp('weapon', 0.05, 0.12, 0.24, torso)
    weapon.rotation.y = -0.35 // counter the bladed torso so the barrel tracks the target
    weapon.add(meshOf(mergeParts('sniperRifle:d', [
      { g: bevelBox(0.06, 0.1, 0.55, 0.018), p: [0, 0, 0] }, // receiver
      { g: cyl(0.02, 0.022, 1.05, 8), p: [0, 0.03, 0.75], r: [Math.PI / 2, 0, 0] }, // long barrel
      { g: cyl(0.035, 0.04, 0.3, 8), p: [0, 0.03, 0.38], r: [Math.PI / 2, 0, 0] }, // shroud
      { g: cyl(0.045, 0.045, 0.09, 8), p: [0, 0.03, 1.24], r: [Math.PI / 2, 0, 0] }, // brake
      { g: cyl(0.04, 0.04, 0.26, 10), p: [0, 0.12, -0.04], r: [Math.PI / 2, 0, 0] }, // top scope
      { g: boxG(0.05, 0.1, 0.2), p: [0, -0.02, -0.36] }, // stock
      { g: boxG(0.045, 0.12, 0.06), p: [0, -0.1, 0.02] }, // grip
    ]), dark, 'dark'))
    const muzzleGlow = glowMesh(cyl(0.028, 0.028, 0.04, 8), 0xff5060, 1.3, 'muzzle')
    muzzleGlow.position.set(0, 0.03, 1.22)
    muzzleGlow.rotation.x = Math.PI / 2
    weapon.add(muzzleGlow)
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.03, 1.3)
    weapon.add(muzzle)
  }

  return g
}

// ─── Shared kind rigs (template + posing handles + part enumeration) ─────────

export interface NodeBase {
  px: number; py: number; pz: number
  rx: number; ry: number; rz: number
}

export interface TemplatePart {
  /** template mesh — posed world matrices are read from here every frame */
  mesh: THREE.Mesh
  /** material bucket: 'chassis' | 'dark' | 'glow:<key>' */
  bucket: string
}

export interface KindRig {
  kind: EnemyKind
  /** template root — NOT in the scene; posed in place per enemy per frame */
  group: THREE.Group
  nodes: Record<string, THREE.Object3D>
  base: Record<string, NodeBase>
  parts: TemplatePart[]
  glowKeys: string[]
}

const NODE_NAMES = ['root', 'torso', 'head', 'armL', 'armR', 'legL', 'legR', 'weapon', 'shield', 'muzzle']

const rigs = new Map<EnemyKind, KindRig>()

export function getKindRig(kind: EnemyKind): KindRig {
  let rig = rigs.get(kind)
  if (rig) return rig
  let group = templates.get(kind)
  if (!group) {
    group = buildTemplate(kind)
    templates.set(kind, group)
  }
  const nodes: Record<string, THREE.Object3D> = {}
  const base: Record<string, NodeBase> = {}
  for (const name of NODE_NAMES) {
    const n = group.getObjectByName(name)
    if (!n) continue
    nodes[name] = n
    base[name] = {
      px: n.position.x, py: n.position.y, pz: n.position.z,
      rx: n.rotation.x, ry: n.rotation.y, rz: n.rotation.z,
    }
  }
  const parts: TemplatePart[] = []
  const glowKeys: string[] = []
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const bucket = (mesh.userData.matKey as string | undefined) ?? 'dark'
    parts.push({ mesh, bucket })
    if (bucket.startsWith('glow:')) {
      const key = bucket.slice(5)
      if (!glowKeys.includes(key)) glowKeys.push(key)
    }
  })
  rig = { kind, group, nodes, base, parts, glowKeys }
  rigs.set(kind, rig)
  return rig
}

// ─── Straggler outline (shared inverted-hull materials, instanced) ───────────
// Two shells per part InstancedMesh: a depth-tested bright rim, and a faint
// depth-ignoring silhouette so the last few enemies read through cover. Shared
// materials keep this to two uniform writes per frame; hull meshes reuse the
// part geometry AND the part's instanceMatrix (Enemies.instanced.ts).

function outlineShader(grow: number, r: number, g: number, b: number, alpha: number, depthTest: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uPulse: { value: 1 }, uColor: { value: new THREE.Color(r, g, b) }, uAlpha: { value: alpha } },
    vertexShader: /* glsl */ `
void main(){
  vec3 p = position + normal * ${grow.toFixed(3)};
  #ifdef USE_INSTANCING
    p = (instanceMatrix * vec4(p, 1.0)).xyz;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uColor;
uniform float uPulse, uAlpha;
void main(){ gl_FragColor = vec4(uColor * uPulse, uAlpha); }`,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest,
  })
}

let rimMat: THREE.ShaderMaterial | null = null
let xrayMat: THREE.ShaderMaterial | null = null

export function outlineMaterials(): { rim: THREE.ShaderMaterial; xray: THREE.ShaderMaterial } {
  if (!rimMat) rimMat = outlineShader(0.035, 3.2, 0.9, 0.3, 0.9, true)
  if (!xrayMat) xrayMat = outlineShader(0.05, 1.3, 0.42, 0.16, 0.45, false)
  return { rim: rimMat, xray: xrayMat }
}

/** Animate the shared outline pulse; call once per frame from the Enemies loop. */
export function updateOutlinePulse(time: number): void {
  if (!rimMat || !xrayMat) return
  const s = Math.sin(time * 7)
  rimMat.uniforms.uPulse.value = 0.85 + 0.4 * s
  xrayMat.uniforms.uPulse.value = 0.55 + 0.25 * s
}

/** Shared unit-box geometry (sniper laser sight instancing needs it too). */
export function unitBoxGeometry(): THREE.BufferGeometry {
  return boxG(1, 1, 1)
}
