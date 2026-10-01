import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'

// Final grade + composite pass. Runs AFTER bloom on the HDR buffer:
// exposure → ACES filmic (same curve + 1.18 exposure the game uses) → overlay
// (2D typography canvas) → chromatic split, slice glitch, scanlines, grain,
// vignette, flashes, fades, letterbox. One effect so the glitch UV warp moves
// the 3D frame and the type together.

const FRAG = /* glsl */ `
uniform sampler2D uOverlay;
uniform float uTime;
uniform float uExposure;
uniform float uChroma;
uniform float uGlitch;
uniform float uScan;
uniform float uGrain;
uniform float uVig;
uniform float uFade;
uniform float uLetter;
uniform vec3 uFlash;
uniform vec3 uTint;
uniform float uSat;
uniform float uOverlayChroma;
uniform float uAces;

float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 gRRT(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 gACES(vec3 color) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = inM * color;
  color = gRRT(color);
  color = outM * color;
  return clamp(color, 0.0, 1.0);
}

vec2 gWarp(vec2 uv) {
  if (uGlitch > 0.001) {
    float tick = floor(uTime * 24.0);
    float row = floor(uv.y * 36.0 + gHash(vec2(tick, 3.0)) * 4.0);
    float h = gHash(vec2(row, tick));
    if (h < uGlitch * 0.45) uv.x += (gHash(vec2(row + 9.0, tick)) - 0.5) * 0.16 * uGlitch;
    float band = step(0.93, gHash(vec2(floor(uv.y * 7.0), tick + 1.0))) * uGlitch;
    uv.x += band * 0.03;
  }
  return uv;
}

void mainImage(const in vec4 inputColor, const in vec2 uvIn, out vec4 outputColor) {
  vec2 uv = gWarp(uvIn);
  vec3 hdr = texture2D(inputBuffer, uv).rgb;
  vec2 dc = (uv - 0.5);
  float ca = uChroma * (0.004 + 0.01 * dot(dc, dc));
  if (ca > 0.00001) {
    vec2 d = normalize(dc + 1e-5) * ca;
    hdr.r = texture2D(inputBuffer, uv + d).r;
    hdr.b = texture2D(inputBuffer, uv - d).b;
  }
  // the game's composer output is effectively linear→sRGB (navy sky, saturated
  // CRT green); keep that response and only add a soft shoulder above 0.75 so
  // HDR emissives roll off instead of clipping
  vec3 lin = max(hdr * uExposure, 0.0);
  // hue-preserving: compress the brightest channel, scale the others with it,
  // so fire stays orange and CRT phosphor stays green instead of clipping white
  float m = max(max(lin.r, lin.g), lin.b);
  float mc = m < 0.75 ? m : 0.75 + 0.25 * (1.0 - exp(-(m - 0.75) / 0.25));
  vec3 col = lin * (mc / max(m, 1e-5));
  // only truly hot cores bleach toward white
  col = mix(col, vec3(mc), smoothstep(4.0, 14.0, m) * 0.35);
  col = mix(col, gACES(hdr), uAces);
  // saturation + tint
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat) * uTint;
  // vignette
  float v = smoothstep(0.85, 0.2, length(dc * vec2(1.0, 0.82)));
  col *= mix(1.0, v, uVig);
  // overlay type/graphics (straight alpha), with its own RGB split
  vec2 od = vec2(uOverlayChroma * 0.004, 0.0);
  vec4 ovG = texture2D(uOverlay, uv);
  float oR = texture2D(uOverlay, uv + od).a;
  float oB = texture2D(uOverlay, uv - od).a;
  col = mix(col, ovG.rgb, ovG.a);
  float fr = max(oR - ovG.a, 0.0);
  float fb = max(oB - ovG.a, 0.0);
  col += (vec3(1.0, 0.12, 0.1) * fr + vec3(0.1, 0.7, 1.0) * fb) * 0.9;
  // scanlines + grain
  float sl = 0.5 + 0.5 * sin(uv.y * 1080.0 * 3.14159265 * 0.5);
  col *= 1.0 - uScan * 0.35 * sl;
  float g = gHash(uv * vec2(1920.0, 1080.0) + fract(uTime * 7.13) * 100.0) - 0.5;
  col += g * uGrain * 0.09;
  // flash, fade, letterbox
  col += uFlash;
  col *= 1.0 - uFade;
  float lb = step(uv.y, uLetter) + step(1.0 - uLetter, uv.y);
  col = mix(col, vec3(0.0), lb);
  outputColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

export class GradeEffect extends Effect {
  constructor(overlay: THREE.Texture) {
    super('GradeEffect', FRAG, {
      blendFunction: BlendFunction.SET,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uOverlay', new THREE.Uniform(overlay)],
        ['uTime', new THREE.Uniform(0)],
        ['uExposure', new THREE.Uniform(1.0)],
        ['uChroma', new THREE.Uniform(0.6)],
        ['uGlitch', new THREE.Uniform(0)],
        ['uScan', new THREE.Uniform(0.12)],
        ['uGrain', new THREE.Uniform(0.12)],
        ['uVig', new THREE.Uniform(0.55)],
        ['uFade', new THREE.Uniform(0)],
        ['uLetter', new THREE.Uniform(0)],
        ['uFlash', new THREE.Uniform(new THREE.Vector3())],
        ['uTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uSat', new THREE.Uniform(1.08)],
        ['uOverlayChroma', new THREE.Uniform(0)],
        ['uAces', new THREE.Uniform(0)],
      ]),
    })
  }

  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!
  }
}
