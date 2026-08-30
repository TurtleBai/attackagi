'use client'
import { useGame } from '@/game/store'
import { CombatHud } from './Hud.combat'
import { HudFx } from './Hud.fx'
import { PauseScreen } from './Hud.pause'
import { PerfHud } from './Hud.perf'
import { BuffSelect, DeathScreen, MenuScreen, VictoryScreen } from './Hud.screens'

// DOM overlay rendered outside the Canvas. Root is pointer-events-none;
// interactive screens (menu / buff select / death / victory) opt back in.
// The inner tree is keyed by runId so every piece of transient HUD state
// (stingers, vignettes, rAF-written styles) hard-resets on restart.
export function Hud() {
  const phase = useGame((s) => s.phase)
  const runId = useGame((s) => s.runId)
  const inCombat = phase === 'wave' || phase === 'smash' || phase === 'boss' || phase === 'buffSelect' || phase === 'paused'
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden text-foreground select-none">
      <HudStyles />
      <PerfHud />
      <div key={runId} className="absolute inset-0">
        <HudFx />
        {inCombat && <CombatHud />}
        {phase === 'menu' && <MenuScreen />}
        {phase === 'paused' && <PauseScreen />}
        {phase === 'buffSelect' && <BuffSelect />}
        {phase === 'dead' && <DeathScreen />}
        {phase === 'victory' && <VictoryScreen />}
      </div>
    </div>
  )
}

/** Keyframes Tailwind can't express — glitch slices, shakes, stingers. */
function HudStyles() {
  return (
    <style>{`
@keyframes hudGlitchA {
  0%, 84%, 100% { clip-path: inset(0 0 100% 0); transform: none; opacity: 0; }
  85% { clip-path: inset(6% 0 64% 0); transform: translate(-5px, -2px); opacity: 0.85; }
  88% { clip-path: inset(58% 0 10% 0); transform: translate(5px, 1px); opacity: 0.85; }
  91% { clip-path: inset(28% 0 46% 0); transform: translate(-3px, 2px); opacity: 0.7; }
  94% { clip-path: inset(78% 0 4% 0); transform: translate(4px, -1px); opacity: 0.8; }
  97% { clip-path: inset(12% 0 70% 0); transform: translate(-2px, 0); opacity: 0.6; }
}
@keyframes hudGlitchB {
  0%, 88%, 100% { clip-path: inset(0 0 100% 0); transform: none; opacity: 0; }
  89% { clip-path: inset(64% 0 6% 0); transform: translate(4px, 2px); opacity: 0.8; }
  92% { clip-path: inset(8% 0 74% 0); transform: translate(-5px, -1px); opacity: 0.8; }
  95% { clip-path: inset(40% 0 34% 0); transform: translate(3px, 1px); opacity: 0.65; }
  98% { clip-path: inset(70% 0 12% 0); transform: translate(-4px, 2px); opacity: 0.75; }
}
.hud-glitch-a { animation: hudGlitchA 3.4s steps(1, end) infinite; }
.hud-glitch-b { animation: hudGlitchB 2.55s steps(1, end) 0.7s infinite; }

@keyframes hudBannerIn {
  0% { opacity: 0; transform: translateY(-16px); }
  60% { opacity: 1; transform: translateY(2px); }
  100% { opacity: 1; transform: none; }
}
.hud-banner-in { animation: hudBannerIn 0.45s cubic-bezier(0.2, 0.9, 0.3, 1) both; }

@keyframes hudStinger {
  0% { opacity: 0; transform: scale(0.82); filter: blur(4px); }
  12% { opacity: 1; transform: scale(1.03); filter: blur(0); }
  20% { transform: scale(1); }
  78% { opacity: 1; }
  100% { opacity: 0; transform: scale(1.06); filter: blur(2px); }
}
.hud-stinger { animation: hudStinger 1.5s ease both; }

@keyframes hudChip {
  0% { opacity: 0; transform: translateY(8px); }
  10%, 80% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: translateY(-6px); }
}
.hud-chip { animation: hudChip 1.8s ease both; }

@keyframes hudShake {
  0%, 100% { transform: translate(0, 0); }
  20% { transform: translate(-4px, 2px); }
  40% { transform: translate(3px, -2px); }
  60% { transform: translate(-2px, -1px); }
  80% { transform: translate(2px, 1px); }
}
.hud-shake { animation: hudShake 0.4s linear infinite; }

@keyframes hudMarch {
  from { background-position: 0 0; }
  to { background-position: 40px 0; }
}
.hud-march { animation: hudMarch 0.5s linear infinite; }

@keyframes hudFlash {
  0% { filter: brightness(3) drop-shadow(0 0 8px rgba(255, 255, 255, 0.9)); }
  100% { filter: none; }
}
.hud-ready-flash { animation: hudFlash 0.35s ease-out both; }
    `}</style>
  )
}
