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
} as const;

export type EtrColumnMap = typeof ETR_COLUMN_MAP;

function parseSalary(raw: string): number {
  return parseInt(raw.replace(/\$/g, "").replace(/,/g, ""), 10);
}

// "40.20%" -> 0.402 (stored as a 0-1 fraction; shown as a percent in the UI).
function parsePercent(raw: string): number {
  return parseFloat(raw.replace(/%+$/, "")) / 100;
}

export function loadEtrCsv(data: string, columnMap: EtrColumnMap = ETR_COLUMN_MAP): Player[] {
  const rows = parse<Record<string, string>>(data, { header: true, skipEmptyLines: true }).data;
  return rows.map(
    (row) =>
      new Player({
        id: row[columnMap.id],
        name: row[columnMap.name].trim(),
        positions: [row[columnMap.pos]],
        team: row[columnMap.team],
        opp: row[columnMap.opp],
        salary: parseSalary(row[columnMap.salary]),
        proj: parseFloat(row[columnMap.proj]),
        ownSmall: parsePercent(row[columnMap.ownSmall]),
        ownLarge: parsePercent(row[columnMap.ownLarge]),
      }),
  );
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
