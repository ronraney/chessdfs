// Ported from tests/test_sport.py. Python writes the config to a tmp_path
// file and loads it from disk; loadSportConfig here takes already-parsed
// data directly (the engine stays I/O-free), so the file-writing step is
// skipped -- the config shape and assertions are otherwise unchanged.
import { describe, expect, it } from "vitest";
import { loadSportConfig, type RawSportConfig } from "./sport";

function makeConfig(pieceBands: RawSportConfig["piece_bands"]): RawSportConfig {
  return {
    sport: "TEST",
    salary_cap: 50000,
    piece_bands: pieceBands,
    roster_slots: [{ name: "ANY", positions: ["X"], count: 1 }],
  };
}

describe("loadSportConfig", () => {
  it("rejects a config missing a catch-all band", () => {
    const config = makeConfig([
      { piece: "KING", positions: ["QB"], min_salary: null, max_salary: null },
    ]);
    expect(() => loadSportConfig(config)).toThrow();
  });

  it("accepts a config with a catch-all band", () => {
    const config = makeConfig([
      { piece: "KING", positions: ["QB"], min_salary: null, max_salary: null },
      { piece: "PAWN", positions: null, min_salary: null, max_salary: null },
    ]);
    const sport = loadSportConfig(config);
    expect(sport.sport).toBe("TEST");
  });
});
