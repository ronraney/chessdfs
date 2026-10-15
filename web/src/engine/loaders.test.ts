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
import { SlateValidationError, loadEtrCsv, loadLineStats, loadOpeningBook, loadPopularity, validateSlateCsv } from "./loaders";
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

  // Bug fix: a real DK export (data/samples/repro-slate.csv, not committed
  // here -- this fixture is a minimal stand-in with the same header shape)
  // carried a plain "id" column instead of "DK_ID". row["DK_ID"] was then
  // `undefined` for every row, so every Player got the SAME id -- not just
  // a cosmetic gap: BuildState.lockedPlayerIds then treats the whole pool
  // as "already locked" the moment any one player locks (see build.test.ts
  // for the full downstream repro). This fixture has no "DK_ID" column at
  // all, only "id" -- loadEtrCsv should fall back to it.
  const ID_ONLY_CSV = [
    "Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field,id",
    'Test Player A,DST,AAA,BBB,"$2,000",5.0,10.00%,10.00%,1001',
    'Test Player B,DST,AAA,BBB,"$2,100",5.1,10.00%,10.00%,1002',
    'Test Player C,DST,AAA,BBB,"$2,200",5.2,10.00%,10.00%,1003',
  ].join("\n");

  it('falls back to a plain "id" column when "DK_ID" is absent, keeping every player distinct', () => {
    const players = loadEtrCsv(ID_ONLY_CSV);
    expect(players.map((p) => p.id)).toEqual(["1001", "1002", "1003"]);
  });
});

// Task 43: admin-upload-only rigor (not loadEtrCsv itself -- see
// validateSlateCsv's own comment for why that'd break every other caller's
// small/synthetic CSVs).
describe("validateSlateCsv", () => {
  const HEADER = "Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field,DK_ID";

  function row(id: string, name: string, pos: string, salary: number): string {
    return `${name},${pos},AAA,BBB,"$${salary.toLocaleString()}",10.0,10.00%,10.00%,${id}`;
  }

  // QB(1) + RB(2) + WR(3) + TE(1) + DST(1) -- exactly covers every
  // dedicated slot with nothing left over for FLEX, but FLEX's own check
  // only asks for >=1 RB/WR/TE total (see validateSlateCsv's own comment:
  // a plain per-slot count, not a full across-slots matching), which the
  // RB/WR/TE already on the roster trivially satisfy.
  const FEASIBLE_ROWS = [
    row("1", "QB1", "QB", 6000),
    row("2", "RB1", "RB", 5200),
    row("3", "RB2", "RB", 5300),
    row("4", "WR1", "WR", 5000),
    row("5", "WR2", "WR", 5100),
    row("6", "WR3", "WR", 5200),
    row("7", "TE1", "TE", 4500),
    row("8", "DST1", "DST", 2500),
  ];

  function csv(rows: readonly string[]): string {
    return [HEADER, ...rows].join("\n");
  }

  it("the real sample CSV validates cleanly", () => {
    const result = validateSlateCsv(SAMPLE_CSV, NFL);
    expect(result.players).toHaveLength(301);
    expect(result.idColumn).toBe("DK_ID");
  });

  it("a feasible minimal slate validates cleanly and reports the ID column used", () => {
    const result = validateSlateCsv(csv(FEASIBLE_ROWS), NFL);
    expect(result.players).toHaveLength(8);
    expect(result.idColumn).toBe("DK_ID");
  });

  it("rejects a slate with no ID column at all (neither DK_ID nor id)", () => {
    const noIdHeader = "Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field";
    const badCsv = [noIdHeader, "QB1,QB,AAA,BBB,$6000,10.0,10.00%,10.00%"].join("\n");
    expect(() => validateSlateCsv(badCsv, NFL)).toThrow(SlateValidationError);
    expect(() => validateSlateCsv(badCsv, NFL)).toThrow(/No ID column found/);
  });

  it("rejects a slate with a missing ID value", () => {
    const rows = [...FEASIBLE_ROWS.slice(0, -1), row("", "DST1", "DST", 2500)];
    expect(() => validateSlateCsv(csv(rows), NFL)).toThrow(/missing an ID value/);
  });

  it("rejects a slate with duplicate IDs", () => {
    const rows = [...FEASIBLE_ROWS.slice(0, -1), row("1", "DST1", "DST", 2500)]; // "1" reused from QB1
    expect(() => validateSlateCsv(csv(rows), NFL)).toThrow(/Duplicate ID\(s\): 1/);
  });

  it("rejects a slate missing required columns, naming them", () => {
    const badCsv = ["Player,DK Pos,DK_ID", "QB1,QB,1"].join("\n");
    expect(() => validateSlateCsv(badCsv, NFL)).toThrow(/Missing required column\(s\): Team, Opp, DK Salary, DK Proj, Small Field, Large Field\./);
  });

  it("rejects a slate with too few players for a roster slot, naming it", () => {
    const rows = FEASIBLE_ROWS.filter((r) => !r.startsWith("RB2,")); // only 1 RB, needs 2
    expect(() => validateSlateCsv(csv(rows), NFL)).toThrow(/Not enough players for slot\(s\): RB \(need 2, have 1\)/);
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
