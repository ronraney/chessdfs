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
  it("a valid two-contest upload parses cleanly", () => {
    const presets = validateContestCsv(csv(TWO_CONTEST_ROWS));
    expect(presets.map((p) => p.name)).toEqual(["Small GPP", "H2H"]);
    expect(presets[0].buyIn).toBe(5);
    expect(presets[0].contest.fieldSize).toBe(100);
    expect(presets[1].buyIn).toBe(1);
    expect(presets[1].contest.fieldSize).toBe(2);
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

  // The real Sim_Contest sample: all 18 GPP rows plus H2H build a real
  // curve cleanly; "NFL GIANT $25 Double-Up" has Pct_To_First=50 (a plain
  // dollar figure in this cash-game row, not a (0,1] fraction) -- a
  // genuine data quirk in the real file, not a contrived test case -- so
  // its own payout curve can't be built and the WHOLE upload is rejected,
  // naming it.
  describe("the real Sim_Contest.csv sample", () => {
    it("rejects the full file over the Double-Up row's own unbuildable curve", () => {
      expect(() => validateContestCsv(SAMPLE_CONTEST_CSV)).toThrow(/Payout curve rejected contest\(s\): NFL GIANT \$25 Double-Up\./);
    });

    it("the same file minus that one row uploads cleanly as 19 contests", () => {
      const presets = validateContestCsv(VALID_CONTEST_CSV);
      expect(presets.length).toBe(19);
      expect(presets.some((p) => p.name === "H2H")).toBe(true);
      expect(presets.some((p) => p.name.includes("Double-Up"))).toBe(false);
    });
  });
});
