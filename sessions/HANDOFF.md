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
earlier rules. It has an explicit Git section: work on `main`, no branches
unless asked, check `git status` for unexpected uncommitted changes before
starting, one commit per task after all tests pass, push to `origin/main`
after every commit. Python 3.11+, stdlib + pytest + `python-chess` for the
original engine; `web/` is a Vite + React + TypeScript app (Node v24, npm)
being built alongside it. The TS port of the engine is now complete and has
a standing parity harness proving it matches Python on real, deterministic
scenarios. Secrets (`LICHESS_API_TOKEN`) live in a gitignored `.env`, never
printed.

## Where We Are

- **180 Python tests passing**, run via `wsl.exe -- bash -lc "cd
  ~/chess-dfs && .venv/bin/python -m pytest tests/ -v"`. The Python engine
  itself is unchanged since the web port began — every web-port task so
  far has been additive, TypeScript-only.
- **`web/` scaffolded** (Vite + React + TypeScript + Vitest + chess.js
  ^1.4.0 + papaparse ^5.7.0). `npm run dev`/`build`/`test` each run `npm
  run sync-data` first, which copies `data/openings/`, `data/samples/`,
  and `config/` into `web/src/data/` (gitignored; originals untouched).
  No UI beyond the Vite default page yet.
- **`web/src/engine/` now covers the entire pure Python engine, and a
  parity harness proves it** (no DOM, no I/O, no unseeded randomness):
  - `models.ts`, `sport.ts`, `config.ts`, `pieces.ts`, `loaders.ts`,
    `openings.ts` — unchanged this session.
  - `rules.ts` — the full `dfs_chess/rules.py`, including `pushSilentMove`.
    Exports `findLegalMove`/`capturedSquare`/`isCaptureMove` for `build.ts`
    to reuse.
  - `build.ts` — the full turn-flow loop ported from `dfs_chess/build.py`:
    `playWhiteMove`, `playBlackMove`, `playBlackTemplateMove`,
    `checkWhiteDeadEnd`, `moveIsCompletable`, `MoveResult`,
    `HAPPY_HUNTING`/`NO_LEGAL_MOVES`. Black's book commitment, rank-closest
    line selection with seeded tie-breaking, falling out of the book to
    uniform-random legal play, template mode, dead ends, and the
    full-lineup "silent move" path are all covered.
  - `rng.ts` — `SeededRandom`, a from-scratch seeded PRNG (mulberry32)
    standing in for Python's `random.Random` (JS has no seedable
    equivalent). Same seed → same TS pick, not the same pick Python would
    make for that seed number.
  - `tools/export_parity.py` + `web/src/engine/__fixtures__/parity.json`
    (committed, ~178KB) + `web/src/engine/parity.test.ts`: a parity
    harness. The Python script calls only real engine functions (never
    reimplements anything) and writes 33 deterministic scenarios' results
    to the JSON fixture; the TS test replays every one through the TS
    engine and asserts an exact match. Covers every sample player's
    classification, ordinary/illegal moves and roster/salary rejections,
    castling in both King modes plus the QB switch, captures (an ordinary
    transfer, an unmoved piece, and one en passant), ownership-tier
    boundaries, target rank at eight field sizes up to 416,171, the full
    104-family ranking list, opening naming/continuations, and one full
    Ruy Lopez Morphy Defense template build with highest-projection picks
    on both sides. All 33 pass. Deliberately excludes anything
    seed-dependent — see `export_parity.py`'s own header. Snapshot, not a
    live link: re-run it if the engine changes.
  - Two real bugs were found and fixed this session, both via testing
    *behavior* rather than reading the diff:
    1. `applyMove`/`applyCaptureMove`/`castle`/`pushSilentMove` used to
       clone the board via `new Chess(state.board.fen())` — FEN has no
       notion of move history, so every clone silently discarded
       everything before the most recent move, breaking `build.ts`'s
       book-commitment depth tracking. Fixed via a `cloneBoard` helper
       that round-trips through PGN instead.
    2. Every "is this move a capture" check in `rules.ts`/`build.ts` (ten
       call sites) tested chess.js's `isCapture()` alone, which is `false`
       for an en passant move (chess.js keeps "capture" and "en passant"
       as separate flags, unlike python-chess's `board.is_capture()`,
       which is `True` for both) — an en passant capture would have
       silently locked a brand-new player instead of transferring the
       captured pawn's. Found by the parity check; fixed by adding
       `isCaptureMove(move) = move.isCapture() || move.isEnPassant()` and
       using it at all ten sites. Python was never wrong here.
- **184 Vitest tests passing** (`npm run test`). `npm run build` is clean
  (`tsc -b` + `vite build`). One test (a 50-seed loop in `build.test.ts`)
  needs its own raised vitest timeout (20s) — chess.js's repeated move
  generation is markedly slower than python-chess's, not a logic issue.
- **Not yet ported from the Python engine**: a "suggested opening" picker
  combining `rankFamilies` with `ContestConfig`'s tier/rank methods (exists
  only inline inside `cli.py`, no standalone Python function or isolated
  test to match); `cli.py` itself; all UI; the Monte Carlo sim.

## Where We're Headed

1. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed, unchanged.
2. Simulated "Top 10%" metric — still a known gap.
3. A decision on whether/how to port a "suggested opening" picker (see Open
   Items) — likely alongside whatever first needs it (CLI or UI).
4. Eventually: a real UI on top of the engine (currently just the Vite
   default page), and a CLI if one is wanted on the TS side at all.
5. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.

## Open Items

- **No "suggested opening" picker ported**: unchanged from before — see
  `sessions/1026/10132026-port-family-ranking-suggestion-opening-preview.md`.
- Chess.js has no public "resolve SAN without pushing" method, no public
  "is this shape a castle/capture independent of legality" check, no
  public clone-with-history method, and treats "capture" and "en passant"
  as disjoint move flags where python-chess treats a capture as a capture
  regardless — four separate workarounds now live across
  `rules.ts`/`openings.ts`/`build.ts` (move-list matching by from/to,
  resolve-then-branch-on-the-matched-move, the PGN-round-trip `cloneBoard`,
  and `isCaptureMove`), each deliberately centralized rather than silently
  assumed, mirroring Python's own duplication between `legal_depth` and
  `opening_preview`. Worth a look if a future task wants to consolidate,
  and worth remembering generally: chess.js's move-flag semantics don't
  always line up one-to-one with python-chess's — check the actual flag
  set for any new "is this move an X" check, don't assume parity.
- `build.ts`'s `playWhiteMove`/`resolvePlayers`/`applyResolvedPlayers`/
  `isMovePlayableForBlack`/`playBlackTemplateMove` all resolve a
  caller-supplied move via `findLegalMove` up front and throw a single
  generic "illegal move" error if it doesn't match any legal move at all
  — Python's originals instead inline `is_castling`/`is_capture` shape
  checks that can evaluate even on an illegal move, routing to whichever
  of `castle`/`apply_move`/`apply_capture_move` then raises its own
  specific error. No test exercises this (every call site in
  `test_build.py` only ever passes already-legal moves), so it's an
  untested, zero-observed-behavior-difference implementation detail.
- `cloneBoard`'s PGN-round-trip clone is slower than a true clone would be
  (re-serializes and re-parses the whole game's move text on every single
  move). Fine at NFL-build scale (~9 plies/side); worth knowing if a future
  task drives many simulated builds at volume (e.g. the Monte Carlo sim).
- Task-numbering collision (a prior session reused "Task 20c" for two
  different pieces of work) and whether Ron intends to accept Scotch Game
  at rank 2 / drop King's Indian Defense from the "top 9": both still
  open, see `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
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
  structure, written only when `/wrap-up` is explicitly invoked — not
  automatically per task); the `Top_Ten` sim-vs-postmortem distinction —
  all still open, carried forward unchanged across several sessions.
- Kings still structurally can never be captured as the King piece itself
  (checkmate ends the position first — emergent, not a bug).
- Full narrative detail for this session's work (Tasks 29, 30, and 30b —
  the build-loop port, the board-history-clone bug, the parity harness,
  and the en passant/`isCaptureMove` bug and fix):
  `sessions/1026/10132026-port-build-loop-and-parity-check-tasks-29-30.md`.
  Earlier logs in `sessions/1026/` for everything predating that.
