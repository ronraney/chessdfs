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

// Bug fix: a Vegas CSV exported with full team names ("Detroit Lions")
// instead of abbreviations ("DET") used to fail the off-slate-team check
// below outright -- the slate's own Team column is always an
// abbreviation (loadEtrCsv passes the ETR CSV's Team value through
// verbatim, never a full name), so a full name never matched. Ported in
// spirit from nfl-dfs's own readVegas()/normalizeTeamName_ (Team AND
// Opponent both normalized the same way there), but that function's real
// mapping table is sourced from a live Google Sheet (H26_Teams) this repo
// has no access to -- this table was built from the 32 real teams' current
// official full names, not copied from nfl-dfs's own source.
//
// Abbreviation set used: ARI, ATL, BAL, BUF, CAR, CHI, CIN, CLE, DAL, DEN,
// DET, GB, HOU, IND, JAX, KC, LAC, LAR, LV, MIA, MIN, NE, NO, NYG, NYJ,
// PHI, PIT, SEA, SF, TB, TEN, WAS. Cross-checked against every REAL team
// code this repo actually has on disk, not asserted from memory alone:
//   - data/samples/"NFL Weekly DFS System - Projections.csv" (22 teams)
//     and config/sports/nfl.json's dome_teams (adds ATL, DAL, LAR) confirm
//     ARI, ATL, CHI, CIN, CLE, DAL, DEN, DET, GB, HOU, IND, LAC, LAR, LV,
//     MIA, MIN, NE, NO, NYG, NYJ, PIT, SEA, SF, TEN, WAS exactly as above.
//   - data/samples/repro-slate.csv (a separate real fixture, 20 teams)
//     confirms BAL, BUF, CAR, KC, PHI, TB exactly as above -- but uses
//     "LA", not "LAR", for the Rams. FLAGGED, not silently resolved: this
//     table uses LAR (matching nfl.json's dome_teams, the more central
//     convention already relied on elsewhere) -- a slate loaded from
//     repro-slate.csv specifically would still reject "Los Angeles Rams"
//     as off-slate, since that slate's own Team column reads "LA".
//   - JAX (Jacksonville) never appears in ANY real file in this repo --
//     the one team code this table could NOT cross-check against real
//     data. Chose JAX (the current DK/NFL.com convention) over the older
//     "JAC" some other sources use; genuinely unconfirmed against an ETR
//     file either way.
const FULL_TEAM_NAME_TO_ABBREVIATION: Readonly<Record<string, string>> = {
  "arizona cardinals": "ARI",
  "atlanta falcons": "ATL",
  "baltimore ravens": "BAL",
  "buffalo bills": "BUF",
  "carolina panthers": "CAR",
  "chicago bears": "CHI",
  "cincinnati bengals": "CIN",
  "cleveland browns": "CLE",
  "dallas cowboys": "DAL",
  "denver broncos": "DEN",
  "detroit lions": "DET",
  "green bay packers": "GB",
  "houston texans": "HOU",
  "indianapolis colts": "IND",
  "jacksonville jaguars": "JAX",
  "kansas city chiefs": "KC",
  "los angeles chargers": "LAC",
  "los angeles rams": "LAR",
  "las vegas raiders": "LV",
  "miami dolphins": "MIA",
  "minnesota vikings": "MIN",
  "new england patriots": "NE",
  "new orleans saints": "NO",
  "new york giants": "NYG",
  "new york jets": "NYJ",
  "philadelphia eagles": "PHI",
  "pittsburgh steelers": "PIT",
  "seattle seahawks": "SEA",
  "san francisco 49ers": "SF",
  "tampa bay buccaneers": "TB",
  "tennessee titans": "TEN",
  "washington commanders": "WAS",
};

// Maps a full team name to its abbreviation; an already-abbreviated (or
// otherwise unrecognized) value passes through unchanged -- abbreviations
// keep working exactly as before, and a genuinely unknown name still
// fails the existing off-slate-team check below with the same message it
// always has, rather than this function inventing a second error path.
function normalizeTeamName(raw: string): string {
  const trimmed = raw.trim();
  return FULL_TEAM_NAME_TO_ABBREVIATION[trimmed.toLowerCase()] ?? trimmed;
}

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

  // Team and Opponent are both normalized before anything below reads
  // them -- a full team name in either column becomes its abbreviation
  // here, once, rather than needing every later check to know about it.
  const rows: Record<string, string>[] = parsed.data.map((row) => ({
    ...row,
    [columnMap.team]: normalizeTeamName(row[columnMap.team] ?? ""),
    [columnMap.opponent]: normalizeTeamName(row[columnMap.opponent] ?? ""),
  }));

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
