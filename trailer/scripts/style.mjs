// Render the style-frame board to out/style_sheet.png (3840×2160).
import { mkdirSync, writeFileSync } from 'node:fs'
import * as lib from './lib.mjs'
const { launch, ROOT, startServer } = lib

const server = await startServer()
const { browser, page } = await launch({ width: 1920, height: 1080 })
try {
  await page.goto(`${lib.BASE}?mode=style`)
  await page.waitForFunction(() => window.__styleReady === true, null, { timeout: 300000 })
  const url = await page.evaluate(() => document.getElementById('c').toDataURL('image/png'))
  mkdirSync(`${ROOT}out`, { recursive: true })
  writeFileSync(`${ROOT}out/style_sheet.png`, Buffer.from(url.split(',')[1], 'base64'))
  console.log('wrote out/style_sheet.png')
} finally {
  await browser.close()
  await server.close()
}
