// Task 35: browser-storage home for the admin-uploaded projections CSV, so
// the player flow (contest -> King mode -> opening) can read a slate the
// admin saved in an earlier visit, surviving reloads. Raw CSV text is what's
// stored (not parsed Player[]) -- loadEtrCsv (the engine's own loader) is
// run fresh wherever the text is read, so there's exactly one parse path for
// both the admin's "N players loaded" count and the player screens' data.
const STORAGE_KEY = "chess-dfs:projections-csv";

export function getSavedProjectionsCsv(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
}

export function saveProjectionsCsv(csvText: string): void {
  window.localStorage.setItem(STORAGE_KEY, csvText);
}

export function clearProjectionsCsv(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
