// Copies the "stockfish" npm package's two runtime files (stockfish.js,
// stockfish.wasm) into public/stockfish/ (gitignored) so they're served at
// a fixed URL a Web Worker can load directly -- see src/stockfishEngine.ts
// for why they need to live together under public/ rather than going
// through Vite's normal module graph. Mirrors sync-data.mjs's own pattern.
//
// Exported as syncStockfish() -- not just a top-level script -- so
// vite.config.ts's own plugin (see syncStockfishPlugin there) can run it at
// dev-server/build startup too. The npm script alone (package.json's "dev"/
// "build"/"test", each `npm run sync-stockfish && ...`) only covers THAT
// one entry point: anything else that starts Vite (a bare `vite`/`vite
// build`, an IDE run task, a dev server already running from before this
// dependency existed) skips it, leaving public/stockfish/ missing. The .wasm
// request then doesn't 404 -- Vite's dev server falls back to serving its
// own index.html (200, text/html) for any unmatched path -- which reads to
// WebAssembly.instantiate() as a corrupt file ("expected magic word ...
// found 3c 21 64 6f", the start of "<!doctype").
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function syncStockfish() {
  const srcDir = path.join(webRoot, "node_modules", "stockfish", "src");
  const destDir = path.join(webRoot, "public", "stockfish");

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const file of ["stockfish.js", "stockfish.wasm"]) {
    cpSync(path.join(srcDir, file), path.join(destDir, file));
    console.log(`synced node_modules/stockfish/src/${file} -> public/stockfish/${file}`);
  }
}

// Run directly when invoked as `node scripts/sync-stockfish.mjs` (the npm
// script) -- not when imported by vite.config.ts.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncStockfish();
}
