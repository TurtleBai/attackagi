'use client'
// AudioSystem.engine.ts — fully procedural WebAudio synthesis engine for Attack AGI.
// No audio assets: oscillators, two pre-generated noise buffers (white + pink,
// reused by every one-shot), biquad filters and short exponential envelopes.
// Signal chain: voices → master gain (~0.45) → DynamicsCompressor → destination.
// Owned by the AudioSystem module.

import {
  DEATHBEAM_SWEEP_TIME, MINIGUN_FIRE_TIME, MINIGUN_SPINUP, MOLOTOV_RADIUS,
} from '@/game/constants'
import { world } from '@/game/world'

const MASTER_GAIN = 0.45
const AMBIENT_DUCK_LEVEL = 0.6 // ≈40% reduction while ducked
const AMBIENT_DUCK_TIME = 0.8
const MIN_ENV = 0.0008 // exponential-ramp floor (can't ramp to 0)

interface Vec3Like { x: number; y: number; z: number }

interface FilterOpts {
  type: BiquadFilterType
  from: number
  to?: number
  sweepT?: number
  q?: number
}

interface BurstOpts {
  t0?: number
  dur: number
  gain: number
  attack?: number
  /** seconds to hold peak after attack before the exponential decay */
  hold?: number
  pink?: boolean
  rate?: number
  filter?: FilterOpts
  dest?: AudioNode
}

interface ToneOpts {
  t0?: number
  type: OscillatorType
  from: number
  to?: number
  sweepT?: number
  dur: number
  gain: number
  attack?: number
  hold?: number
  detune?: number
  lowpass?: number
  dest?: AudioNode
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private white: AudioBuffer | null = null
  private pink: AudioBuffer | null = null
  private ambient: GainNode | null = null
  private lastPlay = new Map<string, number>()
  private muted = false
  private shimmer: { g: GainNode; oscs: OscillatorNode[]; dinged: boolean } | null = null

  hasContext(): boolean { return this.ctx !== null }
  ready(): boolean { return this.ctx !== null && this.ctx.state === 'running' }

  /** Create the context lazily (call from a user gesture). Safe to call repeatedly. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    this.ctx = ctx
    const master = ctx.createGain()
    master.gain.value = this.muted ? 0 : MASTER_GAIN
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 18
    comp.ratio.value = 5
    comp.attack.value = 0.004
    comp.release.value = 0.24
    master.connect(comp)
    comp.connect(ctx.destination)
    this.master = master
    this.white = this.makeNoise(false)
    this.pink = this.makeNoise(true)
    this.startAmbient()
    if (ctx.state === 'suspended') void ctx.resume()
  }

  /** Soft-mute (used on component unmount so a remount doesn't need a new context). */
  setMuted(m: boolean): void {
    this.muted = m
    if (!this.ctx || !this.master) return
    const t = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(t)
    this.master.gain.setTargetAtTime(m ? 0 : MASTER_GAIN, t, 0.05)
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private live(): boolean {
    return this.ctx !== null && this.master !== null && this.white !== null && this.pink !== null
  }

  private now(): number { return this.ctx!.currentTime }

  /** Rate-limit spammy one-shots (AoE hits, stripe beams, rocket clusters). */
  private gate(key: string, minGap: number): boolean {
    const t = performance.now() / 1000
    const last = this.lastPlay.get(key)
    if (last !== undefined && t - last < minGap) return false
    this.lastPlay.set(key, t)
    return true
  }

  /** Gentle distance rolloff for world-positioned one-shots. */
  private distGain(pos?: Vec3Like | null): number {
    if (!pos) return 1
    const p = world.player.pos
    const dx = pos.x - p.x, dy = pos.y - p.y, dz = pos.z - p.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    return 1 / (1 + d * 0.045)
  }

  private makeNoise(pink: boolean): AudioBuffer {
    const ctx = this.ctx!
    const len = Math.floor(ctx.sampleRate * 1.2)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    if (!pink) {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    } else {
      // Paul Kellet pink-noise filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1
        b0 = 0.99886 * b0 + w * 0.0555179
        b1 = 0.99332 * b1 + w * 0.0750759
        b2 = 0.969 * b2 + w * 0.153852
        b3 = 0.8665 * b3 + w * 0.3104856
        b4 = 0.55 * b4 + w * 0.5329522
        b5 = -0.7616 * b5 - w * 0.016898
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
        b6 = w * 0.115926
      }
    }
    return buf
  }

  private applyEnv(g: GainNode, t0: number, gain: number, attack: number, hold: number, dur: number): void {
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(gain, t0 + attack)
    if (hold > 0) g.gain.setValueAtTime(gain, t0 + attack + hold)
    g.gain.exponentialRampToValueAtTime(MIN_ENV, t0 + dur)
  }

  /** Filtered noise one-shot from a shared buffer (allocation: nodes only). */
  private burst(o: BurstOpts): void {
    const ctx = this.ctx!
    if (o.gain <= 0) return
    const t0 = o.t0 ?? ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = o.pink ? this.pink : this.white
    src.loop = true
    src.playbackRate.value = o.rate ?? 1
    let node: AudioNode = src
    if (o.filter) {
      const f = ctx.createBiquadFilter()
      f.type = o.filter.type
      f.frequency.setValueAtTime(Math.max(20, o.filter.from), t0)
      if (o.filter.to !== undefined) {
        f.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.to), t0 + (o.filter.sweepT ?? o.dur))
      }
      f.Q.value = o.filter.q ?? 0.9
      node.connect(f)
      node = f
    }
    const g = ctx.createGain()
    this.applyEnv(g, t0, o.gain, o.attack ?? 0.002, o.hold ?? 0, o.dur)
    node.connect(g)
    g.connect(o.dest ?? this.master!)
    src.start(t0, Math.random() * 0.5)
    src.stop(t0 + o.dur + 0.05)
  }

  /** Oscillator one-shot with optional frequency sweep + lowpass. */
  private tone(o: ToneOpts): void {
    const ctx = this.ctx!
    if (o.gain <= 0) return
    const t0 = o.t0 ?? ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = o.type
    osc.frequency.setValueAtTime(Math.max(1, o.from), t0)
    if (o.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + (o.sweepT ?? o.dur))
    }
    if (o.detune) osc.detune.value = o.detune
    let node: AudioNode = osc
    if (o.lowpass) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = o.lowpass
      node.connect(f)
      node = f
    }
    const g = ctx.createGain()
    this.applyEnv(g, t0, o.gain, o.attack ?? 0.003, o.hold ?? 0, o.dur)
    node.connect(g)
    g.connect(o.dest ?? this.master!)
    osc.start(t0)
    osc.stop(t0 + o.dur + 0.05)
  }

  /** Bell-like inharmonic partial stack (shield clangs, boss metal). */
  private clang(t0: number, base: number, gain: number, dur = 0.28): void {
    const ratios = [1, 2.76, 5.4, 8.93]
    const gains = [1, 0.62, 0.38, 0.22]
    for (let i = 0; i < ratios.length; i++) {
      this.tone({
        t0, type: 'sine',
        from: base * ratios[i] * (0.99 + Math.random() * 0.02),
        dur: dur * (1 - i * 0.14),
        gain: gain * gains[i],
        attack: 0.001,
      })
    }
  }

  /** Short mechanical click (reload, weapon switch). */
  private mechClick(t0: number, pitch: number, gain: number): void {
    this.burst({ t0, dur: 0.03, gain, filter: { type: 'bandpass', from: 2300 * pitch, q: 2 } })
    this.tone({ t0, type: 'square', from: 1250 * pitch, dur: 0.028, gain: gain * 0.45, lowpass: 4200 })
  }

  /** Shared explosion body; `size` ≈ radius / MOLOTOV_RADIUS. */
  private explosionCore(t0: number, size: number, dg: number, layered: boolean): void {
    // noise boom: lowpass sweeping 800→80
    this.burst({
      t0, dur: 0.55 * size + (layered ? 0.7 : 0), gain: 0.72 * dg, attack: 0.004,
      filter: { type: 'lowpass', from: 800, to: 80, sweepT: 0.42 * size },
    })
    // sub sine drop
    this.tone({ t0, type: 'sine', from: 110, to: 34, sweepT: 0.45 * size, dur: 0.65 * size, gain: 0.62 * dg })
    // dusty rumble tail
    this.burst({
      t0: t0 + 0.05, dur: 0.9 * size, gain: 0.28 * dg, attack: 0.04, pink: true,
      filter: { type: 'lowpass', from: 220, to: 90, sweepT: 0.8 * size },
    })
    if (layered) {
      // secondary detonations + metallic debris
      this.burst({
        t0: t0 + 0.28, dur: 0.8, gain: 0.5 * dg, attack: 0.004,
        filter: { type: 'lowpass', from: 620, to: 70, sweepT: 0.6 },
      })
      this.tone({ t0: t0 + 0.28, type: 'sine', from: 90, to: 30, sweepT: 0.7, dur: 0.9, gain: 0.45 * dg })
      for (let i = 0; i < 5; i++) {
        const tt = t0 + 0.1 + Math.random() * 0.9
        this.burst({
          t0: tt, dur: 0.05 + Math.random() * 0.06, gain: 0.1 * dg,
          filter: { type: 'bandpass', from: 1500 + Math.random() * 2500, q: 3 },
        })
      }
      this.burst({
        t0: t0 + 0.1, dur: 2.0, gain: 0.22 * dg, attack: 0.1, hold: 0.6, pink: true,
        filter: { type: 'lowpass', from: 140 },
      })
    }
  }

  /** Duck the ambient bed ~40% for a beat after big detonations. */
  private duckAmbient(): void {
    if (!this.ctx || !this.ambient) return
    const g = this.ambient.gain
    const t = this.now()
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(AMBIENT_DUCK_LEVEL, t + 0.06)
    g.setValueAtTime(AMBIENT_DUCK_LEVEL, t + AMBIENT_DUCK_TIME)
    g.linearRampToValueAtTime(1, t + AMBIENT_DUCK_TIME + 0.6)
  }

  /** Quiet always-on bed: two detuned saws → LFO'd lowpass, plus wandering wind noise. */
  private startAmbient(): void {
    const ctx = this.ctx!
    const amb = ctx.createGain()
    amb.gain.setValueAtTime(0, ctx.currentTime)
    amb.gain.linearRampToValueAtTime(1, ctx.currentTime + 2.2)
    amb.connect(this.master!)
    this.ambient = amb

    // low drone
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 165
    lp.Q.value = 0.7
    const droneGain = ctx.createGain()
    droneGain.gain.value = 0.05
    lp.connect(droneGain)
    droneGain.connect(amb)
    for (const f of [55, 55.9]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.connect(lp)
      o.start()
    }
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.07
    const lfoG = ctx.createGain()
    lfoG.gain.value = 55
    lfo.connect(lfoG)
    lfoG.connect(lp.frequency)
    lfo.start()

    // faint wind
    const wind = ctx.createBufferSource()
    wind.buffer = this.pink
    wind.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 480
    bp.Q.value = 0.5
    const windGain = ctx.createGain()
    windGain.gain.value = 0.05
    wind.connect(bp)
    bp.connect(windGain)
    windGain.connect(amb)
    const wlfo = ctx.createOscillator()
    wlfo.frequency.value = 0.11
    const wlfoG = ctx.createGain()
    wlfoG.gain.value = 0.024
    wlfo.connect(wlfoG)
    wlfoG.connect(windGain.gain)
    wlfo.start()
    wind.start()
  }

  // ─── Public one-shots (each drops silently until the context exists) ───────

  /** Punchy layered gunshot: highpassed noise crack + 140Hz thump + click transient. */
  shot(): void {
    if (!this.live()) return
    this.burst({
      dur: 0.09, gain: 0.42, rate: 0.9 + Math.random() * 0.25,
      filter: { type: 'highpass', from: 950, q: 0.8 },
    })
    this.tone({ type: 'sine', from: 140, to: 62, sweepT: 0.1, dur: 0.13, gain: 0.5 })
    this.burst({ dur: 0.014, gain: 0.34, filter: { type: 'bandpass', from: 3200, q: 1.3 } })
  }

  /** Two scheduled mechanical clicks: mag out now, mag in at reload end. */
  reload(duration: number): void {
    if (!this.live()) return
    const t0 = this.now()
    this.mechClick(t0, 1, 0.2)
    this.mechClick(t0 + Math.max(0.15, duration - 0.04), 1.3, 0.24)
  }

  /** Filtered-noise whoosh; pitch + intensity scale with charge (0..1). */
  batSwing(charged: number): void {
    if (!this.live()) return
    const c = Math.min(1, Math.max(0, charged))
    this.burst({
      dur: 0.28, gain: 0.16 + 0.26 * c, attack: 0.06, rate: 1 + 0.4 * c,
      filter: { type: 'bandpass', from: 300 + 500 * c, to: 950 + 1500 * c, sweepT: 0.2, q: 1.4 },
    })
  }

  /** Low thud + metallic crunch (always near the player — no distance rolloff). */
  batHit(charged: number): void {
    if (!this.live()) return
    const c = Math.min(1, Math.max(0, charged))
    this.tone({ type: 'sine', from: 100, to: 54, sweepT: 0.12, dur: 0.18, gain: 0.42 + 0.28 * c })
    this.burst({ dur: 0.13, gain: 0.28 + 0.2 * c, filter: { type: 'bandpass', from: 2100, q: 0.8 } })
    this.clang(this.now(), 340 + 120 * c, 0.1 + 0.08 * c, 0.16)
  }

  /**
   * Charge shimmer driven by store.batCharge: rising detuned sine pair 200→900Hz,
   * quiet; soft ready 'ding' once when charge reaches 1. Call with 0 to stop.
   */
  setBatCharge(charge: number): void {
    if (!this.live()) return
    const ctx = this.ctx!
    const t = this.now()
    if (charge <= 0) {
      if (this.shimmer) {
        const s = this.shimmer
        this.shimmer = null
        s.g.gain.cancelScheduledValues(t)
        s.g.gain.setValueAtTime(Math.max(MIN_ENV, s.g.gain.value), t)
        s.g.gain.exponentialRampToValueAtTime(MIN_ENV, t + 0.09)
        for (const o of s.oscs) o.stop(t + 0.14)
      }
      return
    }
    if (!this.shimmer) {
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.connect(this.master!)
      const oscs: OscillatorNode[] = []
      for (const det of [0, 7]) {
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.value = 200
        o.detune.value = det
        o.connect(g)
        o.start(t)
        oscs.push(o)
      }
      this.shimmer = { g, oscs, dinged: false }
    }
    const c = Math.min(1, charge)
    const f = 200 + 700 * c
    for (const o of this.shimmer.oscs) o.frequency.setTargetAtTime(f, t, 0.05)
    this.shimmer.g.gain.setTargetAtTime(0.028 + 0.032 * c, t, 0.08)
    if (c >= 1 && !this.shimmer.dinged) {
      this.shimmer.dinged = true
      this.tone({ type: 'sine', from: 1318, dur: 0.35, gain: 0.16, attack: 0.004 })
      this.tone({ type: 'sine', from: 1976, dur: 0.28, gain: 0.07, attack: 0.004 })
    }
  }

  /** Airy tumbling-bottle whoosh. */
  molotovThrow(): void {
    if (!this.live()) return
    this.burst({
      dur: 0.38, gain: 0.18, attack: 0.08,
      filter: { type: 'bandpass', from: 480, to: 1500, sweepT: 0.32, q: 1.2 },
    })
  }

  /** Whoomp + crackle burst when a fire patch ignites. */
  fireIgnite(pos?: Vec3Like | null): void {
    if (!this.live() || !this.gate('fireIgnite', 0.06)) return
    const dg = this.distGain(pos)
    const t0 = this.now()
    this.tone({ t0, type: 'sine', from: 180, to: 52, sweepT: 0.24, dur: 0.32, gain: 0.42 * dg })
    this.burst({
      t0, dur: 0.4, gain: 0.32 * dg, attack: 0.015,
      filter: { type: 'lowpass', from: 950, to: 280, sweepT: 0.3 },
    })
    for (let i = 0; i < 8; i++) {
      this.burst({
        t0: t0 + Math.random() * 0.6, dur: 0.02 + Math.random() * 0.03, gain: 0.07 * dg,
        filter: { type: 'highpass', from: 2400 + Math.random() * 2200, q: 1.5 },
      })
    }
  }

  /** Big boom, length/weight scaled by radius; kind 'bossDeath' is layered + longer. */
  explosion(pos: Vec3Like | null, radius: number, kind: string): void {
    if (!this.live()) return
    const layered = kind === 'bossDeath'
    if (!layered && !this.gate('explosion', 0.05)) return
    const size = Math.min(2.4, Math.max(0.65, radius / MOLOTOV_RADIUS))
    this.explosionCore(this.now(), layered ? Math.max(size, 2) : size, this.distGain(pos), layered)
    this.duckAmbient()
  }

  /** Short metal tick. */
  enemyHit(pos?: Vec3Like | null): void {
    if (!this.live() || !this.gate('enemyHit', 0.035)) return
    const dg = this.distGain(pos)
    this.burst({
      dur: 0.045, gain: 0.2 * dg, rate: 0.9 + Math.random() * 0.3,
      filter: { type: 'bandpass', from: 2900 + Math.random() * 900, q: 1.6 },
    })
    this.tone({ type: 'triangle', from: 1450 + Math.random() * 500, dur: 0.05, gain: 0.09 * dg })
  }

  /** Crunch + descending buzzy power-down blip. */
  enemyDeath(pos?: Vec3Like | null): void {
    if (!this.live() || !this.gate('enemyDeath', 0.06)) return
    const dg = this.distGain(pos)
    this.burst({
      dur: 0.18, gain: 0.34 * dg, filter: { type: 'lowpass', from: 1250, to: 300, sweepT: 0.15 },
    })
    this.tone({
      type: 'sawtooth', from: 600 + Math.random() * 80, to: 65, sweepT: 0.3,
      dur: 0.33, gain: 0.18 * dg, lowpass: 1600,
    })
  }

  /** Bright metallic clang: inharmonic bell partials + tick. */
  shieldBlock(pos?: Vec3Like | null): void {
    if (!this.live() || !this.gate('shieldBlock', 0.05)) return
    const dg = this.distGain(pos)
    this.clang(this.now(), 520, 0.26 * dg, 0.3)
    this.burst({ dur: 0.03, gain: 0.14 * dg, filter: { type: 'highpass', from: 3000 } })
  }

  /** Dull body thump + brief highpass danger ring. */
  playerHit(): void {
    if (!this.live() || !this.gate('playerHit', 0.08)) return
    this.tone({ type: 'sine', from: 85, to: 48, sweepT: 0.13, dur: 0.17, gain: 0.46 })
    this.burst({ dur: 0.06, gain: 0.2, filter: { type: 'lowpass', from: 500 } })
    this.tone({ type: 'sine', from: 2300, dur: 0.3, gain: 0.055, attack: 0.01 })
  }

  /** Quick airy swish. */
  playerDodge(): void {
    if (!this.live()) return
    this.burst({
      dur: 0.18, gain: 0.16, attack: 0.03,
      filter: { type: 'bandpass', from: 700, to: 2600, sweepT: 0.14, q: 1.1 },
    })
  }

  /** Subtle takeoff scuff. */
  playerJump(): void {
    if (!this.live()) return
    this.burst({ dur: 0.07, gain: 0.09, filter: { type: 'lowpass', from: 750 } })
  }

  /** Laser zap; 'deathBeam' = massive sustained roar, 'stripe' = mid, sniper = sharp. */
  beamFire(kind: 'sniper' | 'deathBeam' | 'stripe'): void {
    if (!this.live()) return
    if (kind === 'deathBeam') {
      if (!this.gate('beam:death', 0.2)) return
      const t0 = this.now()
      // massive initial roar, then a sustained sizzle across the sweep
      this.tone({
        t0, type: 'sawtooth', from: 130, to: 82, sweepT: 0.5, dur: 0.55,
        gain: 0.42, attack: 0.025, hold: 0.3, lowpass: 620,
      })
      this.tone({ t0, type: 'sawtooth', from: 132, to: 84, sweepT: 0.5, dur: 0.55, gain: 0.3, detune: 9, lowpass: 620 })
      this.burst({
        t0, dur: DEATHBEAM_SWEEP_TIME, gain: 0.3, attack: 0.03, hold: DEATHBEAM_SWEEP_TIME * 0.6,
        filter: { type: 'lowpass', from: 520, to: 200, sweepT: DEATHBEAM_SWEEP_TIME },
      })
      this.burst({
        t0, dur: DEATHBEAM_SWEEP_TIME * 0.9, gain: 0.12, attack: 0.05, hold: DEATHBEAM_SWEEP_TIME * 0.5,
        filter: { type: 'highpass', from: 2800, q: 0.7 },
      })
      return
    }
    if (kind === 'stripe') {
      if (!this.gate('beam:stripe', 0.09)) return
      this.tone({ type: 'sawtooth', from: 1400, to: 240, sweepT: 0.26, dur: 0.3, gain: 0.24, lowpass: 2600 })
      this.burst({ dur: 0.24, gain: 0.14, filter: { type: 'highpass', from: 3000, q: 0.8 } })
      return
    }
    if (!this.gate('beam:sniper', 0.05)) return
    this.tone({ type: 'sawtooth', from: 2200, to: 300, sweepT: 0.16, dur: 0.2, gain: 0.28, lowpass: 3400 })
    this.burst({ dur: 0.15, gain: 0.17, filter: { type: 'highpass', from: 3800, q: 0.8 } })
  }

  /** Motor whir rising over MINIGUN_SPINUP, then a firing buzz for MINIGUN_FIRE_TIME. */
  minigunSpinup(): void {
    if (!this.live() || !this.gate('minigun', 0.5)) return
    const ctx = this.ctx!
    const t0 = this.now()
    const g = ctx.createGain()
    g.gain.setValueAtTime(MIN_ENV, t0)
    g.gain.exponentialRampToValueAtTime(0.15, t0 + MINIGUN_SPINUP)
    g.gain.linearRampToValueAtTime(0, t0 + MINIGUN_SPINUP + 0.35)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(400, t0)
    lp.frequency.linearRampToValueAtTime(1400, t0 + MINIGUN_SPINUP)
    lp.connect(g)
    g.connect(this.master!)
    const layers: Array<[OscillatorType, number, number]> = [
      ['sawtooth', 50, 200], ['sawtooth', 51.5, 206], ['triangle', 100, 400],
    ]
    for (const [type, f0, f1] of layers) {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(f0, t0)
      o.frequency.exponentialRampToValueAtTime(f1, t0 + MINIGUN_SPINUP)
      o.connect(lp)
      o.start(t0)
      o.stop(t0 + MINIGUN_SPINUP + 0.4)
    }
    // motor flutter: slow AM speeding up with the spin
    const am = ctx.createOscillator()
    am.frequency.setValueAtTime(11, t0)
    am.frequency.linearRampToValueAtTime(48, t0 + MINIGUN_SPINUP)
    const amG = ctx.createGain()
    amG.gain.value = 0.045
    am.connect(amG)
    amG.connect(g.gain)
    am.start(t0)
    am.stop(t0 + MINIGUN_SPINUP + 0.4)
    // firing buzz once spun up (bolt hose has no per-bolt event)
    const tf = t0 + MINIGUN_SPINUP
    const fire = ctx.createBufferSource()
    fire.buffer = this.white!
    fire.loop = true
    const fbp = ctx.createBiquadFilter()
    fbp.type = 'bandpass'
    fbp.frequency.value = 1100
    fbp.Q.value = 0.7
    const fg = ctx.createGain()
    this.applyEnv(fg, tf, 0.16, 0.03, Math.max(0.1, MINIGUN_FIRE_TIME - 0.5), MINIGUN_FIRE_TIME)
    const fam = ctx.createOscillator()
    fam.type = 'square'
    fam.frequency.value = 13
    const famG = ctx.createGain()
    famG.gain.value = 0.09
    fam.connect(famG)
    famG.connect(fg.gain)
    fire.connect(fbp)
    fbp.connect(fg)
    fg.connect(this.master!)
    fire.start(tf, Math.random() * 0.5)
    fire.stop(tf + MINIGUN_FIRE_TIME + 0.1)
    fam.start(tf)
    fam.stop(tf + MINIGUN_FIRE_TIME + 0.1)
  }

  /** Deep metal impact + spark sizzle. Boss is far — keep feedback audible. */
  bossHit(pos?: Vec3Like | null): void {
    if (!this.live() || !this.gate('bossHit', 0.05)) return
    const dg = Math.max(0.55, this.distGain(pos))
    this.tone({ type: 'sine', from: 72, to: 40, sweepT: 0.2, dur: 0.26, gain: 0.34 * dg })
    this.clang(this.now(), 300, 0.1 * dg, 0.2)
    this.burst({ dur: 0.22, gain: 0.12 * dg, filter: { type: 'highpass', from: 3400, q: 0.9 } })
  }

  /** Enormous floor-smash boom + ~1.5s low rumble tail. */
  smashImpact(): void {
    if (!this.live()) return
    const t0 = this.now()
    this.burst({
      t0, dur: 0.95, gain: 0.8, attack: 0.004,
      filter: { type: 'lowpass', from: 520, to: 45, sweepT: 0.7 },
    })
    this.tone({ t0, type: 'sine', from: 70, to: 26, sweepT: 0.8, dur: 1.1, gain: 0.7 })
    this.burst({
      t0: t0 + 0.06, dur: 1.5, gain: 0.34, attack: 0.05, hold: 0.35, pink: true,
      filter: { type: 'lowpass', from: 130 },
    })
    this.clang(t0 + 0.02, 190, 0.12, 0.5)
    this.duckAmbient()
  }

  /** Layered final explosion + slow shimmering riser release. */
  bossDead(): void {
    if (!this.live() || !this.gate('bossDead', 0.5)) return
    const t0 = this.now()
    this.explosionCore(t0, 2.4, 1, true)
    // shimmering riser: detuned saw pair gliding up with a sine sparkle above
    for (const det of [0, 9]) {
      this.tone({
        t0: t0 + 0.35, type: 'sawtooth', from: 170, to: 1150, sweepT: 2.4,
        dur: 2.8, gain: 0.09, attack: 0.5, hold: 1.2, detune: det, lowpass: 2100,
      })
    }
    this.tone({ t0: t0 + 0.6, type: 'sine', from: 520, to: 2300, sweepT: 2.2, dur: 2.6, gain: 0.06, attack: 0.6, hold: 1 })
    this.tone({ t0: t0 + 0.6, type: 'sine', from: 524, to: 2318, sweepT: 2.2, dur: 2.6, gain: 0.05, attack: 0.6, hold: 1 })
    this.duckAmbient()
  }

  /** Two-note dark synth sting. */
  waveStart(): void {
    if (!this.live()) return
    const t0 = this.now()
    for (const [dt, freq] of [[0, 110], [0.28, 155.56]] as const) {
      for (const det of [-5, 5]) {
        this.tone({
          t0: t0 + dt, type: 'sawtooth', from: freq, dur: 0.62, gain: 0.13,
          attack: 0.02, hold: 0.12, detune: det, lowpass: 850,
        })
      }
      this.tone({ t0: t0 + dt, type: 'sine', from: freq / 2, dur: 0.6, gain: 0.16, attack: 0.02 })
    }
  }

  /** Pleasant ascending chime arp. */
  waveClear(): void {
    if (!this.live()) return
    const t0 = this.now()
    const notes = [523.25, 659.25, 783.99, 1046.5]
    for (let i = 0; i < notes.length; i++) {
      const tt = t0 + i * 0.09
      this.tone({ t0: tt, type: 'triangle', from: notes[i], dur: 0.42, gain: 0.15, attack: 0.005 })
      this.tone({ t0: tt, type: 'sine', from: notes[i] * 2, dur: 0.3, gain: 0.05, attack: 0.005 })
    }
  }

  /** Bright coin-ish arp blip. */
  pickup(pos?: Vec3Like | null): void {
    if (!this.live()) return
    const dg = this.distGain(pos)
    const t0 = this.now()
    this.tone({ t0, type: 'triangle', from: 987.77, dur: 0.1, gain: 0.2 * dg, attack: 0.004 })
    this.tone({ t0: t0 + 0.07, type: 'triangle', from: 1318.5, dur: 0.22, gain: 0.2 * dg, attack: 0.004 })
  }

  /** Wooden crate thunk. */
  cratePop(pos?: Vec3Like | null): void {
    if (!this.live()) return
    const dg = this.distGain(pos)
    this.tone({ type: 'sine', from: 190, to: 110, sweepT: 0.1, dur: 0.14, gain: 0.26 * dg })
    this.burst({ dur: 0.08, gain: 0.22 * dg, filter: { type: 'lowpass', from: 820 } })
  }

  /** Mechanical selector click. */
  weaponSwitch(): void {
    if (!this.live()) return
    this.mechClick(this.now(), 1.1, 0.18)
  }

  /** Soft UI tick. */
  uiClick(): void {
    if (!this.live()) return
    this.tone({ type: 'sine', from: 950, dur: 0.04, gain: 0.11, attack: 0.003 })
    this.burst({ dur: 0.02, gain: 0.05, filter: { type: 'bandpass', from: 2000, q: 1.5 } })
  }
}

/** Module singleton — survives React strict-mode remounts; context is created once. */
export const audioEngine = new AudioEngine()
