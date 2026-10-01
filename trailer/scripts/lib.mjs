// Shared Playwright + Vite harness: boots the dev server in-process, launches
// Chromium with GPU-backed WebGL (ANGLE/Metal), and exposes frame capture.
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export let BASE = 'http://localhost:5199/'

export async function startServer() {
  const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, strictPort: false } })
  await server.listen()
  BASE = server.resolvedUrls.local[0]
  return server
}

export async function launch({ width = 1920, height = 1080 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
      '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required',
    ],
  })
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 400)) })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  return { browser, page }
}

export async function openTrailer(page, query = '') {
  await page.goto(`${BASE}${query}`)
  await page.waitForFunction(() => window.__trailer && window.__trailer.ready, null, { timeout: 180000 })
}

/** Render frame n and return its PNG bytes (read straight off the WebGL canvas). */
export async function captureFrame(page, n, type = 'image/png', quality) {
  const dataUrl = await page.evaluate(([n, type, quality]) => {
    window.__trailer.renderFrame(n)
    return document.getElementById('c').toDataURL(type, quality)
  }, [n, type, quality])
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}
