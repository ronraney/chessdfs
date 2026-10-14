// Task 37: the build screen's per-side stats and pick-modal eligibility --
// UI-layer composition of already-exported engine primitives, porting the
// same formulas dfs_chess/cli.py's _eligible_sorted/_side_stats use (no
// Python equivalent of this file itself; same spirit as appData.ts's own
// UI-layer joins). No new engine rules: salary/ownership/projection are
// plain sums, "open slots" is rules.openRosterSlots, eligibility is
// pieces.classify + BuildState.lockedPlayerIds.
import type { Piece } from "./engine/models";
import type { ContestConfig } from "./engine/config";
import type { Player } from "./engine/models";
import { classify } from "./engine/pieces";
import { openRosterSlots } from "./engine/rules";
import type { SportConfig } from "./engine/sport";

// Task 38b: a piece band's own position(s)/salary range, read off `sport`
// (e.g. "WR · $5,000–6,999", "$7,000+" for Queen, which has no position
// restriction) -- the pick modal's subtitle and the build screen's "Book
// continues" entries both describe the same band, so the formatting lives
// here once. `maxSalary` is exclusive (PieceBand.matches: `salary <
// maxSalary`), hence the -1 on the displayed upper bound. Null if `sport`
// has no band at all for `piece` (shouldn't happen for a real sport config
// -- see pieces.classify's own comment -- but this stays a plain lookup,
// not an assumption).
export function pieceBandLabel(piece: Piece, sport: SportConfig): string | null {
  const band = sport.pieceBands.find((b) => b.piece === piece);
  if (band === undefined) return null;
  const parts: string[] = [];
  if (band.positions !== null) parts.push([...band.positions].join("/"));
  if (band.minSalary !== null && band.maxSalary !== null) {
    parts.push(`$${band.minSalary.toLocaleString()}–${(band.maxSalary - 1).toLocaleString()}`);
  } else if (band.minSalary !== null) {
    parts.push(`$${band.minSalary.toLocaleString()}+`);
  } else if (band.maxSalary !== null) {
    parts.push(`up to $${(band.maxSalary - 1).toLocaleString()}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface SideStats {
  salaryRemaining: number;
  openSlots: Readonly<Record<string, number>>;
  openSlotCount: number;
  avgRemainingPerOpenSlot: number;
  projTotal: number;
  ownershipTotal: number;
}

// cli.py's _side_stats: remaining salary, avg remaining per still-open
// roster slot (0 if none are open), core projection total, core ownership
// sum -- for `players` (one side's locked roster so far, or that roster
// plus a hypothetical one-more candidate, for the pick modal's "after this
// pick" preview).
export function sideStats(players: readonly Player[], sport: SportConfig, contest: ContestConfig): SideStats {
  const spent = players.reduce((sum, p) => sum + p.salary, 0);
  const salaryRemaining = contest.effectiveCap(sport) - spent;
  const openSlots = openRosterSlots(players, sport.rosterSlots);
  const openSlotCount = Object.values(openSlots).reduce((a, b) => a + b, 0);
  const avgRemainingPerOpenSlot = openSlotCount > 0 ? salaryRemaining / openSlotCount : 0;
  const tier = contest.fieldTier();
  const ownershipTotal = players.reduce((sum, p) => sum + p.ownFor(tier), 0);
  const projTotal = players.reduce((sum, p) => sum + p.proj, 0);
  return { salaryRemaining, openSlots, openSlotCount, avgRemainingPerOpenSlot, projTotal, ownershipTotal };
}

// cli.py's _eligible_sorted: every unlocked player classifying as `piece`,
// sorted by projection descending -- the pick modal's own candidate list.
// Deliberately not pre-filtered by isLegalMove/lineupStillCompletable (same
// as the CLI precedent): an infeasible pick is rejected when actually
// applied, not hidden from the list beforehand.
export function eligiblePlayers(
  piece: Piece,
  lockedPlayerIds: ReadonlySet<string>,
  playersPool: readonly Player[],
  sport: SportConfig,
): Player[] {
  return playersPool
    .filter((p) => !lockedPlayerIds.has(p.id) && classify(p, sport) === piece)
    .sort((a, b) => b.proj - a.proj);
}
