'use client'
import { ArenaAmbient } from './Arena.ambient'
import { ArenaEnviron } from './Arena.env'
import { ArenaFloor } from './Arena.floor'
import { ArenaObstacles } from './Arena.obstacles'

// Arena module: war-scarred sci-fi launch platform floating over a city abyss.
// - Arena.floor: displaced disc + custom shader detail (markings, seam glow, scorch)
// - Arena.env: parapet ring, under-trusses, void gradient, skyline, clouds,
//   stars, radar dish, flickering rim lights
// - Arena.obstacles: cover registration on world + modeled instanced meshes +
//   collapse destruction with dust puffs
// - Arena.ambient: drifting dust motes + rising embers

export function Arena() {
  return (
    <>
      <ArenaFloor />
      <ArenaEnviron />
      <ArenaObstacles />
      <ArenaAmbient />
    </>
  )
}
