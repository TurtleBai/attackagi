'use client'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { AudioSystem } from './AudioSystem'
import { Hud } from './Hud'
import { useResolvedTier } from './useResolvedTier'

const GameCanvas = dynamic(() => import('./GameCanvas'), { ssr: false })

// potato runs without an EffectComposer, so the composer Vignette is replaced
// by this free CSS radial-gradient (tuned to match darkness 0.58 / offset 0.24).
// Sits between the canvas and the HUD: darkens the scene, never the UI.
// Mounted-gate avoids an SSR/client hydration mismatch (tier resolution touches
// matchMedia + localStorage-persisted settings).
function PotatoVignette() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const tier = useResolvedTier()
  if (!mounted || tier !== 'potato') return null
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ background: 'radial-gradient(ellipse at center, transparent 48%, rgba(0,0,0,0.58) 118%)' }}
    />
  )
}

export function GameShell() {
  return (
    // w-dvw/h-dvh (not just inset-0): phone browsers size `fixed` elements to
    // the LAYOUT viewport, which can extend under dynamic toolbars — dynamic
    // viewport units keep canvas + HUD exactly on the VISIBLE screen. On
    // desktop they are identical to inset-0. overflow-hidden still clips any
    // wide HUD child so nothing can force a horizontal scroll on phones.
    <div className="fixed inset-0 h-dvh w-dvw overflow-hidden bg-background">
      <GameCanvas />
      <PotatoVignette />
      <Hud />
      <AudioSystem />
    </div>
  )
}
