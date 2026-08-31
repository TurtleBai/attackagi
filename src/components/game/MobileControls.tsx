'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSettings } from '@/game/settings'
import { simRunning, useGame } from '@/game/store'
import { isTouchDevice, resetTouchInput, touchInput } from '@/game/touch'
import { cn } from '@/lib/utils'

// Virtual touch controls (coarse-pointer devices only, sim phases only).
// WRITES the touchInput singleton (see src/game/touch.ts for the contract);
// Player/Weapons consume it in their frame loops. Left half = floating
// joystick, right half = look drag, bottom-right = FIRE/AIM/JUMP/DODGE/RELOAD
// cluster, top-right = pause. All handlers are per-pointerId pointer events
// with capture, so joystick + look + buttons work simultaneously.
//
// Layering: mounted in Hud BEFORE CombatHud, so combat panels paint above the
// surfaces; panels are pointer-events-none (touches fall through to the
// surfaces) except the weapon cards, which re-enable pointer events on touch.

// ─── Tuning ──────────────────────────────────────────────────────────────────
const STICK_MAX = 44 // px of nub travel = full deflection
const STICK_DEAD = 0.12 // fraction of full deflection ignored (contract ~0.12)
const AMBER_SOFT = 'rgba(252,211,77,0.65)'
const AMBER_HARD = 'rgba(252,211,77,0.9)'
const AMBER_FILL = 'rgba(251,191,36,0.28)'

/**
 * Dispatch a synthetic key press so keyboard-driven actions (weapon switch,
 * reload) run through the exact same Weapons key handler as the physical
 * keyboard — no second dispatch path to keep in sync. Weapons listens on
 * document (bubble), Player on window (document events bubble to window).
 */
export function pressKey(code: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }))
}

/** setPointerCapture throws NotFoundError if the pointer already lifted (fast taps). */
function capture(e: React.PointerEvent<Element>): void {
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {
    /* pointer gone — the up/cancel handler still fires via bubbling */
  }
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

function ControlButton({
  label,
  className,
  onDown,
  onUp,
}: {
  label: ReactNode
  className?: string
  onDown: () => void
  onUp?: () => void
}) {
  const [pressed, setPressed] = useState(false)
  const release = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    setPressed(false)
    onUp?.() // held-input clears are idempotent (also fired by lostpointercapture)
  }
  return (
    <button
      type="button"
      className={cn(
        'pointer-events-auto absolute flex touch-none flex-col items-center justify-center rounded-full border font-mono tracking-[0.18em] backdrop-blur-sm transition-colors duration-75 select-none',
        pressed
          ? 'border-amber-300/80 bg-amber-400/20 text-amber-200'
          : 'border-border/80 bg-background/50 text-foreground/80',
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        touchInput.active = true
        capture(e)
        setPressed(true)
        onDown()
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={() => {
        setPressed(false)
        onUp?.()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  )
}

function PauseGlyph() {
  return (
    <span aria-label="Pause" className="flex items-center gap-[3px]">
      <span className="h-3.5 w-[3px] bg-current" />
      <span className="h-3.5 w-[3px] bg-current" />
    </span>
  )
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

export function MobileControls() {
  // mounted-gate: isTouchDevice() touches matchMedia (SSR/hydration safety)
  const [enabled, setEnabled] = useState(false)
  useEffect(() => setEnabled(isTouchDevice()), [])
  const phase = useGame((s) => s.phase)

  // contract: reset transient touch input when the sim stops + on restart
  useEffect(() => {
    const unsub = useGame.subscribe((s, prev) => {
      if (s.runId !== prev.runId || (simRunning(prev.phase) && !simRunning(s.phase))) resetTouchInput()
    })
    return () => {
      unsub()
      resetTouchInput()
    }
  }, [])

  // joystick + look pointer tracking (per-pointerId; no per-event allocations)
  const baseRef = useRef<HTMLDivElement>(null)
  const nubRef = useRef<HTMLDivElement>(null)
  const stick = useRef({ id: -1, bx: 0, by: 0, pushed: false })
  const look = useRef({ id: -1, x: 0, y: 0 })

  if (!enabled || !simRunning(phase)) return null

  // ── left half: floating joystick ──
  const onStickDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = stick.current
    if (s.id !== -1) return // one pointer owns the stick
    e.preventDefault()
    e.stopPropagation()
    capture(e)
    touchInput.active = true
    s.id = e.pointerId
    s.bx = e.clientX
    s.by = e.clientY
    const base = baseRef.current
    const nub = nubRef.current
    if (base) {
      base.style.transform = `translate3d(${(e.clientX - 56).toFixed(1)}px, ${(e.clientY - 56).toFixed(1)}px, 0)`
      base.style.opacity = '1'
    }
    if (nub) nub.style.transform = 'translate3d(0,0,0)'
  }

  const onStickMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = stick.current
    if (e.pointerId !== s.id) return
    e.preventDefault()
    e.stopPropagation()
    const dx = e.clientX - s.bx
    const dy = e.clientY - s.by
    const len = Math.hypot(dx, dy)
    const cl = len > STICK_MAX ? STICK_MAX : len
    const nx = len > 1e-4 ? dx / len : 0
    const ny = len > 1e-4 ? dy / len : 0
    const nub = nubRef.current
    if (nub) nub.style.transform = `translate3d(${(nx * cl).toFixed(1)}px, ${(ny * cl).toFixed(1)}px, 0)`
    // dead zone, then remap remaining band to 0..1 (contract: magnitude 0..1)
    const mag = cl / STICK_MAX
    const m = mag <= STICK_DEAD ? 0 : (mag - STICK_DEAD) / (1 - STICK_DEAD)
    touchInput.move.x = nx * m
    touchInput.move.y = -ny * m // screen-up = forward +
    const pushed = m > 0
    if (pushed !== s.pushed) {
      s.pushed = pushed
      const base = baseRef.current
      if (base) base.style.borderColor = pushed ? AMBER_SOFT : ''
      if (nub) {
        nub.style.borderColor = pushed ? AMBER_HARD : ''
        nub.style.background = pushed ? AMBER_FILL : ''
      }
    }
  }

  const onStickUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = stick.current
    if (e.pointerId !== s.id) return
    e.stopPropagation()
    s.id = -1
    s.pushed = false
    touchInput.move.x = 0
    touchInput.move.y = 0
    const base = baseRef.current
    const nub = nubRef.current
    if (base) {
      base.style.opacity = '0'
      base.style.borderColor = ''
    }
    if (nub) {
      nub.style.transform = 'translate3d(0,0,0)'
      nub.style.borderColor = ''
      nub.style.background = ''
    }
  }

  // ── right half: look drag (accumulate raw px deltas; Player consumes) ──
  const onLookDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const l = look.current
    if (l.id !== -1) return
    e.preventDefault()
    e.stopPropagation() // keep Player's noLock pointermove fallback out of it
    capture(e)
    touchInput.active = true
    l.id = e.pointerId
    l.x = e.clientX
    l.y = e.clientY
  }

  const onLookMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const l = look.current
    if (e.pointerId !== l.id) return
    e.preventDefault()
    e.stopPropagation()
    touchInput.lookDX += e.clientX - l.x
    touchInput.lookDY += e.clientY - l.y
    l.x = e.clientX
    l.y = e.clientY
  }

  const onLookUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== look.current.id) return
    e.stopPropagation()
    look.current.id = -1
  }

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
    >
      {/* movement surface (left half) */}
      <div
        className="pointer-events-auto absolute inset-y-0 left-0 w-1/2 touch-none"
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      {/* look surface (right half; cluster + pause + weapon cards sit on top) */}
      <div
        className="pointer-events-auto absolute inset-y-0 right-0 w-1/2 touch-none"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* joystick visuals (base anchored at touch point, nub follows the drag) */}
      <div
        ref={baseRef}
        aria-hidden
        className="absolute top-0 left-0 h-28 w-28 rounded-full border-2 border-border/70 bg-background/40 opacity-0 backdrop-blur-[2px]"
      >
        <div
          ref={nubRef}
          className="absolute top-1/2 left-1/2 -mt-6 -ml-6 h-12 w-12 rounded-full border-2 border-foreground/50 bg-background/60 shadow-[0_0_12px_-2px_rgba(0,0,0,0.8)]"
        />
      </div>

      {/* button cluster: bottom-right, above the (touch-mode horizontal) weapon row */}
      <div className="absolute right-[calc(0.75rem+env(safe-area-inset-right))] bottom-[calc(5.75rem+env(safe-area-inset-bottom))] h-44 w-64">
        <ControlButton
          label="FIRE"
          className="right-0 bottom-0 h-[4.5rem] w-[4.5rem] text-[11px]"
          onDown={() => {
            touchInput.fire = true
          }}
          onUp={() => {
            touchInput.fire = false
          }}
        />
        <ControlButton
          label="AIM"
          className="right-[5.25rem] bottom-1 h-14 w-14 text-[10px]"
          onDown={() => {
            touchInput.aim = true
          }}
          onUp={() => {
            touchInput.aim = false
          }}
        />
        <ControlButton
          label="JUMP"
          className="right-1 bottom-[5.25rem] h-14 w-14 text-[9px]"
          onDown={() => {
            touchInput.jumpQueued = true
          }}
        />
        <ControlButton
          label="DODGE"
          className="right-[4.9rem] bottom-[4.9rem] h-14 w-14 text-[9px]"
          onDown={() => {
            touchInput.dodgeQueued = true
          }}
        />
        <ControlButton
          label="RELOAD"
          className="right-[10.5rem] bottom-2 h-11 w-[4.6rem] rounded-[3px] text-[9px]"
          onDown={() => pressKey(useSettings.getState().bindings.reload)}
        />
      </div>

      {/* pause (kill counter shifts left on coarse pointers to make room) */}
      <ControlButton
        label={<PauseGlyph />}
        className="top-[calc(0.75rem+env(safe-area-inset-top))] right-[calc(0.75rem+env(safe-area-inset-right))] h-11 w-11 rounded-[3px]"
        onDown={() => useGame.getState().pause()}
      />

      {/* portrait: nudge toward landscape without blocking play */}
      <div className="absolute top-[calc(3.25rem+env(safe-area-inset-top))] left-1/2 hidden -translate-x-1/2 items-center gap-2 rounded-[3px] border border-border/70 bg-background/60 px-3 py-1.5 font-mono text-[9px] tracking-[0.25em] whitespace-nowrap text-amber-300/90 backdrop-blur-sm portrait:flex">
        <span className="animate-pulse text-xs leading-none">⟳</span>
        ROTATE FOR BEST EXPERIENCE
      </div>
    </div>
  )
}
