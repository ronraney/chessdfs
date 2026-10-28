// Task 37: the build screen's per-side stats -- UI-layer composition of
// already-exported engine primitives, porting the same formulas
// dfs_chess/cli.py's _side_stats uses (no Python equivalent of this file
// itself; same spirit as appData.ts's own UI-layer joins). No new engine
// rules: salary/ownership/projection are plain sums, "open slots" is
// rules.openRosterSlots. The pick modal's own candidate list is
// engine/picklist.ts's pickList/castleQbCandidates (RULES.md piece table),
// not this file -- "eligible, sorted by projection" stopped being the
// whole story once each piece got its own sort metric and list cap.
import { Piece } from "./engine/models";
import type { ContestConfig } from "./engine/config";
import type { Player } from "./engine/models";
import type { OptimizerResult } from "./engine/optimizer";
import { classify } from "./engine/pieces";
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

export interface TightFinishConfig {
  minOpenSlots: number;
  cautionAvgPerSlot: number;
  warningAvgPerSlot: number;
}

export const TIGHT_FINISH_CONFIG: TightFinishConfig = {
  minOpenSlots: 3,
  cautionAvgPerSlot: 4500,
  warningAvgPerSlot: 4000,
};

export type TightFinishLevel = "caution" | "warning";

export interface TightFinishStatus {
  level: TightFinishLevel;
  avgRemainingPerOpenSlot: number;
  reasons: readonly string[]; // only non-empty at "warning" level
  message: string;
}

function formatAvg(avg: number): string {
  return `$${avg.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Never blocks a move or pick -- purely a display heads-up for White's own
// remaining salary, gated on White having `minOpenSlots`+ open slots at all
// (a near-full roster is always salary-tight and isn't worth flagging).
// "Pawn-priced" (factor a) is classify's own PAWN band -- position/salary
// only, same as everywhere else classify is used, NOT whichever piece
// actually locked that player (RULES.md Rook/Knight/Bishop pools now
// overlap PAWN's own salary range, so a player bought as a Knight can still
// read as Pawn-priced here). Warning needs avg <= warningAvgPerSlot AND at
// least one aggravating factor; avg that low with no factor present still
// reads as Caution, not Warning, not nothing.
export function tightFinishStatus(
  players: readonly Player[],
  sport: SportConfig,
  contest: ContestConfig,
  config: TightFinishConfig = TIGHT_FINISH_CONFIG,
): TightFinishStatus | null {
  const stats = sideStats(players, sport, contest);
  if (stats.openSlotCount < config.minOpenSlots) return null;
  const avg = stats.avgRemainingPerOpenSlot;
  if (avg > config.cautionAvgPerSlot) return null;

  if (avg <= config.warningAvgPerSlot) {
    const reasons: string[] = [];
    if (players.some((p) => classify(p, sport).has(Piece.PAWN))) reasons.push("a Pawn-priced player locked");
    if (players.filter((p) => p.positions.includes("TE")).length >= 2) reasons.push("both TE slots used");
    if (!players.some((p) => p.positions.includes("QB"))) reasons.push("QB still open");
    if (reasons.length > 0) {
      return {
        level: "warning",
        avgRemainingPerOpenSlot: avg,
        reasons,
        message: `Tight finish: ${formatAvg(avg)} per open slot · ${reasons.join(" · ")}`,
      };
    }
  }

  return {
    level: "caution",
    avgRemainingPerOpenSlot: avg,
    reasons: [],
    message: `Salary getting tight: ${formatAvg(avg)} per open slot.`,
  };
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

export interface PointsFromOptimal {
  // bestCompletion.total - slateOptimal.total -- never positive (a
  // completion can never beat the slate's own unconstrained best), shown
  // negated-at-zero rather than as a stray "-0.0".
  delta: number;
  bestCompletion: number;
  slateOptimal: number;
}

// Combines the slate's own best possible lineup (no locks, no exclusions --
// computed once per slate/contest by the caller) with White's current best
// completion (locks forced, Black's picks excluded -- recomputed after
// every pick) into the one display value. Null if either solve came back
// infeasible -- shouldn't happen for a real build (engine/optimizer.ts:
// the core is always completable), but this is a display feature, not a
// rule, so it shows "--" rather than asserting it can't.
export function pointsFromOptimal(slateOptimal: OptimizerResult | null, bestCompletion: OptimizerResult | null): PointsFromOptimal | null {
  if (slateOptimal === null || bestCompletion === null) return null;
  const delta = bestCompletion.total - slateOptimal.total;
  return { delta: delta === 0 ? 0 : delta, bestCompletion: bestCompletion.total, slateOptimal: slateOptimal.total };
}
