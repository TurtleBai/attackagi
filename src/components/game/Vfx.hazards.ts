'use client'
import * as THREE from 'three'
import { tierKnobs } from '@/game/quality'
import { world } from '@/game/world'
import {
  beamWallMaterial, emberMaterial, fireGlowMaterial, flameMaterial, scorchMaterial, smokeMaterial,
} from './Vfx.shaders'

// ─────────────────────────────────────────────────────────────────────────────
// Vfx.hazards — renders world.hazards:
//  · 'fire'  → layered patch: ground glow disc, instanced fluttering flame
//              quads, sparse smoke wisps, rising ember points, and up to
//              tierKnobs().fireLights flickering point lights parked on the
//              biggest fires.
//  · 'beam'  → vertical energy wall a→b (hot core + scrolling noise) plus a
//              ground scorch line that fades after the beam ends.
// All pools are fixed-size; unused instances collapse to degenerate triangles
// in the vertex shader, so idle cost is ~zero.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FIRES = 10
const FLAMES_PER = 8 // was 10 — modest additive-overdraw cut, look preserved
const SMOKE_PER = 3
const EMBERS_PER = 7
const FIRE_TAIL = 0.9 // seconds the visuals keep fading after `until`

const MAX_BEAMS = 10
const MAX_SCORCH = 12
const SCORCH_FADE = 3.0

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const Y_AXIS = new THREE.Vector3(0, 1, 0)
const QX90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)

// ─── Fire patches ────────────────────────────────────────────────────────────

interface FireSlot {
  id: number // hazard id, -1 = free
  until: number
  birth: number
  radius: number
  x: number
  z: number
}

export class FirePatches {
  private slots: FireSlot[] = []
  private glowMeshes: THREE.Mesh[] = []
  private glowMats: THREE.ShaderMaterial[] = []
  private flames: THREE.InstancedMesh
  private flameMat: THREE.ShaderMaterial
  private flameSeed: THREE.InstancedBufferAttribute
  private flameSpan: THREE.InstancedBufferAttribute
  private smoke: THREE.InstancedMesh
  private smokeMat: THREE.ShaderMaterial
  private smokeData: THREE.InstancedBufferAttribute
  private embers: THREE.Points
  private emberMat: THREE.ShaderMaterial
  private emberCenter: THREE.BufferAttribute
  private emberData: THREE.BufferAttribute
  private lights: THREE.PointLight[] = []
  private lightPick: Int32Array
  // STRUCTURAL tier knobs, read once at mount: potato (vfxDensity < 1) halves
  // the flame quads per fire and skips smoke wisps entirely; light count comes
  // from tierKnobs().fireLights. Glow discs + embers stay on every tier so
  // burning ground hazards remain readable.
  private flamesPer: number
  private smokePer: number
  private fireLights: number

  constructor(parent: THREE.Object3D) {
    const knobs = tierKnobs()
    const potato = knobs.vfxDensity < 1
    this.flamesPer = potato ? FLAMES_PER >> 1 : FLAMES_PER
    this.smokePer = potato ? 0 : SMOKE_PER
    this.fireLights = knobs.fireLights
    this.lightPick = new Int32Array(this.fireLights)
    for (let i = 0; i < MAX_FIRES; i++) {
      this.slots.push({ id: -1, until: -100, birth: -100, radius: 1, x: 0, z: 0 })
      const m = fireGlowMaterial()
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m)
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 11
      parent.add(mesh)
      this.glowMeshes.push(mesh)
      this.glowMats.push(m)
    }

    // flames
    {
      const n = MAX_FIRES * this.flamesPer
      const geo = new THREE.PlaneGeometry(1, 1)
      this.flameSeed = new THREE.InstancedBufferAttribute(new Float32Array(n), 1)
      this.flameSpan = new THREE.InstancedBufferAttribute(new Float32Array(n * 2).fill(-10), 2)
      this.flameSeed.setUsage(THREE.DynamicDrawUsage)
      this.flameSpan.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aSeed', this.flameSeed)
      geo.setAttribute('aSpan', this.flameSpan)
      this.flameMat = flameMaterial()
      this.flames = new THREE.InstancedMesh(geo, this.flameMat, n)
      this.flames.count = 0 // raised in update() to cover live slots only
      this.flames.frustumCulled = false
      this.flames.renderOrder = 16
      parent.add(this.flames)
    }
    // smoke
    {
      const n = MAX_FIRES * this.smokePer
      const geo = new THREE.PlaneGeometry(1, 1)
      this.smokeData = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(-10), 3)
      this.smokeData.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aData', this.smokeData)
      this.smokeMat = smokeMaterial()
      this.smoke = new THREE.InstancedMesh(geo, this.smokeMat, n)
      this.smoke.count = 0 // raised in update() to cover live slots only
      this.smoke.frustumCulled = false
      this.smoke.renderOrder = 17
      if (this.smokePer === 0) this.smoke.visible = false // potato: no wisps
      parent.add(this.smoke)
    }
    // embers
    {
      const n = MAX_FIRES * EMBERS_PER
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
      this.emberCenter = new THREE.BufferAttribute(new Float32Array(n * 3), 3)
      this.emberData = new THREE.BufferAttribute(new Float32Array(n * 4).fill(-10), 4)
      this.emberCenter.setUsage(THREE.DynamicDrawUsage)
      this.emberData.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aCenter', this.emberCenter)
      geo.setAttribute('aData', this.emberData)
      this.emberMat = emberMaterial()
      this.embers = new THREE.Points(geo, this.emberMat)
      this.embers.geometry.setDrawRange(0, 0) // widened in update() for live slots
      this.embers.frustumCulled = false
      this.embers.renderOrder = 19
      parent.add(this.embers)
    }
    for (let i = 0; i < this.fireLights; i++) {
      const l = new THREE.PointLight(0xff7a2a, 0, 12, 2)
      l.castShadow = false
      parent.add(l)
      this.lights.push(l)
    }
  }

  private assignSlot(hz: { id: number; pos?: THREE.Vector3; radius?: number; until: number }, time: number): void {
    // free slot, else steal the earliest-expiring one
    let slot: FireSlot | null = null
    for (const s of this.slots) {
      if (s.id === -1 && time > s.until + FIRE_TAIL) { slot = s; break }
    }
    if (!slot) {
      // steal the earliest-expiring slot, but only for a longer-lived fire —
      // prevents reassignment thrash when >MAX_FIRES hazards are live
      let best = this.slots[0]
      for (const s of this.slots) if (s.until < best.until) best = s
      if (best.until >= hz.until) return
      slot = best
    }
    const idx = this.slots.indexOf(slot)
    slot.id = hz.id
    slot.birth = time
    slot.until = hz.until
    slot.radius = hz.radius ?? 2
    slot.x = hz.pos?.x ?? 0
    slot.z = hz.pos?.z ?? 0
    this.writeSlotInstances(idx, time)
  }

  private writeSlotInstances(idx: number, time: number): void {
    const s = this.slots[idx]
    const sizeK = Math.min(1.5, Math.max(0.7, s.radius / 4.5))
    const flameSpan = this.flameSpan.array as Float32Array
    const flameSeed = this.flameSeed.array as Float32Array
    for (let k = 0; k < this.flamesPer; k++) {
      const i = idx * this.flamesPer + k
      const a = Math.random() * Math.PI * 2
      const r = s.radius * 0.78 * Math.sqrt(Math.random())
      const sc = (0.5 + Math.random() * 0.6) * sizeK
      _m.makeScale(sc, sc, sc)
      _m.setPosition(s.x + Math.cos(a) * r, 0, s.z + Math.sin(a) * r)
      this.flames.setMatrixAt(i, _m)
      flameSeed[i] = Math.random() * 100
      flameSpan[i * 2] = time + Math.random() * 0.3
      flameSpan[i * 2 + 1] = s.until + Math.random() * 0.4
    }
    this.flames.instanceMatrix.needsUpdate = true
    this.flameSeed.needsUpdate = true
    this.flameSpan.needsUpdate = true

    const smokeData = this.smokeData.array as Float32Array
    for (let k = 0; k < this.smokePer; k++) {
      const i = idx * this.smokePer + k
      const a = Math.random() * Math.PI * 2
      const r = s.radius * 0.5 * Math.sqrt(Math.random())
      const sc = (0.9 + Math.random() * 0.8) * sizeK
      _m.makeScale(sc, sc, sc)
      _m.setPosition(s.x + Math.cos(a) * r, 0.4, s.z + Math.sin(a) * r)
      this.smoke.setMatrixAt(i, _m)
      smokeData[i * 3] = Math.random() * 90
      smokeData[i * 3 + 1] = time + Math.random() * 0.5
      smokeData[i * 3 + 2] = s.until + 0.6
    }
    if (this.smokePer > 0) {
      this.smoke.instanceMatrix.needsUpdate = true
      this.smokeData.needsUpdate = true
    }

    const ec = this.emberCenter.array as Float32Array
    const ed = this.emberData.array as Float32Array
    for (let k = 0; k < EMBERS_PER; k++) {
      const i = idx * EMBERS_PER + k
      ec[i * 3] = s.x; ec[i * 3 + 1] = 0; ec[i * 3 + 2] = s.z
      ed[i * 4] = s.radius
      ed[i * 4 + 1] = time + Math.random() * 0.4
      ed[i * 4 + 2] = s.until
      ed[i * 4 + 3] = Math.random() * 100
    }
    this.emberCenter.needsUpdate = true
    this.emberData.needsUpdate = true
  }

  /** Cut a slot's lifetime short (hazard vanished early) — restamps fade-outs. */
  private expireSlot(idx: number, time: number): void {
    const s = this.slots[idx]
    s.until = time
    const flameSpan = this.flameSpan.array as Float32Array
    for (let k = 0; k < this.flamesPer; k++) {
      const i = idx * this.flamesPer + k
      flameSpan[i * 2 + 1] = Math.min(flameSpan[i * 2 + 1], time + 0.3)
    }
    this.flameSpan.needsUpdate = true
    const smokeData = this.smokeData.array as Float32Array
    for (let k = 0; k < this.smokePer; k++) {
      const i = idx * this.smokePer + k
      smokeData[i * 3 + 2] = Math.min(smokeData[i * 3 + 2], time + 0.4)
    }
    if (this.smokePer > 0) this.smokeData.needsUpdate = true
    const ed = this.emberData.array as Float32Array
    for (let k = 0; k < EMBERS_PER; k++) {
      const i = idx * EMBERS_PER + k
      ed[i * 4 + 2] = Math.min(ed[i * 4 + 2], time + 0.3)
    }
    this.emberData.needsUpdate = true
  }

  update(time: number, px: number): void {
    // sync assignments with world.hazards
    for (const hz of world.hazards) {
      if (hz.kind !== 'fire') continue
      let found = false
      for (const s of this.slots) {
        if (s.id === hz.id) { found = true; s.until = hz.until; break }
      }
      if (!found) this.assignSlot(hz, time)
    }
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      if (s.id === -1) continue
      let present = false
      for (const hz of world.hazards) if (hz.id === s.id) { present = true; break }
      if (!present && time < s.until) this.expireSlot(i, time)
      if (time > s.until + FIRE_TAIL) s.id = -1
    }

    // draw only instances up to the highest live slot (in-shader collapse still
    // hides dead slots inside the range) — with no fires burning, all three
    // draw calls are skipped outright
    let nLive = 0
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].id !== -1) nLive = i + 1
    this.flames.count = nLive * this.flamesPer
    this.smoke.count = nLive * this.smokePer
    this.embers.geometry.setDrawRange(0, nLive * EMBERS_PER)

    this.flameMat.uniforms.uTime.value = time
    this.smokeMat.uniforms.uTime.value = time
    this.emberMat.uniforms.uTime.value = time
    this.emberMat.uniforms.uPx.value = px

    // glow discs
    for (let i = 0; i < MAX_FIRES; i++) {
      const s = this.slots[i]
      const mesh = this.glowMeshes[i]
      const fadeIn = Math.min(1, (time - s.birth) / 0.3)
      const fadeOut = Math.min(1, Math.max(0, (s.until + 0.5 - time) / 0.8))
      const fade = s.id !== -1 ? Math.max(0, fadeIn * fadeOut) : 0
      if (fade <= 0.005) { mesh.visible = false; continue }
      mesh.visible = true
      mesh.position.set(s.x, 0.05, s.z)
      // quad cropped from radius*2.3 to *2.0 (−24% fill); the shader rescales
      // its coords so the visible glow footprint is unchanged
      mesh.scale.setScalar(s.radius * 2.0)
      const u = this.glowMats[i].uniforms
      u.uTime.value = time
      u.uFade.value = fade
      u.uSeed.value = i * 7.31
    }

    // park lights on the biggest live fires
    const nLights = this.fireLights
    for (let k = 0; k < nLights; k++) this.lightPick[k] = -1
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      if (s.id === -1 || time > s.until + 0.4) continue
      for (let k = 0; k < nLights; k++) {
        const cur = this.lightPick[k]
        if (cur === -1 || this.slots[cur].radius < s.radius) {
          for (let m = nLights - 1; m > k; m--) this.lightPick[m] = this.lightPick[m - 1]
          this.lightPick[k] = i
          break
        }
      }
    }
    for (let k = 0; k < nLights; k++) {
      const light = this.lights[k]
      const pick = this.lightPick[k]
      if (pick === -1) { light.intensity = 0; continue }
      const s = this.slots[pick]
      const fade = Math.min(1, (time - s.birth) / 0.3) * Math.min(1, Math.max(0, (s.until + 0.3 - time) / 0.6))
      const flick = 0.78 + 0.22 * Math.sin(time * 11 + pick * 5.1) * Math.sin(time * 27 + pick * 9.3)
      light.position.set(s.x, 1.5, s.z)
      light.distance = s.radius * 6
      light.intensity = (14 + s.radius * 4) * flick * Math.max(0, fade)
    }
  }

  clear(): void {
    for (const s of this.slots) { s.id = -1; s.until = -100; s.birth = -100 }
    this.flames.count = 0
    this.smoke.count = 0
    this.embers.geometry.setDrawRange(0, 0)
    ;(this.flameSpan.array as Float32Array).fill(-10)
    this.flameSpan.needsUpdate = true
    ;(this.smokeData.array as Float32Array).fill(-10)
    this.smokeData.needsUpdate = true
    ;(this.emberData.array as Float32Array).fill(-10)
    this.emberData.needsUpdate = true
    for (const m of this.glowMeshes) m.visible = false
    for (const l of this.lights) l.intensity = 0
  }
}

// ─── Beam walls + scorch lines ───────────────────────────────────────────────

interface BeamSlot {
  id: number
  mesh: THREE.Mesh
  m: THREE.ShaderMaterial
  ax: number; az: number; bx: number; bz: number
  width: number
  until: number
}

interface ScorchSlot {
  mesh: THREE.Mesh
  m: THREE.ShaderMaterial
  ttl: number
}

export class BeamWalls {
  private beams: BeamSlot[] = []
  private scorch: ScorchSlot[] = []

  constructor(parent: THREE.Object3D) {
    const quad = new THREE.PlaneGeometry(1, 1)
    // both pools stay frustum-culled: slots carry real position/rotation/scale
    // on the shared unit quad (fills are fragment-side, no vertex displacement),
    // so offscreen walls/scorch skip draw + vertex work entirely
    for (let i = 0; i < MAX_BEAMS; i++) {
      const m = beamWallMaterial()
      const mesh = new THREE.Mesh(quad, m)
      mesh.visible = false
      mesh.renderOrder = 14
      parent.add(mesh)
      this.beams.push({ id: -1, mesh, m, ax: 0, az: 0, bx: 0, bz: 0, width: 1, until: 0 })
    }
    for (let i = 0; i < MAX_SCORCH; i++) {
      const m = scorchMaterial()
      const mesh = new THREE.Mesh(quad, m)
      mesh.visible = false
      mesh.renderOrder = 9
      parent.add(mesh)
      this.scorch.push({ mesh, m, ttl: 0 })
    }
  }

  private spawnScorch(b: BeamSlot): void {
    let best = this.scorch[0]
    for (const s of this.scorch) { if (s.ttl <= 0) { best = s; break } if (s.ttl < best.ttl) best = s }
    const dx = b.bx - b.ax, dz = b.bz - b.az
    const len = Math.sqrt(dx * dx + dz * dz)
    if (len < 0.2) return
    best.ttl = SCORCH_FADE
    best.mesh.visible = true
    best.mesh.position.set((b.ax + b.bx) / 2, 0.03, (b.az + b.bz) / 2)
    _q.setFromAxisAngle(Y_AXIS, Math.atan2(dx, dz)).multiply(QX90)
    best.mesh.quaternion.copy(_q)
    best.mesh.scale.set(Math.max(0.3, b.width * 1.25), len, 1)
    best.m.uniforms.uSeed.value = Math.random() * 30
  }

  update(time: number, dt: number): void {
    for (const hz of world.hazards) {
      if (hz.kind !== 'beam' || !hz.a || !hz.b) continue
      let slot: BeamSlot | null = null
      for (const b of this.beams) if (b.id === hz.id) { slot = b; break }
      if (!slot) {
        for (const b of this.beams) if (b.id === -1) { slot = b; break }
        if (!slot) continue
        slot.id = hz.id
        slot.mesh.visible = true
        slot.m.uniforms.uSeed.value = (hz.id % 17) * 3.7
        const c = slot.m.uniforms.uColor.value as THREE.Color
        if (hz.instakill) c.setRGB(2.6, 0.35, 0.28) // death beam: hotter red
        else c.setRGB(2.0, 0.42, 0.14)
      }
      // sync geometry every frame — beams can sweep
      slot.ax = hz.a.x; slot.az = hz.a.z
      slot.bx = hz.b.x; slot.bz = hz.b.z
      slot.width = hz.width ?? 1
      slot.until = hz.until
      const dx = slot.bx - slot.ax, dz = slot.bz - slot.az
      const len = Math.max(0.05, Math.sqrt(dx * dx + dz * dz))
      const height = hz.height ?? 8
      slot.mesh.position.set((slot.ax + slot.bx) / 2, height / 2, (slot.az + slot.bz) / 2)
      slot.mesh.rotation.set(0, Math.atan2(-dz, dx), 0)
      slot.mesh.scale.set(len, height, 1)
      const u = slot.m.uniforms
      u.uTime.value = time
      u.uLen.value = len
      u.uFade.value = Math.min(1, Math.max(0, (hz.until - time) / 0.25))
    }
    // free beams whose hazards are gone → scorch line
    for (const b of this.beams) {
      if (b.id === -1) continue
      let present = false
      for (const hz of world.hazards) if (hz.id === b.id) { present = true; break }
      if (!present || time >= b.until) {
        b.id = -1
        b.mesh.visible = false
        this.spawnScorch(b)
      }
    }
    for (const s of this.scorch) {
      if (s.ttl <= 0) continue
      s.ttl -= dt
      if (s.ttl <= 0) { s.mesh.visible = false; continue }
      const t = s.ttl / SCORCH_FADE
      s.m.uniforms.uFade.value = Math.min(1, t * 1.6)
    }
  }

  clear(): void {
    for (const b of this.beams) { b.id = -1; b.mesh.visible = false }
    for (const s of this.scorch) { s.ttl = 0; s.mesh.visible = false }
  }
}
