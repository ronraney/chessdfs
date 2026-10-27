// Orchestrates one "Sim my core" run: posts one request to a fresh
// simWorker.ts Worker instance and resolves with its SimResult, or
// rejects on failure -- mirrors fieldWorker.ts/buildFieldCache.ts's own
// split (Worker script vs. main-thread orchestration), minus progress
// reporting (runSimulation's own trial loop has no onProgress callback --
// "Simming…" is this feature's own indeterminate-state text, this task's
// own wording, not a progress bar like field-building's).
//
// `new Worker(...)` itself can throw (most relevantly: there is no global
// Worker at all in this codebase's test environment -- jsdom implements
// no Worker, same standing gap fieldWorker.ts/stockfishEngine.ts already
// have, confirmed by every existing test that reaches a finish screen or
// clicks a Worker-backed button carefully avoiding ever doing so) --
// callers should expect runSimInWorker itself to throw synchronously in
// that case, not just `done` to reject.
import type { ContestConfig } from "./engine/config";
import type { Player, PlayerFields } from "./engine/models";
import type { SlateVegas } from "./engine/sim/draws";
import type { SimulatedField } from "./engine/sim/field";
import type { SimResult } from "./engine/sim/run";
import type { SimWorkerRequest, SimWorkerResponse } from "./simWorker";

function toPlayerFields(p: Player): PlayerFields {
  return {
    id: p.id,
    name: p.name,
    positions: p.positions,
    team: p.team,
    opp: p.opp,
    isHome: p.isHome,
    salary: p.salary,
    proj: p.proj,
    ownSmall: p.ownSmall,
    ownLarge: p.ownLarge,
    floor: p.floor,
    ceiling: p.ceiling,
  };
}

export interface RunSimArgs {
  readonly lineup: readonly Player[];
  readonly contest: ContestConfig;
  readonly entryFee: number;
  readonly field: SimulatedField;
  readonly players: readonly Player[];
  readonly vegas: SlateVegas;
  readonly seed: number;
}

// Returns the live Worker (so the caller can hold onto it and `.terminate()`
// it early -- "if a new sim starts, cancel the old one") alongside a
// Promise that resolves with the SimResult once the worker reports done.
export function runSimInWorker(args: RunSimArgs): { worker: Worker; done: Promise<SimResult> } {
  const worker = new Worker(new URL("./simWorker.ts", import.meta.url), { type: "module" });
  const request: SimWorkerRequest = {
    lineupFields: args.lineup.map(toPlayerFields),
    fieldLineupFields: args.field.lineups.map((lineup) => lineup.map(toPlayerFields)),
    fieldLineupWeight: args.field.lineupWeight,
    playerFields: args.players.map(toPlayerFields),
    vegas: args.vegas,
    contestFieldSize: args.contest.fieldSize,
    payouts: args.contest.payouts.map((tier) => ({ rank: tier.rank, amount: tier.amount })),
    entryFee: args.entryFee,
    seed: args.seed,
  };

  const done = new Promise<SimResult>((resolve, reject) => {
    worker.addEventListener("message", (event: MessageEvent<SimWorkerResponse>) => {
      const message = event.data;
      if (message.type === "done") resolve(message.result);
      else reject(new Error(message.message));
    });
    worker.addEventListener("error", (event) => {
      reject(event.error instanceof Error ? event.error : new Error("Sim worker failed."));
    });
  });

  worker.postMessage(request);
  return { worker, done };
}
