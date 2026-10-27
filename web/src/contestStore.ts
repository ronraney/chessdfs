// Browser-storage home for the admin-uploaded contest CSV, mirroring
// vegasStore.ts/projectionsStore.ts exactly. Raw CSV text is what's
// stored (not the parsed ContestPreset[]) -- validateContestCsv is run
// fresh wherever the text is read, same reasoning as those stores' own
// comments.
const STORAGE_KEY = "chess-dfs:contests-csv";

export function getSavedContestsCsv(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
}

export function saveContestsCsv(csvText: string): void {
  window.localStorage.setItem(STORAGE_KEY, csvText);
}

export function clearContestsCsv(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
