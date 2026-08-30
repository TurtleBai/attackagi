import * as THREE from 'three'
import { ARENA_RADIUS, PLAYER_RADIUS } from './constants'
import { events } from './events'
import { useGame } from './store'
import type {
  DropRequest, Enemy, EnemyKind, Hazard, Obstacle, PendingSpawn, Pickup,
  Projectile, ProjectileKind, Telegraph, TelegraphPayload,
} from './types'

// The mutable per-frame world. Systems read/write this in useFrame; React/zustand
// only mirrors UI-relevant values. Everything here is reset on run restart.

export interface PlayerState {
  pos: THREE.Vector3 // feet position
  vel: THREE.Vector3
  yaw: number
  pitch: number
  onGround: boolean
  alive: boolean
  invulnUntil: number // world.time; dodge i-frames
  dodgeReadyAt: number
  moveInput: THREE.Vector2 // normalized WASD intent (for dodge direction, HUD)
}

export interface AgiState {
  /** boss combat state, driven by the Agi module */
  mode: 'waves' | 'smashing' | 'fighting' | 'tired' | 'dying' | 'dead'
  /** true only while the player is allowed to damage the boss (tired window) */
  vulnerable: boolean
  /** world positions of lingering punch hands (empty unless punch linger active); damageable */
  punchHands: Array<{ pos: THREE.Vector3; radius: number; hpLeft: number }>
  /** head center in world space, for aiming/eye checks (updated by Agi module) */
  headPos: THREE.Vector3
  headRadius: number
}

class World {
  time = 0
  private nextId = 1
  id(): number { return this.nextId++ }

  player: PlayerState = {
    pos: new THREE.Vector3(0, 0, 10),
    vel: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    onGround: true,
    alive: true,
    invulnUntil: 0,
    dodgeReadyAt: 0,
    moveInput: new THREE.Vector2(),
  }

  agi: AgiState = {
    mode: 'waves',
    vulnerable: false,
    punchHands: [],
    headPos: new THREE.Vector3(0, 34, -70),
    headRadius: 9,
  }

  enemies = new Map<number, Enemy>()
  obstacles: Obstacle[] = []
  projectiles: Projectile[] = []
  telegraphs: Telegraph[] = []
  hazards: Hazard[] = []
  pickups: Pickup[] = []
  dropRequests: DropRequest[] = [] // Director → Agi
  pendingSpawns: PendingSpawn[] = [] // Agi → Enemies

  reset(): void {
    this.time = 0
    this.player.pos.set(0, 0, 10)
    this.player.vel.set(0, 0, 0)
    this.player.yaw = 0
    this.player.pitch = 0
    this.player.onGround = true
    this.player.alive = true
    this.player.invulnUntil = 0
    this.player.dodgeReadyAt = 0
    this.agi.mode = 'waves'
    this.agi.vulnerable = false
    this.agi.punchHands = []
    this.enemies.clear()
    this.obstacles.length = 0
    this.projectiles.length = 0
    this.telegraphs.length = 0
    this.hazards.length = 0
    this.pickups.length = 0
    this.dropRequests.length = 0
    this.pendingSpawns.length = 0
  }

  // ─── Damage ────────────────────────────────────────────────────────────────

  playerInvulnerable(): boolean { return this.time < this.player.invulnUntil }

  damagePlayer(amount: number, opts?: { ignoreIFrames?: boolean; instakill?: boolean }): boolean {
    if (!this.player.alive) return false
    if (!opts?.ignoreIFrames && this.playerInvulnerable()) return false
    const dmg = opts?.instakill ? 99999 : amount
    useGame.getState().damage(dmg)
    events.emit('playerHit', { amount: dmg })
    if (useGame.getState().hp <= 0) this.player.alive = false
    return true
  }

  /** Returns true if damage was applied. Enemy modules own death (hp<=0 → removeEnemy). */
  damageEnemy(id: number, amount: number): boolean {
    const e = this.enemies.get(id)
    if (!e || e.hp <= 0) return false
    e.hp -= amount
    e.hitFlash = 1
    events.emit('enemyHit', { pos: e.pos.clone(), kind: e.kind })
    return true
  }

  /** Call after death animation; emits enemyDeath + decrements wave counter. */
  removeEnemy(id: number): void {
    const e = this.enemies.get(id)
    if (!e) return
    this.enemies.delete(id)
    events.emit('enemyDeath', { pos: e.pos.clone(), kind: e.kind })
    const s = useGame.getState()
    s.set({ enemiesRemaining: Math.max(0, s.enemiesRemaining - 1), kills: s.kills + 1 })
  }

  /** Damage the boss (tired window) or a lingering punch hand. Returns applied. */
  damageBoss(amount: number, at?: THREE.Vector3): boolean {
    const s = useGame.getState()
    if (this.agi.mode === 'dead' || this.agi.mode === 'dying') return false
    // punch hands are damageable even while attacking, but with a per-hand cap
    if (at) {
      for (const hand of this.agi.punchHands) {
        if (hand.hpLeft > 0 && at.distanceTo(hand.pos) < hand.radius + 1.5) {
          const applied = Math.min(amount, hand.hpLeft)
          hand.hpLeft -= applied
          s.set({ bossHp: Math.max(0, s.bossHp - applied) })
          events.emit('bossHit', { pos: at.clone(), amount: applied })
          return true
        }
      }
    }
    if (!this.agi.vulnerable) return false
    s.set({ bossHp: Math.max(0, s.bossHp - amount) })
    events.emit('bossHit', { pos: at ? at.clone() : null, amount })
    return true
  }

  // ─── Spawning / queues ─────────────────────────────────────────────────────

  spawnEnemy(kind: EnemyKind, pos: THREE.Vector3, dropFrom = 0): void {
    this.pendingSpawns.push({ kind, pos: pos.clone(), dropFrom })
  }

  addObstacle(o: Omit<Obstacle, 'id'>): Obstacle {
    const ob = { ...o, id: this.id(), pos: o.pos.clone(), half: o.half.clone() }
    this.obstacles.push(ob)
    return ob
  }

  clearObstacles(): void {
    for (const o of this.obstacles) o.alive = false
  }

  addProjectile(p: {
    kind: ProjectileKind; pos: THREE.Vector3; vel: THREE.Vector3
    radius: number; damage: number; ttl: number; gravityScale?: number
  }): Projectile {
    const proj: Projectile = {
      id: this.id(), kind: p.kind, pos: p.pos.clone(), vel: p.vel.clone(),
      radius: p.radius, damage: p.damage, ttl: p.ttl, gravityScale: p.gravityScale ?? 0,
    }
    this.projectiles.push(proj)
    return proj
  }

  addTelegraph(t: {
    shape: 'circle' | 'rect'; pos: THREE.Vector3; radius?: number
    w?: number; l?: number; yaw?: number; duration: number; payload: TelegraphPayload
  }): Telegraph {
    const tg: Telegraph = {
      id: this.id(), shape: t.shape, pos: t.pos.clone(),
      radius: t.radius ?? 0, w: t.w ?? 0, l: t.l ?? 0, yaw: t.yaw ?? 0,
      tStart: this.time, tHit: this.time + t.duration, payload: t.payload, resolved: false,
    }
    this.telegraphs.push(tg)
    return tg
  }

  addHazard(h: Omit<Hazard, 'id'>): Hazard {
    const hz = { ...h, id: this.id() }
    this.hazards.push(hz)
    return hz
  }

  addPickup(pos: THREE.Vector3): Pickup {
    const p: Pickup = { id: this.id(), kind: 'ammo', pos: pos.clone() }
    this.pickups.push(p)
    return p
  }

  // ─── Geometry queries ──────────────────────────────────────────────────────

  /** Slab-test ray vs live obstacle AABBs (yaw ignored; gameplay obstacles are axis-aligned). */
  raycastObstacles(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number):
    { dist: number; point: THREE.Vector3 } | null {
    let best = maxDist
    for (const o of this.obstacles) {
      if (!o.alive) continue
      const t = rayAabb(origin, dir, o.pos, o.half)
      if (t !== null && t >= 0 && t < best) best = t
    }
    if (best >= maxDist) return null
    return { dist: best, point: origin.clone().addScaledVector(dir, best) }
  }

  /** Is the straight segment a→b blocked by any live obstacle? (LoS checks) */
  segmentBlocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const dir = _v1.copy(b).sub(a)
    const len = dir.length()
    if (len < 1e-5) return false
    dir.divideScalar(len)
    for (const o of this.obstacles) {
      if (!o.alive) continue
      const t = rayAabb(a, dir, o.pos, o.half)
      if (t !== null && t >= 0 && t < len) return true
    }
    return false
  }

  /**
   * Hitscan vs enemies (vertical cylinders) + boss punch hands + boss head, respecting
   * obstacle occlusion and tank shields. Returns nearest hit.
   */
  raycastShot(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): {
    kind: 'enemy' | 'shieldBlock' | 'obstacle' | 'boss'
    enemy?: Enemy
    dist: number
    point: THREE.Vector3
  } | null {
    const obs = this.raycastObstacles(origin, dir, maxDist)
    let bestDist = obs ? obs.dist : maxDist
    let result: { kind: 'enemy' | 'shieldBlock' | 'obstacle' | 'boss'; enemy?: Enemy; dist: number; point: THREE.Vector3 } | null =
      obs ? { kind: 'obstacle', dist: obs.dist, point: obs.point } : null

    for (const e of this.enemies.values()) {
      if (e.hp <= 0 || e.falling) continue
      const t = rayCylinder(origin, dir, e.pos, e.radius, e.height)
      if (t === null || t < 0 || t >= bestDist) continue
      const point = origin.clone().addScaledVector(dir, t)
      if (e.kind === 'tank' && e.shieldActive) {
        // blocked if the shot comes from within the shield's frontal arc
        const toShooter = _v1.copy(origin).sub(e.pos).setY(0).normalize()
        const facing = _v2.set(Math.sin(e.yaw), 0, Math.cos(e.yaw))
        const halfArc = Math.acos(THREE.MathUtils.clamp(facing.dot(toShooter), -1, 1))
        if (halfArc < 0.62 * Math.PI * 0.5 + 0.35) {
          bestDist = t
          result = { kind: 'shieldBlock', enemy: e, dist: t, point }
          continue
        }
      }
      bestDist = t
      result = { kind: 'enemy', enemy: e, dist: t, point }
    }

    // boss weak points: lingering punch hands, and head/monitor while vulnerable
    for (const hand of this.agi.punchHands) {
      if (hand.hpLeft <= 0) continue
      const t = raySphere(origin, dir, hand.pos, hand.radius)
      if (t !== null && t >= 0 && t < bestDist) {
        bestDist = t
        result = { kind: 'boss', dist: t, point: origin.clone().addScaledVector(dir, t) }
      }
    }
    if (this.agi.vulnerable) {
      const t = raySphere(origin, dir, this.agi.headPos, this.agi.headRadius)
      if (t !== null && t >= 0 && t < bestDist) {
        bestDist = t
        result = { kind: 'boss', dist: t, point: origin.clone().addScaledVector(dir, t) }
      }
    }
    return result
  }

  /**
   * Push a capsule (feet pos, radius) out of live obstacles and clamp to the arena.
   * Mutates and returns pos. Used by player + enemy movement.
   */
  resolveCapsule(pos: THREE.Vector3, radius: number): THREE.Vector3 {
    for (const o of this.obstacles) {
      if (!o.alive) continue
      if (pos.y > o.pos.y + o.half.y) continue // stepped over (jumping above the box)
      const dx = pos.x - o.pos.x
      const dz = pos.z - o.pos.z
      const px = o.half.x + radius - Math.abs(dx)
      const pz = o.half.z + radius - Math.abs(dz)
      if (px <= 0 || pz <= 0) continue
      if (px < pz) pos.x += px * Math.sign(dx || 1)
      else pos.z += pz * Math.sign(dz || 1)
    }
    const r = ARENA_RADIUS - radius
    const d2 = pos.x * pos.x + pos.z * pos.z
    if (d2 > r * r) {
      const d = Math.sqrt(d2)
      pos.x = (pos.x / d) * r
      pos.z = (pos.z / d) * r
    }
    return pos
  }

  // ─── Area checks (used by hazards/telegraph resolution) ───────────────────

  playerFeet(): THREE.Vector3 { return this.player.pos }

  playerInCircle(center: THREE.Vector3, radius: number): boolean {
    const dx = this.player.pos.x - center.x
    const dz = this.player.pos.z - center.z
    return dx * dx + dz * dz <= (radius + PLAYER_RADIUS) ** 2
  }

  playerInRect(center: THREE.Vector3, yaw: number, w: number, l: number): boolean {
    const dx = this.player.pos.x - center.x
    const dz = this.player.pos.z - center.z
    const cos = Math.cos(yaw), sin = Math.sin(yaw)
    // rect length runs along its yaw direction (sin, cos), width across
    const along = dx * sin + dz * cos
    const across = dx * cos - dz * sin
    return Math.abs(along) <= l / 2 + PLAYER_RADIUS && Math.abs(across) <= w / 2 + PLAYER_RADIUS
  }

  enemiesInCircle(center: THREE.Vector3, radius: number): Enemy[] {
    const out: Enemy[] = []
    for (const e of this.enemies.values()) {
      if (e.hp <= 0) continue
      const dx = e.pos.x - center.x
      const dz = e.pos.z - center.z
      if (dx * dx + dz * dz <= (radius + e.radius) ** 2) out.push(e)
    }
    return out
  }

  /** Distance from point p to the segment a-b, in the XZ plane. */
  distToSegmentXZ(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
    const abx = b.x - a.x, abz = b.z - a.z
    const apx = p.x - a.x, apz = p.z - a.z
    const len2 = abx * abx + abz * abz
    const t = len2 < 1e-8 ? 0 : THREE.MathUtils.clamp((apx * abx + apz * abz) / len2, 0, 1)
    const cx = a.x + abx * t - p.x
    const cz = a.z + abz * t - p.z
    return Math.sqrt(cx * cx + cz * cz)
  }
}

// scratch vectors (module-local, never leak)
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()

function rayAabb(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, half: THREE.Vector3): number | null {
  let tmin = -Infinity, tmax = Infinity
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = origin[axis], d = dir[axis]
    const lo = center[axis] - half[axis], hi = center[axis] + half[axis]
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null
    } else {
      let t1 = (lo - o) / d, t2 = (hi - o) / d
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return null
    }
  }
  return tmax < 0 ? null : Math.max(tmin, 0)
}

function raySphere(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, radius: number): number | null {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z
  const b = ox * dir.x + oy * dir.y + oz * dir.z
  const c = ox * ox + oy * oy + oz * oz - radius * radius
  const disc = b * b - c
  if (disc < 0) return null
  const t = -b - Math.sqrt(disc)
  return t >= 0 ? t : (-b + Math.sqrt(disc) >= 0 ? Math.max(0, -b + Math.sqrt(disc)) : null)
}

/** Ray vs vertical cylinder (feet at base.y, given radius/height). */
function rayCylinder(origin: THREE.Vector3, dir: THREE.Vector3, base: THREE.Vector3, radius: number, height: number): number | null {
  const ox = origin.x - base.x, oz = origin.z - base.z
  const a = dir.x * dir.x + dir.z * dir.z
  if (a < 1e-9) {
    // vertical ray
    if (ox * ox + oz * oz > radius * radius) return null
    const t1 = (base.y - origin.y) / dir.y
    const t2 = (base.y + height - origin.y) / dir.y
    const t = Math.min(t1, t2) >= 0 ? Math.min(t1, t2) : Math.max(t1, t2)
    return t >= 0 ? t : null
  }
  const b = ox * dir.x + oz * dir.z
  const c = ox * ox + oz * oz - radius * radius
  const disc = b * b - a * c
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  let t = (-b - sq) / a
  if (t < 0) t = (-b + sq) / a
  if (t < 0) return null
  const y = origin.y + dir.y * t
  if (y < base.y || y > base.y + height) return null
  return t
}

export const world = new World()
