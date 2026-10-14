// Task 38: the build screen's interactive board -- White drags pieces;
// `dests` (computed by the caller via buildFlow.dfsLegalMoves, chess-AND-
// DFS-legal, captures/castling excluded "for now") is the only thing that
// makes a square draggable at all, so there's nothing chessground-side
// left to validate. Black never drags (automatic, per the engine) --
// `movable.color` stays fixed to "white"; passing an empty `dests` map
// (whenever it isn't White's turn, or a move is awaiting its pick) makes
// the board inert without touching that config.
//
// Task 38b: `lastMove` now actually reaches chessground (it never did
// before -- `highlight.lastMove` had nothing to highlight), and the
// checker pattern is BoardSquares -- a real 8x8 grid behind chessground's
// own (now-transparent) cg-board, not a CSS background on it; see
// BoardSquares.tsx and index.css for why. The board-screen's old single-
// suggestion arrow (`drawable.autoShapes`) is gone: the redesigned "Book
// continues" list under the board shows every offerable continuation as
// its own button (the chosen line's next move highlighted among them, not
// drawn on the board), so there's no one suggested move left to point an
// arrow at.
import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Dests, Key } from "@lichess-org/chessground/types";
import { useEffect, useRef } from "react";
import BoardSquares from "./BoardSquares";
import "./BuildBoard.css";

interface Props {
  fen: string;
  dests: Dests;
  lastMove: { orig: Key; dest: Key } | null;
  onMove: (orig: Key, dest: Key) => void;
}

export default function BuildBoard({ fen, dests, lastMove, onMove }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  // `movable.events.after` is registered once, at mount -- this ref keeps
  // it calling whichever `onMove` is current without needing to tear down
  // and recreate the chessground instance every time the prop identity
  // changes.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    if (containerRef.current === null) return;
    apiRef.current = Chessground(containerRef.current, {
      fen,
      orientation: "white",
      coordinates: false,
      animation: { enabled: false },
      lastMove: lastMove ? [lastMove.orig, lastMove.dest] : undefined,
      movable: {
        free: false,
        color: "white",
        dests,
        events: { after: (orig, dest) => onMoveRef.current(orig, dest) },
      },
    });
    return () => apiRef.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiRef.current?.set({
      fen,
      lastMove: lastMove ? [lastMove.orig, lastMove.dest] : undefined,
      movable: { dests },
    });
  }, [fen, dests, lastMove]);

  return (
    <div className="build-board">
      <BoardSquares labels />
      <div className="build-board-cg" ref={containerRef} />
    </div>
  );
}
