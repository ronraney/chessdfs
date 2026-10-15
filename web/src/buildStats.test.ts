// Task 37: buildStats.ts's own tests -- pure-function coverage for the
// build screen's per-side stats and pick-modal eligibility, independent of
// any component rendering. Synthetic players (not the real sample CSV)
// keep the salary/ownership arithmetic exact and the "never appears"
// eligibility claim provable in general, not just for whichever piece
// bands the Morphy Defense line happens to touch.
import { describe, expect, it } from "vitest";
import nflConfig from "./data/config/sports/nfl.json";
import { eligiblePlayers, pickReason, pieceBandLabel, sideStats } from "./buildStats";
import { ContestConfig } from "./engine/config";
import { Piece, Player } from "./engine/models";
import { loadSportConfig } from "./engine/sport";

const NFL = loadSportConfig(nflConfig);
const CONTEST = new ContestConfig({ fieldSize: 1000, payouts: [] }); // Mid tier -> FieldTier.MID -> ownFor averages small/large

function player(id: string, pos: string, salary: number, proj: number, ownSmall = 0.1, ownLarge = 0.3): Player {
  return new Player({ id, name: id, positions: [pos], team: "AAA", opp: "BBB", salary, proj, ownSmall, ownLarge });
}

// Task "piece pools": PAWN is now two bands (RB/TE/WR under $5,000, and
// DST at any salary) -- pieceBandLabel joins every band for a piece, not
// just the first one found, so the label never silently omits half of
// what the pick list actually offers.
describe("pieceBandLabel", () => {
  it("King has no salary bound shown -- just the position", () => {
    expect(pieceBandLabel(Piece.KING, NFL)).toBe("QB");
  });

  it("Queen still reads as having no position restriction (excludes QB, not an allow-list)", () => {
    expect(pieceBandLabel(Piece.QUEEN, NFL)).toBe("$7,000+");
  });

  it("Rook/Bishop/Knight have no ceiling -- just a floor (Knight's own is lower)", () => {
    expect(pieceBandLabel(Piece.ROOK, NFL)).toBe("RB · $5,000+");
    expect(pieceBandLabel(Piece.BISHOP, NFL)).toBe("WR · $5,000+");
    expect(pieceBandLabel(Piece.KNIGHT, NFL)).toBe("TE · $4,500+");
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

describe("eligiblePlayers", () => {
  const wr1 = player("wr1", "WR", 6000, 18.0); // BISHOP band (WR, 5000-7000)
  const wr2 = player("wr2", "WR", 5500, 12.0); // BISHOP band
  const te1 = player("te1", "TE", 5000, 9.0); // KNIGHT band (TE >= 4500, no ceiling)
  const cheapWr = player("wr3", "WR", 4000, 6.0); // below BISHOP's floor -> PAWN catch-all

  it("filters to the moved piece's band only", () => {
    const pool = [wr1, wr2, te1, cheapWr];
    expect(eligiblePlayers(Piece.BISHOP, new Set(), pool, NFL)).toEqual([wr1, wr2]); // sorted by proj desc
    expect(eligiblePlayers(Piece.KNIGHT, new Set(), pool, NFL)).toEqual([te1]);
    expect(eligiblePlayers(Piece.PAWN, new Set(), pool, NFL)).toEqual([cheapWr]);
  });

  it("sorts by projection, descending", () => {
    const result = eligiblePlayers(Piece.BISHOP, new Set(), [wr2, wr1], NFL);
    expect(result.map((p) => p.id)).toEqual(["wr1", "wr2"]); // wr1's 18.0 > wr2's 12.0
  });

  it("a player locked by either side never appears again", () => {
    const pool = [wr1, wr2, te1];
    const lockedByBlack = new Set([wr1.id]); // simulates Black already having taken wr1
    const result = eligiblePlayers(Piece.BISHOP, lockedByBlack, pool, NFL);
    expect(result.some((p) => p.id === wr1.id)).toBe(false);
    expect(result.map((p) => p.id)).toEqual([wr2.id]);
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
