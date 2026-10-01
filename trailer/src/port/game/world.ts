import * as THREE from 'three'
import type { Hazard, Telegraph, TelegraphPayload } from './types'

// Trailer stand-in for the game's mutable per-frame world. The ported Vfx
// modules (telegraph decals, fire patches, beam walls) read `world.telegraphs`,
// `world.hazards`, `world.time`, `world.player.pos` and `world.agi.*` exactly
// as they do in-game; shots populate these directly instead of a simulation.
// Telegraphs resolve at tHit like the game's Projectiles system (flash, linger
// 0.3s, then removal) and fire an optional per-telegraph callback.

export interface AgiState {
  mode: 'waves' | 'smashing' | 'fighting' | 'tired' | 'dying' | 'dead'
  vulnerable: boolean
  headPos: THREE.Vector3
  headRadius: number
}

export interface PlayerState {
  pos: THREE.Vector3
  vel: THREE.Vector3
  onGround: boolean
}

const TELEGRAPH_LINGER = 0.3

type ResolveHook = (tg: Telegraph) => void

class TrailerWorld {
  time = 0
  telegraphs: Telegraph[] = []
  hazards: Hazard[] = []
  player: PlayerState = { pos: new THREE.Vector3(0, 0, 10), vel: new THREE.Vector3(), onGround: true }
  agi: AgiState = { mode: 'waves', vulnerable: false, headPos: new THREE.Vector3(0, 27, -64), headRadius: 8.2 }
  private nextId = 1
  private hooks = new Map<number, ResolveHook>()

  id(): number { return this.nextId++ }

  reset(): void {
    this.time = 0
    this.telegraphs.length = 0
    this.hazards.length = 0
    this.hooks.clear()
    this.player.pos.set(0, 0, 10)
    this.player.vel.set(0, 0, 0)
    this.player.onGround = true
    this.agi.mode = 'waves'
    this.agi.vulnerable = false
  }

  addTelegraph(t: {
    shape: 'circle' | 'rect'; pos: THREE.Vector3; radius?: number
    w?: number; l?: number; yaw?: number; duration: number; payload: TelegraphPayload
    onResolve?: ResolveHook
  }): Telegraph {
    const tg: Telegraph = {
      id: this.id(), shape: t.shape, pos: t.pos.clone(),
      radius: t.radius ?? 0, w: t.w ?? 0, l: t.l ?? 0, yaw: t.yaw ?? 0,
      tStart: this.time, tHit: this.time + t.duration, payload: t.payload, resolved: false,
    }
    this.telegraphs.push(tg)
    if (t.onResolve) this.hooks.set(tg.id, t.onResolve)
    return tg
  }

  addHazard(h: Omit<Hazard, 'id'>): Hazard {
    const hz = { ...h, id: this.id() }
    this.hazards.push(hz)
    return hz
  }

  /** Resolve telegraphs at tHit, drop expired telegraphs/hazards. */
  step(): void {
    for (let i = this.telegraphs.length - 1; i >= 0; i--) {
      const tg = this.telegraphs[i]
      if (!tg.resolved && this.time >= tg.tHit) {
        tg.resolved = true
        const hook = this.hooks.get(tg.id)
        if (hook) hook(tg)
        if (tg.payload.beam) {
          const yaw = tg.yaw
          const lx = Math.sin(yaw), lz = Math.cos(yaw)
          const half = tg.l / 2
          this.addHazard({
            kind: 'beam', until: this.time + tg.payload.beam.duration, dps: 0,
            a: new THREE.Vector3(tg.pos.x - lx * half, 0, tg.pos.z - lz * half),
            b: new THREE.Vector3(tg.pos.x + lx * half, 0, tg.pos.z + lz * half),
            width: tg.w, height: tg.payload.beam.height,
          })
        }
      }
      if (tg.resolved && this.time >= tg.tHit + TELEGRAPH_LINGER) {
        this.hooks.delete(tg.id)
        this.telegraphs.splice(i, 1)
      }
    }
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      if (this.time > this.hazards[i].until + 2) this.hazards.splice(i, 1)
    }
  }
}

export const world = new TrailerWorld()
