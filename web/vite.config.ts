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
    // Housekeeping "Faster tests": Vitest's own default otherwise spins up
    // close to one worker PER test file (sessions/HANDOFF.md's own
    // Environment note measured ~23-32 of them on this machine's 8 cores)
    // -- oversubscribing real CPU contention that's the documented cause
    // of this suite's occasional full-run timeout flakiness. Capped well
    // below the 8-core count on purpose: this box's own hard limit turned
    // out to be RAM, not CPU (~2.8GB total, confirmed via `free -h`) --
    // capping at 8 workers measured WORSE (more, not fewer, full-suite
    // timeout failures) than this lower value, each worker's own jsdom +
    // React + chessground + real player-CSV module graph adding up fast.
    // Revisit if this ever runs on a less memory-constrained box.
    maxWorkers: 4,
  },
})
