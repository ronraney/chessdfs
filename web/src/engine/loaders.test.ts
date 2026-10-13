// Ported from tests/test_loaders.py -- the ETR-CSV section only (5 tests).
// The opening-book/popularity/line-stats sections are out of scope per
// this task ("Not yet: opening book and popularity loading, openings,
// build loop").
//
// Python's load_etr_csv takes a path and opens the file itself; this port
// takes file contents as a string, so the test reads the sample file via
// Node's fs (tests aren't part of the I/O-free engine) instead of passing
// a path through. The sample CSV is read from web/src/data/samples/,
// synced from the repo root's data/samples/ by sync-data.mjs (gitignored
// copy -- the original is never touched).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { loadEtrCsv } from "./loaders";
import { classify } from "./pieces";
import { loadSportConfig } from "./sport";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV_PATH = path.join(dirname, "..", "data", "samples", "NFL Weekly DFS System - Projections.csv");
const SAMPLE_CSV = readFileSync(SAMPLE_CSV_PATH, "utf-8");
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
