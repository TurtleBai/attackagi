'use client'
import { useEffect, useRef } from 'react'
import { events } from '@/game/events'
import { useGame } from '@/game/store'
import { setStyle, useRafLoop } from './Hud.shared'

/**
 * Screen-space feedback: hit vignette spike (rAF decay, no React re-render),
 * persistent low-HP pulse, and a whisper-subtle visor scanline field.
 */
export function HudFx() {
  const dmgRef = useRef<HTMLDivElement>(null)
  const lowRef = useRef<HTMLDivElement>(null)
  const dmgV = useRef(0)
  const lastNow = useRef(0)

  useEffect(
    () =>
      events.on('playerHit', ({ amount }) => {
        // opacity spike scaled by hit size, then ~250ms decay in the rAF below
        dmgV.current = Math.min(1, Math.max(dmgV.current, 0.5 + amount * 0.012))
      }),
    [],
  )

  useRafLoop((now) => {
    const dt = lastNow.current > 0 ? Math.min(0.05, (now - lastNow.current) / 1000) : 0
    lastNow.current = now

    const dmg = dmgRef.current
    if (dmg && dmgV.current > 0) {
      dmgV.current = Math.max(0, dmgV.current - dt * 4) // full fade in 250ms
      setStyle(dmg, 'opacity', dmgV.current.toFixed(3))
    }

    const low = lowRef.current
    if (low) {
      const s = useGame.getState()
      const frac = s.stats.maxHp > 0 ? s.hp / s.stats.maxHp : 1
      const active =
        frac < 0.3 &&
        (s.phase === 'wave' || s.phase === 'smash' || s.phase === 'boss' || s.phase === 'buffSelect')
      setStyle(low, 'opacity', active ? (0.2 + 0.12 * (0.5 + 0.5 * Math.sin(now / 260))).toFixed(3) : '0')
    }
  })

  return (
    <>
      {/* visor scanlines */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          opacity: 0.045,
          backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.9) 0 1px, transparent 1px 3px)',
        }}
      />
      {/* persistent low-HP vignette */}
      <div
        aria-hidden
        ref={lowRef}
        className="absolute inset-0"
        style={{
          opacity: 0,
          background: 'radial-gradient(ellipse at center, transparent 42%, rgba(190,18,30,0.5) 100%)',
        }}
      />
      {/* damage hit vignette */}
      <div
        aria-hidden
        ref={dmgRef}
        className="absolute inset-0"
        style={{
          opacity: 0,
          background: 'radial-gradient(ellipse at center, transparent 34%, rgba(220,38,38,0.62) 100%)',
        }}
      />
    </>
  )
}
