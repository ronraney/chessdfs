// Task 38: the build screen's move-first-then-pick flow -- UI-layer
// composition of already-exported engine primitives, same spirit as
// buildStats.ts. No new engine rules: "DFS-legal, offerable move" is just
// chess.js's own legal moves filtered by build.moveIsCompletable;
// "suggestion" is openings.bookContinuations/openingName, read from the
// chosen line or the book.
//
// Task 39 drops the capture/castling exclusion dfsLegalMoves used to apply
// ("not offered as legal targets" -- Task 38's own words for "next task
// adds them"): build.moveIsCompletable (via resolvePlayers) already
// correctly resolves both, so there was never an engine gap, just a UI-
// layer restriction. classifyMove is new here: the UI needs to know not
// just THAT a move is offerable but WHICH of five pick flows it drives
// (silent King move, ordinary single pick, an instant no-modal capture
// transfer, a capture-of-an-unmoved-piece pick, or castling) before it can
// decide what to show.
import type { Move as ChessJsMove } from "chess.js";
import { moveIsCompletable } from "./engine/build";
import type { ContestConfig } from "./engine/config";
import { KingMode, Piece, type BuildState, type Player } from "./engine/models";
import { bookContinuations, openingName, type BookLine } from "./engine/openings";
import { pieceForChessType } from "./engine/pieces";
import { capturedSquare, isCaptureMove, type ChessMove } from "./engine/rules";
import type { SportConfig } from "./engine/sport";
import type { ChosenOpening } from "./SetupScreen";

// Every legal chess move for the side to move that's DFS-legal: an
// eligible, unlocked, roster/salary-feasible player (or player pair, for
// castling) exists for it right now.
export function dfsLegalMoves(
  state: BuildState,
  sport: SportConfig,
  contest: ContestConfig,
  players: readonly Player[],
  kingMode: KingMode,
): ChessJsMove[] {
  return state.board.moves({ verbose: true }).filter((move) => {
    const chessMove: ChessMove = { from: move.from, to: move.to, promotion: move.promotion };
    return moveIsCompletable(state, chessMove, sport, contest, players, kingMode);
  });
}

export type MoveKind =
  | { kind: "silentKing" } // PLACED mode only -- "later King moves lock no player"
  | { kind: "ordinary"; piece: Piece }
  | { kind: "captureTransfer" } // the captured piece already moved -- its own locked player transfers, no pick needed
  | { kind: "captureUnmoved"; capturedPiece: Piece } // never moved -- the capturing side picks a player of ITS type
  | { kind: "castleEmerge" } // King + Rook, both newly locked
  | { kind: "castlePlaced" }; // Rook only -- the King is already locked from setup

// Which of the five pick flows `move` (an already-matched, legal chess.js
// move) drives, read off `state` as it stands right before the move --
// `isCaptureMove`/`capturedSquare` identify a capture; `state.pieceLocks`
// (checked at the captured square, before the move clears it) says whether
// there's a player to transfer or not.
export function classifyMove(state: BuildState, move: ChessJsMove, kingMode: KingMode): MoveKind {
  if (move.isKingsideCastle() || move.isQueensideCastle()) {
    return kingMode === KingMode.PLACED ? { kind: "castlePlaced" } : { kind: "castleEmerge" };
  }
  if (isCaptureMove(move)) {
    const square = capturedSquare(move);
    const history = state.pieceLocks.get(square) ?? [];
    if (history.length > 0) return { kind: "captureTransfer" };
    return { kind: "captureUnmoved", capturedPiece: pieceForChessType(move.captured!) };
  }
  const piece = pieceForChessType(move.piece);
  if (kingMode === KingMode.PLACED && piece === Piece.KING) return { kind: "silentKing" };
  return { kind: "ordinary", piece };
}

// The legal, verbose move matching a book line's SAN token on the current
// position, or null if it isn't legal here (shouldn't happen for a token
// that came from bookContinuations/a chosen line's own moves against a
// position that still matches its prefix, but a caller resolving an
// arbitrary SAN should still check).
export function chessMoveForSan(state: BuildState, san: string): ChessJsMove | null {
  return state.board.moves({ verbose: true }).find((m) => m.san === san) ?? null;
}

function isPrefixOf(moves: readonly string[], line: readonly string[]): boolean {
  return moves.every((move, i) => line[i] === move);
}

export type Suggestion =
  | { kind: "none" }
  | { kind: "onLine"; move: string; lineName: string }
  | { kind: "offLine"; options: readonly { move: string; name: string }[] };

// "Play your own opening" suggests nothing at all. Otherwise: if the
// current position is still a prefix of the chosen line, its next move is
// THE suggestion; once White has left it (or it's run out), the book's own
// continuations from here take over, each labeled by whichever opening
// that one move leads toward -- openingName at one ply deeper, same
// "longest matching line" rule used everywhere else. No continuations at
// all (truly out of book) means no suggestion -- free play.
export function suggestionFor(
  movesSoFar: readonly string[],
  chosenOpening: ChosenOpening,
  book: readonly BookLine[],
): Suggestion {
  if (chosenOpening.kind === "own") return { kind: "none" };

  const line = chosenOpening.line;
  const depth = movesSoFar.length;
  if (depth < line.moves.length && isPrefixOf(movesSoFar, line.moves)) {
    return { kind: "onLine", move: line.moves[depth], lineName: line.name };
  }

  const continuations = bookContinuations(movesSoFar, book);
  if (continuations.size === 0) return { kind: "none" };
  const options = [...continuations].map((move) => ({
    move,
    name: openingName([...movesSoFar, move], book) ?? move,
  }));
  return { kind: "offLine", options };
}
