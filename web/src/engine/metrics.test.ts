// Ported one-for-one from tests/test_metrics.py.
import { describe, expect, it } from "vitest";
import { ContestConfig } from "./config";
import { floorValue, highestOwnershipByPosition, leverage, relativeLeverage, sortMetric, value } from "./metrics";
import { Piece, Player } from "./models";

// Mid tier (field_size 2000 -> ownFor averages small/large) for leverage's
// own ownership lookup.
const CONTEST = new ContestConfig({ fieldSize: 2000, payouts: [] });

function makePlayer(
  salary: number, proj: number, floor: number, ceiling: number, ownSmall: number, ownLarge: number,
): Player {
  return new Player({
    id: "p1", name: "Test Player", positions: ["WR"], team: "AAA", opp: "BBB",
    salary, proj, ownSmall, ownLarge, floor, ceiling,
  });
}

describe("value / floorValue / leverage", () => {
  it("value is projection per 1000 salary", () => {
    const player = makePlayer(5000, 20.0, 10.0, 30.0, 0.1, 0.1);
    expect(value(player)).toBeCloseTo(4.0); // 20 / 5000 * 1000
  });

  it("floorValue is floor per 1000 salary", () => {
    const player = makePlayer(5000, 20.0, 10.0, 30.0, 0.1, 0.1);
    expect(floorValue(player)).toBeCloseTo(2.0); // 10 / 5000 * 1000
  });

  it("leverage discounts value by ownership", () => {
    const player = makePlayer(5000, 20.0, 10.0, 30.0, 0.2, 0.4);
    // Mid tier -> ownFor is the small/large average (0.3); value is 4.0.
    expect(leverage(player, CONTEST)).toBeCloseTo(4.0 * (1 - 0.3));
  });

  it("leverage is lower for a more-owned player at the same value", () => {
    const chalky = makePlayer(5000, 20.0, 10.0, 30.0, 0.5, 0.5);
    const leveraged = makePlayer(5000, 20.0, 10.0, 30.0, 0.05, 0.05);
    expect(leverage(leveraged, CONTEST)).toBeGreaterThan(leverage(chalky, CONTEST));
  });
});

// --- highestOwnershipByPosition / relativeLeverage (Bishop's own TS-only
// metric -- see metrics.ts) -------------------------------------------------

function makePoolPlayer(id: string, position: string, ownSmall: number, ownLarge: number, salary = 5000): Player {
  return new Player({
    id, name: id, positions: [position], team: "AAA", opp: "BBB",
    salary, proj: 10.0, ownSmall, ownLarge, floor: 6.0, ceiling: 16.0,
  });
}

describe("highestOwnershipByPosition", () => {
  it("is each position's own max ownership (contest's field tier) across the whole pool", () => {
    const pool = [
      makePoolPlayer("wr1", "WR", 0.1, 0.3),
      makePoolPlayer("wr2", "WR", 0.5, 0.5), // mid tier -> (0.5+0.5)/2 = 0.5, the WR max
      makePoolPlayer("rb1", "RB", 0.9, 0.9),
    ];
    const highest = highestOwnershipByPosition(pool, CONTEST);
    expect(highest.get("WR")).toBeCloseTo(0.5);
    expect(highest.get("RB")).toBeCloseTo(0.9);
  });

  it("includes every player at the position, even one too cheap for Bishop's own $5,000 band", () => {
    // highestOwnershipByPosition itself knows nothing about salary bands --
    // that's the whole point (RULES.md: "highest ownership is from the
    // whole slate at that position", deliberately not restricted to
    // Bishop-eligible players the way the value floor is).
    const cheapChalk = makePoolPlayer("cheap", "WR", 0.8, 0.8, 3000);
    const expensive = makePoolPlayer("candidate", "WR", 0.2, 0.2);
    expect(highestOwnershipByPosition([cheapChalk, expensive], CONTEST).get("WR")).toBeCloseTo(0.8);
  });
});

describe("relativeLeverage", () => {
  it("discounts value by ownership relative to the highest at his own position", () => {
    const player = makePlayer(5000, 20.0, 1.0, 42.0, 0.2, 0.4); // WR, mid-tier own = 0.3, value = 4.0
    const highest = new Map([["WR", 0.6]]);
    expect(relativeLeverage(player, CONTEST, highest)).toBeCloseTo(4.0 * (1 - 0.3 / 0.6));
  });

  it("applies no discount when his position has no highest-ownership entry", () => {
    const player = makePlayer(5000, 20.0, 1.0, 42.0, 0.2, 0.4);
    expect(relativeLeverage(player, CONTEST, new Map())).toBeCloseTo(value(player));
  });
});

// --- sortMetric: each piece's own column (RULES.md piece table) -----------

describe("sortMetric", () => {
  it("King and Rook use projection", () => {
    const player = makePlayer(5000, 20.0, 1.0, 99.0, 0.9, 0.9);
    expect(sortMetric(Piece.KING, player, CONTEST)).toBe(player.proj);
    expect(sortMetric(Piece.ROOK, player, CONTEST)).toBe(player.proj);
  });

  it("Queen uses ceiling", () => {
    const player = makePlayer(5000, 20.0, 1.0, 42.0, 0.9, 0.9);
    expect(sortMetric(Piece.QUEEN, player, CONTEST)).toBe(player.ceiling);
  });

  it("Bishop uses relativeLeverage, not leverage", () => {
    const player = makePlayer(5000, 20.0, 1.0, 42.0, 0.2, 0.4);
    const highest = new Map([["WR", 0.6]]);
    expect(sortMetric(Piece.BISHOP, player, CONTEST, highest)).toBe(relativeLeverage(player, CONTEST, highest));
    expect(sortMetric(Piece.BISHOP, player, CONTEST, highest)).not.toBe(leverage(player, CONTEST));
  });

  it("Knight uses floor value", () => {
    const player = makePlayer(5000, 20.0, 12.5, 42.0, 0.2, 0.4);
    expect(sortMetric(Piece.KNIGHT, player, CONTEST)).toBe(floorValue(player));
  });

  it("Pawn uses value", () => {
    const player = makePlayer(2000, 8.0, 3.0, 12.0, 0.2, 0.4);
    expect(sortMetric(Piece.PAWN, player, CONTEST)).toBe(value(player));
  });
});
