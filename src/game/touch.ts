'use client'

// ─── Touch input contract ────────────────────────────────────────────────────
// The virtual mobile controls (DOM overlay) WRITE this singleton; Player and
// Weapons READ it in their frame loops when touch mode is active. Mirrors the
// semantics of the keyboard/mouse inputs one-to-one so the gameplay systems
// stay input-agnostic:
//   move        — analog left-stick vector, x = strafe right +, y = forward +,
//                 magnitude 0..1 (Player multiplies by speed)
//   lookDX/DY   — accumulated look deltas in "pixels" since last consume
//                 (Player consumes + zeroes them each frame, same sensitivity
//                 pipeline as mousemove)
//   fire        — held: revolver full-auto / bat charge; releasing swings the
//                 bat or (molotov, while aiming) throws
//   aim         — held: revolver ADS / molotov arc aim
//   jumpQueued / dodgeQueued — edge-triggered, consumed by Player
// The overlay also drives weapon switching / reload / pause through the same
// store actions the HUD uses — those need no entry here.

export interface TouchInput {
  /** true once the touch overlay has claimed input (coarse pointer + first touch) */
  active: boolean
  move: { x: number; y: number }
  lookDX: number
  lookDY: number
  fire: boolean
  aim: boolean
  jumpQueued: boolean
  dodgeQueued: boolean
}

export const touchInput: TouchInput = {
  active: false,
  move: { x: 0, y: 0 },
  lookDX: 0,
  lookDY: 0,
  fire: false,
  aim: false,
  jumpQueued: false,
  dodgeQueued: false,
}

/** Consume-and-zero the accumulated look deltas (Player, once per frame). */
export function takeLook(out: { dx: number; dy: number }): void {
  out.dx = touchInput.lookDX
  out.dy = touchInput.lookDY
  touchInput.lookDX = 0
  touchInput.lookDY = 0
}

export function resetTouchInput(): void {
  touchInput.move.x = 0
  touchInput.move.y = 0
  touchInput.lookDX = 0
  touchInput.lookDY = 0
  touchInput.fire = false
  touchInput.aim = false
  touchInput.jumpQueued = false
  touchInput.dodgeQueued = false
}

/** Coarse-pointer device (phone/tablet) — the overlay mounts when true. */
export function isTouchDevice(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
}
