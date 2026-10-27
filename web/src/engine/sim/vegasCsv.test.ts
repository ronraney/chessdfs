import { describe, expect, it } from "vitest";
import { Player } from "../models";
import { SeededRandom } from "../rng";
import { drawSlateOutcomes } from "./draws";
import { VegasValidationError, validateVegasCsv } from "./vegasCsv";

const HEADER = "Rank,Team,Implied Total,Spread,O/U,Opponent";

function row(rank: number, team: string, impliedTotal: number, spread: number, overUnder: number, opponent: string): string {
  return `${rank},${team},${impliedTotal},${spread},${overUnder},${opponent}`;
}

function csv(rows: readonly string[]): string {
  return [HEADER, ...rows].join("\n");
}

const TWO_TEAM_ROWS = [row(1, "AAA", 27.5, -3.5, 51, "BBB"), row(2, "BBB", 23.5, 3.5, 51, "AAA")];

describe("validateVegasCsv", () => {
  it("a valid two-team upload parses cleanly with nothing skipped", () => {
    const result = validateVegasCsv(csv(TWO_TEAM_ROWS), new Set(["AAA", "BBB"]));
    expect(result.vegas.get("AAA")).toEqual({ total: 51, spread: -3.5 });
    expect(result.vegas.get("BBB")).toEqual({ total: 51, spread: 3.5 });
    expect(result.skippedTeams).toEqual([]);
  });

  // Bug fix (behavior reversal): a slate team with no Vegas row used to
  // be a non-fatal note (that team would draw with neutral defaults).
  // Now it's a hard error -- a full-week Vegas sheet is expected to cover
  // every team actually on the slate; if it doesn't, that's worth
  // stopping the upload for, not quietly degrading.
  it("errors when a slate team has no Vegas row", () => {
    expect(() => validateVegasCsv(csv(TWO_TEAM_ROWS), new Set(["AAA", "BBB", "CCC"]))).toThrow(
      /No Vegas row for slate team\(s\): CCC/,
    );
  });

  it("rejects a file missing required columns, naming them", () => {
    const badCsv = ["Rank,Team", "1,AAA"].join("\n");
    expect(() => validateVegasCsv(badCsv, new Set(["AAA"]))).toThrow(VegasValidationError);
    expect(() => validateVegasCsv(badCsv, new Set(["AAA"]))).toThrow(/Missing required column\(s\): Implied Total, Spread, O\/U, Opponent\./);
  });

  it("rejects a row with a missing Team value", () => {
    const rows = [...TWO_TEAM_ROWS, row(3, "", 24, 0, 48, "DDD")];
    expect(() => validateVegasCsv(csv(rows), new Set(["AAA", "BBB"]))).toThrow(/1 row\(s\) are missing a Team value/);
  });

  it("rejects duplicate team rows (among teams actually on the slate)", () => {
    const rows = [...TWO_TEAM_ROWS, row(3, "AAA", 24, -1, 48, "BBB")];
    expect(() => validateVegasCsv(csv(rows), new Set(["AAA", "BBB"]))).toThrow(/Duplicate team row\(s\): AAA/);
  });

  it("rejects a non-numeric Spread value, naming the team", () => {
    const rows = [row(1, "AAA", 27.5, "pick" as unknown as number, 51, "BBB"), row(2, "BBB", 23.5, 3.5, 51, "AAA")];
    expect(() => validateVegasCsv(csv(rows), new Set(["AAA", "BBB"]))).toThrow(/Non-numeric Spread value for team\(s\): AAA/);
  });

  it("rejects a non-numeric O/U value, naming the team", () => {
    const rows = [row(1, "AAA", 27.5, -3.5, "TBD" as unknown as number, "BBB"), row(2, "BBB", 23.5, 3.5, 51, "AAA")];
    expect(() => validateVegasCsv(csv(rows), new Set(["AAA", "BBB"]))).toThrow(/Non-numeric O\/U value for team\(s\): AAA/);
  });

  // Bug fix: a full-week Vegas sheet routinely covers teams this
  // particular slate isn't using (e.g. a Thursday-only slate against a
  // full-week sheet) -- that used to reject the whole upload outright.
  // Now the off-slate row is skipped, noted, and doesn't block anything
  // else: AAA (on the slate) still gets its real Vegas data.
  it("skips (does not reject) a Vegas row for a team not on the loaded slate", () => {
    const result = validateVegasCsv(csv(TWO_TEAM_ROWS), new Set(["AAA"]));
    expect(result.vegas.get("AAA")).toEqual({ total: 51, spread: -3.5 });
    expect(result.vegas.has("BBB")).toBe(false);
    expect(result.skippedTeams).toEqual(["BBB"]);
  });

  it("skips several off-slate teams at once and lists them all, deduplicated and sorted", () => {
    const rows = [...TWO_TEAM_ROWS, row(3, "CCC", 20, 0, 44, "DDD"), row(4, "BBB", 23.5, 3.5, 51, "AAA")]; // BBB appears twice, off-slate both times
    const result = validateVegasCsv(csv(rows), new Set(["AAA"]));
    expect(result.skippedTeams).toEqual(["BBB", "CCC"]);
    expect(result.vegas.size).toBe(1);
  });

  // Bug fix: full team names ("Detroit Lions") in the Team column used to
  // be rejected outright as off-slate, since the slate's own Team column
  // is always an abbreviation ("DET").
  it("maps a full team name in the Team column to its abbreviation", () => {
    const rows = [row(1, "Detroit Lions", 24.5, -2.5, 47, "GB"), row(2, "GB", 22, 2.5, 47, "Detroit Lions")];
    const result = validateVegasCsv(csv(rows), new Set(["DET", "GB"]));
    expect(result.vegas.get("DET")).toEqual({ total: 47, spread: -2.5 });
    expect(result.vegas.get("GB")).toEqual({ total: 47, spread: 2.5 });
    expect(result.skippedTeams).toEqual([]);
  });

  it("maps a full team name in the Opponent column the same way (case-insensitive, whitespace-tolerant)", () => {
    const rows = [row(1, "DET", 24.5, -2.5, 47, "  green bay packers  "), row(2, "GB", 22, 2.5, 47, "DET")];
    // Opponent isn't read into the output today, so this only proves the
    // mapping runs without throwing or corrupting the Team-column result.
    const result = validateVegasCsv(csv(rows), new Set(["DET", "GB"]));
    expect(result.vegas.get("DET")).toEqual({ total: 47, spread: -2.5 });
    expect(result.vegas.get("GB")).toEqual({ total: 47, spread: 2.5 });
  });

  it("still accepts plain abbreviations unchanged", () => {
    const result = validateVegasCsv(csv(TWO_TEAM_ROWS), new Set(["AAA", "BBB"]));
    expect(result.vegas.size).toBe(2);
  });

  // Behavior consequence, flagged rather than assumed: this function has
  // no separate "is this a real team" check independent of slate
  // membership -- off-slate and "not a real team at all" are the same
  // condition here (neither is in slateTeams). A typo'd/garbage team name
  // is now silently skipped like any other off-slate row, not rejected.
  it("a genuinely unrecognized team name is skipped the same as any other off-slate team, not rejected", () => {
    const rows = [row(1, "Not A Real Team", 24.5, -2.5, 47, "GB"), row(2, "GB", 22, 2.5, 47, "Not A Real Team")];
    const result = validateVegasCsv(csv(rows), new Set(["GB"]));
    expect(result.skippedTeams).toEqual(["Not A Real Team"]);
    expect(result.vegas.get("GB")).toEqual({ total: 47, spread: 2.5 }); // GB's own row is on-slate and otherwise valid
  });

  it("maps every one of the 32 real full team names to this file's own abbreviation set", () => {
    const fullNames: Record<string, string> = {
      "Arizona Cardinals": "ARI",
      "Atlanta Falcons": "ATL",
      "Baltimore Ravens": "BAL",
      "Buffalo Bills": "BUF",
      "Carolina Panthers": "CAR",
      "Chicago Bears": "CHI",
      "Cincinnati Bengals": "CIN",
      "Cleveland Browns": "CLE",
      "Dallas Cowboys": "DAL",
      "Denver Broncos": "DEN",
      "Detroit Lions": "DET",
      "Green Bay Packers": "GB",
      "Houston Texans": "HOU",
      "Indianapolis Colts": "IND",
      "Jacksonville Jaguars": "JAX",
      "Kansas City Chiefs": "KC",
      "Los Angeles Chargers": "LAC",
      "Los Angeles Rams": "LAR",
      "Las Vegas Raiders": "LV",
      "Miami Dolphins": "MIA",
      "Minnesota Vikings": "MIN",
      "New England Patriots": "NE",
      "New Orleans Saints": "NO",
      "New York Giants": "NYG",
      "New York Jets": "NYJ",
      "Philadelphia Eagles": "PHI",
      "Pittsburgh Steelers": "PIT",
      "Seattle Seahawks": "SEA",
      "San Francisco 49ers": "SF",
      "Tampa Bay Buccaneers": "TB",
      "Tennessee Titans": "TEN",
      "Washington Commanders": "WAS",
    };
    const entries = Object.entries(fullNames);
    expect(entries).toHaveLength(32);
    const rows = entries.map(([name], i) => row(i + 1, name, 24, 0, 47, entries[(i + 1) % entries.length][0]));
    const slateTeams = new Set(Object.values(fullNames));
    const result = validateVegasCsv(csv(rows), slateTeams);
    for (const [, abbr] of entries) {
      expect(result.vegas.has(abbr)).toBe(true);
    }
    expect(result.skippedTeams).toEqual([]);
  });

  // This task's own named case: the Rams' abbreviation genuinely varies
  // by source (confirmed on disk -- see vegasCsv.ts's own comment). The
  // CSV's own choice shouldn't matter; only the slate's does.
  describe("LA/LAR alias (the Rams)", () => {
    it("the slate uses LAR -- a CSV row for LA resolves to LAR", () => {
      const rows = [row(1, "LA", 24, -3, 47, "SF"), row(2, "SF", 23, 3, 47, "LA")];
      const result = validateVegasCsv(csv(rows), new Set(["LAR", "SF"]));
      expect(result.vegas.get("LAR")).toEqual({ total: 47, spread: -3 });
      expect(result.skippedTeams).toEqual([]);
    });

    it("the slate uses LA -- a CSV row for LAR resolves to LA", () => {
      const rows = [row(1, "LAR", 24, -3, 47, "SF"), row(2, "SF", 23, 3, 47, "LAR")];
      const result = validateVegasCsv(csv(rows), new Set(["LA", "SF"]));
      expect(result.vegas.get("LA")).toEqual({ total: 47, spread: -3 });
      expect(result.skippedTeams).toEqual([]);
    });

    it("the slate uses LAR -- a CSV row for the full name 'Los Angeles Rams' resolves to LAR", () => {
      const rows = [row(1, "Los Angeles Rams", 24, -3, 47, "SF"), row(2, "SF", 23, 3, 47, "Los Angeles Rams")];
      const result = validateVegasCsv(csv(rows), new Set(["LAR", "SF"]));
      expect(result.vegas.get("LAR")).toEqual({ total: 47, spread: -3 });
    });

    it("neither alias on the slate -- LA is simply off-slate, not specially treated", () => {
      const rows = [row(1, "LA", 24, -3, 47, "SF"), row(2, "SF", 23, 3, 47, "LA")];
      const result = validateVegasCsv(csv(rows), new Set(["SF"]));
      expect(result.skippedTeams).toEqual(["LA"]);
    });
  });
});

describe("validateVegasCsv -> drawSlateOutcomes integration", () => {
  function makePlayer(id: string, position: string, team: string, opp: string): Player {
    return new Player({
      id,
      name: id,
      positions: [position],
      team,
      opp,
      salary: 5000,
      proj: 18,
      ownSmall: 0.1,
      ownLarge: 0.1,
      floor: 10,
      ceiling: 28,
    });
  }

  it("a team absent from the vegas map falls back to drawSlateOutcomes' own neutral defaults", () => {
    // AAA/BBB get real, skewed Vegas data via validateVegasCsv (proving
    // its own output needs no adapter for drawSlateOutcomes); CCC/DDD are
    // real players on the slate but simply never asked about here --
    // validateVegasCsv now REQUIRES full coverage of whatever slate it's
    // given (a slate team with no Vegas row is a hard error), so a gap
    // can no longer survive its own validated path. Scoping this call's
    // own `slateTeams` to {AAA, BBB} only (not the full 4-player roster)
    // is what still produces a real, validator-approved map with a real
    // gap to test drawSlateOutcomes' own degradation against.
    const players = [
      makePlayer("qbA", "QB", "AAA", "BBB"),
      makePlayer("qbB", "QB", "BBB", "AAA"),
      makePlayer("qbC", "QB", "CCC", "DDD"),
      makePlayer("qbD", "QB", "DDD", "CCC"),
    ];
    const ccDd = [players[2], players[3]];
    const rows = [row(1, "AAA", 30, -6, 60, "BBB"), row(2, "BBB", 24, 6, 60, "AAA")];
    const { vegas, skippedTeams } = validateVegasCsv(csv(rows), new Set(["AAA", "BBB"]));
    expect(skippedTeams).toEqual([]);
    expect(vegas.has("CCC")).toBe(false);
    expect(vegas.has("DDD")).toBe(false);

    // Passed directly as the `games` argument -- no adapter needed.
    const N = 8000;
    const rngWithVegas = new SeededRandom(5150);
    let withVegasSum = 0;
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, vegas, rngWithVegas);
      for (const p of ccDd) withVegasSum += out.get(p.id)!;
    }

    const rngNeutral = new SeededRandom(9001);
    let neutralSum = 0;
    for (let i = 0; i < N; i++) {
      const out = drawSlateOutcomes(players, new Map(), rngNeutral);
      for (const p of ccDd) neutralSum += out.get(p.id)!;
    }

    expect(withVegasSum / N).toBeCloseTo(neutralSum / N, 0);
  });
});
