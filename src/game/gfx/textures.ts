'use client'
import * as THREE from 'three'

// Procedural texture toolkit. Every module builds its maps from these so the whole
// game shares one material identity: worn dark metal, painted panels, dusty concrete.
// All generators are deterministic (seeded) and cached by key.
//
// Painting goes through raw ImageData buffers (one pass fills albedo + height +
// roughness together, sharing the per-pixel noise samples) instead of per-pixel
// fillRect calls — ~10x faster module init with byte-identical output.

const cache = new Map<string, THREE.Texture>()
const setCache = new Map<string, TextureSet>()

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

/** Value-noise fBm sampler on a lattice, tileable across `period` cells. */
export function makeFbm(seed: number, period = 8) {
  const rnd = seededRandom(seed)
  const lattice = new Float32Array(period * period)
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd()
  const at = (x: number, y: number) =>
    lattice[((y % period + period) % period) * period + ((x % period + period) % period)]
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y)
    const xf = smooth(x - xi), yf = smooth(y - yi)
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1)
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf
  }
  return (x: number, y: number, octaves = 4) => {
    let sum = 0, amp = 0.5, freq = 1
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq, y * freq)
      amp *= 0.5
      freq *= 2
    }
    return sum
  }
}

type Fbm = ReturnType<typeof makeFbm>

/** Wrap a filled RGBA buffer in a canvas (single putImageData — no per-pixel 2D calls). */
function dataCanvas(size: number, data: Uint8ClampedArray<ArrayBuffer>): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  canvas.getContext('2d')!.putImageData(new ImageData(data, size, size), 0, 0)
  return canvas
}

function canvasToTexture(canvas: HTMLCanvasElement, opts?: { colorSpace?: boolean; repeat?: number }): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  if (opts?.colorSpace) tex.colorSpace = THREE.SRGBColorSpace
  if (opts?.repeat) tex.repeat.set(opts.repeat, opts.repeat)
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

/** Convert a grayscale height canvas into a tangent-space normal map. */
export function heightToNormal(key: string, height: HTMLCanvasElement, strength = 2.0): THREE.CanvasTexture {
  const hit = cache.get(key)
  if (hit) return hit as THREE.CanvasTexture
  const size = height.width
  const src = height.getContext('2d')!.getImageData(0, 0, size, size).data
  const h = (x: number, y: number) =>
    src[(((y % size + size) % size) * size + ((x % size + size) % size)) * 4] / 255
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const out = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1)
      const i = (y * size + x) * 4
      out.data[i] = (-dx * inv * 0.5 + 0.5) * 255
      out.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255
      out.data[i + 2] = inv * 255
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8
  cache.set(key, tex)
  return tex
}

export interface TextureSet {
  map: THREE.Texture
  normalMap: THREE.Texture
  roughnessMap: THREE.Texture
  /** the raw height canvas, reusable for displacement */
  heightCanvas: HTMLCanvasElement
}

/** One pass over the pixels fills all three maps at once (shared noise samples). */
type SetPainter = (
  albedo: Uint8ClampedArray, height: Uint8ClampedArray, rough: Uint8ClampedArray,
  size: number, fbm: Fbm,
) => void

function buildSet(key: string, size: number, seed: number, paint: SetPainter, normalStrength = 2.0): TextureSet {
  const hit = setCache.get(key)
  if (hit) return hit
  const bytes = size * size * 4
  const albedo = new Uint8ClampedArray(bytes)
  const height = new Uint8ClampedArray(bytes)
  const rough = new Uint8ClampedArray(bytes)
  paint(albedo, height, rough, size, makeFbm(seed))
  const heightCanvas = dataCanvas(size, height)
  const set: TextureSet = {
    map: canvasToTexture(dataCanvas(size, albedo), { colorSpace: true }),
    normalMap: heightToNormal(`${key}:normal`, heightCanvas, normalStrength),
    roughnessMap: canvasToTexture(dataCanvas(size, rough)),
    heightCanvas,
  }
  setCache.set(key, set)
  return set
}

/** Cracked, dusty concrete/asphalt ground with panel seams — for the arena floor. */
export function groundTextures(): TextureSet {
  return buildSet('ground', 512, 1337, (albedo, height, rough, size, fbm) => {
    const cell = size / 4
    let i = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++, i += 4) {
        const n = fbm(x / 64, y / 64, 5)
        const grit = fbm(x / 6 + 40, y / 6 + 40, 2)
        // panel seams every `cell`, darker + recessed
        const sx = Math.min(x % cell, cell - (x % cell))
        const sy = Math.min(y % cell, cell - (y % cell))
        const seam = Math.min(sx, sy) < 3 ? 1 : 0
        // meandering cracks from thresholded ridged noise
        const ridge = Math.abs(fbm(x / 90 + 9, y / 90 + 9, 4) - 0.5)
        const crack = ridge < 0.012 ? 1 : 0
        const base = 66 + n * 44 + grit * 14
        const warm = 4 + n * 6
        const dark = seam ? 0.62 : crack ? 0.5 : 1
        albedo[i] = (base + warm) * dark | 0
        albedo[i + 1] = base * dark | 0
        albedo[i + 2] = (base - 5) * dark | 0
        albedo[i + 3] = 255
        const h = Math.max(0, Math.min(255, 120 + n * 90 + grit * 25 - seam * 70 - crack * 90)) | 0
        height[i] = h; height[i + 1] = h; height[i + 2] = h; height[i + 3] = 255
        const r = (190 + n * 45 - seam * 25) | 0
        rough[i] = r; rough[i + 1] = r; rough[i + 2] = r; rough[i + 3] = 255
      }
    }
  }, 2.6)
}

/** Worn painted metal with panel lines + rivets — robot chassis, boss body, barriers. */
export function panelTextures(variant: 'chassis' | 'dark' | 'boss' = 'chassis'): TextureSet {
  const seeds = { chassis: 77, dark: 501, boss: 900 } as const
  const tint = { chassis: [116, 124, 134], dark: [58, 62, 70], boss: [90, 96, 110] }[variant]
  return buildSet(`panel:${variant}`, 256, seeds[variant], (albedo, height, rough, size, fbm) => {
    const cell = size / 4
    const rnd = seededRandom(seeds[variant] + 5)
    // per-panel brightness offsets
    const panelTone: number[] = []
    for (let k = 0; k < 16; k++) panelTone.push((rnd() - 0.5) * 26)
    let i = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++, i += 4) {
        const n = fbm(x / 40, y / 40, 4)
        const wear = fbm(x / 10 + 99, y / 10 + 99, 3)
        const px = Math.floor(x / cell), py = Math.floor(y / cell)
        const tone = panelTone[py * 4 + px]
        const sx = Math.min(x % cell, cell - (x % cell))
        const sy = Math.min(y % cell, cell - (y % cell))
        const seam = Math.min(sx, sy) < 2 ? 1 : 0
        // rivets near panel corners
        const rx = (x % cell) - 8, ry = (y % cell) - 8
        const rivet = rx * rx + ry * ry < 9 ? 1 : 0
        const scratch = wear > 0.72 ? (wear - 0.72) * 3 : 0
        const d = seam ? 0.55 : 1
        const bare = scratch * 60 // scratched to bare metal = lighter
        albedo[i] = Math.min(255, (tint[0] + tone + n * 18 + bare) * d) | 0
        albedo[i + 1] = Math.min(255, (tint[1] + tone + n * 18 + bare) * d) | 0
        albedo[i + 2] = Math.min(255, (tint[2] + tone + n * 16 + bare) * d) | 0
        albedo[i + 3] = 255
        const h = Math.max(0, Math.min(255, 128 + n * 24 - seam * 80 + rivet * 60 - scratch * 40)) | 0
        height[i] = h; height[i + 1] = h; height[i + 2] = h; height[i + 3] = 255
        const r = Math.max(40, Math.min(255, 150 + n * 40 - scratch * 90 + seam * 30)) | 0
        rough[i] = r; rough[i + 1] = r; rough[i + 2] = r; rough[i + 3] = 255
      }
    }
  }, 2.2)
}

/** Scuffed wood + steel-banded ammo crate faces. */
export function crateTextures(): TextureSet {
  return buildSet('crate', 256, 4242, (albedo, height, rough, size, fbm) => {
    let i = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++, i += 4) {
        const plank = Math.floor(y / (size / 5))
        const grain = fbm(x / 90, y / 8 + plank * 31, 4)
        const knots = fbm(x / 30 + plank * 7, y / 30, 3)
        const bandZone = x < 20 || x > size - 20
        const gap = y % (size / 5) < 3 ? 1 : 0
        if (bandZone) {
          const m = 70 + grain * 20
          albedo[i] = m | 0
          albedo[i + 1] = (m + 4) | 0
          albedo[i + 2] = (m + 8) | 0
        } else {
          const d = gap ? 0.5 : 1
          albedo[i] = (150 + grain * 46 + knots * 16) * d | 0
          albedo[i + 1] = (104 + grain * 34) * d | 0
          albedo[i + 2] = (58 + grain * 22) * d | 0
        }
        albedo[i + 3] = 255
        const h = (bandZone ? 190 : Math.max(0, 128 + grain * 40 - gap * 90)) | 0
        height[i] = h; height[i + 1] = h; height[i + 2] = h; height[i + 3] = 255
        const r = (bandZone ? 110 + grain * 30 : 200 + grain * 30) | 0
        rough[i] = r; rough[i + 1] = r; rough[i + 2] = r; rough[i + 3] = 255
      }
    }
  }, 2.4)
}
