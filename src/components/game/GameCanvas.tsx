'use client'
import { Canvas, useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer, N8AO, Vignette } from '@react-three/postprocessing'
import { Suspense, useRef } from 'react'
import * as THREE from 'three'
import { events } from '@/game/events'
import { TIER_KNOBS } from '@/game/quality'
import { useSettings } from '@/game/settings'
import { simRunning, useGame } from '@/game/store'
import { touchInput } from '@/game/touch'
import { world } from '@/game/world'
import { AdaptiveQuality, FrameScheduler } from './AdaptiveQuality'
import { Agi } from './Agi'
import { Arena } from './Arena'
import { Director } from './Director'
import { Enemies } from './Enemies'
import { Player } from './Player'
import { Projectiles } from './Projectiles'
import { Vfx } from './Vfx'
import { Weapons } from './Weapons'
import { useResolvedTier } from './useResolvedTier'

// Advances the shared simulation clock exactly once per frame, before every system.
// Frozen while paused / picking buffs so absolute-time timers (telegraphs, sniper
// cycles, reload & dodge cooldowns) don't burn down behind the menu.
function WorldClock() {
  useFrame((_, dt) => {
    const phase = useGame.getState().phase
    if (phase === 'paused' || phase === 'buffSelect') return
    world.time += Math.min(dt, 0.05)
  }, -1000)
  return null
}

// Shadow maps at half frame rate: gl.shadowMap.autoUpdate is off (onCreated),
// so the shadow pass only runs on frames where we raise needsUpdate — every
// 2nd frame during sim (30Hz at 60fps: imperceptible with PCFSoft+normalBias,
// halves shadow-pass cost), every frame on the already-throttled non-sim
// phases so menu backdrops never show a stale/empty map.
function ShadowTick() {
  const parity = useRef(false)
  useFrame(({ gl }) => {
    parity.current = !parity.current
    if (parity.current || !simRunning(useGame.getState().phase)) gl.shadowMap.needsUpdate = true
  }, -1) // after all sim/render-sync systems, right before the render pass
  return null
}

function Lighting() {
  return (
    <>
      {/* deliberately restrained key light — surface depth must come from the
          texture-authored shading, AO and normal detail, not from blasting lumens */}
      <directionalLight
        position={[24, 42, 18]}
        intensity={1.6}
        color={0xfff2df}
        castShadow
        // 1536 keeps PCFSoft shadows visually equivalent at 44% less shadow-map
        // fill. Frustum stays ±55: enemies dropped from the AGI's hands high
        // above the rim must keep their shadows (no pop-in), so don't tighten.
        shadow-mapSize={[1536, 1536]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-camera-left={-55}
        shadow-camera-right={55}
        shadow-camera-top={55}
        shadow-camera-bottom={-55}
        shadow-camera-far={140}
      />
      <hemisphereLight args={[0x3d4c6e, 0x241d16, 0.85]} />
      <directionalLight position={[-30, 18, -40]} intensity={0.35} color={0x6e8cff} />
    </>
  )
}

export default function GameCanvas() {
  // Everything render-pipeline is driven from the tier knobs (quality.ts).
  // potato: no composer at all (direct render, CSS vignette in GameShell),
  // no shadows, 0.75–1.0 dpr. smooth/pretty share ONE mounted EffectComposer;
  // N8AO toggles via its `enabled` prop and Bloom levels/MSAA via props, so a
  // smooth↔pretty switch never remounts the composer branch.
  const tier = useResolvedTier()
  const knobs = TIER_KNOBS[tier]
  // adaptive controller's render-scale override (exact dpr inside the band)
  const adaptiveDpr = useSettings((s) => s.adaptiveDpr)
  // frameloop as a prop so R3F re-configures agree with the FrameScheduler
  // instead of stomping it back to 'always'
  const frameloop = useGame((s) => (simRunning(s.phase) ? 'always' : 'demand') as 'always' | 'demand')
  return (
    <Canvas
      shadows={knobs.shadows}
      frameloop={frameloop}
      dpr={adaptiveDpr ?? knobs.dpr}
      camera={{ fov: 78, near: 0.08, far: 400, position: [0, 1.7, 10] }}
      // canvas MSAA is wasted work: every frame ends as the composer's
      // fullscreen quad — AA comes from EffectComposer multisampling instead
      gl={{ powerPreference: 'high-performance', antialias: false }}
      onCreated={({ gl, scene, camera }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.18 // global lift — night mood, but readable
        // shadow maps render only when ShadowTick raises needsUpdate (30Hz in sim)
        gl.shadowMap.autoUpdate = false
        gl.shadowMap.needsUpdate = true
        scene.background = new THREE.Color(0x0b0e1a)
        scene.fog = new THREE.Fog(0x0b0e1a, 70, 260)
        if (process.env.NODE_ENV === 'development') {
          // dev-only debug/profiling handle (console: window.__game)
          ;(window as unknown as Record<string, unknown>).__game = { gl, scene, camera, world, store: useGame, events, touch: touchInput }
        }
      }}
    >
      <WorldClock />
      <ShadowTick />
      <FrameScheduler />
      <AdaptiveQuality />
      <Lighting />
      <Suspense fallback={null}>
        <Arena />
        <Player />
        <Weapons />
        <Enemies />
        <Agi />
        <Projectiles />
        <Vfx />
      </Suspense>
      <Director />
      {/* multisampling 4 on pretty (default 8) halves MSAA resolve cost on the
          HDR buffer at near-identical edge quality; Bloom levels 6 (default 8)
          drops the two smallest, barely-visible mip passes. On smooth the N8AO
          pass stays mounted but disabled (skipped by the composer), msaa 0,
          Bloom levels 5. potato skips the composer entirely. */}
      {knobs.composer && (
        <EffectComposer multisampling={knobs.msaa}>
          <N8AO
            enabled={knobs.ao}
            aoRadius={2.2}
            intensity={3.2}
            distanceFalloff={1}
            quality="performance"
            halfRes
          />
          <Bloom mipmapBlur levels={knobs.bloomLevels} luminanceThreshold={1.0} intensity={0.85} />
          <Vignette darkness={0.58} offset={0.24} />
        </EffectComposer>
      )}
    </Canvas>
  )
}
