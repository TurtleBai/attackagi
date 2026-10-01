import { logosReady } from './port/components/Enemies.decals'
import { installDeterministicRandom } from './engine/rng'
import { Stage } from './engine/stage'
import { FPS, Timeline, TOTAL_FRAMES } from './engine/timeline'
import { SHOTS } from './shots'

// Entry. Modes (query string):
//   (default)        trailer; window.__trailer.renderFrame(n) for capture
//   ?frame=N         render a single frame for preview
//   ?play            realtime-ish preview loop (still frame-stepped)
//   ?mode=style      style sheet board

declare global {
  interface Window {
    __trailer?: {
      ready: boolean
      fps: number
      totalFrames: number
      renderFrame: (n: number) => string
    }
    __styleReady?: boolean
  }
}

async function boot(): Promise<void> {
  installDeterministicRandom()
  const params = new URLSearchParams(location.search)
  await Promise.all([
    document.fonts.load('900 64px "Geist Mono"'),
    document.fonts.load('700 64px "Geist Mono"'),
    document.fonts.load('500 64px "Geist Mono"'),
    document.fonts.load('400 64px "Geist Mono"'),
    document.fonts.load('900 64px "Geist"'),
    document.fonts.load('700 64px "Geist"'),
    document.fonts.load('500 64px "Geist"'),
    document.fonts.load('400 64px "Geist Pixel"'),
    document.fonts.load('400 64px "Geist Pixel Grid"'),
  ])
  await logosReady()
  const canvas = document.getElementById('c') as HTMLCanvasElement
  if (params.get('mode') === 'audio') {
    const { renderScore, toWav } = await import('./audio/score')
    const buf = await renderScore()
    const wav = new Uint8Array(toWav(buf))
    let bin = ''
    for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode(...wav.subarray(i, i + 0x8000))
    ;(window as unknown as { __wav: string }).__wav = btoa(bin)
    return
  }
  if (params.get('mode') === 'style') {
    const { renderStyleSheet } = await import('./style/sheet')
    await renderStyleSheet(canvas)
    window.__styleReady = true
    return
  }
  const stage = new Stage(canvas)
  const tl = new Timeline(stage, SHOTS)
  ;(window as unknown as { __stage: Stage }).__stage = stage
  // warm every shader program once (scene is fully populated after reset)
  stage.renderer.compile(stage.scene, stage.camera)
  window.__trailer = {
    ready: true, fps: FPS, totalFrames: TOTAL_FRAMES,
    renderFrame: (n: number) => tl.renderFrame(n),
  }
  if (params.has('frame')) tl.renderFrame(Number(params.get('frame')))
  if (params.has('play')) {
    document.body.classList.add('fit')
    let f = Number(params.get('from') ?? 0)
    const loop = () => {
      tl.renderFrame(f)
      f = (f + 1) % TOTAL_FRAMES
      requestAnimationFrame(loop)
    }
    loop()
  }
}

boot()
