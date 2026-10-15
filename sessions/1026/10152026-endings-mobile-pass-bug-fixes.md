# 10152026 — Endings, mobile pass, and three production bugs

## Context

Session opened on `sessions/HANDOFF.md` as left by the prior session, which
ended mid-Task-39 with the work implemented but uncommitted. First order of
business was confirming that, then Ron relayed two more planned tasks (40,
41) in sequence. Partway through Task 41's investigation, Ron also dropped
three live bug reports — found while he was actually running the app against
a real-world slate — as mid-turn interrupts; each was triaged and fixed
before returning to the task in progress, per this session's own read of
"address the message as you continue this turn."

## What was done

### Task 39 confirmation (commit `6c63ee3`)
HANDOFF.md and `git log` disagreed: the handoff described Task 39 as done,
but no commit existed for it, while `git status` showed a full, passing
implementation sitting uncommitted (castling two-step picks, capture
transfer/unmoved-capture flows, pick-modal greying, Explorer variation
drill-down — 6 new BuildScreen tests, 1 new SetupScreen test). Verified via
full test runs (281 Vitest, 180 pytest, all green) rather than trusting
either source, then committed and pushed on Ron's confirmation.

### Task 40 — Endings and start again (commit `5868baa`)
Implemented all four build endings (Stop with this core, dead end for
either side, lineup complete) entirely from already-exported engine
primitives — `checkWhiteDeadEnd` (build.ts) and `isLineupComplete`
(rules.ts) already existed and already did the right thing; Black's dead
end was already modeled as a thrown error from `playBlackMove`, mirroring
`cli.py`'s own `except RuntimeError` catch. No engine changes were needed
for this task.

- New `Ending` union + `FinishCard` component replacing the board-column's
  controls (status line/board/book-continues/take-back) on any ending.
- "Take back": a `pastStates` stack pushed once per White commit; popping
  one entry undoes White's move AND whatever Black replied with, in one
  step, since both are simply the later state being discarded.
- "Leaving the book": a sticky `bookExitDismissed` flag swaps the normal
  Book-continues panel for a "Continue, or start again?" prompt once
  `continuationOptions` goes empty; playing any move while it's showing
  counts as an implicit Continue.
- `SetupScreen`/`App.tsx` gained `initialPresetIndex`/`initialKingMode` and
  `onStartAgain`/`onNewContest` plumbing so "Start again" can reopen setup
  pre-filled with the same contest + King mode.
- Flagged to Ron as assumptions (not spec'd verbatim): the "stopped"/
  "complete" headline text, the finish card living alongside (not
  replacing) the You/Field columns, and the header Start-again confirm
  wording.

### Bug 1 — pick modal selection showed no visible change (part of `5b37d6b`)
Ron reported the selected row had no visible accent treatment, the footer
didn't name who was selected, "Lock player" was enabled by default with
nothing clicked, and greyed rows could still be selected. Root cause:
Task 39's PickPanel pre-selected the top feasible candidate by default,
which was the opposite of what the design mockups
(`design/4-club-build-pick.png`, `6-slate-build-pick.png`) show. Fixed:
`selectedId` now starts `null`; `.pick-row.selected` gets
`background: var(--accent-bg)` alongside its existing border; the footer
now reads "Selected: `<player>` · After this pick: ..."; infeasible rows
are now `disabled` buttons, not just styled dim. This had a large ripple
through `BuildScreen.test.tsx` — roughly 14 existing "click Lock player
immediately" call sites all needed a `selectTopRow()` helper call inserted
first, since none of them could rely on a default selection anymore.

### Bug 2 — Black's reply crash mislabeled as a dead end (part of `5b37d6b`)
Ron reported a specific build (London System, 1. d4, White locks Xavier
Worthy) ending with "Black has hit a dead end." despite Black having 0
players and a full $50,000 cap — something he correctly identified as
impossible. Investigated hard at the engine level first: 5,400+ direct
`playBlackMove` trials (every real contest preset × 300 seeds, Knight-band
TE players removed from the pool) plus a SAN-matching check between the
book and chess.js, all clean, zero throws — `chooseBlackCommittedLine`
already filters book continuations by DFS-playability before ever
committing to one, so the "re-choose instead of throw" behavior Ron asked
for was, on paper, already correct for every scenario constructible from
the vendored sample data.

What *was* a real, independently-findable bug: `BuildScreen.tsx`'s
`scheduleBlackReply` treated **any** exception from `playBlackMove` as a
dead end, with no way to distinguish a genuine "no legal move" condition
from literally anything else going wrong. Fixed by giving `playBlackMove`'s
one deliberate dead-end signal its own exported class,
`NoLegalBlackMoveError` (`engine/build.ts`), and having the screen branch
on `instanceof` instead of blanket-catching: only that specific error ends
the build; anything else sets a new `blackMoveError` state, surfaces as
"Something went wrong: `<message>`" in the status line, and leaves the
build alive with Take back still available (cleared on the next commit or
take-back). This fix is correct and valuable independent of root cause —
it means a future occurrence of this exact symptom will show the real
error instead of a misleading message.

### Bug 3 — the actual root cause: `DK_ID` column assumption (commit `58476dd`)
Ron came back with the real repro file, `data/samples/repro-slate.csv`
(268 players, deliberately not committed). Its header has a plain `id`
column, no `DK_ID` at all. Both `loadEtrCsv` (TS) and `load_etr_csv`
(Python) hardcoded `row["DK_ID"]`/`row[column_map["id"]]` as the id source
— confirmed directly against the real file: `loadEtrCsv` gave all 268
players the identical `undefined` id (Python's `csv.DictReader` would
raise `KeyError` instead, a different failure mode but the same root
cause). The instant White locked one player, `BuildState.lockedPlayerIds`
held that one shared id, and *every other player* — despite being
genuinely unlocked — read as "already locked" too, since they all shared
it. The pool was never actually depleted; it just looked that way to
`resolvePlayers`/`eligibleUnlocked` from the very first lock onward.

Fixed in both loaders: fall back to a plain `id` column when `DK_ID` is
genuinely absent from the file's own header row (not just empty for one
row — checked via `papaparse`'s `meta.fields` in TS,
`csv.DictReader.fieldnames` in Python). Verified directly against the real
`repro-slate.csv`: Black now correctly replies `Nf6` on the London System
line — Ron's own original hypothesis about the move, it turns out, just
not the mechanism. Added minimal fixture-based regression tests (not the
real slate, per instruction) in both `loaders.test.ts`/`build.test.ts` and
`test_loaders.py`/`test_build.py`.

### Task 41 — Mobile pass (commit `cf24f7f`)
"No engine changes; no new features" — all CSS/markup. Found and flagged
one real constraint before writing any tests: jsdom (this whole project's
test environment) runs no CSS layout engine at all —
`getBoundingClientRect`/`offsetWidth`/`scrollWidth` are always 0 regardless
of the actual stylesheet, and `getComputedStyle` never evaluates `@media`
queries (verified directly with a throwaway experiment: a
`@media (max-width: 430px)` rule's override never showed up in
`getComputedStyle`'s output no matter what `window.innerWidth` was set to).
Per CLAUDE.md's "never use AskUserQuestion" rule, asked inline rather than
through the tool (caught and corrected mid-question); Ron chose: do the
real responsive work, write tests that check the *mechanism* rather than
pixels, state plainly in each test what it does and doesn't prove, no new
dependencies (ruling out a real Playwright-backed browser runner, which
likely couldn't launch in this environment anyway per earlier sessions'
own documented gap).

Changes:
- **Setup**: `.setup-card select` now `width: 100%` (was sizing to its
  widest option's own text — several contest names are long enough to
  force the card wider than 360px); `.explorer-row button` gained
  `min-width: 0` (a long opening/variation name could otherwise force the
  row, and the page, wider); tier chips (`.chips`) switch from wrapping to
  `overflow-x: auto` + `flex-wrap: nowrap` under the existing 760px
  breakpoint.
- **Build**: "Stop with this core" physically moved from inside the You
  card to `board-column`, grouped with Take back in a new
  `.build-controls` row — Task 41's own explicit order (status line,
  board, Book continues, Take back / Stop, then You, Field, Player |
  Field) has no way to place a child of the You card's grid cell ahead of
  that cell as a whole, so the control itself had to move; this changes
  its position on *every* width, not just mobile, since the two tasks'
  instructions otherwise conflict (flagged to Ron). The board's old mobile
  override (`max-width: 320px`) is gone — narrower than most actual phones
  (375/390/414/430px), it was leaving visible side gutters on anything but
  exactly 360px; removing it lets `BuildBoard.css`'s own
  `width: 100%; aspect-ratio: 1` do "full width, square" correctly, capped
  by `board-column .build-board`'s existing unconditional 420px ceiling
  (which never binds at phone widths, only keeps a single-column tablet
  view from blowing the board up huge). The finish screen's 5-column core
  table is now wrapped in `.finish-core-scroll { overflow-x: auto }` so it
  scrolls internally rather than widening the page.
- **Pick modal**: already a bottom sheet from earlier work (Task 38b);
  hardened rather than rebuilt — `.pick-row-list` gained `min-height: 0`
  (a flex-column child needs this to actually respect its own
  `max-height` instead of forcing its parent taller), `.pick-modal` gained
  `overflow-y: auto` on mobile as a belt-and-suspenders guard, and the
  numeric columns (`salary`/`proj`/`own`) shrink from `minmax(0, 72px)` to
  `minmax(0, 54px)` under 760px so the name column — the one that actually
  needs room — isn't squeezed to ~50px.
- **Board**: touch drag and tap-to-move both already work via
  chessground's own defaults (`draggable.enabled`/`selectable.enabled`,
  neither overridden in `BuildBoard.tsx`, and chessground's own source
  comment confirms it already defaults to tap-tap on touchscreens) —
  verified by reading chessground's `state.ts` defaults, not modified.
- **Touch targets**: already ≥44px app-wide via a pre-existing global
  `button, input:not(radio/checkbox), select { min-height: 44px }` rule in
  `index.css` (its own comment already states this intent) — verified,
  not modified, since nearly every interactive control in this app is a
  real `<button>`/`<input>`/`<select>` element already covered by it.
- **Engine-level test**: a hand-built `BuildState` with all 9 White roster
  slots filled (QB, 2 RB, 3 WR, TE, FLEX, DST) asserts
  `isLineupComplete(...)` is `true` — no UI click-through, per the task's
  own instruction (and BuildScreen has no prop for injecting a pre-built
  state anyway, so a UI-rendered version wasn't even possible).
- **New tests** (`web/src/responsive.test.tsx`, 11 tests): two kinds,
  clearly labeled which is which in the file's own header comment. (1)
  Real DOM-structure checks via actual rendering — e.g. the pick modal's
  footer is asserted to be a true sibling of `.pick-row-list`, never its
  descendant, which is a tree fact jsdom gets exactly right regardless of
  its layout limitations. (2) Stylesheet-source checks — reading the
  `.css` files as plain text and regex-matching for the specific rules
  added above, scoped to one rule block at a time via a `ruleBlock()`
  helper. Sanity-checked the source-based ones are not false positives by
  temporarily reverting the `.setup-card select` fix and confirming the
  corresponding test actually fails, then restoring it (caught a
  collateral-damage `sed` mistake that also broke two unrelated
  pre-existing `100%` rules in the same pass — fixed before it reached any
  commit).

## Open threads

- **No real-browser verification of Task 41** — explicitly out of reach in
  this environment (jsdom only, no GUI/audio libs for a real browser
  either — same gap noted in prior sessions). Gave Ron a concrete by-eye
  checklist at 375px, both themes: Setup screen single-column + chip
  scroll + no horizontal scrollbar; Build screen's top-to-bottom order and
  full-width square board; pick modal docking to the bottom edge with the
  footer staying visible while scrolling; finish screen and How-it-works
  strip not forcing page-level horizontal scroll; general touch-target
  feel.
- **"Stop with this core" now sits in the same place at every width**, not
  just mobile — Task 41's explicit ordering left no clean way to keep
  Task 40's "under the You card" placement at desktop while also
  satisfying the mobile order, so the control moved everywhere. Flagged,
  not confirmed with Ron either way.
- **Bug 2's engine-level root cause was never actually found** independent
  of Bug 3 — the extensive sweep (5,400+ trials) found the *current*
  "re-choose instead of throw" logic already correct for every TE-depleted
  scenario constructible from the vendored sample data. It's entirely
  possible Bug 2's original report and Bug 3's `id`-collision bug were the
  *same* incident described two different ways (Bug 2 came first, before
  Ron had isolated the real slate as the cause) rather than two distinct
  bugs — not confirmed either way, and not worth more engine-side digging
  unless a *new*, still-unexplained throw shows up now that both the
  mislabeling (Bug 2's own fix) and the id-collision (Bug 3) are fixed.
- **`data/samples/repro-slate.csv` stays on disk, untracked** — 268-row
  real DK export, deliberately not committed per Ron's own instruction.
  Verified it's excluded from every commit this session; it also gets
  synced into `web/src/data/samples/` by `npm run build`, but that whole
  directory is already gitignored (`web/.gitignore`'s `src/data` entry),
  so that copy was never at risk either.
- Everything else carried forward unchanged from prior handoffs:
  chessground's GPL-3.0 licensing undecided, the Monte Carlo sim port
  still needed, `VITE_ADMIN_PASSWORD` still unset, `openingPreview`/
  `legalDepth`'s ~49ms/call cost still uncached at the engine level — see
  `sessions/1026/10142026-task-38b-match-designs-clarity-polish.md` and
  earlier logs for the full backlog.

Final counts this session: 303 Vitest passing (was 255 at session start),
182 pytest passing (was 180 at session start — Bug 3's two new tests are
the only Python changes all session).
