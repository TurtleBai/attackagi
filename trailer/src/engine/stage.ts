import * as THREE from 'three'
import {
  BloomEffect, EffectComposer, EffectPass, RenderPass,
} from 'postprocessing'
import { N8AOPostPass } from 'n8ao'
import { world } from '@/game/world'
import { AgiController } from '../port/components/Agi.controller'
import { buildDust, buildEmbers } from '../port/components/Arena.ambient'
import { buildEnv } from '../port/components/Arena.env'
import { buildFloor } from '../port/components/Arena.floor'
import { ObstacleField } from '../port/components/Arena.obstacles'
import { animateCrate, makeCrate, type CrateVis } from '../port/components/Director.crate'
import { ProjectileSystem } from '../port/components/Projectiles.visuals'
import { RobotCrowd } from '../port/components/Robots'
import { ViewModel } from '../port/components/ViewModel'
import { VfxSystems } from '../port/components/Vfx.systems'
import { GradeEffect } from './grade'

// One scene, one camera, every ported system — reset per shot and stepped by
// the timeline with a fixed dt. Render pipeline mirrors GameCanvas.tsx on the
// 'pretty' tier (N8AO → Bloom), then a trailer grade pass does the game's ACES
// + 1.18 exposure, the 2D overlay composite and the motion-design treatments.

export const W = 1920
export const H = 1080

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _e = new THREE.Euler()

export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(78, W / H, 0.05, 900)
  readonly composer: EffectComposer
  readonly grade: GradeEffect
  readonly bloom: BloomEffect
  readonly ao: N8AOPostPass
  readonly overlayCanvas: HTMLCanvasElement
  readonly overlay: CanvasRenderingContext2D
  readonly overlayTex: THREE.CanvasTexture

  readonly agi = new AgiController()
  readonly robots = new RobotCrowd()
  readonly vm = new ViewModel()
  readonly vfx = new VfxSystems()
  readonly proj = new ProjectileSystem()
  readonly obstacles = new ObstacleField()
  readonly floor = buildFloor()
  readonly env = buildEnv()
  readonly dust = buildDust()
  readonly embers = buildEmbers()
  readonly crates: CrateVis[] = []
  readonly key: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly fill: THREE.DirectionalLight
  /** shot-owned props (speedloader, casings, bombs…) hidden on every reset */
  readonly props: THREE.Object3D[] = []
  /** shot-owned accent lights (reset to off every shot) */
  readonly accents: THREE.PointLight[] = []
  /** scorch state (Arena.floor smash response) */
  scorchTarget = 0
  scorchGlow = 0
  private idleAcc = 0

  constructor(canvas: HTMLCanvasElement) {
    const r = new THREE.WebGLRenderer({
      canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
      stencil: false, depth: true,
    })
    r.setPixelRatio(1)
    r.setSize(W, H, false)
    r.toneMapping = THREE.NoToneMapping // ACES lives in the grade pass
    r.shadowMap.enabled = true
    r.shadowMap.type = THREE.PCFShadowMap
    this.renderer = r

    const scene = this.scene
    scene.background = new THREE.Color(0x0b0e1a)
    scene.fog = new THREE.Fog(0x0b0e1a, 70, 260)

    // ── lighting (GameCanvas.tsx Lighting, shadow map doubled for 1080p stills)
    const key = new THREE.DirectionalLight(0xfff2df, 1.6)
    key.position.set(24, 42, 18)
    key.castShadow = true
    key.shadow.mapSize.set(3072, 3072)
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.03
    const sc = key.shadow.camera
    sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.far = 140
    scene.add(key, key.target)
    this.key = key
    this.hemi = new THREE.HemisphereLight(0x3d4c6e, 0x241d16, 0.85)
    scene.add(this.hemi)
    this.fill = new THREE.DirectionalLight(0x6e8cff, 0.35)
    this.fill.position.set(-30, 18, -40)
    scene.add(this.fill)
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 2)
      l.visible = true
      this.accents.push(l)
      scene.add(l)
    }

    // ── world
    const floorMesh = new THREE.Mesh(this.floor.geometry, this.floor.material)
    floorMesh.receiveShadow = true
    scene.add(floorMesh)
    scene.add(this.env.group, this.obstacles.group, this.dust.points, this.embers.points)
    for (const l of this.env.lights) l.light.castShadow = false
    scene.add(this.agi.root, this.robots.group, this.proj.group, this.vfx.group)
    for (let i = 0; i < 3; i++) {
      const c = makeCrate()
      this.crates.push(c)
      scene.add(c.root)
    }
    scene.add(this.camera)
    this.vm.attach(this.camera)

    // ── overlay canvas (typography + motion graphics)
    this.overlayCanvas = document.createElement('canvas')
    this.overlayCanvas.width = W
    this.overlayCanvas.height = H
    this.overlay = this.overlayCanvas.getContext('2d')!
    this.overlayTex = new THREE.CanvasTexture(this.overlayCanvas)
    this.overlayTex.colorSpace = THREE.SRGBColorSpace
    this.overlayTex.minFilter = THREE.LinearFilter
    this.overlayTex.generateMipmaps = false

    // ── post chain
    const composer = new EffectComposer(r, { frameBufferType: THREE.HalfFloatType, multisampling: 4 })
    composer.addPass(new RenderPass(scene, this.camera))
    const ao = new N8AOPostPass(scene, this.camera, W, H)
    ao.configuration.aoRadius = 2.2
    ao.configuration.intensity = 3.2
    ao.configuration.distanceFalloff = 1
    ao.configuration.gammaCorrection = false
    ao.setQualityMode('High')
    composer.addPass(ao)
    this.ao = ao
    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.2, intensity: 0.85, radius: 0.8, levels: 7 })
    composer.addPass(new EffectPass(this.camera, this.bloom))
    this.grade = new GradeEffect(this.overlayTex)
    composer.addPass(new EffectPass(this.camera, this.grade))
    this.composer = composer
    this.reset()
  }

  /** Back to a neutral wave-phase world (every shot starts from here). */
  reset(): void {
    world.reset()
    this.agi.reset()
    this.robots.reset()
    this.vm.reset()
    this.vm.rig.root.visible = false
    this.vfx.reset()
    this.vfx.shakeScale = 1
    this.proj.reset()
    this.obstacles.reset()
    this.scorchTarget = 0
    this.scorchGlow = 0
    this.floor.uniforms.uScorch.value = 0
    this.floor.uniforms.uScorchGlow.value = 0
    for (const c of this.crates) c.root.visible = false
    for (const p of this.props) p.visible = false
    this.vm.enabled = true
    const root = this.vm.rig.root
    root.position.set(0, 0, 0)
    root.quaternion.identity()
    for (const l of this.accents) { l.intensity = 0; l.distance = 30 }
    this.key.intensity = 1.6
    this.hemi.intensity = 0.85
    this.fill.intensity = 0.35
    this.agi.root.visible = true
    this.env.group.visible = true
    this.camera.fov = 78
    this.camera.near = 0.05
    this.camera.up.set(0, 1, 0)
    this.camera.updateProjectionMatrix()
    this.bloom.intensity = 0.85
    this.vfx.telegraphGain = 1
    const g = this.grade
    g.u('uExposure').value = 1.0
    g.u('uAces').value = 0
    g.u('uChroma').value = 0.35
    g.u('uGlitch').value = 0
    g.u('uScan').value = 0.12
    g.u('uGrain').value = 0.12
    g.u('uVig').value = 0.55
    g.u('uFade').value = 0
    g.u('uLetter').value = 0
    ;(g.u('uFlash').value as THREE.Vector3).set(0, 0, 0)
    ;(g.u('uTint').value as THREE.Vector3).set(1, 1, 1)
    g.u('uSat').value = 1.08
    g.u('uOverlayChroma').value = 0
    this.idleAcc = 0
  }

  /** Post-smash floor: char + glowing veins (instant, for shots after the impact). */
  scorchNow(glow = 1.2): void {
    this.scorchTarget = 1
    this.scorchGlow = glow
    this.floor.uniforms.uScorch.value = 1
    this.floor.uniforms.uScorchGlow.value = glow
  }

  smashImpact(): void {
    this.scorchTarget = 1
    this.scorchGlow = 3.4
    this.obstacles.collapse()
    this.vfx.onSmashImpact()
  }

  /** Advance every visual system one fixed step (after the shot wrote its state). */
  step(t: number, dt: number): void {
    world.time = t
    world.player.pos.set(this.camera.position.x, 0, this.camera.position.z)
    this.agi.update(t, dt, this.camera)
    world.agi.headPos.copy(this.agi.headPos)
    world.agi.mode = this.agi.mode
    this.robots.update(dt, t)
    this.proj.update(dt, t)
    world.step()
    this.obstacles.update(dt, t, this.camera)
    this.vm.update(dt, this.camera)
    // floor scorch (Arena.floor frame loop)
    const fu = this.floor.uniforms
    fu.uTime.value = t
    fu.uScorch.value += (this.scorchTarget - fu.uScorch.value) * Math.min(1, dt * 2.4)
    const glowFloor = this.scorchTarget > 0 ? 0.16 : 0
    this.scorchGlow = Math.max(glowFloor, this.scorchGlow * Math.exp(-dt * 0.55))
    fu.uScorchGlow.value = this.scorchGlow
    // ambient
    this.dust.mat.uniforms.uTime.value = t
    this.embers.mat.uniforms.uTime.value = t
    for (let i = 0; i < this.crates.length; i++) if (this.crates[i].root.visible) animateCrate(this.crates[i], t, i * 1.9)
    this.envIdle(t, dt)
    // vfx last: reads world + applies camera shake on top of the shot camera
    this.camera.updateMatrixWorld()
    const pxScale = H / 900
    this.vfx.update(dt, this.camera, pxScale)
    this.camera.updateMatrixWorld()
    this.grade.u('uTime').value = t
  }

  /** Arena.env idle animation (radar, rim flicker, beacons, cloud billboards). */
  private envIdle(t: number, dt: number): void {
    const b = this.env
    b.beaconMat.uniforms.uTime.value = t
    b.radarHead.rotation.y = t * 0.45
    for (const f of b.lights) {
      const n = 0.5 + 0.5 * Math.sin(t * 11 + f.phase + Math.sin(t * 23 + f.phase * 3) * 1.6)
      f.light.intensity = f.base * (0.66 + 0.34 * n)
    }
    this.idleAcc += dt
    const cloudsIM = b.cloudsIM
    if (cloudsIM) {
      const cam = this.camera
      for (let i = 0; i < b.clouds.length; i++) {
        const c = b.clouds[i]
        const ang = c.angle + c.speed * t
        const x = Math.cos(ang) * c.radius
        const z = Math.sin(ang) * c.radius
        _q.setFromEuler(_e.set(0, Math.atan2(cam.position.x - x, cam.position.z - z), 0))
        cloudsIM.setMatrixAt(i, _m.compose(_p.set(x, c.y, z), _q, _s.set(1, 1, 1)))
      }
      cloudsIM.instanceMatrix.needsUpdate = true
    }
  }

  render(): void {
    this.overlayTex.needsUpdate = true
    this.composer.render(1 / 60)
  }
}
