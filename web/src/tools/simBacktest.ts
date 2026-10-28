// Sim backtest (tool only -- not read by any app code, not wired into the
// UI): runs the sim's own field generator + per-trial draws for one real
// contest and reports where the sim's own score lines (Win / Top-1% /
// cash-line / Median) land, for comparison against that contest's actual
// real-world results. Invoked via `npm run backtest -- <args>`
// (simBacktestCli.ts is the actual CLI entry; see that file's own header
// for why this is a separate module).
//
// Field sizing reuses buildFieldCache.ts's OWN tier-builder constants
// (BUILD_ATTEMPT_CAP, TARGET_DISTINCT_LINEUPS) -- same attempt cap/distinct
// target Admin's "Build fields" uses for every tier -- so this tool's field
// is built exactly the way the app already builds one for the contest's own
// tier (ContestConfig.fieldTier(), via `entries`), not a separately
// invented size.
import { BUILD_ATTEMPT_CAP, TARGET_DISTINCT_LINEUPS } from "../buildFieldCache";
import { ContestConfig } from "../engine/config";
import type { Player } from "../engine/models";
import { SeededRandom } from "../engine/rng";
import { drawSlateOutcomes, type SlateVegas } from "../engine/sim/draws";
import { generateSimulatedField } from "../engine/sim/field";
import { MAX_FIELD_SAMPLE, scoreLineup } from "../engine/sim/run";
import type { SportConfig } from "../engine/sport";

// This tool's own default trial count (2,000) -- deliberately NOT run.ts's
// DEFAULT_TRIAL_COUNT (5,000), which is for a different job (scoring one
// external lineup against a field), per this task's own spec.
export const DEFAULT_TRIALS = 2000;

const NO_VEGAS: SlateVegas = new Map();

// Seeded, uniform, without-replacement sample of `count` items -- the same
// partial Fisher-Yates shuffle as run.ts's own (private) sampleWithoutReplacement.
// Duplicated rather than exported from run.ts, per this task's "tool only,
// no app changes."
function sampleWithoutReplacement<T>(items: readonly T[], count: number, rng: SeededRandom): T[] {
  const pool = [...items];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng.next() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

// Linear-interpolation percentile of a pre-sorted ASCENDING array -- same
// formula as run.ts's own (private) percentile.
function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return NaN;
  const idx = p * (sortedAscending.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (idx - lo);
}

// Empirical percentile RANK (0-100) of `value` within a pre-sorted
// ascending array -- the midpoint/mean-rank convention (a tie splits
// evenly between "below" and "at"). The natural inverse of `percentile`
// above: "what percentile does this real score land at in the sim's own
// distribution of that same line."
function percentileRank(sortedAscending: readonly number[], value: number): number {
  const n = sortedAscending.length;
  if (n === 0) return NaN;
  let below = 0;
  let atValue = 0;
  for (const v of sortedAscending) {
    if (v < value) below++;
    else if (v === value) atValue++;
  }
  return ((below + atValue / 2) / n) * 100;
}

// The score of whichever lineup -- in one trial's DESCENDING-sorted field
// scores -- occupies real-contest place `rank`, given each field lineup
// stands in for `lineupWeight` real entries. Same cumulative-weight
// convention run.ts's own computeEffectivePlaceAndPayout already uses to
// rank one EXTERNAL lineup against a field; this instead walks the field's
// own scores against each other to find "whoever's in Nth" directly.
// `rank` >= 1 and `lineupWeight` > 0; a `rank` past the field's total
// represented weight (lineupWeight * scoresDescending.length) returns the
// lowest (last) score rather than throwing -- the real place is past
// everyone this field represents, so "whoever's last" is the right answer.
export function scoreAtRank(scoresDescending: readonly number[], lineupWeight: number, rank: number): number {
  if (scoresDescending.length === 0) throw new Error("scoreAtRank: no scores to rank");
  let cumWeight = 0;
  for (const score of scoresDescending) {
    cumWeight += lineupWeight;
    if (cumWeight >= rank) return score;
  }
  return scoresDescending[scoresDescending.length - 1];
}

export interface RealLines {
  readonly win: number;
  readonly top1: number;
  readonly cash: number;
  readonly median: number;
}

const LINE_KEYS = ["win", "top1", "cash", "median"] as const;
type LineKey = (typeof LINE_KEYS)[number];

export interface LineBacktest {
  readonly name: LineKey;
  readonly rank: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly real?: number;
  readonly realPercentile?: number; // only set when `real` is given
}

export interface ContestBacktestResult {
  readonly entries: number;
  readonly placesPaid: number;
  readonly trials: number;
  readonly fieldLineupCount: number;
  readonly scoredLineupCount: number;
  readonly sampledDown: boolean; // true once fieldLineupCount > MAX_FIELD_SAMPLE
  readonly lineupWeight: number;
  readonly lines: readonly LineBacktest[];
}

// Runs one contest's backtest: builds the field for `entries`' own tier,
// then for `trials` trials draws one correlated outcome for the whole
// slate and scores every field lineup against it, recording the Win /
// Top-1% / cash-line / Median score each trial. Reports each line's sim
// P10/P50/P90 across trials, and (when `real` is given) where each real
// value falls as a percentile of the sim's own distribution for that line.
export function runContestBacktest(
  players: readonly Player[],
  sport: SportConfig,
  entries: number,
  placesPaid: number,
  seed: number,
  trials: number = DEFAULT_TRIALS,
  real?: RealLines,
): ContestBacktestResult {
  const contest = new ContestConfig({ fieldSize: entries, payouts: [] });
  const rng = new SeededRandom(seed);

  const field = generateSimulatedField(players, contest, sport, BUILD_ATTEMPT_CAP, rng, undefined, TARGET_DISTINCT_LINEUPS);
  if (field.lineups.length === 0) {
    throw new Error("runContestBacktest: the field build produced no lineups at all");
  }

  // "If too slow, sample the field per the existing sampling config" --
  // run.ts's own MAX_FIELD_SAMPLE threshold, same reasoning as runSimulation
  // itself: above this many lineups, every trial scores a seeded uniform
  // sample instead of the whole field, with lineupWeight recomputed against
  // the SAMPLE size so ranks still scale to the contest's real `entries`.
  let scoredLineups = field.lineups;
  let lineupWeight = field.lineupWeight;
  const sampledDown = field.lineups.length > MAX_FIELD_SAMPLE;
  if (sampledDown) {
    scoredLineups = sampleWithoutReplacement(field.lineups, MAX_FIELD_SAMPLE, rng);
    lineupWeight = entries / scoredLineups.length;
  }

  const ranks: Record<LineKey, number> = {
    win: 1,
    top1: Math.max(1, Math.round(entries * 0.01)),
    cash: placesPaid,
    median: Math.max(1, Math.round(entries / 2)),
  };

  const series: Record<LineKey, number[]> = { win: [], top1: [], cash: [], median: [] };

  for (let t = 0; t < trials; t++) {
    const outcomes = drawSlateOutcomes(players, NO_VEGAS, rng);
    const scores = scoredLineups.map((lineup) => scoreLineup(lineup, outcomes)).sort((a, b) => b - a);
    for (const key of LINE_KEYS) series[key].push(scoreAtRank(scores, lineupWeight, ranks[key]));
  }

  const lines: LineBacktest[] = LINE_KEYS.map((key) => {
    const sorted = [...series[key]].sort((a, b) => a - b);
    const realValue = real?.[key];
    return {
      name: key,
      rank: ranks[key],
      p10: percentile(sorted, 0.1),
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      real: realValue,
      realPercentile: realValue !== undefined ? percentileRank(sorted, realValue) : undefined,
    };
  });

  return {
    entries,
    placesPaid,
    trials,
    fieldLineupCount: field.lineups.length,
    scoredLineupCount: scoredLineups.length,
    sampledDown,
    lineupWeight,
    lines,
  };
}
