// Ported one-for-one from tests/test_pieces.py, against the same real
// config/sports/nfl.json (synced into web/src/data by `npm run sync-data`).
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { Piece, Player } from "./models";
import { classify } from "./pieces";
import { loadSportConfig } from "./sport";

const NFL = loadSportConfig(nflConfig);

function makePlayer(pos: string, salary: number, team = "AAA"): Player {
  return new Player({
    id: "p1",
    name: "Test Player",
    positions: [pos],
    team,
    opp: "BBB",
    salary,
    proj: 10.0,
    ownSmall: 10.0,
    ownLarge: 10.0,
    floor: 6.0,
    ceiling: 16.0,
  });
}

function pool(player: Player, nfl = NFL, qbTeam: string | null = null): Set<Piece> {
  return new Set(classify(player, nfl, qbTeam));
}

describe("classify", () => {
  it.each([100, 3000, 4999, 5000, 6900, 7000, 9000])(
    "QB is always King only (salary %i)",
    (salary) => {
      // QUEEN/ROOK/BISHOP/KNIGHT are all explicitly RB/WR/TE -- a QB
      // never pools into anything else, at any salary.
      expect(pool(makePlayer("QB", salary))).toEqual(new Set([Piece.KING]));
    },
  );

  it.each(["RB", "WR", "TE"])(
    "non-QB skill position at 7000+ is Queen-eligible (%s)",
    (pos) => {
      expect(classify(makePlayer(pos, 7000), NFL).has(Piece.QUEEN)).toBe(true);
      expect(classify(makePlayer(pos, 9500), NFL).has(Piece.QUEEN)).toBe(true);
    },
  );

  it("DST and other non-skill positions are never Queen-eligible", () => {
    // Piece table: Queen/Bishop/Knight are explicitly RB/WR/TE now, not
    // "any non-QB" -- DST and an otherwise-unclassified position (e.g.
    // FB) no longer pool into Queen just by being priced at $7,000+.
    expect(classify(makePlayer("DST", 9500), NFL).has(Piece.QUEEN)).toBe(false);
    expect(classify(makePlayer("FB", 9500), NFL).has(Piece.QUEEN)).toBe(false);
  });

  it("Rook/Bishop/Knight are RB/WR/TE now, not one position each", () => {
    // Rook/Bishop/Knight all now share the same RB/WR/TE position band
    // (differentiated only by salary floor, plus Rook's own team
    // restriction) -- an RB is Bishop/Knight-eligible too, not just Rook.
    const rb = makePlayer("RB", 5200);
    expect(pool(rb).has(Piece.BISHOP) && pool(rb).has(Piece.KNIGHT)).toBe(true);
    const wr = makePlayer("WR", 5200);
    expect(pool(wr).has(Piece.BISHOP) && pool(wr).has(Piece.KNIGHT)).toBe(true);
  });

  it("Bishop boundary 4999/5000", () => {
    expect(classify(makePlayer("WR", 4999), NFL).has(Piece.BISHOP)).toBe(false);
    expect(classify(makePlayer("WR", 5000), NFL).has(Piece.BISHOP)).toBe(true);
  });

  it("Knight floor is 4500, unlike Bishop's 5000", () => {
    // Knight's own floor is $4,500, not Bishop's $5,000 -- an RB/WR/TE
    // from $4,500 up to (but not including) $5,000 is in BOTH the
    // Knight and Pawn pools (Pawn's own band still runs up to $5,000),
    // not Knight-only.
    expect(pool(makePlayer("TE", 4499))).toEqual(new Set([Piece.PAWN, Piece.ROOK]));
    expect(pool(makePlayer("TE", 4500))).toEqual(new Set([Piece.KNIGHT, Piece.PAWN, Piece.ROOK]));
    expect(pool(makePlayer("TE", 4999))).toEqual(new Set([Piece.KNIGHT, Piece.PAWN, Piece.ROOK]));
    expect(pool(makePlayer("TE", 5000))).toEqual(new Set([Piece.KNIGHT, Piece.BISHOP, Piece.ROOK]));
  });

  it("Bishop/Knight overlap Queen at 6999 vs 7000", () => {
    expect(pool(makePlayer("WR", 6900))).toEqual(new Set([Piece.BISHOP, Piece.KNIGHT, Piece.ROOK]));
    expect(pool(makePlayer("WR", 7000))).toEqual(new Set([Piece.BISHOP, Piece.KNIGHT, Piece.ROOK, Piece.QUEEN]));
  });

  it("DST is Pawn-eligible at every salary", () => {
    expect(pool(makePlayer("DST", 5200))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("DST", 1000))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("DST", 50000))).toEqual(new Set([Piece.PAWN]));
  });

  it("any non-QB under 5000 with no QB locked is Pawn and Rook", () => {
    // With no QB locked yet for the moving side (qbTeam null, the
    // default), Rook's own team restriction doesn't apply -- "list all
    // RB/WR/TE" (RULES.md "Direct Rook move") -- so an RB/WR/TE under
    // $5,000 pools as both Pawn and Rook, not Pawn alone.
    expect(pool(makePlayer("RB", 2500))).toEqual(new Set([Piece.PAWN, Piece.ROOK]));
    expect(pool(makePlayer("WR", 0))).toEqual(new Set([Piece.PAWN, Piece.ROOK]));
  });

  it("Pawn under 5000 is position-agnostic for non-QB", () => {
    expect(pool(makePlayer("DST", 1000))).toEqual(new Set([Piece.PAWN]));
    expect(pool(makePlayer("FB", 3500))).toEqual(new Set([Piece.PAWN])); // not RB/WR/TE -- no Rook pool
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
      floor: 6.0,
      ceiling: 16.0,
    });
    // Piece pools: both positions' bands contribute, not just the
    // first (moot here since RB/WR share the same bands now, but the
    // pool is still every band RB/WR together qualify for).
    expect(pool(hybrid)).toEqual(new Set([Piece.ROOK, Piece.BISHOP, Piece.KNIGHT]));
  });

  // --- Rook: team-restricted (RULES.md piece table, "Rook = correlation") --

  it("Rook requires a QB-team match when a QB is locked", () => {
    const teammate = makePlayer("RB", 5200, "CIN");
    expect(classify(teammate, NFL, "CIN").has(Piece.ROOK)).toBe(true);
    expect(classify(teammate, NFL, "DET").has(Piece.ROOK)).toBe(false);
  });

  it("Rook ignores team when no QB is locked yet", () => {
    const anyone = makePlayer("WR", 3000, "SEA");
    expect(classify(anyone, NFL, null).has(Piece.ROOK)).toBe(true);
  });

  it("Rook's team restriction does not affect Bishop or Knight", () => {
    // Only Rook's own band is team-restricted -- a team mismatch
    // narrows Rook out of the pool without touching any of the
    // player's other salary-band memberships.
    const player = makePlayer("TE", 5200, "CIN");
    expect(classify(player, NFL, "DET")).toEqual(new Set([Piece.BISHOP, Piece.KNIGHT]));
  });
});
