'use client'
import * as THREE from 'three'
import { crateTextures, groundTextures, panelTextures } from './textures'

// Shared material factories — one coherent look across modules. Materials are cached;
// callers must NOT mutate shared instances (clone first for per-instance tweaks like
// hit-flash emissive).

const cache = new Map<string, THREE.Material>()

function cached<T extends THREE.Material>(key: string, make: () => T): T {
  const hit = cache.get(key)
  if (hit) return hit as T
  const m = make()
  cache.set(key, m)
  return m
}

/** Robot chassis: worn painted metal, normal-mapped panels + rivets. Clone per enemy for hit flash. */
export function chassisMaterial(tintHex = 0xffffff): THREE.MeshStandardMaterial {
  return cached(`chassis:${tintHex}`, () => {
    const t = panelTextures('chassis')
    return new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
      color: tintHex, metalness: 0.55, roughness: 1.0,
      normalScale: new THREE.Vector2(1, 1),
    })
  })
}

/** Dark structural metal: joints, weapons, boss arms, obstacle frames. */
export function darkMetalMaterial(): THREE.MeshStandardMaterial {
  return cached('darkMetal', () => {
    const t = panelTextures('dark')
    return new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
      metalness: 0.75, roughness: 1.0, normalScale: new THREE.Vector2(0.8, 0.8),
    })
  })
}

/** Boss hull plating. */
export function bossHullMaterial(): THREE.MeshStandardMaterial {
  return cached('bossHull', () => {
    const t = panelTextures('boss')
    return new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
      metalness: 0.6, roughness: 1.0, normalScale: new THREE.Vector2(1.2, 1.2),
    })
  })
}

export function crateMaterial(): THREE.MeshStandardMaterial {
  return cached('crate', () => {
    const t = crateTextures()
    return new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
      metalness: 0.05, roughness: 1.0, normalScale: new THREE.Vector2(1.1, 1.1),
    })
  })
}

export function groundTextureSet() {
  return groundTextures()
}

/** Unlit emissive glow (lasers, eyes, indicators). Not cached — cheap. */
export function emissiveMaterial(color: THREE.ColorRepresentation, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: opacity < 1, opacity,
    toneMapped: false, // keep neon punch through tone mapping for bloom
  })
}

/** Standard material with emissive core — glowing-but-lit surfaces (enemy eyes housings etc.) */
export function glowMetal(color: THREE.ColorRepresentation, intensity = 2): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0x111318, metalness: 0.6, roughness: 0.4,
    emissive: new THREE.Color(color), emissiveIntensity: intensity,
  })
  return m
}
