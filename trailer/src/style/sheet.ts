import * as THREE from 'three'
import { crateTextures, groundTextures, panelTextures } from '@/game/gfx/textures'
import type { EnemyKind } from '@/game/types'
import { setPose } from '../port/components/Agi.controller'
import { concreteMaps, floorOverlayTexture, hazardStripeTexture } from '../port/components/Arena.textures'
import { Stage, W, H } from '../engine/stage'
import {
  FACE_COLOR, FONT, PAL, glitchText, hudLine, pixelFace, stripes, type FaceId,
} from '../engine/type'

// Style frame board (3840×2160): every hero asset rendered through the real
// trailer stage (same ported models, materials, lights, post chain), plus the
// palette and type system. Rendered once before any scene work to lock the look.

const BW = 3840
const BH = 2160

type Setup = (S: Stage) => void

function shoot(S: Stage, setup: Setup, opts: { steps?: number; t0?: number; update?: (S: Stage, t: number) => void } = {}): HTMLCanvasElement {
  S.reset()
  setup(S)
  const steps = opts.steps ?? 40
  const t0 = opts.t0 ?? 3
  for (let i = 0; i < steps; i++) {
    const t = t0 + i / 60
    opts.update?.(S, t)
    S.step(t, 1 / 60)
  }
  S.overlay.clearRect(0, 0, W, H)
  S.render()
  return S.renderer.domElement
}

function place(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, w: number, h: number, crop?: [number, number, number, number]): void {
  const [sx, sy, sw, sh] = crop ?? (() => {
    // cover-fit the 16:9 render into the cell
    const ar = w / h
    const sar = W / H
    if (ar > sar) { const ch = W / ar; return [0, (H - ch) / 2, W, ch] as [number, number, number, number] }
    const cw = H * ar
    return [(W - cw) / 2, 0, cw, H] as [number, number, number, number]
  })()
  ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h)
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 2
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, sub?: string): void {
  ctx.save()
  ctx.font = `700 24px ${FONT.hud}`
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '4px'
  ctx.fillStyle = PAL.phosphor
  ctx.textBaseline = 'top'
  ctx.fillText(title, x, y)
  if (sub) {
    ctx.font = `500 18px ${FONT.hud}`
    ctx.fillStyle = 'rgba(220,230,255,0.55)'
    ctx.fillText(sub, x, y + 32)
  }
  ctx.restore()
}

function look(S: Stage, pos: [number, number, number], at: [number, number, number], fov = 50): void {
  S.camera.position.set(...pos)
  S.camera.fov = fov
  S.camera.updateProjectionMatrix()
  S.camera.lookAt(...at)
}

export async function renderStyleSheet(board: HTMLCanvasElement): Promise<void> {
  board.width = BW
  board.height = BH
  board.style.width = `${BW / 2}px`
  board.style.height = `${BH / 2}px`
  const glCanvas = document.createElement('canvas')
  glCanvas.width = W
  glCanvas.height = H
  const S = new Stage(glCanvas)
  const ctx = board.getContext('2d')!
  ctx.fillStyle = '#070912'
  ctx.fillRect(0, 0, BW, BH)

  // ── header
  glitchText(ctx, 'ATTACK AGI', 60, 120, { size: 96, color: PAL.phosphor, glow: 24, font: FONT.title, tracking: -0.02 })
  glitchText(ctx, 'TRAILER STYLE FRAME  //  15s  1920×1080  60fps', 720, 112, { size: 30, weight: 500, color: 'rgba(220,230,255,0.7)', tracking: 0.1 })
  stripes(ctx, 0, 150, BW, 10, 0, PAL.hazard, 30, 0, 0.8)

  // ── AGI hero (body, hands, tentacles) — low angle from the deck
  const hero = shoot(S, (s) => {
    s.agi.look.set(-6, 1.7, 14)
    s.agi.arms[0].goal.set(-16, 9, -40); s.agi.arms[1].goal.set(15, 11, -42)
    setPose(s.agi.arms[0], 'open'); setPose(s.agi.arms[1], 'grip')
    s.agi.cargoCount[1] = 5
    s.agi.snapArms()
    look(s, [-6, 1.2, 14], [0, 21, -60], 46)
  }, { steps: 90 })
  place(ctx, hero, 60, 200, 1920, 1080)
  label(ctx, 84, 1210, 'THE AGI', 'monitor head · greebled hull · reactor · telescoping arms · eldritch tentacles')

  // ── CRT faces
  const faces: Array<[FaceId | 'off', string]> = [
    ['happy', ':)  WAITING'], ['angry', '>:(  ATTACKING'], ['hurt', ":'(  HIT"],
    ['tired', ':|  TIRED'], ['surprised', ':0  DYING'], ['off', 'POWER-OFF'],
  ]
  const fw = 560, fh = 315
  faces.forEach(([f, name], i) => {
    const col = i % 3, row = Math.floor(i / 3)
    const x = 2040 + col * (fw + 20), y = 200 + row * (fh + 70)
    const img = shoot(S, (s) => {
      s.agi.look.set(0, 27, -40)
      if (f === 'off') { s.agi.faceMode = 'happy'; s.agi.powerOff = 0.62 }
      else s.agi.faceMode = f
      if (f === 'angry') s.agi.mode = 'fighting'
      if (f === 'tired') s.agi.mode = 'tired'
      look(s, [0, 27.6, -42], [0, 27.4, -64], 30)
    }, { steps: 60, t0: 1.0 })
    place(ctx, img, x, y, fw, fh)
    label(ctx, x + 12, y + fh + 10, name)
  })

  // ── hands: cargo drop + morphs
  const hands = shoot(S, (s) => {
    s.agi.arms[1].goal.set(6, 13, -22); setPose(s.agi.arms[1], 'grip'); s.agi.cargoCount[1] = 5
    s.agi.arms[0].goal.set(-7, 14, -24); s.agi.arms[0].weapon = 'minigun'; s.agi.arms[0].morphGoal = 1
    s.agi.arms[0].aim = new THREE.Vector3(2, 1, 6)
    s.agi.snapArms()
    look(s, [1, 11, -11], [-0.5, 13.2, -23], 50)
  }, { steps: 120 })
  place(ctx, hands, 2040, 970, 850, 310)
  label(ctx, 2052, 1288, 'ARTICULATED HANDS', '4-finger grip w/ cargo bots · minigun morph')
  const cannon = shoot(S, (s) => {
    const a = s.agi.arms[1]
    a.goal.set(9, 16, -26); a.weapon = 'cannon'; a.morphGoal = 1; a.charge = 0.8
    a.aim = new THREE.Vector3(0, 0, 4)
    s.agi.snapArms()
    look(s, [16, 11, -10], [9, 17, -26], 40)
  }, { steps: 120 })
  place(ctx, cannon, 2910, 970, 870, 310)
  label(ctx, 2922, 1288, 'DEATH-BEAM CANNON', 'charge sphere · instakill sweep')

  // ── robots
  const kinds: Array<[EnemyKind, string, string]> = [
    ['melee', 'MELEE', 'power sword · red logo face'],
    ['ranger', 'RANGER', 'rifle · cyan visor strip'],
    ['tank', 'TANK', 'riot shield · amber slab'],
    ['sniper', 'SNIPER', 'scope lens · laser sight'],
    ['drone', 'DRONE', 'purple quad-rotor bomber'],
  ]
  const rw = 728, rh = 410
  kinds.forEach(([k, name, sub], i) => {
    const x = 60 + i * (rw + 20), y = 1370
    const img = shoot(S, (s) => {
      const r = s.robots.spawn(k, new THREE.Vector3(0, k === 'drone' ? 1.3 : 0, 0), 0.35, [1, 0, 4, 2, 6][i])
      if (k === 'sniper') r.state = 'idle'
      s.agi.root.visible = false
      s.accents[0].position.set(2.5, 2.5, 3)
      s.accents[0].color.set(0xb8c8ff)
      s.accents[0].intensity = 6
      s.accents[0].distance = 12
      if (k === 'drone') look(s, [0.9, 1.0, 2.4], [0, 1.6, 0], 36)
      else look(s, [1.3, 1.25, 4.3], [0, 1.0, 0], 34)
    }, { steps: 30 })
    place(ctx, img, x, y, rw, rh)
    label(ctx, x + 12, y + rh + 10, name, sub)
  })

  // ── weapons (product shots: view-model groups reparented in front of the camera)
  const weapons: Array<['pistol' | 'bat' | 'molotov', string, string]> = [
    ['pistol', 'REVOLVER', 'full-auto · red-dot · swing-out cylinder'],
    ['bat', 'BASEBALL BAT', 'charged swing glow'],
    ['molotov', 'MOLOTOV', 'lit rag · burns you too'],
  ]
  const ww = 610, wh = 300
  weapons.forEach(([wk, name, sub], i) => {
    const x = 60 + i * (ww + 20), y = 1880
    const img = shoot(S, (s) => {
      s.agi.root.visible = false
      s.env.group.visible = false
      s.vm.enabled = false
      const rig = s.vm.rig
      const g = wk === 'pistol' ? rig.pistol.group : wk === 'bat' ? rig.bat.group : rig.molotov.group
      const holder = new THREE.Group()
      holder.name = 'turntable'
      s.scene.add(holder)
      holder.add(g)
      g.visible = true
      g.position.set(0, 0, 0)
      if (wk === 'pistol') { g.rotation.set(0, Math.PI / 2 + 0.35, 0); holder.position.set(0, 50, 0) }
      if (wk === 'bat') { g.rotation.set(0, 0, Math.PI / 2 - 0.25); holder.position.set(0.32, 50, 0) ; rig.bat.mat.emissiveIntensity = 0.5; rig.bat.shell.visible = true; rig.bat.shellMat.opacity = 0.25 }
      if (wk === 'molotov') { g.rotation.set(0, 0.6, 0.1); holder.position.set(0, 49.97, 0) }
      s.accents[0].position.set(0.6, 50.6, 0.9); s.accents[0].intensity = 3; s.accents[0].distance = 4; s.accents[0].color.set(0xfff0dd)
      s.accents[1].position.set(-0.8, 50.2, -0.6); s.accents[1].intensity = 2; s.accents[1].distance = 4; s.accents[1].color.set(0x6e8cff)
      const d = wk === 'bat' ? 1.25 : wk === 'pistol' ? 0.55 : 0.5
      look(s, [0, 50.05, d], [0, 50.02 + (wk === 'molotov' ? 0.0 : 0.04), 0], 30)
    }, { steps: 8, update: (s) => { const f = s.vm.rig.molotov; f.flameMat.uniforms.uFlick.value = 1 } })
    place(ctx, img, x, y, ww, wh)
    label(ctx, x + 12, y + wh - 70, name, sub)
    // put the group back on the view model
    const rig = S.vm.rig
    const g = wk === 'pistol' ? rig.pistol.group : wk === 'bat' ? rig.bat.group : rig.molotov.group
    rig.sway.add(g)
    S.vm.enabled = true
    S.scene.remove(S.scene.getObjectByName('turntable')!)
  })

  // ── rooftop materials (flat maps) + in-situ rooftop render
  const mats: Array<[CanvasImageSource, string]> = [
    [groundTextures().map.image as HTMLCanvasElement, 'HELIPAD CONCRETE'],
    [floorOverlayTexture().image as HTMLCanvasElement, 'PAINTED MARKINGS'],
    [hazardStripeTexture().image as HTMLCanvasElement, 'HAZARD STRIPE'],
    [concreteMaps().map.image as HTMLCanvasElement, 'BARRIER CONCRETE'],
    [panelTextures('boss').map.image as HTMLCanvasElement, 'BOSS HULL'],
    [panelTextures('chassis').map.image as HTMLCanvasElement, 'ROBOT CHASSIS'],
    [crateTextures().map.image as HTMLCanvasElement, 'CRATE WOOD'],
  ]
  const ms = 132
  mats.forEach(([img, name], i) => {
    const x = 1980 + (i % 4) * (ms + 24), y = 1880 + Math.floor(i / 4) * (ms + 10)
    ctx.save()
    ctx.fillStyle = name === 'PAINTED MARKINGS' ? '#4a4d55' : '#000'
    ctx.fillRect(x, y, ms, ms)
    ctx.drawImage(img, x, y, ms, ms)
    ctx.restore()
    ctx.font = `500 13px ${FONT.hud}`
    ctx.fillStyle = 'rgba(220,230,255,0.6)'
    ctx.fillText(name, x, y + ms - 6)
  })

  // ── palette
  const pal: Array<[string, string]> = [
    [PAL.sky, 'NAVY SKY'], [PAL.city, 'CITY LIGHTS'], [PAL.concrete, 'CONCRETE'], [PAL.hazard, 'HAZARD'],
    [PAL.phosphor, 'PHOSPHOR'], [PAL.alarm, 'ALARM'], [PAL.drone, 'DRONE'], [PAL.fire, 'FIRE'],
    [PAL.hurt, "HURT :'("], [PAL.tired, 'TIRED :|'],
  ]
  pal.forEach(([c, n], i) => {
    const x = 2620 + (i % 5) * 120, y = 1880 + Math.floor(i / 5) * 140
    ctx.fillStyle = c
    ctx.fillRect(x, y, 104, 80)
    ctx.font = `500 13px ${FONT.hud}`
    ctx.fillStyle = 'rgba(220,230,255,0.7)'
    ctx.fillText(n, x, y + 100)
    ctx.fillStyle = 'rgba(220,230,255,0.4)'
    ctx.fillText(c.toUpperCase(), x, y + 118)
  })

  // ── type system
  const tx = 3250
  glitchText(ctx, 'AIM FOR', tx, 1930, { size: 64, color: PAL.white, glitch: 0.5, t: 1.3, glow: 12 })
  glitchText(ctx, 'THE LOGO.', tx, 1990, { size: 64, color: PAL.phosphor, glitch: 0.2, t: 2.1, glow: 18 })
  hudLine(ctx, tx + 30, 2040, 'DRONE//', '17 M/S DIVE', { t: 0, size: 18, color: PAL.drone })
  hudLine(ctx, tx + 30, 2070, 'BEAM//', 'INSTAKILL · 1/3 ARENA', { t: 0, size: 18, color: PAL.alarm })
  for (let i = 0; i < 5; i++) {
    const f = (['happy', 'angry', 'hurt', 'tired', 'surprised'] as FaceId[])[i]
    pixelFace(ctx, f, tx + 40 + i * 110, 2120, 3, FACE_COLOR[f], 0, 8)
  }
}
