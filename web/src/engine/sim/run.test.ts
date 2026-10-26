import { describe, expect, it } from "vitest";
import nflConfig from "../../data/config/sports/nfl.json";
import { ContestConfig, PayoutTier } from "../config";
import { Player } from "../models";
import { loadSportConfig } from "../sport";
import type { SlateVegas } from "./draws";
import type { SimulatedField } from "./field";
import { type TrialResult, aggregateResults, computeEffectivePlaceAndPayout, runSimulation, scoreLineup } from "./run";

const NFL = loadSportConfig(nflConfig);
const NO_VEGAS: SlateVegas = new Map();

function makePlayer(id: string, position: string, salary: number, proj: number, team: string, opp: string): Player {
  return new Player({
    id,
    name: id,
    positions: [position],
    team,
    opp,
    salary,
    proj,
    ownSmall: 0.1,
    ownLarge: 0.1,
    floor: proj * 0.6,
    ceiling: proj * 1.6,
  });
}

// A complete, legal 9-player DK roster (QB1/RB2/WR3/TE1/FLEX1/DST1,
// nfl.json's own roster_slots) -- every player tagged with `prefix` so
// several lineups (user + each field entry) never collide on id, all
// sharing one HOME-vs-AWAY game so drawSlateOutcomes has real game groups
// to correlate within.
function buildLineup(prefix: string, side: "HOME" | "AWAY"): Player[] {
  const opp = side === "HOME" ? "AWAY" : "HOME";
  return [
    makePlayer(`${prefix}-qb`, "QB", 7000, 20, side, opp),
    makePlayer(`${prefix}-rb1`, "RB", 6000, 15, side, opp),
    makePlayer(`${prefix}-rb2`, "RB", 5000, 12, side, opp),
    makePlayer(`${prefix}-wr1`, "WR", 6500, 16, side, opp),
    makePlayer(`${prefix}-wr2`, "WR", 5500, 13, side, opp),
    makePlayer(`${prefix}-wr3`, "WR", 4500, 10, side, opp),
    makePlayer(`${prefix}-te`, "TE", 4000, 9, side, opp),
    makePlayer(`${prefix}-flex`, "WR", 3500, 8, side, opp),
    makePlayer(`${prefix}-dst`, "DST", 2500, 7, side, opp),
  ];
}

function buildField(): { field: SimulatedField; players: Player[] } {
  const f1 = buildLineup("f1", "HOME");
  const f2 = buildLineup("f2", "AWAY");
  const f3 = buildLineup("f3", "HOME");
  return {
    field: { lineups: [f1, f2, f3], lineupWeight: 2 },
    players: [...f1, ...f2, ...f3],
  };
}

describe("scoreLineup", () => {
  it("sums outcomes for every player in the lineup, defaulting a missing id to 0", () => {
    const lineup = buildLineup("u", "HOME").slice(0, 2); // qb + rb1
    const outcomes = new Map([
      ["u-qb", 25.4],
      ["u-rb1", 11.1],
      // "u-rb2" deliberately absent -- not part of this lineup anyway
    ]);
    expect(scoreLineup(lineup, outcomes)).toBeCloseTo(36.5, 10);
  });
});

describe("computeEffectivePlaceAndPayout", () => {
  it("ties split the tied prizes evenly, across the user's own tied slot", () => {
    // One lineup strictly ahead (150), two tied with the user (100 == 100),
    // one strictly behind (90). weightAhead=1*lineupWeight, weightTied=2*
    // lineupWeight -- placeFrom=2, placeTo=4, payout = avg(payouts[2..4]).
    const payouts = new Map([
      [1, 1000],
      [2, 500],
      [3, 500],
      [4, 100],
    ]);
    const result = computeEffectivePlaceAndPayout(100, [150, 100, 100, 90], 1, payouts);
    expect(result.place).toBe(2);
    expect(result.payout).toBeCloseTo((500 + 500 + 100) / 3, 10);
  });

  it("no ties: place is strictly weightAhead + 1, rounded up", () => {
    const payouts = new Map([
      [1, 1000],
      [2, 500],
    ]);
    // lineupWeight 2.5, one field score ahead -> weightAhead=2.5 -> place
    // rounds UP to 4 (round the payout down, not up) -- place 3 and 4 both
    // pay $0 here since neither is in payouts, confirming the ?? 0 fallback.
    const result = computeEffectivePlaceAndPayout(100, [150], 2.5, payouts);
    expect(result.place).toBe(4);
    expect(result.payout).toBe(0);
  });
});

describe("aggregateResults", () => {
  it("computes roi/cashRate/winRate/top1PctRate/finishPercentiles correctly on fixed trial results", () => {
    const results: TrialResult[] = [
      { trial: 1, userScore: 0, place: 1, payout: 500 },
      { trial: 2, userScore: 0, place: 3, payout: 100 },
      { trial: 3, userScore: 0, place: 1, payout: 500 },
      { trial: 4, userScore: 0, place: 50, payout: 0 },
      { trial: 5, userScore: 0, place: 20, payout: 0 },
      { trial: 6, userScore: 0, place: 5, payout: 50 },
      { trial: 7, userScore: 0, place: 1000, payout: 0 },
      { trial: 8, userScore: 0, place: 2, payout: 200 },
      { trial: 9, userScore: 0, place: 1, payout: 500 },
      { trial: 10, userScore: 0, place: 800, payout: 0 },
    ];
    const entryFee = 10;
    const entries = 300; // ceil(300 * 0.01) = 3 -- a top1PctCutoff distinct from winRate's place-1-only cutoff
    const agg = aggregateResults(results, entryFee, entries);

    // totalPayout=1850, totalCost=100 -> roi=(1850-100)/100=17.5
    expect(agg.roi).toBeCloseTo(17.5, 10);
    // payout>0 on trials 1,2,3,6,8,9 -> 6/10
    expect(agg.cashRate).toBeCloseTo(0.6, 10);
    // place===1 on trials 1,3,9 -> 3/10
    expect(agg.winRate).toBeCloseTo(0.3, 10);
    // place<=3 on trials 1,2,3,8,9 -> 5/10
    expect(agg.top1PctRate).toBeCloseTo(0.5, 10);

    // Sorted places: [1,1,1,2,3,5,20,50,800,1000]
    expect(agg.finishPercentiles.P10).toBe(1);
    expect(agg.finishPercentiles.P25).toBe(1.25);
    expect(agg.finishPercentiles.P50).toBe(4);
    expect(agg.finishPercentiles.P75).toBe(42.5);
    expect(agg.finishPercentiles.P90).toBeCloseTo(820, 10);
  });

  it("entryFee of 0 doesn't divide by zero -- roi reads 0", () => {
    const results: TrialResult[] = [{ trial: 1, userScore: 0, place: 1, payout: 0 }];
    expect(aggregateResults(results, 0, 100).roi).toBe(0);
  });

  it("top1PctCutoff is at least 1 even for a tiny contest (ceil, never floors to 0)", () => {
    const results: TrialResult[] = [
      { trial: 1, userScore: 0, place: 1, payout: 10 },
      { trial: 2, userScore: 0, place: 2, payout: 0 },
    ];
    // entries=2 (H2H) -> ceil(2 * 0.01) = 1 -- only place 1 counts, same as winRate here.
    const agg = aggregateResults(results, 5, 2);
    expect(agg.top1PctRate).toBeCloseTo(0.5, 10);
    expect(agg.top1PctRate).toBeCloseTo(agg.winRate, 10);
  });
});

describe("runSimulation", () => {
  const lineup = buildLineup("u", "AWAY");
  const { field, players: fieldPlayers } = buildField();
  const allPlayers = [...lineup, ...fieldPlayers];
  const contest = new ContestConfig({
    fieldSize: 6,
    payouts: [new PayoutTier({ rank: 1, amount: 1000 }), new PayoutTier({ rank: 2, amount: 500 })],
  });

  it("the same seed produces the same result", () => {
    const result1 = runSimulation(lineup, contest, 10, field, allPlayers, NO_VEGAS, NFL, 2026, 25);
    const result2 = runSimulation(lineup, contest, 10, field, allPlayers, NO_VEGAS, NFL, 2026, 25);
    expect(result1).toEqual(result2);
  });

  it("rejects a partial lineup (missing a required roster slot)", () => {
    const partial = lineup.slice(0, 8); // 8 of 9 -- missing the DST
    expect(() => runSimulation(partial, contest, 10, field, allPlayers, NO_VEGAS, NFL, 2026, 25)).toThrow();
  });

  it("rejects an empty field", () => {
    const emptyField: SimulatedField = { lineups: [], lineupWeight: 1 };
    expect(() => runSimulation(lineup, contest, 10, emptyField, allPlayers, NO_VEGAS, NFL, 2026, 25)).toThrow();
  });
});
