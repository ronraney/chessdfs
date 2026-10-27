// Web Worker wrapper around engine/sim/run.ts's runSimulation. A 5,000-
// trial run measured ~2.4s (Small) to ~10.2s (Large, post field-sampling-
// cap) on the main thread -- long enough to visibly freeze the board if
// run there. Deliberately NOT under engine/ -- spinning up a Worker is
// DOM/I/O, same placement rule fieldWorker.ts/stockfishEngine.ts already
// follow.
//
// Only plain, structured-clone-safe data crosses the postMessage boundary:
// PlayerFields objects (not Player instances -- structured clone drops a
// class's prototype/methods, so `new Player(fields)` reconstructs real
// instances on THIS side, same as fieldWorker.ts) and plain numbers/
// arrays. `vegas` is passed as a real Map -- Map is a structured-clone-
// native type (unlike a class instance), so no array-of-entries
// conversion is needed. The sport config is the same bundled nfl.json
// module every other caller already uses, imported directly rather than
// sent across the boundary at all (fieldWorker.ts's own precedent).
import nflConfig from "./data/config/sports/nfl.json";
import { ContestConfig, PayoutTier } from "./engine/config";
import { Player, type PlayerFields } from "./engine/models";
import type { SlateVegas } from "./engine/sim/draws";
import { runSimulation, type SimResult } from "./engine/sim/run";
import { loadSportConfig } from "./engine/sport";

const NFL = loadSportConfig(nflConfig);

export interface SimWorkerRequest {
  readonly lineupFields: readonly PlayerFields[];
  readonly fieldLineupFields: readonly (readonly PlayerFields[])[];
  readonly fieldLineupWeight: number;
  readonly playerFields: readonly PlayerFields[];
  readonly vegas: SlateVegas;
  readonly contestFieldSize: number;
  readonly payouts: readonly { rank: number; amount: number }[];
  readonly entryFee: number;
  readonly seed: number;
}

export type SimWorkerResponse = { readonly type: "done"; readonly result: SimResult } | { readonly type: "error"; readonly message: string };

addEventListener("message", (event: MessageEvent<SimWorkerRequest>) => {
  const req = event.data;
  try {
    const lineup = req.lineupFields.map((fields) => new Player(fields));
    const fieldLineups = req.fieldLineupFields.map((lineup) => lineup.map((fields) => new Player(fields)));
    const players = req.playerFields.map((fields) => new Player(fields));
    const contest = new ContestConfig({
      fieldSize: req.contestFieldSize,
      payouts: req.payouts.map((tier) => new PayoutTier(tier)),
    });

    const result = runSimulation(
      lineup,
      contest,
      req.entryFee,
      { lineups: fieldLineups, lineupWeight: req.fieldLineupWeight },
      players,
      req.vegas,
      NFL,
      req.seed,
    );
    const done: SimWorkerResponse = { type: "done", result };
    postMessage(done);
  } catch (e) {
    const err: SimWorkerResponse = { type: "error", message: e instanceof Error ? e.message : String(e) };
    postMessage(err);
  }
});
