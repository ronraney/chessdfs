// Ported one-for-one from tests/test_picklist.py.
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { ContestConfig } from "./config";
import { Piece, Player } from "./models";
import { castleQbCandidates, castleRookList, pickList } from "./picklist";
import { loadSportConfig } from "./sport";

const NFL = loadSportConfig(nflConfig);
const CONTEST = new ContestConfig({ fieldSize: 1000, payouts: [] });

function makePlayer(
  id: string, pos: string, salary: number, proj = 10.0, floor = 6.0, ceiling = 16.0,
  ownSmall = 0.1, ownLarge = 0.1, team = "AAA",
): Player {
  return new Player({
    id, name: id, positions: [pos], team, opp: "BBB",
    salary, proj, ownSmall, ownLarge, floor, ceiling,
  });
}

// --- eligibility / feasibility ----------------------------------------------

describe("pickList", () => {
  it("excludes locked players", () => {
    // Same value (so neither trips Bishop's own median floor below) --
    // this test is about lock exclusion, not the value floor.
    const pool = [makePlayer("rb1", "RB", 5200), makePlayer("rb2", "RB", 5200)];
    const result = pickList(Piece.BISHOP, pool, new Set(["rb1"]), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["rb2"]);
  });

  it("excludes players that would overflow the roster", () => {
    // White already has 2 RBs + the FLEX spoken for by 3 RBs -- a 4th
    // RB-eligible candidate has no slot left.
    const current = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200));
    const pool = [...current, makePlayer("rb4", "RB", 5300)];
    const result = pickList(Piece.BISHOP, pool, new Set(), current, NFL, CONTEST);
    expect(result).toEqual([]);
  });

  it("excludes players that would overflow the cap", () => {
    const tight = new ContestConfig({ cap: 10000, fieldSize: 1000, payouts: [] });
    const current = [makePlayer("wr1", "WR", 5100)];
    const pool = [...current, makePlayer("rb1", "RB", 5200)]; // 5100 + 5200 > 10000
    const result = pickList(Piece.BISHOP, pool, new Set(), current, NFL, tight);
    expect(result).toEqual([]);
  });

  // --- sort: each piece by its own metric (RULES.md piece table) -----------

  it("King sorts by projection", () => {
    const pool = [makePlayer("qb1", "QB", 6000, 15.0), makePlayer("qb2", "QB", 6200, 25.0)];
    const result = pickList(Piece.KING, pool, new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["qb2", "qb1"]);
  });

  it("Queen sorts by ceiling, not projection", () => {
    const lowCeilingHighProj = makePlayer("a", "RB", 7200, 25.0, 6.0, 30.0);
    const highCeilingLowProj = makePlayer("b", "RB", 7300, 20.0, 6.0, 45.0);
    const result = pickList(Piece.QUEEN, [lowCeilingHighProj, highCeilingLowProj], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("Bishop sorts by relativeLeverage, not value", () => {
    // Same value (proj/salary), but "chalk" (heavily owned) should rank
    // below the lower-owned player once relativeLeverage discounts it.
    const chalk = makePlayer("chalk", "WR", 5000, 20.0, 6.0, 16.0, 0.5, 0.5);
    const leveraged = makePlayer("leveraged", "WR", 5000, 20.0, 6.0, 16.0, 0.05, 0.05);
    const result = pickList(Piece.BISHOP, [chalk, leveraged], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["leveraged", "chalk"]);
  });

  // --- Bishop: value floor + relative-ownership sort (this task) -----------

  it("Bishop excludes a player below his own position's median value", () => {
    const below = makePlayer("below", "RB", 5000, 10.0); // value 2.0
    const high = makePlayer("high", "RB", 5000, 20.0); // value 4.0 -- median of [2.0, 4.0] is 3.0
    const result = pickList(Piece.BISHOP, [below, high], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["high"]);
  });

  it("Bishop includes a player exactly at the median ('at or above', not strictly above)", () => {
    const a = makePlayer("a", "RB", 5000, 10.0); // value 2.0
    const b = makePlayer("b", "RB", 5000, 10.0); // value 2.0 -- median of [2.0, 2.0, 6.0] is 2.0
    const c = makePlayer("c", "RB", 5000, 30.0); // value 6.0
    const result = pickList(Piece.BISHOP, [a, b, c], new Set(), [], NFL, CONTEST);
    expect(new Set(result.map((p) => p.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("Bishop's median is computed separately per position, not combined across RB/WR/TE", () => {
    // RB's own median (2.0, 3.0 -> 2.5) lets rbHigh through; a median
    // wrongly combined with WR's much higher values (2.0, 3.0, 20.0, 20.0
    // -> 11.5) would have excluded him instead.
    const rbLow = makePlayer("rbLow", "RB", 5000, 10.0); // value 2.0
    const rbHigh = makePlayer("rbHigh", "RB", 5000, 15.0); // value 3.0
    const wr1 = makePlayer("wr1", "WR", 5000, 100.0); // value 20.0
    const wr2 = makePlayer("wr2", "WR", 5000, 100.0); // value 20.0
    const result = pickList(Piece.BISHOP, [rbLow, rbHigh, wr1, wr2], new Set(), [], NFL, CONTEST);
    expect(new Set(result.map((p) => p.id))).toEqual(new Set(["rbHigh", "wr1", "wr2"]));
  });

  it("Bishop's median comes from the whole slate, before removing locked players", () => {
    // Locking "high" doesn't shrink the pool the median is computed from
    // down to just "low" (which would trivially pass against his own,
    // now-single-player median) -- it's still measured against the
    // ORIGINAL two-player median (3.0), so "low" (2.0) stays excluded.
    const low = makePlayer("low", "RB", 5000, 10.0); // value 2.0
    const high = makePlayer("high", "RB", 5000, 20.0); // value 4.0
    const result = pickList(Piece.BISHOP, [low, high], new Set(["high"]), [], NFL, CONTEST);
    expect(result).toEqual([]);
  });

  it("Bishop sorts by value discounted relative to the highest ownership AT HIS OWN POSITION, not a flat field-size discount", () => {
    // Same value (4.0) for both. "b" sets his position's own ownership
    // ceiling (ratio 1.0 -> discounted to zero); "a" is owned at exactly
    // half of it (ratio 0.5), the same discount plain `leverage` would
    // apply to EITHER of them at a flat 50% ownership.
    const a = makePlayer("a", "WR", 5000, 20.0, 6.0, 16.0, 0.25, 0.25);
    const b = makePlayer("b", "WR", 5000, 20.0, 6.0, 16.0, 0.5, 0.5);
    const result = pickList(Piece.BISHOP, [a, b], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("Knight sorts by floor value, not projection", () => {
    const highProjLowFloor = makePlayer("a", "TE", 4600, 20.0, 2.0);
    const lowProjHighFloor = makePlayer("b", "TE", 4600, 10.0, 9.0);
    const result = pickList(Piece.KNIGHT, [highProjLowFloor, lowProjHighFloor], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("Pawn sorts by value, not projection", () => {
    const cheapEfficient = makePlayer("a", "WR", 3000, 12.0); // value 4.0
    const pricierLessEfficient = makePlayer("b", "WR", 4900, 14.0); // value ~2.86
    const result = pickList(Piece.PAWN, [cheapEfficient, pricierLessEfficient], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });

  // --- no list cap (Rule change "Remove the pick list cap") ------------------

  it("Queen/Rook/Bishop/Knight are no longer capped", () => {
    const pool = Array.from({ length: 20 }, (_, i) => makePlayer(`wr${i}`, "WR", 7000 + i, i));
    expect(pickList(Piece.QUEEN, pool, new Set(), [], NFL, CONTEST)).toHaveLength(20);
    expect(pickList(Piece.ROOK, pool, new Set(), [], NFL, CONTEST)).toHaveLength(20);
    expect(pickList(Piece.KNIGHT, pool, new Set(), [], NFL, CONTEST)).toHaveLength(20);
    // Bishop needs its own pool: identical value (same salary and proj for
    // every player) so none trips the median floor below -- this test is
    // about the (removed) cap, not the floor.
    const bishopPool = Array.from({ length: 20 }, (_, i) => makePlayer(`wr${i}`, "WR", 7000, 10.0));
    expect(pickList(Piece.BISHOP, bishopPool, new Set(), [], NFL, CONTEST)).toHaveLength(20);
  });

  it("King and Pawn are uncapped too", () => {
    const kings = Array.from({ length: 20 }, (_, i) => makePlayer(`qb${i}`, "QB", 6000 + i, i));
    const pawns = Array.from({ length: 20 }, (_, i) => makePlayer(`wr${i}`, "WR", 3000 + i, i));
    expect(pickList(Piece.KING, kings, new Set(), [], NFL, CONTEST)).toHaveLength(20);
    expect(pickList(Piece.PAWN, pawns, new Set(), [], NFL, CONTEST)).toHaveLength(20);
  });

  it("taken and infeasible players are still excluded from a large pool", () => {
    // 14 otherwise-eligible Bishops: one is already locked, and WR(3) +
    // FLEX(1) are already filled by 4 locked WRs, so every one of these
    // candidates (all WR) is also infeasible -- the surviving list must
    // be empty.
    const current = [0, 1, 2, 3].map((i) => makePlayer(`wr_locked${i}`, "WR", 5000 + i)); // fills WR(3) + FLEX
    const pool = Array.from({ length: 14 }, (_, i) => makePlayer(`wr${i}`, "WR", 5100 + i, i));
    const result = pickList(Piece.BISHOP, pool, new Set([pool[0].id]), current, NFL, CONTEST);
    expect(result).toEqual([]);
  });

  // --- Rook: stack-tier sort (Rule change "Rook: stack builder") -------------
  // Any RB/WR/TE, any salary -- no team filter at all (that's the whole
  // point of this rework: see pieces.test.ts). Sorted by tier (1: QB's own
  // team, 2: QB's opponent, 3: a team already in the lineup, 4: everyone
  // else), then by DK Ceiling (not proj) within each tier. "His opponent"
  // is read off the QB's own `opp` field in `currentPlayers` -- QB's own
  // team's own `opp` convention (test fixtures use "BBB" throughout via
  // makePlayer's own default).

  it("eligibility is unrestricted: any team, any salary, with or without a locked QB", () => {
    const teammate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const otherTeam = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 16.0, 0.1, 0.1, "DET");
    const result = pickList(Piece.ROOK, [teammate, otherTeam], new Set(), [], NFL, CONTEST, "CIN");
    expect(new Set(result.map((p) => p.id))).toEqual(new Set(["rb1", "rb2"]));
  });

  it("tier 1 (QB's own team) ranks above tier 4 (everyone else)", () => {
    const qb = makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const teammate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 20.0, 0.1, 0.1, "CIN"); // lower ceiling than...
    const stranger = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 30.0, 0.1, 0.1, "SEA"); // ...this higher-ceiling stranger
    const result = pickList(Piece.ROOK, [stranger, teammate], new Set(), [qb], NFL, CONTEST, "CIN");
    // Tier beats ceiling: the QB's own (lower-ceiling) teammate still
    // ranks first, ahead of the (higher-ceiling) unrelated stranger.
    expect(result.map((p) => p.id)).toEqual(["rb1", "rb2"]);
  });

  it("tier 2 (QB's opponent) ranks between tier 1 and tier 3/4", () => {
    const qb = makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN"); // opp defaults to "BBB"
    const teammate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN"); // tier 1
    const oppPlayer = makePlayer("wr1", "WR", 5100, 10.0, 6.0, 16.0, 0.1, 0.1, "BBB"); // tier 2 -- CIN's opponent
    const stranger = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 16.0, 0.1, 0.1, "SEA"); // tier 4
    const result = pickList(Piece.ROOK, [stranger, oppPlayer, teammate], new Set(), [qb], NFL, CONTEST, "CIN");
    expect(result.map((p) => p.id)).toEqual(["rb1", "wr1", "rb2"]);
  });

  it("tier 3 (a team already in the lineup) ranks above tier 4, with no QB needed", () => {
    const lineupTeammate = makePlayer("existing", "TE", 4800, 10.0, 6.0, 16.0, 0.1, 0.1, "SEA");
    const sameTeamAsLineup = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "SEA"); // tier 3
    const stranger = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 16.0, 0.1, 0.1, "DET"); // tier 4
    const result = pickList(Piece.ROOK, [stranger, sameTeamAsLineup], new Set(), [lineupTeammate], NFL, CONTEST, null);
    expect(result.map((p) => p.id)).toEqual(["rb1", "rb2"]);
  });

  it("no QB locked yet skips tiers 1-2 entirely -- a QB's-team/opponent match means nothing without one", () => {
    // Same shape as the tier-1/tier-2 test above, but qbTeam omitted
    // (null, the default) -- CIN gets no tier-1 boost at all now; both
    // candidates fall through to tier 3/4 (neither matches an EXISTING
    // lineup player's team, since the lineup is empty), landing in the
    // same tier 4 and sorting by ceiling instead.
    const cin = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const seaHigherCeiling = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 30.0, 0.1, 0.1, "SEA");
    const result = pickList(Piece.ROOK, [cin, seaHigherCeiling], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["rb2", "rb1"]);
  });

  it("a player sits in his HIGHEST matching tier only (tier 1 wins even though he'd also match tier 3)", () => {
    const qb = makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const otherCin = makePlayer("existing", "TE", 4800, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN"); // already in the lineup, also CIN
    const candidate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN"); // matches BOTH tier 1 (QB's team) and tier 3 (lineup's team)
    const stranger = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 50.0, 0.1, 0.1, "SEA"); // tier 4, highest ceiling of all
    const result = pickList(Piece.ROOK, [stranger, candidate], new Set(), [qb, otherCin], NFL, CONTEST, "CIN");
    expect(result.map((p) => p.id)).toEqual(["rb1", "rb2"]); // tier 1, not demoted by also qualifying for tier 3
  });

  it("within a tier, sorts by DK Ceiling, not projection", () => {
    const qb = makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const highProjLowCeiling = makePlayer("a", "RB", 5200, 25.0, 6.0, 18.0, 0.1, 0.1, "CIN");
    const lowProjHighCeiling = makePlayer("b", "RB", 5300, 10.0, 6.0, 30.0, 0.1, 0.1, "CIN");
    const result = pickList(Piece.ROOK, [highProjLowCeiling, lowProjHighCeiling], new Set(), [qb], NFL, CONTEST, "CIN");
    expect(result.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("is no longer capped", () => {
    const qb = makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const pool = Array.from({ length: 20 }, (_, i) => makePlayer(`rb${i}`, "RB", 5000 + i, 10.0, 6.0, 16.0 + i, 0.1, 0.1, "CIN"));
    expect(pickList(Piece.ROOK, pool, new Set(), [qb], NFL, CONTEST, "CIN")).toHaveLength(20);
  });
});

// --- castleQbCandidates: "only offer QBs with an eligible teammate" --------

describe("castleQbCandidates", () => {
  it("excludes a QB with no teammate in the pool", () => {
    const lonelyQb = makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const teamedQb = makePlayer("qb2", "QB", 6200, 10.0, 6.0, 16.0, 0.1, 0.1, "DET");
    const teammate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "DET");
    const pool = [lonelyQb, teamedQb, teammate];
    const result = castleQbCandidates(pool, new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["qb2"]);
  });

  it("is empty when no QB has an eligible teammate", () => {
    const pool = [
      makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN"),
      makePlayer("qb2", "QB", 6200, 10.0, 6.0, 16.0, 0.1, 0.1, "DET"),
    ];
    expect(castleQbCandidates(pool, new Set(), [], NFL, CONTEST)).toEqual([]);
  });

  it("excludes a QB whose only teammate is already locked", () => {
    const qb = makePlayer("qb1", "QB", 6000, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const teammate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const result = castleQbCandidates([qb, teammate], new Set([teammate.id]), [], NFL, CONTEST);
    expect(result).toEqual([]);
  });
});

// --- castleRookList: castling's own Rook step, UNCHANGED by "Rook: stack
// builder" (that rework only touches the general/direct Rook pool,
// pickList above) -- still restricted to the QB's own team, still sorted
// by proj. -----------------------------------------------------------------

describe("castleRookList", () => {
  it("is restricted to the QB's own team", () => {
    const teammate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const otherTeam = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 16.0, 0.1, 0.1, "DET");
    const result = castleRookList([teammate, otherTeam], new Set(), [], NFL, CONTEST, "CIN");
    expect(result.map((p) => p.id)).toEqual(["rb1"]);
  });

  it("sorts by projection, not ceiling", () => {
    const lowProjHighCeiling = makePlayer("a", "RB", 5200, 10.0, 6.0, 30.0, 0.1, 0.1, "CIN");
    const highProjLowCeiling = makePlayer("b", "RB", 5300, 25.0, 6.0, 18.0, 0.1, 0.1, "CIN");
    const result = castleRookList([lowProjHighCeiling, highProjLowCeiling], new Set(), [], NFL, CONTEST, "CIN");
    expect(result.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("is no longer capped", () => {
    const pool = Array.from({ length: 20 }, (_, i) => makePlayer(`rb${i}`, "RB", 5000 + i, i, 6.0, 16.0, 0.1, 0.1, "CIN"));
    expect(castleRookList(pool, new Set(), [], NFL, CONTEST, "CIN")).toHaveLength(20);
  });
});

// --- Rule change "Pick lists must keep the lineup completable": a pick
// that's affordable BY ITSELF can still leave too little to ever finish
// the roster -- lineupStillCompletable's salary check is now "is there
// enough left for the CHEAPEST way to fill the other open slots from
// who's really still on the board," not just "total spent <= cap."
// Canonical worked example: 6 locked @ $7,000 ($42,000 of a $50,000 cap
// spent -> $8,000 left), 3 slots open (WR, FLEX, DST), two $3,000
// fallbacks still genuinely available for them -- taking a $7,500 WR
// would leave only $500 for a $6,000 job; a $2,000 WR leaves exactly
// enough. -----------------------------------------------------------------

function canonicalRoster(): Player[] {
  return [
    makePlayer("qb1", "QB", 7000),
    makePlayer("rb1", "RB", 7000),
    makePlayer("rb2", "RB", 7000),
    makePlayer("wr1", "WR", 7000),
    makePlayer("wr2", "WR", 7000),
    makePlayer("te1", "TE", 7000),
  ];
}

const CHEAP_FALLBACKS = [makePlayer("cheap_flex", "RB", 3000), makePlayer("cheap_dst", "DST", 3000)];

describe("pickList -- keeps the lineup completable (Rule change)", () => {
  it("excludes a pick that's affordable alone but leaves too little for the other open slots", () => {
    const current = canonicalRoster();
    const locked = new Set(current.map((p) => p.id));
    const pool = [...current, ...CHEAP_FALLBACKS, makePlayer("wr_pricey", "WR", 7500)];
    const result = pickList(Piece.ROOK, pool, locked, current, NFL, CONTEST);
    expect(result.map((p) => p.id)).not.toContain("wr_pricey");
  });

  it("still offers a pick that leaves exactly enough for the other open slots", () => {
    const current = canonicalRoster();
    const locked = new Set(current.map((p) => p.id));
    const pool = [...current, ...CHEAP_FALLBACKS, makePlayer("wr_affordable", "WR", 2000)];
    const result = pickList(Piece.ROOK, pool, locked, current, NFL, CONTEST);
    expect(result.map((p) => p.id)).toContain("wr_affordable");
  });

  it("same check for a Black pick -- pickList takes no side parameter, just a roster", () => {
    const blacksRoster = canonicalRoster(); // read as Black's own locked roster this time
    const locked = new Set(blacksRoster.map((p) => p.id));
    const pool = [...blacksRoster, ...CHEAP_FALLBACKS, makePlayer("wr_pricey", "WR", 7500), makePlayer("wr_affordable", "WR", 2000)];
    const result = pickList(Piece.ROOK, pool, locked, blacksRoster, NFL, CONTEST).map((p) => p.id);
    expect(result).not.toContain("wr_pricey");
    expect(result).toContain("wr_affordable");
  });
});

describe("castleRookList -- keeps the lineup completable (Rule change)", () => {
  it("excludes a Rook pick that's affordable alone but leaves too little for the other open slots", () => {
    const current = canonicalRoster();
    const locked = new Set(current.map((p) => p.id));
    const pool = [...current, ...CHEAP_FALLBACKS, makePlayer("wr_pricey", "WR", 7500, 10, 6, 16, 0.1, 0.1, "AAA")];
    const result = castleRookList(pool, locked, current, NFL, CONTEST, "AAA");
    expect(result.map((p) => p.id)).not.toContain("wr_pricey");
  });
});
