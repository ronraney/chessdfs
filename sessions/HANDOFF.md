# DFS Chess — Handoff
Last updated: 2026-10-13

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
earlier rules. It now also has an explicit Git section (see below). Python
3.11+, stdlib + pytest + `python-chess` for the original engine; `web/` is a
Vite + React + TypeScript app (Node v24, npm) being built alongside it,
starting with a pure TS port of the engine. Secrets (`LICHESS_API_TOKEN`)
live in a gitignored `.env`, never printed.

## Where We Are

- **Git repo now exists**: `github.com/ronraney/chessdfs`, branch `main`,
  clean and pushed through commit `2c7c707`. CLAUDE.md's Git section: work on
  `main` (no branches unless a task asks), check `git status` for
  unexpected uncommitted changes before starting, one commit per task after
  all tests pass (`Task NN — <title>` message), commit only the files the
  task touched, never commit generated files (`.env`, `.venv/`,
  `node_modules/`, `web/src/data/`, etc.), push to `origin/main` after every
  commit.
- **180 Python tests still passing**, run via `wsl.exe -- bash -lc "cd
  ~/chess-dfs && .venv/bin/python -m pytest tests/ -v"`. The Python engine
  itself is unchanged since the web port began — all three web-port tasks so
  far have been additive, TypeScript-only.
- **`web/` scaffolded** (Vite + React + TypeScript + Vitest + chess.js
  ^1.4.0). `npm run dev`/`build`/`test` each run `npm run sync-data` first,
  which copies `data/openings/` and `config/` into `web/src/data/`
  (gitignored; originals untouched). No UI beyond the Vite default page yet.
- **`web/src/engine/` holds a growing pure TypeScript port of `dfs_chess`**
  (no DOM, no I/O, no unseeded randomness):
  - `models.ts` — `Side`, `Piece`, `FieldTier`, `KingMode` (as frozen const
    objects + derived union types, **not** `enum` — this tsconfig sets
    `erasableSyntaxOnly: true`, which forbids real TS enums), `Player`
    (`ownFor(tier)`), `Move`, `BuildState` (a plain **mutable** class,
    mirroring Python's non-frozen dataclass; `board: Chess` from chess.js,
    `pieceLocks: Map<Square, Player[]>`).
  - `sport.ts` — `PieceBand`, `RosterSlot`, `SportConfig`,
    `loadSportConfig(data)`. Takes already-parsed JSON, not a file path (the
    engine stays I/O-free); tests import the synced
    `web/src/data/config/sports/nfl.json` directly as a module
    (`resolveJsonModule: true` in `web/tsconfig.app.json`).
  - `pieces.ts` — `pieceForChessType`, `classify(player, sport)` (returns
    `Piece`, throws — unreachably, given `loadSportConfig`'s catch-all-band
    guarantee — if no band matches).
  - `rules.ts` — `maxAssignable`, `lineupStillCompletable`,
    `isLineupComplete`, `openRosterSlots`. All pure (`Player[]` +
    `SportConfig` + a plain numeric `cap`); no dependency on `ContestConfig`
    or a chess.js board yet.
- **34 Vitest tests passing** (`npm run test`): 33 ported one-for-one from
  Python (`test_models.py`: 3, `test_sport.py`: 2, `test_pieces.py`: 21,
  `test_rules.py`: 7) plus the original Task 21 smoke test. `npm run build`
  is clean (`tsc -b` + `vite build`); `npm run dev` confirmed starting.
- **11 `test_rules.py` tests remain deferred**, pending `is_legal_move`/
  `apply_move` — which need `ContestConfig` (`dfs_chess/config.py`, not yet
  ported — no `config.ts` exists) plus real chess.js board-legality wiring.
  Exact list and reasoning: `sessions/1026/10132026-git-setup-and-ts-engine-
  port.md`. A further 21 tests (castling, King modes, captures) are out of
  scope until their own tasks — by design, not a surprise.
- **New skill**: `.claude/skills/start` — reads `sessions/HANDOFF.md` at the
  top of a session, checks the git branch, and flags (rather than silently
  working through) a task that doesn't fit current state.
- `dfs_chess/build.py`, `loaders.py`, and `openings.py` remain entirely
  unported on the TypeScript side.

## Where We're Headed

1. Port `dfs_chess/config.py` (`ContestConfig`) to `web/src/engine/
   config.ts` — prerequisite for `is_legal_move`/`apply_move`.
2. Port `is_legal_move`/`apply_move` (ordinary, non-capturing, non-castling
   moves only) and their 11 deferred tests, using chess.js directly:
   `Chess.moves({verbose: true})` for legal-move membership, `Chess.get
   (square)` for piece-at-square, each `Move`'s `.isCapture()`/
   `.isKingsideCastle()`/`.isQueensideCastle()` for the early-reject checks,
   and FEN-based board cloning (`new Chess(fen)` — chess.js has no built-in
   `.clone()`) for `apply_move`'s copy-then-push.
3. Later, each its own task: castling (`can_castle`/`castle`), King modes
   (`switch_king`/`place_kings`), captures (`is_legal_capture`/
   `apply_capture_move`).
4. Further out: `build.py` (the real turn-flow loop), `loaders.py`,
   `openings.py` — still entirely unported.
5. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed, unchanged.
6. Simulated "Top 10%" metric — still a known gap.

## Open Items

- The `is_legal_move`/`apply_move` scope decision (narrow: pure functions
  only, now done; broad scope — also porting `ContestConfig` immediately —
  was considered and declined) and the exact 11 deferred test names: see
  `sessions/1026/10132026-git-setup-and-ts-engine-port.md`.
- Task-numbering collision (a prior session reused "Task 20c" for two
  different pieces of work) and whether Ron intends to accept Scotch Game at
  rank 2 / drop King's Indian Defense from the "top 9": both still open, see
  `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md`.
- `excluded_families` and the six tier-boundary numbers are still
  Python-level defaults/parameters on the Python side, not a config file —
  same logs as above.
- CLI wording for the Python CLI's opening-setup screen is still an
  unconfirmed guess, not confirmed UX — same logs as above.
- `openings.book_weights()`/`loaders.load_popularity()`/
  `data/openings/popularity.json` still have no engine caller (Python side).
- No dedicated `contest_type` (GPP/H2H) field in `ContestConfig`; pawn
  promotion's DFS classification unresolved; the `logs/` vs `sessions/`
  doc-process mismatch (CLAUDE.md's "Session log" section still says
  `logs/YYYY-MM-DD-<task>.md`, but actual practice is this `sessions/`
  structure via the `wrap-up` skill); the `Top_Ten` sim-vs-postmortem
  distinction — all still open, carried forward unchanged across several
  sessions.
- Kings still structurally can never be captured as the King piece itself
  (checkmate ends the position first — emergent, not a bug).
- Full narrative detail for everything in this update:
  `sessions/1026/10132026-git-setup-and-ts-engine-port.md` (this session —
  git init, new `start` skill, Tasks 21–23); earlier logs in `sessions/1026/`
  for everything predating that.
