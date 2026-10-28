// Standalone bundler config for simBacktestCli.ts ONLY -- the app's own
// vite.config.ts is untouched. This app's tsconfig uses extensionless,
// bundler-style module resolution, which plain Node can't follow on its
// own; this bundles the CLI tool (and every dependency, including CJS
// deps like papaparse/yalps -- `ssr.noExternal: true`, since leaving them
// as plain external ESM imports hits Node's own CJS/ESM named-export
// interop limits for some of them) into one script `npm run backtest`
// then runs directly with `node`.
import { defineConfig } from "vite";

export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: "src/tools/simBacktestCli.ts",
    outDir: ".tmp-backtest",
    emptyOutDir: true,
    rollupOptions: { output: { format: "es" } },
  },
});
