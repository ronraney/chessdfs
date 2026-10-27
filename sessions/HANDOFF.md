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
Node v24/npm). The TS port of the chess/DFS engine and the Monte Carlo
sim (`web/src/engine/sim/`) are both complete and wired into the UI.

**Admin now has a contest upload** (this session, new) — previously
`config/contests.json` was the only source, a static build-time
constant. Now: `web/src/contestStore.ts` (localStorage, mirrors
projections/Vegas exactly) + `web/src/engine/contestsCsv.ts`
(`validateContestCsv`) + an Admin "Contests" section (upload/summary/
Clear). An upload replaces the whole contest list; nothing uploaded (or
after Clear, or if the saved CSV no longer validates) falls back to
`contests.json`. Validation: required columns present, numbers parse,
no duplicate names; any row whose payout curve can't be built is named
and the whole upload fails. `Pct_To_First > 1` is read as the 1st-place
dollar amount and converted to a fraction (÷ `Total_Prize_Pool`) rather
than rejected — flagged in the summary ("Pct_To_First read as dollars:
..."). The real, untrimmed `Sim_Contest.csv` sample now loads cleanly as
20 contests (previously only 19 would validate — "NFL GIANT $25
Double-Up"'s `Pct_To_First=50` used to fail outright).

`payouts.ts`'s `generatePayoutCurve` gained a flat-table case: when
rank 1's pinned payout (`prizePool * pctToFirst`) is within $0.01 of
`minCash`, every cash spot just pays `minCash` flat (Double-Up/50/50
shape) instead of erroring out trying to decay from a point it's
already sitting on.

`PRESETS` (`appData.ts`) is no longer a frozen import-time snapshot —
it's a live, refreshable export (`refreshPresets()`, reassigns the
module binding, which every importer sees immediately). Falls back to
`contests.json` in the same situations the admin-screen summary does.
`App.tsx` refreshes it on the way back from `#/admin`. "Start again"
matches the previously-chosen contest by **name** (not object identity
— every refresh builds fresh objects) against the current `PRESETS`;
no match falls back to the first contest with a notice on SetupScreen.

**Environment**: accessed from Windows via `\\wsl.localhost\Ubuntu\...`.
Plain `npm`/`npx`/`git`/`python` through the Windows-side Bash tool
fails on this UNC path (wrong `cd`, missing native bindings, "Python not
found") — every such command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."`. No real browser is
launchable here — Sim 4 UI and the real Worker path have still never
been exercised end-to-end in an actual browser.

**Tests**: 237 pytest, 542 npm, both green as of this session's last
commit (`7ef4983`). Two or three BuildScreen/SetupScreen tests
(castling, deviation-banner, admin-routing) are **known flaky under
full-suite 32-worker parallel load only** — they pass reliably alone or
under lighter load, and which exact test flakes varies run to run
(confirmed pre-existing, not introduced this session: the same pattern
reproduced on a full run taken *before* any of this session's changes
existed). Not fixed; several already carry an explicit per-test timeout
bump as a partial mitigation.

## What happened this session

Two tasks, two commits (both pushed):

1. **Admin contest upload** (`4fcc3b1`) — built the upload Ron's prior
   session had only scoped (see previous HANDOFF's item 6): new
   `contestStore.ts`, new `engine/contestsCsv.ts`
   (`validateContestCsv`), new Admin "Contests" section, `PRESETS` made
   dynamic/refreshable, "Start again" fallback-by-name + notice when a
   saved build's contest no longer exists. Clarified with Ron mid-task
   that cash games should NOT be skipped (reversing the original spec's
   "skip Double-Up/50/50" wording, which didn't actually match the real
   CSV's `Contest_Type` values) — rows just get payout-curve-validated
   like everything else, with H2H's existing flat-table special case
   (payouts.ts) covering what cash-game skipping would have.

2. **Contest upload: Pct_To_First as dollars or fraction** (`7ef4983`)
   — the real sample's own "NFL GIANT $25 Double-Up" row has
   `Pct_To_First=50`, a dollar figure, not a (0,1] fraction. Now: > 1 is
   divided by that row's own `Total_Prize_Pool` and flagged in the
   upload summary; (0, 1] is left as-is. Full untrimmed file now loads
   all 20 rows; Double-Up's converted value happens to land exactly on
   its own `Min_Cash_Amount`, so it builds as a flat table.

Both commits: ran `npm run test` (full suite, multiple times to confirm
flaky-vs-regression) and `pytest` before committing, per CLAUDE.md.

## Open items / blockers

- **Vegas no longer affects the sim** (new, this session's "remove
  double counting" task): Admin's Vegas upload (`vegasCsv.ts`/
  `vegasStore.ts`) is still fully wired — upload, validate, save, show in
  Admin — but `draws.ts`'s `drawSlateOutcomes` no longer reads Vegas
  total/spread or dome status at all (both removed; ETR's own floor/
  proj/ceiling already bake in Vegas/dome, so applying them again as a
  separate z-mean shift was double-counting). `drawSlateOutcomes` kept
  its `games: SlateVegas` parameter (for API stability) but it's unused;
  the `domeTeams` parameter was dropped entirely. If Vegas/dome should
  ever come back, it'd need a genuinely different mechanism than "shift
  the z-mean" — that's what caused the double-count.
- **Full-suite test flakiness under max parallel load** (see Tests
  above) — pre-existing, not introduced this session, not fixed. Worth
  a dedicated look if it starts blocking commits reliably rather than
  intermittently.
- This section's older items (STALE as of this session — `draws.ts` was
  since fully rewritten as a Gaussian copula on measured real-world
  correlation targets, replacing the `LATENT_WEIGHTS` model these
  referred to; see `sessions/1026/` for that history) are not re-listed
  here. Still carried forward, genuinely unresolved: field still short of
  its own 5,000-distinct target; stack-size realized rates don't exactly
  match configured weights; real-browser verification still blocked (no
  passwordless sudo for `libasound.so.2`).
- `data/samples/DraftKings NFL DFS Projections -- Main Slate (6).csv`
  and `.../NFL Weekly DFS System - Sim_Contest.csv` stay uncommitted,
  deliberately, same standing precedent as `repro-slate.csv`.
- Prior-session carried-forward items (JAX vs. JAC, `tools/sim_builds.py`'s
  stale 2-arg `classify` call, no "Back" navigation, `DEFAULT_EXCLUDED_FAMILIES`
  double-duty, etc.) are unchanged — see `sessions/1026/` for the fuller
  history if any of those come up.

## Next steps

1. No contest-upload work is queued — it's functionally complete
   (upload/validate/fallback/dollars-conversion all in place and
   tested). Next contest-related ask, if any, would be a new prompt.
2. The real-NFL-correlation recalibration pass on `draws.ts`'s
   `LATENT_WEIGHTS` (flagged last session, still not started) is the
   highest-value open item: WR1-WR2, RB1-WR1, WR1-TE1, QB-RB1 are all
   near-zero in real data but 0.56-0.72 in the sim.
3. Decide whether `BUILD_ATTEMPT_CAP`/`TARGET_DISTINCT_LINEUPS`
   (`buildFieldCache.ts`) should be raised further, or whether
   ~2,500-3,000 distinct per tier is an acceptable permanent ceiling.
4. Still worth a real-browser verification pass once `libasound.so.2`
   is installed, so Sim 4's UI/Worker path doesn't need re-discovering.
