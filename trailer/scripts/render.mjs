// Full render: Playwright steps the timeline frame by frame (window.__trailer.renderFrame),
// reads each 1920×1080 frame straight off the WebGL canvas, pipes PNGs into ffmpeg,
// then muxes the OfflineAudioContext score (out/audio.wav, rendered from the same cues).
// Usage: node scripts/render.mjs [from=0] [to=899] [--review N]  (saves every Nth frame to out/review)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { captureFrame, launch, openTrailer, ROOT, startServer } from './lib.mjs'

const args = process.argv.slice(2)
const reviewIdx = args.indexOf('--review')
const review = reviewIdx >= 0 ? Number(args[reviewIdx + 1]) : 6
const nums = args.filter((a, i) => /^\d+$/.test(a) && i !== reviewIdx + 1).map(Number)
const from = nums[0] ?? 0
const out = `${ROOT}out`
mkdirSync(out, { recursive: true })
if (existsSync(`${out}/review`)) rmSync(`${out}/review`, { recursive: true })
mkdirSync(`${out}/review`, { recursive: true })

const server = await startServer()
const { browser, page } = await launch()
const silent = `${out}/video_silent.mp4`
const ff = spawn('ffmpeg', [
  '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
  '-movflags', '+faststart', silent,
], { stdio: ['pipe', 'inherit', 'inherit'] })
const t0 = Date.now()
try {
  await openTrailer(page)
  const total = await page.evaluate(() => window.__trailer.totalFrames)
  const to = nums[1] ?? total - 1
  for (let f = from; f <= to; f++) {
    const png = await captureFrame(page, f)
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r))
    if (review && f % review === 0) writeFileSync(`${out}/review/f${String(f).padStart(4, '0')}.png`, png)
    if (f % 60 === 0) console.log(`frame ${f}/${to}  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }
} finally {
  ff.stdin.end()
  await browser.close()
  await server.close()
}
const code = await new Promise((r) => ff.on('close', r))
if (code !== 0) throw new Error(`ffmpeg exited ${code}`)
console.log(`video done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
if (existsSync(`${out}/audio.wav`)) {
  const final = `${out}/attack-agi-trailer.mp4`
  await new Promise((res, rej) => spawn('ffmpeg', [
    '-loglevel', 'error', '-y', '-i', silent, '-i', `${out}/audio.wav`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', final,
  ], { stdio: 'inherit' }).on('close', (c) => (c === 0 ? res() : rej(new Error(`mux ${c}`)))))
  console.log(`wrote ${final}`)
  // Twitter/X upload: H.264 High@4.2, 1080p60, ~16 Mbps VBR (cap 25), AAC 192k, faststart
  const tw = `${out}/attack-agi-trailer-twitter.mp4`
  await new Promise((res, rej) => spawn('ffmpeg', [
    '-loglevel', 'error', '-y', '-i', final, '-i', `${out}/audio.wav`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
    '-maxrate', '25M', '-bufsize', '50M', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
    '-g', '60', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', tw,
  ], { stdio: 'inherit' }).on('close', (c) => (c === 0 ? res() : rej(new Error(`twitter encode ${c}`)))))
  console.log(`wrote ${tw}`)
  // integrity gate: both deliverables must decode with zero errors
  for (const f of [final, tw]) {
    const err = await new Promise((res) => {
      let buf = ''
      const p = spawn('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-'])
      p.stderr.on('data', (d) => { buf += d })
      p.on('close', () => res(buf.trim()))
    })
    if (err) throw new Error(`decode errors in ${f}:\n${err.slice(0, 400)}`)
    console.log(`verified ${f}`)
  }
}
