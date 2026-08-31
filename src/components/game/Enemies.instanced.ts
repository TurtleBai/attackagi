'use client'
import * as THREE from 'three'
import { MAX_CONCURRENT_ENEMIES } from '@/game/constants'
import { chassisMaterial, darkMetalMaterial } from '@/game/gfx/materials'
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

/** A few slots of headroom over the Director's hard cap, just in case. */
const CAPACITY = MAX_CONCURRENT_ENEMIES + 4

const KINDS: readonly EnemyKind[] = ['melee', 'ranger', 'tank', 'sniper', 'drone']

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
  rim: THREE.InstancedMesh // straggler outline shells (share mesh's instanceMatrix)
  xray: THREE.InstancedMesh
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
}

function buildKindBatch(kind: EnemyKind, parent: THREE.Group, darkMat: THREE.MeshStandardMaterial): KindBatch {
  const rig = getKindRig(kind)
  const chassisMat = flashMaterial(chassisMaterial(KIND_TINT[kind]), 1.0)
  const flashAttr = dynAttr(1)
  const glowAttrs: Record<string, THREE.InstancedBufferAttribute> = {}
  const glowMats: Record<string, THREE.MeshStandardMaterial> = {}
  for (const key of rig.glowKeys) glowAttrs[key] = dynAttr(1)
  const { rim, xray } = outlineMaterials()

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
    mesh.frustumCulled = false // instances spread across the whole arena
    mesh.castShadow = tp.mesh.castShadow
    mesh.receiveShadow = tp.mesh.receiveShadow
    parent.add(mesh)

    const mkHull = (hm: THREE.ShaderMaterial, order: number): THREE.InstancedMesh => {
      const hull = new THREE.InstancedMesh(geo, hm, CAPACITY)
      hull.instanceMatrix = mesh.instanceMatrix // reuse the body's posed slots
      hull.count = 0
      hull.visible = false
      hull.frustumCulled = false
      hull.castShadow = false
      hull.receiveShadow = false
      hull.renderOrder = order
      parent.add(hull)
      return hull
    }
    parts.push({ src: tp.mesh, mesh, rim: mkHull(rim, 30), xray: mkHull(xray, 45) })
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
  screen.frustumCulled = false
  screen.castShadow = false
  screen.receiveShadow = false
  parent.add(screen)
  const screenLocal = new THREE.Matrix4()
    .makeTranslation(sp.x, sp.y, sp.z)
    .multiply(new THREE.Matrix4().makeScale(sp.w, sp.h, 1))

  return {
    rig, parts, flashAttr, glowAttrs,
    screen, screenCell, screenGlow, screenMat, screenLocal,
    cursor: 0, outlineCount: 0,
  }
}

// module-scope scratch (no per-frame allocation)
const _m4 = new THREE.Matrix4()
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
    this.laserMesh.frustumCulled = false
    this.laserMesh.castShadow = false
    this.laserMesh.receiveShadow = false
    this.group.add(this.laserMesh)
  }

  /** Per-frame shader clock for the head-screen scanline/flicker. */
  setTime(t: number): void {
    for (const k of KINDS) this.kinds[k].screenMat.uniforms.uTime.value = t
  }

  /** Start a frame: rewind all instance cursors. */
  begin(): void {
    for (const k of KINDS) {
      const kb = this.kinds[k]
      kb.cursor = 0
      kb.outlineCount = 0
    }
    this.laserCursor = 0
  }

  /**
   * Capture the posed template rig for one enemy into the next instance slot of
   * its kind. Call right after poseBody() has posed the shared rig for `e`.
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
    }
  }

  /**
   * Straggler outline: the first `count` committed instances of `kind` (commit
   * alive enemies before dying ones) get the rim + x-ray hull shells.
   */
  setOutline(kind: EnemyKind, count: number): void {
    this.kinds[kind].outlineCount = Math.max(0, count)
  }

  /** End a frame: publish counts + mark dynamic buffers for upload. */
  finish(): void {
    for (const k of KINDS) {
      const kb = this.kinds[k]
      const n = kb.cursor
      const on = Math.min(kb.outlineCount, n)
      for (const p of kb.parts) {
        p.mesh.count = n
        p.mesh.visible = n > 0
        p.rim.count = on
        p.rim.visible = on > 0
        p.xray.count = on
        p.xray.visible = on > 0
        if (n > 0) p.mesh.instanceMatrix.needsUpdate = true
      }
      kb.screen.count = n
      kb.screen.visible = n > 0
      if (n > 0) {
        kb.flashAttr.needsUpdate = true
        for (const key of kb.rig.glowKeys) kb.glowAttrs[key].needsUpdate = true
        kb.screen.instanceMatrix.needsUpdate = true
        kb.screenCell.needsUpdate = true
        kb.screenGlow.needsUpdate = true
      }
    }
    const ln = this.laserCursor
    this.laserMesh.count = ln
    this.laserMesh.visible = ln > 0
    if (ln > 0) {
      this.laserMesh.instanceMatrix.needsUpdate = true
      this.laserOp.needsUpdate = true
    }
  }

  /** Hard reset (runId change / unmount): zero every count, hide everything. */
  reset(): void {
    this.begin()
    this.finish()
  }
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
