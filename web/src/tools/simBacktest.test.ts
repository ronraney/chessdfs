// Line-rank math only (this task's own scope): scoreAtRank converts a
// real-contest PLACE into the score of whichever field lineup represents
// it, given each lineup stands in for `lineupWeight` real entries. The
// rest of simBacktest.ts (field generation, correlated draws, percentiles)
// is already covered by field.test.ts/draws.test.ts/run.ts's own tests and
// isn't re-tested here.
import { describe, expect, it } from "vitest";
import { scoreAtRank } from "./simBacktest";

describe("scoreAtRank", () => {
  it("rank 1 is the top (first) score whenever one lineup's own weight already covers it (lineupWeight >= 1)", () => {
    const scores = [300, 250, 200, 150];
    expect(scoreAtRank(scores, 1, 1)).toBe(300);
    expect(scoreAtRank(scores, 50, 1)).toBe(300);
  });

  it("lineupWeight 1 (one lineup = one real entry) reads the Nth score directly", () => {
    const scores = [300, 250, 200, 150, 100];
    expect(scoreAtRank(scores, 1, 3)).toBe(200);
    expect(scoreAtRank(scores, 1, 5)).toBe(100);
  });

  it("lineupWeight > 1 (field under-represents entries): a rank spanning several real entries per lineup still lands on the right lineup", () => {
    const scores = [300, 250, 200, 150]; // lineupWeight 10 -> each lineup covers 10 real places
    expect(scoreAtRank(scores, 10, 1)).toBe(300); // places 1-10
    expect(scoreAtRank(scores, 10, 10)).toBe(300);
    expect(scoreAtRank(scores, 10, 11)).toBe(250); // places 11-20
    expect(scoreAtRank(scores, 10, 20)).toBe(250);
    expect(scoreAtRank(scores, 10, 21)).toBe(200); // places 21-30
  });

  it("lineupWeight < 1 (field over-represents entries): several lineups' worth of weight are needed to reach rank 1", () => {
    const scores = [300, 250, 200, 150]; // lineupWeight 0.5 -> 2 lineups per real place
    expect(scoreAtRank(scores, 0.5, 1)).toBe(250); // cum weight after 2 lineups (1.0) first reaches rank 1
    expect(scoreAtRank(scores, 0.5, 2)).toBe(150); // cum weight after 4 lineups (2.0) first reaches rank 2
  });

  it("a rank past the field's total represented weight returns the lowest (last) score, not a throw", () => {
    const scores = [300, 250, 200];
    expect(scoreAtRank(scores, 1, 1000)).toBe(200);
  });

  it("throws on an empty field -- nothing to rank against", () => {
    expect(() => scoreAtRank([], 1, 1)).toThrow();
  });
});
