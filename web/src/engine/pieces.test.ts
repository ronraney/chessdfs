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

describe("classify", () => {
  it.each([100, 3000, 4999, 5000, 6900, 7000, 9000])(
    "QB is always King (salary %i)",
    (salary) => {
      expect(classify(makePlayer("QB", salary), NFL)).toBe(Piece.KING);
    },
  );

  it.each(["RB", "WR", "TE", "DST", "FB"])(
    "non-QB at 7000+ is Queen (%s)",
    (pos) => {
      expect(classify(makePlayer(pos, 7000), NFL)).toBe(Piece.QUEEN);
      expect(classify(makePlayer(pos, 9500), NFL)).toBe(Piece.QUEEN);
    },
  );

  it("RB Rook boundary 4900/5000", () => {
    expect(classify(makePlayer("RB", 4900), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("RB", 5000), NFL)).toBe(Piece.ROOK);
  });

  it("WR Bishop boundary 4900/5000", () => {
    expect(classify(makePlayer("WR", 4900), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("WR", 5000), NFL)).toBe(Piece.BISHOP);
  });

  it("Rook/Bishop/Knight vs Queen boundary 6900/7000", () => {
    expect(classify(makePlayer("RB", 6900), NFL)).toBe(Piece.ROOK);
    expect(classify(makePlayer("RB", 7000), NFL)).toBe(Piece.QUEEN);
    expect(classify(makePlayer("WR", 6900), NFL)).toBe(Piece.BISHOP);
    expect(classify(makePlayer("WR", 7000), NFL)).toBe(Piece.QUEEN);
    expect(classify(makePlayer("TE", 6900), NFL)).toBe(Piece.KNIGHT);
    expect(classify(makePlayer("TE", 7000), NFL)).toBe(Piece.QUEEN);
  });

  it("TE Knight boundary 4400/4500", () => {
    expect(classify(makePlayer("TE", 4400), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("TE", 4500), NFL)).toBe(Piece.KNIGHT);
  });

  it("DST at 5200 is Pawn", () => {
    expect(classify(makePlayer("DST", 5200), NFL)).toBe(Piece.PAWN);
  });

  it("any player under 3000 is Pawn", () => {
    expect(classify(makePlayer("RB", 2500), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("DST", 1000), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("WR", 0), NFL)).toBe(Piece.PAWN);
  });

  it("DST in Pawn range", () => {
    expect(classify(makePlayer("DST", 3000), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("DST", 4900), NFL)).toBe(Piece.PAWN);
  });

  it("Pawn range is position-agnostic", () => {
    expect(classify(makePlayer("RB", 3000), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("WR", 4900), NFL)).toBe(Piece.PAWN);
    expect(classify(makePlayer("FB", 3500), NFL)).toBe(Piece.PAWN);
  });

  it("multi-position player classifies by either position", () => {
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
    // matches via RB; WR would also match Bishop
    expect(classify(hybrid, NFL)).toBe(Piece.ROOK);
  });
});
