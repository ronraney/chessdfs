# 10132026 — Port Castling, Captures, and King Modes (Task 25)

## Context

Continuing straight from Task 24 (contest config + ordinary-move rules),
this task ported everything Task 23/24 had explicitly deferred in
`dfs_chess/rules.py`: castling (`can_castle`/`castle`), King modes
(`switch_king`/`place_kings`), and Crazyhouse-style captures
(`is_legal_capture`/`apply_capture_move`). `git status` was clean before
starting.

## What was done

**`web/src/engine/rules.ts`** — ported the rest of `dfs_chess/rules.py`
one-for-one:
- `canCastle` / `castle` — `castle` requires `king` (locked alongside
  `rook`) in EMERGE mode; in PLACED mode `king` is `null` and only the
  Rook locks. A private `castlingRookSquares(move)` works out the rook's
  own [from, to] the same way Python's `_castling_rook_squares` does --
  chess.js's verbose `Move` only carries the king's own two-square hop,
  not the rook's squares.
- `switchKing` — Task 14's one-time QB-switch offer; returns `null` (not
  an error) on any of its reject conditions, mirroring Python's `None`
  return exactly.
- `placeKings` — locks both sides' QB before move 1, no chess move
  involved (`BuildState`'s default `board` -- a fresh starting position --
  is used as-is).
- `isLegalCapture` / `applyCaptureMove` — the captured player IS the
  move's pick (Task 18); if the captured piece has lock history, the most
  recent locker transfers; if it never moved, the capturing side's own
  `player` argument is required and takes the captured piece's place
  instead (Task 19). A private `capturedSquare(move)` and `otherSide`
  mirror Python's `captured_square`/`_other_side` exactly, including the
  en passant case (the captured pawn sits beside `to`, not on it).
- **`isLegalMove`/`applyMove`'s early-reject stubs updated, not removed**:
  both Python and this port still reject castling/captures from the
  ordinary-move path permanently (`is_legal_move`'s own comments say "use
  castle()"/"use apply_capture_move()" -- that's real production behavior,
  not a placeholder). Only the TS comments changed, from "not yet ported
  (future task)" to the same "use castle()"/"use applyCaptureMove()"
  Python itself uses, since those functions now exist.
- **Not ported**: `push_silent_move`. It exists in `rules.py` only to
  support the build loop (pushes a move without locking a player, for a
  side whose lineup already filled) -- `test_rules.py` has zero coverage
  of it (confirmed by grep), and it's only ever called from `build.py`/
  `cli.py`, both still out of scope per this task's own "Not yet: loaders,
  openings, build loop." Flagging per CLAUDE.md rather than porting an
  untested function speculatively.

**Tests** — ported all 21 remaining `test_rules.py` tests into
`rules.test.ts` (6 castling, 8 King modes, 7 captures), plus their 4
shared test-setup helpers (`_state_ready_to_castle_queenside[_placed]`,
`_state_with_a[n_unmoved_pawn]_capture_available`) ported as local
functions the same way the existing `uci()` helper already was. **Also
checked** `test_build.py`/`test_cli.py` for other coverage of these
features (grep for `can_castle|castle(|switch_king|place_kings|
is_legal_capture|apply_capture_move|KingMode`) -- both import these
functions, but only as setup for build-loop/CLI-runner tests, which
exercise `build.py`/`cli.py` behavior (not yet ported, out of scope), not
`rules.py` in isolation. None of those were ported; none were in scope.

**Verified**: `npx tsc -b` clean, `npm run test` 82 passed (61 prior + 21
new, all first-try green -- no behavioral mismatches found against
Python), `npm run build` clean, `pytest` 180 passed (Python untouched,
TypeScript-only task).

## Open questions / flags

- `push_silent_move` is unported (see above) -- flagging since it
  technically lives in `rules.py`, even though it's untested and
  build-loop-only.
- The en passant branch of `capturedSquare` (and `matched.isEnPassant()`
  more generally) has no ported test exercising an actual en passant
  capture -- `test_most_recently_locked_player_transfers_on_capture` only
  asserts a capture is NOT en passant. Carried over from the same
  under-tested-but-faithfully-ported spirit as Task 24's promotion flag.
- `isLegalCapture`/`applyCaptureMove` derive the captured piece's type
  from chess.js's verbose `Move.captured` field rather than a separate
  `board.get(square)` lookup Python's `piece_type_at` does -- functionally
  identical (chess.js guarantees `.captured` is set whenever
  `.isCapture()` is true), same implementation-adaptation precedent Task
  24 set for `.piece`/`.san`.

## Follow-ups (noted, not acted on)

- `build.py` (`play_white_move`/`play_black_move`/the turn-flow loop),
  `loaders.py`, `openings.py` — still entirely unported; `push_silent_move`
  now joins that list explicitly rather than being silently skipped.
- HANDOFF.md not rewritten this session (not a `wrap-up` call).
