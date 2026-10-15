# 10142026 — Tasks 36–38: Club/Slate theming, then two build-screen reworks

## Context

Picked up later the same day as the Task 35 session (hidden admin screen,
upload removal) — that log and `10142026-tasks-31-34-opening-setup-and-
engine-speed.md` cover everything before this session. Starting state: 218
Vitest tests, 180 pytest, both suites clean, no theming, build screen still
the Task 32 placeholder ("Build — coming next"). Three tasks landed this
session, each a prompt on its own per CLAUDE.md, each committed and pushed
separately.

## What was done

### Task 36 — Two themes: Club (light) and Slate (dark)

Full CSS-variable rewrite in `web/src/index.css`: Club (light, default) and
Slate (dark) palettes, fonts (Cormorant Garamond/Source Sans 3/IBM Plex Mono
for Club; Space Grotesk/JetBrains Mono for Slate, loaded via Google Fonts
links in `web/index.html`), and board colors. `web/src/theme.ts` +
`ThemeToggle.tsx`/`.css`: an explicit choice persists in `localStorage`
(`chess-dfs:theme`); absent one, a `prefers-color-scheme` media block decides
(and keeps tracking the device setting live, since no `data-theme` attribute
gets written at all in that case) — `main.tsx` applies any saved choice
before the first render to avoid a flash. The toggle is a small
`<header class="app-header">` dropped into every existing screen (setup,
build placeholder, opening setup, admin — both its states).

Board checkering: chessground's own `chessground.brown.css` is overridden by
a `.board-preview cg-board` (later also `.build-board cg-board`) descendant
selector — a pure-CSS two-layer 45° gradient checkerboard driven by
`--board-light`/`--board-dark`, beating the imported stylesheet on
specificity regardless of import order.

Found and fixed a real contrast bug along the way: the pre-existing
hardcoded error-text color (`#d1374a`, fine against the old boilerplate's
plain white) measured ~4.2:1 against Club's new cream background and ~3.9:1
against Slate's near-black — both under the task's own 4.5:1 floor. Replaced
with a theme-aware `--danger` (Club `#B3261E` ≈5.7:1, Slate `#FF6B6B`
≈6.8:1, both WCAG-computed by hand). Also dropped genuinely dead Vite-
boilerplate CSS (`--code-bg`, `--social-bg`, `#social`, `code`/`.counter`
styling) — confirmed via grep that no JSX anywhere references any of it.

Tests: 226 Vitest (218 + 8: 5 `ThemeToggle`, 3 "toggle is present" smoke
checks on App/AdminScreen/OpeningSetupScreen). `tsc -b`, `npm run build`,
oxlint all clean. 180 pytest unchanged (no Python touched). Commit
`bcc1bca`, pushed.

Tried again to get real browser verification working (Playwright +
`chromium-cli`-style driver) rather than relying only on jsdom — same
`libasound.so.2` blocker as every prior attempt, confirmed via `apt-get
install --dry-run` (which itself failed: a Docker keyring conflict breaks
even the simulated package list) and a filesystem-wide `find` for the
library. No sudo in this environment. Still an open item.

### Task 37 — Build screen: layout and template play

First real build screen, replacing the placeholder. Both sides mechanically
played one chosen `BookLine` ply-by-ply: White's pick was an interactive
modal (`PickModal.tsx`, later renamed — see Task 38) listing
`buildStats.eligiblePlayers` (unlocked + `classify` match, ported from
`dfs_chess/cli.py`'s `_eligible_sorted`, deliberately *not* pre-filtered by
legality, same as that precedent); Black's was automatic via
`build.playBlackTemplateMove`. New `buildStats.ts` ports `_side_stats`'
formula (salary remaining, avg/open-slot, projection total, ownership sum)
exactly. Layout: three-column grid (You | Board | Field desktop; Board/You/
Field stacked ≤760px), top accent bars (`--accent`/`--accent-field`).

One real engine gap surfaced and was resolved with the user rather than
guessed around: the opening banner needs ECO alongside the live-updating
name, but `openings.openingName` only ever returned a bare string — and the
real book has multiple lines sharing an identical name at different depths/
ECOs (verified: "Ruy Lopez: Morphy Defense" exists at both C70, 6-ply, and
C78, 10-ply), so the name alone can't be traced back to an ECO without
duplicating `openingName`'s own matching loop in the UI. Asked; user chose
"add `openingLine(moves, book): BookLine | null`, have `openingName` call
it" over "just show the chosen line's fixed ECO throughout." Implemented
exactly that (zero behavior change to `openingName` itself) — no Python
port, as instructed. Added a ply-by-ply ECO test for the Morphy Defense line
per the user's own stated expectation (B00→C20→C40→C40→C60→C70) — but the
*real* vendored book has a dedicated 4-ply entry ("King's Knight Opening:
Normal Variation") at **C44**, not a second C40, so the test asserts the
verified-correct B00→C20→C40→**C44**→C60→C70 instead and says so in a
comment. Flagged the discrepancy rather than silently encoding either the
stated-but-wrong sequence or a silent fix.

Also flagged, not fixed: Club's theme variable `--accent-field` had no
second color in the Task 36 spec, so it just reused `--accent` there —
expected to be revisited (and was, immediately, in this same session — see
Task 38 below, which sets it to `#2F4A6B`).

Tests: 239 Vitest (226 + 13: 2 `openingLine` in `openings.test.ts`, 7
`buildStats.test.ts`, 4 `BuildScreen.test.tsx` — all against the real
vendored book/sample CSV, playing the real "Ruy Lopez: Morphy Defense" line
start to finish and asserting 3 White + 3 Black players locked). Clean
build/lint/types. 180 pytest unchanged. Commit `6e8757c`, pushed.

### Task 38 — Build screen: move first, then pick; openings suggest, not force

A real rule change, not just a UI rework: "in template mode the chosen line
only suggests White's moves; White may play any legal move. Black still
follows its line while White stays on it, and re-chooses per the engine when
White deviates." Investigated both of the task's explicit "stop and say
what's missing" triggers *before* writing any code, per its own instruction
— both turned out to already be fully supported:

- **White deviating from a "template":** not a gap at all. This is exactly
  `build.playBlackMove`'s own long-standing behavior (Task 13, `dfs_chess/
  build.py`'s original design) — Black commits to one book line while it
  keeps matching and re-chooses the moment it doesn't, entirely on its own,
  via `state.blackCommittedLine`. Swapped Black's driver from
  `playBlackTemplateMove` to `playBlackMove` and the whole "template"
  concept this screen needed just... stopped existing. No engine change.
- **Cancel / taking a move back:** also not a gap, because nothing needed
  undoing. Redesigned so a dragged move is never committed to the engine's
  `BuildState` at all until its pick is confirmed — the board shows a
  *preview* FEN (current committed state + the tentative move, via a
  throwaway `new Chess(state.board.fen())` clone, pure chess.js mechanics,
  no DFS logic) while the pick panel is open. Cancel just drops that pending
  move; the preview FEN snaps back to the real `state`'s FEN on its own.

Built: `buildFlow.ts` (`dfsLegalMoves` — chess-AND-DFS-legal, captures/
castling excluded outright per "not offered as legal targets" this task;
`chessMoveForSan`; `suggestionFor` — on-line-vs-book-continuation logic,
reusing `openings.bookContinuations`/`openingName`). `BuildBoard.tsx` — the
first *interactive* chessground wrapper in this codebase (existing
`BoardPreview.tsx` stays view-only, still used by the opening-setup
screen); White drags, `movable.dests` is computed every render from
`dfsLegalMoves`, Black's pieces are never draggable (`movable.color` fixed
to `'white'`; emptied `dests` is what actually disables interaction, not
toggling that). Suggestion arrow via `drawable.autoShapes`.

`BuildScreen.tsx` rewritten around this: arrives on an empty board with a
suggestion banner (the chosen line's next move + a "Play it" button while
still on it; book continuations by name once off it; nothing once truly out
of book); confirming a pick commits and schedules Black's reply 600ms later
(a real `setTimeout`, cleared/replaced on every commit and on unmount) via
`playBlackMove` plus one `SeededRandom` instance generated once per build
(`useState`'s lazy initializer, not `useRef`'s eager argument, specifically
to keep `Math.random()` from being called impurely on every render — oxlint
caught this on the first pass). The old "Line complete" placeholder is gone
entirely; play just continues past wherever the chosen line ends.
`PickModal` renamed to `PickPanel` (Task 37's full-screen overlay restyled
into a side panel on wide screens / bottom sheet ≤760px, per this task's
own wording), plus a new Cancel button.

Second bug fix, independent of the rule change: clicking a family row in the
opening-setup explorer did *nothing but expand/collapse* — there was no path
that called `onSelect` for a bare family click at all, so "choosing a
family" silently fell back to whatever was already selected. Fixed
`OpeningSetupScreen.tsx`'s `FamilyRow` to call `onSelect(family.line)`
(the representative line `rankFamilies` already guarantees, e.g. Morphy
Defense for Ruy Lopez) *and* toggle expand on the same click. New test
drives this for Ruy Lopez specifically, checking both the family click path
and "Play this" land on the exact 6-ply "e4 e5 Nf3 Nc6 Bb5 a6" line, not the
bare 5-ply "Ruy Lopez" book row.

Testing chessground drag-and-drop at all required mocking
`@lichess-org/chessground` outright (`BuildScreen.test.tsx`) — jsdom has no
real layout engine (`getBoundingClientRect` is always zeroed), so chessground's
own pixel-based drag detection is fundamentally unreachable in this
environment, same category of limitation as the Playwright/libasound.so.2
blocker, just for a different library. The fake `Chessground()` captures
whatever config `BuildBoard` passed it (critically `movable.events.after`,
the callback a real drop would eventually call) and a `simulateMove(orig,
dest)` helper invokes it directly — everything downstream (state, the pick
panel, Black's timed reply) is real, unmocked code. Covered all 5 scenarios
the task named: arrival with no pick list, "Play it" opening the panel, a
*non*-suggested legal move being accepted with Black replying after the
delay, cancel reverting the board's displayed FEN exactly, and suggestions
switching to book continuations after a deviation.

Also folded in this task, per its own bullet: Club's `--accent-field` (left
equal to `--accent` as a flagged placeholder in Task 37) is now `#2F4A6B` —
checked by hand: ~7.9:1 against `--bg`, ~8.5:1 against `--card`, both well
past 4.5:1.

Tests: 252 Vitest (239 + 13: 11 `buildFlow.test.ts`, 1 new
`OpeningSetupScreen.test.tsx` case, net +1 on `BuildScreen.test.tsx` after
replacing Task 37's 4 template-flow tests with 5 new move-first-then-pick
ones). Clean build/lint/types. 180 pytest unchanged. Commit `c272f0d`,
pushed.

## Open threads

- **Still no real browser verification of any screen.** Re-confirmed this
  session (Task 36): `libasound.so.2` is absent system-wide, no sudo, and
  even `apt-get`'s dry-run simulation fails on an unrelated Docker keyring
  conflict. Whoever next has shell/sudo access here should fix the
  environment, not re-attempt the same diagnosis.
- **chessground's GPL-3.0 license is still undecided** — carried forward
  unchanged for several sessions now; flagged again since the build screen
  now depends on chessground far more heavily (an interactive board, not
  just a preview).
- **No "Back" navigation exists anywhere on the build screen**, across both
  Task 37 and Task 38 — the old placeholder had one; neither task's spec
  mentioned keeping or dropping it. Flagged twice now, still unconfirmed
  either way.
- **Black having zero legal moves at all** (a genuine dead end) is caught in
  `BuildScreen.tsx`'s `commit()` and silently swallowed — the screen would
  just sit there with no further Black reply if this ever actually
  triggered. No UI for it; deliberately out of scope ("dead ends" is on the
  task's own excluded list), but worth knowing it's a silent no-op, not
  handled.
- **PLACED king mode's "silent King move while dragging" path has no
  dedicated test** — every Task 38 test uses EMERGE mode (matching the
  Morphy Defense line, which never moves a King). The code path exists
  (`BuildScreen.tsx`'s `handleBoardMove`, mirroring the same rule from Task
  37) but is unexercised by anything currently running.
- **Captures and castling for White are deferred on purpose** — Task 38's
  own wording: "next task adds them." Not a bug, just noting it's the
  obvious next build-screen task.
- **A new, untracked `design/` directory appeared** (Club/Slate build-screen
  mockup PNGs + HTML, with the same `:Zone.Identifier` sidecar files already
  seen on the sample CSVs) — looks like Ron's own reference material for
  planning these three tasks, not something this session created. Left
  alone, not committed; flagging its existence since it wasn't mentioned in
  the prompts.
- **The explorer's "choosing a family" test takes ~12–14s** (clicking "All"
  renders all ~85 ranked families, each paying `openingPreview`'s known
  per-row cost). Pre-existing performance characteristic, not something
  this session touched or should have fixed — same root cause already
  logged in `10142026-tasks-31-34-opening-setup-and-engine-speed.md`.
- Carried forward unchanged, same as every recent session: `web/.env` /
  `VITE_ADMIN_PASSWORD` still not created; admin login not persisted across
  reloads; the WSL/UNC environment needing `wsl.exe -- bash -lc "cd
  ~/chess-dfs/... && ..."` for every git/npm command; `openingPreview`/
  `legalDepth`'s ~49ms/call cost, uncached at the engine level;
  `cloneBoard`'s PGN-round-trip; the four centralized chess.js workarounds
  in `rules.ts`/`openings.ts`/`build.ts`; `build.ts`'s generic "illegal
  move" error (untested, no observed behavior difference from Python);
  the Task-20c numbering collision and the Scotch Game/King's Indian
  ranking question; `excluded_families` and the six tier-boundary numbers
  still being Python-side parameters, not config; CLI opening-setup wording
  unconfirmed; `book_weights()`/`load_popularity()` with no engine caller;
  no `contest_type` field; pawn promotion's DFS classification; the
  `logs/` vs `sessions/` doc-process mismatch; the `Top_Ten` distinction;
  Kings structurally uncapturable (emergent, not a bug).
