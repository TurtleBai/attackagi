'use client'
import * as THREE from 'three'
import { heightToNormal, makeFbm, seededRandom } from '@/game/gfx/textures'

// Arena-owned procedural canvas maps. Same visual family as gfx/textures
// (worn dark metal, painted panels, dusty concrete) — seeded + cached.

const cache = new Map<string, THREE.Texture>()

function canvasTex(
  key: string, w: number, h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  opts?: { srgb?: boolean },
): THREE.CanvasTexture {
  const hit = cache.get(key)
  if (hit) return hit as THREE.CanvasTexture
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  draw(ctx, w, h)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  if (opts?.srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  cache.set(key, tex)
  return tex
}

// ─── Concrete (jersey barriers, pillars) ─────────────────────────────────────

export interface ConcreteMaps {
  map: THREE.Texture
  normalMap: THREE.Texture
  roughnessMap: THREE.Texture
}

let concreteCache: ConcreteMaps | null = null

/** Dusty pale concrete: fbm mottle, drip stains, chipped speckles, aggregate. */
export function concreteMaps(): ConcreteMaps {
  if (concreteCache) return concreteCache
  const size = 256
  const fbm = makeFbm(9107)
  const rnd = seededRandom(555)
  // drip stain columns
  const drips: Array<{ x: number; w: number; d: number }> = []
  for (let i = 0; i < 9; i++) drips.push({ x: rnd() * size, w: 3 + rnd() * 9, d: 0.12 + rnd() * 0.2 })
  const paint = (ctx: CanvasRenderingContext2D, kind: 'albedo' | 'height' | 'rough') => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm(x / 52, y / 52, 5)
        const grit = fbm(x / 5 + 71, y / 5 + 71, 2)
        const pore = grit > 0.62 ? (grit - 0.62) * 2.2 : 0
        const chip = fbm(x / 14 + 200, y / 14 + 200, 3) > 0.72 ? 1 : 0
        let stain = 0
        for (const d of drips) {
          const dx = Math.min(Math.abs(x - d.x), size - Math.abs(x - d.x))
          if (dx < d.w) stain += d.d * (1 - dx / d.w) * (0.4 + 0.6 * fbm(x / 20, y / 90 + 7, 3))
        }
        if (kind === 'albedo') {
          const base = 118 + n * 42 + grit * 10 - chip * 26
          const dark = Math.max(0.55, 1 - stain)
          ctx.fillStyle = `rgb(${(base + 4) * dark | 0},${base * dark | 0},${(base - 6) * dark | 0})`
        } else if (kind === 'height') {
          const h = Math.max(0, Math.min(255, 128 + n * 34 - pore * 60 - chip * 70 + grit * 12))
          ctx.fillStyle = `rgb(${h | 0},${h | 0},${h | 0})`
        } else {
          const r = Math.max(120, Math.min(255, 208 + n * 30 - chip * 20 + stain * 60))
          ctx.fillStyle = `rgb(${r | 0},${r | 0},${r | 0})`
        }
        ctx.fillRect(x, y, 1, 1)
      }
    }
  }
  const heightCanvas = document.createElement('canvas')
  heightCanvas.width = heightCanvas.height = size
  paint(heightCanvas.getContext('2d')!, 'height')
  concreteCache = {
    map: canvasTex('arena:concrete:albedo', size, size, (ctx) => paint(ctx, 'albedo'), { srgb: true }),
    normalMap: heightToNormal('arena:concrete:normal', heightCanvas, 2.2),
    roughnessMap: canvasTex('arena:concrete:rough', size, size, (ctx) => paint(ctx, 'rough')),
  }
  return concreteCache
}

// ─── Hazard stripes (parapet band, pillar band) ──────────────────────────────

/** Worn diagonal yellow/black warning stripes, 8 periods per tile. */
export function hazardStripeTexture(): THREE.CanvasTexture {
  return canvasTex('arena:stripes', 256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#16171c'
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    const period = w / 8
    ctx.fillStyle = '#caa22e'
    for (let i = -2; i < 12; i++) {
      ctx.beginPath()
      ctx.moveTo(i * period, 0)
      ctx.lineTo(i * period + period * 0.55, 0)
      ctx.lineTo(i * period + period * 0.55 - h, h)
      ctx.lineTo(i * period - h, h)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
    // wear: scratch speckles knock paint back to dark metal
    const rnd = seededRandom(818)
    ctx.fillStyle = 'rgba(22,23,28,0.9)'
    for (let i = 0; i < 900; i++) {
      const x = rnd() * w, y = rnd() * h
      const s = rnd() * 3 + 0.5
      ctx.globalAlpha = 0.2 + rnd() * 0.5
      ctx.fillRect(x, y, s, s * (0.4 + rnd()))
    }
    ctx.globalAlpha = 1
    // grime gradient at bottom
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(8,8,10,0.45)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }, { srgb: true })
}

// ─── Floor overlay: landing-pad markings, painted rings, grime ───────────────
// Mapped once across the whole disc (planar uv, disc edge ≈ r 0.5 from center).

export function floorOverlayTexture(): THREE.CanvasTexture {
  return canvasTex('arena:overlay', 1024, 1024, (ctx, w) => {
    const c = w / 2
    // disc visual radius exceeds ARENA_RADIUS slightly; playable rim ≈ 0.489 in uv
    const R = w * 0.489
    ctx.clearRect(0, 0, w, w)
    ctx.lineCap = 'butt'

    // rim hazard band: dashed yellow arcs just inside the parapet
    ctx.strokeStyle = 'rgba(188,148,40,0.5)'
    ctx.lineWidth = w * 0.016
    const dashN = 48
    for (let i = 0; i < dashN; i++) {
      const a0 = (i / dashN) * Math.PI * 2
      ctx.beginPath()
      ctx.arc(c, c, R * 0.955, a0, a0 + (Math.PI * 2 / dashN) * 0.55)
      ctx.stroke()
    }
    // worn painted rings
    ctx.strokeStyle = 'rgba(198,204,218,0.30)'
    ctx.lineWidth = w * 0.005
    ctx.beginPath(); ctx.arc(c, c, R * 0.62, 0, Math.PI * 2); ctx.stroke()
    ctx.strokeStyle = 'rgba(198,204,218,0.22)'
    ctx.beginPath(); ctx.arc(c, c, R * 0.335, 0, Math.PI * 2); ctx.stroke()
    // radial tick lanes at mid radius
    ctx.strokeStyle = 'rgba(198,158,44,0.4)'
    ctx.lineWidth = w * 0.009
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(a) * R * 0.70, c + Math.sin(a) * R * 0.70)
      ctx.lineTo(c + Math.cos(a) * R * 0.78, c + Math.sin(a) * R * 0.78)
      ctx.stroke()
    }
    // central landing pad: circle + corner brackets + big worn numeral
    ctx.strokeStyle = 'rgba(202,208,222,0.34)'
    ctx.lineWidth = w * 0.007
    ctx.beginPath(); ctx.arc(c, c, R * 0.185, 0, Math.PI * 2); ctx.stroke()
    ctx.lineWidth = w * 0.011
    const b = R * 0.24
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      ctx.beginPath()
      ctx.moveTo(c + sx * b, c + sy * b - sy * R * 0.07)
      ctx.lineTo(c + sx * b, c + sy * b)
      ctx.lineTo(c + sx * b - sx * R * 0.07, c + sy * b)
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(202,208,222,0.26)'
    ctx.font = `bold ${w * 0.075}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('07', c, c + 1)
    ctx.font = `bold ${w * 0.02}px monospace`
    ctx.fillStyle = 'rgba(198,158,44,0.5)'
    ctx.fillText('K E E P   C L E A R', c, c + R * 0.26)

    // pre-battle grime blotches + old scorch smudges
    const rnd = seededRandom(31007)
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2
      const rr = Math.sqrt(rnd()) * R * 0.92
      const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr
      const rad = w * (0.015 + rnd() * 0.05)
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
      const dark = rnd() > 0.5
      g.addColorStop(0, dark ? 'rgba(12,12,14,0.34)' : 'rgba(30,26,20,0.22)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
    }

    // erosion: eat speckles out of everything painted so far
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * w, y = rnd() * w
      ctx.globalAlpha = 0.25 + rnd() * 0.55
      const s = 1 + rnd() * 4
      ctx.fillStyle = '#000'
      ctx.fillRect(x, y, s, s * (0.3 + rnd()))
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }, { srgb: true })
}

// ─── Floor scorch data map (r = char, g = crack veins) ───────────────────────

export function floorScorchTexture(): THREE.CanvasTexture {
  return canvasTex('arena:scorch', 512, 512, (ctx, w) => {
    const c = w / 2
    const fbm = makeFbm(6606)
    // red channel: charred blotch, strongest at center, lobed by fbm
    const img = ctx.createImageData(w, w)
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - c) / c, dy = (y - c) / c
        const r = Math.sqrt(dx * dx + dy * dy)
        const lobe = fbm(x / 70, y / 70, 4)
        const fall = Math.max(0, 1 - r / (0.6 + lobe * 0.45))
        const mottle = 0.45 + 0.55 * fbm(x / 26 + 40, y / 26 + 40, 4)
        img.data[(y * w + x) * 4] = Math.min(255, fall * mottle * 340) | 0
        img.data[(y * w + x) * 4 + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    // green channel: jagged radial crack veins with branches, additive
    ctx.globalCompositeOperation = 'lighter'
    const rnd = seededRandom(7717)
    const vein = (x0: number, y0: number, a: number, len: number, width: number, depth: number) => {
      let x = x0, y = y0, ang = a
      let seg = 0
      ctx.strokeStyle = 'rgb(0,255,0)'
      ctx.shadowColor = 'rgb(0,90,0)'
      ctx.shadowBlur = 7
      while (seg < len && width > 0.5) {
        const step = 8 + rnd() * 14
        const nx = x + Math.cos(ang) * step
        const ny = y + Math.sin(ang) * step
        ctx.lineWidth = width
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke()
        if (depth > 0 && rnd() > 0.68) {
          vein(nx, ny, ang + (rnd() - 0.5) * 1.8, len * 0.45, width * 0.55, depth - 1)
        }
        x = nx; y = ny
        ang += (rnd() - 0.5) * 0.7
        width *= 0.94
        seg += step
      }
    }
    for (let i = 0; i < 15; i++) {
      const a = (i / 15) * Math.PI * 2 + rnd() * 0.5
      vein(c + Math.cos(a) * 12, c + Math.sin(a) * 12, a, w * (0.2 + rnd() * 0.26), 4.5 + rnd() * 3, 2)
    }
    ctx.shadowBlur = 0
    ctx.globalCompositeOperation = 'source-over'
  })
}

// ─── Floor detail height (blended as close-range normal detail) ──────────────

export function floorDetailNormal(): THREE.Texture {
  const key = 'arena:detailNormal'
  const hit = cache.get(key)
  if (hit) return hit
  const size = 256
  const fbm = makeFbm(2024, 16)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / 7, y / 7, 3)
      const spec = fbm(x / 2.4 + 30, y / 2.4 + 30, 2)
      const h = Math.max(0, Math.min(255, 96 + n * 100 + (spec > 0.6 ? (spec - 0.6) * 190 : 0)))
      ctx.fillStyle = `rgb(${h | 0},${h | 0},${h | 0})`
      ctx.fillRect(x, y, 1, 1)
    }
  }
  const tex = heightToNormal(key + ':n', canvas, 1.35)
  cache.set(key, tex)
  return tex
}

// ─── Skyline towers (sparse emissive windows over near-black hull) ───────────

function paintSkyline(ctx: CanvasRenderingContext2D, x0: number, w: number, h: number, seed: number): void {
  ctx.save()
  ctx.translate(x0, 0)
  ctx.fillStyle = '#07090f'
  ctx.fillRect(0, 0, w, h)
  const rnd = seededRandom(seed)
  const fbm = makeFbm(seed + 3)
  // subtle vertical panel variation
  for (let x = 0; x < w; x += 16) {
    ctx.fillStyle = `rgba(${14 + rnd() * 10 | 0},${16 + rnd() * 10 | 0},${24 + rnd() * 12 | 0},0.5)`
    ctx.fillRect(x, 0, 16, h)
  }
  const cols = 10, rows = 30
  const cw = w / cols, rh = h / rows
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const lit = rnd()
      if (lit > 0.92) {
        const warm = rnd() > 0.4
        const bright = 0.5 + rnd() * 0.5
        ctx.fillStyle = warm
          ? `rgba(255,196,130,${bright})`
          : `rgba(150,190,255,${bright * 0.85})`
        ctx.fillRect(cx * cw + cw * 0.22, ry * rh + rh * 0.28, cw * 0.56, rh * 0.44)
      } else if (lit > 0.86) {
        ctx.fillStyle = `rgba(70,84,110,${0.3 + rnd() * 0.3})`
        ctx.fillRect(cx * cw + cw * 0.22, ry * rh + rh * 0.28, cw * 0.56, rh * 0.44)
      }
    }
  }
  // haze gradient toward base
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgba(11,14,26,0)')
  g.addColorStop(1, 'rgba(11,14,26,0.85)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  // roofline greeble noise
  for (let x = 0; x < w; x++) {
    const n = fbm(x / 30, 0.5, 3)
    ctx.fillStyle = '#05060b'
    ctx.fillRect(x, 0, 1, 2 + n * 6)
  }
  ctx.restore()
}

/**
 * Both skyline variants side-by-side in ONE atlas (left half seedA, right half
 * seedB) so every tower shares a single instanced draw; towers pick a half via
 * a per-instance `aTexSel` uv offset (0 → x∈[0,.5], 1 → x∈[.5,1]).
 */
export function skylineAtlasTexture(seedA: number, seedB: number): THREE.CanvasTexture {
  return canvasTex(`arena:skylineAtlas:${seedA}:${seedB}`, 512, 512, (ctx) => {
    paintSkyline(ctx, 0, 256, 512, seedA)
    paintSkyline(ctx, 256, 256, 512, seedB)
  }, { srgb: true })
}

// ─── Soft sprites ────────────────────────────────────────────────────────────

/** Soft radial puff (dust bursts, fog cards). */
export function softTexture(): THREE.CanvasTexture {
  return canvasTex('arena:soft', 128, 128, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
    g.addColorStop(0, 'rgba(255,255,255,0.9)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.4)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, w)
  })
}

/** Lumpy smoke puff with irregular alpha, for obstacle collapse dust. */
export function puffTexture(): THREE.CanvasTexture {
  return canvasTex('arena:puff', 128, 128, (ctx, w) => {
    const rnd = seededRandom(4321)
    ctx.clearRect(0, 0, w, w)
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2
      const r = rnd() * w * 0.26
      const x = w / 2 + Math.cos(a) * r
      const y = w / 2 + Math.sin(a) * r
      const rad = w * (0.1 + rnd() * 0.16)
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
      g.addColorStop(0, `rgba(255,255,255,${0.16 + rnd() * 0.2})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
    }
  })
}

/** Tiny round dot for point sprites (stars, motes). */
export function dotTexture(): THREE.CanvasTexture {
  return canvasTex('arena:dot', 64, 64, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.7)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, w)
  })
}
