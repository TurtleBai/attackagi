'use client'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { ARENA_RADIUS, FRAME_PRIO } from '@/game/constants'
import { events } from '@/game/events'
import { groundTextureSet } from '@/game/gfx/materials'
import { tierKnobs } from '@/game/quality'
import { useGame } from '@/game/store'
import { floorDetailNormal, floorOverlayTexture, floorScorchTexture } from './Arena.textures'

// War-scarred launch-platform floor. High-segment disc, displacement from the
// shared ground height canvas, plus onBeforeCompile injection: painted-marking
// overlay, close-range detail normals, and a post-smash scorch pass (char
// darkening + glowing crack veins).
//
// FLOOR_LITE (potato, structural knob read at mount): strips the detail-normal
// blend (its distance fade is ~0 beyond 16m anyway) and both scorch texture
// taps from the program — post-smash char becomes a flat uniform-only
// darkening. The define changes the compiled program, so the program cache key
// MUST vary with it (a constant key would reuse the full program across tiers).

const FLOOR_VISUAL_RADIUS = ARENA_RADIUS + 0.9
const MAP_REPEAT = 12 // ground tile ≈ 7.15m, internal panel cells ≈ 1.79m

interface FloorUniforms {
  uOverlay: { value: THREE.Texture }
  uScorch: { value: number }
  uScorchGlow: { value: number }
  uTime: { value: number }
  /** only present (and only sampled) when FLOOR_LITE is off */
  uScorchTex?: { value: THREE.Texture }
  uDetailNormal?: { value: THREE.Texture }
}

function buildFloor() {
  // STRUCTURAL knob — read once at mount, applies on canvas (re)mount.
  const floorLite = tierKnobs().floorLite
  const set = groundTextureSet()
  const displacement = new THREE.CanvasTexture(set.heightCanvas)
  displacement.wrapS = displacement.wrapT = THREE.RepeatWrapping

  const geometry = new THREE.RingGeometry(0.03, FLOOR_VISUAL_RADIUS, 256, 64)
  geometry.rotateX(-Math.PI / 2) // planar uv: x → world X, y → world −Z
  // bake the base-map tiling into the uvs (shared textures stay untouched);
  // arena-space maps (overlay/scorch) sample vArenaUv = uv / MAP_REPEAT
  const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setXY(i, uvAttr.getX(i) * MAP_REPEAT, uvAttr.getY(i) * MAP_REPEAT)
  }

  const uniforms: FloorUniforms = {
    uOverlay: { value: floorOverlayTexture() },
    uScorch: { value: 0 },
    uScorchGlow: { value: 0 },
    uTime: { value: 0 },
  }
  if (!floorLite) {
    // lite skips generating these canvases entirely (never sampled there)
    uniforms.uScorchTex = { value: floorScorchTexture() }
    uniforms.uDetailNormal = { value: floorDetailNormal() }
  }

  const material = new THREE.MeshStandardMaterial({
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.roughnessMap,
    displacementMap: displacement,
    displacementScale: 0.15,
    displacementBias: -0.075,
    metalness: 0.06,
    roughness: 1.0,
    color: 0x8b9099, // night-time tint: keep the dusty concrete dark + cool
    normalScale: new THREE.Vector2(1.15, 1.15),
  })
  // mutate (never replace) defines: MeshStandardMaterial ships { STANDARD: '' }
  if (floorLite) material.defines = { ...material.defines, FLOOR_LITE: '' }
  // CRITICAL: the key must vary with the define or the cached program built
  // for one tier gets reused verbatim for the other.
  material.customProgramCacheKey = () => (floorLite ? 'arenaFloor|lite' : 'arenaFloor')
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vArenaUv;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vArenaUv = uv / ${MAP_REPEAT.toFixed(1)};`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uOverlay;
        #ifndef FLOOR_LITE
        uniform sampler2D uScorchTex;
        uniform sampler2D uDetailNormal;
        #endif
        uniform float uScorch;
        uniform float uScorchGlow;
        uniform float uTime;
        varying vec2 vArenaUv;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        // painted markings + grime, mapped once across the disc
        vec4 arenaOv = texture2D(uOverlay, vArenaUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, arenaOv.rgb, arenaOv.a * 0.9);
        #ifndef FLOOR_LITE
        // post-smash scorch: char darkening + dark crack cores
        vec4 arenaSc = texture2D(uScorchTex, vArenaUv);
        float arenaChar = arenaSc.r * uScorch;
        float arenaVein = arenaSc.g * uScorch;
        diffuseColor.rgb *= 1.0 - clamp(arenaChar * 0.72 + arenaVein * 0.55, 0.0, 0.9);
        #else
        // potato post-smash: flat uniform-only char (no texture taps)
        diffuseColor.rgb *= 1.0 - uScorch * 0.5;
        #endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #ifndef FLOOR_LITE
        // blend a second, higher-frequency detail normal at close range
        {
          vec3 dtl = texture2D(uDetailNormal, vArenaUv * 120.0).xyz * 2.0 - 1.0;
          float dFade = (1.0 - smoothstep(4.0, 16.0, length(vViewPosition))) * 0.55;
          vec3 dView = (viewMatrix * vec4(dtl.x, 0.0, -dtl.y, 0.0)).xyz;
          normal = normalize(normal + dView * dFade);
        }
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifndef FLOOR_LITE
        {
          // glowing crack veins after the smash, cooling to embers
          totalEmissiveRadiance += vec3(1.0, 0.30, 0.05) * arenaVein * uScorchGlow;
        }
        #endif`,
      )
  }
  return { geometry, material, uniforms }
}

export function ArenaFloor() {
  const { geometry, material, uniforms } = useMemo(buildFloor, [])
  const runId = useGame((s) => s.runId)
  const scorch = useRef({ target: 0, glow: 0 })

  useEffect(() => {
    return events.on('smashImpact', () => {
      scorch.current.target = 1
      scorch.current.glow = 3.4
    })
  }, [])

  useEffect(() => {
    // hard reset on run restart
    scorch.current.target = 0
    scorch.current.glow = 0
    uniforms.uScorch.value = 0
    uniforms.uScorchGlow.value = 0
  }, [runId, uniforms])

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05)
    uniforms.uTime.value += step
    const s = scorch.current
    // visual-only lerps (run in every phase)
    uniforms.uScorch.value += (s.target - uniforms.uScorch.value) * Math.min(1, step * 2.4)
    const glowFloor = s.target > 0 ? 0.16 : 0
    s.glow = Math.max(glowFloor, s.glow * Math.exp(-step * 0.55))
    uniforms.uScorchGlow.value = s.glow
  }, FRAME_PRIO.vfx)

  return (
    <mesh geometry={geometry} material={material} receiveShadow />
  )
}
