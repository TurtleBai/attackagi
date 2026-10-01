import * as THREE from 'three'
import { BAT_SWING_TIME, PISTOL_MAG, PLAYER_SPEED } from '@/game/constants'
import { getWeaponRig, type WeaponRig } from './Weapons.models'

// First-person view models, posed by the verbatim Weapons.tsx animation math
// (sway, walk bob, ADS blend, magnum recoil + hammer, reload timeline with the
// crane swing-out / ejector flick / snap-shut wrist flick, bat charge glow +
// swing arc, molotov aim/throw + flame flicker). Inputs are scripted by shots
// instead of the mouse.

const PISTOL_POS = new THREE.Vector3(0.215, -0.205, -0.42)
const BAT_POS = new THREE.Vector3(0.27, -0.34, -0.47)
const BAT_ROT = new THREE.Euler(-0.55, 0.18, -0.12)
const MOLO_POS = new THREE.Vector3(0.24, -0.27, -0.43)
const MOLO_ROT = new THREE.Euler(0.12, 0.0, 0.22)
const MOLO_AIM_POS = new THREE.Vector3(0.215, -0.16, -0.385)
const MOLO_AIM_ROT = new THREE.Euler(-0.5, 0.08, 0.3)
const ADS_Z = -0.26
const THROW_ANIM = 0.42
const CYL_STEP = (Math.PI * 2) / 6

const _tp = new THREE.Vector3()
const _dir = new THREE.Vector3()

export class ViewModel {
  readonly rig: WeaponRig = getWeaponRig()
  weapon: 1 | 2 | 3 = 1
  // scripted inputs
  ads = false
  /** reload progress 0..1 while reloading, else -1 */
  reloadP = -1
  charging = false
  charge = 0
  aimingMolotov = false
  speed = 0 // player ground speed (m/s) → walk bob
  onGround = true
  ammo = PISTOL_MAG
  // animation state (Weapons.tsx LocalState)
  vt = 0
  recoil = 0
  flashT = 0
  swingT = -1
  swingCharge = 0
  throwT = -1
  adsT = 0
  cylAngle = 0
  swayX = 0
  swayY = 0
  lastYaw = 0
  lastPitch = 0
  bobPhase = 0
  bobAmt = 0
  raiseT = 1
  bottleScale = 1
  /** extra pose offset a shot can layer on (camera-local) */
  readonly offset = new THREE.Vector3()
  /** false → leave the weapon groups alone (style-sheet product shots) */
  enabled = true

  attach(camera: THREE.Camera): void {
    camera.add(this.rig.root)
  }

  reset(): void {
    this.weapon = 1
    this.ads = false
    this.reloadP = -1
    this.charging = false
    this.charge = 0
    this.aimingMolotov = false
    this.speed = 0
    this.onGround = true
    this.ammo = PISTOL_MAG
    this.vt = 0
    this.recoil = 0
    this.flashT = 0
    this.swingT = -1
    this.swingCharge = 0
    this.throwT = -1
    this.adsT = 0
    this.cylAngle = 0
    this.swayX = this.swayY = 0
    this.bobPhase = 0
    this.bobAmt = 0
    this.raiseT = 1
    this.bottleScale = 1
    this.offset.set(0, 0, 0)
    this.rig.root.visible = true
    this.lastYaw = NaN
  }

  fire(): void {
    this.ammo = Math.max(0, this.ammo - 1)
    this.recoil = Math.min(1, this.recoil + 0.9)
    this.flashT = 0.055
    const p = this.rig.pistol
    p.flash.rotation.z = Math.random() * Math.PI * 2
    p.flash.scale.setScalar(0.85 + Math.random() * 0.4)
    p.ventFlash.rotation.z = (Math.random() - 0.5) * 0.7
    p.ventFlash.scale.setScalar(0.8 + Math.random() * 0.45)
  }

  swing(charge: number): void {
    this.charging = false
    this.swingT = 0
    this.swingCharge = charge
  }

  throwBottle(): void {
    this.throwT = 0
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.rig.root.updateWorldMatrix(true, true)
    return this.rig.pistol.muzzle.getWorldPosition(out)
  }

  update(step: number, camera: THREE.PerspectiveCamera): void {
    if (!this.enabled) return
    const rig = this.rig
    this.vt += step
    rig.pistol.group.visible = this.weapon === 1
    rig.bat.group.visible = this.weapon === 2
    rig.molotov.group.visible = this.weapon === 3

    // sway from look deltas + walk bob
    camera.getWorldDirection(_dir)
    const yaw = Math.atan2(_dir.x, _dir.z)
    const pitch = Math.asin(THREE.MathUtils.clamp(_dir.y, -1, 1))
    if (Number.isNaN(this.lastYaw)) { this.lastYaw = yaw; this.lastPitch = pitch }
    let dyaw = yaw - this.lastYaw
    if (dyaw > Math.PI) dyaw -= Math.PI * 2
    else if (dyaw < -Math.PI) dyaw += Math.PI * 2
    const dpitch = pitch - this.lastPitch
    this.lastYaw = yaw
    this.lastPitch = pitch
    const invStep = step > 1e-4 ? 1 / step : 0
    const tx = THREE.MathUtils.clamp(-dyaw * invStep * 0.009, -0.06, 0.06)
    const ty = THREE.MathUtils.clamp(-dpitch * invStep * 0.009, -0.05, 0.05)
    const kSway = 1 - Math.exp(-12 * step)
    this.swayX += (tx - this.swayX) * kSway
    this.swayY += (ty - this.swayY) * kSway
    const bobTarget = this.onGround && this.speed > 0.5 ? Math.min(1.25, this.speed / PLAYER_SPEED) : 0
    this.bobAmt += (bobTarget - this.bobAmt) * (1 - Math.exp(-8 * step))
    this.bobPhase += step * (4.5 + this.speed * 0.55)
    const bobX = Math.cos(this.bobPhase) * 0.011 * this.bobAmt
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * 0.013 * this.bobAmt
    this.raiseT = Math.min(1, this.raiseT + step * 4.5)
    const raise = (1 - this.raiseT) * (1 - this.raiseT)
    const reloading = this.reloadP >= 0
    const adsGoal = this.ads && this.weapon === 1 && !reloading ? 1 : 0
    this.adsT += (adsGoal - this.adsT) * (1 - Math.exp(-13 * step))
    const swayK = 1 - 0.85 * this.adsT
    rig.sway.position.set(
      (this.swayX * 0.35 + bobX) * swayK + this.offset.x,
      (this.swayY * 0.35 + bobY + Math.sin(this.vt * 1.4) * 0.0015) * swayK - raise * 0.28 + this.offset.y,
      this.offset.z,
    )
    rig.sway.rotation.set(
      this.swayY * 0.9 * swayK + raise * 0.9,
      this.swayX * 0.9 * swayK,
      -this.swayX * 0.45 * swayK,
    )

    if (this.swingT >= 0) {
      this.swingT += step
      if (this.swingT / BAT_SWING_TIME >= 1) this.swingT = -1
    }
    if (this.throwT >= 0) {
      this.throwT += step
      if (this.throwT >= THROW_ANIM) this.throwT = -1
    }

    // ── revolver ──
    if (rig.pistol.group.visible) {
      const p = reloading ? THREE.MathUtils.clamp(this.reloadP, 0, 1) : 0
      const dip = reloading ? Math.sin(p * Math.PI) : 0
      const open = reloading
        ? THREE.MathUtils.smoothstep(p, 0.08, 0.26) * (1 - THREE.MathUtils.smoothstep(p, 0.84, 0.93)) : 0
      const eject = reloading
        ? THREE.MathUtils.smoothstep(p, 0.36, 0.44) * (1 - THREE.MathUtils.smoothstep(p, 0.5, 0.62)) : 0
      const flick = reloading
        ? THREE.MathUtils.smoothstep(p, 0.86, 0.92) * (1 - THREE.MathUtils.smoothstep(p, 0.93, 0.995)) : 0
      this.recoil *= Math.exp(-9 * step)
      const g = rig.pistol.group
      const ao = rig.pistol.adsOffset
      const bx = THREE.MathUtils.lerp(PISTOL_POS.x, -ao.x, this.adsT)
      const by = THREE.MathUtils.lerp(PISTOL_POS.y, -ao.y, this.adsT)
      const bz = THREE.MathUtils.lerp(PISTOL_POS.z, ADS_Z - ao.z, this.adsT)
      const rk = 1 - 0.45 * this.adsT
      g.position.set(
        bx - dip * 0.055,
        by - dip * 0.15 + this.recoil * 0.012 * rk,
        bz + this.recoil * 0.085 * rk + dip * 0.035,
      )
      g.rotation.set(
        (-dip * 0.78 + flick * 0.1) + this.recoil * 0.28 * rk,
        0.02 * (1 - this.adsT) + dip * 0.1,
        dip * 0.55 + open * 0.26 - flick * 0.16 - this.recoil * 0.05 * rk,
      )
      rig.pistol.crane.rotation.z = open * 2.05
      rig.pistol.ejector.position.z = eject * 0.022
      if (reloading) {
        this.cylAngle += step * open * (7 + 30 * eject)
      } else {
        const tgt = Math.max(0, PISTOL_MAG - this.ammo) * CYL_STEP
        const off = this.cylAngle - tgt
        if (off > CYL_STEP * 0.5 || off < -CYL_STEP * 1.5) {
          this.cylAngle = tgt + ((off % CYL_STEP) + CYL_STEP) % CYL_STEP - CYL_STEP
        }
        this.cylAngle += (tgt - this.cylAngle) * (1 - Math.exp(-25 * step))
      }
      rig.pistol.cylinder.rotation.z = this.cylAngle
      rig.pistol.hammer.rotation.x = THREE.MathUtils.smoothstep(this.recoil, 0.15, 0.5) * 0.55
      this.flashT = Math.max(0, this.flashT - step)
      const flashOn = this.flashT > 0
      rig.pistol.flash.visible = flashOn
      rig.pistol.ventFlash.visible = flashOn
      if (flashOn) rig.pistol.flashMat.opacity = Math.min(1, this.flashT / 0.04)
    }

    // ── bat ──
    if (rig.bat.group.visible) {
      const g = rig.bat.group
      if (this.swingT >= 0) {
        const t = THREE.MathUtils.clamp(this.swingT / BAT_SWING_TIME, 0, 1)
        const a = t * t * (3 - 2 * t)
        const c = this.swingCharge
        const arcLift = Math.sin(a * Math.PI)
        g.position.set(
          BAT_POS.x + 0.05 * c - 0.30 * a,
          BAT_POS.y + 0.02 - 0.06 * arcLift,
          BAT_POS.z + 0.10 * c - 0.22 * arcLift,
        )
        g.rotation.set(
          BAT_ROT.x + 0.30 * c - 1.15 * arcLift,
          BAT_ROT.y + 0.55 * c - 2.3 * a,
          BAT_ROT.z - 0.8 * arcLift,
        )
      } else {
        const c = this.charging ? this.charge : 0
        _tp.set(BAT_POS.x + 0.05 * c, BAT_POS.y + 0.015 * c, BAT_POS.z + 0.10 * c)
        const k = 1 - Math.exp(-16 * step)
        g.position.lerp(_tp, k)
        g.rotation.x += (BAT_ROT.x + 0.30 * c - g.rotation.x) * k
        g.rotation.y += (BAT_ROT.y + 0.55 * c - g.rotation.y) * k
        g.rotation.z += (BAT_ROT.z - 0.18 * c - g.rotation.z) * k
      }
      const fadingSwing = this.swingT >= 0 ? this.swingCharge * (1 - this.swingT / BAT_SWING_TIME) : 0
      const glow = this.charging ? this.charge : fadingSwing
      const full = this.charging && this.charge >= 1
      rig.bat.mat.emissiveIntensity = full ? 1.5 + 1.2 * Math.sin(this.vt * 16) : glow * 0.55
      rig.bat.shellMat.opacity = full ? 0.30 + 0.22 * Math.sin(this.vt * 16) : glow * 0.12
      rig.bat.shell.visible = rig.bat.shellMat.opacity > 0.02
    }

    // ── molotov ──
    if (rig.molotov.group.visible) {
      const g = rig.molotov.group
      const throwing = this.throwT >= 0
      const aimPose = this.aimingMolotov && !throwing
      const k = 1 - Math.exp(-16 * step)
      if (throwing && this.throwT < 0.14) {
        const tt = this.throwT / 0.14
        g.position.set(MOLO_AIM_POS.x + 0.05 * tt, MOLO_AIM_POS.y - 0.04 * tt, MOLO_AIM_POS.z - 0.30 * tt)
        g.rotation.set(MOLO_AIM_ROT.x + 1.5 * tt, MOLO_AIM_ROT.y, MOLO_AIM_ROT.z - 0.2 * tt)
      } else {
        const tpos = aimPose ? MOLO_AIM_POS : MOLO_POS
        const trot = aimPose ? MOLO_AIM_ROT : MOLO_ROT
        g.position.lerp(tpos, k)
        g.rotation.x += (trot.x - g.rotation.x) * k
        g.rotation.y += (trot.y - g.rotation.y) * k
        g.rotation.z += (trot.z - g.rotation.z) * k
      }
      const bottleVisible = throwing ? this.throwT < 0.07 : true
      if (rig.molotov.bottle.visible && !bottleVisible) this.bottleScale = 0.55
      rig.molotov.bottle.visible = bottleVisible
      if (bottleVisible) {
        this.bottleScale += (1 - this.bottleScale) * (1 - Math.exp(-14 * step))
        rig.molotov.bottle.scale.setScalar(this.bottleScale)
      }
      rig.molotov.liquid.rotation.set(this.swayY * 1.2 + Math.sin(this.vt * 3) * 0.04, 0, -this.swayX * 1.5)
      rig.molotov.flameMat.uniforms.uTime.value = this.vt
      rig.molotov.flameMat.uniforms.uFlick.value = 0.78 + 0.16 * Math.sin(this.vt * 23) + 0.06 * Math.sin(this.vt * 61)
      rig.molotov.flame.scale.set(1, 0.9 + 0.12 * Math.sin(this.vt * 17 + 1.3), 1)
      rig.molotov.ember.scale.setScalar(1 + 0.14 * Math.sin(this.vt * 31))
    }
  }
}
