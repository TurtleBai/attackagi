'use client'
import * as THREE from 'three'
import { makeFbm } from '@/game/gfx/textures'

// ─────────────────────────────────────────────────────────────────────────────
// Vfx.shaders — every custom ShaderMaterial used by the Vfx module.
// All of these bypass tone mapping (ShaderMaterial has no tonemapping chunk),
// so hot cores are written > 1.0 to punch through the Bloom threshold (1.0).
// Factories return FRESH materials (per-slot uniforms); geometry is pooled by
// the callers. Nothing here allocates per frame.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Baked energy noise ──────────────────────────────────────────────────────
// One small tiling fbm texture shared by the beam walls + fire glow discs.
// Replaces their per-pixel 4-octave fbm (~16 sin calls/px) with a single
// texture fetch. Tiles every NOISE_TEX_PERIOD noise units, so shaders sample
// at (noiseCoord / NOISE_TEX_PERIOD) with RepeatWrapping.

const NOISE_TEX_SIZE = 128
export const NOISE_TEX_PERIOD = 8

let noiseTex: THREE.CanvasTexture | null = null

function energyNoiseTexture(): THREE.CanvasTexture {
  if (noiseTex) return noiseTex
  const size = NOISE_TEX_SIZE
  const fbm = makeFbm(9107, NOISE_TEX_PERIOD)
  const data = new Uint8ClampedArray(size * size * 4)
  let i = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i += 4) {
      const v = Math.min(255, fbm((x / size) * NOISE_TEX_PERIOD, (y / size) * NOISE_TEX_PERIOD, 4) * 255) | 0
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  canvas.getContext('2d')!.putImageData(new ImageData(data, size, size), 0, 0)
  noiseTex = new THREE.CanvasTexture(canvas)
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping
  noiseTex.needsUpdate = true
  return noiseTex
}

const NOISE2 = /* glsl */ `
float vhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = vhash(i), b = vhash(i + vec2(1.0, 0.0)), c = vhash(i + vec2(0.0, 1.0)), d = vhash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.13, 9.71); a *= 0.5; }
  return s;
}
`

// 2-octave variant for high-fill flame quads; ×1.25 renormalizes the mean back
// to the 4-octave range so erosion thresholds keep their old coverage.
const NOISE2_LO = /* glsl */ `
float vhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = vhash(i), b = vhash(i + vec2(1.0, 0.0)), c = vhash(i + vec2(0.0, 1.0)), d = vhash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 2; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.13, 9.71); a *= 0.5; }
  return s * 1.25;
}
`

const NOISE3_CORE = /* glsl */ `
float h3(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float n3(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float v000 = h3(i), v100 = h3(i + vec3(1.,0.,0.)), v010 = h3(i + vec3(0.,1.,0.)), v110 = h3(i + vec3(1.,1.,0.));
  float v001 = h3(i + vec3(0.,0.,1.)), v101 = h3(i + vec3(1.,0.,1.)), v011 = h3(i + vec3(0.,1.,1.)), v111 = h3(i + vec3(1.,1.,1.));
  return mix(
    mix(mix(v000, v100, f.x), mix(v010, v110, f.x), f.y),
    mix(mix(v001, v101, f.x), mix(v011, v111, f.x), f.y), f.z);
}
`

const NOISE3 = /* glsl */ `
${NOISE3_CORE}
float fbm3(vec3 p){
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++){ s += a * n3(p); p = p * 2.07 + vec3(11.31); a *= 0.5; }
  return s;
}
`

// 2-octave fragment variant (fireball dissolve) — ×1.25 renormalized like NOISE2_LO.
const NOISE3_LO = /* glsl */ `
${NOISE3_CORE}
float fbm3(vec3 p){
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 2; i++){ s += a * n3(p); p = p * 2.07 + vec3(11.31); a *= 0.5; }
  return s * 1.25;
}
`

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

interface MatOpts {
  vert: string
  frag: string
  uniforms: Record<string, THREE.IUniform>
  blending?: THREE.Blending
  depthWrite?: boolean
  depthTest?: boolean
  side?: THREE.Side
  polygonOffset?: boolean
}

function mat(o: MatOpts): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: o.vert,
    fragmentShader: o.frag,
    uniforms: o.uniforms,
    transparent: true,
    blending: o.blending ?? THREE.AdditiveBlending,
    depthWrite: o.depthWrite ?? false,
    depthTest: o.depthTest ?? true,
    side: o.side ?? THREE.DoubleSide,
    polygonOffset: o.polygonOffset ?? false,
    polygonOffsetFactor: o.polygonOffset ? -4 : 0,
    polygonOffsetUnits: o.polygonOffset ? -4 : 0,
  })
}

// ─── Telegraph decals ────────────────────────────────────────────────────────
// uMode: 0 = radial fill, 1 = spinning aim reticle, 2 = smash (alarm rings)

export function telegraphCircleMaterial(): THREE.ShaderMaterial {
  return mat({
    vert: QUAD_VERT,
    polygonOffset: true,
    uniforms: {
      uColor: { value: new THREE.Color(1.9, 0.16, 0.12) },
      uFill: { value: 0 }, uTime: { value: 0 }, uFlash: { value: 0 }, uFade: { value: 0 },
      uIntensity: { value: 1 }, uMode: { value: 0 }, uPulseSpeed: { value: 7 }, uPulseAmp: { value: 0.15 },
    },
    frag: /* glsl */ `
uniform vec3 uColor;
uniform float uFill, uTime, uFlash, uFade, uIntensity, uMode, uPulseSpeed, uPulseAmp;
varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  float rim = smoothstep(0.90, 0.955, r) * (1.0 - smoothstep(0.975, 1.0, r));
  float glow = 0.0;
  if (uMode > 1.5) {
    // smash: alarm rings racing inward over the radial fill
    float rings = smoothstep(0.22, 0.0, abs(fract(r * 3.0 + uTime * 1.6) - 0.5)) * 0.55;
    float fillIn = 1.0 - smoothstep(uFill - 0.04, uFill, r);
    float lead = smoothstep(0.05, 0.0, abs(r - uFill));
    glow = fillIn * 0.4 + lead * 1.6 + rings * (0.35 + fillIn);
  } else if (uMode > 0.5) {
    // spinning reticle: two counter-rotating segmented rings + center dot
    float a1 = ang + uTime * 2.6;
    float ring1 = smoothstep(0.05, 0.018, abs(r - 0.72)) * step(0.15, sin(a1 * 3.0));
    float a2 = ang - uTime * 3.7;
    float ring2 = smoothstep(0.045, 0.015, abs(r - 0.44)) * step(0.0, sin(a2 * 4.0));
    float dotC = smoothstep(0.12, 0.02, r);
    glow = ring1 * 1.25 + ring2 * 1.0 + dotC * 1.5;
  } else {
    float fillIn = 1.0 - smoothstep(uFill - 0.05, uFill, r);
    float lead = smoothstep(0.045, 0.0, abs(r - uFill)) * step(0.001, uFill);
    glow = fillIn * 0.42 + lead * 1.5;
  }
  float pulse = 1.0 + uPulseAmp * sin(uTime * uPulseSpeed);
  float v = rim * 1.5 + glow;
  vec3 col = uColor * v * uIntensity * pulse;
  col = mix(col, vec3(2.6), uFlash);
  float a = clamp(v, 0.0, 1.0) * uFade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`,
  })
}

export function telegraphRectMaterial(): THREE.ShaderMaterial {
  return mat({
    vert: QUAD_VERT,
    polygonOffset: true,
    uniforms: {
      uColor: { value: new THREE.Color(1.9, 0.16, 0.12) },
      uSize: { value: new THREE.Vector2(1, 1) },
      uFill: { value: 0 }, uTime: { value: 0 }, uFlash: { value: 0 }, uFade: { value: 0 },
      uIntensity: { value: 1 }, uPulseSpeed: { value: 7 }, uPulseAmp: { value: 0.15 }, uChevrons: { value: 0 },
    },
    frag: /* glsl */ `
uniform vec3 uColor;
uniform vec2 uSize;
uniform float uFill, uTime, uFlash, uFade, uIntensity, uPulseSpeed, uPulseAmp, uChevrons;
varying vec2 vUv;
void main(){
  float bx = min(vUv.x, 1.0 - vUv.x) * uSize.x;
  float by = min(vUv.y, 1.0 - vUv.y) * uSize.y;
  float border = 1.0 - smoothstep(0.05, 0.17, min(bx, by));
  float fillMask = 1.0 - smoothstep(uFill - 0.01, uFill + 0.01, vUv.y);
  float lead = smoothstep(0.55, 0.0, abs(vUv.y - uFill) * uSize.y) * step(0.001, uFill) * 1.4;
  float body = fillMask * 0.35;
  float chev = 0.0;
  if (uChevrons > 0.5) {
    float ct = fract(vUv.y * uSize.y * 0.35 + abs(vUv.x - 0.5) * 1.7 - uTime * 3.2);
    chev = smoothstep(0.60, 0.70, ct) * (1.0 - smoothstep(0.82, 0.92, ct)) * 0.95;
  }
  float pulse = 1.0 + uPulseAmp * sin(uTime * uPulseSpeed);
  float v = border * 1.45 + body + lead + chev;
  vec3 col = uColor * v * uIntensity * pulse;
  col = mix(col, vec3(2.6), uFlash);
  float a = clamp(v, 0.0, 1.0) * uFade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`,
  })
}

// ─── Fire patches ────────────────────────────────────────────────────────────

export function fireGlowMaterial(): THREE.ShaderMaterial {
  return mat({
    vert: QUAD_VERT,
    polygonOffset: true,
    uniforms: {
      uTime: { value: 0 }, uFade: { value: 0 }, uSeed: { value: 0 },
      uNoise: { value: energyNoiseTexture() },
    },
    frag: /* glsl */ `
uniform float uTime, uFade, uSeed;
uniform sampler2D uNoise;
varying vec2 vUv;
void main(){
  // quad is cropped to radius*2.0 (was *2.3) by FirePatches; rescale so the
  // glow field keeps its exact old world-space footprint (2.0/2.3 = 0.8696) —
  // the trimmed outer band had alpha < 2% and was pure overdraw
  vec2 p = (vUv * 2.0 - 1.0) * 0.8696;
  float r = length(p);
  if (r > 1.0) discard;
  float g = 1.0 - r;
  // baked tiling fbm (1 fetch, was 4-octave analytic fbm = ~16 sin/px)
  float n = texture2D(uNoise, (p * 2.4 + vec2(uSeed, uSeed * 0.7) + vec2(0.0, -uTime * 0.55)) / ${NOISE_TEX_PERIOD.toFixed(1)}).r;
  float flick = 0.78 + 0.22 * sin(uTime * 9.0 + uSeed * 13.0) * sin(uTime * 23.0 + uSeed * 7.0);
  vec3 col = mix(vec3(1.6, 0.30, 0.03), vec3(2.0, 1.05, 0.22), n) * g * g * flick;
  float a = g * g * (0.5 + 0.5 * n) * uFade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`,
  })
}

/** Instanced flame quads: cylindrical billboard + vertex flutter, noise-eroded tips. */
export function flameMaterial(): THREE.ShaderMaterial {
  return mat({
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vert: /* glsl */ `
uniform float uTime;
attribute float aSeed;
attribute vec2 aSpan; // (birth, until) in world.time
varying vec2 vUv;
varying float vSeed;
varying float vFade;
void main(){
  vUv = uv; vSeed = aSeed;
  float t = uTime;
  float fin = smoothstep(aSpan.x, aSpan.x + 0.45, t);
  float fout = 1.0 - smoothstep(aSpan.y - 0.7, aSpan.y, t);
  vFade = fin * fout;
  if (vFade <= 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sc = length(vec3(instanceMatrix[0].xyz));
  vec3 look = cameraPosition - ip.xyz;
  look.y = 0.0;
  float ll = max(length(look), 1e-4);
  look /= ll;
  vec3 right = vec3(look.z, 0.0, -look.x);
  float sway = sin(t * (5.0 + fract(aSeed) * 3.0) + aSeed * 21.0) * 0.4 * uv.y;
  vec3 wp = ip.xyz + right * (position.x + sway * 0.35) * sc + vec3(0.0, (position.y + 0.5) * sc * 1.9, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`,
    frag: /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vSeed;
varying float vFade;
${NOISE2_LO}
void main(){
  float x = vUv.x - 0.5;
  float y = vUv.y;
  float width = 0.36 * (1.0 - y * 0.8);
  float body = smoothstep(width, width * 0.22, abs(x));
  float n = fbm(vec2(x * 3.5 + vSeed * 19.0, y * 2.8 - uTime * (1.8 + fract(vSeed * 0.73) * 1.2)));
  float cut = smoothstep(y * 1.3 - 0.15, y * 1.3 + 0.3, n + 0.42);
  float f = body * cut * vFade;
  if (f < 0.02) discard;
  float core = smoothstep(0.25, 0.9, f) + smoothstep(0.18, 0.0, y) * 0.5;
  vec3 col = mix(vec3(1.5, 0.36, 0.02), vec3(2.1, 1.6, 0.5), clamp(core, 0.0, 1.0));
  gl_FragColor = vec4(col * 1.5, f);
}`,
  })
}

/** Instanced smoke wisps: spherical billboard, looping rise, soft dark puffs. */
export function smokeMaterial(): THREE.ShaderMaterial {
  return mat({
    blending: THREE.NormalBlending,
    uniforms: { uTime: { value: 0 } },
    vert: /* glsl */ `
uniform float uTime;
attribute vec3 aData; // (seed, birth, until)
varying vec2 vUv;
varying float vA;
void main(){
  vUv = uv;
  float t = uTime;
  float seed = aData.x;
  float fin = smoothstep(aData.y, aData.y + 0.7, t);
  float fout = 1.0 - smoothstep(aData.z - 0.9, aData.z, t);
  float cycle = 2.6 + fract(seed * 0.37) * 1.6;
  float ph = fract((t * 0.9 + seed * 7.0) / cycle);
  vA = fin * fout * ph * (1.0 - ph) * 4.0 * 0.30;
  if (vA <= 0.004) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sc = length(vec3(instanceMatrix[0].xyz));
  vec3 wp = ip.xyz + vec3(
    sin(seed * 11.0 + t * 0.6) * 0.5,
    0.6 + ph * (2.4 + fract(seed) * 1.6),
    cos(seed * 13.0 + t * 0.5) * 0.5);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  mv.xy += position.xy * sc * (0.7 + ph * 1.5);
  gl_Position = projectionMatrix * mv;
}`,
    frag: /* glsl */ `
varying vec2 vUv;
varying float vA;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = smoothstep(1.0, 0.2, r) * vA;
  if (a < 0.005) discard;
  gl_FragColor = vec4(vec3(0.05, 0.05, 0.055), a);
}`,
  })
}

/** Ember points drifting up out of fire patches. */
export function emberMaterial(): THREE.ShaderMaterial {
  return mat({
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 } },
    vert: /* glsl */ `
uniform float uTime, uPx;
attribute vec3 aCenter;
attribute vec4 aData; // (radius, birth, until, seed)
varying float vA;
void main(){
  float t = uTime;
  float seed = aData.w;
  float fin = smoothstep(aData.y, aData.y + 0.4, t);
  float fout = 1.0 - smoothstep(aData.z - 0.5, aData.z, t);
  float cyc = 1.5 + fract(seed * 0.61);
  float ph = fract((t * (0.7 + fract(seed * 0.4) * 0.6) + seed * 5.0) / cyc);
  vA = fin * fout * (1.0 - ph) * smoothstep(0.0, 0.12, ph);
  vec3 wp = aCenter + vec3(
    sin(seed * 37.0) * aData.x * 0.6 + sin(t * 2.0 + seed * 17.0) * 0.35,
    0.2 + ph * (2.6 + fract(seed * 0.8) * 2.2),
    cos(seed * 41.0) * aData.x * 0.6 + cos(t * 1.7 + seed * 23.0) * 0.35);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float ps = uPx * 8.0 / max(2.0, -mv.z);
  gl_PointSize = vA <= 0.004 ? 0.0 : clamp(ps, 1.0, 14.0);
}`,
    frag: /* glsl */ `
varying float vA;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0 || vA <= 0.004) discard;
  float g = 1.0 - r2;
  gl_FragColor = vec4(vec3(2.4, 1.0, 0.28) * g, g * vA);
}`,
  })
}

// ─── Beam walls + scorch ─────────────────────────────────────────────────────

export function beamWallMaterial(): THREE.ShaderMaterial {
  return mat({
    uniforms: {
      uColor: { value: new THREE.Color(1.8, 0.32, 0.16) },
      uTime: { value: 0 }, uFade: { value: 0 }, uLen: { value: 10 }, uSeed: { value: 0 },
      uNoise: { value: energyNoiseTexture() },
    },
    vert: QUAD_VERT,
    frag: /* glsl */ `
uniform vec3 uColor;
uniform float uTime, uFade, uLen, uSeed;
uniform sampler2D uNoise;
varying vec2 vUv; // x along, y up
void main(){
  // baked tiling fbm (1 fetch, was 4-octave analytic fbm = ~16 sin/px)
  float n = texture2D(uNoise, vec2(vUv.x * uLen * 0.3 - uTime * 3.4 + uSeed, vUv.y * 2.5 + uTime * 0.9) / ${NOISE_TEX_PERIOD.toFixed(1)}).r;
  float coreQ = (vUv.y - 0.10) * 6.5;
  float core = exp(-coreQ * coreQ);
  float topFade = 1.0 - smoothstep(0.45, 1.0, vUv.y);
  float energy = 0.5 + 0.5 * n;
  vec3 halo = uColor * (0.35 + 0.75 * energy) * topFade;
  vec3 col = halo + vec3(3.0, 2.7, 2.4) * core * (0.7 + 0.6 * energy);
  float a = uFade * topFade * clamp(0.26 + core * 0.9 + (energy - 0.5) * 0.3, 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`,
  })
}

export function scorchMaterial(): THREE.ShaderMaterial {
  return mat({
    blending: THREE.NormalBlending,
    polygonOffset: true,
    uniforms: { uFade: { value: 0 }, uSeed: { value: 0 } },
    vert: QUAD_VERT,
    frag: /* glsl */ `
uniform float uFade, uSeed;
varying vec2 vUv;
${NOISE2}
void main(){
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float along = smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);
  float n = fbm(vec2(vUv.x * 4.0 + uSeed, vUv.y * 24.0));
  float a = smoothstep(0.06, 0.65, across * (0.45 + 0.65 * n)) * along * 0.8 * uFade;
  if (a < 0.006) discard;
  gl_FragColor = vec4(vec3(0.02, 0.016, 0.012), a);
}`,
  })
}

// ─── Bursts / shockwaves / fireballs ─────────────────────────────────────────

export function ringMaterial(): THREE.ShaderMaterial {
  // Drawn on a unit annulus (RingGeometry inner 0.7) scaled by life instead of
  // a full max-radius quad — ~10x less fill on big rings. uScale = meshScale /
  // maxRadius, so rl * uScale recovers the same normalized radius the old quad
  // shader used and the analytic band profile is unchanged where covered.
  return mat({
    vert: QUAD_VERT,
    polygonOffset: true,
    uniforms: {
      uColor: { value: new THREE.Color(2.4, 1.1, 0.5) },
      uP: { value: 0 }, uFade: { value: 0 }, uWidth: { value: 0.22 }, uScale: { value: 1 },
    },
    frag: /* glsl */ `
uniform vec3 uColor;
uniform float uP, uFade, uWidth, uScale;
varying vec2 vUv;
void main(){
  float rl = length(vUv * 2.0 - 1.0); // annulus span: 0.7..1.0
  float r = rl * uScale;              // normalized world radius (1 = maxRadius)
  float d = abs(r - uP);
  float ring = 1.0 - smoothstep(0.0, uWidth, d);
  float inner = smoothstep(0.70, 0.78, rl); // feather the inner geometric edge
  float a = ring * ring * uFade * inner;
  if (a < 0.005) discard;
  gl_FragColor = vec4(uColor * (0.4 + a), a);
}`,
  })
}

/** Expanding fireball sphere with 3D-noise dissolve. */
export function fireballMaterial(): THREE.ShaderMaterial {
  return mat({
    side: THREE.FrontSide,
    uniforms: {
      uLife: { value: 0 }, uSeed: { value: 0 },
      uCore: { value: new THREE.Color(3.4, 2.2, 0.9) },
      uEdge: { value: new THREE.Color(1.6, 0.4, 0.05) },
    },
    vert: /* glsl */ `
uniform float uLife, uSeed;
varying vec3 vP;
${NOISE3}
void main(){
  vP = position;
  float d = fbm3(position * 2.2 + vec3(uSeed) + vec3(0.0, uLife * 1.4, 0.0));
  vec3 p = position * (1.0 + (d - 0.5) * 0.6);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`,
    frag: /* glsl */ `
uniform float uLife, uSeed;
uniform vec3 uCore, uEdge;
varying vec3 vP;
${NOISE3_LO}
void main(){
  float n = fbm3(vP * 3.1 + vec3(uSeed * 3.0) + vec3(0.0, -uLife * 2.2, 0.0));
  float th = uLife * 1.25 - 0.14;
  float m = n - th;
  if (m < 0.0) discard;
  float rim = smoothstep(0.20, 0.0, m);
  vec3 col = mix(uCore, uEdge, clamp(uLife * 1.25, 0.0, 1.0));
  col += vec3(2.2, 1.4, 0.6) * rim;
  float a = clamp(1.35 - uLife * 1.35, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
}`,
  })
}

// ─── Instanced particle families ─────────────────────────────────────────────

/** Velocity-stretched additive spark streaks (instanced; aLife + aColor attrs). */
export function sparkMaterial(): THREE.ShaderMaterial {
  return mat({
    uniforms: {},
    vert: /* glsl */ `
attribute float aLife;
attribute vec3 aColor;
varying vec2 vUv;
varying float vLife;
varying vec3 vCol;
void main(){
  vUv = uv; vLife = aLife; vCol = aColor;
  if (aLife <= 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`,
    frag: /* glsl */ `
varying vec2 vUv;
varying float vLife;
varying vec3 vCol;
void main(){
  float ax = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float ay = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = pow(max(ax, 1e-5), 2.2) * pow(max(ay, 1e-5), 0.8) * vLife;
  if (a < 0.006) discard;
  gl_FragColor = vec4(vCol * (0.7 + 1.5 * vLife), a);
}`,
  })
}

/** Soft billboarded dust/smoke puffs (instanced; normal blending). */
export function puffMaterial(): THREE.ShaderMaterial {
  return mat({
    blending: THREE.NormalBlending,
    uniforms: {},
    vert: /* glsl */ `
attribute float aLife;
attribute vec3 aColor;
varying vec2 vUv;
varying float vLife;
varying vec3 vCol;
void main(){
  vUv = uv; vLife = aLife; vCol = aColor;
  if (aLife <= 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sc = length(vec3(instanceMatrix[0].xyz));
  vec4 mv = viewMatrix * vec4(ip.xyz, 1.0);
  mv.xy += position.xy * sc;
  gl_Position = projectionMatrix * mv;
}`,
    frag: /* glsl */ `
varying vec2 vUv;
varying float vLife;
varying vec3 vCol;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float soft = smoothstep(1.0, 0.15, r);
  float a = soft * pow(max(vLife, 1e-5), 1.2) * smoothstep(1.0, 0.88, vLife) * 0.55;
  if (a < 0.006) discard;
  gl_FragColor = vec4(vCol, a);
}`,
  })
}

// ─── One-shot quads ──────────────────────────────────────────────────────────

/** Thin hot tracer line (quad, length along local Y). */
export function tracerMaterial(): THREE.ShaderMaterial {
  return mat({
    uniforms: { uLife: { value: 0 }, uColor: { value: new THREE.Color(2.6, 1.7, 0.9) } },
    vert: QUAD_VERT,
    frag: /* glsl */ `
uniform float uLife;
uniform vec3 uColor;
varying vec2 vUv;
void main(){
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float head = smoothstep(0.0, 0.12, vUv.y);
  float a = pow(max(across, 1e-5), 2.5) * head * uLife;
  if (a < 0.006) discard;
  gl_FragColor = vec4(uColor * (1.1 + 1.4 * uLife), a);
}`,
  })
}

/** Fat beam-discharge flash (quad, length along local Y, hot core + halo). */
export function beamFlashMaterial(): THREE.ShaderMaterial {
  return mat({
    uniforms: { uLife: { value: 0 }, uColor: { value: new THREE.Color(3.0, 1.4, 1.2) } },
    vert: QUAD_VERT,
    frag: /* glsl */ `
uniform float uLife;
uniform vec3 uColor;
varying vec2 vUv;
void main(){
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float ends = smoothstep(0.0, 0.03, vUv.y) * smoothstep(1.0, 0.97, vUv.y);
  float core = pow(max(across, 1e-5), 6.0) * 2.5;
  float halo = pow(max(across, 1e-5), 1.6);
  float a = (halo * 0.45 + core) * ends * uLife;
  if (a < 0.006) discard;
  vec3 col = uColor * halo + vec3(3.0) * core;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`,
  })
}

/** Star-shaped muzzle/impact flash quad (billboarded by CPU). */
export function flashMaterial(): THREE.ShaderMaterial {
  return mat({
    uniforms: { uLife: { value: 0 }, uColor: { value: new THREE.Color(2.6, 1.8, 0.9) } },
    vert: QUAD_VERT,
    frag: /* glsl */ `
uniform float uLife;
uniform vec3 uColor;
varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  float rays = pow(max(abs(sin(ang * 3.0 + 0.6)), 1e-5), 8.0) * 0.7 + pow(max(abs(cos(ang * 2.0)), 1e-5), 12.0) * 0.9;
  float star = pow(max(1.0 - r, 1e-5), 3.0) * 2.0 + rays * pow(max(1.0 - r, 1e-5), 1.2);
  float a = star * uLife;
  if (a < 0.006) discard;
  gl_FragColor = vec4(uColor * star * 1.6, clamp(a, 0.0, 1.0));
}`,
  })
}

// ─── Camera-space overlays ───────────────────────────────────────────────────

/** Bat swing arc ribbon (uv.x along arc, uv.y across). */
export function slashMaterial(): THREE.ShaderMaterial {
  return mat({
    depthTest: false,
    uniforms: { uT: { value: 2 }, uColor: { value: new THREE.Color(1.4, 1.7, 2.4) } },
    vert: QUAD_VERT,
    frag: /* glsl */ `
uniform float uT;
uniform vec3 uColor;
varying vec2 vUv;
void main(){
  float front = smoothstep(uT, uT - 0.06, vUv.x);
  float trail = smoothstep(uT - 0.5, uT - 0.06, vUv.x);
  float across = max(sin(vUv.y * 3.14159), 0.0);
  float a = front * trail * across * sqrt(across) * clamp(1.3 - uT, 0.0, 1.0);
  if (a < 0.006) discard;
  gl_FragColor = vec4(uColor * (0.7 + 1.9 * trail), a * 0.9);
}`,
  })
}

/** Dodge speed streaks at the screen edges (camera-attached quad). */
export function dodgeMaterial(): THREE.ShaderMaterial {
  return mat({
    depthTest: false,
    uniforms: { uLife: { value: 0 }, uTime: { value: 0 } },
    vert: QUAD_VERT,
    frag: /* glsl */ `
uniform float uLife, uTime;
varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float edge = smoothstep(0.38, 1.05, r);
  float ang = atan(p.y, p.x);
  float sp = pow(max(abs(sin(ang * 11.0)), 1e-5), 4.0) * 0.7 + pow(max(abs(sin(ang * 5.0 + 1.7)), 1e-5), 6.0);
  float move = 0.6 + 0.4 * sin(r * 40.0 - uTime * 70.0);
  float a = edge * sp * move * uLife * 0.5;
  if (a < 0.006) discard;
  gl_FragColor = vec4(vec3(0.7, 0.85, 1.25) * (1.0 + uLife), a);
}`,
  })
}
