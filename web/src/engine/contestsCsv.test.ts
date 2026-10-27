import { describe, expect, it } from "vitest";
import { SAMPLE_CONTEST_CSV, VALID_CONTEST_CSV } from "../testFixtures";
import { ContestValidationError, validateContestCsv } from "./contestsCsv";

const HEADER = "Contest_Name,Entry_Fee,Total_Entrants,Total_Prize_Pool,Pct_To_First,Min_Cash_Amount,Cash_Line_Position,Max_Entries_Per_User,Contest_Type";

function row(
  name: string,
  entryFee: number,
  totalEntrants: number,
  totalPrizePool: number,
  pctToFirst: number,
  minCashAmount: number,
  cashLinePosition: number,
  maxEntriesPerUser: number,
  contestType: string,
): string {
  return `${name},${entryFee},${totalEntrants},${totalPrizePool},${pctToFirst},${minCashAmount},${cashLinePosition},${maxEntriesPerUser},${contestType}`;
}

function csv(rows: readonly string[]): string {
  return [HEADER, ...rows].join("\n");
}

const TWO_CONTEST_ROWS = [
  row("Small GPP", 5, 100, 1000, 0.2, 10, 20, 3, "gpp"),
  row("H2H", 1, 2, 1.8, 1, 1.8, 1, 1, "cash"),
];

describe("validateContestCsv", () => {
  it("a valid two-contest upload parses cleanly, with nothing converted", () => {
    const { presets, dollarPctToFirstNames } = validateContestCsv(csv(TWO_CONTEST_ROWS));
    expect(presets.map((p) => p.name)).toEqual(["Small GPP", "H2H"]);
    expect(presets[0].buyIn).toBe(5);
    expect(presets[0].contest.fieldSize).toBe(100);
    expect(presets[1].buyIn).toBe(1);
    expect(presets[1].contest.fieldSize).toBe(2);
    expect(dollarPctToFirstNames).toEqual([]);
  });

  // Pct_To_First > 1 can't be a (0,1] fraction -- it's read as the
  // 1st-place dollar amount instead and converted by dividing by this
  // row's own Total_Prize_Pool, flagged by name in dollarPctToFirstNames.
  describe("Pct_To_First as dollars", () => {
    it("converts a dollar Pct_To_First to a fraction and flags the row", () => {
      // rank1 should come out to prizePool * (200/1000) = 200 exactly.
      const rows = [row("Dollar Pct", 5, 100, 1000, 200, 10, 20, 3, "gpp")];
      const { presets, dollarPctToFirstNames } = validateContestCsv(csv(rows));
      expect(dollarPctToFirstNames).toEqual(["Dollar Pct"]);
      expect(presets[0].contest.payouts[0].amount).toBeCloseTo(200, 6);
    });

    it("a value in (0, 1] is left as a fraction, not converted", () => {
      const { dollarPctToFirstNames } = validateContestCsv(csv(TWO_CONTEST_ROWS));
      expect(dollarPctToFirstNames).toEqual([]);
    });

    it("exactly 1 is still a valid fraction (winner-take-all), not treated as dollars", () => {
      const rows = [row("WTA", 5, 100, 1000, 1, 1000, 1, 3, "gpp")];
      const { presets, dollarPctToFirstNames } = validateContestCsv(csv(rows));
      expect(dollarPctToFirstNames).toEqual([]);
      expect(presets[0].contest.payouts).toEqual([{ rank: 1, amount: 1000 }]);
    });
  });

  it("rejects a file missing required columns, naming them", () => {
    const badCsv = ["Contest_Name,Entry_Fee", "Foo,5"].join("\n");
    expect(() => validateContestCsv(badCsv)).toThrow(ContestValidationError);
    expect(() => validateContestCsv(badCsv)).toThrow(
      /Missing required column\(s\): Total_Entrants, Total_Prize_Pool, Pct_To_First, Min_Cash_Amount, Cash_Line_Position, Max_Entries_Per_User, Contest_Type\./,
    );
  });

  it("rejects a non-numeric Total_Prize_Pool value, naming the contest", () => {
    const rows = [row("Small GPP", 5, 100, "N/A" as unknown as number, 0.2, 10, 20, 3, "gpp")];
    expect(() => validateContestCsv(csv(rows))).toThrow(/Non-numeric Total_Prize_Pool value for contest\(s\): Small GPP/);
  });

  it("rejects duplicate contest names", () => {
    const rows = [...TWO_CONTEST_ROWS, row("H2H", 1, 2, 1.8, 1, 1.8, 1, 1, "cash")];
    expect(() => validateContestCsv(csv(rows))).toThrow(/Duplicate contest name\(s\): H2H/);
  });

  // minCash (150) is at/above rank1 (1000*0.1=100), so no decaying curve
  // (and no flat-table case either, since they're not within $0.01) can
  // satisfy this row -- generatePayoutCurve's own rejection, surfaced by
  // name rather than that function's own message text.
  it("rejects a row whose payout curve can't be built, naming the contest, and the whole upload fails", () => {
    const rows = [...TWO_CONTEST_ROWS, row("Broken Contest", 10, 500, 1000, 0.1, 150, 50, 1, "gpp")];
    expect(() => validateContestCsv(csv(rows))).toThrow(ContestValidationError);
    expect(() => validateContestCsv(csv(rows))).toThrow(/Payout curve rejected contest\(s\): Broken Contest\./);
  });

  // The real Sim_Contest sample: all 18 GPP rows plus H2H already build a
  // real curve cleanly; "NFL GIANT $25 Double-Up" has Pct_To_First=50 (a
  // plain dollar figure in this cash-game row, not a (0,1] fraction) --
  // a genuine data quirk in the real file, not a contrived test case --
  // read as dollars and converted (50 / 75000 = rank1 exactly equal to
  // its own minCash of 50), which lands it in the flat-table case
  // (payouts.ts) rather than the decaying curve every GPP row uses.
  describe("the real Sim_Contest.csv sample", () => {
    it("all 20 rows load, with Double-Up flagged as dollars and built as a flat table", () => {
      const { presets, dollarPctToFirstNames } = validateContestCsv(SAMPLE_CONTEST_CSV);
      expect(presets.length).toBe(20);
      expect(dollarPctToFirstNames).toEqual(["NFL GIANT $25 Double-Up"]);

      const doubleUp = presets.find((p) => p.name === "NFL GIANT $25 Double-Up")!;
      expect(doubleUp.contest.payouts.length).toBe(1500);
      expect(doubleUp.contest.payouts.every((row) => row.amount === 50)).toBe(true);
    });

    it("the same file minus that one row uploads cleanly as 19 contests, with nothing converted", () => {
      const { presets, dollarPctToFirstNames } = validateContestCsv(VALID_CONTEST_CSV);
      expect(presets.length).toBe(19);
      expect(presets.some((p) => p.name === "H2H")).toBe(true);
      expect(presets.some((p) => p.name.includes("Double-Up"))).toBe(false);
      expect(dollarPctToFirstNames).toEqual([]);
    });
  });
});
