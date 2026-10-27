import { describe, expect, it } from "vitest";
import { Player } from "../models";
import { SeededRandom } from "../rng";
import {
  TEMPLATE_PSD_REPORT,
  assignRoles,
  drawOutcome,
  drawSlateOutcomes,
  internalAnchorForTargetMean,
  nearestPSD,
  tryCholesky,
  type SlateVegas,
} from "./draws";

function makePlayer(id: string, position: string, team: string, opp: string, floor: number, proj: number, ceiling: number): Player {
  return new Player({
    id,
    name: id,
    positions: [position],
    team,
    opp,
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

// Deterministic (no RNG, no Monte Carlo noise) approximation of
// E[drawOutcome(Z)] for a standard normal Z: u = Phi(Z) is exactly
// Uniform(0,1), so this is just ∫_0^1 drawOutcome(u) du, approximated by
// a fine midpoint Riemann sum.
function empiricalMean(floor: number, targetMean: number, ceiling: number, posMin: number, k?: number): number {
  const N = 200000;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N;
    sum += drawOutcome(floor, targetMean, ceiling, posMin, u, k);
  }
  return sum / N;
}

const NO_VEGAS: SlateVegas = new Map();

describe("internalAnchorForTargetMean / drawOutcome: mean-targeting", () => {
  it("the curve's own expected value (not its median) equals the target mean, for an asymmetric player", () => {
    // ceiling-proj gap (11.1) wider than proj-floor gap (8.8) -- the
    // common real-world shape that used to bias the mean upward.
    const avg = empiricalMean(4.1, 12.9, 24, 0);
    expect(avg).toBeCloseTo(12.9, 2);
  });

  it("equals the target mean for a DST (posMin = -5)", () => {
    const avg = empiricalMean(1.0, 6.6, 13.5, -5);
    expect(avg).toBeCloseTo(6.6, 2);
  });

  it("equals the target mean across a range of floor/ceiling shapes, including inverted (ceiling closer than floor)", () => {
    const cases: Array<[number, number, number, number]> = [
      [5, 12, 20, 0],
      [10, 15, 18, 0],
      [2, 20, 45, 0],
      [8, 10, 12, 0],
    ];
    for (const [floor, targetMean, ceiling, posMin] of cases) {
      expect(empiricalMean(floor, targetMean, ceiling, posMin)).toBeCloseTo(targetMean, 2);
    }
  });

  it("the solved anchor differs from the target mean whenever floor/ceiling are asymmetric (the whole point of the fix)", () => {
    const m = internalAnchorForTargetMean(4.1, 12.9, 24, 0);
    expect(m).not.toBeCloseTo(12.9, 1);
    expect(m).toBeGreaterThan(4.1);
    expect(m).toBeLessThan(24);
  });
});

describe("drawOutcome", () => {
  it("still hits floor/ceiling exactly at u = P15/P85 regardless of the mean-targeting anchor", () => {
    const triples: Array<[number, number, number]> = [
      [5, 10, 18],
      [12, 18, 28],
      [2, 7, 14],
    ];
    for (const [floor, targetMean, ceiling] of triples) {
      expect(drawOutcome(floor, targetMean, ceiling, 0, 0.15)).toBeCloseTo(floor, 10);
      expect(drawOutcome(floor, targetMean, ceiling, 0, 0.85)).toBeCloseTo(ceiling, 10);
    }
  });

  it("left tail runs from posMin to floor", () => {
    expect(drawOutcome(10, 18, 28, 0, 0)).toBeCloseTo(0, 10);
    expect(drawOutcome(10, 18, 28, -5, 0)).toBeCloseTo(-5, 10);
  });

  it("right tail approaches a finite asymptote (ceiling + (ceiling - anchor) * k) as u -> 1", () => {
    const floor = 5;
    const targetMean = 12;
    const ceiling = 20;
    const k = 0.5;
    const m = internalAnchorForTargetMean(floor, targetMean, ceiling, 0, k);
    const atOne = drawOutcome(floor, targetMean, ceiling, 0, 1.0, k);
    expect(atOne).toBeCloseTo(ceiling + (ceiling - m) * k, 10);
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
    const players = [makePlayer("qb-a", "QB", "AAA", "BBB", 10, 20, 30), makePlayer("qb-b", "QB", "BBB", "AAA", 10, 25, 30)];
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
  it("recovers floor/ceiling at P15/P85 and the MEAN (not median) at proj, for an 'other' player", () => {
    // Ranked behind wr1/wr2/wr3 (proj 16/15/14) on its own team -- past
    // the WR1-3 cutoff, so genuinely "other": zero correlation, nothing
    // but its own independent draw through drawOutcome.
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
    const sorted = [...samples].sort((a, b) => a - b);
    const p15 = sorted[Math.floor(N * 0.15)];
    const p85 = sorted[Math.floor(N * 0.85)];
    const sampleMean = samples.reduce((a, b) => a + b, 0) / N;

    expect(p15).toBeCloseTo(5, 0);
    expect(p85).toBeCloseTo(20, 0);
    expect(sampleMean).toBeCloseTo(12, 0);
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

describe("drawSlateOutcomes: Vegas/dome no longer affect the draw (removed -- ETR already bakes both in)", () => {
  it("a skewed Vegas total does NOT raise that game's mean scoring any more", () => {
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

    // Same seed, same per-trial random stream, and the Vegas map is now
    // simply unused -- outcomes should be IDENTICAL, not just "close".
    expect(highGame1Sum).toBe(neutralGame1Sum);
  });

  it("drawSlateOutcomes no longer takes a domeTeams parameter at all -- dome has no effect by construction", () => {
    const players = [
      makePlayer("qbA", "QB", "AAA", "BBB", 12, 18, 28),
      makePlayer("qbB", "QB", "BBB", "AAA", 12, 18, 28),
    ];
    const rng1 = new SeededRandom(321);
    const rng2 = new SeededRandom(321);
    const out1 = drawSlateOutcomes(players, NO_VEGAS, rng1);
    const out2 = drawSlateOutcomes(players, NO_VEGAS, rng2);
    for (const p of players) expect(out1.get(p.id)).toBe(out2.get(p.id));
  });
});
