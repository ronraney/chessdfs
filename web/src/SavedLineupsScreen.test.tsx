// @vitest-environment jsdom
// "Save lineup" task: the Saved lineups screen's own UI tests, via
// React Testing Library + jsdom -- same per-file opt-in as every other
// screen's test file (see App.test.tsx's own header comment).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KingMode } from "./engine/models";
import { getSavedLineups, saveLineup, type SavedLineupInput } from "./savedLineupsStore";
import SavedLineupsScreen from "./SavedLineupsScreen";

function makeInput(overrides: Partial<SavedLineupInput> = {}): SavedLineupInput {
  return {
    contestName: "H2H",
    kingMode: KingMode.EMERGE,
    chosenOpening: "Sicilian Defense",
    finalOpening: "Sicilian Defense",
    moves: ["e4", "c5"],
    players: [
      { slot: "QB", piece: "King", optimizer: false, name: "Joe Burrow", pos: "QB", team: "CIN", salary: 8000, projection: 22.5, ownership: 0.18 },
      {
        slot: "RB",
        piece: "(optimizer)",
        optimizer: true,
        name: "Some Back",
        pos: "RB",
        team: "DAL",
        salary: 5500,
        projection: 14.1,
        ownership: 0.09,
      },
    ],
    totals: { salaryUsed: 13500, salaryRemaining: 36500, projection: 36.6, ownership: 0.27 },
    whiteSim: { cashRate: 0.42, bottom99Roi: -0.1, top1PctScoreRoi: 1.3, top1PctRate: 0.02, roi: 0.05, isBestFinish: true, buildSeed: 7, simSeed: 7 },
    blackSim: null,
    ...overrides,
  };
}

const onBack = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  onBack.mockClear();
});

describe("SavedLineupsScreen", () => {
  it('shows "No saved lineups yet." when the store is empty', () => {
    render(<SavedLineupsScreen onBack={onBack} />);
    expect(screen.getByText("No saved lineups yet.")).toBeInTheDocument();
  });

  it("list order: newest-first, showing date/contest/opening/projection/salary used", async () => {
    saveLineup(makeInput({ contestName: "First" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    saveLineup(makeInput({ contestName: "Second", moves: ["d4"] }));

    render(<SavedLineupsScreen onBack={onBack} />);

    const rows = document.querySelectorAll(".saved-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Second");
    expect(rows[1].textContent).toContain("First");
    expect(rows[0].textContent).toContain("Sicilian Defense");
    expect(rows[0].textContent).toContain("36.6 pts");
    expect(rows[0].textContent).toContain("$13,500");
  });

  // "Slot-ordered lineups" task: the detail view shows the same fixed
  // 9-row DK grid (QB, RB, RB, WR, WR, WR, TE, FLEX, DST) the build
  // screens do, with no "Slot" column (row position IS the slot) --
  // recomputed fresh from the saved record's own `.pos` fields, not read
  // back off the stored `.slot` (Copy's own field, untouched by this
  // task). makeInput's QB + RB fill only the first two rows; the other 7
  // are blank placeholders.
  it("detail view: fixed DK-order grid, no Slot column, blank placeholder rows for the rest", async () => {
    saveLineup(makeInput());
    render(<SavedLineupsScreen onBack={onBack} />);
    const user = userEvent.setup();
    await user.click(document.querySelector(".saved-row-main") as HTMLElement);

    const finishCard = document.querySelector(".finish-card") as HTMLElement;
    const headers = [...finishCard.querySelectorAll(".finish-core thead th")].map((th) => th.textContent);
    expect(headers).toEqual(["Piece", "Player", "Pos", "Team", "Salary"]);

    const rows = [...finishCard.querySelectorAll(".finish-core tbody tr")];
    expect(rows).toHaveLength(9);
    const cellsOf = (row: Element) => [...row.querySelectorAll("td")].map((td) => td.textContent);
    expect(cellsOf(rows[0])).toEqual(["King", "Joe Burrow", "QB", "CIN", "$8,000"]); // QB row
    expect(cellsOf(rows[1])).toEqual(["(optimizer)", "Some Back", "RB", "DAL", "$5,500"]); // RB row
    for (const row of rows.slice(2)) {
      expect(cellsOf(row)).toEqual([""]); // blank placeholder, colSpan'd
    }
  });

  it("clicking a row shows the full lineup, with Back to list returning to the list", async () => {
    saveLineup(makeInput());
    render(<SavedLineupsScreen onBack={onBack} />);
    const user = userEvent.setup();

    await user.click(document.querySelector(".saved-row-main") as HTMLElement);

    expect(screen.getByText("Joe Burrow")).toBeInTheDocument();
    expect(screen.getByText("Some Back")).toBeInTheDocument();
    expect(screen.getByText("(optimizer)")).toBeInTheDocument();
    expect(screen.getByText(/Sim results \(best finish\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "← Back to list" }));
    expect(document.querySelector(".saved-row")).not.toBeNull();
  });

  it("Copy on a row copies the same tab-separated format as the Finish screen's own Copy lineup", async () => {
    saveLineup(makeInput());
    render(<SavedLineupsScreen onBack={onBack} />);
    const user = userEvent.setup(); // installs its own navigator.clipboard stub

    await user.click(screen.getByRole("button", { name: "Copy" }));

    const text = await waitFor(async () => {
      const t = await navigator.clipboard.readText();
      expect(t).not.toBe("");
      return t;
    });
    expect(text.split("\n")[0]).toBe("QB\tKing\tJoe Burrow\tQB\tCIN\t$8,000");
    expect(text).toMatch(/Salary used: \$13,500/);
    expect(text).toMatch(/Projection: 36\.6 pts/);
    expect(text).toMatch(/Ownership: 27\.0%/);
    expect(text).toMatch(/Opening: Sicilian Defense/);
    expect(text).toMatch(/Moves: 1\. e4 c5/);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("Delete asks for confirmation; cancelling keeps the row, confirming removes it", async () => {
    saveLineup(makeInput());
    render(<SavedLineupsScreen onBack={onBack} />);
    const user = userEvent.setup();

    const cancelSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(document.querySelector(".saved-row")).not.toBeNull();
    cancelSpy.mockRestore();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    confirmSpy.mockRestore();

    expect(document.querySelector(".saved-row")).toBeNull();
    expect(getSavedLineups()).toHaveLength(0);
  });

  it('"Back" calls onBack', async () => {
    render(<SavedLineupsScreen onBack={onBack} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });

  describe("export / import", () => {
    it('"Download all (backup)" is disabled when there\'s nothing saved', () => {
      render(<SavedLineupsScreen onBack={onBack} />);
      expect(screen.getByRole("button", { name: "Download all (backup)" })).toBeDisabled();
    });

    it("Import loads an exported file back in, skipping anything already saved", async () => {
      saveLineup(makeInput({ contestName: "A" }));
      const exportedText = JSON.stringify(getSavedLineups(), null, 2);
      saveLineup(makeInput({ contestName: "B", moves: ["d4"] })); // saved after the "export" above was taken

      render(<SavedLineupsScreen onBack={onBack} />);
      const user = userEvent.setup();
      const file = new File([exportedText], "backup.json", { type: "application/json" });

      await user.upload(screen.getByLabelText("Import saved lineups"), file);

      await waitFor(() => expect(screen.getByText(/Imported 0, skipped 1 duplicate\./)).toBeInTheDocument());
      expect(getSavedLineups()).toHaveLength(2); // "A" (already here) + "B" -- the import added nothing new
    });

    it("Import restores lineups after they were cleared (export -> clear -> import round trip)", async () => {
      saveLineup(makeInput({ contestName: "A" }));
      saveLineup(makeInput({ contestName: "B", moves: ["d4"] }));
      const exportedText = JSON.stringify(getSavedLineups(), null, 2);
      window.localStorage.clear();

      render(<SavedLineupsScreen onBack={onBack} />);
      const user = userEvent.setup();
      const file = new File([exportedText], "backup.json", { type: "application/json" });

      await user.upload(screen.getByLabelText("Import saved lineups"), file);

      await waitFor(() => expect(screen.getByText(/Imported 2, skipped 0 duplicates\./)).toBeInTheDocument());
      expect(document.querySelectorAll(".saved-row")).toHaveLength(2);
    });
  });
});
