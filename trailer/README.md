# ATTACK AGI: 30 s trailer

Standalone Vite + three.js project that renders the trailer from code, using
ports of the game's real models, procedural textures and shaders
(`src/port/`, copied from `../src/components/game` and `../src/game/gfx`).

- `src/cues.ts`: the one timeline. It holds the shot boundaries and every timed
  event, and the picture and the score both read it.
- `src/shots/`: the shots. Each one is stepped frame by frame from the timeline
  clock (60 fps, fixed dt, seeded RNG), never from wall-clock time.
- `src/audio/score.ts`: music and SFX, synthesized in an OfflineAudioContext
  from the same cues.
- `src/style/sheet.ts`: the style frame board (`out/style_sheet.png`).

```sh
pnpm install
node scripts/style.mjs          # style sheet → out/style_sheet.png
node scripts/audio.mjs          # score → out/audio.wav
node scripts/render.mjs         # 1800 frames via Playwright → ffmpeg → out/attack-agi-trailer*.mp4 (verifies both decode cleanly)
node scripts/stills.mjs 0 210 540   # individual frames → out/stills
node scripts/contact.mjs 6 320  # contact sheet of out/stills
node scripts/filmstrip.mjs      # six frames per shot from the rendered video, for review
pnpm dev                        # http://localhost:5199/?play  (preview), ?frame=N
```

The Geist, Geist Mono and Geist Pixel fonts in `public/fonts` are by Vercel,
licensed under the SIL Open Font License 1.1 (`public/fonts/OFL.txt`).
