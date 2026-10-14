# 10142026 — Task 38b: Match the designs, then clarity polish from live feedback

## Context

Going into this session, `sessions/HANDOFF.md` described the state right
after Task 38 (commit `c272f0d`): the build screen had its move-first-
then-pick flow working, but an untracked `design/` directory had appeared
in the repo with Club/Slate PNG mockups (1-6) and three `.html` source
files (`club-setup.html`, `slate-setup.html`, `build-screen-d.html`),
flagged as "Ron's own planning reference, not created by this session...
left alone, not committed." HANDOFF.md also carried two known board bugs
forward unfixed: the checkerboard CSS was broken (wedge shapes instead of
a real checker pattern) and layers were misaligned (a last-move highlight
looking like it sat on the wrong square after e2–e4).

This session opened with `/start`, then the prompt "Task 38b — Match the
designs," instructing the build screen's UI be brought in line with the
six PNGs and three HTML files in `design/`, with explicit sub-instructions
for the opening banner, "Book continues," the pick modal, and the board
checker/highlight bugs, plus five specific acceptance-test behaviors and a
closing instruction to run both test suites.

## What was done

### Reading the designs

Read all six PNGs (`1-club-setup.png` through `6-slate-build-pick.png`)
and all three `.html` files via the Read tool (which renders PNGs
visually and the HTML as text/templating source, per the task's own
instruction to read the HTML "as reference, not code to copy"). Confirmed
`club-setup.html`/`slate-setup.html` are the Club (Cormorant Garamond /
Source Sans 3 / IBM Plex Mono) and Slate (Space Grotesk / JetBrains Mono)
font/color sources already implemented by Task 36's theme.ts/index.css;
`build-screen-d.html` uses an older, unrelated palette (IBM Plex Sans /
Literata, `#131518` background) explicitly called out in the task prompt
as "not" the palette to use — the PNGs were the layout/spacing ground
truth, Club/Slate CSS variables the color ground truth.

**Scoping decision, flagged in the commit, not separately confirmed with
Ron beforehand**: the task's bullet list and five acceptance tests are
entirely about the build screen. The two setup-screen PNGs show a
single combined contest-picker + King-mode + opening-explorer screen in
a two-column desktop layout, quite different from the current app's
actual architecture (a separate `App.tsx` "setup" screen for contest/King
mode, then a separate single-column, mobile-first `OpeningSetupScreen.tsx`
for the explorer). Treated the setup PNGs as typography/color reference
only (already satisfied by Task 36), not a mandate to merge/restructure
those two screens into the mockups' combined layout — no test or bullet
asked for that, and it would have been a large, unrequested architecture
change. Flagged explicitly in the first commit's message.

### Board fix — root-caused, not just patched

Read `chessground.base.css`/`chessground.brown.css`
(`node_modules/@lichess-org/chessground/assets/`) and the library's own
`render.ts`/`util.ts`/`wrap.ts` source to understand how it actually
positions squares/pieces (`posToTranslate`: pixel `translate()` from
`bounds.width/8` per file/rank — correct, mature, no bug there) versus how
its background is painted (`chessground.brown.css`'s `cg-board` rule: an
embedded base64 SVG checker image, `background-size: cover`). Found the
actual bug in `web/src/index.css`: a hand-rolled override —
`background-image: linear-gradient(45deg, ...)` twice at
`background-size: 25% 25%` — which tiles a 4×4 grid of diagonally-split
squares, not an 8×8 checker. This explained BOTH reported symptoms from
one root cause: the wedge shapes themselves, and "the highlight sits on
e2–e3" after e2–e4 — the highlight element was always correctly
positioned by chessground's own pixel math, it just looked offset
against a backdrop drawn at the wrong scale and phase.

Fix: a new `BoardSquares.tsx`/`.css` component — 64 real `<div>` elements
in a CSS grid (explicitly *not* a gradient, per the task's own wording),
colored from `--board-light`/`--board-dark`, with small rank/file labels
in the corner squares (only passed `labels` on the build board, not the
opening-setup preview, matching the PNGs). `BuildBoard.tsx`/
`BoardPreview.tsx` were restructured so the element passed to
`Chessground()` is a transparent absolutely-positioned child sitting on
top of `BoardSquares`, inside a new sized "frame" div that kept the old
`.build-board`/`.board-preview` class names and CSS (so existing test
selectors like `document.querySelector(".build-board")` kept working
unchanged). `index.css`'s override now just clears `cg-board`'s own
background (`background: none`) rather than drawing one, so brown.css's
move-dest/selected/last-move/check square *colors* still apply.

Separately discovered while implementing: `BuildBoard.tsx` never actually
passed `lastMove` to chessground at all — `highlight.lastMove` had
nothing to highlight, full stop, independent of the background bug. Added
a `lastMove: { orig: Key; dest: Key } | null` prop, computed in
`BuildScreen.tsx` from the pending move (if any) or the most recent real
move, and wired into both the initial `Chessground()` config and the
`.set()` sync effect. Verified via a mocked-chessground test asserting
`lastApi.config.lastMove` equals `["e2", "e4"]` after playing it — this
is the one board-fix claim actually test-covered; the checker-grid
alignment itself follows from using the same percentage-based 8×8 box
chessground renders into, but is not eyeball-verified in a real browser
(see Open threads).

Also dropped `BuildBoard`'s old `suggestionArrow`/`drawable.autoShapes`
prop entirely — with every continuation now its own button (see below),
there's no longer a single "the" suggested move to point a board arrow
at. Flagged as a feature removal in the commit message per CLAUDE.md.

### Opening banner, Book continues, pick modal — first pass (commit `392cd9d`)

Rewrote `BuildScreen.tsx` substantially:

- **Header**: new small row — "Chess DFS" wordmark, a contest chip
  (`<name> · <entries> entries · <tier> field`), a King-mode chip
  (`King: Let him emerge` / `King: Place your King now`), and
  `ThemeToggle` — replacing the old `opening-family` h1's literal
  `"Chess DFS"` fallback text (which rendered with the *global* 56px `h1`
  CSS rule, i.e. genuinely was "the large Chess DFS title" the task named).
- **Opening banner**: now driven by `chosenOpening` directly rather than
  by replaying `state.board.history()` through `openingLine` on every
  commit — the old `lastOpening` state was initialized from an *empty*
  history, so it showed nothing (fell back to "Chess DFS") until the
  first move committed. Removed `lastOpening` state/effect entirely.
  Family/ECO/variation come straight from `chosenOpening.line`;
  `playedCount = commonPrefixLength(history, chosenLine.moves)`;
  `onChosenLine = playedCount === history.length`. Subtext is either
  `"Now: <live openingLine(history,BOOK) name> · <eco>"` while on the
  line, or `"Left the line after <history[playedCount]>"` once off it —
  `history[playedCount]`, not `chosenLine.moves[playedCount-1]`, is the
  move that actually caused the deviation; this took one failed test
  iteration to get right (see below).
- **Book continues**: replaces the old single "Suggested: X / Play it"
  banner. Every chess-AND-DFS-legal continuation from
  `bookContinuations(history, BOOK)` (same filtering buildFlow.ts already
  does), each showing its move, the resulting opening's name
  (`openingLine([...history, san], BOOK)?.name`), and which piece/salary
  band it locks (`lockDescription`, built on a new
  `buildStats.pieceBandLabel(piece, sport)` helper shared with the pick
  modal's own subtitle — reads `sport.pieceBands` directly, e.g. Bishop →
  `"WR · $5,000–6,999"`, `maxSalary` being exclusive is why it's
  `maxSalary - 1`). The chosen line's own next move sorts first with a
  `.chosen` class.
- **Pick modal** (`PickPanel.tsx`/`.css`, fully rewritten): centered,
  dimmed overlay (`.pick-modal-overlay`/`.pick-modal`), title `"Choose
  your <Piece>"`, eyebrow `"<move>. <move> · <opening name>"`, subtitle
  `"<band> · sorted by projection"`. Candidates are a *fixed*
  projection-descending sort (no more interactive sortable column headers
  — nothing in the old test suite exercised that sort interactivity, so
  this is a straight simplification per the design, not a coverage loss).
  Clicking a row only *selects* it (border highlight, live-updating
  "After this pick: $X left · $Y / slot · Z open" footer via
  `buildStats.sideStats`); only "Lock player" calls `onPick`. Bottom
  sheet on ≤760px via the same media-query pattern the old side-panel CSS
  already used.
- Dropped the "Core projection" stat line from the You/Field side cards
  (not part of the design's stat block; kept Core ownership). Flagged.

Ran `tsc -b` (clean), rewrote `BuildScreen.test.tsx`'s five tests into
seven covering: banner-before-any-move, tapping the chosen continuation
opens the modal, `lastMove` wiring after e4, tapping a non-chosen
continuation, the "After this pick" footer + Lock player committing the
top candidate, Cancel reverting, and "Left the line after <move>" post-
deviation. First full run caught a real bug in the "Left the line"
wording: initially wrote `chosenLine.moves[playedCount - 1]` (the *last
matching* move) which gave "Left the line after e4" even when Black's own
subsequent reply, not White's deviation, was the most recent move in
`history` — the actual fix (`history[playedCount]`, the first move that
broke the match, which freezes correctly as later moves pile up) was
found by running the test, reading the rendered DOM dump in the failure
output, and reasoning through *why* "d5" (Black's reply) was showing up
instead of "d4" (White's own deviating move).

`npm run test`: 254 passed (up from 252 at session start — net +2 from
`BuildScreen.test.tsx` going 5→7). `pytest`: 180 passed, unchanged (no
engine files touched — confirmed via `grep` that nothing under
`web/src/engine/` was in the diff). `oxlint`: 0 warnings/errors.
`npm run build`: clean (pre-existing >500kB single-chunk warning only).
Committed as `392cd9d`, pushed to `origin/main`.

### Live-feedback round (commit `4f5f4ae`)

Ron reported back with a screenshot from actually running the dev server
(so the long-standing "no real browser verification possible" blocker —
see HANDOFF's Open Items — is apparently no longer in his way, at least
from wherever he ran it; this session never re-diagnosed the
`libasound.so.2` gap itself). The screenshot showed a real contest
("Quarter Jukebox ($0.25 GPP 20-max) · 71,343 entries · Large field") with
a genuinely obscure suggested opening ("Latvian Gambit Accepted, Main
Line, C40") and, critically, *nothing* rendered below the three stat
cards — no "Book continues" label, no "(Play your own move)" hint, at a
height exactly matching the side cards (ruling out "just scrolled past").

Diagnosed by inspection (own code re-read, not reproduced locally with
real slate data) that this was most likely `bookContinuations([], BOOK)`
at move 1 returning dozens of first moves with no capping — not
necessarily a crash, but genuinely overwhelming, and asked Ron to confirm
whether scrolling revealed a (long, confusing) list or truly nothing.
He confirmed there *was* something there but "it's not clear to me, and
maybe anyone, what this area means" — pinning the problem down to lack of
explanation/affordance rather than a render failure — plus separately
liked the opening-line reference text's *existence* but found it "a bit
light" (the opacity-based fade).

Iterated live over a few exchanges to a concrete three-item plan (laid
out and explicitly confirmed with a plain "yes" before implementing, per
CLAUDE.md's ask-before-building-on-unclear-scope rule applied here to a
genuinely open design question, not a handed-down task spec):

1. **Cap Book continues** to `CONTINUATION_LIMIT = 8`, ranked by family
   rank via `RANK_BY_FAMILY` (already loaded in `appData.ts`, the same
   ranking the Explorer itself uses for tiers) — reused rather than
   wiring in the still-dormant `popularity.json`/`bookWeights()` data
   path HANDOFF already flagged as uncalled. Chosen line's move still
   pinned first regardless of rank. Added a plain instruction paragraph
   above the list: "Tap a move to play it, or drag a piece on the
   board."
2. **Fixed the opacity-as-disabled problem**: `.opening-moves .pending`
   no longer sets `opacity`, just the plain `--text` color already used
   for eyebrows/labels elsewhere on the page. Added a `.next` treatment
   (accent color, bold, small `▸` marker) on the one move actually up
   next, visually tying the banner's move list to the highlighted option
   in Book continues below.
3. **Folded "Moves" into the banner, moved "Player | Field" up**: the
   standalone `<section className="move-list">` and its `MoveList`
   function are gone entirely. The banner's own move display
   (`movesForBanner`/`bannerPlayedCount`) now switches from the chosen
   line's fixed reference (while still on it) to the actual played
   `history` (once off it, or for "own opening" builds from the start) —
   one authoritative "where are we" line instead of two. `Player | Field`
   (kept — it shows the pick-by-pick White/Black pairing, genuinely not
   visible anywhere else on the page) moved from last-on-the-page to
   directly under the board/cards row, and now gets the same card
   treatment (`var(--card)` background, border, padding) as the opening
   banner and side columns, instead of being bare unstyled text.

Updated `BuildScreen.test.tsx` to match: replaced brittle hardcoded
`screen.getByText("1. d4")` (no longer guaranteed to survive the new
rank-based cap/sort) with a generic "first non-`.chosen` `.continue-
option`" lookup; replaced now-gone `.moves-line`/`.hint` "(no moves
yet)" assertions with `.opening-moves` text-content checks and a new
`youColumn()` helper (parallel to the existing `fieldColumn()`) asserting
on `locked-players` list length instead; added one new direct test
(`Book continues is capped, not a dump of every recorded first move`,
asserting `.continue-option` count ≤ 8).

`npm run test`: 255 passed (was 254; `BuildScreen.test.tsx` 7→8).
`tsc -b`, `oxlint`, `npm run build`: all clean. `pytest` not re-run this
round (no Python/engine files touched, confirmed by `git status`).
Committed as `4f5f4ae`, pushed to `origin/main`.

## Open threads

- **Still no real browser verification performed by this session itself**
  — Ron's screenshot is the only actual-browser evidence either of these
  commits has had; the `libasound.so.2`/sudo gap noted in previous
  sessions' logs was never re-diagnosed or re-tested here. The checker-
  grid alignment claim rests on reading chessground's own source
  (`render.ts`'s `posToTranslate`, both squares and pieces using the same
  `bounds.width/8`/`bounds.height/8` math) rather than a screenshot.
- **Setup screens (`App.tsx`'s contest/King-mode step,
  `OpeningSetupScreen.tsx`) were deliberately left unrestructured** —
  flagged as a scoping assumption in the `392cd9d` commit message, never
  independently confirmed by Ron one way or the other. If a future task
  wants the setup screens' two-column combined layout to match
  `1-club-setup.png`/`2-slate-setup.png` more literally, that's new,
  unstarted work, not something this session touched.
- **`design/` itself (6 PNGs, 3 HTML files, plus `:Zone.Identifier`
  sidecar files) and the prior session's
  `10142026-tasks-36-38-themes-and-build-screen-rework.md` log remain
  untracked** — left alone both times this session committed, same as
  the prior session left them; still Ron's call whether `design/` belongs
  in version control going forward.
- **Captures and castling are still not offerable on the build screen** —
  unchanged from Task 38's own carry-forward; still explicitly flagged as
  "next" in HANDOFF.md going into this session, and nothing here touched
  it. Worth noting Book continues' new ranking/capping logic was written
  assuming continuations are plain non-capture moves (`isCaptureMove`-
  excluded upstream in `buildFlow.dfsLegalMoves`, unchanged) — whoever
  picks up captures next will need to decide how a capture's own
  "locks/captures" phrasing (shown in the original `design/` mockup's
  "Bxc6 · Locks a Bishop and captures the Field's TE" row, which this
  session explicitly did *not* implement — see the `392cd9d` commit's own
  reasoning) fits into `ContinuationOption`'s current shape.
- **chessground's GPL-3.0 license decision** — still open, still
  unchanged, still not this session's call; the board now depends on it
  slightly *less* heavily for visuals (checker pattern is our own
  `BoardSquares`, not chessground's `brown.css`) but just as much for
  interaction/drag mechanics and the move-dest/selected/check CSS this
  session kept relying on `chessground.brown.css` for.
- **`CONTINUATION_LIMIT = 8` is a guessed number**, not something Ron
  specified — chosen because it's close to the PNG mockup's own example
  (2 options at a deep, narrow position) scaled up to feel like a
  reasonable menu at the wide-open move-1 case, not derived from any
  product requirement. Flag if it needs tuning.
- Every item already open at session start and not touched here is still
  open and still accurately described by `sessions/1026/
  10142026-tasks-36-38-themes-and-build-screen-rework.md` (board-first
  move list pattern, Monte Carlo sim, `VITE_ADMIN_PASSWORD`, PLACED-mode
  silent-King test gap, etc.) — not re-copied into this log; see that
  file and the rewritten `HANDOFF.md` for the current list.
