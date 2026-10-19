// Task 37: the build screen's per-side stats -- UI-layer composition of
// already-exported engine primitives, porting the same formulas
// dfs_chess/cli.py's _side_stats uses (no Python equivalent of this file
// itself; same spirit as appData.ts's own UI-layer joins). No new engine
// rules: salary/ownership/projection are plain sums, "open slots" is
// rules.openRosterSlots. The pick modal's own candidate list is
// engine/picklist.ts's pickList/castleQbCandidates (RULES.md piece table),
// not this file -- "eligible, sorted by projection" stopped being the
// whole story once each piece got its own sort metric and list cap.
import type { Piece } from "./engine/models";
import type { ContestConfig } from "./engine/config";
import type { Player } from "./engine/models";
import { maxAssignable, openRosterSlots } from "./engine/rules";
import type { PieceBand, SportConfig } from "./engine/sport";

// Task 38b: a piece band's own position(s)/salary range, read off `sport`
// (e.g. "TE · $4,500+") -- the pick modal's subtitle and the build screen's
// "Book continues" entries both describe the same band, so the formatting
// lives here once. `maxSalary` is exclusive (PieceBand.matches: `salary <
// maxSalary`), hence the -1 on the displayed upper bound.
//
// Task "piece pools": a piece can now be spread across more than one band
// (PAWN is "RB/TE/WR under $5,000" AND, separately, "DST, any salary") --
// every band for `piece` is described and joined, not just the first one
// found, so the label never silently omits half of what the pick list
// actually offers. Null if `sport` has no band at all for `piece`
// (shouldn't happen for a real sport config -- see pieces.classify's own
// comment -- but this stays a plain lookup, not an assumption).
export function pieceBandLabel(piece: Piece, sport: SportConfig): string | null {
  const bands = sport.pieceBands.filter((b) => b.piece === piece);
  const labels = bands.map(singleBandLabel).filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(", or ") : null;
}

function singleBandLabel(band: PieceBand): string | null {
  const parts: string[] = [];
  if (band.positions !== null) parts.push([...band.positions].sort().join("/"));
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

// Task 39: the pick modal's "why is this row greyed out" label -- the same
// two checks rules.lineupStillCompletable makes (cap, then roster slots),
// just surfaced individually instead of collapsed into one boolean. UI-
// layer composition of already-exported primitives (maxAssignable), not a
// new engine rule: `lineupStillCompletable` itself also checks
// `currentPlayers.length > sport.rosterSize` first, but that can't trip
// here -- every caller passes a side's own current roster, which is never
// over `rosterSize` to begin with (this function only ever asks "would
// ONE more pick overflow it"). Null means the pick is feasible.
export function pickReason(currentPlayers: readonly Player[], candidate: Player, sport: SportConfig, contest: ContestConfig): string | null {
  const cap = contest.effectiveCap(sport);
  const spent = currentPlayers.reduce((sum, p) => sum + p.salary, 0) + candidate.salary;
  if (spent > cap) return "over the cap";
  if (maxAssignable([...currentPlayers, candidate], sport.rosterSlots) < currentPlayers.length + 1) return "no slot left";
  return null;
}
