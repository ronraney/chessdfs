import { describe, expect, it } from "vitest";
import { generatePayoutCurve } from "./payouts";

describe("generatePayoutCurve", () => {
  it("sums to exactly prizePool, rank 1 exact, and a real floor tier at minCash", () => {
    const prizePool = 10000;
    const pctToFirst = 0.2;
    const minCash = 60;
    const rows = generatePayoutCurve(prizePool, pctToFirst, minCash, 50);

    const sum = rows.reduce((s, r) => s + r.amount, 0);
    expect(sum).toBeCloseTo(prizePool, 6);
    expect(rows[0].amount).toBeCloseTo(prizePool * pctToFirst, 6);

    // Measured: minCash=60 against this shape puts the bottom 9 places
    // exactly on the floor (verified via a throwaway script before writing
    // this test, not guessed) -- the last paid place (cash_line) is always
    // in that floor block when one exists, so it pays exactly minCash.
    const floorRows = rows.filter((r) => r.amount === minCash);
    expect(floorRows.length).toBe(9);
    expect(rows[rows.length - 1].amount).toBe(minCash);
  });

  it("is a non-increasing curve from rank 1 to the cash line", () => {
    const rows = generatePayoutCurve(10000, 0.2, 60, 50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].amount).toBeLessThanOrEqual(rows[i - 1].amount);
    }
  });

  it("a floor that never binds (minCash below the curve's own natural tail) still sums exactly, with zero floor places", () => {
    const rows = generatePayoutCurve(10000, 0.2, 20, 50);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(10000, 6);
    expect(rows.filter((r) => r.amount === 20).length).toBe(0);
    expect(rows[rows.length - 1].amount).toBeGreaterThan(20);
  });

  it("a single cash spot is exact winner-take-all, regardless of pctToFirst/minCash", () => {
    const rows = generatePayoutCurve(1.8, 1, 1.8, 1);
    expect(rows).toEqual([{ rank: 1, amount: 1.8 }]);
  });

  it("builds a flat table (every cash spot pays minCash) when rank 1's pinned amount equals minCash", () => {
    // rank1 = 1000*0.1 = 100 = minCash exactly -- no curve can decay from
    // rank 1 down to a floor it's already sitting on, so every place pays
    // the same flat amount instead (a Double-Up/50/50-style table).
    const rows = generatePayoutCurve(1000, 0.1, 100, 10);
    expect(rows).toEqual(Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, amount: 100 })));
  });

  it("the flat-table case tolerates up to $0.01 of rounding between rank 1's pinned amount and minCash", () => {
    // rank1 = 1000*0.1 = 100; minCash=100.005 -- within the $0.01 tolerance.
    const rows = generatePayoutCurve(1000, 0.1, 100.005, 10);
    expect(rows.every((r) => r.amount === 100.005)).toBe(true);
  });

  it("one row per cashing rank, none beyond the cash line", () => {
    const rows = generatePayoutCurve(10000, 0.2, 60, 50);
    expect(rows.length).toBe(50);
    expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("rejects a non-positive prizePool", () => {
    expect(() => generatePayoutCurve(0, 0.2, 60, 50)).toThrow();
  });

  it("rejects pctToFirst outside (0, 1]", () => {
    expect(() => generatePayoutCurve(10000, 0, 60, 50)).toThrow();
    expect(() => generatePayoutCurve(10000, 1.5, 60, 50)).toThrow();
  });

  it("rejects a non-positive minCash", () => {
    expect(() => generatePayoutCurve(10000, 0.2, 0, 50)).toThrow();
  });

  it("rejects minCash at or above rank 1's own payout", () => {
    // rank1 = 1000*0.1 = 100; minCash=150 >= 100.
    expect(() => generatePayoutCurve(1000, 0.1, 150, 50)).toThrow(/not less than rank 1/);
  });

  it("rejects a prizePool too small to pay every cash spot at least minCash on top of rank 1", () => {
    // rank1 = 1000*0.1 = 100; floor sum = 100 + 50*49 = 2550 > prizePool (1000).
    expect(() => generatePayoutCurve(1000, 0.1, 50, 50)).toThrow(/less than rank 1's cut plus minCash/);
  });

  it("rejects a prizePool too large for rank 1 to plausibly be the biggest payout", () => {
    // rank1 = 100000*0.01 = 1000; flat sum = 1000*50 = 50000 < prizePool (100000).
    expect(() => generatePayoutCurve(100000, 0.01, 1, 50)).toThrow(/exceeds what a FLAT payout/);
  });
});
