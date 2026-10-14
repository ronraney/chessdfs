// Ported from tests/test_config.py. Python's load_contest_config tests
// write JSON to a tmp_path file and load it from disk; loadContestConfig
// here takes already-parsed data directly (the engine stays I/O-free, same
// as loadSportConfig), so the file-writing step is skipped -- the config
// shape and assertions are otherwise unchanged.
import { describe, expect, it } from "vitest";
import contestsData from "../data/config/contests.json";
import nflConfig from "../data/config/sports/nfl.json";
import { ContestConfig, loadContestConfig, loadContestPresets, type RawContestConfig, type RawContestPreset } from "./config";
import { FieldTier, Player } from "./models";
import { loadSportConfig } from "./sport";

const NFL = loadSportConfig(nflConfig);

function makeConfig(fieldSize: number): ContestConfig {
  return new ContestConfig({ cap: 50000, fieldSize, payouts: [] });
}

function rawConfig(overrides: Partial<RawContestConfig>): RawContestConfig {
  return { field_size: 1000, payouts: [], ...overrides };
}

describe("ContestConfig.fieldTier", () => {
  it("boundary 1999/2000", () => {
    expect(makeConfig(1999).fieldTier()).toBe(FieldTier.SMALL);
    expect(makeConfig(2000).fieldTier()).toBe(FieldTier.MID);
  });

  it("boundary 9999/10000", () => {
    expect(makeConfig(9999).fieldTier()).toBe(FieldTier.MID);
    expect(makeConfig(10000).fieldTier()).toBe(FieldTier.LARGE);
  });
});

describe("cap default/override", () => {
  it("defaults to the sport's salary cap when omitted", () => {
    const contest = new ContestConfig({ fieldSize: 1000, payouts: [] }); // cap omitted
    expect(contest.cap).toBeNull();
    expect(contest.effectiveCap(NFL)).toBe(NFL.salaryCap);
  });

  it("override takes precedence over the sport", () => {
    const contest = new ContestConfig({ cap: 10000, fieldSize: 1000, payouts: [] });
    expect(contest.effectiveCap(NFL)).toBe(10000);
  });

  it("loadContestConfig without cap defaults to the sport", () => {
    const contest = loadContestConfig(rawConfig({}));
    expect(contest.cap).toBeNull();
    expect(contest.effectiveCap(NFL)).toBe(NFL.salaryCap);
  });

  it("loadContestConfig with cap overrides the sport", () => {
    const contest = loadContestConfig(rawConfig({ cap: 35000 }));
    expect(contest.effectiveCap(NFL)).toBe(35000);
  });
});

// --- entry-size tiers / target rank (Task 20) ------------------------------
// Replaces the old percentile "contest aggression scale" (Task 15).

describe("ContestConfig.targetRank", () => {
  it("2 entries is rank 1", () => {
    expect(makeConfig(2).targetRank(200)).toBe(1);
  });

  it("1000 entries is rank 9", () => {
    // 1,000 is Small's own upper bound -- boundary sizes belong to the
    // lower tier, so this is still Small's fraction=1 case (rank 9), not
    // Mid's fraction=0 case (rank 10).
    expect(makeConfig(1000).targetRank(200)).toBe(9);
  });

  it("1001 entries is rank 10", () => {
    // Just over Small's upper bound -- now Mid, essentially at its own
    // fraction=0 case (rank 10).
    expect(makeConfig(1001).targetRank(200)).toBe(10);
  });

  it("maxEntriesScale entries is the last rank", () => {
    expect(makeConfig(416_171).targetRank(200)).toBe(200);
  });

  it("is zero when nothing is ranked", () => {
    expect(makeConfig(1000).targetRank(0)).toBe(0);
  });
});

describe("ContestConfig.entryTier", () => {
  it("boundaries belong to the lower tier", () => {
    expect(makeConfig(1000).entryTier(200).name).toBe("Small");
    expect(makeConfig(1001).entryTier(200).name).toBe("Mid");
    expect(makeConfig(5000).entryTier(200).name).toBe("Mid");
    expect(makeConfig(5001).entryTier(200).name).toBe("Large");
    expect(makeConfig(100_000).entryTier(200).name).toBe("Large");
    expect(makeConfig(100_001).entryTier(200).name).toBe("XL");
  });
});

describe("ContestConfig.rankTier", () => {
  it("matches the configured rank ranges", () => {
    const contest = makeConfig(1000); // irrelevant to rankTier -- only the ranges matter
    expect(contest.rankTier(1, 200).name).toBe("Small");
    expect(contest.rankTier(9, 200).name).toBe("Small");
    expect(contest.rankTier(10, 200).name).toBe("Mid");
    expect(contest.rankTier(29, 200).name).toBe("Mid");
    expect(contest.rankTier(30, 200).name).toBe("Large");
    expect(contest.rankTier(60, 200).name).toBe("Large");
    expect(contest.rankTier(61, 200).name).toBe("XL");
    expect(contest.rankTier(200, 200).name).toBe("XL");
  });
});

describe("loadContestConfig overrides", () => {
  it("max_entries_scale override", () => {
    // field_size sits above the default large_max_entries (100,000), so
    // it's in the XL tier, where an overridden max_entries_scale is the
    // tier's own upper bound -- field_size == max_entries_scale there
    // means XL's fraction=1 case, i.e. target_rank == last_rank.
    const contest = loadContestConfig(
      rawConfig({ field_size: 150_000, max_entries_scale: 150_000 }),
    );
    expect(contest.maxEntriesScale).toBe(150_000);
    expect(contest.targetRank(200)).toBe(200);
  });

  it("without max_entries_scale uses the default", () => {
    const contest = loadContestConfig(rawConfig({}));
    expect(contest.maxEntriesScale).toBe(416_171);
  });

  it("tier overrides", () => {
    const contest = loadContestConfig(
      rawConfig({ small_max_entries: 500, small_max_rank: 5 }),
    );
    expect(contest.smallMaxEntries).toBe(500);
    expect(contest.smallMaxRank).toBe(5);
    // 1,000 entries now falls past Small's (overridden) upper bound.
    expect(contest.entryTier(200).name).toBe("Mid");
  });
});

// Task 27: no existing Python or TS test exercises ownFor/field_tier
// together end-to-end at these specific cutoffs -- test_config.py's
// field_tier boundary tests check tier classification only (no
// ownership values), and test_models.py's own_for tests check ownership
// averaging in isolation (arbitrary small/large values, never tied to a
// field_size number). Added here per Task 27's explicit instruction to
// check for this coverage and add it if missing.
describe("ownership by contest entries (fieldTier + ownFor)", () => {
  function player(ownSmall: number, ownLarge: number): Player {
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
    });
  }

  it("1,999 entries uses Small Field ownership only", () => {
    const contest = new ContestConfig({ fieldSize: 1999, payouts: [] });
    expect(player(10, 20).ownFor(contest.fieldTier())).toBe(10);
  });

  it("2,000 entries averages Small and Large Field ownership", () => {
    const contest = new ContestConfig({ fieldSize: 2000, payouts: [] });
    expect(player(10, 20).ownFor(contest.fieldTier())).toBe(15);
  });

  it("9,999 entries averages Small and Large Field ownership", () => {
    const contest = new ContestConfig({ fieldSize: 9999, payouts: [] });
    expect(player(10, 20).ownFor(contest.fieldTier())).toBe(15);
  });

  it("10,000 entries uses Large Field ownership only", () => {
    const contest = new ContestConfig({ fieldSize: 10000, payouts: [] });
    expect(player(10, 20).ownFor(contest.fieldTier())).toBe(20);
  });
});

// --- contest presets (Tasks 31/32) ------------------------------------------
// config/contests.json has no Python original -- new, TS-only. Round-trips
// against the real, synced file (same pattern as nflConfig above), not a
// synthetic fixture, so a change to the seeded presets themselves would
// surface here too. Task 32 replaced the two hand-seeded presets with every
// row of data/samples/NFL Weekly DFS System - Sim_Contest.csv except "NFL
// GIANT $25 Double-Up" (a cash game, unsupported) -- H2H (also technically
// "cash" in that CSV) is kept regardless, per Task 32's explicit carve-out.

describe("loadContestPresets", () => {
  it("round-trips name/buyIn/contest for every preset", () => {
    const presets = loadContestPresets(contestsData as RawContestPreset[]);
    expect(presets.length).toBe((contestsData as RawContestPreset[]).length);
    for (const [index, preset] of presets.entries()) {
      const raw = (contestsData as RawContestPreset[])[index];
      expect(preset.name).toBe(raw.name);
      expect(preset.buyIn).toBe(raw.buy_in);
      expect(preset.contest.fieldSize).toBe(raw.entries);
    }
  });

  it("skips the unsupported cash game but keeps H2H", () => {
    const presets = loadContestPresets(contestsData as RawContestPreset[]);
    expect(presets.some((p) => p.name === "NFL GIANT $25 Double-Up")).toBe(false);

    const h2h = presets.find((p) => p.name === "H2H");
    expect(h2h).toBeDefined();
    expect(h2h!.contest.fieldSize).toBe(2);
    expect(h2h!.buyIn).toBe(1);
  });

  it("entries not given a cap default to the sport's salary cap", () => {
    const presets = loadContestPresets(contestsData as RawContestPreset[]);
    expect(presets.every((p) => p.contest.cap === null)).toBe(true);
  });
});
