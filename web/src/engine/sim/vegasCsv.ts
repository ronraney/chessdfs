// Admin upload: parses + validates a Vegas CSV (one row per team --
// Rank, Team, Implied Total, Spread, O/U, Opponent -- mirroring nfl-dfs's
// own Vegas sheet exactly; see draws.ts's module header for the column
// meanings/units/sign convention) into the SlateVegas shape
// drawSlateOutcomes takes directly as its `games` argument. No I/O: takes
// the file's already-read text, like loadEtrCsv/validateSlateCsv do.
//
// Mirrors validateSlateCsv's own "first problem found" style (column
// shape, then per-row data problems) and throws its own error type
// (VegasValidationError) so the admin screen can show that message
// as-is, the same way it already does for SlateValidationError.
import { parse } from "papaparse";
import type { GameVegas, SlateVegas } from "./draws";

export const VEGAS_COLUMN_MAP = {
  rank: "Rank",
  team: "Team",
  impliedTotal: "Implied Total",
  spread: "Spread",
  overUnder: "O/U",
  opponent: "Opponent",
} as const;

export type VegasColumnMap = typeof VEGAS_COLUMN_MAP;

export class VegasValidationError extends Error {}

export interface VegasValidationResult {
  vegas: SlateVegas;
  // Slate teams with no Vegas row -- not a validation failure (that team
  // just draws with nfl-dfs's own neutral defaults), but worth surfacing.
  missingTeams: readonly string[];
}

const REQUIRED_COLUMN_KEYS = ["rank", "team", "impliedTotal", "spread", "overUnder", "opponent"] as const;
const NUMERIC_COLUMN_KEYS = ["rank", "impliedTotal", "spread", "overUnder"] as const;

export function validateVegasCsv(
  data: string,
  slateTeams: ReadonlySet<string>,
  columnMap: VegasColumnMap = VEGAS_COLUMN_MAP,
): VegasValidationResult {
  const parsed = parse<Record<string, string>>(data, { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields ?? [];

  const missingColumns = REQUIRED_COLUMN_KEYS.filter((key) => !fields.includes(columnMap[key]));
  if (missingColumns.length > 0) {
    throw new VegasValidationError(`Missing required column(s): ${missingColumns.map((key) => columnMap[key]).join(", ")}.`);
  }

  const rows = parsed.data;

  const missingTeamCount = rows.filter((row) => (row[columnMap.team] ?? "").trim() === "").length;
  if (missingTeamCount > 0) {
    throw new VegasValidationError(`${missingTeamCount} row(s) are missing a Team value.`);
  }

  const seenTeams = new Set<string>();
  const duplicateTeams = new Set<string>();
  for (const row of rows) {
    const team = row[columnMap.team].trim();
    if (seenTeams.has(team)) duplicateTeams.add(team);
    seenTeams.add(team);
  }
  if (duplicateTeams.size > 0) {
    throw new VegasValidationError(`Duplicate team row(s): ${[...duplicateTeams].join(", ")}.`);
  }

  for (const key of NUMERIC_COLUMN_KEYS) {
    const columnName = columnMap[key];
    const badTeams = rows.filter((row) => !isFiniteNumericString(row[columnName])).map((row) => row[columnMap.team].trim());
    if (badTeams.length > 0) {
      throw new VegasValidationError(`Non-numeric ${columnName} value for team(s): ${badTeams.join(", ")}.`);
    }
  }

  const offSlateTeams = rows.map((row) => row[columnMap.team].trim()).filter((team) => !slateTeams.has(team));
  if (offSlateTeams.length > 0) {
    throw new VegasValidationError(`Vegas row(s) for team(s) not on the loaded slate: ${offSlateTeams.join(", ")}.`);
  }

  const vegas = new Map<string, GameVegas>();
  for (const row of rows) {
    const team = row[columnMap.team].trim();
    vegas.set(team, {
      total: Number(row[columnMap.overUnder]),
      spread: Number(row[columnMap.spread]),
    });
  }

  const missingTeams = [...slateTeams].filter((team) => !vegas.has(team)).sort();

  return { vegas, missingTeams };
}

function isFiniteNumericString(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  return Number.isFinite(Number(raw));
}
