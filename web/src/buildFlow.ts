// Task 38: the build screen's move-first-then-pick flow -- UI-layer
// composition of already-exported engine primitives, same spirit as
// buildStats.ts. No new engine rules: "DFS-legal, offerable move" is just
// chess.js's own legal moves filtered by build.moveIsCompletable, with
// captures and castling excluded outright ("not offered as legal targets"
// this task -- next task adds them); "suggestion" is openings.
// bookContinuations/openingName, read from the chosen line or the book.
import type { Move as ChessJsMove } from "chess.js";
import { moveIsCompletable } from "./engine/build";
import type { ContestConfig } from "./engine/config";
import type { BuildState, KingMode, Player } from "./engine/models";
import { bookContinuations, openingName, type BookLine } from "./engine/openings";
import { isCaptureMove, type ChessMove } from "./engine/rules";
import type { SportConfig } from "./engine/sport";
import type { ChosenOpening } from "./OpeningSetupScreen";

// Every legal chess move for the side to move that this task offers as a
// drag target: not a capture, not castling (both excluded "for now" --
// RULES.md's castling/capture handling isn't built into this screen yet),
// and DFS-legal (an eligible, unlocked, cap-feasible player exists for the
// piece band it would lock).
export function dfsLegalMoves(
  state: BuildState,
  sport: SportConfig,
  contest: ContestConfig,
  players: readonly Player[],
  kingMode: KingMode,
): ChessJsMove[] {
  return state.board.moves({ verbose: true }).filter((move) => {
    if (isCaptureMove(move) || move.isKingsideCastle() || move.isQueensideCastle()) return false;
    const chessMove: ChessMove = { from: move.from, to: move.to, promotion: move.promotion };
    return moveIsCompletable(state, chessMove, sport, contest, players, kingMode);
  });
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
