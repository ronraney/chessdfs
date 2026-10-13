// Ported from tests/test_loaders.py, now in full. The ETR-CSV section
// (5 tests) was ported in Task 26; the opening-book/popularity/line-stats
// sections (6 tests, deferred then since they belong to openings, not yet
// ported) are ported here in Task 27 alongside openings.ts itself.
//
// Python's loaders take a path (or list of paths) and open the file(s)
// themselves; this port takes file contents as a string (or strings)
// instead, so tests read files via Node's fs (tests aren't part of the
// I/O-free engine) rather than passing a path through. The sample CSV and
// the real opening-book/popularity/line-stats files are read from
// web/src/data/ (samples/, openings/), synced from the repo root by
// sync-data.mjs (gitignored copies -- originals are never touched).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { loadEtrCsv, loadLineStats, loadOpeningBook, loadPopularity } from "./loaders";
import { classify } from "./pieces";
import { loadSportConfig } from "./sport";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV_PATH = path.join(dirname, "..", "data", "samples", "NFL Weekly DFS System - Projections.csv");
const SAMPLE_CSV = readFileSync(SAMPLE_CSV_PATH, "utf-8");
const OPENINGS_DIR = path.join(dirname, "..", "data", "openings");
const NFL = loadSportConfig(nflConfig);

describe("loadEtrCsv", () => {
  it("the sample CSV has 301 players", () => {
    expect(loadEtrCsv(SAMPLE_CSV).length).toBe(301);
  });

  it("salaries are integers", () => {
    const players = loadEtrCsv(SAMPLE_CSV);
    expect(players.every((p) => Number.isInteger(p.salary))).toBe(true);
  });

  it("every loaded player classifies", () => {
    const players = loadEtrCsv(SAMPLE_CSV);
    for (const p of players) {
      classify(p, NFL);
    }
  });

  it("ownership is a 0-1 fraction", () => {
    const players = loadEtrCsv(SAMPLE_CSV);
    expect(players.every((p) => p.ownSmall >= 0 && p.ownSmall <= 1)).toBe(true);
    expect(players.every((p) => p.ownLarge >= 0 && p.ownLarge <= 1)).toBe(true);
  });

  it("names are trimmed", () => {
    const players = loadEtrCsv(SAMPLE_CSV);
    const dstPlayers = players.filter((p) => p.positions.length === 1 && p.positions[0] === "DST");
    expect(dstPlayers.length).toBeGreaterThan(0); // sanity: sample actually has DST rows to check
    expect(players.every((p) => p.name === p.name.trim())).toBe(true);
  });
});

// --- opening book ---------------------------------------------------------

describe("loadOpeningBook", () => {
  it("parses all five files", () => {
    const book = loadOpeningBook(
      ["a", "b", "c", "d", "e"].map((letter) => readFileSync(path.join(OPENINGS_DIR, `${letter}.tsv`), "utf-8")),
    );
    expect(book.length).toBeGreaterThan(3000); // ~3865 rows across a.tsv-e.tsv, minus 5 headers
  });

  it("strips move numbers", () => {
    const book = loadOpeningBook([readFileSync(path.join(OPENINGS_DIR, "c.tsv"), "utf-8")]);
    const ruyLopez = book.find((line) => line.name === "Ruy Lopez");
    expect(ruyLopez?.eco).toBe("C60");
    expect(ruyLopez?.moves).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
  });
});

describe("loadPopularity", () => {
  it("reads the vendored snapshot", () => {
    // Task 9b populated this from a real Lichess game dump (the Opening
    // Explorer API itself is still blocked -- Task 9). This only checks
    // the loader reads valid JSON into the expected shape.
    const popularity = loadPopularity(readFileSync(path.join(OPENINGS_DIR, "popularity.json"), "utf-8"));
    expect(typeof popularity).toBe("object");
    expect(popularity).not.toBeNull();
  });

  it("parses a populated file", () => {
    const data = '{"e4": {"e5": 100, "c5": 80}}';
    expect(loadPopularity(data)).toEqual({ e4: { e5: 100, c5: 80 } });
  });
});

// --- line stats (Task 9b / Task 15) ----------------------------------------

describe("loadLineStats", () => {
  it("reads the vendored snapshot", () => {
    const lines = loadLineStats(readFileSync(path.join(OPENINGS_DIR, "line_stats.json"), "utf-8"));
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0); // Task 9b populated this from a real Lichess game dump
    for (const key of ["eco", "name", "moves", "games"]) {
      expect(Object.keys(lines[0])).toContain(key);
    }
  });

  it("parses a populated file", () => {
    const data = JSON.stringify({
      _meta: { month: "2026-09" },
      lines: [{ eco: "C60", name: "Ruy Lopez", moves: ["e4"], games: 10 }],
    });
    expect(loadLineStats(data)).toEqual([{ eco: "C60", name: "Ruy Lopez", moves: ["e4"], games: 10 }]);
  });
});
