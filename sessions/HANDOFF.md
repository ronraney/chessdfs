# DFS Chess — Handoff
Last updated: 2026-10-15

## Project Context

DFS Chess is an NFL DraftKings lineup builder that layers chess opening
strategy onto lineup construction. The user plays White; "the field"
(Black) plays too, by simulation. The goal is a *core* (typically 4–5
players), not necessarily a full lineup. Every turn is a real chess move
on a real chess board: the moved piece's type (King/Queen/Rook/Bishop/
Knight/Pawn — a salary-tier classification driven by a sport config)
filters eligible real players by position + salary band, and that side
locks one. It is a **build, not a game** — "build" in code and docs, never
"game," except when referring to chess itself.

`CLAUDE.md` (never edited by Claude directly; Ron edits it himself) says the
task **prompt** is the spec — implement it exactly as written, even where it
changes earlier behavior; the existing code and tests are the record of all
earlier rules. Git section: work on `main`, no branches unless asked, check
`git status` for unexpected uncommitted changes before starting (CLAUDE.md
and `sessions/` files are routine, not "unexpected" — commit them with
whatever else the task touched), one commit per task after all tests pass,
push to `origin/main` after every commit. Rules section also says: never use
the `AskUserQuestion` tool — ask any question inline, as plain text, instead.
Python 3.11+, stdlib + pytest + `python-chess` for the original engine;
`web/` is a Vite + React + TypeScript app (Node v24, npm) built alongside
it. The TS port of the engine is complete, with a standing parity harness
proving it matches Python on real, deterministic scenarios. The UI's player
flow is upload-free: **contest + King mode + opening (one merged setup
screen, Task 38c) → build → finish**. A hidden admin screen (`#/admin`)
handles the one CSV upload instead. Secrets (`LICHESS_API_TOKEN`,
`VITE_ADMIN_PASSWORD`) live in gitignored `.env` files, never printed. Club
(light) and Slate (dark) themes exist app-wide, CSS-variable driven, with a
header toggle.

**Environment note**: accessed from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright (npm spawns via `cmd.exe`,
which rejects the UNC working directory). git needed a one-time
`git config --global --add safe.directory` exception (already applied, prior
session). **jsdom (this project's entire test environment) runs no CSS
layout engine**: `getBoundingClientRect`/`offsetWidth`/`scrollWidth` are
always 0 regardless of the real stylesheet, and `getComputedStyle` never
evaluates `@media` queries at all (verified directly this session — an
`@media (max-width: 430px)` override never shows up in `getComputedStyle`'s
output here, no matter `window.innerWidth`). Any future task asking for a
rendered-layout/viewport-geometry test needs either a real browser (and no
browser could launch in this environment to even manually verify — missing
`libasound.so.2`, no sudo, same gap every session has hit) or a
mechanism/DOM-structure test instead, clearly labeled as such — see
`web/src/responsive.test.tsx`'s own header comment for the pattern used.

## Where We Are

- **303 Vitest tests passing** (`npm run test`), **182 pytest passing**,
  `tsc -b`, `npm run build`, and `npm run lint` (oxlint) all clean.
- **Tasks 39, 40, and 41 are all done and pushed**, plus three production
  bugs Ron found by actually running the app against a real slate. Commits,
  newest first: `cf24f7f` (Task 41), `58476dd` (bug: id collision),
  `5b37d6b` (bugs: pick-modal selection + dead-end mislabeling), `5868baa`
  (Task 40), `6c63ee3` (Task 39). Full narrative:
  `sessions/1026/10152026-endings-mobile-pass-bug-fixes.md`.
- **The build now actually ends.** `web/src/BuildScreen.tsx` has a new
  `Ending` union (`stopped` / `complete` / `deadEnd`) and a `FinishCard`
  component that replaces the board-column's controls (status line, board,
  Book continues, Take back/Stop) once the build is over, for all four
  ways it can end — all driven by already-exported engine primitives
  (`checkWhiteDeadEnd`, `rules.isLineupComplete`), no engine changes needed
  for this. "Stop with this core" and "Take back" live together in a
  `.build-controls` row directly under the board (Task 41 moved "Stop"
  there from under the You card — see Open Items, this changed its
  position at every width, not just mobile). Take back pops a
  `pastStates` stack (one entry pushed per White commit); one click undoes
  White's move *and* Black's reply together. "Leaving the book" (no
  Book-continues option left) swaps in a "Continue, or start again?"
  prompt. "Start again" (header link, always visible, confirms only if any
  player is locked) and "New contest" both go through new
  `onStartAgain`/`onNewContest` props threaded from `App.tsx`, which now
  also remembers the just-finished build's preset/King-mode so "Start
  again" can reopen `SetupScreen` pre-filled (`initialPresetIndex`/
  `initialKingMode` props, both optional).
- **PickPanel.tsx candidates require an explicit click now** — no default
  pre-selection (there was one; Ron reported it as a bug since it made
  "Lock player" immediately clickable with nothing visibly selected).
  Selecting a row shows an accent outline + `var(--accent-bg)` tint; the
  footer reads "Selected: `<player>` · After this pick: ..."; infeasible
  (greyed) rows are real `disabled` buttons now, not just dimmed and still
  clickable.
- **Black's reply can no longer crash into a false "dead end."**
  `engine/build.ts` exports `NoLegalBlackMoveError`, a dedicated subclass —
  `playBlackMove`'s one deliberate "no legal move" throw uses it, and
  `BuildScreen.tsx`'s `scheduleBlackReply` branches on `instanceof` instead
  of blanket-catching. Only that specific error ends the build as a dead
  end; anything else sets a `blackMoveError` state, shows "Something went
  wrong: `<message>`" in the status line, and leaves the build alive with
  Take back still available.
- **`loadEtrCsv`/`load_etr_csv` no longer silently corrupt every player's
  identity if a CSV has only a plain `id` column, not `DK_ID`.** This was
  Ron's actual root cause for the dead-end bug above, found from his own
  real (uncommitted) repro slate: every player got the same `undefined`
  id (TS) / the loader raised `KeyError` (Python) the moment `DK_ID` was
  absent, and the instant one player locked, `lockedPlayerIds` held that
  one shared id — making the *entire pool* read as "already locked" from
  then on, not just the one real pick. Both loaders now fall back to a
  plain `id` column when `DK_ID` is genuinely absent from the file's own
  header (checked via `papaparse`'s `meta.fields` / `csv.DictReader.
  fieldnames`, not just an empty cell). If a THIRD id-column spelling
  shows up in a future real export, the same fallback pattern
  (`resolveIdColumn`/`_resolve_id_column`) is where to extend it.
- **Mobile/responsive pass done, not yet eyeballed in a real browser**
  (see Open Items for the exact checklist). Setup screen's contest
  `<select>` no longer sizes to its widest option; Explorer rows and the
  finish screen's core table can no longer force the page wider than the
  viewport; tier chips scroll horizontally instead of wrapping under
  760px; the board is genuinely full-width on a phone (old 320px mobile
  cap removed); the pick modal (already a bottom sheet from Task 38b) is
  hardened so its footer can never be pushed off-screen. Touch drag/tap-
  to-move and ≥44px touch targets were already correct from earlier work
  (chessground's own defaults; a pre-existing global CSS rule in
  `index.css`) — verified this session, not changed.
- **`@lichess-org/chessground`** still **GPL-3.0 licensed; still not
  decided whether that's acceptable** — unchanged, not touched this
  session.
- Everything else unchanged: `config/contests.json` is still the source
  for contests (no admin editing); `web/src/theme.ts`/`ThemeToggle.tsx`
  (Club/Slate) untouched; the TS/Python engines still match via the
  parity harness (re-run `tools/export_parity.py` + `npm run test` if the
  engine ever changes — it didn't this session except for the `id`-
  fallback loader fix, which has no Python-engine-logic equivalent to
  keep in parity, just the loader itself, done in both languages).

## Where We're Headed

1. **Real-browser verification of Task 41** — see the checklist under
   Open Items. Nothing here is confirmed correct beyond what jsdom's
   DOM-structure/stylesheet-source tests can prove (see the Environment
   note above for why that's a real ceiling, not a shortcut taken).
2. Decide on chessground's GPL-3.0 license — long-standing, unchanged.
3. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed.
4. Simulated "Top 10%" metric — still a known gap.
5. Ron needs to create **`web/.env`** with his own `VITE_ADMIN_PASSWORD=...`
   — still not created, deliberately.
6. `CONTINUATION_LIMIT = 8` (Book continues' cap) is still a guessed
   number, not spec'd — flag if it needs tuning either direction.
7. PLACED king mode's "silent King move while dragging" path (a plain,
   non-castling King move once the QB is already placed, locking no one)
   still has no dedicated test — every castling/capture test added across
   Tasks 39–41 uses EMERGE mode.
8. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.

## Open Items

- **Real-browser checklist for Task 41, at 375px, both themes**: Setup
  screen collapses to one column with no horizontal scrollbar, tier chips
  scroll sideways, search + Random stay usable; Build screen's top-to-
  bottom order reads status line → board → Book continues → Take
  back/Stop → You → Field → Player\|Field, header chips wrap, the board
  fills the width and stays square; the pick modal docks to the bottom
  edge and its footer/buttons stay visible while the candidate rows
  scroll; the finish screen's core table and the How-it-works strip don't
  force page-level horizontal scroll. None of this is provable from this
  environment — see the Environment note above.
- **"Stop with this core" now sits in the same place (beside Take back,
  under the board) at every screen width, not just mobile** — Task 41's
  explicit ordering left no clean way to keep Task 40's original "under
  the You card" placement at desktop while also satisfying the mobile
  order (a grid child can't be reordered ahead of its own parent cell),
  so the control moved everywhere. Flagged to Ron, not confirmed either
  way.
- **Bug 2 (the dead-end mislabeling)'s own root cause was never
  conclusively found independent of Bug 3 (the id-collision)** — an
  extensive sweep (5,400+ direct `playBlackMove` trials across every real
  contest preset × 300 seeds, Knight-band players removed) found the
  *current* "re-choose a book line instead of throwing" logic already
  correct for every TE-depleted scenario constructible from the vendored
  sample data. It's plausible Bug 2's original report and Bug 3 were the
  same incident described before Ron had isolated the real slate as the
  cause, rather than two distinct bugs — not confirmed. Worth revisiting
  only if a *new*, still-unexplained dead end shows up now that both
  fixes are live (the mislabeling fix would at least surface the real
  error message next time, rather than hiding it).
- **`data/samples/repro-slate.csv`** (268-row real DK export, Ron's own
  bug-repro data) **stays on disk, deliberately uncommitted** — confirmed
  excluded from every commit this session via explicit `git add` of only
  the intended files, never `git add -A`. It also gets synced into
  `web/src/data/samples/` by `npm run build`, but that whole directory is
  separately gitignored (`web/.gitignore`'s `src/data` entry) regardless.
- **`design/`** (6 PNGs, 3 HTML files, `:Zone.Identifier` sidecars) and an
  older untracked session log (`10142026-tasks-36-38-themes-and-build-
  screen-rework.md`) remain uncommitted — unchanged, Ron's call whether
  `design/` belongs in version control.
- **No "Back" navigation to the PREVIOUS screen without discarding
  progress** — Take back (undo moves) and Start again/New contest
  (restart the whole build) both exist now (Task 40), but there's still
  no way to, say, pause mid-build and resume later, or step back to
  setup without losing locked picks. Not asked for; noting it exists as a
  gap, not asking it be built.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** at
  the engine level, worked around only at the UI layer — unchanged.
  Relatedly, `openings.book_weights()`/`loaders.load_popularity()`/
  `data/openings/popularity.json` still have no engine caller — Book
  continues' own ranking still reuses `RANK_BY_FAMILY` instead of wiring
  that path in.
- `cloneBoard`'s PGN-round-trip clone, chess.js's missing "resolve SAN
  without pushing"/capture-detection/clone-with-history APIs (workarounds
  centralized in `rules.ts`/`openings.ts`/`build.ts`), `build.ts`'s
  generic "illegal move" error — all unchanged.
- Task-numbering collision ("Task 20c" reused), Scotch Game rank 2 /
  King's Indian Defense drop confirmation, `excluded_families` and the six
  tier-boundary numbers still hardcoded, CLI wording unconfirmed,
  `contest_type` field, pawn promotion's DFS classification, `logs/` vs
  `sessions/` doc-process mismatch, `Top_Ten` sim-vs-postmortem
  distinction, Kings structurally uncapturable (emergent) — all still
  open, all unchanged, carried forward across several sessions; see
  `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md` for detail.
- Full narrative for this session: `sessions/1026/
  10152026-endings-mobile-pass-bug-fixes.md`. Prior sessions in
  `sessions/1026/` for everything predating today, including
  `10142026-task-38b-match-designs-clarity-polish.md` and
  `10142026-tasks-36-38-themes-and-build-screen-rework.md`.
