import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GRAVITY } from '@/game/constants'
import { darkMetalMaterial } from '@/game/gfx/materials'

// Ported from Projectiles.tsx: every projectile shader + the shared instanced
// meshes (getShared) verbatim. The gameplay simulation is replaced by a tiny
// visual-only ProjectileSystem the trailer timeline spawns into directly.

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
const UP = new THREE.Vector3(0, 1, 0)
const IDENTITY_Q = new THREE.Quaternion()
const ONE = new THREE.Vector3(1, 1, 1)
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

// ─── Trailer projectile system (visual only) ─────────────────────────────────

export type TrailerProjectileKind = 'rangerBolt' | 'bossBolt' | 'molotov' | 'rocket'

export interface TrailerProjectile {
  id: number
  kind: TrailerProjectileKind
  pos: THREE.Vector3
  vel: THREE.Vector3
  radius: number
  ttl: number
  gravityScale: number
  /** rockets: floor y at which they vanish (their telegraph resolves the boom) */
  floorY: number
  onExpire?: (p: TrailerProjectile) => void
}

const _m4 = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _dir = new THREE.Vector3()
const _v = new THREE.Vector3()
const _scale = new THREE.Vector3()

export class ProjectileSystem {
  readonly group = new THREE.Group()
  readonly list: TrailerProjectile[] = []
  private sh: Shared
  private nextId = 1
  private smokeAcc = 0
  private smokeHead = 0
  private lastPuffTime = -1e4
  private time = 0

  constructor() {
    this.sh = getShared()
    const sh = this.sh
    this.group.add(sh.ranger, sh.boss, sh.molotov, sh.flame, sh.rocket, sh.glow, sh.smoke)
  }

  reset(): void {
    this.list.length = 0
    this.smokeAcc = 0
    this.smokeHead = 0
    this.lastPuffTime = -1e4
    const sh = this.sh
    ;(sh.smokeBirth.array as Float32Array).fill(-1e4)
    sh.smokeBirth.clearUpdateRanges()
    sh.smokeBirth.needsUpdate = true
    sh.smoke.count = 0
    for (const m of [sh.ranger, sh.boss, sh.molotov, sh.flame, sh.rocket, sh.glow]) m.count = 0
  }

  add(p: Omit<TrailerProjectile, 'id' | 'floorY' | 'radius' | 'gravityScale'> & Partial<TrailerProjectile>): TrailerProjectile {
    const full: TrailerProjectile = {
      radius: 0.22, gravityScale: 0, floorY: 0.25, ...p, id: this.nextId++,
      pos: p.pos.clone(), vel: p.vel.clone(),
    }
    this.list.push(full)
    return full
  }

  private spawnPuff(p: TrailerProjectile): void {
    const sh = this.sh
    _dir.copy(p.vel)
    const len = _dir.length()
    if (len > 1e-4) _dir.divideScalar(len)
    else _dir.set(0, 1, 0)
    _v.copy(p.pos).addScaledVector(_dir, -1.0)
    _v.x += (Math.random() - 0.5) * 0.14
    _v.y += (Math.random() - 0.5) * 0.14
    _v.z += (Math.random() - 0.5) * 0.14
    const i = this.smokeHead
    this.smokeHead = (this.smokeHead + 1) % SMOKE_POOL
    _m4.compose(_v, IDENTITY_Q, ONE)
    sh.smoke.setMatrixAt(i, _m4)
    ;(sh.smokeBirth.array as Float32Array)[i] = this.time
    ;(sh.smokeSeed.array as Float32Array)[i] = Math.random() * 100
    sh.smoke.instanceMatrix.needsUpdate = true
    sh.smokeBirth.needsUpdate = true
    sh.smokeSeed.needsUpdate = true
    this.lastPuffTime = this.time
  }

  update(step: number, time: number): void {
    this.time = time
    const sh = this.sh
    this.smokeAcc += step
    let emitPuffs = false
    if (this.smokeAcc >= SMOKE_INTERVAL) {
      this.smokeAcc %= SMOKE_INTERVAL
      emitPuffs = true
    }
    const arr = this.list
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i]
      if (p.gravityScale !== 0) p.vel.y -= GRAVITY * p.gravityScale * step
      p.pos.addScaledVector(p.vel, step)
      p.ttl -= step
      let remove = p.ttl <= 0
      if (p.kind === 'rocket') {
        if (p.pos.y <= p.floorY) remove = true
        else if (emitPuffs) this.spawnPuff(p)
      }
      if (remove) {
        p.onExpire?.(p)
        arr.splice(i, 1)
      }
    }
    // render sync (from Projectiles.tsx syncRender)
    let nRanger = 0, nBoss = 0, nMol = 0, nRocket = 0
    const flameSeeds = sh.flameSeed.array as Float32Array
    const glowSeeds = sh.glowSeed.array as Float32Array
    const writeBolt = (mesh: THREE.InstancedMesh, idx: number, p: TrailerProjectile, halfLen: number) => {
      _dir.copy(p.vel)
      const len = _dir.length()
      if (len > 1e-4) _dir.divideScalar(len)
      else _dir.set(0, 1, 0)
      _quat.setFromUnitVectors(UP, _dir)
      const r = Math.max(0.09, p.radius * 0.85)
      _scale.set(r * 2, halfLen, r * 2)
      _m4.compose(p.pos, _quat, _scale)
      mesh.setMatrixAt(idx, _m4)
    }
    for (const p of arr) {
      if (p.kind === 'rangerBolt') {
        if (nRanger < MAX_RANGER) writeBolt(sh.ranger, nRanger++, p, RANGER_HALF_LEN)
      } else if (p.kind === 'bossBolt') {
        if (nBoss < MAX_BOSS) writeBolt(sh.boss, nBoss++, p, BOSS_HALF_LEN)
      } else if (p.kind === 'molotov') {
        if (nMol < MAX_MOLOTOV) {
          _euler.set(time * 6.3 + p.id * 1.37, p.id * 2.11, time * 4.7 + p.id * 0.77)
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
    for (const m of [sh.ranger, sh.boss, sh.molotov, sh.flame, sh.rocket, sh.glow]) m.instanceMatrix.needsUpdate = true
    sh.flameSeed.needsUpdate = true
    sh.glowSeed.needsUpdate = true
    if (time - this.lastPuffTime < SMOKE_LIFE + 0.05) {
      const births = sh.smokeBirth.array as Float32Array
      const cutoff = time - SMOKE_LIFE - 0.05
      let n = SMOKE_POOL
      while (n > 0 && births[n - 1] <= cutoff) n--
      sh.smoke.count = n
    } else sh.smoke.count = 0
    sh.flameMat.uniforms.uTime.value = time
    sh.glowMat.uniforms.uTime.value = time
    sh.smokeMat.uniforms.uTime.value = time
  }
}
