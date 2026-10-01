import * as THREE from 'three'
import { MOLOTOV_RADIUS } from '@/game/constants'
import { world } from '@/game/world'
import { cueAt, cuesOf } from '../cues'
import { setPose } from '../port/components/Agi.controller'
import type { Robot } from '../port/components/Robots'
import type { Stage } from '../engine/stage'
import { W, H } from '../engine/stage'
import type { Shot, ShotCtx } from '../engine/timeline'
import {
  PAL, ammoReadout, caption, crosshair, easeInOut, easeOutCubic, hudLine, label, seg,
} from '../engine/type'
import {
  V, aim, explode, faceTo, fireAt, fpsCam, handheld, headshot, kick, lerp, lookCam, noise, on,
  robotHead, span, toScreen, walk,
} from './kit'

// Act 2 — the waves. The AGI's hand drops a cluster onto the roof; revolver
// headshots to the logo screens; speedloader reload macro; a purple drone banks
// into its 17 m/s dive and drops on a red circle; a molotov sets the deck on fire.

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

// ── DROP: the hand swings in overhead and lets go ───────────────────────────

const DROP = span('drop')
const HAND_OPEN = cueAt('handOpen')
const LAND = cueAt('robotLand')

export const drop: Shot = {
  name: 'drop', start: DROP.start, end: DROP.end, preroll: 0.45,
  setup({ S }) {
    const a = S.agi
    a.look.set(-1, 1.7, 8)
    a.arms[1].cur.set(10, 18, -26)
    a.arms[1].goal.copy(a.arms[1].cur)
    setPose(a.arms[1], 'grip')
    a.cargoCount[1] = 5
    a.arms[0].goal.set(-19, 10.5, -49)
    a.snapArms()
    S.robots.onLand = (r) => {
      S.vfx.onCratePop({ pos: r.pos.clone() })
      S.vfx.trauma = Math.min(1, S.vfx.trauma + 0.12)
    }
    S.vfx.shakeScale = 0.6
    S.accents[0].color.set(0x9fb4ff)
    S.accents[0].intensity = 14
    S.accents[0].distance = 22
    S.accents[0].position.set(-3, 4, 5)
  },
  update({ S, t, dt }) {
    const a = S.agi
    a.idleGoals(t, 0)
    const arm = a.arms[1]
    arm.goal.set(0.6, 6.4, 0.2)
    arm.rate = 7
    arm.aim = null
    if (t >= HAND_OPEN) {
      setPose(arm, 'open')
      arm.goal.set(1.4, 8.6, -1.2)
      arm.rate = 4
    }
    if (on(t, HAND_OPEN, dt)) {
      a.cargoCount[1] = 0
      const kinds = ['melee', 'ranger', 'tank', 'melee', 'ranger'] as const
      const hand = a.handPos(1)
      kinds.forEach((k, i) => {
        const x = hand.x + (i - 2) * 1.3 + (i % 2) * 0.25
        const z = hand.z + (i % 2 === 0 ? 0.4 : -0.9)
        const y0 = hand.y - 1.4 - (i % 3) * 0.25
        const r = S.robots.spawn(k, V(x, y0, z), Math.PI * 0.05 * (i - 2) + 0.15, i + 2)
        S.robots.drop(r, y0)
        const T = LAND - t + i * 0.012
        r.vy = -(y0 - 13 * T * T) / T
      })
    }
    for (const r of S.robots.list) {
      if (!r.falling && t > LAND + 0.08) walk(r, V(-1.8, 0, 7), 1.6, dt)
    }
    // low worm's-eye, wide lens; hand + falling bots fill the top of frame
    const tilt = easeInOut(seg(t, DROP.start + 0.1, LAND))
    lookCam(S, V(-2.2, 0.55, 7.4), V(0.4, lerp(5.6, 2.2, tilt), -1), 58, 0.05)
    handheld(S, t, 0.006, 1.6)
    kick(S, t, t - LAND, 0.03, 7)
  },
  draw({ o, t }) {
    caption(o, t, LAND - 0.05, DROP.end, [['IT DROPS WAVES', PAL.white], ['OF ROBOTS.', PAL.phosphor]])
    hudLine(o, W - 330, 110, 'WAVE', '1 / 5', { t, size: 26 })
  },
}

// ── GUN: red-dot ADS, three logo headshots on the beat ──────────────────────

const GUN = span('gun')
const REV = cuesOf('revolver', GUN.start, GUN.end).map((c) => c.t)
const GUN_EYE = V(0.6, 1.7, 7.5)

export const gun: Shot = {
  name: 'gun', start: GUN.start, end: GUN.end,
  setup({ S }) {
    const R = S.robots
    const a = R.spawn('melee', V(-2.3, 0, 2.2), 0, 1)
    const b = R.spawn('ranger', V(1.4, 0, 0.6), 0, 4)
    const c = R.spawn('melee', V(4.2, 0, 2.8), 0, 7)
    R.spawn('tank', V(-5.5, 0, -4), 0.3, 3)
    R.spawn('melee', V(6.5, 0, -5), -0.4, 5)
    S.accents[0].color.set(0xc8d4ff)
    S.accents[0].intensity = 16
    S.accents[0].distance = 14
    S.accents[0].position.set(1, 5, 9)
    S.accents[1].color.set(0xff6a50)
    S.accents[1].intensity = 10
    S.accents[1].distance = 12
    S.accents[1].position.set(0, 3, -3)
    for (const r of [a, b, c]) faceTo(r, GUN_EYE)
    S.vm.rig.root.visible = true
    S.vm.weapon = 1
    S.vm.ads = true
    S.vm.adsT = 1
    S.vm.ammo = 6
    S.agi.look.copy(GUN_EYE)
    S.vfx.shakeScale = 0.25
  },
  update({ S, t, dt }) {
    S.agi.idleGoals(t, 0)
    S.agi.idleGoals(t, 1)
    const R = S.robots.list
    for (let i = 0; i < 5; i++) if (!R[i].dead) walk(R[i], GUN_EYE, i < 3 ? 2.2 : 1.6, dt)
    // aim schedule: whip between heads, settle a beat before each shot
    const heads = [0, 1, 2].map((i) => robotHead(R[i], new THREE.Vector3()))
    const aims = heads.map((h) => aim(GUN_EYE, h))
    let yaw: number, pitch: number
    const pre = { yaw: aims[0].yaw + 0.22, pitch: aims[0].pitch - 0.06 }
    const seq = [pre, ...aims]
    const times = [GUN.start, ...REV]
    let k = 0
    while (k < REV.length && t >= times[k + 1] + 0.03) k++
    if (k >= REV.length) {
      yaw = aims[2].yaw; pitch = aims[2].pitch
    } else {
      const t0 = k === 0 ? GUN.start : times[k] + 0.03
      const t1 = times[k + 1] - 0.035
      const e = easeInOut(seg(t, t0, t1))
      yaw = lerp(seq[k].yaw, seq[k + 1].yaw, e)
      pitch = lerp(seq[k].pitch, seq[k + 1].pitch, e)
    }
    // magnum muzzle climb (decays) on top of the aim
    let rec = 0
    for (const rt of REV) if (t >= rt) rec += 0.05 * Math.exp(-(t - rt) * 16)
    fpsCam(S, GUN_EYE, yaw, pitch + rec, 60)
    handheld(S, t, 0.0018, 2.2)
    REV.forEach((rt, i) => { if (on(t, rt, dt)) { S.camera.updateMatrixWorld(); headshot(S, R[i], i === 1 ? -1 : 1) } })
  },
  draw({ o, t, S }) {
    caption(o, t, GUN.start + 0.1, GUN.end, [['SHOOT THEM', PAL.white], ['IN THE HEAD.', '#ff5a4a']], { y: 1080 * 0.25 })
    label(o, t, GUN.start + 0.1, GUN.end, 'REVOLVER', PAL.hazard, 110, 1080 - 120)
    let hit = 0
    for (const rt of REV) if (t >= rt) hit = Math.max(hit, 1 - (t - rt) / 0.16)
    crosshair(o, W / 2, H / 2, 0, 'rgba(255,255,255,0)', hit)
    if (hit > 0) hudLine(o, W / 2 + 60, H / 2 + 60, '', 'HEADSHOT', { t, size: 20, color: '#ff5a4a', alpha: hit })
    ammoReadout(o, W - 260, H - 110, S.vm.ammo, 84)
  },
}

// ── RELOAD: macro on the swing-out cylinder + speedloader ───────────────────

const RLD = span('reload')
const R_OPEN = cueAt('reloadOpen'), R_EJECT = cueAt('reloadEject'), R_IN = cueAt('reloadInsert'), R_SNAP = cueAt('reloadSnap')

interface ReloadProps { loader: THREE.Group; casings: THREE.Mesh[] }
let reloadProps: ReloadProps | null = null

function buildReloadProps(S: Stage): ReloadProps {
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.9, roughness: 0.32 })
  const lead = new THREE.MeshStandardMaterial({ color: 0x7a7a80, metalness: 0.6, roughness: 0.45 })
  const knobMat = new THREE.MeshStandardMaterial({ color: 0x1b1d22, metalness: 0.7, roughness: 0.5 })
  const loader = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0205, 0.0205, 0.006, 20), knobMat)
  body.rotation.x = Math.PI / 2
  body.position.z = 0.019
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.009, 0.016, 14), knobMat)
  knob.rotation.x = Math.PI / 2
  knob.position.z = 0.03
  loader.add(body, knob)
  for (let k = 0; k < 6; k++) {
    const ang = Math.PI / 6 + (k * Math.PI) / 3
    const cx = Math.cos(ang) * 0.0145, cy = Math.sin(ang) * 0.0145
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.0057, 0.0057, 0.03, 12), brass)
    shell.rotation.x = Math.PI / 2
    shell.position.set(cx, cy, 0.0)
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0053, 10, 8), lead)
    tip.scale.set(1, 1, 1.5)
    tip.position.set(cx, cy, -0.016)
    loader.add(shell, tip)
  }
  const casings: THREE.Mesh[] = []
  for (let k = 0; k < 6; k++) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.0059, 0.0059, 0.03, 10), brass)
    c.rotation.x = Math.PI / 2
    casings.push(c)
    S.vm.rig.pistol.crane.add(c)
    S.props.push(c)
  }
  S.vm.rig.pistol.cylinder.add(loader)
  S.props.push(loader)
  return { loader, casings }
}

/** cue-locked progress through the game's reload timeline */
function reloadP(t: number): number {
  const pts: Array<[number, number]> = [
    [RLD.start, 0.02], [R_OPEN, 0.14], [R_EJECT, 0.4], [R_IN, 0.72], [R_SNAP, 0.89], [RLD.end, 0.99],
  ]
  for (let i = 0; i < pts.length - 1; i++) {
    const [ta, pa] = pts[i], [tb, pb] = pts[i + 1]
    if (t <= tb) return lerp(pa, pb, seg(t, ta, tb))
  }
  return 0.99
}

const _q = new THREE.Quaternion()
const _qe = new THREE.Euler()

export const reload: Shot = {
  name: 'reload', start: RLD.start, end: RLD.end,
  setup({ S }) {
    reloadProps ??= buildReloadProps(S)
    S.vm.rig.root.visible = true
    S.vm.weapon = 1
    S.vm.ammo = 0
    S.agi.look.set(0, 1.7, 6)
    S.robots.spawn('melee', V(-1.5, 0, -2), 0, 0)
    S.robots.spawn('ranger', V(2.5, 0, -6), 0, 2)
    S.vfx.shakeScale = 0
    S.accents[0].color.set(0xfff0dc)
    S.accents[0].intensity = 2.2
    S.accents[0].distance = 2.5
    S.accents[1].color.set(0x7090ff)
    S.accents[1].intensity = 1.6
    S.accents[1].distance = 2.5
  },
  update({ S, t, lt }) {
    const vm = S.vm
    const p = reloadP(t)
    vm.reloadP = p
    S.agi.idleGoals(t, 0)
    S.agi.idleGoals(t, 1)
    // camera: low over the deck looking at the AGI; the gun is re-posed in
    // camera space so we see its left (crane) side big in frame
    fpsCam(S, V(0, 1.55, 6), 0.0, 0.12, 30)
    handheld(S, t, 0.003, 1.8)
    void lt
    // props: speedloader seats (0.62→0.78), pulls away (0.8→0.9)
    const pr = reloadProps!
    pr.loader.visible = p > 0.55 && p < 0.92
    const zIn = lerp(0.075, 0.033, easeInOut(seg(p, 0.6, 0.76)))
    pr.loader.position.z = p < 0.8 ? zIn : lerp(0.033, 0.11, seg(p, 0.8, 0.9))
    pr.loader.children.forEach((c, i) => { if (i >= 2) c.visible = p < 0.8 })
    // six spent casings kicked out the rear by the ejector flick
    const te = Math.max(0, p - 0.4) * 1.5
    pr.casings.forEach((c, k) => {
      c.visible = p > 0.4 && p < 0.7
      const ang = Math.PI / 6 + (k * Math.PI) / 3 + vm.cylAngle
      const bx = 0.013 + Math.cos(ang) * 0.0145, by = 0.0175 + Math.sin(ang) * 0.0145
      c.position.set(bx + Math.cos(ang) * te * 0.25, by + te * 0.2 - te * te * 2.6, 0.03 + te * 0.42)
      c.rotation.set(Math.PI / 2 + te * (8 + k), te * (5 - k), 0)
    })
    // keep the macro lit: warm key from upper-left, cool rim behind
    S.camera.updateMatrixWorld()
    S.accents[0].position.copy(S.camera.localToWorld(_b.set(-0.25, 0.25, -0.1)))
    S.accents[1].position.copy(S.camera.localToWorld(_b.set(0.3, 0.1, -0.7)))
  },
  post({ S, lt }) {
    // macro rig: hold the cylinder at a fixed spot in frame, viewed from the
    // crane side, while keeping ~40% of the reload's wrist roll for life
    const rig = S.vm.rig
    const g = rig.pistol.group
    rig.sway.updateMatrix()
    g.updateMatrix()
    rig.pistol.crane.updateMatrix()
    const inner = new THREE.Matrix4().multiplyMatrices(rig.sway.matrix, g.matrix)
    const cyl = rig.pistol.cylinder.position.clone().applyMatrix4(rig.pistol.crane.matrix).applyMatrix4(inner)
    const gq = new THREE.Quaternion().setFromRotationMatrix(inner)
    const damp = new THREE.Quaternion().slerp(gq, 0.4)
    const view = new THREE.Quaternion().setFromEuler(_qe.set(0.3, 1.5 + 0.1 * Math.sin(lt * 4), 0.08, 'YXZ'))
    const q = view.clone().multiply(damp).multiply(gq.clone().invert())
    rig.root.quaternion.copy(q)
    rig.root.position.set(0.035, -0.012, -0.3).sub(cyl.applyQuaternion(q))
  },
  draw({ o, t, S }) {
    const n = t >= R_IN ? 6 : 0
    label(o, t, RLD.start, RLD.end, 'SPEEDLOADER RELOAD', PAL.hazard, 110, H - 120)
    ammoReadout(o, W - 260, H - 110, n, 78)
    void S
  },
}

// ── DRONE: banks into its dive straight at the lens ──────────────────────────

const DRN = span('drone')

interface DroneSim { pos: THREE.Vector3; vel: THREE.Vector3; yaw: number; roll: number; pitch: number }
const dsim: DroneSim = { pos: V(), vel: V(), yaw: 0, roll: 0, pitch: 0 }

function poseDroneGroup(r: Robot, d: DroneSim): void {
  r.pos.set(0, 0, 0)
  r.yaw = 0
  r.group.position.copy(d.pos)
  r.group.quaternion.setFromEuler(_qe.set(d.pitch, d.yaw, d.roll, 'YXZ'))
}

export const drone: Shot = {
  name: 'drone', start: DRN.start, end: DRN.end,
  setup({ S }) {
    const r = S.robots.spawn('drone', V(), 0, 6)
    r.data.speed = 0
    dsim.pos.set(-12, 8.5, -24)
    dsim.vel.set(6, 0, 1)
    dsim.yaw = Math.atan2(7, 1)
    dsim.roll = 0
    dsim.pitch = 0
    S.agi.look.set(0, 2, 4)
    S.vfx.shakeScale = 0
    S.accents[0].color.set(0xb26bff)
    S.accents[0].intensity = 10
    S.accents[0].distance = 9
  },
  update({ S, t, dt, lt }) {
    S.agi.idleGoals(t, 0)
    S.agi.idleGoals(t, 1)
    const r = S.robots.list[0]
    const target = V(1, 1.7, 7)
    // loiter → bank → dive at 17 m/s
    const bank = seg(lt, 0.2, 0.55)
    const dive = seg(lt, 0.42, 1.0)
    _a.copy(target).sub(dsim.pos).normalize().multiplyScalar(lerp(7, 17, easeInOut(dive)))
    const desired = dsim.vel.clone().lerp(_a, bank)
    const prevYaw = dsim.yaw
    dsim.vel.lerp(desired, 1 - Math.exp(-14 * dt))
    dsim.pos.addScaledVector(dsim.vel, dt)
    dsim.yaw = Math.atan2(dsim.vel.x, dsim.vel.z)
    let dyaw = dsim.yaw - prevYaw
    if (dyaw > Math.PI) dyaw -= Math.PI * 2
    if (dyaw < -Math.PI) dyaw += Math.PI * 2
    const yawRate = dyaw / dt
    dsim.roll += (THREE.MathUtils.clamp(-yawRate * 0.32, -0.95, 0.95) - dsim.roll) * (1 - Math.exp(-10 * dt))
    const sp = dsim.vel.length()
    dsim.pitch += (THREE.MathUtils.clamp(-dsim.vel.y / Math.max(sp, 1) * 1.3 + sp * 0.012, -0.2, 0.75) - dsim.pitch) * (1 - Math.exp(-9 * dt))
    poseDroneGroup(r, dsim)
    // camera: hangs ahead of the dive, pulling back as the drone closes in
    const toT = target.clone().sub(dsim.pos).normalize()
    const right = new THREE.Vector3().crossVectors(toT, V(0, 1, 0)).normalize()
    const lead = lerp(2.3, 1.7, easeInOut(dive))
    const cam = dsim.pos.clone().addScaledVector(toT, lead).addScaledVector(right, lerp(0.9, 0.55, dive)).add(V(0, lerp(-0.35, -0.55, dive), 0))
    _b.copy(dsim.pos).add(V(0, 0.4, 0)).addScaledVector(toT, -0.2)
    lookCam(S, cam, _b, 42, -dsim.roll * 0.2)
    handheld(S, t, 0.008, 2.6)
    S.accents[0].position.copy(dsim.pos).add(V(0, -1.2, 1))
  },
  draw({ o, t }) {
    label(o, t, DRN.start + 0.05, DRN.end, 'DRONE', PAL.drone, 110, H - 120)
    void noise
  },
}

// ── DRONE KILL: red circle at your feet, shoot it out of the sky, dodge ─────

const DK = span('droneKill')
const DK_SHOT = cuesOf('revolver', DK.start, DK.end)[0].t
const DK_BOOM = cueAt('explosion', DK.start, DK.end)
const DK_EYE = V(-5, 1.7, 10)

let bombProp: THREE.Group | null = null
function buildBomb(S: Stage): THREE.Group {
  const g = new THREE.Group()
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c33, metalness: 0.7, roughness: 0.45 })
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.32, 10), dark)
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), dark)
  nose.position.y = -0.16
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 6, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.8, 2.6), toneMapped: false }))
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.16
  g.add(body, nose, ring)
  S.scene.add(g)
  S.props.push(g)
  return g
}

export const droneKill: Shot = {
  name: 'droneKill', start: DK.start, end: DK.end,
  setup({ S }) {
    bombProp ??= buildBomb(S)
    const r = S.robots.spawn('drone', V(), 0, 6)
    dsim.pos.copy(DK_EYE).add(V(1.0, 5.2, -9.0))
    dsim.vel.copy(V(0.5, -0.55, 4.2).normalize().multiplyScalar(17))
    dsim.yaw = Math.atan2(dsim.vel.x, dsim.vel.z)
    dsim.roll = -0.35
    dsim.pitch = 0.5
    poseDroneGroup(r, dsim)
    world.time = DK.start
    world.addTelegraph({
      shape: 'circle', pos: V(DK_EYE.x, 0, DK_EYE.z), radius: 2.8, duration: DK_BOOM - DK.start,
      payload: { damage: 22, explosion: true, tag: 'rocket' },
      onResolve: (tg) => explode(S, tg.pos, 2.8, 'rocket'),
    })
    S.vm.rig.root.visible = true
    S.vm.weapon = 1
    S.vm.ammo = 6
    S.agi.look.copy(DK_EYE)
    S.vfx.shakeScale = 0.7
    S.robots.onLand = (rb) => explode(S, rb.pos.clone().setY(0.4), 1.6, 'enemy')
    S.accents[0].color.set(0xb26bff)
    S.accents[0].intensity = 8
    S.accents[0].distance = 8
  },
  update({ S, t, dt }) {
    S.agi.idleGoals(t, 0)
    S.agi.idleGoals(t, 1)
    const r = S.robots.list[0]
    const alive = t < DK_SHOT
    if (alive) {
      dsim.vel.y += 6 * dt // pulls out of the dive overhead
      dsim.pos.addScaledVector(dsim.vel, dt)
      dsim.pitch += (0.15 - dsim.pitch) * (1 - Math.exp(-5 * dt))
      poseDroneGroup(r, dsim)
    } else if (on(t, DK_SHOT, dt)) {
      // hand the wreck to the game's tumble-fall (rotors spool down)
      r.group.position.set(0, 0, 0)
      r.group.quaternion.identity()
      r.pos.copy(dsim.pos)
      r.yaw = dsim.yaw
      r.vy = dsim.vel.y * 0.4
      r.data.vx = dsim.vel.x * 0.6
      r.data.vz = dsim.vel.z * 0.6
      S.camera.updateMatrixWorld()
      fireAt(S, dsim.pos.clone().add(V(0, 0.3, 0)))
      S.robots.kill(r, { tip: 1, roll: 0.6 })
      r.hitFlash = 1
      S.vfx.onEnemyDeath({ pos: dsim.pos.clone(), kind: 'drone' })
    }
    // bomb: released overhead, falls onto the circle centre at the boom
    const bomb = bombProp!
    const rel = cueAt('bombDrop')
    bomb.visible = t >= rel && t < DK_BOOM
    if (bomb.visible) {
      const k = seg(t, rel, DK_BOOM)
      bomb.position.set(lerp(DK_EYE.x + 1.0, DK_EYE.x, k), lerp(5.4, 0.2, k * k), lerp(DK_EYE.z - 4.5, DK_EYE.z, k))
      bomb.rotation.set(0.3 * (1 - k), 0, 0)
    }
    // camera: look up at the dive, track the wreck, dodge right out of the circle
    const dodge = easeOutCubic(seg(t, DK_SHOT + 0.06, DK_SHOT + 0.2))
    const eye = V(DK_EYE.x + dodge * 3.2, 1.7 - 0.25 * Math.sin(dodge * Math.PI), DK_EYE.z + dodge * 0.4)
    const look = alive ? dsim.pos : r.pos
    const a0 = aim(eye, _b.copy(look).add(V(0, 0.4, 0)))
    const back = easeInOut(seg(t, DK_SHOT + 0.12, DK_BOOM - 0.02))
    const circ = aim(eye, V(DK_EYE.x, 0.3, DK_EYE.z))
    const down = aim(eye, V(DK_EYE.x, 0, DK_EYE.z + 0.5))
    const k0 = easeInOut(seg(t, DK.start + 0.06, DK_SHOT - 0.05))
    const yaw = lerp(lerp(down.yaw, a0.yaw, 0.5), a0.yaw, k0)
    const pitch = lerp(lerp(down.pitch, a0.pitch, 0.55), a0.pitch, k0)
    let rec = t >= DK_SHOT ? 0.06 * Math.exp(-(t - DK_SHOT) * 14) : 0
    fpsCam(S, eye, lerp(yaw, circ.yaw, back), lerp(Math.min(pitch, 0.95), circ.pitch, back) + rec, 78, dodge > 0 && dodge < 1 ? -0.06 * Math.sin(dodge * Math.PI) : 0)
    handheld(S, t, 0.004, 2.4)
    rec = 0
    S.vm.speed = dodge > 0 && dodge < 1 ? 14 : 3
    if (on(t, DK_BOOM, dt)) S.vfx.trauma = Math.min(1, S.vfx.trauma + 0.45)
    S.accents[0].position.copy(alive ? dsim.pos : r.pos)
  },
  draw({ o, t, S }) {
    // red-circle warning ticks with the beeps
    const beeps = cuesOf('warnBeep', DK.start, DK.end)
    let flash = 0
    for (const b of beeps) if (t >= b.t) flash = Math.max(flash, 1 - (t - b.t) / 0.1)
    caption(o, t, DK.start + 0.05, DK.end, [['DODGE THE', PAL.white], ['RED CIRCLE.', '#ff4a3a']])
    void flash
    crosshair(o, W / 2, H / 2, 0.2, 'rgba(255,255,255,0.85)', t >= DK_SHOT ? Math.max(0, 1 - (t - DK_SHOT) / 0.18) : 0)
    ammoReadout(o, W - 260, H - 110, S.vm.ammo, 78)
  },
}

// ── MOLOTOV: lob it into the pack, the deck goes up ─────────────────────────

const MOL = span('molotov')
const THROW = cueAt('molotovThrow')
const BREAK = cueAt('glassBreak')
const M_EYE = V(0.5, 1.7, 7)
const M_TARGET = V(-1.4, 0.15, -3.2)

export const molotov: Shot = {
  name: 'molotov', start: MOL.start, end: MOL.end,
  setup({ S }) {
    const R = S.robots
    R.spawn('tank', V(-1.6, 0, -4.4), 0, 3)
    R.spawn('melee', V(-3.6, 0, -2.6), 0, 1)
    R.spawn('melee', V(0.6, 0, -2.4), 0, 5)
    R.spawn('ranger', V(-0.6, 0, -6.4), 0, 0)
    R.spawn('melee', V(4.5, 0, -5), 0, 8)
    for (const r of R.list) faceTo(r, M_EYE)
    // ammo-crate cluster at the edge of the burn
    const c = S.crates[0]
    c.root.visible = true
    c.root.position.set(-5.8, 0, -1.2)
    S.vm.rig.root.visible = true
    S.vm.weapon = 3
    S.vm.aimingMolotov = true
    S.agi.look.copy(M_EYE)
    S.vfx.shakeScale = 0.5
    S.grade.u('uExposure').value = 0.9
    S.bloom.intensity = 1.0
  },
  update({ S, t, dt }) {
    S.agi.idleGoals(t, 0)
    S.agi.idleGoals(t, 1)
    for (const r of S.robots.list) if (!r.dead) walk(r, M_EYE, 1.4, dt)
    const base = aim(M_EYE, V(-0.9, 1.0, -3.5))
    const push = easeOutCubic(seg(t, BREAK, MOL.end)) * 0.8
    const eye = V(M_EYE.x, M_EYE.y, M_EYE.z - push)
    let throwKick = 0
    if (t >= THROW) throwKick = 0.05 * Math.sin(Math.min(1, (t - THROW) / 0.18) * Math.PI)
    fpsCam(S, eye, base.yaw - throwKick * 0.4, base.pitch - throwKick, 78)
    handheld(S, t, 0.004, 1.8)
    kick(S, t, t - BREAK, 0.025, 8)
    if (on(t, THROW, dt)) {
      S.vm.throwBottle()
      S.vm.aimingMolotov = false
      S.camera.updateMatrixWorld()
      const p0 = S.camera.localToWorld(V(0.16, -0.08, -0.45))
      const T = BREAK - THROW
      const vel = M_TARGET.clone().sub(p0).divideScalar(T)
      vel.y += 0.5 * 26 * T
      S.proj.add({ kind: 'molotov', pos: p0, vel, ttl: T, gravityScale: 1, radius: 0.25 })
    }
    if (on(t, BREAK, dt)) {
      explode(S, M_TARGET, MOLOTOV_RADIUS, 'molotov')
      S.vfx.onFireIgnite({ pos: M_TARGET.clone().setY(0), radius: MOLOTOV_RADIUS })
      world.addHazard({ kind: 'fire', pos: M_TARGET.clone().setY(0), radius: MOLOTOV_RADIUS * 0.85, until: t + 6, dps: 22, playerFire: true })
      for (const r of S.robots.list) if (r.pos.distanceTo(M_TARGET) < 4.5) r.hitFlash = 1
    }
    // fire spreads along the deck in licks
    const spread: Array<[number, number, number, number]> = [
      [0.07, -3.6, -1.6, 2.4], [0.13, 1.1, -1.4, 2.2], [0.2, -2.4, 0.4, 2.0], [0.27, 0.6, 0.8, 1.8], [0.33, -4.6, -4.6, 2.2],
    ]
    for (const [dtS, x, z, rad] of spread) {
      if (on(t, BREAK + dtS, dt)) {
        world.addHazard({ kind: 'fire', pos: V(x, 0, z), radius: rad, until: t + 6, dps: 22, playerFire: true })
        S.vfx.onFireIgnite({ pos: V(x, 0, z), radius: rad })
      }
    }
    // the melee bot in the middle of it goes down
    const victim = S.robots.list[2]
    if (on(t, BREAK + 0.22, dt)) {
      S.robots.kill(victim, { tip: -1, roll: 0.3 })
      S.vfx.onEnemyDeath({ pos: victim.pos.clone(), kind: 'melee' })
    }
    for (const r of S.robots.list) if (!r.dead && t > BREAK && r.pos.distanceTo(M_TARGET) < 4.8) r.hitFlash = Math.max(r.hitFlash, 0.35 + 0.35 * Math.sin(t * 40 + r.id))
  },
  draw({ o, t }) {
    caption(o, t, MOL.start + 0.05, MOL.end, [['MOLOTOVS BURN', PAL.white], ['YOU TOO.', PAL.fire]])
    label(o, t, MOL.start + 0.05, MOL.end, 'MOLOTOV', PAL.fire, 110, H - 120)
  },
}

export type { ShotCtx }
