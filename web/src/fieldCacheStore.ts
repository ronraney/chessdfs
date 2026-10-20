// Browser-storage home for Admin's pre-built simulated fields (follow-up
// to Sim 2's field generator, engine/sim/field.ts): one cached field per
// (slate, tier), so a build never has to pay generateSimulatedField's own
// per-attempt MILP cost on the main thread -- see fieldWorker.ts, which
// actually runs the build and writes the result here.
//
// Only player IDs are cached (not full Player objects, and not
// lineupWeight): a cached field is tier-scoped, shared by any contest
// whose fieldTier() matches, so lineupWeight (contest.fieldSize /
// lineups.length) has to stay specific to whichever REAL contest a build
// is reading the cache for -- resolveCachedField below recomputes it at
// read time rather than trusting a baked-in number from whatever
// placeholder fieldSize Admin's own build used to pick whichever tier it
// was building (see fieldWorker.ts's own comment on that placeholder).
import type { ContestConfig } from "./engine/config";
import type { FieldTier, Player } from "./engine/models";
import type { SimulatedField } from "./engine/sim/field";

const STORAGE_PREFIX = "chess-dfs:field-cache:";

export const NO_FIELD_CACHED_MESSAGE = "Build fields in Admin first.";

// A cheap, non-cryptographic hash (FNV-1a) of the saved projections CSV
// text -- not a security primitive, just a short cache-key fragment so a
// field built for one slate is never read back for a different one
// (belt-and-suspenders: handleUpload/handleClear already clear the whole
// cache on any new projections save, see AdminScreen.tsx).
export function slateSignature(csvText: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < csvText.length; i++) {
    hash ^= csvText.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function storageKey(signature: string, tier: FieldTier): string {
  return `${STORAGE_PREFIX}${signature}:${tier}`;
}

export function getCachedFieldIds(signature: string, tier: FieldTier): readonly (readonly string[])[] | null {
  const raw = window.localStorage.getItem(storageKey(signature, tier));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as readonly (readonly string[])[];
  } catch {
    return null;
  }
}

export function saveCachedFieldIds(signature: string, tier: FieldTier, lineupIds: readonly (readonly string[])[]): void {
  window.localStorage.setItem(storageKey(signature, tier), JSON.stringify(lineupIds));
}

// Clears every cached field, for every tier and every slate signature --
// called whenever new projections are saved or cleared (AdminScreen.tsx):
// a new (or removed) slate invalidates whatever was built against the old
// one, and since there's only ever one admin-saved slate at a time, there
// is no "other slate's cache" worth preserving.
export function clearFieldCache(): void {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key !== null && key.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) window.localStorage.removeItem(key);
}

// Resolves the cached field for `contest`'s own tier against `players`
// (whichever slate the build currently has loaded) -- null if nothing's
// cached for this signature+tier yet (caller shows NO_FIELD_CACHED_MESSAGE).
// A cached id with no matching player (stale cache against a changed
// slate that somehow wasn't cleared) is silently dropped from its lineup
// rather than thrown -- defensive only; the normal path is always a clear
// on upload, never a partial mismatch.
export function resolveCachedField(signature: string, contest: ContestConfig, players: readonly Player[]): SimulatedField | null {
  const lineupIds = getCachedFieldIds(signature, contest.fieldTier());
  if (lineupIds === null) return null;
  const byId = new Map(players.map((p) => [p.id, p]));
  const lineups = lineupIds.map((ids) => ids.map((id) => byId.get(id)).filter((p): p is Player => p !== undefined));
  return { lineups, lineupWeight: contest.fieldSize / Math.max(lineups.length, 1) };
}
