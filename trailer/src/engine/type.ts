// 2D motion-graphics + typography toolkit for the overlay canvas. Everything is
// a pure function of (time, params) so frames stay deterministic.
//
// Type system (all OFL Geist family, matching the game's HUD fonts):
//   DISPLAY  Geist Mono 900 — big glitched terminal statements
//   PIXEL    Geist Pixel    — CRT / emoticon voice of the machine
//   HUD      Geist Mono 500 — quiet readouts beside the action
//   TITLE    Geist 900      — the logotype

export const PAL = {
  sky: '#0b0e1a',
  void: '#04050c',
  city: '#ffb867',
  concrete: '#6f737b',
  hazard: '#f2b81c',
  phosphor: '#41ff8c',
  alarm: '#ff3b2f',
  alarmDeep: '#ef4444',
  drone: '#b26bff',
  fire: '#ff8a24',
  crate: '#c08850',
  hurt: '#54c8ff',
  tired: '#ffb84f',
  white: '#f2f6ff',
  ink: '#05070d',
} as const

export const FONT = {
  display: '"Geist Mono"',
  pixel: '"Geist Pixel"',
  hud: '"Geist Mono"',
  title: '"Geist"',
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

const scratch = document.createElement('canvas')
const sctx = scratch.getContext('2d')!

export interface GlitchOpts {
  size: number
  color?: string
  font?: string
  weight?: number
  align?: 'left' | 'center' | 'right'
  t?: number
  /** 0..1 slice displacement + RGB split strength */
  glitch?: number
  tracking?: number // em
  glow?: number // px blur
  glowColor?: string
  seed?: number
  /** per-frame jitter rate (Hz) */
  rate?: number
  alpha?: number
  /** typed-on progress (0..1) — chars appear left to right with a cursor */
  reveal?: number
  baseline?: CanvasTextBaseline
}

function setFont(ctx: CanvasRenderingContext2D, o: GlitchOpts): void {
  ctx.font = `${o.weight ?? 900} ${o.size}px ${o.font ?? FONT.display}`
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${(o.tracking ?? 0) * o.size}px`
  ctx.textBaseline = o.baseline ?? 'alphabetic'
}

export function measure(ctx: CanvasRenderingContext2D, text: string, o: GlitchOpts): number {
  ctx.save()
  setFont(ctx, o)
  const w = ctx.measureText(text).width
  ctx.restore()
  return w
}

/** Big terminal type: slice-shifted, RGB-split, glowing. */
export function glitchText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: GlitchOpts): void {
  const t = o.t ?? 0
  const g = o.glitch ?? 0
  const rate = o.rate ?? 24
  const tick = Math.floor(t * rate)
  const seed = (o.seed ?? 1) * 97.13
  let shown = text
  let cursor = false
  if (o.reveal !== undefined && o.reveal < 1) {
    const n = Math.floor(text.length * Math.max(0, o.reveal))
    shown = text.slice(0, n)
    cursor = true
  }
  // layout in a scratch canvas
  setFont(sctx, o)
  const w = Math.ceil(sctx.measureText(text).width + o.size * 0.6)
  const h = Math.ceil(o.size * 1.5)
  const pad = Math.ceil((o.glow ?? 0) * 2 + o.size * 0.3)
  scratch.width = w + pad * 2
  scratch.height = h + pad * 2
  setFont(sctx, o)
  sctx.textBaseline = 'alphabetic'
  sctx.fillStyle = o.color ?? PAL.white
  const by = pad + o.size * 1.05
  sctx.fillText(shown, pad, by)
  if (cursor && Math.floor(t * 6) % 2 === 0) {
    const cw = sctx.measureText(shown).width
    sctx.fillRect(pad + cw + o.size * 0.08, by - o.size * 0.78, o.size * 0.5, o.size * 0.82)
  }
  const align = o.align ?? 'left'
  const fullW = sctx.measureText(text).width
  const ox = align === 'center' ? x - fullW / 2 : align === 'right' ? x - fullW : x
  const dx0 = ox - pad
  const dy0 = y - by
  ctx.save()
  ctx.globalAlpha = o.alpha ?? 1
  // glow underlay
  if (o.glow) {
    ctx.shadowColor = o.glowColor ?? o.color ?? PAL.white
    ctx.shadowBlur = o.glow
    ctx.drawImage(scratch, dx0, dy0)
    ctx.shadowBlur = 0
  }
  if (g <= 0.001) {
    ctx.drawImage(scratch, dx0, dy0)
    ctx.restore()
    return
  }
  // RGB split ghosts
  const split = g * o.size * 0.06 * (0.5 + hash(tick + seed))
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = (o.alpha ?? 1) * 0.55
  tintDraw(ctx, scratch, dx0 - split, dy0, '#ff2a2a')
  tintDraw(ctx, scratch, dx0 + split, dy0, '#20d0ff')
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = o.alpha ?? 1
  // horizontal slices with jitter
  const slices = 9
  const sh = scratch.height / slices
  for (let i = 0; i < slices; i++) {
    const r = hash(tick * 13.7 + i * 3.1 + seed)
    const off = r < g * 0.6 ? (hash(tick * 7.1 + i + seed) - 0.5) * o.size * 0.5 * g : 0
    ctx.drawImage(scratch, 0, i * sh, scratch.width, sh, dx0 + off, dy0 + i * sh, scratch.width, sh)
  }
  // block noise
  const blocks = Math.floor(g * 6)
  for (let i = 0; i < blocks; i++) {
    const bx = dx0 + hash(tick + i * 5.3 + seed) * scratch.width
    const byy = dy0 + hash(tick * 1.3 + i * 2.7 + seed) * scratch.height
    ctx.fillStyle = hash(i + tick) > 0.5 ? (o.color ?? PAL.white) : PAL.ink
    ctx.globalAlpha = 0.7 * (o.alpha ?? 1)
    ctx.fillRect(bx, byy, o.size * (0.2 + hash(i * 9 + tick) * 1.2), o.size * 0.06)
  }
  ctx.restore()
}

const tintC = document.createElement('canvas')
const tintX = tintC.getContext('2d')!
function tintDraw(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, color: string): void {
  tintC.width = src.width
  tintC.height = src.height
  tintX.globalCompositeOperation = 'source-over'
  tintX.drawImage(src, 0, 0)
  tintX.globalCompositeOperation = 'source-in'
  tintX.fillStyle = color
  tintX.fillRect(0, 0, src.width, src.height)
  ctx.drawImage(tintC, x, y)
}

/** Quiet HUD readout line: [ LABEL ] value, typed on, with a corner tick. */
export function hudLine(
  ctx: CanvasRenderingContext2D, x: number, y: number, label: string, value: string,
  o: { t: number; reveal?: number; color?: string; size?: number; align?: 'left' | 'right'; alpha?: number },
): void {
  const size = o.size ?? 22
  const color = o.color ?? PAL.phosphor
  const full = `${label}  ${value}`
  const n = Math.floor(full.length * Math.min(1, Math.max(0, o.reveal ?? 1)))
  const txt = full.slice(0, n)
  ctx.save()
  ctx.globalAlpha = o.alpha ?? 1
  ctx.font = `500 ${size}px ${FONT.hud}`
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${size * 0.18}px`
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(full).width
  const x0 = o.align === 'right' ? x - w : x
  ctx.shadowColor = color
  ctx.shadowBlur = 10
  ctx.fillStyle = color
  // tick mark
  ctx.fillRect(x0 - size * 0.9, y - 1, size * 0.5, 2)
  const lw = ctx.measureText(label).width
  ctx.globalAlpha = (o.alpha ?? 1) * 0.6
  ctx.fillText(txt.slice(0, label.length), x0, y)
  ctx.globalAlpha = o.alpha ?? 1
  if (txt.length > label.length) ctx.fillText(txt.slice(label.length), x0 + lw, y)
  if ((o.reveal ?? 1) < 1 && Math.floor(o.t * 8) % 2 === 0) {
    ctx.fillRect(x0 + ctx.measureText(txt).width + 4, y - size * 0.45, size * 0.55, size * 0.9)
  }
  ctx.restore()
}

/** Marching 45° hazard stripes (the game's JUMP! banner + floor telegraph language). */
export function stripes(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number,
  color: string = PAL.alarmDeep, period = 28, speed = 60, alpha = 0.9,
): void {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  const off = (t * speed) % period
  for (let sx = x - h - period + off; sx < x + w + h; sx += period) {
    ctx.beginPath()
    ctx.moveTo(sx, y + h)
    ctx.lineTo(sx + period / 2, y + h)
    ctx.lineTo(sx + period / 2 + h, y)
    ctx.lineTo(sx + h, y)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

export type FaceId = 'happy' | 'angry' | 'hurt' | 'tired' | 'surprised'

/** The AGI's pixel emoticons, same 32×20 grid + pixel coordinates as Agi.face.ts. */
export function pixelFace(
  ctx: CanvasRenderingContext2D, face: FaceId, cx: number, cy: number, px: number, color: string,
  t = 0, glow = 0,
): void {
  const ox = cx - 16 * px
  const oy = cy - 10 * px
  ctx.save()
  ctx.fillStyle = color
  if (glow) {
    ctx.shadowColor = color
    ctx.shadowBlur = glow
  }
  const P = (x: number, y: number, w = 1, h = 1) => ctx.fillRect(ox + x * px, oy + y * px, w * px, h * px)
  switch (face) {
    case 'happy':
      P(7, 4, 4, 4); P(21, 4, 4, 4)
      P(7, 12); P(24, 12); P(8, 13, 2, 1); P(22, 13, 2, 1); P(10, 14, 12, 1)
      break
    case 'angry':
      P(6, 2); P(7, 3); P(8, 4); P(25, 2); P(24, 3); P(23, 4)
      P(7, 6, 4, 3); P(21, 6, 4, 3)
      P(7, 15); P(24, 15); P(8, 14, 2, 1); P(22, 14, 2, 1); P(10, 13, 12, 1)
      break
    case 'hurt':
      P(7, 6); P(8, 5, 3, 1); P(11, 6); P(20, 6); P(21, 5, 3, 1); P(24, 6)
      P(8, 7); P(8, 9 + (Math.floor(t * 7) % 7))
      P(9, 15); P(22, 15); P(10, 14, 2, 1); P(20, 14, 2, 1); P(12, 13, 8, 1)
      break
    case 'tired':
      P(7, 4, 4, 1); P(21, 4, 4, 1); P(7, 6, 4, 2); P(21, 6, 4, 2); P(11, 14, 10, 1)
      break
    case 'surprised':
      P(7, 2, 4, 1); P(7, 7, 4, 1); P(6, 3, 1, 4); P(11, 3, 1, 4); P(8, 4, 2, 2)
      P(21, 2, 4, 1); P(21, 7, 4, 1); P(20, 3, 1, 4); P(25, 3, 1, 4); P(22, 4, 2, 2)
      P(13, 10, 6, 1); P(13, 17, 6, 1); P(12, 11, 1, 6); P(19, 11, 1, 6)
      break
  }
  ctx.restore()
}

export const FACE_COLOR: Record<FaceId, string> = {
  happy: '#41ff8c', angry: '#ff4433', hurt: '#54c8ff', tired: '#ffb84f', surprised: '#f2f6ff',
}

/** The game's giant JUMP! warning: » JUMP! n « between marching red stripes. */
export function jumpWarning(ctx: CanvasRenderingContext2D, label: string, cx: number, cy: number, t: number, scale = 1, glitch = 0): void {
  const pulse = 0.82 + 0.18 * Math.sin(t * 2 * Math.PI * 2)
  const sw = 760 * scale
  ctx.save()
  const plate = ctx.createLinearGradient(cx - sw * 0.75, 0, cx + sw * 0.75, 0)
  plate.addColorStop(0, 'rgba(4,6,12,0)')
  plate.addColorStop(0.15, 'rgba(4,6,12,0.78)')
  plate.addColorStop(0.85, 'rgba(4,6,12,0.78)')
  plate.addColorStop(1, 'rgba(4,6,12,0)')
  ctx.fillStyle = plate
  ctx.fillRect(cx - sw * 0.75, cy - 175 * scale, sw * 1.5, 285 * scale)
  ctx.restore()
  stripes(ctx, cx - sw / 2, cy - 150 * scale, sw, 14 * scale, t, PAL.alarmDeep, 28 * scale, 80 * scale)
  stripes(ctx, cx - sw / 2, cy + 70 * scale, sw, 14 * scale, -t, PAL.alarmDeep, 28 * scale, 80 * scale)
  glitchText(ctx, label, cx, cy + 40 * scale, {
    size: 170 * scale, color: PAL.alarmDeep, align: 'center', glow: 40 * scale, t, glitch,
    tracking: 0.12, alpha: pulse, seed: 4,
  })
  glitchText(ctx, '»', cx - sw / 2 - 30 * scale, cy + 30 * scale, { size: 120 * scale, color: PAL.alarmDeep, align: 'right', alpha: pulse * 0.9, glow: 20 })
  glitchText(ctx, '«', cx + sw / 2 + 30 * scale, cy + 30 * scale, { size: 120 * scale, color: PAL.alarmDeep, align: 'left', alpha: pulse * 0.9, glow: 20 })
}

/** Red alarm vignette (radial), matches the game's WarningOverlay gradient. */
export function alarmVignette(ctx: CanvasRenderingContext2D, w: number, h: number, a: number): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.85, w / 2, h / 2, h * 1.4)
  g.addColorStop(0, 'rgba(239,68,68,0)')
  g.addColorStop(1, `rgba(239,68,68,${0.2 * a})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

/** Game crosshair (simple 4-tick reticle with center dot). */
export function crosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread = 0, color = 'rgba(255,255,255,0.9)', hit = 0): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 2.5
  const g = 9 + spread * 14
  const l = 11
  ctx.beginPath()
  ctx.moveTo(cx - g - l, cy); ctx.lineTo(cx - g, cy)
  ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + l, cy)
  ctx.moveTo(cx, cy - g - l); ctx.lineTo(cx, cy - g)
  ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + l)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3)
  if (hit > 0) {
    ctx.strokeStyle = `rgba(255,60,50,${hit})`
    ctx.lineWidth = 4
    const a = 16, b = 30
    ctx.beginPath()
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(cx + sx * a, cy + sy * a)
      ctx.lineTo(cx + sx * b, cy + sy * b)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** Corner brackets framing a target (HUD lock-on language). */
export function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, len = 22, lw = 3, alpha = 1): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.shadowColor = color
  ctx.shadowBlur = 8
  ctx.beginPath()
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y)
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len)
  ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h)
  ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - len)
  ctx.stroke()
  ctx.restore()
}

/** Boss bar in the game's segmented style. */
export function bossBar(ctx: CanvasRenderingContext2D, cx: number, y: number, w: number, frac: number, t: number, alpha = 1): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `700 18px ${FONT.hud}`
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '6px'
  ctx.fillStyle = '#ff6b5e'
  ctx.textAlign = 'center'
  ctx.fillText('THE AGI', cx, y - 14)
  ctx.fillStyle = 'rgba(8,10,18,0.75)'
  ctx.fillRect(cx - w / 2, y, w, 16)
  const fl = 0.9 + 0.1 * Math.sin(t * 20)
  ctx.fillStyle = `rgba(239,68,68,${fl})`
  ctx.shadowColor = '#ef4444'
  ctx.shadowBlur = 14
  ctx.fillRect(cx - w / 2 + 3, y + 3, (w - 6) * frac, 10)
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(8,10,18,0.75)'
  for (let i = 1; i < 12; i++) ctx.fillRect(cx - w / 2 + (w / 12) * i - 1, y + 3, 2, 10)
  ctx.restore()
}

/** Revolver ammo pips (6 chamber dots) + reserve count, bottom right. */
export function ammoReadout(ctx: CanvasRenderingContext2D, x: number, y: number, rounds: number, reserve: number): void {
  ctx.save()
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(x + Math.cos(a) * 22, y + Math.sin(a) * 22, 7, 0, Math.PI * 2)
    ctx.fillStyle = i < rounds ? '#f5d58a' : 'rgba(255,255,255,0.12)'
    ctx.fill()
  }
  ctx.font = `700 34px ${FONT.hud}`
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${rounds}`, x + 46, y - 4)
  ctx.font = `500 18px ${FONT.hud}`
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillText(`/ ${reserve}`, x + 72, y + 2)
  ctx.restore()
}

export const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x))
export const easeInExpo = (x: number) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10))
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
export const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3)
export const easeOutBack = (x: number) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2)
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
export const seg = (x: number, a: number, b: number) => clamp01((x - a) / (b - a))

export interface CaptionOpts {
  x?: number
  y?: number // baseline of the first line
  size?: number
  align?: 'left' | 'center' | 'right'
  scrim?: boolean
}

/**
 * The trailer's story captions: big plain-language lines, typed on fast with a
 * brief entrance glitch, sitting on a soft dark scrim so they read over any shot.
 * lines: [text, color]
 */
export function caption(
  o: CanvasRenderingContext2D, t: number, from: number, to: number,
  lines: Array<[string, string]>, opts: CaptionOpts = {},
): void {
  if (t < from || t >= to) return
  const size = opts.size ?? 100
  const align = opts.align ?? 'left'
  const x = opts.x ?? (align === 'center' ? 960 : align === 'right' ? 1920 - 110 : 110)
  const y0 = opts.y ?? 1080 * 0.27
  const lh = size * 1.1
  const fade = Math.min(seg(t, from, from + 0.08), 1 - seg(t, to - 0.06, to))
  if (opts.scrim !== false) {
    let wMax = 0
    for (const [s] of lines) wMax = Math.max(wMax, measure(o, s, { size, tracking: 0.01 }))
    const pad = size * 0.55
    const top = y0 - size - pad * 0.6
    const h = lh * lines.length + pad * 1.1
    const x0 = align === 'center' ? x - wMax / 2 - pad : align === 'right' ? x - wMax - pad : x - pad
    const g = o.createLinearGradient(x0, 0, x0 + wMax + pad * 2, 0)
    const a = 0.5 * fade
    if (align === 'left') { g.addColorStop(0, `rgba(4,6,12,${a})`); g.addColorStop(0.7, `rgba(4,6,12,${a * 0.75})`); g.addColorStop(1, 'rgba(4,6,12,0)') }
    else if (align === 'right') { g.addColorStop(0, 'rgba(4,6,12,0)'); g.addColorStop(0.3, `rgba(4,6,12,${a * 0.75})`); g.addColorStop(1, `rgba(4,6,12,${a})`) }
    else { g.addColorStop(0, 'rgba(4,6,12,0)'); g.addColorStop(0.2, `rgba(4,6,12,${a})`); g.addColorStop(0.8, `rgba(4,6,12,${a})`); g.addColorStop(1, 'rgba(4,6,12,0)') }
    o.save()
    o.fillStyle = g
    o.fillRect(x0, top, wMax + pad * 2, h)
    o.restore()
  }
  lines.forEach(([s, color], i) => {
    const st = from + i * 0.08
    const reveal = seg(t, st, st + Math.min(0.28, 0.02 * s.length + 0.06))
    if (reveal <= 0) return
    const g = Math.max(0, 1 - (t - st) / 0.16) * 0.55
    glitchText(o, s, x, y0 + i * lh, {
      size, color, align, t, glitch: g, glow: size * 0.16, glowColor: color, seed: 7 + i * 13 + Math.round(from * 10),
      alpha: fade, tracking: 0.01, reveal: reveal < 1 ? reveal : undefined,
    })
  })
}

/** Small weapon/threat label: a tag chip, top-left, game HUD language. */
export function label(o: CanvasRenderingContext2D, t: number, from: number, to: number, text: string, color: string, x = 110, y = 120): void {
  if (t < from || t >= to) return
  const fade = Math.min(seg(t, from, from + 0.06), 1 - seg(t, to - 0.05, to))
  const r = seg(t, from, from + 0.15)
  const shown = text.slice(0, Math.ceil(text.length * r))
  o.save()
  o.globalAlpha = fade
  o.font = `700 34px ${FONT.hud}`
  ;(o as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '7px'
  const w = o.measureText(text).width
  o.fillStyle = 'rgba(4,6,12,0.55)'
  o.fillRect(x - 18, y - 30, w + 36, 58)
  o.strokeStyle = color
  o.lineWidth = 2
  o.strokeRect(x - 18, y - 30, w + 36, 58)
  o.fillStyle = color
  o.shadowColor = color
  o.shadowBlur = 12
  o.textBaseline = 'middle'
  o.fillText(shown, x, y + 1)
  o.restore()
}
