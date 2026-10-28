# Session: Sim correlation rewrite, double-counting fix, Rook stack builder

Seven task prompts this session (continuing the same day as the prior
"sim field fixes/correlation/contest report" session). Four landed as
commits (all pushed); three were diagnosis/report/status-only, per their
own explicit instructions.

## Task 1 — Real NFL correlation targets, season-to-date role ranking (`ddfa1ad`)

Extended last session's nflverse-measurement pipeline to RB2 (2nd RB by
season-to-date carries), WR3 (3rd WR by targets), TE2 (2nd TE by
targets), then computed the FULL 9x9 same-team and opponent correlation
matrices (81 unique pairs) in one shot via a wide per-team-week
dataframe (`.corr()` on 18 columns: the team's own 9 roles + the
opponent's same 9, self-merged). Re-downloaded player_stats.csv +
stats_team_week_{2021..2025}.csv + games.csv from nflverse-data (same
throwaway venv pattern as before, not added to requirements.txt).

Checked the resulting 18x18 block matrix for positive-semidefiniteness
directly (needed for the NEXT task's Cholesky draw) rather than assuming
it: min eigenvalue 0.3109, already PSD, confirmed via an independent
nearest-PSD correction check (eigenvalue-clip-and-reconstruct) landing
within ~8e-16 of the raw matrix (floating-point noise).

Saved to `config/real_correlation_targets.json` with a new shape: `roles`
array (role order = matrix row/column order), `same_team_matrix`,
`opponent_matrix`, `role_qualifying_team_weeks`, `pair_n` per pair, and
`full_matrix_psd_check`. 237 pytest / 552 npm (+10: draws.test.ts
rewritten net).

## Task 2 — Rebuild draws on real correlation targets (`31d6c8e`)

Full rewrite of `draws.ts`'s correlation engine, explicitly diverging
from nfl-dfs (the old latent zGame/zTeam/g-t-loading model + shootout/
script regime shocks + DST-splash side channel, all removed):

1. **Roles**: each player ranked by DK proj within team+position into
   QB1/RB1/RB2/WR1/WR2/WR3/TE1/TE2/DST; everyone else is "other" (0
   correlation with all, including other "other" players).
2. **Per game**: the two teams' own filled roles assembled into one
   joint correlation matrix (same-team block from `same_team_matrix`,
   cross-team block from `opponent_matrix`) — always a principal
   submatrix of the full 18x18 template, so correcting the template ONCE
   at module load (already PSD, confirmed above) is sufficient; no
   per-game correction can ever actually be needed. Implemented a
   hand-rolled Cholesky (`tryCholesky`) and Jacobi eigendecomposition
   (`nearestPSD`) — no new dependency — exercised directly by unit tests
   against hand-built matrices even though real data never triggers the
   correction path.
3. **Each trial**: Cholesky-draw correlated standard normals per game,
   `normCDF` to percentile, `drawOutcome` (unchanged) maps onto floor/
   proj/ceiling.
4. **Vegas/dome/spread**: kept as mean shifts (not variance) this round
   — same constants (VEGAS_WEIGHT 0.5, SPREAD_WEIGHT 0.3, dome 0.15,
   repurposed from the old DOME_WGAME_SCALE) but now applied directly/
   undiluted since the old per-position g/t loadings that used to dilute
   them are gone — flagged as a real, stronger-at-the-same-constant
   effect. (This turned out to be wrong/premature — see Task 4.)

Validation (20,000 trials, Main Slate 6, pooled across the slate's 20
teams/10 games): 67 of 81 pairs within ±0.05 of real_r. Every failure is
a weak real target (|real_r| < 0.1) and/or involves TE2 — diagnosed as
the expected signature of a Gaussian copula pushed through drawOutcome's
own NONLINEAR piecewise marginal (Pearson r isn't preserved under a
nonlinear transform of correlated normals), not a bug — reported as-is
rather than silently NORTA-calibrated away, since the task specified a
direct Cholesky-then-percentile draw.

Benchmark (Cover Four $4 5-max mid, 5,945 entries, the 9-player GB-stack
lineup — Love/McCaffrey/Jacobs/Watson/Golden/Tate/LaPorta/Kraft/
Dolphins, seed 2026, 20,000 trials, full unsampled field): Sim ROI
1,447.3%→322.8%, Cash% 34.8%→33.5%, Top1% 10.0%→3.3%, win rate
2.27%→0.48% — the old same-team correlations (QB-WR1 0.76) were far
stronger than the real ones (0.37) now driving the draw.

237 pytest / 552 npm, both green.

## Task 3 — Sim diagnosis round 2 (no code changes)

Four parts, all measured at 20,000 trials on Main Slate 6 / Cover Four,
"no Vegas unless stated":

1. **Player curves**: for every player with proj≥5, share of draws
   below DK Floor / above DK Ceiling should be ~15%/15% by construction
   (u=normCDF(z) is exactly Uniform(0,1) once nothing shifts z's mean —
   true for both role players, via a Cholesky row's own unit self-
   correlation, and "other" players). Measured instead: ~13%/~17% across
   EVERY position uniformly. Root cause, confirmed directly by isolating
   a known non-dome player (Tate, clean ~15/15, but still +1.31 mean-vs-
   proj) against a known dome-game player (Watson, 11.6%/19.7%, +3.69):
   dome's old mean shift fired unconditionally off `sport.domeTeams`,
   NOT gated by "no Vegas" at all — and 59.5% of this slate's 279
   players sit in a dome game this week. All 10 "off by 3+" players were
   dome-game players. A SECOND, smaller, universal bias was also found:
   even the non-dome control wasn't exactly 0, because drawOutcome's
   piecewise curve pins its MEDIAN (not mean) to proj, and real ceiling-
   proj gaps routinely exceed proj-floor gaps.
2. **Tail size**: right-tail formula is linear in u past P85, asymptotic
   cap `ceiling + (ceiling-median)*k` as u→1 (never literally unbounded).
   At k=1 (the then-current default), P95 was already 25-35% above a
   player's own ceiling across 5 sample players (one per position);
   P99 35-47% above.
3. **ROI landscape**: simmed 200 random field lineups + the projection-
   optimal lineup (built via a throwaway direct `yalps` MILP call, same
   roster shape as field.ts's own solveOneLineup since that function
   isn't exported) + the GB benchmark, against the Mid field sampled
   down to 5,000 (matching run.ts's own MAX_FIELD_SAMPLE production
   path). 200-lineup ROI: P10 −60.1%, P50 −27.2%, P90 +37.8%, P99
   +134.4%, max +141.0%. Optimal-by-proj: +125.1% (99th percentile).
   Benchmark: +393.7% (100th percentile, above all 200) — flagged as
   likely NOT fully explained by genuine correlation, since field.ts's
   own lineup-generation objective has no awareness of the real-
   correlation model at all.
4. **Vegas**: BLOCKED — `data/samples/NFL Weekly DFS System - Vegas
   7.csv` does not exist anywhere in the repo (checked directly, not
   guessed). Reported as a blocker; parts 1-3 completed regardless.

Recommended (not implemented): gate or re-measure dome's real effect
size; fix drawOutcome's mean-vs-median asymmetry; consider whether field
generation itself needs updating for the real-correlation model.

## Task 4 — Sim: remove double counting, fix player curves (`a5c7af1`)

The actual fixes for Task 3's two findings:

1. Removed Vegas total/spread AND dome mean shifts from `draws.ts`
   entirely (not just dome) — ETR's own floor/proj/ceiling already bake
   both in; re-applying them was double-counting. `drawSlateOutcomes`
   dropped its `domeTeams` parameter outright (its only consumer gone);
   kept `games: SlateVegas` (renamed `_games`, TS's own
   `noUnusedParameters` lint requires the underscore once a parameter
   before the last USED one is still unused — not exempted by position
   alone, contrary to an initial assumption) since Admin's Vegas upload
   still produces one and run.ts still threads it through — just inert
   now. Noted in HANDOFF.md per the task's own instruction.
2. Fixed `drawOutcome`: derived a closed-form `internalAnchorForTargetMean`
   (floor/mean/ceiling/posMin/k are all that's needed — the function is
   exactly affine in its own anchor at any fixed u, and u is exactly
   Uniform(0,1), so the expected value integrates out to a closed form
   with no iteration needed) that solves for the INTERNAL curve anchor
   making the curve's own MEAN equal the target (DK Proj), while leaving
   P15=floor/P85=ceiling untouched (neither depends on the anchor).
   `TAIL_K` lowered 1.0→0.5 (own judgment call, not given an exact
   target) for a more realistic tail.

Incidental fixes found while confirming a clean `tsc -b` (which `npm run
test` alone never runs, since vitest transpiles without type-checking):
a pre-existing `(1|0)[][]` type-inference bug in `jacobiEigen` (from
Task 2, never caught) and two fully-dead helpers (`sameTeamCorr`/
`opponentCorr`, superseded by `templateCorr`'s own direct indexing,
also from Task 2).

Re-ran diagnosis round 2 parts 1+3: below-floor/above-ceiling now
14.94-15.05% every position; avg|mean-proj| down to 0.04-0.05; 0 players
off by more than 3 points. Tail vs. ceiling at the same 5 sample players
roughly halved. ROI landscape's relative standing unchanged (benchmark
and optimal-by-proj both still 100th percentile of 200) — expected,
field.ts untouched.

237 pytest / 554 npm, both green.

## Task 5 — Benchmark check (no code changes)

Same settings as diagnosis round 2 (field sampled to 5,000). Extracted
the PRE-fix `draws.ts` via `git show 31d6c8e:...` into a throwaway
sibling file (never touching the real committed file) to get a true
apples-to-apples before/after under IDENTICAL field-sampling methodology
(the earlier Task 2 benchmark had used the full unsampled field, so its
322.8% isn't directly comparable to this task's own numbers — flagged
the discrepancy explicitly rather than let it look inconsistent).

Benchmark: ROI 393.7%→281.2% (Cash 34.1%→30.5%, Top1% 3.66%→2.97%, win
0.60%→0.44%) — figures cross-validated exactly against both Task 2's
and Task 4's own prior runs. Optimal-by-proj (after only): ROI 143.8%,
Cash 43.8%, Top1% 2.23%, win 0.195% — high floor, low ceiling, opposite
shape from the benchmark. Top 10 of 200 by ROI: a mix of QB+1/+2/+3
stacks (same exact lineup appeared twice — expected, the field is a
multiset where repeat count IS exposure, not a bug). Median ROI by stack
bucket: QB+3-or-more −24.3% (n=39) vs. QB+0/1/2 −24.6% (n=161) —
essentially no difference, a real/expected finding (stacking raises
variance/ceiling, not the typical GPP outcome, which is negative
regardless of build type).

No code changes; all scratch files (including the git-extracted pre-fix
snapshot) deleted after use.

## Task 6 — Rook: stack builder (`bcfdc5b`)

Dropped Rook's own-QB's-team eligibility filter entirely:
`classify()` (pieces.ts) no longer takes a `qbTeam` argument at all, for
ANY piece. New 4-tier stack sort in `pickList` (picklist.ts): 1) same
team as the QB, 2) the QB's opponent (derived from `currentPlayers` —
whichever locked QB matches `qbTeam`, read its own `.opp`), 3) same team
as any other player already in the lineup, 4) everyone else — highest
matching tier only, tiers 1-2 skipped (not defaulted to 4) when no QB is
locked yet. Within a tier, sorts by DK Ceiling, not proj.

Castling's own Rook step is explicitly UNCHANGED per the task — but it
shares `pickList` with the general case in the old code, so a straight
removal would have broken it too. Added a dedicated `castleRookList`
(picklist.ts) that reproduces the exact old behavior (team-restricted,
proj-sorted) independently; `rules.ts`'s `castle()` now enforces the
team match as an explicit check (`rook.team !== qbTeam`) rather than
through `classify`, which carries no team concept at all now.
`build.ts`/`BuildScreen.tsx`'s two castling call sites switched to
`castleRookList`; every direct-move/capture call site
(`isLegalMove`/`isLegalCapture`/`applyCaptureMove`) just dropped the
`qbTeam` argument from its `classify` call.

TS-only per the task (Python frozen) — `parity.test.ts`'s own
`pick_list_rook_requires_qb_team` fixture scenario (Python's real,
unchanged "exclude the other team" expectation) is now a deliberate
divergence, filtered out the same way `pick_list_caps_bishop_at_12`
already was for Bishop's own earlier TS-only rework.

Updated tests: pieces.test.ts (removed 3 now-obsolete team-restriction
tests), picklist.test.ts (full new stack-tier coverage: all 4 tiers,
ceiling-sort-within-tier, tier-skip with no QB, "highest tier only,"
cap-at-12, plus a new `castleRookList` describe block proving castling's
path is untouched), rules.test.ts (direct Rook move tests flipped from
"requires a teammate" to "accepts any team, even with a QB locked").

`sport.ts`'s `teamRestricted` field / config's `team_restricted: true`
are now unread by anything — left in place as data (flagged in pieces.ts
's own header), since removing a schema field is a bigger change than
this task asked for.

237 pytest (untouched) / 559 npm, both green.

## Task 7 — Status check (no code changes)

Plain 3-5-line descriptions of current castling, captures, and Black's
Stockfish-vs-book move source behavior, for a status check. Nothing
changed; answered directly from the engine code read across this
session plus a quick direct read of `blackEngine.ts` to confirm the
50cp/MultiPV-5/250ms specifics precisely rather than from memory alone.

## State at session end

- 237 pytest, 559 npm, both green as of the last commit.
- 4 commits this session, all pushed to `origin/main`: `ddfa1ad`,
  `31d6c8e`, `a5c7af1`, `bcfdc5b`.
- A couple of BuildScreen tests flake under full-suite parallel load
  only (same pre-existing pattern as every prior session this cycle,
  reconfirmed, not fixed) — always passed clean when re-run alone.
- Working tree clean except the same pre-existing untracked clutter
  flagged every session this cycle (Zone.Identifier files, `repro-
  slate.csv`, `design/*`, the real sample CSVs — Ron's call to leave
  uncommitted) plus one untracked session-log file from an earlier
  session that was never `git add`ed.
- See HANDOFF.md for the carried-forward open items/next-steps list,
  rewritten fresh this session (the field.ts/real-correlation gap is now
  the single highest-value item).
