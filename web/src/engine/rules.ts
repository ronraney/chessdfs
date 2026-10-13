// Legality rules: roster/salary completability, chess legality + turn
// order, piece-type matching, exclusivity. Ported from dfs_chess/rules.py --
// max_assignable, lineup_still_completable, is_lineup_complete,
// open_roster_slots, is_legal_move, and apply_move. is_legal_move/apply_move
// cover ordinary (non-capturing, non-castling) moves only, per Task 24's
// scope -- castling (can_castle/castle), King modes (switch_king/
// place_kings), and captures (is_legal_capture/apply_capture_move) are each
// still unported, their own future task; is_legal_move's early-rejects for
// castling and captures below are this task's explicit stub for that, not
// an oversight.
//
// Roster shape (slots, eligible positions, salary cap) comes from a
// SportConfig, not from constants here, per RULES.md "Multi-sport ready".

import type { Square } from "chess.js";
import { Chess } from "chess.js";
import type { ContestConfig } from "./config";
import type { Player } from "./models";
import { BuildState, Move, Side } from "./models";
import { classify, pieceForChessType } from "./pieces";
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

// A candidate ordinary move, UCI-shorthand (e.g. {from: "e2", to: "e4"}) --
// the TS stand-in for Python's chess.Move, which chess.js has no public
// constructor for. promotion only disambiguates same-from/to promotion
// choices (e.g. e7e8 to Queen vs. Knight); no ported test exercises it.
export interface ChessMove {
  from: Square;
  to: Square;
  promotion?: string;
}

function sideToMove(board: Chess): Side {
  return board.turn() === "w" ? Side.WHITE : Side.BLACK;
}

function movesFor(state: BuildState, side: Side): Move[] {
  return side === Side.WHITE ? state.whiteMoves : state.blackMoves;
}

function withBoardState(
  state: BuildState,
  side: Side,
  moves: Move[],
  lockedPlayerIds: Set<string>,
  board: Chess,
  pieceLocks: Map<Square, Player[]>,
): BuildState {
  return new BuildState({
    board,
    whiteMoves: side === Side.WHITE ? moves : [...state.whiteMoves],
    blackMoves: side === Side.BLACK ? moves : [...state.blackMoves],
    lockedPlayerIds,
    pieceLocks,
    blackCommittedLine: state.blackCommittedLine,
    whiteCastled: state.whiteCastled,
    blackCastled: state.blackCastled,
  });
}

// The legal, verbose chess.js Move matching `move`'s from/to(/promotion),
// or undefined if `move` isn't legal right now -- the chess.js stand-in for
// `chess_move in state.board.legal_moves`, but also hands back the piece
// type and SAN the Python version separately pulls via piece_type_at/san().
function findLegalMove(board: Chess, move: ChessMove) {
  return board
    .moves({ verbose: true })
    .find((m) => m.from === move.from && m.to === move.to && (move.promotion === undefined || m.promotion === move.promotion));
}

export function isLegalMove(
  state: BuildState,
  chessMove: ChessMove,
  player: Player,
  sport: SportConfig,
  contest: ContestConfig,
): boolean {
  const matched = findLegalMove(state.board, chessMove);
  if (!matched) return false;
  if (matched.isKingsideCastle() || matched.isQueensideCastle()) return false; // castling locks King + Rook together; not yet ported (future task)
  if (matched.isCapture()) return false; // the captured player is the pick; not yet ported (future task)

  const side = sideToMove(state.board);
  const piece = pieceForChessType(matched.piece);

  if (state.lockedPlayerIds.has(player.id)) return false;
  if (classify(player, sport) !== piece) return false;

  const cap = contest.effectiveCap(sport);
  const current = movesFor(state, side).map((m) => m.player);
  if (!lineupStillCompletable([...current, player], sport, cap)) return false;

  return true;
}

// A non-capturing, non-castling move: `player` is this move's new pick. A
// capture never reaches here (isLegalMove rejects it) -- the captured
// player IS the move's pick instead; see apply_capture_move (not yet
// ported).
export function applyMove(
  state: BuildState,
  chessMove: ChessMove,
  player: Player,
  sport: SportConfig,
  contest: ContestConfig,
): BuildState {
  if (!isLegalMove(state, chessMove, player, sport, contest)) {
    throw new Error(`illegal move: ${JSON.stringify(chessMove)} for ${player.id}`);
  }

  const side = sideToMove(state.board);
  const matched = findLegalMove(state.board, chessMove)!;
  const piece = pieceForChessType(matched.piece);
  const san = matched.san;

  const newBoard = new Chess(state.board.fen());
  newBoard.move({ from: chessMove.from, to: chessMove.to, promotion: chessMove.promotion });

  const newPieceLocks = new Map(state.pieceLocks);
  const moverHistory = newPieceLocks.get(chessMove.from) ?? [];
  newPieceLocks.delete(chessMove.from);
  newPieceLocks.set(chessMove.to, [...moverHistory, player]);

  const moveRecord = new Move({ side, piece, san, player });
  const moves = [...movesFor(state, side), moveRecord];
  const locked = new Set(state.lockedPlayerIds);
  locked.add(player.id);

  return withBoardState(state, side, moves, locked, newBoard, newPieceLocks);
}
