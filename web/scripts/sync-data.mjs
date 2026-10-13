// Copies the Python engine's data/openings/, data/samples/, and config/
// into web/src/data/ (gitignored) so the web app can read them. Originals
// are never touched.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(webRoot);
const destRoot = path.join(webRoot, "src", "data");

const copies = [
  [path.join(repoRoot, "data", "openings"), path.join(destRoot, "openings")],
  [path.join(repoRoot, "data", "samples"), path.join(destRoot, "samples")],
  [path.join(repoRoot, "config"), path.join(destRoot, "config")],
];

rmSync(destRoot, { recursive: true, force: true });
for (const [src, dest] of copies) {
  cpSync(src, dest, { recursive: true });
  console.log(`synced ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, dest)}`);
}
