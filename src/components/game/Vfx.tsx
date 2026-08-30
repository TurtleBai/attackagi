'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { ARENA_RADIUS, FRAME_PRIO } from '@/game/constants'
import { events, type EventMap } from '@/game/events'
import { useGame } from '@/game/store'
import { world } from '@/game/world'
import { BeamWalls, FirePatches } from './Vfx.hazards'
import {
  ChunkPool, FireballPool, FlashPool, LightPool, LinePool, PuffPool, RingPool, SparkPool,
} from './Vfx.pools'
import { beamFlashMaterial, dodgeMaterial, slashMaterial, tracerMaterial } from './Vfx.shaders'
import { Telegraphs } from './Vfx.telegraphs'

// ─────────────────────────────────────────────────────────────────────────────
// Vfx — every transient visual: telegraph decals, fire patches, beam walls,
// muzzle flashes, tracers, sparks, explosions, death bursts, pickup glints,
// camera-space swing/dodge overlays, and camera shake. Purely visual: reads
// world.telegraphs / world.hazards + the event bus, writes nothing gameplay.
// Everything pooled; hard reset on runId change.
// ─────────────────────────────────────────────────────────────────────────────

// module-scope scratch (never allocate in handlers/update)
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()

const TAU = Math.PI * 2

function buildSlashGeometry(): THREE.BufferGeometry {
  // curved ribbon band in camera-local space: x right, y up, -z forward
  const SEG = 28
  const pos = new Float32Array((SEG + 1) * 2 * 3)
  const uv = new Float32Array((SEG + 1) * 2 * 2)
  const idx: number[] = []
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG
    const ang = -1.25 + t * 2.5 // right → left sweep
    for (let j = 0; j < 2; j++) {
      const r = j === 0 ? 0.85 : 1.6
      const k = (i * 2 + j) * 3
      pos[k] = Math.sin(ang) * r
      pos[k + 1] = Math.cos(ang) * 0.22 * r - 0.34 + (j === 0 ? 0 : 0.1)
      pos[k + 2] = -1.15 - Math.cos(ang) * 0.3 * r
      uv[(i * 2 + j) * 2] = t
      uv[(i * 2 + j) * 2 + 1] = j
    }
    if (i < SEG) {
      const v = i * 2
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(idx)
  return geo
}

class VfxSystems {
  readonly group = new THREE.Group()

  private telegraphs: Telegraphs
  private fires: FirePatches
  private beams: BeamWalls
  private sparks: SparkPool
  private chunks: ChunkPool
  private puffs: PuffPool
  private rings: RingPool
  private fireballs: FireballPool
  private tracers: LinePool
  private beamFlashes: LinePool
  private flashes: FlashPool
  private lights: LightPool

  // camera-space overlays
  private slashMesh: THREE.Mesh
  private slashMat: THREE.ShaderMaterial
  private slashT = 2 // > 1.3 = idle
  private dodgeMesh: THREE.Mesh
  private dodgeMat: THREE.ShaderMaterial
  private dodgeLife = 0

  // camera shake
  private trauma = 0
  private lastShake = new THREE.Vector3()
  private lastCamAfter = new THREE.Vector3(Infinity, Infinity, Infinity)

  constructor() {
    const g = this.group
    this.telegraphs = new Telegraphs(g)
    this.fires = new FirePatches(g)
    this.beams = new BeamWalls(g)
    this.sparks = new SparkPool(g, 256)
    this.chunks = new ChunkPool(g, 96)
    this.puffs = new PuffPool(g, 64)
    this.rings = new RingPool(g, 8)
    this.fireballs = new FireballPool(g, 8)
    this.tracers = new LinePool(g, 10, tracerMaterial, 22)
    this.beamFlashes = new LinePool(g, 8, beamFlashMaterial, 23)
    this.flashes = new FlashPool(g, 5)
    this.lights = new LightPool(g, 3)

    this.slashMat = slashMaterial()
    this.slashMesh = new THREE.Mesh(buildSlashGeometry(), this.slashMat)
    this.slashMesh.visible = false
    this.slashMesh.frustumCulled = false
    this.slashMesh.renderOrder = 40
    g.add(this.slashMesh)

    this.dodgeMat = dodgeMaterial()
    this.dodgeMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.3), this.dodgeMat)
    this.dodgeMesh.visible = false
    this.dodgeMesh.frustumCulled = false
    this.dodgeMesh.renderOrder = 41
    g.add(this.dodgeMesh)
  }

  // ─── event handlers ────────────────────────────────────────────────────────

  onShot(p: EventMap['shot']): void {
    _a.copy(p.origin).addScaledVector(p.dir, 0.08)
    this.flashes.spawn(_a, 0.42 + Math.random() * 0.14, 2.7, 1.9, 0.9, 0.05)
    _a.copy(p.origin).addScaledVector(p.dir, 0.5)
    this.lights.spawn(_a, 0xffbe78, 14, 9, 0.07)
    const end = p.hitPoint ?? _b.copy(p.origin).addScaledVector(p.dir, 60)
    this.tracers.spawn(p.origin, end, 0.05, 2.6, 1.7, 0.9, 0.07)
    if (p.hitPoint) {
      for (let i = 0; i < 9; i++) {
        _c.set(
          -p.dir.x * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * 5,
          Math.random() * 4 + 0.5,
          -p.dir.z * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * 5)
        this.sparks.spawn(p.hitPoint.x, p.hitPoint.y, p.hitPoint.z, _c.x, _c.y, _c.z,
          2.6, 1.6, 0.6, 0.16 + Math.random() * 0.18, { gravity: 16, width: 0.02 })
      }
    }
  }

  onBatSwing(p: EventMap['batSwing']): void {
    this.slashT = -0.1
    const c = this.slashMat.uniforms.uColor.value as THREE.Color
    if (p.charged > 0.95) c.setRGB(3.0, 1.9, 0.6)
    else if (p.charged > 0.4) c.setRGB(2.0, 1.7, 1.4)
    else c.setRGB(1.4, 1.7, 2.4)
    this.slashMesh.visible = true
  }

  onBatHit(p: EventMap['batHit']): void {
    const k = 1 + p.charged * 1.5
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * TAU
      const sp = (2 + Math.random() * 5) * k
      this.sparks.spawn(p.pos.x, p.pos.y, p.pos.z,
        Math.cos(a) * sp, 1 + Math.random() * 4 * k, Math.sin(a) * sp,
        2.7, 1.8, 0.7, 0.2 + Math.random() * 0.2, { gravity: 14, width: 0.025 })
    }
    this.rings.spawn(p.pos.x, 0.06, p.pos.z, 1.1 + p.charged * 1.6, 0.3, 2.6, 1.4, 0.5, true, 0.3)
  }

  onShieldBlock(p: EventMap['shieldBlock']): void {
    this.flashes.spawn(p.pos, 0.55, 1.5, 2.0, 3.2, 0.09)
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU
      const sp = 2 + Math.random() * 4
      this.sparks.spawn(p.pos.x, p.pos.y, p.pos.z,
        Math.cos(a) * sp, 1.5 + Math.random() * 4, Math.sin(a) * sp,
        1.4, 1.9, 3.2, 0.18 + Math.random() * 0.15, { gravity: 12, width: 0.02 })
    }
  }

  onExplosion(p: EventMap['explosion']): void {
    const boss = p.kind === 'bossDeath'
    const R = Math.max(0.8, p.radius)
    const dur = boss ? 1.6 : 0.5
    if (boss) this.fireballs.spawn(p.pos.x, p.pos.y, p.pos.z, R, dur, 4.2, 3.8, 3.2, 2.2, 1.2, 0.7)
    else this.fireballs.spawn(p.pos.x, p.pos.y + R * 0.2, p.pos.z, R, dur, 3.4, 2.2, 0.9, 1.6, 0.4, 0.05)
    this.rings.spawn(p.pos.x, 0.06, p.pos.z, R * 1.9, boss ? 1.1 : 0.45,
      boss ? 3.0 : 2.5, boss ? 2.6 : 1.2, boss ? 2.0 : 0.5, true, 0.22)
    const nS = boss ? 26 : 13
    for (let i = 0; i < nS; i++) {
      const a = Math.random() * TAU
      const sp = (4 + Math.random() * 9) * (0.6 + R * 0.12)
      this.sparks.spawn(p.pos.x, p.pos.y + 0.3, p.pos.z,
        Math.cos(a) * sp, 3 + Math.random() * 9, Math.sin(a) * sp,
        2.8, 1.5, 0.5, 0.3 + Math.random() * 0.3, { gravity: 20, width: 0.03, stretch: 1.4 })
    }
    const nP = p.kind === 'punch' ? 8 : boss ? 10 : 5
    for (let i = 0; i < nP; i++) {
      const a = Math.random() * TAU
      const rr = Math.random() * R * 0.7
      this.puffs.spawn(p.pos.x + Math.cos(a) * rr, 0.4, p.pos.z + Math.sin(a) * rr,
        Math.cos(a) * 2.5, 1.2 + Math.random(), Math.sin(a) * 2.5,
        R * 0.35, R * 0.8, 0.32, 0.29, 0.26, 0.7 + Math.random() * 0.4)
    }
    _a.set(p.pos.x, p.pos.y + 1, p.pos.z)
    this.lights.spawn(_a, boss ? 0xfff2dd : 0xff9a4a, 30 + R * 10, R * 7, boss ? 1.2 : 0.4)
    const d = Math.max(4, _a.distanceTo(world.player.pos))
    this.trauma = Math.min(1, this.trauma + (boss ? 0.9 : Math.min(0.5, (R * 2.2) / d)))
  }

  onFireIgnite(p: EventMap['fireIgnite']): void {
    _a.copy(p.pos).setY(p.pos.y + 0.4)
    this.flashes.spawn(_a, p.radius * 0.5, 2.8, 1.5, 0.5, 0.12)
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * TAU
      const rr = Math.random() * p.radius * 0.6
      this.sparks.spawn(p.pos.x + Math.cos(a) * rr, 0.2, p.pos.z + Math.sin(a) * rr,
        Math.cos(a) * 1.5, 2.5 + Math.random() * 4, Math.sin(a) * 1.5,
        2.6, 1.1, 0.3, 0.35 + Math.random() * 0.3, { gravity: 4, width: 0.022, stretch: 0.6 })
    }
  }

  onEnemyHit(p: EventMap['enemyHit']): void {
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * TAU
      this.sparks.spawn(p.pos.x, p.pos.y + 1.0, p.pos.z,
        Math.cos(a) * 2.5, 1 + Math.random() * 2.5, Math.sin(a) * 2.5,
        2.5, 1.7, 0.7, 0.12 + Math.random() * 0.1, { gravity: 10, width: 0.018 })
    }
  }

  onEnemyDeath(p: EventMap['enemyDeath']): void {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU
      const sp = 2 + Math.random() * 4.5
      this.chunks.spawn(p.pos.x, p.pos.y + 0.8, p.pos.z,
        Math.cos(a) * sp, 2 + Math.random() * 5, Math.sin(a) * sp,
        0.05 + Math.random() * 0.08, 0.9 + Math.random() * 0.5)
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU
      const sp = 3 + Math.random() * 5
      this.sparks.spawn(p.pos.x, p.pos.y + 0.9, p.pos.z,
        Math.cos(a) * sp, 1 + Math.random() * 6, Math.sin(a) * sp,
        2.7, 1.6, 0.5, 0.2 + Math.random() * 0.25, { gravity: 16, width: 0.025 })
    }
    this.puffs.spawn(p.pos.x, p.pos.y + 0.7, p.pos.z, 0, 0.8, 0,
      0.5, 1.6, 0.12, 0.12, 0.13, 0.8)
  }

  onBossHit(p: EventMap['bossHit']): void {
    const at = p.pos ?? world.agi.headPos
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * TAU
      const sp = 2 + Math.random() * 5
      this.sparks.spawn(at.x, at.y, at.z,
        Math.cos(a) * sp, Math.random() * 5 - 1, Math.sin(a) * sp,
        2.8, 2.0, 0.9, 0.2 + Math.random() * 0.2, { gravity: 12, width: 0.035, stretch: 1.2 })
    }
  }

  onBeamFire(p: EventMap['beamFire']): void {
    if (p.kind === 'sniper') {
      this.beamFlashes.spawn(p.a, p.b, 0.35, 3.0, 1.5, 1.3, 0.22)
    } else if (p.kind === 'deathBeam') {
      this.beamFlashes.spawn(p.a, p.b, 5.5, 3.2, 1.0, 0.8, 0.5)
      this.trauma = Math.min(1, this.trauma + 0.25)
    } else {
      this.beamFlashes.spawn(p.a, p.b, 3.4, 2.6, 1.0, 0.35, 0.32)
    }
  }

  onPickup(p: EventMap['pickup']): void {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU
      const rr = 0.15 + Math.random() * 0.4
      this.sparks.spawn(p.pos.x + Math.cos(a) * rr, p.pos.y + 0.15 + Math.random() * 0.5, p.pos.z + Math.sin(a) * rr,
        0, 1.4 + Math.random() * 1.6, 0,
        2.5, 2.1, 0.9, 0.4 + Math.random() * 0.3, { gravity: 0, width: 0.022, stretch: 0.5, drag: 0.2 })
    }
  }

  onCratePop(p: EventMap['cratePop']): void {
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * TAU
      this.puffs.spawn(p.pos.x + Math.cos(a) * 0.4, 0.4, p.pos.z + Math.sin(a) * 0.4,
        Math.cos(a) * 1.5, 0.8 + Math.random(), Math.sin(a) * 1.5,
        0.4, 1.2, 0.42, 0.37, 0.3, 0.55 + Math.random() * 0.3)
    }
  }

  onPlayerDodge(): void {
    this.dodgeLife = 1
    this.dodgeMesh.visible = true
  }

  onSmashImpact(): void {
    this.rings.spawn(0, 0.07, 0, ARENA_RADIUS, 1.4, 0.5, 0.45, 0.38, false, 0.09)
    this.rings.spawn(0, 0.08, 0, ARENA_RADIUS * 0.75, 0.7, 2.6, 0.8, 0.35, true, 0.12)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU
      const rr = 5 + Math.random() * 22
      this.puffs.spawn(Math.cos(a) * rr, 0.5, Math.sin(a) * rr,
        Math.cos(a) * 4, 1.5 + Math.random() * 1.5, Math.sin(a) * 4,
        1.4, 2.6, 0.38, 0.34, 0.29, 0.9 + Math.random() * 0.5)
    }
    this.trauma = 1
  }

  // ─── frame ─────────────────────────────────────────────────────────────────

  update(step: number, camera: THREE.Camera, pxScale: number): void {
    const time = world.time
    this.telegraphs.update(time)
    this.fires.update(time, pxScale)
    this.beams.update(time, step)
    this.sparks.update(step, camera.position)
    this.chunks.update(step)
    this.puffs.update(step)
    this.rings.update(step)
    this.fireballs.update(step)
    this.tracers.update(step, camera.position)
    this.beamFlashes.update(step, camera.position)
    this.flashes.update(step, camera)
    this.lights.update(step)

    // slash overlay (camera-attached)
    if (this.slashT <= 1.3) {
      this.slashT += step / 0.24
      if (this.slashT > 1.3) this.slashMesh.visible = false
      else {
        this.slashMat.uniforms.uT.value = this.slashT
        this.slashMesh.position.copy(camera.position)
        this.slashMesh.quaternion.copy(camera.quaternion)
      }
    }

    // dodge overlay
    if (this.dodgeLife > 0) {
      this.dodgeLife = Math.max(0, this.dodgeLife - step / 0.35)
      if (this.dodgeLife <= 0) this.dodgeMesh.visible = false
      else {
        this.dodgeMat.uniforms.uLife.value = this.dodgeLife
        this.dodgeMat.uniforms.uTime.value = time
        this.dodgeMesh.quaternion.copy(camera.quaternion)
        this.dodgeMesh.position.copy(camera.position)
          .addScaledVector(_a.set(0, 0, -1).applyQuaternion(camera.quaternion), 0.9)
      }
    }

    // camera shake — runs after the Player wrote the camera this frame. If the
    // camera was NOT rewritten since our last pass (exact float match), undo the
    // previous offset first so shake never accumulates.
    if (camera.position.equals(this.lastCamAfter)) camera.position.sub(this.lastShake)
    this.trauma = Math.max(0, this.trauma - step * 1.7)
    if (this.trauma > 0.001) {
      const amp = this.trauma * this.trauma * 0.4
      this.lastShake.set(
        (Math.random() * 2 - 1) * amp,
        (Math.random() * 2 - 1) * amp * 0.6,
        (Math.random() * 2 - 1) * amp)
      camera.position.add(this.lastShake)
    } else {
      this.lastShake.set(0, 0, 0)
    }
    this.lastCamAfter.copy(camera.position)
  }

  reset(): void {
    this.telegraphs.clear()
    this.fires.clear()
    this.beams.clear()
    this.sparks.clear()
    this.chunks.clear()
    this.puffs.clear()
    this.rings.clear()
    this.fireballs.clear()
    this.tracers.clear()
    this.beamFlashes.clear()
    this.flashes.clear()
    this.lights.clear()
    this.slashT = 2
    this.slashMesh.visible = false
    this.dodgeLife = 0
    this.dodgeMesh.visible = false
    this.trauma = 0
    this.lastShake.set(0, 0, 0)
    this.lastCamAfter.set(Infinity, Infinity, Infinity)
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        o.geometry.dispose()
        const m = o.material as THREE.Material | THREE.Material[]
        if (Array.isArray(m)) for (const mm of m) mm.dispose()
        else m.dispose()
      }
    })
  }
}

export function Vfx() {
  const sys = useMemo(() => new VfxSystems(), [])
  const runId = useGame((s) => s.runId)

  useEffect(() => () => sys.dispose(), [sys])

  useEffect(() => {
    sys.reset()
  }, [sys, runId])

  useEffect(() => {
    const subs = [
      events.on('shot', (p) => sys.onShot(p)),
      events.on('batSwing', (p) => sys.onBatSwing(p)),
      events.on('batHit', (p) => sys.onBatHit(p)),
      events.on('shieldBlock', (p) => sys.onShieldBlock(p)),
      events.on('explosion', (p) => sys.onExplosion(p)),
      events.on('fireIgnite', (p) => sys.onFireIgnite(p)),
      events.on('enemyHit', (p) => sys.onEnemyHit(p)),
      events.on('enemyDeath', (p) => sys.onEnemyDeath(p)),
      events.on('bossHit', (p) => sys.onBossHit(p)),
      events.on('beamFire', (p) => sys.onBeamFire(p)),
      events.on('pickup', (p) => sys.onPickup(p)),
      events.on('cratePop', (p) => sys.onCratePop(p)),
      events.on('playerDodge', () => sys.onPlayerDodge()),
      events.on('smashImpact', () => sys.onSmashImpact()),
    ]
    return () => { for (const off of subs) off() }
  }, [sys])

  const warmed = useRef(false)
  useFrame((state, dt) => {
    if (!warmed.current) {
      // one-time shader warm-up: compiles every pooled (even invisible) material
      // so the first explosion/telegraph never hitches mid-combat
      warmed.current = true
      state.gl.compile(state.scene, state.camera)
    }
    const step = Math.min(dt, 0.05)
    const pxScale = (state.size.height * state.gl.getPixelRatio()) / 900
    sys.update(step, state.camera, pxScale)
  }, FRAME_PRIO.vfx)

  return <primitive object={sys.group} />
}
