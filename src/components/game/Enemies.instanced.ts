'use client'
import * as THREE from 'three'
import { MAX_CONCURRENT_ENEMIES } from '@/game/constants'
import { chassisMaterial, darkMetalMaterial } from '@/game/gfx/materials'
import { tierKnobs } from '@/game/quality'
import type { Enemy, EnemyKind } from '@/game/types'
import {
  getKindRig, KIND_TINT, outlineMaterials, SCREEN_PLACEMENT, unitBoxGeometry,
  type KindRig,
} from './Enemies.bodies'
import { ATLAS_GRID, logoAtlasTexture, logoCellOffset, LOGO_COUNT } from './Enemies.decals'

// Instanced crowd renderer. One InstancedMesh per (kind, template part-mesh),
// sized once; Enemies.tsx poses the shared template rig per enemy and commits
// the posed part world-matrices into instance slots. Per-instance hit-flash and
// glow-intensity ride InstancedBufferAttributes consumed via onBeforeCompile
// injection on a handful of SHARED materials — no per-enemy clones, no
// re-instantiation, ~50 draw calls for the whole crowd instead of ~420.
//
// Per-frame extras handled here:
// - Frustum culling: commit() tracks per-kind position min/max; finish() writes
//   one world-space bounding Sphere per kind onto every draw of that kind, so
//   facing away from a cluster skips its draws + vertex work entirely.
// - Pose-rate LOD: commit() write-through-caches each enemy's committed slot
//   data; commitCached() replays it into the current frame's slot without
//   re-posing the rig (Enemies.tsx decides who may skip).
// - Upload ranges: finish() marks only the live [0, count) prefix of each
//   dynamic buffer for GPU upload instead of the full CAPACITY buffer.
// - Far shadows: castShadow is dropped per kind while the WHOLE kind cluster
//   sits beyond ~30m from the camera (coarse but free; ±2m hysteresis).
// - Potato blob shadows: with tier shadows off (STRUCTURAL, read at batcher
//   construction) one InstancedMesh of soft radial blob quads grounds the crowd.

/** A few slots of headroom over the Director's hard cap, just in case. */
const CAPACITY = MAX_CONCURRENT_ENEMIES + 4

const KINDS: readonly EnemyKind[] = ['melee', 'ranger', 'tank', 'sniper', 'drone']

/** Sphere padding beyond enemy feet positions: limb/weapon reach, screens, dying sink. */
const CULL_PAD = 3.5
/** Camera-to-cluster distance beyond which a whole kind stops casting shadows. */
const FAR_SHADOW_DIST = 30
/** Blob shadows fade out over this altitude (drones at ~8m never draw one). */
const BLOB_FADE_HEIGHT = 6

/** Per-frame sniper aim-laser request, filled by poseBody (Enemies.tsx). */
export interface LaserSlot {
  on: boolean
  ax: number; ay: number; az: number // world start (muzzle)
  bx: number; by: number; bz: number // world end (target)
  opacity: number
}

// ─── Shared-material shader injections ───────────────────────────────────────
// GPU shader safety: every injected term is clamped non-negative and purely
// additive/multiplicative — no pow/sqrt/log/division anywhere (NaN + Bloom
// mipmaps blacks the whole screen on macOS Metal/ANGLE).

/** Hit-flash: additive white emissive scaled by the per-instance aFlash attribute. */
function flashMaterial(src: THREE.MeshStandardMaterial, scale: number): THREE.MeshStandardMaterial {
  const m = src.clone()
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlash;\nvarying float vFlash;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvFlash = aFlash;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlash;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vec3(max(vFlash, 0.0) * ${scale.toFixed(2)});`,
      )
  }
  // scale is baked into the shader text — it must be part of the program key
  m.customProgramCacheKey = () => `enemyFlash:${scale.toFixed(2)}`
  return m
}

/** Glow parts: per-instance intensity multiplier on the material's base emissive. */
function glowInstMaterial(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const m = src.clone()
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGlow = aGlow;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= max(vGlow, 0.0);',
      )
  }
  m.customProgramCacheKey = () => 'enemyGlow'
  return m
}

/** Head display screen: lab logo from the shared atlas over a faint dark screen
 * fill, HDR output (~2) so Bloom halos it. Scanline + idle flicker are built from
 * clamped sums/products only — no pow anywhere (GLSL pow with base <= 0 is a hard
 * NaN rule on this project). */
function screenMaterial(tint: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: logoAtlasTexture() },
      uTint: { value: new THREE.Color(tint) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
attribute vec2 aCell;
attribute float aGlow;
varying vec2 vUv;
varying float vGlow;
varying float vSeed;
void main(){
  vUv = uv + aCell;
  vGlow = aGlow;
  vSeed = aCell.x * 21.0 + aCell.y * 47.0;
  vec4 mp = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    mp = instanceMatrix * mp;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * mp;
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uTint;
uniform float uTime;
varying vec2 vUv;
varying float vGlow;
varying float vSeed;
void main(){
  float mark = texture2D(uAtlas, vUv).a;
  float scan = 0.92 + 0.08 * sin(vUv.y * 620.0 - uTime * 3.0);
  float flick = 0.94 + 0.06 * sin(uTime * 9.0 + vSeed) * sin(uTime * 23.0 + vSeed * 1.7);
  float g = max(vGlow, 0.0) * scan * flick;
  vec3 col = uTint * (0.12 + 2.0 * mark) * g;
  gl_FragColor = vec4(col, 1.0);
}`,
  })
}

/** Shared screen quad: unit plane with UVs pre-scaled to one atlas cell. */
let screenPlane: THREE.PlaneGeometry | null = null
function screenPlaneGeo(): THREE.PlaneGeometry {
  if (!screenPlane) {
    screenPlane = new THREE.PlaneGeometry(1, 1)
    const uv = screenPlane.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / ATLAS_GRID, uv.getY(i) / ATLAS_GRID)
  }
  return screenPlane
}

/** Sniper aim laser: unlit green (sniper's glow family), per-instance opacity. */
function laserMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: 0x38ff7a,
    transparent: true,
    toneMapped: false, // keep neon punch through tone mapping for bloom
  })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOpacity;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvOpacity = aOpacity;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vOpacity;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= clamp(vOpacity, 0.0, 1.0);')
  }
  m.customProgramCacheKey = () => 'enemyLaser'
  return m
}

/** Potato blob shadow: soft dark radial quad, per-instance fade. Falloff is a
 * clamped quadratic product — no pow anywhere (GLSL pow with base <= 0 is a
 * hard NaN rule on this project). */
function blobMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
attribute float aFade;
varying vec2 vUv;
varying float vFade;
void main(){
  vUv = uv;
  vFade = aFade;
  vec4 mp = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    mp = instanceMatrix * mp;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * mp;
}`,
    fragmentShader: /* glsl */ `
varying vec2 vUv;
varying float vFade;
void main(){
  float d = min(1.0, length(vUv - 0.5) * 2.0);
  float t = 1.0 - d;
  float a = t * t * 0.5 * clamp(vFade, 0.0, 1.0);
  gl_FragColor = vec4(0.01, 0.012, 0.02, a);
}`,
  })
}

// ─── Geometry / attribute helpers ────────────────────────────────────────────

function dynAttr(itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * itemSize), itemSize)
  a.setUsage(THREE.DynamicDrawUsage)
  return a
}

/**
 * Wrap a (possibly shared/cached) geometry so per-mesh instanced attributes can
 * be attached without polluting the source. Vertex data + index are SHARED by
 * reference — never dispose these wrappers.
 */
function wrapGeo(
  src: THREE.BufferGeometry,
  extra: Record<string, THREE.InstancedBufferAttribute>,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  if (src.index) g.setIndex(src.index)
  for (const name in src.attributes) g.setAttribute(name, src.attributes[name])
  for (const name in extra) g.setAttribute(name, extra[name])
  return g
}

// ─── Per-kind batch state ────────────────────────────────────────────────────

interface PartRuntime {
  src: THREE.Mesh // template mesh — posed matrixWorld source
  mesh: THREE.InstancedMesh
  rim: THREE.InstancedMesh | null // straggler outline shells (silhouette parts only)
  xray: THREE.InstancedMesh | null
  cast: boolean // template castShadow (restored when the cluster comes back in range)
}

interface KindBatch {
  rig: KindRig
  parts: PartRuntime[]
  flashAttr: THREE.InstancedBufferAttribute // shared by every chassis/dark part
  glowAttrs: Record<string, THREE.InstancedBufferAttribute> // one per glow key
  screen: THREE.InstancedMesh // glowing head-display quad (one per kind)
  screenCell: THREE.InstancedBufferAttribute // atlas cell per instance
  screenGlow: THREE.InstancedBufferAttribute // brightness mult (attack boost / death flicker)
  screenMat: THREE.ShaderMaterial
  screenLocal: THREE.Matrix4 // head-local screen placement
  cursor: number
  outlineCount: number // leading instances that get outline shells this frame
  /** ONE world-space Sphere shared by reference across every draw of this kind */
  sphere: THREE.Sphere
  minX: number; minY: number; minZ: number
  maxX: number; maxY: number; maxZ: number
  /** pose-LOD replay cache: one row per live enemy of this kind (write-through) */
  cache: Float32Array
  stride: number // floats per cache row
  rowOf: Map<number, number> // enemy id → cache row
  freeRows: number[]
  shadowsOn: boolean // far-shadow hysteresis state
}

function buildKindBatch(kind: EnemyKind, parent: THREE.Group, darkMat: THREE.MeshStandardMaterial): KindBatch {
  const rig = getKindRig(kind)
  const chassisMat = flashMaterial(chassisMaterial(KIND_TINT[kind]), 1.0)
  const flashAttr = dynAttr(1)
  const glowAttrs: Record<string, THREE.InstancedBufferAttribute> = {}
  const glowMats: Record<string, THREE.MeshStandardMaterial> = {}
  for (const key of rig.glowKeys) glowAttrs[key] = dynAttr(1)
  const { rim, xray } = outlineMaterials()

  // one cluster-fitting Sphere per kind, shared by reference across every draw
  // of the kind (frustum culls compare against a copy — safe to share/mutate)
  const sphere = new THREE.Sphere(new THREE.Vector3(), CULL_PAD)

  const parts: PartRuntime[] = []
  for (const tp of rig.parts) {
    let mat: THREE.Material
    let geo: THREE.BufferGeometry
    if (tp.bucket === 'chassis') {
      mat = chassisMat
      geo = wrapGeo(tp.mesh.geometry, { aFlash: flashAttr })
    } else if (tp.bucket === 'dark') {
      mat = darkMat
      geo = wrapGeo(tp.mesh.geometry, { aFlash: flashAttr })
    } else {
      const key = tp.bucket.slice(5)
      if (!glowMats[key]) glowMats[key] = glowInstMaterial(tp.mesh.material as THREE.MeshStandardMaterial)
      mat = glowMats[key]
      geo = wrapGeo(tp.mesh.geometry, { aGlow: glowAttrs[key] })
    }
    const mesh = new THREE.InstancedMesh(geo, mat, CAPACITY)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.count = 0
    mesh.visible = false
    mesh.frustumCulled = true // culled against the shared per-kind cluster sphere
    mesh.boundingSphere = sphere
    mesh.castShadow = tp.mesh.castShadow
    mesh.receiveShadow = tp.mesh.receiveShadow
    parent.add(mesh)

    const mkHull = (hm: THREE.ShaderMaterial, order: number): THREE.InstancedMesh => {
      const hull = new THREE.InstancedMesh(geo, hm, CAPACITY)
      hull.instanceMatrix = mesh.instanceMatrix // reuse the body's posed slots
      hull.count = 0
      hull.visible = false
      hull.frustumCulled = true
      hull.boundingSphere = sphere
      hull.castShadow = false
      hull.receiveShadow = false
      hull.renderOrder = order
      parent.add(hull)
      return hull
    }
    // outline shells only for silhouette parts — greebles/glow bits add draws
    // and verts without changing the outline's read (tagged in Enemies.bodies)
    parts.push({
      src: tp.mesh, mesh,
      rim: tp.hull ? mkHull(rim, 30) : null,
      xray: tp.hull ? mkHull(xray, 45) : null,
      cast: tp.mesh.castShadow,
    })
  }

  // glowing head-display quad: transformed from the posed head node per instance
  const sp = SCREEN_PLACEMENT[kind]
  const screenCell = dynAttr(2)
  const screenGlow = dynAttr(1)
  const screenMat = screenMaterial(sp.tint)
  const screen = new THREE.InstancedMesh(
    wrapGeo(screenPlaneGeo(), { aCell: screenCell, aGlow: screenGlow }), screenMat, CAPACITY,
  )
  screen.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  screen.count = 0
  screen.visible = false
  screen.frustumCulled = true
  screen.boundingSphere = sphere
  screen.castShadow = false
  screen.receiveShadow = false
  parent.add(screen)
  const screenLocal = new THREE.Matrix4()
    .makeTranslation(sp.x, sp.y, sp.z)
    .multiply(new THREE.Matrix4().makeScale(sp.w, sp.h, 1))

  // pose-LOD cache row: part matrices + screen matrix + flash + glows + screenGlow
  const stride = rig.parts.length * 16 + 16 + 1 + rig.glowKeys.length + 1
  const freeRows: number[] = []
  for (let i = CAPACITY - 1; i >= 0; i--) freeRows.push(i)

  return {
    rig, parts, flashAttr, glowAttrs,
    screen, screenCell, screenGlow, screenMat, screenLocal,
    cursor: 0, outlineCount: 0,
    sphere,
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    cache: new Float32Array(CAPACITY * stride),
    stride, rowOf: new Map(), freeRows,
    shadowsOn: true,
  }
}

// module-scope scratch (no per-frame allocation)
const _m4 = new THREE.Matrix4()
const _bm4 = new THREE.Matrix4() // blob-only: _m4 still holds the screen matrix when blobs write
const _cell = { x: 0, y: 0 }
const _va = new THREE.Vector3()
const _vb = new THREE.Vector3()
const _laserPose = new THREE.Object3D()

// ─── The batcher ─────────────────────────────────────────────────────────────

export class EnemyBatcher {
  /** attach this to the Enemies root group (module singleton — re-parent freely) */
  group = new THREE.Group()
  private kinds: Record<EnemyKind, KindBatch>
  private laserMesh: THREE.InstancedMesh
  private laserOp: THREE.InstancedBufferAttribute
  private laserCursor = 0
  private laserSphere = new THREE.Sphere(new THREE.Vector3(), 1)
  private lMinX = Infinity; private lMinY = Infinity; private lMinZ = Infinity
  private lMaxX = -Infinity; private lMaxY = -Infinity; private lMaxZ = -Infinity
  // potato blob shadows (null on tiers with real shadow maps)
  private blob: THREE.InstancedMesh | null = null
  private blobFade: THREE.InstancedBufferAttribute | null = null
  private blobSphere = new THREE.Sphere(new THREE.Vector3(), 1)
  private blobCursor = 0
  private bMinX = Infinity; private bMinZ = Infinity
  private bMaxX = -Infinity; private bMaxZ = -Infinity

  constructor() {
    const darkMat = flashMaterial(darkMetalMaterial(), 0.8)
    this.kinds = {
      melee: buildKindBatch('melee', this.group, darkMat),
      ranger: buildKindBatch('ranger', this.group, darkMat),
      tank: buildKindBatch('tank', this.group, darkMat),
      sniper: buildKindBatch('sniper', this.group, darkMat),
      // sized CAPACITY (cap-based) like every kind — never per-wave-quota
      drone: buildKindBatch('drone', this.group, darkMat),
    }

    // one box for every live sniper aim laser
    this.laserOp = dynAttr(1)
    const laserGeo = wrapGeo(unitBoxGeometry(), { aOpacity: this.laserOp })
    this.laserMesh = new THREE.InstancedMesh(laserGeo, laserMaterial(), CAPACITY)
    this.laserMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.laserMesh.count = 0
    this.laserMesh.visible = false
    this.laserMesh.frustumCulled = true
    this.laserMesh.boundingSphere = this.laserSphere
    this.laserMesh.castShadow = false
    this.laserMesh.receiveShadow = false
    this.group.add(this.laserMesh)

    // STRUCTURAL tier knob, read once at construction: without shadow maps the
    // crowd floats — ground it with one InstancedMesh of soft dark blob quads
    if (!tierKnobs().shadows) {
      this.blobFade = dynAttr(1)
      const blobGeo = wrapGeo(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        { aFade: this.blobFade },
      )
      this.blob = new THREE.InstancedMesh(blobGeo, blobMaterial(), CAPACITY)
      this.blob.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.blob.count = 0
      this.blob.visible = false
      this.blob.frustumCulled = true
      this.blob.boundingSphere = this.blobSphere
      this.blob.castShadow = false
      this.blob.receiveShadow = false
      this.group.add(this.blob)
    }
  }

  /** Per-frame shader clock for the head-screen scanline/flicker. */
  setTime(t: number): void {
    for (const k of KINDS) this.kinds[k].screenMat.uniforms.uTime.value = t
  }

  /** Start a frame: rewind all instance cursors + cluster bounds. */
  begin(): void {
    for (const k of KINDS) {
      const kb = this.kinds[k]
      kb.cursor = 0
      kb.outlineCount = 0
      kb.minX = Infinity; kb.minY = Infinity; kb.minZ = Infinity
      kb.maxX = -Infinity; kb.maxY = -Infinity; kb.maxZ = -Infinity
    }
    this.laserCursor = 0
    this.lMinX = Infinity; this.lMinY = Infinity; this.lMinZ = Infinity
    this.lMaxX = -Infinity; this.lMaxY = -Infinity; this.lMaxZ = -Infinity
    this.blobCursor = 0
    this.bMinX = Infinity; this.bMinZ = Infinity
    this.bMaxX = -Infinity; this.bMaxZ = -Infinity
  }

  /** Grow the kind's cluster bounds by this enemy's position. */
  private expandBounds(kb: KindBatch, e: Enemy): void {
    const p = e.pos
    if (p.x < kb.minX) kb.minX = p.x
    if (p.x > kb.maxX) kb.maxX = p.x
    if (p.y < kb.minY) kb.minY = p.y
    if (p.y > kb.maxY) kb.maxY = p.y
    if (p.z < kb.minZ) kb.minZ = p.z
    if (p.z > kb.maxZ) kb.maxZ = p.z
  }

  /** Potato blob shadow under a grounded enemy; shrinks + fades with altitude. */
  private writeBlob(e: Enemy): void {
    const blob = this.blob
    const fadeAttr = this.blobFade
    if (!blob || !fadeAttr) return
    const k = 1 - e.pos.y / BLOB_FADE_HEIGHT // <=0 for flyers at drone altitude
    if (k <= 0) return
    const i = this.blobCursor
    if (i >= CAPACITY) return
    this.blobCursor = i + 1
    const fade = Math.min(1, k)
    const s = e.radius * 2.6 * (0.7 + 0.3 * fade)
    _bm4.makeScale(s, 1, s).setPosition(e.pos.x, 0.03, e.pos.z)
    blob.setMatrixAt(i, _bm4)
    fadeAttr.setX(i, fade)
    if (e.pos.x < this.bMinX) this.bMinX = e.pos.x
    if (e.pos.x > this.bMaxX) this.bMaxX = e.pos.x
    if (e.pos.z < this.bMinZ) this.bMinZ = e.pos.z
    if (e.pos.z > this.bMaxZ) this.bMaxZ = e.pos.z
  }

  /**
   * Capture the posed template rig for one enemy into the next instance slot of
   * its kind. Call right after poseBody() has posed the shared rig for `e`.
   * Write-through-caches the slot data so commitCached() can replay it on
   * pose-LOD skip frames without touching the rig.
   */
  commit(e: Enemy, flash: number, glow: Record<string, number>, laser: LaserSlot): void {
    const kb = this.kinds[e.kind]
    const i = kb.cursor
    if (i >= CAPACITY) return
    kb.cursor = i + 1
    kb.rig.group.updateMatrixWorld(true)
    for (const p of kb.parts) p.mesh.setMatrixAt(i, p.src.matrixWorld)
    kb.flashAttr.setX(i, flash)
    for (const key of kb.rig.glowKeys) kb.glowAttrs[key].setX(i, glow[key] ?? 1)
    logoCellOffset(e.data.logo ?? e.id % LOGO_COUNT, _cell)

    // glowing logo display rides the posed head (follows head pitch/death tilt)
    const head = kb.rig.nodes.head
    if (head) {
      _m4.multiplyMatrices(head.matrixWorld, kb.screenLocal)
      kb.screen.setMatrixAt(i, _m4)
      kb.screenCell.setXY(i, _cell.x, _cell.y)
      kb.screenGlow.setX(i, glow.screen ?? 1)
    }

    this.expandBounds(kb, e)
    this.writeBlob(e)

    // replay cache (row acquired on the enemy's first commit, freed on release)
    let row = kb.rowOf.get(e.id)
    if (row === undefined && kb.freeRows.length > 0) {
      row = kb.freeRows.pop() as number
      kb.rowOf.set(e.id, row)
    }
    if (row !== undefined) {
      const c = kb.cache
      let o = row * kb.stride
      for (const p of kb.parts) {
        const el = p.src.matrixWorld.elements
        for (let j = 0; j < 16; j++) c[o + j] = el[j]
        o += 16
      }
      const el = _m4.elements // still holds the screen matrix from above
      for (let j = 0; j < 16; j++) c[o + j] = el[j]
      o += 16
      c[o++] = flash
      for (const key of kb.rig.glowKeys) c[o++] = glow[key] ?? 1
      c[o] = glow.screen ?? 1
    }

    // sniper aim laser
    if (laser.on && this.laserCursor < CAPACITY) {
      const li = this.laserCursor++
      _va.set(laser.ax, laser.ay, laser.az)
      _vb.set(laser.bx, laser.by, laser.bz)
      const len = _va.distanceTo(_vb)
      _laserPose.position.copy(_va).add(_vb).multiplyScalar(0.5)
      _laserPose.lookAt(_vb)
      _laserPose.scale.set(0.022, 0.022, Math.max(0.1, len))
      _laserPose.updateMatrix()
      this.laserMesh.setMatrixAt(li, _laserPose.matrix)
      this.laserOp.setX(li, laser.opacity)
      if (_va.x < this.lMinX) this.lMinX = _va.x
      if (_va.x > this.lMaxX) this.lMaxX = _va.x
      if (_va.y < this.lMinY) this.lMinY = _va.y
      if (_va.y > this.lMaxY) this.lMaxY = _va.y
      if (_va.z < this.lMinZ) this.lMinZ = _va.z
      if (_va.z > this.lMaxZ) this.lMaxZ = _va.z
      if (_vb.x < this.lMinX) this.lMinX = _vb.x
      if (_vb.x > this.lMaxX) this.lMaxX = _vb.x
      if (_vb.y < this.lMinY) this.lMinY = _vb.y
      if (_vb.y > this.lMaxY) this.lMaxY = _vb.y
      if (_vb.z < this.lMinZ) this.lMinZ = _vb.z
      if (_vb.z > this.lMaxZ) this.lMaxZ = _vb.z
    }
  }

  /**
   * Pose-rate LOD skip frame: replay the enemy's cached slot data into the next
   * instance slot of its kind, skipping the pose + updateMatrixWorld chain
   * entirely. Returns false when no cache row exists yet (caller must full-pose).
   */
  commitCached(e: Enemy): boolean {
    const kb = this.kinds[e.kind]
    const row = kb.rowOf.get(e.id)
    if (row === undefined) return false
    const i = kb.cursor
    if (i >= CAPACITY) return true // over capacity: commit() would drop it too
    kb.cursor = i + 1
    const c = kb.cache
    let o = row * kb.stride
    const base = i * 16
    for (const p of kb.parts) {
      const dst = p.mesh.instanceMatrix.array as Float32Array
      for (let j = 0; j < 16; j++) dst[base + j] = c[o + j]
      o += 16
    }
    const sdst = kb.screen.instanceMatrix.array as Float32Array
    for (let j = 0; j < 16; j++) sdst[base + j] = c[o + j]
    o += 16
    kb.flashAttr.setX(i, c[o++])
    for (const key of kb.rig.glowKeys) kb.glowAttrs[key].setX(i, c[o++])
    kb.screenGlow.setX(i, c[o])
    logoCellOffset(e.data.logo ?? e.id % LOGO_COUNT, _cell)
    kb.screenCell.setXY(i, _cell.x, _cell.y)
    this.expandBounds(kb, e)
    this.writeBlob(e)
    return true
  }

  /** Free the pose-LOD cache row of a removed enemy. */
  release(id: number): void {
    for (const k of KINDS) {
      const kb = this.kinds[k]
      const row = kb.rowOf.get(id)
      if (row !== undefined) {
        kb.rowOf.delete(id)
        kb.freeRows.push(row)
        return
      }
    }
  }

  /**
   * Straggler outline: the first `count` committed instances of `kind` (commit
   * alive enemies before dying ones) get the rim + x-ray hull shells.
   */
  setOutline(kind: EnemyKind, count: number): void {
    this.kinds[kind].outlineCount = Math.max(0, count)
  }

  /**
   * End a frame: publish counts, refresh the per-kind cluster spheres, mark
   * ONLY the live [0, count) prefix of each dynamic buffer for upload, and drop
   * castShadow on kinds whose whole cluster sits beyond FAR_SHADOW_DIST from
   * `camPos` (coarse cluster-level toggle — a single near enemy keeps its
   * kind's shadows on; ±2m hysteresis stops boundary flicker).
   */
  finish(camPos?: THREE.Vector3): void {
    for (const k of KINDS) {
      const kb = this.kinds[k]
      const n = kb.cursor
      const on = Math.min(kb.outlineCount, n)
      if (n > 0) {
        // world-space cluster sphere: midpoint center, half-diagonal + limb pad
        const s = kb.sphere
        s.center.set((kb.minX + kb.maxX) * 0.5, (kb.minY + kb.maxY) * 0.5, (kb.minZ + kb.maxZ) * 0.5)
        const dx = (kb.maxX - kb.minX) * 0.5
        const dy = (kb.maxY - kb.minY) * 0.5
        const dz = (kb.maxZ - kb.minZ) * 0.5
        s.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) + CULL_PAD
        if (camPos) {
          const d = s.center.distanceTo(camPos) - s.radius
          if (d > FAR_SHADOW_DIST + 2) kb.shadowsOn = false
          else if (d < FAR_SHADOW_DIST - 2) kb.shadowsOn = true
        }
      }
      for (const p of kb.parts) {
        p.mesh.count = n
        p.mesh.visible = n > 0
        p.mesh.castShadow = kb.shadowsOn && p.cast
        if (p.rim) {
          p.rim.count = on
          p.rim.visible = on > 0
        }
        if (p.xray) {
          p.xray.count = on
          p.xray.visible = on > 0
        }
        if (n > 0) {
          const im = p.mesh.instanceMatrix
          im.clearUpdateRanges()
          im.addUpdateRange(0, n * 16)
          im.needsUpdate = true
        }
      }
      kb.screen.count = n
      kb.screen.visible = n > 0
      if (n > 0) {
        markRange(kb.flashAttr, n)
        for (const key of kb.rig.glowKeys) markRange(kb.glowAttrs[key], n)
        const sim = kb.screen.instanceMatrix
        sim.clearUpdateRanges()
        sim.addUpdateRange(0, n * 16)
        sim.needsUpdate = true
        markRange(kb.screenCell, n)
        markRange(kb.screenGlow, n)
      }
    }
    const ln = this.laserCursor
    this.laserMesh.count = ln
    this.laserMesh.visible = ln > 0
    if (ln > 0) {
      const s = this.laserSphere
      s.center.set((this.lMinX + this.lMaxX) * 0.5, (this.lMinY + this.lMaxY) * 0.5, (this.lMinZ + this.lMaxZ) * 0.5)
      const dx = (this.lMaxX - this.lMinX) * 0.5
      const dy = (this.lMaxY - this.lMinY) * 0.5
      const dz = (this.lMaxZ - this.lMinZ) * 0.5
      s.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.5
      const im = this.laserMesh.instanceMatrix
      im.clearUpdateRanges()
      im.addUpdateRange(0, ln * 16)
      im.needsUpdate = true
      markRange(this.laserOp, ln)
    }
    if (this.blob && this.blobFade) {
      const bn = this.blobCursor
      this.blob.count = bn
      this.blob.visible = bn > 0
      if (bn > 0) {
        const s = this.blobSphere
        s.center.set((this.bMinX + this.bMaxX) * 0.5, 0, (this.bMinZ + this.bMaxZ) * 0.5)
        const dx = (this.bMaxX - this.bMinX) * 0.5
        const dz = (this.bMaxZ - this.bMinZ) * 0.5
        s.radius = Math.sqrt(dx * dx + dz * dz) + 2.5
        const im = this.blob.instanceMatrix
        im.clearUpdateRanges()
        im.addUpdateRange(0, bn * 16)
        im.needsUpdate = true
        markRange(this.blobFade, bn)
      }
    }
  }

  /** Hard reset (runId change / unmount): zero every count, hide everything. */
  reset(): void {
    for (const k of KINDS) {
      const kb = this.kinds[k]
      kb.rowOf.clear()
      kb.freeRows.length = 0
      for (let i = CAPACITY - 1; i >= 0; i--) kb.freeRows.push(i)
      kb.shadowsOn = true
    }
    this.begin()
    this.finish()
  }
}

/** Mark only the live [0, n) instances of a per-instance attribute for upload. */
function markRange(a: THREE.InstancedBufferAttribute, n: number): void {
  a.clearUpdateRanges()
  a.addUpdateRange(0, n * a.itemSize)
  a.needsUpdate = true
}

let batcher: EnemyBatcher | null = null

/** Module singleton — instanced meshes are sized once and never re-instantiated. */
export function getEnemyBatcher(): EnemyBatcher {
  if (!batcher) batcher = new EnemyBatcher()
  return batcher
}

/** Reset without forcing construction (safe in unmount cleanup / SSR). */
export function resetEnemyBatcher(): void {
  batcher?.reset()
}
