import * as THREE from 'three'
import type { Enemy, EnemyKind } from '@/game/types'
import { getKindRig, SCREEN_PLACEMENT, type KindRig } from './Enemies.bodies'
import { ATLAS_GRID, LOGO_COUNT, logoAtlasTexture, logoCellOffset } from './Enemies.decals'
import { DYING_TIME, GLOW, LASER, LAND_TIME, poseBody } from './Enemies.pose'

// Trailer robot crowd. The game renders robots by posing ONE shared template
// rig per kind and copying matrices into InstancedMeshes; a trailer shows at
// most ~25 robots, so each robot here is a deep clone of the same template
// (shared geometry, per-robot material clones for hit flash + glow) posed by
// the verbatim game posing code. The logo head-screen uses the game's screen
// shader (Enemies.instanced.ts) as a per-mesh material.

const SCREEN_VERT = /* glsl */ `
uniform vec2 uCell;
varying vec2 vUv;
void main(){
  vUv = uv / ${ATLAS_GRID.toFixed(1)} + uCell;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const SCREEN_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uTint;
uniform float uTime;
uniform float uGlow;
uniform float uSeed;
varying vec2 vUv;
void main(){
  float mark = texture2D(uAtlas, vUv).a;
  float scan = 0.92 + 0.08 * sin(vUv.y * 620.0 - uTime * 3.0);
  float flick = 0.94 + 0.06 * sin(uTime * 9.0 + uSeed) * sin(uTime * 23.0 + uSeed * 1.7);
  float g = max(uGlow, 0.0) * scan * flick;
  vec3 col = uTint * (0.12 + 2.0 * mark) * g;
  gl_FragColor = vec4(col, 1.0);
}`

export interface Robot extends Enemy {
  group: THREE.Group
  rig: KindRig
  flashMats: THREE.MeshStandardMaterial[]
  glowMats: Record<string, THREE.MeshStandardMaterial[]>
  screenMat: THREE.ShaderMaterial
  laser: THREE.Mesh | null
  /** falling: vertical velocity (m/s); gravity 26 like the game */
  vy: number
  /** trailer: freeze AI-free robots in place (no walk speed integration) */
  logo: number
  /** shot-scripted aim point override for ranger/sniper/head tracking */
  dead: boolean
}

let nextId = 1

const _cell = { x: 0, y: 0 }

export class RobotCrowd {
  readonly group = new THREE.Group()
  readonly list: Robot[] = []
  /** shot hook: robot touched down (fall landing / drone wreck impact) */
  onLand: ((r: Robot) => void) | undefined

  reset(): void {
    for (const r of this.list) {
      this.group.remove(r.group)
      if (r.laser) this.group.remove(r.laser)
    }
    this.list.length = 0
    this.onLand = undefined
  }

  spawn(kind: EnemyKind, pos: THREE.Vector3, yaw: number, logo?: number): Robot {
    const tpl = getKindRig(kind)
    const clone = tpl.group.clone(true)
    const nodes: Record<string, THREE.Object3D> = {}
    for (const name of Object.keys(tpl.nodes)) {
      const n = clone.getObjectByName(name)
      if (n) nodes[name] = n
    }
    const rig: KindRig = { kind, group: clone, nodes, base: tpl.base, parts: [], glowKeys: tpl.glowKeys }
    const flashMats: THREE.MeshStandardMaterial[] = []
    const glowMats: Record<string, THREE.MeshStandardMaterial[]> = {}
    clone.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      const key = (m.userData.matKey as string | undefined) ?? 'dark'
      const mat = (m.material as THREE.MeshStandardMaterial).clone()
      m.material = mat
      if (key.startsWith('glow:')) {
        const g = key.slice(5)
        ;(glowMats[g] ??= []).push(mat)
        mat.userData.baseGlow = mat.emissiveIntensity
        m.castShadow = false
      } else {
        mat.emissive = new THREE.Color(1, 1, 1)
        mat.emissiveIntensity = 0
        flashMats.push(mat)
      }
    })
    const sp = SCREEN_PLACEMENT[kind]
    const id = nextId++
    const li = logo ?? id % LOGO_COUNT
    logoCellOffset(li, _cell)
    const screenMat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: logoAtlasTexture() },
        uTint: { value: new THREE.Color(sp.tint) },
        uTime: { value: 0 },
        uGlow: { value: 1 },
        uSeed: { value: _cell.x * 21 + _cell.y * 47 },
        uCell: { value: new THREE.Vector2(_cell.x, _cell.y) },
      },
      vertexShader: SCREEN_VERT,
      fragmentShader: SCREEN_FRAG,
    })
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(sp.w, sp.h), screenMat)
    screen.position.set(sp.x, sp.y, sp.z)
    nodes.head?.add(screen)

    let laser: THREE.Mesh | null = null
    if (kind === 'sniper') {
      const lm = new THREE.MeshBasicMaterial({ color: 0x38ff7a, transparent: true, toneMapped: false, opacity: 0 })
      lm.color.multiplyScalar(2.2)
      laser = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), lm)
      laser.visible = false
      laser.frustumCulled = false
      this.group.add(laser)
    }

    const outer = new THREE.Group()
    outer.add(clone)
    clone.traverse((o) => { o.frustumCulled = false })
    this.group.add(outer)
    const r: Robot = {
      id, kind, pos: pos.clone(), vel: new THREE.Vector3(), yaw,
      hp: 1, maxHp: 1, radius: 0.5, height: 2,
      state: kind === 'sniper' ? 'track' : 'chase', stateT: 0, hitFlash: 0,
      shieldActive: kind === 'tank', falling: false,
      data: { phase: id * 1.7, logo: li },
      group: outer, rig, flashMats, glowMats, screenMat, laser, vy: 0, logo: li, dead: false,
    }
    this.list.push(r)
    return r
  }

  remove(r: Robot): void {
    this.group.remove(r.group)
    if (r.laser) this.group.remove(r.laser)
    const i = this.list.indexOf(r)
    if (i >= 0) this.list.splice(i, 1)
  }

  /** Begin the game's death collapse (deathTip/roll seeded like Enemies.tsx). */
  kill(r: Robot, opts?: { tip?: number; roll?: number }): void {
    r.hp = 0
    r.state = 'dying'
    r.stateT = 0
    r.dead = true
    r.data.deathTip = opts?.tip ?? (Math.random() < 0.5 ? 1 : -1) * (0.85 + Math.random() * 0.3)
    r.data.deathRoll = opts?.roll ?? (Math.random() - 0.5) * 0.9
    r.data.impacted = r.kind === 'drone' ? 0 : 1
    r.data.fallT = 0
  }

  /** Drop from a hand: falls with gravity, lands with squash + optional callback. */
  drop(r: Robot, fromY: number): void {
    r.falling = true
    r.pos.y = fromY
    r.vy = 0
  }

  update(step: number, time: number, onLand = this.onLand): void {
    for (const r of [...this.list]) {
      // fall
      if (r.falling) {
        r.vy -= 26 * step
        r.pos.y += r.vy * step
        const floor = r.kind === 'drone' ? (r.data.hoverY ?? 8) : 0
        if (r.pos.y <= floor) {
          r.pos.y = floor
          r.falling = false
          r.data.landT = LAND_TIME
          onLand?.(r)
        }
      }
      if ((r.data.landT ?? 0) > 0) r.data.landT = Math.max(0, (r.data.landT ?? 0) - step)
      // dying drone: tumble-fall until floor
      if (r.dead && r.kind === 'drone' && r.data.impacted !== 1) {
        r.data.fallT = (r.data.fallT ?? 0) + step
        r.vy -= 26 * 0.8 * step
        r.pos.y += r.vy * step
        r.pos.x += (r.data.vx ?? 0) * step
        r.pos.z += (r.data.vz ?? 0) * step
        r.data.vx = (r.data.vx ?? 0) * Math.exp(-1.2 * step)
        r.data.vz = (r.data.vz ?? 0) * Math.exp(-1.2 * step)
        r.stateT = 0
        if (r.pos.y <= 0.2) {
          r.pos.y = 0.2
          r.data.impacted = 1
          onLand?.(r)
        }
      } else if (r.dead) r.stateT += step
      else r.stateT += step
      r.hitFlash = Math.max(0, r.hitFlash - step * 6)

      const flash = poseBody(r, r.rig, step, true)
      // root group transform comes from poseBody (it writes rig.group position/rotation)
      for (const m of r.flashMats) m.emissiveIntensity = flash * 0.9
      for (const key of r.rig.glowKeys) {
        for (const m of r.glowMats[key] ?? []) m.emissiveIntensity = (m.userData.baseGlow as number) * (GLOW[key] ?? 1)
      }
      r.screenMat.uniforms.uGlow.value = GLOW.screen ?? 1
      r.screenMat.uniforms.uTime.value = time
      if (r.laser) {
        const lm = r.laser.material as THREE.MeshBasicMaterial
        r.laser.visible = LASER.on
        if (LASER.on) {
          const a = new THREE.Vector3(LASER.ax, LASER.ay, LASER.az)
          const b = new THREE.Vector3(LASER.bx, LASER.by, LASER.bz)
          const len = a.distanceTo(b)
          r.laser.position.copy(a).lerp(b, 0.5)
          r.laser.lookAt(b)
          r.laser.scale.set(0.025, 0.025, len)
          lm.opacity = LASER.opacity * 1.6
        }
      }
      if (r.dead && r.stateT > DYING_TIME + 0.4) r.group.visible = false
    }
  }
}
