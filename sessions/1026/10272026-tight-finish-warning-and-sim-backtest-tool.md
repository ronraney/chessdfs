# Session: Tight-finish warning, sim backtest tool, backtest diagnostic

Three task prompts this session, all landed as commits, all pushed.

## Task 1 — Tight-finish warning, White only (`cd31a09`)

A display-only heads-up (never blocks a move/pick), gated on White having
3+ open roster slots. `buildStats.ts`'s new `tightFinishStatus` +
`TIGHT_FINISH_CONFIG` (Caution at $4,500 avg remaining/open-slot; Warning
at $4,000 avg + at least one of: a Pawn-priced player locked [by salary —
`classify(...).has(Piece.PAWN)`, NOT by whichever piece actually locked
them, since Knight/Bishop/Rook pools now overlap Pawn's own salary range],
both TE slots used [dedicated TE slot + a 2nd TE in FLEX], QB slot still
open). Wired into `PickPanel.tsx`'s "After this pick" footer (computed
against `[...currentPlayers, selected]`) and `BuildScreen.tsx`'s You
panel only (`SideColumn`, `side === "you"` — Field never gets this prop).

8 new tests in `buildStats.test.ts`: gated-null below 3 open slots even
when salary is extremely tight, Caution at the $4,500 threshold, Caution
staying Caution (not escalating) at the $4,000 threshold when no
aggravating factor applies, one Warning test per factor, and a
multi-reason join test. 20 total tests in that file (was 12).

Flagged assumptions (not confirmed with Ron): "both TE slots" reading
(2 TE players rostered, not a literal 2nd roster-slot named TE, since
`nfl.json` only has one), and the exact wording for the Pawn-priced/
both-TE-used reason strings (only "QB still open" was given verbatim in
the prompt).

## Task 2 — Sim backtest: score lines (`915f99a`)

"Tool only, no app changes." The real design challenge wasn't the sim
math, it was getting a TypeScript file to run outside Vitest at all:
this app's tsconfig uses `moduleResolution: "bundler"` (extensionless
imports), which plain `node script.ts` can't resolve, and there's no
ts-node/tsx dependency. Tried and rejected: Vitest can't run a file
outside its `*.test.*`/`*.spec.*` glob even when given an explicit path
(confirmed empirically). Landed on: bundle the CLI entry for Node via
Vite's own `build --ssr` (already a dependency, no new one added) through
a **standalone** `web/vite.backtest.config.ts` (app's own `vite.config.ts`
untouched), with `ssr.noExternal: true` (papaparse is CJS and hits
Node's ESM named-export interop limits otherwise) and
`output.format: "es"`, then run the bundled `.js` with plain `node`.
Wired as `npm run backtest -- <args>` (`vite build --config
vite.backtest.config.ts && node .tmp-backtest/simBacktestCli.js`);
`.tmp-backtest/` gitignored.

`web/src/tools/simBacktest.ts` (pure, no top-level side effects, testable):
`scoreAtRank` (walks a trial's descending field scores by cumulative
`lineupWeight` to find whoever occupies real-contest place N — same
convention `run.ts`'s `computeEffectivePlaceAndPayout` already uses, just
applied to the field's own scores instead of one external lineup) and
`runContestBacktest` (builds the field via `buildFieldCache.ts`'s own
`BUILD_ATTEMPT_CAP`/`TARGET_DISTINCT_LINEUPS` — "the existing tier field
builder" — for `trials` trials, records Win/Top1/Cash/Median per trial,
reports sim P10/P50/P90 + where a given real value lands as a sim
percentile). `simBacktestCli.ts` is the thin entry (kept separate so
importing the pure module in a test never fires `main()` against the
test's own `process.argv`). 6 new tests for `scoreAtRank` alone, per the
task's "test the line-rank math only."

Ran for real against all 4 contests from the task (Main Slate 6, seed
2026, 2,000 trials): every run took ~2 minutes, dominated by the
10,000-attempt field build (no caching — a fresh build every invocation).
Every field came back ~9,300–9,400 lineups, over `run.ts`'s own
`MAX_FIELD_SAMPLE` (5,000) every time, so the sampling fallback always
triggered — reported automatically each run, not something I had to
manually decide to apply.

Key finding worth remembering: the 11,890- and 147,058-entry contests are
BOTH "LARGE" tier (`ContestConfig.fieldTier()`'s threshold is 10,000), and
with the same seed, the SAME attempt cap, and the SAME player pool, their
built fields are byte-identical (field generation never reads the
contest's own real `fieldSize`, only its tier, until the final
`lineupWeight = fieldSize / lineups.length` line) — so their Win/Top1/
Median results came back nearly identical, only Cash differed (since
`placesPaid` is a different fraction of entries between the two). This is
an inherent consequence of reusing the tier builder as instructed, not a
bug — flagged plainly in the report rather than "fixed."

Result across all 4 contests: real Top1/Cash/Median lines landed at the
sim's own bottom ~1–4th percentile every time; only Win landed near the
middle. Consistent with `field.ts`'s already-documented disconnect from
the real-correlation model (HANDOFF's long-standing #1 open item) — this
backtest is independent evidence for the same gap, not a new one.

## Task 3 — Backtest diagnostic: why sim lines run high (`443d6c8`)

Extended the same tool rather than building a parallel one, per "extend
the backtest tool." Split "why does the sim run high" into two
independent questions by comparing 4 distributions: does the field's own
TALENT already run high before any randomness (real lineups' Σ DK Proj
vs sim-built lineups' Σ DK Proj), and does the per-player RANDOM draw
itself run high against what actually happened (real lineups' actual
Points vs pooled simulated scores across every (lineup, trial) pair).

New `web/src/tools/lineupParser.ts`: `parseLineupString` turns a DK
contest-standings "Lineup" cell (e.g. `"DST Falcons  FLEX Tyler Higbee QB
Joe Burrow RB Bijan Robinson RB Tony Pollard TE Tucker Kraft WR Amon-Ra
St. Brown WR Tee Higgins WR KC Concepcion Jr."`) into ordered `{slot,
name}` pairs by walking whitespace-split words and treating QB/RB/WR/
TE/FLEX/DST as slot-start markers — confirmed by hand against the real
file's own first row before writing the test. 6 new tests (the real row,
punctuation/suffix preservation, the double-space-after-DST quirk, empty
string, stray leading text, an empty name). `simBacktest.ts` matches each
parsed slot to a projections `Player` by name AND slot-compatible
position (`sport.rosterSlots`' own position sets — FLEX accepts
RB/WR/TE), not name alone, so two same-named players at different
positions wouldn't silently collide (none actually did on this slate).
A lineup with any unmatched slot is excluded entirely from every
real-field aggregate (not partially counted) — `realLineupsSkippedUnmatched`
reports how many; every unmatched name is still counted/listed regardless.

The task named the input file `data/backtest/contest-standings-196924779.csv`,
which doesn't exist. Found the real one: `data/samples/contest-standings-196924779.zip`
(same ID). Unzipped it to a sibling `.csv` in `data/samples/` rather than
inventing a new `data/backtest/` directory structure — flagged, not
asked-and-blocked, same judgment call as the prior session's "Main Slate
6" vs "Main Slate (6)" filename mismatch.

Ran for real (4,901-entry tier, seed 2026, 2,000 trials, ~2m18s — A/B
don't depend on trial count at all, only D and the per-player diff do,
confirmed by comparing a `--trials=10` smoke run against the real one and
seeing A/B unchanged). Of 4,901 real entries, 4,842 were usable (0
malformed, 58 skipped for ≥1 unmatched name); 10 distinct unmatched names,
59 occurrences (Adonai Mitchell, Jonah Coleman, Audric Estime, Jalon
Daniels, Breece Hall, Jameis Winston, Dan Villari, AJ Dillon, Ben Mann,
Davante Adams — all real, unmangled names, almost certainly inactive/off
that week's main slate rather than a parser bug). Real avg lineup salary
$49,888 vs sim $49,704. Avg-across-all-players (mean simulated score − DK
Proj): **−0.01** — confirms the mean-anchor-to-proj fix from an earlier
session still holds at essentially zero bias.

The actual finding: A (real lineups' own Σ Proj, median 135.4) ≈ B (sim
field's own Σ Proj, median 137.4) ≈ D (pooled simulated scores, median
136.3) — all three cluster together. C (real lineups' ACTUAL Points,
median 113.0) sits ~23 points below all three. This directly explains
Task 2's finding: the sim isn't miscalibrated against this slate's own
projections (field construction and per-player draw both track DK Proj
closely) — this particular week's real outcomes just came in far below
what was projected across the board. A real-world projection-accuracy
miss, not a sim mechanics bug. Nicely cross-validated against Task 2's
own independent number: that task's rank-based "median" line for this
same 4,901-entry contest reported real 112.8 (from the task prompt's own
real-contest table) — matching this task's directly-computed real Points
median of 113.0 almost exactly, from a completely different computation
path (rank-walk over a sim field vs. direct parse of the real standings
file).

`simBacktestCli.ts` now requires a `backtest`/`diagnose` first argument
(a CLI shape change from Task 2 — no other caller exists, so not treated
as a back-compat concern).

## State at session end

- 237 pytest, 579 npm, both green. 2 known-flaky BuildScreen tests
  (castling, deviation-banner) failed under full-suite parallel load,
  confirmed (again) to pass cleanly in isolation — pre-existing, not
  fixed this session.
- 3 commits, all pushed: `cd31a09`, `915f99a`, `443d6c8`.
- Working tree clean except the same standing untracked clutter (now
  plus `data/samples/contest-standings-196924779.csv`/`.zip`) — see
  HANDOFF.md.
