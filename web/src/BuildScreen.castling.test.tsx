// @vitest-environment jsdom
// Housekeeping "Faster tests": split out of the former BuildScreen.test.tsx
// along its own existing describe block (no test content changed, no
// tests added or removed) so Vitest can run it on its own worker -- see
// BuildScreen.movePick/tightFinish/hoverTooltip/endings.test.tsx for the
// rest. This file keeps the "castling, captures, and unaffordable picks"
// describe block (Task 39) -- the heaviest single block in the original
// file (real chessground + real engine work across several plies).
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
import type { Square } from "chess.js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@lichess-org/chessground/config";
import { BOOK, PRESETS } from "./appData";
import BuildScreen, { setBlackReplyDelayForTests } from "./BuildScreen";
import { ContestConfig } from "./engine/config";
import type { ContestPreset } from "./engine/config";
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

// Housekeeping "Faster tests": pinned to the real pacing, not sped up
// (see BuildScreen.movePick.test.tsx's own comment on its own identical
// pin for the full reasoning) -- "a capture transfers the player with no
// modal" and "capturing an unmoved piece..." below both assert the
// SYNCHRONOUS post-commit status-line text (the capture note), which
// depends on the real pause still being pending at that instant; a
// smaller override only made that harder to win, not easier.
setBlackReplyDelayForTests(600);

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

function statusLine(): HTMLElement {
  return document.querySelector(".status-line") as HTMLElement;
}

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

  // Rule change "new levels + Go back": real top-of-list picks across a
  // several-move sequence can now genuinely reach Caution/Warning (the
  // avg thresholds loosened, and the old 3-open-slot gate dropped to 2) --
  // the board itself goes inert while that dialog is up (BuildScreen's
  // own dests gating), so a real user has to click through it before the
  // next move lands; these multi-move helpers do the same, dismissing it
  // (OK -- keeping the real pick, same as every other move in these
  // sequences) right after whichever lock might have triggered it, before
  // simulating the next move.
  async function dismissTightFinishIfShown(user: UserEvent): Promise<void> {
    const alert = screen.queryByRole("dialog", { name: "Salary alert" });
    if (alert !== null) {
      await user.click(within(alert).getByRole("button", { name: "OK" }));
    }
  }

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
      const dialog = await screen.findByRole("dialog", { name: /^Choose your/ });
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      await dismissTightFinishIfShown(user);
      // Waits for actual, non-empty dests -- the direct signal that it's
      // genuinely White's turn again with real options, not just "the
      // status line's text happens to differ right now" (which a stray
      // intermediate render could satisfy a tick before Black's own
      // delayed reply has actually landed). Not a fieldColumn listitem
      // count either: PLACED mode already starts with one (the placed
      // Black QB) before any real move, throwing off a plain "+1" count.
      await waitFor(() => expect(lastApi!.config.movable!.dests!.size).toBeGreaterThan(0), { timeout: 8000 });
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

      // "No pick dialog" specifically -- real top-of-list picks across 5
      // locks legitimately reach a tight-finish dialog here too (a
      // separate, correctly-named dialog; see BuildScreen.tightFinish.test.tsx).
      expect(screen.queryByRole("dialog", { name: /^Choose your/ })).toBeNull();
      // Three White picks already locked (pawn, knight, bishop) + King + Rook from castling.
      expect(within(youColumn()).queryAllByRole("listitem")).toHaveLength(5);
      expect(within(youColumn()).getByText((text) => text.includes("♚"))).toBeInTheDocument();
    },
    30000,
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
    30000,
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

      // RULES.md piece table ("Rook = correlation"): the switch offer now
      // comes BEFORE the Rook pick, not after -- the Rook has to be a
      // teammate of whichever QB ends up final, so the switch must
      // resolve first.
      simulateMove("e1", "g1"); // O-O -- the King is already locked from setup
      const switchDialog = await screen.findByRole("dialog", { name: "Choose your King" });
      expect(statusLine().textContent).toBe("Switch your QB?");
      expect(within(switchDialog).queryByText(WHITE_QB.name)).toBeNull(); // the current QB isn't offered as a switch target

      await user.click(within(switchDialog).getByRole("button", { name: "Cancel" })); // decline -- keep the current QB

      const rookDialog = await screen.findByRole("dialog", { name: "Choose your Rook" });
      expect(within(rookDialog).queryByText(WHITE_QB.name)).toBeNull(); // not re-offered as a Rook candidate
      await selectTopRow(user, rookDialog);
      await user.click(within(rookDialog).getByRole("button", { name: "Lock player" }));

      // "No pick dialog" specifically -- real top-of-list picks across 5
      // locks legitimately reach a tight-finish dialog here too (a
      // separate, correctly-named dialog; see BuildScreen.tightFinish.test.tsx).
      expect(screen.queryByRole("dialog", { name: /^Choose your/ })).toBeNull();
      expect(within(youColumn()).getByText(new RegExp(WHITE_QB.name))).toBeInTheDocument();

      await waitFor(() => expect(within(fieldColumn()).queryAllByRole("listitem")).toHaveLength(4), { timeout: 2000 }); // Black's reply still fires
    },
    30000,
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
        const kingDialog = await screen.findByRole("dialog", { name: "Choose your King" });
        await selectTopRow(user, kingDialog);
        await user.click(within(kingDialog).getByRole("button", { name: "Lock player" }));
        const rookDialog = await screen.findByRole("dialog", { name: "Choose your Rook" });
        await selectTopRow(user, rookDialog);
        await user.click(within(rookDialog).getByRole("button", { name: "Lock player" }));
      } else if (chess.get(to as Square) === undefined || isSameStartingPiece(fen, to as Square)) {
        // ordinary, or a capture of an unmoved piece -- both open a modal.
        const dialog = await screen.findByRole("dialog", { name: /^Choose your/ });
        await selectTopRow(user, dialog);
        await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      } // else: a transfer capture -- no modal at all.
      // Rule change "new levels + Go back": any of the three branches
      // above can lock a real player and cross a real threshold now --
      // see dismissTightFinishIfShown's own comment.
      await dismissTightFinishIfShown(user);
      // Bug fix: 2000ms here (one of up to 8 plies, each a real Black
      // engine reply + chessground mount) was observed timing out under
      // full-suite parallel load even though the outer it()'s own 15000/
      // 20000ms budget hadn't run out -- testing-library's waitFor has its
      // own independent timeout, not governed by the outer one.
      await waitFor(() => expect(lastApi!.config.movable!.dests!.size).toBeGreaterThan(0), { timeout: 5000 });
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

      // No PICK modal specifically -- the transfer is unambiguous. A real
      // top-of-list pick sequence can legitimately also reach a tight-
      // finish alert here now (Rule change "new levels + Go back"); that's
      // a separate, correctly-named dialog (see BuildScreen.tightFinish.
      // test.tsx), not asserted against either way here.
      expect(screen.queryByRole("dialog", { name: /^Choose your/ })).toBeNull();
      expect(statusLine().textContent).toMatch(/^You captured .+\./);
    },
    30000,
  );

  it(
    "capturing an unmoved piece opens the modal for that piece type",
    async () => {
      renderScreen();
      const user = userEvent.setup();
      // Any capture whose target is STILL its own starting piece has never
      // moved (never been locked) -- almost always a pawn this early.
      await playUntilCapture(user, (fen, _from, to) => isSameStartingPiece(fen, to));

      const dialog = await screen.findByRole("dialog", { name: /^Choose your/ });
      expect(dialog).toHaveAccessibleName(/^Choose your (Pawn|Knight|Bishop|Rook|Queen)$/);
      await selectTopRow(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: "Lock player" }));
      expect(statusLine().textContent).toMatch(/^You captured .+\./);
    },
    // Rule change "Pick lists must keep the lineup completable": measured
    // ~17s in ISOLATION after this change (was ~13.8s under full-suite
    // load before it) -- checkWhiteDeadEnd/Black's own engine assist both
    // re-run pickList once per LEGAL CHESS MOVE at a position (build.ts's
    // own existing search shape, several legal moves often sharing one
    // piece type and so one otherwise-identical pickList call), and
    // pickList's own per-candidate check is real work now, not a plain
    // comparison -- the heaviest test in this file (up to 8 plies of real
    // engine + chessground interaction) feels it the most. Flagged as a
    // real, understood cost, not papered over: see this task's own
    // session notes for the full performance writeup.
    60000,
  );

  it("an over-cap player never appears in the pick list at all", async () => {
    // The cap applies after removing taken players and players who don't
    // fit roster/salary -- an unaffordable candidate is filtered out of
    // the list entirely, not shown greyed out the way it used to be.
    //
    // Rule change "Pick lists must keep the lineup completable": $32,000,
    // not some arbitrarily tiny cap -- the real slate's own cheapest
    // possible full 9-player roster costs $28,600, so anything much
    // tighter than that makes every candidate infeasible (no one could
    // ever leave enough for the rest), emptying the list entirely rather
    // than exercising what this test is actually after. $32,000 is tight
    // enough to still exclude Trey McBride specifically while leaving
    // plenty of other candidates -- and a genuinely completable build.
    const tinyCapPreset: ContestPreset = { name: "Tiny Cap", buyIn: 1, contest: new ContestConfig({ fieldSize: 2, payouts: [], cap: 32000 }) };
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
    // Trey McBride ($6,700) leaves too little to still finish the other
    // 8 slots under a $32,000 cap with nothing else locked yet.
    expect(within(dialog).queryByText(/Trey McBride/)).toBeNull();
    const rows = [...dialog.querySelectorAll<HTMLButtonElement>(".pick-row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => !row.disabled)).toBe(true);
  });
});
