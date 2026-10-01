import * as THREE from 'three'
import { HEAD_CENTER } from '../port/components/Agi.rig'
import type { Robot } from '../port/components/Robots'
import type { Stage } from '../engine/stage'
import { SHOT } from '../cues'

// Shared shot toolkit: camera rigs (cinematic look-at + first-person yaw/pitch),
// deterministic handheld noise, aim solving, and the gameplay beats (revolver
// headshot, kill, explosion) expressed through the ported VFX handlers.

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
export const lerp = THREE.MathUtils.lerp
export const clamp = THREE.MathUtils.clamp
export const smooth = (x: number) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c) }

export function span(name: keyof typeof SHOT): { start: number; end: number } {
  const [start, end] = SHOT[name]
  return { start, end }
}

// ── noise ────────────────────────────────────────────────────────────────────

function h1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}
/** smooth 1D value noise in [-1, 1] */
export function noise(t: number, seed = 0): number {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return (lerp(h1(i + seed * 17.3), h1(i + 1 + seed * 17.3), u)) * 2 - 1
}

// ── cameras ──────────────────────────────────────────────────────────────────

const _e = new THREE.Euler(0, 0, 0, 'YXZ')
const _v = new THREE.Vector3()

export function setFov(S: Stage, fov: number): void {
  if (S.camera.fov !== fov) {
    S.camera.fov = fov
    S.camera.updateProjectionMatrix()
  }
}

/** Cinematic: position + look target + optional roll (radians). */
export function lookCam(S: Stage, pos: THREE.Vector3, target: THREE.Vector3, fov: number, roll = 0): void {
  setFov(S, fov)
  S.camera.position.copy(pos)
  S.camera.up.set(0, 1, 0)
  S.camera.lookAt(target)
  if (roll) S.camera.rotateZ(roll)
}

/** First person: eye position + yaw (0 = facing −Z / the AGI) + pitch + roll. */
export function fpsCam(S: Stage, eye: THREE.Vector3, yaw: number, pitch: number, fov = 78, roll = 0): void {
  setFov(S, fov)
  S.camera.position.copy(eye)
  S.camera.quaternion.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'))
}

/** yaw/pitch (fpsCam convention) that aim from eye at target */
export function aim(eye: THREE.Vector3, target: THREE.Vector3): { yaw: number; pitch: number } {
  _v.copy(target).sub(eye)
  const yaw = Math.atan2(-_v.x, -_v.z)
  const pitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z))
  return { yaw, pitch }
}

/** Handheld drift: low-frequency rotation wander added on top of a camera. */
export function handheld(S: Stage, t: number, amp = 0.006, freq = 1.3, seed = 1): void {
  S.camera.rotateX(noise(t * freq, seed) * amp)
  S.camera.rotateY(noise(t * freq * 0.83, seed + 3) * amp * 1.3)
  S.camera.rotateZ(noise(t * freq * 0.61, seed + 7) * amp * 0.5)
}

/** Impact shake (decaying, high-frequency), in radians. */
export function kick(S: Stage, t: number, since: number, amp: number, decay = 9, freq = 32): void {
  if (since < 0) return
  const a = amp * Math.exp(-decay * since)
  S.camera.rotateX(noise(t * freq, 11) * a)
  S.camera.rotateY(noise(t * freq * 1.1, 13) * a)
  S.camera.rotateZ(noise(t * freq * 0.9, 17) * a * 0.6)
}

// ── AGI geometry helpers ─────────────────────────────────────────────────────

export function bobY(t: number): number {
  return Math.sin(t * 0.5) * 0.9 + Math.sin(t * 1.13) * 0.25
}

/** CRT screen center (head resting on the body, facing +Z). */
export function screenCenter(t: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(HEAD_CENTER.x, HEAD_CENTER.y + bobY(t), HEAD_CENTER.z + 3.72)
}

// ── robot helpers ────────────────────────────────────────────────────────────

/** World position of a robot's logo screen (its headshot target). */
export function robotHead(r: Robot, out = new THREE.Vector3()): THREE.Vector3 {
  const head = r.rig.nodes.head
  r.group.updateMatrixWorld(true)
  const scr = head.children.find((c) => (c as THREE.Mesh).material === r.screenMat)
  return (scr ?? head).getWorldPosition(out)
}

const _o = new THREE.Vector3()
const _d = new THREE.Vector3()

/** Revolver shot from the view model at a world point (tracer + flash + sparks). */
export function fireAt(S: Stage, target: THREE.Vector3): void {
  S.vm.fire()
  S.vm.muzzleWorld(_o)
  _d.copy(target).sub(S.camera.position).normalize()
  S.vfx.onShot({ origin: _o.clone(), dir: _d.clone(), hitPoint: target.clone() })
}

/** Headshot kill: logo screen pops (sparks + flash), body collapses. */
export function headshot(S: Stage, r: Robot, tip?: number): void {
  const hp = robotHead(r)
  fireAt(S, hp)
  r.hitFlash = 1
  S.vfx.onEnemyHit({ pos: r.pos.clone(), kind: r.kind })
  S.vfx.onBatHit({ pos: hp.clone(), charged: 0.4 })
  S.robots.kill(r, tip !== undefined ? { tip, roll: 0.2 } : undefined)
  S.vfx.onEnemyDeath({ pos: r.pos.clone(), kind: r.kind })
}

export function explode(S: Stage, pos: THREE.Vector3, radius: number, kind: 'molotov' | 'rocket' | 'punch' | 'enemy' | 'bossDeath' = 'rocket'): void {
  S.vfx.onExplosion({ pos: pos.clone(), radius, kind })
}

// ── per-frame helpers ────────────────────────────────────────────────────────

/** True exactly on the first frame at/after cue time `at`. */
export function on(t: number, at: number, dt = 1 / 60): boolean {
  return t >= at - 1e-6 && t - dt < at - 1e-6
}

/** Robot walking toward a point at `speed` m/s (drives the game walk cycle). */
export function walk(r: Robot, to: THREE.Vector3, speed: number, dt: number): void {
  if (r.dead || r.falling) return
  _d.set(to.x - r.pos.x, 0, to.z - r.pos.z)
  const dist = _d.length()
  r.yaw = Math.atan2(_d.x, _d.z)
  if (dist > 0.6) {
    r.pos.addScaledVector(_d.divideScalar(dist), speed * dt)
    r.data.speed = speed
  } else r.data.speed = 0
}

export function faceTo(r: Robot, to: THREE.Vector3): void {
  r.yaw = Math.atan2(to.x - r.pos.x, to.z - r.pos.z)
}

/** World point → overlay pixel coords (1920×1080). */
export function toScreen(S: Stage, p: THREE.Vector3): { x: number; y: number; behind: boolean } {
  S.camera.updateMatrixWorld()
  const v = p.clone().project(S.camera)
  return { x: (v.x * 0.5 + 0.5) * 1920, y: (-v.y * 0.5 + 0.5) * 1080, behind: v.z > 1 }
}
