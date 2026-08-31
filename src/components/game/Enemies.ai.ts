'use client'
import * as THREE from 'three'
import {
  ARENA_RADIUS,
  DRONE_ALTITUDE, DRONE_BOMB_DAMAGE, DRONE_BOMB_RADIUS, DRONE_BOMB_TELEGRAPH,
  DRONE_CYCLE, DRONE_SPEED, GRAVITY,
  MELEE_DAMAGE, MELEE_RANGE, MELEE_SPEED, MELEE_SWING_TIME,
  PLAYER_RADIUS,
  RANGER_BOLT_SPEED, RANGER_DAMAGE, RANGER_INTERVAL,
  SNIPER_AIM_TIME, SNIPER_DAMAGE, SNIPER_INTERVAL,
  TANK_BASH_DIST, TANK_BASH_SPEED, TANK_BASH_WIDTH, TANK_DAMAGE, TANK_SPEED, TANK_WINDUP,
} from '@/game/constants'
import { events } from '@/game/events'
import { world } from '@/game/world'
import type { Enemy } from '@/game/types'

// Per-kind AI state machines. Mutate the Enemy record only; body pose is derived
// from (state, stateT, data) by Enemies.tsx. All scratch vectors are module-scoped.

const _dir = new THREE.Vector3()
const _d2 = new THREE.Vector3()
const _o = new THREE.Vector3()
const _m = new THREE.Vector3()
const _c = new THREE.Vector3()
const _t = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

export const MELEE_WINDUP_DUR = MELEE_SWING_TIME * 0.6
export const MELEE_SWING_DUR = MELEE_SWING_TIME * 0.7
export const MELEE_COOLDOWN = 0.9
export const SNIPER_TRACK_DUR = SNIPER_INTERVAL - SNIPER_AIM_TIME
export const TANK_STAGGER = 1.0
export const TANK_RECOVER = 1.2

export function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * Math.min(1, t)
}

/** Sample left/right around a blocking obstacle; keeps a preferred side to avoid dithering. */
function steerAroundObstacles(e: Enemy, dir: THREE.Vector3, dist: number): THREE.Vector3 {
  _o.set(e.pos.x, 0.9, e.pos.z)
  const look = Math.min(dist, 3.0)
  if (look < 0.6 || !world.raycastObstacles(_o, dir, look)) return dir
  const side = e.data.steerSide === -1 ? -1 : 1
  for (const ang of [0.55, 1.05, 1.55]) {
    for (const s of [side, -side]) {
      _d2.copy(dir).applyAxisAngle(UP, ang * s)
      if (!world.raycastObstacles(_o, _d2, 2.4)) {
        e.data.steerSide = s
        return _d2
      }
    }
  }
  return dir
}

// ─── Melee: chase → windup → swing → cooldown ────────────────────────────────

export function aiMelee(e: Enemy, step: number): void {
  const p = world.player
  const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
  const dist = Math.hypot(dx, dz) || 1e-4
  e.stateT += step
  switch (e.state) {
    case 'chase': {
      _dir.set(dx / dist, 0, dz / dist)
      const d = steerAroundObstacles(e, _dir, dist)
      e.pos.addScaledVector(d, MELEE_SPEED * step)
      e.data.speed = MELEE_SPEED
      e.data.tYaw = Math.atan2(d.x, d.z)
      if (dist < MELEE_RANGE) {
        e.state = 'windup'
        e.stateT = 0
        e.data.speed = 0
      }
      break
    }
    case 'windup': {
      e.data.speed = 0
      e.data.tYaw = Math.atan2(dx, dz)
      if (e.stateT >= MELEE_WINDUP_DUR) {
        e.state = 'swing'
        e.stateT = 0
        e.data.struck = 0
      }
      break
    }
    case 'swing': {
      e.data.speed = 0
      if (!e.data.struck && e.stateT >= 0.1) {
        e.data.struck = 1
        if (dist < MELEE_RANGE * 1.15 && p.pos.y < 2) world.damagePlayer(MELEE_DAMAGE)
      }
      if (e.stateT >= MELEE_SWING_DUR) {
        e.state = 'cooldown'
        e.stateT = 0
      }
      break
    }
    case 'cooldown': {
      e.data.speed = 0
      e.data.tYaw = Math.atan2(dx, dz)
      if (e.stateT >= MELEE_COOLDOWN) {
        e.state = dist < MELEE_RANGE ? 'windup' : 'chase'
        e.stateT = 0
      }
      break
    }
    default:
      e.state = 'chase'
      e.stateT = 0
  }
}

// ─── Ranger: stationary turret; sidesteps only when LoS is blocked ───────────

export function aiRanger(e: Enemy, step: number): void {
  const p = world.player
  const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
  const dist = Math.hypot(dx, dz) || 1e-4
  e.stateT += step
  e.data.tYaw = Math.atan2(dx, dz)
  e.data.fireT = (e.data.fireT ?? RANGER_INTERVAL) - step
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw)
  _m.set(e.pos.x + fx * 0.55, e.pos.y + 1.5, e.pos.z + fz * 0.55)
  _c.set(p.pos.x, p.pos.y + 1.2, p.pos.z)
  if (e.state === 'reposition') {
    const sgn = e.data.sideSign === -1 ? -1 : 1
    _d2.set((-dz / dist) * sgn, 0, (dx / dist) * sgn)
    _o.set(e.pos.x, 0.9, e.pos.z)
    if (world.raycastObstacles(_o, _d2, 1.2)) {
      e.data.sideSign = -sgn
    } else {
      e.pos.addScaledVector(_d2, 2.3 * step)
      e.data.sideLeft = (e.data.sideLeft ?? 3) - 2.3 * step
    }
    e.data.speed = 2.3
    if ((e.data.sideLeft ?? 0) <= 0 || !world.segmentBlocked(_m, _c)) {
      e.state = 'hold'
      e.stateT = 0
      e.data.speed = 0
    }
  } else {
    e.data.speed = 0
  }
  if (e.data.fireT <= 0) {
    if (!world.segmentBlocked(_m, _c)) {
      // dodgeable bolt with a little lead and spread
      const lead = Math.min(0.5, (dist / RANGER_BOLT_SPEED) * 0.35)
      _t.set(
        p.pos.x + p.vel.x * lead,
        p.pos.y + 1.0 + p.vel.y * lead * 0.5,
        p.pos.z + p.vel.z * lead,
      )
      _d2.copy(_t).sub(_m).normalize()
      _d2.x += (Math.random() - 0.5) * 0.05
      _d2.y += (Math.random() - 0.5) * 0.03
      _d2.z += (Math.random() - 0.5) * 0.05
      _d2.normalize().multiplyScalar(RANGER_BOLT_SPEED)
      world.addProjectile({
        kind: 'rangerBolt', pos: _m, vel: _d2,
        radius: 0.18, damage: RANGER_DAMAGE, ttl: 6, gravityScale: 0,
      })
      e.data.muzzleT = 0.18
      e.data.fireT = RANGER_INTERVAL * (0.85 + Math.random() * 0.3)
    } else {
      e.data.fireT = 0.35
      if (e.state !== 'reposition') {
        e.state = 'reposition'
        e.stateT = 0
        e.data.sideSign = Math.random() < 0.5 ? -1 : 1
        e.data.sideLeft = 2.5 + Math.random() * 2.5
      }
    }
  }
}

// ─── Tank: advance → windup (rect telegraph) → shield bash dash ──────────────

export function aiTank(e: Enemy, step: number): void {
  const p = world.player
  const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
  const dist = Math.hypot(dx, dz) || 1e-4
  e.stateT += step
  switch (e.state) {
    case 'advance': {
      e.shieldActive = true
      _dir.set(dx / dist, 0, dz / dist)
      e.data.tYaw = Math.atan2(dx, dz)
      if (dist <= TANK_BASH_DIST * 0.8) {
        _o.set(e.pos.x, e.pos.y + 1, e.pos.z)
        _c.set(p.pos.x, p.pos.y + 1, p.pos.z)
        if (!world.segmentBlocked(_o, _c)) {
          const hit = world.raycastObstacles(_o, _dir, TANK_BASH_DIST)
          const dashLen = hit ? Math.max(1, hit.dist - e.radius) : TANK_BASH_DIST
          e.data.dashX = _dir.x
          e.data.dashZ = _dir.z
          e.data.dashLen = dashLen
          e.data.traveled = 0
          e.data.hitP = 0
          _t.set(e.pos.x + (_dir.x * dashLen) / 2, 0, e.pos.z + (_dir.z * dashLen) / 2)
          world.addTelegraph({
            shape: 'rect', pos: _t, w: TANK_BASH_WIDTH, l: dashLen,
            yaw: Math.atan2(_dir.x, _dir.z), duration: TANK_WINDUP,
            payload: { damage: 0, visualOnly: true, tag: 'tankBash' },
          })
          e.state = 'windup'
          e.stateT = 0
          e.data.speed = 0
          break
        }
      }
      const d = steerAroundObstacles(e, _dir, dist)
      e.pos.addScaledVector(d, TANK_SPEED * step)
      e.data.speed = TANK_SPEED
      e.data.tYaw = Math.atan2(d.x, d.z)
      break
    }
    case 'windup': {
      e.data.speed = 0
      e.data.tYaw = Math.atan2(e.data.dashX, e.data.dashZ)
      if (e.stateT >= TANK_WINDUP) {
        e.state = 'dash'
        e.stateT = 0
      }
      break
    }
    case 'dash': {
      e.data.speed = 0
      _dir.set(e.data.dashX, 0, e.data.dashZ)
      const move = TANK_BASH_SPEED * step
      _o.set(e.pos.x, e.pos.y + 1, e.pos.z)
      const hit = world.raycastObstacles(_o, _dir, move + e.radius + 0.05)
      if (hit) {
        // slammed into an obstacle: stop short, drop the shield, stagger
        e.pos.addScaledVector(_dir, Math.max(0, hit.dist - e.radius))
        e.state = 'stagger'
        e.stateT = 0
        e.shieldActive = false
        break
      }
      e.pos.addScaledVector(_dir, move)
      e.data.traveled = (e.data.traveled ?? 0) + move
      if (!e.data.hitP) {
        const pdx = p.pos.x - e.pos.x, pdz = p.pos.z - e.pos.z
        const rr = e.radius + PLAYER_RADIUS + 0.3
        if (pdx * pdx + pdz * pdz < rr * rr && p.pos.y < 1.2) {
          e.data.hitP = 1
          world.damagePlayer(TANK_DAMAGE)
          p.vel.x += _dir.x * 8
          p.vel.z += _dir.z * 8
          p.vel.y += 3
        }
      }
      if ((e.data.traveled ?? 0) >= (e.data.dashLen ?? 0)) {
        e.state = 'recover'
        e.stateT = 0
        e.shieldActive = false
      }
      break
    }
    case 'stagger': {
      e.data.speed = 0
      e.shieldActive = false
      if (e.stateT >= TANK_STAGGER) {
        e.state = 'advance'
        e.stateT = 0
        e.shieldActive = true
      }
      break
    }
    case 'recover': {
      e.data.speed = 0
      e.shieldActive = false
      e.data.tYaw = Math.atan2(dx, dz)
      if (e.stateT >= TANK_RECOVER) {
        e.state = 'advance'
        e.stateT = 0
        e.shieldActive = true
      }
      break
    }
    default:
      e.state = 'advance'
      e.stateT = 0
  }
}

// ─── Drone: travel → hover above target → circle telegraph + bomb drop ───────

/** Seconds the drone lingers over the target after release (watching the boom). */
export const DRONE_LINGER = 0.4
/** Re-pick the bombing point when the player has run this far from it. */
const DRONE_STALE_DIST = 14
/** Pose pulse length after a bomb release (rack flash + kick-up), read by poseDrone. */
export const DRONE_DROP_PULSE = 0.9

/** Bombing point biased near the player: random offset 4–9m, clamped to the arena. */
function pickBombTarget(e: Enemy): void {
  const p = world.player
  const a = Math.random() * Math.PI * 2
  const r = 4 + Math.random() * 5
  let x = p.pos.x + Math.sin(a) * r
  let z = p.pos.z + Math.cos(a) * r
  const d = Math.hypot(x, z)
  const max = ARENA_RADIUS - 2.5
  if (d > max) {
    x = (x / d) * max
    z = (z / d) * max
  }
  e.data.bombX = x
  e.data.bombZ = z
  e.data.hasTarget = 1
}

export function aiDrone(e: Enemy, step: number): void {
  const p = world.player
  e.stateT += step
  e.data.bombT = (e.data.bombT ?? DRONE_CYCLE) - step
  if (e.data.hasTarget !== 1) pickBombTarget(e)

  // vertical: hold altitude with a gentle bob — the GAMEPLAY y really bobs, so
  // raycasts/collision see the same motion the eye does. Also lifts ground-level
  // spawns (dropFrom 0) smoothly up to cruise height.
  const wantY = DRONE_ALTITUDE + Math.sin(world.time * 1.7 + (e.data.phase ?? 0)) * 0.28
  e.pos.y += (wantY - e.pos.y) * Math.min(1, 3 * step)

  const tx = e.data.bombX ?? 0
  const tz = e.data.bombZ ?? 0
  const dx = tx - e.pos.x
  const dz = tz - e.pos.z
  const dist = Math.hypot(dx, dz)

  // smoothed world-velocity (for pose tilt-into-motion); decays while hovering
  let mvx = 0
  let mvz = 0

  switch (e.state) {
    case 'travel': {
      // the player ran off — the picked point no longer threatens; chase closer
      const pdx = tx - p.pos.x
      const pdz = tz - p.pos.z
      if (pdx * pdx + pdz * pdz > DRONE_STALE_DIST * DRONE_STALE_DIST) pickBombTarget(e)
      const spd = DRONE_SPEED * Math.min(1, 0.3 + dist / 3) // ease in on arrival
      if (dist > 1e-4) {
        mvx = (dx / dist) * spd
        mvz = (dz / dist) * spd
        e.pos.x += mvx * step
        e.pos.z += mvz * step
      }
      e.data.speed = spd
      e.data.tYaw = dist > 1.2
        ? Math.atan2(dx, dz)
        : Math.atan2(p.pos.x - e.pos.x, p.pos.z - e.pos.z)
      if (dist < 0.7) {
        e.state = 'hover'
        e.stateT = 0
        e.data.speed = 0
      }
      break
    }
    case 'hover': {
      // pinned directly above the target; face the player while waiting
      const ck = Math.min(1, 4 * step)
      e.pos.x += dx * ck
      e.pos.z += dz * ck
      mvx = (dx * ck) / Math.max(step, 1e-4)
      mvz = (dz * ck) / Math.max(step, 1e-4)
      e.data.speed = 0
      e.data.tYaw = Math.atan2(p.pos.x - e.pos.x, p.pos.z - e.pos.z)
      const pdx = tx - p.pos.x
      const pdz = tz - p.pos.z
      if (pdx * pdx + pdz * pdz > DRONE_STALE_DIST * DRONE_STALE_DIST) {
        // target went stale while waiting for the cycle — reposition first
        pickBombTarget(e)
        e.state = 'travel'
        e.stateT = 0
        break
      }
      if (e.data.bombT <= 0) {
        // glowing red circle on the floor; damage resolves centrally at tHit
        _t.set(tx, 0, tz)
        world.addTelegraph({
          shape: 'circle', pos: _t, radius: DRONE_BOMB_RADIUS, duration: DRONE_BOMB_TELEGRAPH,
          payload: { damage: DRONE_BOMB_DAMAGE, explosion: true, tag: 'rocket' },
        })
        // visual bomb from the rack, gravity-timed to land exactly at tHit
        // (same trick as the boss rocket barrage: kind 'rocket', damage 0)
        _m.set(e.pos.x, e.pos.y - 0.35, e.pos.z)
        const h = Math.max(1, _m.y)
        const v0 = 0.6 // small initial push so the streak orients nose-down at once
        const gs = (2 * (h - v0 * DRONE_BOMB_TELEGRAPH)) / (GRAVITY * DRONE_BOMB_TELEGRAPH * DRONE_BOMB_TELEGRAPH)
        world.addProjectile({
          kind: 'rocket', pos: _m, vel: _d2.set(0, -v0, 0),
          radius: 0.3, damage: 0, ttl: DRONE_BOMB_TELEGRAPH + 0.3, gravityScale: Math.max(0, gs),
        })
        e.data.dropT = DRONE_DROP_PULSE
        e.data.bombT = DRONE_CYCLE * (0.9 + Math.random() * 0.2)
        e.state = 'dropwait'
        e.stateT = 0
      }
      break
    }
    case 'dropwait': {
      // linger over the strike, then drift off to the next point
      e.data.speed = 0
      e.data.tYaw = Math.atan2(p.pos.x - e.pos.x, p.pos.z - e.pos.z)
      if (e.stateT >= DRONE_BOMB_TELEGRAPH + DRONE_LINGER) {
        pickBombTarget(e)
        e.state = 'travel'
        e.stateT = 0
      }
      break
    }
    default:
      e.state = 'travel'
      e.stateT = 0
  }

  // damp the pose-tilt velocity toward this frame's actual motion
  const k = Math.min(1, 6 * step)
  e.data.vx = (e.data.vx ?? 0) + (mvx - (e.data.vx ?? 0)) * k
  e.data.vz = (e.data.vz ?? 0) + (mvz - (e.data.vz ?? 0)) * k
}

// ─── Sniper: track (live laser sight) → aim lock (rect telegraph) → beam ─────

export function aiSniper(e: Enemy, step: number): void {
  const p = world.player
  const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z
  e.stateT += step
  e.data.recoilT = Math.max(0, (e.data.recoilT ?? 0) - step)
  e.data.speed = 0
  if (e.state === 'aim') {
    e.data.tYaw = e.data.lockYaw ?? e.yaw
    if (e.stateT >= SNIPER_AIM_TIME) {
      _m.set(e.data.ax ?? 0, e.data.ay ?? 1.5, e.data.az ?? 0)
      _t.set(e.data.bx ?? 0, e.data.by ?? 1.5, e.data.bz ?? 0)
      events.emit('beamFire', { a: _m.clone(), b: _t.clone(), kind: 'sniper' })
      _c.set(p.pos.x, p.pos.y + 1.2, p.pos.z)
      if (
        !world.segmentBlocked(_m, _c) &&
        world.distToSegmentXZ(p.pos, _m, _t) < 0.7 &&
        p.pos.y < 2.5
      ) {
        world.damagePlayer(SNIPER_DAMAGE)
      }
      e.data.recoilT = 0.55
      e.state = 'track'
      e.stateT = 0
      e.data.cycleJitter = Math.random() * 0.6 - 0.2
    }
    return
  }
  // track
  if (e.state !== 'track') {
    e.state = 'track'
    e.stateT = 0
  }
  e.data.tYaw = Math.atan2(dx, dz)
  if (e.stateT >= SNIPER_TRACK_DUR + (e.data.cycleJitter ?? 0)) {
    // lock aim: beam from muzzle through the player's chest, extended past the rim
    const mfx = Math.sin(e.yaw), mfz = Math.cos(e.yaw)
    _m.set(e.pos.x + mfx * 1.0, e.pos.y + 1.55, e.pos.z + mfz * 1.0)
    _c.set(p.pos.x, p.pos.y + 1.2, p.pos.z)
    _d2.copy(_c).sub(_m).normalize()
    const a2 = _d2.x * _d2.x + _d2.z * _d2.z
    let t = 80
    if (a2 > 1e-6) {
      const b2 = 2 * (_m.x * _d2.x + _m.z * _d2.z)
      const c2 = _m.x * _m.x + _m.z * _m.z - (ARENA_RADIUS + 3) ** 2
      const disc = b2 * b2 - 4 * a2 * c2
      if (disc > 0) t = (-b2 + Math.sqrt(disc)) / (2 * a2)
    }
    _t.copy(_m).addScaledVector(_d2, t)
    e.data.ax = _m.x; e.data.ay = _m.y; e.data.az = _m.z
    e.data.bx = _t.x; e.data.by = _t.y; e.data.bz = _t.z
    e.data.lockYaw = Math.atan2(_d2.x, _d2.z)
    e.data.lockPitch = Math.asin(THREE.MathUtils.clamp(_d2.y, -1, 1))
    e.data.tYaw = e.data.lockYaw
    const lenXZ = Math.hypot(_t.x - _m.x, _t.z - _m.z)
    _o.set((_m.x + _t.x) / 2, 0, (_m.z + _t.z) / 2)
    world.addTelegraph({
      shape: 'rect', pos: _o, w: 0.6, l: lenXZ, yaw: e.data.lockYaw,
      duration: SNIPER_AIM_TIME,
      payload: { damage: 0, visualOnly: true, tag: 'sniper' },
    })
    e.state = 'aim'
    e.stateT = 0
  }
}
