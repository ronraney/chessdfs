# Handoff — 2026-10-27

## Where things stand

DFS Chess is an NFL DraftKings lineup builder that layers chess opening
strategy onto lineup construction. The user plays White; "the field"
(Black) plays too, by simulation. The goal is a *core* (typically 4–5
players), not necessarily a full lineup. `CLAUDE.md` (never edited by
Claude; Ron edits it himself) says the task **prompt** is the spec —
implement it exactly as written; existing code/tests are the record of
all earlier rules. Git workflow: work on `main`, one commit per task
after tests pass, push to `origin/main` after every commit, never use
`AskUserQuestion` (ask inline as plain text).

Python 3.11+ engine (`dfs_chess/`) + `web/` (Vite + React + TypeScript,
Node v24/npm). The TS port of the chess/DFS engine is complete and kept
in parity with Python via a standing test harness. The Monte Carlo sim
port (`web/src/engine/sim/`: `draws.ts`, `field.ts`, `payouts.ts`,
`run.ts`) is also complete and wired into the UI (Sim 4) — this was the
main subject of this session's five tasks. `web/.env` with
`VITE_ADMIN_PASSWORD` exists but its value has never been read/printed,
per CLAUDE.md's secrets rule.

**Environment**: accessed from Windows via `\\wsl.localhost\Ubuntu\...`.
Plain `npm`/`npx`/`git` through the Windows-side Bash tool fails on this
UNC path — every such command needs `wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."`.
No real browser is launchable here (missing `libasound.so.2`, no
passwordless sudo) — the whole Sim 4 UI and `simWorker.ts`/`fieldWorker.ts`'s
real Worker path have still never been exercised end-to-end in an actual
browser. `python3`/`pip` has internet access confirmed this session
(reached GitHub/nflverse-data without issue).

**Tests**: 237 pytest, 523 npm, both green as of this session's last commit.

## What happened this session

Five tasks, four commits (all pushed):

1. **Sim ROI sanity check + finish-screen fixes** (`094e2a2`) — added
   `engine/sim/run.fieldRoiSanity.test.ts` (sims every lineup in a field
   against that same field; average ROI vs. the plain rake identity).
   Found no bug in payout units/place-scaling/entry-fee/tie-splitting —
   the identity holds within a few points once sampled without a
   self-counting artifact the test's own header explains. Finish screen
   now shows "Chosen:"/"Final position:" instead of one unlabeled
   "Opening" row (`BuildScreen.tsx`/`FinishCard`), since those two can
   differ once a build deviates off its chosen book line. Investigated
   "Fill out my core"'s disable-when-complete behavior and found it
   already correct (shared `canFillCore` check is mechanism-agnostic) —
   no code change needed there.

2. **Fuller simulated fields** (`741c957`) — `generateSimulatedField`
   (`field.ts`) now takes an optional `targetDistinct` and stops early
   once that many distinct 9-player combos are found, otherwise running
   up to an attempt cap (same ownership-bias/exposure-cap math, now
   anchored to the cap instead of a flat 1,000). Admin's "Build fields"
   uses a 10,000-attempt cap toward a 5,000-distinct target
   (`buildFieldCache.ts`) and shows distinct-so-far/target progress per
   tier, plus the final shortfall if the cap is hit first. Measured on
   the real sample slate: 1,000 attempts only ever found ~600-640
   distinct lineups per tier; the new cap roughly quadruples that
   (~2,400-3,000) but still falls short of 5,000 — distinct count grows
   logarithmically in attempts on real data, and 5,000 would need well
   over 100,000 attempts per tier (~20+ min).

3. **Sim diagnosis, no code changes** — got the real current slate
   (`data/samples/DraftKings NFL DFS Projections -- Main Slate (6).csv`,
   the one Ron's example lineup's 141.7 proj actually matches) and ran a
   full diagnosis: field stack profile (found the field essentially never
   builds a 3+ stack, and *never* built anything matching the example
   lineup's 5-player GB mega-stack), correlation measurement (confirmed
   `draws.ts` is a byte-faithful port of nfl-dfs's own `sim_draws.js` —
   same weights, same regime constants — but nfl-dfs's own documented
   `calibrateCorrelation()` targets are badly missed for RB↔DST same-team
   correlation: realized 4.9%/16.7% vs. targets 26%/63%), and a
   winning-trials breakdown (84.2% of the example lineup's wins had GB as
   the slate's top-scoring team — confirming its edge is almost entirely
   "GB has a huge game").

4. **Field stack-size mix** (`bb6ff9d`) — replaced the old binary
   "naked vs. at-least-2" coin flip with a per-attempt weighted draw from
   `STACK_SIZE_DISTRIBUTION` (naked 15%, QB+1 30%, QB+2 35%, QB+3-or-more
   20%); the MILP now pins the drawn size exactly for 1/2, at-least for
   the 3+ bucket. On the real slate this took the field from zero 4+
   -player same-team stacks to 177 of 9,402 (1.88%), and dropped the
   example lineup's Sim ROI from 796.0% to 725.4% (Cash 32.9%, Top1%
   9.88%, win rate 2.27%) — real movement, though the field's still short
   of its own 5,000-distinct target so some inflation remains.

5. **Real NFL correlation targets, measurement only** (`5fe31d2`) —
   pulled nflverse-data (player_stats + stats_team + schedules releases,
   2021-2025 regular seasons), computed DK Classic fantasy points from raw
   counting stats, and measured real Pearson r for 14 same-team/opponent
   pairs against the sim's own realized r on the real slate. Saved to
   `config/real_correlation_targets.json`. Biggest finding: the sim's
   shared `zTeam` factor makes every same-team skill player move
   together, but real players mostly *compete* for volume — WR1-WR2,
   RB1-WR1, WR1-TE1, and QB-RB1 are near-zero in real data (0.01-0.08) but
   0.56-0.72 in the sim, the single largest miscalibration found across
   both diagnosis passes this session.

6. **Contest upload: what happened, report only** — confirmed via git
   history and session logs that Admin has **never** had a contest
   upload (CSV or form); `config/contests.json` was hand-transcribed once
   from `data/samples/NFL Weekly DFS System - Sim_Contest.csv` during Task
   32 and has been a static, build-time-bundled constant ever since (no
   localStorage override, unlike projections/Vegas). Reported the exact
   field shape each contest needs and what restoring an upload would take
   (new `contestStore.ts` + validator + Admin UI, same pattern as
   projections/Vegas — but `PRESETS` would need to stop being a static
   module-level constant, a bigger structural change than the other two
   uploads needed since they were already designed to be read dynamically).

## Open items / blockers

- **Field is still short of its own 5,000-distinct target** on every
  tier (measured ~2,400-3,000 at the new 10,000-attempt cap) — reaching
  5,000 would need a much bigger attempt cap (100,000+) and a multi-minute
  wait per tier. Not fixed this session; `BUILD_ATTEMPT_CAP`/
  `TARGET_DISTINCT_LINEUPS` (`buildFieldCache.ts`) are both flagged as
  judgment calls, not spec'd.
- **Stack-size realized rates don't exactly match their targets** — naked
  undershoots (9.7% vs. 15%), QB+1 overshoots (36.2% vs. 30%) — because a
  "naked-drawn" attempt's fallback solve can coincidentally land with 1-2
  same-team catchers anyway (nothing forces zero). Not a bug, just how
  outcome-based bucketing works; flagged, not touched.
- **RB↔DST same-team correlation is badly miscalibrated** against
  nfl-dfs's own documented 2021-2025 validation targets (missed by
  21-46pp) — confirmed pre-existing in nfl-dfs's own original code too,
  not introduced by the TS port. No fix attempted (diagnosis-only task).
- **The newly-measured real-world correlation gaps** (`config/
  real_correlation_targets.json`) are not yet consumed by anything — the
  file exists purely as a reference/diagnostic artifact. Recalibrating
  `draws.ts`'s `LATENT_WEIGHTS` against it is a real, well-sourced,
  not-yet-started follow-up.
- **Contest upload doesn't exist** — item 6 above is a report Ron can act
  on if he wants it built; nothing implemented.
- **Real-browser verification is still blocked** (no passwordless sudo
  to install `libasound.so.2`) — the entire Sim 4 UI, both Workers, and
  Stockfish's real failure path have still never been seen running in an
  actual browser.
- `data/samples/DraftKings NFL DFS Projections -- Main Slate (6).csv` and
  `.../NFL Weekly DFS System - Sim_Contest.csv` stay uncommitted,
  deliberately, same standing precedent as `repro-slate.csv` — Ron's call.
- Prior-session carried-forward items (JAX vs. JAC, `tools/sim_builds.py`'s
  stale 2-arg `classify` call, no "Back" navigation, `DEFAULT_EXCLUDED_FAMILIES`
  double-duty, etc.) are unchanged — see `sessions/1026/` for the fuller
  history if any of those come up.

## Next steps

1. Decide whether `BUILD_ATTEMPT_CAP`/`TARGET_DISTINCT_LINEUPS` should be
   raised further (accepting a longer Admin wait) now that real timing
   numbers exist, or whether ~2,500-3,000 distinct is an acceptable
   permanent ceiling.
2. If the stack-size/field-thinness combination still produces
   unrealistic ROI for mega-stack lineups after this session's fix,
   consider whether `STACK_SIZE_DISTRIBUTION`'s own weights need
   retuning, or whether thinness is still the dominant factor.
3. A real recalibration pass on `draws.ts`'s `LATENT_WEIGHTS` against
   `config/real_correlation_targets.json`, starting with the worst gaps
   (WR1-WR2, RB1-WR1, WR1-TE1, QB-RB1 — all need the model to capture
   target competition within an offense, which nothing today does).
4. If Ron wants a contest upload built, start from this session's report
   (item 6) — the `contestStore.ts`/validator/Admin-UI shape is scoped;
   the `PRESETS`-staticness refactor is the real design decision to make
   first.
5. Still worth a `/run-skill-generator` pass once `libasound.so.2` is
   installed, so real-browser verification doesn't need re-discovering.
