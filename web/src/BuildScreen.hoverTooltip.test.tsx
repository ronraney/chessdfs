// @vitest-environment jsdom
// Housekeeping "Faster tests": split out of the former BuildScreen.test.tsx
// along its own existing describe block (no test content changed, no
// tests added or removed) so Vitest can run it on its own worker -- see
// BuildScreen.movePick/tightFinish/castling/endings.test.tsx for the rest.
// This file keeps the "board piece-info hover tooltip" describe block.
//
// chessground manipulates raw DOM pixel geometry to detect drag/drop,
// which jsdom can't lay out at all (getBoundingClientRect is always
// zeroed) -- there's no way to simulate a real drag in this environment,
// so "@lichess-org/chessground" is mocked here: the fake Chessground()
// captures the config BuildBoard passed it (in particular
// `movable.events.after`, the callback a real drag would eventually
// call). Everything downstream -- state, the pick modal, Black's
// automatic reply -- is real, unmocked BuildScreen/engine code.
//
// Board piece-info hover tooltip: BuildBoard's own geometry/hover wiring is
// covered in isolation by BuildBoard.test.tsx (a scripted getPieceTooltip,
// no real engine state); these tests cover the other half -- that
// BuildScreen's own pieceTooltipContent correctly reads real BuildState/
// pieceLocks/sport/contest for whatever's actually on the board. jsdom's
// getBoundingClientRect is always zeroed by default (same limitation noted
// throughout this file and BuildBoard.test.tsx's own header) -- stubbed
// directly on the real `.build-board-cg` element, same fix as there.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@lichess-org/chessground/config";
import { BOOK, PRESETS } from "./appData";
import BuildScreen, { setBlackReplyDelayForTests } from "./BuildScreen";
import { KingMode } from "./engine/models";
import { loadEtrCsv } from "./engine/loaders";
import { SAMPLE_CSV } from "./testFixtures";

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
});

describe("BuildScreen -- board piece-info hover tooltip", () => {
  const RECT = { left: 0, top: 0, width: 480, height: 480, right: 480, bottom: 480, x: 0, y: 0, toJSON: () => ({}) };

  function pointFor(square: string): { clientX: number; clientY: number } {
    const col = "abcdefgh".indexOf(square[0]);
    const row = 8 - Number(square[1]);
    return { clientX: ((col + 0.5) / 8) * RECT.width, clientY: ((row + 0.5) / 8) * RECT.height };
  }

  function stubRect(): void {
    (document.querySelector(".build-board-cg") as HTMLElement).getBoundingClientRect = () => RECT as DOMRect;
  }

  function hover(square: string): void {
    fireEvent.mouseMove(document.querySelector(".build-board") as HTMLElement, pointFor(square));
  }

  function tooltipTitle(): string | undefined {
    return document.querySelector(".piece-tooltip-title")?.textContent ?? undefined;
  }
  function tooltipDetail(): string | undefined {
    return document.querySelector(".piece-tooltip-detail")?.textContent ?? undefined;
  }

  it("a never-moved piece names which piece a capture would pick; an empty square shows nothing", () => {
    renderScreen();
    stubRect();

    hover("e2"); // White's own king-pawn, untouched at the start position
    expect(tooltipTitle()).toBe("Never moved");
    expect(tooltipDetail()).toBe("Capturing lets you pick a Pawn.");

    hover("e4"); // empty before any move
    expect(document.querySelector(".piece-tooltip")).toBeNull();
  });

  it(
    "a locked White piece shows its name, position, salary, projection, and ownership -- no fit note",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      await user.click(chosenContinueButton()); // Morphy Defense's own 1. e4
      const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

      const lockedName = within(youColumn()).getByRole("listitem").querySelector(".locked-name")!.textContent!.split(" · ")[0];
      const player = PLAYERS.find((p) => p.name === lockedName)!;
      const tier = H2H.contest.fieldTier();

      stubRect();
      hover("e4"); // White's pawn, now locked there
      expect(tooltipTitle()).toBe(player.name);
      expect(tooltipDetail()).toBe(
        `${player.positions[0]} · $${player.salary.toLocaleString()} · ${player.proj.toFixed(1)} pts · ${(player.ownFor(tier) * 100).toFixed(1)}% own`,
      );
      expect(document.querySelector(".piece-tooltip-fit")).toBeNull();
    },
    15000,
  );

  it(
    "a Field piece with lock history also shows whether capturing it would bring that player to White",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      await user.click(chosenContinueButton());
      const dialog = await screen.findByRole("dialog", { name: "Choose your Pawn" });
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));

      await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(1), { timeout: 2000 });
      const fieldName = within(fieldColumn()).getByRole("listitem").querySelector(".locked-name")!.textContent!.split(" · ")[0];
      const dest = lastApi!.config.lastMove![1]; // Black's own reply just landed here

      stubRect();
      hover(dest);
      expect(tooltipTitle()).toBe(fieldName);
      // White's roster has a single pawn locked so far -- transferring
      // Black's own single locked player onto it fits comfortably under
      // any real cap/roster shape, so this is the "joins you" branch;
      // the "won't fit" branch is already covered directly at the engine
      // level (rules.test.ts's isLegalCapture/applyCaptureMove cases).
      const fit = document.querySelector(".piece-tooltip-fit");
      expect(fit?.textContent).toBe("Capture: joins you");
      expect(fit).toHaveClass("ok");
    },
    15000,
  );
});
