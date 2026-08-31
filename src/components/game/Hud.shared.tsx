'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { events } from '@/game/events'
import { useGame } from '@/game/store'
import { cn } from '@/lib/utils'

/** Shared HUD bits: shared rAF manager, panel chrome, glitch headline, tiny helpers. */

export const MONO_LABEL = 'font-mono text-[10px] tracking-[0.22em] text-muted-foreground'

export function uiClick(): void {
  events.emit('uiClick', {})
}

// ─── Shared rAF manager ──────────────────────────────────────────────────────
// ONE requestAnimationFrame loop drives every high-frequency HUD readout
// (charge ring, reload bar, dodge pip, vignettes, perf overlay) instead of N
// independent loops each scheduling their own frame. Entries registered with
// `combat: true` are skipped while the game is paused: the sim clock is frozen
// so their readouts cannot change, and their last-written styles stay visible
// behind the pause overlay.

interface RafEntry {
  run: (now: number) => void
  combat: boolean
}

const rafEntries = new Set<RafEntry>()
let rafList: RafEntry[] = [] // flat snapshot so the tick loop allocates nothing
let rafId = 0
let rafActive = false

function rafTick(now: number): void {
  if (rafEntries.size === 0) {
    rafActive = false
    return
  }
  const paused = useGame.getState().phase === 'paused'
  for (let i = 0; i < rafList.length; i++) {
    const e = rafList[i]
    if (paused && e.combat) continue
    e.run(now)
  }
  rafId = requestAnimationFrame(rafTick)
}

function rafRegister(entry: RafEntry): void {
  rafEntries.add(entry)
  rafList = Array.from(rafEntries)
  if (!rafActive) {
    rafActive = true
    rafId = requestAnimationFrame(rafTick)
  }
}

function rafUnregister(entry: RafEntry): void {
  rafEntries.delete(entry)
  rafList = Array.from(rafEntries)
  if (rafEntries.size === 0 && rafActive) {
    cancelAnimationFrame(rafId)
    rafActive = false
  }
}

/**
 * Run a callback every animation frame without re-rendering React. Used for
 * high-frequency readouts (bat charge ring, dodge cooldown, damage vignette)
 * that would otherwise cause render storms. All callers share one rAF loop.
 *
 * Options: `enabled: false` unregisters the callback entirely (e.g. a closed
 * overlay); `combat: true` marks a combat readout that is skipped while the
 * game is paused (sim clock frozen — the readout cannot change).
 */
export function useRafLoop(cb: (now: number) => void, opts?: { enabled?: boolean; combat?: boolean }): void {
  const ref = useRef(cb)
  useEffect(() => {
    ref.current = cb
  })
  const enabled = opts?.enabled ?? true
  const combat = opts?.combat ?? false
  useEffect(() => {
    if (!enabled) return
    const entry: RafEntry = { run: (now) => ref.current(now), combat }
    rafRegister(entry)
    return () => rafUnregister(entry)
  }, [enabled, combat])
}

// ─── Cached style writes ─────────────────────────────────────────────────────

const styleCache = new WeakMap<Element, Map<string, string>>()

/**
 * Write an inline style prop only when the value differs from the last one
 * written through this helper. rAF readouts call this every frame; skipping
 * identical writes keeps steady-state frames free of style invalidation.
 */
export function setStyle(el: HTMLElement | SVGElement, prop: string, value: string): void {
  let cache = styleCache.get(el)
  if (!cache) {
    cache = new Map()
    styleCache.set(el, cache)
  }
  if (cache.get(prop) === value) return
  cache.set(prop, value)
  ;(el.style as unknown as Record<string, string>)[prop] = value
}

/** Translucent terminal panel with military corner brackets. */
export function HudPanel({
  className,
  accent = 'border-amber-300/50',
  children,
}: {
  className?: string
  accent?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative rounded-[3px] border border-border bg-background/60 backdrop-blur-sm',
        'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_4px_18px_-8px_rgba(0,0,0,0.8)]',
        className,
      )}
    >
      <span aria-hidden className={cn('pointer-events-none absolute -top-px -left-px h-2 w-2 border-t border-l', accent)} />
      <span aria-hidden className={cn('pointer-events-none absolute -top-px -right-px h-2 w-2 border-t border-r', accent)} />
      <span aria-hidden className={cn('pointer-events-none absolute -bottom-px -left-px h-2 w-2 border-b border-l', accent)} />
      <span aria-hidden className={cn('pointer-events-none absolute -bottom-px -right-px h-2 w-2 border-b border-r', accent)} />
      {children}
    </div>
  )
}

/**
 * Layered CRT glitch headline: base text + two clip-sliced chromatic ghost
 * copies + scanlines baked into the glyphs via background-clip:text.
 */
export function GlitchText({
  text,
  className,
  layerA = 'text-red-500/80',
  layerB = 'text-cyan-400/70',
}: {
  text: string
  className?: string
  layerA?: string
  layerB?: string
}) {
  return (
    <div className={cn('relative inline-block whitespace-nowrap', className)}>
      <span className="relative z-10">{text}</span>
      <span aria-hidden className={cn('hud-glitch-a absolute inset-0 z-0', layerA)}>{text}</span>
      <span aria-hidden className={cn('hud-glitch-b absolute inset-0 z-0', layerB)}>{text}</span>
      <span
        aria-hidden
        className="absolute inset-0 z-20 bg-clip-text text-transparent"
        style={{
          backgroundImage: 'repeating-linear-gradient(0deg, rgba(8,10,18,0.38) 0 2px, transparent 2px 6px)',
          WebkitBackgroundClip: 'text',
        }}
      >
        {text}
      </span>
    </div>
  )
}
