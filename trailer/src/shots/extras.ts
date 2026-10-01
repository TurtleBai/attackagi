import * as THREE from 'three'
import { BAT_SWING_TIME, BUFFS } from '@/game/constants'
import { cueAt, cuesOf } from '../cues'
import { W, H } from '../engine/stage'
import type { Shot } from '../engine/timeline'
import { FONT, PAL, caption, easeOutBack, easeOutCubic, label, seg } from '../engine/type'
import { V, aim, faceTo, fpsCam, handheld, kick, lerp, lookCam, on, robotHead, span, walk } from './kit'

// Two beats the 30 s cut adds: the baseball bat on a charging melee bot, and
// the roguelike pick — three buff cards after a wave, one chosen.

const _a = new THREE.Vector3()

// ── BAT (wave): charge, swing, the bot goes flying ──────────────────────────

const BW = span('batWave')
const HIT = cueAt('batHit')
const SWING = HIT - BAT_SWING_TIME * 0.42
const EYE = V(2, 1.7, 3)

export const batWave: Shot = {
  name: 'batWave', start: BW.start, end: BW.end,
  setup({ S }) {
    const r = S.robots.spawn('melee', V(1.6, 0, -2.6), 0, 3)
    faceTo(r, EYE)
    S.robots.spawn('ranger', V(-4, 0, -9), 0.4, 5)
    S.robots.spawn('tank', V(6, 0, -12), -0.3, 2)
    S.vm.rig.root.visible = true
    S.vm.weapon = 2
    S.vm.charging = true
    S.agi.look.copy(EYE)
    S.vfx.shakeScale = 0.4
    S.accents[0].color.set(0xffd2b0)
    S.accents[0].intensity = 18
    S.accents[0].distance = 10
    S.accents[0].position.set(3, 4, 4)
  },
  update({ S, t, dt }) {
    S.agi.idleGoals(t, 0)
    S.agi.idleGoals(t, 1)
    const R = S.robots.list
    const bot = R[0]
    if (!bot.dead) {
      walk(bot, EYE, 3.2, dt)
      if (t > HIT - 0.35 && bot.state !== 'windup') { bot.state = 'windup'; bot.stateT = 0 }
    } else {
      // knocked back, tumbling away from the swing
      bot.pos.addScaledVector(_a.set(-0.55, 0, -1).normalize(), (bot.data.kb ?? 0) * dt)
      bot.data.kb = (bot.data.kb ?? 0) * Math.exp(-4 * dt)
    }
    for (let i = 1; i < R.length; i++) walk(R[i], EYE, 1.4, dt)
    const vm = S.vm
    if (t < SWING) {
      vm.charging = true
      vm.charge = Math.min(1, seg(t, BW.start, SWING - 0.1))
    }
    if (on(t, SWING, dt)) vm.swing(1)
    if (on(t, HIT, dt)) {
      const hp = robotHead(bot).add(V(0, -0.4, 0))
      S.vfx.onBatHit({ pos: hp, charged: 1 })
      bot.hitFlash = 1
      S.robots.kill(bot, { tip: 1, roll: -0.5 })
      bot.data.kb = 9
      S.vfx.onEnemyDeath({ pos: bot.pos.clone(), kind: 'melee' })
      S.vfx.trauma = 0.5
    }
    const look = aim(EYE, robotHead(bot, _a).add(V(0, -0.5, 0)))
    const lean = t >= SWING ? Math.sin(seg(t, SWING, SWING + 0.35) * Math.PI) : 0
    fpsCam(S, V(EYE.x - lean * 0.15, EYE.y - lean * 0.05, EYE.z - lean * 0.25), look.yaw - lean * 0.1, Math.max(look.pitch, -0.15), 78, lean * 0.05)
    handheld(S, t, 0.004, 2)
    kick(S, t, t - HIT, 0.05, 8, 30)
  },
  draw({ o, t }) {
    label(o, t, BW.start + 0.05, BW.end, 'BASEBALL BAT  ·  HOLD TO CHARGE', PAL.fire, 110, H - 120)
  },
}

// ── BUFFS: pick one of three after the wave ─────────────────────────────────

const BF = span('buffs')
const CARD_T = cuesOf('uiCard').map((c) => c.t)
const PICK = cueAt('uiPick')
const CARDS = [BUFFS.hollowPoints, BUFFS.slugger, BUFFS.arsonist]
const PICKED = 1

function roundRect(o: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  o.beginPath()
  o.moveTo(x + r, y)
  o.arcTo(x + w, y, x + w, y + h, r)
  o.arcTo(x + w, y + h, x, y + h, r)
  o.arcTo(x, y + h, x, y, r)
  o.arcTo(x, y, x + w, y, r)
  o.closePath()
}

function wrap(o: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (o.measureText(next).width > maxW && cur) { lines.push(cur); cur = w } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

export const buffs: Shot = {
  name: 'buffs', start: BF.start, end: BF.end,
  setup({ S }) {
    S.agi.look.set(0, 2, 12)
    S.vfx.shakeScale = 0
    const c = S.crates[0]
    c.root.visible = true
    c.root.position.set(-3, 0, 2)
  },
  update({ S, t, lt }) {
    S.agi.idleGoals(t, 0)
    S.agi.idleGoals(t, 1)
    // the game freezes the fight behind the pick: slow drift, dimmed
    lookCam(S, V(lerp(4, 2.5, lt / 1.5), 2.4, 12), V(0, 11, -40), 48)
    const g = S.grade
    g.u('uExposure').value = 0.55
    g.u('uSat').value = 0.55
    g.u('uVig').value = 0.85
  },
  draw({ o, t }) {
    caption(o, t, BF.start + 0.05, BF.end, [['PICK A POWER-UP', PAL.white], ['AFTER EVERY WAVE.', PAL.hazard]], { size: 84, y: H * 0.17, align: 'center' })
    const cw = 400, ch = 470, gap = 46
    const x0 = W / 2 - (cw * 3 + gap * 2) / 2
    const y0 = H * 0.36
    const picked = t >= PICK
    CARDS.forEach((b, i) => {
      const k = easeOutBack(seg(t, CARD_T[i], CARD_T[i] + 0.22))
      if (k <= 0) return
      const sel = picked && i === PICKED
      const dim = picked && i !== PICKED ? 1 - 0.65 * seg(t, PICK, PICK + 0.12) : 1
      const pop = sel ? 1 + 0.06 * easeOutCubic(seg(t, PICK, PICK + 0.15)) : 1
      const x = x0 + i * (cw + gap)
      const y = y0 + (1 - k) * 80
      o.save()
      o.globalAlpha = Math.min(1, k) * dim
      o.translate(x + cw / 2, y + ch / 2)
      o.scale(pop, pop)
      o.translate(-cw / 2, -ch / 2)
      roundRect(o, 0, 0, cw, ch, 14)
      o.fillStyle = 'rgba(10,12,20,0.9)'
      o.fill()
      o.lineWidth = sel ? 4 : 2
      o.strokeStyle = sel ? '#fcd34d' : 'rgba(252,211,77,0.35)'
      if (sel) { o.shadowColor = '#fcd34d'; o.shadowBlur = 30 }
      o.stroke()
      o.shadowBlur = 0
      o.textAlign = 'center'
      o.font = '110px "Apple Color Emoji", "Noto Color Emoji", sans-serif'
      o.textBaseline = 'middle'
      o.fillText(b.icon, cw / 2, 140)
      o.font = `700 34px ${FONT.hud}`
      ;(o as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '5px'
      o.fillStyle = '#fde68a'
      o.fillText(b.name.toUpperCase(), cw / 2, 270)
      o.font = `500 28px ${FONT.hud}`
      ;(o as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '1px'
      o.fillStyle = 'rgba(225,232,250,0.85)'
      wrap(o, b.desc, cw - 60).forEach((ln, j) => o.fillText(ln, cw / 2, 330 + j * 38))
      if (sel) {
        o.font = `700 24px ${FONT.hud}`
        ;(o as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '8px'
        o.fillStyle = '#fcd34d'
        o.fillText('SELECTED', cw / 2, ch - 44)
      }
      o.restore()
    })
  },
}
