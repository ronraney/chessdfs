// @vitest-environment jsdom
// "Save lineup" task: savedLineupsStore.ts's own tests, via jsdom (it uses
// window.localStorage directly, same as fieldCacheStore.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KingMode } from "./engine/models";
import {
  deleteLineup,
  exportLineupsJson,
  getSavedLineups,
  importLineupsJson,
  saveLineup,
  type SavedLineupInput,
} from "./savedLineupsStore";

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
    whiteSim: null,
    blackSim: null,
    ...overrides,
  };
}

describe("savedLineupsStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("save: a new lineup round-trips through getSavedLineups", () => {
    const { lineup, isNew } = saveLineup(makeInput());
    expect(isNew).toBe(true);
    const all = getSavedLineups();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(lineup.id);
    expect(all[0].contestName).toBe("H2H");
    expect(all[0].players).toHaveLength(2);
  });

  it("no duplicate on re-save: saving the identical build twice stores exactly one row", () => {
    const first = saveLineup(makeInput());
    const second = saveLineup(makeInput());

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.lineup.id).toBe(first.lineup.id);
    expect(getSavedLineups()).toHaveLength(1);
  });

  it("a genuinely different build (different moves) is not treated as a duplicate", () => {
    saveLineup(makeInput());
    saveLineup(makeInput({ moves: ["d4", "d5"] }));
    expect(getSavedLineups()).toHaveLength(2);
  });

  it("list order: newest first", async () => {
    const a = saveLineup(makeInput({ contestName: "First" }));
    // savedAt is a real timestamp (new Date().toISOString()) -- a real
    // (if tiny) delay guarantees the second save's own timestamp sorts
    // after the first's, same as two real Save-lineup clicks would.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const b = saveLineup(makeInput({ contestName: "Second", moves: ["d4"] }));

    const all = getSavedLineups();
    expect(all.map((l) => l.id)).toEqual([b.lineup.id, a.lineup.id]);
  });

  it("delete: removes exactly that lineup and leaves the rest", () => {
    const a = saveLineup(makeInput({ contestName: "A" }));
    const b = saveLineup(makeInput({ contestName: "B", moves: ["d4"] }));

    deleteLineup(a.lineup.id);

    const all = getSavedLineups();
    expect(all.map((l) => l.id)).toEqual([b.lineup.id]);
  });

  it("export -> import round trip: re-importing the same export changes nothing (every row skipped as a duplicate)", () => {
    saveLineup(makeInput({ contestName: "A" }));
    saveLineup(makeInput({ contestName: "B", moves: ["d4"] }));
    const exported = exportLineupsJson();

    const result = importLineupsJson(exported);

    expect(result).toEqual({ imported: 0, skipped: 2 });
    expect(getSavedLineups()).toHaveLength(2);
  });

  it("export -> import round trip onto an empty store restores every lineup", () => {
    saveLineup(makeInput({ contestName: "A" }));
    saveLineup(makeInput({ contestName: "B", moves: ["d4"] }));
    const exported = exportLineupsJson();
    window.localStorage.clear();

    const result = importLineupsJson(exported);

    expect(result).toEqual({ imported: 2, skipped: 0 });
    const names = getSavedLineups().map((l) => l.contestName);
    expect(new Set(names)).toEqual(new Set(["A", "B"]));
  });

  it("import only skips the overlapping rows when some are already saved and some are new", () => {
    saveLineup(makeInput({ contestName: "A" }));
    const exported = exportLineupsJson(); // backup with just "A"
    saveLineup(makeInput({ contestName: "B", moves: ["d4"] })); // saved after the backup was taken

    const result = importLineupsJson(exported);

    expect(result).toEqual({ imported: 0, skipped: 1 }); // "A" was already here; nothing new in this backup
    expect(getSavedLineups()).toHaveLength(2);
  });

  it("importLineupsJson rejects anything that isn't a JSON array", () => {
    expect(() => importLineupsJson(JSON.stringify({ not: "an array" }))).toThrow();
  });

  describe("persistent storage request", () => {
    it("requests navigator.storage.persist() once, on the first save only", () => {
      const persist = vi.fn().mockResolvedValue(true);
      Object.defineProperty(navigator, "storage", { value: { persist }, configurable: true });

      saveLineup(makeInput());
      saveLineup(makeInput({ moves: ["d4"] }));
      saveLineup(makeInput({ moves: ["Nf3"] }));

      expect(persist).toHaveBeenCalledTimes(1);
    });

    it("never throws when navigator.storage is unavailable", () => {
      Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
      expect(() => saveLineup(makeInput())).not.toThrow();
    });
  });
});
