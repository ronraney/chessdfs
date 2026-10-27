// Pick-list sort metrics -- see RULES.md's piece table (source of truth
// for which metric sorts which piece's pick list, highest first). Ported
// from dfs_chess/metrics.py.

import type { ContestConfig } from "./config";
import { Piece, type Player } from "./models";

// Projection per $1,000 of salary -- Pawn's own metric, and the base
// `leverage` discounts by ownership. Computed, never read off the ETR
// export's own "DK Value" column (points above a salary baseline, mostly
// negative -- a different thing entirely).
export function value(player: Player): number {
  return (player.proj / player.salary) * 1000;
}

// Floor per $1,000 of salary -- Knight's own metric.
export function floorValue(player: Player): number {
  return (player.floor / player.salary) * 1000;
}

// `value` discounted by the contest's own field-size ownership. Still
// ported/tested as-is (Python's own metric, unchanged), but no longer what
// sorts Bishop's TS pick list -- see relativeLeverage below.
export function leverage(player: Player, contest: ContestConfig): number {
  return value(player) * (1 - player.ownFor(contest.fieldTier()));
}

// The highest ownership (contest's own field tier) at each real-world
// position, from the WHOLE slate `playersPool` -- deliberately every
// player at that position, not just Bishop-band-eligible ones (TS-only
// rule, no Python equivalent) -- relativeLeverage's own denominator.
export function highestOwnershipByPosition(
  playersPool: readonly Player[],
  contest: ContestConfig,
): ReadonlyMap<string, number> {
  const tier = contest.fieldTier();
  const highest = new Map<string, number>();
  for (const player of playersPool) {
    const position = player.positions[0]?.toUpperCase();
    if (position === undefined) continue;
    const own = player.ownFor(tier);
    const current = highest.get(position);
    if (current === undefined || own > current) highest.set(position, own);
  }
  return highest;
}

// `value` discounted by ownership relative to the highest ownership at
// `player`'s own position across the whole slate (`highestOwnership`, from
// highestOwnershipByPosition) -- Bishop's own TS-only metric, replacing
// `leverage` for Bishop specifically. No highest-ownership entry for his
// position (an empty/missing map) means no discount at all.
export function relativeLeverage(
  player: Player,
  contest: ContestConfig,
  highestOwnership: ReadonlyMap<string, number>,
): number {
  const position = player.positions[0]?.toUpperCase();
  const highest = position !== undefined ? highestOwnership.get(position) : undefined;
  const ratio = highest !== undefined && highest > 0 ? player.ownFor(contest.fieldTier()) / highest : 0;
  return value(player) * (1 - ratio);
}

// `player`'s own value for whichever metric sorts `piece`'s pick list,
// highest first: King/Rook by projection (King unchanged; Rook per the
// correlation rework), Queen by ceiling, Bishop by relativeLeverage, Knight
// by floor value, Pawn by value. `highestOwnership` only matters for
// Bishop -- callers of every other piece can omit it.
export function sortMetric(
  piece: Piece,
  player: Player,
  contest: ContestConfig,
  highestOwnership: ReadonlyMap<string, number> = new Map(),
): number {
  if (piece === Piece.QUEEN) return player.ceiling;
  if (piece === Piece.BISHOP) return relativeLeverage(player, contest, highestOwnership);
  if (piece === Piece.KNIGHT) return floorValue(player);
  if (piece === Piece.PAWN) return value(player);
  return player.proj; // KING, ROOK
}
