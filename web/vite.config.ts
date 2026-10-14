import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

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
