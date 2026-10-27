// @vitest-environment jsdom
//
// Task 41 "mobile pass" -- these tests exist despite a real constraint:
// jsdom (this whole project's test environment) runs no CSS layout engine
// at all. getBoundingClientRect/offsetWidth/scrollWidth are always 0
// regardless of the actual stylesheet, and getComputedStyle never
// evaluates @media queries (verified directly: a `@media (max-width:
// 430px)` rule's own declarations never show up in getComputedStyle here,
// no matter what window.innerWidth is set to -- there is simply no CSS
// cascade/layout step). So "at 375px, no element is wider than the
// viewport" cannot be checked by rendering the page and measuring it --
// there is no real browser in this environment to measure with (same gap
// noted in prior sessions' handoffs for drag/drop testing).
//
// What follows instead, in order of how much it actually proves:
//   1. DOM-STRUCTURE checks jsdom genuinely can verify, by rendering the
//      real component -- e.g. the pick modal's footer is a SIBLING of its
//      scrolling candidate list, not nested inside it. That's a tree
//      fact, not a layout fact, and jsdom gets it exactly right.
//   2. STYLESHEET-SOURCE checks -- reading the .css files as plain text
//      (not rendering them) and confirming the specific responsive rules
//      this task added are actually present. This catches "someone later
//      deleted the mobile breakpoint" regressions. It does NOT prove the
//      rendered page actually fits 375px -- a syntactically-present rule
//      could still be wrong.
// Neither is a substitute for an eyeball check in a real browser's
// responsive mode; see the session log / HANDOFF.md for what to check by
// hand.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NFL } from "./appData";
import { ContestConfig } from "./engine/config";
import { Piece, Player } from "./engine/models";
import PickPanel from "./PickPanel";

const dirname = path.dirname(fileURLToPath(import.meta.url));
function readCss(name: string): string {
  return readFileSync(path.join(dirname, name), "utf-8");
}

const SETUP_CSS = readCss("SetupScreen.css");
const BUILD_CSS = readCss("BuildScreen.css");
const PICK_CSS = readCss("PickPanel.css");
const BOARD_CSS = readCss("BuildBoard.css");

// Scopes a regex match to one rule block (`selector { ... }`) by stopping
// at the first `}` -- safe for this project's flat, unnested CSS.
function ruleBlock(css: string, selectorPattern: string): string {
  const match = new RegExp(`${selectorPattern}\\s*\\{[^}]*\\}`).exec(css);
  return match?.[0] ?? "";
}

describe("Setup screen -- responsive CSS mechanism present (stylesheet-source check; see file header)", () => {
  it("collapses Contest/King mode/Suggested/Explorer to one column under 760px", () => {
    const block = ruleBlock(SETUP_CSS, "@media \\(max-width: 760px\\) \\{\\s*\\.setup-layout");
    expect(block).toMatch(/grid-template-columns:\s*1fr;/);
  });

  it("the contest <select> fills its card instead of sizing to its widest option's text", () => {
    expect(ruleBlock(SETUP_CSS, "\\.setup-card select")).toMatch(/width:\s*100%;/);
  });

  it("an explorer row can shrink instead of forcing the row (and the page) wider than its container", () => {
    expect(ruleBlock(SETUP_CSS, "\\.explorer-row button")).toMatch(/min-width:\s*0;/);
  });

  it("tier chips scroll horizontally, not wrap, once the screen goes narrow", () => {
    const mobileSection = SETUP_CSS.slice(SETUP_CSS.lastIndexOf("@media (max-width: 760px)"));
    expect(ruleBlock(mobileSection, "\\.chips")).toMatch(/overflow-x:\s*auto;/);
  });
});

describe("Build screen -- responsive CSS mechanism present (stylesheet-source check; see file header)", () => {
  it("reorders to board, then You, then Field under 760px (status line/Book continues/Take back+Stop stay inside board-column, already in that order in the JSX)", () => {
    const block = ruleBlock(BUILD_CSS, "@media \\(max-width: 760px\\) \\{\\s*\\.build-layout");
    expect(block).toMatch(/grid-template-areas:\s*"board"\s*"you"\s*"field";/);
  });

  it("header chips wrap instead of overflowing", () => {
    expect(ruleBlock(BUILD_CSS, "\\.build-chips")).toMatch(/flex-wrap:\s*wrap;/);
  });

  it("the board is full-width and square (BuildBoard.css itself, not a narrower override)", () => {
    expect(ruleBlock(BOARD_CSS, "\\.build-board")).toMatch(/width:\s*100%;/);
    expect(ruleBlock(BOARD_CSS, "\\.build-board")).toMatch(/aspect-ratio:\s*1;/);
  });

  it("the finish screen's core table scrolls inside itself instead of widening the page", () => {
    expect(BUILD_CSS).toMatch(/\.finish-core-scroll\s*\{[^}]*overflow-x:\s*auto;/);
  });
});

describe("Pick modal -- bottom sheet (DOM structure, real render -- see file header for what this does and doesn't prove)", () => {
  const contest = new ContestConfig({ fieldSize: 1000, payouts: [] });
  function makePlayer(id: string): Player {
    return new Player({ id, name: `Player ${id}`, positions: ["WR"], team: "AAA", opp: "BBB", salary: 5000, proj: 10, ownSmall: 0.1, ownLarge: 0.1, floor: 6, ceiling: 16 });
  }
  const candidates = Array.from({ length: 3 }, (_, i) => makePlayer(`p${i}`));

  function renderPanel() {
    render(
      <PickPanel
        piece={Piece.BISHOP}
        moveLabel="1. d4"
        openingLabel={null}
        moveContext={null}
        candidates={candidates}
        currentPlayers={[]}
        playersPool={candidates}
        sport={NFL}
        contest={contest}
        onPick={() => {}}
        onCancel={() => {}}
        error={null}
      />,
    );
  }

  it('the mobile breakpoint anchors the overlay to the bottom edge ("align-items: flex-end") -- stylesheet-source check, not a rendered position', () => {
    const block = ruleBlock(PICK_CSS, "@media \\(max-width: 760px\\) \\{\\s*\\.pick-modal-overlay");
    expect(block).toMatch(/align-items:\s*flex-end;/);
  });

  it("the footer is a sibling of the scrolling candidate list, not nested inside it -- so scrolling rows can never hide it (real DOM structure, jsdom-verifiable)", () => {
    renderPanel();
    const modal = screen.getByRole("dialog");
    const rowList = modal.querySelector(".pick-row-list")!;
    const footer = modal.querySelector(".pick-modal-footer")!;
    expect(rowList).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(footer.contains(rowList)).toBe(false); // footer isn't an ancestor of the scrolling list
    expect(rowList.contains(footer)).toBe(false); // the scrolling list doesn't contain the footer either
    expect(rowList.parentElement).toBe(footer.parentElement); // true siblings, same parent
  });

  it('"Lock player" stays inside the always-visible footer, not the scrolling list', () => {
    renderPanel();
    const footer = screen.getByRole("dialog").querySelector(".pick-modal-footer")!;
    expect(footer.querySelector(".lock-player")).not.toBeNull();
  });
});
