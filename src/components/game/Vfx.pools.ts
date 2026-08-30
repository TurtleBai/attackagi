'use client'
import * as THREE from 'three'
import {
  fireballMaterial, flashMaterial, puffMaterial, ringMaterial, sparkMaterial,
} from './Vfx.shaders'

// ─────────────────────────────────────────────────────────────────────────────
// Vfx.pools — fixed-size particle/effect pools. Zero per-frame allocation:
// typed-array particle state, module-scope scratch objects, swap-remove
// compaction so InstancedMesh.count === live particles.
// ─────────────────────────────────────────────────────────────────────────────

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const Q_IDENT = new THREE.Quaternion()

function instancedQuad(max: number): { geo: THREE.PlaneGeometry; life: THREE.InstancedBufferAttribute; col: THREE.InstancedBufferAttribute } {
  const geo = new THREE.PlaneGeometry(1, 1)
  const life = new THREE.InstancedBufferAttribute(new Float32Array(max), 1)
  life.setUsage(THREE.DynamicDrawUsage)
  const col = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3)
  col.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aLife', life)
  geo.setAttribute('aColor', col)
  return { geo, life, col }
}

export interface SparkOpts {
  gravity?: number
  width?: number
  stretch?: number
  drag?: number
}

/** Additive velocity-stretched streaks: impact sparks, debris streaks, glints. */
export class SparkPool {
  readonly mesh: THREE.InstancedMesh
  private max: number
  private n = 0
  private cursor = 0
  private p: Float32Array
  private v: Float32Array
  private ttl: Float32Array
  private dur: Float32Array
  private grav: Float32Array
  private wid: Float32Array
  private str: Float32Array
  private drag: Float32Array
  private lifeAttr: THREE.InstancedBufferAttribute
  private colAttr: THREE.InstancedBufferAttribute

  constructor(parent: THREE.Object3D, max = 256) {
    this.max = max
    const { geo, life, col } = instancedQuad(max)
    this.lifeAttr = life
    this.colAttr = col
    this.mesh = new THREE.InstancedMesh(geo, sparkMaterial(), max)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 20
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    parent.add(this.mesh)
    this.p = new Float32Array(max * 3)
    this.v = new Float32Array(max * 3)
    this.ttl = new Float32Array(max)
    this.dur = new Float32Array(max)
    this.grav = new Float32Array(max)
    this.wid = new Float32Array(max)
    this.str = new Float32Array(max)
    this.drag = new Float32Array(max)
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number,
    r: number, g: number, b: number, ttl: number, o?: SparkOpts): void {
    let i: number
    if (this.n < this.max) i = this.n++
    else { i = this.cursor; this.cursor = (this.cursor + 1) % this.max }
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz
    this.ttl[i] = ttl; this.dur[i] = ttl
    this.grav[i] = o?.gravity ?? 12
    this.wid[i] = o?.width ?? 0.025
    this.str[i] = o?.stretch ?? 1
    this.drag[i] = o?.drag ?? 1.2
    const c = this.colAttr.array as Float32Array
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b
    this.colAttr.needsUpdate = true
  }

  private removeAt(i: number): void {
    const l = --this.n
    if (i !== l) {
      for (let k = 0; k < 3; k++) {
        this.p[i * 3 + k] = this.p[l * 3 + k]
        this.v[i * 3 + k] = this.v[l * 3 + k]
      }
      this.ttl[i] = this.ttl[l]; this.dur[i] = this.dur[l]
      this.grav[i] = this.grav[l]; this.wid[i] = this.wid[l]
      this.str[i] = this.str[l]; this.drag[i] = this.drag[l]
      const c = this.colAttr.array as Float32Array
      c[i * 3] = c[l * 3]; c[i * 3 + 1] = c[l * 3 + 1]; c[i * 3 + 2] = c[l * 3 + 2]
      this.colAttr.needsUpdate = true
    }
    this.cursor = 0
  }

  update(dt: number, camPos: THREE.Vector3): void {
    const life = this.lifeAttr.array as Float32Array
    let i = 0
    while (i < this.n) {
      this.ttl[i] -= dt
      if (this.ttl[i] <= 0) { this.removeAt(i); continue }
      const damp = Math.exp(-this.drag[i] * dt)
      this.v[i * 3] *= damp
      this.v[i * 3 + 1] = this.v[i * 3 + 1] * damp - this.grav[i] * dt
      this.v[i * 3 + 2] *= damp
      const px = this.p[i * 3] += this.v[i * 3] * dt
      const py = this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt
      const pz = this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt
      _y.set(this.v[i * 3], this.v[i * 3 + 1], this.v[i * 3 + 2])
      const sp = _y.length()
      if (sp < 1e-4) _y.set(0, 1, 0)
      else _y.divideScalar(sp)
      _v.set(px - camPos.x, py - camPos.y, pz - camPos.z).normalize()
      _x.crossVectors(_y, _v)
      if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0)
      else _x.normalize()
      _z.crossVectors(_x, _y)
      const len = Math.min(this.str[i] * (0.07 + sp * 0.035), 1.4)
      const w = this.wid[i]
      _m.makeBasis(_x.multiplyScalar(w), _y.multiplyScalar(len), _z.multiplyScalar(w))
      _m.setPosition(px, py, pz)
      this.mesh.setMatrixAt(i, _m)
      life[i] = Math.min(1, (this.ttl[i] / this.dur[i]) * 1.6)
      i++
    }
    this.mesh.count = this.n
    if (this.n > 0) { // idle pool: no draw, no re-upload
      this.mesh.instanceMatrix.needsUpdate = true
      this.lifeAttr.needsUpdate = true
    }
  }

  clear(): void { this.n = 0; this.cursor = 0; this.mesh.count = 0 }
}

/** Lit spinning metal debris chunks with gravity + one ground bounce. */
export class ChunkPool {
  readonly mesh: THREE.InstancedMesh
  private max: number
  private n = 0
  private cursor = 0
  private p: Float32Array
  private v: Float32Array
  private rot: Float32Array
  private w: Float32Array
  private ttl: Float32Array
  private dur: Float32Array
  private size: Float32Array
  private bounced: Uint8Array

  constructor(parent: THREE.Object3D, max = 96) {
    this.max = max
    const geo = new THREE.IcosahedronGeometry(0.09, 0)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x59606b, metalness: 0.75, roughness: 0.45, flatShading: true,
    })
    this.mesh = new THREE.InstancedMesh(geo, mat, max)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    parent.add(this.mesh)
    this.p = new Float32Array(max * 3)
    this.v = new Float32Array(max * 3)
    this.rot = new Float32Array(max * 3)
    this.w = new Float32Array(max * 3)
    this.ttl = new Float32Array(max)
    this.dur = new Float32Array(max)
    this.size = new Float32Array(max)
    this.bounced = new Uint8Array(max)
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, ttl: number): void {
    let i: number
    if (this.n < this.max) i = this.n++
    else { i = this.cursor; this.cursor = (this.cursor + 1) % this.max }
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz
    this.rot[i * 3] = Math.random() * 6.28; this.rot[i * 3 + 1] = Math.random() * 6.28; this.rot[i * 3 + 2] = 0
    this.w[i * 3] = (Math.random() - 0.5) * 14; this.w[i * 3 + 1] = (Math.random() - 0.5) * 14; this.w[i * 3 + 2] = (Math.random() - 0.5) * 10
    this.ttl[i] = ttl; this.dur[i] = ttl
    this.size[i] = size
    this.bounced[i] = 0
  }

  private removeAt(i: number): void {
    const l = --this.n
    if (i !== l) {
      for (let k = 0; k < 3; k++) {
        this.p[i * 3 + k] = this.p[l * 3 + k]
        this.v[i * 3 + k] = this.v[l * 3 + k]
        this.rot[i * 3 + k] = this.rot[l * 3 + k]
        this.w[i * 3 + k] = this.w[l * 3 + k]
      }
      this.ttl[i] = this.ttl[l]; this.dur[i] = this.dur[l]
      this.size[i] = this.size[l]; this.bounced[i] = this.bounced[l]
    }
    this.cursor = 0
  }

  update(dt: number): void {
    let i = 0
    while (i < this.n) {
      this.ttl[i] -= dt
      if (this.ttl[i] <= 0) { this.removeAt(i); continue }
      this.v[i * 3 + 1] -= 22 * dt
      this.p[i * 3] += this.v[i * 3] * dt
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt
      const s = this.size[i]
      if (this.p[i * 3 + 1] < s * 0.5 && this.v[i * 3 + 1] < 0) {
        this.p[i * 3 + 1] = s * 0.5
        if (this.bounced[i] === 0) {
          this.bounced[i] = 1
          this.v[i * 3 + 1] *= -0.35
          this.v[i * 3] *= 0.55; this.v[i * 3 + 2] *= 0.55
          this.w[i * 3] *= 0.5; this.w[i * 3 + 1] *= 0.5
        } else {
          this.v[i * 3] = 0; this.v[i * 3 + 1] = 0; this.v[i * 3 + 2] = 0
          this.w[i * 3] = 0; this.w[i * 3 + 1] = 0; this.w[i * 3 + 2] = 0
        }
      }
      this.rot[i * 3] += this.w[i * 3] * dt
      this.rot[i * 3 + 1] += this.w[i * 3 + 1] * dt
      this.rot[i * 3 + 2] += this.w[i * 3 + 2] * dt
      const shrink = Math.min(1, (this.ttl[i] / this.dur[i]) * 3)
      _e.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2])
      _q.setFromEuler(_e)
      _s.setScalar(s * shrink * (1 / 0.09))
      _v.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2])
      _m.compose(_v, _q, _s)
      this.mesh.setMatrixAt(i, _m)
      i++
    }
    this.mesh.count = this.n
    if (this.n > 0) this.mesh.instanceMatrix.needsUpdate = true // idle: skip upload
  }

  clear(): void { this.n = 0; this.cursor = 0; this.mesh.count = 0 }
}

/** Soft dust/smoke puffs (billboarded in shader). */
export class PuffPool {
  readonly mesh: THREE.InstancedMesh
  private max: number
  private n = 0
  private cursor = 0
  private p: Float32Array
  private v: Float32Array
  private ttl: Float32Array
  private dur: Float32Array
  private size0: Float32Array
  private grow: Float32Array
  private lifeAttr: THREE.InstancedBufferAttribute
  private colAttr: THREE.InstancedBufferAttribute

  constructor(parent: THREE.Object3D, max = 64) {
    this.max = max
    const { geo, life, col } = instancedQuad(max)
    this.lifeAttr = life
    this.colAttr = col
    this.mesh = new THREE.InstancedMesh(geo, puffMaterial(), max)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 15
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    parent.add(this.mesh)
    this.p = new Float32Array(max * 3)
    this.v = new Float32Array(max * 3)
    this.ttl = new Float32Array(max)
    this.dur = new Float32Array(max)
    this.size0 = new Float32Array(max)
    this.grow = new Float32Array(max)
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number,
    size: number, grow: number, r: number, g: number, b: number, ttl: number): void {
    let i: number
    if (this.n < this.max) i = this.n++
    else { i = this.cursor; this.cursor = (this.cursor + 1) % this.max }
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz
    this.ttl[i] = ttl; this.dur[i] = ttl
    this.size0[i] = size; this.grow[i] = grow
    const c = this.colAttr.array as Float32Array
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b
    this.colAttr.needsUpdate = true
  }

  private removeAt(i: number): void {
    const l = --this.n
    if (i !== l) {
      for (let k = 0; k < 3; k++) {
        this.p[i * 3 + k] = this.p[l * 3 + k]
        this.v[i * 3 + k] = this.v[l * 3 + k]
      }
      this.ttl[i] = this.ttl[l]; this.dur[i] = this.dur[l]
      this.size0[i] = this.size0[l]; this.grow[i] = this.grow[l]
      const c = this.colAttr.array as Float32Array
      c[i * 3] = c[l * 3]; c[i * 3 + 1] = c[l * 3 + 1]; c[i * 3 + 2] = c[l * 3 + 2]
      this.colAttr.needsUpdate = true
    }
    this.cursor = 0
  }

  update(dt: number): void {
    const life = this.lifeAttr.array as Float32Array
    let i = 0
    while (i < this.n) {
      this.ttl[i] -= dt
      if (this.ttl[i] <= 0) { this.removeAt(i); continue }
      const damp = Math.exp(-1.4 * dt)
      this.v[i * 3] *= damp; this.v[i * 3 + 1] *= damp; this.v[i * 3 + 2] *= damp
      this.p[i * 3] += this.v[i * 3] * dt
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt
      const age = this.dur[i] - this.ttl[i]
      const sc = this.size0[i] + this.grow[i] * age
      _v.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2])
      _s.setScalar(sc)
      _m.compose(_v, Q_IDENT, _s)
      this.mesh.setMatrixAt(i, _m)
      life[i] = this.ttl[i] / this.dur[i]
      i++
    }
    this.mesh.count = this.n
    if (this.n > 0) { // idle pool: no draw, no re-upload
      this.mesh.instanceMatrix.needsUpdate = true
      this.lifeAttr.needsUpdate = true
    }
  }

  clear(): void { this.n = 0; this.cursor = 0; this.mesh.count = 0 }
}

// ─── Small mesh-per-slot pools ───────────────────────────────────────────────

const SHARED_QUAD = new THREE.PlaneGeometry(1, 1)
const SHARED_SPHERE = new THREE.SphereGeometry(1, 24, 18)

/** Expanding ground shockwave / dust rings. Blending switched per activation. */
export class RingPool {
  private slots: Array<{ mesh: THREE.Mesh; m: THREE.ShaderMaterial; ttl: number; dur: number }>

  constructor(parent: THREE.Object3D, count = 8) {
    this.slots = []
    for (let i = 0; i < count; i++) {
      const m = ringMaterial()
      const mesh = new THREE.Mesh(SHARED_QUAD, m)
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 12
      parent.add(mesh)
      this.slots.push({ mesh, m, ttl: 0, dur: 1 })
    }
  }

  spawn(x: number, y: number, z: number, maxRadius: number, dur: number,
    r: number, g: number, b: number, additive: boolean, width = 0.22): void {
    let best = this.slots[0]
    for (const s of this.slots) { if (s.ttl <= 0) { best = s; break } if (s.ttl < best.ttl) best = s }
    best.ttl = dur; best.dur = dur
    best.mesh.position.set(x, y, z)
    best.mesh.scale.setScalar(maxRadius * 2)
    best.mesh.visible = true
    best.m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    const c = best.m.uniforms.uColor.value as THREE.Color
    c.setRGB(r, g, b)
    best.m.uniforms.uWidth.value = width
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.ttl <= 0) continue
      s.ttl -= dt
      if (s.ttl <= 0) { s.mesh.visible = false; continue }
      const t = 1 - s.ttl / s.dur
      const p = 1 - (1 - t) * (1 - t) * (1 - t)
      s.m.uniforms.uP.value = p
      s.m.uniforms.uFade.value = (1 - t) * (1 - t) * 1.2
    }
  }

  clear(): void { for (const s of this.slots) { s.ttl = 0; s.mesh.visible = false } }
}

/** Noise-dissolve explosion fireballs. */
export class FireballPool {
  private slots: Array<{ mesh: THREE.Mesh; m: THREE.ShaderMaterial; ttl: number; dur: number; r: number }>

  constructor(parent: THREE.Object3D, count = 8) {
    this.slots = []
    for (let i = 0; i < count; i++) {
      const m = fireballMaterial()
      const mesh = new THREE.Mesh(SHARED_SPHERE, m)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 18
      parent.add(mesh)
      this.slots.push({ mesh, m, ttl: 0, dur: 1, r: 1 })
    }
  }

  spawn(x: number, y: number, z: number, radius: number, dur: number,
    coreR: number, coreG: number, coreB: number, edgeR: number, edgeG: number, edgeB: number): void {
    let best = this.slots[0]
    for (const s of this.slots) { if (s.ttl <= 0) { best = s; break } if (s.ttl < best.ttl) best = s }
    best.ttl = dur; best.dur = dur; best.r = radius
    best.mesh.position.set(x, y, z)
    best.mesh.visible = true
    best.m.uniforms.uSeed.value = Math.random() * 40
    ;(best.m.uniforms.uCore.value as THREE.Color).setRGB(coreR, coreG, coreB)
    ;(best.m.uniforms.uEdge.value as THREE.Color).setRGB(edgeR, edgeG, edgeB)
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.ttl <= 0) continue
      s.ttl -= dt
      if (s.ttl <= 0) { s.mesh.visible = false; continue }
      const t = 1 - s.ttl / s.dur
      const ease = 1 - (1 - t) * (1 - t)
      s.m.uniforms.uLife.value = t
      s.mesh.scale.setScalar(Math.max(0.01, s.r * (0.35 + 0.8 * ease)))
    }
  }

  clear(): void { for (const s of this.slots) { s.ttl = 0; s.mesh.visible = false } }
}

/** Oriented line quads (tracers / beam discharge flashes), billboarded around their axis. */
export class LinePool {
  private slots: Array<{ mesh: THREE.Mesh; m: THREE.ShaderMaterial; ttl: number; dur: number }>
  private camPos = new THREE.Vector3(0, 2, 10)

  constructor(parent: THREE.Object3D, count: number, factory: () => THREE.ShaderMaterial, renderOrder = 22) {
    this.slots = []
    for (let i = 0; i < count; i++) {
      const m = factory()
      const mesh = new THREE.Mesh(SHARED_QUAD, m)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = renderOrder
      parent.add(mesh)
      this.slots.push({ mesh, m, ttl: 0, dur: 1 })
    }
  }

  spawn(a: THREE.Vector3, b: THREE.Vector3, width: number,
    r: number, g: number, bl: number, dur: number): void {
    _y.copy(b).sub(a)
    const len = _y.length()
    if (len < 1e-3) return
    _y.divideScalar(len)
    let best = this.slots[0]
    for (const s of this.slots) { if (s.ttl <= 0) { best = s; break } if (s.ttl < best.ttl) best = s }
    best.ttl = dur; best.dur = dur
    const mesh = best.mesh
    mesh.position.copy(a).add(b).multiplyScalar(0.5)
    _v.copy(mesh.position).sub(this.camPos).normalize()
    _x.crossVectors(_y, _v)
    if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0)
    else _x.normalize()
    _z.crossVectors(_x, _y)
    _m.makeBasis(_x, _y, _z)
    mesh.quaternion.setFromRotationMatrix(_m)
    mesh.scale.set(width, len, 1)
    mesh.visible = true
    ;(best.m.uniforms.uColor.value as THREE.Color).setRGB(r, g, bl)
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.camPos.copy(camPos)
    for (const s of this.slots) {
      if (s.ttl <= 0) continue
      s.ttl -= dt
      if (s.ttl <= 0) { s.mesh.visible = false; continue }
      const t = s.ttl / s.dur
      s.m.uniforms.uLife.value = t * t
    }
  }

  clear(): void { for (const s of this.slots) { s.ttl = 0; s.mesh.visible = false } }
}

/** Camera-billboarded star flashes (muzzle, shield block, ignition pops). */
export class FlashPool {
  private slots: Array<{ mesh: THREE.Mesh; m: THREE.ShaderMaterial; ttl: number; dur: number; rz: number }>

  constructor(parent: THREE.Object3D, count = 5) {
    this.slots = []
    for (let i = 0; i < count; i++) {
      const m = flashMaterial()
      const mesh = new THREE.Mesh(SHARED_QUAD, m)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 24
      parent.add(mesh)
      this.slots.push({ mesh, m, ttl: 0, dur: 1, rz: 0 })
    }
  }

  spawn(pos: THREE.Vector3, size: number, r: number, g: number, b: number, dur: number): void {
    let best = this.slots[0]
    for (const s of this.slots) { if (s.ttl <= 0) { best = s; break } if (s.ttl < best.ttl) best = s }
    best.ttl = dur; best.dur = dur
    best.rz = Math.random() * Math.PI
    best.mesh.position.copy(pos)
    best.mesh.scale.setScalar(size)
    best.mesh.visible = true
    ;(best.m.uniforms.uColor.value as THREE.Color).setRGB(r, g, b)
  }

  update(dt: number, camera: THREE.Camera): void {
    for (const s of this.slots) {
      if (s.ttl <= 0) continue
      s.ttl -= dt
      if (s.ttl <= 0) { s.mesh.visible = false; continue }
      s.mesh.quaternion.copy(camera.quaternion)
      s.mesh.rotateZ(s.rz)
      s.m.uniforms.uLife.value = s.ttl / s.dur
    }
  }

  clear(): void { for (const s of this.slots) { s.ttl = 0; s.mesh.visible = false } }
}

/** Pooled transient point lights (muzzle, explosions). Lights stay mounted at
 *  intensity 0 so the scene's program light-count never churns. */
export class LightPool {
  private slots: Array<{ light: THREE.PointLight; ttl: number; dur: number; base: number }>

  constructor(parent: THREE.Object3D, count = 3) {
    this.slots = []
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffaa55, 0, 10, 2)
      light.castShadow = false
      parent.add(light)
      this.slots.push({ light, ttl: 0, dur: 1, base: 0 })
    }
  }

  spawn(pos: THREE.Vector3, color: number, intensity: number, distance: number, dur: number): void {
    let best = this.slots[0]
    for (const s of this.slots) { if (s.ttl <= 0) { best = s; break } if (s.ttl < best.ttl) best = s }
    best.ttl = dur; best.dur = dur; best.base = intensity
    best.light.position.copy(pos)
    best.light.color.setHex(color)
    best.light.distance = distance
    best.light.intensity = intensity
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.ttl <= 0) continue
      s.ttl -= dt
      if (s.ttl <= 0) { s.light.intensity = 0; continue }
      const t = s.ttl / s.dur
      s.light.intensity = s.base * t * t
    }
  }

  clear(): void { for (const s of this.slots) { s.ttl = 0; s.light.intensity = 0 } }
}
