'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  ARENA_RADIUS, CRATE_INTERVAL, CRATE_MAX, CRATE_PICKUP_RADIUS, DROP_BATCH,
  DROP_INTERVAL, FRAME_PRIO, MAX_CONCURRENT_ENEMIES, MOLOTOV_PER_CRATE, WAVES,
  type BuffId,
} from '@/game/constants'
import { events } from '@/game/events'
import { allBuffIds, simRunning, useGame } from '@/game/store'
import type { EnemyKind } from '@/game/types'
import { world } from '@/game/world'
import { animateCrate, makeCrate, type CrateVis } from './Director.crate'

// Director — game flow. Owns the phase machine (wave 1..5 → buffSelect → smash),
// wave composition + drip-feeding drop requests to the AGI, wave-clear detection,
// buff offers, run restarts (sole caller of world.reset()), and ammo-crate
// spawning / rendering / pickup. Runs first every frame (FRAME_PRIO.director).

// ─── Spawn-placement tuning (directives local to the Director, not in constants) ─
const SPAWN_R_MIN = 8 // enemy drop polar radius range
const SPAWN_R_MAX = ARENA_RADIUS - 4
const SPAWN_PLAYER_DIST = 10 // never drop enemies closer than this to the player
const CLUSTER_RADIUS = 4 // batch members land within ~this of the batch center
const OBSTACLE_MARGIN = 1 // nudge spawns this far clear of obstacle AABBs
const CAP_RETRY_INTERVAL = 0.8 // recheck sooner when blocked by the concurrency cap
const CRATE_R_MIN = 5
const CRATE_R_MAX = ARENA_RADIUS - 5
const CRATE_PLAYER_DIST = 6
const CRATE_SPACING = 5 // keep crates apart from each other

const KIND_ORDER: readonly EnemyKind[] = ['melee', 'ranger', 'tank', 'sniper', 'drone']

interface DirectorLocal {
  startedWave: number // wave number whose start we've processed (0 = none)
  bag: EnemyKind[] // shuffled spawn bag for the current wave
  dropTimer: number
  crateTimer: number
  clearHandled: boolean
  visT: number // visual clock for crate idle animation (never reset)
}

interface CrateSlot {
  vis: CrateVis
  pickupId: number // -1 = free
}

// module-scope scratch (no per-frame allocation)
const _center = new THREE.Vector3()
const _pos = new THREE.Vector3()

function clampPolar(p: THREE.Vector3, rMin: number, rMax: number): void {
  const d = Math.hypot(p.x, p.z)
  if (d < 1e-4) {
    p.x = rMin
    p.z = 0
    return
  }
  const r = THREE.MathUtils.clamp(d, rMin, rMax)
  p.x = (p.x / d) * r
  p.z = (p.z / d) * r
}

function pushFromPlayer(p: THREE.Vector3, minDist: number): void {
  const pp = world.player.pos
  const dx = p.x - pp.x
  const dz = p.z - pp.z
  const d = Math.hypot(dx, dz)
  if (d >= minDist) return
  if (d < 1e-4) {
    p.x = pp.x + minDist
    p.z = pp.z
  } else {
    p.x = pp.x + (dx / d) * minDist
    p.z = pp.z + (dz / d) * minDist
  }
}

/** Push a ground point (XZ) out of live obstacle AABBs, expanded by `margin`. */
function pushOutOfObstacles(p: THREE.Vector3, margin: number): void {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    for (const o of world.obstacles) {
      if (!o.alive) continue
      const hx = o.half.x + margin
      const hz = o.half.z + margin
      const dx = p.x - o.pos.x
      const dz = p.z - o.pos.z
      const px = hx - Math.abs(dx)
      const pz = hz - Math.abs(dz)
      if (px <= 0 || pz <= 0) continue
      if (px < pz) p.x += (px + 0.01) * Math.sign(dx || 1)
      else p.z += (pz + 0.01) * Math.sign(dz || 1)
      moved = true
    }
    if (!moved) break
  }
}

/** Random batch center: annulus [SPAWN_R_MIN+cluster, SPAWN_R_MAX-1], away from the player. */
function sampleBatchCenter(out: THREE.Vector3): THREE.Vector3 {
  const lo = SPAWN_R_MIN + CLUSTER_RADIUS
  const hi = SPAWN_R_MAX - 1
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(THREE.MathUtils.lerp(lo * lo, hi * hi, Math.random()))
    out.set(Math.sin(a) * r, 0, Math.cos(a) * r)
    const dx = out.x - world.player.pos.x
    const dz = out.z - world.player.pos.z
    const need = SPAWN_PLAYER_DIST + CLUSTER_RADIUS
    if (dx * dx + dz * dz >= need * need) return out
  }
  return out // arena is big enough that this is effectively unreachable
}

function buildBag(quota: readonly number[]): EnemyKind[] {
  const bag: EnemyKind[] = []
  for (let i = 0; i < KIND_ORDER.length; i++) {
    for (let k = 0; k < quota[i]; k++) bag.push(KIND_ORDER[i])
  }
  for (let i = bag.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    const t = bag[i]
    bag[i] = bag[j]
    bag[j] = t
  }
  return bag
}

function pickBuffChoices(): BuffId[] {
  const pool = allBuffIds.slice()
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    const t = pool[i]
    pool[i] = pool[j]
    pool[j] = t
  }
  return pool.slice(0, 3)
}

export function Director() {
  const localRef = useRef<DirectorLocal>({
    startedWave: 0, bag: [], dropTimer: 0,
    crateTimer: CRATE_INTERVAL, clearHandled: false, visT: 0,
  })

  // crate pool (CRATE_MAX slots; only the Director adds pickups, capped at CRATE_MAX).
  // Built in an effect (not render) to keep render pure; geometries/materials are
  // module-scope singletons in Director.crate.ts, so remounts are cheap.
  const groupRef = useRef<THREE.Group>(null)
  const slotsRef = useRef<CrateSlot[]>([])
  useEffect(() => {
    const g = groupRef.current
    if (!g) return
    const slots: CrateSlot[] = []
    for (let i = 0; i < CRATE_MAX; i++) {
      const vis = makeCrate()
      g.add(vis.root)
      slots.push({ vis, pickupId: -1 })
    }
    slotsRef.current = slots
    return () => {
      for (const slot of slots) g.remove(slot.vis.root)
      slotsRef.current = []
    }
  }, [])

  function resetLocal(): void {
    const local = localRef.current
    local.startedWave = 0
    local.bag = []
    local.dropTimer = 0
    local.crateTimer = CRATE_INTERVAL
    local.clearHandled = false
    // visT intentionally kept — pure visual clock
  }

  function startWave(n: number): void {
    const local = localRef.current
    const quota = WAVES[Math.min(Math.max(n, 1), WAVES.length) - 1]
    const total = quota[0] + quota[1] + quota[2] + quota[3] + quota[4]
    local.startedWave = n
    local.bag = buildBag(quota)
    local.dropTimer = 0 // first drop request fires on the next director frame
    local.clearHandled = false
    useGame.getState().set({ enemiesRemaining: total })
    events.emit('waveStart', { wave: n })
  }

  // Run restarts + phase-entry into 'wave'. The listener fires synchronously on
  // every store set; both checks are cheap diffs.
  useEffect(() => {
    const unsub = useGame.subscribe((state, prev) => {
      if (state.runId !== prev.runId) {
        // Only the Director calls world.reset(). Local state hard-resets with it.
        world.reset()
        resetLocal()
        if (state.phase === 'wave') startWave(state.wave || 1)
        return
      }
      if (state.phase === 'wave' && prev.phase !== 'wave' && localRef.current.startedWave !== state.wave) {
        // menu→wave (first start) and buffSelect→wave (next wave)
        startWave(state.wave)
      }
    })
    return unsub
  }, [])

  function flowControl(): void {
    const s = useGame.getState()
    // buff picked (Hud nulled buffChoices but left phase 'buffSelect') → advance
    if (s.phase === 'buffSelect' && s.buffChoices === null) {
      if (s.wave < WAVES.length) s.set({ phase: 'wave', wave: s.wave + 1 })
      else s.set({ phase: 'smash' }) // the AGI advances smash → boss itself
    }
    // safety net: never sit in 'wave' without that wave started (covers hot reload)
    const st = useGame.getState()
    if (st.phase === 'wave' && localRef.current.startedWave !== st.wave) startWave(st.wave)
  }

  /** Spawns queued with the AGI (requests keep their spawns until fully released). */
  function inFlightSpawns(): number {
    let n = 0
    for (const r of world.dropRequests) n += r.spawns.length
    return n
  }

  /**
   * enemiesRemaining is DERIVED, never counted down: alive (incl. collapsing
   * corpses, matching the old decrement-at-removal timing) + pending + queued
   * with the AGI + still in the bag. Recomputed every director frame, so no
   * bookkeeping drift can ever eat a wave or leak into the next one.
   * (Brief ≤ batch-size overcount while a hand releases is harmless.)
   */
  function syncRemaining(): number {
    const truth =
      world.enemies.size + world.pendingSpawns.length + inFlightSpawns() + localRef.current.bag.length
    const s = useGame.getState()
    if (world.pendingKills > 0) {
      // one store commit per frame no matter how many corpses landed together
      s.set({ enemiesRemaining: truth, kills: s.kills + world.pendingKills })
      world.pendingKills = 0
    } else if (s.enemiesRemaining !== truth) {
      s.set({ enemiesRemaining: truth })
    }
    return truth
  }

  function dripFeed(step: number): void {
    const local = localRef.current
    local.dropTimer -= step
    if (local.dropTimer > 0 || local.bag.length === 0) return
    // cap accounting from ground truth (the derived counter's own inputs)
    const activeAndInFlight = world.enemies.size + world.pendingSpawns.length + inFlightSpawns()
    const headroom = MAX_CONCURRENT_ENEMIES - activeAndInFlight
    if (headroom <= 0) {
      local.dropTimer = CAP_RETRY_INTERVAL
      return
    }
    local.dropTimer = DROP_INTERVAL
    const n = Math.min(DROP_BATCH, local.bag.length, headroom)
    sampleBatchCenter(_center)
    const spawns: Array<{ kind: EnemyKind; pos: THREE.Vector3 }> = []
    for (let i = 0; i < n; i++) {
      const kind = local.bag.pop()!
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * CLUSTER_RADIUS
      const pos = new THREE.Vector3(_center.x + Math.sin(a) * r, 0, _center.z + Math.cos(a) * r)
      clampPolar(pos, SPAWN_R_MIN, SPAWN_R_MAX)
      pushFromPlayer(pos, SPAWN_PLAYER_DIST)
      pushOutOfObstacles(pos, OBSTACLE_MARGIN)
      clampPolar(pos, 2, SPAWN_R_MAX) // stay inside the arena after nudges
      spawns.push({ kind, pos })
    }
    world.dropRequests.push({ id: world.id(), spawns })
  }

  function safetyAndClear(_step: number): void {
    const local = localRef.current
    const s = useGame.getState()
    if (local.startedWave !== s.wave || local.clearHandled) return
    // Wave clears only on ground truth: field, queues, hands and bag ALL empty.
    // (The old count-down + stall watchdog could zero the counter early, which
    // advanced waves mid-fight and cascaded kill-accounting into later waves.)
    if (syncRemaining() > 0) return
    // ─── wave clear ───
    local.clearHandled = true
    events.emit('waveClear', { wave: s.wave })
    const st = useGame.getState()
    if (st.stats.healOnWaveClear > 0) st.heal(st.stats.healOnWaveClear * st.stats.maxHp)
    st.offerBuffs(pickBuffChoices()) // → phase 'buffSelect'
  }

  function spawnCrates(step: number): void {
    const local = localRef.current
    local.crateTimer -= step
    if (local.crateTimer > 0) return
    local.crateTimer = CRATE_INTERVAL
    if (world.pickups.length >= CRATE_MAX) return
    // rejection-sample a spot: inside the annulus, away from player + other crates
    for (let tries = 0; tries < 20; tries++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(THREE.MathUtils.lerp(CRATE_R_MIN * CRATE_R_MIN, CRATE_R_MAX * CRATE_R_MAX, Math.random()))
      _pos.set(Math.sin(a) * r, 0, Math.cos(a) * r)
      const dx = _pos.x - world.player.pos.x
      const dz = _pos.z - world.player.pos.z
      if (dx * dx + dz * dz < CRATE_PLAYER_DIST * CRATE_PLAYER_DIST) continue
      let crowded = false
      for (let i = 0; i < world.pickups.length; i++) {
        const q = world.pickups[i].pos
        const qx = _pos.x - q.x
        const qz = _pos.z - q.z
        if (qx * qx + qz * qz < CRATE_SPACING * CRATE_SPACING) {
          crowded = true
          break
        }
      }
      if (!crowded) break
    }
    pushOutOfObstacles(_pos, OBSTACLE_MARGIN)
    clampPolar(_pos, CRATE_R_MIN, CRATE_R_MAX)
    const p = world.addPickup(_pos)
    events.emit('cratePop', { pos: p.pos })
  }

  function collectPickups(): void {
    const pp = world.player.pos
    for (let i = world.pickups.length - 1; i >= 0; i--) {
      const p = world.pickups[i]
      const dx = p.pos.x - pp.x
      const dz = p.pos.z - pp.z
      if (dx * dx + dz * dz > CRATE_PICKUP_RADIUS * CRATE_PICKUP_RADIUS) continue
      const s = useGame.getState()
      s.set({
        ammoReserve: s.stats.reserveMax, // full reserve refill
        molotovs: Math.min(s.stats.molotovCapacity, s.molotovs + MOLOTOV_PER_CRATE),
      })
      events.emit('pickup', { pos: p.pos })
      world.pickups.splice(i, 1) // slot sync below hides the mesh
    }
  }

  function syncCrateVisuals(): void {
    const slots = slotsRef.current
    const pickups = world.pickups
    // free slots whose pickup vanished (collected, or world.reset())
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      if (slot.pickupId === -1) continue
      let found = false
      for (let j = 0; j < pickups.length; j++) {
        if (pickups[j].id === slot.pickupId) {
          found = true
          break
        }
      }
      if (!found) {
        slot.pickupId = -1
        slot.vis.root.visible = false
      }
    }
    // assign new pickups to free slots
    for (let j = 0; j < pickups.length; j++) {
      const p = pickups[j]
      let assigned = false
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].pickupId === p.id) {
          assigned = true
          break
        }
      }
      if (assigned) continue
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.pickupId !== -1) continue
        slot.pickupId = p.id
        slot.vis.root.visible = true
        slot.vis.root.position.copy(p.pos)
        break
      }
    }
    const t = localRef.current.visT
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].pickupId !== -1) animateCrate(slots[i].vis, t, i * 2.1)
    }
  }

  function frameBody(dt: number): void {
    const step = Math.min(dt, 0.05)
    localRef.current.visT += step

    // Phase-machine ownership runs every frame (it must act during buffSelect).
    flowControl()

    const s = useGame.getState()
    if (simRunning(s.phase)) {
      if (s.phase === 'wave') {
        dripFeed(step)
        safetyAndClear(step)
      }
      const phase = useGame.getState().phase // safetyAndClear may have advanced it
      if (phase === 'wave' || phase === 'boss') spawnCrates(step)
      collectPickups()
    }

    // pure visual idle animation — allowed to keep running outside sim phases
    syncCrateVisuals()
  }

  useFrame((_, dt) => frameBody(dt), FRAME_PRIO.director)

  return <group ref={groupRef} />
}
