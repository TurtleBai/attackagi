import * as THREE from 'three'
import { ARENA_RADIUS } from '@/game/constants'
import { world } from '@/game/world'
import { cueAt, cuesOf } from '../cues'
import { setPose } from '../port/components/Agi.controller'
import type { Stage } from '../engine/stage'
import { W, H } from '../engine/stage'
import type { Shot } from '../engine/timeline'
import {
  PAL, alarmVignette, bossBar, caption, easeInOut, easeOutCubic, hudLine, jumpWarning, seg, stripes,
} from '../engine/type'
import { V, aim, fpsCam, handheld, kick, lerp, lookCam, on, screenCenter, span } from './kit'

// Act 3 — wave five is down. The face flips >:(, the whole floor glows red,
// both hands go up: JUMP! 3 · 2 · 1 … one silent beat in the air … SMASH.

const SMASH_T = cueAt('smash')
const ANG = span('angry')
const FLIP = ANG.start + 0.35
const sc = new THREE.Vector3()

/** Shared smash-phase world: alarm-ring floor telegraph + raised open hands. */
function smashWorld(S: Stage, t: number): void {
  S.agi.mode = 'smashing'
  S.agi.faceMode = 'angry'
  world.time = t
  const tg = world.addTelegraph({
    shape: 'circle', pos: V(0, 0, 0), radius: ARENA_RADIUS, duration: 1,
    payload: { damage: 0, instakill: true, dodgeableByJump: true, tag: 'smash' },
  })
  tg.tStart = 6.75
  tg.tHit = SMASH_T
  S.vfx.telegraphGain = 0.62
  for (const arm of S.agi.arms) {
    arm.goal.set(arm.side * 13, 30, -34)
    arm.flatGoal = 0.55
    setPose(arm, 'open')
  }
  S.agi.snapArms()
  S.obstacles.reset()
}

function raisedHands(S: Stage, t: number): void {
  for (let i = 0; i < 2; i++) {
    const arm = S.agi.arms[i]
    arm.goal.set(arm.side * (13 + Math.sin(t * 3 + i) * 0.4), 30 + Math.sin(t * 2.3 + i * 2) * 0.6, -34)
    arm.rate = 4.5
    arm.flatGoal = 0.55
    arm.aim = null
    arm.pointDir = null
    setPose(arm, 'open')
  }
}

/** Alarm treatment shared by the countdown shots: red vignette pulsing on the beeps. */
function alarmPulse(o: CanvasRenderingContext2D, t: number): number {
  let k = 0
  for (const b of cuesOf('warnBeep', 6.9, 8.5)) if (t >= b.t) k = Math.max(k, 1 - (t - b.t) / 0.22)
  alarmVignette(o, W, H, 0.55 + 0.45 * k)
  return k
}

// ── ANGRY: :) glitches to >:( ───────────────────────────────────────────────

export const angry: Shot = {
  name: 'angry', start: ANG.start, end: ANG.end,
  setup({ S }) {
    S.agi.look.set(0, 22, 40)
    S.agi.arms[0].goal.set(-17, 13, -45)
    S.agi.arms[1].goal.set(17, 13, -45)
    S.agi.snapArms()
    S.vfx.shakeScale = 0
    S.accents[0].color.set(0xff2a1a)
    S.accents[0].intensity = 0
    S.accents[0].distance = 40
  },
  update({ S, t, lt }) {
    const a = S.agi
    const flipped = t >= FLIP
    a.faceMode = flipped ? 'angry' : 'happy'
    a.mode = flipped ? 'smashing' : 'waves'
    for (let i = 0; i < 2; i++) {
      if (flipped) a.combatGoals(t, i)
      else a.idleGoals(t, i)
      a.arms[i].rate = 6
    }
    a.recoil = flipped ? Math.max(a.recoil, 0.25 * Math.exp(-(t - FLIP) * 6)) : 0
    screenCenter(t, sc)
    // low push-in on the monitor, slightly under it
    const push = easeOutCubic(seg(lt, 0, ANG.end - ANG.start))
    const cam = V(sc.x - 2.5, sc.y - 6.5, sc.z + lerp(30, 23, push))
    lookCam(S, cam, V(sc.x, sc.y - 1.2, sc.z), 30, 0.03)
    kick(S, t, t - FLIP, 0.02, 8)
    const gk = Math.max(0, 1 - Math.abs(t - FLIP) / 0.06)
    S.grade.u('uGlitch').value = gk
    S.grade.u('uChroma').value = 0.6 + gk * 5
    ;(S.grade.u('uFlash').value as THREE.Vector3).set(0.35, 0.02, 0.0).multiplyScalar(gk)
    // alarm-red key from below once it turns
    S.accents[0].position.set(sc.x, sc.y - 12, sc.z + 10)
    S.accents[0].intensity = flipped ? 380 * (0.6 + 0.4 * Math.sin(t * 25)) : 0
  },
  draw({ o, t }) {
    hudLine(o, W - 420, 110, 'WAVE', '5 / 5  CLEAR', { t, size: 26 })
    caption(o, t, FLIP, ANG.end, [['THEN IT', PAL.white], ['GETS ANGRY.', PAL.alarmDeep]], { y: H * 0.3 })
  },
}

// ── JUMP! 3 · 2 — one wide shot: the whole floor goes alarm-red, hands up ───

const JW = span('jumpWide'), J1 = span('jump1')

export const jumpWide: Shot = {
  name: 'jumpWide', start: JW.start, end: JW.end,
  setup({ S, t }) {
    smashWorld(S, t)
    S.agi.look.set(0, 2, 24)
    S.vfx.shakeScale = 0
    for (let i = 0; i < 2; i++) {
      const L = S.accents[i]
      L.color.set(0xff2a18)
      L.distance = 45
    }
  },
  update({ S, t, lt }) {
    raisedHands(S, t)
    const push = easeInOut(seg(lt, 0, JW.end - JW.start))
    lookCam(S, V(lerp(-7, -3, push), lerp(11, 8, push), lerp(40, 28, push)), V(0, lerp(10, 13, push), -30), 50, 0.02)
    handheld(S, t, 0.003, 1.2)
    for (let i = 0; i < 2; i++) {
      S.accents[i].intensity = 900 * (0.8 + 0.2 * Math.sin(t * 20))
      S.accents[i].position.copy(S.agi.handPos(i)).add(V(0, -9, 3))
    }
  },
  draw({ o, t }) {
    alarmPulse(o, t)
    caption(o, t, JW.start + 0.05, JW.end, [["IT'S GOING TO", PAL.white], ['SMASH THE ROOF.', PAL.alarmDeep]], { size: 84, y: H * 0.2 })
    const n = t < JW.start + 1 ? 3 : 2
    const since = t - (n === 3 ? JW.start : JW.start + 1)
    jumpWarning(o, `JUMP! ${n}`, W / 2, H * 0.66, t, 0.95, Math.max(0, 1 - since / 0.08) * 0.4)
  },
}

// ── JUMP! 1 — top-down: the entire disc is the kill zone ────────────────────

export const jump1: Shot = {
  name: 'jump1', start: J1.start, end: J1.end,
  setup({ S, t }) {
    smashWorld(S, t)
    S.agi.look.set(0, 0, 0)
    S.vfx.shakeScale = 0
  },
  update({ S, t, lt }) {
    raisedHands(S, t)
    S.vfx.telegraphGain = 0.42
    const k = easeInOut(seg(lt, 0, 1))
    lookCam(S, V(0, lerp(80, 66, k), lerp(34, 28, k)), V(0, 0, -6), 52, lerp(0.0, 0.08, k))
  },
  draw({ o, t }) {
    const pulse = alarmPulse(o, t)
    jumpWarning(o, 'JUMP! 1', W / 2, H * 0.45, t, 1.1, Math.max(0, 1 - (t - J1.start) / 0.08) * 0.4)
    void pulse
  },
}

// ── SILENT: in the air, the palms come down — no sound ──────────────────────

const SIL = span('silent')

export const silent: Shot = {
  name: 'silent', start: SIL.start, end: SIL.end,
  setup({ S, t }) {
    smashWorld(S, t)
    S.agi.look.set(0, 3, 3)
    S.vm.rig.root.visible = true
    S.vm.weapon = 1
    S.vm.onGround = false
    S.vfx.shakeScale = 0
  },
  update({ S, t, lt }) {
    // slow-motion slam: palms fall from 30m toward the deck, flattening
    const k = Math.pow(seg(lt, 0, 0.5), 1.4)
    for (let i = 0; i < 2; i++) {
      const arm = S.agi.arms[i]
      arm.goal.set(arm.side * lerp(12, 6.5, k), lerp(28, 5.5, k), lerp(-30, -2.5, k))
      arm.rate = 40
      arm.flatGoal = lerp(0.6, 1, k)
      setPose(arm, 'open')
    }
    // the jump: 9.5 m/s off the deck under 26 m/s² gravity (game constants)
    const jy = Math.max(0, 9.5 * lt - 13 * lt * lt)
    const eye = V(0, 1.7 + jy, 3.5)
    const up = aim(eye, V(0, lerp(25, 8, k), lerp(-28, -6, k)))
    fpsCam(S, eye, up.yaw, up.pitch + 0.08, 70)
    const g = S.grade
    g.u('uSat').value = 0.45
    // red bounce from the glowing floor up onto the falling palms
    for (let i = 0; i < 2; i++) {
      const L = S.accents[i]
      L.color.set(0xff3020)
      L.distance = 40
      L.intensity = 2600
      L.position.copy(S.agi.handPos(i)).add(V(0, -6, 4))
    }
    g.u('uLetter').value = 0.085 * easeOutCubic(seg(lt, 0, 0.12))
    g.u('uScan').value = 0.3
    ;(g.u('uTint').value as THREE.Vector3).set(1.05, 0.92, 0.92)
  },
}

// ── SMASH: impact. Shockwave, dust, cover sinks, the floor scorches ─────────

const SM = span('smash')
const FIGHTS = SM.start + 0.3

export const smash: Shot = {
  name: 'smash', start: SM.start, end: SM.end,
  setup({ S }) {
    S.agi.mode = 'fighting'
    S.agi.faceMode = 'angry'
    S.agi.look.set(14, 2, 14)
    for (const arm of S.agi.arms) {
      arm.goal.set(arm.side * 11, 0.85, -8)
      arm.flatGoal = 1
      setPose(arm, 'open')
    }
    S.agi.snapArms()
    S.vfx.shakeScale = 0.45
  },
  update({ S, t, lt, dt }) {
    const a = S.agi
    for (let i = 0; i < 2; i++) {
      const arm = a.arms[i]
      arm.goal.set(arm.side * 11, lt < 0.6 ? 0.85 : lerp(0.85, 9, easeInOut(seg(lt, 0.6, 1.4))), -8)
      arm.rate = 4
      arm.flatGoal = lt < 0.6 ? 1 : 0.5
    }
    if (on(t, SM.start, dt)) S.smashImpact()
    const fl = Math.max(0, 1 - lt / 0.14)
    const g = S.grade
    ;(g.u('uFlash').value as THREE.Vector3).set(1, 0.85, 0.75).multiplyScalar(fl * fl * fl * 0.4)
    g.u('uChroma').value = 0.6 + fl * 3
    g.u('uGlitch').value = Math.max(0, 0.3 - lt * 2)
    // low wide from beside the right palm: the deck, the cracks, the giant
    lookCam(S, V(17, 1.3, 9), V(-2, 6, -18), 50, -0.04)
    kick(S, t, lt, 0.09, 5, 26)
    handheld(S, t, 0.004, 1.3)
  },
  draw({ o, t }) {
    caption(o, t, FIGHTS, SM.end, [['NOW FIGHT', PAL.white], ['THE AGI ITSELF.', PAL.alarmDeep]])
    const b = seg(t, SM.start + 0.35, SM.start + 0.6)
    if (b > 0) bossBar(o, W / 2, 70, 760, 1, t, b)
    stripes(o, 0, H - 10, W * seg(t, SM.start, SM.start + 0.3), 10, t, PAL.alarmDeep, 26, 120, 0.8)
  },
}

export type { Stage }
