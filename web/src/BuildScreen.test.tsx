// @vitest-environment jsdom
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
//
// Task 38b: rewritten for the redesigned screen -- the single "Suggested:
// X / Play it" banner is gone (replaced by "Book continues," which lists
// every offerable continuation, the chosen line's own next move first and
// highlighted); the pick panel is a centered modal titled "Choose your
// <Piece>" with a single "Lock player" button (candidates are fixed-sorted
// by projection, the top one pre-selected) rather than Task 38's per-row
// "Pick" buttons.
import { Chess } from "chess.js";
import type { Square } from "chess.js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@lichess-org/chessground/config";
import { BOOK, NFL, PRESETS } from "./appData";
import BuildScreen from "./BuildScreen";
import { ContestConfig } from "./engine/config";
import type { ContestPreset } from "./engine/config";
import { playBlackMove } from "./engine/build";
import { loadEtrCsv } from "./engine/loaders";
import { KingMode, Piece } from "./engine/models";
import { classify } from "./engine/pieces";
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
}

let lastApi: FakeApi | null = null;

vi.mock("@lichess-org/chessground", () => ({
  Chessground: (_el: HTMLElement, config: Config): FakeApi => {
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
    };
    lastApi = api;
    return api;
  },
}));

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

// Task 40: BuildScreen no longer owns "start again"/"new contest"
// navigation itself (that's App.tsx's job) -- every render site needs
// these two callback props regardless, so a pair of shared spies (reset
// in beforeEach below) saves repeating `vi.fn()` at every call site.
const onStartAgain = vi.fn();
const onNewContest = vi.fn();

function renderScreen() {
  render(
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
// a row first. Rows are sorted by projection descending, so the first one
// is always "the top candidate" every pre-existing test's own name/intent
// already assumed.
async function selectTopRow(user: UserEvent, dialog: HTMLElement): Promise<void> {
  const firstRow = dialog.querySelector(".pick-row") as HTMLElement;
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

describe("BuildScreen -- move first, then pick", () => {
  it("shows the chosen line's banner before any move, with Book continues offering it first", () => {
    renderScreen();
    expect(document.querySelector(".build-board")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    expect(screen.getByRole("heading", { level: 1, name: "Ruy Lopez" })).toBeInTheDocument();
    expect(screen.getByText("C70")).toBeInTheDocument();
    expect(screen.getByText("Morphy Defense")).toBeInTheDocument();

    const chosen = chosenContinueButton();
    expect(chosen).not.toBeNull();
    expect(chosen.textContent).toContain("1. e4");
  });

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

  it("the pick modal shows the 'After this pick' footer, and Lock player commits the top candidate", async () => {
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
    expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(0); // Black hasn't replied yet

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
  });

  // Bug fix (post-Task-40): selecting a row previously showed no visible
  // change (a default pre-selection made "Lock player" immediately
  // clickable with nothing for the player to actually click). Now nothing
  // is selected until a row is clicked.
  it("selecting a row marks it selected and updates the footer", async () => {
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
  });

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

// Task 39: castling, captures, and unaffordable picks.
describe("BuildScreen -- castling, captures, and unaffordable picks (Task 39)", () => {
  // BuildScreen seeds its own SeededRandom from Math.random() once per
  // mount (see its own header comment) -- fixing Math.random() here makes
  // every one of Black's own book/random choices in this describe block
  // fully reproducible from one run to the next, not just "probably fine
  // most of the time." Picked empirically: this value's own resulting
  // game develops cleanly through the sequences these tests drive.
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.137);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Plays 1. e4 2. Nf3 3. Bb5 for White -- a Knight move and a Bishop
  // move locked (canCastle's own requirement), f1/g1 both clear, same
  // shape as the Ruy Lopez's own opening -- so O-O is chess-AND-DFS-legal
  // next, regardless of whatever Black actually replies with in between
  // (its own castling eligibility never depends on Black's moves).
  async function developKnightAndBishop(user: UserEvent): Promise<void> {
    const moves: [string, string][] = [
      ["e2", "e4"],
      ["g1", "f3"],
      ["f1", "b5"],
    ];
    for (const [from, to] of moves) {
      simulateMove(from, to);
      const dialog = await screen.findByRole("dialog");
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      // Waits for actual, non-empty dests -- the direct signal that it's
      // genuinely White's turn again with real options, not just "the
      // status line's text happens to differ right now" (which a stray
      // intermediate render could satisfy a tick before Black's own
      // delayed reply has actually landed). Not a fieldColumn listitem
      // count either: PLACED mode already starts with one (the placed
      // Black QB) before any real move, throwing off a plain "+1" count.
      await waitFor(() => expect(lastApi!.config.movable!.dests!.size).toBeGreaterThan(0), { timeout: 2000 });
    }
  }

  it(
    "castling locks QB + RB (Let him emerge)",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      await developKnightAndBishop(user);

      expect(lastApi!.config.movable!.dests!.get("e1" as never)).toContain("g1");
      simulateMove("e1", "g1"); // O-O

      const kingDialog = await screen.findByRole("dialog", { name: "Choose your King" });
      expect(statusLine().textContent).toBe("Pick your QB, then your RB (castling).");
      await selectTopRow(user, kingDialog);
      await user.click(within(kingDialog).getByRole("button", { name: "Lock player" }));

      const rookDialog = await screen.findByRole("dialog", { name: "Choose your Rook" });
      expect(statusLine().textContent).toBe("Pick your QB, then your RB (castling).");
      await selectTopRow(user, rookDialog);
      await user.click(within(rookDialog).getByRole("button", { name: "Lock player" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      // Three White picks already locked (pawn, knight, bishop) + King + Rook from castling.
      expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(5);
      expect(within(youColumn()).getByText((text) => text.includes("♚"))).toBeInTheDocument();
    },
    15000,
  );

  it(
    "Cancel during the King step reverts the whole castling attempt",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      await developKnightAndBishop(user);

      const fenBefore = lastApi!.config.fen;
      simulateMove("e1", "g1");
      const kingDialog = await screen.findByRole("dialog", { name: "Choose your King" });
      await user.click(within(kingDialog).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(lastApi!.config.fen).toBe(fenBefore); // the castle itself never committed
      expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(3); // still just pawn, knight, bishop
    },
    15000,
  );

  it(
    "Place now castling offers the QB switch",
    async () => {
      const user = userEvent.setup();
      render(
        <BuildScreen
          preset={H2H}
          players={PLAYERS}
          kingMode={KingMode.PLACED}
          whiteKing={WHITE_QB}
          blackKing={BLACK_QB}
          chosenOpening={{ kind: "own" }}
          onStartAgain={onStartAgain}
          onNewContest={onNewContest}
        />,
      );
      await developKnightAndBishop(user);

      simulateMove("e1", "g1"); // O-O -- the King is already locked from setup
      const rookDialog = await screen.findByRole("dialog", { name: "Choose your Rook" });
      expect(within(rookDialog).queryByText(WHITE_QB.name)).toBeNull(); // not re-offered as a Rook candidate
      await selectTopRow(user, rookDialog);
      await user.click(within(rookDialog).getByRole("button", { name: "Lock player" }));

      expect(statusLine().textContent).toBe("Switch your QB?");
      const switchDialog = await screen.findByRole("dialog", { name: "Choose your King" });
      expect(within(switchDialog).queryByText(WHITE_QB.name)).toBeNull(); // the current QB isn't offered as a switch target

      await user.click(within(switchDialog).getByRole("button", { name: "Cancel" })); // decline -- keep the current QB
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(within(youColumn()).getByText(new RegExp(WHITE_QB.name))).toBeInTheDocument();

      await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(4), { timeout: 2000 }); // Black's reply still fires
    },
    15000,
  );

  // Every square's starting occupant, for isUnmovedCapture below.
  const STARTING_FEN_BOARD = new Chess();
  function isSameStartingPiece(fen: string, square: Square): boolean {
    const current = new Chess(fen).get(square);
    const starting = STARTING_FEN_BOARD.get(square);
    return current !== undefined && starting !== undefined && current.type === starting.type && current.color === starting.color;
  }

  // Plays harmless opening moves (whichever non-capturing dest comes
  // first) until a legal capture matching `predicate` appears among
  // White's own offered dests -- Black's real, book-driven replies decide
  // exactly when that happens, not a scripted sequence, so this adapts to
  // whatever Black actually plays rather than assuming a specific line.
  function isCastleMove(from: string, to: string): boolean {
    return (from === "e1" && (to === "g1" || to === "c1")) || (from === "e8" && (to === "g8" || to === "c8"));
  }

  // Normal developing moves, tried in this order -- central pawns and
  // minor pieces create far more contact (and so capture opportunities)
  // than the first alphabetically-offered move (which is always some
  // edge pawn shuffling in place, per isolation -- that almost never
  // creates a capture within a handful of plies).
  const DEVELOPING_MOVES: [string, string][] = [
    ["e2", "e4"],
    ["d2", "d4"],
    ["g1", "f3"],
    ["b1", "c3"],
    ["f1", "c4"],
    ["f1", "b5"],
    ["c1", "f4"],
    ["c1", "g5"],
    ["d1", "f3"],
    ["g2", "g3"],
  ];

  async function playUntilCapture(user: UserEvent, predicate: (fen: string, from: Square, to: Square) => boolean): Promise<void> {
    for (let ply = 0; ply < 8; ply++) {
      const fen = lastApi!.config.fen!;
      const chess = new Chess(fen);
      const destsNow = lastApi!.config.movable!.dests!;
      const isOffered = (from: string, to: string) => (destsNow.get(from as never) ?? []).includes(to as never);

      let capture: { from: string; to: string } | null = null;
      for (const [from, tos] of destsNow) {
        for (const to of tos) {
          if (chess.get(to as Square) !== undefined && !isCastleMove(from, to) && predicate(fen, from as Square, to as Square)) {
            capture = { from, to };
            break;
          }
        }
        if (capture !== null) break;
      }

      if (capture !== null) {
        simulateMove(capture.from, capture.to);
        // No modal for a transfer; a modal for an unmoved-piece capture --
        // either way, wait for the board to actually reflect the move
        // before returning (simulateMove calls straight into the mocked
        // chessground callback, outside of React's own event handling, so
        // nothing guarantees the resulting re-render has flushed yet).
        await waitFor(() => expect(lastApi!.config.fen).not.toBe(fen));
        return;
      }

      // A filler ply: any other offered move, preferring a normal
      // developing one (more contact, more likely to create the capture
      // this loop is actually looking for within a few more plies).
      // Whatever it turns out to be gets driven through its own real
      // flow -- castling needs two picks, a transfer capture needs none.
      const developing = DEVELOPING_MOVES.find(([from, to]) => isOffered(from, to));
      const [from, to] = developing ?? [...destsNow.entries()].flatMap(([f, tos]) => tos.map((t) => [f, t] as [string, string]))[0];
      simulateMove(from, to);
      if (isCastleMove(from, to)) {
        const kingDialog = await screen.findByRole("dialog");
        await selectTopRow(user, kingDialog);
        await user.click(within(kingDialog).getByRole("button", { name: "Lock player" }));
        const rookDialog = await screen.findByRole("dialog");
        await selectTopRow(user, rookDialog);
        await user.click(within(rookDialog).getByRole("button", { name: "Lock player" }));
      } else if (chess.get(to as Square) === undefined || isSameStartingPiece(fen, to as Square)) {
        // ordinary, or a capture of an unmoved piece -- both open a modal.
        const dialog = await screen.findByRole("dialog");
        await selectTopRow(user, dialog);
        await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      } // else: a transfer capture -- no modal at all.
      await waitFor(() => expect(lastApi!.config.movable!.dests!.size).toBeGreaterThan(0), { timeout: 2000 });
    }
    throw new Error("no matching capture became available within 8 plies");
  }

  it(
    "a capture transfers the player with no modal",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      // Any capture of a piece that ALREADY has lock history -- i.e. not
      // its starting-square occupant -- is a transfer.
      await playUntilCapture(user, (fen, _from, to) => !isSameStartingPiece(fen, to));

      expect(screen.queryByRole("dialog")).toBeNull(); // no modal at all
      expect(statusLine().textContent).toMatch(/^You captured .+\./);
    },
    15000,
  );

  it(
    "capturing an unmoved piece opens the modal for that piece type",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      // Any capture whose target is STILL its own starting piece has never
      // moved (never been locked) -- almost always a pawn this early.
      await playUntilCapture(user, (fen, _from, to) => isSameStartingPiece(fen, to));

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveAccessibleName(/^Choose your (Pawn|Knight|Bishop|Rook|Queen)$/);
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      expect(statusLine().textContent).toMatch(/^You captured .+\./);
    },
    15000,
  );

  it("an over-cap player is greyed out and can't be locked", async () => {
    const tinyCapPreset: ContestPreset = { name: "Tiny Cap", buyIn: 1, contest: new ContestConfig({ fieldSize: 2, payouts: [], cap: 5000 }) };
    render(
      <BuildScreen
        preset={tinyCapPreset}
        players={PLAYERS}
        kingMode={KingMode.EMERGE}
        whiteKing={null}
        blackKing={null}
        chosenOpening={{ kind: "own" }}
        onStartAgain={onStartAgain}
        onNewContest={onNewContest}
      />,
    );
    simulateMove("g1", "f3"); // White's first move -- a Knight move, no pawn pre-move needed

    const dialog = await screen.findByRole("dialog", { name: "Choose your Knight" });
    // Trey McBride ($6,700) is over a $5,000 cap with nothing else locked yet.
    const mcbrideRow = within(dialog).getByText(/Trey McBride/).closest("button")!;
    expect(mcbrideRow).toHaveClass("infeasible");
    expect(within(mcbrideRow).getByText(/over the cap/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(mcbrideRow);
    expect(within(dialog).getByRole("button", { name: "Lock player" })).toBeDisabled();
  });
});

// Task 40: endings (Stop/dead end), the finish screen, Start again, and
// Take back.
describe("BuildScreen -- endings and start again (Task 40)", () => {
  it("Stop with this core shows the summary with the locked players", async () => {
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
  });

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

  it("take back after a pick restores salary remaining and returns the player to the pick list", async () => {
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
  });
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
    const noTE = PLAYERS.filter((p) => classify(p, NFL) !== Piece.KNIGHT);
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
