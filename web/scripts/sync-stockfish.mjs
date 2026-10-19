// Copies the "stockfish" npm package's two runtime files (stockfish.js,
// stockfish.wasm) into public/stockfish/ (gitignored) so they're served at
// a fixed URL a Web Worker can load directly -- see src/stockfishEngine.ts
// for why they need to live together under public/ rather than going
// through Vite's normal module graph. Mirrors sync-data.mjs's own pattern.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(webRoot, "node_modules", "stockfish", "src");
const destDir = path.join(webRoot, "public", "stockfish");

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
for (const file of ["stockfish.js", "stockfish.wasm"]) {
  cpSync(path.join(srcDir, file), path.join(destDir, file));
  console.log(`synced node_modules/stockfish/src/${file} -> public/stockfish/${file}`);
}
