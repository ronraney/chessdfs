# Session — Sim 1 & 2, Pts from optimal (both sides), Vegas/dome admin upload, home/away

**Date:** 2026-10-19

Five rule-change tasks this session, each relayed one at a time from Ron
(planned on claude.ai), each shipped as its own commit. All TS-only —
the Python engine was never touched.

---

## Part 1 — Sim 1: outcome draws + correlation engine (TS only)

**Prompt:** port `drawOutcome_`/`drawSlateOutcomes_` from `rraney/nfl-dfs`'s
`sim_draws.js` into `web/src/engine/sim/` as pure TS (no I/O, seeded RNG
only). Keep the piecewise-linear percentile curve (Floor=P15, Proj=P50,
Ceiling=P85, k=1.0 right tail) and the latent-factor correlation engine
(zGame/zTeam/individual, DST negative game loading, shootout/script
regime shocks, 7% DST splash). Accept optional per-game Vegas (total,
spread), nfl-dfs's math when present, neutral defaults when absent. Skip
`sim_correlation.js`/`sim_foundations.js` as whole files and all
calibration/diagnostic tooling. Report nfl-dfs's Vegas input format.

**What was built:** `engine/sim/draws.ts` — `drawOutcome` (Part A, exact
port) and `drawSlateOutcomes` (Part B). `randNormal`/`normCDF` (the two
pure-math helpers `sim_correlation.js`/`sim_foundations.js` hold) are
reproduced directly rather than porting either file, with the injected
`SeededRandom` replacing `Math.random()`.

**Design decisions, all flagged to Ron:**
- Dome explicitly NOT ported this round — out of scope per the task's own
  Vegas-input framing (total/spread only). (Added properly in Part 3/4
  below, once actually asked for.)
- Showdown CPT/FLEX grouping dropped — chess-dfs has no Showdown contest
  type; nfl-dfs's own comment calls this a no-op for Main Slate anyway.
- `SlateVegas` is keyed by TEAM abbreviation (one optional `{total,
  spread}` per team), mirroring nfl-dfs's real Vegas sheet format exactly
  (reported below) rather than inventing a per-game key shape.
- No params-override object exposed — task's API is the 3-arg form
  (players, games, rng); all `SIM_*` constants hardcoded at nfl-dfs's
  frozen defaults.
- `players: readonly Player[]` reuses the existing engine type directly
  (has team/opp/floor/proj/ceiling already); position read off
  `positions[0]`.

**nfl-dfs's Vegas format, as reported to Ron:** `readVegas()`
(`readers_dkfd_etr.js`) reads a "Vegas" sheet, one row per TEAM (not per
game): columns `Rank, Team, Implied Total, Spread, O/U, Opponent`.
Implied Total/O-U are real NFL points (not DK fantasy points); Spread is
that team's OWN signed spread — negative = favored (giving points),
positive = underdog (getting points), standard American odds convention,
confirmed from nfl-dfs's own code comment.

**Tests (8, all in `draws.test.ts`):** drawOutcome anchor-hit checks,
many-draws P15/P50/P85 recovery, same-seed determinism, teammate
positive correlation, DST-vs-opposing-RB negative correlation, high-
Vegas-total raising a game's mean. Tolerances were tuned empirically
(ran the deterministic seeded test, read the real numbers, picked
margins with real headroom) rather than guessed — this model layers
regime shocks on top of the raw percentile curve, so e.g. P85 doesn't
land exactly on the ETR ceiling anchor; that's expected, not a bug.

**Result:** 417 npm tests (was 409). Commit `23cd25d`, pushed.

---

## Part 2 — Field gets Pts from optimal

**Prompt:** Black's panel should show the same "Pts from optimal" stat
White's already had, computed the same way (Black's locks forced in,
White's picks excluded, same slate optimal). Show it for both sides on
the finish screen too.

**What was built:** `BuildScreen.tsx` — added `blackBestCompletion`/
`blackOptimalStats` (mirrors White's existing `optimalLineup` call,
sides swapped), wired into Black's `SideColumn` and `FinishCard`.
`SideColumn`'s display is no longer gated to `side === "you"` — shows for
either side once `optimalStats` is passed. `FinishCard`'s `optimalStats`
prop renamed `whiteOptimalStats`, new `blackOptimalStats` added; finish
screen shows both a "Pts from optimal:" line (White, unchanged wording)
and a new "Field pts from optimal:" line (Black, matching the app's
existing You/Field terminology).

**Flagged:** the prop rename is an interface change (needed to
disambiguate the two sides); "Field pts from optimal" wording was my own
choice since the task didn't specify it.

**Result:** 419 npm tests (+2). Commit `167e7a0`, pushed.

---

## Part 3 — Admin: Vegas upload + dome list

**Prompt:** add a second admin upload beside projections, for Vegas (one
row per team: Rank, Team, Implied Total, Spread, O/U, Opponent — Spread
negative = favored). Validate required columns/numeric values/teams
matching the loaded slate; warn (don't reject) on a slate team with no
Vegas row — neutral defaults. Save in browser storage like projections;
show what's loaded, allow clearing. Pass it into `drawSlateOutcomes` as
the `games` input. Separately: add a static dome-team list to sport
config (copy nfl-dfs's list) and port nfl-dfs's dome wGame boost into
`draws.ts`.

**What was built:**
- `engine/sim/vegasCsv.ts` — `validateVegasCsv(data, slateTeams)`,
  mirroring `validateSlateCsv`'s "first problem found" style. Required-
  column check, missing/duplicate-team checks, per-numeric-column
  non-numeric checks, off-slate-team rejection (hard error), then
  `missingTeams` (slate teams with no row — reported, not rejected).
  Returns `{ vegas: SlateVegas, missingTeams }` — `vegas` is already the
  exact shape `drawSlateOutcomes` takes, no adapter needed.
- `vegasStore.ts` — `getSavedVegasCsv`/`saveVegasCsv`/`clearVegasCsv`,
  mirroring `projectionsStore.ts` exactly (raw CSV text stored, re-
  parsed wherever read).
- `AdminScreen.tsx` — second upload section, gated behind a loaded
  projections slate (team-matching needs it); shows team count + a
  missing-teams note; "Clear Vegas data" button.
- `config/sports/nfl.json` got `dome_teams` (ARI, ATL, DAL, DET, HOU,
  IND, LV, MIN, NO, LAR — copied verbatim from nfl-dfs's
  `SIM_DOME_TEAMS_`); `SportConfig`/`RawSportConfig` carry it as
  `domeTeams`.
- `draws.ts` got a dome wGame boost (`DOME_WGAME_SCALE = 1.15`) and a new
  optional `domeTeams` parameter (default empty, so every prior caller
  is unaffected).

**Flagged (this was the part corrected in Part 4):** at this point, dome
status was approximated as "either team in the matchup is a dome team" —
chess-dfs's `Player` had no home/away flag yet, so there was no way to
know which of the two teams was actually hosting. Flagged explicitly as
exact only when the dome team is hosting, wrong the other way (a dome
team's real road game at an outdoor stadium would've read as dome).

**Result:** 439 npm tests (+20: 9 vegasCsv, 7 AdminScreen, 2 dome
parsing, 2 dome boost). Commit `33aa6e3` (had to be amended once —
see "Gotchas" below), pushed.

---

## Part 4 — Follow-up: keep home/away; dome is the exact home team

**Prompt:** the ETR "Opp" column's leading "@" means the player's team is
away — store `isHome` on `Player` in the loader (still strip "@" from
`opp`). Dome = home team is in `dome_teams`, exactly as nfl-dfs does.
Test: "NO @ NYG" is not a dome game; "NYG @ NO" is.

**What was built:** `models.ts` — `Player.isHome` (optional, defaults to
`false`, so every pre-existing synthetic test `Player` — and there are a
LOT of `new Player({...})` call sites across the test suite — kept
compiling with zero edits). `loaders.ts` — new `isHomeFromOpp(raw)`
checks the RAW (pre-strip) Opp value for the "@" prefix; `loadEtrCsv` now
sets `isHome` from it before `stripOpp` runs. `draws.ts`'s
`buildGameGroups` now tracks `homeTeam` per game group (whichever team's
players report `isHome`); `domeByGame` keys off that instead of
either-team.

**Updated (not newly broken) by this change:** the existing dome-
correlation test from Part 3 needed its synthetic players to actually
set `isHome` on the right side — with no player ever flagged home,
`homeTeam` stayed undefined everywhere and dome always evaluated false.
Fixed by setting `isHome: true` on the intended-home player in that test.

**New test, the exact scenario the prompt named:** since internal
`domeByGame`/`buildGameGroups` aren't exported, this is tested the same
way the Part-3 dome-correlation test already was — black-box, via a
measurable cross-team wGame-correlation boost — run once for "NO @ NYG"
(expect no boost: NYG hosts, NYG isn't a dome team) and once for "NYG @
NO" (expect a boost: NO hosts, NO is a dome team).

**Also added:** a direct `loaders.test.ts` unit test confirming
`isHome`/`opp` derivation from a synthetic two-row CSV with the real "@"
convention.

**Result:** 441 npm tests (+2). Commit `31a1ffb`, pushed.

---

## Part 5 — Sim 2: simulated contest field (TS only)

**Prompt:** port nfl-dfs's MILP field generator
(`generateSimulatedFieldMilp_`) into `web/src/engine/sim/` as pure TS,
reusing yalps. Skip the older sampling path and all diagnostics. Inputs:
player pool, contest (field size → ownership via the existing Small/Mid/
Large rule; salary cap), sample size, seeded RNG. Keep the ownership-bias
objective term, per-position exposure caps, and the soft minimum-
exposure floor, at frozen defaults. Output `{ lineups, lineupWeight }`
where `lineupWeight = entrants / sampleSize`. Default sample size =
nfl-dfs's default; report it and the time to build a field on the sample
slate. The field ignores the current build's locks.

**What was built:** `engine/sim/field.ts` — `generateSimulatedField`.
Per-attempt: filters the pool by real (not pacing-temporary) exposure
caps, builds a per-player objective (`proj * (1+noise) * ownershipBias *
catchUpBoost`), solves one plain MILP (yalps, binary vars, qb/dst/rb/wr/
te/skill count constraints + salary max) — on success, pushes the
lineup and updates exposure counts/caps; on infeasible, skips the
attempt (no retry/relaxation). `DEFAULT_SAMPLE_SIZE = 1000`.

**Read from nfl-dfs's real source to confirm exact mechanics** (not
guessed): the position-average-ownership bias denominator, the Minimum
Exposure Floor's `minExposureShare`/catch-up-boost formula (including its
`MIN_EXPOSURE_MAX_CATCHUP_BOOST_ = 3.0` cap), the QB-only extra exposure
cap (`FIELD_QB_MAX_EXPOSURE_ = 0.22`), and the QB/DST aggregate-capacity-
guarantee rescale (an unconditional part of how nfl-dfs computes exposure
caps today, not a diagnostic — ported alongside the caps themselves).

**Deliberately NOT ported, all flagged:** stack targeting (naked-QB rate,
stack-team retry), Field Pace Slack, Dynamic Floor Relaxation, and
nfl-dfs's own salary *floor* (`FIELD_MIN_SALARY_`) — none were named in
the task's "keep" list, and the task's own Inputs/Tests wording only
ever says "cap," never "floor."

**Other flagged design choices:**
- `lineupWeight = contest.fieldSize / sampleSize` exactly as the task
  specified — nfl-dfs itself divides by `lineups.length` instead (only
  differs when attempts are skipped as infeasible).
- Roster-slot shape (qb/dst/rb/wr/te/skill min/max counts) is hardcoded
  exactly as nfl-dfs's own `DK_MAIN_ROSTER_` is, NOT derived generically
  from `sport.rosterSlots` the way `optimizer.ts` does — a faithful port
  of nfl-dfs's own NFL-classic-specific MILP, not a new sport-agnostic
  abstraction (optimizer.ts solves a structurally different problem: one
  true-optimal lineup with FLEX eligibility, not a bias-weighted random
  field with exposure caps).
- Ownership resolved via `contest.fieldTier()` + `Player.ownFor(tier)`
  (the existing Small/Mid/Large rule), replacing nfl-dfs's flat
  `ownership` field.
- Dedup key is `Player.id` directly (already unique, enforced by
  `validateSlateCsv`) rather than reconstructing nfl-dfs's `Player|Team`
  composite key, which existed there for a different data shape.

**Performance — measured, not estimated:** ran it twice against the real
301-player sample slate at `DEFAULT_SAMPLE_SIZE` (1000): ~165s and
~153-156s, 917/1000 attempts accepted both times (same seed → same
count, consistent with determinism). That's the number reported to Ron.
Given the cost, the test suite does NOT run this against the real slate
(would add 2.5+ minutes to every future `npm run test`, and isn't one of
the task's four named test requirements) — the four required tests
(legality, determinism, exposure-near-ownership, lineupWeight) run
against a small 58-player synthetic pool instead (built with a real
ownership/salary spread across all 5 positions), completing in ~200ms
total. `DEFAULT_SAMPLE_SIZE`'s value (1000) IS pinned by a trivial fast
test, separate from the real-slate timing.

**Result:** 446 npm tests (+5). Commit `7bd60da`, pushed.

---

## Gotchas worth remembering

- **Commit messages with backticks aren't safe in this environment**,
  even with a single-quoted heredoc delimiter (`<<'EOF'`), which should
  normally suppress all expansion inside the heredoc body. The Part-3
  commit (`33aa6e3`) landed with two backtick-quoted words (`` `games` ``,
  `` `domeTeams` ``) silently replaced by empty strings, plus two stray
  "command not found" lines on stderr — caught only by running `git log
  -1 --format='%B'` right after committing and actually reading it. Fixed
  via `git commit --amend` (the commit hadn't been pushed yet) using
  `git commit -F <tempfile>` instead of an inline heredoc, with double
  quotes in place of backticks inside the message text. Worth checking
  `git log -1 --format='%B'` after any commit whose message has
  backticks or other shell-special characters, and preferring double
  quotes or a temp-file message over inline backticks going forward.
- **MILP (yalps) solve time is NOT small at realistic scale.** A single
  solve over the real ~300-player sample pool costs on the order of
  150-200ms, and that cost is NOT uniform across a batch — exposure caps
  thinning the pool over the course of a run can make later solves
  slower, not faster, in practice (observed ~680ms/solve average in one
  smaller run, vs. ~155-165ms/solve in the full 1000-attempt run — the
  two aren't directly comparable since pool-thinning state differs, but
  it's a real signal that "pool size ÷ solve count" isn't a safe time
  estimator here). Any future task building on `field.ts` should expect
  to measure fresh rather than extrapolate from a different sample size.
- I mistakenly called `ScheduleWakeup` (a `/loop`-mode tool) once while
  waiting on a long-running background test in this (non-loop) session —
  harmless (immediately cancelled with `stop: true`), but it's the wrong
  tool outside `/loop`; a background Bash run already notifies on its
  own completion without it.
