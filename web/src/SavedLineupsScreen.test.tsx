// @vitest-environment jsdom
// "Save lineup" task: the Saved lineups screen's own UI tests, via
// React Testing Library + jsdom -- same per-file opt-in as every other
// screen's test file (see App.test.tsx's own header comment).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEtrCsv } from "./engine/loaders";
import { KingMode, type Player } from "./engine/models";
import { saveProjectionsCsv } from "./projectionsStore";
import { getSavedLineups, saveLineup, type SavedLineupInput, type SavedLineupPlayer } from "./savedLineupsStore";
import SavedLineupsScreen from "./SavedLineupsScreen";
import { SAMPLE_CSV } from "./testFixtures";

const REAL_PLAYERS = loadEtrCsv(SAMPLE_CSV);
function realPlayersByPos(pos: string, count: number): Player[] {
  const found = REAL_PLAYERS.filter((p) => p.positions[0] === pos).slice(0, count);
  if (found.length < count) throw new Error(`fixture needs ${count} ${pos}(s), SAMPLE_CSV only has ${found.length}`);
  return found;
}

function toSavedPlayer(player: Player, slot: string): SavedLineupPlayer {
  return {
    slot,
    piece: "Pawn",
    optimizer: false,
    name: player.name,
    pos: player.positions[0],
    team: player.team,
    salary: player.salary,
    projection: player.proj,
    ownership: player.ownSmall,
  };
}

// A real, full (9/9) roster -- 2 dedicated RBs + a 3rd that overflows to
// FLEX, same as a genuine "Fill out my core"/full build would save, with
// `.slot` already reflecting that overflow (exactly what saveLineupNow
// itself would have written).
function fullSavedPlayers(): SavedLineupPlayer[] {
  const [qb] = realPlayersByPos("QB", 1);
  const [rb1, rb2, rb3] = realPlayersByPos("RB", 3);
  const [wr1, wr2, wr3] = realPlayersByPos("WR", 3);
  const [te] = realPlayersByPos("TE", 1);
  const [dst] = realPlayersByPos("DST", 1);
  return [
    toSavedPlayer(qb, "QB"),
    toSavedPlayer(rb1, "RB"),
    toSavedPlayer(rb2, "RB"),
    toSavedPlayer(wr1, "WR"),
    toSavedPlayer(wr2, "WR"),
    toSavedPlayer(wr3, "WR"),
    toSavedPlayer(te, "TE"),
    toSavedPlayer(rb3, "FLEX"),
    toSavedPlayer(dst, "DST"),
  ];
}

// jsdom implements neither (confirmed empirically: Node's jsdom build has
// no URL.createObjectURL at all) -- downloadFile would throw the moment
// any test actually clicks a download button without this. Blob#text()
// is ALSO unavailable (same gap AdminScreen.tsx's own readFileAsText
// comment already documents) -- FileReader is used instead, same
// workaround, to read back what a captured Blob actually contains.
let lastBlob: Blob | null = null;
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

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
  lastBlob = null;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    lastBlob = blob;
    return "blob:mock";
  });
  URL.revokeObjectURL = vi.fn();
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

  // "DraftKings upload CSV" task.
  describe("DraftKings CSV export", () => {
    it("a core (under 9 players) can't be selected and says why; a full lineup gets a real checkbox", () => {
      saveLineup(makeInput()); // makeInput's own default roster is a 2-player core
      saveLineup({ ...makeInput(), players: fullSavedPlayers(), moves: ["d4"] });
      saveProjectionsCsv(SAMPLE_CSV);
      render(<SavedLineupsScreen onBack={onBack} />);

      const rows = [...document.querySelectorAll(".saved-row")];
      const coreRow = rows.find((r) => r.textContent?.includes("Core ("))!;
      expect(coreRow.textContent).toContain("Core (2/9)");
      expect(coreRow.querySelector('input[type="checkbox"]')).toBeNull();

      const fullRow = rows.find((r) => r !== coreRow)!;
      expect(fullRow.querySelector('input[type="checkbox"]')).not.toBeNull();
    });

    it("Select all selects every full lineup and skips cores; toggles back off", async () => {
      saveLineup(makeInput()); // a core
      saveLineup({ ...makeInput(), players: fullSavedPlayers(), moves: ["d4"] });
      saveLineup({ ...makeInput(), players: fullSavedPlayers(), moves: ["Nf3"] });
      saveProjectionsCsv(SAMPLE_CSV);
      render(<SavedLineupsScreen onBack={onBack} />);
      const user = userEvent.setup();

      const checkboxes = () => [...document.querySelectorAll('.saved-row input[type="checkbox"]')] as HTMLInputElement[];
      expect(checkboxes()).toHaveLength(2); // the core has none at all

      await user.click(screen.getByRole("checkbox", { name: "Select all" }));
      expect(checkboxes().every((c) => c.checked)).toBe(true);
      expect(screen.getByRole("button", { name: "Download for DraftKings" })).toBeEnabled();

      await user.click(screen.getByRole("checkbox", { name: "Select all" }));
      expect(checkboxes().every((c) => !c.checked)).toBe(true);
    });

    it("header and slot order + \"Name (ID)\" format + FLEX overflow, in the actual downloaded CSV", async () => {
      saveLineup({ ...makeInput(), players: fullSavedPlayers() });
      saveProjectionsCsv(SAMPLE_CSV);
      render(<SavedLineupsScreen onBack={onBack} />);
      const user = userEvent.setup();

      await user.click(screen.getByRole("checkbox", { name: /Select .+ for DraftKings export/ }));
      await user.click(screen.getByRole("button", { name: "Download for DraftKings" }));

      await waitFor(() => expect(screen.getByText(/Exported 1 lineup\./)).toBeInTheDocument());
      expect(lastBlob).not.toBeNull();
      const csv = await readBlobText(lastBlob!);
      const [header, row] = csv.split("\n");
      expect(header).toBe("QB,RB,RB,WR,WR,WR,TE,FLEX,DST");

      const cells = row.split(",");
      const flexBack = fullSavedPlayers().find((p) => p.slot === "FLEX")!;
      const flexCell = cells[dkHeaderIndex("FLEX")];
      expect(flexCell).toMatch(new RegExp(`^${flexBack.name} \\(\\d+\\)$`));
      // The two dedicated RB columns are the OTHER two RBs, not the FLEX one.
      expect(cells[dkHeaderIndex("RB", 0)]).not.toContain(flexBack.name);
      expect(cells[dkHeaderIndex("RB", 1)]).not.toContain(flexBack.name);
    });

    it("missing-ID skip: a lineup with a player no longer in the current projections is skipped and reported, by name and reason", async () => {
      const players = fullSavedPlayers();
      const ghost = { ...players[1], name: "Totally Fake Player Not In Slate" };
      players[1] = ghost;
      saveLineup({ ...makeInput(), contestName: "Ghost Lineup", players });
      saveProjectionsCsv(SAMPLE_CSV);
      render(<SavedLineupsScreen onBack={onBack} />);
      const user = userEvent.setup();

      await user.click(screen.getByRole("checkbox", { name: /Select .+ for DraftKings export/ }));
      await user.click(screen.getByRole("button", { name: "Download for DraftKings" }));

      const status = await waitFor(() => screen.getByRole("status"));
      expect(status.textContent).toMatch(/Exported 0 lineups\./);
      expect(status.textContent).toMatch(/Skipped 1:/);
      expect(status.textContent).toMatch(/Ghost Lineup/);
      expect(status.textContent).toMatch(/Totally Fake Player Not In Slate/);
      expect(status.textContent).toMatch(/not in the current projections/);
    });

    it('no DK ID column at all: "stop and report" -- the button is disabled and the reason is shown, not a guessed ID', () => {
      saveLineup({ ...makeInput(), players: fullSavedPlayers() });
      saveProjectionsCsv("Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field,DK Floor,DK Ceiling\n"); // no DK_ID, no id
      render(<SavedLineupsScreen onBack={onBack} />);

      expect(screen.getByText("No DK player ID column found in the loaded projections file.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download for DraftKings" })).toBeDisabled();
    });

    it("no projections loaded at all: stop and report", () => {
      saveLineup({ ...makeInput(), players: fullSavedPlayers() });
      render(<SavedLineupsScreen onBack={onBack} />);

      expect(screen.getByText("No projections loaded -- DK IDs are unavailable.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download for DraftKings" })).toBeDisabled();
    });

    it("reports the real ID column's own name when one is found", () => {
      saveProjectionsCsv(SAMPLE_CSV);
      render(<SavedLineupsScreen onBack={onBack} />);
      expect(screen.getByText(/DK IDs from column: DK_ID/)).toBeInTheDocument();
    });
  });
});

const DK_HEADER = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"];
function dkHeaderIndex(slotName: string, occurrence = 0): number {
  return DK_HEADER.reduce<number[]>((acc, name, i) => (name === slotName ? [...acc, i] : acc), [])[occurrence];
}
