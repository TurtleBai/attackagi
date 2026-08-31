import type * as THREE from 'three'
import type { BuffId } from './constants'

export type GamePhase = 'menu' | 'wave' | 'buffSelect' | 'smash' | 'boss' | 'victory' | 'dead' | 'paused'
export type WeaponSlot = 1 | 2 | 3 // 1 pistol, 2 bat, 3 molotov
export type EnemyKind = 'melee' | 'ranger' | 'tank' | 'sniper' | 'drone'
export type BossFace = 'happy' | 'angry' | 'hurt' | 'tired' | 'surprised'
export type BossPatternId = 'rockets' | 'deathBeam' | 'laserBullets' | 'punch' | 'stripeBarrage'

// ─── World entities (mutable, per-frame; never in zustand) ───────────────────

export interface Obstacle {
  id: number
  pos: THREE.Vector3 // center (y = half.y for ground-standing boxes)
  half: THREE.Vector3
  yaw: number // visual + collision rotation around Y (collision treats as AABB when yaw≈0; use yaw multiples of 0 for gameplay obstacles)
  alive: boolean
  kind: 'barrier' | 'crate' | 'pillar' | 'rack'
}

export interface Enemy {
  id: number
  kind: EnemyKind
  pos: THREE.Vector3 // feet position on ground
  vel: THREE.Vector3
  yaw: number // facing
  hp: number
  maxHp: number
  radius: number // collision cylinder radius
  height: number
  state: string // module-defined AI state
  stateT: number // seconds in current state
  hitFlash: number // 0..1, decays; set by world.damageEnemy
  shieldActive: boolean // tank: frontal bullet block
  falling: boolean // true while dropping from an AGI hand release
  data: Record<string, number> // module scratch values
}

export type ProjectileKind = 'rangerBolt' | 'bossBolt' | 'molotov' | 'rocket'

export interface Projectile {
  id: number
  kind: ProjectileKind
  pos: THREE.Vector3
  vel: THREE.Vector3
  radius: number
  damage: number
  ttl: number // seconds remaining
  gravityScale: number // 0 = straight bolt, 1 = full ballistic
}

// Red floor telegraphs. Created by any system via world.addTelegraph; rendered
// by Vfx; damage resolved centrally by the Hazards system at tHit.
export interface TelegraphPayload {
  damage: number
  instakill?: boolean
  /** if true, a player whose feet are above jumpClearY at tHit takes no damage (floor smash / stripes) */
  dodgeableByJump?: boolean
  /** spawn an explosion VFX + AoE at tHit (rockets, punch) */
  explosion?: boolean
  /** spawn a lingering beam hazard at tHit: vertical wall along the rect */
  beam?: { duration: number; height: number }
  /** informational tag for VFX styling */
  tag?: 'rocket' | 'deathBeam' | 'stripe' | 'punch' | 'smash' | 'tankBash' | 'sniper' | 'aimMarker'
  /** if set, resolves no damage — pure visual marker (minigun aim marker) */
  visualOnly?: boolean
}

export interface Telegraph {
  id: number
  shape: 'circle' | 'rect'
  pos: THREE.Vector3 // center on ground (y≈0)
  radius: number // circle
  w: number // rect width (across)
  l: number // rect length (along yaw direction)
  yaw: number // rect orientation
  tStart: number // world.time when created
  tHit: number // world.time when it resolves
  payload: TelegraphPayload
  resolved: boolean
}

export interface Hazard {
  id: number
  kind: 'fire' | 'beam'
  until: number // world.time expiry
  dps: number
  instakill?: boolean
  // fire
  pos?: THREE.Vector3
  radius?: number
  playerFire?: boolean // player-owned fire damages enemies too
  // beam: vertical laser wall from a to b
  a?: THREE.Vector3
  b?: THREE.Vector3
  width?: number
  height?: number
}

export interface Pickup {
  id: number
  kind: 'ammo'
  pos: THREE.Vector3
}

// Director → Boss: "grab these and drop them on the arena"
export interface DropRequest {
  id: number
  spawns: Array<{ kind: EnemyKind; pos: THREE.Vector3 }>
}

// Boss hands release → Enemies module instantiates
export interface PendingSpawn {
  kind: EnemyKind
  pos: THREE.Vector3
  /** spawn height for the falling-in animation (0 = already grounded) */
  dropFrom: number
}

// ─── Buffable derived stats (recomputed by store on buff pick) ───────────────

export interface PlayerStats {
  maxHp: number
  moveSpeedMult: number
  dodgeCooldown: number
  pistolDamage: number
  magSize: number
  reserveMax: number
  fireInterval: number
  reloadTime: number
  batDamage: number
  batChargeTime: number
  molotovCapacity: number
  molotovRadius: number
  fireDpsMult: number
  healOnWaveClear: number // fraction of maxHp
}

export type OwnedBuffs = Partial<Record<BuffId, number>>
