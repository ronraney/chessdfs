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
screen) → build → finish**. A hidden admin screen (`#/admin`) handles the
one CSV upload instead, now with real slate validation (see below). Secrets
(`LICHESS_API_TOKEN`, `VITE_ADMIN_PASSWORD`) live in gitignored `.env`
files, never printed. Club (light) and Slate (dark) themes exist app-wide,
CSS-variable driven, with a header toggle.

Piece classification is a **pool**, not a single tier: `classify(player,
sport)` returns every piece band a player qualifies for (`frozenset[Piece]`
in Python, `ReadonlySet<Piece>` in TS), not a first-match winner. A move's
pick list is the available players in the moved piece's pool; once a
player is actually locked, their displayed/captured piece is whichever one
the locking move recorded (`Move.piece`), never re-derived from
`classify()`. See `config/sports/nfl.json` for the current NFL bands
(King/Queen/Rook/Bishop/Knight/Pawn — Pawn is two bands; Knight's own floor
is TE ≥ $4,500, lower than Rook/Bishop's $5,000, so a $4,500–4,999 TE is in
*both* the Knight and Pawn pools) and
`sessions/1026/10152026-piece-pools-and-board-bug-fixes.md` for the full
design rationale.

**DK roster slots are a separate concept from pieces, computed on demand**
(this session): `assignRosterSlots`/`assign_roster_slots`
(`engine/rules.ts`/`dfs_chess/rules.py`) takes a locked roster and returns
which named DK slot (QB/RB/WR/TE/FLEX/DST) each player occupies, via the
same Kuhn's-algorithm bipartite matching `maxAssignable`/`openRosterSlots`
already use internally — just recording the actual assignment instead of
only a feasibility count. Shown on the finish screen and in "Copy lineup"
as a "Slot" column before "Piece". Which of several interchangeable
same-position players draws "FLEX" vs. its own dedicated slot is whatever
the matching search finds first, not lock order — a cosmetic artifact, not
a bug (same-named slot instances are indistinguishable on screen).

**Environment note**: accessed from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright (npm spawns via `cmd.exe`,
which rejects the UNC working directory). git needed a one-time
`git config --global --add safe.directory` exception (already applied).
**jsdom (this project's entire test environment) runs no CSS layout
engine**: `getBoundingClientRect`/`offsetWidth`/`scrollWidth` are always 0
regardless of the real stylesheet, and `getComputedStyle` never evaluates
`@media` queries at all. Any future task asking for a rendered-layout/
viewport-geometry test needs either a real browser (still not launchable
here — Playwright's cached Chromium fails on missing `libasound.so.2`, no
sudo to install it) or a mechanism/DOM-structure test instead, clearly
labeled as such. **A handful of real-chessground/real-engine `userEvent`
tests sit close to Vitest's 5000ms default timeout under full-suite
parallel load** (confirmed pre-existing machine-load flakiness, not a code
inefficiency — see this session's log for the investigation). The known
offenders in `SetupScreen.test.tsx`, `BuildScreen.secondMove.test.tsx`, and
`BuildScreen.test.tsx` now carry explicit 15000–20000ms per-test timeouts
(confirmed via 3 consecutive clean full-suite `npm run test` runs this
session), but the underlying cause (CPU contention from 20 parallel
workers, each spawning its own jsdom + real chessground) is environmental,
not fixed — a new heavy test added without an explicit timeout could still
flake under load. `npx vitest run --testTimeout=20000` remains the
belt-and-suspenders form when a clean count absolutely must not flake.

## Where We Are

- **340 Vitest tests passing** (confirmed via 3 consecutive `npm run test`
  runs — plain default timeouts, no `--testTimeout` override needed
  anymore for the previously-flaky files), **197 pytest passing**,
  `tsc -b`, `npm run build`, and `npm run lint` (oxlint) all clean.
- **Two commits this session, newest first**: `27c26ae` (Task 43 — seven
  play-test fixes), `487ef4b` (Task 42 — Copy lineup button). Full
  narrative: `sessions/1026/10152026-copy-lineup-and-play-test-fixes.md`.
- **Finish screen has a "Copy lineup" button** (Task 42): copies the
  locked core as tab-separated plain text (Slot/Piece/Player/Pos/Team/
  Salary per row, then a totals block — salary used/remaining,
  projection, ownership, opening, moves) to the clipboard, showing
  "Copied" for 1.5s. `lineupText`/`formatMoveList` in `BuildScreen.tsx`.
- **DK roster slot assignment exists and is displayed** (Task 43, see
  Project Context above) — finish-screen table and Copy lineup both show
  it now.
- **The pick modal shows the chosen line's own move list under its title**
  (Task 43), the move being picked highlighted — the line's full fixed
  moves while still on-book, or the moves actually played so far plus the
  pending one once off-book. `PickPanel`'s new `moveContext` prop,
  computed in `BuildScreen.tsx`.
- **Opening explorer rows wrap long move lists to 2 lines** instead of
  truncating with "…" (`.explorer-moves` in `SetupScreen.css`, a
  `line-clamp`) — CSS-only, unverified in a real browser (standing
  environment limitation).
- **The Suggested card shows the opening's piece sequence as icon boxes in
  actual move order** (White outline glyphs, Black solid), replacing the
  old "White: P N B / Black: P N B" text — matches
  `design/1-club-setup.png`. `PieceSequence`/`interleavePieces` in
  `SetupScreen.tsx`.
- **The admin slate upload now validates real-world CSV problems before
  saving**: no ID column, missing/duplicate IDs, missing required columns
  (named in the error), too few players for any DK roster slot. A
  rejected upload keeps whatever slate was already saved. Success shows
  player count, a by-position tally, and which column was used as the ID.
  `validateSlateCsv` (`engine/loaders.ts`) / `validate_etr_csv`
  (`dfs_chess/loaders.py`) — deliberately separate from
  `loadEtrCsv`/`load_etr_csv`, which ~20+ other callers (tests, `tools/`,
  the CLI) still use unvalidated against small/synthetic CSVs.
- Everything else unchanged from before this session: piece pools (Task
  "piece pools" session), the board renders correctly (BoardSquares/
  index.css, Task 38b), endings/Take back/Start again (Task 40), mobile
  responsiveness (Task 41, still only DOM-structure-tested), `config/
  contests.json` is still the source for contests, theme toggle untouched,
  `BuildBoard.tsx`'s turnColor fix (White's 2nd+ move) untouched, TS/
  Python engines in parity (re-run `tools/export_parity.py` + `npm run
  test` if the engine ever changes — both current as of this session's
  last commit; confirmed no `parity.json` diff after this session's own
  engine changes).

## Where We're Headed

1. **Real-browser verification** — Task 41's mobile checklist, the
   click-to-move first-move question (see Open Items), and now also this
   session's two CSS-only changes (Explorer row wrapping, the piece-icon
   boxes). No browser can launch in this environment at all.
2. Decide on chessground's GPL-3.0 license — long-standing, unchanged.
3. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed.
4. Simulated "Top 10%" metric — still a known gap.
5. Ron needs to create **`web/.env`** with his own `VITE_ADMIN_PASSWORD=...`
   — still not created, deliberately.
6. `CONTINUATION_LIMIT = 8` (Book continues' cap) is still a guessed
   number, not spec'd — flag if it needs tuning either direction.
7. PLACED king mode's "silent King move while dragging" path still has no
   dedicated test.
8. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.
9. If more tests start flaking under full-suite load (new heavy real-
   engine/real-chessground tests, a slower CI machine, etc.), the same
   "extend this specific test's timeout to match its real cost" treatment
   applies — see this session's log for the investigation that ruled out
   an actual removable inefficiency.

## Open Items

- **Click-to-move's real root cause for a *first*-move failure is still
  genuinely unconfirmed.** A prior session's turnColor desync fix only
  explains White's *second* move onward; a first-move click failure (the
  original bug report) can't be the same mechanism, since turnColor
  starts correctly at `'white'` and hasn't desynced yet. No real-browser
  testing possible here to settle it; needs either a real device or more
  repro detail from Ron (browser/OS, console output, 100%-reproducible vs.
  intermittent). Unchanged this session.
- **Real-browser checklist for Task 41, at 375px, both themes** — see
  `sessions/1026/10142026-tasks-36-38-themes-and-build-screen-rework.md`
  (or the prior handoff) for the exact checklist; still unprovable from
  this environment. Now also covers this session's Explorer-wrap and
  piece-icon CSS changes.
- **`assignRosterSlots`/`validate_etr_csv` aren't in
  `tools/export_parity.py`'s scenario set** — TS/Python parity for these
  two new functions rests on hand-mirrored unit tests, not the shared
  JSON fixture (consistent with how `maxAssignable`/`openRosterSlots`
  were already tested, but worth knowing if the parity harness is ever
  extended to cover this area).
- **Which interchangeable player draws "FLEX" vs. its own dedicated slot
  is a cosmetic artifact of the bipartite matching search**, not lock
  order — see `assignRosterSlots`'s own code comment if a future task
  wants deterministic "most recently locked → FLEX" behavior specifically
  (would need a different algorithm than the one reused here).
- **`openings.py`'s `_piece_eligible_positions`/TS equivalent had a real
  bug fixed two sessions ago but with no dedicated new test** — see the
  piece-pools session log; unchanged.
- **"Stop with this core" sits in the same place (beside Take back, under
  the board) at every screen width, not just mobile** — flagged to Ron in
  an earlier session, not confirmed either way.
- **Bug 2 (an earlier dead-end mislabeling)'s own root cause was never
  conclusively found independent of Bug 3 (an earlier id-collision)** —
  see `sessions/1026/10152026-endings-mobile-pass-bug-fixes.md`;
  unchanged.
- **`data/samples/repro-slate.csv`** (a real DK export, Ron's own bug-
  repro data) **stays on disk, deliberately uncommitted** — confirmed
  excluded again this session.
- **`design/`** (PNGs, HTML mockups, `:Zone.Identifier` sidecars) remains
  uncommitted — Ron's call whether it belongs in version control.
- **No "Back" navigation to the PREVIOUS screen without discarding
  progress** — still a known gap, not asked for.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** at
  the engine level — unchanged, though `appData.ts`'s own `previewFor`
  memoizes results for the Suggested card's single current selection (not
  a fix at the engine level, confirmed this session is still the only
  mitigation in place). `openings.book_weights()`/
  `loaders.load_popularity()`/`data/openings/popularity.json` still have
  no engine caller.
- `cloneBoard`'s PGN-round-trip clone, chess.js's missing APIs
  (workarounds centralized in `rules.ts`/`openings.ts`/`build.ts`),
  `build.ts`'s generic "illegal move" error — all unchanged.
- Task-numbering collision ("Task 20c" reused), Scotch Game rank 2 /
  King's Indian Defense drop confirmation, `excluded_families` and the
  tier-boundary numbers hardcoded, CLI wording unconfirmed,
  `contest_type` field, pawn promotion's DFS classification, `logs/` vs
  `sessions/` doc-process mismatch, `Top_Ten` sim-vs-postmortem
  distinction, Kings structurally uncapturable (emergent) — all still
  open, all unchanged, carried forward across several sessions; see
  `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md` for detail.
- Full narrative for this session: `sessions/1026/
  10152026-copy-lineup-and-play-test-fixes.md`. Prior sessions in
  `sessions/1026/` for everything predating today.
