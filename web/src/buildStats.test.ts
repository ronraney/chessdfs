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

// Tight-finish warning (White only): a display-only heads-up, never a
// block, gated on White having 3+ open slots. Caution fires on avg
// remaining per open slot alone; Warning additionally needs at least one
// aggravating factor, so the same avg with no factor present stays Caution
// rather than escalating.
describe("tightFinishStatus", () => {
  it("null once avg remaining per open slot is comfortably above the caution threshold", () => {
    expect(tightFinishStatus([], NFL, CONTEST)).toBeNull();
  });

  it("null -- fewer than 3 open slots -- even though salary left is extremely tight", () => {
    const locked = [
      player("qb1", "QB", 7500, 20),
      player("rb1", "RB", 6500, 10),
      player("rb2", "RB", 6500, 10),
      player("wr1", "WR", 6500, 10),
      player("wr2", "WR", 6500, 10),
      player("wr3", "WR", 6500, 10),
      player("te1", "TE", 8500, 10), // 7 locked -> FLEX + DST open = 2, below the gate
    ];
    expect(tightFinishStatus(locked, NFL, CONTEST)).toBeNull();
  });

  it("caution at the $4,500 avg threshold, with no aggravating factor required", () => {
    const locked = [
      player("qb1", "QB", 7500, 20),
      player("rb1", "RB", 6000, 10),
      player("rb2", "RB", 6000, 10),
      player("wr1", "WR", 6000, 10),
      player("wr2", "WR", 6000, 10),
      player("wr3", "WR", 5000, 10), // TE/FLEX/DST open = 3
    ];
    const status = tightFinishStatus(locked, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("caution");
    expect(status!.reasons).toEqual([]);
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(4500);
    expect(status!.message).toBe("Salary getting tight: $4,500 per open slot.");
  });

  it("stays caution, not warning, at the $4,000 avg threshold when no aggravating factor applies", () => {
    const locked = [
      player("qb1", "QB", 7500, 20), // QB filled
      player("rb1", "RB", 6500, 10),
      player("rb2", "RB", 6500, 10),
      player("wr1", "WR", 6500, 10),
      player("wr2", "WR", 6000, 10),
      player("wr3", "WR", 5000, 10), // none Pawn-priced (all >= $5,000); 0 TE locked
    ];
    const status = tightFinishStatus(locked, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("caution");
    expect(status!.reasons).toEqual([]);
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(4000);
    expect(status!.message).toBe("Salary getting tight: $4,000 per open slot.");
  });

  it("warning once avg <= $4,000 AND a Pawn-priced player is locked (by salary, not by the piece that locked him)", () => {
    const locked = [
      player("qb1", "QB", 7500, 20),
      player("rb1", "RB", 6500, 10),
      player("rb2", "RB", 6500, 10),
      player("wr1", "WR", 6500, 10),
      player("wr2", "WR", 6800, 10),
      player("wr3", "WR", 4200, 10), // < $5,000, non-QB -> Pawn-priced regardless of how he was drafted
    ];
    const status = tightFinishStatus(locked, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("warning");
    expect(status!.reasons).toEqual(["a Pawn-priced player locked"]);
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(4000);
    expect(status!.message).toBe("Tight finish: $4,000 per open slot · a Pawn-priced player locked");
  });

  it("warning once avg <= $4,000 AND both TE slots are used (the dedicated TE slot plus a 2nd TE in FLEX)", () => {
    const locked = [
      player("qb1", "QB", 8000, 20),
      player("te1", "TE", 9000, 10),
      player("te2", "TE", 9000, 10), // 2nd TE fills FLEX -- RB/WR/DST (6 slots) stay open
    ];
    const status = tightFinishStatus(locked, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("warning");
    expect(status!.reasons).toEqual(["both TE slots used"]);
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(4000);
    expect(status!.message).toBe("Tight finish: $4,000 per open slot · both TE slots used");
  });

  it("warning once avg <= $4,000 AND White's QB slot is still open", () => {
    const locked = [
      player("rb1", "RB", 6500, 10),
      player("rb2", "RB", 6500, 10),
      player("wr1", "WR", 6500, 10),
      player("wr2", "WR", 6500, 10),
      player("wr3", "WR", 6000, 10),
      player("te1", "TE", 6000, 10), // QB/FLEX/DST open = 3; no QB locked
    ];
    const status = tightFinishStatus(locked, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("warning");
    expect(status!.reasons).toEqual(["QB still open"]);
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(4000);
    expect(status!.message).toBe("Tight finish: $4,000 per open slot · QB still open");
  });

  it("joins more than one aggravating-factor reason together", () => {
    const locked = [
      player("rb1", "RB", 7500, 10),
      player("rb2", "RB", 7000, 10),
      player("wr1", "WR", 7000, 10),
      player("wr2", "WR", 7000, 10),
      player("wr3", "WR", 6000, 10),
      player("te1", "TE", 4000, 10), // < $5,000 -> Pawn-priced; no QB locked
    ];
    const status = tightFinishStatus(locked, NFL, CONTEST);
    expect(status).not.toBeNull();
    expect(status!.level).toBe("warning");
    expect(status!.reasons).toEqual(["a Pawn-priced player locked", "QB still open"]);
    expect(status!.avgRemainingPerOpenSlot).toBeCloseTo(11500 / 3);
    expect(status!.message).toBe("Tight finish: $3,833 per open slot · a Pawn-priced player locked · QB still open");
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
