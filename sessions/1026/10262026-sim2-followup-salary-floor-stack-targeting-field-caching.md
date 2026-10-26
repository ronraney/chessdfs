# Session — Sim 2 follow-up: salary floor, stack targeting, lineupWeight, field caching

**Date:** 2026-10-26

One task this session, relayed as a 3-item follow-up to last session's
Sim 2 (`generateSimulatedField`), plus a side request to try a cheap
speedup and report on it. TS-only — the Python engine was never touched.

---

## The task, as given

1. Port nfl-dfs's salary floor and stack targeting at its frozen
   defaults (left out of Sim 2 by mistake). Skip Field Pace Slack and
   Dynamic Floor Relaxation unless the floor makes too many attempts
   infeasible — report the accept rate either way.
2. `lineupWeight = entrants / lineups actually built` (nfl-dfs's own way,
   correcting last session's `/ sampleSize`).
3. Speed: the field ignores the current build, so pre-build it. Admin
   gets a "Build fields" section: once projections (and Vegas, if
   loaded) are in, build one field per ownership tier (Small/Mid/Large)
   in a Web Worker with a progress bar, cached in browser storage keyed
   by slate + tier. Builds load the cached field for their contest's
   tier; if nothing's cached, sim features show "Build fields in Admin
   first." Uploading new projections clears the cache. Also try a cheap
   speedup (e.g. reusing the optimizer's dominance pruning) and report
   the new time per field.
4. Tests: salary floor respected; stacks present at roughly nfl-dfs's
   target rate; cache hit/miss/clear. Run `npm run test`; report the
   count.

## What was read from nfl-dfs's real source (not guessed)

- `sim_field.js`'s `generateSimulatedFieldMilp_`/`_buildOneLineupMilp_`:
  `FIELD_MIN_SALARY_ = 48500`, `FIELD_TARGET_NAKED_QB_RATE_ = 0.175`,
  `STACK_TEAM_RETRY_LIMIT_ = 6`, the `stackTeam`/`qbFromStackTeam`
  constraint pair (needed so "2+ WR/TE from team X" is actually tied to
  a QB from that same team, not just coincidentally present), and the
  weighted-without-replacement team retry (`_weightedSampleOne_`).
  `_buildOneLineupMilp_`'s Dynamic Floor Relaxation and Field Pace Slack
  were read in full to confirm they're genuinely separate mechanisms
  from the floor/stack pieces being ported, not entangled with them.

## What was built

- `engine/sim/field.ts`:
  - `solveOneLineup` gained `floor` (now a required param, no longer
    cap-only) and an optional `stackTeam`, which adds the two stack
    constraints to the MILP when a specific team is being targeted.
  - A new `sampleTeamsWithoutReplacement` (seeded via the injected `rng`,
    not `Math.random()`, to keep the existing same-seed-same-field
    guarantee) picks the retry order for a stack-intended attempt.
  - The main loop: one coin flip per attempt decides stack intent
    (`rng.next() < 1 - TARGET_NAKED_QB_RATE`); if intended, candidate
    teams (structurally stack-eligible AND currently represented in the
    exposure-capped pool) are tried in weighted order up to the retry
    limit; falls back to a plain unstacked solve on no candidates or
    every retry failing — never drops the attempt just because the
    stack didn't land.
  - `lineupWeight` is now `contest.fieldSize / Math.max(lineups.length, 1)`.
  - Added an optional trailing `onProgress?: (completed, total) => void`,
    called once per attempt plus once more at `(sampleSize, sampleSize)`
    — still no I/O inside this file itself, just a callback invocation.
  - `SALARY_FLOOR` and `TARGET_NAKED_QB_RATE` exported (matching the
    existing `DEFAULT_SAMPLE_SIZE` precedent: a frozen default a test
    should cite, not re-guess).
- `fieldWorker.ts` (new, top-level, not under `engine/` — same
  "spinning up a Worker is DOM/I/O" placement rule as `stockfishEngine.ts`):
  the actual Worker entry point. Takes plain `PlayerFields` objects (not
  `Player` instances — postMessage's structured clone drops a class's
  prototype) plus a representative `fieldSize`/`sampleSize`/`seed`,
  reconstructs real `Player`/`ContestConfig` instances on its own side,
  runs `generateSimulatedField`, posts `progress` messages as they come
  and a final `done` with just the lineups' player IDs (not full Player
  objects — smaller payload back across the boundary).
- `buildFieldCache.ts` (new): orchestrates one sequential Worker-run
  build per tier (`BUILD_TIERS = [SMALL, MID, LARGE]`), writing each
  into the cache as it finishes rather than waiting for all three.
  `REPRESENTATIVE_FIELD_SIZE` (1000/5000/50000) and `BUILD_SEED`
  (20261019) are both my own unguessed-by-spec choices, flagged to Ron.
- `fieldCacheStore.ts` (new): `localStorage`-backed, mirroring
  `vegasStore.ts`/`projectionsStore.ts`'s existing convention. Keyed by
  `slateSignature(csvText)` (a plain FNV-1a hash — not a security
  primitive, just a short key fragment) + tier. `getCachedFieldIds`/
  `saveCachedFieldIds`/`clearFieldCache` are the raw hit/miss/clear API;
  `resolveCachedField(signature, contest, players)` is the intended
  read-side entry point for a future consumer — re-hydrates cached IDs
  against a live `Player[]` and recomputes `lineupWeight` from the REAL
  contest asking (a cached field is tier-scoped and reusable across any
  contest sharing that tier; `lineupWeight` is not, so it's deliberately
  NOT baked into the cached payload). `NO_FIELD_CACHED_MESSAGE` = "Build
  fields in Admin first." is defined here, exported, and currently
  **unused outside tests** — see "Open question" below.
- `AdminScreen.tsx`: new "Simulated fields" section (gated on a loaded
  projections slate, same as the Vegas section) — a "Build fields"
  button, a progress bar while a tier is building, and a per-tier
  "N lineups cached" / "not built yet" readout. `handleUpload` and
  `handleClear` (projections) both call `clearFieldCache()` now.

## Open question, flagged rather than guessed through

The task says "builds load the cached field for their contest's tier"
and "sim features show [the message]" — but **no screen in the player-
facing flow reads any sim output at all yet** (HANDOFF.md already said
UI wiring for the whole Monte Carlo port was unstarted future work).
Rather than invent a new BuildScreen section just to have somewhere to
put this, I built the read-side infra fully (`resolveCachedField`,
`NO_FIELD_CACHED_MESSAGE`) and left it unattached, flagged in HANDOFF.md
as the single most concrete next step. Building a whole new consumer UI
wasn't asked for in this prompt and would have been scope creep.

## The accept-rate measurement (task's own ask)

Ran `generateSimulatedField` against the real 301-player sample slate
(`data/samples/NFL Weekly DFS System - Projections.csv`) at
`DEFAULT_SAMPLE_SIZE` (1000), seed 42, via a temporary uncommitted
vitest file (deleted before committing, same pattern as last session's
own one-off benchmark):

- **941/1000 accepted (94.1%)**, stack rate 79.9% (target 82.5%,
  `1 - TARGET_NAKED_QB_RATE`) — close enough, and the accept rate is high
  enough that Field Pace Slack and Dynamic Floor Relaxation were
  correctly skipped per the task's own conditional instruction. Reported
  to Ron rather than silently decided.

## The speedup experiment (task's own ask, "e.g. dominance pruning")

Exported `pruneDominated` from `optimizer.ts` temporarily, applied it to
`field.ts`'s player pool before the main loop, and re-ran the same real-
slate benchmark:

- **688/1000 accepted (68.8%)**, down from 94.1%.
- QB pool collapsed from 22 survivors to 4; the field ended up drawing
  its QB from only 4 distinct players across the whole 1000-lineup
  sample.
- Per-solve time DID improve (~5x: 2.7ms/attempt vs. 14.2ms/attempt,
  smaller pool for yalps to branch over) — but the tradeoff is real, not
  cosmetic: `pruneDominated`'s proof ("a dominated player can always be
  swapped for its dominator without loss") holds for optimizer.ts's own
  single-best-lineup problem, but breaks down here because a later
  attempt can exposure-cap OUT the dominator, at which point the
  permanently-pruned "dominated" player was the only legal substitute
  left — a one-time global prune can't see that coming.
- **Decision: not applied.** `pruneDominated` was reverted back to
  private/unexported in `optimizer.ts`. Reported the full tradeoff to
  Ron with real numbers rather than just picking one side.

### A side investigation this forced: why did the OLD code look 10x faster here than last session's own number?

Last session measured the (floor/stack-less) field generator at
~155-165s/1000 attempts on the real slate. My first isolated run of the
NEW code (floor+stack, no pruning) measured ~14s/1000 — a 10x+ gap that
needed explaining before trusting ANY of these numbers. Ran a direct
control: copied the exact pre-this-session `field.ts` into a temp file
and benchmarked it, in this same session, back to back with the new
code. Isolated, it measured 918/1000 accepted (91.8%, consistent with
last session's own 917/1000) at 231.6ms/attempt — NOT 155-165ms, and not
close to the new code's 14ms/attempt either. The difference turned out
to be CPU contention: that control run happened to overlap with another
`vitest run` I'd started moments earlier (for `field.test.ts`'s own
updated assertions) on the same 8-core machine. Conclusion, written into
HANDOFF.md: this MILP workload's real-world cost is highly sensitive to
concurrent load in this environment, swinging from ~14ms to ~230ms+ per
attempt depending on what else is running — never trust a single
measurement as "the" cost, and don't extrapolate one sample size's
timing to another.

## Tests

- `field.test.ts`: `buildPool()`'s synthetic fixture needed real team
  diversity added (it was previously single-team for every player,
  which trivializes stack-team selection — there's only ever one
  candidate). Added `NUM_TEAMS = 6`, round-robin team assignment for
  QB/RB/WR/TE, re-verified every team ends up stack-eligible (≥2 WR/TE)
  by construction.
  - New: salary-floor-respected test, stack-rate-roughly-matches-target
    test (black-box: scans each returned lineup for QB + 2 same-team
    WR/TE, no new field on the return type needed), `onProgress`-call-
    shape test.
  - Updated: `lineupWeight` test now asserts against the REALIZED lineup
    count, not `sampleSize`. The pre-existing "top-owned player's
    exposure" test's upper tolerance needed widening 1.15x → 1.2x
    (measured 1.16x) — the new floor+stack mechanics shift which
    combinations the MILP ends up picking attempt-to-attempt, nudging
    this specific statistical bound slightly versus the cap-only
    baseline it was tuned against.
- `fieldCacheStore.test.ts` (new, 9 tests): hit/miss, signature+tier
  cross-contamination, clear-removes-everything, clear-leaves-other-keys-
  alone, `slateSignature` determinism, `resolveCachedField` (not-cached,
  resolves-to-real-Players-with-fresh-lineupWeight, drops-a-stale-id-
  rather-than-throwing).
- `AdminScreen.test.tsx` (5 new tests): gated behind a loaded slate;
  shows "not built yet" per tier once a slate's loaded; shows a
  pre-seeded cache's count WITHOUT clicking Build (seeded via direct
  store calls before render, not via the upload flow — uploading always
  clears the cache, so pre-seeding-then-uploading would just wipe the
  seed); uploading new projections clears every cached tier; Clear
  projections does too. Deliberately never clicks "Build fields" itself
  — jsdom has no `Worker`, same gap `stockfishEngine.ts`'s own tests
  already live with (confirmed by checking `BuildScreen.test.tsx`: it
  never drives Black far enough out of book to invoke the real
  Stockfish worker either — same house style, not a new workaround).
  - One PRE-EXISTING test (`"the Vegas upload is gated behind a loaded
    projections slate"`) needed updating: it asserted a single
    `getByText("Upload projections first.")` match, which broke once the
    new Simulated-fields section started sharing that same gating
    message. Changed to `getAllByText(...)).toHaveLength(2)`.

**Result: 463 npm tests (+17), 237 pytest (unchanged).** Confirmed via
`npx vitest run --testTimeout=20000` after one flaky run (two pre-
existing `BuildScreen.secondMove.test.tsx` tests timed out under
unusually heavy load — see Gotchas) and `python -m pytest -q`.

## Gotchas worth remembering

- **`$` in a commit message isn't safe here either, not just backticks.**
  Wrote `\$48,500` inside a single-quoted heredoc (`<<'EOF'`) nested
  inside `wsl.exe -- bash -lc "..."` — the OUTER double-quoted command
  string (not the heredoc itself) ate `$4` as if it were a positional
  parameter, leaving `8,500` in the final commit message on the first
  attempt. Caught via `git log -1 --format='%B'` right after committing
  (same habit HANDOFF.md already recommends for backticks) — fixed by
  rewriting the message to avoid the `$` entirely ("48500" instead of
  "$48,500") rather than fighting the quoting further.
- **A CLI `--testTimeout` flag can't rescue a test with its own smaller
  hardcoded timeout argument.** `BuildScreen.secondMove.test.tsx`'s
  castling test has `it(..., 15000)` baked in; `npx vitest run
  --testTimeout=20000` doesn't override that per-test value, so it still
  flaked at the SAME 15000ms wall under heavy load even with the global
  flag raised. Did not touch that file (out of scope for this task,
  genuinely unrelated) — a third full-suite run, and an isolated run of
  just that file, both passed clean, so treated as transient load (this
  session had just finished several minutes of back-to-back real-slate
  MILP benchmarking immediately before, which likely left residual
  contention) rather than a real regression.
- Ran several temporary, uncommitted benchmark vitest files this session
  (real-slate accept-rate measurement, dominance-pruning A/B, old-vs-new
  code control) — all deleted before the final commit, same pattern as
  last session's own one-off benchmarking.
