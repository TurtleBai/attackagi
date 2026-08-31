'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  DRONE_ALTITUDE, DRONE_CYCLE, DRONE_HP, FRAME_PRIO, GRAVITY,
  MELEE_HP, RANGER_HP, RANGER_INTERVAL, SNIPER_HP, STRAGGLER_OUTLINE_COUNT, TANK_HP, TANK_WINDUP,
} from '@/game/constants'
import { simRunning, useGame } from '@/game/store'
import { world } from '@/game/world'
import type { Enemy, EnemyKind } from '@/game/types'
import {
  aiDrone, aiMelee, aiRanger, aiSniper, aiTank, DRONE_DROP_PULSE, lerpAngle,
  MELEE_WINDUP_DUR, SNIPER_TRACK_DUR,
} from './Enemies.ai'
import { getKindRig, updateOutlinePulse, type KindRig } from './Enemies.bodies'
import { LOGO_COUNT } from './Enemies.decals'
import {
  type EnemyBatcher, getEnemyBatcher, resetEnemyBatcher, type LaserSlot,
} from './Enemies.instanced'

// The 5 robot enemy kinds: spawning (drains world.pendingSpawns), AI state machines
// (Enemies.ai), locomotion/attack posing against ONE shared template rig per kind
// (Enemies.bodies), instanced crowd rendering (Enemies.instanced), hit-flash,
// drop-in falls with dust, and death collapse → world.removeEnemy.

const DYING_TIME = 1.1
const LAND_TIME = 0.28
const SEP_RADIUS = 1.3

const KINDS: readonly EnemyKind[] = ['melee', 'ranger', 'tank', 'sniper', 'drone']

const KIND_DEF: Record<EnemyKind, { hp: number; r: number; h: number }> = {
  melee: { hp: MELEE_HP, r: 0.55, h: 2.1 },
  ranger: { hp: RANGER_HP, r: 0.5, h: 2.0 },
  tank: { hp: TANK_HP, r: 0.7, h: 2.2 },
  sniper: { hp: SNIPER_HP, r: 0.5, h: 2.1 },
  drone: { hp: DRONE_HP, r: 0.7, h: 0.7 }, // squat flying pod
}
const INIT_STATE: Record<EnemyKind, string> = {
  melee: 'chase', ranger: 'hold', tank: 'advance', sniper: 'track', drone: 'travel',
}

// ─── Spawning ────────────────────────────────────────────────────────────────

function drainSpawns(): void {
  while (world.pendingSpawns.length > 0) {
    const s = world.pendingSpawns.shift()
    if (!s) break
    const def = KIND_DEF[s.kind]
    const e: Enemy = {
      id: world.id(),
      kind: s.kind,
      pos: s.pos.clone(),
      vel: new THREE.Vector3(),
      yaw: Math.atan2(world.player.pos.x - s.pos.x, world.player.pos.z - s.pos.z),
      hp: def.hp,
      maxHp: def.hp,
      radius: def.r,
      height: def.h,
      state: 'fall',
      stateT: 0,
      hitFlash: 0,
      shieldActive: s.kind === 'tank',
      falling: s.dropFrom > 0,
      data: {},
    }
    e.data.tYaw = e.yaw
    e.data.phase = Math.random() * Math.PI * 2
    e.data.amp = 0
    e.data.speed = 0
    e.data.steerSide = Math.random() < 0.5 ? -1 : 1
    e.data.desync = Math.random() * 1.4
    e.data.logo = Math.floor(Math.random() * LOGO_COUNT) // random AI-lab chest emblem
    if (s.kind === 'ranger') e.data.fireT = 1.2 + Math.random() * RANGER_INTERVAL
    if (s.kind === 'sniper') e.data.cycleJitter = Math.random() * 0.6 - 0.2
    if (s.kind === 'drone') e.data.bombT = 1.2 + Math.random() * DRONE_CYCLE * 0.6 // desync bomb cycles
    if (s.dropFrom > 0) {
      e.pos.y = s.dropFrom
    } else {
      e.state = INIT_STATE[s.kind]
      e.stateT = e.data.desync
    }
    world.enemies.set(e.id, e)
  }
}

/** Returns true on the frame the enemy touches down (or, for drones, arrests). */
function updateFall(e: Enemy, step: number): boolean {
  e.vel.y -= GRAVITY * step
  e.pos.y += e.vel.y * step
  // drones never reach the floor: their rotors catch at hover altitude
  const arrestY = e.kind === 'drone' ? DRONE_ALTITUDE : 0
  if (e.pos.y <= arrestY) {
    e.pos.y = arrestY
    e.vel.y = 0
    e.falling = false
    if (e.kind !== 'drone') e.data.landT = LAND_TIME // no ground squash for a mid-air catch
    e.state = INIT_STATE[e.kind]
    e.stateT = e.kind === 'sniper' ? e.data.desync ?? 0 : 0
    return true
  }
  return false
}

// ─── Separation steering ─────────────────────────────────────────────────────

const sepList: Enemy[] = []
function separate(step: number): void {
  sepList.length = 0
  for (const e of world.enemies.values()) {
    // windup tanks are locked to their telegraphed dash line — separation
    // shoving them mid-telegraph desynced the red rectangle from the bash
    if (e.falling || e.hp <= 0 || e.state === 'dash' || (e.kind === 'tank' && e.state === 'windup')) continue
    sepList.push(e)
  }
  for (let i = 0; i < sepList.length; i++) {
    const a = sepList[i]
    for (let j = i + 1; j < sepList.length; j++) {
      const b = sepList[j]
      let dx = b.pos.x - a.pos.x
      let dz = b.pos.z - a.pos.z
      // fliers only shove fliers, walkers only walkers — a drone hovering 8m up
      // must not displace the ground troops under it (or vice versa)
      if (Math.abs(b.pos.y - a.pos.y) > 2) continue
      const d2 = dx * dx + dz * dz
      if (d2 >= SEP_RADIUS * SEP_RADIUS) continue
      let d = Math.sqrt(d2)
      if (d < 1e-4) {
        dx = 1
        dz = 0
        d = 1
      }
      const push = ((SEP_RADIUS - d) / SEP_RADIUS) * 3.2 * step
      const nx = dx / d, nz = dz / d
      const wa = b.radius / (a.radius + b.radius) // heavier robots budge less
      a.pos.x -= nx * push * wa
      a.pos.z -= nz * push * wa
      b.pos.x += nx * push * (1 - wa)
      b.pos.z += nz * push * (1 - wa)
    }
  }
}

// ─── Posing (mutates the kind's SHARED template rig, one enemy at a time) ────

const _wp = new THREE.Vector3()
const _wt = new THREE.Vector3()
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const easeOut = (t: number) => 1 - (1 - t) * (1 - t)
const easeIn = (t: number) => t * t
const damp = (cur: number, target: number, rate: number, step: number) =>
  cur + (target - cur) * Math.min(1, rate * step)

// per-enemy pose outputs, consumed by batch.commit() right after poseBody()
const GLOW: Record<string, number> = {}
const LASER: LaserSlot = { on: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, opacity: 0 }

function setRot(r: KindRig, name: string, dx = 0, dy = 0, dz = 0): void {
  const n = r.nodes[name]
  const s = r.base[name]
  if (!n || !s) return
  n.rotation.set(s.rx + dx, s.ry + dy, s.rz + dz)
}
function setPos(r: KindRig, name: string, dx = 0, dy = 0, dz = 0): void {
  const n = r.nodes[name]
  const s = r.base[name]
  if (!n || !s) return
  n.position.set(s.px + dx, s.py + dy, s.pz + dz)
}
function setGlow(key: string, mult: number): void {
  GLOW[key] = mult
}

// reused root-modifier accumulator (no per-frame allocation)
const RM = { bobY: 0, tiltX: 0, tiltZ: 0, shakeX: 0, sy: 1, sxz: 1 }

function poseMelee(e: Enemy, r: KindRig): void {
  const t = e.stateT
  if (e.state === 'windup') {
    const k = easeOut(clamp01(t / MELEE_WINDUP_DUR))
    setRot(r, 'armR', -2.25 * k, 0, -0.45 * k)
    setRot(r, 'torso', 0, -0.5 * k, 0)
    setRot(r, 'weapon', 0.7 * k, 0, 0)
    setGlow('screen', 1 + 0.9 * k)
    setGlow('blade', 1 + 0.8 * k)
  } else if (e.state === 'swing') {
    const k = easeIn(clamp01(t / 0.2))
    setRot(r, 'armR', -2.25 + 3.2 * k, 0, -0.45 + 0.45 * k)
    setRot(r, 'torso', 0.12 * k, -0.5 + 0.95 * k, 0)
    setRot(r, 'weapon', 0.7 - 0.9 * k, 0, 0)
    setGlow('screen', 1.9)
    setGlow('blade', 2.2)
  } else if (e.state === 'cooldown') {
    const k = 1 - clamp01(t / 0.45)
    setRot(r, 'armR', 0.95 * k, 0, 0)
    setRot(r, 'torso', 0.12 * k, 0.45 * k, 0)
    setGlow('blade', 1)
  } else {
    setGlow('blade', 1)
  }
}

function poseRanger(e: Enemy, r: KindRig, step: number, running: boolean): void {
  // both hands are baked onto the rifle — pin the arm stubs to their aimed base
  // so the walk-swing baseline can't pull the elbows off the baked forearms
  setRot(r, 'armL')
  setRot(r, 'armR')
  const p = world.player
  const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
  const dist = Math.hypot(dx, dz) || 1e-4
  const pitch = Math.atan2(p.pos.y + 1.2 - (e.pos.y + 1.5), dist)
  if (running) e.data.muzzleT = Math.max(0, (e.data.muzzleT ?? 0) - step)
  const mz = (e.data.muzzleT ?? 0) / 0.18
  setRot(r, 'weapon', -pitch * 0.7 - 0.25 * mz, 0, 0)
  setPos(r, 'weapon', 0, 0, -0.07 * mz)
  setRot(r, 'head', -pitch * 0.5, 0, 0)
  setGlow('muzzle', 1 + 14 * mz)
  setGlow('screen', 1 + 0.5 * mz)
}

/**
 * Shield/arm placement from the persisted lower amount (e.data.shieldLow).
 * Split out so falling/dying tanks keep a stable shield pose (the rig is shared,
 * so every node must be written every enemy).
 */
function poseTankShield(e: Enemy, r: KindRig): void {
  const low = e.data.shieldLow ?? (e.shieldActive ? 0 : 1)
  setRot(r, 'shield', 0.95 * low, 0, 0)
  setPos(r, 'shield', 0, -0.32 * low, 0.08 * low)
  setRot(r, 'armL', 0.55 * low, 0, 0.25 * low)
  setRot(r, 'armR', 0.55 * low, 0, -0.25 * low)
}

function poseTank(e: Enemy, r: KindRig, step: number): void {
  const low = damp(e.data.shieldLow ?? (e.shieldActive ? 0 : 1), e.shieldActive ? 0 : 1, 6, step)
  e.data.shieldLow = low
  poseTankShield(e, r)
  if (e.state === 'windup') {
    const k = clamp01(e.stateT / TANK_WINDUP)
    RM.tiltX += 0.14 * k
    RM.bobY -= 0.1 * k
    RM.shakeX += Math.sin(e.stateT * 46) * 0.02 * k
    setGlow('screen', 1 + 1.0 * k)
    setGlow('slit', 1 + 2.5 * k)
  } else if (e.state === 'dash') {
    RM.tiltX += 0.26
    setGlow('screen', 2.2)
    setGlow('slit', 3.5)
  } else if (e.state === 'stagger') {
    RM.tiltX += -0.3 + Math.sin(e.stateT * 18) * 0.06 * Math.max(0, 1 - e.stateT)
    const fl = Math.sin(e.stateT * 34) * 0.5 + 0.5
    setGlow('screen', 0.4 + fl * 0.8)
    setGlow('slit', 0.4 + fl * 0.8)
  } else {
    setGlow('slit', 1)
  }
}

function poseSniper(e: Enemy, r: KindRig): void {
  const p = world.player
  let pitchAng: number
  if (e.state === 'aim') {
    pitchAng = e.data.lockPitch ?? 0
  } else {
    const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
    const dist = Math.hypot(dx, dz) || 1e-4
    pitchAng = Math.atan2(p.pos.y + 1.2 - (e.pos.y + 1.55), dist)
  }
  const rc = (e.data.recoilT ?? 0) / 0.55
  // arms pinned to the aimed base pose — the gripping forearms are baked into
  // the rifle merge, so any arm swing would pull elbows off the weapon
  setRot(r, 'armL')
  setRot(r, 'armR')
  setRot(r, 'weapon', -pitchAng * 0.8 - 0.5 * rc * rc, 0, 0)
  setRot(r, 'head', -pitchAng * 0.4, 0, 0)
  RM.tiltX -= 0.1 * rc * rc
  setGlow('muzzle', 1 + 10 * rc * rc)
  if (e.state === 'track') {
    const k = clamp01(e.stateT / SNIPER_TRACK_DUR)
    setGlow('lens', 0.7 + 2.6 * k)
  } else if (e.state === 'aim') {
    setGlow('lens', 4 + Math.sin(e.stateT * 30) * 0.6)
    setGlow('screen', 1.6)
  } else {
    setGlow('lens', 1)
  }
  // live laser sight: faint while tracking, hard while locked
  const mn = r.nodes.muzzle
  const show = !!mn && ((e.state === 'track' && e.stateT > 0.35) || e.state === 'aim')
  LASER.on = show
  if (show && mn) {
    mn.updateWorldMatrix(true, false)
    mn.getWorldPosition(_wp)
    if (e.state === 'aim') _wt.set(e.data.bx ?? 0, e.data.by ?? 1, e.data.bz ?? 0)
    else _wt.set(p.pos.x, p.pos.y + 1.2, p.pos.z)
    LASER.ax = _wp.x; LASER.ay = _wp.y; LASER.az = _wp.z
    LASER.bx = _wt.x; LASER.by = _wt.y; LASER.bz = _wt.z
    LASER.opacity = e.state === 'aim' ? 0.5 + Math.sin(world.time * 40) * 0.12 : 0.16
  }
}

/**
 * Rotor spin + racked-bomb scale, written for EVERY drone commit (falling,
 * alive, dying) — the rig is shared, so per-enemy values may never leak between
 * instances. The rotor angle accumulates per enemy: its speed ramps up during
 * the drop-in fall (the "rotors catch") and winds down to 0 while dying, which
 * is what sells the tumble-fall.
 */
function poseDroneCore(e: Enemy, r: KindRig, step: number): void {
  const dying = e.hp <= 0
  const k = damp(e.data.rotorK ?? (e.falling ? 0.25 : 1), dying ? 0 : 1, dying ? 2.2 : 5, step)
  e.data.rotorK = k
  const ang = (e.data.rotorAng ?? e.id * 1.317) + step * 46 * k
  e.data.rotorAng = ang
  // diagonal pairs counter-rotate; slightly different rates avoid strobe-sync
  setRot(r, 'rotor1', 0, ang, 0)
  setRot(r, 'rotor2', 0, -ang * 0.93, 0)
  setRot(r, 'rotor3', 0, -ang * 1.07, 0)
  setRot(r, 'rotor4', 0, ang * 0.97, 0)
  // release-pulse clock for poseDrone (rack flash + kick-up)
  const dropT = Math.max(0, e.data.dropT ?? 0)
  if (dropT > 0) e.data.dropT = dropT - step
  // next bomb: vanishes at release, then re-racks as the cycle timer (bombT,
  // counting down to the next drop) approaches — frozen mid-state while dying
  const bombT = e.data.bombT ?? 0
  const wn = r.nodes.weapon
  if (wn) wn.scale.setScalar(Math.max(0.001, clamp01((3 - bombT) / 1.2)))
}

function poseDrone(e: Enemy): void {
  // tilt into motion from the AI's smoothed world velocity
  const vx = e.data.vx ?? 0
  const vz = e.data.vz ?? 0
  const sy = Math.sin(e.yaw)
  const cy = Math.cos(e.yaw)
  const fwd = vx * sy + vz * cy
  const lat = vx * cy - vz * sy
  RM.tiltX += Math.max(-0.38, Math.min(0.38, fwd * 0.048))
  RM.tiltZ -= Math.max(-0.3, Math.min(0.3, lat * 0.048))
  // visual hover bob on top of the AI's (gameplay) altitude bob
  RM.bobY += Math.sin(world.time * 2.3 + (e.data.phase ?? 0)) * 0.035
  const pulse = Math.max(0, e.data.dropT ?? 0) / DRONE_DROP_PULSE
  const pp = pulse * pulse
  if (pp > 0) {
    RM.bobY += 0.17 * pp // kick-up as the bomb leaves the rack
    RM.tiltX -= 0.1 * pp
    setGlow('rack', 1 + 7 * pp) // belly/rack flash at release
  }
  // steady purple presence; brightens while its strike circle is live
  const aiming = e.state === 'dropwait'
  setGlow('trim', 1.15 + 0.25 * Math.sin(world.time * 3.1 + (e.data.phase ?? 0)) + (aiming ? 0.9 : 0))
  setGlow('screen', aiming ? 1.7 : 1.15)
}

/** Pose the shared rig for one enemy. Returns the hit-flash value for its slot. */
function poseBody(e: Enemy, r: KindRig, step: number, running: boolean): number {
  const g = r.group
  g.position.copy(e.pos)
  g.rotation.y = e.yaw
  RM.bobY = 0
  RM.tiltX = 0
  RM.tiltZ = 0
  RM.shakeX = 0
  RM.sy = 1
  RM.sxz = 1

  // plating hit-flash (+ death flicker)
  const dyingT = e.state === 'dying' && e.hp <= 0 ? e.stateT : -1
  let flash = e.hitFlash
  let deathGlow = 1
  if (dyingT >= 0) {
    const fade = Math.max(0, 1 - dyingT / DYING_TIME)
    const flicker = (Math.sin(dyingT * 47) * 0.5 + 0.5) * fade
    flash = Math.max(flash, flicker * 0.5)
    deathGlow = flicker * 1.6
  }

  // per-enemy pose outputs default off; branches below override
  for (const k of r.glowKeys) GLOW[k] = 1
  GLOW.screen = 1 // head logo display (not a template part — committed separately)
  LASER.on = false

  // locomotion cycle
  const spd = e.data.speed ?? 0
  if (running && !e.falling && dyingT < 0) {
    e.data.amp = damp(e.data.amp ?? 0, spd > 0.2 ? 1 : 0, 9, step)
    if (spd > 0.2) e.data.phase = (e.data.phase ?? 0) + step * (3.4 + spd * 1.15)
  }
  const amp = e.data.amp ?? 0
  const ph = e.data.phase ?? 0
  const swingAmp = e.kind === 'melee' ? 0.62 : e.kind === 'tank' ? 0.48 : 0.5
  const legSwing = Math.sin(ph) * swingAmp * amp

  // Baseline written EVERY call for EVERY node — the rig is shared across the
  // kind's enemies, so nothing may leak from the previously posed instance.
  // (Dying enemies reuse their frozen phase/amp, keeping legs mid-stride.)
  setRot(r, 'legL', legSwing, 0, 0)
  setRot(r, 'legR', -legSwing, 0, 0)
  setRot(r, 'armL', -Math.sin(ph) * 0.35 * amp, 0, 0)
  setRot(r, 'armR', Math.sin(ph) * 0.3 * amp, 0, 0)
  setRot(r, 'torso')
  setRot(r, 'head')
  setRot(r, 'weapon')
  setPos(r, 'weapon')
  if (e.kind === 'tank') poseTankShield(e, r)
  if (e.kind === 'drone') poseDroneCore(e, r, step)

  if (e.falling) {
    // limbs flail on the way down — except rifle carriers, whose gripping
    // forearms are baked into the weapon: their arms stay pinned to the hold
    setRot(r, 'legL', 0.45, 0, 0.12)
    setRot(r, 'legR', -0.35, 0, -0.12)
    if (e.kind !== 'ranger' && e.kind !== 'sniper') {
      setRot(r, 'armL', -0.7 + Math.sin(world.time * 9 + e.id) * 0.25, 0, 0.5)
      setRot(r, 'armR', -0.6 + Math.cos(world.time * 8 + e.id) * 0.25, 0, -0.5)
    }
    RM.tiltX = Math.sin(world.time * 3 + e.id * 2.1) * 0.12
  } else if (dyingT < 0) {
    // walk/idle baseline; per-kind overlays refine
    RM.bobY = (1 - Math.cos(ph * 2)) * 0.5 * 0.05 * amp
    RM.tiltZ = Math.sin(world.time * 1.6 + e.id * 1.7) * 0.02
    if (e.kind === 'melee') poseMelee(e, r)
    else if (e.kind === 'ranger') poseRanger(e, r, step, running)
    else if (e.kind === 'tank') poseTank(e, r, step)
    else if (e.kind === 'drone') poseDrone(e)
    else poseSniper(e, r)
  } else {
    // collapse: tip over at the feet, arms out, sink away before removal
    const tip = easeIn(clamp01(dyingT / 0.72))
    RM.tiltX = tip * 1.5 * (e.data.deathTip ?? 1)
    RM.tiltZ = tip * (e.data.deathRoll ?? 0)
    if (e.kind === 'drone' && e.data.impacted !== 1) {
      // mid-air wreck: growing tumble + autorotation spin until the floor hit
      // (stateT is held at 0 during the fall, so the generic collapse waits)
      const ft = e.data.fallT ?? 0
      g.rotation.y = e.yaw + ft * ft * 2.4 * (e.data.deathTip ?? 1)
      RM.tiltX = Math.min(1.15, ft * 1.7) * (e.data.deathTip ?? 1)
      RM.tiltZ = Math.min(0.9, ft * 1.4) * ((e.data.deathRoll ?? 0) + 0.25)
    }
    g.position.y = e.pos.y - Math.max(0, dyingT - 0.55) * 1.1
    setRot(r, 'armL', -0.4 * tip, 0, 0.4 * tip)
    setRot(r, 'armR', -0.3 * tip, 0, -0.5 * tip)
    setRot(r, 'head', 0.4 * tip, 0.3 * tip, 0)
    for (const k of r.glowKeys) GLOW[k] = deathGlow
    GLOW.screen = deathGlow
  }

  // landing squash & stretch
  const landT = e.data.landT ?? 0
  if (landT > 0 && !e.falling) {
    const k = Math.sin(Math.PI * (1 - landT / LAND_TIME))
    RM.sy = 1 - 0.28 * k
    RM.sxz = 1 + 0.2 * k
  }

  const root = r.nodes.root
  const rb = r.base.root
  if (root && rb) {
    root.position.set(rb.px + RM.shakeX, rb.py + RM.bobY, rb.pz)
    root.rotation.set(rb.rx + RM.tiltX, rb.ry, rb.rz + RM.tiltZ)
    root.scale.set(RM.sxz, RM.sy, RM.sxz)
  }
  return flash
}

// ─── Dust puffs (landings) ───────────────────────────────────────────────────

interface DustItem {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  t: number
  size: number
  active: boolean
}
interface DustPool {
  spawn(pos: THREE.Vector3, size: number): void
  update(step: number): void
  reset(): void
}

function makeDustPool(parent: THREE.Object3D): DustPool {
  const geo = new THREE.RingGeometry(0.34, 0.62, 22)
  const items: DustItem[] = []
  for (let i = 0; i < 16; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x97907f, transparent: true, opacity: 0, depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.rotation.x = -Math.PI / 2
    mesh.visible = false
    mesh.frustumCulled = false
    parent.add(mesh)
    items.push({ mesh, mat, t: 0, size: 1, active: false })
  }
  return {
    spawn(pos, size) {
      let it = items.find((i) => !i.active)
      if (!it) it = items[0]
      it.active = true
      it.t = 0
      it.size = size
      it.mesh.visible = true
      it.mesh.position.set(pos.x, 0.05, pos.z)
    },
    update(step) {
      for (const it of items) {
        if (!it.active) continue
        it.t += step
        const k = it.t / 0.45
        if (k >= 1) {
          it.active = false
          it.mesh.visible = false
          continue
        }
        const s = it.size * (0.4 + 1.9 * easeOut(k))
        it.mesh.scale.set(s, s, s)
        it.mat.opacity = 0.5 * (1 - k)
      }
    },
    reset() {
      for (const it of items) {
        it.active = false
        it.mesh.visible = false
      }
    },
  }
}

// ─── Pose-rate LOD ───────────────────────────────────────────────────────────
// Enemies beyond LOD_DIST from the camera are posed+committed every 2nd frame
// (alternating by id parity); on skip frames the batcher replays their cached
// slot data, dropping the dominant per-enemy pose + updateMatrixWorld chains.

const LOD_DIST_SQ = 25 * 25
let frameN = 0 // pose-LOD parity clock

/**
 * States that must ALWAYS pose at full rate, regardless of distance — attack
 * telegraphs/tells may never stutter. Falling (drop-in tell) and hit-flash
 * (shot feedback) too. Snipers always: their laser sight ends AT THE PLAYER
 * whatever the range, and it is rebuilt from the pose every frame.
 */
function poseFullRate(e: Enemy): boolean {
  if (e.falling || e.hitFlash > 0) return true
  switch (e.kind) {
    case 'melee': return e.state === 'windup' || e.state === 'swing'
    case 'tank': return e.state === 'windup' || e.state === 'dash' || e.state === 'stagger'
    case 'sniper': return true
    case 'ranger': return (e.data.muzzleT ?? 0) > 0
    case 'drone':
      // dropwait/drop-pulse are the bomb tell; a rotors-dead wreck tumbles fast
      return e.state === 'dropwait' || (e.data.dropT ?? 0) > 0 ||
        (e.hp <= 0 && e.data.impacted !== 1)
  }
}

// ─── Frozen guard (mirrors Projectiles' frozenSynced) ────────────────────────
// When the sim is off AND the world clock is frozen (pause / buff pick), pose +
// commit + upload ONE final frame, then skip the whole visual-sync block so a
// pause costs ~zero enemy CPU. Death/victory screens keep the clock running, so
// idle posing continues behind them as before.

let frozenSynced = false
let frozenTime = -1

/**
 * Pose + commit one enemy (module-level: no per-frame closures). Far,
 * non-telegraphing enemies replay their cached instance slots on alternate
 * frames (by id parity); everyone else gets the full pose, with decay/phase
 * clocks caught up across any skipped frame via world.time.
 */
function commitOne(
  e: Enemy, rig: KindRig, batch: EnemyBatcher, step: number, running: boolean,
  camX: number, camY: number, camZ: number,
): void {
  if (((frameN + e.id) & 1) === 1 && !poseFullRate(e)) {
    const dx = e.pos.x - camX
    const dy = e.pos.y - camY
    const dz = e.pos.z - camZ
    if (dx * dx + dy * dy + dz * dz > LOD_DIST_SQ && batch.commitCached(e)) return
  }
  const pStep = Math.min(0.1, Math.max(step, world.time - (e.data.posedAt ?? world.time)))
  batch.commit(e, poseBody(e, rig, pStep, running), GLOW, LASER)
  e.data.posedAt = world.time
}

// ─── Component ───────────────────────────────────────────────────────────────

const removeList: number[] = []

// per-frame kind buckets: alive committed first so the straggler outline shells
// cover exactly the leading instance slots (module scratch, no allocation)
const aliveByKind: Record<EnemyKind, Enemy[]> = { melee: [], ranger: [], tank: [], sniper: [], drone: [] }
const dyingByKind: Record<EnemyKind, Enemy[]> = { melee: [], ranger: [], tank: [], sniper: [], drone: [] }

export function Enemies() {
  const rootRef = useRef<THREE.Group>(null)
  const dustRef = useRef<DustPool | null>(null)

  // hard reset on run restart (Director owns world.reset(); we zero our instance counts)
  useEffect(() => {
    const reset = () => {
      resetEnemyBatcher()
      dustRef.current?.reset()
      frozenSynced = false
      frozenTime = -1
    }
    const unsub = useGame.subscribe((s, prev) => {
      if (s.runId !== prev.runId) reset()
    })
    return () => {
      unsub()
      reset()
    }
  }, [])

  useFrame((st, dt) => {
    const step = Math.min(dt, 0.05)
    const root = rootRef.current
    if (!root) return
    const running = simRunning(useGame.getState().phase)
    if (!dustRef.current) dustRef.current = makeDustPool(root)
    const dust = dustRef.current
    const batch = getEnemyBatcher()
    if (batch.group.parent !== root) root.add(batch.group)

    if (running) {
      drainSpawns()
      removeList.length = 0
      for (const e of world.enemies.values()) {
        e.hitFlash = Math.max(0, e.hitFlash - step * 4)
        if (e.falling) {
          // drones arrest mid-air — no landing dust ring 8m under them
          if (updateFall(e, step) && e.kind !== 'drone') dust.spawn(e.pos, e.radius * 2.4)
          continue
        }
        if (e.hp <= 0) {
          if (e.state !== 'dying') {
            e.state = 'dying'
            e.stateT = 0
            e.shieldActive = false
            e.data.deathTip = Math.random() < 0.7 ? 1 : -1
            e.data.deathRoll = (Math.random() - 0.5) * 1.2
          } else if (e.kind === 'drone' && e.data.impacted !== 1) {
            // rotors dead: tumble-fall under gravity; the collapse/removal clock
            // (stateT) only starts once the wreck slams into the floor
            e.vel.y -= GRAVITY * step
            e.pos.y += e.vel.y * step
            e.data.fallT = (e.data.fallT ?? 0) + step
            if (e.pos.y <= 0) {
              e.pos.y = 0
              e.vel.y = 0
              e.data.impacted = 1
              e.stateT = 0
              dust.spawn(e.pos, e.radius * 2.6) // impact puff
            }
          } else {
            e.stateT += step
            if (e.stateT >= DYING_TIME) removeList.push(e.id)
          }
          continue
        }
        // integrate melee-shove impulses (bat knockback writes e.vel.x/z; AI
        // moves via e.pos directly, so without this the impulse was a no-op)
        if (e.vel.x !== 0 || e.vel.z !== 0) {
          e.pos.x += e.vel.x * step
          e.pos.z += e.vel.z * step
          const f = Math.max(0, 1 - 10 * step)
          e.vel.x *= f
          e.vel.z *= f
          if (e.vel.x * e.vel.x + e.vel.z * e.vel.z < 0.01) {
            e.vel.x = 0
            e.vel.z = 0
          }
        }
        if ((e.data.landT ?? 0) > 0) {
          e.data.landT = (e.data.landT ?? 0) - step
          continue
        }
        switch (e.kind) {
          case 'melee': aiMelee(e, step); break
          case 'ranger': aiRanger(e, step); break
          case 'tank': aiTank(e, step); break
          case 'sniper': aiSniper(e, step); break
          case 'drone': aiDrone(e, step); break
        }
        const turn =
          e.kind === 'melee' ? 10 : e.kind === 'tank' ? (e.state === 'windup' ? 12 : 6) : e.kind === 'drone' ? 6 : 5
        e.yaw = lerpAngle(e.yaw, e.data.tYaw ?? e.yaw, step * turn)
      }
      separate(step)
      for (const e of world.enemies.values()) {
        if (!e.falling && e.hp > 0) world.resolveCapsule(e.pos, e.radius)
      }
      for (const id of removeList) {
        world.removeEnemy(id)
        batch.release(id) // free its pose-LOD cache row
      }
    }

    // frozen guard: sim off + clock frozen + final frame already uploaded →
    // the entire visual-sync block below (poses, commits, uploads) is skipped
    if (!running && frozenSynced && world.time === frozenTime) return

    // visual sync: pose the shared rig per enemy and commit into instance slots
    // (pose keeps idling even off-sim while the world clock runs)
    frameN++
    const gs = useGame.getState()
    const highlightStragglers =
      gs.phase === 'wave' && gs.enemiesRemaining > 0 && gs.enemiesRemaining <= STRAGGLER_OUTLINE_COUNT
    updateOutlinePulse(world.time)
    batch.setTime(world.time)
    batch.begin()
    for (const k of KINDS) {
      aliveByKind[k].length = 0
      dyingByKind[k].length = 0
    }
    for (const e of world.enemies.values()) {
      ;(e.hp > 0 ? aliveByKind : dyingByKind)[e.kind].push(e)
    }
    const cam = st.camera.position
    for (const kind of KINDS) {
      const rig = getKindRig(kind)
      const alive = aliveByKind[kind]
      const dying = dyingByKind[kind]
      for (const e of alive) commitOne(e, rig, batch, step, running, cam.x, cam.y, cam.z)
      for (const e of dying) commitOne(e, rig, batch, step, running, cam.x, cam.y, cam.z)
      batch.setOutline(kind, highlightStragglers ? alive.length : 0)
    }
    batch.finish(cam)
    dust.update(step)
    frozenSynced = !running
    frozenTime = world.time
  }, FRAME_PRIO.enemies)

  return <group ref={rootRef} />
}
