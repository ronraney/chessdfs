// Browser-storage home for the Finish screen's "Save lineup" button and
// the "Saved lineups" screen that lists/exports/imports them -- same
// localStorage-under-one-key shape as contestStore.ts/vegasStore.ts/
// projectionsStore.ts/fieldCacheStore.ts. Everything lives under
// STORAGE_KEY as one JSON array; survives a page refresh or a full browser
// restart, same as every other *Store.ts here. What WOULD wipe it: the
// user (or an extension) clearing this origin's site data/cookies, a
// private/incognito window closing, or the browser evicting storage under
// disk pressure (requestPersistentStorageOnce below asks it not to do that
// last one -- best-effort only, see its own comment).
import type { KingMode } from "./engine/models";

export interface SavedLineupPlayer {
  readonly slot: string;
  readonly piece: string; // RosterEntry.label: a real piece name ("Pawn", "Queen", ...) or the optimizer marker
  readonly optimizer: boolean; // true when `piece` is the optimizer marker -- explicit flag per this task's own spec
  readonly name: string;
  readonly pos: string;
  readonly team: string;
  readonly salary: number;
  readonly projection: number;
  readonly ownership: number; // fraction 0..1, Player.ownFor(contest.fieldTier())
}

export interface SavedLineupSim {
  readonly cashRate: number;
  readonly bottom99Roi: number;
  readonly top1PctScoreRoi: number;
  readonly top1PctRate: number;
  readonly roi: number;
  readonly isBestFinish: boolean;
  readonly buildSeed: number;
  readonly simSeed: number;
}

export interface SavedLineupTotals {
  readonly salaryUsed: number;
  readonly salaryRemaining: number;
  readonly projection: number;
  readonly ownership: number; // fraction 0..1
}

// Everything the Finish screen knows about a build except WHEN it was
// saved and what row it ended up as -- those two (savedAt/id) are added by
// saveLineup itself, below. contentKey is derived from exactly this shape
// (see saveLineup) -- two saves of the same unchanged build always hash to
// the same key, which is what makes "save it twice" a no-op rather than a
// duplicate row.
export interface SavedLineupInput {
  readonly contestName: string;
  readonly kingMode: KingMode;
  readonly chosenOpening: string;
  readonly finalOpening: string;
  readonly moves: readonly string[];
  readonly players: readonly SavedLineupPlayer[];
  readonly totals: SavedLineupTotals;
  readonly whiteSim: SavedLineupSim | null;
  readonly blackSim: SavedLineupSim | null;
}

export interface SavedLineup extends SavedLineupInput {
  readonly id: string;
  readonly savedAt: string; // ISO timestamp
  readonly contentKey: string;
}

const STORAGE_KEY = "chess-dfs:saved-lineups";
const PERSIST_REQUESTED_KEY = "chess-dfs:storage-persist-requested";

function readAll(): SavedLineup[] {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedLineup[]) : [];
  } catch {
    return [];
  }
}

function writeAll(lineups: readonly SavedLineup[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lineups));
}

// Newest first, by savedAt (an ISO timestamp -- plain string comparison
// sorts it correctly).
export function getSavedLineups(): SavedLineup[] {
  return [...readAll()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// Asks the browser not to evict this origin's storage under disk pressure
// -- fired once, ever (PERSIST_REQUESTED_KEY guards every call after the
// first real one, across reloads too, so a user who saves ten lineups
// only ever triggers this the first time). Fire-and-forget from
// saveLineup's own call site: this is a best-effort heuristic grant (the
// browser decides based on site engagement, bookmarks, etc. -- there's no
// user-facing prompt to wait on), so it never blocks or alters the save
// itself, and nothing is shown to the user either way, granted or denied.
async function requestPersistentStorageOnce(): Promise<void> {
  if (window.localStorage.getItem(PERSIST_REQUESTED_KEY) !== null) return;
  window.localStorage.setItem(PERSIST_REQUESTED_KEY, "1");
  if (typeof navigator === "undefined" || !("storage" in navigator) || typeof navigator.storage?.persist !== "function") return;
  try {
    await navigator.storage.persist();
  } catch {
    // Best-effort only -- see this function's own comment.
  }
}

function generateId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface SaveLineupResult {
  readonly lineup: SavedLineup;
  readonly isNew: boolean; // false if an identical build was already saved -- see contentKey below
}

// `contentKey` is just the input's own canonical JSON text (every field
// except id/savedAt/contentKey itself) -- cheap, collision-free, and exact:
// two calls with the same build (same contest/King mode/openings/moves/
// roster/totals/sim stats) always produce the identical string, which is
// all "saving the same build twice must not create a duplicate" needs.
// `input` is always built the same way, field-by-field, by the one real
// caller (FinishCard's handleSaveLineup) -- so key ORDER (which
// JSON.stringify is sensitive to) never drifts between two saves of what
// is, semantically, the same build.
export function saveLineup(input: SavedLineupInput): SaveLineupResult {
  void requestPersistentStorageOnce();
  const contentKey = JSON.stringify(input);
  const existing = readAll();
  const match = existing.find((lineup) => lineup.contentKey === contentKey);
  if (match !== undefined) return { lineup: match, isNew: false };

  const lineup: SavedLineup = { ...input, id: generateId(), savedAt: new Date().toISOString(), contentKey };
  writeAll([...existing, lineup]);
  return { lineup, isNew: true };
}

export function deleteLineup(id: string): void {
  writeAll(readAll().filter((lineup) => lineup.id !== id));
}

// "Download all (backup)" -- every saved lineup, newest first, as one
// JSON file's worth of text. The caller (SavedLineupsScreen) turns this
// into an actual file download; this function stays pure (no Blob/
// anchor/DOM), same "I/O lives at the UI layer" split every other
// *Store.ts here already follows.
export function exportLineupsJson(): string {
  return JSON.stringify(getSavedLineups(), null, 2);
}

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
}

function isSavedLineup(value: unknown): value is SavedLineup {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SavedLineup>;
  return typeof v.id === "string" && typeof v.savedAt === "string" && typeof v.contentKey === "string";
}

// Loads an exportLineupsJson() file back in -- anything whose contentKey
// already matches a lineup already saved here is skipped (by CONTENT, not
// id, so re-importing the same backup twice, or importing a backup that
// overlaps what's already here from a prior import or a fresh Save
// lineup, never duplicates). Throws if `jsonText` isn't a JSON array at
// all (not this file's own export format); an array entry that doesn't
// look like a SavedLineup is just skipped rather than throwing, same
// "defensive only" precedent fieldCacheStore.resolveCachedField's own
// stale-id handling uses.
export function importLineupsJson(jsonText: string): ImportResult {
  const parsed: unknown = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) throw new Error("Not a saved-lineups export file.");

  const existing = readAll();
  const seenKeys = new Set(existing.map((lineup) => lineup.contentKey));
  const toAdd: SavedLineup[] = [];
  let skipped = 0;
  for (const item of parsed) {
    if (!isSavedLineup(item)) continue;
    if (seenKeys.has(item.contentKey)) {
      skipped++;
      continue;
    }
    seenKeys.add(item.contentKey);
    toAdd.push(item);
  }
  if (toAdd.length > 0) writeAll([...existing, ...toAdd]);
  return { imported: toAdd.length, skipped };
}
