// Web Worker wrapper around engine/sim/field.ts's generateSimulatedField.
// One MILP solve per lineup is genuinely CPU-heavy (HANDOFF.md: ~14ms/
// attempt isolated, 150-230ms/attempt measured under contention on the
// real ~300-player sample slate -- highly sensitive to concurrent load,
// never safe to assume fast) -- building a 1000-lineup field on the main
// thread would visibly freeze the UI for seconds at a time. Deliberately
// NOT under engine/ -- spinning up a Worker is DOM/I/O, which that
// directory's own rule forbids (see stockfishEngine.ts's identical
// placement reasoning, the one other Worker in this codebase).
//
// Loaded via `new Worker(new URL("./fieldWorker.ts", import.meta.url),
// { type: "module" })` (AdminScreen.tsx) -- Vite's native worker support,
// no plugin needed. Only plain, structured-clone-safe data crosses the
// postMessage boundary: PlayerFields objects (not Player instances --
// postMessage's structured clone drops a class's prototype/methods, so
// `new Player(fields)` reconstructs real instances on THIS side) and
// plain numbers; the sport config is the same bundled nfl.json module
// AdminScreen itself already uses, imported directly rather than sent
// across the boundary at all.
import nflConfig from "./data/config/sports/nfl.json";
import { ContestConfig } from "./engine/config";
import { Player, type PlayerFields } from "./engine/models";
import { SeededRandom } from "./engine/rng";
import { generateSimulatedField } from "./engine/sim/field";
import { loadSportConfig } from "./engine/sport";

const NFL = loadSportConfig(nflConfig);

export interface FieldWorkerRequest {
  readonly playerFields: readonly PlayerFields[];
  // Admin has no real contest selected (it only has a slate) -- a
  // representative fieldSize just picks which tier's ownership
  // (contest.fieldTier()) and default salary cap to build against; the
  // real lineupWeight for whichever contest actually reads this field
  // back out of the cache is recomputed there, not here (see
  // fieldCacheStore.ts's resolveCachedField).
  readonly representativeFieldSize: number;
  readonly sampleSize: number;
  readonly seed: number;
}

export type FieldWorkerResponse =
  | { readonly type: "progress"; readonly completed: number; readonly total: number }
  | { readonly type: "done"; readonly lineupIds: readonly (readonly string[])[] };

addEventListener("message", (event: MessageEvent<FieldWorkerRequest>) => {
  const { playerFields, representativeFieldSize, sampleSize, seed } = event.data;
  const players = playerFields.map((fields) => new Player(fields));
  const contest = new ContestConfig({ fieldSize: representativeFieldSize, payouts: [] });
  const rng = new SeededRandom(seed);

  const field = generateSimulatedField(players, contest, NFL, sampleSize, rng, (completed, total) => {
    const progress: FieldWorkerResponse = { type: "progress", completed, total };
    postMessage(progress);
  });

  const lineupIds = field.lineups.map((lineup) => lineup.map((p) => p.id));
  const done: FieldWorkerResponse = { type: "done", lineupIds };
  postMessage(done);
});
