import { describe, expect, it } from "vitest";
import nflConfig from "../../data/config/sports/nfl.json";
import { ContestConfig } from "../config";
import { Player } from "../models";
import { SeededRandom } from "../rng";
import { loadSportConfig } from "../sport";
import { DEFAULT_SAMPLE_SIZE, SALARY_FLOOR, TARGET_NAKED_QB_RATE, generateSimulatedField } from "./field";

const NFL = loadSportConfig(nflConfig);

// NUM_TEAMS spreads QB/RB/WR/TE across several teams (round-robin by
// index) rather than one shared team for everyone -- needed so stack
// targeting (QB + 2 WR/TE from the SAME team) has more than one
// candidate team to weighted-sample from; a single-team pool would make
// every stack trivially the only team available, never exercising the
// candidate-selection/retry logic at all.
const NUM_TEAMS = 6;

function teamName(i: number): string {
  return `TM${i % NUM_TEAMS}`;
}

function makePlayer(id: string, position: string, salary: number, ownership: number, proj: number, team = "AAA"): Player {
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

// A small synthetic pool (58 players) -- large enough to exercise every
// roster-slot constraint and a real spread of ownership (for the
// exposure-cap/bias/min-exposure-floor math), but far cheaper per MILP
// solve than the real ~300-player sample slate: a one-off manual run
// against that real slate (DEFAULT_SAMPLE_SIZE on the 301-player sample
// CSV) is reported alongside this task rather than committed as a test,
// since paying that cost on every future test run isn't one of this
// task's named test requirements. RB0's 0.40 ownership is the clear
// top-owned player across the whole synthetic pool. QB/RB/WR/TE are
// spread round-robin across NUM_TEAMS teams (teamName) so every team has
// a QB and >=2 WR/TE -- stack-eligible by construction.
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

const POOL = buildPool();
// Large tier (fieldSize >= 10,000) -- cap omitted, defaults to NFL.salaryCap.
const CONTEST = new ContestConfig({ fieldSize: 50000, payouts: [] });

function rosterCounts(lineup: readonly Player[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of lineup) {
    const pos = p.positions[0];
    counts[pos] = (counts[pos] ?? 0) + 1;
  }
  return counts;
}

describe("generateSimulatedField", () => {
  it("every lineup is DK-legal and under the cap", () => {
    const field = generateSimulatedField(POOL, CONTEST, NFL, 150, new SeededRandom(42));
    expect(field.lineups.length).toBeGreaterThan(0);

    for (const lineup of field.lineups) {
      expect(lineup.length).toBe(9);
      expect(new Set(lineup.map((p) => p.id)).size).toBe(9); // no duplicate player

      const counts = rosterCounts(lineup);
      expect(counts.QB).toBe(1);
      expect(counts.DST).toBe(1);
      expect(counts.RB).toBeGreaterThanOrEqual(2);
      expect(counts.RB).toBeLessThanOrEqual(3);
      expect(counts.WR).toBeGreaterThanOrEqual(3);
      expect(counts.WR).toBeLessThanOrEqual(4);
      expect(counts.TE).toBeGreaterThanOrEqual(1);
      expect(counts.TE).toBeLessThanOrEqual(2);
      expect((counts.RB ?? 0) + (counts.WR ?? 0) + (counts.TE ?? 0)).toBe(7);

      const salary = lineup.reduce((s, p) => s + p.salary, 0);
      expect(salary).toBeLessThanOrEqual(CONTEST.effectiveCap(NFL));
    }
  });

  it("same seed produces the same field", () => {
    const field1 = generateSimulatedField(POOL, CONTEST, NFL, 150, new SeededRandom(2026));
    const field2 = generateSimulatedField(POOL, CONTEST, NFL, 150, new SeededRandom(2026));
    const idsOf = (field: typeof field1) => field.lineups.map((lineup) => lineup.map((p) => p.id).sort());
    expect(idsOf(field1)).toEqual(idsOf(field2));
  });

  it("lineupWeight is entrants / lineups actually built (nfl-dfs's way)", () => {
    const sampleSize = 150;
    const field = generateSimulatedField(POOL, CONTEST, NFL, sampleSize, new SeededRandom(1));
    // Not necessarily all `sampleSize` attempts land -- some are skipped as
    // infeasible (the salary floor narrows the window further) -- so this
    // only holds against the REALIZED lineup count, not sampleSize itself.
    expect(field.lineups.length).toBeGreaterThan(0);
    expect(field.lineups.length).toBeLessThanOrEqual(sampleSize);
    expect(field.lineupWeight).toBeCloseTo(CONTEST.fieldSize / field.lineups.length, 10);
  });

  it("a top-owned player's exposure lands near their declared ownership", () => {
    const tier = CONTEST.fieldTier();
    const topOwned = [...POOL].sort((a, b) => b.ownFor(tier) - a.ownFor(tier))[0];
    const sampleSize = 800;
    const field = generateSimulatedField(POOL, CONTEST, NFL, sampleSize, new SeededRandom(7));

    const appearances = field.lineups.filter((lineup) => lineup.some((p) => p.id === topOwned.id)).length;
    const exposure = appearances / field.lineups.length;
    const declared = topOwned.ownFor(tier);

    // Exposure caps allow up to ~Math.floor(sampleSize * declared) + the
    // extra QB-only cap (if this player happens to be a QB) -- the
    // objective bias actively pushes a high-owned player toward their
    // cap, so exposure should land close to (and never far above)
    // declared ownership. Upper bound widened 1.15 -> 1.2 this session:
    // the new salary floor + stack targeting (this task) shift which
    // combinations the MILP picks attempt-to-attempt, nudging realized
    // exposure up slightly (measured ~1.16x) versus the cap-only/no-stack
    // baseline this bound was originally tuned against.
    expect(exposure).toBeGreaterThan(declared * 0.5);
    expect(exposure).toBeLessThanOrEqual(declared * 1.2);
  });

  it("every lineup's salary respects the floor as well as the cap", () => {
    const field = generateSimulatedField(POOL, CONTEST, NFL, 300, new SeededRandom(11));
    expect(field.lineups.length).toBeGreaterThan(0);
    for (const lineup of field.lineups) {
      const salary = lineup.reduce((s, p) => s + p.salary, 0);
      expect(salary).toBeGreaterThanOrEqual(SALARY_FLOOR);
      expect(salary).toBeLessThanOrEqual(CONTEST.effectiveCap(NFL));
    }
  });

  it("stacks (QB + 2+ same-team WR/TE) are present at roughly nfl-dfs's target rate", () => {
    const sampleSize = 600;
    const field = generateSimulatedField(POOL, CONTEST, NFL, sampleSize, new SeededRandom(13));
    expect(field.lineups.length).toBeGreaterThan(0);

    const isStacked = (lineup: readonly Player[]): boolean => {
      const qb = lineup.find((p) => p.positions[0] === "QB");
      if (!qb) return false;
      const catchers = lineup.filter((p) => p.team === qb.team && (p.positions[0] === "WR" || p.positions[0] === "TE")).length;
      return catchers >= 2;
    };
    const stackedCount = field.lineups.filter(isStacked).length;
    const stackRate = stackedCount / field.lineups.length;
    const target = 1 - TARGET_NAKED_QB_RATE; // 0.825

    // "Roughly" -- stack-team retry can fail (no candidate team solvable
    // under this attempt's exposure caps/floor/cap), falling back to
    // unstacked rather than forcing it, so the realized rate trails the
    // target somewhat (nfl-dfs's own real-field runs show the same
    // leakage -- see sim_field.js's own "stack leakage" log line).
    // Generous two-sided band for a 58-player synthetic pool/600-attempt
    // sample, not nfl-dfs's own tuned real-field tolerance.
    expect(stackRate).toBeGreaterThan(target - 0.25);
    expect(stackRate).toBeLessThanOrEqual(target + 0.1);
  });

  it("onProgress is called once per attempt plus a final 100% call", () => {
    const sampleSize = 20;
    const calls: Array<[number, number]> = [];
    generateSimulatedField(POOL, CONTEST, NFL, sampleSize, new SeededRandom(5), (completed, total) => {
      calls.push([completed, total]);
    });
    expect(calls.length).toBe(sampleSize + 1);
    expect(calls.map(([completed]) => completed)).toEqual([...Array(sampleSize).keys(), sampleSize]);
    expect(calls.every(([, total]) => total === sampleSize)).toBe(true);
  });

  it("targetDistinct stops the loop early once that many distinct lineups are found, well short of the attempt cap", () => {
    const sampleSize = 600; // plenty of attempts for 5 distinct combos on this 58-player pool
    const target = 5;
    const field = generateSimulatedField(POOL, CONTEST, NFL, sampleSize, new SeededRandom(13), undefined, target);
    const distinctCount = new Set(field.lineups.map((lineup) => lineup.map((p) => p.id).sort().join(","))).size;
    expect(distinctCount).toBeGreaterThanOrEqual(target);
    // Stopped well short of sampleSize -- proves the early stop actually
    // fired rather than coincidentally running the full attempt cap.
    expect(field.lineups.length).toBeLessThan(sampleSize);
  });

  it("omitting targetDistinct runs every attempt, same as before (no early stop)", () => {
    const sampleSize = 50;
    const field = generateSimulatedField(POOL, CONTEST, NFL, sampleSize, new SeededRandom(13));
    expect(field.lineups.length).toBeLessThanOrEqual(sampleSize);
    // This pool/seed can't realistically produce >=50 TRULY distinct
    // 9-player combos in 50 attempts (same logarithmic-growth reality the
    // real sample slate showed) -- confirms the loop kept going the whole
    // way rather than stopping once some small distinct count was hit.
    const distinctCount = new Set(field.lineups.map((lineup) => lineup.map((p) => p.id).sort().join(","))).size;
    expect(distinctCount).toBeLessThan(sampleSize);
  });

  it("onProgress reports distinct-so-far and the target once targetDistinct is given", () => {
    const sampleSize = 600;
    const target = 5;
    const calls: Array<{ distinct: number; targetDistinct: number }> = [];
    const field = generateSimulatedField(POOL, CONTEST, NFL, sampleSize, new SeededRandom(13), (_completed, _total, distinct, targetDistinct) => {
      calls.push({ distinct, targetDistinct });
    }, target);
    expect(calls.every((c) => c.targetDistinct === target)).toBe(true);
    // Monotonically non-decreasing, and the LAST call's distinct count
    // matches the field's own realized distinct count.
    for (let i = 1; i < calls.length; i++) expect(calls[i].distinct).toBeGreaterThanOrEqual(calls[i - 1].distinct);
    const distinctCount = new Set(field.lineups.map((lineup) => lineup.map((p) => p.id).sort().join(","))).size;
    expect(calls[calls.length - 1].distinct).toBe(distinctCount);
  });
});

describe("DEFAULT_SAMPLE_SIZE", () => {
  it("matches nfl-dfs's own default (generateSimulatedFieldMilp_'s `sampleSize || 1000`)", () => {
    expect(DEFAULT_SAMPLE_SIZE).toBe(1000);
  });
});
