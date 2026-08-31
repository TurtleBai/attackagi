'use client'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { AgiState } from '@/game/world'

// ─── Eldritch tentacle mass behind the AGI ───────────────────────────────────
// The "smiling mask, horror behind it" reveal: a fan of thick organic tentacles
// sprouts from behind the torso/shoulder block, rises above and beside the
// monitor head and curls outward, silhouetted against the night sky. Scattered
// across them are EYES that track the player and blink.
//
// Budget: exactly 2 draw calls —
//   1. ONE merged mesh for all 11 tentacles. Undulation runs entirely in the
//      vertex shader (MeshStandardMaterial + onBeforeCompile so lighting/fog/
//      tonemapping match the scene): per-tentacle sway basis + phase live in
//      vertex attributes, bend/curl amplitude ramps toward the tip, and a
//      droop term hangs the tips for tired/limp moods. 29 procedural eyes are
//      drawn in the FRAGMENT shader as SDFs in surface-space (meters), so they
//      stay glued to the deforming skin: pale sclera, dark pupil offset toward
//      the player (uTentLook projected onto a derivative-based tangent frame),
//      per-eye blink phases, lids driven by uTentEyeOpen.
//   2. ONE InstancedMesh with 3 larger "hero" eyeballs on short stalks. Their
//      CPU positions replicate the exact vertex-shader undulation formula
//      (shared TS constants) so they ride their host tentacle without drift;
//      their pupils are shaded procedurally from the same look uniform.
//
// No shadow casting, no per-frame allocations, geometry built once. Attached
// to the rig's `bob` group so the whole mass inherits the boss hover bob and
// hides with the model on death.
//
// NaN safety (bloom blacks the screen on a single NaN pixel): no pow() anywhere
// in injected GLSL — powers are multiplied out; every sqrt gets a +epsilon;
// every normalize goes through inversesqrt(max(dot,eps)).

// ── undulation constants (shared verbatim between GLSL and the CPU mirror) ──
const FREQ_A = 3.1
const FREQ_B = 5.3
const FREQ_C = 9.1
const SPD_B = 0.63
const SPD_C = 1.9
const PH_B = 1.7
const PH_C = 2.3
const MIX_B = 0.55
const MIX_C = 0.6
const DROOP_A = 1.35
const DROOP_B = 0.25
const CURL_T0 = 0.45
const CURL_K = 1.8
// slow large-scale writhing layer: whole tentacles arc/cross over seconds
const SLOW_A = 0.31 // phase rate of the lateral arc (× uTentPh)
const SLOW_B = 0.23
const SLOW_AMP_A = 1.1
const SLOW_AMP_B = 0.8
const SLOW_FREQ_A = 1.3 // along-length frequency (low → whole-arm bends)
const SLOW_FREQ_B = 1.1
const PUMP_F = 0.42 // tip curl/uncurl pump rate
const PUMP_PH = 1.9

const fl = (n: number): string => n.toFixed(4)

// ── mood targets (world.agi.mode → uniform goals, lerped per frame) ──────────

interface Mood { amp: number; speed: number; droop: number; eye: number }

const MOODS: Record<AgiState['mode'], Mood> = {
  waves: { amp: 0.62, speed: 0.5, droop: 0.12, eye: 0.55 }, // big lazy swells, half-lidded
  smashing: { amp: 1.0, speed: 1.5, droop: 0.02, eye: 0.95 },
  fighting: { amp: 1.15, speed: 1.9, droop: 0.02, eye: 1.0 }, // agitated writhe, eyes wide
  tired: { amp: 0.35, speed: 0.5, droop: 1.0, eye: 0.15 }, // hanging, eyes closing
  dying: { amp: 1.7, speed: 3.4, droop: 0.0, eye: 1.0 }, // violent thrash…
  dead: { amp: 0.1, speed: 0.3, droop: 1.5, eye: 0.0 }, // (hidden with the model)
}
const LIMP: Mood = { amp: 0.12, speed: 0.35, droop: 1.6, eye: 0.05 } // …then limp

// ── GLSL ─────────────────────────────────────────────────────────────────────

const GLSL_HELPERS = /* glsl */ `
float agiHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float agiNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = agiHash(i);
  float b = agiHash(i + vec2(1.0, 0.0));
  float c = agiHash(i + vec2(0.0, 1.0));
  float d = agiHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec3 agiSafeN(vec3 v) { return v * inversesqrt(max(dot(v, v), 1e-8)); }
float agiBlink(float tt, float seed) {
  float sp = 0.09 + 0.13 * fract(seed * 0.7231);
  float bt = fract(tt * sp + fract(seed * 0.3719) * 7.0);
  return smoothstep(0.44, 0.5, bt) * (1.0 - smoothstep(0.5, 0.56, bt));
}
`

const TENT_VERT_DECL = /* glsl */ `
#define TNT_FREQ_A ${fl(FREQ_A)}
#define TNT_FREQ_B ${fl(FREQ_B)}
#define TNT_FREQ_C ${fl(FREQ_C)}
#define TNT_SPD_B ${fl(SPD_B)}
#define TNT_SPD_C ${fl(SPD_C)}
#define TNT_PH_B ${fl(PH_B)}
#define TNT_PH_C ${fl(PH_C)}
#define TNT_MIX_B ${fl(MIX_B)}
#define TNT_MIX_C ${fl(MIX_C)}
#define TNT_DROOP_A ${fl(DROOP_A)}
#define TNT_DROOP_B ${fl(DROOP_B)}
#define TNT_CURL_T0 ${fl(CURL_T0)}
#define TNT_CURL_K ${fl(CURL_K)}
#define TNT_SLOW_A ${fl(SLOW_A)}
#define TNT_SLOW_B ${fl(SLOW_B)}
#define TNT_SLOW_AMP_A ${fl(SLOW_AMP_A)}
#define TNT_SLOW_AMP_B ${fl(SLOW_AMP_B)}
#define TNT_SLOW_FREQ_A ${fl(SLOW_FREQ_A)}
#define TNT_SLOW_FREQ_B ${fl(SLOW_FREQ_B)}
#define TNT_PUMP_F ${fl(PUMP_F)}
#define TNT_PUMP_PH ${fl(PUMP_PH)}
uniform float uTentPh;
uniform float uTentAmp;
uniform float uTentDroop;
attribute float aTentRad;
attribute vec4 aTentInfo;   // phase, tentacleId, ampMeters, length
attribute vec2 aTentInfo2;  // baseRadius, eyeCount
attribute vec3 aTentSwayA;
attribute vec3 aTentSwayB;
varying vec3 vTentWP;
varying vec2 vTentUv;
varying vec4 vTentEye;      // tentacleId, eyeCount, length, baseRadius
varying float vTentRad;
varying float vTentNy;
`

// injected over <beginnormal_vertex>: computes the undulation offset (used by
// <begin_vertex> below) and bends the object normal by the sway slope
const TENT_VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
float tT = uv.y;
float tEnv = tT * tT;
float tCs = clamp((tT - TNT_CURL_T0) * TNT_CURL_K, 0.0, 1.0);
float tEnvC = tCs * tCs * (3.0 - 2.0 * tCs);
float tPhase = aTentInfo.x;
float tAmp = aTentInfo.z * uTentAmp;
float tK1 = uTentPh + tPhase + tT * TNT_FREQ_A;
float tK2 = uTentPh * TNT_SPD_B + tPhase * TNT_PH_B + tT * TNT_FREQ_B;
float tK3 = uTentPh * TNT_SPD_C + tPhase * TNT_PH_C + tT * TNT_FREQ_C;
float tW1 = sin(tK1);
float tW2 = cos(tK2);
float tW3 = sin(tK3);
// slow large-scale writhing: near-linear envelope so whole tentacles arc,
// cross and weave over several seconds (per-tentacle phases desynchronize)
float tKa = uTentPh * TNT_SLOW_A + tPhase * 3.1 + tT * TNT_SLOW_FREQ_A;
float tKb = uTentPh * TNT_SLOW_B + tPhase * 2.2 + tT * TNT_SLOW_FREQ_B;
float tWa = sin(tKa);
float tWb = cos(tKb);
// tips slowly curl and uncurl
float tPump = 0.7 + 0.5 * sin(uTentPh * TNT_PUMP_F + tPhase * TNT_PUMP_PH);
vec3 tTentDisp = aTentSwayA * (tAmp * (tW1 * tEnv + TNT_SLOW_AMP_A * tWa * tT))
  + aTentSwayB * (tAmp * (tW2 * tEnv * TNT_MIX_B + tW3 * tEnvC * TNT_MIX_C * tPump + TNT_SLOW_AMP_B * tWb * tT));
float tDroop = aTentInfo.z * uTentDroop;
tTentDisp.y -= tDroop * (TNT_DROOP_A * tEnv * tEnv + TNT_DROOP_B * tEnv);
// cheap normal fix: tilt away from the spine axis by the sway slope d(disp)/ds
float tdEnv = 2.0 * tT;
float tdEnvC = 6.0 * tCs * (1.0 - tCs) * TNT_CURL_K;
vec3 tSlope = aTentSwayA * (tAmp * (cos(tK1) * TNT_FREQ_A * tEnv + tW1 * tdEnv
                + TNT_SLOW_AMP_A * (tWa + tT * cos(tKa) * TNT_SLOW_FREQ_A)))
  + aTentSwayB * (tAmp * ((-sin(tK2)) * TNT_FREQ_B * tEnv + tW2 * tdEnv) * TNT_MIX_B
                + tAmp * (cos(tK3) * TNT_FREQ_C * tEnvC + tW3 * tdEnvC) * TNT_MIX_C * tPump
                + tAmp * TNT_SLOW_AMP_B * (tWb - tT * sin(tKb) * TNT_SLOW_FREQ_B));
tSlope.y -= tDroop * (4.0 * TNT_DROOP_A * tEnv * tT + 2.0 * TNT_DROOP_B * tT);
tSlope /= max(aTentInfo.w, 1.0);
vec3 tSpine = cross(aTentSwayA, aTentSwayB);
vec3 tBentN = objectNormal - tSpine * clamp(dot(tSlope, objectNormal), -1.2, 1.2);
objectNormal = tBentN * inversesqrt(max(dot(tBentN, tBentN), 1e-6));
vTentNy = objectNormal.y;
`

const TENT_VERT_TRANSFORM = /* glsl */ `
#include <begin_vertex>
transformed += tTentDisp;
vTentWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTentUv = uv;
vTentRad = aTentRad;
vTentEye = vec4(aTentInfo.y, aTentInfo2.y, aTentInfo.w, aTentInfo2.x);
`

const TENT_FRAG_DECL = /* glsl */ `
uniform float uTentT;
uniform float uTentEyeOpen;
uniform vec3 uTentLook;
varying vec3 vTentWP;
varying vec2 vTentUv;
varying vec4 vTentEye;
varying float vTentRad;
varying float vTentNy;
${GLSL_HELPERS}
`

// injected over <map_fragment>: sickly skin albedo + SDF eyes in surface space
const TENT_FRAG_SURFACE = /* glsl */ `
vec2 tSurf = vec2(vTentUv.x * 6.2831853 * vTentRad, vTentUv.y * vTentEye.z);
float tN1 = agiNoise(tSurf * 0.85 + vTentEye.x * 3.71);
float tN2 = agiNoise(tSurf * 2.9 + vTentEye.x * 9.13);
float tNn = tN1 * 0.72 + tN2 * 0.28;
vec3 tSkin = mix(vec3(0.045, 0.075, 0.055), vec3(0.17, 0.23, 0.16), tNn);
tSkin = mix(tSkin, vec3(0.11, 0.075, 0.13), smoothstep(0.62, 1.0, vTentUv.y) * 0.5);
float tRidge = 0.5 + 0.5 * sin(vTentUv.y * vTentEye.z * 4.2 + tN1 * 2.2);
tSkin *= 0.9 + 0.1 * tRidge;
tSkin *= 0.72 + 0.28 * smoothstep(0.02, 0.28, vTentUv.y);
tSkin *= 0.88 + 0.12 * clamp(vTentNy * 0.5 + 0.5, 0.0, 1.0);
float tSkinRough = clamp(0.52 - 0.16 * tRidge + 0.14 * tN2, 0.22, 0.62);
float tEyeMask = 0.0;
float tEyeGlow = 0.0;
vec3 tCol = tSkin;
// tangent frame from screen-space derivatives → pupil look-at offset stays
// correct on the deforming surface with zero extra attributes
vec3 tDpx = dFdx(vTentWP);
vec3 tDpy = dFdy(vTentWP);
vec2 tDsx = dFdx(tSurf);
vec2 tDsy = dFdy(tSurf);
float tDetS = (tDsx.x * tDsy.y - tDsx.y * tDsy.x) >= 0.0 ? 1.0 : -1.0;
vec3 tTu = agiSafeN((tDpx * tDsy.y - tDpy * tDsx.y) * tDetS);
vec3 tTv = agiSafeN((tDpy * tDsx.x - tDpx * tDsy.x) * tDetS);
vec2 tLookP = vec2(dot(uTentLook, tTu), dot(uTentLook, tTv));
float tTid = vTentEye.x;
float tEyeN = vTentEye.y;
for (int i = 0; i < 3; i++) {
  float fi = float(i);
  if (fi >= tEyeN - 0.5) break;
  float h1 = agiHash(vec2(tTid * 13.1, fi * 7.7 + 1.3));
  float h2 = agiHash(vec2(tTid * 3.7 + 11.0, fi * 17.3));
  float h3 = agiHash(vec2(tTid * 29.3, fi * 3.3 + 23.0));
  float vc = 0.16 + (fi + h1 * 0.7) * (0.6 / max(tEyeN - 0.3, 1.0));
  float uc = 0.5 + (h2 - 0.5) * 0.34;
  float er = min((0.22 + 0.28 * h3) * clamp(vTentEye.w, 0.5, 2.0), vTentRad * 0.7);
  float du = (fract(vTentUv.x - uc + 0.5) - 0.5) * 6.2831853 * vTentRad;
  float dv = (vTentUv.y - vc) * vTentEye.z;
  float dEye = sqrt(du * du + dv * dv + 1e-8);
  float sd = dEye - er;
  float aa = max(fwidth(sd) * 1.4, 0.004);
  float inEye = 1.0 - smoothstep(-aa, aa, sd);
  if (inEye <= 0.001) continue;
  float open = clamp(uTentEyeOpen * (1.0 - 1.5 * agiBlink(uTentT, tTid * 5.7 + fi * 2.9)), 0.0, 1.0);
  float lidHalf = er * (0.1 + open);
  float lid = 1.0 - smoothstep(lidHalf - aa * 2.0, lidHalf + aa * 2.0, abs(dv));
  float openEye = inEye * lid;
  vec2 pq = vec2(du, dv) - tLookP * er * 0.5;
  float pd = sqrt(dot(pq, pq) + 1e-8);
  float irisM = 1.0 - smoothstep(er * 0.5 - aa, er * 0.5 + aa, pd);
  float prF = mix(0.4, 0.26, uTentEyeOpen);
  float pupM = 1.0 - smoothstep(er * prF - aa, er * prF + aa, pd);
  float blood = smoothstep(er * 0.45, er * 0.98, dEye);
  vec3 scl = mix(vec3(0.42, 0.38, 0.26), vec3(0.30, 0.13, 0.10), blood * 0.6);
  vec3 eyeC = mix(scl, vec3(0.28, 0.30, 0.14), irisM);
  eyeC = mix(eyeC, vec3(0.012, 0.012, 0.012), pupM);
  tCol = mix(tCol, eyeC, openEye);
  tCol = mix(tCol, tSkin * vec3(0.9, 0.85, 0.95), inEye * (1.0 - lid) * 0.5);
  tEyeMask = max(tEyeMask, openEye);
  tEyeGlow += openEye * (1.0 - max(irisM * 0.75, pupM));
}
diffuseColor.rgb = tCol;
`

const TENT_FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mix(tSkinRough, 0.12, tEyeMask);
`

const TENT_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
vec3 tVdir = agiSafeN(vViewPosition);
float tRim = 1.0 - abs(dot(tVdir, normal));
totalEmissiveRadiance += vec3(0.16, 0.24, 0.19) * (tRim * tRim) * 0.5;
// faint ambient self-glow so the mass never reads black-on-black at night
totalEmissiveRadiance += diffuseColor.rgb * 0.14;
totalEmissiveRadiance += vec3(0.55, 0.50, 0.38) * tEyeGlow * 0.4;
`

// ── hero eyeball shaders (instanced spheres on stalks) ───────────────────────

const HERO_VERT_DECL = /* glsl */ `
attribute float aHeroSeed;
varying float vHeroSeed;
varying vec3 vHeroOP;
varying vec3 vHeroON;
varying vec3 vHeroWN;
`

const HERO_VERT_TRANSFORM = /* glsl */ `
#include <begin_vertex>
vHeroOP = position;
vHeroON = objectNormal;
vec3 hWn = objectNormal;
#ifdef USE_INSTANCING
hWn = mat3(instanceMatrix) * hWn;
#endif
vHeroWN = hWn;
vHeroSeed = aHeroSeed;
`

const HERO_FRAG_DECL = /* glsl */ `
uniform float uTentT;
uniform float uTentEyeOpen;
uniform vec3 uTentLook;
varying float vHeroSeed;
varying vec3 vHeroOP;
varying vec3 vHeroON;
varying vec3 vHeroWN;
${GLSL_HELPERS}
`

const HERO_FRAG_SURFACE = /* glsl */ `
vec3 hN = agiSafeN(vHeroWN);
vec3 hLn = agiSafeN(vHeroON);
float hC = clamp(dot(hN, uTentLook), -1.0, 1.0);
float hOpen = clamp(uTentEyeOpen * (1.0 - 1.5 * agiBlink(uTentT, vHeroSeed)), 0.03, 1.0);
float hLidT = mix(0.1, 0.92, hOpen);
float hLid = smoothstep(hLidT - 0.08, hLidT + 0.08, abs(hLn.y));
float hZone = smoothstep(-0.5, -0.25, vHeroOP.y);
float hIris = smoothstep(0.84, 0.9, hC);
float hPup = smoothstep(0.94, 0.965, hC);
float hBlood = smoothstep(0.3, 0.95, 1.0 - hC);
vec3 hScl = mix(vec3(0.45, 0.41, 0.28), vec3(0.30, 0.13, 0.10), hBlood * 0.55);
vec3 hEye = mix(hScl, vec3(0.27, 0.29, 0.13), hIris);
hEye = mix(hEye, vec3(0.01, 0.01, 0.01), hPup);
float hNz = agiNoise(vHeroOP.xy * 2.6 + vHeroSeed * 3.1 + vHeroOP.z);
vec3 hSkin = mix(vec3(0.045, 0.075, 0.055), vec3(0.16, 0.22, 0.15), hNz);
float hShow = hZone * (1.0 - hLid);
diffuseColor.rgb = mix(hSkin, hEye, hShow);
float hMask = hShow;
`

const HERO_FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mix(0.42, 0.1, hMask);
`

const HERO_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * 0.14;
totalEmissiveRadiance += vec3(0.55, 0.50, 0.38) * hShow * (1.0 - max(hIris * 0.75, hPup)) * 0.3;
`

// ── tentacle fan authoring (boss/bob-local space) ────────────────────────────
// Torso block: x ±12, y 8..21, z −76.5..−64.5. Head: x ±8, y 21.5..32.5,
// z −68..−60. Bases sit inside the torso so the open root rings never show.

interface TentSpec {
  base: [number, number, number]
  dir: [number, number, number] // initial growth direction
  plane: [number, number, number] // curl-plane normal (silhouette plane)
  len: number
  baseR: number
  curl: number // total in-plane rotation along the spine (sign = curl side)
  eyes: number // fragment-shader eyes on this tentacle
}

const CENTER_SPEC: TentSpec = {
  base: [0.8, 17, -74.5], dir: [0.06, 1, -0.1], plane: [1, 0, 0.15],
  len: 28, baseR: 2.4, curl: 1.0, eyes: 3, // tallest trunk; tip arcs forward over the head
}

const RIGHT_SPECS: TentSpec[] = [
  // broad trunks that dominate the silhouette
  { base: [4.6, 17.5, -74.0], dir: [0.36, 1, -0.06], plane: [0.1, 0, 1], len: 28, baseR: 2.0, curl: -1.85, eyes: 3 },
  { base: [8.5, 16.5, -73.5], dir: [0.85, 1, -0.05], plane: [0, 0, 1], len: 21, baseR: 2.2, curl: -2.6, eyes: 3 },
  { base: [6.4, 17.5, -75.4], dir: [0.5, 1, -0.12], plane: [-0.15, 0, 1], len: 24, baseR: 1.6, curl: -2.0, eyes: 3 },
  // thinner curling ones for variety
  { base: [11.5, 15.5, -72.5], dir: [0.9, 0.75, 0.1], plane: [0, 0.1, 1], len: 11, baseR: 0.9, curl: -2.8, eyes: 2 },
  { base: [2.2, 16.5, -76.0], dir: [0.18, 1, -0.22], plane: [0.6, 0, 0.8], len: 14, baseR: 0.8, curl: 2.2, eyes: 2 },
]

/** Mirror across x (negating curl keeps the hook bending outward). */
function mirrorSpec(s: TentSpec): TentSpec {
  return {
    base: [-s.base[0], s.base[1], s.base[2]],
    dir: [-s.dir[0], s.dir[1], s.dir[2]],
    plane: [-s.plane[0], s.plane[1], s.plane[2]],
    len: s.len * 0.92, // slight asymmetry so the fan reads organic
    baseR: s.baseR * 0.96,
    curl: -s.curl,
    eyes: s.eyes,
  }
}

interface TentData {
  spine: THREE.Vector3[]
  radii: number[]
  swayA: THREE.Vector3
  swayB: THREE.Vector3
  phase: number
  amp: number
}

interface HeroAnchor {
  rest: THREE.Vector3
  quat: THREE.Quaternion
  scale: number
  swayA: THREE.Vector3
  swayB: THREE.Vector3
  phase: number
  amp: number
  t: number
}

// hero eyeballs ride these tentacles (index into the specs array below)
const HERO_DEFS = [
  { tent: 0, t: 0.34, scale: 1.15 }, // center trunk
  { tent: 2, t: 0.42, scale: 0.9 }, // big right-side curl
  { tent: 8, t: 0.5, scale: 1.0 }, // mirrored left mid tentacle
]

// module-scope scratch (never allocated per-frame)
const _disp = new THREE.Vector3()
const _hp = new THREE.Vector3()
const _sv = new THREE.Vector3()
const _lk = new THREE.Vector3()
const _m4 = new THREE.Matrix4()

/** CPU mirror of the vertex-shader undulation, so hero eyeballs don't drift. */
function dispInto(out: THREE.Vector3, a: HeroAnchor, ph: number, amp: number, droop: number): void {
  const t = a.t
  const env = t * t
  const cs = THREE.MathUtils.clamp((t - CURL_T0) * CURL_K, 0, 1)
  const envC = cs * cs * (3 - 2 * cs)
  const A = a.amp * amp
  const w1 = Math.sin(ph + a.phase + t * FREQ_A)
  const w2 = Math.cos(ph * SPD_B + a.phase * PH_B + t * FREQ_B)
  const w3 = Math.sin(ph * SPD_C + a.phase * PH_C + t * FREQ_C)
  const wa = Math.sin(ph * SLOW_A + a.phase * 3.1 + t * SLOW_FREQ_A)
  const wb = Math.cos(ph * SLOW_B + a.phase * 2.2 + t * SLOW_FREQ_B)
  const pump = 0.7 + 0.5 * Math.sin(ph * PUMP_F + a.phase * PUMP_PH)
  out.copy(a.swayA).multiplyScalar(A * (w1 * env + SLOW_AMP_A * wa * t))
  out.addScaledVector(a.swayB, A * (w2 * env * MIX_B + w3 * envC * MIX_C * pump + SLOW_AMP_B * wb * t))
  out.y -= a.amp * droop * (DROOP_A * env * env + DROOP_B * env)
}

// ── public rig ───────────────────────────────────────────────────────────────

export interface TentaclesRig {
  group: THREE.Group
  /**
   * Per-frame update (call from the boss frame pass in every phase).
   * `t` = world.time (frozen while paused → tentacles freeze too),
   * `dyingT` = seconds since the death sequence started, or -1.
   */
  update: (
    t: number, mode: AgiState['mode'], dyingT: number,
    playerPos: THREE.Vector3, headPos: THREE.Vector3,
  ) => void
  /** Snap mood-smoothed uniforms back to the idle pose (run restart). */
  reset: () => void
}

export function buildTentacles(): TentaclesRig {
  const specs: TentSpec[] = [CENTER_SPEC, ...RIGHT_SPECS, ...RIGHT_SPECS.map(mirrorSpec)]

  // ── shared uniforms (single value objects used by both materials) ─────────
  const uni = {
    uTentPh: { value: 0 }, // CPU-integrated phase (so speed lerps never pop)
    uTentT: { value: 0 },
    uTentAmp: { value: MOODS.waves.amp },
    uTentDroop: { value: MOODS.waves.droop },
    uTentEyeOpen: { value: MOODS.waves.eye },
    uTentLook: { value: new THREE.Vector3(0, -0.4, 1).normalize() },
  }

  // ── build the merged tentacle geometry ────────────────────────────────────
  const pos: number[] = []
  const nrm: number[] = []
  const uvs: number[] = []
  const rad: number[] = []
  const info: number[] = []
  const info2: number[] = []
  const swA: number[] = []
  const swB: number[] = []
  const idx: number[] = []
  const tents: TentData[] = []

  const FRONT = new THREE.Vector3(0, 0, 1)
  const bq = new THREE.Quaternion()
  const bd = new THREE.Vector3()
  const bT = new THREE.Vector3()
  const bS = new THREE.Vector3()
  const bP = new THREE.Vector3()
  const bf = new THREE.Vector3()
  const br = new THREE.Vector3()
  const bn = new THREE.Vector3()

  let vertCount = 0
  specs.forEach((spec, ti) => {
    const rings = Math.max(16, Math.min(26, Math.round(spec.len)))
    const radial = spec.baseR >= 1.5 ? 12 : spec.baseR >= 1.0 ? 10 : 8
    const plane = new THREE.Vector3(...spec.plane).normalize()
    const dir0 = new THREE.Vector3(...spec.dir).normalize()
    const ds = spec.len / (rings - 1)

    // spine: integrate a direction that rotates in the curl plane (more near
    // the tip) — thick base rises straight, tip hooks outward
    const spine: THREE.Vector3[] = [new THREE.Vector3(...spec.base)]
    for (let i = 1; i < rings; i++) {
      const tm = (i - 0.5) / (rings - 1)
      const ang = spec.curl * (0.25 * tm + 0.75 * tm * tm * tm) // straight trunk, hooked tip
      bd.copy(dir0).applyQuaternion(bq.setFromAxisAngle(plane, ang))
      spine.push(spine[i - 1].clone().addScaledVector(bd, ds))
    }
    // wide through most of the length (meaty trunk), narrowing at the curled
    // tip; slight flare where it roots into the torso
    const radii: number[] = []
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1)
      const s = THREE.MathUtils.smoothstep(t, 0.35, 1)
      const flare = 1 + 0.25 * (1 - t) * (1 - t)
      radii.push(Math.max(0.05, spec.baseR * (1 - 0.88 * s * s) * flare))
    }
    // per-tentacle orthonormal sway basis (constant; matches the CPU mirror)
    const D = spine[rings - 1].clone().sub(spine[0]).normalize()
    const swayA = new THREE.Vector3().crossVectors(plane, D).normalize()
    const swayB = new THREE.Vector3().crossVectors(D, swayA).normalize()
    const phase = ti * 2.3999
    const amp = spec.len * 0.14
    tents.push({ spine, radii, swayA, swayB, phase, amp })

    const vertBase = vertCount
    let prevFront = 0
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1)
      bT.copy(spine[Math.min(i + 1, rings - 1)]).sub(spine[Math.max(i - 1, 0)]).normalize()
      bS.crossVectors(plane, bT)
      if (bS.lengthSq() < 1e-6) bS.copy(swayA)
      else bS.normalize()
      bP.crossVectors(bT, bS).normalize()
      const slope = i < rings - 1 ? (radii[i + 1] - radii[i]) / ds : (radii[i] - radii[i - 1]) / ds
      // keep u=0.5 facing the arena (+z) so authored eye spots face the player
      bf.copy(FRONT).addScaledVector(bT, -FRONT.dot(bT))
      const front = bf.lengthSq() < 0.04 ? prevFront : Math.atan2(bf.dot(bP), bf.dot(bS))
      prevFront = front
      for (let c = 0; c <= radial; c++) {
        const u = c / radial
        const aW = front + (u - 0.5) * Math.PI * 2
        br.copy(bS).multiplyScalar(Math.cos(aW)).addScaledVector(bP, Math.sin(aW))
        pos.push(
          spine[i].x + br.x * radii[i],
          spine[i].y + br.y * radii[i],
          spine[i].z + br.z * radii[i],
        )
        bn.copy(br).addScaledVector(bT, -slope).normalize()
        nrm.push(bn.x, bn.y, bn.z)
        uvs.push(u, t)
        rad.push(radii[i])
        info.push(phase, ti, amp, spec.len)
        info2.push(spec.baseR, spec.eyes)
        swA.push(swayA.x, swayA.y, swayA.z)
        swB.push(swayB.x, swayB.y, swayB.z)
        vertCount++
      }
    }
    // apex point closing the tip
    bT.copy(spine[rings - 1]).sub(spine[rings - 2]).normalize()
    pos.push(
      spine[rings - 1].x + bT.x * radii[rings - 1] * 2.2,
      spine[rings - 1].y + bT.y * radii[rings - 1] * 2.2,
      spine[rings - 1].z + bT.z * radii[rings - 1] * 2.2,
    )
    nrm.push(bT.x, bT.y, bT.z)
    uvs.push(0.5, 1)
    rad.push(0.03)
    info.push(phase, ti, amp, spec.len)
    info2.push(spec.baseR, spec.eyes)
    swA.push(swayA.x, swayA.y, swayA.z)
    swB.push(swayB.x, swayB.y, swayB.z)
    const apex = vertCount
    vertCount++

    for (let i = 0; i < rings - 1; i++) {
      for (let c = 0; c < radial; c++) {
        const a = vertBase + i * (radial + 1) + c
        const b = a + 1
        const c2 = a + radial + 1
        const d2 = c2 + 1
        idx.push(a, c2, b, b, c2, d2)
      }
    }
    const lr = vertBase + (rings - 1) * (radial + 1)
    for (let c = 0; c < radial; c++) idx.push(lr + c, apex, lr + c + 1)
  })

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setAttribute('aTentRad', new THREE.Float32BufferAttribute(rad, 1))
  geo.setAttribute('aTentInfo', new THREE.Float32BufferAttribute(info, 4))
  geo.setAttribute('aTentInfo2', new THREE.Float32BufferAttribute(info2, 2))
  geo.setAttribute('aTentSwayA', new THREE.Float32BufferAttribute(swA, 3))
  geo.setAttribute('aTentSwayB', new THREE.Float32BufferAttribute(swB, 3))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  if (geo.boundingSphere) geo.boundingSphere.radius += 15 // sway + droop headroom

  const tentMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, // albedo authored in the fragment shader
    roughness: 0.45,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  tentMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uni)
    shader.vertexShader = TENT_VERT_DECL + shader.vertexShader
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', TENT_VERT_NORMAL)
      .replace('#include <begin_vertex>', TENT_VERT_TRANSFORM)
    shader.fragmentShader = TENT_FRAG_DECL + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', TENT_FRAG_SURFACE)
      .replace('#include <roughnessmap_fragment>', TENT_FRAG_ROUGH)
      .replace('#include <emissivemap_fragment>', TENT_FRAG_EMISSIVE)
  }
  tentMat.customProgramCacheKey = () => 'agi-tentacles'

  const tentMesh = new THREE.Mesh(geo, tentMat)
  tentMesh.castShadow = false
  tentMesh.receiveShadow = false

  // ── hero eyeballs: 3 instanced spheres on stalks ──────────────────────────
  const sphere = new THREE.SphereGeometry(1, 14, 10)
  const stalk = new THREE.CylinderGeometry(0.3, 0.62, 1.4, 8)
  stalk.translate(0, -1.35, 0)
  const heroGeo = mergeGeometries([sphere.toNonIndexed(), stalk.toNonIndexed()], false) ?? sphere.toNonIndexed()
  heroGeo.setAttribute('aHeroSeed', new THREE.InstancedBufferAttribute(new Float32Array([0.37, 3.91, 7.53]), 1))

  const heroMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0 })
  heroMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uni)
    shader.vertexShader = HERO_VERT_DECL + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', HERO_VERT_TRANSFORM)
    shader.fragmentShader = HERO_FRAG_DECL + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', HERO_FRAG_SURFACE)
      .replace('#include <roughnessmap_fragment>', HERO_FRAG_ROUGH)
      .replace('#include <emissivemap_fragment>', HERO_FRAG_EMISSIVE)
  }
  heroMat.customProgramCacheKey = () => 'agi-hero-eye'

  const heroMesh = new THREE.InstancedMesh(heroGeo, heroMat, HERO_DEFS.length)
  heroMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  heroMesh.castShadow = false
  heroMesh.receiveShadow = false
  heroMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 30, -70), 32)

  const anchors: HeroAnchor[] = HERO_DEFS.map((def) => {
    const td = tents[def.tent]
    const ringIdx = Math.round(def.t * (td.spine.length - 1))
    const sign = Math.sign(td.spine[ringIdx].x) || 1
    const outward = new THREE.Vector3(sign * 0.35, 0.3, 1).normalize()
    return {
      rest: td.spine[ringIdx].clone().addScaledVector(outward, td.radii[ringIdx] + def.scale * 0.35),
      quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward),
      scale: def.scale,
      swayA: td.swayA,
      swayB: td.swayB,
      phase: td.phase,
      amp: td.amp,
      t: def.t,
    }
  })

  const group = new THREE.Group()
  group.add(tentMesh, heroMesh)

  // ── per-frame mood/uniform driving ────────────────────────────────────────
  const cur: Mood = { ...MOODS.waves }
  let ph = 0
  let lastT = 0

  function update(
    t: number, mode: AgiState['mode'], dyingT: number,
    playerPos: THREE.Vector3, headPos: THREE.Vector3,
  ): void {
    // world-clock delta: freezes with the pause menu, self-heals on rewinds
    const dtw = THREE.MathUtils.clamp(t - lastT, 0, 0.05)
    lastT = t
    let target = MOODS[mode]
    if (mode === 'dying' && dyingT >= 1.15) target = LIMP // thrash → hang limp
    const k = 1 - Math.exp(-(mode === 'dying' ? 6 : 2.8) * dtw)
    cur.amp += (target.amp - cur.amp) * k
    cur.speed += (target.speed - cur.speed) * k
    cur.droop += (target.droop - cur.droop) * k
    cur.eye += (target.eye - cur.eye) * k
    ph += cur.speed * dtw
    uni.uTentPh.value = ph
    uni.uTentT.value = t
    uni.uTentAmp.value = cur.amp
    uni.uTentDroop.value = cur.droop
    uni.uTentEyeOpen.value = cur.eye
    // eye look direction: boss → player (ancestors only translate, so
    // boss-local directions equal world directions)
    _lk.copy(playerPos)
    _lk.y += 1.5
    _lk.sub(headPos)
    const l2 = _lk.lengthSq()
    if (l2 > 1e-6) {
      _lk.multiplyScalar(1 / Math.sqrt(l2))
      const cv = uni.uTentLook.value
      cv.lerp(_lk, 1 - Math.exp(-6 * dtw))
      const c2 = cv.lengthSq()
      if (c2 > 1e-6) cv.multiplyScalar(1 / Math.sqrt(c2))
      else cv.copy(_lk)
    }
    // hero eyeballs replicate their host surface's undulation on the CPU
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]
      dispInto(_disp, a, ph, cur.amp, cur.droop)
      _hp.copy(a.rest).add(_disp)
      _m4.compose(_hp, a.quat, _sv.setScalar(a.scale))
      heroMesh.setMatrixAt(i, _m4)
    }
    heroMesh.instanceMatrix.needsUpdate = true
  }

  function reset(): void {
    cur.amp = MOODS.waves.amp
    cur.speed = MOODS.waves.speed
    cur.droop = MOODS.waves.droop
    cur.eye = MOODS.waves.eye
    lastT = 0
  }

  return { group, update, reset }
}
