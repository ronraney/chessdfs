// Pick lists -- see RULES.md "List cap" and the piece table's sort
// column. A pick list is the eligible, unlocked, roster/salary-feasible
// players for a piece, sorted by that piece's own metric (metrics.
// sortMetric) and capped to `sport`'s own per-piece list cap, if any.
// This is the one list White's pick modal shows and Black's placeholder
// pick takes the top of (RULES.md: "Black ... picks the top of the moved
// piece's (capped) list instead of highest projection"). Ported from
// dfs_chess/picklist.py.

import type { ContestConfig } from "./config";
import { sortMetric } from "./metrics";
import { Piece, type Player } from "./models";
import { classify } from "./pieces";
import { lineupStillCompletable } from "./rules";
import type { SportConfig } from "./sport";

// `currentPlayers` is whichever side is picking's own roster so far
// (never including a hypothetical candidate) -- feasibility is checked
// as "would `currentPlayers` plus this ONE candidate still be
// completable," same as every other lock in the build. `qbTeam` only
// matters for Rook (see pieces.classify); every other piece ignores it.
export function pickList(
  piece: Piece,
  playersPool: readonly Player[],
  lockedPlayerIds: ReadonlySet<string>,
  currentPlayers: readonly Player[],
  sport: SportConfig,
  contest: ContestConfig,
  qbTeam: string | null = null,
): Player[] {
  const cap = contest.effectiveCap(sport);
  const candidates = playersPool.filter(
    (p) =>
      !lockedPlayerIds.has(p.id) &&
      classify(p, sport, qbTeam).has(piece) &&
      lineupStillCompletable([...currentPlayers, p], sport, cap),
  );
  candidates.sort((a, b) => sortMetric(piece, b, contest) - sortMetric(piece, a, contest));
  const listCap = sport.listCapFor(piece);
  return listCap === null ? candidates : candidates.slice(0, listCap);
}

// King's own pick list, further restricted to QBs with at least one
// eligible teammate (available, fits roster and salary alongside that
// QB) -- RULES.md: "Only offer QBs with at least one eligible teammate
// ... If none, castling is illegal." Empty means castling can't offer
// any QB at all right now.
export function castleQbCandidates(
  playersPool: readonly Player[],
  lockedPlayerIds: ReadonlySet<string>,
  currentPlayers: readonly Player[],
  sport: SportConfig,
  contest: ContestConfig,
): Player[] {
  const kings = pickList(Piece.KING, playersPool, lockedPlayerIds, currentPlayers, sport, contest);
  return kings.filter((king) => {
    const locked = new Set(lockedPlayerIds);
    locked.add(king.id);
    return pickList(Piece.ROOK, playersPool, locked, [...currentPlayers, king], sport, contest, king.team).length > 0;
  });
}
