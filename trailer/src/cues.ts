// THE timeline. Shot boundaries and every timed event (shots fired, impacts,
// face flips, countdown beats, music sections) live here; shots read them to
// drive the picture and the OfflineAudioContext score reads the same list to
// place music + SFX, so audio and video share one clock by construction.
//
// Tempo: 120 BPM → beat = 0.5 s = 30 frames. Bars of 4 beats from t = 0.

export const BPM = 120
export const BEAT = 60 / BPM

export const SHOT = {
  open: [0.0, 4.0],
  drop: [4.0, 6.0],
  gun: [6.0, 8.0],
  reload: [8.0, 8.75],
  batWave: [8.75, 10.0],
  drone: [10.0, 11.0],
  droneKill: [11.0, 12.25],
  molotov: [12.25, 13.5],
  buffs: [13.5, 15.0],
  angry: [15.0, 16.0],
  jumpWide: [16.0, 18.0],
  jump1: [18.0, 19.0],
  silent: [19.0, 19.5],
  smash: [19.5, 21.0],
  rockets: [21.0, 22.0],
  beam: [22.0, 23.25],
  minigun: [23.25, 24.0],
  slam: [24.0, 24.75],
  tired: [24.75, 26.0],
  bat: [26.0, 27.25],
  unplug: [27.25, 28.0],
  title: [28.0, 30.0],
} as const satisfies Record<string, readonly [number, number]>

export type CueKind =
  // music structure
  | 'section'
  // sfx
  | 'crtBlip' | 'crtBoot' | 'whoosh' | 'subBoom' | 'servo' | 'handOpen' | 'robotLand'
  | 'revolver' | 'headshot' | 'reloadOpen' | 'reloadEject' | 'reloadInsert' | 'reloadSnap'
  | 'droneWhine' | 'warnBeep' | 'bombDrop' | 'explosion' | 'droneDown'
  | 'molotovThrow' | 'glassBreak' | 'fireWhoosh'
  | 'uiCard' | 'uiPick'
  | 'alarm' | 'countBeat' | 'smash' | 'debris'
  | 'rocketSalvo' | 'beamCharge' | 'beamFire' | 'minigun' | 'slam' | 'hurt'
  | 'batCharge' | 'batSwing' | 'batHit' | 'batCrack' | 'crtOff' | 'titleHit'

export interface Cue {
  t: number
  kind: CueKind
  /** free-form parameters (section name, intensity, pan, duration…) */
  p?: Record<string, number | string>
}

export const CUES: Cue[] = [
  // ── music sections
  { t: 0.0, kind: 'section', p: { name: 'intro' } },
  { t: 4.5, kind: 'section', p: { name: 'waves' } },
  { t: 15.0, kind: 'section', p: { name: 'alarm' } },
  { t: 16.0, kind: 'section', p: { name: 'count' } },
  { t: 19.0, kind: 'section', p: { name: 'silence' } },
  { t: 19.5, kind: 'section', p: { name: 'boss' } },
  { t: 25.0, kind: 'section', p: { name: 'tired' } },
  { t: 27.0, kind: 'section', p: { name: 'climax' } },
  { t: 28.0, kind: 'section', p: { name: 'title' } },

  // ── cold open: green pixel → :) → pull back
  { t: 0.25, kind: 'crtBlip' },
  { t: 0.75, kind: 'crtBlip' },
  { t: 1.25, kind: 'crtBoot' },
  { t: 1.8, kind: 'whoosh', p: { dur: 1.8, dir: 'out' } },
  { t: 2.5, kind: 'subBoom', p: { gain: 0.9 } },
  // ── hand drop (robots land on the downbeat where the drums start)
  { t: 4.0, kind: 'servo', p: { dur: 0.4 } },
  { t: 4.12, kind: 'handOpen' },
  { t: 4.5, kind: 'robotLand', p: { n: 5 } },
  // ── revolver headshots, one per beat
  { t: 6.5, kind: 'revolver', p: { target: 0 } },
  { t: 6.5, kind: 'headshot' },
  { t: 7.0, kind: 'revolver', p: { target: 1 } },
  { t: 7.0, kind: 'headshot' },
  { t: 7.5, kind: 'revolver', p: { target: 2 } },
  { t: 7.5, kind: 'headshot' },
  // ── speedloader reload
  { t: 8.05, kind: 'reloadOpen' },
  { t: 8.25, kind: 'reloadEject' },
  { t: 8.45, kind: 'reloadInsert' },
  { t: 8.66, kind: 'reloadSnap' },
  // ── bat vs a melee bot
  { t: 8.8, kind: 'batCharge', p: { dur: 0.5 } },
  { t: 9.366, kind: 'batSwing' },
  { t: 9.5, kind: 'batHit' },
  // ── drone dive
  { t: 10.0, kind: 'droneWhine', p: { dur: 1.6 } },
  { t: 11.0, kind: 'warnBeep' },
  { t: 11.25, kind: 'warnBeep' },
  { t: 11.1, kind: 'bombDrop' },
  { t: 11.5, kind: 'revolver', p: { target: 3 } },
  { t: 11.5, kind: 'droneDown' },
  { t: 11.85, kind: 'explosion', p: { size: 0.7 } },
  // ── molotov
  { t: 12.4, kind: 'molotovThrow' },
  { t: 12.75, kind: 'glassBreak' },
  { t: 12.75, kind: 'fireWhoosh' },
  // ── buff cards
  { t: 13.6, kind: 'uiCard' },
  { t: 13.75, kind: 'uiCard' },
  { t: 13.9, kind: 'uiCard' },
  { t: 14.5, kind: 'uiPick' },
  // ── face flips angry, alarm
  { t: 15.0, kind: 'alarm' },
  // ── JUMP! 3 · 2 · 1 (one second each, like the game's countdown)
  { t: 16.0, kind: 'countBeat', p: { n: 3 } },
  { t: 17.0, kind: 'countBeat', p: { n: 2 } },
  { t: 18.0, kind: 'countBeat', p: { n: 1 } },
  { t: 16.0, kind: 'warnBeep' }, { t: 16.5, kind: 'warnBeep' },
  { t: 17.0, kind: 'warnBeep' }, { t: 17.25, kind: 'warnBeep' }, { t: 17.5, kind: 'warnBeep' }, { t: 17.75, kind: 'warnBeep' },
  { t: 18.0, kind: 'warnBeep' }, { t: 18.125, kind: 'warnBeep' }, { t: 18.25, kind: 'warnBeep' }, { t: 18.375, kind: 'warnBeep' },
  { t: 18.5, kind: 'warnBeep' }, { t: 18.625, kind: 'warnBeep' }, { t: 18.75, kind: 'warnBeep' }, { t: 18.875, kind: 'warnBeep' },
  // ── silent beat, then the smash
  { t: 19.5, kind: 'smash' },
  { t: 19.62, kind: 'debris' },
  // ── boss bullet hell
  { t: 21.0, kind: 'rocketSalvo' },
  { t: 21.35, kind: 'explosion', p: { size: 0.8 } },
  { t: 21.5, kind: 'explosion', p: { size: 0.7 } },
  { t: 21.65, kind: 'explosion', p: { size: 0.9 } },
  { t: 22.0, kind: 'beamCharge', p: { dur: 0.5 } },
  { t: 22.5, kind: 'beamFire', p: { dur: 0.75 } },
  { t: 23.25, kind: 'minigun', p: { dur: 0.75 } },
  { t: 24.4, kind: 'slam' },
  { t: 24.55, kind: 'revolver', p: { target: 9 } },
  { t: 24.75, kind: 'hurt' },
  // ── tired window + the bat
  { t: 25.0, kind: 'servo', p: { dur: 1.0, low: 1 } },
  { t: 26.05, kind: 'batCharge', p: { dur: 0.8 } },
  { t: 26.866, kind: 'batSwing' },
  { t: 27.0, kind: 'batCrack' },
  { t: 27.35, kind: 'crtOff' },
  { t: 28.0, kind: 'titleHit' },
]

export function cuesOf(kind: CueKind, from = -Infinity, to = Infinity): Cue[] {
  return CUES.filter((c) => c.kind === kind && c.t >= from && c.t < to)
}

export function cueAt(kind: CueKind, from = -Infinity, to = Infinity): number {
  const c = cuesOf(kind, from, to)[0]
  if (!c) throw new Error(`no cue ${kind} in [${from}, ${to})`)
  return c.t
}
