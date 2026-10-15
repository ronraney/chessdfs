// Ported from tests/test_openings.py, now in full. Naming, continuations,
// and legal depth were ported in Task 27; family ranking (rankFamilies,
// 12 tests) and opening preview (openingPreview, 3 tests) are ported here
// in Task 28. The build loop, CLI, and UI remain out of scope.
import { Chess } from "chess.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { ContestConfig } from "./config";
import { loadLineStats, loadOpeningBook } from "./loaders";
import { Piece } from "./models";
import {
  BookLine,
  bookContinuations,
  bookWeights,
  continuingLines,
  findOpeningLines,
  legalDepth,
  openingLine,
  openingName,
  openingPreview,
  randomOpening,
  rankFamilies,
  splitFamily,
  suggestOpening,
  type RankableLine,
} from "./openings";
import { PieceBand, RosterSlot, SportConfig, loadSportConfig } from "./sport";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENINGS_DIR = path.join(dirname, "..", "data", "openings");
const BOOK = loadOpeningBook(
  ["a", "b", "c", "d", "e"].map((letter) => readFileSync(path.join(OPENINGS_DIR, `${letter}.tsv`), "utf-8")),
);
const NFL = loadSportConfig(nflConfig);

const RUY_LOPEZ = ["e4", "e5", "Nf3", "Nc6", "Bb5"];
const MORPHY_DEFENSE = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]; // Ruy Lopez: Morphy Defense, C70
const NAJDORF = ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"];
const FRIED_LIVER = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "Ng5", "d5", "exd5", "Nxd5", "Nxf7"];
// Italian Game: Classical Variation, Albin Gambit, C50 -- castles early (ply 7).
const ITALIAN_CASTLES = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "c3"];

function boardAfter(moves: readonly string[]): Chess {
  const board = new Chess();
  for (const san of moves) {
    board.move(san);
  }
  return board;
}

describe("openingName", () => {
  it("Ruy Lopez", () => {
    expect(openingName(RUY_LOPEZ, BOOK)).toBe("Ruy Lopez");
  });

  it("null when no line matches", () => {
    expect(openingName(["Qzz9"], BOOK)).toBeNull(); // not a real SAN token; no line starts with it
  });
});

describe("openingLine", () => {
  it("Morphy Defense's eco ply by ply: B00 -> C20 -> C40 -> C44 -> C60 -> C70", () => {
    // Ply 4 (e4 e5 Nf3 Nc6) has its own dedicated book entry -- "King's
    // Knight Opening: Normal Variation", C44 -- longer and so a better
    // match than ply 3's C40 ("King's Knight Opening"), same rule as
    // every other ply here. Verified against the real vendored book
    // (web/src/data/openings/c.tsv).
    const expectedEcos = ["B00", "C20", "C40", "C44", "C60", "C70"];
    for (let ply = 1; ply <= MORPHY_DEFENSE.length; ply++) {
      const line = openingLine(MORPHY_DEFENSE.slice(0, ply), BOOK);
      expect(line?.eco).toBe(expectedEcos[ply - 1]);
    }
    expect(openingLine(MORPHY_DEFENSE, BOOK)?.name).toBe("Ruy Lopez: Morphy Defense");
  });

  it("null when no line matches", () => {
    expect(openingLine(["Qzz9"], BOOK)).toBeNull();
  });
});

describe("bookContinuations", () => {
  it("after e4", () => {
    const continuations = bookContinuations(["e4"], BOOK);
    for (const expected of ["e5", "c5", "e6", "c6"]) {
      expect(continuations.has(expected)).toBe(true);
    }
  });
});

describe("legalDepth", () => {
  it("Najdorf breaks at ply 9", () => {
    expect(legalDepth(NAJDORF, NFL)).toBe(9);
  });

  it("Fried Liver breaks at ply 10", () => {
    expect(legalDepth(FRIED_LIVER, NFL)).toBe(10);
  });

  it("null when the line never breaks", () => {
    expect(legalDepth(RUY_LOPEZ, NFL)).toBeNull();
  });

  it("handles a sport missing a piece band", () => {
    // A sport with only the required PAWN catch-all band -- a line
    // requiring a Knight has no eligible band at all, so it must break
    // right there (not crash -- Task 17 wired legal_depth into a live
    // cli.py path for the first time, via opening_preview, and this
    // surfaced against a sport fixture this minimal).
    const toySport = new SportConfig({
      sport: "TOY",
      salaryCap: 50000,
      pieceBands: [
        new PieceBand({ piece: Piece.PAWN, positions: null, excludePositions: null, minSalary: null, maxSalary: null }),
      ],
      rosterSlots: [new RosterSlot({ name: "ANY", positions: new Set(["ANY"]), count: 9 })],
    });
    expect(legalDepth(["e4", "e5", "Nf3"], toySport)).toBe(3); // Nf3 at ply 3: no Knight band exists
  });
});

// --- popularity weights ------------------------------------------------
// Synthetic popularity fixtures -- deliberately not the real
// data/openings/popularity.json. Tests must stay deterministic and
// network-free regardless of whether that file has been populated yet.

describe("bookWeights", () => {
  it("ranks e5 and c5 above b6 after e4", () => {
    expect(bookContinuations(["e4"], BOOK).has("b6")).toBe(true); // Owen Defense; a real, rare line
    const popularity = { e4: { e5: 1_000_000, c5: 800_000, b6: 500 } };

    const weights = bookWeights(["e4"], BOOK, popularity);

    expect(weights.e5).toBeGreaterThan(weights.b6);
    expect(weights.c5).toBeGreaterThan(weights.b6);
  });

  it("equal when the position has no data", () => {
    const weights = bookWeights(["e4"], BOOK, {});
    const continuations = bookContinuations(["e4"], BOOK);

    expect(new Set(Object.keys(weights))).toEqual(continuations);
    expect(new Set(Object.values(weights)).size).toBe(1); // every continuation weighted the same
  });

  it("missing continuation defaults to zero", () => {
    // A continuation the book has but the fetched position's data
    // doesn't mention still gets a weight -- just the lowest one (0),
    // not dropped.
    const popularity = { e4: { e5: 100 } };
    const weights = bookWeights(["e4"], BOOK, popularity);
    expect(weights.c5).toBe(0);
    expect(weights.e5).toBe(100);
  });
});

// --- template search / continuation lookups (Task 13) -------------------

describe("findOpeningLines", () => {
  it("matches by name case-insensitively", () => {
    const matches = findOpeningLines("ruy lopez", BOOK);
    expect(matches.some((line) => line.name === "Ruy Lopez")).toBe(true);
    expect(matches.every((line) => line.name.toLowerCase().includes("ruy lopez"))).toBe(true);
  });

  it("blank query matches everything", () => {
    expect(findOpeningLines("", BOOK)).toEqual(BOOK);
  });

  it("no match", () => {
    expect(findOpeningLines("not a real opening name", BOOK)).toEqual([]);
  });
});

describe("continuingLines", () => {
  it("after e4 includes Ruy Lopez and excludes shorter lines", () => {
    const matches = continuingLines(["e4"], BOOK);
    expect(matches.some((line) => line.name === "Ruy Lopez")).toBe(true);
    expect(matches.every((line) => line.moves[0] === "e4")).toBe(true);
    expect(matches.every((line) => line.moves.length > 1)).toBe(true); // each has a next move
  });

  it("empty when nothing matches", () => {
    expect(continuingLines(["Qzz9"], BOOK)).toEqual([]); // not a real SAN token; no line starts with it
  });
});

// --- family / variation split (Task 15) ----------------------------------

describe("splitFamily", () => {
  it("with a colon", () => {
    const name = "Ruy Lopez: Berlin Defense, Rio Gambit Accepted";
    expect(splitFamily(name)).toEqual(["Ruy Lopez", "Berlin Defense, Rio Gambit Accepted"]);
  });

  it("with no colon has no variation", () => {
    expect(splitFamily("Ruy Lopez")).toEqual(["Ruy Lopez", ""]);
  });
});

// --- opening preview (Task 17) ------------------------------------------

describe("openingPreview", () => {
  it("Morphy Defense gives White Pawn/Knight/Bishop", () => {
    const line = new BookLine({ eco: "C70", name: "Ruy Lopez: Morphy Defense", moves: MORPHY_DEFENSE });
    const preview = openingPreview(line, NFL);
    expect(preview.whitePieces).toEqual([Piece.PAWN, Piece.KNIGHT, Piece.BISHOP]);
    expect(preview.blackPieces).toEqual([Piece.PAWN, Piece.KNIGHT, Piece.PAWN]);
    expect(preview.fen).toBe(boardAfter(MORPHY_DEFENSE).fen());
    expect(preview.breakPly).toBeNull();
  });

  it("a castling line lists King and Rook", () => {
    const line = new BookLine({
      eco: "C50",
      name: "Italian Game: Classical Variation, Albin Gambit",
      moves: ITALIAN_CASTLES,
    });
    const preview = openingPreview(line, NFL);
    expect(preview.whitePieces).toEqual([
      Piece.PAWN,
      Piece.KNIGHT,
      Piece.BISHOP,
      Piece.KING,
      Piece.ROOK,
      Piece.PAWN,
    ]);
  });

  it("Najdorf reports White's break at ply 9", () => {
    const line = new BookLine({ eco: "B90", name: "Najdorf", moves: NAJDORF });
    const preview = openingPreview(line, NFL);
    expect(preview.breakPly).toBe(9);
    expect(preview.breakPly).toBe(legalDepth(NAJDORF, NFL));
  });
});

// --- family ranking (Task 20, corrected by Task 20b) ---------------------
// Synthetic line_stats-shaped fixtures -- deliberately not the real
// data/openings/line_stats.json, so these stay deterministic regardless
// of what that file currently contains.

function stat(eco: string, name: string, moves: readonly string[], games: number): RankableLine {
  return { eco, name, moves, games };
}

const SIX_PLY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];
const SEVEN_PLY = [...SIX_PLY, "O-O"];
const FIVE_PLY = SIX_PLY.slice(0, -1);

describe("rankFamilies", () => {
  it("orders by the representative lines' games", () => {
    const lineStats = [
      stat("C60", "Ruy Lopez", SIX_PLY, 1000),
      stat("B01", "Scandinavian Defense", SIX_PLY, 2000),
    ];
    const ranked = rankFamilies(lineStats);
    expect(ranked.map((f) => f.name)).toEqual(["Scandinavian Defense", "Ruy Lopez"]);
    expect(ranked.map((f) => f.rank)).toEqual([1, 2]);
  });

  it("a sub-variation substitutes for a too-short bare name", () => {
    // Task 20b's correction: the bare name's own row is only 5 plies, but
    // a named sub-variation reaching 6+ plies DOES substitute for it --
    // unlike Task 20's original (buggy) bare-name-only restriction.
    const lineStats = [
      stat("C60", "Ruy Lopez", FIVE_PLY, 1000),
      stat("C60x", "Ruy Lopez: Morphy Defense", SIX_PLY, 50_000),
    ];
    const ranked = rankFamilies(lineStats);
    expect(ranked.length).toBe(1);
    expect(ranked[0].name).toBe("Ruy Lopez");
    expect(ranked[0].line.name).toBe("Ruy Lopez: Morphy Defense");
    expect(ranked[0].games).toBe(50_000);
  });

  it("a sub-variation is a valid representative with no bare row", () => {
    // No bare-name row at all for this family -- its only row is a named
    // sub-variation, which is a perfectly good representative (Task 20b).
    const lineStats = [stat("C60x", "Ruy Lopez: Morphy Defense", SIX_PLY, 50_000)];
    const ranked = rankFamilies(lineStats);
    expect(ranked.length).toBe(1);
    expect(ranked[0].name).toBe("Ruy Lopez");
    expect(ranked[0].line.name).toBe("Ruy Lopez: Morphy Defense");
  });

  it("picks the most-played qualifying row in the family", () => {
    // Mixed bare and colon-named rows at various ply depths; only the
    // 6- and 7-ply ones qualify, and the 7-ply one has more games.
    const lineStats = [
      stat("C60a", "Ruy Lopez", FIVE_PLY, 90_000),
      stat("C60b", "Ruy Lopez", SIX_PLY, 1_000),
      stat("C60c", "Ruy Lopez: Morphy Defense", SEVEN_PLY, 5_000),
    ];
    const ranked = rankFamilies(lineStats);
    expect(ranked.length).toBe(1);
    expect(ranked[0].games).toBe(5_000);
    expect(ranked[0].line.moves).toEqual(SEVEN_PLY);
  });

  it("rank 1 is most played", () => {
    const lineStats = [
      stat("A", "Alpha", SIX_PLY, 100),
      stat("B", "Beta", SIX_PLY, 300),
      stat("C", "Gamma", SIX_PLY, 200),
    ];
    const ranked = rankFamilies(lineStats);
    expect(ranked.map((f) => f.name)).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(ranked[0].rank).toBe(1);
  });

  it("excludes configured umbrella families", () => {
    // Task 20b: excluded by name, regardless of games -- not derived
    // from the data by a rule (this family would easily qualify
    // otherwise: a bare 6-ply row with plenty of games).
    const lineStats = [stat("C00", "King's Pawn Game", SIX_PLY, 1_000_000)];
    expect(rankFamilies(lineStats)).toEqual([]);
  });

  it("the excluded-families list can be overridden", () => {
    const lineStats = [
      stat("C60", "Ruy Lopez", SIX_PLY, 1000),
      stat("B01", "Scandinavian Defense", SIX_PLY, 2000),
    ];
    const ranked = rankFamilies(lineStats, new Set(["Scandinavian Defense"]));
    expect(ranked.map((f) => f.name)).toEqual(["Ruy Lopez"]);
  });

  it("King's Pawn Game is unranked with real data", () => {
    const lineStats = loadLineStats(readFileSync(path.join(OPENINGS_DIR, "line_stats.json"), "utf-8"));
    const names = new Set(rankFamilies(lineStats).map((f) => f.name));
    expect(names.has("King's Pawn Game")).toBe(false);
    expect(names.has("Queen's Pawn Game")).toBe(false);
    expect(names.has("King's Knight Opening")).toBe(false);
    expect(names.has("Indian Defense")).toBe(false);
  });

  it("Sicilian is rank 1 with real data", () => {
    const lineStats = loadLineStats(readFileSync(path.join(OPENINGS_DIR, "line_stats.json"), "utf-8"));
    const ranked = rankFamilies(lineStats);
    expect(ranked[0].name).toBe("Sicilian Defense");
    expect(ranked[0].rank).toBe(1);
  });

  it("Ruy Lopez's representative is Morphy Defense with real data", () => {
    const lineStats = loadLineStats(readFileSync(path.join(OPENINGS_DIR, "line_stats.json"), "utf-8"));
    const ranked = new Map(rankFamilies(lineStats).map((f) => [f.name, f]));
    const ruyLopez = ranked.get("Ruy Lopez")!;
    expect(ruyLopez.line.name).toBe("Ruy Lopez: Morphy Defense");
    expect(ruyLopez.line.moves).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
  });

  it("about 85 or more families rank with real data", () => {
    const lineStats = loadLineStats(readFileSync(path.join(OPENINGS_DIR, "line_stats.json"), "utf-8"));
    expect(rankFamilies(lineStats).length).toBeGreaterThanOrEqual(85);
  });

  it("the top 9 families are pinned in order with real data", () => {
    const lineStats = loadLineStats(readFileSync(path.join(OPENINGS_DIR, "line_stats.json"), "utf-8"));
    const ranked = rankFamilies(lineStats);
    expect(ranked.slice(0, 9).map((f) => f.name)).toEqual([
      "Sicilian Defense",
      "Scotch Game",
      "Caro-Kann Defense",
      "Scandinavian Defense",
      "Italian Game",
      "French Defense",
      "Ruy Lopez",
      "Queen's Gambit Declined",
      "Nimzo-Indian Defense",
    ]);
  });
});

// --- suggested opening / random opening (Task 31) -------------------------
// Real data throughout, same as rankFamilies' own real-data tests above --
// both functions are meant to run against the live ranking, and parity.json
// (via tools/export_parity.py) separately pins suggestOpening's exact
// output against Python's cli.py selection at eight field sizes.

const REAL_RANKED = rankFamilies(loadLineStats(readFileSync(path.join(OPENINGS_DIR, "line_stats.json"), "utf-8")));

describe("suggestOpening", () => {
  it("H2H (2 entries) suggests rank 1, Sicilian Defense", () => {
    const h2h = new ContestConfig({ fieldSize: 2, payouts: [] });
    const suggestion = suggestOpening(h2h, REAL_RANKED);
    expect(suggestion.rank).toBe(1);
    expect(suggestion.name).toBe("Sicilian Defense");
  });

  it("returns the ranked family's own representative line", () => {
    const h2h = new ContestConfig({ fieldSize: 2, payouts: [] });
    const suggestion = suggestOpening(h2h, REAL_RANKED);
    expect(suggestion.line).toBe(REAL_RANKED[0].line);
  });
});

describe("randomOpening", () => {
  const smallTier = new ContestConfig({ fieldSize: 1000, payouts: [] }).entryTier(REAL_RANKED.length); // Small: ranks 1-9

  it("stays within the given tier across many seeds", () => {
    for (let seed = 0; seed < 25; seed++) {
      const pick = randomOpening(REAL_RANKED, smallTier, seed);
      expect(pick.rank).toBeGreaterThanOrEqual(smallTier.lowRank);
      expect(pick.rank).toBeLessThanOrEqual(smallTier.highRank);
    }
  });

  it("the same seed gives the same pick", () => {
    const first = randomOpening(REAL_RANKED, smallTier, 42);
    const second = randomOpening(REAL_RANKED, smallTier, 42);
    expect(second).toBe(first);
  });

  it("'all' can pick a family outside any single tier's range", () => {
    for (let seed = 0; seed < 25; seed++) {
      const pick = randomOpening(REAL_RANKED, "all", seed);
      expect(pick.rank).toBeGreaterThanOrEqual(1);
      expect(pick.rank).toBeLessThanOrEqual(REAL_RANKED.length);
    }
  });
});
