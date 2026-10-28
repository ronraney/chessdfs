// @vitest-environment jsdom
// Housekeeping "Faster tests": split out of the former BuildScreen.test.tsx
// along its own existing describe blocks (no test content changed, no
// tests added or removed) so Vitest can run these chunks on separate
// workers instead of one long serial file -- see BuildScreen.tightFinish/
// castling/hoverTooltip/endings.test.tsx for the rest. This file keeps
// every describe block that needs no mock beyond chessground itself: the
// core move-first-then-pick flow, the two opening-line-follows-the-book
// tests, rejected/blocked moves, click-to-move, the uncapped pick list,
// the status line, the Core projection stat, and the How-it-works strip.
//
// Task 38: drives the move-first-then-pick flow end to end. chessground
// manipulates raw DOM pixel geometry to detect drag/drop, which jsdom
// can't lay out at all (getBoundingClientRect is always zeroed) -- there's
// no way to simulate a real drag in this environment, so
// "@lichess-org/chessground" is mocked here: the fake Chessground()
// captures the config BuildBoard passed it (in particular
// `movable.events.after`, the callback a real drag would eventually
// call) and `simulateMove` invokes it directly, exactly as chessground
// itself would once a legal drop lands. Everything downstream of that
// callback -- state, the pick modal, Black's automatic reply -- is real,
// unmocked BuildScreen/engine code.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@lichess-org/chessground/config";
import { BOOK, PRESETS } from "./appData";
import BuildScreen, { setBlackReplyDelayForTests } from "./BuildScreen";
import { KingMode, Player } from "./engine/models";
import { loadEtrCsv } from "./engine/loaders";
import { SAMPLE_CSV } from "./testFixtures";

interface FakeApi {
  config: Config;
  set(partial: Partial<Config>): void;
  destroy(): void;
  // Bug fix: models chessground's own click-to-move state machine (board.
  // selectSquare -> board.userMove) well enough to drive BuildScreen the
  // same way two real clicks do -- a first call selects, a second call on
  // one of the first square's own `dests` fires `movable.events.after`
  // exactly like a completed drag's drop does. See BuildBoard.test.tsx for
  // the same two clicks exercised against the REAL chessground library.
  selectSquare(key: string): void;
  // Bug fix: board-bounds re-measure -- BuildBoard now calls this on every
  // render and from its ResizeObserver; a no-op here since this fake has no
  // real bounds to re-measure.
  redrawAll(): void;
}

let lastApi: FakeApi | null = null;

vi.mock("@lichess-org/chessground", () => ({
  Chessground: (_el: HTMLElement, config: Config): FakeApi => {
    let selected: string | null = null;
    const api: FakeApi = {
      config,
      set(partial) {
        api.config = {
          ...api.config,
          ...partial,
          movable: { ...api.config.movable, ...partial.movable },
          drawable: { ...api.config.drawable, ...partial.drawable },
        };
      },
      destroy() {},
      redrawAll() {},
      selectSquare(key) {
        const dests = api.config.movable?.dests?.get(selected as never) ?? [];
        if (selected !== null && selected !== key && dests.includes(key as never)) {
          const orig = selected;
          selected = null;
          api.config.movable!.events!.after!(orig as never, key as never, { premove: false });
          return;
        }
        selected = key;
      },
    };
    lastApi = api;
    return api;
  },
}));

// Housekeeping "Faster tests": pinned to the real 600ms pacing, not sped
// up (a no-op today -- 600 is BuildScreen.tsx's own module default too,
// confirmed via Vitest's own per-file module isolation, which does NOT
// leak this across files; kept explicit so the intent survives even if
// that default ever changes) -- "shows the Field's move once Black
// replies" below asserts the SYNCHRONOUS pre-reply status-line text
// right after a commit, which depends on the real pause still being
// pending at that instant. Confirmed (by instrumenting the real value
// BuildScreen.tsx's own setTimeout call read) that this can still
// occasionally lose that race at the genuine 600ms value under this
// suite's own full-run CPU/scheduling contention -- a pre-existing
// fragility in the test's own design, not something this task's changes
// introduced; a SMALLER override (tried 0ms, then 20ms) only made it
// lose far more often, so this file keeps the real pacing rather than
// trying to find a faster "safe" value that doesn't actually exist here.
setBlackReplyDelayForTests(600);

// Simulates a completed drag/drop -- the same call chessground's own
// `movable.events.after` callback would receive once a legal drop lands.
function simulateMove(orig: string, dest: string): void {
  lastApi!.config.movable!.events!.after!(orig as never, dest as never, { premove: false });
}

const PLAYERS = loadEtrCsv(SAMPLE_CSV);
const H2H = PRESETS.find((preset) => preset.name === "H2H")!;
const MORPHY_DEFENSE = BOOK.find((line) => line.eco === "C70" && line.name === "Ruy Lopez: Morphy Defense")!;
const FRENCH_CLASSICAL = BOOK.find((line) => line.eco === "C12" && line.name === "French Defense, Classical, 4. Bg5")!;
const VIENNA_GAME = BOOK.find((line) => line.eco === "C25" && line.name === "Vienna Game")!; // 1. e4 e5 2. Nc3

// Task 40: BuildScreen no longer owns "start again"/"new contest"
// navigation itself (that's App.tsx's job) -- every render site needs
// these two callback props regardless, so a pair of shared spies (reset
// in beforeEach below) saves repeating `vi.fn()` at every call site.
const onStartAgain = vi.fn();
const onNewContest = vi.fn();

function renderScreen() {
  return render(
    <BuildScreen
      preset={H2H}
      players={PLAYERS}
      kingMode={KingMode.EMERGE}
      whiteKing={null}
      blackKing={null}
      chosenOpening={{ kind: "line", line: MORPHY_DEFENSE }}
      onStartAgain={onStartAgain}
      onNewContest={onNewContest}
    />,
  );
}

function fieldColumn(): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: "Field" }).closest(".side-column") as HTMLElement;
}

function youColumn(): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: "You" }).closest(".side-column") as HTMLElement;
}

function chosenContinueButton(): HTMLElement {
  return document.querySelector(".continue-option.chosen") as HTMLElement;
}

// Bug fix (post-Task-40): the pick modal no longer pre-selects a row --
// every test that used to go straight to "Lock player" now has to select
// a row first. Rows are sorted by the moved piece's own metric (RULES.md
// piece table), descending, so the first one is always "the top
// candidate" every pre-existing test's own name/intent already assumed.
// Piece pools: with far more candidates sharing a piece's pool now (e.g.
// every sub-$5,000 RB/WR/TE is Pawn-eligible, not just a narrow catch-all),
// the single top-projection candidate is more often one Black's own
// replies already spoken for a roster slot for -- greyed out, a real
// disabled button (infeasible rows always have been). "Top row" means the
// top SELECTABLE one.
async function selectTopRow(user: UserEvent, dialog: HTMLElement): Promise<void> {
  const rows = [...dialog.querySelectorAll<HTMLButtonElement>(".pick-row")];
  const firstRow = rows.find((row) => !row.disabled) ?? rows[0];
  await user.click(firstRow);
}

beforeEach(() => {
  lastApi = null;
  window.localStorage.clear();
  onStartAgain.mockClear();
  onNewContest.mockClear();
});

function statusLine(): HTMLElement {
  return document.querySelector(".status-line") as HTMLElement;
}

describe("BuildScreen -- move first, then pick", () => {
  // Synchronous (no await) but observed timing out at Vitest's 5000ms
  // default under full-suite parallel load (confirmed via repeated full-
  // suite runs this session) -- this project's own documented CPU
  // contention (sessions/HANDOFF.md's Environment note: ~23 workers on this
  // machine's 8 cores), not a new inefficiency: renderScreen's first real
  // render is the file's heaviest (real chessground mount + the "Book
  // continues" build, now also a POPULARITY lookup per candidate). Same
  // "extend to match real cost" precedent as this file's other explicitly-
  // timed tests.
  it(
    "shows the chosen line's banner before any move, with Book continues offering it first",
    () => {
      renderScreen();
      expect(document.querySelector(".build-board")).not.toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();

      expect(screen.getByRole("heading", { level: 1, name: "Ruy Lopez" })).toBeInTheDocument();
      expect(screen.getByText("C70")).toBeInTheDocument();
      expect(screen.getByText("Morphy Defense")).toBeInTheDocument();

      const chosen = chosenContinueButton();
      expect(chosen).not.toBeNull();
      expect(chosen.textContent).toContain("1. e4");
    },
    15000,
  );

  it("Book continues is capped, not a dump of every recorded first move", () => {
    renderScreen();
    // bookContinuations([], BOOK) alone returns dozens of first moves --
    // Task 38b caps what's actually shown to a manageable menu.
    expect(document.querySelectorAll(".continue-option").length).toBeLessThanOrEqual(8);
  });

  it("tapping the chosen Book continues button plays it and opens the pick modal", async () => {
    renderScreen();
    const user = userEvent.setup();
    const fenBefore = lastApi!.config.fen;
    await user.click(chosenContinueButton());

    expect(await screen.findByRole("dialog", { name: "Choose your Pawn" })).toBeInTheDocument();
    expect(lastApi!.config.fen).not.toBe(fenBefore); // the board shows the move, even though it isn't locked in yet
  });

  it("after 1. e4, the last-move highlight is on e2 and e4", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton());

    await screen.findByRole("dialog", { name: "Choose your Pawn" });
    expect(lastApi!.config.lastMove).toEqual(["e2", "e4"]);
  });

  it("tapping a non-chosen Book continues button plays that move and opens the modal", async () => {
    renderScreen();
    const user = userEvent.setup();
    // Capped and ranked (Task 38b) -- which specific moves land in the top
    // 8 besides the chosen one isn't the point here, just that a
    // non-chosen option is clickable and behaves the same as the chosen
    // one does in the other tests.
    const other = document.querySelector(".continue-option:not(.chosen)") as HTMLElement;
    expect(other).not.toBeNull();

    await user.click(other);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(0); // still not committed
  });

  // Task 43: the pick modal's own move-list display, under the title.
  it("playing the chosen line's own suggested move shows its full move list, with that move highlighted", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // Morphy Defense's own 1. e4

    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    const moveList = dialog.querySelector(".pick-move-list") as HTMLElement;
    expect(moveList.textContent?.replace(/\s+/g, " ").trim()).toBe("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6"); // the full chosen line, not just what's played
    const highlighted = moveList.querySelector(".highlight") as HTMLElement;
    expect(highlighted.textContent).toBe("e4"); // the move being picked right now
  });

  it("deviating from the chosen line shows only the moves played so far, with the pending one highlighted", async () => {
    renderScreen();
    simulateMove("d2", "d4"); // deviates from Morphy Defense's own 1. e4

    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    const moveList = dialog.querySelector(".pick-move-list") as HTMLElement;
    expect(moveList.textContent?.replace(/\s+/g, " ").trim()).toBe("1. d4"); // not the Morphy Defense line
    const highlighted = moveList.querySelector(".highlight") as HTMLElement;
    expect(highlighted.textContent).toBe("d4");
  });

  // Task 43: this and a handful of other real-interaction tests below
  // (flagged individually) run right at the edge of Vitest's 5000ms
  // default under full-suite load -- confirmed via several repeated full-
  // suite and isolated runs this session, same pre-existing cause as
  // BuildScreen.secondMove.test.tsx/SetupScreen.test.tsx's own fix
  // elsewhere this task (real chessground + real engine work, no
  // removable inefficiency found). Extended to match that same precedent,
  // not newly invented here.
  it(
    "the pick modal shows the 'After this pick' footer, and Lock player commits the top candidate",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      simulateMove("d2", "d4"); // deviates from the suggested e4

      const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      expect(dialog.textContent).not.toContain("After this pick:"); // nothing selected yet

      await selectTopRow(user, dialog);
      expect(dialog.textContent).toContain("After this pick:");

      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

      expect(screen.queryByRole("dialog")).toBeNull(); // modal closes once the pick locks
      expect(document.querySelector(".opening-moves")?.textContent).toContain("d4"); // now actually locked in
      // Bug fix (lineup optimizer task): no longer asserts Black's field
      // column is still empty *synchronously* right here -- that was always
      // racing BLACK_REPLY_DELAY_MS's real 600ms setTimeout against however
      // long this test's own synchronous work takes to run, and the
      // optimizer's own best-completion recompute (engine/optimizer.ts,
      // now triggered by this very commit) adds just enough real CPU cost
      // under this project's own documented full-suite parallel load
      // (HANDOFF.md's Environment note) to occasionally lose that race.
      // The behavior that actually matters -- Black eventually replies --
      // is already covered robustly by the waitFor below regardless of
      // timing.
      await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
    },
    15000,
  );

  // Bug fix (post-Task-40): selecting a row previously showed no visible
  // change (a default pre-selection made "Lock player" immediately
  // clickable with nothing for the player to actually click). Now nothing
  // is selected until a row is clicked.
  it(
    "selecting a row marks it selected and updates the footer",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      simulateMove("d2", "d4");

      const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      expect(dialog.textContent).not.toContain("After this pick:");
      expect(within(dialog).getByRole("button", { name: "Lock player" })).toBeDisabled();

      const firstRow = dialog.querySelector(".pick-row") as HTMLElement;
      await user.click(firstRow);

      expect(firstRow).toHaveClass("selected");
      expect(dialog.textContent).toContain(`Selected: ${firstRow.querySelector(".pick-row-name")!.textContent!.split(" · ")[0]}`);
      expect(dialog.textContent).toContain("After this pick:");
      expect(within(dialog).getByRole("button", { name: "Lock player" })).not.toBeDisabled();
    },
    15000,
  );

  it("cancel restores the previous position and the banner's chosen line", async () => {
    renderScreen();
    const user = userEvent.setup();
    const fenBefore = lastApi!.config.fen;

    await user.click(chosenContinueButton());
    await screen.findByRole("dialog", { name: "Choose your Pawn" });
    expect(lastApi!.config.fen).not.toBe(fenBefore); // the board shows the tentative move

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastApi!.config.fen).toBe(fenBefore); // visually reverted
    expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(0); // never actually committed
    expect(chosenContinueButton()?.textContent).toContain("1. e4"); // still on the chosen line
  });

  it("after deviating, the banner shows 'Left the line after <move>'", async () => {
    renderScreen();
    const user = userEvent.setup();
    simulateMove("d2", "d4"); // no longer the Ruy Lopez's own "e4"
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    expect(screen.getByText("Left the line after d4")).toBeInTheDocument();
    expect(document.querySelector(".continue-option.chosen")).toBeNull(); // no chosen move left to highlight
  });
});

// Bug fix: Black's own committed line (build.playBlackMove's "keep the
// committed line while it still matches, re-choose by rank-closeness once
// it doesn't") was never seeded from the chosen opening -- it started null,
// so Black re-chose by rank-closeness on its very FIRST reply regardless of
// what White chose, immediately contradicting the chosen line (banner:
// "Left the line after <Black's own first move>" before White ever
// deviated at all). See BuildScreen.tsx's state initializer.
describe("BuildScreen -- the field follows a chosen opening line, not just rank-closeness (bug fix)", () => {
  it("plays the French Defense Classical's own 1...e6, not whatever rank-closeness would otherwise pick", async () => {
    const user = userEvent.setup();
    render(
      <BuildScreen
        preset={H2H}
        players={PLAYERS}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "line", line: FRENCH_CLASSICAL }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );
    await user.click(chosenContinueButton()); // the template's own 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    expect(statusLine().textContent).toMatch(/^Field played e6 and locked/);
    expect(document.querySelector(".opening-subtext")?.textContent ?? "").not.toContain("Left the line");
  });

  // Bug fix: "Book continues" sorted by RANK_BY_FAMILY alone -- a whole-
  // family, whole-corpus popularity rank, not how often each move is
  // actually played FROM THIS POSITION. 2. Nf3 (the single most popular
  // reply to 1. e4 e5 by a wide margin, per data/openings/popularity.json)
  // ranked dead last (its family, "King's Knight Opening," is deliberately
  // excluded from RANKED_FAMILIES as too generic to *suggest*), pushing it
  // past CONTINUATION_LIMIT's top-8 cut entirely. Uses the Vienna Game (1.
  // e4 e5 2. Nc3) as the chosen line specifically so its own next move
  // ("Nc3," not Nf3) is what sorts first as "isChosen" -- Nf3's own
  // position is then driven purely by real per-position popularity
  // (openings.bookWeights), not by coincidentally being the chosen move.
  it("ranks 2. Nf3 first or second after 1. e4 e5, by real per-position popularity", async () => {
    const user = userEvent.setup();
    render(
      <BuildScreen
        preset={H2H}
        players={PLAYERS}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "line", line: VIENNA_GAME }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );
    await user.click(chosenContinueButton()); // the template's own 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
    expect(statusLine().textContent).toMatch(/^Field played e5 and locked/); // confirms the position is "1. e4 e5"

    const options = [...document.querySelectorAll(".continue-option")];
    const nf3Index = options.findIndex((el) => el.querySelector(".continue-move")?.textContent?.includes("Nf3"));
    expect(nf3Index).toBeGreaterThanOrEqual(0); // present at all (was pushed past the top-8 cut before the fix)
    expect(nf3Index).toBeLessThanOrEqual(1); // first (index 0) or second (index 1, right after Nc3's own "isChosen" slot)
  });
});

describe("BuildScreen -- a rejected move is never dropped silently (bug fix)", () => {
  it("reports why in the status line instead of doing nothing", async () => {
    renderScreen();
    simulateMove("e2", "e5"); // not one of White's own offered dests

    await waitFor(() => expect(statusLine().textContent).toBe("e2-e5 isn't a legal move right now."));
    expect(screen.queryByRole("dialog")).toBeNull(); // nothing was actually played
    expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("clears once a real move is played", async () => {
    renderScreen();
    const user = userEvent.setup();
    simulateMove("e2", "e5");
    await waitFor(() => expect(statusLine().textContent).toBe("e2-e5 isn't a legal move right now."));

    await user.click(chosenContinueButton());
    expect(await screen.findByRole("dialog", { name: "Choose your Pawn" })).toBeInTheDocument();
    expect(statusLine().textContent).not.toContain("isn't a legal move");
  });

  it("clears on Take back", async () => {
    renderScreen();
    const user = userEvent.setup();
    simulateMove("d2", "d4");
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    simulateMove("e2", "e5"); // bogus move once it's White's turn again
    await waitFor(() => expect(statusLine().textContent).toBe("e2-e5 isn't a legal move right now."));

    await user.click(screen.getByRole("button", { name: "Take back" }));
    expect(statusLine().textContent).not.toContain("isn't a legal move");
  });
});

// Rule change: a move that's legal chess but blocked by the DFS rules is
// now offered as a drag destination too (not silently excluded) -- the
// drop still refuses to commit, with the engine's own reason in the
// status line.
describe("BuildScreen -- blocked moves (rule change)", () => {
  it("an ordinary move with no fitting player is refused with a reason, and nothing is actually played", async () => {
    // A single Knight-band (TE) player, no Pawn-band player at all: White
    // can still open with a Knight (so the build isn't an immediate dead
    // end), but a Pawn move like e4 has no fitting player.
    const onlyKnight = new Player({
      id: "te1", name: "te1", positions: ["TE"], team: "AAA", opp: "BBB",
      salary: 5200, proj: 10.0, ownSmall: 0.1, ownLarge: 0.1, floor: 6.0, ceiling: 16.0,
    });
    render(
      <BuildScreen
        preset={H2H}
        players={[onlyKnight]}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "own" }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );
    const fenBefore = lastApi!.config.fen;
    expect(lastApi!.config.movable!.dests!.get("e2" as never)).toContain("e4"); // chess-legal, offered despite no fit
    simulateMove("e2", "e4");

    await waitFor(() =>
      expect(statusLine().textContent).toBe("e4 blocked: no player in the Pawn list fits your remaining roster and salary."),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(0);
    expect(lastApi!.config.fen).toBe(fenBefore); // the move never actually applied
  });
});

describe("BuildScreen -- click-to-move (bug fix)", () => {
  // Reported bug: click-select then click-destination on the build board
  // didn't move the piece (dragging did). The FakeApi's selectSquare (above)
  // models the same two-step click chessground itself uses internally; see
  // BuildBoard.test.tsx for the identical two clicks run against the real,
  // unmocked chessground library -- both disprove this task's own two
  // suspects ("chessground reconfigured on re-render, resetting selection"
  // and "the move handler only fires for drags"). No code-level cause was
  // found.
  it("a click-select then click-destination makes the move and opens the pick modal", async () => {
    renderScreen();
    lastApi!.selectSquare("g1"); // click 1: select the Knight
    lastApi!.selectSquare("f3"); // click 2: click its destination dot

    expect(await screen.findByRole("dialog", { name: "Choose your Knight" })).toBeInTheDocument();
  });

  it("a re-render between the two clicks doesn't drop the selection", async () => {
    const { rerender } = renderScreen();
    lastApi!.selectSquare("g1");

    rerender(
      <BuildScreen
        preset={H2H}
        players={PLAYERS}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "line", line: MORPHY_DEFENSE }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );

    lastApi!.selectSquare("f3");
    expect(await screen.findByRole("dialog", { name: "Choose your Knight" })).toBeInTheDocument();
  });
});

describe("BuildScreen -- pick list is no longer capped (Rule change)", () => {
  it("shows every eligible Knight, not just the old top-12 cap", async () => {
    renderScreen();
    lastApi!.selectSquare("g1"); // develops the Knight -- Queen/Rook/Bishop/Knight were each capped at 12
    lastApi!.selectSquare("f3");

    const dialog = await screen.findByRole("dialog", { name: "Choose your Knight" });
    const rows = dialog.querySelectorAll(".pick-row");
    expect(rows.length).toBeGreaterThan(12); // the full eligible pool, uncapped
  });
});

describe("BuildScreen -- status line (Task 38d)", () => {
  it("shows 'Your move' on arrival", () => {
    renderScreen();
    expect(statusLine().textContent).toContain("Your move");
  });

  it("shows 'Pick your <piece>' once a move is played and the modal is open", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton());

    await screen.findByRole("dialog", { name: "Choose your Pawn" });
    expect(statusLine().textContent).toBe("Pick your Pawn.");
  });

  it("shows the Field's move once Black replies, then the White-to-move text", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton());
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    expect(statusLine().textContent).toBe("The Field is moving…");

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    expect(statusLine().textContent).toMatch(/^Field played .+ and locked .+\. Your move\./);
  });
});

describe("BuildScreen -- Core projection stat (Task 38c)", () => {
  it("shows Core projection under Core ownership in both the You and Field cards", () => {
    renderScreen();
    for (const column of [youColumn(), fieldColumn()]) {
      expect(within(column).getByText("Core projection")).toBeInTheDocument();
      expect(within(column).getByText(/^0\.0 pts$/)).toBeInTheDocument(); // no picks locked yet
    }
  });
});

describe("BuildScreen -- How it works strip (Task 38d)", () => {
  it("shows the strip by default, hides it once dismissed, and stays hidden after reload", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <BuildScreen
        preset={H2H}
        players={PLAYERS}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "line", line: MORPHY_DEFENSE }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );
    expect(screen.getByText(/You're White\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/You're White\./)).toBeNull();

    unmount(); // simulates a reload -- a fresh mount, same localStorage
    renderScreen();
    expect(screen.queryByText(/You're White\./)).toBeNull();
  });
});
