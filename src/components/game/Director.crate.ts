'use client'
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { crateMaterial, darkMetalMaterial } from '@/game/gfx/materials'

// Ammo-crate pickup visuals, owned by the Director module.
// A beveled wooden crate (shared crateMaterial: scuffed planks + steel band zones)
// wrapped in proud steel corner brackets, an emissive bullet-pictogram decal on
// every face (blooms via toneMapped:false, color > 1), a pulsing additive glow
// ring on the ground and a soft vertical light shaft so the pickup reads as a
// point of interest from across the arena (~40m).

const CRATE_SIZE = 0.92
const CRATE_BEVEL = 0.07
const HOVER_HEIGHT = 0.74 // crate center hover height (bob oscillates around it)
const BEAM_HEIGHT = 3.6

// ─── Shared geometry/material singletons (built lazily, cached for app lifetime,
//     matching the gfx/ cache pattern — never disposed on component unmount) ────

let bodyGeo: THREE.BufferGeometry | null = null
let capsGeo: THREE.BufferGeometry | null = null
let decalGeo: THREE.PlaneGeometry | null = null
let ringGeo: THREE.PlaneGeometry | null = null
let beamGeo: THREE.CylinderGeometry | null = null
let decalMat: THREE.MeshBasicMaterial | null = null
let ringMatProto: THREE.MeshBasicMaterial | null = null
let beamMatProto: THREE.MeshBasicMaterial | null = null

/**
 * Chamfered cube: subdivided box whose vertices are clamped to an inner box and
 * pushed back out along the corner direction — real silhouette change, box UVs kept.
 */
function beveledBoxGeometry(size: number, bevel: number, segments = 3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size, size, size, segments, segments, segments)
  const pos = g.attributes.position as THREE.BufferAttribute
  const inner = size / 2 - bevel
  const v = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    c.set(
      THREE.MathUtils.clamp(v.x, -inner, inner),
      THREE.MathUtils.clamp(v.y, -inner, inner),
      THREE.MathUtils.clamp(v.z, -inner, inner),
    )
    v.sub(c)
    const len = v.length()
    if (len > 1e-6) v.multiplyScalar(bevel / len)
    pos.setXYZ(i, c.x + v.x, c.y + v.y, c.z + v.z)
  }
  g.computeVertexNormals()
  return g
}

/** 8 corner brackets, 3 steel plates each, merged into one geometry. */
function buildCapsGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const h = CRATE_SIZE / 2
  const CAP = 0.26 // bracket arm length along each face
  const T = 0.045 // plate thickness
  const LIP = 0.025 // how far the arm pokes past the crate edge (silhouette)
  const SINK = 0.018 // how deep the plate sinks into the wood
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const tx = sx * (h - CAP / 2 + LIP)
        const ty = sy * (h - CAP / 2 + LIP)
        const tz = sz * (h - CAP / 2 + LIP)
        parts.push(new THREE.BoxGeometry(T, CAP, CAP).translate(sx * (h + T / 2 - SINK), ty, tz))
        parts.push(new THREE.BoxGeometry(CAP, T, CAP).translate(tx, sy * (h + T / 2 - SINK), tz))
        parts.push(new THREE.BoxGeometry(CAP, CAP, T).translate(tx, ty, sz * (h + T / 2 - SINK)))
      }
    }
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return merged
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x, y + r, r)
  ctx.closePath()
}

/** Stenciled bullet pictogram: three cartridges inside a rounded frame. */
function ammoDecalTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, 128, 128)
  // soft halo behind the stencil so the decal reads at distance
  const halo = ctx.createRadialGradient(64, 64, 8, 64, 64, 62)
  halo.addColorStop(0, 'rgba(255,180,80,0.28)')
  halo.addColorStop(1, 'rgba(255,180,80,0)')
  ctx.fillStyle = halo
  ctx.fillRect(0, 0, 128, 128)
  // frame
  ctx.strokeStyle = 'rgba(255,196,110,0.95)'
  ctx.lineWidth = 5
  roundRectPath(ctx, 10, 10, 108, 108, 16)
  ctx.stroke()
  // three cartridges: nose + casing + rim
  ctx.fillStyle = 'rgb(255,200,116)'
  for (const x of [40, 64, 88]) {
    ctx.beginPath()
    ctx.moveTo(x - 8, 60)
    ctx.quadraticCurveTo(x - 8, 36, x, 26)
    ctx.quadraticCurveTo(x + 8, 36, x + 8, 60)
    ctx.lineTo(x + 8, 90)
    ctx.lineTo(x - 8, 90)
    ctx.closePath()
    ctx.fill()
    ctx.fillRect(x - 10, 92, 20, 8)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** Soft annulus, transparent center/edge — additive ground glow. */
function ringTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0.0, 'rgba(255,190,100,0)')
  g.addColorStop(0.42, 'rgba(255,190,100,0.05)')
  g.addColorStop(0.62, 'rgba(255,200,120,0.85)')
  g.addColorStop(0.78, 'rgba(255,170,70,0.35)')
  g.addColorStop(1.0, 'rgba(255,160,60,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Vertical alpha gradient for the light shaft (bright at the ground, fades up). */
function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 16
  c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 128, 0, 0)
  g.addColorStop(0.0, 'rgba(255,200,120,0.4)')
  g.addColorStop(0.35, 'rgba(255,190,100,0.16)')
  g.addColorStop(1.0, 'rgba(255,180,90,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 16, 128)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function init(): void {
  if (bodyGeo) return
  bodyGeo = beveledBoxGeometry(CRATE_SIZE, CRATE_BEVEL, 3)
  capsGeo = buildCapsGeometry()
  decalGeo = new THREE.PlaneGeometry(0.56, 0.56)
  ringGeo = new THREE.PlaneGeometry(2.5, 2.5)
  beamGeo = new THREE.CylinderGeometry(0.2, 0.42, BEAM_HEIGHT, 10, 1, true)
  decalMat = new THREE.MeshBasicMaterial({
    map: ammoDecalTexture(),
    transparent: true,
    depthWrite: false,
    toneMapped: false, // > 1.0 luminance → picked up by the bloom pass
    color: new THREE.Color(2.6, 2.2, 1.7),
  })
  ringMatProto = new THREE.MeshBasicMaterial({
    map: ringTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    color: new THREE.Color(1.7, 1.2, 0.55),
  })
  beamMatProto = new THREE.MeshBasicMaterial({
    map: beamTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    color: new THREE.Color(1.1, 0.85, 0.45),
  })
}

export interface CrateVis {
  root: THREE.Group
  bob: THREE.Group
  ring: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
}

export function makeCrate(): CrateVis {
  init()
  const root = new THREE.Group()
  root.visible = false

  const ring = new THREE.Mesh(ringGeo!, ringMatProto!.clone())
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.03
  ring.renderOrder = 2

  const beam = new THREE.Mesh(beamGeo!, beamMatProto!.clone())
  beam.position.y = BEAM_HEIGHT / 2 + 0.04
  beam.renderOrder = 1

  const bob = new THREE.Group()
  const body = new THREE.Mesh(bodyGeo!, crateMaterial())
  body.castShadow = true
  body.receiveShadow = true
  const caps = new THREE.Mesh(capsGeo!, darkMetalMaterial())
  caps.castShadow = true
  bob.add(body, caps)

  const off = CRATE_SIZE / 2 + 0.014
  const faces: Array<[number, number, number, number, number, number]> = [
    [0, 0, off, 0, 0, 0],
    [0, 0, -off, 0, Math.PI, 0],
    [off, 0, 0, 0, Math.PI / 2, 0],
    [-off, 0, 0, 0, -Math.PI / 2, 0],
    [0, off, 0, -Math.PI / 2, 0, 0],
  ]
  for (const [x, y, z, rx, ry, rz] of faces) {
    const d = new THREE.Mesh(decalGeo!, decalMat!)
    d.position.set(x, y, z)
    d.rotation.set(rx, ry, rz)
    d.renderOrder = 3
    bob.add(d)
  }

  root.add(ring, beam, bob)
  return { root, bob, ring, beam }
}

/** Idle animation: hover-bob + slow spin, pulsing ring/beam. Pure visual. */
export function animateCrate(c: CrateVis, t: number, phase: number): void {
  c.bob.position.y = HOVER_HEIGHT + Math.sin(t * 1.7 + phase) * 0.08
  c.bob.rotation.y = t * 0.65 + phase
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.8 + phase)
  const s = 0.92 + 0.14 * pulse
  c.ring.scale.set(s, s, 1)
  c.ring.material.opacity = 0.55 + 0.4 * pulse
  c.beam.material.opacity = 0.4 + 0.2 * pulse
}
