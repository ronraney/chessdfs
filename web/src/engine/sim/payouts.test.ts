import { describe, expect, it } from "vitest";
import { generatePayoutCurve } from "./payouts";

describe("generatePayoutCurve", () => {
  it("sums to exactly prizePool", () => {
    const rows = generatePayoutCurve(10000, 0.2, 20, 50);
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    expect(sum).toBeCloseTo(10000, 6);
  });

  it("is a non-increasing curve from rank 1 to the cash line", () => {
    const rows = generatePayoutCurve(10000, 0.2, 20, 50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].amount).toBeLessThanOrEqual(rows[i - 1].amount);
    }
  });

  it("pays close to pctToFirst at rank 1 for a small, tight cash line", () => {
    // nfl-dfs's own two-anchor method (sim_trial_loop.js's
    // generateSyntheticPayoutCurve_, "twoAnchor" branch) solves the curve's
    // SHAPE from the two dollar anchors, then renormalizes to sum to
    // prizePool exactly -- its own doc comment calls place 1 landing
    // "close to, not exactly on" pctToFirst*prizePool a deliberate
    // tradeoff. How close depends on how many cash spots there are: a
    // small cash line (few spots) tracks tightly (measured here, rank 1 /
    // target is ~0.985 at 49 spots); chess-dfs's own real contests.json
    // presets run far longer cash lines (hundreds to tens of thousands of
    // spots) and measured 47%-70% of target at rank 1 once renormalized --
    // reported to Ron separately, not a bug in this generator.
    const prizePool = 5000;
    const pctToFirst = 0.1;
    const rows = generatePayoutCurve(prizePool, pctToFirst, 50, 49);
    const target = prizePool * pctToFirst;
    expect(rows[0].amount).toBeGreaterThan(target * 0.9);
    expect(rows[0].amount).toBeLessThanOrEqual(target);
  });

  it("a single cash spot is exact winner-take-all, regardless of pctToFirst/minCash", () => {
    const rows = generatePayoutCurve(1.8, 1, 1.8, 1);
    expect(rows).toEqual([{ rank: 1, amount: 1.8 }]);
  });

  it("one row per cashing rank, none beyond the cash line", () => {
    const rows = generatePayoutCurve(10000, 0.2, 20, 50);
    expect(rows.length).toBe(50);
    expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("rejects a non-positive prizePool", () => {
    expect(() => generatePayoutCurve(0, 0.2, 20, 50)).toThrow();
  });

  it("rejects pctToFirst outside (0, 1]", () => {
    expect(() => generatePayoutCurve(10000, 0, 20, 50)).toThrow();
    expect(() => generatePayoutCurve(10000, 1.5, 20, 50)).toThrow();
  });

  it("rejects inconsistent anchors (place-1 target at or below minCash)", () => {
    // pctToFirst*prizePool (100) <= minCash (200) -- place 1 would have to
    // pay LESS than the cash line, a nonsensical curve shape.
    expect(() => generatePayoutCurve(1000, 0.1, 200, 50)).toThrow();
  });
});
