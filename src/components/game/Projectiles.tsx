'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  FIRE_DPS, FIRE_DURATION, FRAME_PRIO, GRAVITY, MOLOTOV_DAMAGE, PLAYER_RADIUS,
} from '@/game/constants'
import { events } from '@/game/events'
import { darkMetalMaterial } from '@/game/gfx/materials'
import { simRunning, useGame } from '@/game/store'
import type { Projectile } from '@/game/types'
import { world, type PlayerState } from '@/game/world'

// ─────────────────────────────────────────────────────────────────────────────
// Projectiles — simulation of world.projectiles (rangerBolt/bossBolt/molotov/
// rocket), central telegraph resolution at tHit, hazard damage-over-time, and
// instanced rendering of every projectile kind. Telegraph decals / fire / beams
// / explosions are rendered by Vfx — this module renders ONLY projectiles.
// ─────────────────────────────────────────────────────────────────────────────

// Pools / tuning (visual-only; gameplay numbers come from constants/stats)
const MAX_RANGER = 160
const MAX_BOSS = 224
const MAX_MOLOTOV = 10
const MAX_ROCKET = 48
const SMOKE_POOL = 288
const SMOKE_LIFE = 0.7 // seconds a rocket smoke puff lives
const SMOKE_INTERVAL = 0.055 // one puff per rocket per tick
const TELEGRAPH_LINGER = 0.3 // keep resolved telegraphs around so Vfx can flash them
const PLAYER_CAPSULE_HEIGHT = 2.0 // bolt-vs-player vertical span above feet
const JUMP_CLEAR_Y = 1.1 // feet height that clears dodgeableByJump telegraphs
const RANGER_HALF_LEN = 0.85 // capsule geometry spans y∈[-1,1] → world length 1.7
const BOSS_HALF_LEN = 1.2

// Module-scope scratch — never allocate in hot loops
const _prev = new THREE.Vector3()
const _delta = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _v = new THREE.Vector3()
const _ground = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _scale = new THREE.Vector3()
const _m4 = new THREE.Matrix4()
const UP = new THREE.Vector3(0, 1, 0)
const IDENTITY_Q = new THREE.Quaternion()
const ONE = new THREE.Vector3(1, 1, 1)

// Module-local sim state (hard-reset on runId change)
let smokeAcc = 0
let smokeHead = 0
let lastPuffTime = -1e4 // world.time of the most recent rocket smoke puff
let frozenSynced = false // instance buffers already synced since the sim froze

// ─── Shaders ─────────────────────────────────────────────────────────────────

// Glowing bolt streak: hot core at the head fading to a colored tail, soft
// fresnel edge. HDR output (>1) so the bloom pass picks it up.
const BOLT_VERT = /* glsl */ `
varying float vY;
varying float vFacing;
void main() {
  vY = position.y; // capsule local y ∈ [-1, 1]; +y = travel direction
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
  vFacing = clamp(dot(n, normalize(-mvPosition.xyz)), 0.0, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}`

const BOLT_FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uTail;
uniform float uIntensity;
varying float vY;
varying float vFacing;
void main() {
  float head = smoothstep(-1.0, 0.75, vY);
  vec3 col = mix(uTail, uCore, head);
  float soft = smoothstep(0.03, 0.62, vFacing);
  float tailFade = smoothstep(-1.0, -0.3, vY);
  float a = soft * mix(0.22, 1.0, tailFade);
  gl_FragColor = vec4(col * uIntensity * (0.55 + 0.45 * head), a);
}`

// Billboarded procedural flame for the lit molotov rag — fully shader-drawn
// (teardrop SDF + wobble + streaks), flickers per instance via aSeed.
const FLAME_VERT = /* glsl */ `
uniform float uTime;
attribute float aSeed;
varying vec2 vUv;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float fl = 1.0 + 0.14 * sin(uTime * 21.0 + aSeed * 17.0) + 0.08 * sin(uTime * 47.0 + aSeed * 29.0);
  mv.xy += position.xy * fl;
  gl_Position = projectionMatrix * mv;
}`

const FLAME_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vSeed;
void main() {
  float y = clamp(vUv.y, 0.0, 1.0);
  float wob = 0.06 * sin(uTime * 13.0 + vSeed * 11.0 + y * 9.0) * y
            + 0.03 * sin(uTime * 29.0 + y * 17.0 + vSeed);
  float x = vUv.x - 0.5 + wob;
  float w = 0.30 * (1.0 - y) * (0.35 + 0.65 * smoothstep(0.0, 0.25, y));
  float body = smoothstep(w, w * 0.35, abs(x));
  float a = body * smoothstep(1.02, 0.72, y) * smoothstep(0.0, 0.06, y);
  float streak = 0.5 + 0.5 * sin(y * 22.0 - uTime * 9.0 + vSeed);
  a *= 0.75 + 0.25 * streak;
  float core = smoothstep(w * 0.8, 0.0, abs(x)) * smoothstep(0.9, 0.15, y);
  vec3 col = mix(vec3(1.0, 0.33, 0.05), vec3(1.0, 0.82, 0.32), core);
  col = mix(col, vec3(1.0, 0.97, 0.82), core * core * 0.8);
  gl_FragColor = vec4(col * 2.6, a);
}`

// Rocket engine exhaust cone: brightest at the nozzle, flickering length.
const GLOW_VERT = /* glsl */ `
uniform float uTime;
attribute float aSeed;
varying float vT;
varying float vFacing;
void main() {
  float fl = 1.0 + 0.22 * sin(uTime * 31.0 + aSeed * 13.7) + 0.1 * sin(uTime * 57.0 + aSeed * 7.3);
  vec3 pos = position;
  pos.y *= fl;
  pos.xz *= 0.82 + 0.24 * fl;
  vT = clamp(position.y / 0.45 * 0.5 + 0.5, 0.0, 1.0); // 0 nozzle → 1 trailing tip
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
  vec3 n = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
  vFacing = abs(dot(n, normalize(-mvPosition.xyz)));
  gl_Position = projectionMatrix * mvPosition;
}`

const GLOW_FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uTail;
uniform float uIntensity;
varying float vT;
varying float vFacing;
void main() {
  vec3 col = mix(uCore, uTail, vT);
  float a = pow(max(1.0 - vT, 1e-5), 1.6) * smoothstep(0.0, 0.45, vFacing);
  gl_FragColor = vec4(col * uIntensity, a);
}`

// Rocket smoke trail: pooled billboards aged entirely on the GPU from a birth
// timestamp — zero per-frame CPU cost for live puffs.
const SMOKE_VERT = /* glsl */ `
uniform float uTime;
attribute float aBirth;
attribute float aSeed;
varying vec2 vUv;
varying float vAge;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = aSeed;
  float age = uTime - aBirth;
  float n = clamp(age / SMOKE_LIFE, 0.0, 1.0);
  float alive = step(0.0001, age) * (1.0 - step(SMOKE_LIFE, age));
  vAge = n;
  vec3 wp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  wp.y += n * 0.7;
  wp.x += sin(aSeed * 39.0) * n * 0.3;
  wp.z += cos(aSeed * 27.0) * n * 0.3;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float s = mix(0.4, 1.7, pow(max(n, 1e-5), 0.65)) * alive;
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
}`

const SMOKE_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAge;
varying float vSeed;
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d);
  float edge = smoothstep(0.5, 0.16, r);
  float ang = atan(d.y, d.x);
  float lump = 0.85 + 0.15 * sin(ang * 5.0 + vSeed * 31.0) * smoothstep(0.12, 0.5, r);
  float a = edge * lump * (1.0 - vAge) * 0.42;
  vec3 col = mix(vec3(0.46, 0.43, 0.40), vec3(0.15, 0.145, 0.14), vAge);
  gl_FragColor = vec4(col, a);
}`

// ─── Shared geometry / materials / meshes (lazy client-side singleton) ───────

interface Shared {
  ranger: THREE.InstancedMesh
  boss: THREE.InstancedMesh
  molotov: THREE.InstancedMesh
  flame: THREE.InstancedMesh
  rocket: THREE.InstancedMesh
  glow: THREE.InstancedMesh
  smoke: THREE.InstancedMesh
  flameSeed: THREE.InstancedBufferAttribute
  glowSeed: THREE.InstancedBufferAttribute
  smokeBirth: THREE.InstancedBufferAttribute
  smokeSeed: THREE.InstancedBufferAttribute
  flameMat: THREE.ShaderMaterial
  glowMat: THREE.ShaderMaterial
  smokeMat: THREE.ShaderMaterial
}

let shared: Shared | null = null

function boltMaterial(core: THREE.ColorRepresentation, tail: THREE.ColorRepresentation, intensity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: new THREE.Color(core) },
      uTail: { value: new THREE.Color(tail) },
      uIntensity: { value: intensity },
    },
    vertexShader: BOLT_VERT,
    fragmentShader: BOLT_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
}

function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, max: number, name: string): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, max)
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  m.count = 0
  m.frustumCulled = false
  m.name = name
  return m
}

/** Flag an instanced attribute for upload of only its live span (not the whole
 *  pool buffer) — the renderer clears the range after the copy. */
function rangeUpload(attr: THREE.InstancedBufferAttribute, count: number): void {
  attr.clearUpdateRanges()
  attr.addUpdateRange(0, count)
  attr.needsUpdate = true
}

/** Merged rocket body: tapered hull + red warhead + nozzle ring + 4 fins, one draw call. */
function buildRocketGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.16, 0.2, 1.0, 10)
  const nose = new THREE.ConeGeometry(0.165, 0.4, 10)
  nose.translate(0, 0.7, 0)
  const nozzle = new THREE.CylinderGeometry(0.11, 0.155, 0.16, 10)
  nozzle.translate(0, -0.56, 0)
  const parts: THREE.BufferGeometry[] = [body, nose, nozzle]
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.BoxGeometry(0.035, 0.36, 0.24)
    fin.translate(0, -0.4, 0.27)
    fin.rotateY((k * Math.PI) / 2)
    parts.push(fin)
  }
  const merged = mergeGeometries(parts)!
  // vertex colors: red-painted warhead (part index 1), bare dark metal elsewhere
  const counts = parts.map((g) => g.attributes.position.count)
  const total = merged.attributes.position.count
  const colors = new Float32Array(total * 3)
  let o = 0
  parts.forEach((g, idx) => {
    const c = idx === 1 ? [1.45, 0.4, 0.36] : [1, 1, 1]
    for (let i = 0; i < counts[idx]; i++) {
      colors[(o + i) * 3] = c[0]
      colors[(o + i) * 3 + 1] = c[1]
      colors[(o + i) * 3 + 2] = c[2]
    }
    o += counts[idx]
  })
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  parts.forEach((g) => g.dispose())
  return merged
}

/** Lathe-profiled molotov bottle, centered on its tumble pivot. */
function buildBottleGeometry(): THREE.BufferGeometry {
  const profile = [
    new THREE.Vector2(0.001, 0),
    new THREE.Vector2(0.07, 0.006),
    new THREE.Vector2(0.082, 0.03),
    new THREE.Vector2(0.086, 0.16),
    new THREE.Vector2(0.075, 0.21),
    new THREE.Vector2(0.04, 0.255),
    new THREE.Vector2(0.03, 0.27),
    new THREE.Vector2(0.028, 0.33),
    new THREE.Vector2(0.034, 0.34),
    new THREE.Vector2(0.034, 0.35),
    new THREE.Vector2(0.001, 0.35),
  ]
  const geo = new THREE.LatheGeometry(profile, 14)
  geo.translate(0, -0.17, 0)
  return geo
}

function getShared(): Shared {
  if (shared) return shared

  // bolts — capsule spans y∈[-1,1], stretched along velocity via instance scale
  const boltGeo = new THREE.CapsuleGeometry(0.5, 1, 5, 12)
  const ranger = makeInstanced(boltGeo, boltMaterial(0xffa0d8, 0xff1d6e, 3.2), MAX_RANGER, 'rangerBolts')
  const boss = makeInstanced(boltGeo, boltMaterial(0xfff3cf, 0xff7212, 3.6), MAX_BOSS, 'bossBolts')
  ranger.renderOrder = 2
  boss.renderOrder = 2

  // molotov — glassy bottle + procedural flame billboard
  const bottleMat = new THREE.MeshStandardMaterial({
    color: 0x4a6b33, roughness: 0.14, metalness: 0.0,
    transparent: true, opacity: 0.92,
    emissive: new THREE.Color(0xff8524), emissiveIntensity: 0.3,
  })
  const molotov = makeInstanced(buildBottleGeometry(), bottleMat, MAX_MOLOTOV, 'molotovs')
  molotov.castShadow = true

  const flameGeo = new THREE.PlaneGeometry(0.6, 0.85)
  flameGeo.translate(0, 0.36, 0)
  const flameSeed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MOLOTOV), 1)
  flameSeed.setUsage(THREE.DynamicDrawUsage)
  flameGeo.setAttribute('aSeed', flameSeed)
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const flame = makeInstanced(flameGeo, flameMat, MAX_MOLOTOV, 'molotovFlames')
  flame.renderOrder = 3

  // rocket — merged finned hull (vertex-colored warhead) + exhaust cone
  const rocketMat = darkMetalMaterial().clone() // clone: shared materials must not be mutated
  rocketMat.vertexColors = true
  const rocket = makeInstanced(buildRocketGeometry(), rocketMat, MAX_ROCKET, 'rockets')
  rocket.castShadow = true

  const glowGeo = new THREE.ConeGeometry(0.18, 0.9, 12, 1, true)
  const glowSeed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ROCKET), 1)
  glowSeed.setUsage(THREE.DynamicDrawUsage)
  glowGeo.setAttribute('aSeed', glowSeed)
  const glowMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCore: { value: new THREE.Color(0xffe9b8) },
      uTail: { value: new THREE.Color(0xff5a10) },
      uIntensity: { value: 3.0 },
    },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const glow = makeInstanced(glowGeo, glowMat, MAX_ROCKET, 'rocketGlows')
  glow.renderOrder = 2

  // smoke trail pool — GPU-aged billboards
  const smokeGeo = new THREE.PlaneGeometry(1, 1)
  const smokeBirth = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_POOL).fill(-1e4), 1)
  const smokeSeed = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_POOL), 1)
  smokeBirth.setUsage(THREE.DynamicDrawUsage)
  smokeSeed.setUsage(THREE.DynamicDrawUsage)
  smokeGeo.setAttribute('aBirth', smokeBirth)
  smokeGeo.setAttribute('aSeed', smokeSeed)
  const smokeMat = new THREE.ShaderMaterial({
    defines: { SMOKE_LIFE: SMOKE_LIFE.toFixed(3) },
    uniforms: { uTime: { value: 0 } },
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    transparent: true,
    depthWrite: false,
  })
  const smoke = makeInstanced(smokeGeo, smokeMat, SMOKE_POOL, 'rocketSmoke')
  // count is raised to SMOKE_POOL only while puffs can be alive (frameProjectiles);
  // dead puffs inside that window are collapsed by the shader
  smoke.count = 0
  smoke.renderOrder = 1

  shared = {
    ranger, boss, molotov, flame, rocket, glow, smoke,
    flameSeed, glowSeed, smokeBirth, smokeSeed,
    flameMat, glowMat, smokeMat,
  }
  return shared
}

function hardReset(sh: Shared): void {
  smokeAcc = 0
  smokeHead = 0
  lastPuffTime = -1e4
  frozenSynced = false
  ;(sh.smokeBirth.array as Float32Array).fill(-1e4)
  sh.smokeBirth.clearUpdateRanges() // drop stale per-slot ranges → full upload
  sh.smokeBirth.needsUpdate = true
  sh.smoke.count = 0
  sh.ranger.count = 0
  sh.boss.count = 0
  sh.molotov.count = 0
  sh.flame.count = 0
  sh.rocket.count = 0
  sh.glow.count = 0
}

// ─── Simulation (FRAME_PRIO.projectiles) ─────────────────────────────────────

/** Bolt vs obstacles along this frame's travel segment, then vs player capsule. */
function boltStep(p: Projectile, pl: PlayerState): boolean {
  if (p.pos.y < -0.2) return true
  _delta.copy(p.pos).sub(_prev)
  const dist = _delta.length()
  if (dist > 1e-6) {
    _dir.copy(_delta).divideScalar(dist)
    if (world.raycastObstacles(_prev, _dir, dist)) return true
  }
  // closest point on the XZ travel segment to the player
  const abx = _delta.x, abz = _delta.z
  const len2 = abx * abx + abz * abz
  const apx = pl.pos.x - _prev.x, apz = pl.pos.z - _prev.z
  const t = len2 < 1e-8 ? 0 : THREE.MathUtils.clamp((apx * abx + apz * abz) / len2, 0, 1)
  const cx = _prev.x + abx * t - pl.pos.x
  const cz = _prev.z + abz * t - pl.pos.z
  const rr = p.radius + PLAYER_RADIUS
  if (cx * cx + cz * cz <= rr * rr) {
    const by = _prev.y + _delta.y * t
    if (by >= pl.pos.y - 0.1 && by <= pl.pos.y + PLAYER_CAPSULE_HEIGHT) {
      world.damagePlayer(p.damage)
      return true
    }
  }
  return false
}

function detonateMolotov(p: Projectile): void {
  const stats = useGame.getState().stats
  const radius = stats.molotovRadius
  const victims = world.enemiesInCircle(p.pos, radius)
  for (const e of victims) world.damageEnemy(e.id, MOLOTOV_DAMAGE)
  // boss splash counts only when the blast actually reaches a resting/lingering
  // hand — the bare vulnerable flag let arena-wide detonations chip the boss
  const hand = world.agi.punchHands.find((h) => h.hpLeft > 0 && p.pos.distanceTo(h.pos) <= radius + h.radius)
  if (hand) world.damageBoss(MOLOTOV_DAMAGE, hand.pos)
  _ground.set(p.pos.x, 0, p.pos.z)
  world.addHazard({
    kind: 'fire',
    pos: _ground.clone(),
    radius: radius * 0.85,
    until: world.time + FIRE_DURATION,
    dps: FIRE_DPS * stats.fireDpsMult,
    playerFire: true,
  })
  events.emit('explosion', { pos: p.pos, radius, kind: 'molotov' })
  events.emit('fireIgnite', { pos: _ground, radius })
}

function molotovStep(p: Projectile): boolean {
  _delta.copy(p.pos).sub(_prev)
  const dist = _delta.length()
  if (dist > 1e-6) {
    _dir.copy(_delta).divideScalar(dist)
    const hit = world.raycastObstacles(_prev, _dir, dist)
    if (hit) {
      p.pos.copy(hit.point)
      detonateMolotov(p)
      return true
    }
  }
  if (p.pos.y <= 0.15) {
    detonateMolotov(p)
    return true
  }
  for (const e of world.enemies.values()) {
    if (e.hp <= 0 || e.falling) continue
    const dx = p.pos.x - e.pos.x
    const dz = p.pos.z - e.pos.z
    const rr = 0.4 + e.radius
    if (dx * dx + dz * dz < rr * rr && p.pos.y >= e.pos.y - 0.1 && p.pos.y <= e.pos.y + e.height + 0.3) {
      detonateMolotov(p)
      return true
    }
  }
  return false
}

function spawnPuff(sh: Shared, p: Projectile): void {
  _dir.copy(p.vel)
  const len = _dir.length()
  if (len > 1e-4) _dir.divideScalar(len)
  else _dir.set(0, 1, 0)
  _v.copy(p.pos).addScaledVector(_dir, -1.0)
  _v.x += (Math.random() - 0.5) * 0.14
  _v.y += (Math.random() - 0.5) * 0.14
  _v.z += (Math.random() - 0.5) * 0.14
  const i = smokeHead
  smokeHead = (smokeHead + 1) % SMOKE_POOL
  _m4.compose(_v, IDENTITY_Q, ONE)
  sh.smoke.setMatrixAt(i, _m4)
  ;(sh.smokeBirth.array as Float32Array)[i] = world.time
  ;(sh.smokeSeed.array as Float32Array)[i] = Math.random() * 100
  // upload only the touched slot; same-frame puffs accumulate ranges and the
  // renderer merges + clears them after the copy
  sh.smoke.instanceMatrix.addUpdateRange(i * 16, 16)
  sh.smoke.instanceMatrix.needsUpdate = true
  sh.smokeBirth.addUpdateRange(i, 1)
  sh.smokeBirth.needsUpdate = true
  sh.smokeSeed.addUpdateRange(i, 1)
  sh.smokeSeed.needsUpdate = true
  lastPuffTime = world.time
}

function simulate(step: number, sh: Shared): void {
  smokeAcc += step
  let emitPuffs = false
  if (smokeAcc >= SMOKE_INTERVAL) {
    smokeAcc %= SMOKE_INTERVAL
    emitPuffs = true
  }
  const pl = world.player
  const arr = world.projectiles
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i]
    _prev.copy(p.pos)
    if (p.gravityScale !== 0) p.vel.y -= GRAVITY * p.gravityScale * step
    p.pos.addScaledVector(p.vel, step)
    p.ttl -= step

    let remove = false
    if (p.ttl <= 0) remove = true
    else if (p.kind === 'rangerBolt' || p.kind === 'bossBolt') remove = boltStep(p, pl)
    else if (p.kind === 'molotov') remove = molotovStep(p)
    else {
      // rocket: purely visual — its telegraph resolves the boom
      if (p.pos.y <= 0.25) remove = true
      else if (emitPuffs) spawnPuff(sh, p)
    }
    if (remove) {
      arr[i] = arr[arr.length - 1]
      arr.pop()
    }
  }
}

// ─── Telegraph resolution + hazard tick (FRAME_PRIO.hazards) ─────────────────

function resolveTelegraphs(): void {
  const tgs = world.telegraphs
  for (let i = tgs.length - 1; i >= 0; i--) {
    const tg = tgs[i]
    if (!tg.resolved && world.time >= tg.tHit) {
      tg.resolved = true
      const pay = tg.payload
      if (!pay.visualOnly) {
        let hit = tg.shape === 'circle'
          ? world.playerInCircle(tg.pos, tg.radius)
          : world.playerInRect(tg.pos, tg.yaw, tg.w, tg.l)
        if (pay.dodgeableByJump && world.player.pos.y > JUMP_CLEAR_Y) hit = false
        if (hit) {
          if (pay.instakill) world.damagePlayer(0, { instakill: true })
          // beam payloads deliver damage via the spawned wall's DoT — applying
          // it here too double-dipped (stripes hit for 70 instead of 35)
          else if (!pay.beam) world.damagePlayer(pay.damage)
        }
        if (pay.explosion) {
          events.emit('explosion', {
            pos: tg.pos.clone(),
            radius: tg.shape === 'circle' ? tg.radius : 3,
            kind: pay.tag === 'rocket' ? 'rocket' : 'punch',
          })
        }
        if (pay.beam) {
          const sin = Math.sin(tg.yaw)
          const cos = Math.cos(tg.yaw)
          const hl = tg.l / 2
          world.addHazard({
            kind: 'beam',
            a: new THREE.Vector3(tg.pos.x + sin * hl, 0, tg.pos.z + cos * hl),
            b: new THREE.Vector3(tg.pos.x - sin * hl, 0, tg.pos.z - cos * hl),
            width: tg.w,
            height: pay.beam.height,
            until: world.time + pay.beam.duration,
            dps: pay.instakill ? 0 : pay.damage / pay.beam.duration,
            instakill: pay.instakill,
          })
        }
      }
    }
    // keep resolved telegraphs briefly so Vfx can flash them on resolve
    if (tg.resolved && world.time >= tg.tHit + TELEGRAPH_LINGER) tgs.splice(i, 1)
  }
}

function tickHazards(step: number): void {
  const hz = world.hazards
  const pl = world.player
  for (let i = hz.length - 1; i >= 0; i--) {
    const h = hz[i]
    if (world.time >= h.until) {
      hz[i] = hz[hz.length - 1]
      hz.pop()
      continue
    }
    if (h.kind === 'fire') {
      const pos = h.pos
      const radius = h.radius ?? 0
      if (!pos) continue
      if (h.playerFire) {
        // player-owned fire cooks enemies only (inline circle test — avoids
        // enemiesInCircle's per-frame array allocation in this hot loop)
        for (const e of world.enemies.values()) {
          if (e.hp <= 0 || e.falling) continue // ground fire can't cook mid-air drops
          if (Math.abs(e.pos.y - pos.y) > radius + e.height) continue // …or hovering drones
          const dx = e.pos.x - pos.x
          const dz = e.pos.z - pos.z
          const rr = radius + e.radius
          if (dx * dx + dz * dz <= rr * rr) world.damageEnemy(e.id, h.dps * step, { dot: true })
        }
      } else if (world.playerInCircle(pos, radius)) {
        world.damagePlayer(h.dps * step)
      }
    } else {
      // beam wall
      const a = h.a
      const b = h.b
      if (!a || !b) continue
      const width = h.width ?? 0
      const height = h.height ?? Infinity
      if (world.distToSegmentXZ(pl.pos, a, b) < width / 2 + PLAYER_RADIUS && pl.pos.y < height) {
        if (h.instakill) world.damagePlayer(0, { instakill: true })
        else world.damagePlayer(h.dps * step, { ignoreIFrames: false })
      }
    }
  }
}

// ─── Render sync ─────────────────────────────────────────────────────────────

function writeBolt(mesh: THREE.InstancedMesh, i: number, p: Projectile, halfLen: number): void {
  _dir.copy(p.vel)
  const len = _dir.length()
  if (len > 1e-4) _dir.divideScalar(len)
  else _dir.set(0, 1, 0)
  _quat.setFromUnitVectors(UP, _dir)
  const r = Math.max(0.09, p.radius * 0.85)
  _scale.set(r * 2, halfLen, r * 2) // geometry radius 0.5, span 2 → world r / len
  _m4.compose(p.pos, _quat, _scale)
  mesh.setMatrixAt(i, _m4)
}

function syncRender(sh: Shared): void {
  let nRanger = 0
  let nBoss = 0
  let nMol = 0
  let nRocket = 0
  const t = world.time
  const flameSeeds = sh.flameSeed.array as Float32Array
  const glowSeeds = sh.glowSeed.array as Float32Array

  for (const p of world.projectiles) {
    if (p.kind === 'rangerBolt') {
      if (nRanger < MAX_RANGER) writeBolt(sh.ranger, nRanger++, p, RANGER_HALF_LEN)
    } else if (p.kind === 'bossBolt') {
      if (nBoss < MAX_BOSS) writeBolt(sh.boss, nBoss++, p, BOSS_HALF_LEN)
    } else if (p.kind === 'molotov') {
      if (nMol < MAX_MOLOTOV) {
        // tumble around a per-projectile phase
        _euler.set(t * 6.3 + p.id * 1.37, p.id * 2.11, t * 4.7 + p.id * 0.77)
        _quat.setFromEuler(_euler)
        _m4.compose(p.pos, _quat, ONE)
        sh.molotov.setMatrixAt(nMol, _m4)
        _v.set(p.pos.x, p.pos.y + 0.1, p.pos.z)
        _m4.compose(_v, IDENTITY_Q, ONE)
        sh.flame.setMatrixAt(nMol, _m4)
        flameSeeds[nMol] = (p.id % 89) * 0.61
        nMol++
      }
    } else if (nRocket < MAX_ROCKET) {
      _dir.copy(p.vel)
      const len = _dir.length()
      if (len > 1e-4) _dir.divideScalar(len)
      else _dir.set(0, 1, 0)
      _quat.setFromUnitVectors(UP, _dir)
      _m4.compose(p.pos, _quat, ONE)
      sh.rocket.setMatrixAt(nRocket, _m4)
      _v.copy(p.pos).addScaledVector(_dir, -0.85)
      _dir.negate()
      _quat.setFromUnitVectors(UP, _dir)
      _m4.compose(_v, _quat, ONE)
      sh.glow.setMatrixAt(nRocket, _m4)
      glowSeeds[nRocket] = (p.id % 113) * 0.53
      nRocket++
    }
  }

  sh.ranger.count = nRanger
  sh.boss.count = nBoss
  sh.molotov.count = nMol
  sh.flame.count = nMol
  sh.rocket.count = nRocket
  sh.glow.count = nRocket
  // flag uploads only for pools with live instances — idle pools (count 0)
  // draw nothing, so re-uploading their stale buffers every frame is waste —
  // and upload only the live span (update ranges), not the whole pool buffer
  if (nRanger > 0) rangeUpload(sh.ranger.instanceMatrix, nRanger * 16)
  if (nBoss > 0) rangeUpload(sh.boss.instanceMatrix, nBoss * 16)
  if (nMol > 0) {
    rangeUpload(sh.molotov.instanceMatrix, nMol * 16)
    rangeUpload(sh.flame.instanceMatrix, nMol * 16)
    rangeUpload(sh.flameSeed, nMol)
  }
  if (nRocket > 0) {
    rangeUpload(sh.rocket.instanceMatrix, nRocket * 16)
    rangeUpload(sh.glow.instanceMatrix, nRocket * 16)
    rangeUpload(sh.glowSeed, nRocket)
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Per-frame projectile pass (module-level so no component state is mutated). */
function frameProjectiles(elapsed: number, dt: number): void {
  const sh = getShared()
  const step = Math.min(dt, 0.05)
  const running = simRunning(useGame.getState().phase)
  if (running) simulate(step, sh)
  // sync every sim frame, plus once more when the sim freezes so projectiles
  // stay visible (frozen) during pauses without re-uploading unchanged buffers
  if (running || !frozenSynced) syncRender(sh)
  frozenSynced = !running
  // GPU-aged smoke pool: draw only up to the highest slot whose puff can still
  // be alive (mirrors the FirePatches nLive pattern) — dead puffs inside the
  // span are collapsed by the shader, slots above it skip vertex work entirely
  if (world.time - lastPuffTime < SMOKE_LIFE + 0.05) {
    const births = sh.smokeBirth.array as Float32Array
    const cutoff = world.time - SMOKE_LIFE - 0.05
    let n = SMOKE_POOL
    while (n > 0 && births[n - 1] <= cutoff) n--
    sh.smoke.count = n
  } else {
    sh.smoke.count = 0
  }
  sh.flameMat.uniforms.uTime.value = elapsed
  sh.glowMat.uniforms.uTime.value = elapsed
  sh.smokeMat.uniforms.uTime.value = world.time
}

/** Per-frame hazards pass: central telegraph resolution + damage-over-time. */
function frameHazards(dt: number): void {
  const step = Math.min(dt, 0.05)
  if (!simRunning(useGame.getState().phase)) return
  resolveTelegraphs()
  tickHazards(step)
}

function subscribeReset(): () => void {
  hardReset(getShared())
  return useGame.subscribe((s, prev) => {
    if (s.runId !== prev.runId) hardReset(getShared())
  })
}

export function Projectiles() {
  const sh = getShared() // lazy cached singleton; stable across renders

  useEffect(subscribeReset, [])

  useFrame((state, dt) => frameProjectiles(state.clock.elapsedTime, dt), FRAME_PRIO.projectiles)
  useFrame((_, dt) => frameHazards(dt), FRAME_PRIO.hazards)

  return (
    <group name="projectiles">
      <primitive object={sh.ranger} />
      <primitive object={sh.boss} />
      <primitive object={sh.molotov} />
      <primitive object={sh.flame} />
      <primitive object={sh.rocket} />
      <primitive object={sh.glow} />
      <primitive object={sh.smoke} />
    </group>
  )
}
