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
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type TouchEvent } from "react";
import BoardSquares from "./BoardSquares";
import "./BuildBoard.css";

// Piece-info hover/long-press tooltip: the content a caller hands back for
// whichever square is currently hovered (or long-pressed, on touch) --
// null means nothing to show (an empty square). `fit` is present only for
// a captured-would-transfer note (Field pieces with lock history); absent
// for every other content shape (a locked White piece, a never-moved
// piece, or one that's moved but locked no one).
export interface PieceTooltipContent {
  title: string;
  detail?: string;
  fit?: { fits: boolean; text: string };
}

interface Props {
  fen: string;
  dests: Dests;
  lastMove: { orig: Key; dest: Key } | null;
  onMove: (orig: Key, dest: Key) => void;
  // Optional: whoever owns the engine state (BuildScreen) supplies this to
  // turn a hovered/long-pressed square into tooltip content -- BuildBoard
  // itself knows nothing about players, locks, or fit checks, only board
  // geometry. Omitted entirely, hovering just does nothing (BuildBoard.
  // test.tsx's existing renders never pass it).
  getPieceTooltip?: (square: Key) => PieceTooltipContent | null;
}

// Long-press duration (touch only -- desktop uses plain hover) before the
// tooltip appears; short enough to feel responsive, long enough that an
// ordinary tap-to-select/tap-to-move never triggers it.
const LONG_PRESS_MS = 500;

const FILES = "abcdefgh";

// The square under (clientX, clientY), given the board container's own
// bounding rect -- orientation is always "white" (hardcoded at
// construction below), so this is the same row/col -> file/rank mapping
// BoardSquares.tsx uses for the checker pattern. Null outside the board
// (including a zeroed rect, e.g. under jsdom, which never has real layout).
function squareAtPoint(rect: DOMRect, clientX: number, clientY: number): Key | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  if (relX < 0 || relX >= 1 || relY < 0 || relY >= 1) return null;
  const col = Math.floor(relX * 8);
  const row = Math.floor(relY * 8);
  return `${FILES[col]}${8 - row}` as Key;
}

// Where the tooltip box sits relative to `.build-board` (percent of its own
// width/height, which is always square -- aspect-ratio: 1 in BuildBoard.css)
// -- centered above the hovered square, flipped below for the top rank so
// it never clips out the top of the board; nudged off-center near the left/
// right edges so it doesn't run off the side either. `pointer-events: none`
// in BuildBoard.css (not here) is what actually guarantees it can never
// block a move/drag, regardless of this positioning.
function tooltipStyle(square: Key): CSSProperties {
  const col = FILES.indexOf(square[0]);
  const row = 8 - Number(square[1]);
  const nearTop = row === 0;
  const translateX = col <= 1 ? "0%" : col >= 6 ? "-100%" : "-50%";
  return {
    left: `${((col + 0.5) / 8) * 100}%`,
    top: `${(nearTop ? row + 1 : row) * 12.5}%`,
    transform: `translate(${translateX}, ${nearTop ? "8px" : "calc(-100% - 8px)"})`,
  };
}

export default function BuildBoard({ fen, dests, lastMove, onMove, getPieceTooltip }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const [hover, setHover] = useState<{ square: Key; content: PieceTooltipContent } | null>(null);
  const longPressRef = useRef<number | null>(null);
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

  // The position just changed (a move committed) -- whatever was hovered
  // may no longer mean the same thing (or exist at all), so drop it rather
  // than show stale info until the pointer next moves.
  useEffect(() => {
    setHover(null);
  }, [fen]);

  function clearLongPress(): void {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }

  function showTooltipAt(clientX: number, clientY: number): void {
    if (getPieceTooltip === undefined || containerRef.current === null) return;
    const square = squareAtPoint(containerRef.current.getBoundingClientRect(), clientX, clientY);
    const content = square === null ? null : getPieceTooltip(square);
    setHover(square !== null && content !== null ? { square, content } : null);
  }

  // Desktop: plain hover. Neither handler calls preventDefault/
  // stopPropagation, so chessground's own mousedown/drag handling on the
  // same element is completely untouched by these.
  function handleMouseMove(e: MouseEvent): void {
    showTooltipAt(e.clientX, e.clientY);
  }
  function handleMouseLeave(): void {
    setHover(null);
  }

  // Mobile (no hover): a long press shows the tooltip; any movement before
  // it fires cancels it (that's a drag, not a press-and-hold), and lifting
  // the finger always clears both the pending timer and any tooltip
  // already showing. Chessground's own touchstart/touchmove/touchend
  // listeners on this same element see every one of these events exactly
  // as if this component didn't exist -- tap-to-select and drag-to-move
  // are untouched.
  function handleTouchStart(e: TouchEvent): void {
    if (getPieceTooltip === undefined) return;
    const touch = e.touches[0];
    clearLongPress();
    longPressRef.current = window.setTimeout(() => showTooltipAt(touch.clientX, touch.clientY), LONG_PRESS_MS);
  }
  function handleTouchEnd(): void {
    clearLongPress();
    setHover(null);
  }

  return (
    <div
      className="build-board"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchEnd}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <BoardSquares labels />
      <div className="build-board-cg" ref={containerRef} />
      {hover !== null && (
        <div className="piece-tooltip" style={tooltipStyle(hover.square)}>
          <p className="piece-tooltip-title">{hover.content.title}</p>
          {hover.content.detail !== undefined && <p className="piece-tooltip-detail">{hover.content.detail}</p>}
          {hover.content.fit !== undefined && (
            <p className={`piece-tooltip-fit ${hover.content.fit.fits ? "ok" : "no"}`}>{hover.content.fit.text}</p>
          )}
        </div>
      )}
    </div>
  );
}
