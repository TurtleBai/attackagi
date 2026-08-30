'use client'
import * as THREE from 'three'

// AI-lab chassis emblems: each robot is randomly "manufactured" by one of the
// labs on the reactbench.com leaderboard. SVGs live in /public/logos; all 9 are
// rasterized into ONE shared 3x3 atlas CanvasTexture (white mark, transparent
// background). A single InstancedMesh plane (Enemies.instanced.ts) stamps every
// enemy's chest plate, selecting the mark with a per-instance UV-cell offset.

const LABS = [
  'openai', 'anthropic', 'xai', 'alibaba', 'google',
  'deepseek', 'moonshot', 'zai', 'cursor',
] as const

export const LOGO_COUNT = LABS.length
export const ATLAS_GRID = 3
const CELL = 128

let atlasTex: THREE.CanvasTexture | null = null

/** Shared 3x3 logo atlas (lazy; rasterizes async as each SVG loads). Null during SSR. */
export function logoAtlasTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  if (atlasTex) return atlasTex
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = CELL * ATLAS_GRID
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  atlasTex = tex
  LABS.forEach((lab, i) => {
    const img = new Image()
    img.onload = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const x = (i % ATLAS_GRID) * CELL
      const y = Math.floor(i / ATLAS_GRID) * CELL
      // the SVGs are 128x128 with xMidYMid letterboxing baked in — draw with a
      // small inset so beveled chest plates never clip the mark (and so mipmap
      // bleed between atlas cells stays invisible at gameplay distance)
      ctx.clearRect(x, y, CELL, CELL)
      ctx.drawImage(img, x + 10, y + 10, CELL - 20, CELL - 20)
      tex.needsUpdate = true
    }
    img.src = `/logos/${lab}.svg`
  })
  return atlasTex
}

/**
 * Atlas UV offset (lower-left corner of the cell, GL v-up) for logo index i.
 * Pair with plane UVs pre-scaled to [0, 1/ATLAS_GRID].
 */
export function logoCellOffset(i: number, out: { x: number; y: number }): void {
  const idx = ((i | 0) % LOGO_COUNT + LOGO_COUNT) % LOGO_COUNT
  const col = idx % ATLAS_GRID
  const row = Math.floor(idx / ATLAS_GRID) // canvas row, y-down
  out.x = col / ATLAS_GRID
  out.y = (ATLAS_GRID - 1 - row) / ATLAS_GRID
}
