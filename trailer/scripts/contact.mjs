// Contact sheet of rendered stills → out/contact.png, labelled "frame  time".
// Usage: node scripts/contact.mjs [cols=4] [width=560] [dir=out/stills] [outfile=out/contact.png]
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { ROOT } from './lib.mjs'

const cols = process.argv[2] ?? '4'
const width = process.argv[3] ?? '560'
const dir = `${ROOT}${process.argv[4] ?? 'out/stills'}`
const outFile = `${ROOT}${process.argv[5] ?? 'out/contact.png'}`
const files = readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort()
const args = ['-font', '/Users/aidenybai/Library/Fonts/GeistMono-Bold.ttf', '-pointsize', '18', '-fill', '#ffd84a', '-background', '#111']
for (const f of files) {
  const n = Number(f.slice(1, -4))
  args.push('-label', `${n}  ${(n / 60).toFixed(3)}s`, `${dir}/${f}`)
}
args.push('-tile', `${cols}x`, '-geometry', `${width}x+4+4`, outFile)
execFileSync('montage', args)
console.log(`wrote ${outFile} (${files.length} frames)`)
