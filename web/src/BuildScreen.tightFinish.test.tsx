// @vitest-environment jsdom
// Housekeeping "Faster tests": split out of the former BuildScreen.test.tsx
// along its own existing describe block (no test content changed, no
// tests added or removed) so Vitest can run it on its own worker -- see
// BuildScreen.movePick/castling/hoverTooltip/endings.test.tsx for the
// rest. This file keeps the "tight finish alert" describe block, the one
// that partially mocks buildStats.tightFinishStatus.
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
import { Chess } from "chess.js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@lichess-org/chessground/config";
import { BOOK, PRESETS } from "./appData";
import BuildScreen, { setBlackReplyDelayForTests } from "./BuildScreen";
import { tightFinishStatus } from "./buildStats";
import type { TightFinishStatus } from "./buildStats";
import { KingMode } from "./engine/models";
import { loadEtrCsv } from "./engine/loaders";
import { SAMPLE_CSV } from "./testFixtures";

// Rule change: `tightFinishStatus` is partially mocked (real implementation
// kept by default -- restored in beforeEach below via a fresh
// vi.importActual, same spirit as BuildScreen.endings.test.tsx's own
// `playBlackMove` mock) so the tight-finish-alert tests can script exactly
// which level each pick reports without needing a genuinely expensive,
// many-pick real roster to reach "caution"/"warning" against the real
// $50,000 cap -- those thresholds already have their own direct unit
// coverage in buildStats.test.ts; what's new (and under test) here is
// purely BuildScreen's own wiring (the dialog, once per level, skipped on
// mount and once the build's over).
vi.mock("./buildStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./buildStats")>();
  return { ...actual, tightFinishStatus: vi.fn(actual.tightFinishStatus) };
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

function youColumn(): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: "You" }).closest(".side-column") as HTMLElement;
}

// Bug fix (post-Task-40): the pick modal no longer pre-selects a row --
// every test that used to go straight to "Lock player" now has to select
// a row first. Rows are sorted by the moved piece's own metric (RULES.md
// piece table), descending, so the first one is always "the top
// candidate" every pre-existing test's own name/intent already assumed.
// "Top row" means the top SELECTABLE one.
async function selectTopRow(user: UserEvent, dialog: HTMLElement): Promise<void> {
  const rows = [...dialog.querySelectorAll<HTMLButtonElement>(".pick-row")];
  const firstRow = rows.find((row) => !row.disabled) ?? rows[0];
  await user.click(firstRow);
}

beforeEach(async () => {
  lastApi = null;
  window.localStorage.clear();
  onStartAgain.mockClear();
  onNewContest.mockClear();
  // Undoes any test's own scripted implementation -- a fresh real
  // reference each time (see the mock's own comment above for why this
  // can't just be captured once at module scope).
  const real = await vi.importActual<typeof import("./buildStats")>("./buildStats");
  vi.mocked(tightFinishStatus).mockReset().mockImplementation(real.tightFinishStatus);
});

// Rule change: the existing inline "tight finish" copy (buildStats.ts's
// tightFinishStatus, shown in the You panel and the pick modal's own
// "after this pick" preview) is easy to miss -- an in-app dialog
// (TightFinishDialog.tsx) now shows too, once per level, the moment a
// LOCKED pick first reaches it. tightFinishStatus itself is mocked (see
// the top of this file) so these tests can script exactly which level a
// pick reports without needing a genuinely expensive, many-pick real
// roster against the real $50,000 cap.
describe("BuildScreen -- tight finish alert (rule change)", () => {
  const CAUTION: TightFinishStatus = {
    level: "caution",
    avgRemainingPerOpenSlot: 4200,
    message: "Salary getting tight: $4,200 per open slot.",
  };
  const WARNING: TightFinishStatus = {
    level: "warning",
    avgRemainingPerOpenSlot: 3800,
    message: "Tight finish: $3,800 per open slot.",
  };
  const CRITICAL: TightFinishStatus = {
    level: "critical",
    avgRemainingPerOpenSlot: 1000,
    message: "Barely completable: $200 of room before the cheapest finish.",
  };

  function tightFinishDialog(): HTMLElement | null {
    return screen.queryByRole("dialog", { name: "Salary alert" });
  }

  async function dismissTightFinishDialog(user: UserEvent): Promise<void> {
    const dialog = screen.getByRole("dialog", { name: "Salary alert" });
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
  }

  // Same move/pick/wait-for-reply shape as the castling describe block's
  // own developKnightAndBishop (not reused directly -- that one's scoped
  // to its own file) -- any 3 legal, in-book moves work here, since
  // tightFinishStatus's real output is irrelevant once mocked.
  async function playAndLock(user: UserEvent, from: string, to: string): Promise<void> {
    simulateMove(from, to);
    const dialog = await screen.findByRole("dialog", { name: /^Choose your/ });
    await selectTopRow(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
    // Waits for Black's own reply to actually land -- NOT "dests
    // repopulate," which (Rule change "new levels + Go back") no longer
    // implies that on its own: the board goes inert (empty dests) while a
    // tight-finish dialog is up, same as while a pick is pending, and
    // every test here mocks tightFinishStatus to return non-null, so
    // that's exactly what happens right after this lock -- dismissed
    // explicitly by each test body afterward (that's what's actually
    // under test), not here. Checking the real chess turn (off the FEN
    // chessground itself was handed) instead of dests size is the signal
    // that's actually true either way.
    await waitFor(() => expect(new Chess(lastApi!.config.fen!).turn()).toBe("w"), { timeout: 2000 });
  }

  it("shows an in-app dialog the moment a locked pick first makes the build 'caution', keeping the inline text too", async () => {
    renderScreen();
    const user = userEvent.setup();

    expect(tightFinishDialog()).toBeNull(); // nothing to show yet, right at mount

    vi.mocked(tightFinishStatus).mockReturnValue(CAUTION);
    await playAndLock(user, "e2", "e4");

    const dialog = await screen.findByRole("dialog", { name: "Salary alert" });
    expect(within(dialog).getByRole("heading", { name: "Caution" })).toBeInTheDocument();
    expect(dialog.textContent).toContain(CAUTION.message);
    // The existing inline copy is still there too -- this doesn't replace it.
    expect(within(youColumn()).getByText(CAUTION.message)).toBeInTheDocument();

    await dismissTightFinishDialog(user);
    expect(tightFinishDialog()).toBeNull();
  }, 15000);

  it("shows a second, different dialog once a later pick makes it 'warning', but never re-shows a level already shown this build", async () => {
    renderScreen();
    const user = userEvent.setup();

    vi.mocked(tightFinishStatus).mockReturnValue(CAUTION);
    await playAndLock(user, "e2", "e4");
    expect(within(await screen.findByRole("dialog", { name: "Salary alert" })).getByRole("heading", { name: "Caution" })).toBeInTheDocument();
    await dismissTightFinishDialog(user);

    vi.mocked(tightFinishStatus).mockReturnValue(WARNING);
    await playAndLock(user, "g1", "f3");
    const warningDialog = await screen.findByRole("dialog", { name: "Salary alert" });
    expect(within(warningDialog).getByRole("heading", { name: "Warning" })).toBeInTheDocument();
    expect(warningDialog.textContent).toContain(WARNING.message);
    await dismissTightFinishDialog(user);

    // Back to "caution" (e.g. Take back, or a cheaper pick) -- already
    // shown once this build, so no third dialog.
    vi.mocked(tightFinishStatus).mockReturnValue(CAUTION);
    await playAndLock(user, "f1", "b5");
    expect(tightFinishDialog()).toBeNull();
  }, 15000);

  it("does not show a dialog from the pick modal's own hypothetical preview -- only once a pick actually locks", async () => {
    renderScreen();
    const user = userEvent.setup();

    // PickPanel's own "after this pick" preview calls tightFinishStatus
    // with the CANDIDATE already added (one more player than the real,
    // still-uncommitted roster) -- returning WARNING only for that longer
    // list (and nothing for BuildScreen's own, still-empty actual roster)
    // models "the preview already reads tight, the real roster doesn't
    // yet" without an unrelated re-render (opening the modal) spuriously
    // flipping the mock's return value out from under an unchanged roster.
    vi.mocked(tightFinishStatus).mockImplementation((players) => (players.length > 0 ? WARNING : null));
    simulateMove("e2", "e4");
    const pickDialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, pickDialog); // shows the "after this pick" preview -- still not committed

    expect(tightFinishDialog()).toBeNull();

    await user.click(within(pickDialog).getByRole("button", { name: "Lock player" }));
    expect(await screen.findByRole("dialog", { name: "Salary alert" })).toBeInTheDocument(); // only once the pick is actually locked
  }, 15000);

  it("shows the 'critical' level with its own heading and message", async () => {
    renderScreen();
    const user = userEvent.setup();

    vi.mocked(tightFinishStatus).mockReturnValue(CRITICAL);
    await playAndLock(user, "e2", "e4");

    const dialog = await screen.findByRole("dialog", { name: "Salary alert" });
    expect(within(dialog).getByRole("heading", { name: "Critical" })).toBeInTheDocument();
    expect(dialog.textContent).toContain(CRITICAL.message);
  }, 15000);

  // Rule change "new levels + Go back": the dialog's primary action.
  it("Go back undoes the just-locked pick and reopens that same piece's pick list", async () => {
    renderScreen();
    const user = userEvent.setup();

    vi.mocked(tightFinishStatus).mockReturnValue(CAUTION);
    simulateMove("e2", "e4");
    const pawnDialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    const fenWhilePending = lastApi!.config.fen; // e4 shown as a pending preview, nothing locked yet
    await selectTopRow(user, pawnDialog);
    await user.click(within(pawnDialog).getByRole("button", { name: "Lock player" }));

    const alert = await screen.findByRole("dialog", { name: "Salary alert" });
    expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(1); // the pick really did lock

    await user.click(within(alert).getByRole("button", { name: "Go back" }));

    expect(screen.queryByRole("dialog", { name: "Salary alert" })).toBeNull();
    expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(0); // the lock is undone
    const reopened = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    expect(reopened).toBeInTheDocument(); // same pick list, reopened
    // e4 is still shown pending (the SAME move, not yet re-locked) -- Go
    // back undoes the LOCK, not the move itself.
    expect(lastApi!.config.fen).toBe(fenWhilePending);
  }, 15000);

  it("Go back un-marks the level it undid, so locking an equally tight player again re-alerts (only OK suppresses it)", async () => {
    renderScreen();
    const user = userEvent.setup();

    vi.mocked(tightFinishStatus).mockReturnValue(CAUTION);
    simulateMove("e2", "e4");
    const pawnDialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, pawnDialog);
    await user.click(within(pawnDialog).getByRole("button", { name: "Lock player" }));
    await screen.findByRole("dialog", { name: "Salary alert" });

    // The real roster goes back to empty once Go back reverts it -- models
    // that honestly (null) rather than leaving the mock lying about an
    // unchanged roster, the same way the CAUTION -> WARNING -> CAUTION
    // test above exercises a real level change.
    vi.mocked(tightFinishStatus).mockReturnValue(null);
    await user.click(within(screen.getByRole("dialog", { name: "Salary alert" })).getByRole("button", { name: "Go back" }));
    await screen.findByRole("dialog", { name: "Choose your Pawn" });

    vi.mocked(tightFinishStatus).mockReturnValue(CAUTION);
    const reopened = screen.getByRole("dialog", { name: "Choose your Pawn" });
    await selectTopRow(user, reopened);
    await user.click(within(reopened).getByRole("button", { name: "Lock player" }));

    expect(await screen.findByRole("dialog", { name: "Salary alert" })).toBeInTheDocument(); // re-alerts, not suppressed
  }, 15000);
});
