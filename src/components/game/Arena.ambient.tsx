'use client'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { ARENA_RADIUS, FRAME_PRIO } from '@/game/constants'
import { seededRandom } from '@/game/gfx/textures'
import { tierKnobs } from '@/game/quality'
import { dotTexture } from './Arena.textures'

// Ambient life: soft additive dust motes drifting over the whole arena and
// occasional embers rising near the rim. Pure visual — animates in every phase.
// Counts are STRUCTURAL tier knobs (read once at mount): tierKnobs().dustCount
// / .emberCount. Dust sprites clamp gl_PointSize to 40px so near-camera motes
// can't balloon into huge additive fill quads.

function buildDust() {
  const N = tierKnobs().dustCount
  const pos = new Float32Array(N * 3)
  const seed = new Float32Array(N)
  const rnd = seededRandom(60601)
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2
    const r = Math.sqrt(rnd()) * (ARENA_RADIUS + 4)
    pos[i * 3] = Math.cos(a) * r
    pos[i * 3 + 1] = rnd() * 11
    pos[i * 3 + 2] = Math.sin(a) * r
    seed[i] = rnd() * 100
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uMap: { value: dotTexture() } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      varying float vA;
      void main() {
        vec3 p = position;
        float sf = fract(aSeed * 0.173);
        float t = uTime * (0.3 + 0.35 * sf);
        p.x += sin(t + aSeed * 1.37) * 1.5;
        p.z += cos(t * 0.83 + aSeed * 0.91) * 1.5;
        p.y = mod(p.y + uTime * (0.14 + sf * 0.2), 11.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = max(1.0, -mv.z);
        gl_PointSize = min((2.4 + fract(aSeed * 0.53) * 3.0) * (16.0 / dist), 40.0);
        vA = smoothstep(0.0, 1.4, p.y) * (1.0 - smoothstep(7.5, 11.0, p.y));
        vA *= 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (0.8 + sf) + aSeed * 2.0));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying float vA;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        gl_FragColor = vec4(vec3(0.50, 0.57, 0.72) * a * vA * 0.32, 0.0);
      }`,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  return { points, mat }
}

function buildEmbers() {
  const N = tierKnobs().emberCount // 64 on every tier today — embers stay
  const pos = new Float32Array(N * 3)
  const seed = new Float32Array(N)
  const rnd = seededRandom(70707)
  for (let i = 0; i < N; i++) {
    // bias toward the rim, where the burning-city glow would come from
    const a = rnd() * Math.PI * 2
    const r = (0.55 + rnd() * 0.5) * ARENA_RADIUS
    pos[i * 3] = Math.cos(a) * r
    pos[i * 3 + 1] = rnd() * 9
    pos[i * 3 + 2] = Math.sin(a) * r
    seed[i] = rnd() * 100
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uMap: { value: dotTexture() } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      varying float vA;
      void main() {
        vec3 p = position;
        float sf = fract(aSeed * 0.311);
        p.y = mod(p.y + uTime * (0.55 + sf * 0.7), 9.0);
        p.x += sin(uTime * (0.7 + sf) + aSeed) * 0.8;
        p.z += cos(uTime * (0.6 + sf * 0.8) + aSeed * 1.7) * 0.8;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = max(1.0, -mv.z);
        gl_PointSize = (2.0 + sf * 2.2) * (20.0 / dist);
        // flicker + fade out as it rises
        vA = (1.0 - smoothstep(5.0, 9.0, p.y)) * smoothstep(0.0, 0.6, p.y);
        vA *= 0.55 + 0.45 * sin(uTime * (6.0 + sf * 5.0) + aSeed * 3.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying float vA;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        gl_FragColor = vec4(vec3(1.9, 0.75, 0.22) * a * max(vA, 0.0), 0.0);
      }`,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  return { points, mat }
}

export function ArenaAmbient() {
  const dust = useMemo(buildDust, [])
  const embers = useMemo(buildEmbers, [])
  const t = useRef(0)

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05)
    t.current += step
    dust.mat.uniforms.uTime.value = t.current
    embers.mat.uniforms.uTime.value = t.current
  }, FRAME_PRIO.vfx)

  return (
    <>
      <primitive object={dust.points} />
      <primitive object={embers.points} />
    </>
  )
}
