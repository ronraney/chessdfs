// Ported from tests/test_models.py (own_for tests only -- the rest of
// models.py has no Python test coverage to port; see pieces.test.ts and
// sport.test.ts for the rest of this task's ported coverage).
import { describe, expect, it } from "vitest";
import { FieldTier, Player } from "./models";

function makePlayer(ownSmall: number, ownLarge: number): Player {
  return new Player({
    id: "p1",
    name: "Test Player",
    positions: ["WR"],
    team: "AAA",
    opp: "BBB",
    salary: 5000,
    proj: 10.0,
    ownSmall,
    ownLarge,
    floor: 6.0,
    ceiling: 16.0,
  });
}

describe("Player.ownFor", () => {
  it("small uses the small field", () => {
    expect(makePlayer(10.0, 20.0).ownFor(FieldTier.SMALL)).toBe(10.0);
  });

  it("large uses the large field", () => {
    expect(makePlayer(10.0, 20.0).ownFor(FieldTier.LARGE)).toBe(20.0);
  });

  it("mid returns the average", () => {
    expect(makePlayer(10.0, 20.0).ownFor(FieldTier.MID)).toBe(15.0);
  });
});
