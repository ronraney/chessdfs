// "DraftKings upload CSV" task: dkExport.ts's own tests, pure-function
// level (no React/DOM needed) -- the real NFL roster_slots shape, same
// as SavedLineupsScreen actually passes it.
import { describe, expect, it } from "vitest";
import nflConfig from "./data/config/sports/nfl.json";
import { buildDkCsv, dkCsvHeader } from "./dkExport";
import { Player } from "./engine/models";
import { loadSportConfig } from "./engine/sport";
import type { SavedLineup, SavedLineupPlayer } from "./savedLineupsStore";
import { KingMode } from "./engine/models";

const NFL = loadSportConfig(nflConfig);

function makePlayer(id: string, name: string, pos: string, team = "AAA"): Player {
  return new Player({
    id,
    name,
    positions: [pos],
    team,
    opp: "BBB",
    salary: 5000,
    proj: 10,
    ownSmall: 0.1,
    ownLarge: 0.1,
    floor: 5,
    ceiling: 15,
  });
}

function savedPlayer(overrides: Partial<SavedLineupPlayer>): SavedLineupPlayer {
  return {
    slot: "RB",
    piece: "Rook",
    optimizer: false,
    name: "Someone",
    pos: "RB",
    team: "AAA",
    salary: 5000,
    projection: 10,
    ownership: 0.1,
    ...overrides,
  };
}

function savedLineup(players: readonly SavedLineupPlayer[], overrides: Partial<SavedLineup> = {}): SavedLineup {
  return {
    id: "lineup-1",
    savedAt: "2026-11-13T00:00:00.000Z",
    contentKey: "key-1",
    contestName: "H2H",
    kingMode: KingMode.EMERGE,
    chosenOpening: "Sicilian Defense",
    finalOpening: "Sicilian Defense",
    moves: ["e4", "c5"],
    players,
    totals: { salaryUsed: 45000, salaryRemaining: 5000, projection: 100, ownership: 0.9 },
    whiteSim: null,
    blackSim: null,
    ...overrides,
  };
}

// A legal, full 9-player roster: QB, 2 RB (dedicated), 3 WR, TE, 1 extra
// RB (FLEX overflow), DST -- same shape a real "Fill out my core"/full
// build would save, with `.slot` already reflecting lineupSlots'
// placement (as saveLineupNow actually writes it).
function fullLineupPlayers(): SavedLineupPlayer[] {
  return [
    savedPlayer({ slot: "QB", pos: "QB", name: "Joe Burrow", team: "CIN" }),
    savedPlayer({ slot: "RB", pos: "RB", name: "Bijan Robinson", team: "ATL" }),
    savedPlayer({ slot: "RB", pos: "RB", name: "Second Back", team: "DAL" }),
    savedPlayer({ slot: "WR", pos: "WR", name: "WR One", team: "MIA" }),
    savedPlayer({ slot: "WR", pos: "WR", name: "WR Two", team: "SF" }),
    savedPlayer({ slot: "WR", pos: "WR", name: "WR Three", team: "KC" }),
    savedPlayer({ slot: "TE", pos: "TE", name: "TE One", team: "BAL" }),
    savedPlayer({ slot: "FLEX", pos: "RB", name: "Flex Back", team: "GB" }), // 3rd RB, overflowed to FLEX
    savedPlayer({ slot: "DST", pos: "DST", name: "Ravens", team: "BAL" }),
  ];
}

function currentPlayersFor(players: readonly SavedLineupPlayer[]): Player[] {
  return players.map((p, i) => makePlayer(`id-${i}`, p.name, p.pos, p.team));
}

describe("dkCsvHeader", () => {
  it("header and slot order: QB, RB, RB, WR, WR, WR, TE, FLEX, DST", () => {
    expect(dkCsvHeader(NFL)).toEqual(["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"]);
  });
});

describe("buildDkCsv", () => {
  it('"Name (ID)" format, header row, and one data row per exported lineup', () => {
    const players = fullLineupPlayers();
    const current = currentPlayersFor(players);
    const result = buildDkCsv([savedLineup(players)], current, NFL);

    const lines = result.csv.split("\n");
    expect(lines[0]).toBe("QB,RB,RB,WR,WR,WR,TE,FLEX,DST");
    expect(result.exportedCount).toBe(1);
    expect(result.skipped).toEqual([]);

    const burrowId = current.find((p) => p.name === "Joe Burrow")!.id;
    expect(lines[1].split(",")[0]).toBe(`Joe Burrow (${burrowId})`);
  });

  it("FLEX overflow: the 3rd RB (saved with slot FLEX) lands in the CSV's own FLEX column", () => {
    const players = fullLineupPlayers();
    const current = currentPlayersFor(players);
    const result = buildDkCsv([savedLineup(players)], current, NFL);

    const cells = result.csv.split("\n")[1].split(",");
    const flexIndex = dkCsvHeader(NFL).indexOf("FLEX");
    const flexBackId = current.find((p) => p.name === "Flex Back")!.id;
    expect(cells[flexIndex]).toBe(`Flex Back (${flexBackId})`);
    // The two dedicated RB columns are the OTHER two RBs, not Flex Back.
    const rbIndices = dkCsvHeader(NFL).flatMap((name, i) => (name === "RB" ? [i] : []));
    for (const i of rbIndices) expect(cells[i]).not.toContain("Flex Back");
  });

  it("missing-ID skip: a lineup whose player isn't in the current projections is skipped, with a reason, and does not block other lineups", () => {
    const players = fullLineupPlayers();
    const current = currentPlayersFor(players).filter((p) => p.name !== "Bijan Robinson"); // an "old slate" gap
    const otherLineupPlayers = fullLineupPlayers().map((p) => ({ ...p, team: `${p.team}2` })); // a distinct, fully-present lineup
    const currentForOther = currentPlayersFor(otherLineupPlayers);

    const result = buildDkCsv(
      [savedLineup(players, { id: "missing-one" }), savedLineup(otherLineupPlayers, { id: "fully-present" })],
      [...current, ...currentForOther],
      NFL,
    );

    expect(result.exportedCount).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].lineup.id).toBe("missing-one");
    expect(result.skipped[0].reason).toMatch(/Bijan Robinson/);
    expect(result.skipped[0].reason).toMatch(/not in the current projections/);
  });

  it("an empty selection exports just the header row, nothing skipped", () => {
    const result = buildDkCsv([], [], NFL);
    expect(result.csv).toBe("QB,RB,RB,WR,WR,WR,TE,FLEX,DST");
    expect(result.exportedCount).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it("quotes a cell only if the name needs it", () => {
    const players = fullLineupPlayers();
    players[0] = { ...players[0], name: 'Last, First "Nickname"' };
    const current = currentPlayersFor(players);
    const result = buildDkCsv([savedLineup(players)], current, NFL);

    const id = current.find((p) => p.team === players[0].team)!.id;
    const expectedFirstCell = `"Last, First ""Nickname"" (${id})"`;
    expect(result.csv.split("\n")[1].startsWith(`${expectedFirstCell},`)).toBe(true);
  });
});
