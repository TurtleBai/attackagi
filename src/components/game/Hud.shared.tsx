'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { events } from '@/game/events'
import { cn } from '@/lib/utils'

/** Shared HUD bits: rAF hook, panel chrome, glitch headline, tiny helpers. */

export const MONO_LABEL = 'font-mono text-[10px] tracking-[0.22em] text-muted-foreground'

export function uiClick(): void {
  events.emit('uiClick', {})
}

/**
 * Run a callback every animation frame without re-rendering React. Used for
 * high-frequency readouts (bat charge ring, dodge cooldown, damage vignette)
 * that would otherwise cause render storms.
 */
export function useRafLoop(cb: (now: number) => void): void {
  const ref = useRef(cb)
  useEffect(() => {
    ref.current = cb
  })
  useEffect(() => {
    let raf = 0
    const loop = (now: number) => {
      ref.current(now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
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
