// Pick lists -- see RULES.md "List cap" and the piece table's sort
// column. A pick list is the eligible, unlocked, roster/salary-feasible
// players for a piece, sorted by that piece's own metric (metrics.
// sortMetric) and capped to `sport`'s own per-piece list cap, if any.
// This is the one list White's pick modal shows and Black's placeholder
// pick takes the top of (RULES.md: "Black ... picks the top of the moved
// piece's (capped) list instead of highest projection"). Ported from
// dfs_chess/picklist.py.

import type { ContestConfig } from "./config";
import { highestOwnershipByPosition, sortMetric, value } from "./metrics";
import { Piece, type Player } from "./models";
import { classify } from "./pieces";
import { lineupStillCompletable } from "./rules";
import type { SportConfig } from "./sport";

// Linear-interpolation percentile of an ascending-sorted, non-empty array --
// same formula as engine/sim/run.ts's own private percentile (kept
// separate; that one serves a different domain, finish-place aggregation).
function percentile(sortedAscending: readonly number[], p: number): number {
  const idx = p * (sortedAscending.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (idx - lo);
}

// Bishop's own eligibility "quality floor" (TS-only rule, no Python
// equivalent): the configured percentile (sport.bishopValuePercentile,
// default 0.5 = median) of `value`, among every Bishop-band-eligible
// player in the WHOLE slate `playersPool` -- before removing locked/taken
// players -- grouped by real-world position.
function bishopValueFloors(playersPool: readonly Player[], sport: SportConfig): ReadonlyMap<string, number> {
  const byPosition = new Map<string, number[]>();
  for (const candidate of playersPool) {
    if (!classify(candidate, sport).has(Piece.BISHOP)) continue;
    const position = candidate.positions[0]?.toUpperCase();
    if (position === undefined) continue;
    const values = byPosition.get(position) ?? [];
    values.push(value(candidate));
    byPosition.set(position, values);
  }
  const floors = new Map<string, number>();
  for (const [position, values] of byPosition) {
    values.sort((a, b) => a - b);
    floors.set(position, percentile(values, sport.bishopValuePercentile));
  }
  return floors;
}

// Whether `player` clears his own position's Bishop value floor -- true
// (no restriction) if his position has no floor at all, which shouldn't
// happen for a Bishop-band-eligible player (he'd have contributed to his
// own position's floor) but is handled defensively all the same.
function meetsBishopValueFloor(player: Player, floors: ReadonlyMap<string, number>): boolean {
  const position = player.positions[0]?.toUpperCase();
  const floor = position !== undefined ? floors.get(position) : undefined;
  return floor === undefined || value(player) >= floor;
}

// Rook's own stack-tier (Rule change "Rook: stack builder"): a player
// sits in his HIGHEST matching tier only (1 beats 2 beats 3 beats 4) --
// 1. same team as that side's QB, 2. the QB's own opponent (same game),
// 3. same team as any OTHER player already in that side's lineup, 4.
// everyone else. `qbTeam`/`qbOpp` are both null when no QB is locked yet
// -- tiers 1-2 are skipped entirely then (every candidate falls through
// to 3 or 4), not defaulted to tier 4 outright.
function rookTier(
  player: Player,
  qbTeam: string | null,
  qbOpp: string | null,
  currentPlayers: readonly Player[],
): 1 | 2 | 3 | 4 {
  if (qbTeam !== null) {
    if (player.team === qbTeam) return 1;
    if (qbOpp !== null && player.team === qbOpp) return 2;
  }
  if (currentPlayers.some((cp) => cp.team === player.team)) return 3;
  return 4;
}

// The locked QB's own opponent team, derived from `currentPlayers` (the
// QB itself is always among them whenever `qbTeam` is non-null -- every
// caller derives both from the same roster/move list) -- null if no QB
// is locked (qbTeam null) or, defensively, if it somehow isn't found.
function qbOpponentTeam(qbTeam: string | null, currentPlayers: readonly Player[]): string | null {
  if (qbTeam === null) return null;
  const qb = currentPlayers.find((p) => p.team === qbTeam && p.positions.some((pos) => pos.toUpperCase() === "QB"));
  return qb?.opp ?? null;
}

// `currentPlayers` is whichever side is picking's own roster so far
// (never including a hypothetical candidate) -- feasibility is checked
// as "would `currentPlayers` plus this ONE candidate still be
// completable," same as every other lock in the build. `qbTeam` feeds
// Rook's own stack-tier sort (rookTier above); every other piece ignores
// it. Bishop gets two more TS-only checks on top of classify()'s
// unchanged RB/WR/TE >= $5,000 band: a per-position value floor
// (bishopValueFloors) and a sort by value discounted relative to the
// highest ownership at his own position (metrics.relativeLeverage) --
// both computed from the whole `playersPool`, before locked/infeasible
// players are filtered out.
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
  const bishopFloors = piece === Piece.BISHOP ? bishopValueFloors(playersPool, sport) : null;
  const highestOwnership = piece === Piece.BISHOP ? highestOwnershipByPosition(playersPool, contest) : undefined;
  const candidates = playersPool.filter(
    (p) =>
      !lockedPlayerIds.has(p.id) &&
      classify(p, sport).has(piece) &&
      (bishopFloors === null || meetsBishopValueFloor(p, bishopFloors)) &&
      lineupStillCompletable([...currentPlayers, p], sport, cap),
  );
  if (piece === Piece.ROOK) {
    const qbOpp = qbOpponentTeam(qbTeam, currentPlayers);
    candidates.sort((a, b) => {
      const tierA = rookTier(a, qbTeam, qbOpp, currentPlayers);
      const tierB = rookTier(b, qbTeam, qbOpp, currentPlayers);
      return tierA !== tierB ? tierA - tierB : b.ceiling - a.ceiling;
    });
  } else {
    candidates.sort(
      (a, b) => sortMetric(piece, b, contest, highestOwnership) - sortMetric(piece, a, contest, highestOwnership),
    );
  }
  const listCap = sport.listCapFor(piece);
  return listCap === null ? candidates : candidates.slice(0, listCap);
}

// Castling's own Rook step -- UNCHANGED by Rule change "Rook: stack
// builder" (which only reworks the general/direct Rook pool above):
// restricted to the QB's own teammates only, sorted by proj. A dedicated
// function rather than a flag on pickList, since the two have genuinely
// diverged (team-restricted eligibility + proj sort here, vs. unrestricted
// eligibility + stack-tier/ceiling sort there).
export function castleRookList(
  playersPool: readonly Player[],
  lockedPlayerIds: ReadonlySet<string>,
  currentPlayers: readonly Player[],
  sport: SportConfig,
  contest: ContestConfig,
  qbTeam: string,
): Player[] {
  const cap = contest.effectiveCap(sport);
  const candidates = playersPool.filter(
    (p) =>
      !lockedPlayerIds.has(p.id) &&
      classify(p, sport).has(Piece.ROOK) &&
      p.team === qbTeam &&
      lineupStillCompletable([...currentPlayers, p], sport, cap),
  );
  candidates.sort((a, b) => sortMetric(Piece.ROOK, b, contest) - sortMetric(Piece.ROOK, a, contest));
  const listCap = sport.listCapFor(Piece.ROOK);
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
    return castleRookList(playersPool, locked, [...currentPlayers, king], sport, contest, king.team).length > 0;
  });
}
