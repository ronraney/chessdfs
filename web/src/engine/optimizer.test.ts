import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { Player } from "./models";
import { cheapestCompletionCost, optimalLineup } from "./optimizer";
import { loadSportConfig } from "./sport";

const NFL = loadSportConfig(nflConfig);
const CAP = NFL.salaryCap; // 50,000

function makePlayer(id: string, pos: string, salary: number, proj: number, team = "AAA"): Player {
  return new Player({
    id, name: id, positions: [pos], team, opp: "BBB",
    salary, proj, ownSmall: 0.1, ownLarge: 0.1, floor: proj * 0.6, ceiling: proj * 1.6,
  });
}

// The non-WR half of a minimal, exactly-fillable DK Classic roster (QB x1,
// RB x2, TE x1, DST x1 -- 5 of the 9 slots) -- cheap and unremarkable by
// design, so every test below can focus its own salary/projection trade-off
// entirely on the WR/FLEX group without also having to re-justify the rest
// of the lineup.
function minimalFiller(): Player[] {
  return [
    makePlayer("qb1", "QB", 5000, 20),
    makePlayer("dst1", "DST", 2000, 5),
    makePlayer("rb1", "RB", 4000, 10),
    makePlayer("rb2", "RB", 4000, 10),
    makePlayer("te1", "TE", 3000, 8),
  ];
}
const FILLER_SALARY = 5000 + 2000 + 4000 + 4000 + 3000; // 18,000
const FILLER_PROJ = 20 + 5 + 10 + 10 + 8; // 53

describe("optimalLineup -- known-answer slate (not greedy)", () => {
  // 3 WR slots + 1 FLEX need exactly 4 picks from 5 WR-eligible candidates.
  // w1/w2/w3 are identical "elite" options (salary 9,000, proj 30); w4/w5
  // are identical "cheap" options (salary 3,000, proj 12/11). A cap of
  // 46,000 leaves exactly 28,000 for the WR group: all 3 elites plus any
  // cheap one costs 30,000 (too much), but 2 elites + both cheap ones costs
  // 24,000 (fits) -- so the true optimum drops exactly ONE elite, not the
  // worst-looking (cheapest) candidates. A greedy "sort by projection, take
  // what still fits" pass takes all 3 elites first (tied for best, 27,000
  // spent, 1,000 left) and then can't afford a 4th pick at all -- an
  // INCOMPLETE roster, not just a worse one.
  it("drops an elite WR (not the cheap ones) to afford a complete, higher-total lineup", () => {
    const wrGroup = [
      makePlayer("w1", "WR", 9000, 30),
      makePlayer("w2", "WR", 9000, 30),
      makePlayer("w3", "WR", 9000, 30),
      makePlayer("w4", "WR", 3000, 12),
      makePlayer("w5", "WR", 3000, 11),
    ];
    const players = [...minimalFiller(), ...wrGroup];
    const cap = FILLER_SALARY + 28000; // 46,000

    const result = optimalLineup(players, NFL, cap);

    expect(result).not.toBeNull();
    expect(result!.lineup).toHaveLength(NFL.rosterSize); // 9
    expect(result!.total).toBeCloseTo(FILLER_PROJ + 30 + 30 + 12 + 11, 5); // 136

    const ids = new Set(result!.lineup.map((p) => p.id));
    expect(ids.has("w4")).toBe(true);
    expect(ids.has("w5")).toBe(true);
    const elitesKept = ["w1", "w2", "w3"].filter((id) => ids.has(id));
    expect(elitesKept).toHaveLength(2); // exactly one elite was dropped

    const totalSalary = result!.lineup.reduce((sum, p) => sum + p.salary, 0);
    expect(totalSalary).toBeLessThanOrEqual(cap);
  });
});

describe("optimalLineup -- locks and exclusions (best completion)", () => {
  it("forces a locked player in even when it isn't the free-pick optimum", () => {
    const wrGroup = [
      makePlayer("w1", "WR", 9000, 30),
      makePlayer("w2", "WR", 9000, 30),
      makePlayer("w3", "WR", 9000, 30),
      makePlayer("w4", "WR", 3000, 12),
      makePlayer("w5", "WR", 3000, 11),
      makePlayer("w6", "WR", 9500, 5), // expensive AND weak -- never the free choice
    ];
    const players = [...minimalFiller(), ...wrGroup];
    const cap = FILLER_SALARY + 28000;

    const free = optimalLineup(players, NFL, cap);
    expect(free!.lineup.some((p) => p.id === "w6")).toBe(false); // confirms w6 is never the free choice

    const locked = optimalLineup(players, NFL, cap, { locked: [wrGroup[5]] }); // force w6 in
    expect(locked).not.toBeNull();
    expect(locked!.lineup.some((p) => p.id === "w6")).toBe(true);
    expect(locked!.lineup).toHaveLength(NFL.rosterSize);
    expect(locked!.total).toBeLessThan(free!.total); // forcing the worst pick costs total proj
  });

  it("never selects an excluded player, even the single best one available", () => {
    const wrGroup = [
      makePlayer("w1", "WR", 9000, 50), // the clear best WR on the slate
      makePlayer("w2", "WR", 9000, 30),
      makePlayer("w3", "WR", 9000, 30),
      makePlayer("w4", "WR", 3000, 12),
      makePlayer("w5", "WR", 3000, 11),
    ];
    const players = [...minimalFiller(), ...wrGroup];
    const cap = FILLER_SALARY + 28000;

    const result = optimalLineup(players, NFL, cap, { excludeIds: new Set(["w1"]) });

    expect(result).not.toBeNull();
    expect(result!.lineup.some((p) => p.id === "w1")).toBe(false);
    expect(result!.lineup).toHaveLength(NFL.rosterSize);
  });
});

describe("optimalLineup -- FLEX", () => {
  it("fills FLEX with whichever eligible position maximizes total projection", () => {
    const players = [
      makePlayer("qb1", "QB", 1000, 1),
      makePlayer("dst1", "DST", 1000, 1),
      makePlayer("rb1", "RB", 1000, 5),
      makePlayer("rb2", "RB", 1000, 5),
      makePlayer("te1", "TE", 1000, 5),
      makePlayer("w1", "WR", 1000, 5),
      makePlayer("w2", "WR", 1000, 5),
      makePlayer("w3", "WR", 1000, 5),
      // A 4th WR, tied with w1/w2/w3 -- with 4 interchangeable WR candidates
      // for 3 dedicated WR slots, one of the four is always the "spare"
      // competing for FLEX. A 3rd RB (only 2 dedicated RB slots exist, so it
      // can only ever land in FLEX itself) with a much higher projection
      // than any of the tied WRs should win that FLEX spot instead.
      makePlayer("w4", "WR", 1000, 5),
      makePlayer("rb3", "RB", 1000, 50),
    ];

    const result = optimalLineup(players, NFL, CAP);

    expect(result).not.toBeNull();
    const ids = new Set(result!.lineup.map((p) => p.id));
    expect(ids.has("rb3")).toBe(true); // FLEX went to the high-projection RB
    const wrsKept = ["w1", "w2", "w3", "w4"].filter((id) => ids.has(id));
    expect(wrsKept).toHaveLength(3); // exactly one of the tied WRs sat out
    expect(result!.lineup).toHaveLength(NFL.rosterSize);
  });
});

describe("optimalLineup -- dominance pruning (performance) doesn't drop needed duplicates", () => {
  // RB is eligible for both the RB slot (count 2) and FLEX (count 1) -- a
  // group that can need as many as 3 players at once, not just the single
  // best one. 5 IDENTICAL RBs (same salary, same projection) is the
  // adversarial case for a pruning step that only keeps "the best" per
  // group: a naive version drops all but 1, or -- if ties mutually
  // "dominate" each other with no tiebreak -- drops all of them, either
  // way leaving fewer than the 3 this slate actually needs.
  it("keeps enough identical RBs to fill RB + FLEX, even though they're all tied", () => {
    const rbs = [1, 2, 3, 4, 5].map((i) => makePlayer(`rb${i}`, "RB", 4000, 10));
    const players = [
      makePlayer("qb1", "QB", 5000, 20),
      makePlayer("dst1", "DST", 2000, 5),
      makePlayer("te1", "TE", 3000, 8),
      makePlayer("w1", "WR", 5000, 15),
      makePlayer("w2", "WR", 5000, 15),
      makePlayer("w3", "WR", 5000, 15),
      ...rbs,
    ];

    const result = optimalLineup(players, NFL, CAP);

    expect(result).not.toBeNull();
    expect(result!.lineup).toHaveLength(NFL.rosterSize);
    const rbsKept = rbs.filter((p) => result!.lineup.some((lp) => lp.id === p.id));
    expect(rbsKept).toHaveLength(3); // RB's own 2 slots + the 1 FLEX slot
  });
});

describe("optimalLineup -- salary cap", () => {
  it("never returns a lineup over the cap", () => {
    const wrGroup = [
      makePlayer("w1", "WR", 9000, 30),
      makePlayer("w2", "WR", 9000, 30),
      makePlayer("w3", "WR", 9000, 30),
      makePlayer("w4", "WR", 3000, 12),
      makePlayer("w5", "WR", 3000, 11),
    ];
    const players = [...minimalFiller(), ...wrGroup];

    const result = optimalLineup(players, NFL, CAP); // the full 50,000 cap -- room for all 5 WRs
    expect(result).not.toBeNull();
    const totalSalary = result!.lineup.reduce((sum, p) => sum + p.salary, 0);
    expect(totalSalary).toBeLessThanOrEqual(CAP);
  });

  it("returns null when no legal lineup fits under the cap", () => {
    const players = [
      makePlayer("qb1", "QB", 40000, 20),
      makePlayer("dst1", "DST", 2000, 5),
      makePlayer("rb1", "RB", 4000, 10),
      makePlayer("rb2", "RB", 4000, 10),
      makePlayer("te1", "TE", 3000, 8),
      makePlayer("w1", "WR", 9000, 30),
      makePlayer("w2", "WR", 9000, 30),
      makePlayer("w3", "WR", 9000, 30),
      makePlayer("w4", "WR", 3000, 12),
    ]; // the only possible 9-player roster here (exact position counts, no
    // spares for FLEX) sums to 83,000 -- no way to fit under 50,000

    const result = optimalLineup(players, NFL, CAP);
    expect(result).toBeNull();
  });
});

// Rule change "Tight-finish alerts: new levels + Go back" -- step 3's own
// floor: the cheapest a side could still finish its OPEN slots for. Same
// "not greedy" concern as optimalLineup's own known-answer test above, just
// inverted (minimizing salary, not maximizing projection): a naive
// independent per-slot "take the cheapest eligible player" can double-book
// the same player into two different open slots when one player (or a
// small group) is eligible for more than one of them.
describe("cheapestCompletionCost", () => {
  it("returns 0 with no solve at all once there's nothing open", () => {
    expect(cheapestCompletionCost([], {}, NFL.rosterSlots)).toBe(0);
  });

  it("doesn't double-book the one cheap player across two open slots that both accept them", () => {
    // RB is eligible for the dedicated RB slot AND FLEX -- if the solver
    // let the single cheap RB count toward both open slots at once, the
    // (wrong) answer would be 4,000 (2,000 twice); correctly used for only
    // one of them, the other slot has to fall back to the next-cheapest
    // FLEX-eligible player instead.
    const available = [makePlayer("rb_cheap", "RB", 2000, 1), makePlayer("wr_cheap", "WR", 2500, 1)];
    const cost = cheapestCompletionCost(available, { RB: 1, FLEX: 1 }, NFL.rosterSlots);
    expect(cost).toBe(4500);
  });

  it("fills a multi-count open slot with its own cheapest eligible players, not just one", () => {
    const available = [
      makePlayer("w1", "WR", 3000, 1),
      makePlayer("w2", "WR", 3500, 1),
      makePlayer("w3", "WR", 9000, 1), // never needed -- the other two are enough and cheaper
    ];
    const cost = cheapestCompletionCost(available, { WR: 2 }, NFL.rosterSlots);
    expect(cost).toBe(6500);
  });

  it("ignores players who aren't eligible for any currently-open slot", () => {
    const available = [makePlayer("dst_cheap", "DST", 1500, 1), makePlayer("qb_irrelevant", "QB", 1, 1)];
    const cost = cheapestCompletionCost(available, { DST: 1 }, NFL.rosterSlots);
    expect(cost).toBe(1500); // the $1 QB is irrelevant -- DST is the only open slot
  });

  it("returns null when no eligible player is left for some open slot at all", () => {
    const available = [makePlayer("rb1", "RB", 4000, 10)]; // no QB-eligible player anywhere
    expect(cheapestCompletionCost(available, { QB: 1 }, NFL.rosterSlots)).toBeNull();
  });
});
