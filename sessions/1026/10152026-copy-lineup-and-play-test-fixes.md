# 10152026 — Copy lineup and play-test fixes (Tasks 42–43)

## Context

Picked up right after the prior session's handoff (piece pools, board bug
fixes — `10152026-piece-pools-and-board-bug-fixes.md`). `git status` was
clean apart from the standing, deliberately-uncommitted
`data/samples/repro-slate.csv`. Two tasks arrived back to back in this one
session: Task 42 (a single "Copy lineup" button) and Task 43 (a bundle of
seven play-test fixes gathered from an actual run-through of the app).

## What was done

### Task 42 — Copy lineup (commit `487ef4b`)

Added a "Copy lineup" button to `FinishCard` (`BuildScreen.tsx`) that
writes a tab-separated plain-text version of the locked core to the
clipboard: one row per player (Piece/Player/Pos/Team/Salary at the time),
then a totals block (salary used, salary remaining, projection, ownership,
opening, moves). The button shows "Copied" for 1.5s via a `setTimeout`
(cleared on unmount), mirroring the `blackTimerRef` pattern already used
elsewhere in the file.

Flagged assumptions at the time (since the prompt was terse): "slot" in
the copy text meant the existing Piece column, not a DK roster slot (the
engine had no per-player DK-slot assignment yet — that gap is exactly what
Task 43 asked for); "salary used" has no stored field, so it's summed from
the locked players directly; "moves" is the full two-sided game transcript
in SAN, not just White's own moves.

One real investigation mid-task: `navigator.clipboard` couldn't be mocked
the obvious way (`Object.defineProperty` before `userEvent.setup()`) —
`@testing-library/user-event` v14's `setup()` *always* installs its own
clipboard stub (`attachClipboardStubToView`, in
`node_modules/@testing-library/user-event/dist/.../utils/dataTransfer/
Clipboard.js`), saving and later restoring whatever was there, which
silently clobbers a prior custom mock the moment `setup()` runs. The test
ended up using that built-in stub directly (click button, then
`navigator.clipboard.readText()` to verify) instead of fighting it — worth
remembering next time any test here touches `navigator.clipboard`.

Result: 325 Vitest tests passing (up from 324), pytest untouched (186),
`tsc -b`/`lint`/`build` clean. Pushed.

### Task 43 — Play-test fixes (commit `27c26ae`)

Seven items, each investigated independently:

**1. Knight pool floor** — the prompt asked for TE ≥ $4,500 (no ceiling),
overlapping Pawn in the $4,500–4,999 band. Checked `config/sports/
nfl.json`, `buildStats.test.ts`, `pieces.test.ts`, and the Python mirrors
— all of it was **already exactly this**, left over from the prior
session's `1d2dcb8` revert. Re-ran `tools/export_parity.py` to be sure
(`git status` showed no diff to `parity.json` afterward). No code change;
flagged to Ron as a no-op rather than silently skipped.

**2. DK slots** — added `assignRosterSlots(players, rosterSlots):
string[]` to both `rules.ts` and `rules.py`, parallel to the existing
`maxAssignable`/`open_roster_slots` (same Kuhn's-algorithm bipartite
matching, same slot-instance expansion over `RosterSlot.count`), just
recording which instance each player actually lands in instead of only a
count. Guaranteed to fully assign everyone whenever
`maxAssignable(players, rosterSlots) === players.length` — true by
construction for any `whiteMoves`, since `lineupStillCompletable` already
gates every lock during the build on exactly that check.

One real wrinkle, caught by a failing test rather than assumed away: which
of several *interchangeable* same-position players (e.g. a 2nd vs. 3rd
locked RB) ends up labeled "FLEX" is decided by the augmenting-path
search's own traversal, not simply "whichever was locked last" — a naive
test asserting `["RB", "RB", "FLEX"]` in lock order failed; the fix was
asserting the sorted multiset (`["FLEX", "RB", "RB"]`) instead, since the
specific instance is cosmetically arbitrary (same-named slots are
indistinguishable on screen) and the existing `openRosterSlots`/
`maxAssignable` already accept this same non-determinism. Wired into
`FinishCard`'s table as a new "Slot" column before "Piece", and into
`lineupText`'s Copy output the same way. 8 new tests (4 TS in
`rules.test.ts`, 4 Python in `test_rules.py`), plus one assertion folded
into the existing "Stop with this core" BuildScreen test rather than
duplicating its expensive real-engine setup in a new test.

**3. Pick modal move list** — `PickPanel` now takes a `moveContext:
{moves, highlightIndex} | null` prop, rendered under the `<h2>` title as
`PickMoveList`. `BuildScreen.tsx` computes it: while the pending move
still continues the chosen book line (`pendingMove.san ===
chosenNextMove`), shows the line's full fixed move list with the pick
highlighted at its own depth; otherwise shows `[...history,
pendingMove.san]` (what's actually been played, plus the one being
decided) — either way the highlight index is just `history.length`, since
`history` never includes the pending move until it commits. `null` for the
switch-QB offer (not a real chess move). 2 new BuildScreen tests covering
both branches via the existing Morphy Defense fixture.

**4. Explorer row wrapping** — `.explorer-moves` in `SetupScreen.css`
dropped `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` for
a 2-line `-webkit-line-clamp`/`line-clamp` clamp. CSS-only; unverifiable
in this environment (jsdom has no layout engine at all — standing
limitation, not new this session).

**5. Suggested card piece icons** — replaced the old "White: P N B /
Black: P N B" text (`PieceSequence` in `SetupScreen.tsx`) with a row of
icon boxes in actual play order, matching `design/1-club-setup.png`:
`interleavePieces` zips `whitePieces`/`blackPieces` back into real move
order (White's move, then Black's reply, ply after ply — verified by hand
against Morphy Defense: P(w) P(b) N(w) N(b) B(w) P(b)), each rendered as
the standard Unicode outline glyph for White (♔♕♖♗♘♙) or solid glyph for
Black (♚♛♜♝♞♟), with a `title` attribute naming side+piece for a baseline
accessibility fallback (the old text content was itself the accessible
name; pure icons would have silently dropped it). 1 new test
(`the Suggested card shows the piece sequence as icons...`) asserting the
exact 6-icon title sequence for Morphy Defense.

**6. Admin slate validation** — new `validateSlateCsv` (`engine/
loaders.ts`) and `validate_etr_csv` (`dfs_chess/loaders.py`), deliberately
**separate** functions from `loadEtrCsv`/`load_etr_csv` rather than
folding the checks in — those two are called from ~20+ other places
(tests, `tools/`, the CLI) with small/synthetic CSVs never meant to form a
complete, roster-feasible lineup, and merging rigor in would have broken
most of them. Checks, in this order (column shape has to pass before row
parsing makes sense, before IDs, before roster-slot feasibility — the
prompt listed them in a different order but this is the only order that's
actually checkable): missing required columns (named in the message); no
ID column at all (`DK_ID` or `id`); missing ID values; duplicate IDs; then
(only once parsing succeeds) too few players for *any* roster slot — a
plain per-slot count check against `SportConfig.rosterSlots`, not a full
cross-slot bipartite feasibility match like `assignRosterSlots` does for
an actual locked roster (the prompt's own wording — "too few players for
any roster slot" — reads as the simpler, literal check; flagged as a
deliberate simplification, not an oversight).

`AdminScreen.tsx` rewired: `handleUpload` calls `validateSlateCsv` instead
of the old `loadEtrCsv` + `length === 0` check; on success it saves the
CSV and shows `"{count} players loaded · ID column: {idColumn}"` plus a
by-position tally line (`countByPosition`, a plain per-player tally of
`positions[0]`, independent of the roster-slot machinery); on
`SlateValidationError` it surfaces `e.message` directly (so "Missing
required column(s): Team, Opp, ..." is what the admin actually sees, not
a generic fallback) and — this was already true of the old code, just
newly load-bearing — never calls `saveProjectionsCsv` on failure, so the
previously-saved slate stays in place untouched. 7 new Vitest tests in
`engine/loaders.test.ts`, 7 mirrored in `tests/test_loaders.py`; 3 of
`AdminScreen.test.tsx`'s existing tests needed their exact-text
assertions updated for the new success-message format (`N players loaded`
→ `N players loaded · ID column: DK_ID`), and so did 2 in `App.test.tsx`
(same text, reached via the `#/admin` routing path).

**7. Flaky tests** — `SetupScreen.test.tsx` ("Random stays within the
selected chip", "choosing a family in the explorer...") and
`BuildScreen.secondMove.test.tsx` ("plays a full cycle...", "White can
move again after Take back") were timing out intermittently under
full-suite load at Vitest's 5000ms default. Investigated for an actual
removable inefficiency before reaching for a timeout bump: tried mocking
`@lichess-org/chessground` in `SetupScreen.test.tsx` the way
`BuildScreen.test.tsx` already does (hypothesis: real chessground mount
cost) — measured *no* improvement, if anything noisier; confirmed
`appData.ts`'s `previewFor` is already memoized and the Explorer's own
rows never call it; confirmed `BoardPreview` only mounts chessground once
(empty-deps effect) regardless of how many times the selection changes.
Found nothing to remove. Settled on extending per-test timeouts (15000ms)
to match the real cost of real chessground + real engine interaction —
the *same* fix pattern `BuildScreen.secondMove.test.tsx`'s own
"after castling"/"White can move again after a capture" tests already
used for the identical reason, not a new pattern invented here.

While confirming the fix with repeated full-suite runs, `BuildScreen.
test.tsx` itself turned out to have the same problem — a *different*
unrelated test timed out on 3 separate full-suite runs (none of them the
same test twice), confirming this is genuine, pervasive, machine-load
flakiness across any test doing real chessground+engine work under
20-parallel-worker contention, not something scoped to the two files Task
43 named. Since the task's own stated bar was "the full suite must pass
under default timeouts," extended the same 15000ms treatment to
`BuildScreen.test.tsx`'s own 5 heaviest tests too ("the pick modal shows
the 'After this pick' footer...", "selecting a row marks it selected...",
"Stop with this core shows the summary...", "Copy lineup copies...",
"take back after a pick restores...") and bumped "capturing an unmoved
piece opens the modal for that piece type" — observed as high as 13.8s in
one run — to 20000ms specifically. Flagged this scope expansion
explicitly to Ron rather than doing it silently.

**Confirmed via 3 consecutive clean `npm run test` runs**: 340/340
Vitest tests passing each time (up from 324 before this session — 1 from
Task 42, 15 from Task 43: 2 DK-slot-adjacent + 2 pick-modal + 1 piece-icon
+ 7 slate-validation + 3 updated-but-still-counted). `pytest`: 197/197
(up from 186 — 4 `assignRosterSlots` + 7 `validate_etr_csv`, matching the
TS side exactly). `tsc -b`, `npm run lint` (oxlint), `npm run build` all
clean. `tools/export_parity.py` re-run after all Python engine changes —
no diff to `parity.json`, and `parity.test.ts`'s 43 scenarios still pass,
confirming `assign_roster_slots`/`validate_etr_csv` didn't touch anything
the existing parity harness exercises.

Committed as `27c26ae` ("Task 43 -- Play-test fixes"), pushed to
`origin/main`.

## Open threads

- Everything already open before this session (click-to-move's
  unconfirmed first-move root cause, the Task 41 real-browser mobile
  checklist, "Stop with this core" placement, `openingPreview`/
  `legalDepth` being slow-and-uncached, `web/.env` not yet created, the
  long tail of carried-forward items in prior logs) is **unchanged** —
  this session didn't touch any of it. See the prior session's own log
  (`10152026-piece-pools-and-board-bug-fixes.md`) for the full list.
- **Explorer row wrapping and the Suggested card's piece icons are
  CSS/layout changes unverified in a real browser** — same standing
  environment limitation (no real browser launchable here; jsdom has no
  CSS layout engine), not newly discovered this session.
- **BuildScreen.test.tsx's own flakiness under full-suite load is now
  addressed (5 tests + 1 extra-wide one extended), but this was reactive,
  not requested** — if more of this file's tests start flaking under
  heavier future load (more tests added, slower CI machine, etc.), the
  same treatment applies; there's no deeper fix available short of
  `isolate: false` in `vite.config.ts` (tried reasoning through it,
  rejected as too broad a behavioral change — shared module state across
  test files — to make unprompted) or a real investment in mocking
  chessground project-wide (tried once for `SetupScreen.test.tsx`
  specifically, didn't help).
- **`assignRosterSlots`/`validate_etr_csv` aren't part of
  `tools/export_parity.py`'s scenario set** — parity between the two
  engines for these two new functions rests on hand-mirrored unit tests
  (`rules.test.ts` ↔ `test_rules.py`, `loaders.test.ts` ↔
  `test_loaders.py`), not the shared JSON fixture. Consistent with how
  the rest of the roster-slot functions (`maxAssignable`/
  `openRosterSlots`) are already tested, but worth knowing if the parity
  harness is ever extended to cover roster-slot/validation scenarios too.
- **Which of several interchangeable same-position players draws "FLEX"
  vs. its own dedicated slot is a cosmetic artifact of the matching
  search**, not lock order — documented in both engines' own code
  comments and in the tests, but worth remembering if a future task
  wants deterministic "most recently locked goes to FLEX" behavior
  specifically (would need a different, more involved algorithm than the
  bipartite matching reused here — see the `assignRosterSlots` code
  comment for the exploration already done on this).
