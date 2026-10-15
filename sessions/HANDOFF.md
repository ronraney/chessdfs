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
one CSV upload instead. Secrets (`LICHESS_API_TOKEN`, `VITE_ADMIN_PASSWORD`)
live in gitignored `.env` files, never printed. Club (light) and Slate
(dark) themes exist app-wide, CSS-variable driven, with a header toggle.

**Piece classification is now a pool, not a single tier** (this session):
`classify(player, sport)` returns every piece band a player qualifies for
(`frozenset[Piece]` in Python, `ReadonlySet<Piece>` in TS), not a first-
match winner. A move's pick list is the available players in the moved
piece's pool; once a player is actually locked, their displayed/captured
piece is whichever one the locking move recorded (`Move.piece`), never
re-derived from `classify()`. See `config/sports/nfl.json` for the current
NFL bands (King/Queen/Rook/Bishop/Knight/Pawn — Pawn is two bands) and
`sessions/1026/10152026-piece-pools-and-board-bug-fixes.md` for the full
design rationale (`exclude_positions`, the config-coverage validation, the
one real "one piece per player" spot the change touched).

**Environment note**: accessed from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright (npm spawns via `cmd.exe`,
which rejects the UNC working directory). git needed a one-time
`git config --global --add safe.directory` exception (already applied,
prior session). **jsdom (this project's entire test environment) runs no
CSS layout engine**: `getBoundingClientRect`/`offsetWidth`/`scrollWidth` are
always 0 regardless of the real stylesheet, and `getComputedStyle` never
evaluates `@media` queries at all. Any future task asking for a rendered-
layout/viewport-geometry test needs either a real browser (still not
launchable here — Playwright's cached Chromium fails on missing
`libasound.so.2`, no sudo to install it, reconfirmed this session) or a
mechanism/DOM-structure test instead, clearly labeled as such. **`npm run
test`'s default 5s timeout flakes on 1-2 unrelated heavy `userEvent` tests
under this machine's load** (confirmed pre-existing, not caused by any
session's changes, via `git stash` against the unmodified baseline) —
`npx vitest run --testTimeout=20000` passes the identical suite cleanly;
use that form when a clean count actually matters.

## Where We Are

- **324 Vitest tests passing** (confirmed via `npx vitest run
  --testTimeout=20000`; the plain `npm run test` can show 1-2 of these as
  flaky-failed under load, see Environment note), **186 pytest passing**,
  `tsc -b`, `npm run build`, and `npm run lint` (oxlint) all clean.
- **Four commits this session, newest first**: `1d2dcb8` (Knight pool
  floor reverted to $4,500), `f2ff2fc` (piece pools rule change, both
  engines), `290ce91` (bug fix: White's second move silently failed),
  `934bf2a` (bug fix: board move-dot/selection contrast + click-to-move
  investigation). Full narrative:
  `sessions/1026/10152026-piece-pools-and-board-bug-fixes.md`.
- **Piece classification is pools, not first-match-wins** (see Project
  Context above). Current NFL bands: King = any QB. Queen = any non-QB
  (via `exclude_positions`, not an allow-list) ≥ $7,000, no ceiling.
  Rook/Bishop = RB/WR ≥ $5,000, no ceiling. Knight = TE ≥ **$4,500**, no
  ceiling (reverted from a brief $5,000 floor earlier this session) — so
  a TE priced $4,500–$4,999 is in *both* the Knight and Pawn pools, the
  one deliberate asymmetry against Rook/Bishop's $5,000 floor. Pawn = any
  non-QB under $5,000, plus all DST at any salary (two config bands).
  `load_sport_config`/`loadSportConfig` now validates coverage (every
  real roster position's full salary range must be covered by some
  band's union) instead of requiring one literal catch-all band.
- **`BuildBoard.tsx`'s chessground wiring now keeps `turnColor` honest on
  every update, not just at mount** (bug fix, commit `290ce91`): without
  this, White's second move onward silently failed every time — see the
  session log for the exact mechanism (`isMovable` vs. the opposite-
  sense `isPremovable`, defaulting to a never-executed premove instead of
  a real move). `premovable.enabled: false` is new too (belt-and-
  suspenders; this app has no use for premoves). A rejected move now also
  surfaces why in the status line instead of vanishing silently
  (`handleBoardMove`'s old bare `return` is gone).
- **Move dots/selection highlight on the build board are theme-accent-
  colored now**, not brown.css's fixed green (commit `934bf2a`):
  `--board-marker` (new CSS var per theme) backs `.move-dest`/
  `.oc.move-dest`/`.selected` in `index.css`, chosen for ≥3:1 contrast
  against both `--board-light` and `--board-dark` in both themes.
- **Click-to-move's exact root cause for a reported *first*-move failure
  is still unconfirmed** — see Open Items. The turnColor fix resolves
  every *subsequent* move; it doesn't explain a first-move click failure,
  since turnColor hasn't had a chance to desync yet at that point.
- Everything else unchanged from before this session: the board renders
  correctly (BoardSquares/index.css, Task 38b), endings/Take back/Start
  again (Task 40), mobile responsiveness (Task 41, still only DOM-
  structure-tested, not eyeballed in a real browser — see Open Items),
  `config/contests.json` is still the source for contests, theme toggle
  untouched, TS/Python engines in parity (re-run `tools/export_parity.py`
  + `npm run test` if the engine ever changes — both current as of this
  session's last commit).

## Where We're Headed

1. **Real-browser verification** — both of Task 41's mobile checklist
   (long-standing) and the click-to-move first-move question above. No
   browser can launch in this environment at all (confirmed again this
   session).
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

## Open Items

- **Click-to-move's real root cause for a *first*-move failure is still
  genuinely unconfirmed.** The turnColor desync (fixed this session)
  only explains White's *second* move onward; a first-move click failure
  (the original bug report) can't be the same mechanism, since turnColor
  starts correctly at `'white'` and hasn't desynced yet. Possibly the
  same bug mis-timed in the telling, possibly a separate still-open
  issue — not resolved either way. No real-browser testing possible here
  to settle it; needs either a real device or more repro detail from Ron
  (browser/OS, console output, 100%-reproducible vs. intermittent).
- **Real-browser checklist for Task 41, at 375px, both themes** — see
  prior session's log for the exact checklist; still unprovable from
  this environment (jsdom has no CSS layout engine at all).
- **`openings.py`'s `_piece_eligible_positions`/TS equivalent had a real
  bug fixed this session but with no dedicated new test**: it wasn't
  subtracting `exclude_positions`, so Queen/Pawn's roster-feasibility
  proxy (`legal_depth`/`opening_preview`, display-only estimation, not a
  legality gate) incorrectly treated QB as an eligible position for
  them. Fixed in both languages; constructing a clean, minimal, isolated
  repro line was judged disproportionate effort for a narrow estimation-
  only edge case, so it's covered only by code review, not a test. Worth
  a dedicated test if this area gets touched again.
- **"Stop with this core" sits in the same place (beside Take back,
  under the board) at every screen width, not just mobile** — flagged to
  Ron in an earlier session, not confirmed either way.
- **Bug 2 (an earlier dead-end mislabeling)'s own root cause was never
  conclusively found independent of Bug 3 (an earlier id-collision)** —
  see `sessions/1026/10152026-endings-mobile-pass-bug-fixes.md` for
  detail; unchanged this session.
- **`data/samples/repro-slate.csv`** (a real DK export, Ron's own bug-
  repro data) **stays on disk, deliberately uncommitted** — confirmed
  excluded from every commit this session too.
- **`design/`** (PNGs, HTML mockups, `:Zone.Identifier` sidecars) remains
  uncommitted — unchanged, Ron's call whether it belongs in version
  control.
- **No "Back" navigation to the PREVIOUS screen without discarding
  progress** — still a known gap, not asked for.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** at
  the engine level — unchanged. `openings.book_weights()`/
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
  10152026-piece-pools-and-board-bug-fixes.md`. Prior sessions in
  `sessions/1026/` for everything predating today, including
  `10152026-endings-mobile-pass-bug-fixes.md`.
