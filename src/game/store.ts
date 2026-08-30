'use client'
import { create } from 'zustand'
import {
  BAT_CHARGE_TIME, BAT_DAMAGE, BUFFS, DODGE_COOLDOWN, MOLOTOV_CAPACITY, MOLOTOV_RADIUS,
  MOLOTOV_START, PISTOL_DAMAGE, PISTOL_FIRE_INTERVAL, PISTOL_MAG, PISTOL_RELOAD,
  PISTOL_RESERVE_START, PLAYER_HP, BOSS_HP, type BuffId,
} from './constants'
import type { GamePhase, OwnedBuffs, PlayerStats, WeaponSlot } from './types'

function computeStats(buffs: OwnedBuffs): PlayerStats {
  const n = (id: BuffId) => buffs[id] ?? 0
  return {
    maxHp: PLAYER_HP + 25 * n('plating'),
    moveSpeedMult: 1 + 0.12 * n('fleetFooted'),
    // floor 1.2s: with 0.38s i-frames, anything lower makes stacked Phantom
    // Step a near-permanent invulnerability loop (and trivializes the death beam)
    dodgeCooldown: Math.max(1.2, DODGE_COOLDOWN - 0.6 * n('phantomStep')),
    pistolDamage: PISTOL_DAMAGE * (1 + 0.4 * n('hollowPoints')),
    magSize: PISTOL_MAG + 4 * n('extendedMag'),
    reserveMax: PISTOL_RESERVE_START + 24 * n('deepPockets'),
    fireInterval: PISTOL_FIRE_INTERVAL / (1 + 0.3 * n('rapidFire')),
    reloadTime: PISTOL_RELOAD * Math.pow(0.7, n('quickHands')),
    batDamage: BAT_DAMAGE * (1 + 0.5 * n('slugger')),
    batChargeTime: BAT_CHARGE_TIME * Math.pow(0.65, n('quickWindup')),
    molotovCapacity: MOLOTOV_CAPACITY + n('arsonist'),
    molotovRadius: MOLOTOV_RADIUS * (1 + 0.35 * n('biggerSplash')),
    fireDpsMult: 1 + 0.3 * n('arsonist'),
    healOnWaveClear: 0.4 * n('fieldMedic'),
  }
}

interface GameState {
  phase: GamePhase
  wave: number // 1..5, valid during wave/buffSelect
  enemiesRemaining: number // yet-to-kill in current wave (spawned + unspawned)
  kills: number
  hp: number
  weapon: WeaponSlot
  ammoInMag: number
  ammoReserve: number
  molotovs: number
  reloading: boolean
  batCharge: number // 0..1 while holding, for HUD ring
  aimingMolotov: boolean
  adsRevolver: boolean // revolver aim-down-sight active (HUD hides the crosshair)
  ownedBuffs: OwnedBuffs
  buffChoices: BuffId[] | null // non-null during buffSelect
  stats: PlayerStats
  bossHp: number
  bossMaxHp: number
  bossBarVisible: boolean
  warning: string | null // e.g. 'JUMP!'
  runId: number // increments on restart so systems can hard-reset
  pausedFrom: GamePhase | null // sim phase to return to on resume

  // actions
  set: (partial: Partial<GameState>) => void
  startGame: () => void
  restart: () => void
  pause: () => void
  resume: () => void
  damage: (amount: number) => void // called only by world.damagePlayer
  heal: (amount: number) => void
  offerBuffs: (choices: BuffId[]) => void
  chooseBuff: (id: BuffId) => void
}

const initialRun = () => {
  const stats = computeStats({})
  return {
    phase: 'menu' as GamePhase,
    wave: 0,
    enemiesRemaining: 0,
    kills: 0,
    hp: stats.maxHp,
    weapon: 1 as WeaponSlot,
    ammoInMag: stats.magSize,
    ammoReserve: stats.reserveMax,
    molotovs: MOLOTOV_START,
    reloading: false,
    batCharge: 0,
    aimingMolotov: false,
    adsRevolver: false,
    ownedBuffs: {} as OwnedBuffs,
    buffChoices: null,
    stats,
    bossHp: BOSS_HP,
    bossMaxHp: BOSS_HP,
    bossBarVisible: false,
    warning: null,
    pausedFrom: null as GamePhase | null,
  }
}

export const useGame = create<GameState>((set, get) => ({
  ...initialRun(),
  runId: 0,

  set: (partial) => set(partial),

  startGame: () => set({ phase: 'wave', wave: 1 }),

  restart: () => set({ ...initialRun(), runId: get().runId + 1, phase: 'wave', wave: 1 }),

  pause: () => {
    const { phase } = get()
    if (phase === 'wave' || phase === 'smash' || phase === 'boss') {
      set({ phase: 'paused', pausedFrom: phase })
    }
  },

  resume: () => {
    const { phase, pausedFrom } = get()
    if (phase === 'paused') set({ phase: pausedFrom ?? 'wave', pausedFrom: null })
  },

  damage: (amount) => {
    const { hp, phase } = get()
    if (phase === 'dead' || phase === 'victory') return
    const next = Math.max(0, hp - amount)
    set({ hp: next })
    if (next <= 0) set({ phase: 'dead' })
  },

  heal: (amount) => set((s) => ({ hp: Math.min(s.stats.maxHp, s.hp + amount) })),

  offerBuffs: (choices) => set({ phase: 'buffSelect', buffChoices: choices }),

  chooseBuff: (id) => {
    const s = get()
    const owned: OwnedBuffs = { ...s.ownedBuffs, [id]: (s.ownedBuffs[id] ?? 0) + 1 }
    const stats = computeStats(owned)
    const hpBonus = stats.maxHp - s.stats.maxHp
    set({
      ownedBuffs: owned,
      stats,
      buffChoices: null,
      hp: Math.min(stats.maxHp, s.hp + (hpBonus > 0 ? hpBonus : 0)),
      // clamp/replenish per-weapon resources against new caps
      ammoReserve: Math.min(stats.reserveMax, Math.max(s.ammoReserve, id === 'deepPockets' ? stats.reserveMax : s.ammoReserve)),
      molotovs: Math.min(stats.molotovCapacity, s.molotovs + (id === 'arsonist' ? 1 : 0)),
    })
  },
}))

export const allBuffIds = Object.keys(BUFFS) as BuffId[]

/** True when gameplay simulation should advance (systems early-return otherwise). */
export const simRunning = (phase: GamePhase): boolean =>
  phase === 'wave' || phase === 'smash' || phase === 'boss'
