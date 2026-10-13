// Legality rules: roster/salary completability. Ported from
// dfs_chess/rules.py -- max_assignable, lineup_still_completable,
// is_lineup_complete, and open_roster_slots only (the rest of rules.py
// needs ContestConfig and chess.js move-legality wiring not yet ported;
// see Task 23's session log for the exact deferral list).
//
// Roster shape (slots, eligible positions, salary cap) comes from a
// SportConfig, not from constants here, per RULES.md "Multi-sport ready".

import type { Player } from "./models";
import type { RosterSlot, SportConfig } from "./sport";

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

// Max number of `players` that can be simultaneously placed into distinct
// roster slot instances they're eligible for (each slot's `count` expands
// into that many interchangeable instances). A maximum bipartite matching
// (Kuhn's algorithm) -- small enough (<=9 a side) that a plain
// augmenting-path search is fine. If this comes back under `players.length`,
// no later pick can ever complete the roster.
export function maxAssignable(players: readonly Player[], rosterSlots: readonly RosterSlot[]): number {
  const instancePositions: ReadonlySet<string>[] = [];
  for (const slot of rosterSlots) {
    for (let i = 0; i < slot.count; i++) {
      instancePositions.push(slot.positions);
    }
  }

  const occupant: (number | null)[] = new Array(instancePositions.length).fill(null);

  function augment(playerIdx: number, visited: Set<number>): boolean {
    const eligiblePositions = new Set(players[playerIdx].positions.map((p) => p.toUpperCase()));
    for (let slotIdx = 0; slotIdx < instancePositions.length; slotIdx++) {
      if (visited.has(slotIdx) || !intersects(instancePositions[slotIdx], eligiblePositions)) continue;
      visited.add(slotIdx);
      const current = occupant[slotIdx];
      if (current === null || augment(current, visited)) {
        occupant[slotIdx] = playerIdx;
        return true;
      }
    }
    return false;
  }

  let count = 0;
  for (let i = 0; i < players.length; i++) {
    if (augment(i, new Set())) count++;
  }
  return count;
}

// Whether `players` -- one side's locked roster so far -- could still be
// completed into a legal lineup for `sport` within `cap`. Only checks for
// overflow a later pick could never undo; it does not require minimums
// yet, since the roster is still incomplete.
export function lineupStillCompletable(players: readonly Player[], sport: SportConfig, cap: number): boolean {
  if (players.length > sport.rosterSize) return false;
  if (players.reduce((sum, p) => sum + p.salary, 0) > cap) return false;
  if (maxAssignable(players, sport.rosterSlots) < players.length) return false;
  return true;
}

// Whether `players` is a full, legal lineup for `sport` -- exactly
// rosterSize players, every one of them placeable into a distinct roster
// slot. (Salary cap isn't part of "complete" -- a side can finish under
// budget.)
export function isLineupComplete(players: readonly Player[], sport: SportConfig): boolean {
  return players.length === sport.rosterSize && maxAssignable(players, sport.rosterSlots) === sport.rosterSize;
}

// How many instances of each roster slot in `rosterSlots` are NOT filled by
// `players`, via the same maximum bipartite matching maxAssignable uses --
// {} if every slot is filled.
export function openRosterSlots(
  players: readonly Player[],
  rosterSlots: readonly RosterSlot[],
): Record<string, number> {
  const instances: RosterSlot[] = [];
  for (const slot of rosterSlots) {
    for (let i = 0; i < slot.count; i++) {
      instances.push(slot);
    }
  }
  const occupant: (number | null)[] = new Array(instances.length).fill(null);

  function augment(playerIdx: number, visited: Set<number>): boolean {
    const positions = new Set(players[playerIdx].positions.map((p) => p.toUpperCase()));
    for (let idx = 0; idx < instances.length; idx++) {
      if (visited.has(idx) || !intersects(instances[idx].positions, positions)) continue;
      visited.add(idx);
      const current = occupant[idx];
      if (current === null || augment(current, visited)) {
        occupant[idx] = playerIdx;
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < players.length; i++) {
    augment(i, new Set());
  }

  const openCounts: Record<string, number> = {};
  instances.forEach((slot, idx) => {
    if (occupant[idx] === null) {
      openCounts[slot.name] = (openCounts[slot.name] ?? 0) + 1;
    }
  });
  return openCounts;
}
