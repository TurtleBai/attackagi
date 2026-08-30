'use client'
import * as THREE from 'three'
import { seededRandom } from '@/game/gfx/textures'
import type { BossFace } from '@/game/types'

// ─── The AGI's pixel face: tiny canvas redrawn ~8fps + CRT screen shader ─────
// Canvas is 64×40 real pixels; the face is authored on a chunky 32×20 grid
// (1 face pixel = 2×2 canvas px). The ShaderMaterial adds curvature, scanlines,
// phosphor stripes, flicker and vignette, and outputs >1.0 colors so the
// composer's bloom picks the screen up at 60m.

const W = 64
const H = 40

interface FaceStyle {
  css: string
  glow: THREE.Color
}

const FACE_STYLE: Record<BossFace, FaceStyle> = {
  happy: { css: '#41ff8c', glow: new THREE.Color(0.22, 1.0, 0.5) },
  angry: { css: '#ff4433', glow: new THREE.Color(1.0, 0.2, 0.12) },
  hurt: { css: '#54c8ff', glow: new THREE.Color(0.28, 0.72, 1.0) },
  tired: { css: '#ffb84f', glow: new THREE.Color(1.0, 0.68, 0.26) },
  surprised: { css: '#f2f6ff', glow: new THREE.Color(0.9, 0.94, 1.0) },
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uTime;
uniform float uGlow;
uniform vec3 uFaceColor;
varying vec2 vUv;

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  uv *= 1.0 + 0.055 * vec2(dot(uv.yy, uv.yy), dot(uv.xx, uv.xx));
  return uv * 0.5 + 0.5;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = curve(vUv);
  vec3 col = vec3(0.008, 0.010, 0.016);
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
    vec3 face = texture2D(uMap, uv).rgb;
    // phosphor triad stripes (64 columns * 3 subpixels)
    float px = uv.x * 192.0;
    vec3 mask = 0.78 + 0.22 * vec3(
      sin(px * 2.0943951),
      sin((px + 1.0) * 2.0943951),
      sin((px + 2.0) * 2.0943951));
    // 40 scanline rows
    float scan = 0.78 + 0.22 * sin((uv.y * 40.0 - 0.25) * 6.2831853);
    // slow rolling brightness band
    float roll = 0.97 + 0.05 * sin((uv.y * 2.0 + uTime * 0.27) * 6.2831853);
    // high-frequency flicker
    float flick = 0.962 + 0.028 * sin(uTime * 73.0) + 0.014 * hash(vec2(floor(uTime * 24.0), 3.0));
    // ambient phosphor haze so the screen never reads as dead glass
    vec3 haze = uFaceColor * (0.055 + 0.05 * uGlow);
    float vig = pow(max(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 1e-5), 0.27);
    col = (face * mask * scan + haze) * roll * flick * vig;
    col *= 1.35 + 0.6 * uGlow;
  }
  gl_FragColor = vec4(col, 1.0);
}
`

export interface FaceScreen {
  texture: THREE.CanvasTexture
  material: THREE.ShaderMaterial
  /** Redraw the pixel face. Call ~8fps (and immediately on expression change). */
  draw: (face: BossFace, t: number) => void
  /** Per-frame uniform update. glow in 0..1.5-ish. */
  update: (time: number, glow: number) => void
}

export function createFaceScreen(): FaceScreen {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uTime: { value: 0 },
      uGlow: { value: 1 },
      uFaceColor: { value: FACE_STYLE.happy.glow.clone() },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  })

  function draw(face: BossFace, t: number) {
    const style = FACE_STYLE[face]
    ctx.fillStyle = '#030604'
    ctx.fillRect(0, 0, W, H)

    // sparse static, deterministic per redraw tick
    const rnd = seededRandom((Math.floor(t * 8) % 4096) * 31 + 7)
    ctx.fillStyle = 'rgba(110,160,130,0.12)'
    for (let i = 0; i < 12; i++) ctx.fillRect((rnd() * W) | 0, (rnd() * H) | 0, 1, 1)

    // idle wiggle: whole face shifts by one chunky pixel now and then
    const s = Math.sin(t * 0.9)
    const jx = face === 'surprised' ? 0 : s > 0.55 ? 1 : s < -0.55 ? -1 : 0
    const jy = Math.sin(t * 0.53 + 1.7) > 0.72 ? 1 : 0

    ctx.fillStyle = style.css
    const P = (x: number, y: number, w = 1, h = 1) =>
      ctx.fillRect((x + jx) * 2, (y + jy) * 2, w * 2, h * 2)

    const blink = (face === 'happy' || face === 'tired') && t % 3.7 > 3.52

    switch (face) {
      case 'happy': {
        if (blink) {
          P(7, 7, 4, 1); P(21, 7, 4, 1)
        } else {
          P(7, 4, 4, 4); P(21, 4, 4, 4)
        }
        // smile
        P(7, 12); P(24, 12)
        P(8, 13, 2, 1); P(22, 13, 2, 1)
        P(10, 14, 12, 1)
        break
      }
      case 'angry': {
        // slanted brows
        P(6, 2); P(7, 3); P(8, 4)
        P(25, 2); P(24, 3); P(23, 4)
        // narrowed eyes
        P(7, 6, 4, 3); P(21, 6, 4, 3)
        // frown
        P(7, 15); P(24, 15)
        P(8, 14, 2, 1); P(22, 14, 2, 1)
        P(10, 13, 12, 1)
        break
      }
      case 'hurt': {
        // pinched-shut eye arcs
        P(7, 6); P(8, 5, 3, 1); P(11, 6)
        P(20, 6); P(21, 5, 3, 1); P(24, 6)
        // falling tear under the left eye
        P(8, 7)
        P(8, 9 + (Math.floor(t * 7) % 7))
        // small frown
        P(9, 15); P(22, 15)
        P(10, 14, 2, 1); P(20, 14, 2, 1)
        P(12, 13, 8, 1)
        break
      }
      case 'tired': {
        // heavy lids over half-open eyes
        P(7, 4, 4, 1); P(21, 4, 4, 1)
        if (!blink) { P(7, 6, 4, 2); P(21, 6, 4, 2) }
        // flat mouth
        P(11, 14, 10, 1)
        break
      }
      case 'surprised': {
        // wide ring eyes with pupils
        P(7, 2, 4, 1); P(7, 7, 4, 1); P(6, 3, 1, 4); P(11, 3, 1, 4); P(8, 4, 2, 2)
        P(21, 2, 4, 1); P(21, 7, 4, 1); P(20, 3, 1, 4); P(25, 3, 1, 4); P(22, 4, 2, 2)
        // big O mouth
        P(13, 10, 6, 1); P(13, 17, 6, 1); P(12, 11, 1, 6); P(19, 11, 1, 6)
        break
      }
    }

    // terminal cursor blip in the corner
    if (t % 1 < 0.5) {
      ctx.globalAlpha = 0.55
      P(29, 18)
      ctx.globalAlpha = 1
    }

    ;(material.uniforms.uFaceColor.value as THREE.Color).copy(style.glow)
    texture.needsUpdate = true
  }

  function update(time: number, glow: number) {
    material.uniforms.uTime.value = time
    material.uniforms.uGlow.value = glow
  }

  draw('happy', 0)
  return { texture, material, draw, update }
}
