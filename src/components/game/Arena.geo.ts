'use client'
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Arena-owned geometry builders. Everything modeled with real silhouette relief:
// chamfered boxes, extruded jersey profiles, greebled racks, beveled parapets.

/** Multiply the uv attribute in place (texture tiling baked into geometry). */
export function scaleUvs(geo: THREE.BufferGeometry, sx: number, sy = sx): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv) return geo
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy)
  uv.needsUpdate = true
  return geo
}

/**
 * Box with chamfered edges all around (silhouette-changing bevel, not a plain box).
 * Origin at the center of the base (sits on y=0), dims exactly w×h×d.
 */
export function bevelBox(w: number, h: number, d: number, bevel = 0.05, uvScale = 1): THREE.BufferGeometry {
  const b = Math.min(bevel, w / 4, h / 4, d / 4)
  const shape = new THREE.Shape()
  const hw = w / 2 - b, hh = h / 2 - b
  shape.moveTo(-hw, -hh)
  shape.lineTo(hw, -hh)
  shape.lineTo(hw, hh)
  shape.lineTo(-hw, hh)
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 1,
  })
  geo.translate(0, h / 2, -(d - 2 * b) / 2)
  scaleUvs(geo, uvScale)
  geo.computeVertexNormals()
  return geo
}

/** Extruded jersey-barrier profile, length along X, base at y=0. */
export function jerseyGeometry(length: number, uvScale = 0.55): THREE.BufferGeometry {
  const s = new THREE.Shape()
  s.moveTo(-0.40, 0)
  s.lineTo(-0.40, 0.09)
  s.lineTo(-0.24, 0.31)
  s.lineTo(-0.13, 1.00)
  s.lineTo(-0.08, 1.07)
  s.lineTo(0.08, 1.07)
  s.lineTo(0.13, 1.00)
  s.lineTo(0.24, 0.31)
  s.lineTo(0.40, 0.09)
  s.lineTo(0.40, 0)
  s.closePath()
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: length - 0.05, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 1,
  })
  geo.translate(0, 0.02, -(length - 0.05) / 2)
  geo.rotateY(Math.PI / 2) // length along X
  scaleUvs(geo, uvScale)
  geo.computeVertexNormals()
  return geo
}

function nonIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return g.index ? g.toNonIndexed() : g
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, uvScale = 1, ry = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  scaleUvs(g, uvScale)
  if (ry) g.rotateY(ry)
  g.translate(x, y, z)
  return nonIndexed(g)
}

/**
 * Dead server rack, one merged geometry (dark panel family): chamfered body,
 * proud frame rails, horizontal vent fins, side handles, feet. ~1.15×2.15×0.85.
 * Front face is +Z. Base at y=0.
 */
export function rackGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(nonIndexed(bevelBox(1.15, 2.06, 0.82, 0.035, 0.85).translate(0, 0.08, 0)))
  // frame rails proud of the front face
  const fz = 0.44
  parts.push(box(0.09, 2.02, 0.06, -0.52, 1.11, fz, 0.5))
  parts.push(box(0.09, 2.02, 0.06, 0.52, 1.11, fz, 0.5))
  parts.push(box(1.13, 0.09, 0.06, 0, 2.09, fz, 0.5))
  parts.push(box(1.13, 0.09, 0.06, 0, 0.14, fz, 0.5))
  // horizontal vent fins across the lower front
  for (let i = 0; i < 6; i++) {
    parts.push(box(0.86, 0.045, 0.05, -0.05, 0.30 + i * 0.115, fz + 0.005, 0.3))
  }
  // blade slots upper front (inset lips)
  for (let i = 0; i < 4; i++) {
    parts.push(box(0.86, 0.03, 0.045, -0.05, 1.30 + i * 0.16, fz, 0.3))
  }
  // side handles + top cable tray
  parts.push(box(0.05, 0.26, 0.14, -0.62, 1.55, 0.1, 0.3))
  parts.push(box(0.05, 0.26, 0.14, 0.62, 1.55, 0.1, 0.3))
  parts.push(box(0.7, 0.09, 0.5, 0.05, 2.185, -0.08, 0.5))
  // feet
  for (const [fx, fzz] of [[-0.48, 0.32], [0.48, 0.32], [-0.48, -0.32], [0.48, -0.32]] as const) {
    parts.push(box(0.12, 0.09, 0.12, fx, 0.045, fzz, 0.4))
  }
  const merged = mergeGeometries(parts, false)!
  merged.computeVertexNormals()
  return merged
}

/**
 * Wide low octagonal pillar (concrete family): base slab, tapered body,
 * chamfer cap. Circumradius ≈1.5, height ≈1.68, base at y=0.
 */
export function pillarGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const oct = (rTop: number, rBot: number, h: number, y: number, uv: number) => {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, 8, 1)
    scaleUvs(g, uv, uv)
    g.rotateY(Math.PI / 8)
    g.translate(0, y + h / 2, 0)
    return nonIndexed(g)
  }
  parts.push(oct(1.5, 1.56, 0.2, 0, 2.2))
  parts.push(oct(1.30, 1.38, 1.28, 0.2, 1.6))
  parts.push(oct(1.40, 1.44, 0.14, 1.48, 2.2))
  parts.push(oct(1.24, 1.40, 0.06, 1.62, 2.2)) // top chamfer ring
  const merged = mergeGeometries(parts, false)!
  merged.computeVertexNormals()
  return merged
}

/** Octagonal hazard band that wraps the pillar body. */
export function pillarBandGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1.40, 1.42, 0.30, 8, 1, true)
  g.rotateY(Math.PI / 8)
  g.translate(0, 0.62, 0)
  scaleUvs(g, 6, 1)
  return g
}

/** Thin emissive trim ring under the pillar cap. */
export function pillarGlowGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1.375, 1.385, 0.035, 8, 1, true)
  g.rotateY(Math.PI / 8)
  g.translate(0, 1.47, 0)
  return g
}

/**
 * Parapet segment (dark panel family): beveled body + wider chamfered cap +
 * two vertical ribs. Width along X, inner face −Z, base at y=0.
 */
export function parapetGeometry(segW: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  parts.push(nonIndexed(bevelBox(segW, 0.92, 0.52, 0.04, 0.55)))
  parts.push(nonIndexed(bevelBox(segW + 0.22, 0.20, 0.70, 0.05, 0.55).translate(0, 0.92, 0)))
  parts.push(box(0.16, 0.9, 0.60, -segW / 2 + 0.10, 0.45, 0, 0.6))
  parts.push(box(0.16, 0.9, 0.60, segW / 2 - 0.10, 0.45, 0, 0.6))
  const merged = mergeGeometries(parts, false)!
  merged.computeVertexNormals()
  return merged
}

/** Radar dish: shallow lathe paraboloid, opening along +Y before tilting. */
export function dishGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = []
  for (let i = 0; i <= 10; i++) {
    const r = (i / 10) * 1.05
    pts.push(new THREE.Vector2(r, r * r * 0.34))
  }
  const g = new THREE.LatheGeometry(pts, 20)
  g.computeVertexNormals()
  return g
}
