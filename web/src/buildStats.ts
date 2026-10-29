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
import { cheapestCompletionCost } from "./engine/optimizer";
import type { OptimizerResult } from "./engine/optimizer";
import { classify } from "./engine/pieces";
import { blockedPositions, maxAssignable, openRosterSlots } from "./engine/rules";
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
  minOpenSlotsForAvg: number;
  cautionAvgPerSlot: number;
  warningAvgPerSlot: number;
  criticalCushion: number;
}

export const TIGHT_FINISH_CONFIG: TightFinishConfig = {
  minOpenSlotsForAvg: 2,
  cautionAvgPerSlot: 5000,
  warningAvgPerSlot: 4000,
  criticalCushion: 500,
};

export type TightFinishLevel = "caution" | "warning" | "critical";

export interface TightFinishStatus {
  level: TightFinishLevel;
  avgRemainingPerOpenSlot: number;
  message: string;
}

function formatAvg(avg: number): string {
  return `$${avg.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Rule change "Tight-finish alerts: new levels + Go back": three straight
// salary-tightness steps, White only, worst-first (a pick that crosses
// more than one in the same jump reports only the worst):
//   1. caution -- avg remaining per open slot <= cautionAvgPerSlot.
//   2. warning -- avg remaining per open slot <= warningAvgPerSlot. No
//      aggravating factors any more (dropped this rule change) -- either
//      threshold alone is enough.
//   3. critical ("barely completable") -- remaining salary minus the
//      CHEAPEST possible completion of every still-open slot
//      (cheapestCompletionCost, from `availablePlayers` -- genuinely
//      undrafted by either side) is under criticalCushion. Checked first
//      (it's the worst) and applies whenever ANY slot is open; steps 1-2
//      only apply at minOpenSlotsForAvg+ open slots (dropped from 3 to 2
//      this rule change) -- a near-full roster is always salary-tight by
//      the crude avg metric and isn't worth flagging by it, but IS still
//      worth flagging by the exact completability metric, hence the
//      separate, looser gate for step 3 alone.
// Never blocks a move or pick -- purely a display heads-up (BuildScreen's
// own dialog on top of it adds "Go back," which DOES act, but that's
// BuildScreen undoing the pick, not this function). A null
// cheapestCompletionCost (no legal completion at all from
// `availablePlayers` -- shouldn't happen against a real slate) just skips
// step 3, falling through to 1-2 same as if cushion were comfortable.
export function tightFinishStatus(
  whiteRoster: readonly Player[],
  availablePlayers: readonly Player[],
  sport: SportConfig,
  contest: ContestConfig,
  config: TightFinishConfig = TIGHT_FINISH_CONFIG,
): TightFinishStatus | null {
  const stats = sideStats(whiteRoster, sport, contest);
  if (stats.openSlotCount === 0) return null;

  const cheapest = cheapestCompletionCost(availablePlayers, stats.openSlots, sport.rosterSlots);
  if (cheapest !== null) {
    const cushion = stats.salaryRemaining - cheapest;
    if (cushion < config.criticalCushion) {
      return {
        level: "critical",
        avgRemainingPerOpenSlot: stats.avgRemainingPerOpenSlot,
        message: `Barely completable: ${formatAvg(cushion)} of room before the cheapest finish.`,
      };
    }
  }

  if (stats.openSlotCount < config.minOpenSlotsForAvg) return null;
  const avg = stats.avgRemainingPerOpenSlot;
  if (avg > config.cautionAvgPerSlot) return null;
  if (avg <= config.warningAvgPerSlot) {
    return { level: "warning", avgRemainingPerOpenSlot: avg, message: `Tight finish: ${formatAvg(avg)} per open slot.` };
  }
  return { level: "caution", avgRemainingPerOpenSlot: avg, message: `Salary getting tight: ${formatAvg(avg)} per open slot.` };
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

// Rule change "Roster-full notice + opponent in pick lists": the pick
// modal's own top-of-list notice -- which of THIS list's real-world
// positions (every unlocked, `piece`-eligible player's own position,
// regardless of whether he individually survives the roster-fit filter)
// are flat-out blocked for `currentPlayers`' side right now (rules.
// blockedPositions: every slot that position could fill, including FLEX,
// is already taken). Null once nothing relevant is blocked. Deliberately
// NOT restricted to a team (castling's own Rook step included) -- a
// position blocked side-wide is blocked side-wide, regardless of which
// teammates happen to fill this particular list.
export function blockedPositionsNotice(
  piece: Piece,
  playersPool: readonly Player[],
  lockedPlayerIds: ReadonlySet<string>,
  currentPlayers: readonly Player[],
  sport: SportConfig,
): string | null {
  const relevant = new Set<string>();
  for (const p of playersPool) {
    if (lockedPlayerIds.has(p.id)) continue;
    if (!classify(p, sport).has(piece)) continue;
    for (const position of p.positions) relevant.add(position.toUpperCase());
  }
  if (relevant.size === 0) return null;

  const blocked = blockedPositions(currentPlayers, sport.rosterSlots);
  const named = [...relevant].filter((position) => blocked.has(position)).sort();
  if (named.length === 0) return null;

  return `You cannot select any more ${named.join(" or ")}.`;
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
