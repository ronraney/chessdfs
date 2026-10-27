// Orchestrates one Admin "Build fields" run: one Worker-run build per
// ownership tier (Small/Mid/Large), written into fieldCacheStore as each
// tier completes. NOT unit-tested directly -- spinning up a real Worker
// needs a real browser, the same standing gap as stockfishEngine.ts's own
// Worker (see sessions/HANDOFF.md: "no browser can launch in this
// environment at all"); AdminScreen.test.tsx covers everything around
// this function (gating, cache display, clear-on-upload/clear) without
// ever clicking the button that reaches it, same as BuildScreen's tests
// never drive Black out of book far enough to invoke stockfishEngine.
import { FieldTier, type Player, type PlayerFields } from "./engine/models";
import { DEFAULT_TARGET_DISTINCT_LINEUPS } from "./engine/sim/field";
import { saveCachedFieldIds } from "./fieldCacheStore";
import type { FieldWorkerRequest, FieldWorkerResponse } from "./fieldWorker";

export const BUILD_TIERS: readonly FieldTier[] = [FieldTier.SMALL, FieldTier.MID, FieldTier.LARGE];

// Admin has no real contest selected to build against -- these just need
// to land in each tier's own ContestConfig.fieldTier() bucket (Small <
// 2,000 entries, Mid < 10,000, Large >= 10,000); the exact number
// otherwise doesn't matter (see fieldWorker.ts's own comment on why, and
// fieldCacheStore.ts's resolveCachedField for how a real contest's own
// fieldSize is substituted back in at read time).
const REPRESENTATIVE_FIELD_SIZE: Record<FieldTier, number> = {
  [FieldTier.SMALL]: 1000,
  [FieldTier.MID]: 5000,
  [FieldTier.LARGE]: 50000,
};

// This task's own target: every tier's cached field should contain at
// least this many DISTINCT 9-player combinations, not just this many
// accepted attempts.
export const TARGET_DISTINCT_LINEUPS = DEFAULT_TARGET_DISTINCT_LINEUPS;

// The attempt CAP -- "stop at a sensible attempt cap and report the
// shortfall" (this task's own wording). Measured on the real sample slate
// (301 players, data/samples/NFL Weekly DFS System - Projections.csv):
// distinct-lineup count grows roughly logarithmically in attempts (the
// ownership-bias objective keeps re-finding the same handful of best-
// scoring combos well before exposure caps force real variety) -- ~624
// distinct at 1,000 attempts, ~2,671 at 10,000 (Mid tier), and a log-curve
// fit through those points puts 5,000 distinct at roughly 135,000+
// attempts, which at the ~10ms/attempt measured here would take 20+
// minutes PER TIER. 10,000 attempts (~100s/tier measured) is this
// session's own judgment call for "sensible" -- a real improvement over
// the old flat 1,000 (roughly 4x the distinct count), without turning
// "Build fields" into a many-minutes-per-tier wait. Flagged as a guess,
// not spec'd: Ron may want this tuned differently once he's felt the
// actual wait in a real browser.
export const BUILD_ATTEMPT_CAP = 10000;

// A fixed seed for every admin-triggered build -- there's no per-build
// "seed" concept exposed anywhere in this app yet, and this task only
// asked for determinism-by-construction (SeededRandom), not a specific
// number. Flagged as a guessed choice, not spec'd.
const BUILD_SEED = 20261019;

function runOneTier(
  playerFields: readonly PlayerFields[],
  tier: FieldTier,
  onProgress: (completed: number, total: number, distinct: number, targetDistinct: number) => void,
): Promise<readonly (readonly string[])[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fieldWorker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<FieldWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress(message.completed, message.total, message.distinct, message.targetDistinct);
        return;
      }
      worker.terminate();
      resolve(message.lineupIds);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(event.error ?? new Error("field build worker failed"));
    });
    const request: FieldWorkerRequest = {
      playerFields,
      representativeFieldSize: REPRESENTATIVE_FIELD_SIZE[tier],
      sampleSize: BUILD_ATTEMPT_CAP,
      seed: BUILD_SEED,
      targetDistinct: TARGET_DISTINCT_LINEUPS,
    };
    worker.postMessage(request);
  });
}

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

// Builds all three tiers, sequentially (one MILP batch of CPU work at a
// time, and an unambiguous "which tier is this progress for" callback),
// writing each tier into the cache as soon as it completes rather than
// waiting for all three to finish first.
export async function buildAndCacheFields(
  signature: string,
  players: readonly Player[],
  onProgress: (tier: FieldTier, completed: number, total: number, distinct: number, targetDistinct: number) => void,
): Promise<void> {
  const playerFields = players.map(toPlayerFields);
  for (const tier of BUILD_TIERS) {
    const lineupIds = await runOneTier(playerFields, tier, (completed, total, distinct, targetDistinct) =>
      onProgress(tier, completed, total, distinct, targetDistinct),
    );
    saveCachedFieldIds(signature, tier, lineupIds);
  }
}
