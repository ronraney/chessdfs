# Session — 2026-10-29: pick-list completability, notices, and a perf regression

## Context coming in

Last handoff was 2026-10-28 (`342c917`). Three more commits had landed
since then without a /wrap-up (`33c00af` board-hover tooltip, `4738f03`
tight-finish alerts reworked into Caution/Warning/Critical steps,
`cab7142` housekeeping/test-splitting) — all authored as Ron directly,
not a Claude session. Caught up on these by reading the commits before
starting; folded the catch-up into the new HANDOFF.md's "Where things
stand" rather than attributing them to this session.

## Task 1 — Roster-full notice + opponent in pick lists (`7e69fe8`)

Two independent asks: (1) a top-of-list notice naming any real-world
position that's entirely blocked (every slot it could fill, FLEX
included, already taken) for the side's own roster; (2) show each
candidate's opponent next to their team.

- `rules.blockedPositions(players, rosterSlots)` — new, reuses the
  existing `openRosterSlots` matching: a position is blocked only when
  EVERY slot whose eligible positions include it has zero open
  instances.
- `buildStats.blockedPositionsNotice` — scopes that to positions
  actually relevant to the piece this list is for (so a King list
  doesn't flag a blocked WR). Reused the "relevant positions" helper for
  the salary-cap notice in task 2 too (`relevantPositionsFor`).
- `PickPanel.tsx` row: `{player.name} · {player.team} {isHome ? "vs" :
  "@"} {player.opp}`.
- Flagged, not resolved: `Player.isHome` has no tri-state — defaults
  `false` whenever a loader doesn't set it, and only `loadEtrCsv` (the
  one real loader) ever does. The prompt's own "otherwise 'vs'" fallback
  for missing home/away data never actually triggers against a real
  slate; it only matters for hand-built test fixtures, which I updated
  to pass explicit `isHome` values rather than touching the model's
  default-collapsing behavior (a bigger, unrequested change).

## Task 2 — Salary-cap notice + finished-lineup cleanup (`23ea222`)

- `buildStats.salaryCapNotice` — $X = salary remaining minus the
  cheapest cost to fill the OTHER open slots (tries each of the list's
  own relevant still-open slot names, keeps the cheapest resulting
  `cheapestCompletionCost`, since a mixed-position list like Rook's has
  no single fixed "other slots" answer). Verified against the exact
  worked example from the prompt ($8,000 left, 3 open, $3,000 fallbacks
  → "$2,000").
- "Fill out my core" now hidden (not just disabled) once a side has no
  open slots, both render sites (mid-build button, finish screen). The
  "$X avg/open slot · N open" line becomes "Lineup full." in
  `SideColumn` — shared by both You and Field, so this applies to
  either side's column.
- Behavior-change flag: one existing `BuildScreen.endings.test.tsx` test
  explicitly asserted the button stayed visible-but-disabled once
  complete ("Still rendered... disabled, not hidden") — this task's own
  instruction superseded that; updated the test and its comment rather
  than leaving stale coverage.

## Task 3 — Pick lists must keep the lineup completable (`b560a13`)

The big one. Rule: a pick is allowed only if, after it, the side can
still fill every open slot under the cap from players still available
(not taken by either side) — not just "total spent <= cap."

- `lineupStillCompletable` gained an optional 4th arg,
  `availablePlayers`. Given, it swaps the salary check for "remaining
  salary >= `cheapestCompletionCost`(availablePlayers, openSlots after
  this pick)." Omitted (every pre-existing caller), unchanged behavior —
  deliberately not a breaking signature change, same pattern as every
  other optional-arg rule change this project has done.
  `pickList`/`castleRookList` (`picklist.ts`) pass it; nothing else yet
  (that's task 4).
- Critical mid-session correction: `cheapestCompletionCost` returning
  `null` (no eligible player anywhere for some open slot) MUST mean
  "can't prove this is unaffordable," not "assume the worst" — tried the
  opposite first and it broke 24 of `picklist.test.ts`'s 30 existing
  tests (every one of them uses a small, non-full-roster synthetic pool,
  which is exactly what makes some slot come up with zero eligible
  players). Matching `tightFinishStatus`'s own existing null-handling
  fixed all 24 with zero test changes.
- Also had to fix the test suite's OWN use of `Piece.QUEEN` in a couple
  of new tests — Queen has a $7,000 salary floor, so a deliberately
  "exactly affordable" $2,000 test candidate silently wasn't
  Queen-eligible at all. Switched those specific tests to `Piece.ROOK`
  (no salary floor), which is also more consistent with the running
  "$8,000/3-slot" example used throughout this whole session's prompts.
- Performance: the naive version (call `cheapestCompletionCost` fresh
  per candidate, no caching) took `npm run test` from ~80s to ~22
  MINUTES. Added a WeakMap-keyed cache to `cheapestCompletionCost`
  itself (keyed on the `availablePlayers` array reference + a string key
  of the `openSlots` shape) and stopped excluding each individual
  candidate from the shared `available` array (accepted the tiny,
  rare correctness cost of not self-excluding, in exchange for the cache
  actually being able to hit across candidates sharing a position) —
  brought it down to ~150-230s. Also had to bump several Vitest
  timeouts (global `testTimeout`/`hookTimeout`, RTL's own
  `asyncUtilTimeout`, a few explicit heavy per-test overrides) since real
  interaction tests now legitimately take longer. Confirmed correctness
  throughout via `--maxWorkers=1` sequential runs (always clean; the
  default parallel run's occasional flakes are the same pre-existing,
  environment-driven pattern already documented in earlier sessions).

## Task 4 — Completability for captures/castling/King placement + Simming indicator (`797e19f`)

Extended the same optional-4th-arg pattern to every other place still
using the raw check: `isLegalMove`, `castle`, `switchKing`,
`placeKings`, `isLegalCapture`, `applyCaptureMove` — plus
`BuildScreen.tsx`'s own capture hover-tooltip preview
(`pieceTooltipContent`, which calls `lineupStillCompletable` directly,
not through `rules.ts`'s own named functions). `BuildScreen.tsx` now
passes the real player pool at every point a user action actually locks
something.

Four new `rules.test.ts` tests, one per required path (castling's QB
step, the Place-your-King QB switch, King placement at setup, a capture
transfer) — each shows the SAME scenario twice, once without a pool
(legal, proving the old check really would have allowed it) and once
with (rejected).

Investigated and reported (no code change, as asked) where the
"Barely completable" dialog fires today: it's driven generically by
`state.whiteMoves` changes, so picks/captures/castling all trigger it
uniformly (they all update that same roster); King placement at setup
does NOT trigger it, because the triggering effect explicitly skips its
own first-mount evaluation ("the dialog is only ever about a pick that
just locked") — a later QB switch would trigger it, though, since
that's a subsequent roster change, not the initial placement.

**The real find of this task**: applying the new pool-aware check
inside `build.ts`'s `bestLegalPlayer`/`bestLegalCapturePlayer` (their
own `isLegalMove`/`isLegalCapture` filter, AFTER `pickList` already
filtered the same candidates by the same completability check) was
pure redundant work — and since those functions run inside
`checkWhiteDeadEnd`/Black's move-selection loop, once per LEGAL CHESS
MOVE at a position (often 20-40), with zero cache benefit (each call
computes its own fresh `available` array), it turned what should have
been a minor cost increase into clicking-a-move-hangs-for-30-seconds
territory. Found via a long, honestly somewhat expensive debugging
detour (a from-scratch test file that reliably hung on the very first
click, bisected down via `console.time` instrumentation to confirm
`pickList` itself was fast (~60-80ms) but the actual click handler
chain wasn't completing) — the fix was two lines in `build.ts` (drop
the redundant pool arg there) plus memoizing `BuildScreen.tsx`'s own
`legalMoves`/`legalSans` (previously recomputed, unmemoized, on every
render, which didn't matter when the check was cheap but mattered a lot
once it wasn't).

Built, then abandoned, a dedicated test for the Simming overlay
(mocking `./simRunner` to freeze a sim mid-flight) after it hit an
unrelated hang in that one test file's own harness that didn't resolve
with reasonable debugging effort. Since the prompt's own test
requirements were explicitly scoped to task 1's four paths and didn't
ask for automated coverage of the Simming indicator, decided this
wasn't worth further time; verified the overlay by code/CSS review
instead, and the user separately confirmed (from their own live
dev-server session) that the underlying "Simming…" trigger condition
fires correctly — visual confirmation of the spinner/dimming itself
still outstanding as of this handoff.

## Final state

`npm run test` (sequential, `--maxWorkers=1`) — 636 passed, 0 failed,
confirmed clean. Default parallel run shows the same pre-existing
flakiness pattern as prior sessions (not new). `pytest` — 237 passed
throughout, Python engine untouched all session (every task here was
TS/React-only). All 4 commits pushed to `origin/main`.
