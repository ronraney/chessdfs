# Session: Sim ROI/field fixes, correlation diagnosis, contest-upload report

Six task prompts this session. Four landed as commits (all pushed); two
were report-only (no code changes), per their own explicit instructions.

## Task 1 — Sim ROI sanity check + finish-screen fixes (`094e2a2`)

Three parts:

1. **Sanity test**: added `engine/sim/run.fieldRoiSanity.test.ts` — sims
   every lineup in a cached field against that same field; average ROI
   must land within a few points of `(prizePool - entries*buyIn) /
   (entries*buyIn)`. Spent most of this task's effort on diagnostics
   (throwaway test files, always cleaned up before committing) chasing
   down why naive attempts at this check showed tens-of-points of drift:
   turned out to be a real, explainable, small artifact —
   `computeEffectivePlaceAndPayout` always reserves one extra rank slot
   for "the user" on top of whatever it finds tied in the field, correct
   for the real caller (an external lineup never present in the field)
   but double-counting when a field MEMBER is turned into "the user" for
   this specific test methodology. Drift shrinks as ~1/lineupWeight —
   negligible for any real contest. Confirmed via same-seed-across-
   lineups testing (isolates structural bugs from Monte Carlo noise
   entirely — trials=5 and trials=50 gave identical results to 10 decimal
   places). No bug found in payout units/place-scaling/entry-fee/ties.
2. **Finish screen labels**: banner always showed the originally-chosen
   book line's name; finish screen showed the live/final matched opening
   with no label distinguishing the two — looked contradictory
   ("Zukertort Opening" vs. "King's Indian Attack" for the same build).
   Now two labeled rows, "Chosen:" / "Final position:"
   (`BuildScreen.tsx`'s `FinishCard`). Copy-lineup clipboard text
   unchanged.
3. **"Fill out my core" disable check**: investigated, found `canFillCore`
   already correctly disables the button once `isLineupComplete
   (whiteRoster, NFL)` — shared identically by the mid-build button and
   every finish-screen variant, mechanism-agnostic (final-state check, not
   "how did it get complete"). Couldn't find or construct a failing
   scenario. No code change.

## Task 2 — Fuller simulated fields (`741c957`)

The reported symptom: cached fields built from a flat 1,000 attempts only
ever found ~600-640 DISTINCT lineups per tier on the real sample slate
(not the "24-400" figure the task's own prompt cited — that number
actually came from MY OWN earlier synthetic 58-player toy-pool
diagnostics in a prior session, not a measurement of the real slate;
flagged this correction explicitly).

Reworked `generateSimulatedField` (`field.ts`): `sampleSize` is now read
as an attempt CAP, not a guaranteed attempt count. New optional
`targetDistinct` param — the loop tracks a `Set` of sorted-player-id keys
and stops early once that many distinct combos are found. Ownership-bias/
exposure-cap math is UNCHANGED, just now anchored to the (bigger) cap
instead of a flat 1,000, per the task's own "keep ownership targeting and
exposure caps as they are." `onProgress` callback extended with trailing
`distinct`/`targetDistinct` args (backward compatible — TS's callback-
arity variance means existing 2-arg callbacks still typecheck and behave
identically when `targetDistinct` is omitted).

`buildFieldCache.ts`: new `BUILD_ATTEMPT_CAP = 10000` and
`TARGET_DISTINCT_LINEUPS = 5000` (both exported, both flagged as judgment
calls — "sensible," not spec'd). `AdminScreen.tsx`: progress now shows
"distinct lineups so far / target" with a progress bar keyed on distinct
count; final per-tier status line reports the shortfall if the target
wasn't reached, e.g. "Mid: 8996 lineups cached (2671 distinct, short of
the 5000 target by 2329)".

Measured growth curve (Mid tier, real slate): 1,000 attempts → 624
distinct, 3,000 → 1,270, 6,000 → 2,043, 10,000 → 2,671 — clearly
logarithmic, not linear. A rough log-fit puts 5,000 distinct at 135,000+
attempts (~20+ min/tier at measured speed) — explains why even the new
10x-bigger cap still falls short. Before/after per tier (real slate, 1000
→ 10000-attempt cap): Small 600→2384, Mid 624→2671, Large 641→2983 — all
roughly 4x, none reaching 5,000.

Added 3 new field.test.ts tests (targetDistinct stops early, omitting it
preserves old behavior exactly, onProgress reports distinct/target
correctly) and updated 2 AdminScreen.test.tsx string assertions for the
new status-line format. 237 pytest / 523 npm (520+3) all green.

## Task 3 — Sim diagnosis, no code changes (diagnosis only)

Needed the REAL current slate first — the task named
`data/samples/DraftKings NFL DFS Projections -- Main Slate 6.csv`, which
didn't exist (close-but-different filename: `...Main Slate (6).csv`, with
parens). Confirmed it was the right one once found: the example lineup
(Love/McCaffrey/Jacobs/Watson/Golden/Tate/LaPorta/Kraft/Dolphins) totals
EXACTLY 141.7 proj / $49,800 salary on it, matching the number from an
earlier task precisely — the PRIOR session's attempt to re-run this same
example lineup had been blocked because the old static sample CSV didn't
even contain "Josh Jacobs" as a player; this is evidently the real,
current slate Ron's actually been building against.

Four sub-reports:
1. Rebuilt Mid field (current settings, pre-stack-size-fix): 9,381
   accepted / 3,047 distinct. Example lineup, 20,000 trials: Sim ROI
   796.0%, Cash% 32.8%, Top1% 10.23%, win rate 2.53% — down substantially
   from an earlier-reported 3,641% (confirming the fuller-fields work is
   real) but still very elevated.
2. Field stack profile: QB+0 12.6%, QB+1 13.6%, QB+2 64.8% (!), QB+3+
   8.9%. **Zero** of 9,381 field lineups had Love + 3-or-more other
   Packers (the example lineup's own shape, a 5-player GB stack) — the
   field structurally never builds anything that big because the old
   `stackTeam >= 2` constraint gives the MILP no reason to ever go beyond
   the minimum. This became the direct motivation for Task 4.
3. Correlation: confirmed `draws.ts` is a line-for-line, constant-for-
   constant faithful port of nfl-dfs's real production file
   (`sim_draws.js`, confirmed via `sim_trial_loop.js` that THIS — not the
   separate experimental `sim_correlation.js` three-shock model — is what
   nfl-dfs actually runs). Measured realized Pearson r for 5 pairs
   (0.812/0.707/0.763/0.824/0.440 for QB-WR1/QB-RB1/QB-TE1/WR1-WR2/
   QB-oppWR1) against a naive weight-implied Z-space baseline — realized
   ran consistently ~0.14-0.21 higher, explained by the shootout/script
   regime shocks adding shared variance the naive baseline didn't
   include (not a bug). Then ran nfl-dfs's OWN documented
   `calibrateCorrelation()` methodology (found in
   `/home/raney/nfl-dfs/sim_draws.js` — a sibling working directory,
   the actual original Google-Apps-Script project) against chess-dfs's
   port: 4 of 6 checks landed within nfl-dfs's own ±8pp tolerance
   (opp-WR/opp-RB/opp-DST/no-pass-catcher given QB ceiling), but the two
   RB↔DST same-team checks missed badly — realized 4.9%/16.7% vs.
   targets 26%/63% (off by 21pp and 46pp). This is nfl-dfs's own
   headline validated mechanism (DST's negative g-loading, specifically
   designed to reproduce this exact asymmetry) failing on its own terms,
   confirmed NOT a porting bug since every constant/formula matches the
   source file exactly — looks like calibration that was never actually
   finished (the source file's own comment still says "starting
   values... rerun until all pass").
4. Of 505 trials (of 20,000) where the example lineup finished 1st, GB
   was the slate's own top-scoring team in 425 (84.2%) — confirms the
   lineup's edge is almost entirely "did Green Bay have a huge game."

Recommended two fixes (not implemented, per the task): (a) let the field
build bigger stacks (became Task 4), (b) a separate RB-DST recalibration
pass (not started).

## Task 4 — Field stack-size mix (`bb6ff9d`)

Replaced `field.ts`'s binary "naked (17.5%) vs. at-least-2 (82.5%)" coin
flip with `STACK_SIZE_DISTRIBUTION`: naked 15%, QB+1 30%, QB+2 35%,
QB+3-or-more 20%, drawn per attempt via a new `drawStackSize` helper.
`solveOneLineup` now takes a `stackSize` param — the MILP constraint is
`{equal: stackSize}` for 1/2, `{min: stackSize}` for the 3+ bucket
(left open-ended on purpose). `stackEligibleTeams`'s structural pre-
filter loosened `>=2` → `>=1` catchers (so size-1 stacks have
candidates); the real gating (`catchersInPool >= drawnSize`) happens per-
attempt as before, just parameterized. Bring-back logic untouched, per
the task's own instruction.

Rewrote field.test.ts's old binary stack-rate test into a per-bucket
rate check against `STACK_SIZE_DISTRIBUTION`'s own weights (generous
asymmetric tolerance bands — leakage only ever pushes realized rates
toward naked, never past 100%). Widened the pre-existing "top-owned
player's exposure" test's tolerance 1.2x → 1.3x (same precedent already
in that test's own comment from an earlier stack-targeting change) —
bigger stacks are now reachable more often, nudging a high-owned
player's realized exposure up slightly further.

Rebuilt Mid on the real slate: QB+0 9.7%, QB+1 36.2%, QB+2 33.7%, QB+3+
20.4% (naked undershoots/QB+1 overshoots their targets — a drawn-naked
attempt's fallback solve can coincidentally land with 1-2 same-team
catchers anyway since nothing forces zero; not a bug). Love+3-or-more
Packers: 0 → 177 of 9,402 (1.88%). Example lineup: Sim ROI 796.0% →
725.4%, Cash% 32.8%→32.9%, Top1% 10.23%→9.88%, win rate 2.53%→2.27%.
Real movement, modest in size — the field's still short of its own
5,000-distinct target, so thinness is still doing most of the remaining
work. 237 pytest / 523 npm (net unchanged — 1 test replaced 1-for-1).

## Task 5 — Real NFL correlation targets, measurement only (`5fe31d2`)

A NEW task arrived mid-turn while Task 4 was in progress (handled by
finishing Task 4 first, then starting this one, per the harness's own
"address it as you continue this turn" framing — not abandoning in-
progress work).

Confirmed nflverse-data (github.com/nflverse/nflverse-data) was reachable
via plain `curl` from this WSL environment before committing to the full
pipeline, per the task's own "if unreachable, stop and say so." Set up a
throwaway Python venv at `/tmp/nflverse_corr` (pandas/numpy, NOT added to
chess-dfs's own `requirements.txt` — a one-off analysis script, not a
project dependency), downloaded `player_stats.csv` (33MB, all positions/
seasons) and `stats_team_week_{2021..2025}.csv` + `games.csv` (for
opponent's score → points-allowed tiers) from nflverse's GitHub release
assets.

Computed DK Classic (full-PPR) fantasy points from RAW counting stats
(passing/rushing/receiving yards+TDs, INTs, 2pt conversions, fumbles
lost, 300/100-yard bonuses for offense; sacks/INTs/fumble-recoveries/
defensive+ST-TDs/safeties/blocked-kicks/points-allowed-tiers for DST) —
deliberately NOT nflverse's own `fantasy_points_ppr` column, which uses a
different -2 INT / -2 fumble-lost / no-bonus formula. Roles ranked per
team per week: QB1 by attempts, RB1 by carries, WR1/WR2 by targets (top
2), TE1 by targets. Opponent pairs joined same-game rows on `game_id`.
2,174 team-weeks across 2021-2025 regular seasons.

Then re-measured the SIM's own realized r for all 14 pairs (not just the
5 from Task 3's diagnosis) on the real Main Slate 6 file, pooling all 20
teams' own role-players across 20,000 trials for a much bigger, more
robust sample (n=400,000 per pair) than the single-team numbers from
Task 3.

Saved both side-by-side in `config/real_correlation_targets.json`
(committed — not consumed by any code yet, a diagnostic/reference
artifact only). Biggest finding, bigger than Task 3's RB-DST gap: the
sim's shared `zTeam` factor makes every same-team skill player move
together, but real players mostly COMPETE for a fixed amount of volume —
WR1-WR2 (real 0.19 vs. sim 0.72), RB1-WR1 (0.01 vs. 0.64), WR1-TE1 (-0.01
vs. 0.56), QB-RB1 (0.08 vs. 0.67) are all near-zero in real data but
strongly positive in the sim. QB-to-own-pass-catcher and bring-back pairs
are directionally right in both but the sim overshoots by roughly
0.2-0.36 (same-team) to 2-4x (opponent). RB1-DST is actually close on raw
Pearson r (0.078 vs. 0.056) — a different conclusion from Task 3's
conditional-ceiling-rate check on the same pair, which showed a much
bigger gap; noted explicitly that the two metrics emphasize different
parts of the joint distribution (linear association vs. tail
co-occurrence), not a contradiction.

No sim code touched, per the task. Cleaned up the scratch venv/downloads
(`/tmp/nflverse_corr`) after extracting the final numbers.

## Task 6 — Contest upload: what happened, report only

Git history + session logs show Admin has NEVER had a contest upload —
`config/contests.json` was hand-transcribed exactly once from
`data/samples/NFL Weekly DFS System - Sim_Contest.csv` during Task 32
(commit `9a62cf3`, confirmed via `sessions/1026/10142026-tasks-31-34-...md`'s
own account: "Replaced config/contests.json entirely with the 19 real
contests from [the CSV]... CSV itself untouched"). No commit removed or
hid a contest upload because none ever existed — Task 35's "players
don't upload" was about PROJECTIONS moving to Admin, unrelated to
contests. `PRESETS` (`appData.ts`) is a static, build-time-bundled
constant read directly by `SetupScreen.tsx`/`App.tsx`/several test files
— no `contestStore.ts`, no localStorage override, unlike projections/
Vegas which were already designed to be read dynamically from day one.

Reported the exact `RawContestPreset` field shape (`entries`/`buy_in`
required; `prize_pool`/`pct_to_first`/`min_cash`/`cash_line` required
together, feeding `generatePayoutCurve` automatically; `type`/
`max_entries_per_user` typed but never read anywhere, cosmetic only) and
what restoring an upload would take: a new `contestStore.ts` + CSV
validator following the projections/Vegas pattern exactly, PLUS a bigger
structural change those two didn't need — every current `PRESETS` reader
would have to stop importing a static array and start reading a
dynamically-merged one instead. Flagged "adds or replaces" as an
undecided design question (merge-by-name vs. wholesale swap). No code
changed.

## State at session end

- 237 pytest, 523 npm, both green.
- 4 commits this session, all pushed to `origin/main`: `094e2a2`,
  `741c957`, `bb6ff9d`, `5fe31d2`.
- Working tree clean except the same pre-existing untracked clutter
  flagged every session this cycle (Zone.Identifier files, `repro-
  slate.csv`, `design/*` — Ron's call to leave uncommitted) plus the new
  `DraftKings NFL DFS Projections -- Main Slate (6).csv` and `NFL Weekly
  DFS System - Sim_Contest.csv`, both left uncommitted on the same
  standing precedent.
- See HANDOFF.md for the carried-forward open items/next-steps list.
