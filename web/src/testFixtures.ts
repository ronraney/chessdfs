// Shared sample-CSV fixture for App.test.tsx and AdminScreen.test.tsx --
// Task 35 split the old upload step across both of those files, so both
// need the same sample projections file and a File object built from it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV_PATH = path.join(dirname, "data", "samples", "NFL Weekly DFS System - Projections.csv");
const SAMPLE_CONTEST_CSV_PATH = path.join(dirname, "data", "samples", "NFL Weekly DFS System - Sim_Contest.csv");

export const SAMPLE_CSV = readFileSync(SAMPLE_CSV_PATH, "utf-8");

export function sampleCsvFile(): File {
  return new File([SAMPLE_CSV], "projections.csv", { type: "text/csv" });
}

// The real Sim_Contest sample -- 18 GPP rows + H2H + "NFL GIANT $25
// Double-Up". Its own numbers (Pct_To_First=50, a plain dollar figure
// rather than a (0,1] fraction) make Double-Up's payout curve
// unbuildable (see engine/contestsCsv.test.ts), so SAMPLE_CONTEST_CSV is
// used for the rejection path and VALID_CONTEST_CSV (the same file minus
// that one row) for the success path -- both genuinely this file's own
// data, not synthesized.
export const SAMPLE_CONTEST_CSV = readFileSync(SAMPLE_CONTEST_CSV_PATH, "utf-8");

export const VALID_CONTEST_CSV = SAMPLE_CONTEST_CSV.split("\n")
  .filter((line) => !line.includes("Double-Up"))
  .join("\n");

export function sampleContestCsvFile(text: string = SAMPLE_CONTEST_CSV): File {
  return new File([text], "contests.csv", { type: "text/csv" });
}
