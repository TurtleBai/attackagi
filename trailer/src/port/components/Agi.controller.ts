import * as THREE from 'three'
import type { BossFace } from '@/game/types'
import type { AgiState } from '@/game/world'
import { createFaceScreen, type FaceScreen } from './Agi.face'
import {
  ARM_SEGMENTS, HEAD_CENTER, SEG_RADIUS, SHOULDER_LOCAL,
  buildAgiRig, type AgiRig, type ArmRig,
} from './Agi.rig'
import { darkMetalMaterial } from '@/game/gfx/materials'

// Ported from Agi.tsx: hand poses, arm bezier layout, hand orientation, finger
// instancing and the always-on visual pass are verbatim. The boss AI (drops,
// smash, patterns) is replaced by shot choreography that writes arm goals
// directly. Trailer additions: CRT boot/power-off modes for the face screen,
// and the tired-window head descent on stretched neck cables (the docs'
// "lowers hands + head onto the arena").

const UP = new THREE.Vector3(0, 1, 0)
const SPLAY = [0.16, 0.05, -0.05, -0.16]

export type HandPose = 'open' | 'grip' | 'point' | 'fist'
const POSES: Record<HandPose, { curl: readonly number[]; spread: number }> = {
  open: { curl: [0.1, 0.1, 0.1, 0.1], spread: 1 },
  grip: { curl: [0.78, 0.86, 0.86, 0.8], spread: 0.35 },
  point: { curl: [0.03, 1.05, 1.12, 1.08], spread: 0.15 },
  fist: { curl: [1.22, 1.28, 1.28, 1.22], spread: 0.1 },
}

// module-scope scratch (never allocated per-frame)
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _eb = new THREE.Vector3()
const _d = new THREE.Vector3()
const _d2 = new THREE.Vector3()
const _f = new THREE.Vector3()
const _h = new THREE.Vector3()
const _n = new THREE.Vector3()
const _x = new THREE.Vector3()
const _z = new THREE.Vector3()
const _root = new THREE.Vector3()
const _m4 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _pp = new THREE.Vector3()
const _c = new THREE.Color()
// dynamic whole-boss bounds accumulator + offscreen-gate frustum scratch
const _bMin = new THREE.Vector3()
const _bMax = new THREE.Vector3()
const _frustum = new THREE.Frustum()
const _projScreen = new THREE.Matrix4()
const _camInv = new THREE.Matrix4()

// ─── partial-buffer uploads ──────────────────────────────────────────────────
// Attach an update range covering only the touched span, reusing one retained
// range object per attribute (three clears `updateRanges` after each consumed
// upload, and addUpdateRange() would allocate every frame). If the previous
// range is still pending (mesh was frustum-culled), widen it instead so no
// dirty span is ever dropped.
const _ranges = new WeakMap<THREE.BufferAttribute, { start: number; count: number }>()
function pushUpdateRange(attr: THREE.BufferAttribute, start: number, count: number): void {
  let r = _ranges.get(attr)
  if (!r) {
    r = { start: 0, count: 0 }
    _ranges.set(attr, r)
  }
  const arr = attr.updateRanges as { start: number; count: number }[]
  if (arr.length > 0 && arr[arr.length - 1] === r) {
    const end = Math.max(r.start + r.count, start + count)
    r.start = Math.min(r.start, start)
    r.count = end - r.start
  } else {
    r.start = start
    r.count = count
    arr.push(r)
  }
  attr.needsUpdate = true
}

export interface ArmCtl {
  side: number // -1 left, +1 right
  goal: THREE.Vector3
  cur: THREE.Vector3
  rate: number // goal-chasing rate (1/s)
  pts: THREE.Vector3[] // bezier samples, ARM_SEGMENTS+1
  curl: number[]
  curlGoal: number[]
  spread: number
  spreadGoal: number
  flat: number // 0..1 palm-flat-on-ground blend
  flatGoal: number
  aim: THREE.Vector3 | null // world point the fingers/weapon aim at
  aimVec: THREE.Vector3
  pointDir: THREE.Vector3 | null // explicit finger direction (skyward etc.)
  fingerDir: THREE.Vector3 // computed every frame; muzzle direction
  weapon: 'none' | 'minigun' | 'cannon'
  morph: number
  morphGoal: number
  spin: number
  spinRate: number
  spinRateGoal: number
  flash: number
  charge: number
}
export function makeArm(side: number): ArmCtl {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= ARM_SEGMENTS; i++) pts.push(new THREE.Vector3())
  return {
    side,
    goal: new THREE.Vector3(side * 19, 10.5, -49),
    cur: new THREE.Vector3(side * 19, 10.5, -49),
    rate: 2.6,
    pts,
    curl: [0.1, 0.1, 0.1, 0.1],
    curlGoal: [0.1, 0.1, 0.1, 0.1],
    spread: 1,
    spreadGoal: 1,
    flat: 0,
    flatGoal: 0,
    aim: null,
    aimVec: new THREE.Vector3(),
    pointDir: null,
    fingerDir: new THREE.Vector3(0, -1, 0),
    weapon: 'none',
    morph: 0,
    morphGoal: 0,
    spin: 0,
    spinRate: 0,
    spinRateGoal: 0,
    flash: 0,
    charge: 0,
  }
}

export function setPose(arm: ArmCtl, pose: HandPose): void {
  const p = POSES[pose]
  for (let f = 0; f < 4; f++) arm.curlGoal[f] = p.curl[f]
  arm.spreadGoal = p.spread
}

export function setRestCurl(arm: ArmCtl): void {
  for (let f = 0; f < 4; f++) arm.curlGoal[f] = 0.38
  arm.spreadGoal = 0.6
}
// ─── per-frame visual pass (runs in every phase) ─────────────────────────────

/** Returns true when the hand orientation has converged onto its target. */
function orientHand(ctl: ArmCtl, hand: THREE.Group, tangent: THREE.Vector3, step: number): boolean {
  _f.copy(tangent)
  if (ctl.aim) _f.copy(ctl.aim).sub(hand.position).normalize()
  else if (ctl.pointDir) _f.copy(ctl.pointDir)
  if (ctl.flat > 0.001) {
    _h.set(_f.x, 0, _f.z)
    if (_h.lengthSq() < 1e-4) _h.set(0, 0, 1)
    _h.normalize()
    _f.lerp(_h, ctl.flat).normalize()
  }
  // palm normal: world-down projected perpendicular to the fingers
  _n.set(0, -1, 0).addScaledVector(_f, _f.y)
  if (_n.lengthSq() < 0.03) _n.set(0, 0, 1).addScaledVector(_f, -_f.z)
  _n.normalize()
  // basis: local +Y = fingers, local +Z = back of hand
  _z.copy(_n).multiplyScalar(-1)
  _x.crossVectors(_f, _z)
  if (_x.lengthSq() < 1e-5) _x.set(1, 0, 0)
  _x.normalize()
  _z.crossVectors(_x, _f).normalize()
  _m4.makeBasis(_x, _f, _z)
  _q.setFromRotationMatrix(_m4)
  hand.quaternion.slerp(_q, 1 - Math.exp(-9 * step))
  ctl.fingerDir.copy(_f)
  return hand.quaternion.angleTo(_q) < 0.0015
}

/**
 * Lays the arm's bezier out into the shared instance buffers, expands the
 * frame's whole-boss bounds accumulator (_bMin/_bMax) over every sample, and
 * returns true when position + orientation have converged onto their goals.
 */
function layoutArm(ctl: ArmCtl, rig: AgiRig, armIdx: number, rootPos: THREE.Vector3, step: number): boolean {
  ctl.cur.lerp(ctl.goal, 1 - Math.exp(-ctl.rate * step))
  if (ctl.cur.y < 0.6) ctl.cur.y = 0.6
  // quadratic bezier: shoulder → raised/outward elbow → hand
  const dist = rootPos.distanceTo(ctl.cur)
  _eb.copy(rootPos).add(ctl.cur).multiplyScalar(0.5)
  _eb.x += ctl.side * (2.5 + dist * 0.08)
  _eb.y += Math.max(2, 5 + dist * 0.14 - Math.max(0, ctl.cur.y - rootPos.y) * 0.55)
  for (let i = 0; i <= ARM_SEGMENTS; i++) {
    const u = i / ARM_SEGMENTS
    const a = (1 - u) * (1 - u)
    const b = 2 * (1 - u) * u
    const c = u * u
    const p = ctl.pts[i]
    p.set(
      a * rootPos.x + b * _eb.x + c * ctl.cur.x,
      a * rootPos.y + b * _eb.y + c * ctl.cur.y,
      a * rootPos.z + b * _eb.z + c * ctl.cur.z,
    )
    // dynamic bounds: every bezier sample, padded by the fattest segment.
    // The hand sample gets a bigger pad below (fingers/cannon reach ~9m).
    if (p.x - 1.8 < _bMin.x) _bMin.x = p.x - 1.8
    if (p.x + 1.8 > _bMax.x) _bMax.x = p.x + 1.8
    if (p.y - 1.8 < _bMin.y) _bMin.y = p.y - 1.8
    if (p.y + 1.8 > _bMax.y) _bMax.y = p.y + 1.8
    if (p.z - 1.8 < _bMin.z) _bMin.z = p.z - 1.8
    if (p.z + 1.8 > _bMax.z) _bMax.z = p.z + 1.8
  }
  const nJoint = ARM_SEGMENTS - 1
  for (let i = 0; i < ARM_SEGMENTS; i++) {
    const a = ctl.pts[i]
    const b = ctl.pts[i + 1]
    _d.copy(b).sub(a)
    const len = Math.max(0.01, _d.length())
    _d.divideScalar(len)
    // segment (piston rod baked into its geometry): instance of segs[i]
    _pp.copy(a).addScaledVector(_d, len * 0.5)
    _q2.setFromUnitVectors(UP, _d)
    _m4.compose(_pp, _q2, _s.set(1, len, 1))
    rig.segs[i].setMatrixAt(armIdx, _m4)
    if (i > 0) {
      // joint collar (unit radius, xz-scaled per joint) + loop ring on odd joints
      _d2.copy(b).sub(ctl.pts[i - 1]).normalize()
      _q2.setFromUnitVectors(UP, _d2)
      const r = SEG_RADIUS[i]
      _m4.compose(a, _q2, _s.set(r + 0.24, 1, r + 0.24))
      rig.collars.setMatrixAt(armIdx * nJoint + (i - 1), _m4)
      if (i % 2 === 1) {
        const ls = r + 0.3
        _m4.compose(a, _q2, _s.set(ls, ls, ls))
        rig.loops.setMatrixAt(armIdx * 3 + (i - 1) / 2, _m4)
      }
    }
  }
  _m4.makeTranslation(rootPos.x, rootPos.y, rootPos.z)
  rig.shoulders.setMatrixAt(armIdx, _m4)
  const hand = rig.arms[armIdx].hand.group
  hand.position.copy(ctl.cur)
  // hand sample pad: fingers ~5.5m, morphed cannon + charge sphere ~8.5m
  if (ctl.cur.x - 9 < _bMin.x) _bMin.x = ctl.cur.x - 9
  if (ctl.cur.x + 9 > _bMax.x) _bMax.x = ctl.cur.x + 9
  if (ctl.cur.y - 9 < _bMin.y) _bMin.y = ctl.cur.y - 9
  if (ctl.cur.y + 9 > _bMax.y) _bMax.y = ctl.cur.y + 9
  if (ctl.cur.z - 9 < _bMin.z) _bMin.z = ctl.cur.z - 9
  if (ctl.cur.z + 9 > _bMax.z) _bMax.z = ctl.cur.z + 9
  _d.copy(ctl.pts[ARM_SEGMENTS]).sub(ctl.pts[ARM_SEGMENTS - 1]).normalize()
  const oriented = orientHand(ctl, hand, _d, step)
  return oriented && ctl.cur.distanceToSquared(ctl.goal) < 1e-4
}

/**
 * Push the finger phalanx group world transforms into the shared instanced
 * meshes. The instanced meshes are children of `model` (so they hide with it),
 * and model only ever translates — subtract its position to go world → local.
 */
function syncFingerInstances(rig: AgiRig): void {
  rig.root.updateMatrixWorld(true)
  const mp = rig.model.position
  for (let h = 0; h < 2; h++) {
    const fingers = rig.arms[h].hand.fingers
    for (let f = 0; f < 4; f++) {
      const idx = h * 4 + f
      const fr = fingers[f]
      writeWorldInstance(rig.fingerLevels[0], idx, fr.root, mp)
      writeWorldInstance(rig.fingerLevels[1], idx, fr.mid, mp)
      writeWorldInstance(rig.fingerLevels[2], idx, fr.tip, mp)
    }
  }
  // all 8 fingers are always live → range the full 8×mat4 span explicitly
  for (const lv of rig.fingerLevels) pushUpdateRange(lv.instanceMatrix, 0, 8 * 16)
}

function writeWorldInstance(im: THREE.InstancedMesh, idx: number, o: THREE.Object3D, modelPos: THREE.Vector3): void {
  _m4.copy(o.matrixWorld)
  const e = _m4.elements
  e[12] -= modelPos.x
  e[13] -= modelPos.y
  e[14] -= modelPos.z
  im.setMatrixAt(idx, _m4)
}

/** Returns true when curls/spread/flat/morph/spin/flash have all converged. */
function updateHand(ctl: ArmCtl, rig: ArmRig, step: number): boolean {
  const k = 1 - Math.exp(-10 * step)
  const forceFist = ctl.morph > 0.25
  let settled = true
  for (let f = 0; f < 4; f++) {
    const goal = forceFist ? 1.3 : ctl.curlGoal[f]
    ctl.curl[f] += (goal - ctl.curl[f]) * k
    if (Math.abs(ctl.curl[f] - goal) >= 2e-3) settled = false
    const c = ctl.curl[f]
    const fr = rig.hand.fingers[f]
    fr.root.rotation.x = -(0.1 + c * 0.85)
    fr.mid.rotation.x = -(0.06 + c * 1.05)
    fr.tip.rotation.x = -(0.05 + c * 0.9)
    fr.root.rotation.z = SPLAY[f] * ctl.spread
  }
  ctl.spread += ((forceFist ? 0.1 : ctl.spreadGoal) - ctl.spread) * k
  ctl.flat += (ctl.flatGoal - ctl.flat) * (1 - Math.exp(-6 * step))
  ctl.morph += (ctl.morphGoal - ctl.morph) * (1 - Math.exp(-5 * step))
  const mg = rig.hand.minigun
  const cn = rig.hand.cannon
  const showM = ctl.weapon === 'minigun' && ctl.morph > 0.02
  mg.group.visible = showM
  if (showM) mg.group.scale.setScalar(0.01 + 0.99 * ctl.morph)
  const showC = ctl.weapon === 'cannon' && ctl.morph > 0.02
  cn.group.visible = showC
  if (showC) cn.group.scale.setScalar(0.01 + 0.99 * ctl.morph)
  ctl.spinRate += (ctl.spinRateGoal - ctl.spinRate) * (1 - Math.exp(-1.7 * step))
  ctl.spin += ctl.spinRate * step
  mg.spinner.rotation.y = ctl.spin
  ctl.flash = Math.max(0, ctl.flash - step * 13)
  mg.flashMat.opacity = Math.min(1, ctl.flash)
  cn.charge.scale.setScalar(0.01 + ctl.charge * 1.5)
  cn.chargeMat.opacity = THREE.MathUtils.clamp(ctl.charge, 0, 1)
  return settled &&
    Math.abs(ctl.spread - (forceFist ? 0.1 : ctl.spreadGoal)) < 1e-3 &&
    Math.abs(ctl.flat - ctl.flatGoal) < 1e-3 &&
    Math.abs(ctl.morph - ctl.morphGoal) < 1e-3 &&
    Math.abs(ctl.spinRate) < 1e-3 && Math.abs(ctl.spinRateGoal) < 1e-3 &&
    ctl.flash < 1e-3
}


// ─── Trailer controller ──────────────────────────────────────────────────────

export type FaceMode = BossFace | 'cursor' | 'blank'

/** Tired-window head rest point: in front of the hands, screen-height ~= bat swing. */
export const HEAD_DOWN = new THREE.Vector3(0, 6.2, -24)

const CABLE_N = 5

/** CRT power-off: collapse to a bright line, then to a dot, then fade. */
function patchFaceShader(face: FaceScreen): void {
  const m = face.material
  m.uniforms.uOff = { value: 0 }
  m.uniforms.uHaze = { value: 1 }
  m.fragmentShader = m.fragmentShader
    .replace('uniform vec3 uFaceColor;', 'uniform vec3 uFaceColor;\nuniform float uOff;\nuniform float uHaze;')
    .replace('vec3 haze = uFaceColor * (0.055 + 0.05 * uGlow);', 'vec3 haze = uFaceColor * (0.055 + 0.05 * uGlow) * uHaze;')
    .replace(
      'vec2 uv = curve(vUv);\n  vec3 col = vec3(0.008, 0.010, 0.016);\n  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {\n    vec3 face = texture2D(uMap, uv).rgb;',
      `vec2 uvS = curve(vUv);
  float offA = smoothstep(0.0, 0.42, uOff);
  float offB = smoothstep(0.42, 0.78, uOff);
  float offC = smoothstep(0.78, 1.0, uOff);
  vec2 offSc = vec2(mix(1.0, 0.012, offB), mix(1.0, 0.018, offA));
  vec2 uv = (uvS - 0.5) / offSc + 0.5;
  vec3 col = vec3(0.008, 0.010, 0.016);
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
    vec3 face = mix(texture2D(uMap, uv).rgb, vec3(0.75, 1.0, 0.85), offA);`,
    )
    .replace(
      '  gl_FragColor = vec4(col, 1.0);',
      `  col *= 1.0 + offA * 2.0 + offB * 5.0;
  col *= 1.0 - offC;
  vec2 offD = (uvS - 0.5) * vec2(12.4, 7.9);
  col += vec3(0.7, 1.0, 0.8) * 3.5 * offB * (1.0 - offC * 0.7) * exp(-dot(offD, offD) * 6.0);
  gl_FragColor = vec4(col, 1.0);`,
    )
  if (!m.fragmentShader.includes('offSc') || !m.fragmentShader.includes('* uHaze') || !m.fragmentShader.includes('offD')) {
    throw new Error('CRT face shader patch did not apply')
  }
  m.needsUpdate = true
}

export class AgiController {
  readonly face: FaceScreen
  readonly rig: AgiRig
  readonly arms: [ArmCtl, ArmCtl]
  mode: AgiState['mode'] = 'waves'
  faceMode: FaceMode = 'happy'
  /** null → game glow curve for the mode */
  glowOverride: number | null = null
  /** CRT power-off progress 0..1 */
  powerOff = 0
  /** phosphor haze multiplier (0 → black glass, for the cold open) */
  haze = 1
  /** cursor mode: is the lone pixel lit this frame */
  cursorOn = false
  recoil = 0
  dyingT = -1
  /** what the head + tentacle eyes track (player eye position) */
  readonly look = new THREE.Vector3(0, 1.7, 8)
  /** 0 = head on the body, 1 = head lowered to HEAD_DOWN on its cables */
  headDrop = 0
  readonly beam = { active: false, from: new THREE.Vector3(), to: new THREE.Vector3() }
  readonly sparkOn: [boolean, boolean] = [false, false]
  readonly cargoCount: [number, number] = [0, 0]
  readonly headPos = new THREE.Vector3()
  private headYaw = 0
  private headPitch = 0
  private lastFaceKey = ''
  private cables: THREE.Mesh[] = []
  private cableMat: THREE.Material

  constructor() {
    this.face = createFaceScreen()
    patchFaceShader(this.face)
    this.rig = buildAgiRig(this.face.material)
    this.arms = [makeArm(-1), makeArm(1)]
    this.cableMat = darkMetalMaterial()
    for (let i = 0; i < CABLE_N; i++) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.cableMat)
      m.castShadow = true
      m.receiveShadow = true
      m.visible = false
      m.frustumCulled = false
      this.rig.bob.add(m)
      this.cables.push(m)
    }
    // everything here is posed by hand per frame; skip per-instance culling
    this.rig.root.traverse((o) => { o.frustumCulled = false })
  }

  get root(): THREE.Group { return this.rig.root }

  reset(): void {
    this.mode = 'waves'
    this.faceMode = 'happy'
    this.glowOverride = null
    this.powerOff = 0
    this.haze = 1
    this.cursorOn = false
    this.recoil = 0
    this.dyingT = -1
    this.headDrop = 0
    this.beam.active = false
    this.sparkOn[0] = this.sparkOn[1] = false
    this.cargoCount[0] = this.cargoCount[1] = 0
    this.headYaw = 0
    this.headPitch = 0
    this.lastFaceKey = ''
    for (let i = 0; i < 2; i++) {
      const a = this.arms[i]
      a.goal.set(a.side * 19, 10.5, -49)
      a.cur.copy(a.goal)
      a.rate = 2.6
      setPose(a, 'open')
      for (let f = 0; f < 4; f++) a.curl[f] = a.curlGoal[f]
      a.spread = a.spreadGoal
      a.flat = 0
      a.flatGoal = 0
      a.aim = null
      a.pointDir = null
      a.weapon = 'none'
      a.morph = 0
      a.morphGoal = 0
      a.spin = 0
      a.spinRate = 0
      a.spinRateGoal = 0
      a.flash = 0
      a.charge = 0
    }
    const rig = this.rig
    rig.model.visible = true
    rig.model.position.set(0, 0, 0)
    rig.tentacles.reset()
    rig.debris.group.visible = false
    rig.beam.group.visible = false
    rig.beam.impact.visible = false
    for (const sp of rig.sparks) sp.group.visible = false
    for (const arm of rig.arms) arm.hand.cargo.visible = false
    rig.head.position.copy(HEAD_CENTER)
  }

  /** Teleport arms onto their current goals (shot setup). */
  snapArms(): void {
    for (const a of this.arms) {
      a.cur.copy(a.goal)
      for (let f = 0; f < 4; f++) a.curl[f] = a.curlGoal[f]
      a.spread = a.spreadGoal
      a.flat = a.flatGoal
      a.morph = a.morphGoal
      a.spinRate = a.spinRateGoal
    }
  }

  /** Wave-phase idle drift (Agi.tsx idleArmGoals). */
  idleGoals(t: number, i: number): void {
    const arm = this.arms[i]
    arm.goal.set(
      arm.side * (19 + Math.sin(t * 0.31 + i * 2.1) * 2.5),
      10.5 + Math.sin(t * 0.43 + i) * 1.5,
      -49 + Math.sin(t * 0.23 + i * 3) * 2,
    )
    arm.rate = 2.6
    arm.flatGoal = 0
    arm.aim = null
    arm.pointDir = null
    arm.morphGoal = 0
    arm.spinRateGoal = 0
    setPose(arm, 'open')
  }

  /** Fight-phase guard pose (Agi.tsx combatIdleGoals). */
  combatGoals(t: number, i: number): void {
    const arm = this.arms[i]
    arm.goal.set(arm.side * 14, 14.5 + Math.sin(t * 0.9 + i * 2) * 0.8, -44)
    arm.rate = 3
    arm.flatGoal = 0
    arm.aim = null
    arm.pointDir = null
    arm.morphGoal = 0
    arm.spinRateGoal = 0
    setPose(arm, 'fist')
  }

  handPos(i: number): THREE.Vector3 {
    return this.rig.arms[i].hand.group.position
  }

  private drawFace(t: number): void {
    const mode = this.faceMode
    const tick = Math.floor(t * 8)
    const key = `${mode}:${tick}:${this.cursorOn}`
    if (key === this.lastFaceKey) return
    this.lastFaceKey = key
    if (mode === 'cursor' || mode === 'blank') {
      const canvas = this.face.texture.image as HTMLCanvasElement
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#030604'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      if (mode === 'cursor' && this.cursorOn) {
        ctx.fillStyle = '#41ff8c'
        ctx.fillRect(31, 19, 2, 2)
      }
      ;(this.face.material.uniforms.uFaceColor.value as THREE.Color).setRGB(0.22, 1.0, 0.5)
      this.face.texture.needsUpdate = true
      return
    }
    this.face.draw(mode, t)
  }

  update(t: number, step: number, camera: THREE.Camera): void {
    const rig = this.rig
    // hover bob + hit recoil
    const bobY = Math.sin(t * 0.5) * 0.9 + Math.sin(t * 1.13) * 0.25
    rig.bob.position.y = bobY
    rig.bob.position.z = -this.recoil * 1.3
    this.recoil *= Math.exp(-3.2 * step)
    if (this.dyingT >= 0) {
      const amp = 0.15 + Math.min(1, this.dyingT / 1.8) * 0.85
      rig.model.position.set((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp * 0.7, (Math.random() - 0.5) * amp)
    } else rig.model.position.set(0, 0, 0)

    // head: on the body, or lowered on stretched cables for the tired window
    const hd = this.headDrop
    const e = hd * hd * (3 - 2 * hd)
    const hp = rig.head.position
    hp.lerpVectors(HEAD_CENTER, _v3.set(HEAD_DOWN.x, HEAD_DOWN.y - bobY, HEAD_DOWN.z), e)
    hp.y += Math.sin(e * Math.PI) * 4 // swings out and down rather than sliding
    const lp = this.look
    _v1.set(lp.x - hp.x, lp.y - (hp.y + bobY), lp.z - (hp.z + rig.bob.position.z))
    const horiz = Math.hypot(_v1.x, _v1.z)
    const targetYaw = Math.atan2(_v1.x, _v1.z)
    const targetPitch = Math.atan2(-_v1.y, horiz) * (0.5 + 0.4 * e)
    const hk = 1 - Math.exp(-2.1 * step)
    this.headYaw += (targetYaw - this.headYaw) * hk
    this.headPitch += (targetPitch - this.headPitch) * hk
    rig.head.rotation.set(this.headPitch, this.headYaw, this.dyingT >= 0 ? (Math.random() - 0.5) * 0.1 : e * 0.06)
    this.headPos.set(hp.x, hp.y + bobY, hp.z + rig.bob.position.z)
    this.updateCables(e)

    // arms
    _bMin.copy(rig.staticBounds.min)
    _bMax.copy(rig.staticBounds.max)
    for (let i = 0; i < 2; i++) {
      _root.copy(SHOULDER_LOCAL[i])
      _root.y += bobY
      _root.z += rig.bob.position.z
      layoutArm(this.arms[i], rig, i, _root, step)
      updateHand(this.arms[i], rig.arms[i], step)
    }
    for (const im of rig.segs) im.instanceMatrix.needsUpdate = true
    rig.collars.instanceMatrix.needsUpdate = true
    rig.loops.instanceMatrix.needsUpdate = true
    rig.shoulders.instanceMatrix.needsUpdate = true
    const c = rig.bounds.center
    c.set((_bMin.x + _bMax.x) * 0.5, (_bMin.y + _bMax.y) * 0.5, (_bMin.z + _bMax.z) * 0.5)
    rig.bounds.radius = c.distanceTo(_bMax) + 2
    for (let i = 0; i < 2; i++) {
      const hand = rig.arms[i].hand
      const cc = this.cargoCount[i]
      hand.cargo.visible = cc > 0
      hand.cargoBodies.count = cc
      hand.cargoEyes.count = cc
    }
    syncFingerInstances(rig)
    rig.fan.rotation.x += step * (this.mode === 'fighting' ? 15 : 6)
    for (const led of rig.leds) {
      const on = Math.sin(t * 3.1 + led.phase) > 0.05 ? 1 : 0.22
      led.mesh.setColorAt(led.index, _c.copy(led.base).multiplyScalar(on))
    }
    for (const im of rig.ledMeshes) im.instanceColor!.needsUpdate = true
    rig.reactorMat.uniforms.uTime.value = t
    rig.reactorMat.uniforms.uHeat.value =
      this.mode === 'tired' ? 0.45 : this.mode === 'dying' ? 0.5 + Math.random() * 0.7 : this.mode === 'dead' ? 0 : 1
    rig.tentacles.update(t, this.mode, this.dyingT, _v2.set(lp.x, lp.y - 1.5, lp.z), this.headPos)

    // spark clusters on grounded hands
    for (let i = 0; i < 2; i++) {
      const sp = rig.sparks[i]
      sp.group.visible = this.sparkOn[i]
      if (!this.sparkOn[i]) continue
      sp.group.position.copy(this.handPos(i))
      for (let b = 0; b < 7; b++) {
        if (Math.random() < 0.4) {
          const sc = 0.35 + Math.random() * 1.4
          const vs = Math.random() < 0.88 ? sc : 0
          _m4.makeScale(vs, vs, vs)
          _m4.setPosition((Math.random() - 0.5) * 3.4, Math.random() * 1.8, (Math.random() - 0.5) * 3.4)
          sp.inst.setMatrixAt(b, _m4)
        }
      }
      sp.inst.instanceMatrix.needsUpdate = true
    }
    // death-beam visual
    const bm = rig.beam
    bm.group.visible = this.beam.active
    bm.impact.visible = this.beam.active
    if (this.beam.active) {
      _d.copy(this.beam.to).sub(this.beam.from)
      const len = Math.max(0.01, _d.length())
      _d.divideScalar(len)
      bm.group.position.copy(this.beam.from).addScaledVector(_d, len * 0.5)
      bm.group.quaternion.setFromUnitVectors(UP, _d)
      const pulse = 1 + 0.18 * Math.sin(t * 41)
      bm.core.scale.set(pulse, len, pulse)
      const wob = 1 + 0.2 * Math.sin(t * 23)
      bm.sheath.scale.set(wob, len, wob)
      bm.sheathMat.uniforms.uTime.value = t
      bm.impact.position.set(this.beam.to.x, 0.15, this.beam.to.z)
      bm.impact.scale.setScalar(1 + 0.3 * Math.sin(t * 31))
    }

    // face
    this.drawFace(t)
    const glow = this.glowOverride ?? (
      this.mode === 'tired' ? 0.3
      : this.mode === 'dying' ? Math.random()
      : this.mode === 'dead' ? 0
      : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.8)))
    this.face.update(t, glow)
    this.face.material.uniforms.uOff.value = this.powerOff
    this.face.material.uniforms.uHaze.value = this.haze
    void camera
  }

  /** Neck cables: rebuilt tubes from the neck socket to the lowered head's back. */
  private updateCables(e: number): void {
    const show = e > 0.01
    const rig = this.rig
    rig.head.updateMatrix()
    for (let i = 0; i < CABLE_N; i++) {
      const m = this.cables[i]
      m.visible = show
      if (!show) continue
      const k = i - (CABLE_N - 1) / 2
      const a = new THREE.Vector3(k * 1.1, 22.4, -66.6 - Math.abs(k) * 0.4)
      const b = new THREE.Vector3(k * 1.5, -2.4 + Math.abs(k) * 0.5, -3.8).applyMatrix4(rig.head.matrix)
      const mid = a.clone().lerp(b, 0.5)
      mid.y -= 3 + Math.abs(k) * 1.2 + 4 * Math.sin(e * Math.PI)
      mid.x += k * 1.6
      const mid2 = a.clone().lerp(b, 0.8)
      mid2.y -= 1.5 + Math.abs(k) * 0.6
      const curve = new THREE.CatmullRomCurve3([a, mid, mid2, b])
      m.geometry.dispose()
      m.geometry = new THREE.TubeGeometry(curve, 40, 0.34 + (i % 2) * 0.14, 8)
    }
  }
}
