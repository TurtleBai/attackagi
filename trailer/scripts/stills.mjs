// Render specific frames to out/stills/fNNNN.png.  Usage: node scripts/stills.mjs 0 120 300 ...
//   or ranges: node scripts/stills.mjs 100-160:10
import { mkdirSync, writeFileSync } from 'node:fs'
import { captureFrame, launch, openTrailer, ROOT, startServer } from './lib.mjs'

const frames = []
for (const a of process.argv.slice(2)) {
  const m = a.match(/^(\d+)-(\d+)(?::(\d+))?$/)
  if (m) for (let f = +m[1]; f <= +m[2]; f += +(m[3] ?? 1)) frames.push(f)
  else frames.push(+a)
}
const dir = `${ROOT}out/stills`
mkdirSync(dir, { recursive: true })
const server = await startServer()
const { browser, page } = await launch()
try {
  await openTrailer(page)
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2')
    const d = c.getExtension('WEBGL_debug_renderer_info')
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'
  })
  console.log('GL:', gl)
  for (const f of frames) {
    const t0 = Date.now()
    const png = await captureFrame(page, f)
    writeFileSync(`${dir}/f${String(f).padStart(4, '0')}.png`, png)
    console.log(`frame ${f} ${Date.now() - t0}ms`)
  }
} finally {
  await browser.close()
  await server.close()
}
