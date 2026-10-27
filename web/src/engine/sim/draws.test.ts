import { describe, expect, it } from "vitest";
import { Player } from "../models";
import { SeededRandom } from "../rng";
import { TEMPLATE_PSD_REPORT, assignRoles, drawOutcome, drawSlateOutcomes, nearestPSD, tryCholesky, type SlateVegas } from "./draws";

function makePlayer(
  id: string,
  position: string,
  team: string,
  opp: string,
  floor: number,
  proj: number,
  ceiling: number,
  isHome: boolean = false,
): Player {
  return new Player({
    id,
    name: id,
    positions: [position],
    team,
    opp,
    isHome,
    salary: 5000,
    proj,
    ownSmall: 0.1,
    ownLarge: 0.1,
    floor,
    ceiling,
  });
}

function pearsonR(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  return num / Math.sqrt(denX * denY);
}

const NO_VEGAS: SlateVegas = new Map();
const EMPTY_DOME: ReadonlySet<string> = new Set();

describe("drawOutcome", () => {
  it("hits floor/median/ceiling exactly at u = P15/P50/P85", () => {
    const triples: Array<[number, number, number]> = [
      [5, 10, 18],
      [12, 18, 28],
      [2, 7, 14],
    ];
    for (const [floor, median, ceiling] of triples) {
      expect(drawOutcome(floor, median, ceiling, 0, 0.15)).toBeCloseTo(floor, 10);
      expect(drawOutcome(floor, median, ceiling, 0, 0.5)).toBeCloseTo(median, 10);
      expect(drawOutcome(floor, median, ceiling, 0, 0.85)).toBeCloseTo(ceiling, 10);
    }
  });

  it("extends the right tail beyond P85 at k=1", () => {
    expect(drawOutcome(10, 18, 28, 0, 1.0)).toBeCloseTo(28 + (28 - 18), 10);
  });

  it("left tail runs from posMin to floor", () => {
    expect(drawOutcome(10, 18, 28, 0, 0)).toBeCloseTo(0, 10);
    expect(drawOutcome(10, 18, 28, -5, 0)).toBeCloseTo(-5, 10);
  });
});

describe("assignRoles", () => {
  it("ranks QB1/RB1-2/WR1-3/TE1-2/DST by proj within team+position; everyone past the cutoff is other", () => {
    const players = [
      makePlayer("qb-a", "QB", "AAA", "BBB", 10, 20, 30),
      makePlayer("rb-a1", "RB", "AAA", "BBB", 5, 15, 25),
      makePlayer("rb-a2", "RB", "AAA", "BBB", 5, 10, 20),
      makePlayer("rb-a3", "RB", "AAA", "BBB", 2, 4, 8), // past the RB2 cutoff -- "other"
      makePlayer("wr-a1", "WR", "AAA", "BBB", 5, 18, 28),
      makePlayer("wr-a2", "WR", "AAA", "BBB", 4, 12, 20),
      makePlayer("wr-a3", "WR", "AAA", "BBB", 3, 8, 14),
      makePlayer("wr-a4", "WR", "AAA", "BBB", 1, 3, 6), // past WR3 -- "other"
      makePlayer("te-a1", "TE", "AAA", "BBB", 3, 10, 18),
      makePlayer("te-a2", "TE", "AAA", "BBB", 2, 5, 10),
      makePlayer("dst-a", "DST", "AAA", "BBB", 1, 7, 14),
    ];
    const roles = assignRoles(players);
    expect(roles.get("qb-a")).toBe("QB1");
    expect(roles.get("rb-a1")).toBe("RB1");
    expect(roles.get("rb-a2")).toBe("RB2");
    expect(roles.get("rb-a3")).toBeUndefined();
    expect(roles.get("wr-a1")).toBe("WR1");
    expect(roles.get("wr-a2")).toBe("WR2");
    expect(roles.get("wr-a3")).toBe("WR3");
    expect(roles.get("wr-a4")).toBeUndefined();
    expect(roles.get("te-a1")).toBe("TE1");
    expect(roles.get("te-a2")).toBe("TE2");
    expect(roles.get("dst-a")).toBe("DST");
  });

  it("ties keep the pool's own original order (stable sort)", () => {
    const players = [
      makePlayer("wr-first", "WR", "AAA", "BBB", 5, 10, 18),
      makePlayer("wr-second", "WR", "AAA", "BBB", 5, 10, 18), // identical proj, listed after
    ];
    const roles = assignRoles(players);
    expect(roles.get("wr-first")).toBe("WR1");
    expect(roles.get("wr-second")).toBe("WR2");
  });

  it("an unmodeled position (e.g. K) is never assigned a role", () => {
    const players = [makePlayer("k-a", "K", "AAA", "BBB", 2, 8, 12)];
    expect(assignRoles(players).get("k-a")).toBeUndefined();
  });

  it("ranks independently per team -- a second team's roles don't collide with the first's", () => {
    const players = [
      makePlayer("qb-a", "QB", "AAA", "BBB", 10, 20, 30),
      makePlayer("qb-b", "QB", "BBB", "AAA", 10, 25, 30),
    ];
    const roles = assignRoles(players);
    expect(roles.get("qb-a")).toBe("QB1");
    expect(roles.get("qb-b")).toBe("QB1");
  });
});

describe("tryCholesky / nearestPSD", () => {
  it("tryCholesky factors a valid correlation matrix (L L^T reconstructs it)", () => {
    const m = [
      [1, 0.5, 0.2],
      [0.5, 1, 0.3],
      [0.2, 0.3, 1],
    ];
    const L = tryCholesky(m);
    expect(L).not.toBeNull();
    const n = m.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) sum += L![i][k] * L![j][k];
        expect(sum).toBeCloseTo(m[i][j], 9);
      }
    }
  });

  it("tryCholesky returns null for a matrix that isn't positive-definite", () => {
    // Off-diagonal magnitude > 1 is never a valid correlation -- not PSD.
    const broken = [
      [1, 1.5],
      [1.5, 1],
    ];
    expect(tryCholesky(broken)).toBeNull();
  });

  it("nearestPSD repairs a broken matrix into one that IS positive-definite, with a nonzero reported change", () => {
    const broken = [
      [1, 1.5],
      [1.5, 1],
    ];
    const { matrix, largestChange } = nearestPSD(broken);
    expect(largestChange).toBeGreaterThan(0);
    expect(matrix[0][0]).toBeCloseTo(1, 6);
    expect(matrix[1][1]).toBeCloseTo(1, 6);
    expect(tryCholesky(matrix)).not.toBeNull();
  });

  it("nearestPSD leaves an already-valid correlation matrix (almost) unchanged", () => {
    const m = [
      [1, 0.3],
      [0.3, 1],
    ];
    const { largestChange } = nearestPSD(m);
    expect(largestChange).toBeLessThan(1e-6);
  });
});

describe("TEMPLATE_PSD_REPORT", () => {
  it("the real, measured role x role template (real_correlation_targets.json) is already PSD -- no correction needed", () => {
    expect(TEMPLATE_PSD_REPORT.wasAlreadyPsd).toBe(true);
    expect(TEMPLATE_PSD_REPORT.largestChange).toBeLessThan(1e-9);
  });
});

describe("drawSlateOutcomes: known triples over many draws", () => {
  it("recovers roughly the right P15/P50/P85 for an 'other' player (no role, no vegas)", () => {
    // Ranked behind wr1/wr2/wr3 (proj 16/15/14) on its own team -- past the
    // WR1-3 cutoff, so genuinely "other": zero correlation, zero mean
    // shift, nothing but its own independent draw through drawOutcome.
    const other = makePlayer("other", "WR", "AAA", "BBB", 5, 12, 20);
    const wr1 = makePlayer("wr1", "WR", "AAA", "BBB", 5, 16, 24);
    const wr2 = makePlayer("wr2", "WR", "AAA", "BBB", 5, 15, 23);
    const wr3 = makePlayer("wr3", "WR", "AAA", "BBB", 5, 14, 22);
    const dummyOpp = makePlayer("dummy1", "WR", "BBB", "AAA", 5, 12, 20);
    const players = [other, wr1, wr2, wr3, dummyOpp];

    const rng = new SeededRandom(12345);
    const N = 20000;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, rng);
      samples.push(out.get("other")!);
    }
    samples.sort((a, b) => a - b);
    const p15 = samples[Math.floor(N * 0.15)];
    const p50 = samples[Math.floor(N * 0.5)];
    const p85 = samples[Math.floor(N * 0.85)];

    // No regime layering left in this model -- an "other" player with no
    // Vegas input is a plain mean-0, unit-variance normal through
    // drawOutcome, so empirical percentiles should track the ETR anchors
    // tightly.
    expect(p50).toBeCloseTo(12, 0);
    expect(p15).toBeLessThan(p50);
    expect(p85).toBeGreaterThan(p50);
    expect(p15).toBeCloseTo(12 - (12 - 5), 0);
    expect(p85).toBeCloseTo(20, 0);
  });
});

describe("drawSlateOutcomes: determinism", () => {
  it("same seed produces the same outcomes", () => {
    const players = [
      makePlayer("qb1", "QB", "AAA", "BBB", 12, 18, 28),
      makePlayer("wr1", "WR", "AAA", "BBB", 5, 10, 18),
      makePlayer("rb1", "RB", "BBB", "AAA", 6, 12, 20),
      makePlayer("dst1", "DST", "BBB", "AAA", 2, 7, 14),
    ];

    const rng1 = new SeededRandom(777);
    const rng2 = new SeededRandom(777);
    const out1 = drawSlateOutcomes(players, NO_VEGAS, rng1);
    const out2 = drawSlateOutcomes(players, NO_VEGAS, rng2);

    for (const p of players) {
      expect(out1.get(p.id)).toBe(out2.get(p.id));
    }
  });
});

describe("drawSlateOutcomes: role correlation structure", () => {
  it("same-team QB1/WR1 are positively correlated, roughly matching the measured target", () => {
    const qb = makePlayer("qb1", "QB", "AAA", "BBB", 12, 18, 28);
    const wr = makePlayer("wr1", "WR", "AAA", "BBB", 5, 10, 18);
    const oppRb = makePlayer("rb1", "RB", "BBB", "AAA", 6, 12, 20);
    const oppDst = makePlayer("dst1", "DST", "BBB", "AAA", 2, 7, 14);
    const players = [qb, wr, oppRb, oppDst];

    const rng = new SeededRandom(42);
    const N = 10000;
    const qbPts: number[] = [];
    const wrPts: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, rng);
      qbPts.push(out.get("qb1")!);
      wrPts.push(out.get("wr1")!);
    }

    // Measured target (real_correlation_targets.json): QB1-WR1 sim_r
    // isn't pinned to the real_r itself (that's the whole point of
    // Cholesky-drawing from this matrix rather than copying it verbatim
    // -- drawOutcome's own piecewise curve, not a raw normal, is what
    // actually gets correlated), so this just confirms the right sign and
    // rough strength, not an exact value.
    expect(pearsonR(qbPts, wrPts)).toBeGreaterThan(0.2);
  });

  it("DST is negatively correlated with the opposing QB1 (measured target -0.41)", () => {
    const dst = makePlayer("dst1", "DST", "AAA", "BBB", 2, 7, 14);
    const oppQb = makePlayer("qb1", "QB", "BBB", "AAA", 12, 18, 28);
    const players = [dst, oppQb];

    const rng = new SeededRandom(99);
    const N = 10000;
    const dstPts: number[] = [];
    const qbPts: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, rng);
      dstPts.push(out.get("dst1")!);
      qbPts.push(out.get("qb1")!);
    }

    expect(pearsonR(dstPts, qbPts)).toBeLessThan(-0.1);
  });

  it("an 'other' player (past the modeled-role cutoff) has ~zero correlation with a teammate's role-player", () => {
    const qb = makePlayer("qb1", "QB", "AAA", "BBB", 12, 18, 28);
    const wr1 = makePlayer("wr1", "WR", "AAA", "BBB", 5, 15, 24);
    const wr2 = makePlayer("wr2", "WR", "AAA", "BBB", 5, 14, 23);
    const wr3 = makePlayer("wr3", "WR", "AAA", "BBB", 5, 13, 22);
    const wr4 = makePlayer("wr4", "WR", "AAA", "BBB", 5, 10, 18); // "other"
    const oppFiller = makePlayer("dummy", "WR", "BBB", "AAA", 5, 10, 18);
    const players = [qb, wr1, wr2, wr3, wr4, oppFiller];

    const rng = new SeededRandom(2024);
    const N = 15000;
    const qbPts: number[] = [];
    const wr4Pts: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, rng);
      qbPts.push(out.get("qb1")!);
      wr4Pts.push(out.get("wr4")!);
    }

    expect(Math.abs(pearsonR(qbPts, wr4Pts))).toBeLessThan(0.05);
  });
});

describe("drawSlateOutcomes: Vegas/dome/spread shift the mean, not shared variance", () => {
  it("a high Vegas total raises that game's mean scoring vs neutral", () => {
    const game1 = [
      makePlayer("qb1", "QB", "AAA", "BBB", 12, 18, 28),
      makePlayer("wr1", "WR", "AAA", "BBB", 5, 10, 18),
      makePlayer("rb1", "RB", "BBB", "AAA", 6, 12, 20),
      makePlayer("dst1", "DST", "BBB", "AAA", 2, 7, 14),
    ];
    const game2 = [
      makePlayer("qb2", "QB", "CCC", "DDD", 12, 18, 28),
      makePlayer("wr2", "WR", "CCC", "DDD", 5, 10, 18),
      makePlayer("rb2", "RB", "DDD", "CCC", 6, 12, 20),
      makePlayer("dst2", "DST", "DDD", "CCC", 2, 7, 14),
    ];
    const players = [...game1, ...game2];
    const N = 8000;

    const neutralRng = new SeededRandom(2026);
    let neutralGame1Sum = 0;
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, neutralRng);
      for (const p of game1) neutralGame1Sum += out.get(p.id)!;
    }

    const skewedTotals: SlateVegas = new Map([
      ["AAA", { total: 60 }],
      ["BBB", { total: 60 }],
      ["CCC", { total: 40 }],
      ["DDD", { total: 40 }],
    ]);
    const highRng = new SeededRandom(2026);
    let highGame1Sum = 0;
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, skewedTotals, highRng);
      for (const p of game1) highGame1Sum += out.get(p.id)!;
    }

    expect(highGame1Sum / N).toBeGreaterThan(neutralGame1Sum / N);
  });

  it("Vegas total does NOT change same-team correlation (mean shift only, not shared variance)", () => {
    const qb = makePlayer("qb1", "QB", "AAA", "BBB", 12, 18, 28);
    const wr = makePlayer("wr1", "WR", "AAA", "BBB", 5, 10, 18);
    const oppQb = makePlayer("qb2", "QB", "BBB", "AAA", 12, 18, 28);
    const oppWr = makePlayer("wr2", "WR", "BBB", "AAA", 5, 10, 18);
    const players = [qb, wr, oppQb, oppWr];
    const N = 10000;

    function corrAt(vegas: SlateVegas, seed: number): number {
      const rng = new SeededRandom(seed);
      const qbPts: number[] = [];
      const wrPts: number[] = [];
      for (let i = 0; i < N; i++) {
        const out = drawSlateOutcomes(players, vegas, rng);
        qbPts.push(out.get("qb1")!);
        wrPts.push(out.get("wr1")!);
      }
      return pearsonR(qbPts, wrPts);
    }

    const neutral = corrAt(NO_VEGAS, 55);
    const high: SlateVegas = new Map([
      ["AAA", { total: 60 }],
      ["BBB", { total: 60 }],
    ]);
    const highCorr = corrAt(high, 55);
    expect(Math.abs(highCorr - neutral)).toBeLessThan(0.05);
  });

  it("a dome game raises mean scoring but does NOT change cross-team correlation", () => {
    const qbA = makePlayer("qbA", "QB", "AAA", "BBB", 12, 18, 28, true);
    const qbB = makePlayer("qbB", "QB", "BBB", "AAA", 12, 18, 28, false);
    const players = [qbA, qbB];
    const domeTeams = new Set(["AAA"]);
    const N = 10000;

    const neutralRng = new SeededRandom(321);
    let neutralSum = 0;
    const neutralAPts: number[] = [];
    const neutralBPts: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, neutralRng, EMPTY_DOME);
      neutralSum += out.get("qbA")!;
      neutralAPts.push(out.get("qbA")!);
      neutralBPts.push(out.get("qbB")!);
    }
    const domeRng = new SeededRandom(321);
    let domeSum = 0;
    const aPts: number[] = [];
    const bPts: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, domeRng, domeTeams);
      domeSum += out.get("qbA")!;
      aPts.push(out.get("qbA")!);
      bPts.push(out.get("qbB")!);
    }
    expect(domeSum / N).toBeGreaterThan(neutralSum / N);

    // Each is the lone QB on its own team, so both are role "QB1" --
    // qbA/qbB ARE correlated (the measured QB1-oppQB1 target, ~0.2), not
    // zero. The point of this test is that dome doesn't change THAT
    // correlation -- only the mean -- so compare dome's correlation
    // against the identical pair's own neutral-run correlation, not
    // against zero.
    const neutralCorr = pearsonR(neutralAPts, neutralBPts);
    const domeCorr = pearsonR(aPts, bPts);
    expect(Math.abs(domeCorr - neutralCorr)).toBeLessThan(0.05);
  });

  it("an empty domeTeams set draws every game as non-dome (default, unchanged from before dome existed)", () => {
    const players = [
      makePlayer("qb1", "QB", "AAA", "BBB", 12, 18, 28),
      makePlayer("wr1", "WR", "AAA", "BBB", 5, 10, 18),
      makePlayer("rb1", "RB", "BBB", "AAA", 6, 12, 20),
      makePlayer("dst1", "DST", "BBB", "AAA", 2, 7, 14),
    ];
    const rngNoDomeArg = new SeededRandom(13);
    const rngEmptyDome = new SeededRandom(13);
    const out1 = drawSlateOutcomes(players, NO_VEGAS, rngNoDomeArg);
    const out2 = drawSlateOutcomes(players, NO_VEGAS, rngEmptyDome, new Set());
    for (const p of players) {
      expect(out1.get(p.id)).toBe(out2.get(p.id));
    }
  });
});
