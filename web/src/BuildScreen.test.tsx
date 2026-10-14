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
// callback -- state, the pick panel, Black's automatic reply -- is real,
// unmocked BuildScreen/engine code.
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

beforeEach(() => {
  lastApi = null;
});

describe("BuildScreen -- move first, then pick", () => {
  it("arrives on the board with no pick list, and suggests the chosen line's first move", () => {
    renderScreen();
    expect(document.querySelector(".build-board")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const banner = document.querySelector(".suggestion-banner");
    expect(banner?.textContent).toContain("Suggested:");
    expect(banner?.textContent).toContain("e4");
    expect(banner?.textContent).toContain("Ruy Lopez: Morphy Defense");
  });

  it("the suggested move's 'Play it' makes that move and opens the pick list", async () => {
    renderScreen();
    const user = userEvent.setup();
    const fenBefore = lastApi!.config.fen;
    await user.click(screen.getByRole("button", { name: "Play it" }));

    expect(await screen.findByRole("dialog", { name: "Pick a Pawn" })).toBeInTheDocument();
    expect(lastApi!.config.fen).not.toBe(fenBefore); // the board shows the move, even though it isn't locked in yet
  });

  it("a non-suggested legal move is accepted, and Black responds after the pick locks", async () => {
    renderScreen();
    const user = userEvent.setup();
    simulateMove("d2", "d4"); // deviates from the suggested e4

    const dialog = await screen.findByRole("dialog", { name: "Pick a Pawn" });
    await user.click(within(dialog).getAllByRole("button", { name: "Pick" })[0]);

    expect(screen.queryByRole("dialog")).toBeNull(); // panel closes once the pick locks
    expect(document.querySelector(".moves-line")?.textContent).toContain("d4"); // now actually locked in
    expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(0); // Black hasn't replied yet

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
  });

  it("cancel restores the previous position", async () => {
    renderScreen();
    const user = userEvent.setup();
    const fenBefore = lastApi!.config.fen;

    simulateMove("e2", "e4");
    await screen.findByRole("dialog", { name: "Pick a Pawn" });
    expect(lastApi!.config.fen).not.toBe(fenBefore); // the board shows the tentative move

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastApi!.config.fen).toBe(fenBefore); // visually reverted
    expect(document.querySelector(".hint")?.textContent).toBe("(no moves yet)"); // never actually committed
    expect(document.querySelector(".suggestion-banner")?.textContent).toContain("Suggested:"); // back on the chosen line
  });

  it("after deviating, suggestions come from book continuations by name", async () => {
    renderScreen();
    const user = userEvent.setup();
    simulateMove("d2", "d4"); // no longer the Ruy Lopez's own "e4"
    const dialog = await screen.findByRole("dialog", { name: "Pick a Pawn" });
    await user.click(within(dialog).getAllByRole("button", { name: "Pick" })[0]);

    await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });

    expect(screen.queryByText(/^Suggested:/)).toBeNull();
    expect(screen.getByText("Book continuations:")).toBeInTheDocument();
  });
});
