// Ported one-for-one from tests/test_metrics.py.
import { describe, expect, it } from "vitest";
import { ContestConfig } from "./config";
import { floorValue, leverage, sortMetric, value } from "./metrics";
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

  it("Bishop uses leverage", () => {
    const player = makePlayer(5000, 20.0, 1.0, 42.0, 0.2, 0.4);
    expect(sortMetric(Piece.BISHOP, player, CONTEST)).toBe(leverage(player, CONTEST));
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
