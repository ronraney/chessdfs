// @vitest-environment jsdom
// fieldCacheStore.ts uses window.localStorage directly -- needs jsdom,
// same as AdminScreen.test.tsx (the engine tests' default `node`
// environment has no `window` at all).
import { beforeEach, describe, expect, it } from "vitest";
import { ContestConfig } from "./engine/config";
import { FieldTier, Player } from "./engine/models";
import { clearFieldCache, getCachedFieldIds, resolveCachedField, saveCachedFieldIds, slateSignature } from "./fieldCacheStore";

function makePlayer(id: string): Player {
  return new Player({
    id,
    name: id,
    positions: ["WR"],
    team: "AAA",
    opp: "BBB",
    salary: 5000,
    proj: 10,
    ownSmall: 0.1,
    ownLarge: 0.1,
    floor: 5,
    ceiling: 15,
  });
}

describe("fieldCacheStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("miss: nothing cached yet returns null", () => {
    expect(getCachedFieldIds("sig1", FieldTier.SMALL)).toBeNull();
  });

  it("hit: a saved field round-trips through getCachedFieldIds", () => {
    const lineupIds = [
      ["p1", "p2"],
      ["p3", "p4"],
    ];
    saveCachedFieldIds("sig1", FieldTier.LARGE, lineupIds);
    expect(getCachedFieldIds("sig1", FieldTier.LARGE)).toEqual(lineupIds);
  });

  it("is keyed by both signature and tier -- no cross-contamination", () => {
    saveCachedFieldIds("sigA", FieldTier.SMALL, [["a"]]);
    saveCachedFieldIds("sigA", FieldTier.MID, [["b"]]);
    saveCachedFieldIds("sigB", FieldTier.SMALL, [["c"]]);

    expect(getCachedFieldIds("sigA", FieldTier.SMALL)).toEqual([["a"]]);
    expect(getCachedFieldIds("sigA", FieldTier.MID)).toEqual([["b"]]);
    expect(getCachedFieldIds("sigA", FieldTier.LARGE)).toBeNull();
    expect(getCachedFieldIds("sigB", FieldTier.SMALL)).toEqual([["c"]]);
  });

  it("clear: removes every cached tier for every signature", () => {
    saveCachedFieldIds("sigA", FieldTier.SMALL, [["a"]]);
    saveCachedFieldIds("sigA", FieldTier.MID, [["b"]]);
    saveCachedFieldIds("sigB", FieldTier.LARGE, [["c"]]);

    clearFieldCache();

    expect(getCachedFieldIds("sigA", FieldTier.SMALL)).toBeNull();
    expect(getCachedFieldIds("sigA", FieldTier.MID)).toBeNull();
    expect(getCachedFieldIds("sigB", FieldTier.LARGE)).toBeNull();
  });

  it("clear leaves unrelated localStorage keys alone", () => {
    window.localStorage.setItem("chess-dfs:projections-csv", "unrelated data");
    saveCachedFieldIds("sigA", FieldTier.SMALL, [["a"]]);

    clearFieldCache();

    expect(window.localStorage.getItem("chess-dfs:projections-csv")).toBe("unrelated data");
  });

  it("slateSignature is deterministic and differs for different text", () => {
    expect(slateSignature("same text")).toBe(slateSignature("same text"));
    expect(slateSignature("text one")).not.toBe(slateSignature("text two"));
  });

  describe("resolveCachedField", () => {
    const players = [makePlayer("p1"), makePlayer("p2"), makePlayer("p3")];
    const contest = new ContestConfig({ fieldSize: 50000, payouts: [] }); // Large tier

    it("returns null when nothing is cached for this signature+tier", () => {
      expect(resolveCachedField("sig1", contest, players)).toBeNull();
    });

    it("resolves cached ids back to real Player objects, with lineupWeight from THIS contest", () => {
      saveCachedFieldIds("sig1", FieldTier.LARGE, [
        ["p1", "p2"],
        ["p2", "p3"],
      ]);
      const field = resolveCachedField("sig1", contest, players);
      expect(field).not.toBeNull();
      expect(field!.lineups.map((lineup) => lineup.map((p) => p.id))).toEqual([
        ["p1", "p2"],
        ["p2", "p3"],
      ]);
      // lineupWeight is recomputed from the REAL contest passed in here,
      // not baked in at build time (see fieldCacheStore.ts's own comment).
      expect(field!.lineupWeight).toBeCloseTo(50000 / 2, 10);
    });

    it("drops a cached id with no matching player rather than throwing", () => {
      saveCachedFieldIds("sig1", FieldTier.LARGE, [["p1", "stale-id"]]);
      const field = resolveCachedField("sig1", contest, players);
      expect(field!.lineups[0].map((p) => p.id)).toEqual(["p1"]);
    });
  });
});
