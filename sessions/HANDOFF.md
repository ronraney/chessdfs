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

Python 3.11+ engine (`dfs_chess/`, **frozen** — TS-only from here on,
per the most recent rule change) + `web/` (Vite + React + TypeScript,
Node v24/npm). The TS port of the chess/DFS engine and the Monte Carlo
sim (`web/src/engine/sim/`) are both complete and wired into the UI.

**Sim engine (`draws.ts`) is now a Gaussian copula on measured real-world
correlations**, not a latent-factor model. Each player is ranked into a
role (QB1, RB1/RB2, WR1/WR2/WR3, TE1/TE2, DST) by DK projection within
team+position; everyone else is "other" (0 correlation with all).
`config/real_correlation_targets.json` holds the measured 9x9 same-team
and opponent correlation matrices (nflverse, 2021-2025, season-to-date
role ranking); per game, the two teams' filled roles are assembled into
one matrix and Cholesky-drawn. No more zGame/zTeam/regime shocks, no
DST-splash side channel. Vegas total/spread and dome **no longer affect
the draw at all** — removed as double-counting (ETR's own floor/proj/
ceiling already bake both in). The Vegas upload still works end-to-end
in Admin (`vegasCsv.ts`/`vegasStore.ts`); it's just inert now.
`drawOutcome` was also fixed so a player's simulated **mean** (not
median) lands on DK Proj (`internalAnchorForTargetMean`, a closed-form
per-player anchor solve) — previously the mean ran 1-2pts high because
real ceiling-proj gaps usually exceed proj-floor gaps. `TAIL_K` lowered
1.0→0.5 (the old value put P95/P99 25-45% above a player's own ceiling).

**`field.ts` (lineup generation, the MILP that builds "the field") was
NOT touched by any of this** — it still has no awareness of the new
real-correlation model, just its own older ownership-bias/noise
objective. This is a real, flagged, open gap: a diagnosis run found both
the projection-optimal lineup and a hand-picked GB-stack benchmark
ranking at the **100th percentile of 200 random field lineups** even
after the correlation fixes above — the field likely isn't competitive/
representative enough yet. Not started.

**Rook's own pool was reworked** (pieces.ts/picklist.ts): any RB/WR/TE,
any salary — the old "QB's team only" filter is gone from `classify()`
entirely (team no longer affects eligibility for ANY piece). The pick
list instead sorts by a 4-tier stack rule (1: QB's team, 2: QB's
opponent, 3: a team already in the lineup, 4: everyone else), then DK
Ceiling within a tier. Castling's own Rook step
is explicitly unchanged (team-restricted, proj-sorted) via a new
dedicated `castleRookList`, kept deliberately separate from the general
`pickList` since the two have now genuinely diverged. This is a TS-only
divergence from the frozen Python engine; one parity fixture
(`pick_list_rook_requires_qb_team`) is now filtered out in
`parity.test.ts`, same precedent as Bishop's own earlier TS-only rework.

**Admin has a contest upload** (from an earlier session, unchanged this
session): `contestStore.ts` + `engine/contestsCsv.ts` + an Admin
"Contests" section (upload/summary/Clear), falling back to
`config/contests.json` when nothing's uploaded. `Pct_To_First > 1` is
read as a dollar amount and converted to a fraction automatically.

**Environment**: accessed from Windows via `\\wsl.localhost\Ubuntu\...`.
Plain `npm`/`npx`/`git`/`python` through the Windows-side Bash tool
fails on this UNC path — every such command needs
`wsl.exe -d Ubuntu -- bash -lc "cd ~/chess-dfs/... && ..."`. No real
browser is launchable here (missing `libasound.so.2`, no passwordless
sudo) — Sim 4's UI and the real Worker path have still never been
exercised end-to-end in an actual browser.

**Tests**: 237 pytest, 559 npm, both green as of this session's last
commit (`bcfdc5b`). A couple of BuildScreen/SetupScreen tests (castling,
deviation-banner, "White can move again after castling") are **known
flaky under full-suite parallel load only** — confirmed again this
session, same pre-existing pattern from prior sessions; they pass
reliably alone. Not fixed.

## What happened this session

Four rule-change tasks (all committed and pushed), plus three
diagnosis/report/status asks with no code changes:

1. **Real NFL correlation targets, season-to-date role ranking**
   (`ddfa1ad`) — extended the nflverse measurement script to RB2/WR3/TE2
   (9 roles total) and to the FULL 9x9 same-team + opponent matrix (81
   pairs), replacing the earlier per-week-ranked version (a lookahead/
   circularity bug: ranking a role by the very week being correlated
   inflates same-team real_r). Every real_r changed; biggest moves in
   same-team pairs (QB-WR1 0.45→0.37, WR1-WR2 0.19→0.03).

2. **Rebuild draws on real correlation targets** (`31d6c8e`) — the
   Gaussian-copula rewrite described above. Validation (20,000 trials,
   Main Slate 6): 67 of 81 measured pairs land within ±0.05 of real_r;
   every failure is a weak real target and/or involves TE2 (expected
   copula-through-nonlinear-marginal signature, not a bug). Benchmark
   GB-stack lineup: Sim ROI 1,447%→323% (Cash% 34.8%→33.5%, Top1%
   10.0%→3.3%, win rate 2.27%→0.48%) — the old same-team correlations
   (e.g. 0.76) were far stronger than real ones (0.37), so a mega-stack's
   edge shrinks a lot once it's calibrated to real data.

3. **Sim diagnosis round 2** (no code changes) — found two real bugs
   later fixed in task 4: (a) dome's old mean-shift fired regardless of
   "no Vegas" (59.5% of this slate's players sit in a dome game, so this
   wasn't a corner case); (b) `drawOutcome`'s median-pinned-to-proj
   design left the mean biased ~1-2pts high even with zero shift, purely
   from curve asymmetry. All 10 "off by 3+" players were dome-game
   players. Also ran a 200-lineup field vs. optimal-by-proj vs. the GB
   benchmark ROI comparison (see field.ts gap above).

4. **Sim: remove double counting, fix player curves** (`a5c7af1`) — the
   actual fixes for (a)/(b) above. Re-ran the diagnosis: below-floor/
   above-ceiling now 14.9-15.1% every position (was 13.0/17.3); 0 players
   off by more than 3 points (was 10); P95/P99-vs-ceiling roughly halved
   at the same 5 sample players.

5. **Benchmark check** (no code changes) — before/after comparison under
   diagnosis-round-2 settings (field sampled to 5,000): benchmark ROI
   393.7%→281.2% (Cash 34.1%→30.5%, Top1% 3.66%→2.97%, win 0.60%→0.44%).
   Median ROI by stack bucket (QB+3-or-more vs. QB+0/1/2) showed no real
   difference (−24.3% vs. −24.6%) — stacking affects tail/ceiling, not
   the typical outcome, which is expected in a GPP.

6. **Rook: stack builder** (`bcfdc5b`) — the pieces.ts/picklist.ts rework
   described above.

7. **Status check** (no code changes) — a plain description of current
   castling/captures/Black-move-source behavior; nothing changed.

Every commit: ran `npm run test` (full suite) and `pytest` before
committing, per CLAUDE.md; flaky BuildScreen failures were re-run in
isolation each time to confirm they weren't real regressions.

## Open items / blockers

- **`field.ts` doesn't know about the new real-correlation model** (see
  above) — the single highest-value open item. Its own ownership-bias/
  noise objective is unchanged since well before this session; a
  diagnosis found both the optimal-by-proj and a hand-built stack
  ranking at the 100th percentile of a 200-lineup field sample, which
  suggests the field itself may be under-competitive. Not started.
- **Full-suite test flakiness under parallel load** (see Tests above) —
  pre-existing across many sessions, not fixed.
- Field still short of its own 5,000-distinct-lineup target per tier
  (measured a few sessions back at ~2,500-3,000); stack-size realized
  rates still don't exactly match `STACK_SIZE_DISTRIBUTION`'s configured
  weights (same "leakage toward smaller stacks" already documented in
  `field.ts`'s own comments).
- `sport.ts`'s `teamRestricted` field and `config/sports/nfl.json`'s
  `team_restricted: true` are now unread by any code (Rook's own
  restriction moved to an explicit team check) — left in place as data
  since removing a schema field was a bigger change than that task
  asked for.
- No real-browser verification yet (`libasound.so.2`, no passwordless
  sudo) — Sim 4's UI/Worker path still hasn't been exercised end-to-end
  in an actual browser.
- `data/samples/DraftKings NFL DFS Projections -- Main Slate (6).csv`,
  `.../NFL Weekly DFS System - Sim_Contest.csv`, and
  `.../NFL Weekly DFS System - Projections.csv` stay uncommitted,
  deliberately, same standing precedent as `repro-slate.csv`.
- `sessions/1026/10272026-admin-contest-upload-and-pct-to-first-dollars.md`
  is still untracked (never `git add`ed by whichever earlier session
  wrote it) — worth adding next time something else in that area is
  committed, not urgent on its own.

## Next steps

1. Decide whether `field.ts`'s own lineup-generation objective should be
   updated to use the real-correlation model too (currently fully
   disconnected from `draws.ts`), given the 100th-percentile finding
   above — this is the natural next rule-change task.
2. If Vegas/dome should come back, they need a genuinely different
   mechanism than "shift the z-mean" (that's what caused the double-
   count this session fixed) — not scoped, just flagged for whenever it
   comes up.
3. Still worth a real-browser verification pass once `libasound.so.2` is
   installed.
