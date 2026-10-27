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
  it("a valid two-team upload parses cleanly with no missing teams", () => {
    const result = validateVegasCsv(csv(TWO_TEAM_ROWS), new Set(["AAA", "BBB"]));
    expect(result.vegas.get("AAA")).toEqual({ total: 51, spread: -3.5 });
    expect(result.vegas.get("BBB")).toEqual({ total: 51, spread: 3.5 });
    expect(result.missingTeams).toEqual([]);
  });

  it("warns (does not throw) when a slate team has no Vegas row", () => {
    const result = validateVegasCsv(csv(TWO_TEAM_ROWS), new Set(["AAA", "BBB", "CCC"]));
    expect(result.vegas.size).toBe(2);
    expect(result.missingTeams).toEqual(["CCC"]);
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

  it("rejects duplicate team rows", () => {
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

  it("rejects a Vegas row for a team not on the loaded slate", () => {
    expect(() => validateVegasCsv(csv(TWO_TEAM_ROWS), new Set(["AAA"]))).toThrow(
      /Vegas row\(s\) for team\(s\) not on the loaded slate: BBB/,
    );
  });

  // Bug fix: full team names ("Detroit Lions") in the Team column used to
  // be rejected outright as off-slate, since the slate's own Team column
  // is always an abbreviation ("DET").
  it("maps a full team name in the Team column to its abbreviation", () => {
    const rows = [row(1, "Detroit Lions", 24.5, -2.5, 47, "GB"), row(2, "GB", 22, 2.5, 47, "Detroit Lions")];
    const result = validateVegasCsv(csv(rows), new Set(["DET", "GB"]));
    expect(result.vegas.get("DET")).toEqual({ total: 47, spread: -2.5 });
    expect(result.vegas.get("GB")).toEqual({ total: 47, spread: 2.5 });
    expect(result.missingTeams).toEqual([]);
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

  it("still rejects a genuinely unknown team name", () => {
    const rows = [row(1, "Not A Real Team", 24.5, -2.5, 47, "GB"), row(2, "GB", 22, 2.5, 47, "Not A Real Team")];
    expect(() => validateVegasCsv(csv(rows), new Set(["GB"]))).toThrow(
      /Vegas row\(s\) for team\(s\) not on the loaded slate: Not A Real Team/,
    );
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
    expect(result.missingTeams).toEqual([]);
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

  it("a slate team missing from the Vegas upload falls back to drawSlateOutcomes' own neutral defaults", () => {
    // AAA/BBB get real, skewed Vegas data; CCC/DDD are on the slate but
    // absent from the CSV entirely (validateVegasCsv reports them as
    // missingTeams, not an error). CCC/DDD's own game total/spread is
    // undefined either way, so their statistics should land the same
    // whether or not AAA/BBB's real coverage is present elsewhere on the
    // slate -- checked over many trials (a single shared-rng draw isn't
    // comparable 1:1 across scenarios here: AAA/BBB's different Vegas
    // data changes how many regime-shock rng calls their OWN game
    // consumes, which shifts the rng stream CCC/DDD draw from next).
    const players = [
      makePlayer("qbA", "QB", "AAA", "BBB"),
      makePlayer("qbB", "QB", "BBB", "AAA"),
      makePlayer("qbC", "QB", "CCC", "DDD"),
      makePlayer("qbD", "QB", "DDD", "CCC"),
    ];
    const ccDd = [players[2], players[3]];
    const rows = [row(1, "AAA", 30, -6, 60, "BBB"), row(2, "BBB", 24, 6, 60, "AAA")];
    const { vegas, missingTeams } = validateVegasCsv(csv(rows), new Set(["AAA", "BBB", "CCC", "DDD"]));
    expect(missingTeams).toEqual(["CCC", "DDD"]);
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
