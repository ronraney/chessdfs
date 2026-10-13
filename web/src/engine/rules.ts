// Legality rules: roster/salary completability, chess legality + turn
// order, piece-type matching, exclusivity, castling, King modes, and
// Crazyhouse-style captures. Ported from dfs_chess/rules.py in full --
// max_assignable, lineup_still_completable, is_lineup_complete,
// open_roster_slots, is_legal_move, apply_move, can_castle, castle,
// switch_king, place_kings, is_legal_capture, and apply_capture_move.
// push_silent_move is NOT ported -- it exists in rules.py only to support
// the build loop (a side whose lineup is already complete), has no
// test_rules.py coverage, and the build loop itself is still out of scope
// (see Task 25's session log).
//
// Roster shape (slots, eligible positions, salary cap) comes from a
// SportConfig, not from constants here, per RULES.md "Multi-sport ready".

import type { Move as ChessJsMove, Square } from "chess.js";
import { Chess } from "chess.js";
import type { ContestConfig } from "./config";
import type { Player } from "./models";
import { BuildState, KingMode, Move, Piece, Side } from "./models";
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
function findLegalMove(board: Chess, move: ChessMove): ChessJsMove | undefined {
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
  if (matched.isKingsideCastle() || matched.isQueensideCastle()) return false; // castling locks King + Rook together; use castle()
  if (matched.isCapture()) return false; // the captured player is the pick; use applyCaptureMove()

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

// The rook's [from, to] squares for a castling move, derived the same way
// Python's _castling_rook_squares does -- from the king's own from-square
// (e1 => White, e8 => Black) and which side it castled toward. chess.js's
// Move doesn't carry the rook's squares directly (only the king's two-
// square hop), so this has to be worked out the same way Python does.
function castlingRookSquares(move: ChessJsMove): [Square, Square] {
  const kingside = move.isKingsideCastle();
  if (move.from === "e1") {
    return kingside ? ["h1", "f1"] : ["a1", "d1"];
  }
  return kingside ? ["h8", "f8"] : ["a8", "d8"];
}

// `kingMode` EMERGE (default): matches the pre-Task-14 behavior exactly --
// a King locked by any move (including a prior castling) blocks further
// castling. PLACED: the King is already locked from setup, which must NOT
// block castling -- the explicit `*Castled` flag is what detects "already
// castled" instead.
export function canCastle(state: BuildState, side: Side, kingMode: KingMode = KingMode.EMERGE): boolean {
  const alreadyCastled = side === Side.WHITE ? state.whiteCastled : state.blackCastled;
  if (alreadyCastled) return false;
  const lockedPieces = new Set(movesFor(state, side).map((m) => m.piece));
  if (kingMode === KingMode.EMERGE && lockedPieces.has(Piece.KING)) return false;
  return lockedPieces.has(Piece.KNIGHT) && lockedPieces.has(Piece.BISHOP);
}

// `king` is required (and locked, King + Rook together) in EMERGE mode. In
// PLACED mode (Task 14), the King is already locked from setup -- castling
// locks only the Rook, and `king` is ignored (pass null).
export function castle(
  state: BuildState,
  chessMove: ChessMove,
  king: Player | null,
  rook: Player,
  sport: SportConfig,
  contest: ContestConfig,
  kingMode: KingMode = KingMode.EMERGE,
): BuildState {
  const matched = findLegalMove(state.board, chessMove);
  if (!matched || !(matched.isKingsideCastle() || matched.isQueensideCastle())) {
    throw new Error(`${JSON.stringify(chessMove)} is not a legal castling move`);
  }

  const side = sideToMove(state.board);
  if (!canCastle(state, side, kingMode)) {
    throw new Error(`castling is not legal for ${side}`);
  }

  if (kingMode === KingMode.EMERGE) {
    if (king === null) {
      throw new Error("kingMode is EMERGE; a King player is required");
    }
    if (classify(king, sport) !== Piece.KING) {
      throw new Error(`${king.name} does not classify as King`);
    }
    if (state.lockedPlayerIds.has(king.id)) {
      throw new Error(`${king.name} is already locked`);
    }
  }

  if (classify(rook, sport) !== Piece.ROOK) {
    throw new Error(`${rook.name} does not classify as Rook`);
  }
  if (state.lockedPlayerIds.has(rook.id)) {
    throw new Error(`${rook.name} is already locked`);
  }

  const current = movesFor(state, side).map((m) => m.player);
  const additions = kingMode === KingMode.EMERGE ? [king as Player, rook] : [rook];
  if (!lineupStillCompletable([...current, ...additions], sport, contest.effectiveCap(sport))) {
    throw new Error("castling would make a legal lineup impossible to complete");
  }

  const san = matched.san;
  const [rookFrom, rookTo] = castlingRookSquares(matched);

  const newBoard = new Chess(state.board.fen());
  newBoard.move({ from: chessMove.from, to: chessMove.to });

  const newPieceLocks = new Map(state.pieceLocks);
  const kingHistory = newPieceLocks.get(chessMove.from) ?? [];
  newPieceLocks.delete(chessMove.from);
  // PLACED mode: the King's square still holds whatever locked it at setup
  // -- castling relocates that history along with the physical king move,
  // but doesn't add to it (no new King lock here).
  newPieceLocks.set(chessMove.to, kingMode === KingMode.EMERGE ? [...kingHistory, king as Player] : kingHistory);
  const rookHistory = newPieceLocks.get(rookFrom) ?? [];
  newPieceLocks.delete(rookFrom);
  newPieceLocks.set(rookTo, [...rookHistory, rook]);

  const newMoves: Move[] = [new Move({ side, piece: Piece.ROOK, san, player: rook })];
  if (kingMode === KingMode.EMERGE) {
    newMoves.unshift(new Move({ side, piece: Piece.KING, san, player: king as Player }));
  }
  const moves = [...movesFor(state, side), ...newMoves];
  const locked = new Set(state.lockedPlayerIds);
  locked.add(rook.id);
  if (kingMode === KingMode.EMERGE) locked.add((king as Player).id);

  const newState = withBoardState(state, side, moves, locked, newBoard, newPieceLocks);
  if (side === Side.WHITE) {
    newState.whiteCastled = true;
  } else {
    newState.blackCastled = true;
  }
  return newState;
}

// Task 14's one-time "Switch your QB?" offer, right after castling in
// PLACED king mode: `side`'s currently-locked QB returns to the player
// pool (available to either side again), and `newKing` takes its place --
// provided the swap keeps the lineup completable (the roster shape never
// changes, still exactly one QB; only salary can actually break this).
// Returns null if `newKing` doesn't classify as King, is already locked,
// or the swap would overflow the cap -- the caller should treat that as
// "switch rejected," leaving the original QB in place.
export function switchKing(
  state: BuildState,
  side: Side,
  newKing: Player,
  sport: SportConfig,
  contest: ContestConfig,
): BuildState | null {
  if (classify(newKing, sport) !== Piece.KING) return null;
  if (state.lockedPlayerIds.has(newKing.id)) return null;

  const moves = movesFor(state, side);
  const oldKingMove = moves.find((m) => m.piece === Piece.KING);
  if (oldKingMove === undefined) return null;
  const oldKing = oldKingMove.player;

  const otherPlayers = moves.filter((m) => m.player.id !== oldKing.id).map((m) => m.player);
  if (!lineupStillCompletable([...otherPlayers, newKing], sport, contest.effectiveCap(sport))) {
    return null;
  }

  const newMoves = moves.map((m) =>
    m.player.id === oldKing.id ? new Move({ side, piece: Piece.KING, san: m.san, player: newKing }) : m,
  );
  const newLocked = new Set(state.lockedPlayerIds);
  newLocked.delete(oldKing.id);
  newLocked.add(newKing.id);
  const newPieceLocks = new Map<Square, Player[]>();
  for (const [square, history] of state.pieceLocks) {
    newPieceLocks.set(
      square,
      history.map((p) => (p.id === oldKing.id ? newKing : p)),
    );
  }

  return withBoardState(state, side, newMoves, newLocked, state.board, newPieceLocks);
}

// Task 14 "Place your King now": locks White's and Black's QB before move
// 1 -- no chess move is involved, so the board starts at the normal
// starting position. Throws if either player doesn't classify as King,
// they're the same player, or either is unaffordable alone (mirrors the
// same completability check every other lock goes through).
export function placeKings(
  whiteKing: Player,
  blackKing: Player,
  sport: SportConfig,
  contest: ContestConfig,
): BuildState {
  if (classify(whiteKing, sport) !== Piece.KING) {
    throw new Error(`${whiteKing.name} does not classify as King`);
  }
  if (classify(blackKing, sport) !== Piece.KING) {
    throw new Error(`${blackKing.name} does not classify as King`);
  }
  if (whiteKing.id === blackKing.id) {
    throw new Error("White and Black cannot place the same QB");
  }

  const cap = contest.effectiveCap(sport);
  if (!lineupStillCompletable([whiteKing], sport, cap)) {
    throw new Error(`${whiteKing.name} is not affordable for White`);
  }
  if (!lineupStillCompletable([blackKing], sport, cap)) {
    throw new Error(`${blackKing.name} is not affordable for Black`);
  }

  return new BuildState({
    whiteMoves: [new Move({ side: Side.WHITE, piece: Piece.KING, san: "(placed)", player: whiteKing })],
    blackMoves: [new Move({ side: Side.BLACK, piece: Piece.KING, san: "(placed)", player: blackKing })],
    lockedPlayerIds: new Set([whiteKing.id, blackKing.id]),
  });
}

function otherSide(side: Side): Side {
  return side === Side.WHITE ? Side.BLACK : Side.WHITE;
}

// The square holding the piece `move` captures. Normally `move.to`; for en
// passant the captured pawn sits beside it. Call before pushing.
function capturedSquare(move: ChessJsMove): Square {
  if (move.isEnPassant()) {
    return (move.to[0] + move.from[1]) as Square;
  }
  return move.to;
}

// Whether `chessMove` is a legal capture right now. The captured player IS
// this move's pick when the captured piece has lock history -- then
// `player` is ignored, and this just checks whether transferring the
// captured player keeps the capturing side's lineup completable. For a
// captured piece with NO lock history (it never moved), there's nothing to
// transfer -- `player` is the capturing side's own pick of that piece's
// real chess type instead; legal only if `player` classifies as that
// type, isn't already locked, and keeps the lineup completable. False
// (not an error) if `player` is required here but missing or doesn't
// qualify -- same "not playable" convention isLegalMove uses for
// everything else.
export function isLegalCapture(
  state: BuildState,
  chessMove: ChessMove,
  sport: SportConfig,
  contest: ContestConfig,
  player: Player | null = null,
): boolean {
  const matched = findLegalMove(state.board, chessMove);
  if (!matched) return false;
  if (!matched.isCapture() || matched.isKingsideCastle() || matched.isQueensideCastle()) return false;

  const side = sideToMove(state.board);
  const current = movesFor(state, side).map((m) => m.player);
  const cap = contest.effectiveCap(sport);

  const square = capturedSquare(matched);
  const capturedHistory = state.pieceLocks.get(square) ?? [];
  if (capturedHistory.length > 0) {
    return lineupStillCompletable([...current, capturedHistory[capturedHistory.length - 1]], sport, cap);
  }

  if (player === null || state.lockedPlayerIds.has(player.id)) return false;
  const capturedType = pieceForChessType(matched.captured!);
  if (classify(player, sport) !== capturedType) return false;
  return lineupStillCompletable([...current, player], sport, cap);
}

// Applies a capturing move: the captured player IS this move's pick -- the
// capturing piece locks no new player of its own. If the captured piece
// has lock history, there's nothing for a caller to have prompted for
// (`player` is ignored). If it never moved, there's no locked player on
// record to transfer -- `player` is required instead: the capturing
// side's own pick of that piece's real chess type, taking the captured
// piece's place as this move's only pick. Throws if `chessMove` isn't a
// legal, non-castling capture right now, if a never-moved capture's
// `player` is missing, doesn't classify as the captured piece's type, or
// is already locked, or if the resulting pick would overflow the
// capturing side's roster/salary.
export function applyCaptureMove(
  state: BuildState,
  chessMove: ChessMove,
  sport: SportConfig,
  contest: ContestConfig,
  player: Player | null = null,
): BuildState {
  const matched = findLegalMove(state.board, chessMove);
  if (!matched) {
    throw new Error(`illegal move: ${JSON.stringify(chessMove)}`);
  }
  if (matched.isKingsideCastle() || matched.isQueensideCastle()) {
    throw new Error(`${JSON.stringify(chessMove)} is castling, not a plain capture; use castle()`);
  }
  if (!matched.isCapture()) {
    throw new Error(`${JSON.stringify(chessMove)} is not a capture; use applyMove()`);
  }

  const side = sideToMove(state.board);
  const san = matched.san;
  const square = capturedSquare(matched);
  const capturedHistory = state.pieceLocks.get(square) ?? [];
  let captured: Player;
  if (capturedHistory.length > 0) {
    captured = capturedHistory[capturedHistory.length - 1];
  } else {
    const capturedType = pieceForChessType(matched.captured!);
    if (player === null) {
      throw new Error(`${san} captures an unmoved ${capturedType} -- a player pick is required`);
    }
    if (classify(player, sport) !== capturedType) {
      throw new Error(`${player.name} does not classify as ${capturedType}`);
    }
    if (state.lockedPlayerIds.has(player.id)) {
      throw new Error(`${player.name} is already locked`);
    }
    captured = player;
  }

  const cap = contest.effectiveCap(sport);
  const current = movesFor(state, side).map((m) => m.player);
  if (!lineupStillCompletable([...current, captured], sport, cap)) {
    throw new Error(`capturing ${captured.name} would make the lineup impossible to complete`);
  }

  const newBoard = new Chess(state.board.fen());
  newBoard.move({ from: chessMove.from, to: chessMove.to, promotion: chessMove.promotion });

  const newPieceLocks = new Map(state.pieceLocks);
  const moverHistory = newPieceLocks.get(chessMove.from) ?? [];
  newPieceLocks.delete(chessMove.from);
  if (square !== chessMove.to) {
    newPieceLocks.delete(square);
  }
  newPieceLocks.set(chessMove.to, [...moverHistory, captured]);

  const moveRecord = new Move({ side, piece: classify(captured, sport), san, player: captured });
  const moves = [...movesFor(state, side), moveRecord];

  const opposingSide = otherSide(side);
  const opponentMoves = movesFor(state, opposingSide).filter((m) => m.player.id !== captured.id);
  const locked = new Set(state.lockedPlayerIds);
  locked.add(captured.id);

  return new BuildState({
    board: newBoard,
    whiteMoves: side === Side.WHITE ? moves : opponentMoves,
    blackMoves: side === Side.BLACK ? moves : opponentMoves,
    lockedPlayerIds: locked,
    pieceLocks: newPieceLocks,
    blackCommittedLine: state.blackCommittedLine,
    whiteCastled: state.whiteCastled,
    blackCastled: state.blackCastled,
  });
}
