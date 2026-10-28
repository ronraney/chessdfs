import { describe, expect, it } from "vitest";
import { parseLineupString } from "./lineupParser";

describe("parseLineupString", () => {
  it("parses a real DK standings Lineup cell into 9 ordered {slot, name} pairs", () => {
    const lineup =
      "DST Falcons  FLEX Tyler Higbee QB Joe Burrow RB Bijan Robinson RB Tony Pollard TE Tucker Kraft " +
      "WR Amon-Ra St. Brown WR Tee Higgins WR KC Concepcion Jr.";
    expect(parseLineupString(lineup)).toEqual([
      { slot: "DST", name: "Falcons" },
      { slot: "FLEX", name: "Tyler Higbee" },
      { slot: "QB", name: "Joe Burrow" },
      { slot: "RB", name: "Bijan Robinson" },
      { slot: "RB", name: "Tony Pollard" },
      { slot: "TE", name: "Tucker Kraft" },
      { slot: "WR", name: "Amon-Ra St. Brown" },
      { slot: "WR", name: "Tee Higgins" },
      { slot: "WR", name: "KC Concepcion Jr." },
    ]);
  });

  it("preserves internal punctuation and multi-word names (hyphen, period, suffix)", () => {
    expect(parseLineupString("QB Josh Allen WR KC Concepcion Jr.")).toEqual([
      { slot: "QB", name: "Josh Allen" },
      { slot: "WR", name: "KC Concepcion Jr." },
    ]);
  });

  it("collapses the double space DK leaves after a DST's team nickname", () => {
    expect(parseLineupString("DST Falcons  FLEX Tyler Higbee")).toEqual([
      { slot: "DST", name: "Falcons" },
      { slot: "FLEX", name: "Tyler Higbee" },
    ]);
  });

  it("empty string returns no slots", () => {
    expect(parseLineupString("")).toEqual([]);
  });

  it("drops stray text before the first recognized slot token", () => {
    expect(parseLineupString("??? QB Joe Burrow")).toEqual([{ slot: "QB", name: "Joe Burrow" }]);
  });

  it("a slot token with no trailing name yields an empty name, not a crash", () => {
    expect(parseLineupString("QB RB Bijan Robinson")).toEqual([
      { slot: "QB", name: "" },
      { slot: "RB", name: "Bijan Robinson" },
    ]);
  });
});
