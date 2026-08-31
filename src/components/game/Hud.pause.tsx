'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Kbd } from '@/components/ui/kbd'
import { Slider } from '@/components/ui/slider'
import { resolvedTier } from '@/game/quality'
import {
  ACTION_LABELS, keyLabel, useSettings, type BindableAction, type GraphicsQuality,
} from '@/game/settings'
import { useGame } from '@/game/store'
import { cn } from '@/lib/utils'
import { GlitchText, uiClick } from './Hud.shared'

/** Pause overlay (phase 'paused'): resume/restart, mouse sensitivity, key rebinds. */

const BIND_ORDER: readonly BindableAction[] = [
  'forward', 'back', 'left', 'right',
  'jump', 'dodge', 'reload',
  'weapon1', 'weapon2', 'weapon3',
]

export function PauseScreen() {
  const sensitivity = useSettings((s) => s.lookSensitivity)
  const bindings = useSettings((s) => s.bindings)
  const quality = useSettings((s) => s.quality)
  const resolvedQuality = useSettings((s) => s.resolvedQuality)
  const [rebinding, setRebinding] = useState<BindableAction | null>(null)

  const resume = () => {
    uiClick()
    useGame.getState().resume()
  }

  // Esc resumes; while capturing a rebind, Esc cancels the capture instead.
  // Capture-phase listener so the Player/Weapons handlers never see these keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rebinding) {
        e.preventDefault()
        e.stopPropagation()
        if (e.code && e.code !== 'Escape') useSettings.getState().setBinding(rebinding, e.code)
        uiClick()
        setRebinding(null)
        return
      }
      if (e.code === 'Escape') resume()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [rebinding])

  return (
    <div
      className="pointer-events-auto absolute inset-0 flex items-center-safe justify-center overflow-y-auto pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur-sm"
      style={{ background: 'rgba(8,10,18,0.72)' }}
    >
      <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-5 py-8 duration-300 max-sm:gap-4">
        <div className="flex flex-col items-center gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.5em] text-amber-300/80">{'/// COMBAT SUSPENDED'}</span>
          <GlitchText text="PAUSED" className="font-mono text-5xl font-black tracking-[0.2em] text-foreground max-sm:text-4xl" />
        </div>

        <div className="flex flex-wrap items-start justify-center gap-4">
          <Card className="w-[19rem] max-w-[86vw] bg-background/55 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="font-mono text-[11px] tracking-[0.4em] text-muted-foreground">CALIBRATION</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] tracking-[0.18em] text-muted-foreground">
                    <span className="pointer-coarse:hidden">MOUSE SENSITIVITY</span>
                    <span className="hidden pointer-coarse:inline">TOUCH SENSITIVITY</span>
                  </span>
                  <span className="font-mono text-xs tabular-nums text-amber-300">{sensitivity.toFixed(2)}×</span>
                </div>
                <Slider
                  value={[sensitivity]}
                  min={0.3}
                  max={2.5}
                  step={0.05}
                  onValueChange={(v) => useSettings.getState().setSensitivity(Array.isArray(v) ? v[0] : (v as number))}
                />
                <div className="flex justify-between font-mono text-[9px] tracking-[0.2em] text-muted-foreground/60">
                  <span>0.30×</span>
                  <span>2.50×</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="font-mono text-[11px] tracking-[0.18em] text-muted-foreground">GRAPHICS</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {(['auto', 'potato', 'smooth', 'pretty'] as const satisfies readonly GraphicsQuality[]).map((q) => (
                    <button
                      key={q}
                      onClick={() => {
                        uiClick()
                        useSettings.getState().setQuality(q)
                      }}
                      className={cn(
                        'cursor-pointer rounded-[3px] border py-1.5 font-mono text-[10px] tracking-[0.25em] transition-colors',
                        quality === q
                          ? 'border-amber-300/80 bg-amber-400/10 text-amber-200'
                          : 'border-border bg-background/50 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {q === 'auto'
                        ? quality === 'auto'
                          ? `AUTO (${(resolvedQuality ?? resolvedTier()).toUpperCase()})`
                          : 'AUTO'
                        : q.toUpperCase()}
                    </button>
                  ))}
                </div>
                <span className="font-mono text-[9px] tracking-[0.15em] text-muted-foreground/60">
                  AUTO ADAPTS TO FPS · POTATO = MIN SPEC · PRETTY = FULL AO + AA
                </span>
              </div>

              <div className="flex flex-col gap-2 pt-1">
                <Button
                  onClick={resume}
                  className="h-11 border border-emerald-400/40 bg-emerald-600 font-mono text-sm font-bold tracking-[0.35em] text-white hover:bg-emerald-500"
                >
                  RESUME
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    uiClick()
                    useGame.getState().restart()
                  }}
                  className="h-9 font-mono text-[11px] tracking-[0.3em] text-muted-foreground pointer-coarse:h-11"
                >
                  RESTART RUN
                </Button>
              </div>
              <span className="text-center font-mono text-[9px] tracking-[0.2em] text-muted-foreground/60 pointer-coarse:hidden">
                ESC RESUMES · CLICK TO RECAPTURE CURSOR
              </span>
              <span className="hidden text-center font-mono text-[9px] tracking-[0.2em] text-amber-300/70 pointer-coarse:block">
                TOUCH CONTROLS ACTIVE
              </span>
            </CardContent>
          </Card>

          {/* key bindings are meaningless on touch — the virtual controls are fixed */}
          <Card className="w-[21rem] max-w-[86vw] bg-background/55 backdrop-blur-md pointer-coarse:hidden">
            <CardHeader>
              <CardTitle className="flex items-center justify-between font-mono text-[11px] tracking-[0.4em] text-muted-foreground">
                <span>KEY BINDINGS</span>
                <button
                  onClick={() => {
                    uiClick()
                    setRebinding(null)
                    useSettings.getState().resetDefaults()
                  }}
                  className="cursor-pointer font-mono text-[9px] tracking-[0.2em] text-muted-foreground/60 transition-colors hover:text-amber-300"
                >
                  RESET
                </button>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col">
              {BIND_ORDER.map((action) => {
                const active = rebinding === action
                return (
                  <button
                    key={action}
                    onClick={() => {
                      uiClick()
                      setRebinding(active ? null : action)
                    }}
                    className={cn(
                      'flex cursor-pointer items-center justify-between border-b border-border/40 py-1.5 text-left transition-colors last:border-0 hover:bg-muted/20',
                      active && 'bg-amber-400/10',
                    )}
                  >
                    <span className="font-mono text-[11px] tracking-[0.18em] text-muted-foreground">
                      {ACTION_LABELS[action].toUpperCase()}
                    </span>
                    <Kbd
                      className={cn(
                        'bg-muted/60 font-mono',
                        active && 'animate-pulse bg-amber-400/25 text-amber-200',
                      )}
                    >
                      {active ? 'PRESS KEY…' : keyLabel(bindings[action])}
                    </Kbd>
                  </button>
                )
              })}
              <span className="pt-2 text-center font-mono text-[9px] tracking-[0.2em] text-muted-foreground/60">
                CLICK A ROW, THEN PRESS THE NEW KEY · ESC CANCELS
              </span>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
