// @vitest-environment jsdom
// Bug report: click-select-then-click-destination on the build board didn't
// move the piece (dragging did). Investigated using the REAL chessground
// library here (only the factory function is intercepted, to grab a handle
// on the real Api it returns) rather than BuildScreen.test.tsx's usual full
// mock, specifically to exercise chessground's own click state machine
// (board.selectSquare -> board.userMove) instead of assuming it. Calling
// the public Api's selectSquare() twice is exactly what chessground's own
// mousedown handler does internally for a click-then-click move -- this
// sidesteps the two things jsdom genuinely can't do (real DOM events aren't
// `isTrusted`, which chessground's own listener requires unless
// `trustAllEvents` is set; and getBoundingClientRect is always zeroed, so
// `drag.start`'s own square-from-pixel math can't run) without faking
// either one.
//
// Conclusion: both of this bug's two suspects -- "the chessground instance
// gets reconfigured on re-render, resetting selection" and "the move
// handler only fires for drags" -- are disproven below. selectSquare/
// selectSquare correctly reaches `movable.events.after` (the same callback
// a drag's drop calls), including across a re-render that hands BuildBoard
// a brand-new (but content-equivalent) `dests` Map, which is what happens
// on every real BuildScreen render since `dests` is rebuilt inline, not
// memoized. No code-level cause was found this way; real-browser
// verification isn't available in this environment (see sessions/HANDOFF.md's
// Environment note -- no browser can launch here at all, missing
// libasound.so.2, no sudo to install it).
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "@lichess-org/chessground/api";
import type { Dests, Key } from "@lichess-org/chessground/types";
import BuildBoard from "./BuildBoard";

let capturedApi: Api | null = null;

vi.mock("@lichess-org/chessground", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lichess-org/chessground")>();
  return {
    Chessground: (el: HTMLElement, config: unknown) => {
      const api = actual.Chessground(el, config as never);
      capturedApi = api;
      return api;
    },
  };
});

// `movable.events.after` is called via chessground's own
// `setTimeout(..., 1)` (see board.js's callUserFunction), not synchronously.
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("BuildBoard -- click-to-move (real chessground, not the mock)", () => {
  it("click-select then click-destination calls onMove with the real move", async () => {
    const onMove = vi.fn();
    const dests: Dests = new Map([["g1" as Key, ["f3" as Key, "h3" as Key]]]);
    render(<BuildBoard fen="start" dests={dests} lastMove={null} onMove={onMove} />);

    capturedApi!.selectSquare("g1" as Key); // click 1: select the Knight
    capturedApi!.selectSquare("f3" as Key); // click 2: click its destination dot
    await wait(10);

    expect(onMove).toHaveBeenCalledWith("g1", "f3");
  });

  it("a re-render between the two clicks (fresh dests Map, same content) doesn't drop the selection", async () => {
    const onMove = vi.fn();
    const dests: Dests = new Map([["g1" as Key, ["f3" as Key, "h3" as Key]]]);

    const { rerender } = render(<BuildBoard fen="start" dests={dests} lastMove={null} onMove={onMove} />);

    capturedApi!.selectSquare("g1" as Key);

    // Exactly what happens on every real BuildScreen render: `dests` is a
    // brand-new Map built inline each render, not memoized.
    const dests2: Dests = new Map([["g1" as Key, ["f3" as Key, "h3" as Key]]]);
    rerender(<BuildBoard fen="start" dests={dests2} lastMove={null} onMove={onMove} />);

    capturedApi!.selectSquare("f3" as Key);
    await wait(10);

    expect(onMove).toHaveBeenCalledWith("g1", "f3");
  });
});

// Bug fix: "Board clicks land one square off" -- chessground caches its own
// board bounds and only re-measures them from inside redrawAll; a layout
// shift above/around the board (banner, status line, Book continues,
// pick panel width) never told it to. jsdom can't lay out real elements at
// all (getBoundingClientRect is always zeroed -- see this file's own header
// comment and sessions/HANDOFF.md's Environment note), so an *actual*
// resize/reposition can't be produced here; this only proves the wiring --
// that BuildBoard's own ResizeObserver callback calls the real Api's
// redrawAll() when the browser reports its container resized. Ron verifies
// the real-browser behavior.
//
// Note: chessground itself also registers its own internal ResizeObserver
// on this same element (events.ts's bindDocument, for its own lighter
// bounds-cache invalidation) -- both constructors go through the one global
// stub below, so this fires every captured callback (exactly what a real
// resize notification would do -- every observer registered on an element
// gets its own, independent callback invocation) rather than assuming
// which one is BuildBoard's own.
describe("BuildBoard -- re-measures chessground's board bounds on container resize", () => {
  it("calls the real Api's redrawAll() when the ResizeObserver fires", () => {
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const onMove = vi.fn();
    const dests: Dests = new Map();
    const { unmount } = render(<BuildBoard fen="start" dests={dests} lastMove={null} onMove={onMove} />);

    expect(callbacks.length).toBeGreaterThan(0);

    const redrawSpy = vi.spyOn(capturedApi!, "redrawAll");
    // Neither BuildBoard's own callback nor chessground's internal one reads
    // the second (observer) argument -- a null stand-in avoids constructing
    // another real FakeResizeObserver here, which would otherwise push a new
    // entry onto `callbacks` (its constructor's side effect) while this
    // very loop is iterating over that same array.
    for (const cb of callbacks) cb([] as unknown as ResizeObserverEntry[], null as unknown as ResizeObserver);

    expect(redrawSpy).toHaveBeenCalled();

    unmount();
    expect(disconnect).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
