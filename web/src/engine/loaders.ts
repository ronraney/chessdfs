// ETR projections CSV -> Player[]. Ported from dfs_chess/loaders.py's
// load_etr_csv (and the salary/percent parsing it depends on) only -- the
// Lichess opening-book, popularity-snapshot, and line-stats loaders are
// all out of scope (they belong to openings, not yet ported; see this
// task's session log).
//
// The engine stays I/O-free: unlike Python's load_etr_csv(path), which
// opens the file itself, loadEtrCsv here takes the file's contents as a
// string -- same spirit as loadSportConfig/loadContestConfig taking
// already-parsed data instead of a path.

import { parse } from "papaparse";
import { Player } from "./models";

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
