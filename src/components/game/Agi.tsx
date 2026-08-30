'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import * as THREE from 'three'
import {
  ARENA_RADIUS, BOSS_BOLT_DAMAGE, BOSS_BOLT_SPEED, BOSS_PATTERNS_PER_CYCLE, BOSS_TIRED_TIME,
  DEATHBEAM_SWEEP_TIME, DEATHBEAM_TELEGRAPH, DEATHBEAM_WIDTH, FRAME_PRIO, GRAVITY,
  MINIGUN_FIRE_TIME, MINIGUN_SPINUP, PUNCH_DAMAGE, PUNCH_HAND_HP_LIMIT, PUNCH_LINGER,
  ROCKET_COUNT, ROCKET_DAMAGE, ROCKET_RADIUS, ROCKET_TELEGRAPH, SMASH_DAMAGE, SMASH_WARN_TIME,
  STRIPE_BARRAGES, STRIPE_COUNT, STRIPE_DAMAGE, STRIPE_GAP, STRIPE_TELEGRAPH, STRIPE_WIDTH,
} from '@/game/constants'
import { events } from '@/game/events'
import { simRunning, useGame } from '@/game/store'
import { world } from '@/game/world'
import type { BossFace, BossPatternId, DropRequest, Telegraph } from '@/game/types'
import { createFaceScreen, type FaceScreen } from './Agi.face'
import {
  ARM_SEGMENTS, HEAD_CENTER, HEAD_RADIUS, SEG_RADIUS, SHOULDER_LOCAL,
  buildAgiRig, type AgiRig, type ArmRig,
} from './Agi.rig'

// ─── THE AGI ─────────────────────────────────────────────────────────────────
// Monitor-headed sky god. Waves: hovers beyond the north rim, hand-drops enemy
// clusters (world.dropRequests → world.spawnEnemy). Smash: floor-wide jump
// telegraph then double palm slam. Boss: 3 random patterns per cycle → tired
// (vulnerable) → repeat, until bossHp hits 0 and it pops in a shower of debris.
// Telegraph damage is resolved centrally by the hazards system — this module
// only creates telegraphs, visual projectiles, arm choreography and events.

const UP = new THREE.Vector3(0, 1, 0)
const SPLAY = [0.16, 0.05, -0.05, -0.16]

type HandPose = 'open' | 'grip' | 'point' | 'fist'
const POSES: Record<HandPose, { curl: readonly number[]; spread: number }> = {
  open: { curl: [0.1, 0.1, 0.1, 0.1], spread: 1 },
  grip: { curl: [0.78, 0.86, 0.86, 0.8], spread: 0.35 },
  point: { curl: [0.03, 1.05, 1.12, 1.08], spread: 0.15 },
  fist: { curl: [1.22, 1.28, 1.28, 1.22], spread: 0.1 },
}

// module-scope scratch (never allocated per-frame)
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _eb = new THREE.Vector3()
const _d = new THREE.Vector3()
const _d2 = new THREE.Vector3()
const _o = new THREE.Vector3()
const _f = new THREE.Vector3()
const _h = new THREE.Vector3()
const _n = new THREE.Vector3()
const _x = new THREE.Vector3()
const _z = new THREE.Vector3()
const _root = new THREE.Vector3()
const _m4 = new THREE.Matrix4()
const _q = new THREE.Quaternion()

// ─── local state ─────────────────────────────────────────────────────────────

interface ArmCtl {
  side: number // -1 left, +1 right
  goal: THREE.Vector3
  cur: THREE.Vector3
  rate: number // goal-chasing rate (1/s)
  pts: THREE.Vector3[] // bezier samples, ARM_SEGMENTS+1
  curl: number[]
  curlGoal: number[]
  spread: number
  spreadGoal: number
  flat: number // 0..1 palm-flat-on-ground blend
  flatGoal: number
  aim: THREE.Vector3 | null // world point the fingers/weapon aim at
  aimVec: THREE.Vector3
  pointDir: THREE.Vector3 | null // explicit finger direction (skyward etc.)
  fingerDir: THREE.Vector3 // computed every frame; muzzle direction
  weapon: 'none' | 'minigun' | 'cannon'
  morph: number
  morphGoal: number
  spin: number
  spinRate: number
  spinRateGoal: number
  flash: number
  charge: number
}

type PatternState =
  | { id: 'rockets'; t: number; ascAcc: number; ascArm: number; fired: number }
  | {
      id: 'deathBeam'; t: number; init: boolean; made: boolean
      x0: number; x1: number; sweepStart: number; sweepEnd: number; firedBeam: boolean
    }
  | { id: 'laserBullets'; t: number; started: boolean; marker: Telegraph | null; accA: number; accB: number }
  | {
      id: 'punch'; t: number; placed: boolean; hitAt: number; slammed: boolean; cleared: boolean
      spots: [THREE.Vector3, THREE.Vector3]
    }
  | {
      id: 'stripeBarrage'; t: number; yaws: number[]
      fired: boolean[]; beamed: boolean[]; endsA: THREE.Vector3[]; endsB: THREE.Vector3[]
    }

interface DropState {
  req: DropRequest
  t: number
  arm: number
  spawned: number
  centroid: THREE.Vector3
}

interface Local {
  arms: [ArmCtl, ArmCtl]
  drop: DropState | null
  nextDropArm: number
  smash: { started: boolean; impacted: boolean; tHit: number }
  pattern: PatternState | null
  cycle: BossPatternId[]
  pendingTired: boolean
  betweenT: number
  tiredT: number
  dying: { t: number; boomAcc: number; finale: boolean } | null
  debris: { vel: THREE.Vector3; ang: THREE.Vector3 }[]
  debrisT: number
  beam: { active: boolean; from: THREE.Vector3; to: THREE.Vector3 }
  hurtUntil: number
  recoil: number
  lastT: number // world.time watermark to detect clock rewinds (run restarts)
  face: BossFace | null
  lastFaceDraw: number
  headYaw: number
  headPitch: number
  sparkOn: [boolean, boolean]
  sparkPos: [THREE.Vector3, THREE.Vector3]
  cargoCount: [number, number]
}

function makeArm(side: number): ArmCtl {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= ARM_SEGMENTS; i++) pts.push(new THREE.Vector3())
  return {
    side,
    goal: new THREE.Vector3(side * 19, 10.5, -49),
    cur: new THREE.Vector3(side * 19, 10.5, -49),
    rate: 2.6,
    pts,
    curl: [0.1, 0.1, 0.1, 0.1],
    curlGoal: [0.1, 0.1, 0.1, 0.1],
    spread: 1,
    spreadGoal: 1,
    flat: 0,
    flatGoal: 0,
    aim: null,
    aimVec: new THREE.Vector3(),
    pointDir: null,
    fingerDir: new THREE.Vector3(0, -1, 0),
    weapon: 'none',
    morph: 0,
    morphGoal: 0,
    spin: 0,
    spinRate: 0,
    spinRateGoal: 0,
    flash: 0,
    charge: 0,
  }
}

function makeLocal(): Local {
  const debris: Local['debris'] = []
  for (let i = 0; i < 8; i++) debris.push({ vel: new THREE.Vector3(), ang: new THREE.Vector3() })
  return {
    arms: [makeArm(-1), makeArm(1)],
    drop: null,
    nextDropArm: 0,
    smash: { started: false, impacted: false, tHit: 0 },
    pattern: null,
    cycle: [],
    pendingTired: false,
    betweenT: 1,
    tiredT: 0,
    dying: null,
    debris,
    debrisT: 0,
    beam: { active: false, from: new THREE.Vector3(), to: new THREE.Vector3() },
    hurtUntil: 0,
    recoil: 0,
    lastT: 0,
    face: null,
    lastFaceDraw: -1,
    headYaw: 0,
    headPitch: 0,
    sparkOn: [false, false],
    sparkPos: [new THREE.Vector3(), new THREE.Vector3()],
    cargoCount: [0, 0],
  }
}

function setPose(arm: ArmCtl, pose: HandPose): void {
  const p = POSES[pose]
  for (let f = 0; f < 4; f++) arm.curlGoal[f] = p.curl[f]
  arm.spreadGoal = p.spread
}

function setRestCurl(arm: ArmCtl): void {
  for (let f = 0; f < 4; f++) arm.curlGoal[f] = 0.38
  arm.spreadGoal = 0.6
}

function clampToArena(v: THREE.Vector3, r: number): void {
  const d = Math.hypot(v.x, v.z)
  if (d > r) {
    v.x = (v.x / d) * r
    v.z = (v.z / d) * r
  }
}

function idleArmGoals(S: Local, t: number, i: number): void {
  const arm = S.arms[i]
  arm.goal.set(
    arm.side * (19 + Math.sin(t * 0.31 + i * 2.1) * 2.5),
    10.5 + Math.sin(t * 0.43 + i) * 1.5,
    -49 + Math.sin(t * 0.23 + i * 3) * 2,
  )
  arm.rate = 2.6
  arm.flatGoal = 0
  arm.aim = null
  arm.pointDir = null
  arm.morphGoal = 0
  arm.spinRateGoal = 0
  setPose(arm, 'open')
}

function combatIdleGoals(S: Local, t: number, i: number): void {
  const arm = S.arms[i]
  arm.goal.set(arm.side * 14, 14.5 + Math.sin(t * 0.9 + i * 2) * 0.8, -44)
  arm.rate = 3
  arm.flatGoal = 0
  arm.aim = null
  arm.pointDir = null
  arm.morphGoal = 0
  arm.spinRateGoal = 0
  setPose(arm, 'fist')
}

function pickPatterns(): BossPatternId[] {
  const all: BossPatternId[] = ['rockets', 'deathBeam', 'laserBullets', 'punch', 'stripeBarrage']
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = all[i]
    all[i] = all[j]
    all[j] = tmp
  }
  return all.slice(0, BOSS_PATTERNS_PER_CYCLE)
}

function startPattern(S: Local, id: BossPatternId): void {
  switch (id) {
    case 'rockets':
      S.pattern = { id, t: 0, ascAcc: 0, ascArm: 0, fired: 0 }
      break
    case 'deathBeam':
      S.pattern = { id, t: 0, init: false, made: false, x0: 0, x1: 0, sweepStart: 0, sweepEnd: 0, firedBeam: false }
      break
    case 'laserBullets':
      S.pattern = { id, t: 0, started: false, marker: null, accA: 0, accB: 0.045 }
      break
    case 'punch':
      S.pattern = {
        id, t: 0, placed: false, hitAt: 0, slammed: false, cleared: false,
        spots: [new THREE.Vector3(), new THREE.Vector3()],
      }
      break
    case 'stripeBarrage': {
      const straight = Math.random() < 0.5 ? 0 : Math.PI / 2
      const diag = Math.random() < 0.5 ? Math.PI / 4 : -Math.PI / 4
      const yaws = [straight, diag, straight === 0 ? Math.PI / 2 : 0]
      const endsA: THREE.Vector3[] = []
      const endsB: THREE.Vector3[] = []
      for (let r = 0; r < STRIPE_BARRAGES; r++) {
        endsA.push(new THREE.Vector3())
        endsB.push(new THREE.Vector3())
      }
      S.pattern = {
        id, t: 0, yaws,
        fired: new Array(STRIPE_BARRAGES).fill(false),
        beamed: new Array(STRIPE_BARRAGES).fill(false),
        endsA, endsB,
      }
      break
    }
  }
}

// ─── wave-phase hand drops ───────────────────────────────────────────────────

function updateDrops(S: Local, t: number, step: number): void {
  if (!S.drop) {
    const req = world.dropRequests[0]
    if (req && req.spawns.length > 0) {
      const centroid = new THREE.Vector3()
      for (const sp of req.spawns) centroid.add(sp.pos)
      centroid.divideScalar(req.spawns.length)
      centroid.y = 0
      S.drop = { req, t: 0, arm: S.nextDropArm, spawned: 0, centroid }
      S.nextDropArm = S.nextDropArm === 0 ? 1 : 0
    }
  }
  const active = S.drop
  if (!active) {
    idleArmGoals(S, t, 0)
    idleArmGoals(S, t, 1)
    return
  }
  idleArmGoals(S, t, 1 - active.arm)

  const arm = S.arms[active.arm]
  active.t += step
  const n = active.req.spawns.length
  const T_DIP = 0.75
  const T_REACH = 1.7
  const STAGGER = 0.12
  const releaseEnd = T_REACH + n * STAGGER
  const T_DONE = releaseEnd + 0.55

  arm.aim = null
  arm.pointDir = null
  arm.flatGoal = 0
  if (active.t < T_DIP) {
    // dip behind/below the torso to pick up a cluster
    arm.goal.set(arm.side * 9, 8, -68)
    arm.rate = 5
    setPose(arm, active.t > T_DIP * 0.5 ? 'grip' : 'open')
    if (active.t > T_DIP * 0.45) S.cargoCount[active.arm] = Math.min(5, n)
  } else if (active.t < T_REACH) {
    arm.goal.set(active.centroid.x, 13, active.centroid.z)
    arm.rate = 3.6
    setPose(arm, 'grip')
  } else if (active.t < releaseEnd) {
    arm.goal.set(active.centroid.x, 13, active.centroid.z)
    setPose(arm, 'open')
    const shouldHave = Math.min(n, Math.floor((active.t - T_REACH) / STAGGER) + 1)
    while (active.spawned < shouldHave) {
      const sp = active.req.spawns[active.spawned]
      world.spawnEnemy(sp.kind, sp.pos, 12)
      active.spawned++
      S.cargoCount[active.arm] = Math.max(0, Math.min(5, n - active.spawned))
    }
  } else {
    S.cargoCount[active.arm] = 0
    setPose(arm, 'open')
    idleArmGoals(S, t, active.arm)
    if (active.t >= T_DONE) {
      const idx = world.dropRequests.indexOf(active.req)
      if (idx >= 0) world.dropRequests.splice(idx, 1)
      S.drop = null
    }
  }
}

// ─── smash sequence ──────────────────────────────────────────────────────────

function updateSmash(S: Local, g: ReturnType<typeof useGame.getState>, t: number, step: number): void {
  if (!S.smash.started) {
    S.smash.started = true
    world.agi.mode = 'smashing'
    S.smash.tHit = t + SMASH_WARN_TIME
    world.addTelegraph({
      shape: 'circle',
      pos: _v1.set(0, 0, 0),
      radius: ARENA_RADIUS,
      duration: SMASH_WARN_TIME,
      payload: { damage: SMASH_DAMAGE, dodgeableByJump: true, tag: 'smash' },
    })
    g.set({ warning: 'JUMP!' })
  }
  void step
  const remain = S.smash.tHit - t
  for (let i = 0; i < 2; i++) {
    const arm = S.arms[i]
    arm.aim = null
    arm.pointDir = null
    setPose(arm, 'open')
    if (remain > 0.3) {
      arm.goal.set(arm.side * 13, 30, -34)
      arm.rate = 4.5
      arm.flatGoal = 0.55
    } else {
      // fast slam so both palms strike the floor right at tHit
      arm.goal.set(arm.side * 11, 0.85, -8)
      arm.rate = 30
      arm.flatGoal = 1
    }
  }
  if (remain <= 0 && !S.smash.impacted) {
    // commit all state first so a throwing event handler can't wedge the phase machine
    S.smash.impacted = true
    world.clearObstacles()
    g.set({ warning: null, phase: 'boss', bossBarVisible: true })
    world.agi.mode = 'fighting'
    S.betweenT = 1.5
    S.cycle = []
    S.pendingTired = false
    events.emit('smashImpact', {})
  }
}

// ─── boss patterns ───────────────────────────────────────────────────────────

function updateRockets(p: Extract<PatternState, { id: 'rockets' }>, S: Local, rig: AgiRig, step: number): boolean {
  for (let i = 0; i < 2; i++) {
    const arm = S.arms[i]
    arm.goal.set(arm.side * 12, 26, -50)
    arm.rate = 4.5
    setPose(arm, 'point')
    if (!arm.pointDir) arm.pointDir = new THREE.Vector3(arm.side * 0.16, 1, -0.06).normalize()
    arm.flatGoal = 0
    arm.aim = null
  }
  // ascending show volley
  if (p.t < 1.25) {
    p.ascAcc += step
    while (p.ascAcc >= 0.09) {
      p.ascAcc -= 0.09
      const i = p.ascArm
      p.ascArm = 1 - p.ascArm
      const arm = S.arms[i]
      _v1.copy(rig.arms[i].hand.group.position).addScaledVector(arm.fingerDir, 3)
      _v2.copy(arm.fingerDir).multiplyScalar(20 + Math.random() * 7)
      _v2.x += (Math.random() - 0.5) * 7
      _v2.z += (Math.random() - 0.5) * 7
      world.addProjectile({ kind: 'rocket', pos: _v1, vel: _v2, radius: 0.3, damage: 0, ttl: 1.1, gravityScale: 0.35 })
    }
  }
  // landing telegraphs march over ~3s, several biased at the player
  const shouldHave = Math.floor(THREE.MathUtils.clamp((p.t - 0.4) / 3.0, 0, 1) * ROCKET_COUNT)
  while (p.fired < shouldHave) {
    if (p.fired % 3 === 1) {
      _v1.copy(world.player.pos)
      _v1.x += (Math.random() - 0.5) * 3
      _v1.z += (Math.random() - 0.5) * 3
    } else {
      const r = Math.sqrt(Math.random()) * (ARENA_RADIUS - 3)
      const a = Math.random() * Math.PI * 2
      _v1.set(Math.cos(a) * r, 0, Math.sin(a) * r)
    }
    _v1.y = 0
    clampToArena(_v1, ARENA_RADIUS - 2)
    world.addTelegraph({
      shape: 'circle', pos: _v1, radius: ROCKET_RADIUS, duration: ROCKET_TELEGRAPH,
      payload: { damage: ROCKET_DAMAGE, explosion: true, tag: 'rocket' },
    })
    // descending visual rocket timed to arrive at the telegraph's tHit
    _v2.copy(_v1)
    _v2.y = 26
    world.addProjectile({
      kind: 'rocket', pos: _v2, vel: _v3.set(0, -26 / ROCKET_TELEGRAPH, 0),
      radius: 0.3, damage: 0, ttl: ROCKET_TELEGRAPH, gravityScale: 0,
    })
    p.fired++
  }
  if (p.t >= 3.4 + ROCKET_TELEGRAPH + 0.25) {
    S.arms[0].pointDir = null
    S.arms[1].pointDir = null
    return true
  }
  return false
}

function updateDeathBeam(p: Extract<PatternState, { id: 'deathBeam' }>, S: Local, rig: AgiRig): boolean {
  const armC = S.arms[1]
  const armO = S.arms[0]
  if (!p.init) {
    p.init = true
    armC.weapon = 'cannon'
    armC.morphGoal = 1
    setPose(armC, 'fist')
    setPose(armO, 'fist')
  }
  armO.goal.set(-17, 18, -52)
  armO.rate = 3
  armO.aim = null
  armO.pointDir = null

  if (!p.made && p.t >= 0.6) {
    p.made = true
    const px = world.player.pos.x
    const side = Math.random() < 0.5 ? 1 : -1
    p.x0 = THREE.MathUtils.clamp(px - side * 8, -(ARENA_RADIUS - 3), ARENA_RADIUS - 3)
    p.x1 = side * (ARENA_RADIUS - 1)
    const NR = 6
    for (let i = 0; i < NR; i++) {
      const x = THREE.MathUtils.lerp(p.x0, p.x1, i / (NR - 1))
      // staggered durations = hit times marching across the arena
      world.addTelegraph({
        shape: 'rect', pos: _v1.set(x, 0, 0), w: DEATHBEAM_WIDTH, l: ARENA_RADIUS * 2 + 6, yaw: 0,
        duration: DEATHBEAM_TELEGRAPH + (i / (NR - 1)) * DEATHBEAM_SWEEP_TIME,
        payload: { damage: 0, instakill: true, beam: { duration: 0.35, height: 9 }, tag: 'deathBeam' },
      })
    }
    p.sweepStart = p.t + DEATHBEAM_TELEGRAPH
    p.sweepEnd = p.sweepStart + DEATHBEAM_SWEEP_TIME
  }

  const handPos = rig.arms[1].hand.group.position
  if (!p.made) {
    armC.goal.set(14, 19, -48)
    armC.rate = 3.4
    armC.aim = armC.aimVec.set(world.player.pos.x, 1, world.player.pos.z)
    return false
  }
  const prog = THREE.MathUtils.clamp((p.t - p.sweepStart) / DEATHBEAM_SWEEP_TIME, 0, 1)
  const bx = THREE.MathUtils.lerp(p.x0, p.x1, prog)
  armC.aim = armC.aimVec.set(bx, 0, 4)
  armC.goal.set(bx * 0.35, 19, -46)
  armC.rate = p.t >= p.sweepStart ? 6 : 3.4
  armC.charge = p.t < p.sweepStart
    ? THREE.MathUtils.clamp((p.t - (p.sweepStart - 0.8)) / 0.8, 0, 1)
    : Math.max(0, 1 - (p.t - p.sweepStart) * 2)
  if (!p.firedBeam && p.t >= p.sweepStart) {
    p.firedBeam = true
    _v1.copy(handPos).addScaledVector(armC.fingerDir, 6.9)
    events.emit('beamFire', { a: _v1.clone(), b: new THREE.Vector3(p.x0, 0, 4), kind: 'deathBeam' })
  }
  const sweeping = p.t >= p.sweepStart && p.t < p.sweepEnd
  S.beam.active = sweeping
  if (sweeping) {
    S.beam.from.copy(handPos).addScaledVector(armC.fingerDir, 6.9)
    S.beam.to.set(bx, 0.1, 4)
  }
  if (p.t >= p.sweepEnd + 0.4) {
    S.beam.active = false
    armC.morphGoal = 0
    armC.charge = 0
    armC.aim = null
  }
  return p.t >= p.sweepEnd + 0.9
}

function updateMiniguns(
  p: Extract<PatternState, { id: 'laserBullets' }>, S: Local, rig: AgiRig, step: number,
): boolean {
  if (!p.started) {
    p.started = true
    events.emit('minigunSpinup', {})
    for (const arm of S.arms) {
      arm.weapon = 'minigun'
      arm.morphGoal = 1
      setPose(arm, 'fist')
    }
    p.marker = world.addTelegraph({
      shape: 'circle', pos: world.player.pos, radius: 2.6,
      duration: MINIGUN_SPINUP + MINIGUN_FIRE_TIME,
      payload: { damage: 0, visualOnly: true, tag: 'aimMarker' },
    })
  }
  const mk = p.marker
  if (mk) {
    // marker chases the player at ~6.5 m/s — lags a running player
    _v1.set(world.player.pos.x - mk.pos.x, 0, world.player.pos.z - mk.pos.z)
    const d = _v1.length()
    if (d > 1e-4) mk.pos.addScaledVector(_v1.divideScalar(d), Math.min(6.5 * step, d))
    mk.pos.y = 0
  }
  for (let i = 0; i < 2; i++) {
    const arm = S.arms[i]
    arm.goal.set(arm.side * 13, 15, -42)
    arm.rate = 3.2
    arm.flatGoal = 0
    arm.pointDir = null
    if (mk) arm.aim = arm.aimVec.set(mk.pos.x, 1.2, mk.pos.z)
    arm.spinRateGoal = 46 * Math.pow(Math.min(1, p.t / MINIGUN_SPINUP), 1.6)
  }
  const fireEnd = MINIGUN_SPINUP + MINIGUN_FIRE_TIME
  if (p.t >= MINIGUN_SPINUP && p.t < fireEnd && mk) {
    const fire = (i: number) => {
      const arm = S.arms[i]
      _v1.copy(rig.arms[i].hand.group.position).addScaledVector(arm.fingerDir, 4.6)
      _v2.set(
        mk.pos.x + (Math.random() - 0.5) * 2.6,
        0.9 + Math.random() * 0.8,
        mk.pos.z + (Math.random() - 0.5) * 2.6,
      )
      _v2.sub(_v1).normalize().multiplyScalar(BOSS_BOLT_SPEED)
      world.addProjectile({ kind: 'bossBolt', pos: _v1, vel: _v2, radius: 0.22, damage: BOSS_BOLT_DAMAGE, ttl: 4 })
      arm.flash = 1
    }
    p.accA += step
    p.accB += step
    while (p.accA >= 0.09) { p.accA -= 0.09; fire(0) }
    while (p.accB >= 0.09) { p.accB -= 0.09; fire(1) }
  }
  if (p.t >= fireEnd + 0.4) {
    for (const arm of S.arms) {
      arm.morphGoal = 0
      arm.spinRateGoal = 0
      arm.aim = null
    }
    p.marker = null
    return true
  }
  return false
}

function updatePunch(p: Extract<PatternState, { id: 'punch' }>, S: Local, rig: AgiRig): boolean {
  if (!p.placed && p.t >= 0.55) {
    p.placed = true
    const a = Math.random() * Math.PI * 2
    const ox = Math.cos(a) * 2.7
    const oz = Math.sin(a) * 2.7
    p.spots[0].set(world.player.pos.x + ox, 0, world.player.pos.z + oz)
    p.spots[1].set(world.player.pos.x - ox, 0, world.player.pos.z - oz)
    for (const s of p.spots) {
      clampToArena(s, ARENA_RADIUS - 3)
      world.addTelegraph({
        shape: 'circle', pos: s, radius: 4.2, duration: 1.25,
        payload: { damage: PUNCH_DAMAGE, explosion: true, tag: 'punch' },
      })
    }
    p.hitAt = p.t + 1.25
  }
  for (let i = 0; i < 2; i++) {
    const arm = S.arms[i]
    setPose(arm, 'fist')
    arm.aim = null
    arm.pointDir = null
    if (!p.placed) {
      arm.goal.set(arm.side * 8, 21, -32)
      arm.rate = 5.5
      arm.flatGoal = 0.4
    } else if (p.t < p.hitAt - 0.24) {
      arm.goal.set(p.spots[i].x, 15, p.spots[i].z)
      arm.rate = 6
      arm.flatGoal = 0.85
    } else if (p.t < p.hitAt + PUNCH_LINGER) {
      arm.goal.set(p.spots[i].x, 1.0, p.spots[i].z)
      arm.rate = 28
      arm.flatGoal = 1
    } else {
      arm.goal.set(arm.side * 13, 16, -44)
      arm.rate = 4
      arm.flatGoal = 0
    }
  }
  if (p.placed && !p.slammed && p.t >= p.hitAt) {
    p.slammed = true
    world.agi.punchHands = [0, 1].map((i) => ({
      pos: rig.arms[i].hand.group.position.clone(),
      radius: 3,
      hpLeft: PUNCH_HAND_HP_LIMIT,
    }))
    S.sparkOn[0] = S.sparkOn[1] = true
  }
  if (p.slammed && p.t < p.hitAt + PUNCH_LINGER) {
    for (let i = 0; i < 2; i++) {
      S.sparkPos[i].copy(rig.arms[i].hand.group.position)
      const hand = world.agi.punchHands[i]
      if (hand) hand.pos.copy(rig.arms[i].hand.group.position)
    }
  }
  if (p.slammed && !p.cleared && p.t >= p.hitAt + PUNCH_LINGER) {
    p.cleared = true
    world.agi.punchHands = []
    S.sparkOn[0] = S.sparkOn[1] = false
  }
  return p.cleared && p.t >= p.hitAt + PUNCH_LINGER + 0.6
}

function updateStripes(p: Extract<PatternState, { id: 'stripeBarrage' }>, S: Local): boolean {
  const ROUND_GAP = 1.9
  for (let r = 0; r < STRIPE_BARRAGES; r++) {
    const start = r * ROUND_GAP
    if (!p.fired[r] && p.t >= start) {
      p.fired[r] = true
      const yaw = p.yaws[r]
      const shift = (r % 2) * (STRIPE_WIDTH + STRIPE_GAP) * 0.5
      const lx = Math.sin(yaw)
      const lz = Math.cos(yaw)
      const px = Math.cos(yaw)
      const pz = -Math.sin(yaw)
      for (let k = 0; k < STRIPE_COUNT; k++) {
        const off = (k - (STRIPE_COUNT - 1) / 2) * (STRIPE_WIDTH + STRIPE_GAP) + shift
        world.addTelegraph({
          shape: 'rect', pos: _v1.set(px * off, 0, pz * off),
          w: STRIPE_WIDTH, l: ARENA_RADIUS * 2 + 6, yaw,
          duration: STRIPE_TELEGRAPH,
          payload: { damage: STRIPE_DAMAGE, beam: { duration: 0.5, height: 7 }, tag: 'stripe' },
        })
      }
      p.endsA[r].set(px * shift - lx * (ARENA_RADIUS + 3), 1.2, pz * shift - lz * (ARENA_RADIUS + 3))
      p.endsB[r].set(px * shift + lx * (ARENA_RADIUS + 3), 1.2, pz * shift + lz * (ARENA_RADIUS + 3))
    }
    if (!p.beamed[r] && p.t >= start + STRIPE_TELEGRAPH) {
      p.beamed[r] = true
      events.emit('beamFire', { a: p.endsA[r].clone(), b: p.endsB[r].clone(), kind: 'stripe' })
    }
  }
  // arms rake across the sky in sync with the rounds
  const sweep = Math.sin((p.t / ROUND_GAP) * Math.PI)
  for (let i = 0; i < 2; i++) {
    const arm = S.arms[i]
    arm.goal.set(arm.side * 8 + sweep * 20, 21, -36)
    arm.rate = 4
    arm.flatGoal = 0
    arm.aim = null
    setPose(arm, 'point')
    if (!arm.pointDir) arm.pointDir = new THREE.Vector3(0, -0.5, 0.87).normalize()
  }
  const total = (STRIPE_BARRAGES - 1) * ROUND_GAP + STRIPE_TELEGRAPH + 1.0
  if (p.t >= total) {
    S.arms[0].pointDir = null
    S.arms[1].pointDir = null
    return true
  }
  return false
}

function updatePattern(S: Local, rig: AgiRig, step: number): boolean {
  const p = S.pattern
  if (!p) return true
  p.t += step
  switch (p.id) {
    case 'rockets': return updateRockets(p, S, rig, step)
    case 'deathBeam': return updateDeathBeam(p, S, rig)
    case 'laserBullets': return updateMiniguns(p, S, rig, step)
    case 'punch': return updatePunch(p, S, rig)
    case 'stripeBarrage': return updateStripes(p, S)
  }
}

// ─── tired / death / boss loop ───────────────────────────────────────────────

function enterTired(S: Local): void {
  world.agi.mode = 'tired'
  world.agi.vulnerable = true
  S.tiredT = 0
  S.pendingTired = false
  // resting hands become damage conduits (world routes shots through punchHands);
  // effectively uncapped during the tired window
  world.agi.punchHands = [
    { pos: new THREE.Vector3(-9, 1.2, -2), radius: 3, hpLeft: 999999 },
    { pos: new THREE.Vector3(9, 1.2, -2), radius: 3, hpLeft: 999999 },
  ]
  S.sparkOn[0] = S.sparkOn[1] = true
}

function startDying(S: Local): void {
  S.dying = { t: 0, boomAcc: 0.12, finale: false }
  S.pattern = null
  S.beam.active = false
  world.agi.mode = 'dying'
  world.agi.vulnerable = false
  world.agi.punchHands = []
  S.sparkOn[0] = S.sparkOn[1] = false
  for (const arm of S.arms) {
    arm.morphGoal = 0
    arm.spinRateGoal = 0
    arm.charge = 0
    arm.aim = null
    arm.pointDir = null
    arm.goal.set(arm.side * 17, 5.5, -55)
    arm.rate = 1.6
    arm.flatGoal = 0
    setPose(arm, 'open')
  }
}

function updateDying(S: Local, rig: AgiRig, g: ReturnType<typeof useGame.getState>, step: number): void {
  const d = S.dying
  if (!d) return
  d.t += step
  if (!d.finale) {
    d.boomAcc -= step
    if (d.boomAcc <= 0) {
      d.boomAcc = THREE.MathUtils.lerp(0.3, 0.09, Math.min(1, d.t / 1.8))
      _v1.set((Math.random() - 0.5) * 16, 12 + Math.random() * 17, -64 - Math.random() * 9)
      events.emit('explosion', { pos: _v1.clone(), radius: 2.5, kind: 'bossDeath' })
    }
    if (d.t >= 1.8) {
      d.finale = true
      for (let i = 0; i < rig.debris.chunks.length; i++) {
        const c = rig.debris.chunks[i]
        c.position.copy(world.agi.headPos)
        c.position.x += (Math.random() - 0.5) * 8
        c.position.y += (Math.random() - 0.5) * 6
        c.position.z += (Math.random() - 0.5) * 5
        c.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
        c.scale.setScalar(1)
        S.debris[i].vel.set((Math.random() - 0.5) * 24, 7 + Math.random() * 13, (Math.random() - 0.3) * 20)
        S.debris[i].ang.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8)
      }
      S.debrisT = 0
      rig.debris.group.visible = true
      rig.model.visible = false
      world.agi.mode = 'dead'
      g.set({ phase: 'victory' })
      events.emit('explosion', { pos: world.agi.headPos.clone(), radius: 14, kind: 'bossDeath' })
      events.emit('bossDead', {})
    }
  }
}

function updateBoss(S: Local, rig: AgiRig, g: ReturnType<typeof useGame.getState>, t: number, step: number): void {
  if (S.dying) {
    updateDying(S, rig, g, step)
    return
  }
  if (g.bossHp <= 0 && world.agi.mode !== 'dead') {
    startDying(S)
    return
  }
  if (world.agi.mode === 'tired') {
    S.tiredT += step
    for (let i = 0; i < 2; i++) {
      const arm = S.arms[i]
      arm.goal.set(arm.side * 9, 0.8, -2)
      arm.rate = 3.2
      arm.flatGoal = 1
      arm.aim = null
      arm.pointDir = null
      arm.morphGoal = 0
      setRestCurl(arm)
      // glue the vulnerable hand hitboxes + sparks to the visible hands
      const hand = world.agi.punchHands[i]
      if (hand) hand.pos.copy(rig.arms[i].hand.group.position)
      S.sparkPos[i].copy(rig.arms[i].hand.group.position)
    }
    if (S.tiredT >= BOSS_TIRED_TIME) {
      world.agi.vulnerable = false
      world.agi.punchHands = []
      world.agi.mode = 'fighting'
      S.sparkOn[0] = S.sparkOn[1] = false
      S.betweenT = 1.0
    }
    return
  }
  // fighting
  if (S.pattern) {
    const done = updatePattern(S, rig, step)
    if (done) {
      S.pattern = null
      S.betweenT = 0.8
      if (S.cycle.length === 0) S.pendingTired = true
    }
    return
  }
  combatIdleGoals(S, t, 0)
  combatIdleGoals(S, t, 1)
  S.betweenT -= step
  if (S.betweenT > 0) return
  if (S.pendingTired) {
    enterTired(S)
    return
  }
  if (S.cycle.length === 0) S.cycle = pickPatterns()
  const next = S.cycle.shift()
  if (next) startPattern(S, next)
}

// ─── per-frame visual pass (runs in every phase) ─────────────────────────────

function orientHand(ctl: ArmCtl, hand: THREE.Group, tangent: THREE.Vector3, step: number): void {
  _f.copy(tangent)
  if (ctl.aim) _f.copy(ctl.aim).sub(hand.position).normalize()
  else if (ctl.pointDir) _f.copy(ctl.pointDir)
  if (ctl.flat > 0.001) {
    _h.set(_f.x, 0, _f.z)
    if (_h.lengthSq() < 1e-4) _h.set(0, 0, 1)
    _h.normalize()
    _f.lerp(_h, ctl.flat).normalize()
  }
  // palm normal: world-down projected perpendicular to the fingers
  _n.set(0, -1, 0).addScaledVector(_f, _f.y)
  if (_n.lengthSq() < 0.03) _n.set(0, 0, 1).addScaledVector(_f, -_f.z)
  _n.normalize()
  // basis: local +Y = fingers, local +Z = back of hand
  _z.copy(_n).multiplyScalar(-1)
  _x.crossVectors(_f, _z)
  if (_x.lengthSq() < 1e-5) _x.set(1, 0, 0)
  _x.normalize()
  _z.crossVectors(_x, _f).normalize()
  _m4.makeBasis(_x, _f, _z)
  _q.setFromRotationMatrix(_m4)
  hand.quaternion.slerp(_q, 1 - Math.exp(-9 * step))
  ctl.fingerDir.copy(_f)
}

function layoutArm(ctl: ArmCtl, rig: ArmRig, rootPos: THREE.Vector3, step: number): void {
  ctl.cur.lerp(ctl.goal, 1 - Math.exp(-ctl.rate * step))
  if (ctl.cur.y < 0.6) ctl.cur.y = 0.6
  // quadratic bezier: shoulder → raised/outward elbow → hand
  const dist = rootPos.distanceTo(ctl.cur)
  _eb.copy(rootPos).add(ctl.cur).multiplyScalar(0.5)
  _eb.x += ctl.side * (2.5 + dist * 0.08)
  _eb.y += Math.max(2, 5 + dist * 0.14 - Math.max(0, ctl.cur.y - rootPos.y) * 0.55)
  for (let i = 0; i <= ARM_SEGMENTS; i++) {
    const u = i / ARM_SEGMENTS
    const a = (1 - u) * (1 - u)
    const b = 2 * (1 - u) * u
    const c = u * u
    ctl.pts[i].set(
      a * rootPos.x + b * _eb.x + c * ctl.cur.x,
      a * rootPos.y + b * _eb.y + c * ctl.cur.y,
      a * rootPos.z + b * _eb.z + c * ctl.cur.z,
    )
  }
  for (let i = 0; i < ARM_SEGMENTS; i++) {
    const a = ctl.pts[i]
    const b = ctl.pts[i + 1]
    _d.copy(b).sub(a)
    const len = Math.max(0.01, _d.length())
    _d.divideScalar(len)
    const seg = rig.segs[i]
    seg.position.copy(a).addScaledVector(_d, len * 0.5)
    seg.quaternion.setFromUnitVectors(UP, _d)
    seg.scale.set(1, len, 1)
    // piston rod running alongside the segment
    _o.crossVectors(_d, UP)
    if (_o.lengthSq() < 1e-4) _o.set(1, 0, 0)
    _o.normalize().multiplyScalar(SEG_RADIUS[i] * 0.85)
    const rod = rig.pistons[i]
    rod.position.copy(seg.position).add(_o)
    rod.quaternion.copy(seg.quaternion)
    rod.scale.set(1, len * 0.8, 1)
    if (i > 0) {
      const collar = rig.collars[i - 1]
      collar.position.copy(a)
      _d2.copy(b).sub(ctl.pts[i - 1]).normalize()
      collar.quaternion.setFromUnitVectors(UP, _d2)
    }
  }
  rig.shoulder.position.copy(rootPos)
  const hand = rig.hand.group
  hand.position.copy(ctl.cur)
  _d.copy(ctl.pts[ARM_SEGMENTS]).sub(ctl.pts[ARM_SEGMENTS - 1]).normalize()
  orientHand(ctl, hand, _d, step)
}

function updateHand(ctl: ArmCtl, rig: ArmRig, step: number): void {
  const k = 1 - Math.exp(-10 * step)
  const forceFist = ctl.morph > 0.25
  for (let f = 0; f < 4; f++) {
    const goal = forceFist ? 1.3 : ctl.curlGoal[f]
    ctl.curl[f] += (goal - ctl.curl[f]) * k
    const c = ctl.curl[f]
    const fr = rig.hand.fingers[f]
    fr.root.rotation.x = -(0.1 + c * 0.85)
    fr.mid.rotation.x = -(0.06 + c * 1.05)
    fr.tip.rotation.x = -(0.05 + c * 0.9)
    fr.root.rotation.z = SPLAY[f] * ctl.spread
  }
  ctl.spread += ((forceFist ? 0.1 : ctl.spreadGoal) - ctl.spread) * k
  ctl.flat += (ctl.flatGoal - ctl.flat) * (1 - Math.exp(-6 * step))
  ctl.morph += (ctl.morphGoal - ctl.morph) * (1 - Math.exp(-5 * step))
  const mg = rig.hand.minigun
  const cn = rig.hand.cannon
  const showM = ctl.weapon === 'minigun' && ctl.morph > 0.02
  mg.group.visible = showM
  if (showM) mg.group.scale.setScalar(0.01 + 0.99 * ctl.morph)
  const showC = ctl.weapon === 'cannon' && ctl.morph > 0.02
  cn.group.visible = showC
  if (showC) cn.group.scale.setScalar(0.01 + 0.99 * ctl.morph)
  ctl.spinRate += (ctl.spinRateGoal - ctl.spinRate) * (1 - Math.exp(-1.7 * step))
  ctl.spin += ctl.spinRate * step
  mg.spinner.rotation.y = ctl.spin
  ctl.flash = Math.max(0, ctl.flash - step * 13)
  mg.flashMat.opacity = Math.min(1, ctl.flash)
  cn.charge.scale.setScalar(0.01 + ctl.charge * 1.5)
  cn.chargeMat.opacity = THREE.MathUtils.clamp(ctl.charge, 0, 1)
}

function updateVisuals(S: Local, rig: AgiRig, t: number, step: number): void {
  // hover bob + hit recoil
  const bobY = Math.sin(t * 0.5) * 0.9 + Math.sin(t * 1.13) * 0.25
  rig.bob.position.y = bobY
  rig.bob.position.z = -S.recoil * 1.3
  S.recoil *= Math.exp(-3.2 * step)
  // dying shake
  if (S.dying && !S.dying.finale) {
    const amp = 0.15 + Math.min(1, S.dying.t / 1.8) * 0.85
    rig.model.position.set(
      (Math.random() - 0.5) * amp,
      (Math.random() - 0.5) * amp * 0.7,
      (Math.random() - 0.5) * amp,
    )
  } else if (!S.dying) {
    rig.model.position.set(0, 0, 0)
  }
  // slow player-tracking head turn
  const pp = world.player.pos
  _v1.set(pp.x - HEAD_CENTER.x, pp.y + 1.5 - (HEAD_CENTER.y + bobY), pp.z - HEAD_CENTER.z)
  const horiz = Math.hypot(_v1.x, _v1.z)
  const targetYaw = Math.atan2(_v1.x, _v1.z)
  const targetPitch = Math.atan2(-_v1.y, horiz) * 0.5
  const hk = 1 - Math.exp(-2.1 * step)
  S.headYaw += (targetYaw - S.headYaw) * hk
  S.headPitch += (targetPitch - S.headPitch) * hk
  rig.head.rotation.set(S.headPitch, S.headYaw, S.dying ? (Math.random() - 0.5) * 0.1 : 0)
  // arms (world-space layout; shoulder roots follow the bobbing body)
  for (let i = 0; i < 2; i++) {
    _root.copy(SHOULDER_LOCAL[i])
    _root.y += bobY
    _root.z += rig.bob.position.z
    layoutArm(S.arms[i], rig.arms[i], _root, step)
    updateHand(S.arms[i], rig.arms[i], step)
    rig.arms[i].hand.cargo.visible = S.cargoCount[i] > 0
    for (let b = 0; b < rig.arms[i].hand.cargoBots.length; b++) {
      rig.arms[i].hand.cargoBots[b].visible = b < S.cargoCount[i]
    }
  }
  // idle machinery: fan, LEDs, reactor
  rig.fan.rotation.x += step * (world.agi.mode === 'fighting' ? 15 : 6)
  for (const led of rig.ledMats) {
    const on = Math.sin(t * 3.1 + led.phase) > 0.05 ? 1 : 0.22
    led.mat.color.copy(led.base).multiplyScalar(on)
  }
  rig.reactorMat.uniforms.uTime.value = t
  rig.reactorMat.uniforms.uHeat.value =
    world.agi.mode === 'tired' ? 0.45
    : world.agi.mode === 'dying' ? 0.5 + Math.random() * 0.7
    : world.agi.mode === 'dead' ? 0 : 1
  // spark clusters on grounded hands
  for (let i = 0; i < 2; i++) {
    const sp = rig.sparks[i]
    sp.group.visible = S.sparkOn[i]
    if (S.sparkOn[i]) {
      sp.group.position.copy(S.sparkPos[i])
      for (const bit of sp.bits) {
        if (Math.random() < 0.4) {
          bit.position.set((Math.random() - 0.5) * 3.4, Math.random() * 1.8, (Math.random() - 0.5) * 3.4)
          bit.scale.setScalar(0.35 + Math.random() * 1.4)
          bit.visible = Math.random() < 0.88
        }
      }
    }
  }
  // death-beam visual
  const bm = rig.beam
  bm.group.visible = S.beam.active
  bm.impact.visible = S.beam.active
  if (S.beam.active) {
    _d.copy(S.beam.to).sub(S.beam.from)
    const len = Math.max(0.01, _d.length())
    _d.divideScalar(len)
    bm.group.position.copy(S.beam.from).addScaledVector(_d, len * 0.5)
    bm.group.quaternion.setFromUnitVectors(UP, _d)
    const pulse = 1 + 0.18 * Math.sin(t * 41)
    bm.core.scale.set(pulse, len, pulse)
    const wob = 1 + 0.2 * Math.sin(t * 23)
    bm.sheath.scale.set(wob, len, wob)
    bm.sheathMat.uniforms.uTime.value = t
    bm.impact.position.set(S.beam.to.x, 0.15, S.beam.to.z)
    bm.impact.scale.setScalar(1 + 0.3 * Math.sin(t * 31))
  }
  // death debris (pure visual; keeps running into the victory phase)
  if (rig.debris.group.visible) {
    S.debrisT += step
    for (let i = 0; i < rig.debris.chunks.length; i++) {
      const c = rig.debris.chunks[i]
      const dd = S.debris[i]
      c.position.addScaledVector(dd.vel, step)
      dd.vel.y -= GRAVITY * 0.45 * step
      c.rotation.x += dd.ang.x * step
      c.rotation.y += dd.ang.y * step
      c.rotation.z += dd.ang.z * step
      if (c.position.y < 1) {
        c.position.y = 1
        dd.vel.y = Math.abs(dd.vel.y) * 0.3
        dd.vel.x *= 0.8
        dd.vel.z *= 0.8
      }
    }
    if (S.debrisT > 2.4) {
      const fade = THREE.MathUtils.clamp(1 - (S.debrisT - 2.4) / 0.8, 0.001, 1)
      for (const c of rig.debris.chunks) c.scale.setScalar(fade)
    }
    if (S.debrisT > 3.4) rig.debris.group.visible = false
  }
}

function resetLocal(S: Local, rig: AgiRig): void {
  S.drop = null
  S.nextDropArm = 0
  S.smash.started = false
  S.smash.impacted = false
  S.smash.tHit = 0
  S.pattern = null
  S.cycle.length = 0
  S.pendingTired = false
  S.betweenT = 1
  S.tiredT = 0
  S.dying = null
  S.debrisT = 0
  S.beam.active = false
  S.hurtUntil = 0
  S.recoil = 0
  S.lastT = 0
  S.face = null
  S.lastFaceDraw = -1
  S.headYaw = 0
  S.headPitch = 0
  S.sparkOn[0] = S.sparkOn[1] = false
  S.cargoCount[0] = S.cargoCount[1] = 0
  for (let i = 0; i < 2; i++) {
    const a = S.arms[i]
    a.goal.set(a.side * 19, 10.5, -49)
    a.cur.copy(a.goal)
    a.rate = 2.6
    setPose(a, 'open')
    for (let f = 0; f < 4; f++) a.curl[f] = a.curlGoal[f]
    a.spread = a.spreadGoal
    a.flat = 0
    a.flatGoal = 0
    a.aim = null
    a.pointDir = null
    a.weapon = 'none'
    a.morph = 0
    a.morphGoal = 0
    a.spin = 0
    a.spinRate = 0
    a.spinRateGoal = 0
    a.flash = 0
    a.charge = 0
  }
  rig.model.visible = true
  rig.model.position.set(0, 0, 0)
  rig.debris.group.visible = false
  rig.beam.group.visible = false
  rig.beam.impact.visible = false
  for (const sp of rig.sparks) sp.group.visible = false
  for (const arm of rig.arms) arm.hand.cargo.visible = false
  world.agi.mode = 'waves' // Director's world.reset() also does this; either order is fine
}

// ─── component ───────────────────────────────────────────────────────────────

// The boss is a mounted-once singleton: THREE model + mutable per-frame state
// live at module scope (never in React state), hard-reset on runId change.
interface BossSingleton {
  face: FaceScreen
  rig: AgiRig
  S: Local
}
let bossSingleton: BossSingleton | null = null
function getBoss(): BossSingleton {
  if (!bossSingleton) {
    const face = createFaceScreen()
    bossSingleton = { face, rig: buildAgiRig(face.material), S: makeLocal() }
  }
  return bossSingleton
}

export function Agi() {
  const runId = useGame((s) => s.runId)
  const [root] = useState(() => getBoss().rig.root)

  useEffect(() => {
    const { S, rig } = getBoss()
    resetLocal(S, rig)
  }, [runId])

  useEffect(() => {
    const off = events.on('bossHit', () => {
      const { S } = getBoss()
      S.hurtUntil = world.time + 0.6
      S.recoil = Math.min(1, S.recoil + 0.45)
    })
    return off
  }, [])

  useFrame((_, dt) => {
    const { S, rig, face } = getBoss()
    const step = Math.min(dt, 0.05)
    const g = useGame.getState()
    const t = world.time
    // world clock rewound (Director run restart) → all absolute timestamps are
    // stale; hard-reset module state regardless of whether runId re-rendered yet
    if (t + 1e-3 < S.lastT) resetLocal(S, rig)
    S.lastT = t

    // ── gameplay simulation (gated) ──
    if (simRunning(g.phase)) {
      if (g.phase === 'wave') updateDrops(S, t, step)
      else if (g.phase === 'smash') updateSmash(S, g, t, step)
      else if (g.phase === 'boss') updateBoss(S, rig, g, t, step)
    } else if ((g.phase === 'menu' || g.phase === 'buffSelect') && world.agi.mode === 'waves') {
      // pure idle drift while waiting
      if (!S.drop) {
        idleArmGoals(S, t, 0)
        idleArmGoals(S, t, 1)
      }
    }

    // ── expression state (world.agi.mode → face, hurt flash overrides) ──
    const mode = world.agi.mode
    let faceNow: BossFace = 'happy'
    if (mode === 'dying' || mode === 'dead') faceNow = 'surprised'
    else if (t < S.hurtUntil) faceNow = 'hurt'
    else if (mode === 'tired') faceNow = 'tired'
    else if (mode === 'fighting' || mode === 'smashing') faceNow = 'angry'
    if (faceNow !== S.face) {
      S.face = faceNow
      S.lastFaceDraw = -1
      events.emit('bossFace', { face: faceNow })
    }
    if (t - S.lastFaceDraw >= 0.125) {
      S.lastFaceDraw = t
      face.draw(faceNow, t)
    }
    const glow =
      mode === 'tired' ? 0.3
      : mode === 'dying' ? Math.random()
      : mode === 'dead' ? 0
      : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.8))
    face.update(t, glow)

    // ── always-on visual pass ──
    updateVisuals(S, rig, t, step)

    // ── contract sync: monitor center for aiming/eye checks ──
    world.agi.headPos.set(HEAD_CENTER.x, HEAD_CENTER.y + rig.bob.position.y, HEAD_CENTER.z + rig.bob.position.z)
    world.agi.headRadius = HEAD_RADIUS
  }, FRAME_PRIO.boss)

  return <primitive object={root} />
}
