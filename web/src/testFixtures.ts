// Shared sample-CSV fixture for App.test.tsx and AdminScreen.test.tsx --
// Task 35 split the old upload step across both of those files, so both
// need the same sample projections file and a File object built from it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV_PATH = path.join(dirname, "data", "samples", "NFL Weekly DFS System - Projections.csv");

export const SAMPLE_CSV = readFileSync(SAMPLE_CSV_PATH, "utf-8");

export function sampleCsvFile(): File {
  return new File([SAMPLE_CSV], "projections.csv", { type: "text/csv" });
}
