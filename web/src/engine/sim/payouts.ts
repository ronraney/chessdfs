// Synthetic payout curve generation. Ported from rraney/nfl-dfs's
// generateSyntheticPayoutCurve_ (sim_trial_loop.js) -- specifically its
// "two-anchor" GPP branch (both Pct_To_First AND Cash_Line_Position/
// Min_Cash_Amount valid real anchors). chess-dfs's own contests.json
// always supplies all four anchors (prize_pool, pct_to_first, min_cash,
// cash_line) for every real contest, so the generic-default/single-anchor/
// rake-derived-prize-pool tiers nfl-dfs falls back to when real data is
// incomplete are not ported -- there is no input shape here that would
// ever reach them. See config.ts's loadContestPresets, the only caller.
//
// Power-law decay: payout(place) = prizePool * place^-k / sum_{p=1}^{cashSpots} p^-k,
// where k is solved in closed form so the RATIO between place 1's and the
// cash line's raw (pre-normalization) weights matches the ratio between
// their real dollar anchors:
//   k = ln(place1Target / minCash) / ln(cashSpots)
// The curve is then normalized so the rows sum to prizePool -- nfl-dfs's
// own documented tradeoff: place 1 and the cash line land CLOSE to, not
// exactly on, pctToFirst*prizePool / minCash once normalized (an earlier
// nfl-dfs version pinned place 1 exactly and left the total unnormalized;
// confirmed live to overpay real contests by 1.6x-9.1x). Aggregate
// correctness (every dollar paid is a dollar in the pool) wins over
// exactly hitting both anchors -- same priority nfl-dfs's own code
// comment states. cashSpots === 1 is the one exact case (and needs no
// normalization): a single cash spot collapses to winner-take-all
// regardless of k, same degenerate case nfl-dfs's own comment notes (this
// is also how chess-dfs's H2H -- 2 entries, cash_line 1 -- resolves).
//
// Unlike nfl-dfs's sheet-oriented curve (rounded to cents for human
// display, and range-compressed for storage), these rows are consumed
// programmatically by run.ts's trial loop, not displayed: no cent
// rounding (rows sum to prizePool to floating-point precision, not
// "close, reported as a diff" the way nfl-dfs's own cent-rounded curve
// is) and no range compression (chess-dfs's PayoutTier is a flat
// {rank, amount} pair with no range concept -- one row per cashing rank).

export interface PayoutRow {
  readonly rank: number;
  readonly amount: number;
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
    return [{ rank: 1, amount: prizePool }];
  }

  const place1Target = prizePool * pctToFirst;
  if (place1Target <= minCash) {
    throw new Error(
      `generatePayoutCurve: place-1 target ($${place1Target}, prizePool x pctToFirst) is <= minCash ` +
        `($${minCash}) -- inconsistent contest data. nfl-dfs's own generateSyntheticPayoutCurve_ falls back ` +
        `to a generic-default curve shape in this situation; this port has no such fallback, since chess-dfs's ` +
        `contests always supply all four real anchors. Fix the contest's prize_pool/pct_to_first/min_cash/cash_line.`,
    );
  }

  const k = Math.log(place1Target / minCash) / Math.log(spots);
  const rawWeights: number[] = [];
  let sumWeights = 0;
  for (let place = 1; place <= spots; place++) {
    const w = Math.pow(place, -k);
    rawWeights.push(w);
    sumWeights += w;
  }

  return rawWeights.map((w, i) => ({ rank: i + 1, amount: (prizePool * w) / sumWeights }));
}
