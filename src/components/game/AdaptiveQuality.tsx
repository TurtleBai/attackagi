'use client'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { isCoarsePointer, TIER_KNOBS, type ResolvedTier } from '@/game/quality'
import { useSettings } from '@/game/settings'
import { simRunning, useGame } from '@/game/store'
import type { GamePhase } from '@/game/types'

// ─── Frame scheduling + AUTO tier controller (both live inside the Canvas) ───
//
// FrameScheduler: heat/battery. Sim phases run frameloop 'always'; menus and
// end screens tick ~25Hz through a setInterval → invalidate(); 'paused' draws
// exactly one more frame then idles on 'demand'; a hidden tab renders nothing.
//
// AdaptiveQuality: owns the RESOLVED tier while the user's setting is 'auto'.
// It measures sim-phase frame deltas, estimates the display budget once from
// the median of the first ~90 valid deltas (60/120/144Hz displays), then steps
// the resolved tier down when >15% of the last 120 valid frames blow
// budget×1.25 (10s cooldown) and back up after 30s of >95% frames under
// budget×0.9. Structural knob flips (composer / shadows / defines) are held as
// `pending` until a safe phase (menu/paused/buffSelect); the immediate relief
// on a step-down decision is a CHEAP knob — dpr floored within the current
// tier's band. Coarse-pointer (touch) devices resolve AUTO within
// {potato, smooth} only.

const isSafePhase = (p: GamePhase): boolean => p === 'menu' || p === 'paused' || p === 'buffSelect'

export function FrameScheduler() {
  const invalidate = useThree((s) => s.invalidate)
  const setFrameloop = useThree((s) => s.setFrameloop)

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null

    const applyPhase = (phase: GamePhase) => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
      if (document.visibilityState === 'hidden') {
        setFrameloop('never')
        return
      }
      if (simRunning(phase)) {
        setFrameloop('always')
        return
      }
      setFrameloop('demand')
      if (phase === 'paused') {
        // one more frame so the frozen sim + pause treatment lands, then idle
        invalidate()
        return
      }
      // menu / buffSelect / dead / victory: ~25Hz keeps backdrops alive cheaply
      interval = setInterval(invalidate, 40)
      invalidate()
    }

    applyPhase(useGame.getState().phase)
    const unsub = useGame.subscribe((s, prev) => {
      if (s.phase !== prev.phase) applyPhase(s.phase)
    })
    const onVis = () => applyPhase(useGame.getState().phase)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      unsub()
      document.removeEventListener('visibilitychange', onVis)
      if (interval) clearInterval(interval)
      setFrameloop('always')
    }
  }, [invalidate, setFrameloop])

  return null
}

// ─── Adaptive controller tunables ────────────────────────────────────────────
const WARMUP_FRAMES = 90 // valid deltas used to estimate the display budget
const WINDOW = 120 // ring-buffer window for the step-down test
const OVER_MULT = 1.25 // a frame over budget×this is a violation
const OVER_FRACTION = 0.15 // >15% violations in the window → step down
const UNDER_MULT = 0.9 // step-up wants frames under budget×this
const UNDER_BAD_FRACTION = 0.05 // >5% not-under → good-streak resets
const STEP_COOLDOWN_MS = 10_000
const STEP_UP_AFTER_MS = 30_000
const BUDGET_MIN_MS = 1000 / 145 // treat displays as at most ~144Hz
const BUDGET_MAX_MS = 1000 / 59 // …and at least ~60Hz (a struggling start must not inflate the budget)

const ORDER: readonly ResolvedTier[] = ['potato', 'smooth', 'pretty']

let _coarse: boolean | null = null
const coarse = (): boolean => (_coarse ??= isCoarsePointer())

const fallbackTier = (): ResolvedTier => (coarse() ? 'potato' : 'smooth')

const currentResolved = (): ResolvedTier => useSettings.getState().resolvedQuality ?? fallbackTier()

interface AdaptState {
  warm: Float32Array
  warmN: number
  budget: number // ms; 0 = still estimating
  ring: Float32Array
  ringN: number
  ringI: number
  over: number // violations currently in the ring
  upStart: number // ms timestamp the current good streak began
  upTotal: number
  upBad: number
  lastStepAt: number
  pending: ResolvedTier | null // structural step waiting for a safe phase
  chain: boolean // previous frame was a valid sim frame (delta trustworthy)
  wasActive: boolean
}

function resetWindows(s: AdaptState, now: number): void {
  s.ringN = 0
  s.ringI = 0
  s.over = 0
  s.upStart = now
  s.upTotal = 0
  s.upBad = 0
  s.chain = false
}

export function AdaptiveQuality() {
  const st = useRef<AdaptState>({
    warm: new Float32Array(WARMUP_FRAMES),
    warmN: 0,
    budget: 0,
    ring: new Float32Array(WINDOW),
    ringN: 0,
    ringI: 0,
    over: 0,
    upStart: 0,
    upTotal: 0,
    upBad: 0,
    lastStepAt: 0,
    pending: null,
    chain: false,
    wasActive: false,
  })

  // Seed the resolved tier with quality.ts's own fallback so the HUD can show
  // "AUTO (…)" — identical value, so nothing visual moves at mount.
  useEffect(() => {
    const s = useSettings.getState()
    if (s.quality === 'auto' && !s.resolvedQuality) s.setResolvedQuality(fallbackTier())
  }, [])

  // Structural steps apply only at safe phases — watched via subscription
  // because paused runs no frames (useFrame is off in 'demand' idle).
  useEffect(() => {
    const tryApply = (phase: GamePhase) => {
      const a = st.current
      if (!a.pending || !isSafePhase(phase)) return
      const settings = useSettings.getState()
      if (settings.quality !== 'auto') {
        a.pending = null
        return
      }
      settings.setResolvedQuality(a.pending)
      settings.setAdaptiveDpr(null) // new tier's dpr band takes over
      a.pending = null
      resetWindows(a, performance.now())
      a.lastStepAt = performance.now()
    }
    tryApply(useGame.getState().phase)
    return useGame.subscribe((s, prev) => {
      if (s.phase !== prev.phase) tryApply(s.phase)
    })
  }, [])

  useFrame((_, delta) => {
    const a = st.current
    const settings = useSettings.getState()
    if (settings.quality !== 'auto') {
      // user pinned a tier — controller dormant; forget any queued step
      a.pending = null
      a.wasActive = false
      return
    }
    if (!a.wasActive) {
      a.wasActive = true
      resetWindows(a, performance.now())
    }

    const dtMs = delta * 1000
    if (!simRunning(useGame.getState().phase) || dtMs <= 0 || dtMs > 250) {
      a.chain = false
      return
    }
    if (!a.chain) {
      a.chain = true // first frame after a gap: delta spans the gap, discard
      return
    }

    // ── budget estimation (once) ──
    if (a.budget === 0) {
      a.warm[a.warmN++] = dtMs
      if (a.warmN >= WARMUP_FRAMES) {
        a.warm.sort()
        const median = a.warm[WARMUP_FRAMES >> 1]
        a.budget = Math.min(BUDGET_MAX_MS, Math.max(BUDGET_MIN_MS, median))
        resetWindows(a, performance.now())
        a.chain = true // this frame was valid — keep the chain
      }
      return
    }

    const now = performance.now()
    const overLimit = a.budget * OVER_MULT

    // ── ring buffer of the last WINDOW valid deltas (violation count kept incrementally) ──
    if (a.ringN === WINDOW && a.ring[a.ringI] > overLimit) a.over--
    a.ring[a.ringI] = dtMs
    if (dtMs > overLimit) a.over++
    a.ringI = (a.ringI + 1) % WINDOW
    if (a.ringN < WINDOW) a.ringN++

    // ── good-streak window for stepping up ──
    a.upTotal++
    if (dtMs >= a.budget * UNDER_MULT) a.upBad++
    if (a.upBad > a.upTotal * UNDER_BAD_FRACTION) {
      a.upStart = now
      a.upTotal = 0
      a.upBad = 0
    }

    // ── step down (or cancel a queued step up) ──
    if (a.ringN === WINDOW && a.over > WINDOW * OVER_FRACTION) {
      const cur = currentResolved()
      if (a.pending && ORDER.indexOf(a.pending) > ORDER.indexOf(cur)) {
        a.pending = null // frames got worse before the queued upgrade landed
        resetWindows(a, now)
      } else if (!a.pending && now - a.lastStepAt > STEP_COOLDOWN_MS) {
        const down = ORDER[ORDER.indexOf(cur) - 1]
        if (down) {
          a.pending = down
          a.lastStepAt = now
          // immediate CHEAP relief: floor the render scale inside the current
          // tier's dpr band (structural flip waits for a safe phase)
          const floor = TIER_KNOBS[cur].dpr[0]
          if (settings.adaptiveDpr !== floor) settings.setAdaptiveDpr(floor)
          resetWindows(a, now)
        }
      }
    }

    // ── step up (or cancel a queued step down) after 30s of headroom ──
    if (a.upTotal > 0 && now - a.upStart > STEP_UP_AFTER_MS) {
      const cur = currentResolved()
      if (a.pending) {
        if (ORDER.indexOf(a.pending) < ORDER.indexOf(cur)) {
          // recovered (dpr floor was enough) before the downgrade applied
          a.pending = null
          if (settings.adaptiveDpr !== null) settings.setAdaptiveDpr(null)
        }
      } else {
        const cap: ResolvedTier = coarse() ? 'smooth' : 'pretty'
        const up = ORDER[ORDER.indexOf(cur) + 1]
        if (up && ORDER.indexOf(up) <= ORDER.indexOf(cap)) {
          a.pending = up
          a.lastStepAt = now
        }
      }
      resetWindows(a, now)
      a.chain = true
    }
  }, -999) // right after WorldClock (-1000), before every sim system

  return null
}
