// Task 38: the build screen's interactive board -- White drags pieces;
// `dests` (computed by the caller via buildFlow.dfsLegalMoves, chess-AND-
// DFS-legal, captures/castling excluded "for now") is the only thing that
// makes a square draggable at all, so there's nothing chessground-side
// left to validate. Black never drags (automatic, per the engine) --
// `movable.color` stays fixed to "white"; passing an empty `dests` map
// (whenever it isn't White's turn, or a move is awaiting its pick) makes
// the board inert without touching that config. The suggested move (if
// any) is drawn via `drawable.autoShapes`, the same imperative API
// BoardPreview doesn't need since it's view-only.
import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Dests, Key } from "@lichess-org/chessground/types";
import { useEffect, useRef } from "react";
import "./BuildBoard.css";

interface Props {
  fen: string;
  dests: Dests;
  suggestionArrow: { orig: Key; dest: Key } | null;
  onMove: (orig: Key, dest: Key) => void;
}

export default function BuildBoard({ fen, dests, suggestionArrow, onMove }: Props) {
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
      movable: {
        free: false,
        color: "white",
        dests,
        events: { after: (orig, dest) => onMoveRef.current(orig, dest) },
      },
      drawable: {
        enabled: false,
        autoShapes: suggestionArrow ? [{ orig: suggestionArrow.orig, dest: suggestionArrow.dest, brush: "green" }] : [],
      },
    });
    return () => apiRef.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiRef.current?.set({
      fen,
      movable: { dests },
      drawable: {
        autoShapes: suggestionArrow ? [{ orig: suggestionArrow.orig, dest: suggestionArrow.dest, brush: "green" }] : [],
      },
    });
  }, [fen, dests, suggestionArrow]);

  return <div className="build-board" ref={containerRef} />;
}
