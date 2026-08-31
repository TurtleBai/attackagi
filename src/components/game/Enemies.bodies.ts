'use client'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { chassisMaterial, darkMetalMaterial, glowMetal } from '@/game/gfx/materials'
import type { EnemyKind } from '@/game/types'

// Glowing head-display placement per kind (head-local: quad center + size) and the
// per-kind display tint. One InstancedMesh quad per kind (Enemies.instanced.ts)
// shows each enemy's AI-lab logo as a lit screen on the head unit's front face —
// this is the robot's lab identity (the old chest emblems are gone).
export const SCREEN_PLACEMENT: Record<
  EnemyKind,
  { x: number; y: number; z: number; w: number; h: number; tint: number }
> = {
  melee: { x: 0, y: 0, z: 0.148, w: 0.16, h: 0.26, tint: 0xff3b22 }, // narrow vertical face
  ranger: { x: 0, y: -0.015, z: 0.138, w: 0.28, h: 0.11, tint: 0x35d4ff }, // wide visor strip
  tank: { x: 0, y: -0.01, z: 0.178, w: 0.32, h: 0.1, tint: 0xffa728 }, // low armored slab
  sniper: { x: -0.075, y: 0, z: 0.138, w: 0.13, h: 0.17, tint: 0x38ff7a }, // beside the scope
  drone: { x: 0, y: 0, z: 0.408, w: 0.22, h: 0.13, tint: 0xc07dff }, // nose face of the pod
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
const torus = (r: number, tube: number, seg = 8, tseg = 18) =>
  cachedGeo(`tor:${r}:${tube}:${seg}:${tseg}`, () => new THREE.TorusGeometry(r, tube, seg, tseg))
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

/** Full leg hanging from a hip pivot: armored thigh + knee housing + plated shin + big boot. */
function legGeo(key: string, L: number, t: number, side: number): THREE.BufferGeometry {
  const th = L * 0.47, sh = L * 0.47
  return mergeParts(`leg:${key}:${L}:${t}:${side}`, [
    { g: sph(0.19 * t, 10), p: [0, 0, 0] }, // hip ball
    { g: cyl(0.15 * t, 0.17 * t, th, 10), p: [0, -th / 2 - 0.02, 0] }, // thigh core
    { g: bevelBox(0.3 * t, th * 0.72, 0.3 * t, 0.03), p: [0, -th * 0.52, 0.04 * t] }, // thigh armor
    { g: cyl(0.06 * t, 0.06 * t, th * 0.7, 6), p: [side * 0.18 * t, -th * 0.55, 0.1 * t], r: [0.16, 0, 0] }, // piston
    { g: sph(0.16 * t, 10), p: [0, -th - 0.03, 0.01] }, // knee ball
    { g: bevelBox(0.26 * t, 0.2 * t, 0.26 * t, 0.03), p: [0, -th - 0.03, 0.03 * t] }, // knee housing
    { g: cyl(0.12 * t, 0.15 * t, sh, 10), p: [0, -th - sh / 2 - 0.04, -0.01] }, // shin core
    { g: bevelBox(0.22 * t, sh * 0.6, 0.14 * t, 0.025), p: [0, -th - sh * 0.52, 0.08 * t] }, // shin guard
    { g: bevelBox(0.38 * t, 0.16, 0.6 * t, 0.03), p: [0, -L + 0.08, 0.08 * t] }, // boot
    { g: bevelBox(0.3 * t, 0.11, 0.16 * t, 0.02), p: [0, -L + 0.055, 0.38 * t] }, // toe cap
    { g: boxG(0.16 * t, 0.1, 0.2 * t), p: [0, -L + 0.13, -0.18 * t] }, // heel block
  ])
}

/** Arm hanging from a shoulder pivot: deltoid housing + upper + elbow block + guarded forearm + fist. */
function armGeo(key: string, L: number, t: number): THREE.BufferGeometry {
  return mergeParts(`arm:${key}:${L}:${t}`, [
    { g: sph(0.17 * t, 10), p: [0, 0, 0] }, // shoulder ball
    { g: cyl(0.17 * t, 0.14 * t, 0.16 * t, 10), p: [0, -0.02 * t, 0] }, // deltoid ring (pivot-safe)
    { g: cyl(0.12 * t, 0.14 * t, L * 0.45, 8), p: [0, -L * 0.225, 0] }, // upper arm
    { g: sph(0.13 * t, 8), p: [0, -L * 0.47, 0.01] }, // elbow ball
    { g: bevelBox(0.2 * t, 0.17 * t, 0.2 * t, 0.025), p: [0, -L * 0.47, 0.01] }, // elbow housing
    { g: cyl(0.1 * t, 0.12 * t, L * 0.42, 8), p: [0, -L * 0.68, 0] }, // forearm
    { g: bevelBox(0.19 * t, L * 0.34, 0.22 * t, 0.025), p: [0, -L * 0.68, 0.01] }, // forearm guard
    { g: bevelBox(0.2 * t, 0.24 * t, 0.2 * t, 0.025), p: [0, -L * 0.95, 0.01] }, // fist
  ])
}

// ─── Two-hand rifle grip toolkit (ranger + sniper) ───────────────────────────

const UP_Y = new THREE.Vector3(0, 1, 0)
const DOWN_Y = new THREE.Vector3(0, -1, 0)

/** Cylinder Part running from point `a` to point `b` (merge-local space). */
function tubePart(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, seg = 8): Part {
  const d = new THREE.Vector3().subVectors(b, a)
  const len = Math.max(0.01, d.length())
  const e = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(UP_Y, d.normalize()),
  )
  return {
    g: cyl(r0, r1, len, seg),
    p: [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2],
    r: [e.x, e.y, e.z],
  }
}

/** Shoulder-to-elbow arm stub for rifle carriers (forearm + hand are baked into the rifle). */
function upperArmGeo(key: string, L: number, t: number): THREE.BufferGeometry {
  return mergeParts(`uarm:${key}:${L}:${t}`, [
    { g: sph(0.17 * t, 10), p: [0, 0, 0] }, // shoulder ball
    { g: cyl(0.17 * t, 0.14 * t, 0.16 * t, 10), p: [0, -0.02 * t, 0] }, // deltoid ring
    { g: cyl(0.12 * t, 0.13 * t, L * 0.9, 8), p: [0, -L * 0.5, 0] }, // upper arm
    { g: sph(0.12 * t, 8), p: [0, -L, 0] }, // elbow ball (lands in the rifle's elbow housing)
  ])
}

/**
 * Bake one gripping arm into a rifle, at template-build time: computes a
 * weapon-local elbow between the arm pivot and the hand target, AIMS the arm
 * group at it (so the shoulder-to-elbow stub stays connected), and returns
 * forearm + elbow-housing + hand Parts to merge INTO the weapon geometry — the
 * hold rides every per-frame weapon pitch/recoil write for free, and the elbow
 * housing masks the seam where the static upper arm meets the pitching forearm.
 * `weapon` and `arm` must share a parent (the torso); `weapon` may only yaw.
 */
function bakeGrip(
  weapon: THREE.Group, arm: THREE.Group,
  hand: [number, number, number], upperLen: number, t: number,
): Part[] {
  const yaw = weapon.rotation.y
  const sW = new THREE.Vector3().subVectors(arm.position, weapon.position)
    .applyAxisAngle(UP_Y, -yaw) // shoulder pivot, weapon-local
  const hW = new THREE.Vector3(...hand)
  const dir = new THREE.Vector3().subVectors(hW, sW)
  dir.y -= 0.18 // elbow hangs below the straight shoulder-to-hand line
  dir.normalize()
  const eW = new THREE.Vector3().copy(sW).addScaledVector(dir, upperLen) // elbow, weapon-local
  const eT = new THREE.Vector3().copy(eW).applyAxisAngle(UP_Y, yaw).add(weapon.position)
  arm.quaternion.setFromUnitVectors(
    DOWN_Y, new THREE.Vector3().subVectors(eT, arm.position).normalize(),
  )
  return [
    tubePart(eW, hW, 0.085 * t, 0.105 * t), // forearm, elbow → hand
    { g: bevelBox(0.2 * t, 0.17 * t, 0.2 * t, 0.02), p: [eW.x, eW.y, eW.z] }, // elbow housing
    { g: bevelBox(0.15 * t, 0.16 * t, 0.19 * t, 0.02), p: hand }, // gripping hand
  ]
}

// ─── Materials ───────────────────────────────────────────────────────────────

export const KIND_TINT: Record<EnemyKind, number> = {
  melee: 0xd8b9a8, // rust-warm plating
  ranger: 0xaec6dd, // cold blue-grey
  tank: 0xbfc4a6, // olive drab
  sniper: 0xc9b6d8, // faded violet
  drone: 0x9f8fc4, // purple-grey gunship chassis
}

/** The drone's glow family — every emissive part of the gunship sits in this purple. */
export const DRONE_GLOW = 0xb26bff

// ─── Template construction ───────────────────────────────────────────────────

const templates = new Map<EnemyKind, THREE.Group>()

/**
 * `hull` marks a SILHOUETTE part: only these get straggler-outline shells
 * (rim + x-ray) in Enemies.instanced.ts. Tag legs/torso/head/weapon/shield —
 * the parts whose edges define the robot's read — and skip interior greeble
 * merges (bezels, vents, backpacks) whose outlines hide inside the big hulls
 * anyway. Explicit tags beat a size threshold here because greeble merges span
 * the same bounding volume as the casings they decorate.
 */
function meshOf(
  geo: THREE.BufferGeometry, mat: THREE.Material, matKey: 'chassis' | 'dark',
  cast = true, hull = false,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.userData.matKey = matKey
  m.userData.hull = hull
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
    // athletic-heavy chassis, narrow vertical display-face head, power sword in the right hand
    const hipY = 1.06
    const legL = grp('legL', 0.2, hipY, 0, root)
    const legR = grp('legR', -0.2, hipY, 0, root)
    legL.add(meshOf(legGeo('lean', hipY, 0.85, 1), dark, 'dark', true, true))
    legR.add(meshOf(legGeo('lean', hipY, 0.85, -1), dark, 'dark', true, true))
    const pelvis = meshOf(mergeParts('meleePelvis:c', [
      { g: bevelBox(0.56, 0.3, 0.4, 0.05), p: [0, 0, 0] },
      { g: bevelBox(0.2, 0.24, 0.34, 0.03), p: [0.3, -0.02, 0] }, // hip guards
      { g: bevelBox(0.2, 0.24, 0.34, 0.03), p: [-0.3, -0.02, 0] },
    ]), chassis, 'chassis')
    pelvis.position.set(0, 1.14, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.44, 0, root)
    torso.rotation.x = 0.1
    torso.add(meshOf(mergeParts('meleeTorso:c', [
      { g: bevelBox(0.74, 0.62, 0.42, 0.06), p: [0, 0.1, 0] }, // barrel chest
      { g: bevelBox(0.3, 0.18, 0.36, 0.035), p: [0.42, 0.33, 0] }, // shoulder yokes
      { g: bevelBox(0.3, 0.18, 0.36, 0.035), p: [-0.42, 0.33, 0] },
      { g: bevelBox(0.24, 0.14, 0.3, 0.03), p: [0.44, 0.43, 0] }, // pauldron caps
      { g: bevelBox(0.24, 0.14, 0.3, 0.03), p: [-0.44, 0.43, 0] },
      { g: bevelBox(0.54, 0.34, 0.1, 0.03), p: [0, 0.16, 0.22] }, // chest plate
      { g: bevelBox(0.12, 0.42, 0.34, 0.03), p: [0.4, 0.02, 0.02] }, // side armor
      { g: bevelBox(0.12, 0.42, 0.34, 0.03), p: [-0.4, 0.02, 0.02] },
      { g: bevelBox(0.46, 0.26, 0.34, 0.04), p: [0, -0.26, 0] }, // abdomen
    ]), chassis, 'chassis', true, true))
    torso.add(meshOf(mergeParts('meleeTorso:d', [
      { g: cyl(0.13, 0.15, 0.12, 10), p: [0, 0.44, 0] }, // collar
      { g: cyl(0.16, 0.18, 0.14, 10), p: [0, -0.42, 0] }, // waist joint
      { g: boxG(0.3, 0.03, 0.05), p: [0, -0.06, 0.24] }, // vents
      { g: boxG(0.3, 0.03, 0.05), p: [0, -0.12, 0.24] },
      { g: boxG(0.3, 0.03, 0.05), p: [0, -0.18, 0.24] },
      { g: bevelBox(0.4, 0.4, 0.14, 0.035), p: [0, 0.1, -0.27] }, // backpack
      { g: cyl(0.008, 0.008, 0.32, 5), p: [-0.14, 0.46, -0.24] }, // antenna
    ]), dark, 'dark'))
    // head: narrow vertical monitor unit — front face carries the glowing logo screen
    const head = grp('head', 0, 0.58, 0.04, torso)
    head.add(meshOf(mergeParts('meleeHead:c', [
      { g: bevelBox(0.26, 0.36, 0.28, 0.035), p: [0, 0, -0.02] }, // vertical casing
      { g: bevelBox(0.3, 0.1, 0.3, 0.03), p: [0, 0.2, -0.02] }, // armored crown
    ]), chassis, 'chassis', true, true))
    head.add(meshOf(mergeParts('meleeHead:d', [
      { g: bevelBox(0.21, 0.31, 0.05, 0.015), p: [0, 0, 0.115] }, // screen bezel
      { g: bevelBox(0.06, 0.34, 0.26, 0.02), p: [0.15, 0, -0.03] }, // cheek guards
      { g: bevelBox(0.06, 0.34, 0.26, 0.02), p: [-0.15, 0, -0.03] },
      { g: bevelBox(0.2, 0.07, 0.1, 0.02), p: [0, -0.2, 0.06] }, // chin block
    ]), dark, 'dark', false))
    const armL = grp('armL', 0.52, 0.3, 0, torso)
    armL.add(meshOf(armGeo('lean', 0.9, 0.9), dark, 'dark'))
    const armR = grp('armR', -0.52, 0.3, 0, torso)
    armR.add(meshOf(armGeo('lean', 0.9, 0.9), dark, 'dark'))
    // power sword held in the right hand, blade continuing down past the fist
    const weapon = grp('weapon', 0, -0.86, 0.03, armR)
    weapon.rotation.x = -0.45
    weapon.add(meshOf(mergeParts('sword:d', [
      { g: cyl(0.028, 0.032, 0.26, 8), p: [0, 0.1, 0] }, // grip up through the hand
      { g: bevelBox(0.16, 0.05, 0.08, 0.015), p: [0, -0.03, 0] }, // guard
      { g: bevelBox(0.035, 0.86, 0.13, 0.014), p: [0, -0.5, 0] }, // blade core
      { g: bevelBox(0.05, 0.1, 0.16, 0.015), p: [0, -0.95, -0.01] }, // tip mass
    ]), dark, 'dark', true, true))
    const edge = glowMesh(boxG(0.045, 0.82, 0.024), 0xff5a2a, 2.8, 'blade')
    edge.position.set(0, -0.5, 0.07)
    weapon.add(edge)
  }

  if (kind === 'ranger') {
    // mid-weight trooper, wide twin-brow visor display, rifle braced two-handed
    const hipY = 1.02
    const legL = grp('legL', 0.19, hipY, 0, root)
    const legR = grp('legR', -0.19, hipY, 0, root)
    legL.add(meshOf(legGeo('slim', hipY, 0.75, 1), dark, 'dark', true, true))
    legR.add(meshOf(legGeo('slim', hipY, 0.75, -1), dark, 'dark', true, true))
    legL.rotation.x = 0.3 // braced: one foot forward…
    legR.rotation.x = -0.24 // …one back
    root.position.y = -0.045
    const pelvis = meshOf(mergeParts('rangerPelvis:c', [
      { g: bevelBox(0.5, 0.26, 0.36, 0.04), p: [0, 0, 0] },
      { g: bevelBox(0.18, 0.2, 0.3, 0.03), p: [0.27, -0.02, 0] }, // hip guards
      { g: bevelBox(0.18, 0.2, 0.3, 0.03), p: [-0.27, -0.02, 0] },
    ]), chassis, 'chassis')
    pelvis.position.set(0, 1.08, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.36, 0, root)
    torso.rotation.y = 0.28 // bladed stance toward target
    torso.add(meshOf(mergeParts('rangerTorso:c', [
      { g: bevelBox(0.64, 0.58, 0.36, 0.05), p: [0, 0.08, 0] },
      { g: bevelBox(0.26, 0.16, 0.32, 0.03), p: [0.37, 0.3, 0] }, // shoulder yokes
      { g: bevelBox(0.26, 0.16, 0.32, 0.03), p: [-0.37, 0.3, 0] },
      { g: bevelBox(0.2, 0.12, 0.26, 0.025), p: [0.39, 0.4, 0] }, // pauldron caps
      { g: bevelBox(0.2, 0.12, 0.26, 0.025), p: [-0.39, 0.4, 0] },
      { g: bevelBox(0.46, 0.26, 0.09, 0.025), p: [0, 0.16, 0.19] }, // chest plate
      { g: bevelBox(0.1, 0.36, 0.3, 0.025), p: [0.34, 0.04, 0.01] }, // side armor
      { g: bevelBox(0.1, 0.36, 0.3, 0.025), p: [-0.34, 0.04, 0.01] },
      { g: bevelBox(0.4, 0.22, 0.3, 0.035), p: [0, -0.25, 0] }, // abdomen
    ]), chassis, 'chassis', true, true))
    torso.add(meshOf(mergeParts('rangerTorso:d', [
      { g: cyl(0.11, 0.13, 0.1, 10), p: [0, 0.4, 0] },
      { g: cyl(0.13, 0.15, 0.12, 10), p: [0, -0.38, 0] },
      { g: bevelBox(0.36, 0.42, 0.16, 0.035), p: [0, 0.06, -0.24] }, // power pack
      { g: cyl(0.008, 0.008, 0.36, 5), p: [0.1, 0.46, -0.2] },
      { g: cyl(0.008, 0.008, 0.28, 5), p: [-0.08, 0.42, -0.2] },
      { g: boxG(0.24, 0.028, 0.05), p: [0, -0.06, 0.22] },
      { g: boxG(0.24, 0.028, 0.05), p: [0, -0.12, 0.22] },
    ]), dark, 'dark'))
    // head: wide visor unit with twin brow plates over the glowing logo strip
    const head = grp('head', 0, 0.48, 0.02, torso)
    head.add(meshOf(mergeParts('rangerHead:c', [
      { g: bevelBox(0.36, 0.22, 0.26, 0.03), p: [0, 0, -0.01] }, // wide visor casing
      { g: bevelBox(0.4, 0.08, 0.28, 0.025), p: [0, 0.13, -0.01] }, // crown plate
    ]), chassis, 'chassis', true, true))
    head.add(meshOf(mergeParts('rangerHead:d', [
      { g: bevelBox(0.33, 0.145, 0.05, 0.015), p: [0, -0.015, 0.105] }, // screen bezel
      { g: bevelBox(0.16, 0.05, 0.08, 0.015), p: [0.09, 0.085, 0.1], r: [0, 0, -0.12] }, // twin brows
      { g: bevelBox(0.16, 0.05, 0.08, 0.015), p: [-0.09, 0.085, 0.1], r: [0, 0, 0.12] },
      { g: bevelBox(0.08, 0.2, 0.24, 0.02), p: [0.2, 0, -0.02] }, // ear armor
      { g: bevelBox(0.08, 0.2, 0.24, 0.02), p: [-0.2, 0, -0.02] },
    ]), dark, 'dark', false))
    const armL = grp('armL', 0.44, 0.26, 0, torso)
    const armR = grp('armR', -0.44, 0.26, 0, torso)
    // rifle shouldered against the left yoke, clear of the deeper chest; the
    // counter-yaw keeps the barrel tracking the target. bakeGrip aims both arm
    // groups and bakes the gripping forearms + hands into the rifle merge so the
    // hold survives poseRanger's per-frame pitch/recoil writes.
    const weapon = grp('weapon', 0.14, 0.12, 0.5, torso)
    weapon.rotation.y = -0.28
    weapon.add(meshOf(mergeParts('rangerRifle:d', [
      { g: bevelBox(0.07, 0.12, 0.52, 0.02), p: [0, 0, 0.05] }, // receiver
      { g: cyl(0.024, 0.026, 0.5, 8), p: [0, 0.025, 0.52], r: [Math.PI / 2, 0, 0] }, // barrel
      { g: boxG(0.05, 0.09, 0.2), p: [0, -0.01, -0.28] }, // stock
      { g: boxG(0.05, 0.13, 0.07), p: [0, -0.12, 0.02] }, // mag
      { g: boxG(0.04, 0.06, 0.04), p: [0, 0.09, 0.1] }, // sight
      ...bakeGrip(weapon, armR, [0, -0.11, 0], 0.42, 0.8), // trigger hand
      ...bakeGrip(weapon, armL, [0, -0.05, 0.2], 0.42, 0.8), // foregrip hand
    ]), dark, 'dark', true, true))
    armL.add(meshOf(upperArmGeo('slim', 0.42, 0.8), dark, 'dark'))
    armR.add(meshOf(upperArmGeo('slim', 0.42, 0.8), dark, 'dark'))
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
    // genuinely massive squat frame behind a riveted riot shield
    const hipY = 0.88
    const legL = grp('legL', 0.32, hipY, 0, root)
    const legR = grp('legR', -0.32, hipY, 0, root)
    legL.add(meshOf(legGeo('heavy', hipY, 1.35, 1), dark, 'dark', true, true))
    legR.add(meshOf(legGeo('heavy', hipY, 1.35, -1), dark, 'dark', true, true))
    for (const [lg, sx] of [[legL, 1], [legR, -1]] as const) {
      const plate = meshOf(bevelBox(0.3, 0.4, 0.26, 0.035), chassis, 'chassis')
      plate.position.set(sx * 0.02, -0.24, 0.16)
      lg.add(plate)
    }
    const pelvis = meshOf(mergeParts('tankPelvis:c', [
      { g: bevelBox(0.84, 0.32, 0.54, 0.06), p: [0, 0, 0] },
      { g: bevelBox(0.26, 0.28, 0.46, 0.04), p: [0.44, -0.04, 0] }, // hip guards
      { g: bevelBox(0.26, 0.28, 0.46, 0.04), p: [-0.44, -0.04, 0] },
    ]), chassis, 'chassis')
    pelvis.position.set(0, 0.97, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.42, 0, root)
    torso.add(meshOf(mergeParts('tankTorso:c', [
      { g: bevelBox(1.15, 0.76, 0.68, 0.08), p: [0, 0.05, 0] },
      { g: bevelBox(0.4, 0.3, 0.5, 0.05), p: [0.66, 0.18, 0] }, // shoulder blocks
      { g: bevelBox(0.4, 0.3, 0.5, 0.05), p: [-0.66, 0.18, 0] },
      { g: bevelBox(0.34, 0.16, 0.44, 0.04), p: [0.68, 0.38, 0] }, // pauldron caps
      { g: bevelBox(0.34, 0.16, 0.44, 0.04), p: [-0.68, 0.38, 0] },
      { g: bevelBox(0.72, 0.46, 0.12, 0.04), p: [0, 0.04, 0.36] }, // front plate
      { g: bevelBox(0.16, 0.5, 0.56, 0.04), p: [0.58, -0.02, 0] }, // side armor
      { g: bevelBox(0.16, 0.5, 0.56, 0.04), p: [-0.58, -0.02, 0] },
    ]), chassis, 'chassis', true, true))
    torso.add(meshOf(mergeParts('tankTorso:d', [
      { g: cyl(0.06, 0.07, 0.34, 8), p: [0.36, 0.56, -0.2] }, // exhaust stacks
      { g: cyl(0.06, 0.07, 0.28, 8), p: [-0.36, 0.53, -0.2] },
      { g: boxG(0.6, 0.035, 0.06), p: [0, -0.22, 0.4] },
      { g: boxG(0.6, 0.035, 0.06), p: [0, -0.29, 0.4] },
      { g: cyl(0.2, 0.24, 0.16, 12), p: [0, -0.45, 0] },
      { g: bevelBox(0.6, 0.48, 0.18, 0.045), p: [0, 0.05, -0.42] }, // engine block
    ]), dark, 'dark'))
    // head: low armored slab display peeking over the shield rim
    const head = grp('head', 0, 0.62, 0.14, torso)
    head.add(meshOf(mergeParts('tankHead:c', [
      { g: bevelBox(0.44, 0.2, 0.34, 0.035), p: [0, 0, -0.02] }, // low slab casing
      { g: bevelBox(0.5, 0.08, 0.4, 0.03), p: [0, 0.12, -0.03] }, // armored cowl overhang
    ]), chassis, 'chassis', true, true))
    head.add(meshOf(mergeParts('tankHead:d', [
      { g: bevelBox(0.37, 0.13, 0.05, 0.015), p: [0, -0.01, 0.145] }, // screen bezel
      { g: bevelBox(0.1, 0.16, 0.3, 0.02), p: [0.24, 0, -0.03] }, // side cheeks
      { g: bevelBox(0.1, 0.16, 0.3, 0.02), p: [-0.24, 0, -0.03] },
    ]), dark, 'dark', false))
    const armL = grp('armL', 0.78, 0.26, 0.1, torso)
    armL.add(meshOf(armGeo('heavy', 0.85, 1.3), dark, 'dark'))
    armL.rotation.set(-1.15, 0.35, 0)
    const armR = grp('armR', -0.78, 0.26, 0.1, torso)
    armR.add(meshOf(armGeo('heavy', 0.85, 1.3), dark, 'dark'))
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
    ]), dark, 'dark', true, true))
    const inset = meshOf(bevelBox(0.95, 1.15, 0.05, 0.025), chassis, 'chassis', false)
    inset.position.set(0, -0.12, 0.06)
    shield.add(inset)
    const slit = glowMesh(boxG(0.5, 0.045, 0.03), 0xffa728, 1.8, 'slit')
    slit.position.set(0, 0.52, 0.1)
    shield.add(slit)
  }

  if (kind === 'sniper') {
    // leanest frame but still armored; big green scope-lens beside a compact display unit
    const hipY = 1.04
    const legL = grp('legL', 0.18, hipY, 0, root)
    const legR = grp('legR', -0.18, hipY, 0, root)
    legL.add(meshOf(legGeo('slim', hipY, 0.7, 1), dark, 'dark', true, true))
    legR.add(meshOf(legGeo('slim', hipY, 0.7, -1), dark, 'dark', true, true))
    legL.rotation.x = 0.24
    legR.rotation.x = -0.2
    root.position.y = -0.03
    const pelvis = meshOf(mergeParts('sniperPelvis:c', [
      { g: bevelBox(0.46, 0.24, 0.32, 0.035), p: [0, 0, 0] },
      { g: bevelBox(0.16, 0.18, 0.26, 0.025), p: [0.25, -0.02, 0] }, // hip guards
      { g: bevelBox(0.16, 0.18, 0.26, 0.025), p: [-0.25, -0.02, 0] },
    ]), chassis, 'chassis')
    pelvis.position.set(0, 1.1, 0)
    root.add(pelvis)
    const torso = grp('torso', 0, 1.4, 0, root)
    torso.rotation.y = 0.35
    torso.add(meshOf(mergeParts('sniperTorso:c', [
      { g: bevelBox(0.56, 0.6, 0.32, 0.045), p: [0, 0.08, 0] },
      { g: bevelBox(0.22, 0.14, 0.28, 0.028), p: [0.33, 0.31, 0] }, // shoulder yokes
      { g: bevelBox(0.22, 0.14, 0.28, 0.028), p: [-0.33, 0.31, 0] },
      { g: bevelBox(0.4, 0.22, 0.08, 0.022), p: [0, 0.2, 0.17] }, // chest plate
      { g: bevelBox(0.09, 0.32, 0.26, 0.022), p: [0.3, 0.04, 0.01] }, // side armor
      { g: bevelBox(0.09, 0.32, 0.26, 0.022), p: [-0.3, 0.04, 0.01] },
      { g: bevelBox(0.36, 0.2, 0.26, 0.03), p: [0, -0.26, 0] }, // abdomen
    ]), chassis, 'chassis', true, true))
    torso.add(meshOf(mergeParts('sniperTorso:d', [
      { g: cyl(0.1, 0.12, 0.1, 10), p: [0, 0.42, 0] },
      { g: cyl(0.12, 0.14, 0.11, 10), p: [0, -0.38, 0] },
      { g: bevelBox(0.3, 0.4, 0.14, 0.03), p: [0, 0.04, -0.2] }, // power pack
      { g: cyl(0.007, 0.007, 0.44, 5), p: [-0.1, 0.52, -0.18] }, // tall antenna
      { g: sph(0.02, 6), p: [-0.1, 0.74, -0.18] },
      { g: boxG(0.2, 0.026, 0.05), p: [0, -0.08, 0.2] },
    ]), dark, 'dark'))
    // head: compact display unit; the big scope lens rides beside it (kept, now green)
    const head = grp('head', 0, 0.48, 0.02, torso)
    head.add(meshOf(mergeParts('sniperHead:c', [
      { g: bevelBox(0.34, 0.26, 0.26, 0.035), p: [0, 0, -0.01] }, // casing
      { g: bevelBox(0.38, 0.08, 0.28, 0.025), p: [0, 0.15, -0.01] }, // crown plate
    ]), chassis, 'chassis', true, true))
    head.add(meshOf(mergeParts('sniperHead:d', [
      { g: bevelBox(0.17, 0.21, 0.05, 0.015), p: [-0.075, 0, 0.105] }, // screen bezel
      { g: cyl(0.115, 0.13, 0.18, 14), p: [0.085, 0.01, 0.13], r: [Math.PI / 2, 0, 0] }, // scope housing
      { g: bevelBox(0.09, 0.05, 0.1, 0.015), p: [0.17, 0.12, 0.06] }, // housing bracket
    ]), dark, 'dark', false))
    const lens = glowMesh(cyl(0.085, 0.085, 0.03, 14), 0x38ff7a, 1.6, 'lens')
    lens.position.set(0.085, 0.01, 0.23)
    lens.rotation.x = Math.PI / 2
    head.add(lens)
    const armL = grp('armL', 0.4, 0.26, 0, torso)
    const armR = grp('armR', -0.4, 0.26, 0, torso)
    // long rifle raised to the cheek, stock butted on the shoulder yoke; gripping
    // forearms + hands are baked into the rifle merge (see bakeGrip) so the hold
    // survives poseSniper's per-frame aim-pitch and recoil writes.
    const weapon = grp('weapon', 0.15, 0.26, 0.53, torso)
    weapon.rotation.y = -0.35 // counter the bladed torso so the barrel tracks the target
    weapon.add(meshOf(mergeParts('sniperRifle:d', [
      { g: bevelBox(0.06, 0.1, 0.55, 0.018), p: [0, 0, 0] }, // receiver
      { g: cyl(0.02, 0.022, 1.05, 8), p: [0, 0.03, 0.75], r: [Math.PI / 2, 0, 0] }, // long barrel
      { g: cyl(0.035, 0.04, 0.3, 8), p: [0, 0.03, 0.38], r: [Math.PI / 2, 0, 0] }, // shroud
      { g: cyl(0.045, 0.045, 0.09, 8), p: [0, 0.03, 1.24], r: [Math.PI / 2, 0, 0] }, // brake
      { g: cyl(0.04, 0.04, 0.26, 10), p: [0, 0.12, -0.04], r: [Math.PI / 2, 0, 0] }, // top scope
      { g: boxG(0.05, 0.1, 0.2), p: [0, -0.02, -0.36] }, // stock
      { g: boxG(0.045, 0.12, 0.06), p: [0, -0.1, 0.02] }, // grip
      ...bakeGrip(weapon, armR, [0, -0.09, 0.02], 0.4, 0.72), // trigger hand
      ...bakeGrip(weapon, armL, [0, -0.02, 0.24], 0.4, 0.72), // foregrip hand under the shroud
    ]), dark, 'dark', true, true))
    armL.add(meshOf(upperArmGeo('sniper', 0.4, 0.72), dark, 'dark'))
    armR.add(meshOf(upperArmGeo('sniper', 0.4, 0.72), dark, 'dark'))
    const muzzleGlow = glowMesh(cyl(0.028, 0.028, 0.04, 8), 0x4dff8f, 1.3, 'muzzle')
    muzzleGlow.position.set(0, 0.03, 1.22)
    muzzleGlow.rotation.x = Math.PI / 2
    weapon.add(muzzleGlow)
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.03, 1.3)
    weapon.add(muzzle)
  }

  if (kind === 'drone') {
    // squat quad-rotor bomber gunship, ~1.3m tip-to-tip — seen mostly from BELOW
    // (it hovers at DRONE_ALTITUDE), so the belly carries the read: glowing core,
    // belly light, under-slung bomb rack with the next bomb, purple duct rings.
    // Only the pod + X-frame arms cast shadows; props/glow/bomb don't.
    const podY = 0.42
    // pod core is the 'head' node — the purple logo screen rides its nose face
    const head = grp('head', 0, podY, 0, root)
    head.add(meshOf(mergeParts('dronePod:c', [
      { g: bevelBox(0.6, 0.3, 0.74, 0.05), p: [0, 0, 0] }, // chunky main pod
      { g: bevelBox(0.46, 0.12, 0.5, 0.03), p: [0, 0.19, -0.06] }, // spine hump
      { g: bevelBox(0.5, 0.14, 0.44, 0.035), p: [0, -0.14, -0.02] }, // belly plating
      { g: bevelBox(0.3, 0.13, 0.2, 0.03), p: [0, 0.02, 0.42] }, // sensor prow
      { g: bevelBox(0.16, 0.2, 0.44, 0.028), p: [0.31, 0.02, -0.04] }, // cheek sponsons
      { g: bevelBox(0.16, 0.2, 0.44, 0.028), p: [-0.31, 0.02, -0.04] },
    ]), chassis, 'chassis', true, true))
    head.add(meshOf(mergeParts('dronePod:d', [
      { g: bevelBox(0.27, 0.18, 0.06, 0.015), p: [0, 0, 0.38] }, // screen bezel
      { g: boxG(0.4, 0.055, 0.09), p: [0, 0.115, 0.36] }, // sensor brow housing
      { g: boxG(0.44, 0.03, 0.06), p: [0, -0.12, 0.3] }, // chin vent
      { g: boxG(0.34, 0.03, 0.05), p: [0, 0.05, -0.39] }, // tail vent
      { g: cyl(0.008, 0.008, 0.3, 5), p: [-0.17, 0.3, -0.24] }, // antenna
      { g: sph(0.05, 8), p: [0.15, 0.27, -0.2] }, // GPS dome
    ]), dark, 'dark', false))
    // glowing sensor strip across the brow (rides the pod so it follows death tilt)
    const strip = glowMesh(boxG(0.34, 0.024, 0.02), DRONE_GLOW, 2.4, 'trim')
    strip.position.set(0, 0.115, 0.415)
    head.add(strip)

    // the little HEAD on top — the headshot target (HEADSHOT_ZONE.drone at
    // e.pos.y + 0.78 ≈ pod node 0.42 + local 0.36): neck stalk + beveled head
    // cube with a bright visor slit so it reads as "shoot me" from the ground
    head.add(meshOf(mergeParts('droneHead:c', [
      { g: cyl(0.035, 0.048, 0.09, 8), p: [0, 0.27, 0.08] }, // neck stalk
      { g: bevelBox(0.16, 0.14, 0.16, 0.022), p: [0, 0.36, 0.08] }, // the head
      { g: boxG(0.05, 0.02, 0.04), p: [0, 0.445, 0.08] }, // topknot sensor
    ]), chassis, 'chassis', true, true))
    const headVisor = glowMesh(boxG(0.12, 0.032, 0.02), DRONE_GLOW, 2.8, 'trim')
    headVisor.position.set(0, 0.365, 0.168)
    head.add(headVisor)

    // X-frame arms to four ducted rotors + the bomb-rack rails (structural dark)
    const frame: Part[] = []
    const rings: Part[] = []
    const corners: ReadonlyArray<readonly [number, number]> = [[1, 1], [-1, 1], [1, -1], [-1, -1]]
    for (const [sx, sz] of corners) {
      const yawA = Math.atan2(sx, sz) // diagonal the arm runs along
      frame.push(
        { g: bevelBox(0.1, 0.06, 0.36, 0.02), p: [sx * 0.21, 0.47, sz * 0.21], r: [0, yawA, 0] }, // arm beam
        { g: torus(0.2, 0.032, 8, 18), p: [sx * 0.36, 0.5, sz * 0.36], r: [Math.PI / 2, 0, 0] }, // rotor duct
        { g: cyl(0.05, 0.07, 0.11, 8), p: [sx * 0.36, 0.49, sz * 0.36] }, // motor pod
      )
      // engine ring on the duct underside — the purple signature seen from the ground
      rings.push({ g: torus(0.2, 0.013, 6, 18), p: [sx * 0.36, 0.455, sz * 0.36], r: [Math.PI / 2, 0, 0] })
    }
    frame.push(
      { g: boxG(0.05, 0.09, 0.42), p: [0.1, 0.2, 0] }, // bomb-rack rails
      { g: boxG(0.05, 0.09, 0.42), p: [-0.1, 0.2, 0] },
      { g: boxG(0.25, 0.04, 0.06), p: [0, 0.22, 0.16] }, // rack cross members
      { g: boxG(0.25, 0.04, 0.06), p: [0, 0.22, -0.16] },
    )
    root.add(meshOf(mergeParts('droneFrame:d', frame), dark, 'dark', true, true))
    root.add(glowMesh(mergeParts('droneRings:g', rings), DRONE_GLOW, 2.2, 'trim'))
    // belly package: nav light + exposed power core — flashes on bomb release
    root.add(glowMesh(mergeParts('droneBelly:g', [
      { g: cyl(0.075, 0.09, 0.035, 12), p: [0, 0.265, 0.24] }, // belly nav light
      { g: sph(0.1, 10), p: [0, 0.26, -0.06] }, // power core orb bulging through the belly (headshot zone)
      { g: boxG(0.02, 0.02, 0.34), p: [0.13, 0.185, 0] }, // rail glow trim
      { g: boxG(0.02, 0.02, 0.34), p: [-0.13, 0.185, 0] },
    ]), DRONE_GLOW, 2.6, 'rack'))

    // spinning props — one articulated node per rotor (2-blade + hub + tip weights)
    const propGeo = mergeParts('droneProp:d', [
      { g: cyl(0.035, 0.045, 0.06, 8), p: [0, 0, 0] }, // hub
      { g: boxG(0.37, 0.012, 0.05), p: [0, 0.01, 0], r: [0.16, 0, 0] }, // blade pair (pitched)
      { g: boxG(0.03, 0.02, 0.055), p: [0.17, 0.01, 0] }, // tip weights
      { g: boxG(0.03, 0.02, 0.055), p: [-0.17, 0.01, 0] },
    ])
    corners.forEach(([sx, sz], i) => {
      const rot = grp(`rotor${i + 1}`, sx * 0.36, 0.535, sz * 0.36, root)
      rot.add(meshOf(propGeo, dark, 'dark', false))
    })

    // next bomb on the rack (the 'weapon' node — scaled away at release, re-racks)
    const weapon = grp('weapon', 0, 0.12, 0.02, root)
    weapon.add(meshOf(mergeParts('droneBomb:d', [
      { g: cyl(0.06, 0.06, 0.18, 8), p: [0, 0, 0] }, // body
      { g: sph(0.06, 8), p: [0, -0.09, 0] }, // round nose (points down)
      { g: boxG(0.015, 0.09, 0.11), p: [0, 0.1, 0] }, // tail fins
      { g: boxG(0.11, 0.09, 0.015), p: [0, 0.1, 0] },
    ]), dark, 'dark', false))
    const tail = glowMesh(torus(0.05, 0.012, 6, 12), DRONE_GLOW, 2.4, 'rack')
    tail.rotation.x = Math.PI / 2
    tail.position.set(0, 0.09, 0)
    weapon.add(tail)
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
  /** silhouette part: gets straggler-outline hull shells (glow bits never do) */
  hull: boolean
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

const NODE_NAMES = [
  'root', 'torso', 'head', 'armL', 'armR', 'legL', 'legR', 'weapon', 'shield', 'muzzle',
  'rotor1', 'rotor2', 'rotor3', 'rotor4', // drone props (absent on other kinds)
]

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
    parts.push({ mesh, bucket, hull: mesh.userData.hull === true && !bucket.startsWith('glow:') })
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
