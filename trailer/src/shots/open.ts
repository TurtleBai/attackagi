import * as THREE from 'three'
import { cueAt, cuesOf } from '../cues'
import type { Shot } from '../engine/timeline'
import { PAL, caption, easeInOut, easeOutExpo, seg } from '../engine/type'
import { H } from '../engine/stage'
import { V, handheld, lookCam, screenCenter, span } from './kit'

// 0:00 — black frame, a single green pixel blinks. It boots into :) and the
// camera rips backwards: the pixel was one dot on the CRT face of a machine the
// size of a building, hanging over the rooftop. "IT WANTS THE ROOF."

const sp = span('open')
const BOOT = cueAt('crtBoot')
const BOOM = cueAt('subBoom')
const sc = new THREE.Vector3()
const tgt = new THREE.Vector3()

// pull-back path (world space; screen-relative points resolved per frame)
const END = V(14, 1.5, -6)
const END_LOOK = V(-15, 15.5, -64)

export const open: Shot = {
  name: 'open',
  start: sp.start,
  end: sp.end,
  setup({ S }) {
    S.agi.faceMode = 'cursor'
    S.agi.look.set(0, 27, 200) // head square to +Z
    S.agi.arms[0].goal.set(-19, 10.5, -49)
    S.agi.arms[1].goal.set(19, 10.5, -49)
    S.agi.snapArms()
    S.vfx.shakeScale = 0
    S.bloom.intensity = 1.6
  },
  update({ S, t }) {
    const a = S.agi
    a.idleGoals(t, 0)
    a.idleGoals(t, 1)
    a.faceMode = t < BOOT ? 'cursor' : 'happy'
    a.glowOverride = t < BOOT ? 1.0 : null
    // the lone pixel blinks with the two CRT blips, then holds for the boot
    const blips = cuesOf('crtBlip')
    a.cursorOn = (t >= blips[0].t && t < blips[0].t + 0.2) || (t >= blips[1].t && t < blips[1].t + 0.2) || t >= blips[1].t + 0.3
    a.haze = t < BOOT ? 0.02 : Math.min(1, 0.3 + (t - BOOT) * 6)
    // boot = reverse power-off: bright line snaps open to the full raster
    a.powerOff = t < BOOT ? 0 : 0.55 * (1 - seg(t, BOOT, BOOT + 0.09))
    screenCenter(t, sc)
    const g = S.grade
    // boot glitch + phosphor flash
    const bootK = t < BOOT ? 0 : Math.max(0, 1 - Math.abs(t - BOOT - 0.03) / 0.09)
    g.u('uGlitch').value = bootK * 0.8
    ;(g.u('uFlash').value as THREE.Vector3).set(0.05, 0.25, 0.12).multiplyScalar(bootK)
    g.u('uChroma').value = 0.6 + bootK * 4

    if (t < BOOT) {
      // macro: creep toward the lone pixel
      const k = seg(t, 0, BOOT)
      lookCam(S, V(sc.x, sc.y, sc.z + 6.5 - 2.5 * k), sc, 30)
      g.u('uVig').value = 1.0
      S.env.group.visible = false
      return
    }
    S.env.group.visible = true
    g.u('uVig').value = 0.55
    // stage 1: snap back far enough to read the whole :)  (BOOT → 1.2)
    const k1 = easeOutExpo(seg(t, BOOT, BOOT + 0.5))
    // stage 2: rip back + crane down to the deck (1.25 → end)
    const k2 = easeInOut(seg(t, BOOT + 0.55, sp.end - 0.1))
    const p1 = V(sc.x, sc.y, sc.z + THREE.MathUtils.lerp(4.0, 15.5, k1))
    const mid = V(9, 13, -20)
    const pos = new THREE.Vector3()
    if (k2 <= 0) pos.copy(p1)
    else {
      const curve = new THREE.CatmullRomCurve3([p1, V(2.5, 25, -36), mid, END], false, 'centripetal')
      curve.getPoint(k2, pos)
    }
    tgt.copy(sc).lerp(END_LOOK, k2)
    const fov = THREE.MathUtils.lerp(t < BOOT + 0.55 ? 30 + 4 * k1 : 34, 47, k2)
    const roll = -0.06 * k2
    lookCam(S, pos, tgt, fov, roll)
    handheld(S, t, 0.004 * k2, 1.1)
  },
  draw({ o, t }) {
    caption(o, t, BOOM - 0.05, sp.end, [['THE AGI IS COMING', PAL.white], ['FOR YOUR ROOF.', PAL.phosphor]], { size: 104, y: H * 0.34 })

  },
}
