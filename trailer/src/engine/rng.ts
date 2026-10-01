// Deterministic Math.random: every shot reseeds before its setup so a frame
// renders identically whether reached sequentially or by seeking.

let state = 1

function next(): number {
  // mulberry32
  state = (state + 0x6d2b79f5) | 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function seed(s: number): void {
  state = s | 0
}

export function installDeterministicRandom(): void {
  Math.random = next
}
