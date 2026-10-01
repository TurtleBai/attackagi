// Render the score (music + SFX from src/cues.ts) via OfflineAudioContext → out/audio.wav
import { mkdirSync, writeFileSync } from 'node:fs'
import * as lib from './lib.mjs'

const server = await lib.startServer()
const { browser, page } = await lib.launch()
try {
  await page.goto(`${lib.BASE}?mode=audio`)
  await page.waitForFunction(() => typeof window.__wav === 'string', null, { timeout: 300000 })
  const b64 = await page.evaluate(() => window.__wav)
  mkdirSync(`${lib.ROOT}out`, { recursive: true })
  writeFileSync(`${lib.ROOT}out/audio.wav`, Buffer.from(b64, 'base64'))
  console.log('wrote out/audio.wav')
} finally {
  await browser.close()
  await server.close()
}
