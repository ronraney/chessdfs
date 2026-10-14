// @vitest-environment jsdom
// Task 37: drives the Ruy Lopez: Morphy Defense template end to end --
// White's three interactive picks (Pawn/e4, Knight/Nf3, Bishop/Bb5) via
// the pick modal, Black's three automatic ones (Pawn/e5, Knight/Nc6,
// Pawn/a6) via build.playBlackTemplateMove -- against the real vendored
// book and a real sample projections CSV (same data every other screen's
// tests already use).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BOOK, NFL, PRESETS } from "./appData";
import BuildScreen from "./BuildScreen";
import { eligiblePlayers } from "./buildStats";
import { loadEtrCsv } from "./engine/loaders";
import { KingMode, Piece } from "./engine/models";
import { SAMPLE_CSV } from "./testFixtures";

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

// Regex/substring text matchers in RTL match any ancestor whose combined
// textContent happens to contain the substring, not just the one leaf
// paragraph -- querySelector against the side-stat paragraph's own class
// (the first .side-stat in a SideColumn is always the salary-remaining
// line; see BuildScreen.tsx's SideColumn) sidesteps that ambiguity.
function salaryRemainingText(container: Element): string {
  return container.querySelector(".side-stat")?.textContent ?? "";
}

describe("BuildScreen -- Morphy Defense template", () => {
  it("the book has the expected 6-ply line this test drives", () => {
    expect(MORPHY_DEFENSE.moves).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
  });

  it("locks 3 White and 3 Black players, then shows the line-complete placeholder", async () => {
    renderScreen();
    const user = userEvent.setup();

    for (const label of ["Pick a Pawn", "Pick a Knight", "Pick a Bishop"]) {
      const dialog = await screen.findByRole("dialog", { name: label });
      await user.click(within(dialog).getAllByRole("button", { name: "Pick" })[0]);
    }

    await screen.findByText("Line complete — next steps coming.");

    const you = screen.getByRole("heading", { level: 2, name: "You" }).closest(".side-column") as HTMLElement;
    const field = screen.getByRole("heading", { level: 2, name: "Field" }).closest(".side-column") as HTMLElement;
    expect(within(you).getAllByRole("listitem")).toHaveLength(3);
    expect(within(field).getAllByRole("listitem")).toHaveLength(3);

    // All 6 locked players are distinct -- the practical consequence of
    // lockedPlayerIds gating both sides' eligibility (see buildStats.test.ts
    // for the direct, general proof that a locked player is excluded).
    const names = [...within(you).getAllByRole("listitem"), ...within(field).getAllByRole("listitem")].map(
      (li) => li.textContent,
    );
    expect(new Set(names).size).toBe(6);
  });

  it("the pick modal lists exactly the eligible players for the moved piece", async () => {
    renderScreen();
    const user = userEvent.setup();

    await screen.findByRole("dialog", { name: "Pick a Pawn" });
    const pawnDialog = screen.getByRole("dialog", { name: "Pick a Pawn" });
    await user.click(within(pawnDialog).getAllByRole("button", { name: "Pick" })[0]);

    const knightDialog = await screen.findByRole("dialog", { name: "Pick a Knight" });
    const rows = within(knightDialog).getAllByRole("row").slice(1); // drop the header row
    // Both picks locked so far (White's e4, Black's auto e5) are Pawn-band
    // players -- classify() is one-to-one, so neither affects the
    // Knight-eligible pool at all; the empty locked set here matches that.
    const expectedCount = eligiblePlayers(Piece.KNIGHT, new Set(), PLAYERS, NFL).length;
    expect(rows.length).toBe(expectedCount);
  });

  it("salary remaining updates by exactly the picked player's salary", async () => {
    renderScreen();
    const user = userEvent.setup();

    const you = screen.getByRole("heading", { level: 2, name: "You" }).closest(".side-column")!;
    const before = salaryRemainingText(you);

    const dialog = await screen.findByRole("dialog", { name: "Pick a Pawn" });
    const firstRow = within(dialog).getAllByRole("row")[1]; // header + first candidate
    const salaryText = within(firstRow).getAllByRole("cell")[2].textContent!; // Name | Team | Salary | ...
    const salary = Number(salaryText.replace(/[$,]/g, ""));

    await user.click(within(firstRow).getByRole("button", { name: "Pick" }));

    const after = salaryRemainingText(you);
    const capBefore = Number(before.match(/\$([\d,]+)/)![1].replace(/,/g, ""));
    const capAfter = Number(after.match(/\$([\d,]+)/)![1].replace(/,/g, ""));
    expect(capAfter).toBe(capBefore - salary);
  });
});
