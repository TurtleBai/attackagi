import { BEAT, CUES, cuesOf, type Cue } from '../cues'
import { DURATION } from '../engine/timeline'

// The whole soundtrack — music + SFX — synthesized offline from the SAME cue
// list that drives the picture (src/cues.ts), so every hit lands on its frame.
// Dark synth + industrial percussion at 120 BPM in D minor:
//   intro (0–3)      CRT blips, pad swell, sub boom, riser into the drop
//   waves (3–6.5)    4-on-the-floor kick, metal snare, 16th hats, distorted 8th bass, arp
//   alarm (6.5–7)    siren, hit
//   count (7–8.5)    tom + boom on each JUMP! number, accelerating hats, riser
//   silence (8.5–9)  one silent beat
//   boss (9–11.75)   full kit, 16th bass, saw chord stabs
//   tired (11.75–)   drops to a heartbeat + pad while the bat charges
//   climax/title     CRACK, CRT power-down, title chord + :) chirp, ring-out
// SFX recipes follow the game's AudioSystem.engine.ts one-shots, re-timed to cues.

export const SR = 48000
const LEN = DURATION + 0.0

// deterministic noise
function rng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12) // midi → Hz
// D minor: D2=38, F2=41, G2=43, A2=45, Bb2=46, C3=48
const D1 = 26, D2 = 38

interface ToneOpts {
  t0: number; type: OscillatorType; from: number; to?: number; sweepT?: number; dur: number; gain: number
  attack?: number; hold?: number; lowpass?: number; q?: number; dest?: AudioNode; detune?: number; release?: 'exp' | 'lin'
}
interface BurstOpts {
  t0: number; dur: number; gain: number; pink?: boolean; rate?: number; attack?: number; hold?: number; dest?: AudioNode
  filter?: { type: BiquadFilterType; from: number; to?: number; sweepT?: number; q?: number }
}

class Synth {
  ctx: OfflineAudioContext
  white: AudioBuffer
  pink: AudioBuffer
  master: GainNode
  music: GainNode
  drums: GainNode
  sfx: GainNode
  verbIn: GainNode
  r = rng(1337)

  constructor() {
    const ctx = new OfflineAudioContext(2, Math.ceil(LEN * SR), SR)
    this.ctx = ctx
    this.white = this.noise(false)
    this.pink = this.noise(true)
    // master: glue compressor → soft clip → out
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 8
    comp.ratio.value = 4
    comp.attack.value = 0.004
    comp.release.value = 0.18
    const clip = ctx.createWaveShaper()
    clip.curve = softClip(1.6)
    clip.oversample = '4x'
    const out = ctx.createGain()
    out.gain.value = 0.62
    this.master = ctx.createGain()
    this.master.connect(comp)
    comp.connect(clip)
    clip.connect(out)
    out.connect(ctx.destination)
    // reverb send (generated plate-ish impulse)
    const verb = ctx.createConvolver()
    verb.buffer = this.impulse(2.4)
    this.verbIn = ctx.createGain()
    const verbOut = ctx.createGain()
    verbOut.gain.value = 0.5
    this.verbIn.connect(verb)
    verb.connect(verbOut)
    verbOut.connect(this.master)
    // buses
    this.music = ctx.createGain()
    this.music.gain.value = 0.62
    const musicDrive = ctx.createWaveShaper()
    musicDrive.curve = softClip(1.2)
    this.music.connect(musicDrive)
    musicDrive.connect(this.master)
    this.drums = ctx.createGain()
    this.drums.gain.value = 0.8
    const drumDrive = ctx.createWaveShaper()
    drumDrive.curve = softClip(2.2) // industrial grit
    this.drums.connect(drumDrive)
    drumDrive.connect(this.music)
    this.sfx = ctx.createGain()
    this.sfx.gain.value = 0.75
    this.sfx.connect(this.master)
    const sfxVerb = ctx.createGain()
    sfxVerb.gain.value = 0.22
    this.sfx.connect(sfxVerb)
    sfxVerb.connect(this.verbIn)
    const musVerb = ctx.createGain()
    musVerb.gain.value = 0.18
    this.music.connect(musVerb)
    musVerb.connect(this.verbIn)
  }

  private noise(pink: boolean): AudioBuffer {
    const len = Math.floor(SR * 2)
    const buf = this.ctx.createBuffer(1, len, SR)
    const d = buf.getChannelData(0)
    const r = rng(pink ? 77 : 99)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (let i = 0; i < len; i++) {
      const w = r() * 2 - 1
      if (!pink) { d[i] = w; continue }
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    }
    return buf
  }

  private impulse(sec: number): AudioBuffer {
    const len = Math.floor(SR * sec)
    const buf = this.ctx.createBuffer(2, len, SR)
    const r = rng(4242)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) {
        const t = i / len
        d[i] = (r() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < SR * 0.012 ? i / (SR * 0.012) : 1)
      }
    }
    return buf
  }

  private env(g: GainNode, t0: number, gain: number, attack: number, hold: number, dur: number, lin = false): void {
    g.gain.setValueAtTime(0, Math.max(0, t0))
    g.gain.linearRampToValueAtTime(gain, t0 + attack)
    if (hold > 0) g.gain.setValueAtTime(gain, t0 + attack + hold)
    if (lin) g.gain.linearRampToValueAtTime(0, t0 + dur)
    else g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  }

  tone(o: ToneOpts): void {
    if (o.gain <= 0 || o.t0 >= LEN) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = o.type
    osc.frequency.setValueAtTime(Math.max(1, o.from), o.t0)
    if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), o.t0 + (o.sweepT ?? o.dur))
    if (o.detune) osc.detune.value = o.detune
    let node: AudioNode = osc
    if (o.lowpass) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = o.lowpass
      f.Q.value = o.q ?? 0.7
      node.connect(f)
      node = f
    }
    const g = ctx.createGain()
    this.env(g, o.t0, o.gain, o.attack ?? 0.003, o.hold ?? 0, o.dur, o.release === 'lin')
    node.connect(g)
    g.connect(o.dest ?? this.sfx)
    osc.start(o.t0)
    osc.stop(o.t0 + o.dur + 0.05)
  }

  burst(o: BurstOpts): void {
    if (o.gain <= 0 || o.t0 >= LEN) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = o.pink ? this.pink : this.white
    src.loop = true
    src.playbackRate.value = o.rate ?? 1
    let node: AudioNode = src
    if (o.filter) {
      const f = ctx.createBiquadFilter()
      f.type = o.filter.type
      f.frequency.setValueAtTime(Math.max(20, o.filter.from), o.t0)
      if (o.filter.to !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.to), o.t0 + (o.filter.sweepT ?? o.dur))
      f.Q.value = o.filter.q ?? 0.9
      node.connect(f)
      node = f
    }
    const g = ctx.createGain()
    this.env(g, o.t0, o.gain, o.attack ?? 0.002, o.hold ?? 0, o.dur)
    node.connect(g)
    g.connect(o.dest ?? this.sfx)
    src.start(o.t0, this.r() * 1.5)
    src.stop(o.t0 + o.dur + 0.05)
  }

  clang(t0: number, base: number, gain: number, dur = 0.28, dest?: AudioNode): void {
    const ratios = [1, 2.76, 5.4, 8.93]
    const gains = [1, 0.62, 0.38, 0.22]
    for (let i = 0; i < ratios.length; i++) {
      this.tone({ t0, type: 'sine', from: base * ratios[i] * (0.99 + this.r() * 0.02), dur: dur * (1 - i * 0.14), gain: gain * gains[i], attack: 0.001, dest })
    }
  }

  mechClick(t0: number, pitch: number, gain: number): void {
    this.burst({ t0, dur: 0.03, gain, filter: { type: 'bandpass', from: 2300 * pitch, q: 2 } })
    this.tone({ t0, type: 'square', from: 1250 * pitch, dur: 0.028, gain: gain * 0.45, lowpass: 4200 })
  }

  explosionCore(t0: number, size: number, dg: number, layered: boolean): void {
    this.burst({ t0, dur: 0.55 * size + (layered ? 0.7 : 0), gain: 0.72 * dg, attack: 0.004, filter: { type: 'lowpass', from: 800, to: 80, sweepT: 0.42 * size } })
    this.tone({ t0, type: 'sine', from: 110, to: 34, sweepT: 0.45 * size, dur: 0.65 * size, gain: 0.62 * dg })
    this.burst({ t0: t0 + 0.05, dur: 0.9 * size, gain: 0.28 * dg, attack: 0.04, pink: true, filter: { type: 'lowpass', from: 220, to: 90, sweepT: 0.8 * size } })
    if (layered) {
      this.burst({ t0: t0 + 0.28, dur: 0.8, gain: 0.5 * dg, attack: 0.004, filter: { type: 'lowpass', from: 620, to: 70, sweepT: 0.6 } })
      this.tone({ t0: t0 + 0.28, type: 'sine', from: 90, to: 30, sweepT: 0.7, dur: 0.9, gain: 0.45 * dg })
      for (let i = 0; i < 5; i++) {
        const tt = t0 + 0.1 + this.r() * 0.9
        this.burst({ t0: tt, dur: 0.05 + this.r() * 0.06, gain: 0.1 * dg, filter: { type: 'bandpass', from: 1500 + this.r() * 2500, q: 3 } })
      }
    }
  }

  // ── drums ──────────────────────────────────────────────────────────────────
  kick(t: number, g = 1): void {
    const d = this.drums
    this.tone({ t0: t, type: 'sine', from: 160, to: 42, sweepT: 0.11, dur: 0.38, gain: 0.95 * g, dest: d })
    this.tone({ t0: t, type: 'triangle', from: 90, to: 40, sweepT: 0.08, dur: 0.2, gain: 0.35 * g, dest: d })
    this.burst({ t0: t, dur: 0.018, gain: 0.35 * g, filter: { type: 'highpass', from: 2500 }, dest: d })
  }
  snare(t: number, g = 1): void {
    const d = this.drums
    this.burst({ t0: t, dur: 0.2, gain: 0.55 * g, filter: { type: 'bandpass', from: 1900, q: 0.7 }, dest: d })
    this.burst({ t0: t, dur: 0.09, gain: 0.35 * g, filter: { type: 'highpass', from: 5000 }, dest: d })
    this.tone({ t0: t, type: 'triangle', from: 210, to: 160, sweepT: 0.06, dur: 0.12, gain: 0.4 * g, dest: d })
    this.clang(t, 410, 0.09 * g, 0.12, d) // metal plate ring = industrial
  }
  hat(t: number, g = 1, open = false): void {
    this.burst({ t0: t, dur: open ? 0.22 : 0.045, gain: 0.2 * g, filter: { type: 'highpass', from: 7500 }, dest: this.drums })
  }
  metal(t: number, g = 1, base = 300): void {
    this.clang(t, base, 0.14 * g, 0.22, this.drums)
    this.burst({ t0: t, dur: 0.05, gain: 0.12 * g, filter: { type: 'bandpass', from: 3200, q: 3 }, dest: this.drums })
  }
  tom(t: number, g = 1, f = 95): void {
    this.tone({ t0: t, type: 'sine', from: f * 1.8, to: f * 0.55, sweepT: 0.3, dur: 0.75, gain: 0.9 * g, dest: this.drums })
    this.burst({ t0: t, dur: 0.12, gain: 0.3 * g, filter: { type: 'lowpass', from: 1200, to: 200 }, dest: this.drums })
  }
  crash(t: number, g = 1): void {
    this.burst({ t0: t, dur: 1.6, gain: 0.22 * g, filter: { type: 'highpass', from: 4200 }, dest: this.music })
    this.burst({ t0: t, dur: 0.6, gain: 0.15 * g, filter: { type: 'bandpass', from: 2400, q: 0.6 }, dest: this.music })
  }

  // ── synths ─────────────────────────────────────────────────────────────────
  bass(t: number, midi: number, dur: number, g = 1, bright = 1): void {
    const ctx = this.ctx
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.Q.value = 6
    f.frequency.setValueAtTime(180 + 1400 * bright, t)
    f.frequency.exponentialRampToValueAtTime(140, t + dur * 0.9)
    const gn = ctx.createGain()
    this.env(gn, t, 0.32 * g, 0.004, dur * 0.4, dur)
    f.connect(gn)
    gn.connect(this.music)
    for (const [type, det, mul] of [['sawtooth', -9, 1], ['sawtooth', 9, 1], ['square', 0, 0.5]] as const) {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = NOTE(midi) * mul
      o.detune.value = det
      const og = ctx.createGain()
      og.gain.value = type === 'square' ? 0.6 : 0.5
      o.connect(og)
      og.connect(f)
      o.start(t)
      o.stop(t + dur + 0.05)
    }
  }
  pad(t0: number, t1: number, midis: number[], g: number, cut0: number, cut1: number, attack = 0.4): void {
    const ctx = this.ctx
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.Q.value = 1.2
    f.frequency.setValueAtTime(cut0, t0)
    f.frequency.exponentialRampToValueAtTime(cut1, t1)
    const gn = ctx.createGain()
    gn.gain.setValueAtTime(0, t0)
    gn.gain.linearRampToValueAtTime(g, t0 + attack)
    gn.gain.setValueAtTime(g, Math.max(t0 + attack, t1 - 0.25))
    gn.gain.linearRampToValueAtTime(0, t1)
    f.connect(gn)
    gn.connect(this.music)
    for (const m of midis) {
      for (const det of [-11, 0, 12]) {
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = NOTE(m)
        o.detune.value = det
        const og = ctx.createGain()
        og.gain.value = 0.11
        o.connect(og)
        og.connect(f)
        o.start(t0)
        o.stop(t1 + 0.05)
      }
    }
  }
  stab(t: number, midis: number[], dur: number, g = 1): void {
    for (const m of midis) {
      for (const det of [-14, 14]) {
        this.tone({ t0: t, type: 'sawtooth', from: NOTE(m), dur, gain: 0.07 * g, lowpass: 2600, q: 2, detune: det, dest: this.music })
      }
    }
  }
  arp(t: number, midi: number, g = 1): void {
    this.tone({ t0: t, type: 'square', from: NOTE(midi), dur: 0.11, gain: 0.05 * g, lowpass: 3200, dest: this.music })
  }
  riser(t0: number, t1: number, g = 1): void {
    const dur = t1 - t0
    this.burst({ t0, dur, gain: 0.3 * g, attack: dur * 0.9, filter: { type: 'bandpass', from: 300, to: 6000, sweepT: dur, q: 2.5 }, dest: this.music })
    this.tone({ t0, type: 'sawtooth', from: NOTE(D2 + 12), to: NOTE(D2 + 36), sweepT: dur, dur, gain: 0.06 * g, attack: dur * 0.9, lowpass: 2400, dest: this.music })
  }
}

function softClip(k: number): Float32Array<ArrayBuffer> {
  const n = 2048
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  return c
}

// ─── score ──────────────────────────────────────────────────────────────────

function section(name: string): number {
  const c = CUES.find((q) => q.kind === 'section' && q.p?.name === name)
  if (!c) throw new Error(`no section ${name}`)
  return c.t
}

function music(s: Synth): void {
  const T = {
    waves: section('waves'), alarm: section('alarm'), count: section('count'), silence: section('silence'),
    boss: section('boss'), tired: section('tired'), climax: section('climax'), title: section('title'),
  }
  const b16 = BEAT / 4
  // ── intro: sub hum (the AGI's presence), pad swells at the boot, riser into the drop
  const boot = cuesOf('crtBoot')[0].t
  s.tone({ t0: 0.0, type: 'sine', from: NOTE(D1), dur: T.waves - 0.2, gain: 0.16, attack: 0.8, hold: T.waves - 1.5, dest: s.music, release: 'lin' })
  s.pad(boot, T.waves + 0.1, [D2, D2 + 7, D2 + 15], 0.3, 220, 2200, 1.2)
  s.riser(T.waves - 2.0, T.waves, 0.7)
  for (let t = T.waves - 1.0; t < T.waves - 1e-6; t += b16 * 2) s.hat(t, 0.3 + 0.7 * (1 - (T.waves - t)))
  // ── waves: driving industrial
  const bassLine = [0, 0, 0, 3, 0, 0, -2, -4] // D D D F D D C Bb (8ths)
  const arpNotes = [0, 3, 7, 10, 12, 10, 7, 3]
  const brk = cuesOf('uiCard')[0].t - 0.1 // breakdown under the buff pick
  const half = T.waves + 4 // second groove: bass climbs, arp inverts
  const bassLine2 = [0, 0, 3, 5, 0, 7, 5, 3]
  const arpNotes2 = [12, 10, 7, 3, 0, 3, 7, 10]
  for (let t = T.waves; t < brk - 1e-6; t += BEAT) s.kick(t, 1)
  for (let t = T.waves + BEAT; t < brk - 1e-6; t += BEAT * 2) s.snare(t, 0.9)
  for (let i = 0, t = T.waves; t < brk - 1e-6; t += b16, i++) s.hat(t, i % 4 === 2 ? 0.9 : 0.45, i % 8 === 6)
  for (let i = 0, t = T.waves; t < brk - 1e-6; t += BEAT / 2, i++) s.bass(t, D2 - 12 + (t < half ? bassLine : bassLine2)[i % 8], BEAT / 2 * 0.9, 1, t < half ? 0.6 : 0.85)
  for (let i = 0, t = T.waves; t < brk - 1e-6; t += b16, i++) s.arp(t, D2 + 24 + (t < half ? arpNotes : arpNotes2)[i % 8], 0.8)
  for (let t = T.waves + BEAT * 1.75; t < brk; t += BEAT * 2) s.metal(t, 0.7, 260)
  for (let t = brk - BEAT; t < brk - 1e-6; t += b16) s.snare(t, 0.35 + 0.6 * (1 - (brk - t)))
  s.crash(T.waves, 1)
  s.crash(half, 0.7)
  s.pad(T.waves, brk + 0.1, [D2, D2 + 3, D2 + 7], 0.24, 900, 1400, 0.05)
  // breakdown: the fight freezes for the pick — low pad, heartbeat kick, shimmer
  s.pad(brk, T.alarm, [D2 - 12, D2 + 3, D2 + 10], 0.3, 700, 2400, 0.05)
  for (let t = brk; t < T.alarm - 1e-6; t += BEAT) s.kick(t, 0.55)
  // ── alarm: stop, hit, drone
  s.kick(T.alarm, 1.2)
  s.crash(T.alarm, 0.8)
  s.tone({ t0: T.alarm, type: 'sawtooth', from: NOTE(D1 + 1), dur: T.count - T.alarm + 0.1, gain: 0.12, lowpass: 400, dest: s.music, release: 'lin', hold: 0.3 })
  // ── count: tom + boom per number, hats accelerate, riser to the void
  for (const c of cuesOf('countBeat')) {
    s.tom(c.t, 1.1, 82 - (3 - Number(c.p?.n)) * 6)
    s.kick(c.t, 1.1)
    s.stab(c.t, [D2, D2 + 1, D2 + 7], 0.42, 1.2) // phrygian b2 — dread
    s.tone({ t0: c.t, type: 'sine', from: NOTE(D1), dur: 0.5, gain: 0.25, dest: s.music })
  }
  const third = (T.silence - T.count) / 3
  for (const [a, b, step] of [[T.count, T.count + third, b16 * 2], [T.count + third, T.count + 2 * third, b16], [T.count + 2 * third, T.silence, b16 / 2]] as const) {
    for (let t = a; t < b - 1e-6; t += step) s.hat(t, 0.55)
  }
  s.riser(T.count, T.silence, 1.1)
  // ── silence: nothing (8.5 → 9.0)
  // ── boss: full intensity
  s.crash(T.boss, 1.4)
  const prog = [0, 0, -4, -4, -2, -2, -5, -5] // Dm Dm Bb Bb C C A A (per beat pair)
  const chord = (r: number) => [D2 + 12 + r, D2 + 15 + r + (r === -5 ? 1 : 0), D2 + 19 + r]
  for (let i = 0, t = T.boss; t < T.tired - 1e-6; t += BEAT, i++) {
    s.kick(t, 1.15)
    if (i % 2 === 1) s.snare(t, 1)
    s.kick(t + BEAT * 0.75, 0.6)
  }
  for (let i = 0, t = T.boss; t < T.tired - 1e-6; t += b16, i++) {
    s.hat(t, i % 2 ? 0.4 : 0.7)
    const r = prog[Math.floor(i / 8) % 8]
    s.bass(t, D2 - 12 + r + (i % 4 === 3 ? 12 : 0), b16 * 0.85, 1.05, 0.9)
  }
  for (let i = 0, t = T.boss; t < T.tired - 1e-6; t += BEAT * 2, i++) {
    const r = prog[(i * 2) % 8]
    s.stab(t, chord(r), 0.32, 1.3)
    s.stab(t + BEAT * 1.5, chord(r), 0.18, 0.9)
    s.metal(t + BEAT * 0.5, 0.9, 220)
  }
  s.pad(T.boss, T.tired, [D2 + 12, D2 + 15, D2 + 19, D2 + 24], 0.2, 1400, 3200, 0.05)
  // ── tired: everything drops; heartbeat kick + low pad while the bat charges
  s.pad(T.tired, T.climax, [D2 - 12, D2, D2 + 3], 0.32, 900, 220, 0.04)
  for (let t = T.tired; t < T.climax - 0.2; t += BEAT) { s.kick(t, 0.6); s.kick(t + 0.16, 0.38) }
  // ── climax: the crack lands on the chord
  s.crash(T.climax, 1.6)
  s.pad(T.climax, T.title - 0.05, [D2, D2 + 7, D2 + 10, D2 + 15], 0.36, 3000, 300, 0.01)
  s.tone({ t0: T.climax, type: 'sine', from: NOTE(D1), to: NOTE(D1) * 0.7, sweepT: 0.7, dur: 0.75, gain: 0.5, dest: s.music })
  // ── title: hit + chord + :) chirp, ring out
  s.kick(T.title, 1.3)
  s.tom(T.title, 1, 60)
  s.crash(T.title, 1.2)
  s.pad(T.title, LEN, [D2 - 12, D2, D2 + 7, D2 + 14, D2 + 15], 0.42, 2600, 500, 0.02)
  s.tone({ t0: T.title, type: 'sine', from: NOTE(D1), dur: 1.5, gain: 0.45, dest: s.music, hold: 0.6 })
  const chirp = [D2 + 36, D2 + 43, D2 + 40]
  chirp.forEach((m, i) => s.tone({ t0: T.title + 0.5 + i * 0.09, type: 'square', from: NOTE(m), dur: 0.08, gain: 0.06, lowpass: 5000, dest: s.music }))
}

function sfx(s: Synth, c: Cue): void {
  const t = c.t
  const P = c.p ?? {}
  switch (c.kind) {
    case 'section': return
    case 'crtBlip':
      s.tone({ t0: t, type: 'square', from: 1567, dur: 0.06, gain: 0.12, lowpass: 6000 })
      s.tone({ t0: t, type: 'sine', from: 3135, dur: 0.04, gain: 0.05 })
      s.burst({ t0: t, dur: 0.012, gain: 0.08, filter: { type: 'highpass', from: 3000 } })
      return
    case 'crtBoot':
      s.tone({ t0: t, type: 'sine', from: 70, to: 48, sweepT: 0.2, dur: 0.35, gain: 0.5 })
      s.burst({ t0: t, dur: 0.08, gain: 0.3, filter: { type: 'lowpass', from: 1800, to: 300 } })
      s.tone({ t0: t + 0.02, type: 'sine', from: 7800, dur: 1.2, gain: 0.018, attack: 0.05 })
      s.tone({ t0: t, type: 'square', from: 523, dur: 0.07, gain: 0.07, lowpass: 4000 })
      s.tone({ t0: t + 0.07, type: 'square', from: 784, dur: 0.12, gain: 0.07, lowpass: 4000 })
      return
    case 'whoosh': {
      const dur = Number(P.dur ?? 0.6)
      s.burst({ t0: t, dur, gain: 0.2, attack: dur * 0.35, pink: true, filter: { type: 'bandpass', from: 2400, to: 260, sweepT: dur, q: 1.3 } })
      s.tone({ t0: t, type: 'sine', from: 120, to: 40, sweepT: dur, dur, gain: 0.18, attack: dur * 0.3 })
      return
    }
    case 'subBoom':
      s.tone({ t0: t, type: 'sine', from: 62, to: 30, sweepT: 1.1, dur: 1.8, gain: 0.85 * Number(P.gain ?? 1) })
      s.burst({ t0: t, dur: 1.2, gain: 0.32, pink: true, filter: { type: 'lowpass', from: 260, to: 60 } })
      s.clang(t, 72, 0.12, 1.4)
      return
    case 'servo': {
      const dur = Number(P.dur ?? 0.4)
      const low = Number(P.low ?? 0)
      s.tone({ t0: t, type: 'sawtooth', from: low ? 95 : 70, to: low ? 45 : 120, sweepT: dur, dur, gain: 0.16, lowpass: 700, q: 4, attack: 0.05 })
      s.tone({ t0: t, type: 'sawtooth', from: low ? 97 : 72, to: low ? 46 : 123, sweepT: dur, dur, gain: 0.12, lowpass: 900, attack: 0.05 })
      s.burst({ t0: t, dur, gain: 0.12, attack: 0.08, filter: { type: 'bandpass', from: 900, to: 400, q: 5 } })
      s.clang(t + dur * 0.8, low ? 90 : 140, 0.1, 0.5)
      return
    }
    case 'handOpen':
      s.clang(t, 170, 0.2, 0.6)
      s.burst({ t0: t, dur: 0.35, gain: 0.2, filter: { type: 'highpass', from: 4000, to: 1500 } })
      s.mechClick(t, 0.5, 0.25)
      return
    case 'robotLand':
      for (let i = 0; i < Number(P.n ?? 5); i++) {
        const tt = t + i * 0.012
        s.tone({ t0: tt, type: 'sine', from: 95, to: 38, sweepT: 0.14, dur: 0.3, gain: 0.45 })
        s.burst({ t0: tt, dur: 0.16, gain: 0.3, filter: { type: 'lowpass', from: 700, to: 120 } })
        s.clang(tt + 0.01, 230 + i * 37, 0.07, 0.3)
      }
      return
    case 'revolver':
      // game AudioSystem.shot(): hammer click, high-passed crack, 94 Hz magnum thump, room tail
      s.burst({ t0: t, dur: 0.012, gain: 0.3, filter: { type: 'bandpass', from: 3400, q: 1.4 } })
      s.tone({ t0: t, type: 'square', from: 1600, dur: 0.018, gain: 0.1, lowpass: 5200 })
      s.burst({ t0: t, dur: 0.14, gain: 0.62, rate: 0.85 + s.r() * 0.25, filter: { type: 'highpass', from: 720, q: 0.7 } })
      s.tone({ t0: t, type: 'sine', from: 94, to: 46, sweepT: 0.16, dur: 0.34, gain: 0.62 })
      s.burst({ t0: t + 0.03, dur: 0.38, gain: 0.14, attack: 0.03, pink: true, filter: { type: 'lowpass', from: 1400, to: 380, sweepT: 0.3 } })
      return
    case 'headshot':
      s.burst({ t0: t + 0.01, dur: 0.07, gain: 0.25, filter: { type: 'bandpass', from: 3600, q: 2 } })
      s.tone({ t0: t + 0.01, type: 'sawtooth', from: 2200, to: 260, sweepT: 0.09, dur: 0.11, gain: 0.09, lowpass: 5000 })
      s.clang(t + 0.012, 880, 0.08, 0.2)
      return
    case 'reloadOpen':
      s.tone({ t0: t, type: 'sine', from: 210, to: 120, sweepT: 0.07, dur: 0.1, gain: 0.32 })
      s.burst({ t0: t, dur: 0.06, gain: 0.24, filter: { type: 'lowpass', from: 900 } })
      s.mechClick(t, 0.75, 0.18)
      return
    case 'reloadEject':
      s.burst({ t0: t, dur: 0.05, gain: 0.2, filter: { type: 'bandpass', from: 1700, to: 3400, sweepT: 0.045, q: 1.6 } })
      for (let i = 0; i < 6; i++) {
        const tt = t + 0.03 + i * 0.022 + s.r() * 0.01
        const p = 1 + (s.r() - 0.5) * 0.35
        s.tone({ t0: tt, type: 'triangle', from: 2500 * p, dur: 0.05, gain: 0.08, attack: 0.001 })
        s.burst({ t0: tt, dur: 0.022, gain: 0.07, filter: { type: 'bandpass', from: 4200 * p, q: 3 } })
      }
      return
    case 'reloadInsert':
      s.tone({ t0: t, type: 'sine', from: 150, to: 92, sweepT: 0.08, dur: 0.11, gain: 0.36 })
      s.burst({ t0: t, dur: 0.07, gain: 0.22, filter: { type: 'lowpass', from: 700 } })
      s.mechClick(t, 1.0, 0.16)
      return
    case 'reloadSnap':
      s.mechClick(t, 1.3, 0.38)
      s.tone({ t0: t, type: 'sine', from: 190, to: 115, sweepT: 0.05, dur: 0.08, gain: 0.3 })
      s.burst({ t0: t, dur: 0.04, gain: 0.18, filter: { type: 'bandpass', from: 2600, q: 1.2 } })
      return
    case 'droneWhine': {
      const dur = Number(P.dur ?? 0.9)
      // four rotors, doppler rising as it dives at the lens
      for (const [f, d] of [[410, 0], [418, 7], [205, -5]] as const) {
        s.tone({ t0: t, type: 'sawtooth', from: f, to: f * 1.45, sweepT: dur * 0.8, dur, gain: 0.05, lowpass: 2600, detune: d, attack: 0.15 })
      }
      s.burst({ t0: t, dur, gain: 0.14, attack: 0.2, filter: { type: 'bandpass', from: 900, to: 1800, sweepT: dur, q: 3 } })
      return
    }
    case 'warnBeep':
      s.tone({ t0: t, type: 'square', from: 1320, dur: 0.075, gain: 0.08, lowpass: 5000, hold: 0.04 })
      s.tone({ t0: t, type: 'square', from: 1326, dur: 0.075, gain: 0.05, lowpass: 5000, hold: 0.04 })
      return
    case 'bombDrop':
      s.tone({ t0: t, type: 'sine', from: 2300, to: 700, sweepT: 0.38, dur: 0.38, gain: 0.07, attack: 0.03 })
      s.mechClick(t, 0.9, 0.12)
      return
    case 'explosion':
      s.explosionCore(t, Number(P.size ?? 1), 0.85, false)
      return
    case 'droneDown':
      s.tone({ t0: t + 0.01, type: 'sawtooth', from: 560, to: 90, sweepT: 0.3, dur: 0.32, gain: 0.08, lowpass: 2000 })
      s.burst({ t0: t + 0.01, dur: 0.12, gain: 0.25, filter: { type: 'bandpass', from: 2800, q: 1.5 } })
      s.clang(t + 0.02, 640, 0.07, 0.25)
      return
    case 'molotovThrow':
      s.burst({ t0: t, dur: 0.3, gain: 0.18, attack: 0.08, filter: { type: 'bandpass', from: 500, to: 1600, sweepT: 0.22, q: 1.2 } })
      return
    case 'glassBreak':
      s.burst({ t0: t, dur: 0.05, gain: 0.45, filter: { type: 'highpass', from: 3000 } })
      for (let i = 0; i < 9; i++) {
        const tt = t + s.r() * 0.18
        s.tone({ t0: tt, type: 'sine', from: 3000 + s.r() * 4000, dur: 0.06 + s.r() * 0.06, gain: 0.05, attack: 0.001 })
      }
      s.explosionCore(t, 0.6, 0.5, false)
      return
    case 'fireWhoosh':
      s.burst({ t0: t, dur: 0.9, gain: 0.32, attack: 0.04, filter: { type: 'lowpass', from: 300, to: 2400, sweepT: 0.25, q: 0.8 } })
      for (let i = 0; i < 14; i++) s.burst({ t0: t + 0.05 + s.r() * 0.5, dur: 0.012, gain: 0.06, filter: { type: 'bandpass', from: 2500 + s.r() * 3000, q: 4 } })
      return
    case 'uiCard':
      s.tone({ t0: t, type: 'square', from: 988, dur: 0.06, gain: 0.06, lowpass: 5000 })
      s.burst({ t0: t, dur: 0.12, gain: 0.08, attack: 0.02, filter: { type: 'bandpass', from: 1800, to: 3600, q: 2 } })
      return
    case 'uiPick':
      s.tone({ t0: t, type: 'square', from: 1319, dur: 0.07, gain: 0.07, lowpass: 6000 })
      s.tone({ t0: t + 0.07, type: 'square', from: 1976, dur: 0.14, gain: 0.07, lowpass: 6000 })
      s.clang(t, 660, 0.06, 0.4)
      return
    case 'batHit':
      s.burst({ t0: t, dur: 0.03, gain: 0.7, filter: { type: 'highpass', from: 1800 } })
      s.tone({ t0: t, type: 'sine', from: 160, to: 55, sweepT: 0.12, dur: 0.3, gain: 0.6 })
      s.clang(t, 310, 0.16, 0.5)
      s.burst({ t0: t, dur: 0.1, gain: 0.3, filter: { type: 'bandpass', from: 2200, q: 1.2 } })
      return
    case 'alarm':
      for (let i = 0; i < 4; i++) {
        s.tone({ t0: t + i * 0.125, type: 'square', from: i % 2 ? 660 : 880, dur: 0.12, gain: 0.06, lowpass: 3000, hold: 0.09 })
      }
      s.burst({ t0: t, dur: 0.08, gain: 0.3, filter: { type: 'bandpass', from: 1200, q: 1 } })
      s.tone({ t0: t, type: 'sawtooth', from: 220, to: 55, sweepT: 0.2, dur: 0.3, gain: 0.12, lowpass: 1200 })
      return
    case 'countBeat':
      s.tone({ t0: t, type: 'sine', from: 80, to: 36, sweepT: 0.35, dur: 0.55, gain: 0.55 })
      return
    case 'smash':
      s.explosionCore(t, 2.2, 1.0, true)
      s.tone({ t0: t, type: 'sine', from: 58, to: 24, sweepT: 1.6, dur: 2.6, gain: 0.85 })
      s.burst({ t0: t, dur: 0.05, gain: 0.6, filter: { type: 'highpass', from: 1500 } })
      s.clang(t, 95, 0.25, 1.6)
      s.clang(t + 0.02, 141, 0.18, 1.2)
      return
    case 'debris':
      for (let i = 0; i < 16; i++) {
        const tt = t + s.r() * 0.9
        s.burst({ t0: tt, dur: 0.04 + s.r() * 0.08, gain: 0.08, filter: { type: 'bandpass', from: 400 + s.r() * 1800, q: 2 } })
        if (i % 4 === 0) s.clang(tt, 180 + s.r() * 300, 0.04, 0.2)
      }
      return
    case 'rocketSalvo':
      for (let i = 0; i < 12; i++) {
        const tt = t + i * 0.035
        s.burst({ t0: tt, dur: 0.32, gain: 0.07, attack: 0.02, filter: { type: 'bandpass', from: 2400, to: 900, sweepT: 0.3, q: 1.8 } })
        s.tone({ t0: tt, type: 'sawtooth', from: 900 + (i % 3) * 90, to: 300, sweepT: 0.3, dur: 0.32, gain: 0.025, lowpass: 3000 })
      }
      return
    case 'beamCharge': {
      const dur = Number(P.dur ?? 0.4)
      s.tone({ t0: t, type: 'sine', from: 160, to: 1900, sweepT: dur, dur: dur + 0.02, gain: 0.14, attack: dur * 0.8 })
      s.tone({ t0: t, type: 'sawtooth', from: 80, to: 240, sweepT: dur, dur: dur + 0.02, gain: 0.09, lowpass: 1500, attack: dur * 0.7 })
      s.burst({ t0: t, dur: dur + 0.02, gain: 0.16, attack: dur * 0.9, filter: { type: 'bandpass', from: 400, to: 5000, sweepT: dur, q: 4 } })
      return
    }
    case 'beamFire': {
      const dur = Number(P.dur ?? 0.35) + 0.15
      s.tone({ t0: t, type: 'sawtooth', from: 92, dur, gain: 0.28, lowpass: 1800, q: 3, hold: dur * 0.6 })
      s.tone({ t0: t, type: 'square', from: 46, dur, gain: 0.22, lowpass: 400, hold: dur * 0.6 })
      s.burst({ t0: t, dur, gain: 0.4, hold: dur * 0.5, filter: { type: 'bandpass', from: 1300, q: 0.8 } })
      s.burst({ t0: t, dur: 0.06, gain: 0.5, filter: { type: 'highpass', from: 2000 } })
      s.tone({ t0: t, type: 'sine', from: 70, to: 35, sweepT: 0.4, dur: 0.6, gain: 0.5 })
      return
    }
    case 'minigun': {
      const dur = Number(P.dur ?? 0.37)
      s.tone({ t0: t, type: 'sawtooth', from: 380, dur, gain: 0.05, lowpass: 2500, hold: dur * 0.7 })
      for (let tt = t; tt < t + dur; tt += 0.045) {
        s.burst({ t0: tt, dur: 0.035, gain: 0.22, filter: { type: 'highpass', from: 900 } })
        s.tone({ t0: tt, type: 'sine', from: 140, to: 70, sweepT: 0.03, dur: 0.05, gain: 0.18 })
      }
      return
    }
    case 'slam':
      s.explosionCore(t, 1.3, 0.95, false)
      s.clang(t, 118, 0.2, 0.9)
      s.burst({ t0: t, dur: 0.04, gain: 0.5, filter: { type: 'highpass', from: 1500 } })
      return
    case 'hurt':
      s.tone({ t0: t, type: 'square', from: 880, to: 620, sweepT: 0.08, dur: 0.1, gain: 0.07, lowpass: 4000 })
      s.tone({ t0: t + 0.09, type: 'square', from: 620, to: 330, sweepT: 0.12, dur: 0.16, gain: 0.07, lowpass: 4000 })
      s.burst({ t0: t, dur: 0.06, gain: 0.12, filter: { type: 'bandpass', from: 5000, q: 2 } })
      return
    case 'batCharge': {
      const dur = Number(P.dur ?? 0.45)
      s.tone({ t0: t, type: 'triangle', from: 110, to: 330, sweepT: dur, dur: dur + 0.05, gain: 0.16, attack: dur * 0.6 })
      s.tone({ t0: t, type: 'sine', from: 660, to: 1980, sweepT: dur, dur: dur + 0.05, gain: 0.05, attack: dur * 0.8 })
      s.burst({ t0: t, dur: dur + 0.05, gain: 0.12, attack: dur * 0.9, filter: { type: 'bandpass', from: 800, to: 4000, sweepT: dur, q: 3 } })
      return
    }
    case 'batSwing':
      s.burst({ t0: t, dur: 0.28, gain: 0.5, attack: 0.06, rate: 1.4, filter: { type: 'bandpass', from: 800, to: 2450, sweepT: 0.2, q: 1.4 } })
      return
    case 'batCrack':
      // wood CRACK + glass/CRT impact + metallic ring + sub
      s.burst({ t0: t, dur: 0.035, gain: 1.0, filter: { type: 'highpass', from: 1800 } })
      s.burst({ t0: t, dur: 0.12, gain: 0.7, filter: { type: 'bandpass', from: 2600, q: 1.1 } })
      s.tone({ t0: t, type: 'sine', from: 140, to: 40, sweepT: 0.2, dur: 0.5, gain: 0.9 })
      s.explosionCore(t, 1.0, 0.7, false)
      s.clang(t, 205, 0.28, 1.4)
      for (let i = 0; i < 10; i++) s.tone({ t0: t + 0.02 + s.r() * 0.25, type: 'sine', from: 2800 + s.r() * 4500, dur: 0.07, gain: 0.05, attack: 0.001 })
      return
    case 'crtOff':
      s.tone({ t0: t, type: 'sine', from: 2100, to: 55, sweepT: 0.3, dur: 0.34, gain: 0.16 })
      s.burst({ t0: t, dur: 0.02, gain: 0.25, filter: { type: 'bandpass', from: 2000, q: 2 } })
      s.tone({ t0: t, type: 'sine', from: 60, dur: 0.3, gain: 0.2, lowpass: 200 })
      s.tone({ t0: t + 0.02, type: 'sine', from: 7600, to: 7000, dur: 0.45, gain: 0.02, attack: 0.01 })
      return
    case 'titleHit':
      s.explosionCore(t, 1.2, 0.6, false)
      s.burst({ t0: t, dur: 0.03, gain: 0.4, filter: { type: 'highpass', from: 2500 } })
      return
  }
}

export async function renderScore(): Promise<AudioBuffer> {
  const s = new Synth()
  music(s)
  for (const c of CUES) sfx(s, c)
  // the silent beat: hard gate EVERYTHING (tails + reverb) for one beat
  const sil = section('silence'), boss = section('boss')
  const mg = s.master.gain
  mg.setValueAtTime(1, sil - 0.03)
  mg.linearRampToValueAtTime(0, sil + 0.02)
  mg.setValueAtTime(0, boss - 0.002)
  mg.linearRampToValueAtTime(1, boss)
  // music bus envelope = the build: sparse → driving → (silence) → full → dip → crack
  const crack = CUES.find((c) => c.kind === 'batCrack')!.t
  const mu = s.music.gain
  const pts: Array<[number, number]> = [
    [0, 0.2], [section('waves') - 2.5, 0.26], [section('waves') - 0.6, 0.42], [section('waves'), 0.48], [section('count') - 0.01, 0.5],
    [section('count'), 0.54], [boss, 0.62], [section('tired') - 0.05, 0.62], [section('tired') + 0.08, 0.26],
    [crack - 0.12, 0.3], [crack - 0.02, 0.08], [crack - 0.001, 0.08], [crack + 0.01, 0.55],
    [section('title') - 0.01, 0.45], [section('title'), 0.55], [LEN, 0.5],
  ]
  mu.setValueAtTime(pts[0][1], 0)
  for (const [tt, v] of pts.slice(1)) mu.linearRampToValueAtTime(v, tt)
  return s.ctx.startRendering()
}

export function toWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels
  const n = buf.length
  const out = new ArrayBuffer(44 + n * ch * 2)
  const v = new DataView(out)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true)
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, n * ch * 2, true)
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i))
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, data[c][i]))
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true)
      o += 2
    }
  }
  return out
}
