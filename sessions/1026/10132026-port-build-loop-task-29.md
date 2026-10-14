# 10132026 — Port the build loop (Task 29)

## Context

Went in via `/start`. `sessions/HANDOFF.md` was already carrying Tasks 24-28's
"Where We're Headed" item #1: port `dfs_chess/build.py` (the turn-flow loop),
now that nearly every pure function it calls (`rules.ts`, `openings.ts`,
`pieces.ts`, `config.ts`, `loaders.ts`) was already ported. `git status` showed
uncommitted changes I didn't make — `sessions/HANDOFF.md` (85 insertions / 77
deletions) and an untracked `sessions/1026/10132026-port-rules-loaders-
openings-tasks-24-28.md` — leftover from the prior session, never committed.
Flagged it to Ron via AskUserQuestion; he chose to bundle both the leftover
Tasks 24-28 docs commit and this session's own work into one commit.

The task: port `build.py`'s turn flow (White's move from the caller, Black's
generated via book commitment or uniform random play), template mode, dead
ends, stop-with-core, and `push_silent_move` (a side whose lineup is already
full) — matching Python exactly, converting any test that pins an exact
seeded pick into a property test, and porting every test in `test_build.py`.

## What was done

**`web/src/engine/rng.ts` (new)** — `SeededRandom`, a small from-scratch
seeded PRNG (mulberry32). JS has no seedable equivalent to Python's
`random.Random`, so this stands in for it everywhere `build.ts` needs
randomness. Deliberately NOT bit-for-bit comparable to Python's Mersenne
Twister — same seed gives the same TS pick, and that pick always comes from
the allowed candidate set, but the literal value differs from whatever Python
would pick for the "same" seed number.

**`web/src/engine/rules.ts` (modified)** — three changes:
1. Added `pushSilentMove` (ported from `dfs_chess/rules.py`, not `build.py` —
   that's where it actually lives in Python). Exported `findLegalMove` and
   `capturedSquare` (previously module-private), since `build.ts` needs the
   same move-resolution/captured-square logic rules.ts already has.
2. **Found and fixed a pre-existing bug**, not something Task 29 asked for
   but required to make it work: `applyMove`, `applyCaptureMove`, `castle`,
   and `pushSilentMove` all cloned the board via `new Chess(state.board.fen())`.
   FEN encodes only the current position, not move history — python-chess's
   `board.copy()` (which the Python originals actually use) preserves the
   *full* history. The TS version was silently losing it on every single
   move application: `board.history()` would only ever show the most recent
   move, never the accumulated sequence. This was invisible through Task
   24/25's own tests (`rules.test.ts` never calls `.history()`, only checks
   each `Move` record's own `.san`), but it broke `build.ts` outright —
   `playBlackMove`'s book-commitment tracking depends on `sanHistory(board)`
   reflecting the *entire* game so far, not just the latest ply. Root-caused
   it by writing a throwaway debug test that traced `board.history()` after
   two plies and found it had length 1, not 2. Fixed with a `cloneBoard`
   helper that round-trips through PGN instead
   (`new Chess(); clone.loadPgn(board.pgn())`), verified via a scratch script
   that this correctly preserves history even from a non-default starting
   FEN (chess.js emits `[SetUp "1"]`/`[FEN ...]` PGN headers for that case,
   and `loadPgn` honors them on the way back in).
3. Updated the file's header comment: previously said push_silent_move was
   NOT ported (Task 25); now documents that it is (Task 29) and explains its
   build-loop-only test coverage.

**`web/src/engine/build.ts` (new)** — full port of `dfs_chess/build.py`:
`MoveResult`, `HAPPY_HUNTING`/`NO_LEGAL_MOVES`, `checkWhiteDeadEnd`,
`moveIsCompletable`, `playWhiteMove`, `playBlackMove`,
`playBlackTemplateMove`, plus the private helpers (`resolvePlayers`,
`applyResolvedPlayers`, `bestLegalPlayer`/`bestLegalCapturePlayer`/
`bestLegalCastlePlayers`, `eligibleUnlocked`, `isMovePlayableForBlack`,
`playableContinuations`, `chooseBlackCommittedLine`, `sanHistory`,
`isBuildOver`). `sanHistory` is a one-line alias over `board.history()`
rather than Python's replay-through-a-second-board approach — chess.js
already tracks SAN history itself (now that the clone bug above is fixed),
so there's no need to reconstruct it move-by-move the way python-chess's
version does. Everywhere Python inlines `state.board.is_castling(move)` /
`is_capture(move)` on a possibly-not-yet-legal `chess.Move`, TS instead
resolves the move once via `rules.findLegalMove` and branches on the
resolved verbose chess.js `Move`'s own `isCapture()`/`isKingsideCastle()`/
`isQueensideCastle()` — chess.js has no shape-only capture/castle check
independent of legality the way python-chess does, so an input that isn't a
legal move at all now gets a single generic "illegal move" error instead of
whichever specific error Python's castle()/apply_move()/apply_capture_move()
would have produced for that shape. No test in `test_build.py` exercises
that path (every call site only ever passes already-legal moves), so this
is an untested, zero-behavior-difference implementation detail — flagging it
per CLAUDE.md's "flag any behavior change beyond what the task asked," even
though no test can see it.

The CLI's "Black captured an unmoved pawn" wording (task's third bullet) was
confirmed to live in `cli.py`'s `_prompt_for_opening_setup`-adjacent output
(`f"\nYou play {...}, capturing an unmoved ..."`, line ~598), not in
`build.py` or `rules.py` — grepped for it directly. Skipped per the task's
own instruction; `rules.ts`'s existing `applyCaptureMove` error message
(`"... captures an unmoved {type} -- a player pick is required"`) is the
only unmoved-piece message in scope, and it was already there pre-Task-29.

**`web/src/engine/build.test.ts` (new)** — all 21 tests from
`tests/test_build.py` ported, one-for-one, organized under the same section
comments Python uses (`describe` blocks: "Black's book play", "template mode
(Task 13)", "Black's book-line commitment outside a template (Task 13)",
"King modes (Task 14)", "capturing a piece that never moved (Task 19)", "end
condition", "capture transfer pre-check (Task 11c)", "dead-end endings (Task
11e)"). **Property-test conversion**: checked every seeded test in
`test_build.py` individually — none of them actually pin an exact seed→value
pick. Every one already asserts a property instead: set membership
(`played_san in book_continuations(...)`), same-seed-same-result
determinism, or "varies across enough seeds" (`len(sans) > 1`). So nothing
needed converting into a new kind of test; they ported over structurally
unchanged, just with `SeededRandom` standing in for `random.Random`. Noted
this explicitly in the test file's header comment so a future reader doesn't
go looking for a conversion that didn't happen.

One test (`capture transfer pre-check (Task 11c)`, 50 seeds × a full
`playBlackMove` call each) needed its vitest timeout bumped from the 5s
default to 20s — chess.js's `board.moves({verbose: true})` is markedly
slower than python-chess's `legal_moves` per call, and `resolvePlayers`'s
player-candidate loops end up re-running it many times per move pick. Not a
logic bug (confirmed via the earlier debug trace once the clone bug was
fixed) — purely chess.js being slower than python-chess at repeated move
generation. Flagged in a comment on the test rather than touching
`vite.config.ts`'s global `testTimeout` (smaller blast radius, scoped to the
one slow test).

Git housekeeping: appending `pushSilentMove` to the end of `rules.ts` via
`Edit` twice landed it in the wrong place (right after `withBoardState`,
since its closing-brace text pattern wasn't actually unique — `withBoardState`
and the end of `applyCaptureMove` both end identically) before I switched to
a direct `cat >>` append to guarantee it landed at the true end of the file.
Worth remembering for future edits near duplicate boilerplate closings in
this file.

## Verification

- `npm run build` (`tsc -b` + `vite build`): clean, no type errors.
- `npm run test -- --run`: **150 passed** (129 before this session + 21 new
  in `build.test.ts`), 0 failed, across 9 test files.
- `.venv/bin/python -m pytest tests/ -q`: **180 passed**, unchanged (no
  Python files touched this session).

## Open threads

- The untested "illegal move passed to a function that branches on
  is_castling/is_capture" implementation gap noted above (playWhiteMove,
  resolvePlayers, applyResolvedPlayers, isMovePlayableForBlack,
  playBlackTemplateMove) — zero test coverage either side, flagged for
  awareness only, not actioned.
- `cloneBoard`'s PGN round-trip is noticeably slower than a hypothetical
  true clone would be (string-serializes and re-parses the entire game on
  every single move application). Not a problem at NFL-build scale (~9
  plies a side), but worth knowing if a future task does something at much
  higher move-volume (e.g. a Monte Carlo sim driving many simulated builds).
  No action taken — chess.js has no public clone-with-history API to use
  instead.
- CLI, UI, the Monte Carlo sim, and the "suggested opening" picker
  (`by_rank[target_rank]`, still only inline in `cli.py`) remain unported,
  unchanged from before this session.
- The leftover Tasks 24-28 `sessions/HANDOFF.md` diff and session log file
  that were sitting uncommitted at the start of this session are being
  committed together with this session's own work, per Ron's explicit
  "bundle into one commit" answer — see commit message for the combined
  scope.
