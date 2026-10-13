# 10132026 — Git Setup and TypeScript Engine Port (Tasks 21–23)

## Context

Going into this session, HANDOFF.md described chess-dfs as "multi-sport-ready,
no git repo yet" with 180 Python tests passing. Ron asked for a new skill
(`start`) mirroring the existing `wrap-up` skill — read `sessions/HANDOFF.md`
at the top of a session, check the git branch, flag it if the task at hand
doesn't fit what HANDOFF.md describes — then asked to get git set up before
starting Task 21, with Tasks 22 and 23 following in the same session to begin
porting the Python engine to a new `web/` TypeScript app.

## What was done

**New skill.** `.claude/skills/start/SKILL.md` — reads `sessions/HANDOFF.md`,
points to the dated logs for depth, checks the git branch, and says to stop
and flag a task that doesn't fit current state rather than silently
reinterpreting it.

**Git init.** `.gitignore` gained `__pycache__/`, `*.pyc`, `.pytest_cache/`,
and `*:Zone.Identifier` (a stray Windows download-metadata sidecar file
sitting next to `data/samples/NFL Weekly DFS System - Projections.csv` —
excluded rather than committed since it embedded a long signed Google Sheets
export URL, not project content). `git init`, initial commit `caf92c6` (49
files: engine, tests, data, docs, prior session logs). Remote added as
`origin` → `https://github.com/ronraney/chessdfs.git`; local branch renamed
`master` → `main` per Ron's request; pushed.

**Task 21 — scaffold `web/`.** `npm create vite@latest web -- --template
react-ts`, then added `chess.js` (^1.4.0, dependency) and `vitest` (^5.0.4,
devDependency) — the rest of the deps (`react`/`react-dom`,
`@vitejs/plugin-react`, `typescript`, `vite`, `oxlint`, `@types/*`) came from
the Vite template itself. `web/src/engine/index.ts` is an empty placeholder
(pure engine: no DOM, no I/O, no unseeded randomness). `web/scripts/
sync-data.mjs` wipes and recopies `data/openings/` → `web/src/data/openings/`
and `config/` → `web/src/data/config/` via `fs.cpSync`; `web/.gitignore` adds
`src/data` so the copy never gets committed; `dev`/`build`/`test` npm scripts
all run `sync-data` first. One Vitest smoke test: chess.js plays `1. e4 e5`,
asserts the move list. Verified: `npm run test` (1 passed), `npm run build`
(clean), `npm run dev` starts. `pytest` still 180 passed (Python untouched).
Committed `c59986b`.

**Mid-session workflow correction.** Ron pointed out I should have confirmed
I was on a branch before Task 22's changes. I created a
`task-22-port-models-sport-classification` branch, but Ron then edited
CLAUDE.md directly to add an explicit Git section: work on `main`, no
branches unless a task asks, `git status` check for unexpected uncommitted
changes before starting, one commit per task only after all tests pass
(`Task NN — <task title>` message format), commit only task-touched files,
never commit generated files, push to `origin/main` after every commit, end
each reply with the commit hash and push status. I switched back to `main`,
deleted the now-unneeded branch (nothing had been committed to it), and
committed the CLAUDE.md edit on its own (`2e99890`, pushed) since it wasn't
part of Task 22's own work.

**Task 22 — port `models.py`/`sport.py`/`pieces.py`.**
- `models.ts`: `Side`, `Piece`, `FieldTier`, `KingMode` as frozen const
  objects + derived union types — this tsconfig sets `erasableSyntaxOnly:
  true` (both `tsconfig.app.json` and `tsconfig.node.json`), which forbids
  real TS `enum`; the const+type pattern is the standard substitute and
  reads the same at call sites (`Piece.KING`, `tier === FieldTier.SMALL`).
  `Player` class with `ownFor(tier)`; `Move` class. `BuildState` deliberately
  deferred — it needed a board/square representation not yet decided.
- `sport.ts`: `PieceBand`, `RosterSlot`, `SportConfig` classes;
  `loadSportConfig(data)` takes already-parsed JSON rather than a file path,
  to keep the engine I/O-free per Task 21's own rule (Python's version opens
  the file itself). Added `resolveJsonModule: true` to `web/tsconfig.app.json`
  so tests can `import nflConfig from "../data/config/sports/nfl.json"`
  directly.
- `pieces.ts`: `pieceForChessType` (chess.js `PieceSymbol` → `Piece`),
  `classify(player, sport)`.
- Ported all 26 Python tests one-for-one across `models.test.ts` (3, from
  `test_models.py`), `sport.test.ts` (2, from `test_sport.py`), and
  `pieces.test.ts` (21, from `test_pieces.py` including every
  `@pytest.mark.parametrize` case, via Vitest's `it.each`).
- Verified: `npm run test` 27 passed (26 ported + Task 21's smoke test),
  `npm run build` clean, `pytest` 180 passed. Committed `45a8197`, pushed.

**Task 23 — port `BuildState` + roster/salary completability + exclusivity.**
Before building, flagged a real scope question: `is_legal_move`/`apply_move`
in `rules.py` both take a `contest: ContestConfig` (from `dfs_chess/
config.py`, a module Task 23 never named — only `models.ts, rules.ts` were
listed) and need full chess.js move-legality/SAN/board-cloning wiring. Asked
Ron to choose between porting only the four pure roster/salary functions now
(deferring `is_legal_move`/`apply_move` and everything that depends on them
until `ContestConfig` is ported) versus also pulling in `ContestConfig` this
task. Ron chose the narrow scope.
- `models.ts`: added `BuildState` as a plain **mutable** class — not
  frozen, matching Python's non-frozen `@dataclass` (its `castle()`, not yet
  ported, mutates `white_castled`/`black_castled` on an already-built
  instance rather than reconstructing it). `board: Chess` (chess.js),
  defaulting to `new Chess()`; `pieceLocks: Map<Square, Player[]>`.
- `pieces.ts`: `classify()` now returns `Piece` (not `Piece | undefined`) per
  this task's explicit correction — throws if no band matches, which
  `loadSportConfig`'s catch-all-band guarantee makes unreachable in practice.
- `rules.ts` (new): `maxAssignable`, `lineupStillCompletable`,
  `isLineupComplete`, `openRosterSlots` — all pure (`Player[]` + `SportConfig`
  + a plain numeric `cap`), zero dependency on `ContestConfig` or a chess.js
  board.
- Ported the 7 tests from `test_rules.py`'s "roster/salary feasibility,
  tested directly" section — the only section that calls
  `lineup_still_completable` directly rather than through `is_legal_move`/
  `apply_move`/`castle`/`apply_capture_move`.
- In the scope question I first miscounted the deferred-test count as 16;
  corrected to the actual 11 before the final report (see Open threads for
  the real list).
- Verified: `npm run test` 34 passed (27 + 7 new), `npm run build` clean,
  `pytest` 180 passed. Committed `2c7c707`, pushed.

## Open threads

- **11 deferred `test_rules.py` tests** — need `is_legal_move`/`apply_move`,
  which need `ContestConfig` (not yet ported; lives in `dfs_chess/config.py`,
  no `config.ts` exists yet):
  - *chess legality + turn order*: `test_illegal_chess_move_rejected`,
    `test_move_piece_must_match_classification`, `test_turn_alternates`,
    `test_san_comes_from_board`
  - *exclusivity*: `test_exclusivity_blocks_the_other_side`,
    `test_exclusivity_blocks_the_same_side_repicking`
  - *roster/salary (same rules for both sides)*:
    `test_unknown_position_illegal_for_white`,
    `test_second_king_illegal_for_white`,
    `test_lineup_impossible_to_complete_illegal_for_black`,
    `test_cap_overflow_illegal_for_white`, `test_cap_overflow_illegal_for_black`
- The other 21 `test_rules.py` tests (castling, King modes, captures) remain
  out of scope per Task 23's own exclusion list — not a new finding, just
  not yet due.
- `dfs_chess/config.py` (`ContestConfig`) is unported and is now the
  prerequisite for `is_legal_move`/`apply_move`. Porting those will also need
  real chess.js board wiring: `Chess.moves({verbose: true})` for legal-move
  membership, `Chess.get(square)` for piece-at-square, each returned `Move`'s
  `.isCapture()`/`.isKingsideCastle()`/`.isQueensideCastle()` for the
  early-reject checks, and FEN-based board cloning (`new Chess(fen)`, since
  chess.js has no built-in `.clone()`) for `apply_move`'s own copy-then-push.
- `dfs_chess/build.py` (the actual turn-flow loop: `play_white_move`,
  `play_black_move`, etc.), `loaders.py`, and `openings.py` remain entirely
  unported — every task so far has explicitly excluded them.
- Task 21's commit message used `Task 21: <title>` (colon); CLAUDE.md's Git
  section, added after that commit, standardizes on `Task NN — <title>`
  (em-dash) for every commit since. Not retroactively fixed — CLAUDE.md says
  never amend a pushed commit without Ron asking.
