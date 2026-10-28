# Session — 2026-10-27 (afternoon): Admin contest upload + Pct_To_First dollars/fraction

Two prompts, each its own commit, both on `main`, both pushed.

## Task 1: Admin contest upload (`4fcc3b1`)

Prompt asked for the same pattern as projections/Vegas: `contestStore.ts`,
`validateContestCsv`, an Admin section with upload/summary/Clear, a
rejected upload keeping the old data. Also: an upload replaces the whole
list (falls back to `contests.json` otherwise); skip cash games
(Double-Up/50/50) but keep H2H, reporting skips in the summary;
duplicate-name/numeric/required-column validation; any row the payout
curve rejects fails the whole upload, named; `PRESETS` becomes dynamic;
a saved build whose contest no longer exists falls back to the first
contest with a notice.

**Blocking question raised before building**: the prompt's "skip cash
games (Contest_Type containing Double-Up or 50/50)" doesn't match the
real sample CSV — `Contest_Type` is only ever `gpp` or `cash` there;
"Double-Up" only appears in `Contest_Name`. Flagged this contradiction
per CLAUDE.md's "stop and ask" rule rather than guess which field was
meant.

**Ron's answer changed the plan entirely**: don't skip cash games at
all. Instead, in the payout curve: if `pctToFirst * prizePool` equals
`minCash` (within $0.01), build a flat table (every cash spot pays
`minCash`) instead of the decaying curve. No rows skipped; the
Contest_Name substring check that would have detected Double-Up/50/50
is explicitly unused.

Implementation:
- `payouts.ts`: added the flat-table branch, right before the existing
  `minCash >= rank1` guard (so an exact/near-exact match short-circuits
  into the flat case instead of hitting that error).
- `contestStore.ts`: exact mirror of `vegasStore.ts`/`projectionsStore.ts`.
- `engine/contestsCsv.ts`: new validator, mirrors `vegasCsv.ts`'s shape
  (column map, required-column check, numeric check, duplicate check,
  then a per-row payout-curve pass that collects rejected names rather
  than failing fast on the first one).
- `AdminScreen.tsx`: new "Contests" section, ungated (contests don't
  depend on a slate, unlike Vegas).
- `appData.ts`: `PRESETS` changed from `export const` to `export let`
  plus `refreshPresets()` — relies on ES module live bindings so every
  importer sees updates without re-importing. `App.tsx` calls
  `refreshPresets()` in its existing `onHashChange` handler, alongside
  the existing `loadSavedPlayers()` re-read.
- `App.tsx`'s `startAgain()`: matches the previous contest by **name**,
  not `PRESETS.indexOf(chosenSetup.preset)` by reference — reference
  equality would false-positive on every no-op `#/admin` visit, since
  `refreshPresets()` always builds fresh `ContestPreset` objects even
  when nothing changed. No match → `presetIndex: 0` + a notice string
  threaded through to `SetupScreen` as a new `contestNotice` prop.

**Fixture verification before writing tests**: wrote a throwaway Node
script (not committed) to run the real `Sim_Contest.csv`'s 20 rows
through the payout-curve logic directly, confirming exactly 19 pass and
"NFL GIANT $25 Double-Up" fails (`Pct_To_First=50` is not a (0,1]
fraction) — matches the original task prompt's own "19 contests loaded"
example, which is presumably why that number was chosen. Added
`SAMPLE_CONTEST_CSV` (the full 20-row file) and `VALID_CONTEST_CSV`
(same file minus the Double-Up line) to `testFixtures.ts`.

**A real debugging detour**: a new "Start again falls back..." test in
`App.test.tsx` failed with the Password field never appearing after a
live hash navigation to `#/admin` — but only when the contest selected
beforehand was H2H specifically, not any other preset. Built a scratch
test file (`__scratch_hashnav.test.tsx`, deleted after) to isolate it:
confirmed live hashchange navigation into `#/admin` works fine from
SetupScreen and from a freshly-opened BuildScreen (any preset), and
ruled out "any `selectOptions` call" as the cause by testing two other
presets explicitly. Root cause: a bare synchronous `screen.getByLabelText`
right after an `act()` block isn't safe when the preceding render was
heavier (H2H's tiny 2-entry field apparently takes slightly longer) —
fixed by awaiting `screen.findByLabelText` instead. Not an app bug.

**Full-suite flakiness**: the full `npm run test` run intermittently
timed out on 2-3 *unrelated* BuildScreen/SetupScreen tests (castling,
"Left the line after", "Random stays within the selected chip") under
32-worker parallel load — confirmed pre-existing by re-running before
any of this session's test files existed and seeing the identical
pattern (different exact tests failing each run, never deterministic).
Added the same explicit per-test timeout bump (`15000`, third arg to
`it()`) this codebase's own heaviest existing tests already use, for
the one new heavy test. Re-running the full suite cleanly a second time
(542/542) after the bump confirmed it wasn't a real regression.

Final: 539 passed (full suite) → re-run clean at 539, then 542 after
adding the new test with its timeout bump. Pytest: 237 passed, untouched
by this Python-free change.

## Task 2: Pct_To_First as dollars or fraction (`7ef4983`)

Follow-up prompt: in `validateContestCsv`, `Pct_To_First > 1` → treat as
the 1st-place dollar amount, convert by dividing by that row's own
`Total_Prize_Pool`; (0, 1] stays as-is. Flag converted rows in the
upload summary ("Pct_To_First read as dollars: ..."). Test with the
full, untrimmed sample: all 20 rows load, Double-Up builds a flat table.

Straightforward once the flat-table branch already existed from Task 1:
`50 / 75000 = 0.000666...`; `rank1 = prizePool * pctToFirst` comes out
to exactly `50`, which equals Double-Up's own `Min_Cash_Amount` of `50`
— so it lands in the existing flat-table case automatically, no new
payout-curve logic needed.

Changed `validateContestCsv`'s return shape from a bare `ContestPreset[]`
to `{ presets, dollarPctToFirstNames }` — updated the two callers
(`appData.ts`'s `loadPresets()`, `AdminScreen.tsx`'s upload handler +
summarize helper) and all existing tests that destructured/consumed the
old shape.

Replaced the now-obsolete "rejects the full file over Double-Up's
unbuildable curve" tests (in both `contestsCsv.test.ts` and
`AdminScreen.test.tsx`) with "all 20 rows load, Double-Up flagged and
flat-tabled" — kept the adjacent "19 contests, minus that row, nothing
converted" tests since they're still a valid, distinct check.

Final: 542 passed (full suite, confirmed clean on a second run — one
unrelated test flaked on the first run, different from any flaked
before, reinforcing it's load-dependent noise not a regression). Pytest:
237 passed.

## Notes for next time

- The flat-table payout case (`payouts.ts`) is now load-bearing for two
  different things: H2H's winner-take-all-ish shape (pre-existing
  `spots === 1` special case, untouched) and now also any contest whose
  rank-1 dollar amount happens to equal its own min-cash exactly (new
  this session) — including both a genuinely-fractional `Pct_To_First`
  that happens to land there AND a dollars-converted one.
- Full-suite flakiness is real and pre-existing, not something either
  task introduced — but it's annoying enough (appeared on nearly every
  full run this session, always a different 1-3 tests) that it might be
  worth a dedicated look if Ron wants it gone rather than just mitigated
  test-by-test.
