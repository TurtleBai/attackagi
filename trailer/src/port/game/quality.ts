// Trailer shim for the game's graphics-tier contract: the trailer always renders
// the game's 'pretty' tier (full SDF tentacle eyes, floor detail normals + scorch,
// AO, fire/VFX lights). Offline frame-stepped rendering has no frame budget.

export interface TierKnobs {
  dpr: [number, number]
  composer: boolean
  ao: boolean
  bloomLevels: number
  msaa: number
  shadows: boolean
  vfxDensity: number
  fireLights: number
  vfxLights: number
  rimLights: number
  cloudN: number
  dustCount: number
  emberCount: number
  floorLite: boolean
  tentLite: boolean
}

const PRETTY: TierKnobs = {
  dpr: [1, 1],
  composer: true,
  ao: true,
  bloomLevels: 6,
  msaa: 4,
  shadows: true,
  vfxDensity: 1,
  fireLights: 3,
  vfxLights: 3,
  rimLights: 2,
  cloudN: 9,
  dustCount: 240,
  emberCount: 64,
  floorLite: false,
  tentLite: false,
}

export function tierKnobs(): TierKnobs {
  return PRETTY
}
