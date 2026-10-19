// Ported one-for-one from tests/test_picklist.py.
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { ContestConfig } from "./config";
import { Piece, Player } from "./models";
import { castleQbCandidates, pickList } from "./picklist";
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
    const pool = [makePlayer("rb1", "RB", 5200), makePlayer("rb2", "RB", 5300)];
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

  it("King and Rook sort by projection", () => {
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

  it("Bishop sorts by leverage, not value", () => {
    // Same value (proj/salary), but "chalk" (heavily owned) should rank
    // below the lower-owned player once leverage discounts it.
    const chalk = makePlayer("chalk", "WR", 5000, 20.0, 6.0, 16.0, 0.5, 0.5);
    const leveraged = makePlayer("leveraged", "WR", 5000, 20.0, 6.0, 16.0, 0.05, 0.05);
    const result = pickList(Piece.BISHOP, [chalk, leveraged], new Set(), [], NFL, CONTEST);
    expect(result.map((p) => p.id)).toEqual(["leveraged", "chalk"]);
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

  // --- list cap (RULES.md "List cap") -----------------------------------------

  it("caps Queen/Rook/Bishop/Knight to 12", () => {
    const pool = Array.from({ length: 20 }, (_, i) => makePlayer(`wr${i}`, "WR", 7000 + i, i));
    expect(pickList(Piece.QUEEN, pool, new Set(), [], NFL, CONTEST)).toHaveLength(12);
    expect(pickList(Piece.ROOK, pool, new Set(), [], NFL, CONTEST)).toHaveLength(12);
    expect(pickList(Piece.BISHOP, pool, new Set(), [], NFL, CONTEST)).toHaveLength(12);
    expect(pickList(Piece.KNIGHT, pool, new Set(), [], NFL, CONTEST)).toHaveLength(12);
  });

  it("King and Pawn are uncapped", () => {
    const kings = Array.from({ length: 20 }, (_, i) => makePlayer(`qb${i}`, "QB", 6000 + i, i));
    const pawns = Array.from({ length: 20 }, (_, i) => makePlayer(`wr${i}`, "WR", 3000 + i, i));
    expect(pickList(Piece.KING, kings, new Set(), [], NFL, CONTEST)).toHaveLength(20);
    expect(pickList(Piece.PAWN, pawns, new Set(), [], NFL, CONTEST)).toHaveLength(20);
  });

  it("cap applies after removing taken and infeasible players", () => {
    // 14 otherwise-eligible Bishops: one is already locked, and WR(3) +
    // FLEX(1) are already filled by 4 locked WRs, so every one of these
    // candidates (all WR) is also infeasible -- the surviving list must
    // be empty, not capped-but-nonempty by counting taken/infeasible
    // players toward the 12.
    const current = [0, 1, 2, 3].map((i) => makePlayer(`wr_locked${i}`, "WR", 5000 + i)); // fills WR(3) + FLEX
    const pool = Array.from({ length: 14 }, (_, i) => makePlayer(`wr${i}`, "WR", 5100 + i, i));
    const result = pickList(Piece.BISHOP, pool, new Set([pool[0].id]), current, NFL, CONTEST);
    expect(result).toEqual([]);
  });

  // --- Rook: team-restricted (RULES.md "Rook = correlation") -----------------

  it("Rook is restricted to the QB's team when given", () => {
    const teammate = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const otherTeam = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 16.0, 0.1, 0.1, "DET");
    const result = pickList(Piece.ROOK, [teammate, otherTeam], new Set(), [], NFL, CONTEST, "CIN");
    expect(result.map((p) => p.id)).toEqual(["rb1"]);
  });

  it("Rook lists all RB/WR/TE when no QB is locked", () => {
    const cin = makePlayer("rb1", "RB", 5200, 10.0, 6.0, 16.0, 0.1, 0.1, "CIN");
    const det = makePlayer("rb2", "RB", 5300, 10.0, 6.0, 16.0, 0.1, 0.1, "DET");
    const result = pickList(Piece.ROOK, [cin, det], new Set(), [], NFL, CONTEST, null);
    expect(new Set(result.map((p) => p.id))).toEqual(new Set(["rb1", "rb2"]));
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
