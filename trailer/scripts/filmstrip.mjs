// Review aid: N evenly spaced frames per shot from a rendered video, one row per shot.
// Usage: node scripts/filmstrip.mjs [video=out/attack-agi-trailer-twitter.mp4] [perShot=6] [width=300]
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { ROOT } from './lib.mjs'

const video = `${ROOT}${process.argv[2] ?? 'out/attack-agi-trailer-twitter.mp4'}`
const per = Number(process.argv[3] ?? 6)
const width = process.argv[4] ?? '300'
const src = (await import('node:fs')).readFileSync(`${ROOT}src/cues.ts`, 'utf8')
const block = src.slice(src.indexOf('export const SHOT = {'), src.indexOf('} as const'))
const shots = [...block.matchAll(/(\w+): \[([\d.]+), ([\d.]+)\]/g)].map((m) => [m[1], +m[2], +m[3]])
const dir = `${ROOT}out/strip`
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const rows = []
for (const [name, a, b] of shots) {
  const files = []
  for (let i = 0; i < per; i++) {
    const t = a + 0.02 + ((b - a - 0.04) * i) / (per - 1)
    const f = `${dir}/${name}_${i}.png`
    execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-1`, f])
    files.push('-label', `${name} ${t.toFixed(2)}s`, f)
  }
  rows.push(files)
}
const half = Math.ceil(rows.length / 2)
for (const [k, part] of [rows.slice(0, half), rows.slice(half)].entries()) {
  execFileSync('montage', ['-font', '/Users/aidenybai/Library/Fonts/GeistMono-Bold.ttf', '-pointsize', '14', '-fill', '#ffd84a', '-background', '#111',
    ...part.flat(), '-tile', `${per}x`, '-geometry', '+3+3', `${ROOT}out/filmstrip${k + 1}.png`])
}
console.log('wrote out/filmstrip1.png, out/filmstrip2.png')
