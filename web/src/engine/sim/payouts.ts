// Synthetic payout curve generation. Ported from rraney/nfl-dfs's
// generateSyntheticPayoutCurve_ (sim_trial_loop.js) -- specifically its
// "Pct_To_First ONLY" GPP tier (solveGppExponentForPctToFirst_): rank 1
// pays EXACTLY pctToFirst * prizePool, and the whole curve (rank 1
// included) is scaled so every rank's payout sums to EXACTLY prizePool.
//
// This supersedes this file's first version, which used nfl-dfs's OTHER
// tier -- the "two-anchor" curve (both pctToFirst AND minCash/cashSpots as
// real dollar anchors), which nfl-dfs's own doc comment admits lands rank
// 1 "close to, not exactly on" pctToFirst*prizePool once renormalized.
// Measured against all 19 real contests.json presets, that gap was large
// (47%-70% of target for every contest but one) -- reported, then this
// follow-up task asked for an exact rank-1 fit instead. minCash is no
// longer a curve-shaping input at all under this tier: cashSpots (from
// cash_line) alone still decides how many ranks pay -- "min_cash is still
// the last paid place" in the follow-up task's own wording reads as "the
// LAST PAID PLACE stays unchanged" (a rank-count/position claim), not
// "the dollar amount at that place still equals minCash" (there is no
// second real anchor left to pin a dollar value there once rank 1 is
// pinned exactly -- a 2-parameter power law has exactly 2 degrees of
// freedom, already spent on rank 1 exact + sum exact). How far the
// resulting last-rank payout drifts from the original minCash figure is
// reported per-contest, same as rank 1's fit was reported for the
// previous (two-anchor) version.
//
// Method: payout(place) = prizePool * pctToFirst * place^-k, where k is
// solved (bracket-then-bisect, nfl-dfs's own solveGppExponentForPctToFirst_
// technique) so that place 1's own NATURAL (pre-scaling) share of the
// pool, 1 / sum_{p=1}^{cashSpots} p^-k, equals pctToFirst exactly --
// scaling the whole curve by prizePool afterward therefore makes rank 1
// read prizePool*pctToFirst exactly (1^-k is 1 regardless of k) while the
// sum is exactly prizePool by construction (the scaling factor IS chosen
// to make the total come out to prizePool). share(k) is monotonically
// increasing in k (k=0 -> uniform 1/cashSpots share; k -> infinity ->
// winner-take-all, share -> 1), the textbook bracket-then-bisect
// precondition. k > 0 (a genuinely decaying, non-increasing curve) holds
// whenever pctToFirst exceeds the uniform share 1/cashSpots -- true for
// every real GPP (pctToFirst is a meaningfully top-heavy fraction); throws
// if it isn't, rather than silently returning an increasing "curve."
//
// Unlike nfl-dfs's sheet-oriented curve (rounded to cents for human
// display, and range-compressed for storage), these rows are consumed
// programmatically by run.ts's trial loop, not displayed: no cent
// rounding (rows sum to prizePool to floating-point precision) and no
// range compression (chess-dfs's PayoutTier is a flat {rank, amount} pair
// with no range concept -- one row per cashing rank).

export interface PayoutRow {
  readonly rank: number;
  readonly amount: number;
}

// nfl-dfs's own solveGppExponentForPctToFirst_, reproduced verbatim
// (bracket by doubling until share(kHigh) clears targetShare, then plain
// bisection) -- share(k) = 1 / sum_{p=1}^{cashSpots} p^-k.
function solveExponentForPctToFirst(cashSpots: number, targetShare: number): number {
  const shareForK = (k: number): number => {
    let sum = 0;
    for (let place = 1; place <= cashSpots; place++) sum += Math.pow(place, -k);
    return 1 / sum;
  };

  let kLow = 0;
  let kHigh = 1;
  while (shareForK(kHigh) < targetShare && kHigh < 1e6) kHigh *= 2;
  if (shareForK(kHigh) < targetShare) {
    throw new Error(
      `generatePayoutCurve: no exponent (even up to k=${kHigh}) makes rank 1's natural share reach pctToFirst ` +
        `(${targetShare}) over ${cashSpots} cash spots -- pctToFirst is too extreme for this cash-spot count.`,
    );
  }

  let k = kHigh;
  for (let iter = 0; iter < 100; iter++) {
    k = (kLow + kHigh) / 2;
    const share = shareForK(k);
    if (share < targetShare) kLow = k;
    else kHigh = k;
  }
  return k;
}

export function generatePayoutCurve(prizePool: number, pctToFirst: number, cashSpots: number): PayoutRow[] {
  if (!(prizePool > 0)) {
    throw new Error(`generatePayoutCurve: prizePool must be positive (got ${prizePool})`);
  }
  if (!(pctToFirst > 0 && pctToFirst <= 1)) {
    throw new Error(`generatePayoutCurve: pctToFirst must be in (0, 1] (got ${pctToFirst})`);
  }

  const spots = Math.max(1, Math.round(cashSpots));
  if (spots === 1) {
    return [{ rank: 1, amount: prizePool }]; // winner-take-all -- exact regardless of pctToFirst
  }

  const uniformShare = 1 / spots;
  if (pctToFirst <= uniformShare) {
    throw new Error(
      `generatePayoutCurve: pctToFirst (${pctToFirst}) is at or below an even split across ${spots} cash spots ` +
        `(${uniformShare}) -- no decaying (non-increasing) curve can hit that little at rank 1. Inconsistent contest data.`,
    );
  }

  const k = solveExponentForPctToFirst(spots, pctToFirst);
  const rawWeights: number[] = [];
  let sumWeights = 0;
  for (let place = 1; place <= spots; place++) {
    const w = Math.pow(place, -k);
    rawWeights.push(w);
    sumWeights += w;
  }

  return rawWeights.map((w, i) => ({ rank: i + 1, amount: (prizePool * w) / sumWeights }));
}
