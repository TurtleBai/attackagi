'use client'
import { isCoarsePointer, type ResolvedTier } from '@/game/quality'
import { useSettings } from '@/game/settings'

// React-reactive twin of quality.ts resolvedTier(): same resolution rules
// (explicit pick > adaptive resolution > smooth / potato-on-coarse fallback),
// but as a hook so components re-render when the tier moves. Deliberately free
// of @react-three/fiber imports — GameShell uses it outside the Canvas.
export function useResolvedTier(): ResolvedTier {
  return useSettings((s) =>
    s.quality === 'auto'
      ? (s.resolvedQuality ?? (isCoarsePointer() ? 'potato' : 'smooth'))
      : s.quality,
  )
}
