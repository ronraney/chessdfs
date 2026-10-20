// Browser-storage home for the admin-uploaded Vegas CSV, mirroring
// projectionsStore.ts exactly. Raw CSV text is what's stored (not the
// parsed SlateVegas) -- validateVegasCsv is run fresh wherever the text
// is read, same reasoning as projectionsStore's own comment.
const STORAGE_KEY = "chess-dfs:vegas-csv";

export function getSavedVegasCsv(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
}

export function saveVegasCsv(csvText: string): void {
  window.localStorage.setItem(STORAGE_KEY, csvText);
}

export function clearVegasCsv(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
