// Evaluate an expression after rendering a frame: node scripts/probe.mjs <frame> "<js using S>"
import { launch, openTrailer, startServer } from './lib.mjs'
const [frame, expr] = process.argv.slice(2)
const server = await startServer()
const { browser, page } = await launch()
try {
  await openTrailer(page)
  const out = await page.evaluate(([f, e]) => { window.__trailer.renderFrame(+f); const S = window.__stage; return JSON.stringify(eval(e)) }, [frame, expr])
  console.log(out)
} finally { await browser.close(); await server.close() }
