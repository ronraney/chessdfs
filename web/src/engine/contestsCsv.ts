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

export function validateContestCsv(data: string, columnMap: ContestColumnMap = CONTEST_COLUMN_MAP): ContestPreset[] {
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
  const presets: ContestPreset[] = [];
  for (const row of rows) {
    const name = row[columnMap.name].trim();
    try {
      const payouts = generatePayoutCurve(
        Number(row[columnMap.totalPrizePool]),
        Number(row[columnMap.pctToFirst]),
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

  return presets;
}

function isFiniteNumericString(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  return Number.isFinite(Number(raw));
}
