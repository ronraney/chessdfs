// "Slot-ordered lineups" task: slotGridRows' own tests, pure-function
// level (no React/DOM needed) -- the real NFL roster_slots shape (QB 1,
// RB 2, WR 3, TE 1, FLEX 1, DST 1), same as BuildScreen/SavedLineupsScreen
// actually pass it.
import { describe, expect, it } from "vitest";
import nflConfig from "./data/config/sports/nfl.json";
import { slotGridRows, slotNamesForEntries } from "./lineupSlots";
import { loadSportConfig } from "./engine/sport";

const NFL = loadSportConfig(nflConfig);

interface Entry {
  name: string;
  pos: string;
}

function entry(name: string, pos: string): Entry {
  return { name, pos };
}

function run(entries: readonly Entry[]) {
  return slotGridRows(entries, (e) => e.pos, NFL.rosterSlots);
}

describe("slotGridRows", () => {
  it("fixed DK order: QB, RB, RB, WR, WR, WR, TE, FLEX, DST", () => {
    const rows = run([]);
    expect(rows.map((r) => r.slotName)).toEqual(["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"]);
    expect(rows.every((r) => r.entry === null)).toBe(true);
  });

  it("slot fill order: each position's own dedicated slots fill in pick order", () => {
    const rb1 = entry("RB1", "RB");
    const rb2 = entry("RB2", "RB");
    const wr1 = entry("WR1", "WR");
    const rows = run([rb1, rb2, wr1]);

    const byName = (name: string) => rows.find((r) => r.slotName === name && r.entry !== null);
    expect(rows.filter((r) => r.slotName === "RB").map((r) => r.entry)).toEqual([rb1, rb2]);
    expect(byName("WR")?.entry).toBe(wr1);
  });

  it("FLEX overflow: a 3rd same-position entry (dedicated slots full) lands in FLEX, in pick order", () => {
    const rb1 = entry("RB1", "RB");
    const rb2 = entry("RB2", "RB");
    const rb3 = entry("RB3", "RB");
    const rows = run([rb1, rb2, rb3]);

    expect(rows.filter((r) => r.slotName === "RB").map((r) => r.entry)).toEqual([rb1, rb2]);
    expect(rows.find((r) => r.slotName === "FLEX")?.entry).toBe(rb3);
  });

  it("overflow across positions still resolves in overall pick order", () => {
    // 3 WRs (only 3 dedicated WR slots -- no overflow) locked before a 3rd
    // RB -- the RB is the one that needed FLEX, not a WR, even though the
    // WRs were locked earlier; dedicated slots are claimed first regardless
    // of pick order across DIFFERENT positions, overflow only matters
    // within a position.
    const rb1 = entry("RB1", "RB");
    const rb2 = entry("RB2", "RB");
    const wr1 = entry("WR1", "WR");
    const wr2 = entry("WR2", "WR");
    const wr3 = entry("WR3", "WR");
    const rb3 = entry("RB3", "RB");
    const rows = run([rb1, rb2, wr1, wr2, wr3, rb3]);

    expect(rows.filter((r) => r.slotName === "RB").map((r) => r.entry)).toEqual([rb1, rb2]);
    expect(rows.filter((r) => r.slotName === "WR").map((r) => r.entry)).toEqual([wr1, wr2, wr3]);
    expect(rows.find((r) => r.slotName === "FLEX")?.entry).toBe(rb3);
  });

  it("empty placeholders: fewer than 9 locked leaves the rest null, in their own fixed rows", () => {
    const qb = entry("QB1", "QB");
    const rb1 = entry("RB1", "RB");
    const rows = run([qb, rb1]);

    expect(rows.map((r) => r.entry)).toEqual([qb, rb1, null, null, null, null, null, null, null]);
  });

  it("re-slotting after a capture: removing an entry re-derives from scratch, with no stale FLEX leftover", () => {
    const rb1 = entry("RB1", "RB");
    const rb2 = entry("RB2", "RB");
    const rb3 = entry("RB3", "RB"); // overflows to FLEX while rb1/rb2 are both still locked
    const before = run([rb1, rb2, rb3]);
    expect(before.find((r) => r.slotName === "FLEX")?.entry).toBe(rb3);

    // rb1 gets captured mid-build -- the roster shrinks to [rb2, rb3].
    const after = run([rb2, rb3]);
    expect(after.filter((r) => r.slotName === "RB").map((r) => r.entry)).toEqual([rb2, rb3]); // rb3 moved OUT of FLEX
    expect(after.find((r) => r.slotName === "FLEX")?.entry).toBeNull(); // FLEX is open again, not stuck on rb3
  });

  it("position matching is case-insensitive", () => {
    const rb = entry("RB1", "rb");
    const rows = run([rb]);
    expect(rows.find((r) => r.slotName === "RB")?.entry).toBe(rb);
  });
});

// "DraftKings upload CSV" task: Copy lineup, the saved record's own
// `.slot` field, and the DK CSV all read THIS shape (parallel to the
// input entries, no blanks) -- same underlying placement as
// slotGridRows above (computePlacement), just a different return shape.
describe("slotNamesForEntries", () => {
  function runNames(entries: readonly Entry[]) {
    return slotNamesForEntries(entries, (e) => e.pos, NFL.rosterSlots);
  }

  it("slot fill order: each position's own dedicated slots fill in pick order", () => {
    const names = runNames([entry("QB1", "QB"), entry("RB1", "RB"), entry("RB2", "RB"), entry("WR1", "WR")]);
    expect(names).toEqual(["QB", "RB", "RB", "WR"]);
  });

  it("FLEX overflow: a 3rd same-position entry lands in FLEX, in pick order, parallel to the input", () => {
    const names = runNames([entry("RB1", "RB"), entry("RB2", "RB"), entry("RB3", "RB")]);
    expect(names).toEqual(["RB", "RB", "FLEX"]);
  });

  it("is parallel to the input -- same length, no blanks, one name per entry", () => {
    const entries = [entry("QB1", "QB"), entry("RB1", "RB")];
    expect(runNames(entries)).toHaveLength(entries.length);
  });
});
