// @vitest-environment jsdom
// Bug report: after Black's first reply, White can't make any second move
// -- destination dots appear, but drag and click both snap back silently,
// every piece, every time. White's first move works. Uses the REAL,
// unmocked chessground library (only the factory fn is intercepted, to
// grab a handle on the real Api it returns) through the full BuildScreen
// flow, not BuildScreen.test.tsx's usual full mock -- this bug lives
// *inside* chessground's own state machine (see the root-cause comment
// below), so a fake Api that doesn't reproduce that state machine can't
// reproduce the bug either.
//
// "drag and click both" fail identically because they funnel through the
// exact same gating (board.isMovable/board.canMove, gated on
// state.turnColor) before chessground calls `movable.events.after` --
// confirmed in the prior click-to-move investigation (BuildBoard.test.tsx).
// Calling the public Api's selectSquare() twice (click 1: select, click 2:
// destination) exercises that gating faithfully without needing real drag
// DOM events, which jsdom can't produce as `isTrusted` anyway.
//
// Root cause: chessground's own `state.turnColor` only ever toggles inside
// its OWN move functions (board.baseMove/baseUserMove), run when White
// moves via this board. Black's reply is applied as a plain `fen` prop
// update (BuildBoard's second useEffect's `.set({fen, ...})`) -- fen.js's
// own `read()` only parses piece placement, never the side-to-move field,
// so nothing ever tells chessground "it's White's turn again." After
// White's first move, state.turnColor is stuck at 'black' forever: White's
// own pieces fail `isMovable` (movable.color==='white' but
// turnColor==='black'), BUT `isPremovable` is satisfied instead
// (premovable.enabled defaults to true, and it specifically requires
// turnColor !== piece.color) -- so selecting a piece still shows dots
// (premove destinations), and completing one calls board.setPremove, not
// movable.events.after. The move is silently recorded as a premove (never
// executed, never reported) and the piece visually reverts once
// unselected: exactly "snaps back silently." This affects every White move
// after the first, regardless of commit type (ordinary, castle, capture,
// or after Take back) -- all of them toggle state.turnColor the same way.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { BOOK, PRESETS } from "./appData";
import BuildScreen, { setBlackReplyDelayForTests } from "./BuildScreen";
import { KingMode } from "./engine/models";
import { loadEtrCsv } from "./engine/loaders";
import { SAMPLE_CSV } from "./testFixtures";

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

// Housekeeping "Faster tests": near-zero, not exactly 0 -- a
// `setTimeout(fn, 0)` can still fire within a single `await
// user.click(...)`'s own turns of the event loop, which would race a
// test asserting the SYNCHRONOUS pre-reply state (no test in this file
// does). See the setter's own comment in BuildScreen.tsx; BuildScreen.
// movePick/castling.test.tsx pin this to the real 600ms instead, for
// tests that do need that synchronous state reliably observable. The
// real app's own pacing is untouched either way; this only ever runs
// under Vitest.
setBlackReplyDelayForTests(20);

const PLAYERS = loadEtrCsv(SAMPLE_CSV);
const H2H = PRESETS.find((preset) => preset.name === "H2H")!;
const MORPHY_DEFENSE = BOOK.find((line) => line.eco === "C70" && line.name === "Ruy Lopez: Morphy Defense")!;

const onStartAgain = vi.fn();
const onNewContest = vi.fn();

beforeEach(() => {
  capturedApi = null;
  window.localStorage.clear();
  onStartAgain.mockClear();
  onNewContest.mockClear();
});

function renderScreen(opening: "line" | "own" = "line") {
  return render(
    <BuildScreen
      preset={H2H}
      players={PLAYERS}
      kingMode={KingMode.EMERGE}
      whiteKing={null}
      blackKing={null}
      chosenOpening={opening === "line" ? { kind: "line", line: MORPHY_DEFENSE } : { kind: "own" }}
      onStartAgain={onStartAgain}
      onNewContest={onNewContest}
    />,
  );
}

// A real click is two selectSquare() calls (select, then its destination) --
// see board.js's selectSquare/userMove, and the file header above.
function clickMove(from: string, to: string): void {
  capturedApi!.selectSquare(from as Key);
  capturedApi!.selectSquare(to as Key);
}

async function lockTopCandidate(user: UserEvent, dialogName?: string): Promise<void> {
  const dialog = dialogName ? await screen.findByRole("dialog", { name: dialogName }) : await screen.findByRole("dialog", { name: /^Choose your/ });
  const firstRow = dialog.querySelector(".pick-row") as HTMLElement;
  await user.click(firstRow);
  await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
  // Rule change "new levels + Go back": a real top-of-list pick can now
  // genuinely reach Caution/Warning/Critical (the avg thresholds
  // loosened, and the old 3-open-slot gate dropped to 2) -- the board
  // goes inert (empty dests, same as a pending pick) while that dialog is
  // up, so every caller here needs it out of the way before the next
  // move; OK keeps the real pick, same as every other move in these
  // sequences.
  const alert = screen.queryByRole("dialog", { name: "Salary alert" });
  if (alert !== null) {
    await user.click(within(alert).getByRole("button", { name: "OK" }));
  }
}

// Waits for White's real turn to actually be back (non-empty dests), not
// just "the component rendered once more" -- same pattern
// BuildScreen.test.tsx's castling tests use. Black's reply always carries
// BLACK_REPLY_DELAY_MS's real 600ms setTimeout on top of a render (now also
// recomputing engine/optimizer.ts's best-completion stat); 2000ms left too
// little margin under this project's own documented full-suite CPU
// contention (sessions/HANDOFF.md's Environment note) -- bumped to match,
// same precedent as this file's own 15000ms per-test extensions.
async function waitForWhitesTurn(): Promise<void> {
  await waitFor(() => expect(capturedApi!.state.movable.dests?.size ?? 0).toBeGreaterThan(0), { timeout: 5000 });
}

function anyLegalMove(): [string, string] {
  const dests = capturedApi!.state.movable.dests!;
  const [from, tos] = [...dests.entries()][0];
  return [from, tos[0]];
}

describe("BuildScreen -- White's second move (bug fix)", () => {
  // Task 43: this test's own real-DOM/real-chessground/real-engine work
  // (confirmed via isolated timing runs, no inefficiency found -- see the
  // "after castling"/"White can move again after a capture" tests below,
  // the ones that already needed the same extension) legitimately costs
  // 3-4s even on a quiet machine; under full-suite parallel load that left
  // too little headroom against Vitest's 5000ms default. Same fix as those
  // two siblings, not a new pattern.
  it(
    "plays a full cycle -- move, pick, lock, Black replies, White's second move opens the pick modal",
    async () => {
      renderScreen();
      const user = userEvent.setup();

      clickMove("g1", "f3"); // White's first move -- works today
      await lockTopCandidate(user, "Choose your Knight");
      await waitForWhitesTurn(); // Black has replied; it's genuinely White's turn again

      const [from, to] = anyLegalMove();
      clickMove(from, to); // White's second move -- the reported failure

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    },
    30000,
  );

  it(
    "White can move again after Take back",
    async () => {
      renderScreen();
      const user = userEvent.setup();

      clickMove("g1", "f3");
      await lockTopCandidate(user, "Choose your Knight");
      await waitForWhitesTurn();

      await user.click(screen.getByRole("button", { name: "Take back" }));
      await waitForWhitesTurn();

      const [from, to] = anyLegalMove();
      clickMove(from, to);

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    },
    30000,
  );

  // Seeding Math.random (same value BuildScreen.test.tsx's own castling
  // block uses) makes Black's book/random replies reproducible, so a
  // fixed developing sequence reliably reaches a position where O-O is
  // chess-AND-DFS-legal -- see BuildScreen.test.tsx's developKnightAndBishop
  // for the original version of this sequence (there, via the mocked
  // simulateMove; here, via real clickMove).
  describe("after castling", () => {
    beforeEach(() => {
      vi.spyOn(Math, "random").mockReturnValue(0.137);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("White can move again after castling", async () => {
      renderScreen("own");
      const user = userEvent.setup();

      for (const [from, to] of [
        ["e2", "e4"],
        ["g1", "f3"],
        ["f1", "b5"],
      ] as const) {
        clickMove(from, to);
        await lockTopCandidate(user);
        await waitForWhitesTurn();
      }

      expect(capturedApi!.state.movable.dests!.get("e1" as Key)).toContain("g1" as Key);
      clickMove("e1", "g1"); // O-O

      await lockTopCandidate(user, "Choose your King");
      await lockTopCandidate(user, "Choose your Rook");
      await waitForWhitesTurn();

      const [from, to] = anyLegalMove();
      clickMove(from, to);

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    }, 60000); // Rule change "Pick lists must keep the lineup completable": same heavier-multi-ply cost as BuildScreen.castling.test.tsx's own "capturing an unmoved piece" test
  });

  it(
    "White can move again after a capture",
    async () => {
      renderScreen("own");
      const user = userEvent.setup();

      // Plays harmless developing moves until a legal capture appears
      // among White's own offered dests -- Black's real, book-driven
      // replies decide exactly when that happens, so this adapts to
      // whatever Black actually plays rather than assuming a specific
      // line (same approach as BuildScreen.test.tsx's own playUntilCapture,
      // adapted to read chessground's real state instead of the mock's
      // config).
      const DEVELOPING_MOVES: [string, string][] = [
        ["e2", "e4"],
        ["d2", "d4"],
        ["g1", "f3"],
        ["b1", "c3"],
        ["f1", "c4"],
      ];
      let capture: [string, string] | null = null;
      for (let ply = 0; ply < 8 && capture === null; ply++) {
        const dests = capturedApi!.state.movable.dests!;
        const pieces = capturedApi!.state.pieces;
        const isCastle = (from: string, to: string) => from === "e1" && (to === "g1" || to === "c1");

        for (const [from, tos] of dests) {
          for (const to of tos) {
            if (pieces.has(to as Key) && !isCastle(from, to)) {
              capture = [from, to];
              break;
            }
          }
          if (capture !== null) break;
        }
        if (capture !== null) break;

        const filler = DEVELOPING_MOVES.find(([from, to]) => (dests.get(from as Key) ?? []).includes(to as Key)) ?? anyLegalMove();
        clickMove(filler[0], filler[1]);
        await lockTopCandidate(user);
        await waitForWhitesTurn();
      }
      if (capture === null) throw new Error("no capture became available within 8 plies");

      const pieceBeforeCapture = capturedApi!.state.pieces.get(capture[1] as Key)!;
      clickMove(capture[0], capture[1]);

      // A transfer (the captured piece already has lock history) commits
      // immediately with no modal; capturing a still-unmoved piece opens
      // one -- either way, wait for the capturing piece to actually land.
      await waitFor(() => expect(capturedApi!.state.pieces.get(capture![1] as Key)?.color).toBe(pieceBeforeCapture.color === "white" ? "black" : "white"));
      if (screen.queryByRole("dialog", { name: /^Choose your/ }) !== null) {
        await lockTopCandidate(user);
      } else {
        // A transfer capture (no modal) can itself cross a real tight-
        // finish threshold now -- see lockTopCandidate's own comment.
        const alert = screen.queryByRole("dialog", { name: "Salary alert" });
        if (alert !== null) {
          await user.click(within(alert).getByRole("button", { name: "OK" }));
        }
      }
      await waitForWhitesTurn();

      const [from, to] = anyLegalMove();
      clickMove(from, to); // White's move right after the capture's Black reply

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    },
    60000, // Rule change "Pick lists must keep the lineup completable": up to 8 plies, same heavier cost as this file's "after castling" test above
  );
});
