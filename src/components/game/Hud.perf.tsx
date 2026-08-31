'use client'
import { useEffect, useRef, useState } from 'react'
import { resolvedTier } from '@/game/quality'
import { useSettings } from '@/game/settings'
import { world } from '@/game/world'
import { useRafLoop } from './Hud.shared'

// Dev-only performance overlay, toggled with F1. Reads the renderer through the
// window.__game debug handle (set by GameCanvas in development builds only).
// Draw-call/triangle deltas are sampled per display frame with info.autoReset
// disabled while the overlay is open (restored on close). Also shows the
// resolved graphics tier + the adaptive controller's current pick so tier
// stepping is observable while testing.

interface GameHandle {
  gl: {
    info: {
      autoReset: boolean
      reset: () => void
      programs?: unknown[]
      memory: { geometries: number; textures: number }
      render: { calls: number; triangles: number; frame: number }
    }
    getPixelRatio: () => number
  }
}

const getHandle = (): GameHandle | null =>
  (window as unknown as { __game?: GameHandle }).__game ?? null

export function PerfHud() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLPreElement>(null)
  const s = useRef({
    last: 0, frames: [] as number[],
    calls: 0, tris: 0, rframes: 0,
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'F1') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const g = getHandle()
    if (!g) return
    if (open) {
      g.gl.info.autoReset = false
      g.gl.info.reset()
      // fresh timing history so the first visible frame isn't a stale spike
      s.current.last = 0
      s.current.frames.length = 0
    } else {
      g.gl.info.autoReset = true
    }
    return () => {
      const h = getHandle()
      if (h) h.gl.info.autoReset = true
    }
  }, [open])

  useRafLoop((now) => {
    if (!ref.current) return
    const st = s.current
    const dt = st.last > 0 ? now - st.last : 16.7
    st.last = now
    st.frames.push(dt)
    if (st.frames.length > 45) st.frames.shift()

    const g = getHandle()
    let drawLine = 'renderer: n/a (prod build)'
    if (g) {
      const r = g.gl.info.render
      const calls = r.calls - st.calls
      const tris = r.triangles - st.tris
      const passes = r.frame - st.rframes
      st.calls = r.calls
      st.tris = r.triangles
      st.rframes = r.frame
      if (passes > 0) {
        drawLine =
          `draws ${calls}  tris ${(tris / 1000).toFixed(1)}k  passes ${passes}\n` +
          `progs ${g.gl.info.programs?.length ?? 0}  geo ${g.gl.info.memory.geometries}  tex ${g.gl.info.memory.textures}  dpr ${g.gl.getPixelRatio().toFixed(2)}`
      } else {
        drawLine = 'renderer idle (no frame this tick)'
      }
    }

    // resolved tier + adaptive controller state (tolerant of the store shape:
    // `resolvedQuality` only exists once the adaptive controller has written it)
    const set = useSettings.getState() as unknown as { quality?: string; resolvedQuality?: string }
    const tierLine =
      `tier ${resolvedTier()}  set ${set.quality ?? '?'}` +
      (set.resolvedQuality ? `  adaptive ${set.resolvedQuality}` : '')

    const avg = st.frames.reduce((a, b) => a + b, 0) / st.frames.length
    const worst = Math.max(...st.frames)
    ref.current.textContent =
      `fps ${(1000 / avg).toFixed(0)}  avg ${avg.toFixed(1)}ms  worst ${worst.toFixed(0)}ms\n` +
      `${tierLine}\n` +
      `${drawLine}\n` +
      `enemies ${world.enemies.size}  proj ${world.projectiles.length}  fx ${world.hazards.length + world.telegraphs.length}`
  }, { enabled: open })

  if (!open) return null
  return (
    <pre
      ref={ref}
      className="absolute top-10 left-2 z-50 rounded-sm border border-border/50 bg-background/80 px-2 py-1.5 font-mono text-[10px] leading-4 text-emerald-300/90 backdrop-blur-sm"
    >
      perf: waiting for frames…
    </pre>
  )
}
