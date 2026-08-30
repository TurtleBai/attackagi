'use client'
import { Canvas, useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer, N8AO, Vignette } from '@react-three/postprocessing'
import { Suspense } from 'react'
import * as THREE from 'three'
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
function WorldClock() {
  useFrame((_, dt) => {
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
        shadow-mapSize={[2048, 2048]}
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
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 78, near: 0.08, far: 400, position: [0, 1.7, 10] }}
      gl={{ powerPreference: 'high-performance' }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        scene.background = new THREE.Color(0x0b0e1a)
        scene.fog = new THREE.Fog(0x0b0e1a, 70, 260)
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
      <EffectComposer>
        <N8AO aoRadius={2.2} intensity={3.2} distanceFalloff={1} quality="medium" />
        <Bloom mipmapBlur luminanceThreshold={1.0} intensity={0.85} />
        <Vignette darkness={0.72} offset={0.28} />
      </EffectComposer>
    </Canvas>
  )
}
