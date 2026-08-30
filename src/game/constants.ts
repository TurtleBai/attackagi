// All game tuning lives here. Systems read buffable values via store.stats, not from here directly.

// ─── Arena ───────────────────────────────────────────────────────────────────
export const ARENA_RADIUS = 42 // playable disc radius (m)
export const GRAVITY = 26

// ─── Frame priorities (useFrame order; lower runs first) ─────────────────────
export const FRAME_PRIO = {
  director: -100,
  player: -90,
  weapons: -80,
  enemies: -70,
  boss: -60,
  projectiles: -50,
  hazards: -45,
  vfx: -20,
} as const

// ─── Player ──────────────────────────────────────────────────────────────────
export const PLAYER_HP = 100
export const PLAYER_EYE = 1.7
export const PLAYER_RADIUS = 0.45
export const PLAYER_SPEED = 9.5 // fast walk (m/s)
export const JUMP_VELOCITY = 9.5
export const DODGE_SPEED = 26
export const DODGE_TIME = 0.22
export const DODGE_IFRAMES = 0.38
export const DODGE_COOLDOWN = 2.0

// ─── Revolver (slot 1 sidearm) ───────────────────────────────────────────────
export const PISTOL_DAMAGE = 20
export const PISTOL_MAG = 6 // cylinder
export const PISTOL_RESERVE_START = 90
export const PISTOL_FIRE_INTERVAL = 0.26 // min seconds between shots (full-auto while held)
export const PISTOL_RELOAD = 1.5 // swing out, eject, speedload, snap shut
export const PISTOL_RANGE = 120

// ─── Baseball bat ────────────────────────────────────────────────────────────
export const BAT_DAMAGE = 30
export const BAT_RANGE = 3.0
export const BAT_ARC = Math.PI * 0.7 // horizontal arc centered on view
export const BAT_SWING_TIME = 0.32
export const BAT_CHARGE_TIME = 2.5 // seconds to reach max charge
export const BAT_CHARGED_MULT = 3.0 // max-charge damage multiplier

// ─── Molotov ─────────────────────────────────────────────────────────────────
export const MOLOTOV_START = 2
export const MOLOTOV_CAPACITY = 4
export const MOLOTOV_PER_CRATE = 2
export const MOLOTOV_DAMAGE = 45 // impact explosion
export const MOLOTOV_RADIUS = 4.5
export const MOLOTOV_THROW_SPEED = 22
export const FIRE_DURATION = 6.0
export const FIRE_DPS = 22

// ─── Ammo crates ─────────────────────────────────────────────────────────────
export const CRATE_INTERVAL = 14 // seconds between spawns during waves
export const CRATE_MAX = 3
export const CRATE_PICKUP_RADIUS = 1.6

// ─── Enemies ─────────────────────────────────────────────────────────────────
export const MAX_CONCURRENT_ENEMIES = 22
export const MELEE_HP = 36
export const MELEE_DAMAGE = 10
export const MELEE_SPEED = 5.2
export const MELEE_RANGE = 2.2
export const MELEE_SWING_TIME = 0.5

export const RANGER_HP = 22
export const RANGER_DAMAGE = 7
export const RANGER_INTERVAL = 2.4
export const RANGER_BOLT_SPEED = 15 // slow, dodgeable

export const TANK_HP = 36
export const TANK_DAMAGE = 22
export const TANK_SPEED = 3.6
export const TANK_WINDUP = 1.5 // stands still telegraphing before bash
export const TANK_BASH_SPEED = 18
export const TANK_BASH_DIST = 12
export const TANK_BASH_WIDTH = 2.2
export const TANK_SHIELD_ARC = Math.PI * 0.62 // frontal cone that blocks bullets

export const SNIPER_HP = 22
export const SNIPER_DAMAGE = 26
export const SNIPER_INTERVAL = 5.0
export const SNIPER_AIM_TIME = 1.4 // red line telegraph duration

/** When this many (or fewer) enemies remain in a wave, stragglers get a glowing outline. */
export const STRAGGLER_OUTLINE_COUNT = 5

// ─── Waves: [melee, ranger, tank, sniper] ────────────────────────────────────
export const WAVES: ReadonlyArray<readonly [number, number, number, number]> = [
  [20, 10, 0, 0],
  [20, 10, 5, 0],
  [20, 10, 10, 5],
  [20, 10, 20, 10],
  [10, 20, 20, 10],
]
export const DROP_BATCH = 5 // enemies per AGI hand drop
export const DROP_INTERVAL = 4.0 // seconds between drop requests while under cap

// ─── Boss ────────────────────────────────────────────────────────────────────
export const BOSS_HP = 1100
export const SMASH_WARN_TIME = 2.6 // ground glows red + JUMP! before impact
export const SMASH_DAMAGE = 40
export const BOSS_TIRED_TIME = 7.0
export const BOSS_PATTERNS_PER_CYCLE = 3
export const PUNCH_HAND_HP_LIMIT = 60 // max damage extractable per lingering hand
export const PUNCH_DAMAGE = 30
export const PUNCH_LINGER = 3.2
export const ROCKET_COUNT = 26
export const ROCKET_RADIUS = 3.4
export const ROCKET_DAMAGE = 24
export const ROCKET_TELEGRAPH = 1.5
export const DEATHBEAM_WIDTH = 5.0
export const DEATHBEAM_TELEGRAPH = 1.6
export const DEATHBEAM_SWEEP_TIME = 2.8
export const MINIGUN_SPINUP = 5.0
export const MINIGUN_FIRE_TIME = 4.0
export const BOSS_BOLT_SPEED = 26 // fast but outrunnable
export const BOSS_BOLT_DAMAGE = 8
export const STRIPE_COUNT = 6
export const STRIPE_WIDTH = 3.2
export const STRIPE_GAP = 4.6
export const STRIPE_TELEGRAPH = 1.5
export const STRIPE_BARRAGES = 3
export const STRIPE_DAMAGE = 35

// ─── Buffs ───────────────────────────────────────────────────────────────────
export type BuffId =
  | 'hollowPoints' | 'extendedMag' | 'deepPockets' | 'rapidFire' | 'quickHands'
  | 'slugger' | 'quickWindup' | 'arsonist' | 'biggerSplash'
  | 'fleetFooted' | 'phantomStep' | 'plating' | 'fieldMedic'

export interface BuffDef {
  id: BuffId
  name: string
  desc: string
  icon: string // emoji for HUD cards
}

export const BUFFS: Record<BuffId, BuffDef> = {
  hollowPoints: { id: 'hollowPoints', name: 'Hollow Points', desc: '+40% pistol damage', icon: '🎯' },
  extendedMag: { id: 'extendedMag', name: 'Extended Mag', desc: '+4 magazine size', icon: '📏' },
  deepPockets: { id: 'deepPockets', name: 'Deep Pockets', desc: '+24 reserve ammo capacity (and refill)', icon: '🎒' },
  rapidFire: { id: 'rapidFire', name: 'Rapid Fire', desc: '+30% pistol fire rate', icon: '⚡' },
  quickHands: { id: 'quickHands', name: 'Quick Hands', desc: '30% faster reload', icon: '🧤' },
  slugger: { id: 'slugger', name: 'Slugger', desc: '+50% bat damage', icon: '💥' },
  quickWindup: { id: 'quickWindup', name: 'Quick Wind-Up', desc: 'Bat charges 35% faster', icon: '⏱️' },
  arsonist: { id: 'arsonist', name: 'Arsonist', desc: '+1 molotov capacity, +30% fire damage', icon: '🔥' },
  biggerSplash: { id: 'biggerSplash', name: 'Bigger Splash', desc: '+35% molotov blast radius', icon: '🫧' },
  fleetFooted: { id: 'fleetFooted', name: 'Fleet Footed', desc: '+12% move speed', icon: '👟' },
  phantomStep: { id: 'phantomStep', name: 'Phantom Step', desc: 'Dodge cooldown −0.6s', icon: '👻' },
  plating: { id: 'plating', name: 'Reinforced Plating', desc: '+25 max HP and heal 25', icon: '🛡️' },
  fieldMedic: { id: 'fieldMedic', name: 'Field Medic', desc: 'Heal 40% of max HP after each wave', icon: '💉' },
}
