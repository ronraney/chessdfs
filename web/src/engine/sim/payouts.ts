// Synthetic payout curve generation -- round 2. Pins all three of a
// contest's real summary numbers at once: rank 1 pays EXACTLY
// pctToFirst * prizePool, every paid place (cash_line of them) pays AT
// LEAST minCash (a flat floor tier at the bottom of the ladder, same
// shape real DK/FD payout tables actually have -- a decaying curve on top,
// a flat min-cash block underneath), and the whole table still sums to
// EXACTLY prizePool. This is a genuinely different curve family from
// either of this file's two earlier versions (the two-anchor curve that
// pinned min_cash's shape and left rank 1 approximate; the Pct_To_First-
// only curve that pinned rank 1 exactly but let the bottom drift away
// from min_cash with no floor at all) -- neither nfl-dfs tier does this
// three-way pin, so this is chess-dfs's own construction, not a port.
//
// Shape: payout(place) = max(rank1 * place^-k, minCash), place = 1..spots,
// rank1 = prizePool * pctToFirst (fixed, not solved -- place^-k is 1 at
// place=1 regardless of k, so rank 1 is trivially exact for ANY k). Only
// k is solved, for the single remaining constraint: the table sums to
// prizePool. max() of a strictly-decreasing power-law term and a constant
// floor is itself non-increasing by construction (decays until it meets
// the floor, flat after) -- "payouts never increase down the ladder"
// holds automatically, not asserted separately.
//
// f(k) = sum_{p=1}^{spots} max(rank1*p^-k, minCash) is monotonically
// non-increasing in k: every term starts at rank1 (k=0 makes p^-k == 1 for
// every p) and can only shrink (toward its own floor) as k grows, so the
// sum can only shrink too. That gives two closed-form bounds reachable in
// the limit:
//   f(0)        = rank1 * spots                        (every place flat at rank1)
//   f(infinity) = rank1 + minCash * (spots - 1)         (every place but rank1 floored)
// A valid curve needs prizePool to fall inside [f(inf), f(0)] -- outside
// that range, no k (no matter how the floor/power-law trade off) can hit
// prizePool while also honoring the two exact pins and the floor. Three
// distinct ways this can fail, each reported with which constraint broke
// rather than papered over:
//   - minCash >= rank1: no decaying curve can meet a floor at or above
//     its own starting point.
//   - prizePool < f(infinity): not enough money to pay every place at
//     least minCash on top of rank 1's own cut.
//   - prizePool > f(0): pctToFirst's rank-1 cut is smaller than an equal
//     split of prizePool across cash_line places -- rank 1 wouldn't
//     actually be the biggest payout.
// Otherwise k is solved by bracket-then-bisect (same technique nfl-dfs's
// own solveGppExponentForPctToFirst_ uses, mirrored for a DEcreasing f).
//
// Unlike nfl-dfs's sheet-oriented curve (rounded to cents for human
// display, range-compressed for storage), these rows are consumed
// programmatically by run.ts's trial loop: no cent rounding (rows sum to
// prizePool to floating-point precision) and no range compression
// (chess-dfs's PayoutTier is a flat {rank, amount} pair, one row per
// cashing rank -- though in practice the floor tier IS one constant value
// repeated across a contiguous block of ranks, same as a real curve's own
// flat min-cash block).

export interface PayoutRow {
  readonly rank: number;
  readonly amount: number;
}

// Bracket-then-bisect for a DEcreasing f(k): start at k=0 (f at its max),
// double kHigh until f(kHigh) <= target (brackets the root from above),
// then bisect. Mirrors nfl-dfs's solveGppExponentForPctToFirst_ (which
// bisects an INcreasing share(k) instead) with the comparison flipped.
function solveFloorCurveExponent(spots: number, rank1: number, minCash: number, prizePool: number): number {
  const sumForK = (k: number): number => {
    let sum = 0;
    for (let place = 1; place <= spots; place++) sum += Math.max(rank1 * Math.pow(place, -k), minCash);
    return sum;
  };

  let kLow = 0;
  let kHigh = 1;
  while (sumForK(kHigh) > prizePool && kHigh < 1e6) kHigh *= 2;

  let k = kHigh;
  for (let iter = 0; iter < 100; iter++) {
    k = (kLow + kHigh) / 2;
    if (sumForK(k) > prizePool) kLow = k;
    else kHigh = k;
  }
  return k;
}

export function generatePayoutCurve(prizePool: number, pctToFirst: number, minCash: number, cashSpots: number): PayoutRow[] {
  if (!(prizePool > 0)) {
    throw new Error(`generatePayoutCurve: prizePool must be positive (got ${prizePool})`);
  }
  if (!(pctToFirst > 0 && pctToFirst <= 1)) {
    throw new Error(`generatePayoutCurve: pctToFirst must be in (0, 1] (got ${pctToFirst})`);
  }
  if (!(minCash > 0)) {
    throw new Error(`generatePayoutCurve: minCash must be positive (got ${minCash})`);
  }

  const spots = Math.max(1, Math.round(cashSpots));
  if (spots === 1) {
    return [{ rank: 1, amount: prizePool }]; // winner-take-all -- exact regardless of pctToFirst/minCash
  }

  const rank1 = prizePool * pctToFirst;

  // Flat-payout contests (e.g. Double-Up, 50/50): rank 1's own pinned
  // amount already equals minCash, so there's no room for ANY decaying
  // curve between them -- every cashing place just pays minCash flat,
  // same shape a real Double-Up/50/50 payout table actually has (one
  // constant amount across the whole cash line, no ladder at all).
  // $0.01 tolerance absorbs the same kind of rounding a real contest
  // export's own numbers can carry.
  if (Math.abs(rank1 - minCash) <= 0.01) {
    return Array.from({ length: spots }, (_, i) => ({ rank: i + 1, amount: minCash }));
  }

  if (minCash >= rank1) {
    throw new Error(
      `generatePayoutCurve: minCash ($${minCash}) is not less than rank 1's payout ($${rank1}) -- can't build a ` +
        `curve that decays from rank 1 down to a floor at or above rank 1 itself. Inconsistent contest data.`,
    );
  }

  const floorSum = rank1 + minCash * (spots - 1); // f(k) as k -> infinity
  const flatSum = rank1 * spots; // f(0)
  if (prizePool < floorSum) {
    throw new Error(
      `generatePayoutCurve: prizePool ($${prizePool}) is less than rank 1's cut plus minCash for every other ` +
        `cash spot ($${floorSum}) -- can't pay all ${spots} cash_line places at least minCash while also paying ` +
        `rank 1 exactly pctToFirst * prizePool. Inconsistent contest data.`,
    );
  }
  if (prizePool > flatSum) {
    throw new Error(
      `generatePayoutCurve: prizePool ($${prizePool}) exceeds what a FLAT payout of rank 1's own amount across ` +
        `all ${spots} cash_line places would distribute ($${flatSum}) -- pctToFirst is too small relative to ` +
        `prizePool/cash_line for rank 1 to be the biggest payout. Inconsistent contest data.`,
    );
  }

  const k = solveFloorCurveExponent(spots, rank1, minCash, prizePool);
  const rows: PayoutRow[] = [];
  for (let place = 1; place <= spots; place++) {
    rows.push({ rank: place, amount: Math.max(rank1 * Math.pow(place, -k), minCash) });
  }
  return rows;
}
