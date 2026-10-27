// Admin upload: parses + validates a contest CSV (one row per contest --
// Contest_Name, Entry_Fee, Total_Entrants, Total_Prize_Pool, Pct_To_First,
// Min_Cash_Amount, Cash_Line_Position, Max_Entries_Per_User, Contest_Type
// -- mirroring the Sim_Contest sheet this repo already vendors a sample
// of) into ContestPreset[], the same shape loadContestPresets builds from
// contests.json. No I/O: takes the file's already-read text, like
// loadEtrCsv/validateSlateCsv/validateVegasCsv do.
//
// Mirrors vegasCsv.ts's own "first problem found" style (column shape,
// then per-row data problems, then the one check that needs every row's
// numbers at once) and throws its own error type (ContestValidationError)
// so the admin screen can show that message as-is.
import { parse } from "papaparse";
import { loadContestConfig, type ContestPreset } from "./config";
import { generatePayoutCurve } from "./sim/payouts";

export const CONTEST_COLUMN_MAP = {
  name: "Contest_Name",
  entryFee: "Entry_Fee",
  totalEntrants: "Total_Entrants",
  totalPrizePool: "Total_Prize_Pool",
  pctToFirst: "Pct_To_First",
  minCashAmount: "Min_Cash_Amount",
  cashLinePosition: "Cash_Line_Position",
  maxEntriesPerUser: "Max_Entries_Per_User",
  contestType: "Contest_Type",
} as const;

export type ContestColumnMap = typeof CONTEST_COLUMN_MAP;

export class ContestValidationError extends Error {}

const REQUIRED_COLUMN_KEYS = [
  "name",
  "entryFee",
  "totalEntrants",
  "totalPrizePool",
  "pctToFirst",
  "minCashAmount",
  "cashLinePosition",
  "maxEntriesPerUser",
  "contestType",
] as const;

// Contest_Name/Contest_Type are free text -- every other required column
// is a number.
const NUMERIC_COLUMN_KEYS = [
  "entryFee",
  "totalEntrants",
  "totalPrizePool",
  "pctToFirst",
  "minCashAmount",
  "cashLinePosition",
  "maxEntriesPerUser",
] as const;

export interface ContestCsvValidationResult {
  presets: ContestPreset[];
  // Rows whose Pct_To_First was > 1 -- a dollar amount (some real
  // exports use this for cash-game-style contests) rather than the (0,1]
  // fraction every other row uses -- converted here by dividing by that
  // row's own Total_Prize_Pool before the payout curve ever sees it.
  dollarPctToFirstNames: readonly string[];
}

export function validateContestCsv(data: string, columnMap: ContestColumnMap = CONTEST_COLUMN_MAP): ContestCsvValidationResult {
  const parsed = parse<Record<string, string>>(data, { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields ?? [];

  const missingColumns = REQUIRED_COLUMN_KEYS.filter((key) => !fields.includes(columnMap[key]));
  if (missingColumns.length > 0) {
    throw new ContestValidationError(`Missing required column(s): ${missingColumns.map((key) => columnMap[key]).join(", ")}.`);
  }

  const rows = parsed.data;

  for (const key of NUMERIC_COLUMN_KEYS) {
    const columnName = columnMap[key];
    const badNames = rows.filter((row) => !isFiniteNumericString(row[columnName])).map((row) => (row[columnMap.name] ?? "").trim());
    if (badNames.length > 0) {
      throw new ContestValidationError(`Non-numeric ${columnName} value for contest(s): ${badNames.join(", ")}.`);
    }
  }

  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const row of rows) {
    const name = row[columnMap.name].trim();
    if (seenNames.has(name)) duplicateNames.add(name);
    seenNames.add(name);
  }
  if (duplicateNames.size > 0) {
    throw new ContestValidationError(`Duplicate contest name(s): ${[...duplicateNames].join(", ")}.`);
  }

  const rejectedNames: string[] = [];
  const dollarPctToFirstNames: string[] = [];
  const presets: ContestPreset[] = [];
  for (const row of rows) {
    const name = row[columnMap.name].trim();
    const totalPrizePool = Number(row[columnMap.totalPrizePool]);
    const rawPctToFirst = Number(row[columnMap.pctToFirst]);
    // > 1 can't be a (0,1] fraction -- it's the 1st-place dollar amount
    // instead (some real cash-game-style rows export it that way); every
    // other row's value is already a fraction, left as-is.
    const pctToFirst = rawPctToFirst > 1 ? rawPctToFirst / totalPrizePool : rawPctToFirst;
    if (rawPctToFirst > 1) dollarPctToFirstNames.push(name);
    try {
      const payouts = generatePayoutCurve(
        totalPrizePool,
        pctToFirst,
        Number(row[columnMap.minCashAmount]),
        Number(row[columnMap.cashLinePosition]),
      );
      presets.push({
        name,
        buyIn: Number(row[columnMap.entryFee]),
        contest: loadContestConfig({ field_size: Number(row[columnMap.totalEntrants]), payouts }),
      });
    } catch {
      rejectedNames.push(name);
    }
  }
  if (rejectedNames.length > 0) {
    throw new ContestValidationError(`Payout curve rejected contest(s): ${rejectedNames.join(", ")}.`);
  }

  return { presets, dollarPctToFirstNames };
}

function isFiniteNumericString(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  return Number.isFinite(Number(raw));
}
