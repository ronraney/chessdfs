# Session — Sim 3, Sim 4, Vegas team-name fixes, "Fill out my core"

**Date:** 2026-10-26

A long session, seven relayed prompts, each self-contained per CLAUDE.md's
"one task per prompt" rule, each its own commit.

---

## 0. Status check (read-only, no commits)

First prompt was a read-only report on everything since `e78d55b`: commit
list, which of six named features were actually done (with hashes),
`engine/sim/` file inventory, `contests.json`'s payout-table completeness,
uncommitted changes, test counts. Findings worth remembering:
- **"Fill out my core" did not exist at all** at that point — only "Stop
  with this core" did. (Built later this same session, see §6.)
- **Castling's Rook-step modal context (QB name shown, Cancel returns to
  the King step) did not exist either** — Cancel on the Rook step dropped
  the whole castling attempt, same as Cancel on the King step. Not revisited
  this session; still a gap if Ron asks for it later.
- `contests.json`: all 19 real presets had `payouts: []` — confirmed by
  direct inspection, not assumed. This became Sim 3's starting point.
- 463 npm / 237 pytest at that point.

---

## 1. Sim 3 — trial loop, scoring, payouts (`173000e`)

Built `engine/sim/run.ts` (the trial loop: draw outcomes, score user +
field, rank via weighted-place + tie-splitting, pay, aggregate) and
`engine/sim/payouts.ts` (`generatePayoutCurve`, wired into `config.ts`'s
`loadContestPresets` so the real `contests.json` presets actually get
populated payout tables instead of `[]`).

First payout-curve version ported nfl-dfs's **two-anchor** method (both
`pct_to_first` and `min_cash`/`cash_line` as real dollar anchors shape the
curve, then everything renormalizes to sum to `prize_pool` exactly).
Measured against all 19 real presets: rank-1 landed only **47%-70%** of the
`pct_to_first` target for every contest but one (Mini Gridiron, 49 cash
spots, ~98.5%) — nfl-dfs's own code comments admit this tier trades exact
anchor-fit for an exact total by design, and chess-dfs's contests run far
longer cash lines than nfl-dfs's own real examples did. Reported, not
silently accepted — this directly motivated round 2 (§2).

`DEFAULT_TRIAL_COUNT = 5000` — found by reading `config_workbooks.js`
directly: `CONFIG_DEFAULT_TRIAL_COUNT_ = 5000`, the real live default, NOT
the `1000` a different, separate quick-manual-single-lineup UI prompt in
`sim_trial_loop.js` falls back to. Worth remembering this distinction if
any future task asks about nfl-dfs's trial count again.

463 → 479 npm tests (+16).

---

## 2. Sim 3 fixes, round 1 (`53e38e2`)

Two unrelated fixes bundled into one follow-up prompt:
1. Renamed `top1Rate` → `top1PctRate`, redefined from "place 1 only" to
   "top 1% of ENTRIES" (`place <= ceil(entries * 0.01)`); added a separate
   `winRate` for the place-1-only case. `aggregateResults` gained an
   `entries` parameter.
2. Payout curve rewrite: switched to nfl-dfs's **Pct_To_First-only** tier
   (solves the exponent so rank 1's NATURAL pre-normalization share exactly
   equals `pct_to_first`, which survives normalization exactly since
   `place^-k` at `place=1` is always 1 regardless of `k`). This made rank-1
   exact (ratio 1.000000 on all 19 presets) but let the BOTTOM of the curve
   drift with no floor at all — `minCash` was dropped from the function's
   signature entirely, since it was no longer used for anything.

479 → 486 npm tests (+7, after a brief regression-and-fix: the `P90`
assertion in `aggregateResults`'s own test needed `toBeCloseTo` instead of
`toBe` — floating-point drift from the percentile interpolation, caught
immediately by the test itself, not shipped).

---

## 3. Sim 3 fixes, round 2 (`0366e38`)

Two more fixes, same prompt:
1. **Payout curve rewrite #2 — the real final version.** Round 1 traded
   `min_cash` away to get rank-1 exact; this prompt asked to pin ALL THREE
   real numbers at once: rank 1 exact, every paid place pays at least
   `min_cash` (a flat floor tier at the bottom — the SAME shape a real
   DK/FD curve actually has), total sums to `prize_pool` exactly. Solved by
   fixing `rank1 = prizePool * pctToFirst` as the scale (trivially exact
   regardless of the exponent) and solving for the ONE remaining free
   parameter (the exponent) via bracket-then-bisect so
   `sum(max(rank1 * place^-k, minCash))` hits `prizePool`. `minCash` came
   back into the signature. Infeasible inputs (e.g. `minCash >= rank1`)
   throw naming which constraint broke, rather than silently forcing a
   curve. Measured all 19 real presets again: every one feasible, BOTH
   rank-1 ratio AND min-cash ratio exactly 1.000000 this time. Floor-tier
   size ranged from 3 places (Mini Gridiron) to 38,755 (First Down) —
   genuinely load-bearing for most contests, confirmed by measurement, not
   assumed to just be a formality.
2. **Field sampling cap** — above `MAX_FIELD_SAMPLE` (5,000, exported,
   also an optional `runSimulation` param) lineups, each trial scores a
   seeded uniform sample instead of the whole field (`lineupWeight`
   recomputed against the sample size). Re-measured Large-tier (50,000
   lineups) timing at 5,000 trials: **~70s → ~10.2s**. Benchmark used a
   TEMPORARY, uncommitted vitest file each time (same house pattern as
   earlier sim sessions), deleted before the commit.

486 → 495 npm tests (+9, after one genuine flake mid-session:
`BuildScreen.secondMove.test.tsx`'s castling test hit its own hardcoded
15000ms timeout under full-suite load; passed clean in isolation and on a
clean full-suite retry — same pre-existing, previously-documented
flakiness, not a regression from this prompt's own changes).

---

## 4. Sim 4 — sim results in the UI (`2673699`)

The big one. Research phase: spawned a background `general-purpose` agent
to map BuildScreen.tsx's structure (1400+ lines), buildStats.ts/
optimizer.ts, the existing fieldWorker.ts/buildFieldCache.ts Worker
precedent, fieldCacheStore.ts/vegasStore.ts, and buildFlow.ts/App.tsx's
data flow — all BEFORE writing any code, since this was the first task
ever touching BuildScreen.tsx's UI layer for the sim feature.

Key findings from that research that shaped the design:
- `bestCompletion`/`blackBestCompletion` (the `OptimizerResult` behind
  "Pts from optimal") already return the FULL completed roster via
  `.lineup`, not just a delta — directly reusable as the sim's lineup
  input for a partial core, no new optimizer call needed.
- BuildScreen's own `rng` (seeded once at mount from `Math.random()`) is
  LIVE and continuously advancing, reserved for Black's own book/random
  play — consuming it for a sim seed would have perturbed Black's future
  moves depending on whether "Sim my core" was ever clicked. Fixed by
  splitting a separate `buildSeed` out of the SAME mount-time
  `Math.random()` call (no new entropy source, same resulting `rng`
  stream as before — confirmed this doesn't break the existing
  `vi.spyOn(Math, "random").mockReturnValue(...)` test convention, since
  it's still exactly one `Math.random()` call total).
- jsdom has no `Worker` at all — confirmed by the research, then
  confirmed AGAIN empirically: every existing BuildScreen test reaching a
  finish screen (and thus the new auto-sim-trigger effect) kept passing
  unchanged once `new Worker(...)` was wrapped in try/catch, proving the
  ReferenceError is caught cleanly rather than crashing the render.

Built `simWorker.ts` (Worker entry point, mirrors `fieldWorker.ts`'s
PlayerFields-over-postMessage pattern) + `simRunner.ts` (main-thread
orchestration: builds the request, posts it, wires a Promise, returns the
live `Worker` so the caller can `.terminate()` it). Wired into
`BuildScreen.tsx`: `SideSimState` per side (`idle`/`noField`/`running`/
`done`/`error`, each non-idle variant carrying `isBestFinish`), a
`dispatchSim` helper shared by both sides, `runSimForBothSides` (auto-
triggered via a `useEffect` keyed on `ending`, also wired to a new "Sim my
core" button). Field via `resolveCachedField`; Vegas via
`validateVegasCsv`, falling back to an empty map on ANY failure (missing
CSV, or validation failure against a changed slate) — confirmed via direct
reading of `draws.ts` that an empty/partial Vegas map degrades safely to
nfl-dfs's own neutral defaults, not an error state.

### The real-browser verification attempt — the most time spent this session

CLAUDE.md/system instructions ask for a real-browser check on UI changes.
No project run-skill exists for this app. `chromium-cli` isn't installed
anywhere in this environment (checked PATH in both the Windows-side Bash
tool and inside WSL). Fell back to the `run` skill's own documented
fallback: Playwright directly.

Found that `playwright` the npm package ISN'T resolvable via plain
`require()` anywhere on this machine (confirmed: `npm ls playwright` in
`web/` is empty, `/usr/lib/node_modules` has nothing matching, several
`~/.npm/_npx/*` cache directories exist but don't contain a usable
`node_modules/playwright` either) — yet `npx --no-install playwright
--version` DOES resolve and run successfully. Rather than keep chasing
exactly which npx cache mechanism made that work, set up a throwaway
scratch project (`npm init -y && npm install playwright` in the session
scratchpad) — confirmed fast (network IS reachable; a PINNED-version
`npx -y playwright@1.56.0 --version` resolved in well under 90s).

Playwright's own browser cache (`~/.cache/ms-playwright/`) already had
BOTH `chromium-1248` and `chromium_headless_shell-1248` downloaded from
some prior, unrelated use of this machine. Tried launching both —
BOTH fail identically:
```
error while loading shared libraries: libasound.so.2: cannot open shared object file
```
Confirmed via direct `ldd` on the regular `chrome` binary too (which,
oddly, does NOT list `libasound.so.2` as a direct dependency via `ldd` —
it's evidently a runtime `dlopen()`, not a link-time dependency, so `ldd`
alone doesn't surface it; the actual launch attempt does). No
passwordless `sudo` (`sudo -n true` fails) — can't `apt-get install
libasound2`/`libasound2t64` without Ron's WSL password.

**Conclusion, reported rather than silently worked around**: real-browser
verification is blocked on exactly one missing system package, fixable
with one `sudo apt-get install` command Ron would need to run himself (or
grant sudo access for). Everything else in the chain (Playwright, a
matching cached Chromium binary, network access, the dev server itself)
already works. Flagged in the task report and carried into HANDOFF.md's
"Where We're Headed" — this is the single most concrete, most quickly
actionable open item from the whole session.

495 → 501 npm tests (+6, all passing on the first clean run — no
regressions, no flakes this time).

### A tool-use mistake worth remembering

Early in the Sim 4 research phase, called `ScheduleWakeup` (a `/loop`-mode-
only tool) by mistake while waiting on the background research agent — it
scheduled a stray dynamic-loop wakeup outside any actual `/loop` context.
Caught immediately and cancelled via `ScheduleWakeup({stop: true})` before
it could fire. No actual harm (the background agent still completed and
notified normally), but worth remembering: background-agent waits need NO
tool call at all — the harness notifies automatically when they finish.

---

## 5. Vegas upload: full team names, then LA/LAR + skip-off-slate (`9786b82`, `ad11333`)

Two back-to-back prompts, the second one landing mid-turn while the first
was still being finished — handled by continuing straight into the
combined scope rather than treating them as fully separate turns.

**First prompt** ("accept full team names"): `validateVegasCsv` was
rejecting "Detroit Lions" because the slate's own Team column is always an
abbreviation ("DET"). Built `FULL_TEAM_NAME_TO_ABBREVIATION` (all 32 real
teams, current official names) applied to BOTH the Team and Opponent
columns before any other check runs. Cross-checked every abbreviation
against real files on disk in this repo (the sample Projections CSV,
`nfl.json`'s `dome_teams`, `repro-slate.csv`) rather than trusting memory —
this is what SURFACED the Rams' LA/LAR conflict (dome_teams says "LAR",
repro-slate.csv says "LA") and the fact that Jacksonville never appears in
any real file here at all (JAX chosen, genuinely unconfirmed).

**Second prompt**, landing mid-turn, asked for two more things in one go:
1. Resolve the LA/LAR conflict just flagged — DYNAMICALLY, not by picking
   a fixed winner: `TEAM_ALIAS_GROUPS = [["LA", "LAR"]]`, resolved against
   whichever alias the CURRENT slate actually has.
2. A full-week Vegas sheet was being rejected outright for covering teams
   not on the loaded slate. Changed off-slate rows from a hard error to a
   skip + note (`skippedTeams`, replacing `missingTeams`). The explicit
   FLIP SIDE, stated directly in the prompt: a slate team with NO Vegas
   row is now a hard error instead of the old non-fatal "neutral
   defaults" note — a deliberate behavior reversal, implemented exactly as
   asked per CLAUDE.md even though it inverts the OLD rule.

This reversal broke `AdminScreen.test.tsx`'s whole "valid upload" fixture:
the sample slate has 22 real teams, and the old fixture only covered 2
(ARI/CHI) — which is now a hard-error scenario, not a success scenario.
Rebuilt the fixture to cover all 22 real sample-slate teams for the "valid"
case, kept the old 2-team CSV separately (renamed
`PARTIAL_COVERAGE_VEGAS_CSV`) to test the NEW hard-error path instead.
Also reworked `vegasCsv.test.ts`'s own "missing team falls back to neutral
defaults" integration test — its premise (validateVegasCsv producing a
map with a gap) was no longer reachable through a successful call at all,
so it was rescoped (pass a SMALLER `slateTeams` set into `validateVegasCsv`
itself, proving its real output still needs no adapter for
`drawSlateOutcomes`) rather than dropped, per CLAUDE.md's "don't trim
coverage" rule.

Flagged consequence, not silently accepted: this function has no "is this
a real team" check independent of slate membership — a typo'd/garbage
Team value is now silently skipped the same as any other off-slate row,
not rejected like before.

Net across both Vegas commits (on top of Sim 4's own baseline): +5 npm
tests, mostly from `vegasCsv.test.ts`'s full-name/alias/skip coverage and
`AdminScreen.test.tsx`'s rebuilt fixtures. See HANDOFF.md's commit list
for per-commit hashes; this log focuses on the "why" of each change, not
re-deriving every intermediate test count.

---

## 6. "Fill out my core" button (`a293274`)

Final prompt of the session. Added the button (White only, mid-build +
every finish-screen variant) that fills open slots with
`bestCompletion.lineup` and ends the build with a new `Ending` kind,
`"filled"`.

The one real design decision: the engine's `BuildState` has NO concept of
a player locked any way other than an actual chess move (`Move.piece`/
`Move.san`), so the optimizer-filled players could not be folded into
`state.whiteMoves` at all without inventing a fake Move for each. Kept
them as separate `whiteFilledPlayers` React state instead — purely a UI-
layer addition, the engine itself untouched. A new `RosterEntry` shape
(`{ label, glyph, player }`) lets `SideColumn`/`FinishCard`/`lineupText`
all walk ONE combined list (piece-locked moves first, then optimizer
fills) instead of `Move[]` directly, so "(optimizer)" rendering and Copy-
lineup/sim feeding both fall out of the same list rather than needing
separate merge logic in three places.

Confirmed by construction (not just assumed) that the sim needed ZERO new
code to pick up a filled core: `runSimForBothSides` already dispatches
`bestCompletion.lineup` for White whenever the move-locked core is
incomplete (Sim 4, §4), and `bestCompletion` itself doesn't change when
`whiteFilledPlayers` is set (same `locked`/`excludeIds` inputs either
way) — a filled core already WAS exactly what the sim used for an
incomplete core, before this button even existed.

501 → 506 npm tests (+5, all passing clean on the first run — no flakes,
no fixture rework needed this time).

---

## Final state

- **506 npm tests, 237 pytest** — pytest unchanged all session (every
  prompt was explicitly TS-only; `dfs_chess/` never touched).
- 7 commits, all pushed to `origin/main`, hashes in HANDOFF.md.
- Biggest open item: real-browser verification of the new Worker-backed
  Sim 4 UI, blocked on one missing system library (`libasound.so.2`) that
  needs `sudo` to install. See HANDOFF.md "Where We're Headed" #1-2 for
  the exact unblock command and what to test once it's run.
