import * as THREE from 'three'
import {
  ARENA_RADIUS, BAT_SWING_TIME, DEATHBEAM_WIDTH, ROCKET_RADIUS, STRIPE_COUNT, STRIPE_GAP, STRIPE_WIDTH,
} from '@/game/constants'
import { world } from '@/game/world'
import { cueAt, cuesOf } from '../cues'
import { HEAD_DOWN, setPose, setRestCurl } from '../port/components/Agi.controller'
import type { Stage } from '../engine/stage'
import { W, H } from '../engine/stage'
import type { Shot } from '../engine/timeline'
import {
  FACE_COLOR, FONT, PAL, bossBar, caption, crosshair, easeInOut, easeOutCubic, easeOutExpo, glitchText, hudLine, label,
  pixelFace, seg, stripes,
} from '../engine/type'
import { V, aim, explode, fireAt, fpsCam, handheld, kick, lerp, lookCam, noise, on, screenCenter, span } from './kit'

// Act 4 — the boss. It ran the fight; now it IS the fight: rocket barrage,
// the instakill death beam sweeping a third of the arena, miniguns + walls of
// beams, hand slams. Then it tires: head and hands come down. Charged bat. :0.

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

function bossWorld(S: Stage): void {
  S.vfx.telegraphGain = 0.55
  S.agi.mode = 'fighting'
  S.agi.faceMode = 'angry'
  S.obstacles.flatten()
  S.scorchNow(0.6)
}

function hpFrac(t: number): number {
  // boss HP drains across the fight → big chunk at the bat crack
  const crack = cueAt('batCrack')
  return t < crack ? lerp(1, 0.62, seg(t, 9.5, crack)) : lerp(0.62, 0.38, easeOutExpo(seg(t, crack, crack + 0.25)))
}

// ── ROCKETS ──────────────────────────────────────────────────────────────────

const RK = span('rockets')

export const rockets: Shot = {
  name: 'rockets', start: RK.start, end: RK.end, preroll: 0.25,
  setup({ S, t }) {
    bossWorld(S)
    S.agi.look.set(4, 2, 10)
    for (const arm of S.agi.arms) {
      arm.goal.set(arm.side * 12, 26, -50)
      setPose(arm, 'point')
      arm.pointDir = V(arm.side * 0.16, 1, -0.06).normalize()
    }
    S.agi.snapArms()
    world.time = t
    // landing telegraphs carpet the deck; descending rockets arrive on tHit
    // all landings stay 8m+ from the lens so the blasts read as blasts, not white-outs
    const spots: Array<[number, number]> = [
      [2, 4], [-4, 1], [7, -1], [-1, -4], [10, 6], [-8, 6], [4, -9], [-6, -10], [13, 0],
      [-12, 2], [9, -12], [-14, -3], [15, 9], [-15, -8], [-9, -16], [17, -7], [0, -14], [-3, 8],
    ]
    spots.forEach(([x, z], i) => {
      const tHit = RK.start + 0.3 + i * 0.03 + (i % 3) * 0.05
      const tg = world.addTelegraph({
        shape: 'circle', pos: V(x, 0, z), radius: ROCKET_RADIUS, duration: 1,
        payload: { damage: 24, explosion: true, tag: 'rocket' },
        onResolve: (tg2) => explode(S, tg2.pos, ROCKET_RADIUS, 'rocket'),
      })
      tg.tStart = tHit - 1.5
      tg.tHit = tHit
      const vy = 34
      S.proj.add({ kind: 'rocket', pos: V(x, 0.25 + vy * (tHit - t), z), vel: V(0, -vy, 0), ttl: tHit - t + 0.05 })
    })
    S.vfx.shakeScale = 0.35
    S.grade.u('uExposure').value = 0.72
  },
  update({ S, t, dt }) {
    // ascending show volley from the pointing fingertips
    for (let i = 0; i < 2; i++) {
      const arm = S.agi.arms[i]
      arm.goal.set(arm.side * 12, 26, -50)
      arm.rate = 4.5
      if (Math.floor(t / 0.06) !== Math.floor((t - dt) / 0.06) && (Math.floor(t / 0.06) % 2) === i) {
        _a.copy(S.agi.handPos(i)).addScaledVector(arm.fingerDir, 3)
        _b.copy(arm.fingerDir).multiplyScalar(22 + Math.random() * 6)
        _b.x += (Math.random() - 0.5) * 7
        _b.z += (Math.random() - 0.5) * 7
        S.proj.add({ kind: 'rocket', pos: _a, vel: _b, ttl: 1.2, gravityScale: 0.35, floorY: -99 })
      }
    }
    lookCam(S, V(3, 1.1, 21), V(-1, 8, -10), 56, 0.03)
    handheld(S, t, 0.005, 2)
  },
  draw({ o, t }) {
    bossBar(o, W / 2, 70, 760, hpFrac(t), t)
    label(o, t, RK.start + 0.05, RK.end, 'ROCKET BARRAGE', PAL.alarm, 110, H - 120)
  },
}

// ── DEATH BEAM ───────────────────────────────────────────────────────────────

const BM = span('beam')
const BEAM_FIRE = cueAt('beamFire')
const BX0 = -24
const BX1 = BX0 + (ARENA_RADIUS * 2) / 3

export const beam: Shot = {
  name: 'beam', start: BM.start, end: BM.end,
  setup({ S, t }) {
    bossWorld(S)
    const c = S.agi.arms[1], o = S.agi.arms[0]
    c.weapon = 'cannon'; c.morphGoal = 1; setPose(c, 'fist')
    c.goal.set(9, 19, -40)
    o.goal.set(-17, 18, -52); setPose(o, 'fist')
    S.agi.snapArms()
    world.time = t
    const NR = Math.ceil(Math.abs(BX1 - BX0) / (DEATHBEAM_WIDTH * 0.85)) + 1
    for (let i = 0; i < NR; i++) {
      const x = lerp(BX0, BX1, i / (NR - 1))
      const tg = world.addTelegraph({
        shape: 'rect', pos: V(x, 0, 0), w: DEATHBEAM_WIDTH, l: ARENA_RADIUS * 2 + 6, yaw: 0, duration: 1,
        payload: { damage: 0, instakill: true, tag: 'deathBeam' },
      })
      tg.tStart = BM.start - 0.9
      tg.tHit = BEAM_FIRE + (i / (NR - 1)) * (BM.end - BEAM_FIRE + 0.05)
    }
    S.vm.rig.root.visible = true
    S.vm.weapon = 1
    S.vm.speed = 11
    S.vfx.shakeScale = 0.5
    S.vfx.telegraphGain = 0.2
    S.grade.u('uExposure').value = 0.82
  },
  update({ S, t, lt, dt }) {
    const c = S.agi.arms[1]
    const prog = seg(t, BEAM_FIRE, BM.end + 0.05)
    const bx = lerp(BX0, BX1, prog)
    c.aim = c.aimVec.set(t < BEAM_FIRE ? BX0 + 4 : bx, 0, 4)
    c.goal.set(lerp(9, bx * 0.35 + 6, prog), 19, -40)
    c.rate = 6
    c.charge = t < BEAM_FIRE ? seg(t, BM.start, BEAM_FIRE) : Math.max(0, 1 - (t - BEAM_FIRE) * 3)
    const firing = t >= BEAM_FIRE
    S.agi.beam.active = firing
    if (firing) {
      S.agi.beam.from.copy(S.agi.handPos(1)).addScaledVector(c.fingerDir, 6.9)
      S.agi.beam.to.set(bx, 0.1, 4)
    }
    if (on(t, BEAM_FIRE, dt)) {
      S.vfx.onBeamFire({ a: S.agi.beam.from.clone(), b: V(BX0, 0, 4), kind: 'deathBeam' })
    }
    // sprinting right out of the swept third, eyes on the cannon
    const eye = V(lerp(-7, 2, easeOutCubic(seg(lt, 0.2, 1.25))), 1.7 + Math.abs(Math.sin(lt * 17)) * 0.06, 9)
    const lk = aim(eye, V(lerp(2, -6, seg(t, BEAM_FIRE, BM.end)), 10, -30))
    fpsCam(S, eye, lk.yaw, lk.pitch, 80, -0.04 + Math.sin(lt * 8.5) * 0.012)
    handheld(S, t, 0.004, 2.2)
    // charge light on the deck / red key from the beam
    S.accents[0].color.set(0xff3a22)
    S.accents[0].distance = 60
    S.accents[0].position.copy(firing ? S.agi.beam.to : S.agi.handPos(1)).setY(firing ? 4 : S.agi.handPos(1).y)
    S.accents[0].intensity = firing ? 2600 : 800 * c.charge
  },
  draw({ o, t }) {
    bossBar(o, W / 2, 70, 760, hpFrac(t), t)
    label(o, t, BM.start + 0.05, BM.end, 'DEATH BEAM  ·  INSTANT KILL', PAL.alarm, 110, H - 120)
  },
}

// ── MINIGUNS + WALLS OF BEAMS ────────────────────────────────────────────────

const MG = span('minigun')

export const minigun: Shot = {
  name: 'minigun', start: MG.start, end: MG.end, preroll: 0.7,
  setup({ S, t }) {
    bossWorld(S)
    for (const arm of S.agi.arms) {
      arm.weapon = 'minigun'
      arm.morphGoal = 1
      arm.spinRate = 46
      arm.spinRateGoal = 46
      setPose(arm, 'fist')
      arm.goal.set(arm.side * 8.5, 12.5, -22)
    }
    S.agi.snapArms()
    world.time = t
    // a stripe barrage resolving into beam walls behind the bullet streams
    S.vfx.telegraphGain = 0.3
    S.grade.u('uExposure').value = 0.82
    // walls run toward the AGI, flanking the frame like a corridor
    for (const [k, x] of [-15, -8.5, 8, 14.5].entries()) {
      const off = x
      const tg = world.addTelegraph({
        shape: 'rect', pos: V(off, 0, -10), w: STRIPE_WIDTH, l: 60, yaw: 0, duration: 1,
        payload: { damage: 35, beam: { duration: 0.5, height: 7 }, tag: 'stripe' },
      })
      tg.tStart = MG.start - 1.4
      tg.tHit = MG.start + 0.08 + k * 0.025
    }
    S.vfx.shakeScale = 0.3
  },
  update({ S, t, dt }) {
    const target = V(0.5, 1.2, 5)
    for (let i = 0; i < 2; i++) {
      const arm = S.agi.arms[i]
      arm.goal.set(arm.side * 8.5 + Math.sin(t * 7 + i) * 0.3, 12.5, -22)
      arm.aim = arm.aimVec.copy(target)
      arm.spinRateGoal = 46
      // 11 rounds/s per gun (game cadence 0.09 s)
      if (Math.floor(t / 0.045) !== Math.floor((t - dt) / 0.045) && Math.floor(t / 0.045) % 2 === i) {
        _a.copy(S.agi.handPos(i)).addScaledVector(arm.fingerDir, 4.6)
        _b.set(target.x + (Math.random() - 0.5) * 6, 0.6 + Math.random() * 2.2, target.z + (Math.random() - 0.5) * 6).sub(_a).normalize().multiplyScalar(26)
        S.proj.add({ kind: 'bossBolt', pos: _a, vel: _b, ttl: 1.6, radius: 0.22 })
        arm.flash = 1
      }
    }
    lookCam(S, V(-1.6, 1.0, 9.5), V(0.5, 8.5, -20), 46, 0.05)
    handheld(S, t, 0.006, 3)
    kick(S, t, 0.05, 0.004, 0, 40)
  },
  draw({ o, t }) {
    bossBar(o, W / 2, 70, 760, hpFrac(t), t)
    label(o, t, MG.start + 0.05, MG.end, 'MINIGUNS  ·  BEAM WALLS', PAL.alarm, 110, H - 120)
  },
}

// ── HAND SLAM (+ the lingering fist takes your shots) ───────────────────────

const SL = span('slam')
const SLAM_T = cueAt('slam')
const SLAM_SHOT = cuesOf('revolver', SL.start, SL.end)[0].t
const SLAM_POS = V(2.4, 0, 1.2)

export const slam: Shot = {
  name: 'slam', start: SL.start, end: SL.end,
  setup({ S, t }) {
    bossWorld(S)
    const r = S.agi.arms[1]
    setPose(r, 'fist'); setPose(S.agi.arms[0], 'fist')
    r.goal.set(SLAM_POS.x, 15, SLAM_POS.z)
    r.flatGoal = 0.85
    S.agi.arms[0].goal.set(-13, 16, -44)
    S.agi.snapArms()
    world.time = t
    const tg = world.addTelegraph({
      shape: 'circle', pos: SLAM_POS, radius: 4.2, duration: 1,
      payload: { damage: 30, explosion: true, tag: 'punch' },
      onResolve: () => explode(S, V(SLAM_POS.x, 0.5, SLAM_POS.z), 4.2, 'punch'),
    })
    tg.tStart = SLAM_T - 1.25
    tg.tHit = SLAM_T
    S.vm.rig.root.visible = true
    S.vm.weapon = 1
    S.vfx.shakeScale = 0.6
    S.grade.u('uExposure').value = 0.8
  },
  update({ S, t, dt }) {
    const r = S.agi.arms[1]
    if (t < SLAM_T - 0.07) { r.goal.set(SLAM_POS.x, 14, SLAM_POS.z); r.rate = 6 }
    else { r.goal.set(SLAM_POS.x, 1.0, SLAM_POS.z); r.rate = 34; r.flatGoal = 1 }
    S.agi.sparkOn[1] = t >= SLAM_T
    const eye = V(-1.6, 1.7, 7.8)
    const lk = aim(eye, V(SLAM_POS.x - 0.4, lerp(4.2, 1.6, seg(t, SLAM_T - 0.1, SLAM_T)), SLAM_POS.z))
    let rec = 0
    if (t >= SLAM_SHOT) rec = 0.05 * Math.exp(-(t - SLAM_SHOT) * 14)
    fpsCam(S, eye, lk.yaw, lk.pitch + rec, 74)
    kick(S, t, t - SLAM_T, 0.07, 7)
    if (on(t, SLAM_T, dt)) S.vfx.trauma = 0.8
    if (on(t, SLAM_SHOT, dt)) {
      S.camera.updateMatrixWorld()
      const hp = S.agi.handPos(1).clone().add(V(-0.8, 1.2, 0.8))
      fireAt(S, hp)
      S.vfx.onBossHit({ pos: hp, amount: 20 })
    }
  },
  draw({ o, t }) {
    bossBar(o, W / 2, 70, 760, hpFrac(t), t)
    crosshair(o, W / 2, H / 2, 0.15, 'rgba(255,255,255,0.85)', t >= SLAM_SHOT ? Math.max(0, 1 - (t - SLAM_SHOT) / 0.15) : 0)
    label(o, t, SL.start + 0.05, SL.end, 'HAND SLAM', PAL.alarm, 110, H - 120)
  },
}

// ── TIRED: :| — the hands and the head come down ────────────────────────────

const TI = span('tired')
const TIRED_AT = TI.start + 0.45

export const tired: Shot = {
  name: 'tired', start: TI.start, end: TI.end,
  setup({ S }) {
    bossWorld(S)
    S.agi.mode = 'fighting'
    S.agi.faceMode = 'hurt'
    S.agi.recoil = 0.9
    for (const arm of S.agi.arms) { arm.goal.set(arm.side * 13, 14, -40); setRestCurl(arm) }
    S.agi.snapArms()
    S.agi.look.set(4, 12, 30)
    S.vfx.shakeScale = 0
    S.accents[0].color.set(0xffb84f)
    S.accents[0].distance = 40
  },
  update({ S, t, lt }) {
    const a = S.agi
    const tiredNow = t >= TIRED_AT
    a.faceMode = tiredNow ? 'tired' : 'hurt'
    a.mode = tiredNow ? 'tired' : 'fighting'
    for (const arm of a.arms) {
      arm.goal.set(arm.side * 9, tiredNow ? 0.8 : 10, tiredNow ? -2 : -30)
      arm.rate = 3.5
      arm.flatGoal = tiredNow ? 1 : 0.3
      setRestCurl(arm)
    }
    a.headDrop = easeInOut(seg(t, TIRED_AT, TI.end)) * 0.75
    a.sparkOn[0] = a.sparkOn[1] = t > TIRED_AT + 0.45
    // start tight on the hurt face, pull back + down to the deck as it sags
    const pull = easeInOut(seg(t, TIRED_AT - 0.1, TI.end))
    const sc = screenCenter(t)
    const close = V(sc.x - 1.5, sc.y - 2.5, sc.z + 17)
    const wide = V(9, 1.6, 6)
    lookCam(S, close.lerp(wide, pull), V(sc.x, sc.y - 0.5, sc.z).lerp(V(-2, 7.5, -30), pull), lerp(30, 50, pull), lerp(-0.03, 0.04, pull))
    handheld(S, t, 0.003, 1.2)
    kick(S, t, lt, 0.015, 10)
    S.accents[0].position.copy(a.headPos).add(V(0, -4, 8))
    S.accents[0].intensity = tiredNow ? 600 : 0
  },
  draw({ o, t }) {
    bossBar(o, W / 2, 70, 760, hpFrac(t), t)
    caption(o, t, TIRED_AT + 0.05, TI.end, [['WHEN IT GETS', PAL.white], ['TIRED...', PAL.tired]])
  },
}

// ── BAT: charge to full, crack the screen → :0 ──────────────────────────────

const BT = span('bat')
const CRACK = cueAt('batCrack')
const SWING = CRACK - BAT_SWING_TIME * 0.42
const BAT_EYE = V(1.2, 1.7, HEAD_DOWN.z + 7.0)

export const bat: Shot = {
  name: 'bat', start: BT.start, end: BT.end,
  setup({ S }) {
    bossWorld(S)
    S.agi.mode = 'tired'
    S.agi.faceMode = 'tired'
    S.agi.headDrop = 1
    S.agi.look.copy(BAT_EYE)
    for (const arm of S.agi.arms) { arm.goal.set(arm.side * 9, 0.8, -2); arm.flatGoal = 1; setRestCurl(arm) }
    S.agi.snapArms()
    S.agi.sparkOn[0] = S.agi.sparkOn[1] = true
    S.vm.rig.root.visible = true
    S.vm.weapon = 2
    S.vm.charging = true
    S.vfx.shakeScale = 0.5
    S.accents[0].color.set(0xffb84f)
    S.accents[0].distance = 18
  },
  update({ S, t, dt }) {
    const a = S.agi
    const vm = S.vm
    if (t < SWING) {
      vm.charging = true
      vm.charge = Math.min(1, seg(t, BT.start, SWING - 0.12))
    }
    if (on(t, SWING, dt)) vm.swing(1)
    const hit = t >= CRACK
    if (on(t, CRACK, dt)) {
      a.faceMode = 'surprised'
      a.recoil = 1
      a.mode = 'dying'
      a.dyingT = 0
      const hp = a.headPos.clone().add(V(0.6, -3.2, 4.2))
      S.vfx.onBatHit({ pos: hp, charged: 1 })
      S.vfx.onBossHit({ pos: hp, amount: 90 })
      S.vfx.trauma = 1
    }
    if (hit) a.dyingT = t - CRACK
    // look up into the lowered monitor; lean into the swing
    const sc = a.headPos.clone().add(V(0, 0.3, 3.7))
    const lk = aim(BAT_EYE, sc)
    const lean = t >= SWING ? Math.sin(seg(t, SWING, SWING + 0.3) * Math.PI) : 0
    const pre = seg(t, BT.start, SWING) * 0.03
    fpsCam(S, V(BAT_EYE.x - lean * 0.25, BAT_EYE.y - lean * 0.08, BAT_EYE.z - lean * 0.3), lk.yaw - lean * 0.12 + pre, lk.pitch - 0.08 + pre * 0.5, 82, lean * 0.06)
    handheld(S, t, 0.004, 2)
    kick(S, t, t - CRACK, 0.09, 6, 30)
    // hit-stop flash + chroma
    const fk = hit ? Math.max(0, 1 - (t - CRACK) / 0.12) : 0
    ;(S.grade.u('uFlash').value as THREE.Vector3).set(1, 0.9, 0.7).multiplyScalar(fk * fk * fk * 0.35)
    S.grade.u('uChroma').value = 0.35 + fk * 3
    S.grade.u('uGlitch').value = fk * 0.25
    S.accents[0].position.copy(S.camera.position).add(V(0, 1, -1))
    S.accents[0].intensity = vm.charge >= 1 && !hit ? 30 + 20 * Math.sin(t * 16) : 8 * vm.charge
  },
  draw({ o, t, S }) {
    bossBar(o, W / 2, 70, 760, hpFrac(t), t)
    caption(o, t, BT.start + 0.05, CRACK, [['...HIT IT', PAL.white], ['IN THE FACE.', PAL.fire]])
    if (t < SWING) {
      const c = S.vm.charge
      o.save()
      o.fillStyle = 'rgba(8,10,18,0.6)'
      o.fillRect(W / 2 - 160, H / 2 + 110, 320, 12)
      o.fillStyle = c >= 1 ? (Math.floor(t * 16) % 2 ? '#fff3c4' : PAL.fire) : PAL.fire
      o.shadowColor = PAL.fire
      o.shadowBlur = 14
      o.fillRect(W / 2 - 157, H / 2 + 113, 314 * c, 6)
      o.restore()
      hudLine(o, W / 2 - 160, H / 2 + 146, '', c >= 1 ? 'FULL CHARGE' : 'CHARGING', { t, size: 20, color: PAL.fire })
    }
  },
}

// ── UNPLUG: :0, and the CRT powers down ─────────────────────────────────────

const UP = span('unplug')
const OFF = cueAt('crtOff')

export const unplug: Shot = {
  name: 'unplug', start: UP.start, end: UP.end,
  setup({ S }) {
    bossWorld(S)
    S.agi.mode = 'dying'
    S.agi.dyingT = 0.3
    S.agi.faceMode = 'surprised'
    S.agi.headDrop = 1
    S.agi.look.set(0, 3.5, HEAD_DOWN.z + 30)
    for (const arm of S.agi.arms) { arm.goal.set(arm.side * 9, 0.8, -2); arm.flatGoal = 1; setRestCurl(arm) }
    S.agi.snapArms()
    S.vfx.shakeScale = 0
  },
  update({ S, t, lt }) {
    const a = S.agi
    a.dyingT = 0.3 + lt
    a.powerOff = easeInOut(seg(t, OFF, UP.end - 0.06))
    a.glowOverride = 0.85
    const sc = a.headPos.clone().add(V(0, 0.2, 3.7))
    const push = easeOutCubic(seg(lt, 0, 0.5))
    lookCam(S, V(sc.x + 0.4, sc.y - 0.4, sc.z + lerp(15, 12.5, push)), sc, 34, 0.02)
    // the room dims with the screen
    const dim = seg(t, OFF + 0.1, UP.end)
    S.key.intensity = lerp(1.6, 0.3, dim)
    S.hemi.intensity = lerp(0.85, 0.2, dim)
    S.grade.u('uVig').value = lerp(0.55, 1, dim)
  },
  draw({ o, t }) {
    const k = seg(t, OFF + 0.04, OFF + 0.12)
    if (k > 0) {
      const g = Math.max(0, 1 - (t - OFF - 0.04) / 0.2) * 0.4
      glitchText(o, 'UNPLUG IT.', W / 2, H * 0.86, {
        size: 170, align: 'center', color: PAL.white, t, glitch: g, glow: 26, glowColor: 'rgba(65,255,140,0.7)', alpha: k, tracking: 0.06, seed: 81,
      })
    }
  },
}

// ── TITLE ────────────────────────────────────────────────────────────────────

const TT = span('title')

export const title: Shot = {
  name: 'title', start: TT.start, end: TT.end,
  setup({ S }) {
    S.agi.root.visible = false
    S.env.group.visible = false
    S.vfx.shakeScale = 0
    S.key.intensity = 0
    S.hemi.intensity = 0
    S.fill.intensity = 0
  },
  update({ S, lt }) {
    lookCam(S, V(0, 500, 0), V(0, 600, -1), 40)
    S.grade.u('uVig').value = 0.8
    S.grade.u('uScan').value = 0.22
    S.grade.u('uGlitch').value = Math.max(0, 0.5 - lt * 3) + (lt > 1.32 && lt < 1.36 ? 0.4 : 0)
    S.grade.u('uOverlayChroma').value = Math.max(0.35, 2.4 - lt * 8)
  },
  draw({ o, t }) {
    const lt = t - TT.start
    // the CRT afterglow dot from the previous shot blooms into a scan line, then the title
    o.fillStyle = '#000'
    o.fillRect(0, 0, W, H)
    const open = easeOutExpo(seg(lt, 0, 0.16))
    if (lt < 0.2) {
      const lw = W * open
      const g = o.createLinearGradient(W / 2 - lw / 2, 0, W / 2 + lw / 2, 0)
      g.addColorStop(0, 'rgba(65,255,140,0)')
      g.addColorStop(0.5, 'rgba(210,255,225,1)')
      g.addColorStop(1, 'rgba(65,255,140,0)')
      o.fillStyle = g
      o.fillRect(W / 2 - lw / 2, H / 2 - 3 - 40 * open * open, lw, 6 + 80 * open * open)
    }
    const k = seg(lt, 0.08, 0.2)
    if (k > 0) {
      // faint raster texture behind the type
      o.save()
      o.globalAlpha = 0.06 * k
      o.fillStyle = PAL.phosphor
      for (let y = 0; y < H; y += 4) o.fillRect(0, y, W, 1)
      o.restore()
      o.save()
      o.font = `500 22px ${FONT.hud}`
      ;(o as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '11px'
      o.fillStyle = 'rgba(252,211,77,0.85)'
      o.textAlign = 'center'
      o.globalAlpha = seg(lt, 0.2, 0.35)
      o.fillText('/// PERIMETER DEFENSE TERMINAL v2.7', W / 2, H * 0.355)
      o.restore()
      glitchText(o, 'ATTACK AGI', W / 2 + 22, H * 0.55, {
        size: 250, align: 'center', color: PAL.white, t, glitch: Math.max(0, 0.9 - lt * 3.2), glow: 34,
        glowColor: 'rgba(65,255,140,0.55)', tracking: 0.14, alpha: k, seed: 91, rate: 30,
      })
      stripes(o, W / 2 - 640, H * 0.6, 1280 * easeOutCubic(seg(lt, 0.2, 0.45)), 10, t, PAL.hazard, 26, 40, 0.85)
      const tl = 'Survive the waves. Unplug the machine.'
      const r = seg(lt, 0.42, 0.85)
      glitchText(o, tl, W / 2, H * 0.695, {
        size: 54, weight: 500, align: 'center', color: 'rgba(225,235,255,0.92)', t, reveal: r < 1 ? r : undefined,
        tracking: 0.06, glow: 8, glowColor: 'rgba(65,255,140,0.35)', seed: 92,
      })
      pixelFace(o, 'happy', W / 2, H * 0.22, 7, FACE_COLOR.happy, t, 24)
      void noise
    }
  },
}
