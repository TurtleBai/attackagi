'use client'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  BAT_ARC, BAT_CHARGED_MULT, BAT_RANGE, BAT_SWING_TIME, FRAME_PRIO, GRAVITY,
  MOLOTOV_DAMAGE, MOLOTOV_THROW_SPEED, PISTOL_RANGE, PLAYER_SPEED,
} from '@/game/constants'
import { events } from '@/game/events'
import { useSettings } from '@/game/settings'
import { simRunning, useGame } from '@/game/store'
import type { WeaponSlot } from '@/game/types'
import { world } from '@/game/world'
import { getArcAssets, getWeaponRig } from './Weapons.models'

// Weapon logic + first-person view models. Runs at FRAME_PRIO.weapons (after Player
// has placed the camera). View models hang off the camera; the molotov aim arc and
// landing disc live in scene space.

// ─── Pose constants ──────────────────────────────────────────────────────────

const PISTOL_POS = new THREE.Vector3(0.215, -0.205, -0.42)
const BAT_POS = new THREE.Vector3(0.27, -0.34, -0.47)
const BAT_ROT = new THREE.Euler(-0.55, 0.18, -0.12)
const MOLO_POS = new THREE.Vector3(0.24, -0.27, -0.43)
const MOLO_ROT = new THREE.Euler(0.12, 0.0, 0.22)
const MOLO_AIM_POS = new THREE.Vector3(0.215, -0.16, -0.385)
const MOLO_AIM_ROT = new THREE.Euler(-0.5, 0.08, 0.3)

const STRIKE_AT = 0.42 // fraction of the swing when bat damage lands
const HEADSHOT_MULT = 2 // revolver damage multiplier for head-zone hits
const ADS_Z = -0.26 // camera-local depth of the red dot while aiming
const ADS_FOV = 60 // zoom while aiming (base 78)
const THROW_ANIM = 0.42 // seconds
const CYL_STEP = (Math.PI * 2) / 6 // one revolver chamber

// ─── Scratch (no per-frame allocations) ──────────────────────────────────────

const _eye = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _p = new THREE.Vector3()
const _prev = new THREE.Vector3()
const _v = new THREE.Vector3()
const _seg = new THREE.Vector3()
const _mid = new THREE.Vector3()
const _land = new THREE.Vector3()
const _chest = new THREE.Vector3()
const _tp = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _sc = new THREE.Vector3(1, 1, 1)
const _zAxis = new THREE.Vector3(0, 0, 1)

interface LocalState {
  vt: number // visual clock (always advances)
  triggerHeld: boolean // pistol full-auto: LMB held
  charging: boolean
  chargeT: number
  charge: number // 0..1 ratio
  swingT: number // -1 idle, else seconds into swing
  swingCharge: number
  struck: boolean
  reloadActive: boolean
  reloadEnd: number // world.time
  reloadDur: number
  lastShot: number
  aiming: boolean
  ads: boolean // revolver aim-down-sight held (RMB on slot 1)
  adsT: number // 0..1 smoothed ADS blend
  throwT: number // -1 idle, else seconds into throw anim
  flashT: number
  recoil: number
  cylAngle: number // revolver cylinder visual angle (rad, accumulates forward)
  swayX: number
  swayY: number
  lastYaw: number
  lastPitch: number
  bobPhase: number
  bobAmt: number
  raiseT: number // weapon raise-in after switching
  bottleScale: number
}

export function Weapons() {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  // rig + arc are module singletons; fetched inside callbacks (never mutated during render)

  const st = useRef<LocalState>({
    vt: 0,
    triggerHeld: false,
    charging: false, chargeT: 0, charge: 0,
    swingT: -1, swingCharge: 0, struck: true,
    reloadActive: false, reloadEnd: 0, reloadDur: 1,
    lastShot: -1e9,
    aiming: false,
    ads: false, adsT: 0,
    throwT: -1,
    flashT: 0,
    recoil: 0,
    cylAngle: 0,
    swayX: 0, swayY: 0, lastYaw: 0, lastPitch: 0,
    bobPhase: 0, bobAmt: 0,
    raiseT: 1,
    bottleScale: 1,
  }).current

  // ── Actions (closures over stable st + global singletons) ──────────────────

  const hardReset = () => {
    st.triggerHeld = false
    st.charging = false; st.chargeT = 0; st.charge = 0
    st.swingT = -1; st.swingCharge = 0; st.struck = true
    st.reloadActive = false; st.reloadEnd = 0
    st.lastShot = -1e9
    st.aiming = false
    st.ads = false; st.adsT = 0
    st.throwT = -1
    st.flashT = 0; st.recoil = 0
    st.cylAngle = 0
    st.swayX = 0; st.swayY = 0
    st.bobPhase = 0; st.bobAmt = 0
    st.raiseT = 1
    getArcAssets().group.visible = false
  }

  const startReload = () => {
    const s = useGame.getState()
    if (st.reloadActive) return
    if (s.ammoInMag >= s.stats.magSize) return
    if (s.ammoReserve <= 0) return
    st.reloadActive = true
    st.reloadDur = s.stats.reloadTime
    st.reloadEnd = world.time + s.stats.reloadTime
    s.set({ reloading: true })
    events.emit('reloadStart', { duration: s.stats.reloadTime })
  }

  const completeReload = () => {
    const s = useGame.getState()
    st.reloadActive = false
    const transfer = Math.min(s.stats.magSize - s.ammoInMag, s.ammoReserve)
    s.set({
      ammoInMag: s.ammoInMag + Math.max(0, transfer),
      ammoReserve: s.ammoReserve - Math.max(0, transfer),
      reloading: false,
    })
  }

  const tryFirePistol = () => {
    const s = useGame.getState()
    if (st.reloadActive) return
    if (s.ammoInMag <= 0) { startReload(); return } // empty click → auto reload
    if (world.time - st.lastShot < s.stats.fireInterval) return
    st.lastShot = world.time

    const rig = getWeaponRig()
    camera.getWorldPosition(_eye)
    camera.getWorldDirection(_dir)
    const hit = world.raycastShot(_eye, _dir, PISTOL_RANGE)
    if (hit) {
      if (hit.kind === 'enemy' && hit.enemy) {
        const headshot = hit.headshot === true
        world.damageEnemy(hit.enemy.id, s.stats.pistolDamage * (headshot ? HEADSHOT_MULT : 1))
        events.emit('hitConfirm', { headshot })
      } else if (hit.kind === 'shieldBlock') {
        events.emit('shieldBlock', { pos: hit.point })
      } else if (hit.kind === 'boss') {
        if (world.damageBoss(s.stats.pistolDamage, hit.point)) events.emit('hitConfirm', { headshot: false })
      }
    }
    rig.pistol.muzzle.getWorldPosition(_p)
    events.emit('shot', { origin: _p.clone(), dir: _dir.clone(), hitPoint: hit ? hit.point : null })

    const magAfter = s.ammoInMag - 1
    s.set({ ammoInMag: magAfter })
    st.recoil = Math.min(1, st.recoil + 0.9)
    st.flashT = 0.055
    rig.pistol.flash.rotation.z = Math.random() * Math.PI * 2
    rig.pistol.flash.scale.setScalar(0.85 + Math.random() * 0.4)
    rig.pistol.ventFlash.rotation.z = (Math.random() - 0.5) * 0.7
    rig.pistol.ventFlash.scale.setScalar(0.8 + Math.random() * 0.45)
    if (magAfter <= 0 && s.ammoReserve > 0) startReload() // auto on empty
  }

  const doStrike = (charge: number) => {
    const s = useGame.getState()
    camera.getWorldPosition(_eye)
    camera.getWorldDirection(_dir)
    const dmg = s.stats.batDamage * (1 + (BAT_CHARGED_MULT - 1) * charge)
    const fx = _dir.x, fz = _dir.z
    const fl = Math.hypot(fx, fz) || 1
    const cosHalf = Math.cos(BAT_ARC / 2)
    const kb = 4 + 8 * charge
    let connected = false
    for (const e of world.enemies.values()) {
      if (e.hp <= 0 || e.falling) continue
      const dx = e.pos.x - world.player.pos.x
      const dz = e.pos.z - world.player.pos.z
      const d = Math.hypot(dx, dz)
      if (d - e.radius > BAT_RANGE) continue
      const dot = (dx * (fx / fl) + dz * (fz / fl)) / Math.max(d, 1e-4)
      if (dot < cosHalf) continue
      _chest.copy(e.pos)
      _chest.y += e.height * 0.55
      if (world.segmentBlocked(_eye, _chest)) continue
      world.damageEnemy(e.id, dmg)
      connected = true
      const inv = 1 / Math.max(d, 1e-4)
      e.vel.x += dx * inv * kb
      e.vel.z += dz * inv * kb
      events.emit('batHit', { pos: _chest.clone(), charged: charge })
    }
    // giant boss hands (punch linger + tired rest): proximity strike — the
    // forward ray whiffs when the player stands beside/inside the big sphere,
    // so a swing next to a hand always connects
    let hitHand = false
    for (const hand of world.agi.punchHands) {
      if (hand.hpLeft <= 0) continue
      const dxh = hand.pos.x - world.player.pos.x
      const dzh = hand.pos.z - world.player.pos.z
      if (Math.hypot(dxh, dzh) <= BAT_RANGE + hand.radius) {
        if (world.damageBoss(dmg, hand.pos)) connected = true
        events.emit('batHit', { pos: hand.pos.clone(), charged: charge })
        hitHand = true
      }
    }
    // head / other weak points still via the forward ray (skip if a hand
    // already took this swing — no double dipping)
    if (!hitHand) {
      const hit = world.raycastShot(_eye, _dir, BAT_RANGE)
      if (hit && hit.kind === 'boss') {
        if (world.damageBoss(dmg, hit.point)) connected = true
        events.emit('batHit', { pos: hit.point.clone(), charged: charge })
      }
    }
    if (connected) events.emit('hitConfirm', { headshot: false })
  }

  const releaseBat = () => {
    if (!st.charging) return
    const charge = st.charge
    st.charging = false
    st.chargeT = 0
    st.charge = 0
    const s = useGame.getState()
    if (s.batCharge !== 0) s.set({ batCharge: 0 })
    if (!document.pointerLockElement || !simRunning(s.phase) || s.weapon !== 2) return
    st.swingT = 0
    st.swingCharge = charge
    st.struck = false
    events.emit('batSwing', { charged: charge })
  }

  const throwMolotov = () => {
    const s = useGame.getState()
    if (s.molotovs <= 0 || st.throwT >= 0) return
    camera.getWorldPosition(_eye)
    camera.getWorldDirection(_dir)
    _right.set(-_dir.z, 0, _dir.x)
    const rl = _right.length()
    if (rl > 1e-4) _right.divideScalar(rl); else _right.set(1, 0, 0)
    _p.copy(_eye).addScaledVector(_dir, 0.45).addScaledVector(_right, 0.16)
    _p.y -= 0.06
    _v.copy(_dir).multiplyScalar(MOLOTOV_THROW_SPEED)
    world.addProjectile({
      kind: 'molotov', pos: _p, vel: _v,
      radius: 0.25, damage: MOLOTOV_DAMAGE, ttl: 8, gravityScale: 1,
    })
    const left = s.molotovs - 1
    s.set({ molotovs: left, ...(left <= 0 ? { aimingMolotov: false } : null) })
    if (left <= 0) st.aiming = false // out of bottles: drop out of aim mode
    events.emit('molotovThrow', {})
    st.throwT = 0
  }

  const switchWeapon = (slot: WeaponSlot) => {
    const s = useGame.getState()
    if (s.weapon === slot) return
    st.triggerHeld = false
    st.ads = false
    st.charging = false
    st.chargeT = 0
    st.charge = 0
    st.swingT = -1
    if (st.aiming) st.aiming = false
    s.set({ weapon: slot, batCharge: 0, aimingMolotov: false })
    events.emit('weaponSwitch', { slot })
    st.raiseT = 0
  }

  // ── Camera attachment ──────────────────────────────────────────────────────

  useEffect(() => {
    const rig = getWeaponRig()
    if (!camera.parent) scene.add(camera) // camera children only render if the camera is in the scene graph
    camera.add(rig.root)
    return () => { camera.remove(rig.root) }
  }, [camera, scene])

  // ── Run reset ──────────────────────────────────────────────────────────────

  useEffect(() => {
    return useGame.subscribe((now, prev) => {
      if (now.runId !== prev.runId) hardReset()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Input ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const locked = () => document.pointerLockElement !== null
    const running = () => simRunning(useGame.getState().phase)

    const onKeyDown = (e: KeyboardEvent) => {
      if (!locked() || !running()) return
      const b = useSettings.getState().bindings
      if (e.code === b.weapon1) switchWeapon(1)
      else if (e.code === b.weapon2) switchWeapon(2)
      else if (e.code === b.weapon3) switchWeapon(3)
      else if (e.code === b.reload) {
        if (useGame.getState().weapon === 1) startReload()
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (!locked() || !running()) return
      const s = useGame.getState()
      if (e.button === 0) {
        if (s.weapon === 1) {
          st.triggerHeld = true // full-auto: keeps firing in the frame loop
          tryFirePistol()
        } else if (s.weapon === 2) {
          if (st.swingT < 0 && !st.charging) { st.charging = true; st.chargeT = 0; st.charge = 0 }
        } else if (s.weapon === 3 && st.aiming) throwMolotov()
      } else if (e.button === 2) {
        if (s.weapon === 1) {
          st.ads = true // revolver aim-down-sight
        } else if (s.weapon === 3 && !st.aiming && s.molotovs > 0) {
          st.aiming = true
          s.set({ aimingMolotov: true })
        }
      }
    }

    const onMouseUp = (e: MouseEvent) => {
      // releases always clear held state, even if the sim paused mid-hold
      if (e.button === 0) {
        st.triggerHeld = false
        releaseBat()
      }
      else if (e.button === 2) {
        st.ads = false
        if (st.aiming) {
          st.aiming = false
          useGame.getState().set({ aimingMolotov: false })
        }
      }
    }

    const onContextMenu = (e: MouseEvent) => {
      if (locked()) e.preventDefault()
    }

    const onLockChange = () => {
      if (document.pointerLockElement) return
      // lock lost: drop transient held inputs
      st.triggerHeld = false
      st.ads = false
      if (st.charging) {
        st.charging = false
        st.chargeT = 0
        st.charge = 0
        useGame.getState().set({ batCharge: 0 })
      }
      if (st.aiming) {
        st.aiming = false
        useGame.getState().set({ aimingMolotov: false })
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('pointerlockchange', onLockChange)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('pointerlockchange', onLockChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])

  // ── Aim arc + landing disc ─────────────────────────────────────────────────

  const updateArc = (molotovRadius: number) => {
    const arc = getArcAssets()
    camera.getWorldPosition(_eye)
    camera.getWorldDirection(_dir)
    _right.set(-_dir.z, 0, _dir.x)
    const rl = _right.length()
    if (rl > 1e-4) _right.divideScalar(rl); else _right.set(1, 0, 0)
    _p.copy(_eye).addScaledVector(_dir, 0.45).addScaledVector(_right, 0.16)
    _p.y -= 0.06
    _v.copy(_dir).multiplyScalar(MOLOTOV_THROW_SPEED)
    const dtA = 0.03
    let n = 0
    let landed = false
    for (let i = 0; i < 110 && n < 72; i++) {
      _prev.copy(_p)
      _v.y -= GRAVITY * dtA
      _p.addScaledVector(_v, dtA)
      _seg.copy(_p).sub(_prev)
      const len = _seg.length()
      if (len < 1e-5) continue
      _seg.divideScalar(len)
      const obs = world.raycastObstacles(_prev, _seg, len)
      let endT = -1
      if (obs) endT = obs.dist
      else if (_p.y <= 0) endT = len * (_prev.y / Math.max(1e-5, _prev.y - _p.y))
      const segEnd = endT >= 0 ? endT : len
      if (i >= 1 && segEnd > 0.02) {
        _mid.copy(_prev).addScaledVector(_seg, segEnd * 0.5)
        _q.setFromUnitVectors(_zAxis, _seg)
        _sc.set(1, 1, Math.min(1, segEnd / 0.26))
        _m.compose(_mid, _q, _sc)
        arc.dashes.setMatrixAt(n++, _m)
      }
      if (endT >= 0) {
        _land.copy(_prev).addScaledVector(_seg, endT)
        landed = true
        break
      }
    }
    if (!landed) _land.copy(_p)
    arc.dashes.count = n
    arc.dashes.instanceMatrix.needsUpdate = true
    arc.disc.position.set(_land.x, Math.max(0.035, _land.y + 0.035), _land.z)
    arc.disc.scale.setScalar(molotovRadius)
    arc.discMat.uniforms.uTime.value = st.vt
    arc.group.visible = true
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  useFrame((_state, dt) => {
    const rig = getWeaponRig()
    const arc = getArcAssets()
    const step = Math.min(dt, 0.05)
    st.vt += step
    const s = useGame.getState()
    const running = simRunning(s.phase)
    const locked = document.pointerLockElement !== null

    // visibility follows the equipped slot
    rig.pistol.group.visible = s.weapon === 1
    rig.bat.group.visible = s.weapon === 2
    rig.molotov.group.visible = s.weapon === 3

    // ── sway from look deltas + walk bob (pure visual, always runs) ──
    camera.getWorldDirection(_dir)
    const yaw = Math.atan2(_dir.x, _dir.z)
    const pitch = Math.asin(THREE.MathUtils.clamp(_dir.y, -1, 1))
    let dyaw = yaw - st.lastYaw
    if (dyaw > Math.PI) dyaw -= Math.PI * 2
    else if (dyaw < -Math.PI) dyaw += Math.PI * 2
    const dpitch = pitch - st.lastPitch
    st.lastYaw = yaw
    st.lastPitch = pitch
    const invStep = step > 1e-4 ? 1 / step : 0
    const tx = THREE.MathUtils.clamp(-dyaw * invStep * 0.009, -0.06, 0.06)
    const ty = THREE.MathUtils.clamp(-dpitch * invStep * 0.009, -0.05, 0.05)
    const kSway = 1 - Math.exp(-12 * step)
    st.swayX += (tx - st.swayX) * kSway
    st.swayY += (ty - st.swayY) * kSway

    const pv = world.player.vel
    const speed = Math.hypot(pv.x, pv.z)
    const bobTarget = world.player.onGround && speed > 0.5 ? Math.min(1.25, speed / PLAYER_SPEED) : 0
    st.bobAmt += (bobTarget - st.bobAmt) * (1 - Math.exp(-8 * step))
    st.bobPhase += step * (4.5 + speed * 0.55)
    const bobX = Math.cos(st.bobPhase) * 0.011 * st.bobAmt
    const bobY = -Math.abs(Math.sin(st.bobPhase)) * 0.013 * st.bobAmt

    st.raiseT = Math.min(1, st.raiseT + step * 4.5)
    const raise = (1 - st.raiseT) * (1 - st.raiseT)

    // ADS blend: goal 1 only while held on the equipped revolver mid-combat;
    // reloads and switches force back to hip
    const adsGoal = st.ads && s.weapon === 1 && !st.reloadActive && locked && running ? 1 : 0
    st.adsT += (adsGoal - st.adsT) * (1 - Math.exp(-13 * step))
    const adsUi = st.adsT > 0.5
    if (adsUi !== s.adsRevolver) s.set({ adsRevolver: adsUi })
    const swayK = 1 - 0.85 * st.adsT // sights stay planted while aiming

    rig.sway.position.set(
      (st.swayX * 0.35 + bobX) * swayK,
      (st.swayY * 0.35 + bobY + Math.sin(st.vt * 1.4) * 0.0015) * swayK - raise * 0.28,
      0,
    )
    rig.sway.rotation.set(
      st.swayY * 0.9 * swayK + raise * 0.9,
      st.swayX * 0.9 * swayK,
      -st.swayX * 0.45 * swayK,
    )

    // ── gameplay timers (early-out unless the sim is running) ──
    if (running) {
      if (st.reloadActive && world.time >= st.reloadEnd) completeReload()

      // full-auto pistol: held trigger re-fires at stats.fireInterval cadence
      if (st.triggerHeld && s.weapon === 1 && locked) tryFirePistol()

      if (st.charging && s.weapon === 2 && locked) {
        st.chargeT += step
        st.charge = Math.min(1, st.chargeT / Math.max(0.05, s.stats.batChargeTime))
        const q = Math.min(1, Math.round(st.charge * 50) / 50)
        if (q !== s.batCharge) s.set({ batCharge: q })
      }

      if (st.swingT >= 0) {
        st.swingT += step
        const t = st.swingT / BAT_SWING_TIME
        if (!st.struck && t >= STRIKE_AT) {
          st.struck = true
          doStrike(st.swingCharge)
        }
        if (t >= 1) st.swingT = -1
      }
    }

    if (st.throwT >= 0) {
      st.throwT += step
      if (st.throwT >= THROW_ANIM) st.throwT = -1
    }

    // ── molotov aim arc ──
    if (st.aiming && s.weapon === 3 && running && locked) updateArc(s.stats.molotovRadius)
    else if (arc.group.visible) arc.group.visible = false

    // ── revolver animation ──
    if (rig.pistol.group.visible) {
      // reload timeline — every pose below derives from progress p, never from
      // accumulated state, so a weapon switch mid-reload snaps back clean
      const p = st.reloadActive
        ? THREE.MathUtils.clamp(1 - (st.reloadEnd - world.time) / st.reloadDur, 0, 1)
        : 0
      const dip = st.reloadActive ? Math.sin(p * Math.PI) : 0 // tilt down-left arc
      const open = st.reloadActive // crane swings out, holds, snaps shut in the last ~0.15s
        ? THREE.MathUtils.smoothstep(p, 0.08, 0.26) * (1 - THREE.MathUtils.smoothstep(p, 0.84, 0.93))
        : 0
      const eject = st.reloadActive // ejector-rod flick around mid-reload
        ? THREE.MathUtils.smoothstep(p, 0.36, 0.44) * (1 - THREE.MathUtils.smoothstep(p, 0.5, 0.62))
        : 0
      const flick = st.reloadActive // small wrist snap as the cylinder shuts
        ? THREE.MathUtils.smoothstep(p, 0.86, 0.92) * (1 - THREE.MathUtils.smoothstep(p, 0.93, 0.995))
        : 0

      st.recoil *= Math.exp(-9 * step)
      const g = rig.pistol.group
      // ADS pose: slide the grip so the red-dot sight axis lands dead on the
      // camera axis (adsOffset is the dot's local position within the group)
      const ao = rig.pistol.adsOffset
      const bx = THREE.MathUtils.lerp(PISTOL_POS.x, -ao.x, st.adsT)
      const by = THREE.MathUtils.lerp(PISTOL_POS.y, -ao.y, st.adsT)
      const bz = THREE.MathUtils.lerp(PISTOL_POS.z, ADS_Z - ao.z, st.adsT)
      const rk = 1 - 0.45 * st.adsT // tamer kick while shouldered
      g.position.set(
        bx - dip * 0.055,
        by - dip * 0.15 + st.recoil * 0.012 * rk,
        bz + st.recoil * 0.085 * rk + dip * 0.035,
      )
      g.rotation.set(
        (-dip * 0.78 + flick * 0.1) + st.recoil * 0.28 * rk, // magnum muzzle rise
        0.02 * (1 - st.adsT) + dip * 0.1,
        dip * 0.55 + open * 0.26 - flick * 0.16 - st.recoil * 0.05 * rk, // roll cylinder-side down
      )
      // zoom: blends over whatever the Player set this frame (dodge kick included)
      if (st.adsT > 0.004) {
        const cam = camera as THREE.PerspectiveCamera
        cam.fov += (ADS_FOV - cam.fov) * st.adsT
        cam.updateProjectionMatrix()
      }

      rig.pistol.crane.rotation.z = open * 2.05
      rig.pistol.ejector.position.z = eject * 0.022

      // cylinder: free spin while swung out, else index one chamber per round fired
      if (st.reloadActive) {
        st.cylAngle += step * open * (7 + 30 * eject)
      } else {
        const tgt = Math.max(0, s.stats.magSize - s.ammoInMag) * CYL_STEP
        const off = st.cylAngle - tgt
        if (off > CYL_STEP * 0.5 || off < -CYL_STEP * 1.5) {
          // chambers are 6-fold symmetric — wrap to within one chamber below the
          // target so post-reload (and any hard jump) clicks forward, never rewinds
          st.cylAngle = tgt + ((off % CYL_STEP) + CYL_STEP) % CYL_STEP - CYL_STEP
        }
        st.cylAngle += (tgt - st.cylAngle) * (1 - Math.exp(-25 * step))
      }
      rig.pistol.cylinder.rotation.z = st.cylAngle

      // hammer: snaps back with the recoil spike, drops as it decays (next
      // shot re-spikes recoil, so the drop lands right before the bang)
      rig.pistol.hammer.rotation.x = THREE.MathUtils.smoothstep(st.recoil, 0.15, 0.5) * 0.55

      st.flashT = Math.max(0, st.flashT - step)
      const flashOn = st.flashT > 0
      if (rig.pistol.flash.visible !== flashOn) {
        rig.pistol.flash.visible = flashOn
        rig.pistol.ventFlash.visible = flashOn
      }
      if (flashOn) rig.pistol.flashMat.opacity = Math.min(1, st.flashT / 0.04)
    }

    // ── bat animation ──
    if (rig.bat.group.visible) {
      const g = rig.bat.group
      if (st.swingT >= 0) {
        // swing arc: anticipation baked into the charge pose, fast sweep across the view
        const t = THREE.MathUtils.clamp(st.swingT / BAT_SWING_TIME, 0, 1)
        const a = t * t * (3 - 2 * t)
        const c = st.swingCharge
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
        const c = st.charging ? st.charge : 0
        _tp.set(BAT_POS.x + 0.05 * c, BAT_POS.y + 0.015 * c, BAT_POS.z + 0.10 * c)
        const k = 1 - Math.exp(-16 * step)
        g.position.lerp(_tp, k)
        g.rotation.x += (BAT_ROT.x + 0.30 * c - g.rotation.x) * k
        g.rotation.y += (BAT_ROT.y + 0.55 * c - g.rotation.y) * k
        g.rotation.z += (BAT_ROT.z - 0.18 * c - g.rotation.z) * k
      }
      // charge glow — hard flash at max charge (clearly readable)
      const fadingSwing = st.swingT >= 0 ? st.swingCharge * (1 - st.swingT / BAT_SWING_TIME) : 0
      const glow = st.charging ? st.charge : fadingSwing
      const full = st.charging && st.charge >= 1
      rig.bat.mat.emissiveIntensity = full ? 1.5 + 1.2 * Math.sin(st.vt * 16) : glow * 0.55
      rig.bat.shellMat.opacity = full ? 0.30 + 0.22 * Math.sin(st.vt * 16) : glow * 0.12
      rig.bat.shell.visible = rig.bat.shellMat.opacity > 0.02
    } else if (rig.bat.mat.emissiveIntensity !== 0) {
      rig.bat.mat.emissiveIntensity = 0
      rig.bat.shellMat.opacity = 0
      rig.bat.shell.visible = false
    }

    // ── molotov animation ──
    if (rig.molotov.group.visible) {
      const g = rig.molotov.group
      const throwing = st.throwT >= 0
      const aimPose = st.aiming && !throwing
      const k = 1 - Math.exp(-16 * step)
      if (throwing && st.throwT < 0.14) {
        const tt = st.throwT / 0.14
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

      const bottleVisible = throwing ? st.throwT < 0.07 : s.molotovs > 0
      if (rig.molotov.bottle.visible && !bottleVisible) st.bottleScale = 0.55 // next appearance pops in
      rig.molotov.bottle.visible = bottleVisible
      if (bottleVisible) {
        st.bottleScale += (1 - st.bottleScale) * (1 - Math.exp(-14 * step))
        rig.molotov.bottle.scale.setScalar(st.bottleScale)
      }

      // liquid slosh opposing the sway + flame flicker
      rig.molotov.liquid.rotation.set(st.swayY * 1.2 + Math.sin(st.vt * 3) * 0.04, 0, -st.swayX * 1.5)
      rig.molotov.flameMat.uniforms.uTime.value = st.vt
      rig.molotov.flameMat.uniforms.uFlick.value = 0.78 + 0.16 * Math.sin(st.vt * 23) + 0.06 * Math.sin(st.vt * 61)
      rig.molotov.flame.scale.set(1, 0.9 + 0.12 * Math.sin(st.vt * 17 + 1.3), 1)
      rig.molotov.ember.scale.setScalar(1 + 0.14 * Math.sin(st.vt * 31))
    }
  }, FRAME_PRIO.weapons)

  return <primitive object={getArcAssets().group} />
}
