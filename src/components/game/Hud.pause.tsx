'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Kbd } from '@/components/ui/kbd'
import { Slider } from '@/components/ui/slider'
import {
  ACTION_LABELS, keyLabel, useSettings, type BindableAction,
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
      className="pointer-events-auto absolute inset-0 flex items-center justify-center overflow-y-auto backdrop-blur-sm"
      style={{ background: 'rgba(8,10,18,0.72)' }}
    >
      <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-5 py-8 duration-300">
        <div className="flex flex-col items-center gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.5em] text-amber-300/80">{'/// COMBAT SUSPENDED'}</span>
          <GlitchText text="PAUSED" className="font-mono text-5xl font-black tracking-[0.2em] text-foreground" />
        </div>

        <div className="flex flex-wrap items-start justify-center gap-4">
          <Card className="w-[19rem] max-w-[86vw] bg-background/55 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="font-mono text-[11px] tracking-[0.4em] text-muted-foreground">CALIBRATION</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] tracking-[0.18em] text-muted-foreground">MOUSE SENSITIVITY</span>
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
                  className="h-9 font-mono text-[11px] tracking-[0.3em] text-muted-foreground"
                >
                  RESTART RUN
                </Button>
              </div>
              <span className="text-center font-mono text-[9px] tracking-[0.2em] text-muted-foreground/60">
                ESC RESUMES · CLICK TO RECAPTURE CURSOR
              </span>
            </CardContent>
          </Card>

          <Card className="w-[21rem] max-w-[86vw] bg-background/55 backdrop-blur-md">
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
