import { describe, expect, it } from "vitest";
import { generatePayoutCurve } from "./payouts";

describe("generatePayoutCurve", () => {
  it("sums to exactly prizePool", () => {
    const rows = generatePayoutCurve(10000, 0.2, 50);
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    expect(sum).toBeCloseTo(10000, 6);
  });

  it("is a non-increasing curve from rank 1 to the cash line", () => {
    const rows = generatePayoutCurve(10000, 0.2, 50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].amount).toBeLessThanOrEqual(rows[i - 1].amount);
    }
  });

  it("rank 1 pays exactly pctToFirst * prizePool", () => {
    const prizePool = 40000;
    const pctToFirst = 0.1;
    const rows = generatePayoutCurve(prizePool, pctToFirst, 1995); // Nickel's own real shape
    expect(rows[0].amount).toBeCloseTo(prizePool * pctToFirst, 6);
  });

  it("a single cash spot is exact winner-take-all, regardless of pctToFirst", () => {
    const rows = generatePayoutCurve(1.8, 1, 1);
    expect(rows).toEqual([{ rank: 1, amount: 1.8 }]);
  });

  it("one row per cashing rank, none beyond the cash line", () => {
    const rows = generatePayoutCurve(10000, 0.2, 50);
    expect(rows.length).toBe(50);
    expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("rejects a non-positive prizePool", () => {
    expect(() => generatePayoutCurve(0, 0.2, 50)).toThrow();
  });

  it("rejects pctToFirst outside (0, 1]", () => {
    expect(() => generatePayoutCurve(10000, 0, 50)).toThrow();
    expect(() => generatePayoutCurve(10000, 1.5, 50)).toThrow();
  });

  it("rejects pctToFirst at or below an even split across the cash spots", () => {
    // 1/50 = 0.02 -- 0.001 can't support any decaying (non-increasing) curve.
    expect(() => generatePayoutCurve(1000, 0.001, 50)).toThrow();
  });
});
