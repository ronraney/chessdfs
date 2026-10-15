// Ported one-for-one from tests/test_pieces.py, against the same real
// config/sports/nfl.json (synced into web/src/data by `npm run sync-data`).
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { Piece, Player } from "./models";
import { classify } from "./pieces";
import { loadSportConfig } from "./sport";

const NFL = loadSportConfig(nflConfig);

function makePlayer(pos: string, salary: number): Player {
  return new Player({
    id: "p1",
    name: "Test Player",
    positions: [pos],
    team: "AAA",
    opp: "BBB",
    salary,
    proj: 10.0,
    ownSmall: 10.0,
    ownLarge: 10.0,
  });
}

function pool(player: Player, nfl = NFL): Set<string> {
  return new Set(classify(player, nfl));
}

describe("classify", () => {
  it.each([100, 3000, 4999, 5000, 6900, 7000, 9000])(
    "QB is always King only (salary %i)",
    (salary) => {
      expect(pool(makePlayer("QB", salary))).toEqual(new Set([Piece.KING]));
    },
  );

  it.each(["RB", "WR", "TE", "DST", "FB"])(
    "non-QB at 7000+ is Queen-eligible (%s)",
    (pos) => {
      expect(classify(makePlayer(pos, 7000), NFL).has(Piece.QUEEN)).toBe(true);
      expect(classify(makePlayer(pos, 9500), NFL).has(Piece.QUEEN)).toBe(true);
    },
  );

  it("RB Rook boundary 4999/5000", () => {
    expect(pool(makePlayer("RB", 4999))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("RB", 5000))).toEqual(new Set([Piece.ROOK]));
  });

  it("WR Bishop boundary 4999/5000", () => {
    expect(pool(makePlayer("WR", 4999))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("WR", 5000))).toEqual(new Set([Piece.BISHOP]));
  });

  it("TE Knight boundary 4999/5000", () => {
    expect(pool(makePlayer("TE", 4999))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("TE", 5000))).toEqual(new Set([Piece.KNIGHT]));
  });

  it("Rook/Bishop/Knight overlap Queen at 6999 vs 7000", () => {
    // Piece pools: Rook/Bishop/Knight no longer have a $7,000 ceiling, so
    // an RB/WR/TE at $7,000+ is in BOTH its position band and Queen -- the
    // $6,900 case stays single-pool (below Queen's own $7,000 floor).
    expect(pool(makePlayer("RB", 6900))).toEqual(new Set([Piece.ROOK]));
    expect(pool(makePlayer("RB", 7000))).toEqual(new Set([Piece.ROOK, Piece.QUEEN]));
    expect(pool(makePlayer("WR", 6900))).toEqual(new Set([Piece.BISHOP]));
    expect(pool(makePlayer("WR", 7000))).toEqual(new Set([Piece.BISHOP, Piece.QUEEN]));
    expect(pool(makePlayer("TE", 6900))).toEqual(new Set([Piece.KNIGHT]));
    expect(pool(makePlayer("TE", 7000))).toEqual(new Set([Piece.KNIGHT, Piece.QUEEN]));
  });

  it("DST is Pawn-eligible at every salary", () => {
    expect(classify(makePlayer("DST", 5200), NFL).has(Piece.PAWN)).toBe(true);
    expect(classify(makePlayer("DST", 1000), NFL).has(Piece.PAWN)).toBe(true);
    expect(classify(makePlayer("DST", 50000), NFL).has(Piece.PAWN)).toBe(true);
  });

  it("DST at 7000+ is Pawn and Queen", () => {
    // DST is Pawn-eligible regardless of salary ("plus all DST") AND, once
    // >= $7,000, also Queen-eligible -- these two Pawn rules (position-
    // agnostic under $5,000, DST at any salary) aren't mutually exclusive.
    expect(pool(makePlayer("DST", 7000))).toEqual(new Set([Piece.PAWN, Piece.QUEEN]));
  });

  it("any non-QB under 3000 is Pawn only", () => {
    expect(pool(makePlayer("RB", 2500))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("DST", 1000))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("WR", 0))).toEqual(new Set([Piece.PAWN]));
  });

  it("Pawn under 5000 is position-agnostic for non-QB", () => {
    expect(pool(makePlayer("RB", 3000))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("WR", 4900))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("FB", 3500))).toEqual(new Set([Piece.PAWN]));
  });

  it("multi-position player pools from every position it holds", () => {
    const hybrid = new Player({
      id: "h1",
      name: "Hybrid",
      positions: ["RB", "WR"],
      team: "AAA",
      opp: "BBB",
      salary: 5200,
      proj: 10.0,
      ownSmall: 0.1,
      ownLarge: 0.1,
    });
    // Piece pools: both positions' bands contribute, not just the first.
    expect(pool(hybrid)).toEqual(new Set([Piece.ROOK, Piece.BISHOP]));
  });
});
