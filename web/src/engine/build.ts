// Turn flow: White's move always comes from the caller; Black's is
// generated here. Randomness only ever flows through an injected
// SeededRandom (see rng.ts) -- nothing in this module touches a shared
// PRNG instance. Ported from dfs_chess/build.py in full.
//
// The build ends when White's lineup is complete (RULES.md), regardless of
// Black's. Black's lineup must always stay completable (enforced per-move,
// same as White's, via isLegalMove/lineupStillCompletable) but need not be
// finished. Once Black's lineup IS full, Black's board moves lock no
// player (RULES.md) -- see rules.ts's pushSilentMove.
//
// Outside an explicit template (RULES.md "Opening templates"), Black
// commits to one full book line at a time -- among every line matching
// the moves so far, the one whose family (openings.splitFamily's first
// element) rank is closest to the contest's target rank (openings.
// rankFamilies, ContestConfig.targetRank -- an unranked family counts as
// farthest), ties broken by a seeded random choice -- and plays that line
// exactly for as long as it keeps matching (see playBlackMove,
// BuildState.blackCommittedLine). Once no book line matches, or there's
// nothing left to commit to, Black asks its injected `BlackEngine` (see
// blackEngine.ts) for its top candidates, drops any that fail the DFS rules
// for Black (not completable), and plays a seeded choice among whatever's
// left within 50cp of the best of those (chooseAmongSound) -- falling back
// to any legal move, chosen uniformly, if the engine has no opinion (the
// default `noEngine`) or none of its candidates survive filtering. This is
// a deliberate TS-only divergence from the Python engine, which has no
// engine dependency and always falls back to the uniform-random choice --
// parity.test.ts's fixture harness never exercises playBlackMove's
// free-play branch at all (every scenario there is constructed to be
// deterministic), so there's nothing to reconcile there; this is simply out
// of scope for parity by construction.
//
// A capture is its own category: the captured player IS the move's pick.
// If the captured piece has no lock history -- it never moved -- there's
// nothing to transfer, so Black instead picks same as any other pick (see
// chooseBlueprintPlayer below); a candidate move resolves to null (same as
// any other unplayable move) only when no eligible player exists. Once
// Black's lineup is full, captures and castling are excluded outright too,
// since both inherently lock a player and Black isn't drafting anymore.
//
// Rule change "Sim 5": Black's PLAYER pick within whichever piece band a
// (non-silent) move requires -- including castling's King/Rook steps and
// an unmoved-piece capture, and (see SetupScreen.tsx) Black's QB at setup
// -- is drafted from a BLUEPRINT: one lineup from the contest tier's own
// built field (fieldCacheStore's SimulatedField, resolveCachedField'd
// against the tier the same way BuildScreen's own sim already does),
// chosen by seeded random so it contains every player Black has already
// locked and none of White's. Each pick then takes whichever blueprint
// player is eligible/available/completable for that piece (pickList/
// castleRookList/castleQbCandidates already computed exactly that,
// sorted) -- see chooseBlueprintPlayer. The blueprint is re-drawn (next
// seeded draw, same containment rules, restricted to field lineups that
// have a qualifying player for the pick at hand) once it's no longer
// usable: a blueprint player got taken by White, or no blueprint player
// fits this particular piece. With no field built for the tier, or no
// field lineup qualifies at all (even after a redraw), Black falls back
// to the pre-Sim-5 rule: top of the piece's own (capped) list -- see
// `pick`'s default below, threaded through bestLegalPlayer/
// bestLegalCapturePlayer/bestLegalCastlePlayers. This only ever runs for
// Black's own ACTUAL pick (playBlackMove/playBlackTemplateMove's commit
// call) -- every feasibility PROBE elsewhere in this module (
// checkWhiteDeadEnd, moveIsCompletable, playableContinuations, the
// free-play candidate filter) calls resolvePlayers with no `pick`
// override at all, so it never touches the field/rng and stays exactly
// as deterministic/side-effect-free as before this rule change.

import type { Move as ChessJsMove } from "chess.js";
import {
  chooseAmongSound,
  ENGINE_MOVE_TIME_MS,
  ENGINE_MULTIPV,
  noEngine,
  type BlackEngine,
  type EngineCandidate,
} from "./blackEngine";
import type { ContestConfig } from "./config";
import { BuildState, KingMode, Piece, Player, Side } from "./models";
import type { BookLine } from "./openings";
import { bookContinuations, openingName, splitFamily } from "./openings";
import { castleQbCandidates, castleRookList, pickList } from "./picklist";
import { pieceForChessType } from "./pieces";
import type { ChessMove } from "./rules";
import {
  applyCaptureMove,
  applyMove,
  canCastle,
  capturedSquare,
  castle,
  findLegalMove,
  isCaptureMove,
  isLegalCapture,
  isLegalMove,
  isLineupComplete,
  lockedQbTeam,
  openRosterSlots,
  pushSilentMove,
} from "./rules";
import { SeededRandom } from "./rng";
import type { SimulatedField } from "./sim/field";
import type { SportConfig } from "./sport";

export const HAPPY_HUNTING = "Happy Hunting";
export const NO_LEGAL_MOVES = "No legal moves";

// Bug fix: playBlackMove's one deliberate "Black genuinely has no legal
// (chess-AND-DFS) move" signal -- a dedicated subclass, not a plain Error,
// so a caller (BuildScreen) can tell a real dead end apart from any OTHER
// exception (a book/data inconsistency, a future engine bug, ...) without
// fragile string-matching on `.message`. Only ever thrown from the "no
// book line to commit to, and no legal move resolves at all" branch below
// -- every other failure propagates as whatever it actually is.
export class NoLegalBlackMoveError extends Error {
  constructor() {
    super("Black has no legal move available");
    this.name = "NoLegalBlackMoveError";
  }
}

export interface MoveResultFields {
  state: BuildState;
  opening: string | null;
  message: string | null; // HAPPY_HUNTING, NO_LEGAL_MOVES, or null (build still ongoing)
  openSlots?: Record<string, number> | null; // populated only for NO_LEGAL_MOVES
  // True only for a playBlackMove call where a real engine was actually
  // consulted (no committed book line) AND it genuinely failed (threw --
  // see chooseEngineMove) -- Black still played a legal, DFS-sound move
  // (the uniform-random fallback), but the caller/UI may want to say so.
  // False for every other MoveResult (playWhiteMove, playBlackTemplateMove,
  // checkWhiteDeadEnd never touch the engine at all; a committed book line
  // skips it too; `noEngine`'s own "no opinion" isn't a failure either).
  engineFailed?: boolean;
}

export class MoveResult {
  readonly state: BuildState;
  readonly opening: string | null;
  readonly message: string | null;
  readonly openSlots: Record<string, number> | null;
  readonly engineFailed: boolean;

  constructor(fields: MoveResultFields) {
    this.state = fields.state;
    this.opening = fields.opening;
    this.message = fields.message;
    this.openSlots = fields.openSlots ?? null;
    this.engineFailed = fields.engineFailed ?? false;
  }
}

// The full build's SAN move list in order -- chess.js already tracks this
// on the board itself (unlike python-chess, whose move_stack holds Move
// objects, not SAN; Python's san_history replays them through a second
// board to get SAN strings), so this is just a thin alias over
// `board.history()` rather than a replay loop.
function sanHistory(board: BuildState["board"]): readonly string[] {
  return board.history();
}

function isBuildOver(state: BuildState, sport: SportConfig): boolean {
  return isLineupComplete(state.whiteMoves.map((m) => m.player), sport);
}

function currentPlayersFor(state: BuildState, side: Side): Player[] {
  return (side === Side.WHITE ? state.whiteMoves : state.blackMoves).map((m) => m.player);
}

// Which of an already eligible/available/completable, sorted candidate
// list (pickList/castleRookList/castleQbCandidates's own output) a pick
// actually takes -- `candidates` is never empty when this is called.
// Every probing call site (see module comment above) leaves this at its
// default, the pre-Sim-5 rule (RULES.md: "Black ... picks the top of the
// moved piece's (capped) list"); only playBlackMove/playBlackTemplateMove's
// own commit call overrides it with a blueprint-aware chooser (see
// chooseBlueprintPlayer below).
type PlayerPicker = (candidates: readonly Player[]) => Player;
const TOP_OF_LIST: PlayerPicker = (candidates) => candidates[0];

// The `pick`-chosen player of `piece`'s own pick list for which `chessMove`
// is actually legal (see PlayerPicker above).
function bestLegalPlayer(
  chessMove: ChessMove,
  piece: Piece,
  state: BuildState,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  pick: PlayerPicker = TOP_OF_LIST,
): Player | null {
  const side = state.board.turn() === "w" ? Side.WHITE : Side.BLACK;
  const current = currentPlayersFor(state, side);
  const qbTeam = lockedQbTeam(state, side);
  const candidates = pickList(piece, playersPool, state.lockedPlayerIds, current, sport, contest, qbTeam).filter(
    (player) => isLegalMove(state, chessMove, player, sport, contest),
  );
  return candidates.length > 0 ? pick(candidates) : null;
}

// The `pick`-chosen player of `capturedType`'s own pick list for which
// `chessMove` -- a capture of a piece with no lock history, i.e. it never
// moved -- is actually legal right now (see PlayerPicker above).
function bestLegalCapturePlayer(
  chessMove: ChessMove,
  capturedType: Piece,
  state: BuildState,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  pick: PlayerPicker = TOP_OF_LIST,
): Player | null {
  const side = state.board.turn() === "w" ? Side.WHITE : Side.BLACK;
  const current = currentPlayersFor(state, side);
  const qbTeam = lockedQbTeam(state, side);
  const candidates = pickList(capturedType, playersPool, state.lockedPlayerIds, current, sport, contest, qbTeam).filter(
    (player) => isLegalCapture(state, chessMove, sport, contest, player),
  );
  return candidates.length > 0 ? pick(candidates) : null;
}

// [King, Rook] in EMERGE mode, or [Rook] in PLACED mode (castling locks
// only the Rook there) -- each the `pick`-chosen player of its own pick
// list (RULES.md: "Only offer QBs with at least one eligible teammate ...
// If none, castling is illegal"; see PlayerPicker above).
function bestLegalCastlePlayers(
  state: BuildState,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  kingMode: KingMode = KingMode.EMERGE,
  pick: PlayerPicker = TOP_OF_LIST,
): Player[] | null {
  const side = state.board.turn() === "w" ? Side.WHITE : Side.BLACK;
  if (!canCastle(state, side, kingMode)) return null;

  const current = currentPlayersFor(state, side);
  const locked = state.lockedPlayerIds;

  if (kingMode === KingMode.PLACED) {
    const qbTeam = lockedQbTeam(state, side);
    if (qbTeam === null) return null; // no locked QB to restrict the castling Rook to
    const rooks = castleRookList(playersPool, locked, current, sport, contest, qbTeam);
    return rooks.length > 0 ? [pick(rooks)] : null;
  }

  const kings = castleQbCandidates(playersPool, locked, current, sport, contest);
  if (kings.length === 0) return null;
  const king = pick(kings);
  const lockedWithKing = new Set(locked);
  lockedWithKing.add(king.id);
  const rooks = castleRookList(playersPool, lockedWithKing, [...current, king], sport, contest, king.team);
  return rooks.length > 0 ? [king, pick(rooks)] : null;
}

// The player(s) `chessMove` would lock -- one, or two for castling in
// EMERGE mode (King + Rook, per RULES.md), one for castling in PLACED mode
// (Rook only), one for a capture (the captured player IS the pick,
// regardless of which piece did the capturing), or zero for a plain
// (non-capturing, non-castling) King move in PLACED mode (RULES.md "King
// modes": "later King moves lock no player") -- or null if no legal,
// unlocked candidate (or no legal capture) exists, i.e. this move isn't
// playable at all right now. A capture is always resolvable (never null):
// a captured piece with lock history resolves to the captured player
// (applyCaptureMove decides whether that's a transfer or a return-to-pool
// once applied); one with no lock history -- it never moved -- resolves
// to the best eligible player of that piece's own real chess type, or an
// empty array if none fits (RULES.md "Captures": still legal, locks no
// one).
function resolvePlayers(
  state: BuildState,
  chessMove: ChessMove,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  kingMode: KingMode = KingMode.EMERGE,
  pick: PlayerPicker = TOP_OF_LIST,
): Player[] | null {
  const matched = findLegalMove(state.board, chessMove);
  if (!matched) return null;

  if (matched.isKingsideCastle() || matched.isQueensideCastle()) {
    return bestLegalCastlePlayers(state, sport, contest, playersPool, kingMode, pick);
  }
  if (isCaptureMove(matched)) {
    const square = capturedSquare(matched);
    const capturedHistory = state.pieceLocks.get(square) ?? [];
    if (capturedHistory.length > 0) {
      return [capturedHistory[capturedHistory.length - 1]];
    }
    const capturedType = pieceForChessType(matched.captured!);
    const player = bestLegalCapturePlayer(chessMove, capturedType, state, sport, contest, playersPool, pick);
    return player === null ? [] : [player];
  }
  const piece = pieceForChessType(matched.piece);
  if (kingMode === KingMode.PLACED && piece === Piece.KING) return [];
  const player = bestLegalPlayer(chessMove, piece, state, sport, contest, playersPool, pick);
  return player === null ? null : [player];
}

// Applies `chessMove` given the player(s) resolvePlayers already resolved
// for it: castling (1 player in PLACED mode, just the Rook; 2 in EMERGE
// mode, King + Rook), a capture (`players` holds the captured player when
// there's lock history to transfer -- applyCaptureMove re-derives that
// itself and ignores it -- the chosen replacement player when the
// captured piece never moved but one fits, or empty when none does;
// either way applyCaptureMove decides transfer/pick vs.
// return-to-pool/locks-no-one on its own), a silent King move (empty --
// PLACED mode only), or an ordinary single-player lock.
function applyResolvedPlayers(
  state: BuildState,
  chessMove: ChessMove,
  players: readonly Player[],
  sport: SportConfig,
  contest: ContestConfig,
  kingMode: KingMode,
): BuildState {
  const matched = findLegalMove(state.board, chessMove)!;
  if (matched.isKingsideCastle() || matched.isQueensideCastle()) {
    if (kingMode === KingMode.PLACED) {
      const [rook] = players;
      return castle(state, chessMove, null, rook, sport, contest, kingMode);
    }
    const [king, rook] = players;
    return castle(state, chessMove, king, rook, sport, contest, kingMode);
  }
  if (isCaptureMove(matched)) {
    const player = players.length > 0 ? players[0] : null;
    return applyCaptureMove(state, chessMove, sport, contest, player);
  }
  if (players.length === 0) {
    return pushSilentMove(state, chessMove);
  }
  const [player] = players;
  return applyMove(state, chessMove, player, sport, contest);
}

// If White (to move) has no legal (chess move, eligible player) combination
// at all, ends the build early: White's lineup stays incomplete, and
// `message` is NO_LEGAL_MOVES with `openSlots` naming what's still unfilled
// (RULES.md: no "Happy Hunting" in that case). Returns null if White still
// has at least one legal move -- the caller should proceed normally
// (prompt for it, apply it via playWhiteMove).
export function checkWhiteDeadEnd(
  state: BuildState,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  kingMode: KingMode = KingMode.EMERGE,
): MoveResult | null {
  if (state.board.turn() !== "w") {
    throw new Error("it is not White's turn");
  }

  for (const move of state.board.moves({ verbose: true })) {
    const chessMove: ChessMove = { from: move.from, to: move.to, promotion: move.promotion };
    if (resolvePlayers(state, chessMove, sport, contest, playersPool, kingMode) !== null) {
      return null;
    }
  }

  const openSlots = openRosterSlots(state.whiteMoves.map((m) => m.player), sport.rosterSlots);
  return new MoveResult({ state, opening: null, message: NO_LEGAL_MOVES, openSlots });
}

// Whether some eligible, unlocked, roster/salary-feasible player exists for
// `chessMove` right now, for whichever side is on the board -- the same
// feasibility playWhiteMove/playBlackMove themselves rely on. A silent King
// move (PLACED mode) counts as completable too -- it locks no one, but it's
// still playable.
export function moveIsCompletable(
  state: BuildState,
  chessMove: ChessMove,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  kingMode: KingMode = KingMode.EMERGE,
): boolean {
  return resolvePlayers(state, chessMove, sport, contest, playersPool, kingMode) !== null;
}

// Whether Black could actually play `chessMove` right now. Once Black's
// lineup is full, that's just "not a capture and not castling" (both
// inherently lock a player); otherwise it's "a legal, unlocked player
// exists for the piece band" (moveIsCompletable, which also covers PLACED
// mode's silent King moves, and a capture of a piece that never moved, via
// the same placeholder pick as any other move).
function isMovePlayableForBlack(
  chessMove: ChessMove,
  state: BuildState,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  blackIsFull: boolean,
  kingMode: KingMode = KingMode.EMERGE,
): boolean {
  if (blackIsFull) {
    const matched = findLegalMove(state.board, chessMove);
    if (!matched) return false;
    return !(isCaptureMove(matched) || matched.isKingsideCastle() || matched.isQueensideCastle());
  }
  return moveIsCompletable(state, chessMove, sport, contest, playersPool, kingMode);
}

// `continuations` restricted to the ones Black can actually play -- see
// isMovePlayableForBlack.
function playableContinuations(
  state: BuildState,
  continuations: ReadonlySet<string>,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  blackIsFull: boolean,
  kingMode: KingMode = KingMode.EMERGE,
): Set<string> {
  const playable = new Set<string>();
  for (const san of continuations) {
    const matched = state.board.moves({ verbose: true }).find((m) => m.san === san);
    if (!matched) {
      throw new Error(`"${san}" is not a legal move on the current position`);
    }
    const chessMove: ChessMove = { from: matched.from, to: matched.to, promotion: matched.promotion };
    if (isMovePlayableForBlack(chessMove, state, sport, contest, playersPool, blackIsFull, kingMode)) {
      playable.add(san);
    }
  }
  return playable;
}

function isPrefixMatch(lineMoves: readonly string[], movesSoFar: readonly string[]): boolean {
  return movesSoFar.every((move, i) => lineMoves[i] === move);
}

// A full book line matching `movesSoFar`, chosen among every matching line
// whose *next* move Black could actually play right now -- the one whose
// family (openings.splitFamily's first element, looked up in
// `familyRanks`) rank is closest to `targetRank`; a family missing from
// `familyRanks` (unranked, e.g. King's Pawn Game) counts as farthest --
// never preferred over any ranked family -- ties (including "every
// matching line's family is unranked") broken by a seeded random choice.
// Returns null if no line qualifies. Black then plays that whole line
// exactly while it keeps matching (see playBlackMove) -- RULES.md "Opening
// templates": "Black outside a template ... commit to it and play it
// exactly."
function chooseBlackCommittedLine(
  movesSoFar: readonly string[],
  state: BuildState,
  book: readonly BookLine[],
  familyRanks: Readonly<Record<string, number>>,
  targetRank: number,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  blackIsFull: boolean,
  rng: SeededRandom,
  kingMode: KingMode = KingMode.EMERGE,
): readonly string[] | null {
  const depth = movesSoFar.length;
  const continuations = bookContinuations(movesSoFar, book);
  const playable = playableContinuations(state, continuations, sport, contest, playersPool, blackIsFull, kingMode);
  if (playable.size === 0) return null;

  const matchingLines = book.filter(
    (line) => line.moves.length > depth && isPrefixMatch(line.moves, movesSoFar) && playable.has(line.moves[depth]),
  );
  if (matchingLines.length === 0) return null;

  function rankDistance(line: BookLine): number {
    const [family] = splitFamily(line.name);
    const rank = familyRanks[family];
    return rank === undefined ? Infinity : Math.abs(rank - targetRank);
  }

  const distances = matchingLines.map(rankDistance);
  const minDistance = Math.min(...distances);
  const closest = matchingLines.filter((_, i) => distances[i] === minDistance);
  return rng.choice(closest).moves;
}

// Applies the caller-chosen White move. `whiteRook` is required iff
// `whiteMove` is castling (King + Rook, locked together in EMERGE mode --
// `whitePlayer` is the King then). In PLACED king mode, castling locks
// only the Rook; `whitePlayer` is ignored for that call (the caller may
// pass the side's already-locked King as a harmless placeholder). A plain
// (non-castling) King move in PLACED mode locks no one at all ("later King
// moves lock no player") -- the caller is expected to route that case to
// rules.ts's pushSilentMove directly rather than here, since there's no
// player to supply. A capture whose captured piece has lock history also
// needs no `whitePlayer` at all -- the captured player IS the pick, so
// there's nothing the caller could have prompted for; pass null. A capture
// of a piece that never moved does need `whitePlayer`: the capturing
// side's own pick of that piece's real chess type, prompted for same as
// any other pick.
export function playWhiteMove(
  state: BuildState,
  whiteMove: ChessMove,
  whitePlayer: Player | null,
  sport: SportConfig,
  contest: ContestConfig,
  book: readonly BookLine[],
  whiteRook: Player | null = null,
  kingMode: KingMode = KingMode.EMERGE,
): MoveResult {
  const matched = findLegalMove(state.board, whiteMove);
  if (!matched) {
    throw new Error(`illegal move: ${JSON.stringify(whiteMove)}`);
  }

  let newState: BuildState;
  if (matched.isKingsideCastle() || matched.isQueensideCastle()) {
    if (whiteRook === null) {
      throw new Error("whiteMove is castling; whiteRook is required too");
    }
    const king = kingMode === KingMode.EMERGE ? whitePlayer : null;
    newState = castle(state, whiteMove, king, whiteRook, sport, contest, kingMode);
  } else if (isCaptureMove(matched)) {
    newState = applyCaptureMove(state, whiteMove, sport, contest, whitePlayer);
  } else {
    if (whitePlayer === null) {
      throw new Error("whiteMove is not castling or a capture; whitePlayer is required");
    }
    newState = applyMove(state, whiteMove, whitePlayer, sport, contest);
  }

  const opening = openingName(sanHistory(newState.board), book);
  const message = isBuildOver(newState, sport) ? HAPPY_HUNTING : null;
  return new MoveResult({ state: newState, opening, message });
}

function moveKey(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

// Asks `engine` for Black's out-of-book move among `dfsLegalCandidates`
// (already filtered to whatever's both chess-legal and DFS-sound for Black
// right now -- see playBlackMove). Engine candidates outside that allow-list
// (the engine knows nothing about DFS/roster rules) are dropped before
// chooseAmongSound ever sees them. `move` is null -- the caller's cue to
// fall back to a uniform-random choice among `dfsLegalCandidates` -- if the
// engine has no opinion at all (the default `noEngine`, not a failure) or
// none of its candidates survive the allow-list filter (also not a
// failure: the engine answered fine, its answer just wasn't usable).
// `engineFailed` is true only for the other case, a genuine failure (a
// real Stockfish worker that errors, never responds, or never loads at
// all) -- `engine.analyze` throwing -- distinct from both of the above so
// the caller/UI can tell "the engine had nothing good to say" apart from
// "the engine is broken."
interface EngineMoveResult {
  move: ChessMove | null;
  engineFailed: boolean;
}

async function chooseEngineMove(
  state: BuildState,
  dfsLegalCandidates: readonly ChessJsMove[],
  rng: SeededRandom,
  engine: BlackEngine,
): Promise<EngineMoveResult> {
  let engineCandidates: readonly EngineCandidate[];
  try {
    engineCandidates = await engine.analyze(state.board.fen(), ENGINE_MULTIPV, ENGINE_MOVE_TIME_MS);
  } catch {
    return { move: null, engineFailed: true };
  }

  const legalKeys = new Set(dfsLegalCandidates.map(moveKey));
  const sound = engineCandidates.filter((c) => legalKeys.has(moveKey(c.move)));
  return { move: chooseAmongSound(sound, rng)?.move ?? null, engineFailed: false };
}

// Rule change "Sim 5": one Black pick, drafted from `field` instead of
// `candidates`' own top (see module comment above) -- `candidates` is
// always non-empty (whichever pickList/castleRookList/castleQbCandidates
// call produced it). `currentBlueprint` is the already-committed blueprint
// lineup (null to draw fresh); `blackLockedIds`/`whiteLockedIds` are each
// side's own currently-locked player ids, snapshotted BEFORE this pick (a
// castling King+Rook pair's own two calls reuse the same snapshot -- the
// King just chosen within this same castle doesn't retroactively change
// what "already locked" meant when the blueprint was drawn).
//
// Falls back to `candidates[0]` (the pre-Sim-5 rule) whenever there's no
// field to draft from at all, or no field lineup -- even a freshly (re-)
// drawn one -- has a player who's actually in `candidates`; the returned
// `blueprint` is null in both of those cases too, so the NEXT pick starts
// over rather than reusing a blueprint that never actually matched.
export interface BlueprintDraw {
  readonly player: Player;
  readonly blueprint: readonly Player[] | null;
}

export function chooseBlueprintPlayer(
  candidates: readonly Player[],
  field: SimulatedField | null,
  blackLockedIds: ReadonlySet<string>,
  whiteLockedIds: ReadonlySet<string>,
  currentBlueprint: readonly Player[] | null,
  rng: SeededRandom,
): BlueprintDraw {
  if (field === null || field.lineups.length === 0) {
    return { player: candidates[0], blueprint: null };
  }

  let blueprint = currentBlueprint;
  if (blueprint !== null && blueprint.some((p) => whiteLockedIds.has(p.id))) {
    blueprint = null; // invalid: White took one of the blueprint's players
  }
  if (blueprint !== null) {
    const blueprintIds = new Set(blueprint.map((p) => p.id));
    const match = candidates.find((p) => blueprintIds.has(p.id));
    if (match !== undefined) return { player: match, blueprint };
    blueprint = null; // invalid: no blueprint player qualifies for this pick -- redraw
  }

  const qualifyingLineups = field.lineups.filter((lineup) => {
    const ids = new Set(lineup.map((p) => p.id));
    for (const id of blackLockedIds) if (!ids.has(id)) return false;
    for (const id of whiteLockedIds) if (ids.has(id)) return false;
    return candidates.some((p) => ids.has(p.id)); // only redraw among lineups with a qualifying player for THIS pick
  });
  if (qualifyingLineups.length === 0) {
    return { player: candidates[0], blueprint: null }; // fallback: no field lineup qualifies
  }

  const drawn = rng.choice(qualifyingLineups);
  const drawnIds = new Set(drawn.map((p) => p.id));
  const match = candidates.find((p) => drawnIds.has(p.id))!; // guaranteed by the qualifies filter above
  return { player: match, blueprint: drawn };
}

// Generates and applies Black's move. Outside an explicit template
// (RULES.md "Opening templates"), Black commits to one full book line at a
// time -- chosen among every line matching the moves so far, the one whose
// family rank is closest to `targetRank`, excluding any whose next move
// Black can't actually play -- and plays that line exactly for as long as
// it keeps matching (state.blackCommittedLine). Black re-chooses only once
// that line runs out or White's own move no longer matches it; with no line
// to commit to at all, `engine` (see blackEngine.ts; defaults to `noEngine`,
// i.e. no engine at all) is asked for its top candidates, any that aren't
// DFS-sound for Black are dropped, and a seeded choice is made among
// whatever's left within 50cp of the best of those -- or, failing all of
// that, any legal move, chosen uniformly, exactly as before this had an
// engine at all. Locks a player normally, unless Black's lineup is already
// full, in which case the move is pushed silently (see module comment
// above). Async solely because `engine.analyze` is -- every other branch
// resolves synchronously underneath the returned promise. `field` (Rule
// change "Sim 5"; defaults to null, the pre-Sim-5 behavior for every
// caller that doesn't pass one) is the contest tier's own built field --
// see chooseBlueprintPlayer and the module comment above for how Black's
// actual PLAYER pick drafts from it.
export async function playBlackMove(
  state: BuildState,
  book: readonly BookLine[],
  familyRanks: Readonly<Record<string, number>>,
  targetRank: number,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  rng: SeededRandom,
  kingMode: KingMode = KingMode.EMERGE,
  engine: BlackEngine = noEngine,
  field: SimulatedField | null = null,
): Promise<MoveResult> {
  if (state.board.turn() !== "b") {
    throw new Error("it is not Black's turn");
  }

  const blackIsFull = isLineupComplete(state.blackMoves.map((m) => m.player), sport);
  const movesSoFar = sanHistory(state.board);
  const depth = movesSoFar.length;

  let committed = state.blackCommittedLine;
  if (committed !== null) {
    if (depth >= committed.length || !isPrefixMatch(committed, movesSoFar)) {
      committed = null; // the line ran out, or White's own move left it
    } else {
      const matched = state.board.moves({ verbose: true }).find((m) => m.san === committed![depth]);
      if (!matched) {
        throw new Error(`"${committed[depth]}" is not a legal move on the current position`);
      }
      const chessMove: ChessMove = { from: matched.from, to: matched.to, promotion: matched.promotion };
      if (!isMovePlayableForBlack(chessMove, state, sport, contest, playersPool, blackIsFull, kingMode)) {
        committed = null; // no longer playable here -- re-choose below
      }
    }
  }

  if (committed === null) {
    committed = chooseBlackCommittedLine(
      movesSoFar,
      state,
      book,
      familyRanks,
      targetRank,
      sport,
      contest,
      playersPool,
      blackIsFull,
      rng,
      kingMode,
    );
  }

  let chessMove: ChessMove | null = null;
  let engineFailed = false;
  if (committed !== null) {
    const matched = state.board.moves({ verbose: true }).find((m) => m.san === committed![depth]);
    if (!matched) {
      throw new Error(`"${committed[depth]}" is not a legal move on the current position`);
    }
    chessMove = { from: matched.from, to: matched.to, promotion: matched.promotion };
  }

  if (chessMove === null) {
    // No book line to commit to at all: every DFS-sound legal move -- the
    // same allow-list the engine's own candidates get checked against
    // below, and the uniform-random fallback if none of those pass either
    // (including when the engine itself failed -- Black must never hang
    // waiting on a broken engine).
    const legalMoves = state.board.moves({ verbose: true });
    let candidates: ChessJsMove[];
    if (blackIsFull) {
      candidates = legalMoves.filter((m) => !isCaptureMove(m) && !m.isKingsideCastle() && !m.isQueensideCastle());
    } else {
      candidates = legalMoves.filter((m) => {
        const cm: ChessMove = { from: m.from, to: m.to, promotion: m.promotion };
        return resolvePlayers(state, cm, sport, contest, playersPool, kingMode) !== null;
      });
    }
    if (candidates.length === 0) {
      throw new NoLegalBlackMoveError();
    }

    const engineResult = await chooseEngineMove(state, candidates, rng, engine);
    chessMove = engineResult.move;
    engineFailed = engineResult.engineFailed;
    if (chessMove === null) {
      // RULES.md gives no other weighting signal for free play.
      const chosen = rng.choice(candidates);
      chessMove = { from: chosen.from, to: chosen.to, promotion: chosen.promotion };
    }
  }

  let newState: BuildState;
  if (blackIsFull) {
    newState = pushSilentMove(state, chessMove);
  } else {
    // Rule change "Sim 5": snapshotted once per actual pick, BEFORE this
    // move's own lock -- see chooseBlueprintPlayer's own header comment.
    const blackLockedIds = new Set(currentPlayersFor(state, Side.BLACK).map((p) => p.id));
    const whiteLockedIds = new Set(currentPlayersFor(state, Side.WHITE).map((p) => p.id));
    let blueprint = state.blackBlueprint;
    const pick: PlayerPicker = (candidates) => {
      const result = chooseBlueprintPlayer(candidates, field, blackLockedIds, whiteLockedIds, blueprint, rng);
      blueprint = result.blueprint;
      return result.player;
    };
    const players = resolvePlayers(state, chessMove, sport, contest, playersPool, kingMode, pick);
    if (players === null) {
      // chessMove was only ever chosen because this resolved -- either as
      // the committed line's next move (checked via isMovePlayableForBlack
      // just above) or as a pre-filtered candidate.
      throw new Error("internal error: resolved move unexpectedly has no players");
    }
    newState = applyResolvedPlayers(state, chessMove, players, sport, contest, kingMode);
    newState.blackBlueprint = blueprint;
  }

  newState.blackCommittedLine = committed;
  const opening = openingName(sanHistory(newState.board), book);
  const message = isBuildOver(newState, sport) ? HAPPY_HUNTING : null;
  return new MoveResult({ state: newState, opening, message, engineFailed });
}

// Applies `chessMove` for Black exactly as given, in place of Black's usual
// book-weighted choice -- for template mode, where both sides mechanically
// play a user-chosen book line (RULES.md "Opening templates"). Player pick
// drafts from `field` the same way playBlackMove's own commit does (Rule
// change "Sim 5"; see chooseBlueprintPlayer and the module comment above),
// falling back to the pre-Sim-5 top-of-list rule when `field` is omitted
// (the default -- every existing caller); `book` is only for naming the
// resulting opening, same as everywhere else. Returns null if no eligible,
// unlocked, roster/salary-feasible player exists for `chessMove` right now
// (a template-mode "DFS-illegal" move) -- the caller should treat the
// template as ended here and fall back to Black's normal (playBlackMove)
// behavior for this turn. A plain King move in PLACED king mode always
// succeeds, locking no one ("later King moves lock no player").
export function playBlackTemplateMove(
  state: BuildState,
  chessMove: ChessMove,
  sport: SportConfig,
  contest: ContestConfig,
  playersPool: readonly Player[],
  book: readonly BookLine[],
  kingMode: KingMode = KingMode.EMERGE,
  field: SimulatedField | null = null,
  rng: SeededRandom = new SeededRandom(0),
): MoveResult | null {
  if (state.board.turn() !== "b") {
    throw new Error("it is not Black's turn");
  }

  const blackIsFull = isLineupComplete(state.blackMoves.map((m) => m.player), sport);
  let newState: BuildState;
  if (blackIsFull) {
    const matched = findLegalMove(state.board, chessMove);
    if (matched && (isCaptureMove(matched) || matched.isKingsideCastle() || matched.isQueensideCastle())) {
      return null;
    }
    newState = pushSilentMove(state, chessMove);
  } else {
    const blackLockedIds = new Set(currentPlayersFor(state, Side.BLACK).map((p) => p.id));
    const whiteLockedIds = new Set(currentPlayersFor(state, Side.WHITE).map((p) => p.id));
    let blueprint = state.blackBlueprint;
    const pick: PlayerPicker = (candidates) => {
      const result = chooseBlueprintPlayer(candidates, field, blackLockedIds, whiteLockedIds, blueprint, rng);
      blueprint = result.blueprint;
      return result.player;
    };
    const players = resolvePlayers(state, chessMove, sport, contest, playersPool, kingMode, pick);
    if (players === null) return null;
    newState = applyResolvedPlayers(state, chessMove, players, sport, contest, kingMode);
    newState.blackBlueprint = blueprint;
  }

  const opening = openingName(sanHistory(newState.board), book);
  const message = isBuildOver(newState, sport) ? HAPPY_HUNTING : null;
  return new MoveResult({ state: newState, opening, message });
}
