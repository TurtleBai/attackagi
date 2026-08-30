'use client'
import { useEffect, useRef, useState } from 'react'
import { Progress } from '@/components/ui/progress'
import { WAVES } from '@/game/constants'
import { events } from '@/game/events'
import { useGame } from '@/game/store'
import type { WeaponSlot } from '@/game/types'
import { world } from '@/game/world'
import { cn } from '@/lib/utils'
import { HudPanel, MONO_LABEL, useRafLoop } from './Hud.shared'

/** In-combat overlay: crosshair, HP, weapons, dodge, banners, boss bar, warnings. */

export function CombatHud() {
  return (
    <>
      <TopStatus />
      <WaveBanner />
      <BossBar />
      <KillCounter />
      <Crosshair />
      <HpPanel />
      <WeaponPanel />
      <DodgePip />
      <StingerLayer />
      <WarningOverlay />
    </>
  )
}

// ─── Top-left system status line ─────────────────────────────────────────────

const PHASE_LABEL: Record<string, string> = {
  wave: 'WAVE PROTOCOL ACTIVE',
  buffSelect: 'COMBAT SUSPENDED',
  smash: 'SEISMIC EVENT DETECTED',
  boss: 'DIRECT ENGAGEMENT',
}

function TopStatus() {
  const phase = useGame((s) => s.phase)
  const danger = phase === 'smash' || phase === 'boss'
  return (
    <div className="absolute top-4 left-4 flex items-center gap-2 font-mono text-[10px] tracking-[0.28em]">
      <span className={cn('inline-block size-1.5 rounded-full', danger ? 'bg-red-500 animate-pulse' : 'bg-emerald-400')} />
      <span className={cn(danger ? 'text-red-300/90' : 'text-muted-foreground/90')}>
        UPLINK STABLE // {PHASE_LABEL[phase] ?? 'STANDBY'}
      </span>
      <span className="animate-pulse text-muted-foreground/60">█</span>
    </div>
  )
}

// ─── Crosshair + bat charge ring + molotov aim hint ──────────────────────────

const RING_R = 21
const RING_C = 2 * Math.PI * RING_R

function Crosshair() {
  const weapon = useGame((s) => s.weapon)
  const aiming = useGame((s) => s.aimingMolotov)
  const ringRef = useRef<SVGCircleElement>(null)
  const groupRef = useRef<SVGGElement>(null)

  useRafLoop(() => {
    const g = groupRef.current
    const ring = ringRef.current
    if (!g || !ring) return
    const s = useGame.getState()
    const show = s.weapon === 2 && s.batCharge > 0.001
    g.style.opacity = show ? '1' : '0'
    if (!show) return
    const c = Math.min(1, s.batCharge)
    ring.style.strokeDashoffset = String(RING_C * (1 - c))
    if (c >= 1) {
      // max charge: flash white in sync with the bat (deterministic off world.time)
      const on = Math.sin(world.time * 16) > 0
      ring.style.stroke = on ? '#ffffff' : '#fbbf24'
      ring.style.filter = on
        ? 'drop-shadow(0 0 7px rgba(255,255,255,0.95))'
        : 'drop-shadow(0 0 4px rgba(251,191,36,0.8))'
    } else {
      ring.style.stroke = '#fbbf24'
      ring.style.filter = c > 0.85 ? 'drop-shadow(0 0 3px rgba(251,191,36,0.6))' : 'none'
    }
  })

  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
      <svg width={56} height={56} viewBox="0 0 56 56" className="text-foreground/90 drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]">
        {/* ticks */}
        <g stroke="currentColor" strokeWidth={1.8} strokeLinecap="square" opacity={0.92}>
          <path d="M28 8v8" />
          <path d="M28 40v8" />
          <path d="M8 28h8" />
          <path d="M40 28h8" />
        </g>
        {/* center dot */}
        <circle cx={28} cy={28} r={1.7} fill="currentColor" />
        {/* bat charge ring track (visible whenever bat is out) */}
        <circle
          cx={28} cy={28} r={RING_R} fill="none" stroke="currentColor" strokeWidth={2.5}
          className={cn('transition-opacity duration-150', weapon === 2 ? 'opacity-20' : 'opacity-0')}
        />
        {/* bat charge progress (rAF-driven) */}
        <g ref={groupRef} style={{ opacity: 0 }}>
          <circle
            ref={ringRef}
            cx={28} cy={28} r={RING_R} fill="none" strokeWidth={3}
            stroke="#fbbf24" strokeLinecap="butt"
            strokeDasharray={RING_C} strokeDashoffset={RING_C}
            transform="rotate(-90 28 28)"
          />
        </g>
        {/* molotov aim ring */}
        {weapon === 3 && aiming && (
          <circle
            cx={28} cy={28} r={25} fill="none" stroke="#fbbf24" strokeWidth={1.4}
            strokeDasharray="3 7" className="animate-spin origin-center opacity-80"
            style={{ animationDuration: '7s' }}
          />
        )}
      </svg>
      {weapon === 3 && aiming && (
        <span className="absolute top-full left-1/2 mt-2 -translate-x-1/2 font-mono text-[9px] tracking-[0.3em] whitespace-nowrap text-amber-300/90">
          LMB THROW
        </span>
      )}
    </div>
  )
}

// ─── HP panel (bottom-left) ──────────────────────────────────────────────────

function HpPanel() {
  const hp = useGame((s) => s.hp)
  const maxHp = useGame((s) => s.stats.maxHp)
  const pct = maxHp > 0 ? Math.max(0, (hp / maxHp) * 100) : 0
  const low = pct < 30
  const mid = pct < 60
  return (
    <HudPanel
      className={cn('absolute bottom-4 left-4 w-64 px-3.5 py-3', low && 'border-red-500/60')}
      accent={low ? 'border-red-500/70' : undefined}
    >
      <div className="mb-2 flex items-end justify-between">
        <span className={MONO_LABEL}>INTEGRITY</span>
        <span className={cn('font-mono text-sm leading-none tabular-nums', low ? 'text-red-400' : 'text-foreground/90')}>
          {Math.ceil(hp)}
          <span className="text-muted-foreground/70"> / {maxHp}</span>
        </span>
      </div>
      <div className={cn('relative', low && 'animate-pulse')}>
        <Progress
          value={pct}
          className={cn(
            'block gap-0',
            '[&_[data-slot=progress-track]]:h-2.5 [&_[data-slot=progress-track]]:rounded-[2px] [&_[data-slot=progress-track]]:bg-muted/40',
            '[&_[data-slot=progress-indicator]]:transition-[width] [&_[data-slot=progress-indicator]]:duration-200',
            low
              ? '[&_[data-slot=progress-indicator]]:bg-red-500'
              : mid
                ? '[&_[data-slot=progress-indicator]]:bg-amber-400'
                : '[&_[data-slot=progress-indicator]]:bg-emerald-400',
          )}
        />
        {/* segment ticks */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent 0, transparent calc(10% - 1px), rgba(8,10,18,0.7) calc(10% - 1px), rgba(8,10,18,0.7) 10%)',
          }}
        />
      </div>
    </HudPanel>
  )
}

// ─── Weapon panel + slot pills (bottom-right) ────────────────────────────────

const WEAPON_META: Record<WeaponSlot, { name: string; hint: string; tag: string }> = {
  1: { name: 'M9 SIDEARM', hint: 'HOLD LMB · R RELOAD', tag: 'PST' },
  2: { name: 'CQC BAT', hint: 'HOLD LMB · CHARGE ×3', tag: 'BAT' },
  3: { name: 'MOLOTOV', hint: 'RMB AIM · LMB THROW', tag: 'MLT' },
}

/** Minimal weapon silhouettes (currentColor) for the panel header + slot pills. */
function WeaponIcon({ slot, className }: { slot: WeaponSlot; className?: string }) {
  if (slot === 1) {
    // pistol: slide, grip, trigger guard
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <path
          fill="currentColor"
          d="M2 7h18v4.2h-6.9l-.9 1.9h-2.4l.6-1.9H9.2l-1.9 6.4H3.4l1.9-6.4H2V7Zm16.6 4.2h1.9l.9-1.4h-2.8v1.4Z"
        />
      </svg>
    )
  }
  if (slot === 2) {
    // baseball bat: tapered barrel + handle + knob
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <path
          d="M18.2 5.8 9.6 14.4"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
        />
        <path d="M9.6 14.4 5.2 18.8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <circle cx="4.6" cy="19.4" r="1.7" fill="currentColor" />
      </svg>
    )
  }
  // molotov: flame, rag, neck, bottle
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M13.6 1.2c1.9 1.3 2.4 2.9 1.3 4.4h-2.2c-.5-1.3.2-2 .6-2.8.2-.5.3-1 .3-1.6ZM10.7 6.4h3.4v2.2h-3.4V6.4Zm-1.2 3c-1.3.5-2.2 1.8-2.2 3.2v6.2A3.2 3.2 0 0 0 10.5 22h3.8a3.2 3.2 0 0 0 3.2-3.2v-6.2c0-1.4-.9-2.7-2.2-3.2H9.5Zm.4 4.4 4.9-2.4c.6.4 1 1 1 1.8l-5.9 2.9v-2.3Z"
      />
    </svg>
  )
}

function WeaponPanel() {
  const weapon = useGame((s) => s.weapon)
  const ammoInMag = useGame((s) => s.ammoInMag)
  const ammoReserve = useGame((s) => s.ammoReserve)
  const molotovs = useGame((s) => s.molotovs)
  const capacity = useGame((s) => s.stats.molotovCapacity)
  const reloading = useGame((s) => s.reloading)
  const reloadRef = useRef<HTMLDivElement>(null)

  // reload progress micro-bar: width tween driven by the reloadStart event
  useEffect(
    () =>
      events.on('reloadStart', ({ duration }) => {
        const el = reloadRef.current
        if (!el) return
        el.style.transition = 'none'
        el.style.width = '0%'
        void el.offsetWidth // reflow so the next transition starts from 0
        el.style.transition = `width ${duration}s linear`
        el.style.width = '100%'
      }),
    [],
  )

  const meta = WEAPON_META[weapon]
  const magLow = ammoInMag <= 2
  const magEmpty = ammoInMag <= 0

  return (
    <div className="absolute right-4 bottom-4 flex flex-col items-end gap-1.5">
      {([1, 2, 3] as const).map((slot) => (
        <WeaponCard key={slot} slot={slot} active={weapon === slot} molotovs={molotovs} />
      ))}
      <div className="mt-1 flex w-44 flex-col rounded-md border border-border/70 bg-background/65 px-3 py-2 backdrop-blur-sm">
        <div className="flex items-baseline justify-center gap-1.5 font-mono text-[28px] leading-none font-black tabular-nums">
          {weapon === 1 &&
            (reloading ? (
              <span className="animate-pulse text-xl tracking-[0.25em] text-amber-300">RELOADING</span>
            ) : (
              <>
                <span className={cn(magEmpty ? 'text-red-400' : magLow ? 'text-amber-300' : 'text-foreground')}>
                  {ammoInMag}
                </span>
                <span className="text-xl text-muted-foreground/70">|</span>
                <span className={cn('text-[22px]', ammoReserve <= 0 ? 'text-red-400/90' : 'text-foreground/80')}>
                  {ammoReserve}
                </span>
                {(magLow || ammoReserve <= 0) && (
                  <span
                    className={cn(
                      'animate-pulse pl-1 text-xl',
                      magEmpty || ammoReserve <= 0 ? 'text-red-500' : 'text-amber-400',
                    )}
                  >
                    !!!
                  </span>
                )}
              </>
            ))}
          {weapon === 2 && <span className="text-xl tracking-[0.3em] text-foreground">MELEE</span>}
          {weapon === 3 && (
            <>
              <span className={cn(molotovs <= 0 ? 'text-red-400' : 'text-foreground')}>×{molotovs}</span>
              <span className="text-xl text-muted-foreground/70">|</span>
              <span className="text-[22px] text-foreground/80">{capacity}</span>
              {molotovs <= 0 && <span className="animate-pulse pl-1 text-xl text-red-500">!!!</span>}
            </>
          )}
        </div>
        <div className={cn('mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-muted/40', !reloading && 'opacity-0')}>
          <div ref={reloadRef} className="h-full bg-amber-400" style={{ width: '0%' }} />
        </div>
        <span className="mt-1 text-center font-mono text-[9px] tracking-[0.2em] text-muted-foreground/80">{meta.hint}</span>
      </div>
    </div>
  )
}

/** Icon-forward weapon tile (reference-style stack): big pictogram, name below,
 *  count badge for consumables, amber highlight on the equipped slot. */
function WeaponCard({ slot, active, molotovs }: { slot: WeaponSlot; active: boolean; molotovs: number }) {
  const meta = WEAPON_META[slot]
  return (
    <div
      className={cn(
        'relative flex h-[4.4rem] w-24 flex-col items-center justify-center gap-1 rounded-md border backdrop-blur-sm transition-all duration-150',
        active
          ? 'border-amber-300/80 bg-background/75 shadow-[0_0_16px_-4px_rgba(252,211,77,0.85)]'
          : 'border-border/70 bg-background/45 opacity-75',
      )}
    >
      <span className="absolute top-1 left-1.5 font-mono text-[9px] leading-none text-muted-foreground/80">{slot}</span>
      {slot === 3 && (
        <span
          className={cn(
            'absolute top-1 right-1.5 font-mono text-[10px] leading-none font-bold',
            molotovs <= 0 ? 'text-red-400' : 'text-amber-200',
          )}
        >
          ×{molotovs}
        </span>
      )}
      <WeaponIcon slot={slot} className={cn('size-7', active ? 'text-amber-100' : 'text-muted-foreground')} />
      <span
        className={cn(
          'px-1 text-center font-mono text-[8px] leading-none tracking-[0.14em]',
          active ? 'text-orange-300' : 'text-orange-400/60',
        )}
      >
        {meta.name}
      </span>
    </div>
  )
}

// ─── Dodge cooldown pip (bottom-center, rAF off world.player) ────────────────

const PIP_R = 12
const PIP_C = 2 * Math.PI * PIP_R

function DodgePip() {
  const arcRef = useRef<SVGCircleElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const wasReady = useRef(true)

  useRafLoop(() => {
    const arc = arcRef.current
    const wrap = wrapRef.current
    if (!arc || !wrap) return
    const cd = useGame.getState().stats.dodgeCooldown
    const remaining = Math.max(0, world.player.dodgeReadyAt - world.time)
    const frac = cd > 0 ? 1 - Math.min(1, remaining / cd) : 1
    const ready = remaining <= 0
    arc.style.strokeDashoffset = String(PIP_C * (1 - frac))
    arc.style.stroke = ready ? '#e2e8f0' : '#f59e0b'
    arc.style.filter = ready ? 'drop-shadow(0 0 4px rgba(226,232,240,0.7))' : 'none'
    wrap.style.opacity = ready ? '1' : '0.72'
    if (ready && !wasReady.current) {
      wrap.classList.remove('hud-ready-flash')
      void wrap.offsetWidth
      wrap.classList.add('hud-ready-flash')
    }
    wasReady.current = ready
  })

  return (
    <div ref={wrapRef} className="absolute bottom-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1">
      <svg width={34} height={34} viewBox="0 0 34 34">
        <circle cx={17} cy={17} r={PIP_R} fill="none" stroke="currentColor" strokeWidth={2} className="text-muted/60" />
        <circle
          ref={arcRef}
          cx={17} cy={17} r={PIP_R} fill="none" strokeWidth={2.5} stroke="#e2e8f0"
          strokeDasharray={PIP_C} strokeDashoffset={0} strokeLinecap="round"
          transform="rotate(-90 17 17)"
        />
        <g stroke="currentColor" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" className="text-foreground/80">
          <path d="M12 12l4.5 5-4.5 5" />
          <path d="M18 12l4.5 5-4.5 5" />
        </g>
      </svg>
      <span className="font-mono text-[9px] tracking-[0.3em] text-muted-foreground">SHIFT</span>
    </div>
  )
}

// ─── Wave banner + kill counter (top) ────────────────────────────────────────

function WaveBanner() {
  const phase = useGame((s) => s.phase)
  const wave = useGame((s) => s.wave)
  const remaining = useGame((s) => s.enemiesRemaining)
  if (phase !== 'wave') return null
  return (
    <div key={wave} className="hud-banner-in absolute top-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <div className="font-mono text-2xl font-bold tracking-[0.35em] text-foreground/95 drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
        WAVE {wave} <span className="text-muted-foreground">/ {WAVES.length}</span>
      </div>
      <div className="flex items-center gap-2 rounded-[3px] border border-border bg-background/55 px-2.5 py-1 backdrop-blur-sm">
        <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
        <span className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground">
          HOSTILES <span className="text-red-300/90 tabular-nums">{String(Math.max(0, remaining)).padStart(2, '0')}</span>
        </span>
      </div>
    </div>
  )
}

function KillCounter() {
  const kills = useGame((s) => s.kills)
  return (
    <HudPanel className="absolute top-4 right-4 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className={MONO_LABEL}>KILLS</span>
        <span className="font-mono text-lg leading-none tabular-nums text-amber-200">{String(kills).padStart(3, '0')}</span>
      </div>
    </HudPanel>
  )
}

// ─── Boss health bar ─────────────────────────────────────────────────────────

function BossBar() {
  const visible = useGame((s) => s.bossBarVisible)
  const bossHp = useGame((s) => s.bossHp)
  const bossMaxHp = useGame((s) => s.bossMaxHp)
  if (!visible) return null
  const frac = bossMaxHp > 0 ? Math.max(0, bossHp / bossMaxHp) : 0
  const pct = bossHp > 0 ? Math.max(1, Math.round(frac * 100)) : 0
  return (
    <div className="hud-banner-in absolute top-5 left-1/2 w-[min(44rem,78vw)] -translate-x-1/2">
      <div className="relative mb-1.5 flex items-end justify-center px-0.5">
        <span className="font-mono text-sm font-bold tracking-[0.45em] text-red-400 drop-shadow-[0_0_10px_rgba(239,68,68,0.7)]">
          A.G.I.
        </span>
        <span className="absolute right-0.5 bottom-0 font-mono text-xs tabular-nums text-red-300/80">{pct}%</span>
      </div>
      <div className="relative rounded-[3px] border border-red-500/40 bg-background/60 p-[3px] shadow-[0_0_26px_-6px_rgba(239,68,68,0.55)] backdrop-blur-sm">
        <Progress
          value={frac * 100}
          className={cn(
            'block gap-0',
            '[&_[data-slot=progress-track]]:h-3 [&_[data-slot=progress-track]]:rounded-[2px] [&_[data-slot=progress-track]]:bg-red-950/50',
            '[&_[data-slot=progress-indicator]]:bg-linear-to-r [&_[data-slot=progress-indicator]]:from-red-600 [&_[data-slot=progress-indicator]]:via-red-500 [&_[data-slot=progress-indicator]]:to-orange-400',
            '[&_[data-slot=progress-indicator]]:transition-[width] [&_[data-slot=progress-indicator]]:duration-300',
          )}
        />
        {/* segment ticks */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-[3px]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent 0, transparent calc(100%/12 - 1px), rgba(8,10,18,0.75) calc(100%/12 - 1px), rgba(8,10,18,0.75) calc(100%/12))',
          }}
        />
      </div>
    </div>
  )
}

// ─── Giant warning (JUMP!) ───────────────────────────────────────────────────

const HAZARD_STRIPES: React.CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(45deg, #ef4444 0 14px, transparent 14px 28px)',
}

function WarningOverlay() {
  const warning = useGame((s) => s.warning)
  if (!warning) return null
  return (
    <>
      <div
        aria-hidden
        className="absolute inset-0 animate-pulse"
        style={{ background: 'radial-gradient(ellipse at center, transparent 45%, rgba(239,68,68,0.3) 100%)' }}
      />
      <div className="absolute top-[24%] left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
        <div className="hud-march h-2 w-[28rem] max-w-[72vw] opacity-90" style={HAZARD_STRIPES} />
        <div className="hud-shake flex items-center gap-7">
          <span className="animate-pulse font-mono text-6xl font-black text-red-500/90">»</span>
          <span className="animate-pulse font-mono text-7xl font-black tracking-[0.25em] text-red-500 drop-shadow-[0_0_28px_rgba(239,68,68,0.95)] md:text-8xl">
            {warning}
          </span>
          <span className="animate-pulse font-mono text-6xl font-black text-red-500/90">«</span>
        </div>
        <div
          className="hud-march h-2 w-[28rem] max-w-[72vw] opacity-90"
          style={{ ...HAZARD_STRIPES, animationDirection: 'reverse' }}
        />
      </div>
    </>
  )
}

// ─── Transient stingers + pickup chips ───────────────────────────────────────

interface FxItem {
  id: number
  text: string
}

function StingerLayer() {
  const [stingers, setStingers] = useState<FxItem[]>([])
  const [chips, setChips] = useState<FxItem[]>([])

  useEffect(() => {
    let n = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t)
        fn()
      }, ms)
      timers.add(t)
    }
    const offs = [
      events.on('waveClear', () => {
        const id = ++n
        setStingers((cur) => [...cur.slice(-1), { id, text: 'WAVE CLEAR' }])
        later(1600, () => setStingers((cur) => cur.filter((f) => f.id !== id)))
      }),
      events.on('pickup', () => {
        const id = ++n
        setChips((cur) => [...cur.slice(-2), { id, text: 'AMMO RESTOCKED' }])
        later(1900, () => setChips((cur) => cur.filter((f) => f.id !== id)))
      }),
    ]
    return () => {
      offs.forEach((off) => off())
      timers.forEach((t) => clearTimeout(t))
    }
  }, [])

  return (
    <>
      <div className="absolute top-[36%] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {stingers.map((f) => (
          <span
            key={f.id}
            className="hud-stinger font-mono text-4xl font-bold tracking-[0.5em] text-amber-200 drop-shadow-[0_0_22px_rgba(252,211,77,0.7)]"
          >
            {f.text}
          </span>
        ))}
      </div>
      <div className="absolute bottom-28 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1">
        {chips.map((f) => (
          <span
            key={f.id}
            className="hud-chip rounded-[3px] border border-emerald-300/40 bg-emerald-500/10 px-3 py-1 font-mono text-[11px] tracking-[0.25em] text-emerald-300 backdrop-blur-sm"
          >
            {f.text}
          </span>
        ))}
      </div>
    </>
  )
}
