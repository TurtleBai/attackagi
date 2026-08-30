import type * as THREE from 'three'
import type { BossFace, EnemyKind, WeaponSlot } from './types'

// Transient one-shot effects (VFX, audio, screen feedback). Payloads must be
// treated as read-only snapshots; Vector3s may be reused by emitters — clone if kept.
export interface EventMap {
  shot: { origin: THREE.Vector3; dir: THREE.Vector3; hitPoint: THREE.Vector3 | null }
  reloadStart: { duration: number }
  batSwing: { charged: number } // 0..1
  batHit: { pos: THREE.Vector3; charged: number }
  molotovThrow: Record<string, never>
  explosion: { pos: THREE.Vector3; radius: number; kind: 'molotov' | 'rocket' | 'punch' | 'enemy' | 'bossDeath' }
  fireIgnite: { pos: THREE.Vector3; radius: number }
  enemyHit: { pos: THREE.Vector3; kind: EnemyKind }
  /** shooter-side hit confirmation for the HUD hit marker (red when headshot) */
  hitConfirm: { headshot: boolean }
  enemyDeath: { pos: THREE.Vector3; kind: EnemyKind }
  shieldBlock: { pos: THREE.Vector3 }
  playerHit: { amount: number }
  playerDodge: Record<string, never>
  playerJump: Record<string, never>
  bossHit: { pos: THREE.Vector3 | null; amount: number }
  bossFace: { face: BossFace }
  beamFire: { a: THREE.Vector3; b: THREE.Vector3; kind: 'sniper' | 'deathBeam' | 'stripe' }
  minigunSpinup: Record<string, never>
  waveStart: { wave: number }
  waveClear: { wave: number }
  smashImpact: Record<string, never>
  bossDead: Record<string, never>
  pickup: { pos: THREE.Vector3 }
  cratePop: { pos: THREE.Vector3 }
  weaponSwitch: { slot: WeaponSlot }
  uiClick: Record<string, never>
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void

class GameEvents {
  private handlers = new Map<keyof EventMap, Set<Handler<never>>>()

  on<K extends keyof EventMap>(type: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(fn as Handler<never>)
    return () => set.delete(fn as Handler<never>)
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const set = this.handlers.get(type)
    if (!set) return
    for (const fn of set) (fn as Handler<K>)(payload)
  }

  clear(): void {
    this.handlers.clear()
  }
}

export const events = new GameEvents()
