// Task 37: buildStats.ts's own tests -- pure-function coverage for the
// build screen's per-side stats and pick-modal eligibility, independent of
// any component rendering. Synthetic players (not the real sample CSV)
// keep the salary/ownership arithmetic exact and the "never appears"
// eligibility claim provable in general, not just for whichever piece
// bands the Morphy Defense line happens to touch.
import { describe, expect, it } from "vitest";
import nflConfig from "./data/config/sports/nfl.json";
import { pickReason, pieceBandLabel, sideStats, tightFinishStatus } from "./buildStats";
import { ContestConfig } from "./engine/config";
import { Piece, Player } from "./engine/models";
import { loadSportConfig } from "./engine/sport";

const NFL = loadSportConfig(nflConfig);
const CONTEST = new ContestConfig({ fieldSize: 1000, payouts: [] }); // Mid tier -> FieldTier.MID -> ownFor averages small/large

function player(
  id: string, pos: string, salary: number, proj: number, ownSmall = 0.1, ownLarge = 0.3,
): Player {
  return new Player({
    id, name: id, positions: [pos], team: "AAA", opp: "BBB", salary, proj, ownSmall, ownLarge,
    floor: proj * 0.6, ceiling: proj * 1.6,
  });
}

// Task "piece pools": PAWN is now two bands (RB/TE/WR under $5,000, and
// DST at any salary) -- pieceBandLabel joins every band for a piece, not
// just the first one found, so the label never silently omits half of
// what the pick list actually offers.
describe("pieceBandLabel", () => {
  it("King has no salary bound shown -- just the position", () => {
    expect(pieceBandLabel(Piece.KING, NFL)).toBe("QB");
  });

  it("Queen, Bishop, and Knight are all RB/WR/TE now, differing only by salary floor", () => {
    expect(pieceBandLabel(Piece.QUEEN, NFL)).toBe("RB/TE/WR · $7,000+");
    expect(pieceBandLabel(Piece.BISHOP, NFL)).toBe("RB/TE/WR · $5,000+");
    expect(pieceBandLabel(Piece.KNIGHT, NFL)).toBe("RB/TE/WR · $4,500+");
  });

  it("Rook is RB/WR/TE with no salary bound at all (team-restricted instead)", () => {
    expect(pieceBandLabel(Piece.ROOK, NFL)).toBe("RB/TE/WR");
  });

  it("Pawn joins both its bands", () => {
    expect(pieceBandLabel(Piece.PAWN, NFL)).toBe("up to $4,999, or DST");
  });
});

describe("sideStats", () => {
  it("no players: full cap, no projection/ownership, every slot open", () => {
    const stats = sideStats([], NFL, CONTEST);
    expect(stats.salaryRemaining).toBe(CONTEST.effectiveCap(NFL));
    expect(stats.projTotal).toBe(0);
    expect(stats.ownershipTotal).toBe(0);
    expect(stats.openSlotCount).toBe(NFL.rosterSize);
  });

  it("sums salary/projection/ownership and reduces open slots for locked players", () => {
    const qb = player("qb1", "QB", 7500, 20.5, 0.2, 0.4);
    const rb = player("rb1", "RB", 6000, 15.0, 0.1, 0.25);
    const stats = sideStats([qb, rb], NFL, CONTEST);

    expect(stats.salaryRemaining).toBe(CONTEST.effectiveCap(NFL) - 7500 - 6000);
    expect(stats.projTotal).toBeCloseTo(35.5);
    expect(stats.ownershipTotal).toBeCloseTo(qb.ownFor(CONTEST.fieldTier()) + rb.ownFor(CONTEST.fieldTier()));
    expect(stats.openSlotCount).toBe(NFL.rosterSize - 2);
    expect(stats.avgRemainingPerOpenSlot).toBeCloseTo(stats.salaryRemaining / stats.openSlotCount);
  });

  it("avg remaining per open slot is 0, not NaN/Infinity, once every slot is filled", () => {
    const full = NFL.rosterSlots.flatMap((slot, i) =>
      Array.from({ length: slot.count }, (_, j) => player(`p${i}-${j}`, [...slot.positions][0], 4000, 5)),
    );
    const stats = sideStats(full, NFL, CONTEST);
    expect(stats.openSlotCount).toBe(0);
    expect(stats.avgRemainingPerOpenSlot).toBe(0);
  });

  it("'after this pick' preview is just sideStats with the candidate appended", () => {
    const qb = player("qb1", "QB", 7500, 20.5);
    const candidate = player("rb1", "RB", 6000, 15.0);
    const before = sideStats([qb], NFL, CONTEST);
    const after = sideStats([qb, candidate], NFL, CONTEST);

    expect(after.salaryRemaining).toBe(before.salaryRemaining - candidate.salary);
    expect(after.openSlotCount).toBe(before.openSlotCount - 1);
  });
});

// Tight-finish alert (White only): a display-only heads-up, never a block.
// Rule change "new levels + Go back" dropped the old aggravating-factor
// gate entirely (Caution/Warning now fire on avg remaining per open slot
// alone) and added a third, worse level ("critical" -- barely
// completable, checked first) with its own looser 1-open-slot gate;
// Caution/Warning still need 2+ open slots. `CHEAP_POOL` stands in for
// "plenty of cheap players are still genuinely available" in every test
// that isn't itself about the critical level, so its own cheapest-
// completion check never fires a false positive underneath the thing
// actually under test.
describe("tightFinishStatus", () => {
  const CHEAP_POOL = [
    player("cheap_qb", "QB", 2000, 1),
    player("cheap_rb1", "RB", 2000, 1),
    player("cheap_rb2", "RB", 2100, 1),
    player("cheap_wr1", "WR", 2000, 1),
    player("cheap_wr2", "WR", 2100, 1),
    player("cheap_te1", "TE", 2000, 1),
    player("cheap_te2", "TE", 2100, 1),
    player("cheap_dst", "DST", 2000, 1),
  ];

  it("null once avg remaining per open slot is comfortably above every threshold", () => {
    expect(tightFinishStatus([], CHEAP_POOL, NFL, CONTEST)).toBeNull();
  });

  it("null -- fewer than 2 open slots -- even though salary left is extremely tight (Caution/Warning's own gate)", () => {
    const locked = [
      player("qb1", "QB", 6000, 20),
      player("rb1", "RB", 6000, 10),
      player("rb2", "RB", 6000, 10),
      player("wr1", "WR", 6000, 10),
      player("wr2", "WR", 6000, 10),
      player("wr3", "WR", 6000, 10),
      player("te1", "TE", 6000, 10),
      player("flex1", "RB", 5000, 10), // 8 locked -> only DST open (1 slot, below the 2-slot gate)
    ];
    // avg would read as a clear Warning (3000 <= $4,000) if the gate
    // didn't apply -- a cheap DST keeps the critical check out of it too,
    // isolating the gate as the one and only reason this is null.
    const available = [...CHEAP_POOL, player("dst1", "DST", 2000, 1)];
    expect(tightFinishStatus(locked, available, NFL, CONTEST)).toBeNull();
  });

  it("caution at the (loosened) $5,000 avg threshold", () => {
    const locked = [
      player("qb1", "QB", 7500, 20),
      player("rb1", "RB", 6000, 10),
      player("rb2", "RB", 6000, 10),
      player("wr1", "WR", 6000, 10),
      player("wr2", "WR", 6000, 10),
      player("wr3", "WR", 5000, 10), // TE/FLEX/DST open = 3
    ];
    const status = tightFinishStatus(locked, CHEAP_POOL, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("caution");
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(4500);
    expect(status!.message).toBe("Salary getting tight: $4,500 per open slot.");
  });

  it("warning at the $4,000 avg threshold -- no aggravating factor needed any more", () => {
    const locked = [
      player("qb1", "QB", 7500, 20),
      player("rb1", "RB", 6500, 10),
      player("rb2", "RB", 6500, 10),
      player("wr1", "WR", 6500, 10),
      player("wr2", "WR", 6800, 10),
      player("wr3", "WR", 4200, 10), // TE/FLEX/DST open = 3
    ];
    const status = tightFinishStatus(locked, CHEAP_POOL, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("warning");
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(4000);
    expect(status!.message).toBe("Tight finish: $4,000 per open slot.");
  });

  it("critical ('barely completable') once remaining minus the cheapest completion drops under $500", () => {
    const locked = [
      player("qb1", "QB", 6000, 20),
      player("rb1", "RB", 6000, 10),
      player("rb2", "RB", 6000, 10),
      player("wr1", "WR", 6000, 10),
      player("wr2", "WR", 6000, 10),
      player("wr3", "WR", 6000, 10),
      player("te1", "TE", 6000, 10),
      player("flex1", "RB", 5700, 10), // 8 locked -> only DST open; remaining = $2,300
    ];
    const available = [player("dst_a", "DST", 2000, 1), player("dst_b", "DST", 1900, 1)]; // cheapest = $1,900
    const status = tightFinishStatus(locked, available, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("critical");
    expect(status!.message).toBe("Barely completable: $400 of room before the cheapest finish.");
  });

  it("critical overrides a comfortable avg -- it has no 2-open-slot gate of its own", () => {
    const locked = [
      player("qb1", "QB", 6000, 20),
      player("rb1", "RB", 4000, 10),
      player("rb2", "RB", 4000, 10),
      player("wr1", "WR", 4000, 10),
      player("wr2", "WR", 4000, 10),
      player("wr3", "WR", 4000, 10),
      player("te1", "TE", 4000, 10), // 7 locked -> FLEX + DST open = 2; remaining = $20,000, avg = $10,000
    ];
    // DST is cheap, but the only FLEX-eligible player left is expensive --
    // the avg alone (well above the $5,000 caution threshold) says
    // nothing's wrong; the exact completability check disagrees.
    const available = [player("flex_only", "RB", 17600, 1), player("dst1", "DST", 2000, 1)];
    const status = tightFinishStatus(locked, available, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("critical");
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(10000);
    expect(status!.message).toBe("Barely completable: $400 of room before the cheapest finish.");
  });

  it("null once every slot is filled, regardless of what's left available", () => {
    const full = NFL.rosterSlots.flatMap((slot, i) =>
      Array.from({ length: slot.count }, (_, j) => player(`p${i}-${j}`, [...slot.positions][0], 4000, 5)),
    );
    expect(tightFinishStatus(full, [], NFL, CONTEST)).toBeNull();
  });

  it("falls through to the avg-based result (not critical, not a crash) when no legal completion exists at all", () => {
    const locked = [
      player("qb1", "QB", 5000, 20),
      player("rb1", "RB", 5000, 10),
      player("rb2", "RB", 5000, 10),
      player("wr1", "WR", 5000, 10),
      player("wr2", "WR", 5000, 10),
      player("wr3", "WR", 5000, 10), // TE/FLEX/DST open = 3; avg = $6,667 -- comfortable
    ];
    expect(tightFinishStatus(locked, [], NFL, CONTEST)).toBeNull();
  });
});

// Task 39: the pick modal's "grey this row out, with a reason" check.
describe("pickReason", () => {
  it("null (feasible) for an ordinary affordable, slot-available pick", () => {
    const candidate = player("rb1", "RB", 6000, 15.0);
    expect(pickReason([], candidate, NFL, CONTEST)).toBeNull();
  });

  it("'over the cap' once the candidate's own salary alone overflows it", () => {
    const tightContest = new ContestConfig({ fieldSize: 1000, payouts: [], cap: 10000 });
    const candidate = player("rb1", "RB", 15000, 15.0);
    expect(pickReason([], candidate, NFL, tightContest)).toBe("over the cap");
  });

  it("'no slot left' once every RB-eligible slot (RB x2, FLEX) is already spoken for", () => {
    const rb1 = player("rb1", "RB", 5500, 10);
    const rb2 = player("rb2", "RB", 5500, 10);
    const rb3 = player("rb3", "RB", 5500, 10); // fills RB, RB, FLEX -- no RB-eligible slot left
    const candidate = player("rb4", "RB", 5500, 10);
    expect(pickReason([rb1, rb2, rb3], candidate, NFL, CONTEST)).toBe("no slot left");
  });

  it("cap is checked before slots -- an over-cap pick that's also slot-infeasible still reads 'over the cap'", () => {
    const tightContest = new ContestConfig({ fieldSize: 1000, payouts: [], cap: 1000 });
    const rb1 = player("rb1", "RB", 500, 10);
    const rb2 = player("rb2", "RB", 500, 10);
    const rb3 = player("rb3", "RB", 500, 10); // already no RB-eligible slot left, and barely any cap room
    const candidate = player("rb4", "RB", 5000, 10); // way over what's left
    expect(pickReason([rb1, rb2, rb3], candidate, NFL, tightContest)).toBe("over the cap");
  });
});
