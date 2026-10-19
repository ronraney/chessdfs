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

// `value` discounted by the contest's own field-size ownership -- Bishop's
// own metric.
export function leverage(player: Player, contest: ContestConfig): number {
  return value(player) * (1 - player.ownFor(contest.fieldTier()));
}

// `player`'s own value for whichever metric sorts `piece`'s pick list,
// highest first: King/Rook by projection (King unchanged; Rook per the
// correlation rework), Queen by ceiling, Bishop by leverage, Knight by
// floor value, Pawn by value.
export function sortMetric(piece: Piece, player: Player, contest: ContestConfig): number {
  if (piece === Piece.QUEEN) return player.ceiling;
  if (piece === Piece.BISHOP) return leverage(player, contest);
  if (piece === Piece.KNIGHT) return floorValue(player);
  if (piece === Piece.PAWN) return value(player);
  return player.proj; // KING, ROOK
}
