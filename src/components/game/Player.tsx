'use client'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  DODGE_IFRAMES, DODGE_SPEED, DODGE_TIME, FRAME_PRIO, GRAVITY, JUMP_VELOCITY,
  PLAYER_EYE, PLAYER_RADIUS, PLAYER_SPEED,
} from '@/game/constants'
import { events } from '@/game/events'
import { isCoarsePointer } from '@/game/quality'
import { useSettings } from '@/game/settings'
import { simRunning, useGame } from '@/game/store'
import { world } from '@/game/world'

// First-person controller. Owns: pointer lock + mouse look, WASD/jump/dodge
// locomotion, gravity + capsule collision, world.player sync, and the camera
// (eye height, head-bob, landing dip, dodge FOV kick, menu orbit backdrop).
//
// Conventions (documented for other modules):
//   camera.rotation order 'YXZ', rotation = (pitch, yaw, roll)
//   player forward = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))
//   world.player.moveInput = (x: strafe right +, y: forward +), normalized.

// ─── Local feel tuning (visual/feel only — nothing below exists in constants) ─
const LOOK_SENS = 0.0022 // rad per px of mouse movement
const PITCH_LIMIT = 1.5 // rad, spec clamp
const ACCEL_GROUND = 12 // 1/s exponential approach of horizontal velocity
const ACCEL_AIR = 5 // reduced steering while airborne
const JUMP_BUFFER = 0.12 // s: a jump pressed just before landing still fires
const BASE_FOV = 78 // matches GameCanvas camera fov
const MENU_FOV = 70 // slightly longer lens for the cinematic backdrop
const DODGE_FOV_KICK = 9 // 78 → ~87 → 78
const DODGE_FOV_TIME = DODGE_TIME * 1.8 // kick curve outlives the dash slightly
const BOB_FREQ = 0.9 // bob phase advance per meter travelled
const BOB_AMP_Y = 0.032 // m, vertical bob at full run speed
const BOB_AMP_X = 0.02 // m, lateral sway at full run speed
const BREATHE_AMP = 0.006 // m, idle breathing (fades out while moving)
const DIP_STIFF = 170 // landing-dip spring stiffness
const DIP_DAMP = 13 // landing-dip spring damping
const LEAN_STRAFE = 0.012 // rad camera roll from strafe input
const LEAN_DODGE = 0.05 // rad extra roll from lateral dodge
const MENU_RADIUS = 26
const MENU_HEIGHT = 9
const MENU_SWAY_RATE = 0.05 // rad/s of the ping-pong orbit phase
const MENU_SWAY_ARC = 0.9 // rad half-arc; keeps camera on the south side

// ─── No-pointer-lock fallback (mobile/test enablement, not touch controls) ───
// When the platform can't hold a pointer lock (coarse-pointer/touch devices,
// or requestPointerLock rejected twice), mouse look falls back to pointermove
// client-position deltas while the sim runs, and the lock-loss→pause listener
// is disabled (there is never a lock to lose — it would pause instantly).
let noLock = false
let lockRejections = 0
function registerLockRejection(): void {
  if (++lockRejections >= 2) noLock = true
}

// module-scope scratch (never allocated per-frame)
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _desired = new THREE.Vector3()
const _dash = new THREE.Vector3()
const _target = new THREE.Vector3()

function setFov(cam: THREE.PerspectiveCamera, fov: number): void {
  if (Math.abs(cam.fov - fov) > 0.001) {
    cam.fov = fov
    cam.updateProjectionMatrix()
  }
}

export function Player() {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera)
  const gl = useThree((s) => s.gl)

  // input state
  const keys = useRef(new Set<string>())
  const jumpBufferedAt = useRef(-1)
  const dodgeQueued = useRef(false)
  // dodge state
  const dodgeUntil = useRef(-1e9)
  const dodgeStartT = useRef(-1e9)
  const dashDir = useRef(new THREE.Vector3(0, 0, -1))
  // camera feel state
  const bobT = useRef(0)
  const bobAmp = useRef(0)
  const dip = useRef(0)
  const dipV = useRef(0)
  const roll = useRef(0)
  const menuT = useRef(0)
  // fallback-look pointer tracking (only used while noLock)
  const fbPointer = useRef({ active: false, id: -1, x: 0, y: 0 })

  useEffect(() => {
    const canvas = gl.domElement
    if (isCoarsePointer()) noLock = true

    const resetLocal = () => {
      keys.current.clear()
      jumpBufferedAt.current = -1
      dodgeQueued.current = false
      dodgeUntil.current = -1e9
      dodgeStartT.current = -1e9
      dashDir.current.set(0, 0, -1)
      bobT.current = 0
      bobAmp.current = 0
      dip.current = 0
      dipV.current = 0
      roll.current = 0
      world.player.moveInput.set(0, 0)
      fbPointer.current.active = false
    }

    const tryLock = () => {
      if (noLock || document.pointerLockElement === canvas) return
      try {
        // may return a promise (rejects if the browser refuses, e.g. re-lock
        // too soon after an exit) — swallow it, the next click re-attempts.
        // Two rejections flip the module into no-lock fallback mode.
        const r = canvas.requestPointerLock() as unknown
        if (r instanceof Promise) r.catch(() => registerLockRejection())
      } catch {
        registerLockRejection() // still counts — user clicks re-attempt until then
      }
    }

    const onPointerDown = () => {
      if (simRunning(useGame.getState().phase)) tryLock()
    }

    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return
      // some browsers emit a giant movement spike on lock acquisition — drop it
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return
      const p = world.player
      const sens = LOOK_SENS * useSettings.getState().lookSensitivity
      p.yaw -= e.movementX * sens
      p.pitch = THREE.MathUtils.clamp(p.pitch - e.movementY * sens, -PITCH_LIMIT, PITCH_LIMIT)
    }

    // no-lock fallback look: client-position deltas of a single tracked pointer
    // (touch drag on coarse devices; hover-look where a lock was refused)
    const onFallbackMove = (e: PointerEvent) => {
      if (!noLock || document.pointerLockElement === canvas) return
      const f = fbPointer.current
      if (!simRunning(useGame.getState().phase)) {
        f.active = false
        return
      }
      if (!f.active) {
        f.active = true
        f.id = e.pointerId
        f.x = e.clientX
        f.y = e.clientY
        return
      }
      if (e.pointerId !== f.id) return // second touch must not slew the camera
      const dx = e.clientX - f.x
      const dy = e.clientY - f.y
      f.x = e.clientX
      f.y = e.clientY
      const p = world.player
      const sens = LOOK_SENS * useSettings.getState().lookSensitivity
      p.yaw -= dx * sens
      p.pitch = THREE.MathUtils.clamp(p.pitch - dy * sens, -PITCH_LIMIT, PITCH_LIMIT)
    }
    const onFallbackEnd = (e: PointerEvent) => {
      // a lifted finger must not teleport the next touch's baseline
      if (fbPointer.current.active && e.pointerId === fbPointer.current.id) fbPointer.current.active = false
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') e.preventDefault() // no page scroll
      keys.current.add(e.code) // before the repeat gate: repeats re-add after a reset
      if (e.repeat) return
      // action buffers only while the sim runs — keys pressed on menus/pause
      // must not fire an uncommanded jump/dodge on the first resumed frame
      if (!simRunning(useGame.getState().phase)) return
      // without a pointer lock, Esc never triggers a lock-loss pause — pause here
      if (noLock && e.code === 'Escape') {
        useGame.getState().pause()
        return
      }
      const b = useSettings.getState().bindings
      if (e.code === b.jump) jumpBufferedAt.current = world.time
      if (e.code === b.dodge) dodgeQueued.current = true
    }
    const onKeyUp = (e: KeyboardEvent) => {
      keys.current.delete(e.code)
    }
    const onBlur = () => keys.current.clear()

    // pointer-lock loss during live sim (Esc, alt-tab) = pause. Phase-driven
    // exits below only happen once the phase is already non-sim, so no loop.
    // Disabled in noLock fallback mode — there is never a lock to lose, and
    // pausing on its absence would freeze the game on the first sim frame.
    const onLockChange = () => {
      if (noLock) return
      if (!document.pointerLockElement && simRunning(useGame.getState().phase)) {
        useGame.getState().pause()
      }
    }
    document.addEventListener('pointerlockchange', onLockChange)

    canvas.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('pointermove', onFallbackMove)
    document.addEventListener('pointerup', onFallbackEnd)
    document.addEventListener('pointercancel', onFallbackEnd)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    const unsub = useGame.subscribe((s, prev) => {
      if (s.runId !== prev.runId) resetLocal()
      if (s.phase !== prev.phase) {
        if (simRunning(s.phase)) {
          // phase flips into play happen inside user click handlers (Start
          // button, buff pick, retry) — synchronous lock attempt is within
          // the user gesture, so it usually succeeds without an extra click
          tryLock()
        } else if (document.pointerLockElement === canvas) {
          document.exitPointerLock()
        }
      }
    })

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointerlockchange', onLockChange)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointermove', onFallbackMove)
      document.removeEventListener('pointerup', onFallbackEnd)
      document.removeEventListener('pointercancel', onFallbackEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      unsub()
      if (document.pointerLockElement === canvas) document.exitPointerLock()
    }
  }, [gl])

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05)
    const s = useGame.getState()
    const p = world.player
    const cam = camera
    if (cam.rotation.order !== 'YXZ') cam.rotation.order = 'YXZ'

    // ─── Menu: slow cinematic sway around the south rim, framing arena + AGI ─
    if (s.phase === 'menu') {
      menuT.current += step
      const t = menuT.current
      const a = Math.sin(t * MENU_SWAY_RATE) * MENU_SWAY_ARC
      cam.position.set(
        Math.sin(a) * MENU_RADIUS,
        MENU_HEIGHT + Math.sin(t * 0.13) * 0.6,
        Math.cos(a) * MENU_RADIUS,
      )
      _target.set(0, 7, -26) // between arena center and the AGI at z≈-66
      cam.lookAt(_target)
      setFov(cam, MENU_FOV)
      return
    }

    // shared basis for this frame's yaw
    const sy = Math.sin(p.yaw)
    const cy = Math.cos(p.yaw)
    _fwd.set(-sy, 0, -cy)
    _right.set(cy, 0, -sy)

    const running = simRunning(s.phase)

    if (running) {
      const stats = s.stats

      // ── movement intent (user-rebindable) ──
      const b = useSettings.getState().bindings
      const kf = (keys.current.has(b.forward) ? 1 : 0) - (keys.current.has(b.back) ? 1 : 0)
      const kr = (keys.current.has(b.right) ? 1 : 0) - (keys.current.has(b.left) ? 1 : 0)
      const ilen = Math.hypot(kr, kf)
      p.moveInput.set(ilen > 0 ? kr / ilen : 0, ilen > 0 ? kf / ilen : 0)

      // ── dodge ──
      if (dodgeQueued.current) {
        dodgeQueued.current = false
        if (p.alive && world.time >= p.dodgeReadyAt) {
          if (ilen > 0) {
            _dash
              .copy(_fwd)
              .multiplyScalar(p.moveInput.y)
              .addScaledVector(_right, p.moveInput.x)
              .normalize()
          } else {
            _dash.copy(_fwd) // idle dodge dashes along facing
          }
          dashDir.current.copy(_dash)
          dodgeStartT.current = world.time
          dodgeUntil.current = world.time + DODGE_TIME
          p.invulnUntil = world.time + DODGE_IFRAMES
          p.dodgeReadyAt = world.time + stats.dodgeCooldown
          events.emit('playerDodge', {})
        }
      }
      const dodging = world.time < dodgeUntil.current

      // ── horizontal velocity ──
      if (dodging) {
        p.vel.x = dashDir.current.x * DODGE_SPEED
        p.vel.z = dashDir.current.z * DODGE_SPEED
      } else {
        const speed = PLAYER_SPEED * stats.moveSpeedMult
        _desired.set(
          (_fwd.x * p.moveInput.y + _right.x * p.moveInput.x) * speed,
          0,
          (_fwd.z * p.moveInput.y + _right.z * p.moveInput.x) * speed,
        )
        const k = 1 - Math.exp(-(p.onGround ? ACCEL_GROUND : ACCEL_AIR) * step)
        p.vel.x += (_desired.x - p.vel.x) * k
        p.vel.z += (_desired.z - p.vel.z) * k
      }

      // ── jump (buffered) ──
      if (
        p.onGround &&
        jumpBufferedAt.current >= 0 &&
        world.time - jumpBufferedAt.current <= JUMP_BUFFER
      ) {
        jumpBufferedAt.current = -1
        p.vel.y = JUMP_VELOCITY
        p.onGround = false
        events.emit('playerJump', {})
      }

      // ── gravity, integrate, collide ──
      p.vel.y -= GRAVITY * step
      p.pos.addScaledVector(p.vel, step)
      world.resolveCapsule(p.pos, PLAYER_RADIUS)
      const fallSpeed = -p.vel.y
      if (p.pos.y <= 0) {
        p.pos.y = 0
        if (p.vel.y <= 0) {
          if (!p.onGround) {
            // landing dip: impact-scaled downward impulse into the spring
            dipV.current -= THREE.MathUtils.clamp(fallSpeed * 0.02, 0.05, 0.3)
          }
          p.onGround = true
          p.vel.y = 0
        }
      } else {
        p.onGround = false
      }
    } else {
      // frozen (buffSelect/dead/victory): no physics, no stale intent
      p.moveInput.set(0, 0)
    }

    // ─── Camera feel (pure visual — runs every non-menu frame so springs settle) ─
    const dodging = world.time < dodgeUntil.current
    const hSpeed = Math.hypot(p.vel.x, p.vel.z)

    // head-bob amplitude follows grounded run speed, fades in air / while frozen
    const bobTarget =
      running && p.onGround && !dodging ? Math.min(hSpeed / PLAYER_SPEED, 1.15) : 0
    bobAmp.current += (bobTarget - bobAmp.current) * (1 - Math.exp(-8 * step))
    if (running) bobT.current += hSpeed * step * BOB_FREQ

    // landing-dip spring
    dipV.current += (-dip.current * DIP_STIFF - dipV.current * DIP_DAMP) * step
    dip.current += dipV.current * step

    // subtle strafe/dodge lean (roll)
    const rollTarget = running
      ? -p.moveInput.x * LEAN_STRAFE -
        (dodging ? dashDir.current.dot(_right) * LEAN_DODGE : 0)
      : 0
    roll.current += (rollTarget - roll.current) * (1 - Math.exp(-10 * step))

    // dodge FOV kick: 78 → ~87 → 78 across the dash
    let fov = BASE_FOV
    const tk = (world.time - dodgeStartT.current) / DODGE_FOV_TIME
    if (tk >= 0 && tk <= 1) fov += DODGE_FOV_KICK * Math.sin(tk * Math.PI)
    setFov(cam, fov)

    // compose: eye height + bob + dip, lateral sway along camera right
    const bobY =
      Math.sin(bobT.current * 2) * BOB_AMP_Y * bobAmp.current +
      Math.sin(world.time * 1.6) * BREATHE_AMP * (1 - bobAmp.current)
    const bobX = Math.cos(bobT.current) * BOB_AMP_X * bobAmp.current
    cam.position.set(
      p.pos.x + _right.x * bobX,
      p.pos.y + PLAYER_EYE + bobY + dip.current,
      p.pos.z + _right.z * bobX,
    )
    cam.rotation.set(p.pitch, p.yaw, roll.current)
  }, FRAME_PRIO.player)

  return null
}
