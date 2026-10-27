import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { syncStockfish } from './scripts/sync-stockfish.mjs'

// Belt-and-suspenders for package.json's own `npm run sync-stockfish && ...`
// prefix on "dev"/"build"/"test": that only runs for THOSE exact npm
// scripts, so anything else that starts Vite directly (a bare `vite`, an
// IDE run task, a dev server left running from before the "stockfish"
// dependency existed) skips it, leaving public/stockfish/ missing -- see
// scripts/sync-stockfish.mjs's own header for what that breaks. Called here
// at config-module-eval time, not from a plugin hook (buildStart runs too
// late -- Vite snapshots its publicDir file list before any plugin hook
// fires, so files a buildStart hook creates still 404-to-index.html for the
// server's whole lifetime even though they're genuinely on disk).
syncStockfish()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Pure engine tests stay on the default 'node' environment (jsdom adds
    // real overhead -- see App.test.tsx's own `@vitest-environment jsdom`
    // comment for the one file that needs a DOM).
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
  },
})
