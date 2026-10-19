// CSV/JSON loaders -> engine types. Ported from dfs_chess/loaders.py in
// full: load_etr_csv (ETR projections CSV -> Player[]), load_opening_book
// (Lichess chess-openings TSVs -> BookLine[]), load_popularity (the
// fetched opening-popularity snapshot -> a plain object), and
// load_line_stats (line_stats.json's "lines" array, verbatim).
//
// The engine stays I/O-free: unlike Python's loaders, which take a path
// (or list of paths) and open the file(s) themselves, every loader here
// takes the file's contents as a string (or strings) instead -- same
// spirit as loadSportConfig/loadContestConfig taking already-parsed data
// instead of a path, just one step earlier in the pipeline since these
// loaders do their own string parsing (CSV/TSV/JSON) rather than
// expecting it pre-parsed.

import { parse } from "papaparse";
import { Player } from "./models";
import { BookLine } from "./openings";
import type { SportConfig } from "./sport";

// Verified against data/samples/NFL Weekly DFS System - Projections.csv.
// `id` and `DK_ID` are both present and identical in that sample; DK_ID is
// used since it's the name DK's own upload format expects. `Small Field`/
// `Large Field` are separate ownership projections -- there's no single
// "Own" column -- hence ownSmall/ownLarge on Player. Keys here are
// camelCase (matching Player's own TS field names) rather than Python's
// snake_case dict keys -- this map isn't an on-disk schema like
// RawSportConfig, just an internal lookup, so it follows the TS side's
// own naming.
export const ETR_COLUMN_MAP = {
  id: "DK_ID",
  name: "Player",
  pos: "DK Pos",
  team: "Team",
  opp: "Opp",
  salary: "DK Salary",
  proj: "DK Proj",
  ownSmall: "Small Field",
  ownLarge: "Large Field",
  floor: "DK Floor",
  ceiling: "DK Ceiling",
} as const;

export type EtrColumnMap = typeof ETR_COLUMN_MAP;

function parseSalary(raw: string): number {
  return parseInt(raw.replace(/\$/g, "").replace(/,/g, ""), 10);
}

// "40.20%" -> 0.402 (stored as a 0-1 fraction; shown as a percent in the UI).
function parsePercent(raw: string): number {
  return parseFloat(raw.replace(/%+$/, "")) / 100;
}

// "@ARI" (away) -> "ARI"; "SF" (home) is unchanged.
function stripOpp(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

// Bug fix: some DK exports carry only a plain "id" column, not "DK_ID" --
// `row[columnMap.id]` would then be `undefined` for every row, silently
// giving every Player the SAME id. That's not just a cosmetic gap: once
// any one player locks, `BuildState.lockedPlayerIds` holds that shared
// `undefined` id, and `!lockedPlayerIds.has(p.id)` is false for every
// OTHER player too (same id) -- the whole pool reads as "already locked"
// from that point on, and the very next pick (White's or Black's) finds
// zero eligible candidates for any piece band at all. Falling back to
// "id" when "DK_ID" is genuinely absent from the file's own header row
// (not just empty for one row) keeps every player's identity distinct.
function resolveIdColumn(columnMap: EtrColumnMap, fields: readonly string[]): string {
  if (fields.includes(columnMap.id)) return columnMap.id;
  if (fields.includes("id")) return "id";
  return columnMap.id;
}

export function loadEtrCsv(data: string, columnMap: EtrColumnMap = ETR_COLUMN_MAP): Player[] {
  const parsed = parse<Record<string, string>>(data, { header: true, skipEmptyLines: true });
  const rows = parsed.data;
  const idColumn = resolveIdColumn(columnMap, parsed.meta.fields ?? []);
  return rows.map(
    (row) =>
      new Player({
        id: row[idColumn],
        name: row[columnMap.name].trim(),
        positions: [row[columnMap.pos]],
        team: row[columnMap.team],
        opp: stripOpp(row[columnMap.opp]),
        salary: parseSalary(row[columnMap.salary]),
        proj: parseFloat(row[columnMap.proj]),
        ownSmall: parsePercent(row[columnMap.ownSmall]),
        ownLarge: parsePercent(row[columnMap.ownLarge]),
        floor: parseFloat(row[columnMap.floor]),
        ceiling: parseFloat(row[columnMap.ceiling]),
      }),
  );
}

// Task 43: slate validation for the admin upload -- a separate function
// from loadEtrCsv itself (not folded into it) so every OTHER caller
// (tests, tools, the CLI's own load) keeps working against small/synthetic
// CSVs that were never meant to form a complete, roster-feasible lineup.
// Only the admin upload needs "is this actually a usable slate" rigor.
// Throws a SlateValidationError describing the first problem found (column
// shape before IDs before roster-slot feasibility -- parsing rows needs
// the columns to exist first); returns the parsed players + which column
// was used as the ID otherwise.
export class SlateValidationError extends Error {}

export interface SlateValidationResult {
  players: Player[];
  idColumn: string;
}

const REQUIRED_COLUMN_KEYS = ["name", "pos", "team", "opp", "salary", "proj", "ownSmall", "ownLarge", "floor", "ceiling"] as const;

export function validateSlateCsv(
  data: string,
  sport: SportConfig,
  columnMap: EtrColumnMap = ETR_COLUMN_MAP,
): SlateValidationResult {
  const parsed = parse<Record<string, string>>(data, { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields ?? [];

  const missingColumns = REQUIRED_COLUMN_KEYS.filter((key) => !fields.includes(columnMap[key]));
  if (missingColumns.length > 0) {
    throw new SlateValidationError(`Missing required column(s): ${missingColumns.map((key) => columnMap[key]).join(", ")}.`);
  }

  if (!fields.includes(columnMap.id) && !fields.includes("id")) {
    throw new SlateValidationError(`No ID column found (expected "${columnMap.id}" or "id").`);
  }
  const idColumn = resolveIdColumn(columnMap, fields);

  const rows = parsed.data;
  const missingIdCount = rows.filter((row) => (row[idColumn] ?? "").trim() === "").length;
  if (missingIdCount > 0) {
    throw new SlateValidationError(`${missingIdCount} player(s) are missing an ID value.`);
  }

  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const row of rows) {
    const id = row[idColumn];
    if (seenIds.has(id)) duplicateIds.add(id);
    seenIds.add(id);
  }
  if (duplicateIds.size > 0) {
    throw new SlateValidationError(`Duplicate ID(s): ${[...duplicateIds].join(", ")}.`);
  }

  const players = loadEtrCsv(data, columnMap);

  const shortSlots = sport.rosterSlots
    .map((slot) => ({
      slot,
      have: players.filter((p) => p.positions.some((pos) => slot.positions.has(pos.toUpperCase()))).length,
    }))
    .filter(({ slot, have }) => have < slot.count);
  if (shortSlots.length > 0) {
    const detail = shortSlots.map(({ slot, have }) => `${slot.name} (need ${slot.count}, have ${have})`).join(", ");
    throw new SlateValidationError(`Not enough players for slot(s): ${detail}.`);
  }

  return { players, idColumn };
}

const MOVE_NUMBER = /^\d+\.$/;

// "1. e4 e5 2. Nf3" -> ["e4", "e5", "Nf3"] -- drops the move-number tokens.
function parsePgnMoves(pgn: string): string[] {
  const trimmed = pgn.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/).filter((token) => !MOVE_NUMBER.test(token));
}

// Lichess chess-openings TSVs (eco, name, pgn columns) -> BookLine[].
// Source: github.com/lichess-org/chess-openings (CC0 1.0). Python's
// version takes a list of paths and opens each; this takes the already-
// read contents of each file instead.
export function loadOpeningBook(tsvContents: readonly string[]): BookLine[] {
  const lines: BookLine[] = [];
  for (const content of tsvContents) {
    const rows = parse<Record<string, string>>(content, {
      header: true,
      delimiter: "\t",
      skipEmptyLines: true,
    }).data;
    for (const row of rows) {
      lines.push(new BookLine({ eco: row.eco, name: row.name, moves: parsePgnMoves(row.pgn) }));
    }
  }
  return lines;
}

// data/openings/popularity.json's shape, produced by
// tools/fetch_popularity.py -- {"<moves joined by ' '>": {<next move SAN>:
// <game count>}}, one entry per position actually fetched. A position
// with no entry has no data (see openings.bookWeights).
export function loadPopularity(data: string): Record<string, Record<string, number>> {
  return JSON.parse(data) as Record<string, Record<string, number>>;
}

export interface LineStatsEntry {
  eco: string;
  name: string;
  moves: string[];
  games: number;
  white_rate: number;
  draw_rate: number;
  black_rate: number;
}

// data/openings/line_stats.json's "lines" array, produced by
// tools/count_popularity.py, verbatim -- the "_meta" key is dropped. See
// openings.rankFamilies (not yet ported).
export function loadLineStats(data: string): LineStatsEntry[] {
  return (JSON.parse(data) as { lines: LineStatsEntry[] }).lines;
}
