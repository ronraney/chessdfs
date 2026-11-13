// "DraftKings upload CSV" task: builds the CSV DraftKings' own lineup-
// upload tool expects -- one column per roster-slot instance (NFL's own
// roster_slots expand to QB, RB, RB, WR, WR, WR, TE, FLEX, DST), one row
// per selected full lineup, each cell "Name (DK ID)" e.g.
// "Bijan Robinson (44850860)". Pure formatting only; the actual file
// download, selection checkboxes, and the DK-ID-column availability
// check (engine/loaders.detectIdColumn) all live in SavedLineupsScreen.tsx
// -- same "I/O lives at the UI layer" split every other *Store.ts/*.ts
// helper here already follows.
import type { Player } from "./engine/models";
import type { SportConfig } from "./engine/sport";
import type { SavedLineup, SavedLineupPlayer } from "./savedLineupsStore";

// The CSV header, and every data row's own column order -- "Use the
// on-screen slot assignment everywhere" task: this is exactly
// `rosterSlots`' own expansion order (engine/rules.ts's old
// assignRosterSlots, SideColumn/FinishCard's own grid, and
// slotNamesForEntries's own placement all already walk slots in this
// same definition order), not a hardcoded NFL-specific literal.
export function dkCsvHeader(sport: SportConfig): string[] {
  return sport.rosterSlots.flatMap((slot) => Array<string>(slot.count).fill(slot.name));
}

// DK IDs are re-derived fresh from whatever's CURRENTLY loaded, never
// read back off anything stored on the saved record itself -- the same
// real player's own DK_ID can change from one slate/week to the next, so
// a saved lineup (a snapshot of name/pos/team/salary/etc. at save time)
// was never going to carry a still-valid ID forward anyway. Matched by
// name + team (not name alone) so two same-named players on different
// teams don't collide.
function findCurrentPlayer(saved: SavedLineupPlayer, currentPlayers: readonly Player[]): Player | undefined {
  return currentPlayers.find((p) => p.name === saved.name && p.team === saved.team);
}

// Quotes a cell only if it actually needs it (contains a comma, quote,
// or newline) -- DK player names are plain ("Bijan Robinson"), this is
// cheap insurance against a future one that isn't.
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface SkippedLineup {
  readonly lineup: SavedLineup;
  readonly reason: string;
}

export interface DkExportResult {
  readonly csv: string; // header row only ("") if nothing was exportable
  readonly exportedCount: number;
  readonly skipped: readonly SkippedLineup[];
}

// Builds the full CSV for every one of `lineups` (already filtered down
// to the user's own selection) against `currentPlayers` (the CURRENTLY
// loaded projections slate). A lineup is skipped -- not exported, listed
// in `skipped` with why -- the moment any one of its players can't be
// found in `currentPlayers` (an old slate no longer carrying them) or
// has no player at all recorded for some header slot (defensive only:
// every full 9/9 lineup saved by this app's own Save-lineup flow always
// has exactly one player per header slot by construction -- see
// lineupSlots.ts's own header comment for why -- this only guards a
// corrupted/hand-edited import).
export function buildDkCsv(lineups: readonly SavedLineup[], currentPlayers: readonly Player[], sport: SportConfig): DkExportResult {
  const header = dkCsvHeader(sport);
  const rows: string[] = [header.join(",")];
  const skipped: SkippedLineup[] = [];

  for (const lineup of lineups) {
    const usedBySlot = new Map<string, number>();
    const cells: string[] = [];
    let reason: string | null = null;

    for (const slotName of header) {
      const idx = usedBySlot.get(slotName) ?? 0;
      usedBySlot.set(slotName, idx + 1);
      const savedPlayer = lineup.players.filter((p) => p.slot === slotName)[idx];
      if (savedPlayer === undefined) {
        reason = `no player assigned to ${slotName}`;
        break;
      }
      const current = findCurrentPlayer(savedPlayer, currentPlayers);
      if (current === undefined) {
        reason = `${savedPlayer.name} is not in the current projections`;
        break;
      }
      cells.push(csvCell(`${savedPlayer.name} (${current.id})`));
    }

    if (reason !== null) {
      skipped.push({ lineup, reason });
      continue;
    }
    rows.push(cells.join(","));
  }

  return { csv: rows.join("\n"), exportedCount: rows.length - 1, skipped };
}
