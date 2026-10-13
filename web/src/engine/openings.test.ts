// Ported from tests/test_openings.py -- naming, continuations, and legal
// depth only, per this task's scope. Family ranking (rankFamilies and its
// 12 tests), opening preview (openingPreview and its 3 tests), and the
// build loop are all out of scope -- see this task's session log.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { loadOpeningBook } from "./loaders";
import { Piece } from "./models";
import {
  bookContinuations,
  bookWeights,
  continuingLines,
  findOpeningLines,
  legalDepth,
  openingName,
  splitFamily,
} from "./openings";
import { PieceBand, RosterSlot, SportConfig, loadSportConfig } from "./sport";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENINGS_DIR = path.join(dirname, "..", "data", "openings");
const BOOK = loadOpeningBook(
  ["a", "b", "c", "d", "e"].map((letter) => readFileSync(path.join(OPENINGS_DIR, `${letter}.tsv`), "utf-8")),
);
const NFL = loadSportConfig(nflConfig);

const RUY_LOPEZ = ["e4", "e5", "Nf3", "Nc6", "Bb5"];
const NAJDORF = ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"];
const FRIED_LIVER = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "Ng5", "d5", "exd5", "Nxd5", "Nxf7"];

describe("openingName", () => {
  it("Ruy Lopez", () => {
    expect(openingName(RUY_LOPEZ, BOOK)).toBe("Ruy Lopez");
  });

  it("null when no line matches", () => {
    expect(openingName(["Qzz9"], BOOK)).toBeNull(); // not a real SAN token; no line starts with it
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
      pieceBands: [new PieceBand({ piece: Piece.PAWN, positions: null, minSalary: null, maxSalary: null })],
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
