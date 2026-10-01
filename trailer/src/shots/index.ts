import type { Shot } from '../engine/timeline'
import { SHOT } from '../cues'
import { bat, beam, minigun, rockets, slam, tired, title, unplug } from './boss'
import { batWave, buffs } from './extras'
import { open } from './open'
import { angry, jump1, jumpWide, silent, smash } from './smash'
import { drop, droneKill, drone, gun, molotov, reload } from './waves'

// Shot order = edit order. Boundaries come from cues.ts SHOT; verified contiguous.
export const SHOTS: Shot[] = [
  open, drop, gun, reload, batWave, drone, droneKill, molotov, buffs,
  angry, jumpWide, jump1, silent, smash,
  rockets, beam, minigun, slam, tired, bat, unplug, title,
]

const names = Object.keys(SHOT)
SHOTS.forEach((s, i) => {
  if (s.name !== names[i]) throw new Error(`shot order mismatch: ${s.name} vs ${names[i]}`)
  if (i > 0 && Math.abs(SHOTS[i - 1].end - s.start) > 1e-9) throw new Error(`gap before ${s.name}`)
})
