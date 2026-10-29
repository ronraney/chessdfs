// Legality rules: roster/salary completability, chess legality + turn
// order, piece-type matching, exclusivity, castling, King modes, and
// Crazyhouse-style captures. Ported from dfs_chess/rules.py in full --
// max_assignable, lineup_still_completable, is_lineup_complete,
// open_roster_slots, is_legal_move, apply_move, can_castle, castle,
// switch_king, place_kings, is_legal_capture, apply_capture_move, and
// (Task 29, alongside build.ts) push_silent_move -- a side whose lineup is
// already complete gets its board moves pushed without locking anyone.
// push_silent_move has no test_rules.py coverage of its own in Python
// (build-loop-only); it's exercised here only indirectly, through
// build.test.ts's ported play_black_move/play_black_template_move tests,
// same as in Python.
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

// Rule change "Roster-full notice + opponent in pick lists": every real-
// world position with no roster-slot capacity left for `players` -- every
// slot that position could fill, including FLEX, is already taken. Reuses
// openRosterSlots' own matching: a position is blocked only when EVERY
// slot whose eligible positions include it shows zero open instances.
export function blockedPositions(players: readonly Player[], rosterSlots: readonly RosterSlot[]): ReadonlySet<string> {
  const open = openRosterSlots(players, rosterSlots);
  const allPositions = new Set<string>();
  for (const slot of rosterSlots) {
    for (const position of slot.positions) allPositions.add(position);
  }

  const blocked = new Set<string>();
  for (const position of allPositions) {
    const stillOpen = rosterSlots.some((slot) => slot.positions.has(position) && (open[slot.name] ?? 0) > 0);
    if (!stillOpen) blocked.add(position);
  }
  return blocked;
}

// Task 43: a concrete roster-slot assignment for `players` -- which named
// slot (RosterSlot.name, e.g. "RB" or "FLEX") each player occupies,
// parallel to `players`. Same Kuhn's matching as maxAssignable/
// openRosterSlots (same slot-instance expansion, same augmenting-path
// order) -- just recording which instance each player actually landed in
// instead of a count. Fully assigns every player whenever
// maxAssignable(players, rosterSlots) === players.length, which every
// caller's own `players` already satisfies (lineupStillCompletable gates
// every lock during the build on exactly that). Which of several
// interchangeable same-position players lands in a dedicated slot vs.
// FLEX is whatever the augmenting search finds first, not necessarily
// `players`' own order -- cosmetic only, since same-named slot instances
// are indistinguishable on screen.
export function assignRosterSlots(players: readonly Player[], rosterSlots: readonly RosterSlot[]): string[] {
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

  const slotNames: string[] = new Array(players.length).fill("");
  instances.forEach((slot, idx) => {
    const playerIdx = occupant[idx];
    if (playerIdx !== null) slotNames[playerIdx] = slot.name;
  });
  return slotNames;
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

// The team of `side`'s currently locked QB (King), or null if no King is
// locked yet for that side. Direct Rook moves no longer restrict
// eligibility by this at all (Rule change "Rook: stack builder" -- any
// RB/WR/TE, any salary); this still feeds picklist.ts's own stack-tier
// SORT (tier 1: same team as the QB) and castling's own Rook step, which
// keeps the old team restriction (castleRookList, rules.ts's castle()).
export function lockedQbTeam(state: BuildState, side: Side): string | null {
  const kingMove = movesFor(state, side).find((m) => m.piece === Piece.KING);
  return kingMove !== undefined ? kingMove.player.team : null;
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
    blackBlueprint: state.blackBlueprint,
    whiteCastled: state.whiteCastled,
    blackCastled: state.blackCastled,
  });
}

// The legal, verbose chess.js Move matching `move`'s from/to(/promotion),
// or undefined if `move` isn't legal right now -- the chess.js stand-in for
// `chess_move in state.board.legal_moves`, but also hands back the piece
// type and SAN the Python version separately pulls via piece_type_at/san().
// Exported for build.ts (Task 29), which needs the same resolution for its
// own caller-supplied/candidate moves.
//
// Task 33: this is the engine's hottest path by far -- build.ts's
// bestLegalPlayer/bestLegalCapturePlayer/bestLegalCastlePlayers call it with
// the exact same (board, move) pair once per candidate player, a loop of
// dozens deep for a real NFL pool. Two fixes, stacked: `square: move.from`
// scopes chess.js's own move generation (and its per-move check-legality
// make/undo filtering) to the one piece on that square instead of the whole
// board; a per-board result cache then collapses the *repeat* asks for that
// same square entirely. Caching by board-instance identity is safe because
// a BuildState's `board` is never mutated in place after creation -- every
// apply/castle/capture/silent-move clones first (see cloneBoard below) --
// and a WeakMap means a discarded board's cache entry is collected right
// along with it, never leaked.
const legalMoveCache = new WeakMap<Chess, Map<string, ChessJsMove | undefined>>();

export function findLegalMove(board: Chess, move: ChessMove): ChessJsMove | undefined {
  const key = `${move.from}${move.to}${move.promotion ?? ""}`;
  let cache = legalMoveCache.get(board);
  if (cache === undefined) {
    cache = new Map();
    legalMoveCache.set(board, cache);
  }
  if (cache.has(key)) {
    return cache.get(key);
  }

  const result = board
    .moves({ verbose: true, square: move.from })
    .find((m) => m.to === move.to && (move.promotion === undefined || m.promotion === move.promotion));
  cache.set(key, result);
  return result;
}

// A copy of `board` that keeps its full move history -- unlike python-chess's
// `board.copy()`, chess.js has no public clone, and `new Chess(board.fen())`
// only carries over the current position: FEN has no notion of move
// history, so a board rebuilt that way reports an empty `history()` (or,
// after one more move, a history of length 1) no matter how many moves
// actually led to this position. Round-tripping through PGN instead
// preserves it, including a non-default starting position (chess.js emits
// a `[FEN ...]`/`[SetUp "1"]` header for that case and `loadPgn` honors it).
// Task 33 profiling found this a minor cost next to the move-generation
// fix above (it only runs once per real move actually applied, not once
// per candidate) -- left as-is rather than risking a subtler replay-based
// rewrite for marginal gain.
function cloneBoard(board: Chess): Chess {
  const clone = new Chess();
  clone.loadPgn(board.pgn());
  return clone;
}

// chess.js keeps "ordinary capture" and "en passant" as separate, non-
// overlapping move flags (`isCapture()` / `isEnPassant()`), unlike python-
// chess's `board.is_capture()`, which returns True for both (RULES.md draws
// no distinction either -- a capture is a capture). Every "is this move a
// capture" check in this module and in build.ts goes through this instead
// of calling `isCapture()` alone (Task 30b) -- `isCapture()` on its own
// silently mis-routed an en passant move down the ordinary-move path,
// which locks a brand-new player instead of transferring the captured
// pawn's, caught by Task 30's parity check against the Python original.
export function isCaptureMove(move: ChessJsMove): boolean {
  return move.isCapture() || move.isEnPassant();
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
  if (isCaptureMove(matched)) return false; // the captured player is the pick; use applyCaptureMove()

  const side = sideToMove(state.board);
  const piece = pieceForChessType(matched.piece);

  if (state.lockedPlayerIds.has(player.id)) return false;
  if (!classify(player, sport).has(piece)) return false;

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

  const newBoard = cloneBoard(state.board);
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
    if (!classify(king, sport).has(Piece.KING)) {
      throw new Error(`${king.name} does not classify as King`);
    }
    if (state.lockedPlayerIds.has(king.id)) {
      throw new Error(`${king.name} is already locked`);
    }
  }

  // RULES.md piece table: the Rook must be a teammate of the FINAL QB --
  // the one just chosen (EMERGE) or already locked from setup (PLACED).
  // Castling's own Rook step is UNCHANGED by Rule change "Rook: stack
  // builder" (which only drops this restriction for the general/direct
  // Rook pool) -- enforced here as an explicit team check now that
  // classify() itself no longer carries any team restriction at all.
  const qbTeam = kingMode === KingMode.EMERGE ? (king as Player).team : lockedQbTeam(state, side);
  if (!classify(rook, sport).has(Piece.ROOK)) {
    throw new Error(`${rook.name} does not classify as Rook`);
  }
  if (rook.team !== qbTeam) {
    throw new Error(`${rook.name} is not on the QB's team`);
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

  const newBoard = cloneBoard(state.board);
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
  if (!classify(newKing, sport).has(Piece.KING)) return null;
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
  if (!classify(whiteKing, sport).has(Piece.KING)) {
    throw new Error(`${whiteKing.name} does not classify as King`);
  }
  if (!classify(blackKing, sport).has(Piece.KING)) {
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
// passant the captured pawn sits beside it. Call before pushing. Exported
// for build.ts (Task 29), same reason as findLegalMove above.
export function capturedSquare(move: ChessJsMove): Square {
  if (move.isEnPassant()) {
    return (move.to[0] + move.from[1]) as Square;
  }
  return move.to;
}

// Whether capturing right now would keep the capturing side's lineup
// completable -- NOT whether the capture itself is allowed to happen
// (every legal, non-castling capture is always allowed; see
// applyCaptureMove, which transfers/picks a replacement only when this is
// true and otherwise still applies the capture, locking no one). When the
// captured piece has lock history, `player` is ignored and this checks the
// transfer. For a captured piece with NO lock history (it never moved),
// `player` is the capturing side's own candidate pick of that piece's real
// chess type instead; this is false (not an error) if `player` is missing,
// doesn't classify as that type, or is already locked -- same "not a fit"
// convention isLegalMove uses for everything else.
export function isLegalCapture(
  state: BuildState,
  chessMove: ChessMove,
  sport: SportConfig,
  contest: ContestConfig,
  player: Player | null = null,
): boolean {
  const matched = findLegalMove(state.board, chessMove);
  if (!matched) return false;
  if (!isCaptureMove(matched) || matched.isKingsideCastle() || matched.isQueensideCastle()) return false;

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
  if (!classify(player, sport).has(capturedType)) return false;
  return lineupStillCompletable([...current, player], sport, cap);
}

// Applies a capturing move -- always legal, whenever `chessMove` itself is
// a legal, non-castling capture (RULES.md "Captures"). If the captured
// piece has lock history, the captured player transfers to the capturing
// side's pick UNLESS that would overflow its roster/salary, in which case
// the captured player instead leaves the opposing side and returns to the
// pool, available to either side -- the capturing piece locks no one. If
// the captured piece never moved, `player` (the capturing side's own
// candidate of that piece's real chess type) transfers in the same way if
// given and it fits; with no `player`, or one that doesn't fit, the
// capture still happens but locks no one. Throws only for a genuine
// misuse: `chessMove` isn't a legal, non-castling capture right now, or a
// never-moved capture's `player` doesn't classify as the captured piece's
// type or is already locked.
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
  if (!isCaptureMove(matched)) {
    throw new Error(`${JSON.stringify(chessMove)} is not a capture; use applyMove()`);
  }

  const side = sideToMove(state.board);
  const san = matched.san;
  const square = capturedSquare(matched);
  const capturedHistory = state.pieceLocks.get(square) ?? [];
  let captured: Player | null;
  let lockedPiece: Piece;
  if (capturedHistory.length > 0) {
    // A transfer keeps the captured player's own prior identity -- the
    // piece whichever earlier move actually locked them with, not a
    // fresh classify() (which, now that pools overlap, could name a
    // DIFFERENT piece than the one they were really picked as).
    captured = capturedHistory[capturedHistory.length - 1];
    lockedPiece = [...state.whiteMoves, ...state.blackMoves].find((m) => m.player.id === captured!.id)!.piece;
  } else {
    const capturedType = pieceForChessType(matched.captured!);
    if (player !== null) {
      if (!classify(player, sport).has(capturedType)) {
        throw new Error(`${player.name} does not classify as ${capturedType}`);
      }
      if (state.lockedPlayerIds.has(player.id)) {
        throw new Error(`${player.name} is already locked`);
      }
    }
    captured = player;
    lockedPiece = capturedType;
  }

  const cap = contest.effectiveCap(sport);
  const current = movesFor(state, side).map((m) => m.player);
  const fits = captured !== null && lineupStillCompletable([...current, captured], sport, cap);

  const newBoard = cloneBoard(state.board);
  newBoard.move({ from: chessMove.from, to: chessMove.to, promotion: chessMove.promotion });

  const newPieceLocks = new Map(state.pieceLocks);
  const moverHistory = newPieceLocks.get(chessMove.from) ?? [];
  newPieceLocks.delete(chessMove.from);
  if (square !== chessMove.to) {
    newPieceLocks.delete(square);
  }
  // Bug fix: the capturing piece's own lock history follows IT to its new
  // square, in BOTH branches below -- never the captured player's, even
  // when that capture fits and transfers. A capture never locks a new
  // player for the capturing piece itself (RULES.md "Captures": "the
  // capturing piece locks no one"), so its own history can't gain an
  // entry here; `captured` is tracked entirely via `moves`/`locked`
  // below instead. Previously this set `[...moverHistory, captured!]`
  // when `fits` -- conflating the capturing piece's own identity with the
  // captured player's at the SAME square. That stray entry then silently
  // became "the most recently locked player" for a LATER capture of that
  // same square (recapture), handing the wrong player to the wrong side
  // -- e.g. 5. Bxc6 (fits) dxc6 used to transfer the knight captured on
  // move 5 back out, instead of the bishop's own pick from move 4.
  newPieceLocks.set(chessMove.to, moverHistory);

  let moves: Move[];
  let locked: Set<string>;
  if (fits) {
    const moveRecord = new Move({ side, piece: lockedPiece, san, player: captured! });
    moves = [...movesFor(state, side), moveRecord];
    locked = new Set(state.lockedPlayerIds);
    locked.add(captured!.id);
  } else {
    // A historied `captured` leaves the opposing side's roster and
    // returns to the pool (no longer locked); an unmoved capture's
    // `captured` (missing, or given but not a fit) was never locked, so
    // there's nothing to remove.
    moves = movesFor(state, side);
    locked = new Set(state.lockedPlayerIds);
    if (captured !== null) locked.delete(captured.id);
  }

  const opposingSide = otherSide(side);
  const opponentMoves =
    captured !== null ? movesFor(state, opposingSide).filter((m) => m.player.id !== captured!.id) : movesFor(state, opposingSide);

  return new BuildState({
    board: newBoard,
    whiteMoves: side === Side.WHITE ? moves : opponentMoves,
    blackMoves: side === Side.BLACK ? moves : opponentMoves,
    lockedPlayerIds: locked,
    pieceLocks: newPieceLocks,
    blackCommittedLine: state.blackCommittedLine,
    blackBlueprint: state.blackBlueprint,
    whiteCastled: state.whiteCastled,
    blackCastled: state.blackCastled,
  });
}

// Pushes `chessMove` without locking any player -- for a side whose lineup
// is already complete (RULES.md: "If Black's lineup fills first, Black's
// board moves lock no player"). Must be neither a capture nor castling:
// both inherently lock a player (a transferred capture would overflow an
// already-full roster; castling always locks King + Rook), so neither
// makes sense once nobody is being drafted this move.
export function pushSilentMove(state: BuildState, chessMove: ChessMove): BuildState {
  const matched = findLegalMove(state.board, chessMove);
  if (!matched) {
    throw new Error(`illegal move: ${JSON.stringify(chessMove)}`);
  }
  if (isCaptureMove(matched)) {
    throw new Error(`${JSON.stringify(chessMove)} is a capture; a silent move cannot be`);
  }
  if (matched.isKingsideCastle() || matched.isQueensideCastle()) {
    throw new Error(`${JSON.stringify(chessMove)} is castling; a silent move cannot be`);
  }

  const side = sideToMove(state.board);
  const newBoard = cloneBoard(state.board);
  newBoard.move({ from: chessMove.from, to: chessMove.to, promotion: chessMove.promotion });

  const newPieceLocks = new Map(state.pieceLocks);
  const history = newPieceLocks.get(chessMove.from);
  newPieceLocks.delete(chessMove.from);
  if (history !== undefined) {
    newPieceLocks.set(chessMove.to, history);
  }

  const moves = movesFor(state, side);
  return withBoardState(state, side, moves, state.lockedPlayerIds, newBoard, newPieceLocks);
}
