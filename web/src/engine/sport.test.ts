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

  it("rejects a config with a salary gap", () => {
    // Piece pools: bands below $5,000 and above $5,000 that don't
    // actually meet at the boundary leave a real gap (nothing matches
    // exactly $5,000) -- rejected the same as a missing catch-all.
    const config = makeConfig([
      { piece: "KING", positions: ["QB"], min_salary: null, max_salary: null },
      { piece: "PAWN", positions: null, min_salary: null, max_salary: 4999 },
      { piece: "QUEEN", positions: null, min_salary: 5001, max_salary: null },
    ]);
    expect(() => loadSportConfig(config)).toThrow();
  });

  it("accepts bands that meet exactly at the boundary", () => {
    const config = makeConfig([
      { piece: "KING", positions: ["QB"], min_salary: null, max_salary: null },
      { piece: "PAWN", positions: null, min_salary: null, max_salary: 5000 },
      { piece: "QUEEN", positions: null, min_salary: 5000, max_salary: null },
    ]);
    const sport = loadSportConfig(config);
    expect(sport.sport).toBe("TEST");
  });

  it("honors exclude_positions for coverage -- excluding X needs X's own fallback", () => {
    const config = makeConfig([
      { piece: "QUEEN", positions: null, exclude_positions: ["X"], min_salary: null, max_salary: null },
    ]);
    expect(() => loadSportConfig(config)).toThrow();
  });

  it("accepts exclude_positions with a fallback band", () => {
    const config = makeConfig([
      { piece: "QUEEN", positions: null, exclude_positions: ["X"], min_salary: null, max_salary: null },
      { piece: "PAWN", positions: ["X"], min_salary: null, max_salary: null },
    ]);
    const sport = loadSportConfig(config);
    expect(sport.sport).toBe("TEST");
  });

  it("defaults domeTeams to empty when dome_teams is absent", () => {
    const config = makeConfig([{ piece: "PAWN", positions: null, min_salary: null, max_salary: null }]);
    const sport = loadSportConfig(config);
    expect(sport.domeTeams.size).toBe(0);
  });

  it("parses dome_teams into domeTeams", () => {
    const config: RawSportConfig = {
      ...makeConfig([{ piece: "PAWN", positions: null, min_salary: null, max_salary: null }]),
      dome_teams: ["ARI", "LV"],
    };
    const sport = loadSportConfig(config);
    expect(sport.domeTeams.has("ARI")).toBe(true);
    expect(sport.domeTeams.has("LV")).toBe(true);
    expect(sport.domeTeams.has("SF")).toBe(false);
  });
});
