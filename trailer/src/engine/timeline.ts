import { seed } from './rng'
import type { Stage } from './stage'

// One timeline clock. Frame n ↔ t = n / FPS. Each shot owns [start, end) on the
// global clock; entering a shot (or seeking) resets the stage, reseeds the RNG,
// runs setup, then fixed-steps from the shot's first frame (minus any preroll)
// so every frame is a pure function of its index.

export const FPS = 60
export const DURATION = 30
export const TOTAL_FRAMES = FPS * DURATION

export interface ShotCtx {
  S: Stage
  /** global seconds */
  t: number
  /** seconds since shot start (negative during preroll) */
  lt: number
  /** shot length in seconds */
  len: number
  dt: number
  frame: number
  /** 0..1 progress through the shot */
  p: number
  o: CanvasRenderingContext2D
}

export interface Shot {
  name: string
  start: number
  end: number
  preroll?: number
  setup(c: ShotCtx): void
  update(c: ShotCtx): void
  draw?(c: ShotCtx): void
  /** runs after the stage stepped (view-model fixups that must see the posed rig) */
  post?(c: ShotCtx): void
}

export class Timeline {
  private cur: Shot | null = null
  private last = -2
  constructor(private S: Stage, readonly shots: Shot[]) {}

  shotAt(t: number): Shot {
    for (const s of this.shots) if (t >= s.start - 1e-9 && t < s.end - 1e-9) return s
    return this.shots[this.shots.length - 1]
  }

  private ctx(shot: Shot, frame: number): ShotCtx {
    const t = frame / FPS
    const len = shot.end - shot.start
    return {
      S: this.S, t, lt: t - shot.start, len, dt: 1 / FPS, frame,
      p: Math.min(1, Math.max(0, (t - shot.start) / len)), o: this.S.overlay,
    }
  }

  private stepFrame(shot: Shot, frame: number, render: boolean): void {
    const c = this.ctx(shot, frame)
    shot.update(c)
    this.S.step(c.t, c.dt)
    shot.post?.(c)
    if (render) {
      const o = this.S.overlay
      o.setTransform(1, 0, 0, 1, 0, 0)
      o.clearRect(0, 0, o.canvas.width, o.canvas.height)
      o.globalAlpha = 1
      o.globalCompositeOperation = 'source-over'
      shot.draw?.(c)
      this.S.render()
    }
  }

  renderFrame(frame: number): string {
    const t = frame / FPS
    const shot = this.shotAt(t)
    if (shot !== this.cur || frame !== this.last + 1) {
      this.cur = shot
      seed(Math.round(shot.start * 1000) + 7)
      this.S.reset()
      const first = Math.round(shot.start * FPS) - Math.round((shot.preroll ?? 0) * FPS)
      shot.setup(this.ctx(shot, first))
      for (let f = first; f < frame; f++) this.stepFrame(shot, f, false)
    }
    this.stepFrame(shot, frame, true)
    this.last = frame
    return shot.name
  }
}
