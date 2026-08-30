'use client'
import { Canvas, useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer, N8AO, Vignette } from '@react-three/postprocessing'
import { Suspense } from 'react'
import * as THREE from 'three'
import { events } from '@/game/events'
import { useSettings } from '@/game/settings'
import { useGame } from '@/game/store'
import { world } from '@/game/world'
import { Agi } from './Agi'
import { Arena } from './Arena'
import { Director } from './Director'
import { Enemies } from './Enemies'
import { Player } from './Player'
import { Projectiles } from './Projectiles'
import { Vfx } from './Vfx'
import { Weapons } from './Weapons'

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

function Lighting() {
  return (
    <>
      {/* deliberately restrained key light — surface depth must come from the
          texture-authored shading, AO and normal detail, not from blasting lumens */}
      <directionalLight
        position={[24, 42, 18]}
        intensity={1.35}
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
      <hemisphereLight args={[0x33415e, 0x1a1410, 0.55]} />
      <directionalLight position={[-30, 18, -40]} intensity={0.25} color={0x6e8cff} />
    </>
  )
}

export default function GameCanvas() {
  // 'smooth' (default): 20% fewer pixels, no AO pass, lighter bloom — for frame
  // rate. 'pretty': the full pipeline. Toggled in the pause menu.
  const smooth = useSettings((s) => s.quality) === 'smooth'
  return (
    <Canvas
      shadows
      dpr={smooth ? [1, 1.2] : [1, 1.5]}
      camera={{ fov: 78, near: 0.08, far: 400, position: [0, 1.7, 10] }}
      // canvas MSAA is wasted work: every frame ends as the composer's
      // fullscreen quad — AA comes from EffectComposer multisampling instead
      gl={{ powerPreference: 'high-performance', antialias: false }}
      onCreated={({ gl, scene, camera }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        scene.background = new THREE.Color(0x0b0e1a)
        scene.fog = new THREE.Fog(0x0b0e1a, 70, 260)
        if (process.env.NODE_ENV === 'development') {
          // dev-only debug/profiling handle (console: window.__game)
          ;(window as unknown as Record<string, unknown>).__game = { gl, scene, camera, world, store: useGame, events }
        }
      }}
    >
      <WorldClock />
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
      {/* multisampling 4 (default is 8) halves MSAA resolve cost on the HDR
          buffer at near-identical edge quality; Bloom levels 6 (default 8)
          drops the two smallest, barely-visible mip passes */}
      {smooth ? (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur levels={5} luminanceThreshold={1.0} intensity={0.85} />
          <Vignette darkness={0.72} offset={0.28} />
        </EffectComposer>
      ) : (
        <EffectComposer multisampling={4}>
          <N8AO aoRadius={2.2} intensity={3.2} distanceFalloff={1} quality="performance" halfRes />
          <Bloom mipmapBlur levels={6} luminanceThreshold={1.0} intensity={0.85} />
          <Vignette darkness={0.72} offset={0.28} />
        </EffectComposer>
      )}
    </Canvas>
  )
}
