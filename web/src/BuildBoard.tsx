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
//
// Bug fix: White's second move (and every one after) silently failed --
// dots appeared, but completing a move snapped back with no callback ever
// firing. chessground's own `state.turnColor` only toggles inside its own
// move functions (board.baseMove/baseUserMove), run when White moves via
// this board; Black's reply lands as a plain `fen` prop update instead
// (fen.js's `read()` only parses piece placement, never the side-to-move
// field), so nothing ever told chessground it was White's turn again --
// `state.turnColor` stayed stuck at 'black' forever after White's first
// move. `movable.color` ('white') no longer matched `turnColor`, so
// `isMovable`/`canMove` failed for every White piece -- but
// `isPremovable` (gated on `turnColor !== piece.color`, the OPPOSITE
// check) started passing instead, since `premovable.enabled` defaults to
// true. Selecting a piece still showed dots (premove destinations, not
// `movable.dests`), and completing one called `board.setPremove` --
// recorded, never executed, never reported -- instead of
// `movable.events.after`: the move vanished with no callback and no
// error. Passing `turnColor: "white"` on every update (not just at
// mount) keeps chessground's own tracking honest regardless of how the
// position changed (Black's reply, Take back, a castle, a capture).
// `premovable.enabled: false` is belt-and-suspenders: this app has no use
// for premoves (Black never drags), so disabling it means any future
// turnColor mismatch fails loudly (nothing selectable) rather than
// silently eating a move again.
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
      turnColor: "white",
      coordinates: false,
      animation: { enabled: false },
      lastMove: lastMove ? [lastMove.orig, lastMove.dest] : undefined,
      movable: {
        free: false,
        color: "white",
        dests,
        events: { after: (orig, dest) => onMoveRef.current(orig, dest) },
      },
      premovable: { enabled: false },
    });
    return () => apiRef.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bug fix: chessground memoizes its own board bounds (getBoundingClientRect)
  // and only recomputes them from inside redrawAll -- a layout shift
  // anywhere above or around the board (the opening banner's subtext, the
  // status line's length, Book continues gaining/losing rows, the pick
  // panel changing the board column's width) moves or resizes the real
  // board element without chessground ever finding out, so a click/drag
  // lands against stale bounds (one square off, or on nothing). The
  // ResizeObserver catches the board's own size changing; it won't fire for
  // a pure position shift (a sibling growing/shrinking without resizing
  // this container), so the second effect below -- no dependency array,
  // meaning it also runs after every render -- covers that case instead,
  // relying on this component re-rendering whenever BuildScreen does (it
  // isn't memoized).
  useEffect(() => {
    if (containerRef.current === null) return;
    const observer = new ResizeObserver(() => apiRef.current?.redrawAll());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    apiRef.current?.redrawAll();
  });

  useEffect(() => {
    apiRef.current?.set({
      fen,
      turnColor: "white",
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
