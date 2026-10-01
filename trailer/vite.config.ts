import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The ported game modules import '@/game/*' exactly like the Next app does;
// the alias points that at the trailer's copy (src/port/game) so the copied
// files stay byte-close to their originals.
export default defineConfig({
  resolve: {
    alias: {
      '@/game': fileURLToPath(new URL('./src/port/game', import.meta.url)),
    },
  },
  server: { port: 5199 },
})
