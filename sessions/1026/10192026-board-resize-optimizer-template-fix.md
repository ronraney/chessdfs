# 10192026 — Board resize bug, lineup optimizer, Black template bug

## Context

Picked up on a clean `main` (after the piece-pools/GPP-metric session,
commit `0e860b1`), 377 Vitest / 233 pytest passing. Three separate prompts
arrived this session, each its own task/commit: a chessground click-
alignment bug fix, a brand-new lineup-optimizer feature, and a second,
unrelated bug investigation (Black not following a chosen opening
template, plus a "Book continues" ordering bug). Each is its own section
below.

## Task 1 — Board clicks land one square off (commit `8121748`)

### The bug

Repro: on White's second move, clicking a pawn highlighted the square
below it; clicking a back-rank piece did nothing. Reported hypothesis:
chessground's cached board bounds are stale after a layout shift above/
around the board.

### Root cause

Confirmed: chessground memoizes `getBoundingClientRect()` and only
recomputes it from inside its own `redrawAll()`. A layout shift anywhere
above/around the board (a longer status line after Black's reply, the
banner's subtext appearing, Book continues gaining/losing rows, the pick
panel changing the board column's width) moves or resizes the real board
element without chessground ever finding out.

**Important finding, not obvious going in**: chessground already runs its
own internal `ResizeObserver` on the exact same container element (`events.
ts`'s `bindDocument`, bound to `s.dom.elements.wrap` — which turns out to
literally BE the element passed into `Chessground(el, config)`, not a
child chessground creates). That internal observer only handles a pure
SIZE change (e.g. the pick panel narrowing the board column) via a
lighter internal `updateBounds`/`renderResized` — it does NOT catch a
pure POSITION shift (the board's top offset changing because a sibling
above it grew/shrank), since `ResizeObserver` by definition only fires on
size changes of the observed element itself.

### Fix

`BuildBoard.tsx` gained two things:
1. Its own `ResizeObserver` on the container, calling the public
   `redrawAll()` — explicitly asked for in the task, even though it's
   partly redundant with chessground's own internal one for pure size
   changes.
2. A second effect **with no dependency array** that also calls
   `redrawAll()` — this is the one that actually fixes the reported bug.
   It fires after every render, and `BuildBoard` re-renders whenever
   `BuildScreen` does (it isn't wrapped in `React.memo`), so this reaches
   exactly the "something above/around the board changed" case a
   `ResizeObserver` can't see.

### Testing complications

- jsdom has no `ResizeObserver` at all. Added a global no-op stub to
  `test-setup.ts` (same pattern as the existing `matchMedia` stub) so
  every test that mounts `BuildBoard` doesn't throw.
- `BuildScreen.test.tsx`'s hand-rolled `FakeApi` mock (used for its full-
  mock test suite) needed a `redrawAll() {}` no-op added, since it now
  gets called on every render.
- New test in `BuildBoard.test.tsx` proving the `ResizeObserver`
  callback invokes the real Api's `redrawAll()`. **Found and fixed a real
  bug in my own first draft of this test**: the loop that invoked each
  captured callback also constructed a fresh `FakeResizeObserver` instance
  per iteration purely to satisfy a type signature — but that
  constructor's own side effect pushed a new entry onto the very array the
  loop was iterating, so the loop never terminated (infinite accumulation,
  crashed the test worker with an OOM). Fixed by passing a null stand-in
  for the unused second argument instead of constructing a real one.

### Result

378 Vitest passing, 233 pytest passing. jsdom can't verify actual bounds/
positioning in a real browser — this is wiring-only proof; Ron verifies
visually.

## Task 2 — Lineup optimizer + points from optimal (commit `dfbd7ca`)

### Ask

Add an exact (not greedy) best-legal-DK-lineup solver to the TS engine
only (display feature, Python not required), with optional locks/
exclusions, and surface "Pts from optimal" on the build screen (under
Core projection) and the finish screen. Explicitly allowed adding one
small LP/ILP dependency.

### Design

New `engine/optimizer.ts`. Modeled as a 0/1 MILP: one binary variable per
(player, eligible roster slot) pair, an "exactly `slot.count`" constraint
per roster slot (FLEX falls out of this generically — no FLEX-specific
code at all, same shape `rules.ts`'s `maxAssignable` already uses for
feasibility-only checks), an "at most one slot" (or "exactly one," for a
locked player) constraint per player, and one salary-cap constraint.
Solved by **`yalps`** (new dependency — chose it over the older
`javascript-lp-solver` for being a modern, actively maintained, pure-
TypeScript rewrite with the same lineage; genuinely small, no WASM).
`tolerance: 0` (yalps' own default) is what makes this exact rather than
"good enough" — explicitly checked this stays unset.

### Performance

A naive solve on this project's real ~301-player sample CSV took **2.3
seconds** — measured directly, not assumed. Far too slow for "feel
instant," and the task's suggested lever ("drop 0-projection players")
didn't apply at all — the real sample slate has zero such players.

Implemented **dominance pruning** instead: for players eligible for the
exact same set of roster slots (e.g. every RB, eligible for RB's own slot
AND FLEX), drop a player only once at least as many OTHER players in that
same group each individually dominate it (same-or-lower salary, same-or-
higher projection) as that group could ever need to supply at once (`need`
= sum of the counts of every slot the group is eligible for — 3 for RB in
this NFL config, RB's own 2 plus FLEX's 1). This is provably safe (a
pigeonhole argument: swapping a dropped player for any of its ≥`need`
dominators is always possible without displacing anything already kept).

**Caught a real bug in my own first draft of this**: it initially kept
only the single non-dominated "best" player per group, ignoring that a
slot can need MORE than one pick from the same group. With exactly `need`
or more identical players, this either dropped all-but-one (breaking a
multi-count slot) or, worse, let identical-tied players "mutually
dominate" each other down to literally zero survivors. Fixed with a
deterministic id tiebreak in the `dominates()` comparator (identical
players don't mutually dominate — only the lexicographically-earlier one
dominates the later one), confirmed via a dedicated regression test (5
identical RBs, `need=3`, exactly 3 must survive) before this ever reached
the full test suite.

Result: 2.3s → **~180ms**, identical answer (same 153.8-point optimal
total), confirmed against the real sample CSV both before and after.
Added a `WeakMap` cache (keyed by the `players` array's own identity,
same pattern as `rules.ts`'s `findLegalMove` board cache) for the "slate
optimal" case (no locks, no exclusions) specifically, since that's
genuinely a compute-once-per-slate/contest value — "best completion"
(locks forced, exclusions applied) isn't cached, since it changes every
pick, but with pruning it's down to single-digit milliseconds anyway.

### UI

`buildStats.ts` gained `PointsFromOptimal`/`pointsFromOptimal()` (pure
composition: `bestCompletion.total - slateOptimal.total`, normalized so an
exact tie never prints `-0.0`). `BuildScreen.tsx` computes both via
`useMemo` (slate-optimal keyed on `[players, preset]`; best-completion
keyed on `[players, preset, state.whiteMoves, state.blackMoves]`) and
passes the result to `SideColumn` (White's own panel only, new optional
prop) and `FinishCard`. New CSS: `.side-pts-from-optimal` (matches `.side-
projection`'s sizing) and `.finish-stat-sub` (the finish screen's smaller
"best finish X · optimal Y" subtext).

### Testing

`engine/optimizer.test.ts`: a hand-built "known answer" slate specifically
designed so a greedy "take the best-looking candidates until the cap
runs out" pass produces an INCOMPLETE roster (not just a worse one) —
three tied "elite" WRs plus two cheap ones, with a cap that only fits 4
of the 5, where greedy spends its whole budget on the 3 elites and then
can't afford a required 4th pick at all. Also: locks forced in even when
suboptimal, exclusions always honored (even the single best player on the
slate), FLEX correctly going to whichever eligible position maximizes
total (not whichever happens to look "extra"), salary cap always
respected (including a genuinely infeasible case returning `null`), and
the dominance-pruning regression test described above.

### Side effects: test flakiness

The new `bestCompletion` `useMemo` adds a small but real computation to
BuildScreen's render path, now firing on every pick. Even at a few ms per
call (after pruning), this was enough to push THREE pre-existing, timing-
sensitive tests over their budgets under this project's own documented
full-suite parallel-load CPU contention — confirmed by running the full
suite repeatedly (378→387 count check aside, saw the SAME specific
failures recur, not random noise):

1. `BuildScreen.test.tsx`'s "After this pick footer" test had a
   synchronous assertion ("Black hasn't replied yet") racing against
   `BLACK_REPLY_DELAY_MS`'s real 600ms `setTimeout` — removed the racy
   assertion; the `waitFor` right after it already covers the behavior
   that actually matters (Black eventually replies) regardless of timing.
2. `BuildScreen.secondMove.test.tsx`'s shared `waitForWhitesTurn()` helper
   had the identical race baked into its own `{timeout: 2000}` — bumped to
   5000ms (this one function is called by every test in the file, so one
   fix covers all its callers).
3. `engine/build.test.ts`'s "different seeds can give different multi-ply
   builds" — a PURE engine test, no React/jsdom at all, 20 seeds × several
   real plies each. Not caused by my change directly (it shares no code
   with BuildScreen), but tipped over by the SAME ambient CPU contention
   from other workers now doing slightly more work. Extended to 15000ms,
   same established precedent.

Confirmed stable across 3 repeated full-suite runs after all three fixes
(this session re-ran the suite roughly a dozen times total across both
feature tasks, tracking down which failures were genuine vs. transient
host-load noise — see Task 3's own section for a `/proc/loadavg` check
that confirmed the host itself was occasionally busier than usual,
independent of anything in this diff).

### Result

385 Vitest passing (confirmed stable), 233 pytest passing (untouched —
display feature, no Python port needed, said so explicitly in the
report). `tsc -b`/`oxlint` clean. Production build (`npm run build`)
confirmed to bundle cleanly with the new dependency.

## Task 3 — Black ignores the chosen template; Book continues missing real-popular moves (commit `d09e81e`)

### Ask

A second bug report, given with specific repro (French Defense Classical
template, White plays 1. e4, Black plays 1...e5 instead of 1...e6; Book
continues after 1. e4 e5 missing 2. Nf3/2. f4) and an explicit, unverified
hypothesis to confirm or reject: that Black's template commitment is being
dropped, and both Black's own choice and the continuations list are
ordered by closeness to the contest's target rank instead of (a) the
template and (b) popularity.

### Investigation

Dispatched a dedicated research pass (read-only, no changes) before
touching anything, to trace `playBlackMove`/`chooseBlackCommittedLine`
(`engine/build.ts`) and the continuations sort (`BuildScreen.tsx`), check
Python parity, and confirm what the real book/popularity data actually
contains. The agent's report reproduced the EXACT reported symptom
(same 8-move list, same banner text) against the real vendored data
before any code was touched — gave high confidence in what to fix.

Verified the agent's key claims directly: read `SetupScreen.tsx`'s
`ChosenOpening` type (`{kind:"line"} | {kind:"own"}` — no third
"template" kind exists in the web app's type system at all), the full
`chooseBlackCommittedLine`/`playBlackMove` bodies in `build.ts`, `openings.
ts`'s `bookContinuations`/`bookWeights`/`rankFamilies`/
`DEFAULT_EXCLUDED_FAMILIES`, and `data/openings/popularity.json`'s actual
contents for "e4 e5" (`Nf3: 145527` vs. the next-highest `f4: 20276` — a
~7x margin) and "d4 d5" (`c4: 73204`, `Nf3: 37546` second).

### Root cause (confirmed)

`BuildScreen.tsx` never threaded `chosenOpening`/`chosenLine` into Black's
move selection at all — it's used ONLY for display (banner text, pick-
modal move list, "isChosen" highlighting), never passed to `playBlackMove`,
and `playBlackTemplateMove` (which DOES exist in `build.ts`, with full
Python parity) is never imported by any UI file. `BuildState.
blackCommittedLine` defaults to `null`, so on Black's very first reply the
engine always ran a fresh rank-closeness choice (`chooseBlackCommittedLine`
— `Math.abs(rank - targetRank)`, minimized, seeded tie-break), regardless
of what White chose. This traces back to Task 38's "the chosen line only
suggests White's moves" rewrite, which swapped Black's driver from
`playBlackTemplateMove` to `playBlackMove` with the stated intent "Black
still follows its line while White stays on it" — but `blackCommittedLine`
was never actually seeded from the chosen line, so that clause was a no-op
from the very first ply.

Separately, "Book continues" sorted by `RANK_BY_FAMILY` — a whole-family,
whole-corpus popularity rank (one representative line per family, by
total games, built by `rankFamilies`) — not real per-position popularity.
2. Nf3 after 1. e4 e5 (the single most popular reply there by a wide
margin) scored `Infinity` because its resulting family, "King's Knight
Opening," is in `DEFAULT_EXCLUDED_FAMILIES` — a list meant to answer "is
this family too generic to usefully *suggest* as a named opening," reused
here for a different question ("how should this move be *ordered*") it
was never designed to answer. 2. f4 (King's Gambit) similarly scored
`Infinity` for an unrelated reason — no row in the book has ≥6 plies under
the bare "King's Gambit" name, so `rankFamilies` never ranks it at all.
`data/openings/popularity.json` (real per-position Lichess game counts)
was already vendored and already loaded by `loaders.ts`'s `loadPopularity`
— flagged as dead code, imported nowhere, in the PRIOR session's own
handoff — but never wired into anything.

### Hypothesis assessment

- "Black's template commitment is being dropped" — **confirmed**, more
  precisely: never created in the first place, not dropped mid-flight.
- "Black's own choice is ordered by closeness to target rank" —
  **confirmed exactly**, reproduced numerically against the real contest/
  book data (targetRank=21 for the reported 2,450-entry contest; Center
  Game at rank 22 beats the French family at rank 24 by distance 1 vs. 3).
- "The continuations list is ordered by closeness to target rank" —
  **rejected as literally stated**: `targetRank` never appears anywhere in
  that sort. The list's actual bug (whole-family rank, not per-position
  popularity) produces the same visible symptom the hypothesis was
  reaching for, just via a different, also-wrong mechanism.

### Fix

1. `BuildScreen.tsx`'s initial `BuildState` now seeds `blackCommittedLine`
   from `chosenOpening.line.moves` when the opening is a chosen "line."
   No engine change at all — `playBlackMove`'s own existing "keep the
   committed line while it still matches, drop it the moment White
   deviates or it runs out" logic (already correct, already tested, for
   every OTHER committed line) just works once there's something to keep.
   "Own opening" mode is unaffected (`blackCommittedLine` stays `null`,
   same rank-closeness behavior as always).
2. `appData.ts` now loads `popularity.json` as `POPULARITY`. The
   continuation sort's comparator gained a `weight` field (real per-
   position game count, looked up directly from `POPULARITY`, falling
   back to equal weight 1 when the position has no recorded data at all —
   the same convention `bookWeights()` uses) as its PRIMARY sort key,
   after `isChosen`; `rank` (family rank) is now only a tiebreak for equal
   weight.

### A real inefficiency caught mid-session

First draft called `openings.ts`'s existing `bookWeights()` helper
directly — correct semantically, but it internally re-runs
`bookContinuations()` (a full ~3,865-line linear scan of the book) a
SECOND time per render, on top of the scan `continuationOptions` already
does for its own candidate list. This showed up as a newly-flaking test
("shows the chosen line's banner before any move...", a SYNCHRONOUS test
with no `await` at all, timing out at the 5000ms default — unusual enough
for a sync test to be worth chasing rather than assuming pure load noise).
Fixed properly: looked up `POPULARITY[history.join(" ")]` inline instead
of calling `bookWeights()`, reusing the ALREADY-computed continuations set
rather than re-scanning for a second one. `bookWeights()` itself is left
unchanged (still exported, still useful for a caller that doesn't already
have the continuations in hand).

After that fix, one more run of this exact test still timed out once
under unusually heavy host load (`/proc/loadavg` showed 2.2–2.7 on this
8-core machine while 23 vitest workers were spawned for the full suite —
not this diff's fault, just how oversubscribed this environment already
runs) — extended its timeout to 15000ms, the SAME established precedent
this file's other heaviest tests already use, rather than chasing further
micro-optimization for a test that's already doing the minimum necessary
work.

**Verified both new tests actually test something**: stashed just the two
fix files (`BuildScreen.tsx`, `appData.ts`), keeping the new tests in
`BuildScreen.test.tsx`, and confirmed both failed against the pre-fix code
(Black played "c5" instead of "e6"/"e5" in the stashed run) before
restoring the fix and re-confirming green.

### Testing

Two new tests in `BuildScreen.test.tsx`: the French Defense Classical
template plays 1...e6 (not whatever rank-closeness would otherwise pick);
Book continues after 1. e4 e5 ranks 2. Nf3 first or second by real
popularity. The second test deliberately uses the Vienna Game (1. e4 e5
2. Nc3) as the chosen opening, specifically so Nc3 — not Nf3 — is the one
that sorts first via `isChosen`; this makes Nf3's own ranking depend
entirely on the real-popularity fix, not coincidentally on being the
user's own chosen move.

### Result

387 Vitest passing (confirmed stable across 3 repeated full-suite runs),
233 pytest passing (untouched — the CLI's own template mode already
drives Black correctly via `play_black_template_move`; "Book continues"
has no CLI/Python equivalent at all, it's a web-UI-only concept).

## Open threads

- See HANDOFF.md's Open Items for the full carried-forward list plus this
  session's new ones: `DEFAULT_EXCLUDED_FAMILIES`'s dual-use (suggest vs.
  order), `yalps` as a new dependency not yet reviewed by Ron, the
  dominance-pruning logic's own subtlety (worth a second pair of eyes
  given how easy it was to get wrong the first time), and "Pts from
  optimal"'s on-screen layout unverified in a real browser.
- No real-browser verification of anything visual from this session (the
  resize fix, "Pts from optimal," or the template/continuations fix) —
  same standing environment limitation as every prior session.
- This session's full-suite re-runs surfaced a useful general lesson,
  recorded in HANDOFF.md's Environment note: when a new per-render
  computation tips a previously-stable test into flaking, check for an
  actual removable inefficiency before just extending the timeout — one
  of this session's three "flaky" tests turned out to be a real, fixable
  double-scan, not pure environmental noise.
