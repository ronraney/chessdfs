// Ported from the "roster/salary feasibility, tested directly" section of
// tests/test_rules.py -- the only section that exercises
// lineup_still_completable directly, independent of is_legal_move/
// apply_move (not yet ported; see this task's session log for the rest).
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { Player } from "./models";
import { lineupStillCompletable } from "./rules";
import { loadSportConfig } from "./sport";

const NFL = loadSportConfig(nflConfig);
// Python's tests use ContestConfig(cap=50000, ...).cap; ContestConfig isn't
// ported yet (Task 23 scope), so the plain cap value stands in directly --
// lineupStillCompletable takes a number, not a ContestConfig.
const CONTEST_CAP = 50000;

function makePlayer(id: string, pos: string, salary: number): Player {
  return new Player({
    id,
    name: id,
    positions: [pos],
    team: "AAA",
    opp: "BBB",
    salary,
    proj: 10.0,
    ownSmall: 0.1,
    ownLarge: 0.1,
  });
}

describe("lineupStillCompletable", () => {
  it("flex can absorb one extra RB", () => {
    const roster = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200)); // 3rd RB uses the 1 flex
    expect(lineupStillCompletable(roster, NFL, CONTEST_CAP)).toBe(true);
  });

  it("flex double overflow is illegal", () => {
    const roster = [
      ...[0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200)),
      ...[0, 1, 2].map((i) => makePlayer(`wr${i}`, "WR", 5000)),
    ];
    expect(lineupStillCompletable(roster, NFL, CONTEST_CAP)).toBe(true); // flex spent on the 3rd RB
    const overflowed = [...roster, makePlayer("wr4", "WR", 5300)]; // 4th WR would need the flex too
    expect(lineupStillCompletable(overflowed, NFL, CONTEST_CAP)).toBe(false);
  });

  it("second DST is illegal", () => {
    const oneDst = [makePlayer("dst1", "DST", 2500)];
    expect(lineupStillCompletable(oneDst, NFL, CONTEST_CAP)).toBe(true);
    const twoDst = [...oneDst, makePlayer("dst2", "DST", 2600)];
    expect(lineupStillCompletable(twoDst, NFL, CONTEST_CAP)).toBe(false);
  });

  it("mirrors castle()'s cap overflow check", () => {
    // Knight+Bishop already locked (9600), King+Rook (12000) pushes the
    // total to 21600 > a 15000 cap.
    const alreadyLocked = [makePlayer("te1", "TE", 4600), makePlayer("wr1", "WR", 5000)];
    const king = makePlayer("qb1", "QB", 6000);
    const rook = makePlayer("rb1", "RB", 6000);
    expect(lineupStillCompletable([...alreadyLocked, king, rook], NFL, 15000)).toBe(false);
  });

  it("mirrors is_legal_capture()'s cap overflow check", () => {
    // The captured player (Task 18: the capturing move's only pick) on top
    // of what's already locked exceeds a tight cap.
    const alreadyLocked = makePlayer("wr1", "WR", 5100);
    const captured = makePlayer("rb1", "RB", 5200); // 5100 + 5200 = 10300 > 10000
    expect(lineupStillCompletable([alreadyLocked, captured], NFL, 10000)).toBe(false);
  });

  it("capture is illegal on roster overflow", () => {
    // The capturing side already has its own QB; capturing a 2nd QB-tier
    // player can never fit a DK roster, regardless of salary/cap.
    const alreadyLocked = [makePlayer("qb2", "QB", 5900)];
    const capturedQb = makePlayer("qb1", "QB", 6000);
    expect(lineupStillCompletable([...alreadyLocked, capturedQb], NFL, CONTEST_CAP)).toBe(false);
  });

  it("multi-position player fills either slot", () => {
    // A hybrid RB/WR player, per CLAUDE.md's "Multi-sport ready": "can fill
    // any slot matching any of them."
    const hybrid = new Player({
      id: "h1",
      name: "Hybrid",
      positions: ["RB", "WR"],
      team: "AAA",
      opp: "BBB",
      salary: 3000,
      proj: 10.0,
      ownSmall: 0.1,
      ownLarge: 0.1,
    });
    const threeRbs = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200)); // fills RB(2) + FLEX(1)
    const roster = [...threeRbs, hybrid];
    expect(lineupStillCompletable(roster, NFL, CONTEST_CAP)).toBe(true); // hybrid still fits via WR
  });
});
