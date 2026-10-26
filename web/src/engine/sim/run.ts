// Monte Carlo trial loop: scores the user's lineup and a simulated field
// against correlated per-trial draws, ranks the user, pays from the
// contest's payout table, and aggregates into ROI/cash rate/top-1% rate/
// finish-place percentiles. Ported from rraney/nfl-dfs's runSimulation_ +
// scoreLineup_ + computeEffectivePlaceAndPayout_ + aggregateSimResults_
// (sim_trial_loop.js, Parts C/D) -- the batch variant (runSimulationBatch_,
// grading many lineups against one shared per-trial draw+field pass) is
// not ported; this task asked for one lineup at a time.
//
// Pure and seeded, same discipline as draws.ts/field.ts: no I/O, the only
// randomness is the injected seed. The field itself is NOT read from
// fieldCacheStore here (that's browser localStorage -- I/O) -- the caller
// resolves the cached field for the contest's tier via
// fieldCacheStore.resolveCachedField first (which already recomputes
// lineupWeight = contest.fieldSize / lineups.length against the REAL
// contest asking, i.e. "resample to the contest's actual entries... using
// lineupWeight" from this task's own wording) and passes the resulting
// SimulatedField straight in.
//
// Signature note (flagged, not silent): the task named this
// `runSimulation(lineup, contest)`, but scoring a trial needs more than
// those two -- the full slate pool + Vegas (to draw correlated outcomes
// the same way field.ts's own players were drawn against), the resolved
// field, the sport config (roster-completeness check, dome teams), an
// explicit seed (no unseeded randomness allowed), and the contest's entry
// fee for ROI (ContestConfig itself carries no entryFee/buyIn field --
// that lives one level up, on config.ts's ContestPreset, so adding it to
// ContestConfig would mean threading a new required field through every
// existing `new ContestConfig(...)` test fixture in the suite for a value
// only this one caller needs). Grew the real signature instead of
// shrinking the task to fit two params.
import type { ContestConfig, PayoutTier } from "../config";
import { isLineupComplete } from "../rules";
import type { Player } from "../models";
import { SeededRandom } from "../rng";
import type { SportConfig } from "../sport";
import { drawSlateOutcomes, type SlateVegas } from "./draws";
import type { SimulatedField } from "./field";

// nfl-dfs's CONFIG_DEFAULT_TRIAL_COUNT_ (config_workbooks.js) -- the real,
// currently-live default (Config!B3's seeded value), not the 1000 a
// different, quick manual-single-lineup UI prompt in sim_trial_loop.js
// falls back to when its own prompt is left blank. Exported so a caller/
// test can cite it explicitly, same `DEFAULT_SAMPLE_SIZE` precedent as
// field.ts.
export const DEFAULT_TRIAL_COUNT = 5000;

export interface TrialResult {
  readonly trial: number;
  readonly userScore: number;
  readonly place: number;
  readonly payout: number;
}

export interface FinishPercentiles {
  readonly P10: number;
  readonly P25: number;
  readonly P50: number;
  readonly P75: number;
  readonly P90: number;
}

// roi/cashRate/top1Rate are fractions (0..1), not percentages -- same
// internal representation nfl-dfs itself uses (its own Logger/sheet output
// multiplies by 100 only for display, which has no equivalent here: no UI
// in this task, Sim 4's job). top1Rate is the fraction of trials finishing
// in place 1 exactly -- a literal win rate, a different number from
// nfl-dfs's own "Top1pct_ROI" (dollar return over the top 1% of trials BY
// PAYOUT) despite the similar name; paired with cashRate (also a bare
// frequency, not a dollar figure) in this same return shape, "Rate" reads
// as frequency here, not nfl-dfs's ROI-flavored "Top1pct_ROI" metric.
export interface SimResult {
  readonly roi: number;
  readonly cashRate: number;
  readonly top1Rate: number;
  readonly finishPercentiles: FinishPercentiles;
}

// Sums a lineup's drawn outcomes -- identical logic for the user's lineup
// and every field lineup (nfl-dfs's own scoreLineup_, reused both ways).
export function scoreLineup(lineup: readonly Player[], outcomes: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const p of lineup) sum += outcomes.get(p.id) ?? 0;
  return sum;
}

function payoutByRank(payouts: readonly PayoutTier[]): ReadonlyMap<number, number> {
  const m = new Map<number, number>();
  for (const tier of payouts) m.set(tier.rank, tier.amount);
  return m;
}

// Ranks the user against one trial's field scores and looks up a payout.
// Ported one-for-one from nfl-dfs's computeEffectivePlaceAndPayout_: see
// that function's own doc comment (sim_trial_loop.js) for the full
// reasoning -- effective place = (sum of lineupWeight for every field
// lineup that outscored the user) + 1, rounded CONSERVATIVELY (place
// rounds up / Math.ceil, since payouts are non-increasing in place --
// "round the payout down" means "round the place up"). A tie (one or more
// field lineups scoring exactly equal to the user) splits the tied
// place-range's payouts evenly across that range, including the user's
// own tied slot -- the standard DK tie rule.
export function computeEffectivePlaceAndPayout(
  userScore: number,
  fieldScores: readonly number[],
  lineupWeight: number,
  payouts: ReadonlyMap<number, number>,
): { place: number; payout: number } {
  let weightAhead = 0;
  let weightTied = 0;
  for (const s of fieldScores) {
    if (s > userScore) weightAhead += lineupWeight;
    else if (s === userScore) weightTied += lineupWeight;
  }

  const placeFrom = Math.ceil(weightAhead) + 1;
  const placeTo = Math.ceil(weightAhead + weightTied) + 1;
  if (placeTo <= placeFrom) {
    return { place: placeFrom, payout: payouts.get(placeFrom) ?? 0 };
  }

  let sum = 0;
  let n = 0;
  for (let p = placeFrom; p <= placeTo; p++) {
    sum += payouts.get(p) ?? 0;
    n++;
  }
  return { place: placeFrom, payout: n > 0 ? sum / n : 0 };
}

// Linear-interpolation percentile of a PRE-SORTED (ascending) array.
// Ported verbatim from nfl-dfs's percentile_.
function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return NaN;
  const idx = p * (sortedAscending.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (idx - lo);
}

// Part D aggregation: Sim ROI, Cash Rate, top-1% (win) rate, and finish-
// place percentiles. Exported separately from runSimulation so scoring/
// payout correctness can be tested against hand-built TrialResult[]
// fixtures directly, without needing a real correlated draw to land on
// exact scores (same reason nfl-dfs keeps aggregateSimResults_ as its own
// separately-callable pure function, distinct from runSimulation_ itself).
export function aggregateResults(results: readonly TrialResult[], entryFee: number): SimResult {
  const trialCount = results.length;
  const totalPayout = results.reduce((s, r) => s + r.payout, 0);
  const totalCost = trialCount * entryFee;
  const roi = totalCost > 0 ? (totalPayout - totalCost) / totalCost : 0;
  const cashRate = trialCount > 0 ? results.filter((r) => r.payout > 0).length / trialCount : 0;
  const top1Rate = trialCount > 0 ? results.filter((r) => r.place === 1).length / trialCount : 0;

  const places = results.map((r) => r.place).sort((a, b) => a - b);
  const finishPercentiles: FinishPercentiles = {
    P10: percentile(places, 0.1),
    P25: percentile(places, 0.25),
    P50: percentile(places, 0.5),
    P75: percentile(places, 0.75),
    P90: percentile(places, 0.9),
  };

  return { roi, cashRate, top1Rate, finishPercentiles };
}

// The trial loop itself. Draws one correlated outcome per player each
// trial (drawSlateOutcomes, draws.ts), scores the user's lineup and every
// field lineup, ranks, pays, and aggregates -- ported from nfl-dfs's
// runSimulation_ (field generation itself is NOT called here each run,
// same "field composition doesn't change per trial" reasoning nfl-dfs's
// own comment gives, except here the field is a pre-built, pre-cached
// input rather than something this function builds).
//
// `lineup` must be a complete roster (sport.rosterSize players, every
// roster slot fillable) -- thrown, not silently scored, same fail-loudly
// convention nfl-dfs's own loadUserLineup_ uses for an invalid lineup.
// `players` must be the SAME full slate pool the cached `field`'s lineups
// were drawn from (drawSlateOutcomes needs every player referenced by
// either the user's lineup or any field lineup to have an outcome drawn
// for it).
export function runSimulation(
  lineup: readonly Player[],
  contest: ContestConfig,
  entryFee: number,
  field: SimulatedField,
  players: readonly Player[],
  vegas: SlateVegas,
  sport: SportConfig,
  seed: number,
  trialCount: number = DEFAULT_TRIAL_COUNT,
): SimResult {
  if (!isLineupComplete(lineup, sport)) {
    throw new Error(`runSimulation: lineup is not a complete ${sport.rosterSize}-player roster`);
  }
  if (field.lineups.length === 0) {
    throw new Error("runSimulation: field has no lineups to rank against");
  }

  const rng = new SeededRandom(seed);
  const payouts = payoutByRank(contest.payouts);
  const results: TrialResult[] = [];

  for (let trial = 1; trial <= trialCount; trial++) {
    const outcomes = drawSlateOutcomes(players, vegas, rng, sport.domeTeams);
    const userScore = scoreLineup(lineup, outcomes);
    const fieldScores = field.lineups.map((fieldLineup) => scoreLineup(fieldLineup, outcomes));
    const { place, payout } = computeEffectivePlaceAndPayout(userScore, fieldScores, field.lineupWeight, payouts);
    results.push({ trial, userScore, place, payout });
  }

  return aggregateResults(results, entryFee);
}
