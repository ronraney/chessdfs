// @vitest-environment jsdom
// Housekeeping "Faster tests": split out of the former BuildScreen.test.tsx
// along its own existing describe blocks (no test content changed, no
// tests added or removed) so Vitest can run these chunks on separate
// workers -- see BuildScreen.movePick/tightFinish/castling/
// hoverTooltip.test.tsx for the rest. This file keeps every describe
// block about what happens once White's core is done (or Black's reply
// fails): endings and start again, Black's reply never crashing the
// build, Field's Pts from optimal, Sim 4's sim results, and Fill out my
// core.
//
// chessground manipulates raw DOM pixel geometry to detect drag/drop,
// which jsdom can't lay out at all (getBoundingClientRect is always
// zeroed) -- there's no way to simulate a real drag in this environment,
// so "@lichess-org/chessground" is mocked here: the fake Chessground()
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
import { BOOK, NFL, PRESETS } from "./appData";
import BuildScreen, { setBlackReplyDelayForTests } from "./BuildScreen";
import { playBlackMove } from "./engine/build";
import { loadEtrCsv } from "./engine/loaders";
import { KingMode, Piece } from "./engine/models";
import { classify } from "./engine/pieces";
import { NO_FIELD_CACHED_MESSAGE, saveCachedFieldIds, slateSignature } from "./fieldCacheStore";
import { saveProjectionsCsv } from "./projectionsStore";
import { SAMPLE_CSV } from "./testFixtures";

// Bug fix: `playBlackMove` is partially mocked (real implementation kept
// by default) so one test can force it to throw something other than its
// own NoLegalBlackMoveError, without hand-crafting a real engine scenario
// for "an unexpected error" (which, by definition, isn't a scenario the
// engine is supposed to produce on purpose).
vi.mock("./engine/build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/build")>();
  return { ...actual, playBlackMove: vi.fn(actual.playBlackMove) };
});

interface FakeApi {
  config: Config;
  set(partial: Partial<Config>): void;
  destroy(): void;
  selectSquare(key: string): void;
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

// Simulates a completed drag/drop -- the same call chessground's own
// `movable.events.after` callback would receive once a legal drop lands.
function simulateMove(orig: string, dest: string): void {
  lastApi!.config.movable!.events!.after!(orig as never, dest as never, { premove: false });
}

const PLAYERS = loadEtrCsv(SAMPLE_CSV);
const H2H = PRESETS.find((preset) => preset.name === "H2H")!;
const MORPHY_DEFENSE = BOOK.find((line) => line.eco === "C70" && line.name === "Ruy Lopez: Morphy Defense")!;
const WHITE_QB = PLAYERS.find((p) => p.name === "Joe Burrow")!;
const BLACK_QB = PLAYERS.find((p) => p.name === "Jared Goff")!;

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
// a row first. "Top row" means the top SELECTABLE one (infeasible rows
// are real disabled buttons).
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
  vi.mocked(playBlackMove).mockClear(); // clears call history only -- the wrapped real implementation stays
});

function statusLine(): HTMLElement {
  return document.querySelector(".status-line") as HTMLElement;
}

// Task 40: endings (Stop/dead end), the finish screen, Start again, and
// Take back.
describe("BuildScreen -- endings and start again (Task 40)", () => {
  it(
    "Stop with this core shows the summary with the locked players",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      await user.click(chosenContinueButton()); // 1. e4
      const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      // Wait for Black's reply to land first -- Stop is disabled while Black
      // is mid-reply, same as Take back.
      await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

      const lockedName = youColumn().querySelector(".locked-name")!.textContent!.split(" · ")[0];

      // Task 41 moved this button from under the You card to board-column,
      // beside Take back (the mobile pass's own explicit ordering).
      await user.click(screen.getByRole("button", { name: "Stop with this core" }));

      expect(screen.getByText("You stopped with this core.")).toBeInTheDocument();
      expect(screen.getByText("Happy Hunting")).toBeInTheDocument();
      const finishCard = document.querySelector(".finish-card") as HTMLElement;
      expect(within(finishCard).getByText(lockedName)).toBeInTheDocument();

      // Task 43: a DK roster slot (Slot column), before Piece -- folded
      // into this same test (not a new one) since it already drives the
      // exact lock -> Black-reply -> Stop flow needed; a second standalone
      // test would just repeat that same real-engine setup for no added
      // coverage.
      const headers = [...finishCard.querySelectorAll(".finish-core thead th")].map((th) => th.textContent);
      expect(headers[0]).toBe("Slot");
      expect(headers[1]).toBe("Piece");
      const firstRowCells = [...finishCard.querySelectorAll(".finish-core tbody tr")[0].querySelectorAll("td")].map((td) => td.textContent);
      expect(["QB", "RB", "WR", "TE", "FLEX", "DST"]).toContain(firstRowCells[0]);
    },
    15000,
  );

  it(
    "Copy lineup copies the locked core and totals as plain text, then shows Copied briefly",
    async () => {
      renderScreen();
      const user = userEvent.setup(); // installs its own navigator.clipboard stub (writeText/readText) -- real enough to round-trip through, no separate mock needed
      await user.click(chosenContinueButton()); // 1. e4
      const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

      const lockedName = youColumn().querySelector(".locked-name")!.textContent!.split(" · ")[0];
      await user.click(screen.getByRole("button", { name: "Stop with this core" }));

      await user.click(screen.getByRole("button", { name: "Copy lineup" }));

      const text = await waitFor(async () => {
        const t = await navigator.clipboard.readText();
        expect(t).not.toBe("");
        return t;
      });
      expect(text).toContain(lockedName);
      // Task 43: Slot is the first tab-separated field, before the Piece label.
      const firstDataLine = text.split("\n")[0];
      const [slotCell] = firstDataLine.split("\t");
      expect(["QB", "RB", "WR", "TE", "FLEX", "DST"]).toContain(slotCell);
      expect(text).toMatch(/Salary used: \$[\d,]+/);
      expect(text).toMatch(/Salary remaining: \$[\d,]+/);
      expect(text).toMatch(/Projection: [\d.]+ pts/);
      expect(text).toMatch(/Ownership: [\d.]+%/);
      expect(text).toMatch(/Opening: .+/);
      expect(text).toMatch(/Moves: 1\. e4/);

      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Copy lineup" })).toBeInTheDocument(), { timeout: 3000 });
    },
    15000,
  );

  it("a dead end shows the right message and open slots", async () => {
    // An empty player pool: every one of White's 20 legal first moves has
    // zero eligible, unlocked players for whichever piece type it would
    // lock -- the same "totally dead immediately" scenario build.test.ts's
    // own checkWhiteDeadEnd coverage uses, just reached through the real
    // screen instead of a hand-built BuildState.
    render(
      <BuildScreen
        preset={H2H}
        players={[]}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "own" }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );

    expect(await screen.findByText("You have hit a dead end.")).toBeInTheDocument();
    expect(screen.getByText("Happy Hunting")).toBeInTheDocument();
    const finishCard = document.querySelector(".finish-card") as HTMLElement;
    const openSlotsLine = within(finishCard).getByText(/^Open slots:/);
    for (const slot of ["QB", "RB", "WR", "TE", "FLEX", "DST"]) {
      expect(openSlotsLine.textContent).toContain(slot);
    }
  });

  it("the header link asks for confirmation after a pick", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Start again" })); // the header link -- turn is Black's right now, so no other "Start again" is on screen

    expect(confirmSpy).toHaveBeenCalled();
    expect(onStartAgain).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // Task NN "Start over during the build": the action-row button beside
  // Take back / Stop with this core / Sim my core / Fill out my core --
  // always confirms first (unlike the header link above, which only
  // confirms once a player is locked), and does exactly what the finish
  // screen's "Start again" does once confirmed.
  it("Start over in the action row confirms first; cancelling leaves the build untouched, confirming does what Start again does", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    const cancelSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(cancelSpy).toHaveBeenCalledWith("Start over? This build will be lost.");
    expect(onStartAgain).not.toHaveBeenCalled();
    expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(1); // the lock from 1. e4 is still there
    cancelSpy.mockRestore();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(onStartAgain).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it(
    "take back after a pick restores salary remaining and returns the player to the pick list",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      await user.click(chosenContinueButton()); // 1. e4
      const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

      const lockedName = youColumn().querySelector(".locked-name")!.textContent!.split(" · ")[0];
      const fullCap = `$${H2H.contest.effectiveCap(NFL).toLocaleString()}`;

      await user.click(screen.getByRole("button", { name: "Take back" }));

      expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(0);
      expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(0);
      expect(within(youColumn()).getByText(fullCap)).toBeInTheDocument(); // salary remaining is back to the full cap

      simulateMove("e2", "e4"); // the same move is legal again from the start position
      const dialog2 = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      expect(within(dialog2).getByText(new RegExp(lockedName))).toBeInTheDocument(); // the player is back in the pick list
    },
    15000,
  );
});

// Bug fix: Black's reply crashed the build with a false "Black has hit a
// dead end." when its own preferred book continuation wasn't DFS-legal.
// The engine's own re-choose logic (chooseBlackCommittedLine filters book
// continuations by playability before ever committing to one) already
// covers this; these tests cover the screen's own side: a real depleted
// band doesn't crash the build, and the screen only ever reports a dead
// end for the engine's own NoLegalBlackMoveError, never for anything else.
describe("BuildScreen -- Black's reply never crashes the build (bug fix)", () => {
  const LONDON_SYSTEM = BOOK.find((line) => line.eco === "A48" && line.name === "London System")!;

  it("Black still moves with no Knight-band TE available (London System line)", async () => {
    const noTE = PLAYERS.filter((p) => !classify(p, NFL).has(Piece.KNIGHT));
    render(
      <BuildScreen
        preset={H2H}
        players={noTE}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "line", line: LONDON_SYSTEM }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // plays the London System's own first move, 1. d4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
    expect(screen.queryByText(/dead end/i)).toBeNull();
  });

  it("an unexpected error from Black's move is not reported as a dead end", async () => {
    vi.mocked(playBlackMove).mockImplementationOnce(() => {
      throw new Error("boom: something broke");
    });
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton());
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    await waitFor(() => expect(statusLine().textContent).toBe("Something went wrong: boom: something broke"), { timeout: 2000 });

    expect(screen.queryByText(/dead end/i)).toBeNull();
    expect(document.querySelector(".finish-card")).toBeNull(); // the build hasn't ended
    expect(screen.getByRole("button", { name: "Take back" })).not.toBeDisabled();
  });
});

// Field gets Pts from optimal: the same stat White's panel already showed
// (locks forced, the other side's picks excluded, same slate optimal),
// mirrored for Black -- during the build (both side columns) and on the
// finish screen (both sides' lines).
describe("BuildScreen -- Field gets Pts from optimal", () => {
  it("both side columns show Pts from optimal once a pick locks", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    expect(within(youColumn()).getByText("Pts from optimal")).toBeInTheDocument();
    expect(within(fieldColumn()).getByText("Pts from optimal")).toBeInTheDocument();
    const youValue = youColumn().querySelector(".side-pts-from-optimal")!.textContent;
    const fieldValue = fieldColumn().querySelector(".side-pts-from-optimal")!.textContent;
    expect(youValue).not.toBe("—");
    expect(fieldValue).not.toBe("—");
  });

  it("the finish screen shows Pts from optimal for both sides", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    await user.click(screen.getByRole("button", { name: "Stop with this core" }));

    const finishCard = document.querySelector(".finish-card") as HTMLElement;
    expect(within(finishCard).getByText(/^Pts from optimal:/)).toBeInTheDocument();
    expect(within(finishCard).getByText(/^Field pts from optimal:/)).toBeInTheDocument();
  });
});

// Sim 4: sim results in the UI. jsdom has no real Worker (the same
// standing gap fieldWorker.ts/stockfishEngine.ts already live with) --
// every one of these exercises the real BuildScreen code up to and
// including `new Worker(...)` itself; what differs from a real browser is
// only what happens after (a ReferenceError there, caught, surfaces as an
// "error" sim state instead of a real SimResult). Nothing here saves a
// projections CSV to localStorage (same `window.localStorage.clear()`
// beforeEach every other describe block relies on), so `cachedField`
// always resolves null -- the "no cached field" branch is the one path
// fully provable in this environment without a real Worker at all.
describe("BuildScreen -- Sim 4: sim results", () => {
  it('shows "Sim my core" once a pick locks, and both sides show "Build fields in Admin first." after clicking it', async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    const simButton = screen.getByRole("button", { name: "Sim my core" });
    await user.click(simButton);

    await waitFor(() => {
      expect(within(youColumn()).getByText("Build fields in Admin first.")).toBeInTheDocument();
      expect(within(fieldColumn()).getByText("Build fields in Admin first.")).toBeInTheDocument();
    });
    // Both cores are still partial (one White pawn, one Black reply) --
    // the label should say so on both sides.
    expect(within(youColumn()).getByText("Sim results (best finish)")).toBeInTheDocument();
    expect(within(fieldColumn()).getByText("Sim results (best finish)")).toBeInTheDocument();
  });

  it('auto-runs on the finish screen and shows "Build fields in Admin first." for both sides with no click needed', async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    await user.click(screen.getByRole("button", { name: "Stop with this core" }));

    const finishCard = document.querySelector(".finish-card") as HTMLElement;
    await waitFor(() => {
      expect(within(finishCard).getByText(/^Sim ROI \(best finish\):/)).toBeInTheDocument();
      expect(within(finishCard).getByText(/^Field sim ROI \(best finish\):/)).toBeInTheDocument();
    });
    expect(within(finishCard).getAllByText("Build fields in Admin first.")).toHaveLength(2); // White's line + Black's line
  });

  it("a cached field makes the worker dispatch path run without crashing the screen (surfaces as an error, not a thrown exception, since jsdom has no real Worker)", async () => {
    saveProjectionsCsv(SAMPLE_CSV);
    saveCachedFieldIds(slateSignature(SAMPLE_CSV), H2H.contest.fieldTier(), [[WHITE_QB.id, BLACK_QB.id]]);

    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    await user.click(screen.getByRole("button", { name: "Sim my core" }));

    await waitFor(() => {
      const youText = youColumn().querySelector(".side-detail")?.textContent ?? "";
      expect(youText).not.toBe("");
      expect(youText).not.toBe(NO_FIELD_CACHED_MESSAGE);
    });
  });

  it("clicking Sim my core twice in a row doesn't crash and settles into one consistent state", async () => {
    renderScreen();
    const user = userEvent.setup();
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    const simButton = screen.getByRole("button", { name: "Sim my core" });
    await user.click(simButton);
    await user.click(screen.getByRole("button", { name: "Sim my core" }));

    await waitFor(() => {
      expect(within(youColumn()).getByText("Build fields in Admin first.")).toBeInTheDocument();
      expect(within(fieldColumn()).getByText("Build fields in Admin first.")).toBeInTheDocument();
    });
  });
});

// "Fill out my core": fills White's open slots with the optimizer's own
// best completion (the exact same OptimizerResult "Pts from optimal"
// already computes) and ends the build. One real White pick is locked
// first in every test below -- the same precondition "Pts from optimal"'s
// own tests already rely on to guarantee optimalLineup finds a feasible
// completion under the real sample slate's cap.
describe("BuildScreen -- Fill out my core", () => {
  async function lockOnePawn(user: UserEvent): Promise<void> {
    await user.click(chosenContinueButton()); // 1. e4
    const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
  }

  it('fills the open slots, marks them "(optimizer)", and shows the finish screen', async () => {
    renderScreen();
    const user = userEvent.setup();
    await lockOnePawn(user);

    const fillButton = screen.getByRole("button", { name: "Fill out my core" });
    expect(fillButton).toBeEnabled();
    await user.click(fillButton);

    expect(screen.getByText("Your core was filled out by the optimizer.")).toBeInTheDocument();
    const finishCard = document.querySelector(".finish-card") as HTMLElement;
    // Header row + 9 roster rows (1 locked pawn + 8 optimizer-filled).
    expect(within(finishCard).getAllByRole("row")).toHaveLength(10);
    expect(within(finishCard).getAllByText("(optimizer)")).toHaveLength(8);
  });

  it("the You panel marks optimizer-filled players distinctly from the move-locked one", async () => {
    renderScreen();
    const user = userEvent.setup();
    await lockOnePawn(user);

    await user.click(screen.getByRole("button", { name: "Fill out my core" }));

    const you = youColumn();
    expect(within(you).getAllByRole("listitem")).toHaveLength(9);
    expect(within(you).getAllByText("(optimizer)")).toHaveLength(8);
  });

  it("feeds the full (locked + filled) roster to Copy lineup, with optimizer rows marked", async () => {
    renderScreen();
    const user = userEvent.setup(); // installs its own navigator.clipboard stub (writeText/readText)
    await lockOnePawn(user);
    await user.click(screen.getByRole("button", { name: "Fill out my core" }));

    await user.click(screen.getByRole("button", { name: "Copy lineup" }));

    const text = await waitFor(async () => {
      const t = await navigator.clipboard.readText();
      expect(t).not.toBe("");
      return t;
    });
    const lines = text.split("\n");
    const rosterLines = lines.slice(0, 9); // 9 roster rows before the blank separator + totals
    const optimizerRows = rosterLines.filter((line) => line.includes("\t(optimizer)\t"));
    expect(optimizerRows).toHaveLength(8);
    // "Salary used" must equal the sum of all 9 rows' own salary column --
    // only true if Copy lineup read the full post-fill roster (whiteStats
    // already folds in the filled players, see whiteRoster's own
    // comment); if it had frozen on the pre-fill snapshot, this total
    // would equal just the one locked pawn's salary instead.
    const rowSalaries = rosterLines.map((line) => Number(line.split("\t").at(-1)!.replace(/[^0-9]/g, "")));
    const salaryUsedLine = lines.find((line) => line.startsWith("Salary used:"))!;
    const salaryUsed = Number(salaryUsedLine.replace(/[^0-9]/g, ""));
    expect(salaryUsed).toBe(rowSalaries.reduce((sum, s) => sum + s, 0));
  });

  it("clicking Fill out my core from the Stop finish screen still fills and switches the headline", async () => {
    renderScreen();
    const user = userEvent.setup();
    await lockOnePawn(user);
    await user.click(screen.getByRole("button", { name: "Stop with this core" }));
    expect(screen.getByText("You stopped with this core.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fill out my core" }));

    expect(screen.getByText("Your core was filled out by the optimizer.")).toBeInTheDocument();
    expect(screen.queryByText("You stopped with this core.")).not.toBeInTheDocument();
    const finishCard = document.querySelector(".finish-card") as HTMLElement;
    expect(within(finishCard).getAllByText("(optimizer)")).toHaveLength(8);
  });

  // Rule change "Salary-cap notice + finished-lineup cleanup": a side with
  // no open slots left hides the button entirely now, rather than leaving
  // it disabled.
  it("is hidden once White's lineup is already complete (via a prior fill)", async () => {
    renderScreen();
    const user = userEvent.setup();
    await lockOnePawn(user);
    await user.click(screen.getByRole("button", { name: "Fill out my core" }));

    expect(screen.queryByRole("button", { name: "Fill out my core" })).not.toBeInTheDocument();
  });
});
