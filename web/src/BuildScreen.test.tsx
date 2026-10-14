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
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@lichess-org/chessground/config";
import { BOOK, PRESETS } from "./appData";
import BuildScreen from "./BuildScreen";
import { loadEtrCsv } from "./engine/loaders";
import { KingMode } from "./engine/models";
import { SAMPLE_CSV } from "./testFixtures";

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

function renderScreen() {
  render(
    <BuildScreen
      preset={H2H}
      players={PLAYERS}
      kingMode={KingMode.EMERGE}
      whiteKing={null}
      blackKing={null}
      chosenOpening={{ kind: "line", line: MORPHY_DEFENSE }}
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

beforeEach(() => {
  lastApi = null;
  window.localStorage.clear();
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
    expect(dialog.textContent).toContain("After this pick:");

    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    expect(screen.queryByRole("dialog")).toBeNull(); // modal closes once the pick locks
    expect(document.querySelector(".opening-moves")?.textContent).toContain("d4"); // now actually locked in
    expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(0); // Black hasn't replied yet

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
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
    await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

    expect(statusLine().textContent).toBe("The Field is moving…");

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    expect(statusLine().textContent).toMatch(/^Field played .+ and locked .+\. Your move\./);
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
