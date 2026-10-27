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
//     "LA", not "LAR", for the Rams. This genuine real-data conflict is
//     what TEAM_ALIAS_GROUPS (below) resolves dynamically per slate,
//     rather than this table having to pick one winner.
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

// Teams whose abbreviation genuinely varies by source -- each inner array
// is the same real team under different codes, real conflicting data
// confirmed on disk in this repo (see the table's own comment above for
// the Rams' LA/LAR case). Resolved to whichever one THIS slate actually
// uses, not a fixed pick -- a slate never has both, so "whichever alias
// is present" is unambiguous. Only the one pair this task named, not a
// general "every team's every known alternate code" list.
const TEAM_ALIAS_GROUPS: readonly (readonly string[])[] = [["LA", "LAR"]];

// If `abbr` itself isn't on the slate but a KNOWN ALIAS of it is, returns
// that alias instead; otherwise returns `abbr` unchanged (including when
// neither it nor any alias is on the slate -- the off-slate-team check
// downstream is what reports that, not this function).
function resolveSlateAlias(abbr: string, slateTeams: ReadonlySet<string>): string {
  if (slateTeams.has(abbr)) return abbr;
  for (const group of TEAM_ALIAS_GROUPS) {
    if (!group.includes(abbr)) continue;
    const onSlate = group.find((alias) => slateTeams.has(alias));
    if (onSlate !== undefined) return onSlate;
  }
  return abbr;
}

// Maps a full team name to its abbreviation, then reconciles known
// abbreviation aliases (TEAM_ALIAS_GROUPS) against this slate's own
// convention. An already-abbreviated (or otherwise unrecognized) value
// with no alias match passes through unchanged -- abbreviations keep
// working exactly as before, and a genuinely unknown name still fails the
// off-slate-team handling below the same way it always has.
function normalizeTeamName(raw: string, slateTeams: ReadonlySet<string>): string {
  const trimmed = raw.trim();
  const mapped = FULL_TEAM_NAME_TO_ABBREVIATION[trimmed.toLowerCase()] ?? trimmed;
  return resolveSlateAlias(mapped, slateTeams);
}

export class VegasValidationError extends Error {}

export interface VegasValidationResult {
  vegas: SlateVegas;
  // Vegas rows for a team not on this slate -- skipped, not an error (a
  // full-week Vegas sheet routinely covers teams this slate isn't using).
  // A SLATE team with no Vegas row is the opposite situation and still a
  // hard error (see the throw below) -- these two checks are deliberately
  // asymmetric now, not two sides of the same rule.
  skippedTeams: readonly string[];
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

  // Team and Opponent are both normalized (full name -> abbreviation,
  // then slate-alias reconciliation) before anything below reads them.
  const normalizedRows: Record<string, string>[] = parsed.data.map((row) => ({
    ...row,
    [columnMap.team]: normalizeTeamName(row[columnMap.team] ?? "", slateTeams),
    [columnMap.opponent]: normalizeTeamName(row[columnMap.opponent] ?? "", slateTeams),
  }));

  const missingTeamCount = normalizedRows.filter((row) => (row[columnMap.team] ?? "").trim() === "").length;
  if (missingTeamCount > 0) {
    throw new VegasValidationError(`${missingTeamCount} row(s) are missing a Team value.`);
  }

  // Off-slate rows are dropped before any further check runs -- a row
  // we're about to discard shouldn't block the upload over its own data
  // quality (a duplicate or non-numeric value among teams we don't care
  // about here). skippedTeams is deduplicated and sorted for the caller's
  // own "Skipped N teams not on this slate: ..." note.
  const skippedTeams = [...new Set(normalizedRows.map((row) => row[columnMap.team].trim()).filter((team) => !slateTeams.has(team)))].sort();
  const rows = normalizedRows.filter((row) => slateTeams.has(row[columnMap.team].trim()));

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

  const vegas = new Map<string, GameVegas>();
  for (const row of rows) {
    const team = row[columnMap.team].trim();
    vegas.set(team, {
      total: Number(row[columnMap.overUnder]),
      spread: Number(row[columnMap.spread]),
    });
  }

  // Bug fix (behavior reversal, per this task's own explicit wording): a
  // slate team with no Vegas row used to be a non-fatal "missingTeams"
  // note (that team would just draw with neutral defaults). Now it's a
  // hard error instead -- paired with skippedTeams above, the new rule is
  // "every slate team needs real Vegas data; extra rows for teams the
  // slate isn't using are fine."
  const missingTeams = [...slateTeams].filter((team) => !vegas.has(team)).sort();
  if (missingTeams.length > 0) {
    throw new VegasValidationError(`No Vegas row for slate team(s): ${missingTeams.join(", ")}.`);
  }

  return { vegas, skippedTeams };
}

function isFiniteNumericString(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  return Number.isFinite(Number(raw));
}
