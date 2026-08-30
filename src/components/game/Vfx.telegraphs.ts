'use client'
import * as THREE from 'three'
import { world } from '@/game/world'
import type { Telegraph } from '@/game/types'
import { telegraphCircleMaterial, telegraphRectMaterial } from './Vfx.shaders'

// ─────────────────────────────────────────────────────────────────────────────
// Vfx.telegraphs — pooled flat decals mirroring world.telegraphs every frame.
// Circle: ring + growing radial fill; rect: outline + sweeping fill. Styled by
// payload.tag; brightness/pulse ramp toward tHit; white flash on resolve
// (telegraphs linger ~0.3s resolved — plus a local orphan-flash fallback in
// case an owner removes one at tHit exactly).
// ─────────────────────────────────────────────────────────────────────────────

const CIRCLES = 32
const RECTS = 24
const DECAL_Y = 0.045
const FLASH_TIME = 0.3

const Y_AXIS = new THREE.Vector3(0, 1, 0)
const QX90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
const _q = new THREE.Quaternion()

interface Style {
  r: number; g: number; b: number
  intensity: number
  mode: number // circle only: 0 fill, 1 reticle, 2 smash
  pulseAmp: number
  chevrons: number // rect only
}

const STYLE_RED: Style = { r: 1.9, g: 0.16, b: 0.12, intensity: 1.1, mode: 0, pulseAmp: 0.15, chevrons: 0 }
const STYLE_STRIPE: Style = { r: 2.3, g: 0.55, b: 0.07, intensity: 1.3, mode: 0, pulseAmp: 0.2, chevrons: 0 }
const STYLE_DEATHBEAM: Style = { r: 3.0, g: 0.55, b: 0.45, intensity: 1.9, mode: 0, pulseAmp: 0.3, chevrons: 1 }
const STYLE_SMASH: Style = { r: 1.9, g: 0.14, b: 0.1, intensity: 1.7, mode: 2, pulseAmp: 0.5, chevrons: 0 }
const STYLE_AIM: Style = { r: 2.1, g: 0.4, b: 0.2, intensity: 1.3, mode: 1, pulseAmp: 0.2, chevrons: 0 }

function styleFor(t: Telegraph): Style {
  switch (t.payload.tag) {
    case 'deathBeam': return STYLE_DEATHBEAM
    case 'smash': return STYLE_SMASH
    case 'aimMarker': return STYLE_AIM
    case 'stripe': return STYLE_STRIPE
    default: return STYLE_RED
  }
}

interface Slot {
  mesh: THREE.Mesh
  m: THREE.ShaderMaterial
  id: number // -1 = free
  seen: number
  lastFill: number
  lastOver: number // seconds past tHit at last sync (< 0 pre-hit)
  visualOnly: boolean
  orphanUntil: number // > 0 → keep flashing after the telegraph vanished
}

function makeSlots(parent: THREE.Object3D, count: number, circle: boolean): Slot[] {
  const geo = new THREE.PlaneGeometry(1, 1)
  const out: Slot[] = []
  for (let i = 0; i < count; i++) {
    const m = circle ? telegraphCircleMaterial() : telegraphRectMaterial()
    const mesh = new THREE.Mesh(geo, m)
    mesh.visible = false
    mesh.frustumCulled = false
    mesh.renderOrder = 10
    parent.add(mesh)
    out.push({ mesh, m, id: -1, seen: 0, lastFill: 0, lastOver: -1, visualOnly: false, orphanUntil: 0 })
  }
  return out
}

export class Telegraphs {
  private circles: Slot[]
  private rects: Slot[]
  private byId = new Map<number, Slot>()
  private stamp = 0

  constructor(parent: THREE.Object3D) {
    this.circles = makeSlots(parent, CIRCLES, true)
    this.rects = makeSlots(parent, RECTS, false)
  }

  update(time: number): void {
    this.stamp++
    for (const tg of world.telegraphs) {
      let slot = this.byId.get(tg.id)
      if (!slot) {
        slot = this.assign(tg)
        if (!slot) continue
      }
      slot.seen = this.stamp
      this.sync(slot, tg, time)
    }
    this.release(this.circles, time)
    this.release(this.rects, time)
  }

  private assign(tg: Telegraph): Slot | undefined {
    const pool = tg.shape === 'circle' ? this.circles : this.rects
    for (const s of pool) {
      if (s.id === -1 && s.orphanUntil === 0) {
        s.id = tg.id
        s.lastFill = 0
        s.lastOver = -1
        s.visualOnly = tg.payload.visualOnly === true
        s.mesh.visible = true
        const st = styleFor(tg)
        const u = s.m.uniforms
        ;(u.uColor.value as THREE.Color).setRGB(st.r, st.g, st.b)
        u.uPulseAmp.value = st.pulseAmp
        if (tg.shape === 'circle') u.uMode.value = st.mode
        else u.uChevrons.value = st.chevrons
        this.byId.set(tg.id, s)
        return s
      }
    }
    return undefined
  }

  private sync(slot: Slot, tg: Telegraph, time: number): void {
    const u = slot.m.uniforms
    const dur = Math.max(0.05, tg.tHit - tg.tStart)
    const fill = Math.min(1, Math.max(0, (time - tg.tStart) / dur))
    slot.lastFill = fill
    const st = styleFor(tg)
    u.uTime.value = time
    u.uFill.value = fill
    u.uIntensity.value = st.intensity * (0.65 + 0.8 * fill * fill)
    u.uPulseSpeed.value = 6 + 8 * fill
    const over = time - tg.tHit
    slot.lastOver = over
    if ((tg.resolved || over >= 0) && !slot.visualOnly) {
      const k = Math.min(1, Math.max(0, over) / FLASH_TIME)
      u.uFlash.value = (1 - k) * (1 - k)
      u.uFade.value = 1 - k
    } else if (over >= 0) {
      // visual-only markers just fade after tHit
      u.uFlash.value = 0
      u.uFade.value = Math.max(0, 1 - over / FLASH_TIME)
    } else {
      u.uFlash.value = 0
      u.uFade.value = Math.min(1, (time - tg.tStart) / 0.12)
    }
    const mesh = slot.mesh
    const i = mesh.id % 7
    mesh.position.set(tg.pos.x, DECAL_Y + i * 0.0012, tg.pos.z)
    if (tg.shape === 'circle') {
      mesh.quaternion.copy(QX90)
      mesh.scale.set(Math.max(0.01, tg.radius * 2), Math.max(0.01, tg.radius * 2), 1)
    } else {
      _q.setFromAxisAngle(Y_AXIS, tg.yaw).multiply(QX90)
      mesh.quaternion.copy(_q)
      mesh.scale.set(Math.max(0.01, tg.w), Math.max(0.01, tg.l), 1)
      ;(u.uSize.value as THREE.Vector2).set(tg.w, tg.l)
    }
  }

  private release(pool: Slot[], time: number): void {
    for (const s of pool) {
      if (s.orphanUntil > 0) {
        // local resolve-flash for telegraphs removed exactly at tHit
        if (time >= s.orphanUntil) { s.orphanUntil = 0; s.mesh.visible = false }
        else {
          const k = 1 - (s.orphanUntil - time) / FLASH_TIME
          s.m.uniforms.uFlash.value = (1 - k) * (1 - k)
          s.m.uniforms.uFade.value = 1 - k
          s.m.uniforms.uTime.value = time
        }
        continue
      }
      if (s.id === -1 || s.seen === this.stamp) continue
      this.byId.delete(s.id)
      s.id = -1
      // Orphan flash only for telegraphs yanked right at tHit — ones that
      // lingered already played their resolve flash during sync.
      if (s.lastFill >= 0.98 && s.lastOver <= 0.05 && !s.visualOnly) {
        s.orphanUntil = time + FLASH_TIME
        s.m.uniforms.uFill.value = 1
      } else {
        s.mesh.visible = false
      }
    }
  }

  clear(): void {
    this.byId.clear()
    for (const s of this.circles) { s.id = -1; s.orphanUntil = 0; s.mesh.visible = false }
    for (const s of this.rects) { s.id = -1; s.orphanUntil = 0; s.mesh.visible = false }
  }
}
