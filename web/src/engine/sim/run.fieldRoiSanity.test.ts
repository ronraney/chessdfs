// Sanity check (this task's own spec): sim every lineup in a cached field
// against that same field; the average ROI across all of them must land
// within a few points of the plain rake identity --
// (prizePool - entries*buyIn) / (entries*buyIn) -- since every one of
// those lineups collectively represents the contest's own entire entry
// pool, and the payout table (payouts.ts) sums to exactly prizePool over
// ranks 1..entries. If this drifts by more than a few points, something
// in payout-table construction, lineupWeight/place scaling, entryFee, or
// tie-splitting is actually broken.
//
// Same SEED for every lineup's own runSimulation call (not a fresh one
// per lineup) -- every lineup then sees the IDENTICAL sequence of
// per-trial outcome draws, so summing their payouts reproduces the exact
// per-trial field total with NO cross-lineup Monte Carlo noise (confirmed
// empirically: trials=5 and trials=50 against the same field produced the
// same aggregate to 10 decimal places). That isolates a real accounting
// bug from ordinary sampling variance, and makes this test fast and
// deterministic rather than needing thousands of trials to converge.
//
// One real, small, UNAVOIDABLE source of drift remains even with correct
// code: computeEffectivePlaceAndPayout (run.ts) always reserves one extra
// rank slot for "the user" on top of whatever it finds tied in the field
// it's handed -- correct for runSimulation's real caller (an external
// lineup never present in field.lineups), but when THIS test turns a
// field member into "the user," that lineup is already counted once via
// its own self-tie in the field array, so the extra reserved slot
// double-counts it by one real entry out of `lineupWeight`. That's why
// the identity is "within a few points," not exact: the drift shrinks as
// ~1/lineupWeight (confirmed: ~102x lineupWeight -> ~0.8pt drift, ~17x ->
// ~3.6pt, ~500x -> ~0.1pt) -- negligible for any real contest, where the
// cached field (a few hundred to ~1000 distinct lineups, DEFAULT_SAMPLE_
// SIZE) stands in for anywhere from hundreds to hundreds of thousands of
// real entries, i.e. lineupWeight comfortably >> 1. This test picks a
// contest/field-size ratio realistic enough to keep that drift small.
import { describe, expect, it } from "vitest";
import nflConfig from "../../data/config/sports/nfl.json";
import { ContestConfig, PayoutTier } from "../config";
import { Player } from "../models";
import { SeededRandom } from "../rng";
import { loadSportConfig } from "../sport";
import type { SlateVegas } from "./draws";
import { generateSimulatedField } from "./field";
import { generatePayoutCurve } from "./payouts";
import { runSimulation } from "./run";

const NFL = loadSportConfig(nflConfig);
const NO_VEGAS: SlateVegas = new Map();
const NUM_TEAMS = 6;

function teamName(i: number): string {
  return `TM${i % NUM_TEAMS}`;
}

function makePlayer(id: string, position: string, salary: number, ownership: number, proj: number, team: string): Player {
  return new Player({
    id,
    name: id,
    positions: [position],
    team,
    opp: "OPP",
    salary,
    proj,
    ownSmall: ownership,
    ownLarge: ownership,
    floor: proj * 0.6,
    ceiling: proj * 1.6,
  });
}

// A modest synthetic pool, same shape as field.test.ts's own fixture --
// enough position/team variety for generateSimulatedField's roster-slot
// and stack constraints to produce a real, somewhat-diverse field.
function buildPool(): Player[] {
  const pool: Player[] = [];
  const qbOwn = [0.3, 0.2, 0.15, 0.1, 0.08, 0.05];
  qbOwn.forEach((own, i) => pool.push(makePlayer(`qb${i}`, "QB", 5000 + i * 500, own, 18 - i, teamName(i))));
  const dstOwn = [0.25, 0.18, 0.15, 0.12, 0.08, 0.05];
  dstOwn.forEach((own, i) => pool.push(makePlayer(`dst${i}`, "DST", 2000 + i * 300, own, 8 - i * 0.5, teamName(i))));
  for (let i = 0; i < 16; i++) {
    const own = i === 0 ? 0.4 : Math.max(0.02, 0.3 - i * 0.02);
    pool.push(makePlayer(`rb${i}`, "RB", 3500 + (i % 8) * 500, own, 16 - i * 0.4, teamName(i)));
  }
  for (let i = 0; i < 20; i++) {
    const own = Math.max(0.01, 0.28 - i * 0.012);
    pool.push(makePlayer(`wr${i}`, "WR", 3000 + (i % 10) * 500, own, 15 - i * 0.3, teamName(i)));
  }
  for (let i = 0; i < 10; i++) {
    const own = Math.max(0.02, 0.22 - i * 0.02);
    pool.push(makePlayer(`te${i}`, "TE", 3000 + (i % 5) * 400, own, 11 - i * 0.3, teamName(i)));
  }
  return pool;
}

describe("field-average ROI sanity check", () => {
  it("average ROI across every field lineup, simmed against the same field, matches the rake identity within a few points", () => {
    const players = buildPool();

    // Real-shaped contest numbers (same magnitude as a real preset in
    // config/contests.json's "Fair Catch" tier): $12 buy-in, 2,450
    // entries, $25,000 prize pool, 10% to first, $25 min cash, 563 paid
    // places.
    const entries = 2450;
    const buyIn = 12;
    const prizePool = 25000;
    const payoutRows = generatePayoutCurve(prizePool, 0.1, 25, 563);
    const payouts = payoutRows.map((r) => new PayoutTier(r));
    expect(payouts.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(prizePool, 6); // payout table itself sums to the real prize pool

    const contest = new ContestConfig({ fieldSize: entries, payouts });
    const field = generateSimulatedField(players, contest, NFL, 60, new SeededRandom(42));
    expect(field.lineups.length).toBeGreaterThan(10); // enough distinct lineups for this check to mean anything

    const SEED = 2026; // same seed for every lineup -- see this file's own header comment
    const TRIALS = 25;
    let totalPayout = 0;
    let totalCost = 0;
    for (const lineup of field.lineups) {
      const result = runSimulation(lineup, contest, buyIn, field, players, NO_VEGAS, NFL, SEED, TRIALS);
      totalPayout += result.roi * TRIALS * buyIn + TRIALS * buyIn;
      totalCost += TRIALS * buyIn;
    }
    const avgRoi = (totalPayout - totalCost) / totalCost;
    const expectedRoi = (prizePool - entries * buyIn) / (entries * buyIn);

    // "A few points" -- generous enough to clear the ~1/lineupWeight
    // self-counting artifact (~0.01 here, given lineupWeight ~100), tight
    // enough to catch a real break in payout units/place scaling/entry
    // fee/ties (any of which showed up as tens-of-points-or-more drift,
    // or an outright wrong sign, in manual testing against this file).
    expect(Math.abs(avgRoi - expectedRoi)).toBeLessThan(0.03);
  });
});
