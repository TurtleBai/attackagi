'use client'
import { useSettings } from './settings'

// ─── Graphics tier contract ──────────────────────────────────────────────────
// Three resolved tiers. Modules read knobs through resolvedTier()/tierKnobs()
// — never from useSettings directly — so the 'auto' adaptive controller can
// re-point the resolution without touching consumers.
//
// STRUCTURAL knobs (pool sizes, mounted light counts, shader #defines, the
// composer branch) are read ONCE at module init or component mount: they apply
// on page load / canvas remount. CHEAP knobs (dpr, bloom intensity, vfx
// density multipliers) may be re-read per frame and are safe for the adaptive
// controller to move mid-run.

export type ResolvedTier = 'potato' | 'smooth' | 'pretty'

export interface TierKnobs {
  dpr: [number, number]
  composer: boolean // false = no EffectComposer at all (potato)
  ao: boolean
  bloomLevels: number
  msaa: number
  shadows: boolean
  /** multiplier for transient particle pool sizes + spawn counts (structural) */
  vfxDensity: number
  fireLights: number
  vfxLights: number
  rimLights: number
  cloudN: number
  dustCount: number
  emberCount: number
  floorLite: boolean // strip detail-normal + scorch layers from the floor shader
  tentLite: boolean // strip SDF eye loop / extra octaves from tentacles
}

export const TIER_KNOBS: Record<ResolvedTier, TierKnobs> = {
  potato: {
    dpr: [0.75, 1.0],
    composer: false,
    ao: false,
    bloomLevels: 0,
    msaa: 0,
    shadows: false,
    vfxDensity: 0.5,
    fireLights: 1,
    vfxLights: 1,
    rimLights: 0,
    cloudN: 0,
    dustCount: 120,
    emberCount: 64,
    floorLite: true,
    tentLite: true,
  },
  smooth: {
    dpr: [1, 1.2],
    composer: true,
    ao: false,
    bloomLevels: 5,
    msaa: 0,
    shadows: true,
    vfxDensity: 1,
    fireLights: 3,
    vfxLights: 3,
    rimLights: 2,
    cloudN: 6,
    dustCount: 240,
    emberCount: 64,
    floorLite: false,
    tentLite: false,
  },
  pretty: {
    dpr: [1, 1.5],
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
  },
}

/** Coarse pointer ≈ touch device: cap what AUTO may resolve to. */
export function isCoarsePointer(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
}

/**
 * Resolve the user's setting to a concrete tier. 'auto' resolution is owned by
 * the adaptive controller (tiers implementation) — until it writes a resolved
 * value it falls back to 'smooth' (or 'potato' on coarse-pointer devices).
 */
export function resolvedTier(): ResolvedTier {
  const s = useSettings.getState()
  const q = s.quality
  // explicit whitelist so a tampered/corrupt persisted value falls through to
  // the adaptive resolution instead of indexing TIER_KNOBS with garbage
  if (q === 'potato' || q === 'smooth' || q === 'pretty') return q
  return s.resolvedQuality ?? (isCoarsePointer() ? 'potato' : 'smooth')
}

export function tierKnobs(): TierKnobs {
  return TIER_KNOBS[resolvedTier()]
}
