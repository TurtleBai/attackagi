'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  FRAME_PRIO, GRAVITY,
  MELEE_HP, RANGER_HP, RANGER_INTERVAL, SNIPER_HP, TANK_HP, TANK_WINDUP,
} from '@/game/constants'
import { simRunning, useGame } from '@/game/store'
import { world } from '@/game/world'
import type { Enemy, EnemyKind } from '@/game/types'
import {
  aiMelee, aiRanger, aiSniper, aiTank, lerpAngle,
  MELEE_WINDUP_DUR, SNIPER_TRACK_DUR,
} from './Enemies.ai'
import { createEnemyBody, type EnemyBody } from './Enemies.bodies'

// The 4 robot enemy kinds: spawning (drains world.pendingSpawns), AI state machines
// (Enemies.ai), articulated procedural bodies (Enemies.bodies), locomotion/attack
// posing, hit-flash, drop-in falls with dust, and death collapse → world.removeEnemy.

const DYING_TIME = 1.1
const LAND_TIME = 0.28
const SEP_RADIUS = 1.3

const KIND_DEF: Record<EnemyKind, { hp: number; r: number; h: number }> = {
  melee: { hp: MELEE_HP, r: 0.55, h: 2.1 },
  ranger: { hp: RANGER_HP, r: 0.5, h: 2.0 },
  tank: { hp: TANK_HP, r: 0.7, h: 2.2 },
  sniper: { hp: SNIPER_HP, r: 0.5, h: 2.1 },
}
const INIT_STATE: Record<EnemyKind, string> = {
  melee: 'chase', ranger: 'hold', tank: 'advance', sniper: 'track',
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
    if (s.kind === 'ranger') e.data.fireT = 1.2 + Math.random() * RANGER_INTERVAL
    if (s.kind === 'sniper') e.data.cycleJitter = Math.random() * 0.6 - 0.2
    if (s.dropFrom > 0) {
      e.pos.y = s.dropFrom
    } else {
      e.state = INIT_STATE[s.kind]
      e.stateT = e.data.desync
    }
    world.enemies.set(e.id, e)
  }
}

/** Returns true on the frame the enemy touches down. */
function updateFall(e: Enemy, step: number): boolean {
  e.vel.y -= GRAVITY * step
  e.pos.y += e.vel.y * step
  if (e.pos.y <= 0) {
    e.pos.y = 0
    e.vel.y = 0
    e.falling = false
    e.data.landT = LAND_TIME
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
    if (e.falling || e.hp <= 0 || e.state === 'dash') continue
    sepList.push(e)
  }
  for (let i = 0; i < sepList.length; i++) {
    const a = sepList[i]
    for (let j = i + 1; j < sepList.length; j++) {
      const b = sepList[j]
      let dx = b.pos.x - a.pos.x
      let dz = b.pos.z - a.pos.z
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

// ─── Posing ──────────────────────────────────────────────────────────────────

const _wp = new THREE.Vector3()
const _wt = new THREE.Vector3()
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const easeOut = (t: number) => 1 - (1 - t) * (1 - t)
const easeIn = (t: number) => t * t
const damp = (cur: number, target: number, rate: number, step: number) =>
  cur + (target - cur) * Math.min(1, rate * step)

function setRot(b: EnemyBody, name: string, dx = 0, dy = 0, dz = 0): void {
  const n = b.nodes[name]
  const s = b.base[name]
  if (!n || !s) return
  n.rotation.set(s.rx + dx, s.ry + dy, s.rz + dz)
}
function setPos(b: EnemyBody, name: string, dx = 0, dy = 0, dz = 0): void {
  const n = b.nodes[name]
  const s = b.base[name]
  if (!n || !s) return
  n.position.set(s.px + dx, s.py + dy, s.pz + dz)
}
function setGlow(b: EnemyBody, key: string, mult: number): void {
  const m = b.glow[key]
  if (m) m.emissiveIntensity = (b.glowBase[key] ?? 1) * mult
}

// reused root-modifier accumulator (no per-frame allocation)
const RM = { bobY: 0, tiltX: 0, tiltZ: 0, shakeX: 0, sy: 1, sxz: 1 }

function poseMelee(e: Enemy, b: EnemyBody): void {
  const t = e.stateT
  if (e.state === 'windup') {
    const k = easeOut(clamp01(t / MELEE_WINDUP_DUR))
    setRot(b, 'armR', -2.25 * k, 0, -0.45 * k)
    setRot(b, 'torso', 0, -0.5 * k, 0)
    setRot(b, 'weapon', 0.7 * k, 0, 0)
    setGlow(b, 'eye', 1 + 1.6 * k)
    setGlow(b, 'blade', 1 + 0.8 * k)
  } else if (e.state === 'swing') {
    const k = easeIn(clamp01(t / 0.2))
    setRot(b, 'armR', -2.25 + 3.2 * k, 0, -0.45 + 0.45 * k)
    setRot(b, 'torso', 0.12 * k, -0.5 + 0.95 * k, 0)
    setRot(b, 'weapon', 0.7 - 0.9 * k, 0, 0)
    setGlow(b, 'eye', 2.4)
    setGlow(b, 'blade', 2.2)
  } else if (e.state === 'cooldown') {
    const k = 1 - clamp01(t / 0.45)
    setRot(b, 'armR', 0.95 * k, 0, 0)
    setRot(b, 'torso', 0.12 * k, 0.45 * k, 0)
    setGlow(b, 'eye', 1)
    setGlow(b, 'blade', 1)
  } else {
    setGlow(b, 'eye', 1)
    setGlow(b, 'blade', 1)
  }
}

function poseRanger(e: Enemy, b: EnemyBody, step: number, running: boolean): void {
  const p = world.player
  const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
  const dist = Math.hypot(dx, dz) || 1e-4
  const pitch = Math.atan2(p.pos.y + 1.2 - (e.pos.y + 1.5), dist)
  if (running) e.data.muzzleT = Math.max(0, (e.data.muzzleT ?? 0) - step)
  const mz = (e.data.muzzleT ?? 0) / 0.18
  setRot(b, 'weapon', -pitch * 0.7 - 0.25 * mz, 0, 0)
  setPos(b, 'weapon', 0, 0, -0.07 * mz)
  setRot(b, 'head', -pitch * 0.5, 0, 0)
  setGlow(b, 'muzzle', 1 + 14 * mz)
  setGlow(b, 'eye', 1 + 0.6 * mz)
}

function poseTank(e: Enemy, b: EnemyBody, step: number): void {
  const low = damp(e.data.shieldLow ?? (e.shieldActive ? 0 : 1), e.shieldActive ? 0 : 1, 6, step)
  e.data.shieldLow = low
  setRot(b, 'shield', 0.95 * low, 0, 0)
  setPos(b, 'shield', 0, -0.32 * low, 0.08 * low)
  setRot(b, 'armL', 0.55 * low, 0, 0.25 * low)
  setRot(b, 'armR', 0.55 * low, 0, -0.25 * low)
  if (e.state === 'windup') {
    const k = clamp01(e.stateT / TANK_WINDUP)
    RM.tiltX += 0.14 * k
    RM.bobY -= 0.1 * k
    RM.shakeX += Math.sin(e.stateT * 46) * 0.02 * k
    setGlow(b, 'eye', 1 + 2.5 * k)
    setGlow(b, 'slit', 1 + 2.5 * k)
  } else if (e.state === 'dash') {
    RM.tiltX += 0.26
    setGlow(b, 'eye', 3.5)
    setGlow(b, 'slit', 3.5)
  } else if (e.state === 'stagger') {
    RM.tiltX += -0.3 + Math.sin(e.stateT * 18) * 0.06 * Math.max(0, 1 - e.stateT)
    const fl = Math.sin(e.stateT * 34) * 0.5 + 0.5
    setGlow(b, 'eye', 0.4 + fl * 0.8)
    setGlow(b, 'slit', 0.4 + fl * 0.8)
  } else {
    setGlow(b, 'eye', 1)
    setGlow(b, 'slit', 1)
  }
}

function poseSniper(e: Enemy, b: EnemyBody): void {
  const p = world.player
  let pitchAng: number
  if (e.state === 'aim') {
    pitchAng = e.data.lockPitch ?? 0
  } else {
    const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
    const dist = Math.hypot(dx, dz) || 1e-4
    pitchAng = Math.atan2(p.pos.y + 1.2 - (e.pos.y + 1.55), dist)
  }
  const r = (e.data.recoilT ?? 0) / 0.55
  setRot(b, 'weapon', -pitchAng * 0.8 - 0.5 * r * r, 0, 0)
  setRot(b, 'head', -pitchAng * 0.4, 0, 0)
  RM.tiltX -= 0.1 * r * r
  setGlow(b, 'muzzle', 1 + 10 * r * r)
  if (e.state === 'track') {
    const k = clamp01(e.stateT / SNIPER_TRACK_DUR)
    setGlow(b, 'lens', 0.7 + 2.6 * k)
    setGlow(b, 'eye', 1)
  } else if (e.state === 'aim') {
    setGlow(b, 'lens', 4 + Math.sin(e.stateT * 30) * 0.6)
    setGlow(b, 'eye', 2)
  } else {
    setGlow(b, 'lens', 1)
    setGlow(b, 'eye', 1)
  }
  // live laser sight: faint while tracking, hard while locked
  const laser = b.laser
  const mn = b.nodes.muzzle
  if (laser && mn) {
    const show = (e.state === 'track' && e.stateT > 0.35) || e.state === 'aim'
    laser.visible = show
    if (show) {
      mn.updateWorldMatrix(true, false)
      mn.getWorldPosition(_wp)
      if (e.state === 'aim') _wt.set(e.data.bx ?? 0, e.data.by ?? 1, e.data.bz ?? 0)
      else _wt.set(p.pos.x, p.pos.y + 1.2, p.pos.z)
      const len = _wp.distanceTo(_wt)
      laser.position.copy(_wp).add(_wt).multiplyScalar(0.5)
      laser.scale.set(0.022, 0.022, Math.max(0.1, len))
      laser.lookAt(_wt)
      const m = laser.material as THREE.MeshBasicMaterial
      m.opacity = e.state === 'aim' ? 0.5 + Math.sin(world.time * 40) * 0.12 : 0.16
    }
  }
}

function poseBody(e: Enemy, b: EnemyBody, step: number, running: boolean): void {
  const g = b.group
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
  b.chassis.emissive.setScalar(flash)
  b.dark.emissive.setScalar(flash * 0.8)

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

  if (e.falling) {
    // limbs flail on the way down
    setRot(b, 'legL', 0.45, 0, 0.12)
    setRot(b, 'legR', -0.35, 0, -0.12)
    setRot(b, 'armL', -0.7 + Math.sin(world.time * 9 + e.id) * 0.25, 0, 0.5)
    setRot(b, 'armR', -0.6 + Math.cos(world.time * 8 + e.id) * 0.25, 0, -0.5)
    RM.tiltX = Math.sin(world.time * 3 + e.id * 2.1) * 0.12
    for (const k in b.glow) setGlow(b, k, 1)
    if (b.laser) b.laser.visible = false
  } else if (dyingT < 0) {
    // walk/idle baseline; per-kind overlays refine below
    setRot(b, 'legL', legSwing, 0, 0)
    setRot(b, 'legR', -legSwing, 0, 0)
    setRot(b, 'armL', -Math.sin(ph) * 0.35 * amp, 0, 0)
    setRot(b, 'armR', Math.sin(ph) * 0.3 * amp, 0, 0)
    setRot(b, 'torso')
    setRot(b, 'head')
    setRot(b, 'weapon')
    setPos(b, 'weapon')
    RM.bobY = (1 - Math.cos(ph * 2)) * 0.5 * 0.05 * amp
    RM.tiltZ = Math.sin(world.time * 1.6 + e.id * 1.7) * 0.02
    if (e.kind === 'melee') poseMelee(e, b)
    else if (e.kind === 'ranger') poseRanger(e, b, step, running)
    else if (e.kind === 'tank') poseTank(e, b, step)
    else poseSniper(e, b)
  } else {
    // collapse: tip over at the feet, arms out, sink away before removal
    const tip = easeIn(clamp01(dyingT / 0.72))
    RM.tiltX = tip * 1.5 * (e.data.deathTip ?? 1)
    RM.tiltZ = tip * (e.data.deathRoll ?? 0)
    g.position.y = e.pos.y - Math.max(0, dyingT - 0.55) * 1.1
    setRot(b, 'armL', -0.4 * tip, 0, 0.4 * tip)
    setRot(b, 'armR', -0.3 * tip, 0, -0.5 * tip)
    setRot(b, 'head', 0.4 * tip, 0.3 * tip, 0)
    for (const k in b.glow) setGlow(b, k, deathGlow)
    if (b.laser) b.laser.visible = false
  }

  // landing squash & stretch
  const landT = e.data.landT ?? 0
  if (landT > 0 && !e.falling) {
    const k = Math.sin(Math.PI * (1 - landT / LAND_TIME))
    RM.sy = 1 - 0.28 * k
    RM.sxz = 1 + 0.2 * k
  }

  const root = b.nodes.root
  const rb = b.base.root
  if (root && rb) {
    root.position.set(rb.px + RM.shakeX, rb.py + RM.bobY, rb.pz)
    root.rotation.set(rb.rx + RM.tiltX, rb.ry, rb.rz + RM.tiltZ)
    root.scale.set(RM.sxz, RM.sy, RM.sxz)
  }
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

// ─── Component ───────────────────────────────────────────────────────────────

const removeList: number[] = []

function destroyBody(root: THREE.Group, b: EnemyBody): void {
  root.remove(b.group)
  if (b.laser) root.remove(b.laser)
  b.dispose()
}

export function Enemies() {
  const rootRef = useRef<THREE.Group>(null)
  const bodiesRef = useRef<Map<number, EnemyBody>>(new Map())
  const dustRef = useRef<DustPool | null>(null)

  // hard reset on run restart (Director owns world.reset(); we clear our visuals)
  useEffect(() => {
    const reset = () => {
      const root = rootRef.current
      for (const b of bodiesRef.current.values()) {
        if (root) {
          root.remove(b.group)
          if (b.laser) root.remove(b.laser)
        }
        b.dispose()
      }
      bodiesRef.current.clear()
      dustRef.current?.reset()
    }
    const unsub = useGame.subscribe((s, prev) => {
      if (s.runId !== prev.runId) reset()
    })
    return () => {
      unsub()
      reset()
    }
  }, [])

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05)
    const root = rootRef.current
    if (!root) return
    const running = simRunning(useGame.getState().phase)
    const bodies = bodiesRef.current
    if (!dustRef.current) dustRef.current = makeDustPool(root)
    const dust = dustRef.current

    if (running) {
      drainSpawns()
      removeList.length = 0
      for (const e of world.enemies.values()) {
        e.hitFlash = Math.max(0, e.hitFlash - step * 4)
        if (e.falling) {
          if (updateFall(e, step)) dust.spawn(e.pos, e.radius * 2.4)
          continue
        }
        if (e.hp <= 0) {
          if (e.state !== 'dying') {
            e.state = 'dying'
            e.stateT = 0
            e.shieldActive = false
            e.data.deathTip = Math.random() < 0.7 ? 1 : -1
            e.data.deathRoll = (Math.random() - 0.5) * 1.2
          } else {
            e.stateT += step
            if (e.stateT >= DYING_TIME) removeList.push(e.id)
          }
          continue
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
        }
        const turn =
          e.kind === 'melee' ? 10 : e.kind === 'tank' ? (e.state === 'windup' ? 12 : 6) : 5
        e.yaw = lerpAngle(e.yaw, e.data.tYaw ?? e.yaw, step * turn)
      }
      separate(step)
      for (const e of world.enemies.values()) {
        if (!e.falling && e.hp > 0) world.resolveCapsule(e.pos, e.radius)
      }
      for (const id of removeList) world.removeEnemy(id)
    }

    // visual sync: create/pose/prune bodies (pose keeps idling even off-sim)
    for (const e of world.enemies.values()) {
      let b = bodies.get(e.id)
      if (!b) {
        b = createEnemyBody(e.kind)
        root.add(b.group)
        if (b.laser) root.add(b.laser)
        bodies.set(e.id, b)
      }
      poseBody(e, b, step, running)
    }
    for (const [id, b] of bodies) {
      if (!world.enemies.has(id)) {
        destroyBody(root, b)
        bodies.delete(id)
      }
    }
    dust.update(step)
  }, FRAME_PRIO.enemies)

  return <group ref={rootRef} />
}
