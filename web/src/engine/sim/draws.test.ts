import { describe, expect, it } from "vitest";
import { Player } from "../models";
import { SeededRandom } from "../rng";
import { drawOutcome, drawSlateOutcomes, type SlateVegas } from "./draws";

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
    // At u=1.0, k=1: ceiling + (ceiling - median) * 1 * (1.0-0.85)/0.15 = ceiling + (ceiling-median)
    expect(drawOutcome(10, 18, 28, 0, 1.0)).toBeCloseTo(28 + (28 - 18), 10);
  });

  it("left tail runs from posMin to floor", () => {
    expect(drawOutcome(10, 18, 28, 0, 0)).toBeCloseTo(0, 10);
    expect(drawOutcome(10, 18, 28, -5, 0)).toBeCloseTo(-5, 10);
  });
});

describe("drawSlateOutcomes: known triples over many draws", () => {
  it("recovers roughly the right P15/P50/P85 for an isolated player", () => {
    const wr = makePlayer("wr1", "WR", "AAA", "BBB", 5, 12, 20);
    const dummyOpp = makePlayer("dummy1", "WR", "BBB", "AAA", 5, 12, 20);
    const players = [wr, dummyOpp];

    const rng = new SeededRandom(12345);
    const N = 20000;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, rng);
      samples.push(out.get("wr1")!);
    }
    samples.sort((a, b) => a - b);
    const p15 = samples[Math.floor(N * 0.15)];
    const p50 = samples[Math.floor(N * 0.5)];
    const p85 = samples[Math.floor(N * 0.85)];

    // The latent model layers regime shocks (shootout/script) on top of the
    // raw percentile curve, so empirical percentiles track the ETR anchors
    // closely but not exactly -- same structural reason nfl-dfs's own
    // calibration harness measures its OWN empirical P95 rather than
    // assuming the raw anchor. Tolerance is generous but still meaningfully
    // bounds the median tightly and confirms P15 < P50 < P85 ordering.
    expect(p50).toBeGreaterThan(10);
    expect(p50).toBeLessThan(15);
    expect(p15).toBeLessThan(p50);
    expect(p85).toBeGreaterThan(p50);
    expect(p15).toBeGreaterThan(0);
    expect(p15).toBeLessThan(8);
    expect(p85).toBeGreaterThan(18);
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

describe("drawSlateOutcomes: correlation structure", () => {
  it("teammates are positively correlated", () => {
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

  it("DST is negatively correlated with the opposing RB", () => {
    // DST (AAA) and RB (BBB) are on OPPOSING sides of the same game -- the
    // negative correlation channel is DST's negative wGame loading vs RB's
    // positive wGame loading on the one zGame factor they share, not a
    // same-team relationship (same-team RB<->DST is the OPPOSITE sign in
    // nfl-dfs's own validated asymmetry -- see module header).
    const dst = makePlayer("dst1", "DST", "AAA", "BBB", 2, 7, 14);
    const oppRb = makePlayer("rb1", "RB", "BBB", "AAA", 6, 12, 20);
    const players = [dst, oppRb];

    const rng = new SeededRandom(99);
    const N = 10000;
    const dstPts: number[] = [];
    const rbPts: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, rng);
      dstPts.push(out.get("dst1")!);
      rbPts.push(out.get("rb1")!);
    }

    expect(pearsonR(dstPts, rbPts)).toBeLessThan(-0.05);
  });
});

describe("drawSlateOutcomes: Vegas total", () => {
  it("a high Vegas total raises that game's mean scoring vs neutral", () => {
    // totalShift is a deviation FROM THE SLATE AVERAGE (nfl-dfs's own
    // design), so a single-game slate is self-referential -- that game's
    // total always equals the average of itself, and the shift is always
    // zero regardless of the number entered. A second game is required to
    // give the average something to deviate from.
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

    // game1 at a high total (60), game2 at a below-average total (40) --
    // gives the slate average (50) something real to deviate from.
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
});

describe("drawSlateOutcomes: dome", () => {
  it("a dome game leans more on the shared zGame factor than a non-dome game", () => {
    // Dome only scales wGame (the shared-per-game loading), not wTeam --
    // so the cleanest place to see it is a CROSS-team pair (no shared
    // zTeam at all) sharing only the game's zGame factor. Game1 (AAA
    // hosting BBB) is flagged dome; game2 (CCC hosting DDD) is an
    // identical control, non-dome -- AAA is the HOME team (isHome: true),
    // exactly the team dome status keys off of.
    const qbA = makePlayer("qbA", "QB", "AAA", "BBB", 12, 18, 28, true);
    const qbB = makePlayer("qbB", "QB", "BBB", "AAA", 12, 18, 28, false);
    const qbC = makePlayer("qbC", "QB", "CCC", "DDD", 12, 18, 28, true);
    const qbD = makePlayer("qbD", "QB", "DDD", "CCC", 12, 18, 28, false);
    const players = [qbA, qbB, qbC, qbD];
    const domeTeams = new Set(["AAA"]);

    const rng = new SeededRandom(2468);
    const N = 10000;
    const aPts: number[] = [];
    const bPts: number[] = [];
    const cPts: number[] = [];
    const dPts: number[] = [];
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, NO_VEGAS, rng, domeTeams);
      aPts.push(out.get("qbA")!);
      bPts.push(out.get("qbB")!);
      cPts.push(out.get("qbC")!);
      dPts.push(out.get("qbD")!);
    }

    const domeCorr = pearsonR(aPts, bPts);
    const controlCorr = pearsonR(cPts, dPts);
    expect(domeCorr).toBeGreaterThan(controlCorr);
  });

  it("dome keys off the home team only, not either team in the matchup: NO @ NYG is not a dome game, NYG @ NO is", () => {
    // Cross-team wGame-only pairs again (see the test above for why) --
    // dome's measurable effect is a higher cross-team correlation than a
    // domeTeams-empty control drawn from the identical matchup.
    const domeTeams = new Set(["NO"]);
    const rng = new SeededRandom(70118);
    const N = 10000;

    function crossTeamCorr(homeTeam: string, awayTeam: string, domes: ReadonlySet<string>): number {
      const home = makePlayer("home", "QB", homeTeam, awayTeam, 12, 18, 28, true);
      const away = makePlayer("away", "QB", awayTeam, homeTeam, 12, 18, 28, false);
      const homePts: number[] = [];
      const awayPts: number[] = [];
      for (let i = 0; i < N; i++) {
        const out = drawSlateOutcomes([home, away], NO_VEGAS, rng, domes);
        homePts.push(out.get("home")!);
        awayPts.push(out.get("away")!);
      }
      return pearsonR(homePts, awayPts);
    }

    // "NO @ NYG": NO away, NYG hosts -- NYG isn't a dome team, so this
    // reads identically to a plain non-dome control even with domeTeams
    // naming NO (NO is only the away team here, never consulted).
    const noAtNyg = crossTeamCorr("NYG", "NO", domeTeams);
    const nonDomeControl = crossTeamCorr("NYG", "NO", EMPTY_DOME);
    expect(noAtNyg).toBeCloseTo(nonDomeControl, 1);

    // "NYG @ NO": NYG away, NO hosts -- NO (Caesars Superdome) IS a dome
    // team, so this game IS dome -- a real correlation boost vs. the same
    // matchup with no dome list at all.
    const nygAtNo = crossTeamCorr("NO", "NYG", domeTeams);
    const domeControl = crossTeamCorr("NO", "NYG", EMPTY_DOME);
    expect(nygAtNo).toBeGreaterThan(domeControl);
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
